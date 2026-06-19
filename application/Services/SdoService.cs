using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging;

namespace application.Services;

/// <summary>One CANopen expedited-SDO transaction result.</summary>
public record SdoResult(bool Ok, uint Value, byte[] Raw, uint AbortCode, string? Error)
{
    public static SdoResult Success(uint value, byte[] raw) => new(true, value, raw, 0, null);
    public static SdoResult Abort(uint code) => new(false, 0, Array.Empty<byte>(), code, "SDO abort 0x" + code.ToString("X8"));
    public static SdoResult Fail(string msg) => new(false, 0, Array.Empty<byte>(), 0, msg);
}

/// <summary>
/// CANopen expedited SDO client (read/write a node's object dictionary). Used to configure
/// keypads (Blink Marine PKP / Grayhill) whose persistent settings live in their OD and are
/// only reachable over SDO — separate from the runtime LED/button traffic the PDM drives.
/// Request COB-ID 0x600+node, response 0x580+node. Expedited (≤4-byte) transfers only.
/// </summary>
public class SdoService(ICommsAdapterManager comms, ILogger<SdoService> logger)
{
    // Standard "save"/"load" signatures for OD 0x1010/0x1011 sub1.
    public const uint SaveSignature = 0x65766173; // 'evas' -> "save"
    public const uint LoadSignature = 0x64616F6C; // 'daol' -> "load"

    public Task<SdoResult> ReadAsync(int node, ushort index, byte sub, int timeoutMs = 600, CancellationToken ct = default)
    {
        var req = new byte[] { 0x40, (byte)(index & 0xFF), (byte)(index >> 8), sub, 0, 0, 0, 0 };
        return TransactAsync(node, req, isWrite: false, timeoutMs, ct);
    }

    public Task<SdoResult> WriteAsync(int node, ushort index, byte sub, uint value, int size, int timeoutMs = 600, CancellationToken ct = default)
    {
        byte cmd = size switch { 1 => 0x2F, 2 => 0x2B, 3 => 0x27, _ => 0x23 }; // expedited, size-specified
        var req = new byte[]
        {
            cmd, (byte)(index & 0xFF), (byte)(index >> 8), sub,
            (byte)(value & 0xFF), (byte)((value >> 8) & 0xFF), (byte)((value >> 16) & 0xFF), (byte)((value >> 24) & 0xFF)
        };
        return TransactAsync(node, req, isWrite: true, timeoutMs, ct);
    }

    private async Task<SdoResult> TransactAsync(int node, byte[] req, bool isWrite, int timeoutMs, CancellationToken ct)
    {
        var adapter = comms.ActiveAdapter;
        if (adapter is null || !comms.IsConnected) return SdoResult.Fail("not connected to a CAN adapter");
        if (node is <= 0 or > 0x7F) return SdoResult.Fail("invalid node id (1..127)");

        int rxId = 0x580 + node;
        var tcs = new TaskCompletionSource<CanFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
        void OnRx(object? s, CanFrameEventArgs e) { if (e.Frame.Id == rxId && e.Frame.Payload.Length >= 8) tcs.TrySetResult(e.Frame); }

        comms.DataReceived += OnRx;
        try
        {
            if (!await adapter.WriteAsync(new CanFrame(0x600 + node, 8, req), ct))
                return SdoResult.Fail("failed to transmit SDO request");

            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs, ct));
            if (done != tcs.Task) return SdoResult.Fail($"timeout — no SDO response from node {node}");

            var p = tcs.Task.Result.Payload;
            if (p[0] == 0x80) return SdoResult.Abort(BitConverter.ToUInt32(p, 4));
            // Write ack = 0x60; read response carries the value in bytes 4..7 (expedited).
            uint val = BitConverter.ToUInt32(p, 4);
            return SdoResult.Success(isWrite ? 0u : val, p);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "SDO transaction failed (node {Node})", node);
            return SdoResult.Fail(ex.Message);
        }
        finally { comms.DataReceived -= OnRx; }
    }
}
