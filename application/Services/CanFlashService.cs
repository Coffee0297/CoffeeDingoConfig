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
    // Started: the module was sent to its bootloader (false: refused before anything reached it, it runs as before)
    public record FlashResult(bool Ok, string Log, string? Version = null, bool Started = false);
    public record FlashStatus(bool Busy, int Percent, string Phase);

    // OpenBLT PDMs relocate the app above the 16 KB bootloader to sector 1 (CANBoards from 5.7: DfuImage.CanboardAppBase).
    private const uint AppBase = DfuImage.AppBase;

    private volatile int _percent;
    private volatile string _phase = "idle";
    private volatile bool _busy;
    private int _running;
    public FlashStatus Status() => new(_busy, _percent, _phase);
    private void Set(string phase, int percent) { _phase = phase; _percent = percent; }

    public async Task<FlashResult> FlashAsync(Guid deviceId, byte[] srec, CancellationToken ct = default)
    {
        var log = new StringBuilder();

        // 1. Parse the S-record (or the Intel HEX that upstream dingoFW releases ship).
        SRecordImage image;
        try { image = SRecordImage.ParseText(Encoding.ASCII.GetString(srec)); }
        catch (Exception ex) { return new(false, $"Not a valid .srec / .hex file: {ex.Message}"); }
        log.AppendLine($"Parsed {image.TotalBytes} bytes in {image.Segments.Count} segment(s), base 0x{image.MinAddress:X8}.");

        // 2. Wrong-board / sanity guard. Any board carrying the OpenBLT CAN bootloader can be
        // flashed over CAN (CANBoard, dingoPDM, dingoPDM-Max); they all relocate the app to 0x08004000.
        var dev = dm.GetDevice(deviceId);
        if (dev is null) return new(false, "Device is not on the bus — connect and discover it first.");
        bool upstream = dev is IDeviceConfigurable { Family: domain.Common.FwFamily.Upstream };
        if (dev is not IDeviceConfigurable cfg || !cfg.CanBootloader)
            return new(false, upstream
                ? $"Refused: {dev.Name} runs upstream dingoFW and is not known to have the OpenBLT CAN bootloader. Plain upstream firmware answers a CAN update by going to USB-DFU. Program the bootloader once (SWD or USB), then mark it on the Firmware page."
                : $"'{dev.Type}' does not have the OpenBLT CAN bootloader — it can't be flashed over CAN.");
        // The app starts where the .srec says: PDMs 0x08004000; a CANBoard 0x08002000 (5.7, 8 KB bootloader) or 0x08004000 (5.x).
        bool isCanboard = string.Equals(dev.Type, "CANBoard", StringComparison.OrdinalIgnoreCase);
        if (!DfuImage.IsAppBase(image.MinAddress, isCanboard))
            return new(false, $"Firmware base 0x{image.MinAddress:X8} does not match the relocated application base 0x{AppBase:X8}{(isCanboard ? $" or 0x{DfuImage.CanboardAppBase:X8}" : "")} — wrong firmware (or not a bootloader-relocated build) for this module?");
        bool newCbLoader = isCanboard && image.MinAddress == DfuImage.CanboardAppBase;
        if (newCbLoader)
            log.AppendLine("CANBoard image at 0x08002000: needs the 8 KB CANBoard bootloader (programmed once over SWD). With the old 16 KB one the erase fails and the module stays in its bootloader.");
        // CANBoard app region: 54 KB behind the 8 KB bootloader, 46 KB behind the old 16 KB one; the F446 PDMs are 368 KB
        // (sectors 1–6), upstream 496 KB (sectors 1–7).
        int maxBytes = (isCanboard ? (newCbLoader ? 54 : 46) : upstream ? 496 : 368) * 1024;
        if (image.TotalBytes < 1024 || image.TotalBytes > maxBytes)
            return new(false, $"Refused: image size {image.TotalBytes} bytes is outside the {dev.Type} app range (1 KB–{maxBytes / 1024} KB).");
        // A v7 and a -Max share the MCU and app base, so only the marker tells their images apart.
        if (image.BoardMarker() is string board && !SRecordImage.BoardMatches(board, dev.Type))
            return new(false, $"Refused: this .srec is built for a {board}, not a {dev.Type}.");

        int baseId = dev.BaseId;
        string? Ver() => dm.GetDevice(deviceId) switch
        {
            domain.Devices.Canboard.CanboardDevice cb => cb.Version,
            domain.Devices.dingoPdm.PdmDevice p => p.Version,
            _ => null,
        } is { Length: > 0 } v && v != "v0.0.0" ? v : null;
        var before = Ver();
        // one update at a time: a second one (another window, a reload) moved the receive filter off the first module
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0) return new(false, "Refused: another module is being updated over CAN. Wait until it is done.");
        _busy = true; Set("Entering bootloader", 2);
        using var lifetime = ct.CanBeCanceled ? null : new CancellationTokenSource(TimeSpan.FromMinutes(4));
        var token = lifetime?.Token ?? ct;

        try
        {
            // 3. Command the running app into the OpenBLT CAN bootloader (MsgCmd::Bootloader = 33,
            // byte 6 = 1 = CAN-update entry; on the PDMs byte 6 = 0 would mean USB-DFU instead).
            if (!dm.RequestBootloader(deviceId, canUpdate: true))
                log.AppendLine("Device did not accept the bootloader command (continuing — it may already be in the bootloader).");
            else
                log.AppendLine("Sent bootloader command; waiting for OpenBLT…");
            await Task.Delay(700, token);   // let the app write the magic + reset into the bootloader

            // Admit only the bootloader's XCP response id at the adapter's read loop, so a flooded bus
            // can't bury the response or stall the per-frame DataReceived handlers during programming
            // (the reason a CAN flash failed on a saturated bus). Cleared after reset and in finally.
            // SuspendConfigFilter first so a config exchange done seconds ago can't let its idle timer
            // lift this filter out from under the flash.
            dm.SuspendConfigFilter();
            adapters.ActiveAdapter?.SetReceiveFilter(baseId + 13);

            using var xcp = new XcpCanMaster(adapters, baseId);

            // 4. Connect (retry while the bootloader comes up). IDs derived from the base ID.
            Set("Connecting", 5);
            if (!await xcp.ConnectAsync(retries: 25, token))
            {
                // upstream: it answered no bootloader, so it isn't offered a CAN update again until someone says it has one
                if (dm.GetDevice(deviceId) is domain.Devices.dingoPdm.PdmDevice { Family: domain.Common.FwFamily.Upstream } up) up.OpenBlt = false;
                return Fail(log, $"No XCP response on 0x{xcp.RespId:X3}. The bootloader did not come up (is it SWD-flashed? is the bus quiet?)."
                    + (upstream ? " Plain upstream firmware goes to USB-DFU instead: power-cycle the module to get it back." : ""));
            }
            if (dm.GetDevice(deviceId) is domain.Devices.dingoPdm.PdmDevice { Family: domain.Common.FwFamily.Upstream } seen) seen.OpenBlt = true;
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
                    return Fail(log, $"Erase failed at 0x{seg.Address:X8}." + (newCbLoader ? " This CANBoard probably still has the old 16 KB bootloader: program the 8 KB one over SWD once." : ""));
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

            // Lift the receive filter so the re-discover / version read below sees the app's telemetry.
            adapters.ActiveAdapter?.SetReceiveFilter(null);

            // 8. Re-discover, then actively request the version so we can confirm the new app.
            // (The app only broadcasts its version on request, so without this the read-back
            // would still show the default until the next manual query.)
            Set("Re-discovering", 98);
            await Task.Delay(1500, token);          // let the app boot and rejoin the bus
            // The old version stays until the new app answers, so wait for it to change; a reflash of the
            // same version never changes it, and then the (identical) version it had is the answer.
            string? version = null;
            for (int i = 0; i < 10 && version is null; i++)
            {
                if (i % 4 == 0) dm.RequestVersion(deviceId);   // (re)ask every ~1.2 s
                await Task.Delay(300, token);
                if (Ver() is string v && v != before) version = v;
            }
            version ??= Ver();
            Set("Done", 100);
            log.AppendLine(version is not null ? $"✓ Done — module reports {version}." : "✓ Done — module rebooting (version not yet reported).");
            logger.LogInformation("CAN flash ok ({Bytes} bytes) for {Name}", written, dev.Name);
            return new(true, log.ToString(), version, true);
        }
        catch (OperationCanceledException) { return Fail(log, "Timed out / cancelled."); }
        catch (Exception ex)
        {
            logger.LogError(ex, "CAN flash error");
            return Fail(log, "Error: " + ex.Message);
        }
        finally { adapters.ActiveAdapter?.SetReceiveFilter(null); dm.ResumeConfigFilter(); _busy = false; _running = 0; }
    }

    private FlashResult Fail(StringBuilder log, string msg)
    {
        Set("Failed", _percent);
        log.AppendLine("✗ " + msg);
        return new(false, log.ToString(), null, true);
    }
}
