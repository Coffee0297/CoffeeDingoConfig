using domain.Common;
using Xunit;

namespace tests;

/// <summary>ResetCause (55) reply byte 1 = RCC CSR >> 24 (upstream feat/reset-cause, notes: power-on 0x0E, restart / wake 0x14).</summary>
public class ResetCauseTests
{
    [Theory]
    [InlineData(0x0E, false, "power-on")]                                            // BOR | PIN | POR
    [InlineData(0x14, false, "software (restart, bootloader or wake from sleep)")]  // PIN | SFT
    [InlineData(0x06, false, "brown-out (supply dip)")]                              // BOR | PIN
    [InlineData(0x06, true, "option-byte load")]                                     // CANBoard F3: bit 1 is OBL
    [InlineData(0x04, false, "reset pin")]
    [InlineData(0x24, false, "watchdog")]                                            // IWDG | PIN
    [InlineData(0x44, false, "watchdog")]                                            // WWDG | PIN
    [InlineData(0x84, false, "low-power reset")]
    [InlineData(0x00, false, "unknown")]
    public void Decode_MostSpecificFlag(int flags, bool canboard, string cause) => Assert.Equal(cause, ResetCause.Decode(flags, canboard));

    [Fact]
    public void Flags_ByRegisterName()
    {
        Assert.Equal(["BOR", "PIN", "POR"], ResetCause.Flags(0x0E));
        Assert.Equal(["OBL", "PIN"], ResetCause.Flags(0x06, canboard: true));
        Assert.Empty(ResetCause.Flags(0));
    }
}
