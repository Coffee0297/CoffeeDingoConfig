using domain.Devices.Functions;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>feat/math-block on upstream dingoFW: params 0x1C00 (core/param_defs.h MATH_PARAMS) and the var map
/// (core/device.cpp: math 1-8 after the timers; nm math-block dingopdm_v7.elf: pVarMap 0x3a4 bytes = 233).</summary>
public class UpstreamMathTests
{
    [Fact]
    public void Pdm_WithMathBlock_AppendsMathAfterTimers()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(MathFunction.BaseIndex, 8, 7)]);
        Assert.Equal(233, d.VarMap.Count);
        Assert.All(d.VarMap.Skip(217).Take(8), v => Assert.Equal("timer", v.OwnerKind));
        Assert.Equal(Enumerable.Range(1, 8), d.VarMap.Skip(225).Select(v => { Assert.Equal(("math", "Value", "float"), (v.OwnerKind, v.PropertyName, v.DataType)); return v.OwnerNumber; }));
        Assert.Equal(Enumerable.Range(0, 233), d.VarMap.Select(v => v.VariableIndex));

        // params as the firmware numbers them: sub 0 enabled … 6 offset, all eight blocks the module has
        var m1 = d.Params.Where(p => p.Index == MathFunction.BaseIndex).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(["math[1].enabled", "math[1].op", "math[1].inputA", "math[1].inputB", "math[1].constB", "math[1].factor", "math[1].offset"], m1.Select(p => p.Name));
        Assert.Equal(1.0, m1[5].DefaultValue);
        Assert.Equal(56, d.Params.Count(p => p.Index >= 0x1C00 && p.Index < 0x1D00 && domain.Common.FwFamily.Has(d, p)));
    }

    [Fact]
    public void Pdm_WithoutMathBlock_KeepsStockLayout()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, d.VarMap.Count);
        Assert.DoesNotContain(d.VarMap, v => v.OwnerKind == "math");
        Assert.DoesNotContain(d.Params, p => p.Index == MathFunction.BaseIndex && domain.Common.FwFamily.Has(d, p));
    }
}
