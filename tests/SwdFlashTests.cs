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

    // an image with the DINGO_BASEID= marker at an odd offset, default 0x640
    private static byte[] WithMarker()
    {
        var b = Bin(4096);
        var tag = System.Text.Encoding.ASCII.GetBytes("DINGO_BASEID=\0");
        tag.CopyTo(b, 1003);
        b[1017] = 0x40; b[1018] = 0x06;
        return b;
    }

    [Fact]
    public void BaseIdPatch_Bin_SetsTheId()
    {
        var (img, ext, err) = domain.Firmware.BaseIdPatch.Apply(WithMarker(), ".bin", 0x7A0);
        Assert.Null(err);
        Assert.Equal(".bin", ext);
        Assert.Equal(0x7A0, domain.Firmware.BaseIdPatch.Read(img!));
        Assert.Equal(0x640, domain.Firmware.BaseIdPatch.Read(WithMarker()));   // the input is not changed
    }

    [Fact]
    public void BaseIdPatch_Hex_SetsTheIdEvenAcrossRecords()
    {
        // 16-byte records: the marker at 1003..1018 spans two of them
        var hex = domain.Firmware.BaseIdPatch.ToIntelHex([new domain.Firmware.SRecordImage.Segment(0x08002000, WithMarker())]);
        var (img, ext, err) = domain.Firmware.BaseIdPatch.Apply(System.Text.Encoding.ASCII.GetBytes(hex), ".hex", 0x7A0);
        Assert.Null(err);
        Assert.Equal(".hex", ext);
        var back = domain.Firmware.SRecordImage.ParseText(System.Text.Encoding.ASCII.GetString(img!));
        Assert.Equal(0x08002000u, back.MinAddress);
        Assert.Equal(0x7A0, domain.Firmware.BaseIdPatch.Read(back.Segments[0].Data));
    }

    [Fact]
    public async Task BaseId_RefusesAnImageWithoutTheMarker()
    {
        Assert.NotNull(domain.Firmware.BaseIdPatch.Apply(Bin(4096), ".bin", 0x7A0).Error);
        var r = await Flasher.SwdFlashAsync("canboard", "old.bin", Bin(4096), 0x7A0);
        Assert.False(r.Ok);
        Assert.Contains("5.7.4", r.Log);
    }

    [Fact]
    public async Task Refuses_ABinThatIsNotFirmware()
    {
        var r = await Flasher.SwdFlashAsync("dingopdm", "zeros.bin", new byte[4096]);
        Assert.False(r.Ok);
        Assert.Contains("reset vector", r.Log);
    }
}
