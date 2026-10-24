using application.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>SWD flash refuses what pyOCD must never be started with (it writes whatever it gets).</summary>
public class SwdFlashTests
{
    private static readonly FirmwareFlashService Flasher = new(null!, null!, NullLogger<FirmwareFlashService>.Instance);

    // a .bin whose reset vector points into flash at 0x08000000
    private static byte[] Bin(int size)
    {
        var b = new byte[size];
        BitConverter.GetBytes(0x20004000u).CopyTo(b, 0);
        BitConverter.GetBytes(0x08000201u).CopyTo(b, 4);
        return b;
    }

    [Theory]
    [InlineData("stm32", "a.srec", "unknown board")]
    [InlineData("canboard", "a.exe", "pick a .srec")]
    [InlineData("canboard", "a.txt", "pick a .srec")]
    public async Task Refuses_BadBoardOrFile(string board, string name, string why)
    {
        var r = await Flasher.SwdFlashAsync(board, name, Bin(4096));
        Assert.False(r.Ok);
        Assert.Contains(why, r.Log);
    }

    [Fact]
    public async Task Refuses_ABinTooBigForTheChip()
    {
        var r = await Flasher.SwdFlashAsync("canboard", "big.bin", Bin(70 * 1024));   // CANBoard: 64 KB
        Assert.False(r.Ok);
        Assert.Contains("does not fit", r.Log);
    }

    [Fact]
    public async Task Refuses_ABinThatIsNotFirmware()
    {
        var r = await Flasher.SwdFlashAsync("dingopdm", "zeros.bin", new byte[4096]);
        Assert.False(r.Ok);
        Assert.Contains("reset vector", r.Log);
    }
}
