using domain.Common;
using domain.Devices.dingoPdm;
using domain.Enums;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>feat/condition-hysteresis on upstream dingoFW: 0x1500+i sub 4 is fHyst, a band >= 0 (core/param_defs.h,
/// default 0), not the fork's absolute release point argOff. The app keeps "off again at" and sends the band.</summary>
public class UpstreamConditionHystTests
{
    private static domain.Models.DeviceParameter Sub4(PdmDevice d) => d.Params.Single(p => p.Index == 0x1500 && p.SubIndex == 4);

    [Fact]
    public void Upstream_Sub4_IsTheBand()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1500, 32, 5), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, d.VarMap.Count);   // no var-map change (nm condition-hysteresis dingopdm_v7.elf: 0x384)
        var c = d.Conditions[0];
        var p = Sub4(d);
        Assert.Equal(("condition[1].hyst", (object)0.0), (p.Name, p.DefaultValue));
        Assert.True(FwFamily.Has(d, p));

        c.Operator = Operator.GreaterThan; c.Arg = 95; c.ArgOff = 90;
        Assert.Equal(5.0, p.GetValue());                       // on above 95, off again at 90
        c.Operator = Operator.LessThanOrEqual; c.Arg = 10; c.ArgOff = 12;
        Assert.Equal(2.0, p.GetValue());
        c.Operator = Operator.GreaterThan; c.Arg = 95; c.ArgOff = 99;
        Assert.Equal(0.0, p.GetValue());                       // wrong side of the value: no band, never negative
        c.Operator = Operator.Equal; c.ArgOff = 90;
        Assert.Equal(0.0, p.GetValue());

        // read back from the module: the band becomes the release point again
        c.Operator = Operator.GreaterThanOrEqual; c.Arg = 100; p.SetValue(10.0);
        Assert.Equal(90, c.ArgOff);
        c.Operator = Operator.LessThan; p.SetValue(3.0);
        Assert.Equal(103, c.ArgOff);
    }

    [Fact]
    public void Fork_Sub4_StaysTheReleasePoint()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        var c = d.Conditions[0];
        c.Operator = Operator.GreaterThan; c.Arg = 95; c.ArgOff = 90;
        Assert.Equal(("condition[1].argOff", (object)90.0), (Sub4(d).Name, Sub4(d).GetValue()));
    }
}
