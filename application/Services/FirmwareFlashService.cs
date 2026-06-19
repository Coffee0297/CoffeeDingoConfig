using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace application.Services;

/// <summary>
/// In-app firmware flashing over USB DFU. Commands the device into its DFU bootloader,
/// releases the serial port, waits for the STM32 ROM DFU device (0483:df11), and runs
/// dfu-util to write the uploaded binary. Works too if the board is already in DFU.
/// dfu-util path: env var DINGO_DFU_UTIL, else the known dingo-tools location, else PATH.
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
        var known = @"C:\dingo-tools\dfu-util\dfu-util-0.11-binaries\win64\dfu-util.exe";
        if (File.Exists(known)) return known;
        return OperatingSystem.IsWindows() ? "dfu-util.exe" : "dfu-util";   // assume on PATH
    }

    public async Task<FlashResult> FlashAsync(Guid deviceId, byte[] binary)
    {
        if (binary.Length < 1024 || binary.Length > 512 * 1024)
            return new(false, $"Refused: binary size {binary.Length} bytes is outside the sane 1KB–512KB range.");

        var dfu = ResolveDfuUtil();
        var tmp = Path.Combine(Path.GetTempPath(), $"dingo_fw_{Guid.NewGuid():N}.bin");
        await File.WriteAllBytesAsync(tmp, binary);
        var log = new StringBuilder();
        _busy = true; Set("Commanding DFU", 0);
        try
        {
            // 1. If the device is on the bus, command it into the DFU bootloader.
            if (dm.GetDevice(deviceId) != null)
            {
                if (dm.RequestBootloader(deviceId)) log.AppendLine("Sent bootloader command…");
                else log.AppendLine("Device did not accept a bootloader command (continuing — may already be in DFU).");
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
            Set("Writing", 15);
            var (code, outp) = await RunAsync(dfu, $"-d {DfuId} -a 0 -s 0x08000000:leave -D \"{tmp}\"", 120_000, trackProgress: true);
            log.Append(outp);
            var ok = outp.Contains("File downloaded successfully", StringComparison.OrdinalIgnoreCase)
                     || (code == 0 && outp.Contains("Download", StringComparison.OrdinalIgnoreCase));
            Set(ok ? "Done" : "Failed", ok ? 100 : _percent);
            log.AppendLine(ok ? "✓ Flash complete — device rebooting." : $"✗ Flash failed (exit {code}).");
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
