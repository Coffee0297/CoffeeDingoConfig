using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Enums.dingoPdm;
using Xunit;

namespace tests;

/// <summary>feat/output-bench-test (upstream MsgCmd 48): what the app knows the firmware refuses, checked before sending.</summary>
public class OutputTestRulesTests
{
    [Fact]
    public void Refusals_FollowTheFirmware()
    {
        var p = new PdmDevice("PDM", 0x680);
        Assert.Empty(OutputTestRules.Refusals(p, 5, 1, 0));
        Assert.Empty(OutputTestRules.Refusals(p, 5, 2, 200));
        Assert.Single(OutputTestRules.Refusals(p, 5, 2, 10));            // 16-400 Hz
        Assert.Single(OutputTestRules.Refusals(p, 5, 2, 401));
        p.Outputs[5].PrimaryOutput = 4;                                     // output 6 follows output 5: both refused
        Assert.Contains(OutputTestRules.Refusals(p, 5, 1, 0), w => w.Contains("paired"));
        Assert.Contains(OutputTestRules.Refusals(p, 6, 1, 0), w => w.Contains("paired"));
        p.Outputs[5].PrimaryOutput = -1;
        p.Outputs[4].State = OutState.Fault;
        Assert.Contains(OutputTestRules.Refusals(p, 5, 1, 0), w => w.Contains("tripped"));
        Assert.Empty(OutputTestRules.Refusals(p, 5, 0, 0));               // a release always goes through

        var c = new CanboardDevice("CB", 0x660);
        Assert.Empty(OutputTestRules.Refusals(c, 1, 1, 0));
        Assert.Single(OutputTestRules.Refusals(c, 1, 2, 100));            // no PWM test on a CANBoard
    }
}
