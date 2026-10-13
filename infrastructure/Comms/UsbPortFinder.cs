using System.IO.Ports;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace infrastructure.Comms;

/// <summary>
/// Finds the serial ports of dingoPDM / CANBoard modules plugged in over USB, so the "USB" interface can
/// connect without the user picking a COM port. The firmware enumerates as ST's virtual COM port, VID 0483
/// PID 5740 (dingoFW comms/usb.cpp). Windows: the USB enum keys in the registry; Linux: sysfs. Only ports
/// that are present right now are returned (the registry remembers every module ever plugged in).
/// </summary>
public static class UsbPortFinder
{
    public const string Vid = "0483", Pid = "5740";

    public static string[] Find()
    {
        var present = SerialPort.GetPortNames();
        IEnumerable<string> found = OperatingSystem.IsWindows() ? FromRegistry()
            : OperatingSystem.IsLinux() ? FromSysfs("/sys/class/tty") : [];   // ponytail: no macOS lookup, pick the port as SLCAN there
        return found.Where(p => present.Contains(p, StringComparer.OrdinalIgnoreCase))
                    .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    [SupportedOSPlatform("windows")]
    private static IEnumerable<string> FromRegistry()
    {
        using var usb = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\USB");
        if (usb is null) yield break;
        // VID_0483&PID_5740, or VID_0483&PID_5740&MI_xx if a firmware ever makes it a composite device
        foreach (var dev in usb.GetSubKeyNames().Where(n => n.StartsWith($"VID_{Vid}&PID_{Pid}", StringComparison.OrdinalIgnoreCase)))
        {
            using var dk = usb.OpenSubKey(dev);
            if (dk is null) continue;
            foreach (var inst in dk.GetSubKeyNames())
            {
                using var dp = dk.OpenSubKey($@"{inst}\Device Parameters");
                if (dp?.GetValue("PortName") is string port) yield return port;
            }
        }
    }

    /// <summary>Linux: /sys/class/tty/ttyACMn/device is the USB interface; its parent holds idVendor/idProduct.</summary>
    public static IEnumerable<string> FromSysfs(string ttyRoot)
    {
        if (!Directory.Exists(ttyRoot)) yield break;
        foreach (var tty in Directory.GetDirectories(ttyRoot))
        {
            var usbDev = Path.Combine(tty, "device", "..");
            string Read(string f) { try { return File.ReadAllText(Path.Combine(usbDev, f)).Trim(); } catch { return ""; } }
            if (Read("idVendor").Equals(Vid, StringComparison.OrdinalIgnoreCase) && Read("idProduct").Equals(Pid, StringComparison.OrdinalIgnoreCase))
                yield return "/dev/" + Path.GetFileName(tty);
        }
    }
}
