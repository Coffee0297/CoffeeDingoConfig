using System.Diagnostics;
using System.IO.Ports;
using System.Text;
using domain.Enums;
using domain.Interfaces;
using domain.Models;

// ReSharper disable MemberCanBePrivate.Global

namespace infrastructure.Adapters;

public class SlcanAdapter : ICommsAdapter
{
    public virtual string Name => "SLCAN";

    protected SerialPort? Serial;
    protected string? PortName;
    protected Stopwatch? RxStopwatch;
    protected Timer? ConnectionMonitorTimer;
    protected TimeSpan RxTimeDelta { get; set; }

    private CancellationTokenSource? _readCts;
    private Thread? _readThread;
    // Serializes every write to the single serial port. SerialPort.Write is not safe to call
    // from multiple threads at once; without this, an overlapping single-frame write and a
    // batch write (or two queued writes from concurrent Read/Write/Flash requests) could
    // interleave bytes on the wire and corrupt CAN frames.
    private readonly object _writeLock = new();

    // The port must actually be open to be "connected" — without this, a failed Init (Serial
    // closed, RxTimeDelta still at its default Zero) reported IsConnected=true with no link.
    public bool IsConnected => (Serial?.IsOpen ?? false) && RxTimeDelta < TimeSpan.FromMilliseconds(500);

    public event DataReceivedHandler? DataReceived;
    public event EventHandler? Disconnected;
    
    private int _bitrate;

    // CAN-id accept range applied in the reader (see SetReceiveFilter): _acceptLo < 0 = accept all,
    // otherwise only ids in [_acceptLo.._acceptHi] are surfaced via DataReceived. Dropping the flood
    // right in the read loop — BEFORE the synchronous DataReceived handlers — keeps the reader from
    // backing up until the OS serial buffer overflows (which drops an XCP/config reply). A flash sets
    // a single id (the XCP response); a config exchange sets the device's whole id block so its
    // telemetry keeps flowing. volatile: written from the flash/config thread, read by SlcanRead.
    private volatile int _acceptLo = -1;
    private volatile int _acceptHi = -1;

    // Last base id reported by the dingoFW 'I' identify reply (see IdentifyBridgeBaseIdAsync / the reader).
    // -1 = none seen since the last identify request. volatile: written by the reader thread, polled by the
    // identify await.
    private volatile int _bridgeBaseId = -1;

    // The id currently pushed to the dingoFW 'X' bridge filter (-2 = never set). Deduped so a chunked
    // read/write — whose every frame re-arms the config filter — sends 'X' once, not per frame.
    private volatile int _bridgeFilterId = -2;

    public void SetReceiveFilter(int? loId, int? hiId = null)
    {
        _acceptLo = loId ?? -1;
        _acceptHi = hiId ?? loId ?? -1;
        // Also push the dingoFW 'X' bridge accept-filter. The reader-side range above only drops the
        // flood AFTER it crosses USB — under a real 3000+ msg/s flood the USB/SLCAN link itself
        // saturates and buries the config/XCP reply. 'X' makes a dingoPDM/CANBoard acting as the bridge
        // forward ONLY this id over USB, so the flood never crosses the link and the read/write/CRC
        // exchange always completes. The firmware forwards a single id; we forward the reply id (loId,
        // = base for config, base+13 for XCP). A standalone SLCAN adapter ignores the unknown 'X'.
        // Cleared (bare 'X') when the filter lifts. Deduped: only emit on a change.
        var want = loId ?? -1;
        if (want != _bridgeFilterId)
        {
            _bridgeFilterId = want;
            SendRaw(want >= 0 ? $"X{want:X3}\r" : "X\r");
        }
    }

    // Fire-and-forget raw SLCAN command line under the shared write lock; swallows any port fault.
    private void SendRaw(string cmd)
    {
        if (Serial is not { IsOpen: true }) return;
        try { var b = Encoding.ASCII.GetBytes(cmd); lock (_writeLock) Serial?.Write(b, 0, b.Length); }
        catch { /* best-effort */ }
    }

    // Count frames surfaced via DataReceived over a window (the reader-side filter is open during a probe).
    private async Task<int> CountForAsync(int ms, CancellationToken ct)
    {
        int c = 0;
        DataReceivedHandler h = (_, __) => Interlocked.Increment(ref c);
        DataReceived += h;
        try { await Task.Delay(ms, ct); } catch (OperationCanceledException) { }
        finally { DataReceived -= h; }
        return c;
    }

    public async Task<AdapterFilterProbe> ProbeFilterAsync(CancellationToken ct = default)
    {
        if (Serial is not { IsOpen: true }) return new(null, "none", "Adapter is not connected.");
        var savedLo = _acceptLo; var savedHi = _acceptHi;
        _acceptLo = -1; _acceptHi = -1;           // count everything the adapter actually forwards
        try
        {
            int baseline = await CountForAsync(1200, ct);
            if (baseline < 8)
                return new(null, "none", $"Inconclusive — only {baseline} frames/1.2s on the bus. " +
                    "Run with live traffic (power a module) so there's something to filter.");

            // 1) dingoFW bridge filter: forward only an id that isn't on the bus.
            SendRaw("X7FE\r");
            int xc = await CountForAsync(1200, ct);
            SendRaw("X\r");                        // clear
            if (xc * 4 < baseline)
                return new(true, "dingoFW-X",
                    $"Suitable — honors the dingoFW 'X' bridge filter (forwarding {baseline}→{xc} per 1.2s). " +
                    "Can flash over CAN on a busy bus.");

            // 2) standard SLCAN M/m hardware filter: an impossible 32-bit match (must be set while closed).
            SendRaw("C\r"); SendRaw("M55555555\r"); SendRaw("m00000000\r"); SendRaw("O\r");
            int mc = await CountForAsync(1200, ct);
            SendRaw("C\r"); SendRaw("M00000000\r"); SendRaw("mFFFFFFFF\r"); SendRaw("O\r");   // restore accept-all
            if (mc * 4 < baseline)
                return new(true, "slcan-Mm",
                    $"Suitable — honors the SLCAN M/m hardware filter (forwarding {baseline}→{mc} per 1.2s).");

            return new(false, "none",
                $"NOT suitable — ignores both the dingoFW 'X' and SLCAN M/m filters (forwarding unchanged: " +
                $"X {baseline}→{xc}, M/m {baseline}→{mc}). It will forward the whole bus, so a busy-bus CAN " +
                "flash loses responses. Flash on a quiet bus, use real CAN hardware (PCAN/Kvaser), or — if " +
                "this is a dingoPDM/CANBoard bridge — update its firmware to one with the 'X' filter.");
        }
        finally { _acceptLo = savedLo; _acceptHi = savedHi; }
    }

    public async Task<int?> IdentifyBridgeBaseIdAsync(CancellationToken ct = default)
    {
        if (Serial is not { IsOpen: true }) return null;
        _bridgeBaseId = -1;
        SendRaw("I\r");                              // dingoFW identify; standalone adapters ignore it
        // Poll for the reader to capture the 'I' reply. ~400ms is ample over a 115200 link; a non-dingo
        // adapter never answers, so we just time out and return null (→ no bridge identified).
        for (int i = 0; i < 20 && _bridgeBaseId < 0; i++)
        {
            try { await Task.Delay(20, ct); } catch (OperationCanceledException) { return null; }
        }
        return _bridgeBaseId >= 0 ? _bridgeBaseId : null;
    }

    public Task<bool> InitAsync(string port, CanBitRate bitRate, CancellationToken ct)
    {
        try
        {
            // Release any leftover handle from a prior session so re-open can't be denied.
            if (Serial != null)
            {
                try { Serial.ErrorReceived -= _serial_ErrorReceived; } catch { /* ignore */ }
                try { if (Serial.IsOpen) Serial.Close(); } catch { /* ignore */ }
                try { Serial.Dispose(); } catch { /* ignore */ }
                Serial = null;
            }
            PortName = port;
            Serial = new SerialPort(port, 115200, Parity.None, 8, StopBits.One);
            Serial.Handshake = Handshake.None;
            Serial.NewLine = "\r";
            // Large OS buffer so a burst (e.g. ReadAll streams ~2300 frames back-to-back)
            // can't overflow the driver buffer before the read thread drains it.
            Serial.ReadBufferSize = 1 << 20; // 1 MB (~47k SLCAN frames)
            Serial.WriteBufferSize = 65536;
            Serial.ReadTimeout = 500;
            Serial.ErrorReceived += _serial_ErrorReceived;
            Serial.Open();

            RxStopwatch = Stopwatch.StartNew();
        }
        catch
        {
            Serial?.ErrorReceived -= _serial_ErrorReceived;
            Serial?.Close();

            RxStopwatch?.Stop();
            PortName = null;

            return Task.FromResult(false);
        }
        
        _bitrate = ToSlcanBitrate(bitRate);
        
        return Task.FromResult(true);
    }

    public Task<bool> StartAsync(CancellationToken ct)
    {
        if (Serial is { IsOpen: false }) return Task.FromResult(false);

        try
        {
            // Send SLCAN commands
            var sData = "C\r";
            if (Serial != null)
            {
                lock (_writeLock)
                {
                    Serial.Write(Encoding.ASCII.GetBytes(sData), 0, Encoding.ASCII.GetByteCount(sData));

                    //Set bitrate
                    sData = "S" + _bitrate + "\r";
                    Serial.Write(Encoding.ASCII.GetBytes(sData), 0, Encoding.ASCII.GetByteCount(sData));

                    //Open slcan
                    sData = "O\r";
                    Serial.Write(Encoding.ASCII.GetBytes(sData), 0, Encoding.ASCII.GetByteCount(sData));
                }
            }

            StartConnectionMonitor();
            StartReadLoop();
        }
        catch(Exception e)
        {
            Console.WriteLine(e.ToString());
            return Task.FromResult(false);
        }

        return Task.FromResult(true);
    }

    public Task<bool> StopAsync()
    {
        StopConnectionMonitor();

        // Detach the field first so the read loop sees it gone and further writes stop.
        var serial = Serial;
        Serial = null;

        // Best-effort: tell the SLCAN device to close its channel before we drop the port.
        if (serial != null)
        {
            try { if (serial.IsOpen) lock (_writeLock) serial.Write(Encoding.ASCII.GetBytes("C\r"), 0, 2); } catch { /* shutting down */ }
        }

        StopReadLoop();   // cancel + join the reader (it was reading serial.BaseStream)

        // Actually release the OS handle. Without this the port stays open and the next
        // Connect fails with "Access denied" until the device is physically re-plugged.
        if (serial != null)
        {
            try { serial.ErrorReceived -= _serial_ErrorReceived; } catch { /* ignore */ }
            try { if (serial.IsOpen) serial.Close(); } catch { /* ignore */ }
            try { serial.Dispose(); } catch { /* ignore */ }
        }

        RxStopwatch?.Stop();
        RxTimeDelta = new TimeSpan(1, 0, 0);   // force IsConnected = false
        return Task.FromResult(true);
    }

    // Encodes a single CAN frame into buffer at offset using SLCAN format.
    // Returns the number of bytes written.
    private static int EncodeFrame(CanFrame frame, byte[] buffer, int offset)
    {
        buffer[offset]     = (byte)'t';
        buffer[offset + 1] = (byte)((frame.Id & 0xF00) >> 8);
        buffer[offset + 2] = (byte)((frame.Id & 0xF0) >> 4);
        buffer[offset + 3] = (byte)(frame.Id & 0xF);
        buffer[offset + 4] = (byte)frame.Len;

        var lastByte = 0;
        for (var i = 0; i < frame.Len; i++)
        {
            buffer[offset + 5 + (i * 2)] = (byte)((frame.Payload[i] & 0xF0) >> 4);
            buffer[offset + 6 + (i * 2)] = (byte)(frame.Payload[i] & 0xF);
            lastByte = 6 + (i * 2);
        }

        buffer[offset + lastByte + 1] = (byte)'\r';

        for (var i = 1; i < lastByte + 1; i++)
            buffer[offset + i] += buffer[offset + i] < 0xA ? (byte)0x30 : (byte)0x37;

        return lastByte + 2;
    }

    public Task<bool> WriteAsync(CanFrame frame, CancellationToken ct)
    {
        // `is not { IsOpen: true }` is true when Serial is null OR closed — so a write to a dropped
        // port returns failure instead of falling through to a no-op `Serial?.Write` that would
        // falsely report the frame as transmitted.
        if (Serial is not { IsOpen: true } || frame.Payload.Length != 8)
            return Task.FromResult(false);

        try
        {
            var buffer = new byte[22];
            var len = EncodeFrame(frame, buffer, 0);
            lock (_writeLock) Serial?.Write(buffer, 0, len);
        }
        catch (InvalidOperationException ex)
        {
            HandleDisconnection($"WriteAsync: {ex.Message}");
            return Task.FromResult(false);
        }
        catch (IOException ex)
        {
            HandleDisconnection($"WriteAsync: {ex.Message}");
            return Task.FromResult(false);
        }
        catch (UnauthorizedAccessException ex)
        {
            HandleDisconnection($"WriteAsync: {ex.Message}");
            return Task.FromResult(false);
        }
        catch (Exception e)
        {
            Console.WriteLine(e.ToString());
            return Task.FromResult(false);
        }

        return Task.FromResult(true);
    }

    public Task<bool> WriteBatchAsync(IReadOnlyList<CanFrame> frames, CancellationToken ct)
    {
        if (Serial is not { IsOpen: true }) return Task.FromResult(false);   // null or closed → not written

        var frameBuffer = new byte[22];
        try
        {
            // Hold the lock for the whole batch so it is transmitted as one contiguous burst
            // and can't be split by a concurrent single-frame WriteAsync.
            lock (_writeLock)
            {
                foreach (var frame in frames)
                {
                    if (frame.Payload.Length != 8) continue;
                    var len = EncodeFrame(frame, frameBuffer, 0);
                    Serial!.Write(frameBuffer, 0, len);
                }
            }
        }
        catch (InvalidOperationException ex)
        {
            HandleDisconnection($"WriteBatchAsync: {ex.Message}");
            return Task.FromResult(false);
        }
        catch (IOException ex)
        {
            HandleDisconnection($"WriteBatchAsync: {ex.Message}");
            return Task.FromResult(false);
        }
        catch (UnauthorizedAccessException ex)
        {
            HandleDisconnection($"WriteBatchAsync: {ex.Message}");
            return Task.FromResult(false);
        }
        catch (Exception e)
        {
            Console.WriteLine(e.ToString());
            return Task.FromResult(false);
        }

        return Task.FromResult(true);
    }
    
    protected void StartReadLoop()
    {
        _readCts = new CancellationTokenSource();
        // Dedicated, above-normal-priority thread (not a pooled Task) so the reader is
        // never starved by GC/other work during a high-volume burst and can't fall behind
        // the OS serial buffer. It only parses frames and hands them to the (non-blocking,
        // bounded-channel) pipeline, so processing is decoupled from reading.
        _readThread = new Thread(() => ReadLoop(_readCts.Token))
        {
            IsBackground = true,
            Priority = ThreadPriority.AboveNormal,
            Name = "SlcanRead"
        };
        _readThread.Start();
    }

    protected void StopReadLoop()
    {
        _readCts?.Cancel();
        try { _readThread?.Join(TimeSpan.FromSeconds(2)); }
        catch
        {
            // ignored
        }

        _readCts?.Dispose();
        _readCts = null;
        _readThread = null;
    }

    private void ReadLoop(CancellationToken ct)
    {
        var stream = Serial?.BaseStream;
        if (stream == null) return;

        var readBuf = new byte[16384];
        var line = new byte[64];       // an SLCAN 't' frame is <= 22 bytes
        var lineLen = 0;

        while (!ct.IsCancellationRequested && (Serial?.IsOpen ?? false))
        {
            int n;
            try
            {
                n = stream.Read(readBuf, 0, readBuf.Length); // bulk read; honors ReadTimeout
            }
            catch (TimeoutException) { continue; }
            catch (OperationCanceledException) { return; }
            catch (InvalidOperationException ex) { HandleDisconnection($"ReadLoop: {ex.Message}"); return; }
            catch (IOException ex) { HandleDisconnection($"ReadLoop: {ex.Message}"); return; }
            catch (ArgumentException ex) { HandleDisconnection($"ReadLoop: {ex.Message}"); return; }
            if (n <= 0) continue;

            for (var i = 0; i < n; i++)
            {
                var c = readBuf[i];
                if (c == (byte)'\r')
                {
                    if (lineLen > 0) { ProcessFrameBytes(line, lineLen); lineLen = 0; }
                }
                else if (c != (byte)'\n')
                {
                    if (lineLen < line.Length) line[lineLen++] = c;
                    else lineLen = 0; // overrun (garbage) → drop and resync at next '\r'
                }
            }
        }
    }

    // '0'-'9' → 0-9, 'A'-'F'/'a'-'f' → 10-15; no string allocation
    private static int HexByteToInt(byte c) =>
        c <= (byte)'9' ? c - (byte)'0' : (c & 0x1F) + 9;

    // A line may hold several frames if a '\r' was dropped under load (issue #56: PWM bursts).
    // Parse each frame by its DLC-derived length and continue, so concatenated frames are
    // recovered instead of the whole line being discarded.
    private void ProcessFrameBytes(byte[] buf, int len)
    {
        // dingoFW 'I' identify reply: 'I' + base id (3 hex) + CR. Not a CAN frame — a dingo bridge sends it
        // over USB in answer to our 'I' request so we learn which board is the bridge. Capture and stop.
        if (len >= 4 && buf[0] == (byte)'I')
        {
            _bridgeBaseId = ((HexByteToInt(buf[1]) << 8) | (HexByteToInt(buf[2]) << 4) | HexByteToInt(buf[3])) & 0x7FF;
            return;
        }
        int off = 0, guard = 0;
        while (off < len && guard++ < 24)
        {
            int consumed = ParseOneFrame(buf, off, len);
            if (consumed <= 0) break;                  // not a frame here (ack/status/garbage)
            off += consumed;
            while (off < len && (buf[off] == (byte)'\r' || buf[off] == (byte)'\n')) off++;
        }
    }

    // Parse one SLCAN frame at `off`. Returns chars consumed, or 0 if not a frame / truncated.
    private int ParseOneFrame(byte[] buf, int off, int len)
    {
        if (off >= len) return 0;
        var kind = buf[off];
        bool ext = kind == (byte)'T' || kind == (byte)'R';     // 29-bit
        bool std = kind == (byte)'t' || kind == (byte)'r';     // 11-bit
        bool remote = kind == (byte)'r' || kind == (byte)'R';
        if (!std && !ext) return 0;                            // status/ack line — stop
        int idLen = ext ? 8 : 3;
        int dlcPos = off + 1 + idLen;
        if (dlcPos >= len) return 0;
        int dlc = HexByteToInt(buf[dlcPos]);
        if (dlc < 0 || dlc > 8) return 0;
        int frameLen = 1 + idLen + 1 + (remote ? 0 : dlc * 2);
        if (off + frameLen > len) return 0;                    // truncated — wait for more
        try
        {
            if (RxStopwatch != null) { RxTimeDelta = new TimeSpan(RxStopwatch.ElapsedMilliseconds); RxStopwatch.Restart(); }
            int id = 0;
            for (int k = 0; k < idLen; k++) id = (id << 4) | HexByteToInt(buf[off + 1 + k]);
            var payload = new byte[dlc > 0 ? dlc : 8];
            // Accept-filter at the wire: under a flood, dropping out-of-range ids here (a cheap int
            // compare) instead of in the handlers is what keeps the reader draining fast enough.
            // RxStopwatch above still updated for every frame, so connection monitoring is unaffected.
            if (_acceptLo >= 0 && (id < _acceptLo || id > _acceptHi)) return frameLen;
            for (int i = 0; i < dlc && !remote; i++)
                payload[i] = (byte)((HexByteToInt(buf[dlcPos + 1 + i * 2]) << 4) | HexByteToInt(buf[dlcPos + 2 + i * 2]));
            DataReceived?.Invoke(this, new CanFrameEventArgs(new CanFrame(id, dlc, payload, IsExtended: ext)));
        }
        catch (IndexOutOfRangeException) { }
        return frameLen;
    }

    private void _serial_ErrorReceived(object sender, SerialErrorReceivedEventArgs e)
    {
        HandleDisconnection($"serial error: {e.EventType}");
    }

    protected void StartConnectionMonitor()
    {
        // Start connection monitoring (check every 500ms)
        ConnectionMonitorTimer = new Timer(MonitorConnection, null,
            TimeSpan.FromMilliseconds(500),
            TimeSpan.FromMilliseconds(500));
    }

    protected void StopConnectionMonitor()
    {
        ConnectionMonitorTimer?.Dispose();
        ConnectionMonitorTimer = null;
    }

    private void MonitorConnection(object? state)
    {
        if (!IsConnected) return;

        try
        {
            // Cross-platform approach: Check if the port still exists in the system
            // Works on Linux, Windows, and macOS
            if (string.IsNullOrEmpty(PortName))
            {
                HandleDisconnection();
                return;
            }

            var availablePorts = SerialPort.GetPortNames();
            if (!availablePorts.Contains(PortName))
            {
                // Port no longer exists - device was unplugged
                HandleDisconnection();
            }
        }
        catch (Exception)
        {
            // Exception during port enumeration
            HandleDisconnection();
        }
    }

    protected void HandleDisconnection(string? reason = null)
    {
        //Note: Disconnecting is handled by the CommsAdapterManager
        // Preserve the failure context (previously swallowed) so a drop can be diagnosed.
        if (reason != null) Console.WriteLine($"[{Name}] disconnect: {reason}");
        Disconnected?.Invoke(this, EventArgs.Empty);
    }

    private int ToSlcanBitrate(CanBitRate canBitRate)
    {
        return canBitRate switch
        {
            CanBitRate.BitRate100K => 3,
            CanBitRate.BitRate125K => 4,
            CanBitRate.BitRate250K => 5,
            CanBitRate.BitRate500K => 6,
            CanBitRate.BitRate1000K => 8,
            //Default to 500k
            _ => 6
        };
    }
}