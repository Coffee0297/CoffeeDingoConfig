using domain.Firmware;
using Xunit;

namespace tests;

/// <summary>The USB-DFU flash address comes from the image's reset vector — a wrong pick bricks the bootloader.</summary>
public class DfuImageTests
{
    private static byte[] Bin(uint sp, uint reset)
    {
        var b = new byte[1024];
        BitConverter.GetBytes(sp).CopyTo(b, 0);
        BitConverter.GetBytes(reset).CopyTo(b, 4);
        return b;
    }

    [Fact] public void RelocatedApp_GoesAboveTheBootloader() =>
        Assert.Equal(DfuImage.AppBase, DfuImage.FlashAddress(Bin(0x20000400, 0x0800431D)));   // dingopdm_v7 v5.5.110

    [Fact] public void FullImage_GoesToFlashBase() =>
        Assert.Equal(DfuImage.FlashBase, DfuImage.FlashAddress(Bin(0x2001FFF0, 0x08000215)));  // OpenBLT in sector 0

    [Fact] public void NotAFlashImage_IsRefused()
    {
        Assert.Null(DfuImage.FlashAddress(Bin(0x20000400, 0x20000100)));   // reset vector in RAM
        Assert.Null(DfuImage.FlashAddress(Bin(0xFFFFFFFF, 0xFFFFFFFF)));   // erased / junk
        Assert.Null(DfuImage.FlashAddress(new byte[4]));
    }
}
