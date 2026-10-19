using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/curve-block on upstream dingoFW: params 0x2400 (core/param_defs.h CURVE_PARAMS) and the var map
/// (core/device.cpp: curve 1-4 after the timers; nm curve-block dingopdm_v7.elf: pVarMap 0x394 bytes = 229).</summary>
public class UpstreamCurveTests
{
    private static PdmDevice Pdm(params (int Index, int Sub)[] keys)
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x680, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);   // upstream v0.6.3
        // a full ReadAll of exactly these params (values 0) teaches the app the module's list
        var crc = new CumulativeCrc32();
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys) { crc.Update([0, 0, 0, 0]); d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, 0, 0, 0, 0], ref q, []); }
        d.Read(0x680, [12, (byte)keys.Length, (byte)(keys.Length >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        Assert.True(d.ParamSet.FromModule);
        return d;
    }
    private static IEnumerable<(int, int)> Block(int b, int count, int subs) =>
        Enumerable.Range(0, count).SelectMany(n => Enumerable.Range(0, subs).Select(s => (b + n, s)));

    [Fact]
    public void Pdm_WithCurveBlock_AppendsCurvesAfterTimers()
    {
        var d = Pdm([.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(CurveFunction.BaseIndex, 4, 27)]);
        Assert.Equal(229, d.VarMap.Count);
        Assert.All(d.VarMap.Skip(217).Take(8), v => Assert.Equal("timer", v.OwnerKind));
        Assert.Equal(Enumerable.Range(1, 4), d.VarMap.Skip(225).Select(v => { Assert.Equal(("curve", "Value", "float"), (v.OwnerKind, v.PropertyName, v.DataType)); return v.OwnerNumber; }));
        Assert.Equal(Enumerable.Range(0, 229), d.VarMap.Select(v => v.VariableIndex));

        // sub 0 enabled, 1 input, 2 points, 3-14 X, 15-26 Y (floats); all four curves the module has
        var c1 = d.Params.Where(p => p.Index == CurveFunction.BaseIndex).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 27), c1.Select(p => p.SubIndex));
        Assert.Equal(["curve[1].enabled", "curve[1].input", "curve[1].points"], c1.Take(3).Select(p => p.Name));
        Assert.Equal(("curve[1].x[0]", "curve[1].x[11]", "curve[1].y[0]", "curve[1].y[11]"), (c1[3].Name, c1[14].Name, c1[15].Name, c1[26].Name));
        Assert.All(c1.Skip(3), p => Assert.Equal(typeof(double), p.ValueType));
        Assert.Equal(2, c1[2].DefaultValue);
        Assert.Equal(108, d.Params.Count(p => p.Index >= 0x2400 && p.Index < 0x2500 && FwFamily.Has(d, p)));

        // the read values land on the curve (points clamp to the firmware's 2..12)
        d.Curves[0].Points = 40;
        Assert.Equal(12, d.Curves[0].Points);
    }

    [Fact]
    public void Pdm_WithoutCurveBlock_KeepsStockLayout_AndForkHasNoCurveParams()
    {
        var d = Pdm([.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, d.VarMap.Count);
        Assert.DoesNotContain(d.VarMap, v => v.OwnerKind == "curve");

        var f = new PdmDevice("PDM", 0x680);
        Assert.DoesNotContain(f.Params, p => p.Index == CurveFunction.BaseIndex);
        Assert.DoesNotContain(f.VarMap, v => v.OwnerKind == "curve");
    }
}
