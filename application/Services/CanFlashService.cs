using System.Text;
using domain.Firmware;
using domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace application.Services;

/// <summary>
/// Flashes a module's application firmware over CAN using the OpenBLT XCP-over-CAN bootloader,
/// driving the live SLCAN connection (no port hand-off, unlike USB-DFU). Sequence: command the
/// app into the bootloader (MsgCmd::Bootloader) → XCP connect on the module's base+12/+13 →
/// program-start → erase + write each S-record segment → (optional) read-back verify →
/// program-reset (runs the new app) → re-read the version. Live progress via <see cref="Status"/>.
/// </summary>
public sealed class CanFlashService(
    DeviceManager dm,
    ICommsAdapterManager adapters,
    ILogger<CanFlashService> logger)
{
    public record FlashResult(bool Ok, string Log, string? Version = null);
    public record FlashStatus(bool Busy, int Percent, string Phase);

    // The CANBoard application is relocated above the 16 KB bootloader (see canboard_v2.ld).
    private const uint CanboardAppBase = 0x08004000;

    private volatile int _percent;
    private volatile string _phase = "idle";
    private volatile bool _busy;
    public FlashStatus Status() => new(_busy, _percent, _phase);
    private void Set(string phase, int percent) { _phase = phase; _percent = percent; }

    public async Task<FlashResult> FlashAsync(Guid deviceId, byte[] srec, CancellationToken ct = default)
    {
        var log = new StringBuilder();

        // 1. Parse the S-record.
        SRecordImage image;
        try { image = SRecordImage.ParseText(Encoding.ASCII.GetString(srec)); }
        catch (Exception ex) { return new(false, $"Not a valid S-record (.srec) file: {ex.Message}"); }
        log.AppendLine($"Parsed {image.TotalBytes} bytes in {image.Segments.Count} segment(s), base 0x{image.MinAddress:X8}.");

        // 2. Wrong-board / sanity guard.
        var dev = dm.GetDevice(deviceId);
        if (dev is null) return new(false, "Device is not on the bus — connect and discover it first.");
        if (!string.Equals(dev.Type, "CANBoard", StringComparison.OrdinalIgnoreCase))
            return new(false, $"CAN flashing currently supports CANBoard only (device is '{dev.Type}'). Use USB-DFU for PDM modules.");
        if (image.MinAddress != CanboardAppBase)
            return new(false, $"Firmware base 0x{image.MinAddress:X8} does not match the CANBoard application base 0x{CanboardAppBase:X8} — wrong firmware for this module?");
        if (image.TotalBytes is < 1024 or > 46 * 1024)
            return new(false, $"Refused: image size {image.TotalBytes} bytes is outside the CANBoard app range (1 KB–46 KB).");

        int baseId = dev.BaseId;
        _busy = true; Set("Entering bootloader", 2);
        using var lifetime = ct.CanBeCanceled ? null : new CancellationTokenSource(TimeSpan.FromMinutes(4));
        var token = lifetime?.Token ?? ct;

        try
        {
            // 3. Command the running app into the OpenBLT CAN bootloader (MsgCmd::Bootloader = 33).
            if (!dm.RequestBootloader(deviceId))
                log.AppendLine("Device did not accept the bootloader command (continuing — it may already be in the bootloader).");
            else
                log.AppendLine("Sent bootloader command; waiting for OpenBLT…");
            await Task.Delay(700, token);   // let the app write the magic + reset into the bootloader

            using var xcp = new XcpCanMaster(adapters, baseId);

            // 4. Connect (retry while the bootloader comes up). IDs derived from the base ID.
            Set("Connecting", 5);
            if (!await xcp.ConnectAsync(retries: 25, token))
                return Fail(log, $"No XCP response on 0x{xcp.RespId:X3}. The bootloader did not come up (is it SWD-flashed? is the bus quiet?).");
            log.AppendLine($"XCP connected (cmd 0x{xcp.CmdId:X3} / resp 0x{xcp.RespId:X3}, maxCto {xcp.MaxCto}).");
            await xcp.GetStatusAsync(token);
            if (!await xcp.ProgramStartAsync(token))
                return Fail(log, "PROGRAM_START refused by the bootloader.");

            // 5. Erase + write each segment.
            int total = image.TotalBytes, written = 0;
            foreach (var seg in image.Segments)
            {
                Set("Erasing", 8);
                if (!await xcp.ClearMemoryAsync(seg.Address, (uint)seg.Data.Length, token))
                    return Fail(log, $"Erase failed at 0x{seg.Address:X8}.");
                if (!await xcp.WriteDataAsync(seg.Address, seg.Data, n =>
                        Set("Writing", 10 + (int)(55L * (written + n) / Math.Max(total, 1))), token))
                    return Fail(log, $"Programming failed in segment at 0x{seg.Address:X8}.");
                written += seg.Data.Length;
            }
            log.AppendLine($"Programmed {written} bytes.");

            // 6. End programming FIRST. PROGRAM(0) flushes the bootloader's buffered blocks,
            // including the vector block which OpenBLT (with our FlashDone reorder) writes LAST.
            // The read-back verify must come after this, or the vector region at the app base
            // would still be unwritten and falsely mismatch.
            Set("Finishing", 68);
            if (!await xcp.ProgramDoneAsync(token))
                return Fail(log, "End-of-programming (PROGRAM size 0) was refused by the bootloader.");

            // 7. Verify by reading back and comparing (catches any corruption that slipped through).
            int verified = 0;
            foreach (var seg in image.Segments)
            {
                Set("Verifying", 70);
                var read = await xcp.ReadDataAsync(seg.Address, seg.Data.Length, n =>
                        Set("Verifying", 70 + (int)(24L * (verified + n) / Math.Max(total, 1))), token);
                if (read is null)
                    return Fail(log, $"Read-back failed at 0x{seg.Address:X8} (left in bootloader — safe to retry).");
                if (!read.AsSpan().SequenceEqual(seg.Data))
                    return Fail(log, $"Verify mismatch at 0x{seg.Address:X8} — NOT starting the app (left in bootloader — retry).");
                verified += seg.Data.Length;
            }
            log.AppendLine("Read-back verify OK.");

            // 8. Reset into the freshly-programmed app.
            Set("Resetting", 96);
            await xcp.ProgramResetAsync(token);
            log.AppendLine("Programming complete — module resetting into the new app.");

            // 8. Re-discover and read back the version.
            Set("Re-discovering", 98);
            await Task.Delay(2500, token);
            var version = dm.GetDevice(deviceId) is domain.Devices.Canboard.CanboardDevice cb && cb.Connected
                ? cb.Version : null;
            Set("Done", 100);
            log.AppendLine(version is { Length: > 0 } ? $"✓ Done — module reports {version}." : "✓ Done — module rebooting.");
            logger.LogInformation("CAN flash ok ({Bytes} bytes) for {Name}", written, dev.Name);
            return new(true, log.ToString(), version);
        }
        catch (OperationCanceledException) { return Fail(log, "Timed out / cancelled."); }
        catch (Exception ex)
        {
            logger.LogError(ex, "CAN flash error");
            return Fail(log, "Error: " + ex.Message);
        }
        finally { _busy = false; }
    }

    private FlashResult Fail(StringBuilder log, string msg)
    {
        Set("Failed", _percent);
        log.AppendLine("✗ " + msg);
        return new(false, log.ToString());
    }
}
