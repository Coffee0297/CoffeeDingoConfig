using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>
/// Upstream dingoFW (version major 0): family detection, its var map (core/device.cpp InitVarMap; sizes = pVarMap
/// length read with nm from the built ELF), the param list learned from ReadAll, and the WriteAll / CheckCrc CRC in
/// ReadAll order (core/param_registry.cpp CalcParamsCrc).
/// </summary>
public class UpstreamFamilyTests
{
    private static ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> Q() => new();
    private static readonly byte[] UpstreamVersion = [31, 0, 0, 0, 0, 6, 0, 3];   // v0.6.3, no board id

    private static PdmDevice UpstreamPdm()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, UpstreamVersion, ref q, []);
        return d;
    }

    [Fact]
    public void VersionReply_Major0_IsUpstream_AndKnown()
    {
        var d = UpstreamPdm();
        Assert.Equal(FwFamily.Upstream, d.Family);
        Assert.True(d.VersionReceived);
        Assert.Equal("v0.6.3", d.Version);

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.Equal(FwFamily.Fork, f.Family);
        Assert.Equal(284, f.VarMap.Count);   // fork layout untouched
    }

    [Fact]
    public void Pdm_UpstreamVarMap_MatchesFirmware()
    {
        var d = UpstreamPdm();
        Assert.Equal(225, d.VarMap.Count);   // nm dingopdm_v7.elf: pVarMap 0x384 bytes
        // sys 5, DI 2, CAN in 32x2, virtual 16, outputs 8x4, flashers 4, conditions 32, counters 4, wiper 6, keypads 2x26
        Assert.Equal(("caninput", 1, "State"), (d.VarMap[7].OwnerKind, d.VarMap[7].OwnerNumber, d.VarMap[7].PropertyName));
        Assert.Equal(("output", 1, "On"), (d.VarMap[87].OwnerKind, d.VarMap[87].OwnerNumber, d.VarMap[87].PropertyName));
        Assert.Equal("wiper", d.VarMap[159].OwnerKind);
        Assert.Equal(("keypad", 2), (d.VarMap[216].OwnerKind, d.VarMap[216].OwnerNumber));
        // timers last, no Lua slots
        Assert.All(d.VarMap.Skip(217), v => Assert.Equal("timer", v.OwnerKind));
        Assert.DoesNotContain(d.VarMap, v => v.OwnerKind == "lua");
        Assert.Equal(Enumerable.Range(0, 225), d.VarMap.Select(v => v.VariableIndex));
    }

    [Fact]
    public void Canboard_UpstreamVarMap_MatchesFirmware()
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = Q();
        d.Read(0x660, UpstreamVersion, ref q, []);
        // sys 3, DI 8, DO 4, analog 5x4, CAN in 8x2, virtual 8, flashers 4, conditions 8, counters 4; NUM_TIMERS 0
        Assert.Equal(75, d.VarMap.Count);   // nm canboard_v2.elf: pVarMap 0x12c bytes
        Assert.Equal(("analoginput", 1, "Raw ADC"), (d.VarMap[15].OwnerKind, d.VarMap[15].OwnerNumber, d.VarMap[15].PropertyName));
        Assert.Equal(("analoginput", 2, "Raw ADC"), (d.VarMap[19].OwnerKind, d.VarMap[19].OwnerNumber, d.VarMap[19].PropertyName));
        Assert.Equal(("caninput", 1), (d.VarMap[35].OwnerKind, d.VarMap[35].OwnerNumber));
        Assert.Equal(("counter", 4), (d.VarMap[74].OwnerKind, d.VarMap[74].OwnerNumber));
        Assert.False(d.CanSleep);
        // upstream analog input: rotary offset / step / max position at sub 7-9, nothing after
        var ai = d.Params.Where(p => p.Index == 0x2200).ToList();
        Assert.Equal(10, ai.Count);
        Assert.Equal(typeof(double), ai.Single(p => p.SubIndex == 8).ValueType);
    }

    [Fact]
    public void UpstreamDeviceParams_AndTimer_HaveUpstreamNumbers()
    {
        var d = UpstreamPdm();
        var dev = d.Params.Where(p => p.Index == 0).ToDictionary(p => p.SubIndex, p => p.Name);
        Assert.Equal(Enumerable.Range(0, 9), dev.Keys.Order());
        Assert.Equal("device.muteTxInput", dev[7]);
        Assert.Equal("device.forceSleepInput", dev[8]);
        Assert.Equal(5, d.Params.Count(p => p.Index == 0x1A00));   // timer 1, not a table
        Assert.DoesNotContain(d.Params, p => p.Index == 0x1B00);
    }

    // A ReadAll from an upstream module: the app learns exactly its params, in order; a WriteAll then sends those (an
    // unknown one with the value it read) and puts their CRC in WriteAllComplete; CheckCrc matches that CRC.
    [Fact]
    public void ReadAll_LearnsParamList_WriteAllSendsItInOrderWithCrc()
    {
        var d = UpstreamPdm();
        var q = Q();
        var keys = Enumerable.Range(0, 9).Select(s => (0x0000, s))
            .Concat(Enumerable.Range(0, 18).Select(s => (0x1000, s)))
            .Append((0x4000, 0)).ToList();   // 0x4000 = a block this app has no model for
        var crc = new CumulativeCrc32();
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys)
        {
            // the module's values: what the app holds (in range), the current limit changed, an unknown param
            var known = d.Params.FirstOrDefault(p => p.Index == i && p.SubIndex == s);
            var v = (i, s) == (0x1000, 2) ? BitConverter.GetBytes(12.5f) : known is null ? [7, 0, 0, 0]
                : ParamCodec.ToFrame(domain.Enums.MessageCommand.ReadAllRsp, known, 0).Payload[4..];
            crc.Update(v);
            d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, .. v], ref q, []);
        }
        d.Read(0x680, [12, (byte)keys.Count, 0, 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);

        Assert.True(d.ParamSet.FromModule);
        Assert.Equal(keys, d.ParamSet.Order.Select(k => (k.Index, k.SubIndex)));
        Assert.Equal(12.5, d.Outputs[0].CurrentLimit, 3);

        var outgoing = new List<DeviceCanFrame>();
        d.Read(0x680, [20, 0, 0, 0, 0, 0, 0, 0], ref q, outgoing);
        Assert.Equal(keys.Count + 1, outgoing.Count);
        Assert.Equal(keys, outgoing.Take(keys.Count).Select(f => (f.Frame.Payload[2] << 8 | f.Frame.Payload[1], (int)f.Frame.Payload[3])));
        Assert.Equal(7, outgoing[keys.Count - 1].Frame.Payload[4]);   // unknown param sent back as read
        var complete = outgoing[^1].Frame.Payload;
        Assert.Equal(22, complete[0]);
        Assert.Equal(keys.Count, complete[1]);
        Assert.Equal(crc.Final, BitConverter.ToUInt32(complete, 4));   // nothing changed: same CRC as the read

        // the module confirms ([22, count, applied=1, crc]) and CheckCrc agrees: in step
        d.Read(0x680, [22, (byte)keys.Count, 0, 1, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        Assert.False(d.ConfigMismatch);
        d.ConfigMismatch = true;
        d.Read(0x680, [35, 0, 0, 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        Assert.False(d.ConfigMismatch);
    }

    [Fact]
    public void FailedUpstreamWriteAll_IsRetried()
    {
        var d = UpstreamPdm();
        d.ParamSet.Learn([(0, 0), (0, 1)], new());
        var q = Q();
        d.Read(0x680, [20, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        var outgoing = new List<DeviceCanFrame>();
        d.Read(0x680, [22, 1, 0, 0, 0, 0, 0, 0], ref q, outgoing);   // applied = 0
        Assert.Contains(outgoing, f => f.Name == "WriteAll (retry)");
        Assert.True(d.ConfigMismatch);
    }

    // feat/output-warn-openload: output subs 18-20 (same numbers as the fork's) only where the module listed them, and
    // Msg 3 output state nibbles 4 = Warning, 5 = OpenLoad
    [Fact]
    public void WarnOpenLoad_ByParamList_AndMsg3States()
    {
        var d = UpstreamPdm();
        var warn = d.Params.Single(p => p.Index == 0x1000 && p.SubIndex == 18);
        Assert.Equal("output[1].warnLimit", warn.Name);
        d.ParamSet.Learn(Enumerable.Range(0, 18).Select(s => (0x1000, s)).ToList(), new());   // stock upstream
        Assert.False(FwFamily.Has(d, warn));
        d.ParamSet.Learn(Enumerable.Range(0, 21).Select(s => (0x1000, s)).ToList(), new());   // feat/output-warn-openload
        Assert.True(FwFamily.Has(d, warn));
        Assert.True(FwFamily.Has(d, d.Params.Single(p => p.Index == 0x1000 && p.SubIndex == 20)));

        var q = Q();
        d.Read(0x680 + 5, [0x41, 0x05, 0, 0, 0, 0, 0, 0], ref q, []);   // outputs 1 On, 2 Warning, 3 OpenLoad
        Assert.Equal(domain.Enums.dingoPdm.OutState.On, d.Outputs[0].State);
        Assert.Equal(domain.Enums.dingoPdm.OutState.Warning, d.Outputs[1].State);
        Assert.Equal(domain.Enums.dingoPdm.OutState.OpenLoad, d.Outputs[2].State);
    }

    private static PdmDevice ReadAllFrom(List<(int, int)> keys)
    {
        var d = UpstreamPdm();
        var q = Q();
        var crc = new CumulativeCrc32();
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys)
        {
            byte[] v = [0, 0, 0, 0];
            crc.Update(v);
            d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, .. v], ref q, []);
        }
        d.Read(0x680, [12, (byte)keys.Count, (byte)(keys.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        return d;
    }

    // feat/output-state-signals: a module with the warn/open-load subs (18-20) gets Warning, Open Load per output after
    // the timers (nm dingopdm_v7.elf of feat/output-state-signals: pVarMap 0x3c4 bytes = 241)
    [Fact]
    public void OutputStateSignals_AfterTimers_WhenWarnListed()
    {
        List<(int, int)> outs(int subs) => Enumerable.Range(0, 8).SelectMany(o => Enumerable.Range(0, subs).Select(s => (0x1000 + o, s))).ToList();
        var timer = new List<(int, int)> { (0x1A00, 0) };
        Assert.Equal(225, ReadAllFrom([.. outs(18), .. timer]).VarMap.Count);
        var d = ReadAllFrom([.. outs(21), .. timer]);
        Assert.Equal(241, d.VarMap.Count);
        Assert.Equal("timer", d.VarMap[224].OwnerKind);
        Assert.Equal(("output", 1, "Warning"), (d.VarMap[225].OwnerKind, d.VarMap[225].OwnerNumber, d.VarMap[225].PropertyName));
        Assert.Equal(("output", 2, "Open Load"), (d.VarMap[228].OwnerKind, d.VarMap[228].OwnerNumber, d.VarMap[228].PropertyName));
        Assert.Equal(("output", 8, "Open Load"), (d.VarMap[240].OwnerKind, d.VarMap[240].OwnerNumber, d.VarMap[240].PropertyName));
        Assert.Equal(Enumerable.Range(0, 241), d.VarMap.Select(v => v.VariableIndex));
    }

    [Fact]
    public void ParamRuns_RoundTrip_KeepOrder()
    {
        var s = new DeviceParamSet();
        var order = new List<(int, int)> { (0, 0), (0, 1), (0x1000, 0), (0x1000, 1), (0x1001, 0), (0x1001, 1), (0x1800, 0), (0x1800, 2), (0x1200, 0) };
        s.Learn(order, new());
        var runs = s.Runs!;
        Assert.Equal(4, runs.Length);
        var t = new DeviceParamSet { Runs = runs };
        Assert.Equal(order, t.Order.Select(k => (k.Index, k.SubIndex)));
        Assert.False(t.FromModule);   // a saved list still needs a Read before Apply
        Assert.True(t.HasBlock(0x1800));
        Assert.False(t.HasBlock(0x1C00));
    }
}
