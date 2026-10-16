using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using Xunit;

namespace tests;

/// <summary>
/// The var map is index-addressed, so dingoConfig's list must match the firmware's InitVarMap exactly.
/// Sizes are the firmware's pVarMap length (CONFIG_VERSION 0x0012 / 5.6, read with nm from the built ELFs).
/// </summary>
public class VarMapLayoutTests
{
    [Fact]
    public void Canboard_MatchesFirmware_WithPwmInputsLast()
    {
        var d = new CanboardDevice("CB", 0x660);
        Assert.Equal(113, d.VarMap.Count);   // 5.6: + 4 math, 2 CAN messages, 7 ignition
        Assert.Equal("PWM Duty", d.VarMap[84].PropertyName);       // appended after the timers: old indices kept
        Assert.Equal("PWM Frequency", d.VarMap[99].PropertyName);
        Assert.Equal(99, d.VarMap[99].VariableIndex);
    }

    [Fact]
    public void Pdm_MatchesFirmware_WithPwmInputsLast()
    {
        var d = new PdmDevice("PDM", 0x680);
        Assert.Equal(282, d.VarMap.Count);   // 5.6: + 8 math, 4 CAN messages, 7 ignition
        Assert.Equal("PWM Duty", d.VarMap[259].PropertyName);
        Assert.Equal(262, d.VarMap[262].VariableIndex);
        // 5.6 blocks after everything older, ignition roles last; none of them exists on older firmware
        Assert.Equal(("math", 1), (d.VarMap[263].OwnerKind, d.VarMap[263].OwnerNumber));
        Assert.Equal(("canmsg", 1), (d.VarMap[271].OwnerKind, d.VarMap[271].OwnerNumber));
        Assert.Equal("Ignition", d.VarMap[275].PropertyName);
        Assert.Equal("Link OK", d.VarMap[281].PropertyName);
        Assert.All(d.VarMap.Skip(263), v => Assert.Equal(new Version(5, 6, 0), v.MinFirmware));
        Assert.All(d.VarMap.Take(263), v => Assert.Null(v.MinFirmware));
    }

    // A module reports its firmware; the WriteAll it is sent only has the params that firmware knows, so a
    // 5.5 module is never sent the 5.6 ones (it would refuse them and the whole write would fail).
    [Fact]
    public void WriteAll_SkipsParamsTheModuleFirmwareDoesNotHave()
    {
        int Sent(byte major, byte minor, int build)
        {
            var d = new CanboardDevice("CB", 0x660);
            d.SetLogger(Microsoft.Extensions.Logging.Abstractions.NullLogger<CanboardDevice>.Instance);
            var q = new System.Collections.Concurrent.ConcurrentDictionary<(int BaseId, int Index, int SubIndex), domain.Models.DeviceCanFrame>();
            d.Read(0x660, [31, 2, 0, 0, major, minor, (byte)(build >> 8), (byte)build], ref q, []);   // Version reply
            var outgoing = new List<domain.Models.DeviceCanFrame>();
            d.Read(0x660, [20, 0, 0, 0, 0, 0, 0, 0], ref q, outgoing);                              // WriteAll echo
            return outgoing.Count;
        }
        // CANBoard 5.6 params: 8 CAN input timeout values + 4 math x 7 + 2 CAN messages x 15 + ignition 11
        Assert.Equal(77, Sent(5, 6, 0) - Sent(5, 5, 112));
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
