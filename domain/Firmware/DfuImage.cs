namespace domain.Firmware;

/// <summary>
/// Where a raw .bin belongs, read from its own vector table: a bootloader-relocated app (OpenBLT keeps
/// sector 0) has its reset handler at or above 0x08004000; a full image — bootloader included, or an old
/// non-relocated app — starts in sector 0. Writing a relocated app at 0x08000000 would wipe the
/// bootloader and misplace the app, so the address is never taken from the caller.
/// </summary>
public static class DfuImage
{
    public const uint FlashBase = 0x08000000;
    public const uint AppBase = 0x08004000;
    private const uint FlashEnd = FlashBase + 0x100000;   // 1 MB: covers every STM32 dingo board

    /// <summary>The flash address to write <paramref name="bin"/> at, or null when it isn't an STM32 flash image.</summary>
    public static uint? FlashAddress(byte[] bin)
    {
        if (bin.Length < 8) return null;
        var reset = BitConverter.ToUInt32(bin, 4) & ~1u;   // thumb bit
        if (reset < FlashBase || reset >= FlashEnd) return null;
        return reset >= AppBase ? AppBase : FlashBase;
    }
}
