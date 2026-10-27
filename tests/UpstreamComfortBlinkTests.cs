using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.Functions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>feat/comfort-blink on upstream dingoFW: params 0x1F00 subs 0-5 (core/param_defs.h COMFORT_BLINK_PARAMS) and
/// Left / Right after the timers (nm comfort-blink elfs: dingopdm_v7 pVarMap 0x38c = 227, canboard_v2 0x134 = 77).</summary>
public class UpstreamComfortBlinkTests
{
    [Fact]
    public void Pdm_WithComfortBlink_AppendsLeftRightAfterTimers()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(ComfortBlink.BaseIndex, 1, 6)]);
        Assert.Equal(227, d.VarMap.Count);
        Assert.Equal("timer", d.VarMap[224].OwnerKind);
        Assert.Equal([("comfortblink", "Left", 225), ("comfortblink", "Right", 226)], d.VarMap.Skip(225).Select(v => (v.OwnerKind, v.PropertyName, v.VariableIndex)));
        var p = d.Params.Where(x => x.Index == ComfortBlink.BaseIndex && FwFamily.Has(d, x)).OrderBy(x => x.SubIndex).ToList();
        Assert.Equal(["comfortBlink.enabled", "comfortBlink.leftInput", "comfortBlink.rightInput", "comfortBlink.clockInput", "comfortBlink.tapMs", "comfortBlink.blinks"], p.Select(x => x.Name));
        Assert.Equal((object)1000, p[4].DefaultValue);
        Assert.Equal((object)3, p[5].DefaultValue);
    }

    [Fact]
    public void Canboard_WithComfortBlink_AppendsLeftRight()
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = Q();
        d.Read(0x660, [31, 2, 0, 0, 0, 6, 0, 3], ref q, []);
        LearnParams(d, 0x660, [.. Block(0x0000, 1, 9), .. Block(ComfortBlink.BaseIndex, 1, 6)]);
        Assert.Equal(77, d.VarMap.Count);   // 75 stock (no timers) + Left, Right
        Assert.Equal(("comfortblink", "Left", 75), (d.VarMap[75].OwnerKind, d.VarMap[75].PropertyName, d.VarMap[75].VariableIndex));
        Assert.Equal(6, d.Params.Count(x => x.Index == ComfortBlink.BaseIndex && FwFamily.Has(d, x)));
    }

    [Fact]
    public void WithoutTheBlock_StockLayout()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, d.VarMap.Count);
    }
}
