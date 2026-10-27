using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using domain.Firmware;
using domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace application.Services;

/// <summary>
/// In-app firmware flashing over USB DFU. Commands the device into its DFU bootloader,
/// releases the serial port, waits for the STM32 ROM DFU device (0483:df11), and runs
/// dfu-util to write the uploaded binary. Works too if the board is already in DFU.
/// dfu-util path: env var DINGO_DFU_UTIL, else tools/dfu-util next to the app, else PATH.
/// Live progress is exposed via <see cref="Status"/> (polled by the UI during a flash).
/// </summary>
public partial class FirmwareFlashService(
    DeviceManager dm,
    ICommsAdapterManager adapters,
    ILogger<FirmwareFlashService> logger)
{
    public record FlashResult(bool Ok, string Log);
    public record FlashStatus(bool Busy, int Percent, string Phase);

    private const string DfuId = "0483:df11";

    // Live progress (single flash at a time). volatile ints/refs are fine for status polling.
    private volatile int _percent;
    private volatile string _phase = "idle";
    private volatile bool _busy;
    public FlashStatus Status() => new(_busy, _percent, _phase);

    private void Set(string phase, int percent) { _phase = phase; _percent = percent; }

    private static string ResolveDfuUtil()
    {
        var env = Environment.GetEnvironmentVariable("DINGO_DFU_UTIL");
        if (!string.IsNullOrWhiteSpace(env) && File.Exists(env)) return env;
        var exe = OperatingSystem.IsWindows() ? "dfu-util.exe" : "dfu-util";
        var bundled = Path.Combine(AppContext.BaseDirectory, "tools", "dfu-util", exe);   // shipped next to the app
        if (File.Exists(bundled)) return bundled;
        return exe;   // assume on PATH
    }

    /// <param name="deviceId">The project entry being updated, or Guid.Empty for "Flash new module".</param>
    /// <remarks>
    /// The write address comes from the image (<see cref="DfuImage.FlashAddress"/>): a relocated app goes to
    /// 0x08004000 — erasing only sectors 1+, so the OpenBLT bootloader in sector 0 survives — and a full
    /// image to 0x08000000.
    /// </remarks>
    public async Task<FlashResult> FlashAsync(Guid deviceId, byte[] binary)
    {
        if (binary.Length < 1024 || binary.Length > 512 * 1024)
            return new(false, $"Refused: binary size {binary.Length} bytes is outside the sane 1KB–512KB range.");
        if (DfuImage.FlashAddress(binary) is not uint flashAddr)
            return new(false, "Refused: not an STM32 firmware .bin (its reset vector doesn't point into flash).");

        var dfu = ResolveDfuUtil();
        var tmp = Path.Combine(Path.GetTempPath(), $"dingo_fw_{Guid.NewGuid():N}.bin");
        await File.WriteAllBytesAsync(tmp, binary);
        var log = new StringBuilder();
        _busy = true; Set("Commanding DFU", 0);
        try
        {
            // 1. Command the module on USB into its DFU bootloader. USB DFU only reaches that module, so address
            //    it at the id it reports ('I' identify), not the project record's — they differ for a fresh or
            //    un-burned module, and "Flash new module" has no record at all. Telemetry isn't needed: a module
            //    whose status never reaches USB (≤ v5.5.109 alone on a bench) still takes the command.
            log.AppendLine($"Image is {(flashAddr == DfuImage.AppBase ? "a bootloader-relocated app" : "a full image")} → writing at 0x{flashAddr:X8}.");
            // Asked right now, straight from the adapter: no "connected" gate (a module with no telemetry reads as
            // disconnected) and no fallback to an id remembered from earlier — that one may be another module's.
            var usb = adapters.ActiveAdapter;
            int? gw = usb != null ? await usb.IdentifyBridgeBaseIdAsync() : null;
            var dev = dm.GetDevice(deviceId);
            if (gw is int g)
            {
                dm.RequestUsbBootloaderAt(g);
                log.AppendLine(dev != null && dev.BaseId != g
                    ? $"Sent bootloader command to the module on USB (0x{g:X}; the project has it at 0x{dev.BaseId:X})…"
                    : $"Sent bootloader command to the module on USB (0x{g:X})…");
                // A module that took the command has reset off the link within a few ms; one still answering ignored it.
                await Task.Delay(500);
                if (await usb!.IdentifyBridgeBaseIdAsync() is int still)
                {
                    Set("Failed", 0);
                    log.AppendLine($"✗ The module on USB is still running (answers as 0x{still:X}) — it ignored the bootloader command" +
                        (still != g ? $" sent to 0x{g:X}." : ".") + " Retry; if it keeps refusing, put it in DFU by hand (BOOT0 + reset).");
                    return new(false, log.ToString());
                }
            }
            else if (dev != null && dm.RequestBootloader(deviceId)) log.AppendLine("Sent bootloader command…");
            else log.AppendLine("No module answered on USB — waiting for one already in DFU (BOOT0 + reset).");
            if (gw != null || dev != null)
            {
                await Task.Delay(250);              // let the command transmit…
                await adapters.DisconnectAsync();   // …then release the port BEFORE the device re-enumerates as DFU
            }

            // 2. Wait for the DFU device to enumerate (show a slow ramp 0→15% while waiting).
            bool ready = false;
            for (int i = 0; i < 24 && !ready; i++)
            {
                Set("Waiting for bootloader", Math.Min(15, i));
                await Task.Delay(500);
                ready = await DfuPresentAsync(dfu);
            }
            if (!ready)
            {
                Set("Failed", 0);
                log.AppendLine($"DFU device ({DfuId}) not reachable by dfu-util after 12s.");
                log.AppendLine("If a 'STM32 BOOTLOADER' shows in Device Manager but stays here, its driver isn't the one");
                log.AppendLine("dfu-util needs — install the WinUSB/libusb driver on the DFU device (e.g. Zadig), once.");
                log.AppendLine("Otherwise put the board in DFU (BOOT0 + reset) and retry.");
                return new(false, log.ToString());
            }
            log.AppendLine("DFU device detected — flashing…");

            // 3. Flash + leave (reboots into the new firmware). Progress parsed from dfu-util.
            //    dfu-util erases only the sectors the download covers (from flashAddr), so writing the app
            //    at 0x08004000 leaves the bootloader in sector 0 untouched.
            Set("Writing", 15);
            log.AppendLine($"Flashing {binary.Length} bytes at 0x{flashAddr:X8}…");
            var (code, outp) = await RunAsync(dfu, $"-d {DfuId} -a 0 -s 0x{flashAddr:X8}:leave -D \"{tmp}\"", 120_000, trackProgress: true);
            log.Append(outp);
            var ok = outp.Contains("File downloaded successfully", StringComparison.OrdinalIgnoreCase)
                     || (code == 0 && outp.Contains("Download", StringComparison.OrdinalIgnoreCase));
            Set(ok ? "Done" : "Failed", ok ? 100 : _percent);
            log.AppendLine(ok ? "✓ Flash complete — device rebooting." : $"✗ Flash failed (exit {code}).");
            // upstream: a relocated app only starts behind the OpenBLT bootloader; a full image overwrote sector 0
            if (ok && dev is domain.Devices.dingoPdm.PdmDevice { Family: domain.Common.FwFamily.Upstream } up) up.OpenBlt = flashAddr == DfuImage.AppBase;
            logger.LogInformation("Firmware flash {Result} ({Len} bytes)", ok ? "ok" : "failed", binary.Length);
            return new(ok, log.ToString());
        }
        catch (Exception ex)
        {
            Set("Failed", _percent);
            logger.LogError(ex, "Firmware flash error");
            return new(false, log + "\nError: " + ex.Message);
        }
        finally { _busy = false; try { File.Delete(tmp); } catch { /* ignore */ } }
    }

    private async Task<bool> DfuPresentAsync(string dfu)
    {
        try { var (_, outp) = await RunAsync(dfu, "-l", 8_000); return outp.Contains(DfuId, StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    public record DfuScan(bool UtilOk, string Util, int DfuDevices, string Raw);

    /// <summary>List what dfu-util sees right now — so the UI can show the operator their DFU device
    /// (or tell them nothing is detected). Counts "Found DFU:" lines (STM32 ROM DFU = 0483:df11).</summary>
    public async Task<DfuScan> ScanAsync()
    {
        var dfu = ResolveDfuUtil();
        try
        {
            var (_, outp) = await RunAsync(dfu, "-l", 8_000);
            // A single STM32 in DFU shows up as several "Found DFU:" lines — one per alt setting
            // (Internal Flash, Option Bytes, OTP, Device Feature). Count DISTINCT physical devices by
            // devnum so "4 interfaces" doesn't read as "4 boards". ("Found Runtime:" lines are apps
            // advertising DFU, not in the bootloader — ignored.)
            var devs = new HashSet<string>();
            foreach (Match m in DfuDevnumRegex().Matches(outp)) devs.Add(m.Groups[1].Value);
            return new(true, dfu, devs.Count, outp.Trim());
        }
        catch (Exception ex)
        {
            return new(false, dfu, 0, $"Could not run dfu-util ({dfu}): {ex.Message}");
        }
    }

    [GeneratedRegex(@"Found DFU:[^\n]*?devnum=(\d+)")] private static partial Regex DfuDevnumRegex();

    // ---- SWD: a debug probe (CMSIS-DAP, ST-Link, J-Link) through pyOCD, for what USB and CAN can't reach (a CANBoard's
    // bootloader, a bricked board). pyocd path: env var DINGO_PYOCD, else PATH. Only whole-chip targets we know.
    /// <param name="SettingsPage">Where the board stores its settings in flash (null: in external FRAM, out of SWD's reach).</param>
    public record SwdBoard(string Target, int FlashKb, uint? SettingsPage = null);
    public static readonly IReadOnlyDictionary<string, SwdBoard> SwdBoards = new Dictionary<string, SwdBoard>
    {
        ["canboard"] = new("stm32f303k8", 64, 0x0800F800),   // STM32F303x8; settings: the last 2 KB page (CONFIG_SECTOR 31)
        ["dingopdm"] = new("stm32f446re", 512),              // STM32F446, settings in FRAM
        ["dingopdmmax"] = new("stm32f446re", 512),
    };

    private static string ResolvePyocd()
    {
        var env = Environment.GetEnvironmentVariable("DINGO_PYOCD");
        return !string.IsNullOrWhiteSpace(env) && File.Exists(env) ? env : "pyocd";
    }

    public record SwdScan(bool ToolOk, string Tool, int Probes, string Raw);

    /// <summary>The probes pyOCD sees ("pyocd list": one numbered row per probe).</summary>
    public async Task<SwdScan> SwdScanAsync()
    {
        var tool = ResolvePyocd();
        try
        {
            var (_, outp) = await RunAsync(tool, "list", 15_000);
            return new(true, tool, ProbeRowRegex().Matches(outp).Count, outp.Trim());
        }
        catch (Exception ex) { return new(false, tool, 0, $"Could not run pyocd ({tool}): {ex.Message}. Install it with: pip install pyocd"); }
    }

    [GeneratedRegex(@"(?m)^\s+\d+\s+\S")] private static partial Regex ProbeRowRegex();

    /// <summary>Write an image over SWD. pyOCD erases only the sectors the image covers, so a bootloader (0x08000000)
    /// leaves the app alone and an app leaves the bootloader alone. A .bin goes where its reset vector says.</summary>
    /// <param name="baseId">The ID the board starts on while it has no stored settings (patched into the image's
    /// DINGO_BASEID= marker, see <see cref="BaseIdPatch"/>); null leaves the image's default.</param>
    public async Task<FlashResult> SwdFlashAsync(string board, string fileName, byte[] image, int? baseId = null)
    {
        if (!SwdBoards.TryGetValue(board ?? "", out var b)) return new(false, $"Refused: unknown board '{board}'.");
        var ext = Path.GetExtension(fileName ?? "").ToLowerInvariant();
        if (ext is not (".srec" or ".hex" or ".bin" or ".elf")) return new(false, "Refused: pick a .srec, .hex, .bin or .elf file.");
        if (image.Length < 64 || image.Length > 4 * 1024 * 1024) return new(false, $"Refused: the file is {image.Length} bytes.");
        if (baseId is int id)
        {
            var (patched, newExt, why) = BaseIdPatch.Apply(image, ext, id);
            if (patched is null) return new(false, $"Refused: {why}.");
            (image, ext) = (patched, newExt);
        }
        var baseArg = "";
        if (ext == ".bin")
        {
            if (image.Length > b.FlashKb * 1024) return new(false, $"Refused: {image.Length / 1024} KB does not fit the {b.FlashKb} KB flash.");
            if (DfuImage.FlashAddress(image) is not uint a) return new(false, "Refused: not an STM32 firmware .bin (its reset vector doesn't point into flash).");
            baseArg = $" --base-address 0x{a:X8}";
        }
        if (_busy) return new(false, "Refused: another flash is running.");

        var tmp = Path.Combine(Path.GetTempPath(), $"dingo_swd_{Guid.NewGuid():N}{ext}");
        await File.WriteAllBytesAsync(tmp, image);
        var log = new StringBuilder($"pyOCD → {b.Target} ({board}), {fileName}{baseArg}" +
            (baseId is int bid ? $"; starts on base ID 0x{bid:X3} while it has no stored settings" : "") + "\n");
        _busy = true; Set("Writing", 15);
        try
        {
            // A base ID only takes on a board with no stored settings: erase its settings page first, so it starts on it
            // after the flash's reset (factory settings: apply its config over CAN). FRAM (a PDM) is out of SWD's reach.
            if (baseId is int && b.SettingsPage is uint page)
            {
                Set("Erasing stored settings", 10);
                var (ec, eo) = await RunAsync(ResolvePyocd(), $"erase -t {b.Target} --sector 0x{page:X8}", 60_000);
                log.Append(eo);
                if (ec != 0) { Set("Failed", 0); log.AppendLine($"✗ Could not erase the stored settings (exit {ec}): nothing was flashed."); return new(false, log.ToString()); }
                log.AppendLine($"Stored settings erased (page 0x{page:X8}): the board starts on factory settings and base ID 0x{baseId:X3}.");
            }
            else if (baseId is int)
                log.AppendLine($"This board keeps its settings in FRAM: with stored settings it keeps its own ID (move it with Deploy to USB).");
            var (code, outp) = await RunAsync(ResolvePyocd(), $"flash -t {b.Target}{baseArg} \"{tmp}\"", 180_000, trackProgress: true);
            log.Append(outp);
            var ok = code == 0;
            Set(ok ? "Done" : "Failed", ok ? 100 : _percent);
            log.AppendLine(ok ? (baseId is int id2 && b.SettingsPage is not null ? $"✓ Flash complete — the board restarts on base ID 0x{id2:X3}." : "✓ Flash complete — the board restarts.")
                : $"✗ Flash failed (exit {code}). Check the probe wiring (SWDIO, SWCLK, GND) and that the board is powered.");
            logger.LogInformation("SWD flash {Result} ({Board}, {Len} bytes)", ok ? "ok" : "failed", board, image.Length);
            return new(ok, log.ToString());
        }
        catch (Exception ex)
        {
            Set("Failed", _percent);
            return new(false, log + $"\nCould not run pyocd: {ex.Message}. Install it with: pip install pyocd");
        }
        finally { _busy = false; try { File.Delete(tmp); } catch { /* ignore */ } }
    }

    [GeneratedRegex(@"(\d{1,3})%")] private static partial Regex PercentRegex();

    // dfu-util runs an erase pass then a download pass, each reporting 0→100%. Map them into
    // separate bands (erase 15→50, download 50→99) and keep the bar monotonic so it never
    // appears to jump backwards between the two passes.
    private void OnProgressLine(string line)
    {
        var m = PercentRegex().Match(line);
        if (!m.Success || !int.TryParse(m.Groups[1].Value, out var pct)) return;
        bool erase = line.Contains("Erase", StringComparison.OrdinalIgnoreCase);
        int v = erase ? 15 + pct * 35 / 100 : 50 + pct * 49 / 100;
        if (v > _percent) _percent = Math.Clamp(v, 15, 99);
    }

    private async Task<(int code, string output)> RunAsync(string exe, string args, int timeoutMs, bool trackProgress = false)
    {
        var psi = new ProcessStartInfo(exe, args)
        { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        using var p = Process.Start(psi);
        if (p == null) return (-1, "failed to start dfu-util");

        var sb = new StringBuilder();
        var pumps = Task.WhenAll(
            PumpAsync(p.StandardOutput, sb, trackProgress),
            PumpAsync(p.StandardError, sb, trackProgress));
        if (await Task.WhenAny(pumps, Task.Delay(timeoutMs)) != pumps)
        { try { p.Kill(true); } catch { } return (-1, sb + "\n(timed out)"); }
        p.WaitForExit(2000);
        return (p.ExitCode, sb.ToString());
    }

    // dfu-util redraws its progress bar with '\r', so parse on both '\r' and '\n'.
    private async Task PumpAsync(StreamReader r, StringBuilder sb, bool track)
    {
        var buf = new char[256];
        var line = new StringBuilder();
        int n;
        while ((n = await r.ReadAsync(buf, 0, buf.Length)) > 0)
        {
            for (int i = 0; i < n; i++)
            {
                var c = buf[i];
                lock (sb) sb.Append(c);
                if (c == '\r' || c == '\n') { if (track && line.Length > 0) OnProgressLine(line.ToString()); line.Clear(); }
                else line.Append(c);
            }
        }
        if (track && line.Length > 0) OnProgressLine(line.ToString());
    }
}
