using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using Xunit;

namespace tests;

/// <summary>
/// The var map is index-addressed, so dingoConfig's list must match the firmware's InitVarMap exactly.
/// Sizes are the firmware's pVarMap length (CONFIG_VERSION 0x0011, read with nm from the built ELFs).
/// </summary>
public class VarMapLayoutTests
{
    [Fact]
    public void Canboard_MatchesFirmware_WithPwmInputsLast()
    {
        var d = new CanboardDevice("CB", 0x660);
        Assert.Equal(100, d.VarMap.Count);
        Assert.Equal("PWM Duty", d.VarMap[84].PropertyName);       // appended after the timers: old indices kept
        Assert.Equal("PWM Frequency", d.VarMap[99].PropertyName);
        Assert.Equal(99, d.VarMap[99].VariableIndex);
    }

    [Fact]
    public void Pdm_MatchesFirmware_WithPwmInputsLast()
    {
        var d = new PdmDevice("PDM", 0x680);
        Assert.Equal(263, d.VarMap.Count);
        Assert.Equal("PWM Duty", d.VarMap[259].PropertyName);
        Assert.Equal(262, d.VarMap[262].VariableIndex);
    }

    [Fact]
    public void DigitalInput_PwmParams_AreSubIndex5And6()
    {
        var di = new DigitalInput(1, "Fan PWM") { Pwm = true, PwmFreq = 100 };
        var pwm = di.Params.Single(p => p.Name == "input[1].pwm");
        var freq = di.Params.Single(p => p.Name == "input[1].pwmFreq");
        Assert.Equal((5, 6), (pwm.SubIndex, freq.SubIndex));
        Assert.Equal(7, di.Params.Single(p => p.Name == "input[1].pwmMinPulseUs").SubIndex);
        Assert.Equal(true, pwm.GetValue());
        freq.SetValue(0);
        Assert.Equal(0, di.PwmFreq);
    }
}
