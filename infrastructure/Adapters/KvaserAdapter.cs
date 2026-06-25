using System.Diagnostics;
using System.Runtime.InteropServices;
using domain.Enums;
using domain.Interfaces;
using domain.Models;

namespace infrastructure.Adapters;

/// <summary>
/// Kvaser CAN adapter via the CANlib driver (canlib32.dll, installed with the Kvaser drivers — Windows).
/// A dedicated CAN bus interface like PCAN: it is NOT a dingo USB bridge, so it never answers the 'I'
/// identify (IdentifyBridgeBaseIdAsync stays the interface default, null) and every module on the bus is
/// flashed over CAN. The "port" is the CANlib channel index (0-based); blank/non-numeric → channel 0.
/// </summary>
public class KvaserAdapter : ICommsAdapter
{
    public string Name => "Kvaser";

    private int _handle = -1;             // CANlib canHandle; < 0 = not open
    private int _channel;
    private Thread? _readThread;
    private CancellationTokenSource? _readCts;
    private readonly object _writeLock = new();

    private Stopwatch? _rxStopwatch;
    public TimeSpan RxTimeDelta { get; private set; }
    // Liveness by traffic, same model as PcanAdapter: a frame seen within 500ms ⇒ connected.
    public bool IsConnected => _handle >= 0 && RxTimeDelta < TimeSpan.FromMilliseconds(500);

    public event DataReceivedHandler? DataReceived;
    public event EventHandler? Disconnected;

    // Host-side accept gate (see ICommsAdapter.SetReceiveFilter) — drop out-of-range ids in the read thread
    // before the synchronous handlers, so a flooded bus can't bury a reply during a CAN flash / config read.
    private volatile int _acceptLo = -1;
    private volatile int _acceptHi = -1;
    public void SetReceiveFilter(int? loId, int? hiId = null)
    {
        _acceptLo = loId ?? -1;
        _acceptHi = hiId ?? loId ?? -1;
    }

    public Task<AdapterFilterProbe> ProbeFilterAsync(CancellationToken ct = default) =>
        Task.FromResult(new AdapterFilterProbe(true, "kvaser",
            "Suitable — the read-thread id gate drops other-id traffic before the handlers."));

    public Task<bool> InitAsync(string port, CanBitRate bitRate, CancellationToken ct)
    {
        _channel = int.TryParse(port, out var c) ? c : 0;
        try
        {
            canInitializeLibrary();   // idempotent
            _handle = canOpenChannel(_channel, 0);
            if (_handle < 0) { _handle = -1; return Task.FromResult(false); }

            // Predefined bitrate constants are passed as the negative `freq`; the tseg/sjw args are ignored.
            if (canSetBusParams(_handle, BitrateConst(bitRate), 0, 0, 0, 0, 0) != canOK ||
                canSetBusOutputControl(_handle, canDRIVER_NORMAL) != canOK)
            {
                canClose(_handle); _handle = -1; return Task.FromResult(false);
            }
            _rxStopwatch = Stopwatch.StartNew();
            return Task.FromResult(true);
        }
        catch (DllNotFoundException)
        {
            // canlib32.dll missing (Kvaser drivers not installed) — report a clean failed connect.
            _handle = -1;
            return Task.FromResult(false);
        }
    }

    public Task<bool> StartAsync(CancellationToken ct)
    {
        if (_handle < 0) return Task.FromResult(false);
        if (canBusOn(_handle) != canOK) return Task.FromResult(false);

        _readCts = new CancellationTokenSource();
        _readThread = new Thread(() => ReadLoop(_readCts.Token))
        {
            IsBackground = true, Priority = ThreadPriority.AboveNormal, Name = "KvaserRead"
        };
        _readThread.Start();
        return Task.FromResult(true);
    }

    public Task<bool> StopAsync()
    {
        _readCts?.Cancel();
        try { _readThread?.Join(TimeSpan.FromSeconds(2)); } catch { /* ignore */ }
        _readCts?.Dispose(); _readCts = null; _readThread = null;

        if (_handle >= 0)
        {
            try { canBusOff(_handle); canClose(_handle); } catch { /* shutting down */ }
            _handle = -1;
        }
        RxTimeDelta = TimeSpan.FromHours(1);   // force IsConnected = false
        return Task.FromResult(true);
    }

    public Task<bool> WriteAsync(CanFrame frame, CancellationToken ct)
    {
        if (_handle < 0 || frame.Payload.Length != 8) return Task.FromResult(false);
        var data = new byte[8];
        Array.Copy(frame.Payload, data, 8);
        int status;
        lock (_writeLock) status = canWrite(_handle, frame.Id, data, (uint)frame.Len, canMSG_STD);
        if (status != canOK) { HandleDisconnection(); return Task.FromResult(false); }
        return Task.FromResult(true);
    }

    public Task<bool> WriteBatchAsync(IReadOnlyList<CanFrame> frames, CancellationToken ct)
    {
        var ok = true;
        foreach (var f in frames) ok &= WriteAsync(f, ct).Result;
        return Task.FromResult(ok);
    }

    private void ReadLoop(CancellationToken ct)
    {
        var data = new byte[8];
        int consecutiveErrors = 0;
        while (!ct.IsCancellationRequested && _handle >= 0)
        {
            int status = canReadWait(_handle, out long id, data, out uint dlc, out uint flag, out _, 100);
            if (status == canERR_NOMSG) { consecutiveErrors = 0; continue; }   // idle bus — normal
            if (status != canOK)
            {
                // A burst of hard errors (device unplugged / bus-off) ⇒ treat as disconnected. Tolerate the
                // odd transient so a single hiccup doesn't drop a working link.
                if (++consecutiveErrors > 20) { HandleDisconnection(); return; }
                continue;
            }
            consecutiveErrors = 0;

            if (_rxStopwatch != null) { RxTimeDelta = new TimeSpan(_rxStopwatch.ElapsedMilliseconds); _rxStopwatch.Restart(); }

            // Only 11-bit data frames carry the dingo protocol; skip extended/error/remote frames.
            if ((flag & (canMSG_EXT | canMSG_ERROR_FRAME | canMSG_RTR)) != 0 || (flag & canMSG_STD) == 0) continue;
            if (dlc == 0) continue;

            int len = (int)Math.Min(dlc, 8u);
            var payload = new byte[len];
            Array.Copy(data, payload, len);
            int fid = (int)(id & 0x7FF);
            if (_acceptLo < 0 || (fid >= _acceptLo && fid <= _acceptHi))
                DataReceived?.Invoke(this, new CanFrameEventArgs(new CanFrame(fid, len, payload)));
        }
    }

    private void HandleDisconnection()
    {
        if (_handle < 0) return;   // already torn down
        Disconnected?.Invoke(this, EventArgs.Empty);
    }

    // --- Kvaser CANlib P/Invoke (canlib32.dll ships with the Kvaser drivers) -----------------------------
    private const int canOK = 0;
    private const int canERR_NOMSG = -2;
    private const uint canMSG_RTR = 0x0001;
    private const uint canMSG_STD = 0x0002;
    private const uint canMSG_EXT = 0x0004;
    private const uint canMSG_ERROR_FRAME = 0x0020;
    private const uint canDRIVER_NORMAL = 4;

    // Predefined CANlib bitrate constants (passed as the negative `freq` to canSetBusParams).
    private static long BitrateConst(CanBitRate b) => b switch
    {
        CanBitRate.BitRate1000K => -1,   // canBITRATE_1M
        CanBitRate.BitRate500K => -2,    // canBITRATE_500K
        CanBitRate.BitRate250K => -3,    // canBITRATE_250K
        CanBitRate.BitRate125K => -4,    // canBITRATE_125K
        CanBitRate.BitRate100K => -5,    // canBITRATE_100K
        _ => -2
    };

    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern void canInitializeLibrary();
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canOpenChannel(int channel, int flags);
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canSetBusParams(int hnd, long freq, uint tseg1, uint tseg2, uint sjw, uint noSamp, uint syncmode);
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canSetBusOutputControl(int hnd, uint drivertype);
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canBusOn(int hnd);
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canBusOff(int hnd);
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canClose(int hnd);
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canWrite(int hnd, long id, byte[] msg, uint dlc, uint flag);
    [DllImport("canlib32", CallingConvention = CallingConvention.StdCall)]
    private static extern int canReadWait(int hnd, out long id, byte[] msg, out uint dlc, out uint flag, out ulong time, long timeout);
}
