using System.Collections.Concurrent;
using domain.Devices.Functions;
using domain.Models;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>feat/ignition-block on upstream dingoFW: params 0x1E00 subs 0-10 (core/param_defs.h IGNITION_PARAMS), the
/// seven roles after the timers (nm ignition-block dingopdm_v7.elf: pVarMap 0x3a0 bytes = 232) and the state frame,
/// cyclic Msg 30 = base + 32 (PT-DPDM Msg 31 = base + 33).</summary>
public class UpstreamIgnitionTests
{
    private static readonly List<(int, int)> Stock = [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5)];

    [Fact]
    public void Pdm_WithIgnitionBlock_AppendsRolesAfterTimers()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Stock, .. Block(Ignition.BaseIndex, 1, 11)]);
        Assert.Equal(232, d.VarMap.Count);
        Assert.Equal(["Ignition", "Accessory", "Cranking", "Running", "Ready", "Dash", "Link OK"],
            d.VarMap.Skip(225).Select(v => { Assert.Equal(("ignition", 1), (v.OwnerKind, v.OwnerNumber)); return v.PropertyName; }));
        Assert.Equal(Enumerable.Range(0, 232), d.VarMap.Select(v => v.VariableIndex));
        var p = d.Params.Where(x => x.Index == Ignition.BaseIndex).OrderBy(x => x.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 11), p.Select(x => x.SubIndex));
        Assert.Equal(("ignition.maxCrankMs", (object)5000), (p[7].Name, p[7].DefaultValue));
        Assert.Equal(("ignition.mainStateId", true), (p[10].Name, p.All(x => domain.Common.FwFamily.Has(d, x))));
    }

    [Fact]
    public void StateFrame_IsBasePlus32_OnlyWithTheBlock()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, Stock);
        d.BaseId = 0x680;
        Assert.Null(d.IgnitionStateOffset);
        Assert.False(d.InIdRange(0x680 + 32));   // the base of a module 0x20 above: not ours
        Assert.Equal(225, d.VarMap.Count);

        d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Stock, .. Block(Ignition.BaseIndex, 1, 11)]);
        d.BaseId = 0x680;   // the read set every param to 0, the base id too
        Assert.Equal(32, d.IgnitionStateOffset);
        Assert.True(d.InIdRange(0x680 + 32));
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x680 + 32, [(byte)'I', 2, 0x13, 0, 0, 0, 0, 0], ref q, []);
        Assert.Equal((IgnitionState.Cranking, true), (d.Ignition.State, d.Ignition.Dash));
        d.Read(0x680 + 30, [(byte)'I', 3, 0, 0, 0, 0, 0, 0], ref q, []);   // +30 is a timer frame upstream, not the state
        Assert.Equal(IgnitionState.Cranking, d.Ignition.State);

        d.PdmType = 2;   // PT-DPDM: one frame more, Msg 31 (the layout is rebuilt when the list is learned)
        LearnParams(d, 0x680, [.. Stock, .. Block(Ignition.BaseIndex, 1, 11)]);
        Assert.Equal(33, d.IgnitionStateOffset);
        Assert.Equal(30, Ignition.StateOffsetFor("dingoPDM"));   // fork unchanged
        Assert.Equal(14, Ignition.StateOffsetFor("CANBoard"));
    }
}
