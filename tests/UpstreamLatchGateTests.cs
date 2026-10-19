using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/latch-gate-block on upstream dingoFW: params 0x2600 (core/param_defs.h LATCH_GATE_PARAMS) and the var
/// map (core/device.cpp: latch/gate 1-8 after the timers; nm latch-gate-block dingopdm_v7.elf: pVarMap 0x3a4 bytes = 233).</summary>
public class UpstreamLatchGateTests
{
    private static PdmDevice Pdm(params (int Index, int Sub)[] keys)
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x680, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);   // upstream v0.6.3
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
    public void Pdm_WithLatchGateBlock_AppendsEightAfterTimers()
    {
        var d = Pdm([.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(LatchGateFunction.BaseIndex, 8, 5)]);
        Assert.Equal(233, d.VarMap.Count);
        Assert.All(d.VarMap.Skip(217).Take(8), v => Assert.Equal("timer", v.OwnerKind));
        Assert.Equal(Enumerable.Range(1, 8), d.VarMap.Skip(225).Select(v => { Assert.Equal(("latchgate", "Value", "float"), (v.OwnerKind, v.PropertyName, v.DataType)); return v.OwnerNumber; }));
        Assert.Equal(Enumerable.Range(0, 233), d.VarMap.Select(v => v.VariableIndex));

        var l1 = d.Params.Where(p => p.Index == LatchGateFunction.BaseIndex).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(["latchGate[1].enabled", "latchGate[1].type", "latchGate[1].input", "latchGate[1].controlInput", "latchGate[1].timeMs"], l1.Select(p => p.Name));
        Assert.Equal(typeof(LatchGateType), l1[1].ValueType);
        Assert.Equal(40, d.Params.Count(p => p.Index >= 0x2600 && p.Index < 0x2700 && FwFamily.Has(d, p)));

        d.LatchGates[0].TimeMs = 700000;   // firmware max 600000
        Assert.Equal(600000, d.LatchGates[0].TimeMs);
    }

    [Fact]
    public void Pdm_WithoutLatchGateBlock_KeepsStockLayout_AndForkHasNoLatchGateParams()
    {
        var d = Pdm([.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, d.VarMap.Count);
        Assert.DoesNotContain(d.VarMap, v => v.OwnerKind == "latchgate");

        var f = new PdmDevice("PDM", 0x680);
        Assert.DoesNotContain(f.Params, p => p.Index == LatchGateFunction.BaseIndex);
        Assert.DoesNotContain(f.VarMap, v => v.OwnerKind == "latchgate");
    }
}
