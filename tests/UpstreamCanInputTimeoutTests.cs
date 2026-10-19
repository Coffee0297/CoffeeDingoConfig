using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>feat/can-input-timeout-value on upstream dingoFW: 0x1300+i sub 14 fTimeoutValue (Float, default 0) and sub 15
/// bTimeoutUseValue (Bool, default 0) (core/param_defs.h). Fork 5.6 has only sub 14 and always uses it.</summary>
public class UpstreamCanInputTimeoutTests
{
    [Fact]
    public void Upstream_HasTimeoutValueAndFlag()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1300, 32, 16), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, d.VarMap.Count);
        var p = d.Params.Where(x => x.Index == 0x1300 && FwFamily.Has(d, x)).OrderBy(x => x.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 16), p.Select(x => x.SubIndex));
        Assert.Equal(("canInput[1].timeoutValue", typeof(double), (object)0.0), (p[14].Name, p[14].ValueType, p[14].DefaultValue));
        Assert.Equal(("canInput[1].timeoutUseValue", typeof(bool), (object)false), (p[15].Name, p[15].ValueType, p[15].DefaultValue));
        p[15].SetValue(true);
        Assert.True(d.CanInputs[0].TimeoutUseValue);

        // stock upstream (no feature): neither is sent
        var s = UpstreamPdm();
        LearnParams(s, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1300, 32, 14), .. Block(0x1A00, 8, 5)]);
        Assert.DoesNotContain(s.Params, x => x.Index == 0x1300 && x.SubIndex >= 14 && FwFamily.Has(s, x));
    }

    [Fact]
    public void Fork_HasNoFlag()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.Equal(14, d.Params.Where(x => x.Index == 0x1300).Max(x => x.SubIndex));
        var c = new CanboardDevice("CB", 0x660);
        Assert.DoesNotContain(c.Params, x => x.Index == 0x1300 && x.SubIndex == 15);
    }
}
