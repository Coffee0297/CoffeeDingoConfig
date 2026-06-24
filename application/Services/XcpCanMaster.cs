using domain.Interfaces;
using domain.Models;

namespace application.Services;

/// <summary>
/// XCP-over-CAN master for the OpenBLT bootloader, driving the live CAN adapter directly.
/// Ports the command set/sequence of LibOpenBLT's xcploader.c. One XCP packet == one classic
/// CAN frame (maxCTO/maxDTO == 8). The module's XCP identifiers are derived from its base ID:
/// command (tool→bootloader) = base+12, response (bootloader→tool) = base+13 — matching the
/// firmware's DingoLoadCanConfig(). Request/response is strictly serialized (XCP is one command
/// at a time); every command is validated against the bootloader's positive response (0xFF) so
/// a corrupted/lost frame aborts the flash rather than silently writing garbage.
/// </summary>
public sealed class XcpCanMaster(ICommsAdapterManager adapters, int baseId) : IDisposable
{
    // XCP command codes (see LibOpenBLT xcploader.c).
    private const byte CmdConnect = 0xFF, CmdDisconnect = 0xFE, CmdGetStatus = 0xFD;
    private const byte CmdSetMta = 0xF6, CmdUpload = 0xF5;
    private const byte CmdProgramStart = 0xD2, CmdProgramClear = 0xD1, CmdProgram = 0xD0;
    private const byte CmdProgramReset = 0xCF, CmdProgramMax = 0xC9;
    private const byte PidRes = 0xFF;                 // positive response

    private readonly int _cmdId = baseId + 12;        // tool → bootloader
    private readonly int _respId = baseId + 13;       // bootloader → tool

    private readonly object _gate = new();
    private TaskCompletionSource<byte[]>? _pending;
    private bool _subscribed;

    public int CmdId => _cmdId;
    public int RespId => _respId;
    public bool Intel { get; private set; } = true;   // slave byte order; OpenBLT F303 = little-endian
    public int MaxCto { get; private set; } = 8;
    public int MaxDto { get; private set; } = 8;
    public int MaxProgCto { get; private set; } = 8;

    private void Subscribe()
    {
        if (_subscribed) return;
        adapters.DataReceived += OnFrame;
        _subscribed = true;
    }

    public void Dispose()
    {
        if (_subscribed) adapters.DataReceived -= OnFrame;
        _subscribed = false;
    }

    private void OnFrame(object? sender, CanFrameEventArgs e)
    {
        if (e.Frame.Id != _respId) return;
        TaskCompletionSource<byte[]>? p;
        lock (_gate) { p = _pending; _pending = null; }
        if (p is null) return;                        // unsolicited / late frame — ignore
        var n = Math.Min(e.Frame.Len, e.Frame.Payload.Length);
        var resp = new byte[n];
        Array.Copy(e.Frame.Payload, resp, n);
        p.TrySetResult(resp);
    }

    /// <summary>Sends one XCP command packet and awaits the response on the response id.
    /// Returns the response bytes, or null on timeout / send failure.</summary>
    private async Task<byte[]?> SendAsync(byte[] packet, int len, int timeoutMs, CancellationToken ct)
    {
        Subscribe();
        var adapter = adapters.ActiveAdapter;
        if (adapter is null) return null;

        var tcs = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_gate) { _pending = tcs; }

        var payload = new byte[8];                    // WriteAsync requires an 8-byte array; Len is the DLC
        Array.Copy(packet, payload, len);
        if (!await adapter.WriteAsync(new CanFrame(_cmdId, len, payload), ct).ConfigureAwait(false))
        {
            lock (_gate) { if (_pending == tcs) _pending = null; }
            return null;
        }

        var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs, ct)).ConfigureAwait(false);
        if (done != tcs.Task)
        {
            lock (_gate) { if (_pending == tcs) _pending = null; }
            return null;                              // timeout
        }
        return await tcs.Task.ConfigureAwait(false);
    }

    private static bool Ok(byte[]? r) => r is { Length: >= 1 } && r[0] == PidRes;

    private void PutLong(uint value, byte[] buf, int off)
    {
        if (Intel)
        {
            buf[off] = (byte)value; buf[off + 1] = (byte)(value >> 8);
            buf[off + 2] = (byte)(value >> 16); buf[off + 3] = (byte)(value >> 24);
        }
        else
        {
            buf[off] = (byte)(value >> 24); buf[off + 1] = (byte)(value >> 16);
            buf[off + 2] = (byte)(value >> 8); buf[off + 3] = (byte)value;
        }
    }

    /// <summary>XCP CONNECT (with retries — the bootloader may still be coming up after reset).</summary>
    public async Task<bool> ConnectAsync(int retries, CancellationToken ct)
    {
        for (int i = 0; i < retries && !ct.IsCancellationRequested; i++)
        {
            var r = await SendAsync([CmdConnect, 0x00], 2, 1500, ct).ConfigureAwait(false);
            if (r is { Length: >= 8 } && r[0] == PidRes)
            {
                Intel = (r[2] & 0x01) == 0;
                MaxCto = r[3] == 0 ? 8 : r[3];
                MaxProgCto = MaxCto;
                MaxDto = Intel ? r[4] | (r[5] << 8) : r[5] | (r[4] << 8);
                if (MaxDto == 0) MaxDto = 8;
                return true;
            }
            await Task.Delay(200, ct).ConfigureAwait(false);
        }
        return false;
    }

    public async Task<bool> GetStatusAsync(CancellationToken ct) => Ok(await SendAsync([CmdGetStatus], 1, 1000, ct).ConfigureAwait(false));

    public async Task<bool> ProgramStartAsync(CancellationToken ct)
    {
        var r = await SendAsync([CmdProgramStart], 1, 3000, ct).ConfigureAwait(false);
        if (!Ok(r)) return false;
        if (r!.Length >= 4 && r[3] != 0) MaxProgCto = Math.Min((int)r[3], 8);   // slave-imposed program packet size
        return true;
    }

    private async Task<bool> SetMtaAsync(uint address, CancellationToken ct)
    {
        var p = new byte[8];
        p[0] = CmdSetMta; /* p[1..3] reserved/addr-ext = 0 */
        PutLong(address, p, 4);
        return Ok(await SendAsync(p, 8, 1000, ct).ConfigureAwait(false));
    }

    /// <summary>Erase the given flash range (SET_MTA then PROGRAM_CLEAR). Erase can take a while.</summary>
    public async Task<bool> ClearMemoryAsync(uint address, uint length, CancellationToken ct)
    {
        if (!await SetMtaAsync(address, ct).ConfigureAwait(false)) return false;
        var p = new byte[8];
        p[0] = CmdProgramClear; /* p[1]=absolute mode, p[2..3] reserved = 0 */
        PutLong(length, p, 4);
        return Ok(await SendAsync(p, 8, 20000, ct).ConfigureAwait(false));
    }

    /// <summary>Program a contiguous block. SET_MTA then PROGRAM_MAX (full packets) + a final
    /// PROGRAM for the remainder, exactly as LibOpenBLT's XcpLoaderWriteData. Reports bytes written.</summary>
    public async Task<bool> WriteDataAsync(uint address, byte[] data, Action<int>? onBytes, CancellationToken ct)
    {
        if (!await SetMtaAsync(address, ct).ConfigureAwait(false)) return false;
        int chunk = MaxProgCto - 1;                   // PROGRAM_MAX carries MaxProgCto-1 data bytes
        if (chunk < 1) chunk = 1;
        int offset = 0;
        while (offset < data.Length)
        {
            int n = Math.Min(chunk, data.Length - offset);
            bool ok;
            if (n == chunk)
            {
                var p = new byte[8];
                p[0] = CmdProgramMax;
                Array.Copy(data, offset, p, 1, n);
                ok = Ok(await SendAsync(p, n + 1, 5000, ct).ConfigureAwait(false));
            }
            else
            {
                var p = new byte[8];
                p[0] = CmdProgram; p[1] = (byte)n;
                Array.Copy(data, offset, p, 2, n);
                ok = Ok(await SendAsync(p, n + 2, 5000, ct).ConfigureAwait(false));
            }
            if (!ok) return false;
            offset += n;
            onBytes?.Invoke(offset);
        }
        return true;
    }

    /// <summary>Read back a range via XCP UPLOAD (SET_MTA then chunked UPLOAD), for verify-after-program.</summary>
    public async Task<byte[]?> ReadDataAsync(uint address, int length, Action<int>? onBytes, CancellationToken ct)
    {
        if (!await SetMtaAsync(address, ct).ConfigureAwait(false)) return null;
        var result = new byte[length];
        int chunk = MaxDto - 1;
        if (chunk < 1) chunk = 1;
        int offset = 0;
        while (offset < length)
        {
            int n = Math.Min(chunk, length - offset);
            var r = await SendAsync([CmdUpload, (byte)n], 2, 2000, ct).ConfigureAwait(false);
            if (!Ok(r) || r!.Length < n + 1) return null;
            Array.Copy(r, 1, result, offset, n);
            offset += n;
            onBytes?.Invoke(offset);
        }
        return result;
    }

    /// <summary>End the programming session (PROGRAM with size 0 flushes the bootloader's
    /// buffered blocks — including the vector block written last).</summary>
    public async Task<bool> ProgramDoneAsync(CancellationToken ct) =>
        Ok(await SendAsync([CmdProgram, 0x00], 2, 5000, ct).ConfigureAwait(false));

    /// <summary>Reset the module so the bootloader starts the freshly-programmed app.
    /// A response is optional (the slave resets), so success is not gated on one.</summary>
    public async Task ProgramResetAsync(CancellationToken ct)
    {
        await SendAsync([CmdProgramReset], 1, 1000, ct).ConfigureAwait(false);
    }

    /// <summary>DISCONNECT keeps the bootloader running without starting the app.</summary>
    public async Task DisconnectAsync(CancellationToken ct)
    {
        await SendAsync([CmdDisconnect], 1, 1000, ct).ConfigureAwait(false);
    }
}
