namespace domain.Common;

/// <summary>
/// Why a module last reset, from the ResetCause (55) reply: the STM32 RCC CSR reset flags (CSR &gt;&gt; 24), kept at boot
/// and cleared so the next reset shows only its own. PIN is set with every other cause, so the cause is the most
/// specific flag; power-on also sets BOR (F4). A wake from sleep is a software reset in this firmware.
/// </summary>
public static class ResetCause
{
    /// <summary>The cause in words, most specific first. <paramref name="canboard"/>: the F3's bit 1 is OBL, not BOR.</summary>
    public static string Decode(int flags, bool canboard = false) =>
        (flags & 0x60) != 0 ? "watchdog"
        : (flags & 0x80) != 0 ? "low-power reset"
        : (flags & 0x10) != 0 ? "software (restart, bootloader or wake from sleep)"
        : (flags & 0x08) != 0 ? "power-on"
        : (flags & 0x02) != 0 ? (canboard ? "option-byte load" : "brown-out (supply dip)")
        : (flags & 0x04) != 0 ? "reset pin"
        : "unknown";

    /// <summary>Every flag that is set, by its register name.</summary>
    public static string[] Flags(int flags, bool canboard = false) =>
        new[] { (0x02, canboard ? "OBL" : "BOR"), (0x04, "PIN"), (0x08, "POR"), (0x10, "SFT"), (0x20, "IWDG"), (0x40, "WWDG"), (0x80, "LPWR") }
            .Where(f => (flags & f.Item1) != 0).Select(f => f.Item2).ToArray();
}
