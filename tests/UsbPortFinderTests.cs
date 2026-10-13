using infrastructure.Comms;
using Xunit;

namespace tests;

/// <summary>Linux lookup: only ttys whose USB device is 0483:5740 (the dingo firmware) are returned.</summary>
public class UsbPortFinderTests
{
    [Fact]
    public void SysfsMatchesDingoVidPidOnly()
    {
        var root = Directory.CreateTempSubdirectory("tty").FullName;
        void Tty(string name, string vid, string pid)
        {
            Directory.CreateDirectory(Path.Combine(root, name, "device"));   // device/.. = the tty dir here
            File.WriteAllText(Path.Combine(root, name, "idVendor"), vid + "\n");
            File.WriteAllText(Path.Combine(root, name, "idProduct"), pid + "\n");
        }
        Tty("ttyACM0", "0483", "5740");   // dingoPDM
        Tty("ttyACM1", "0483", "374b");   // ST-Link VCP: same vendor, other product
        Tty("ttyUSB0", "0403", "6001");   // FTDI
        Directory.CreateDirectory(Path.Combine(root, "tty0"));   // no USB device at all
        Assert.Equal(["/dev/ttyACM0"], UsbPortFinder.FromSysfs(root).ToArray());
        Directory.Delete(root, true);
    }
}
