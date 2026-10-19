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
    internal static ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> Q() => new();
    private static readonly byte[] UpstreamVersion = [31, 0, 0, 0, 0, 6, 0, 3];   // v0.6.3, no board id

    internal static PdmDevice UpstreamPdm()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, UpstreamVersion, ref q, []);
        return d;
    }

    /// <summary>A full upstream ReadAll of exactly <paramref name="keys"/> (all values 0): the module's param list,
    /// as a feature-branch firmware would report it. Upstream PDM/CANBoard first (Version reply).</summary>
    internal static void LearnParams(domain.Interfaces.IDevice d, int baseId, List<(int Index, int Sub)> keys)
    {
        var q = Q();
        var crc = new CumulativeCrc32();
        d.Read(baseId, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys)
        {
            crc.Update([0, 0, 0, 0]);
            d.Read(baseId, [11, (byte)i, (byte)(i >> 8), (byte)s, 0, 0, 0, 0], ref q, []);
        }
        d.Read(baseId, [12, (byte)keys.Count, (byte)(keys.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
    }

    /// <summary>Every (index, sub) of <paramref name="count"/> blocks at <paramref name="baseIndex"/> with subs 0..subs-1.</summary>
    internal static IEnumerable<(int, int)> Block(int baseIndex, int count, int subs) =>
        Enumerable.Range(0, count).SelectMany(n => Enumerable.Range(0, subs).Select(s => (baseIndex + n, s)));

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
        // upstream analog input: rotary offset / step / max position at sub 7-9, scaling 10-12 (feat/analog-linear-scaling), calibrated mode 13-20 (feat/analog-calibrated-switch)
        var ai = d.Params.Where(p => p.Index == 0x2200).ToList();
        Assert.Equal(21, ai.Count);
        Assert.Equal(typeof(double), ai.Single(p => p.SubIndex == 8).ValueType);
    }

    [Fact]
    public void UpstreamDeviceParams_AndTimer_HaveUpstreamNumbers()
    {
        var d = UpstreamPdm();
        var dev = d.Params.Where(p => p.Index == 0).ToDictionary(p => p.SubIndex, p => p.Name);
        Assert.Equal(Enumerable.Range(0, 9).Append(12).Append(13), dev.Keys.Order());   // 12: feat/fault-clear retry-all   // 13: feat/load-shed shed input
        Assert.Equal("device.muteTxInput", dev[7]);
        Assert.Equal("device.forceSleepInput", dev[8]);
        Assert.Equal(5, d.Params.Count(p => p.Index == 0x1A00));   // timer 1, not a table
        Assert.DoesNotContain(d.Params, p => p.Index == 0x1B00 && p.Name.StartsWith("timer"));   // 0x1B00 = tables upstream
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

    // feat/undercurrent-trip: output subs 27-29 on upstream only; a module listing them gets Undercurrent per output after
    // the state signals (nm dingopdm_v7.elf of feat/undercurrent-trip: pVarMap 0x3e4 bytes = 249); Msg 3 state 6
    [Fact]
    public void Undercurrent_SubsVarMapAndState()
    {
        var keys = Enumerable.Range(0, 8).SelectMany(o => Enumerable.Range(0, 21).Concat([27, 28, 29]).Select(s => (0x1000 + o, s))).ToList();
        var d = ReadAllFrom([.. keys, (0x1A00, 0)]);
        Assert.Equal(249, d.VarMap.Count);
        Assert.Equal(("output", 2, "Open Load"), (d.VarMap[228].OwnerKind, d.VarMap[228].OwnerNumber, d.VarMap[228].PropertyName));
        Assert.Equal(("output", 1, "Undercurrent"), (d.VarMap[241].OwnerKind, d.VarMap[241].OwnerNumber, d.VarMap[241].PropertyName));
        Assert.Equal(("output", 8, "Undercurrent"), (d.VarMap[248].OwnerKind, d.VarMap[248].OwnerNumber, d.VarMap[248].PropertyName));
        var sub = (int s) => d.Params.Single(p => p.Index == 0x1001 && p.SubIndex == s);
        d.Outputs[1].UnderLimit = 101; d.Outputs[1].UnderTime = 60001; d.Outputs[1].UnderTrip = true;
        Assert.Equal((100.0, 60000, true), ((double)sub(27).GetValue(), (int)sub(28).GetValue(), (bool)sub(29).GetValue()));
        Assert.True(FwFamily.Has(d, sub(27)));

        var q = Q();
        d.Read(0x680 + 5, [0x61, 0, 0, 0, 0, 0, 0, 0], ref q, []);   // output 1 On, 2 Undercurrent
        Assert.Equal(domain.Enums.dingoPdm.OutState.Undercurrent, d.Outputs[1].State);

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, p => p.Index == 0x1000 && p.SubIndex == 27);   // fork: not sent
    }

    // feat/pwm-variable-frequency: output subs 21-23 (the fork's numbers) only where the module listed them; a WriteAll
    // sends the frequency source and denominator in the module's order
    [Fact]
    public void VariableFrequency_ByParamList()
    {
        var d = UpstreamPdm();
        var keys = Enumerable.Range(0, 24).Select(s => (0x1000, s)).ToList();
        d.ParamSet.Learn(keys, new());
        d.Outputs[0].VariableFreq = true; d.Outputs[0].FreqInput = 8; d.Outputs[0].FreqInputDenom = 10;
        var q = Q();
        var outgoing = new List<DeviceCanFrame>();
        d.Read(0x680, [20, 0, 0, 0, 0, 0, 0, 0], ref q, outgoing);
        Assert.Equal(keys, outgoing.Take(keys.Count).Select(f => (f.Frame.Payload[2] << 8 | f.Frame.Payload[1], (int)f.Frame.Payload[3])));
        Assert.Equal(1, outgoing[21].Frame.Payload[4]);
        Assert.Equal(8, outgoing[22].Frame.Payload[4]);
        Assert.Equal(10, outgoing[23].Frame.Payload[4]);

        d.ParamSet.Learn(Enumerable.Range(0, 18).Select(s => (0x1000, s)).ToList(), new());   // stock upstream: none of them
        Assert.DoesNotContain(d.Params.Where(p => p.Index == 0x1000 && p.SubIndex is >= 21 and <= 23), p => FwFamily.Has(d, p));

        // feat/pwm-ramp-duty-changes: sub 24 after them
        var ramp = d.Params.Single(p => p.Index == 0x1000 && p.SubIndex == 24);
        Assert.Equal("output[1].rampDutyChanges", ramp.Name);
        Assert.False(FwFamily.Has(d, ramp));
        d.ParamSet.Learn(Enumerable.Range(0, 25).Select(s => (0x1000, s)).ToList(), new());
        Assert.True(FwFamily.Has(d, ramp));
    }

    // feat/hard-short-trip: output 0x1000+i sub 32 fHardShortLimit (A, float, 0..100), upstream modules only
    [Fact]
    public void HardShortLimit_UpstreamOnly()
    {
        var d = UpstreamPdm();
        var p = Assert.Single(d.Params, x => x.Index == 0x1001 && x.SubIndex == 32);
        Assert.Equal(typeof(double), p.ValueType);
        d.Outputs[1].HardShortLimit = 150;
        Assert.Equal(100.0, p.GetValue());   // the firmware's range
        d.Outputs[1].HardShortLimit = 40;
        var frame = ParamCodec.ToFrame(domain.Enums.MessageCommand.WriteAllVal, p, 0).Payload;
        Assert.Equal(40f, BitConverter.ToSingle(frame, 4));   // sent as a float
        d.ParamSet.Learn(Enumerable.Range(0, 18).Select(s => (0x1001, s)).ToList(), new());
        Assert.False(FwFamily.Has(d, p));

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, x => x.SubIndex == 32 && x.Index >= 0x1000 && x.Index < 0x1008);
    }

    // feat/soft-start-current-limit: output 0x1000+i sub 30 nSoftStartTimeout (ms, 0..60000), upstream modules only
    [Fact]
    public void SoftStartTimeout_UpstreamOnly()
    {
        var d = UpstreamPdm();
        var p = Assert.Single(d.Params, x => x.Index == 0x1006 && x.SubIndex == 30);
        Assert.Equal("output[7].softStartTimeout", p.Name);
        d.Outputs[6].SoftStartTimeout = 70000;
        Assert.Equal(60000, p.GetValue());   // the firmware's range
        d.ParamSet.Learn(Enumerable.Range(0, 18).Select(s => (0x1006, s)).ToList(), new());
        Assert.False(FwFamily.Has(d, p));
        d.ParamSet.Learn([.. Enumerable.Range(0, 18).Select(s => (0x1006, s)), (0x1006, 30)], new());
        Assert.True(FwFamily.Has(d, p));

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, x => x.SubIndex == 30 && x.Index >= 0x1000 && x.Index < 0x1008);
    }

    // feat/soft-stop: output 0x1000+i sub 31 nSoftStopTime (ms, 0..10000), upstream modules only
    [Fact]
    public void SoftStop_UpstreamOnly()
    {
        var d = UpstreamPdm();
        var p = Assert.Single(d.Params, x => x.Index == 0x1006 && x.SubIndex == 31);
        Assert.Equal("output[7].softStopTime", p.Name);
        d.Outputs[6].SoftStopTime = 10001;
        Assert.Equal(10000, p.GetValue());   // the firmware's range
        d.ParamSet.Learn(Enumerable.Range(0, 18).Select(s => (0x1006, s)).ToList(), new());
        Assert.False(FwFamily.Has(d, p));
        d.ParamSet.Learn([.. Enumerable.Range(0, 18).Select(s => (0x1006, s)), (0x1006, 31)], new());
        Assert.True(FwFamily.Has(d, p));

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, x => x.SubIndex == 31 && x.Index >= 0x1000 && x.Index < 0x1008);
    }

    // feat/load-shed (core/param_defs.h): device 0x0000 sub 13 nShedInput, output 0x1000+i sub 26 bShed; upstream only
    [Fact]
    public void LoadShed_Params_UpstreamOnly()
    {
        var d = UpstreamPdm();
        var si = Assert.Single(d.Params, p => p.Name == "device.shedInput");
        Assert.Equal((0x0000, 13), (si.Index, si.SubIndex));
        Assert.Equal(8, d.Params.Count(p => p.SubIndex == 26 && p.Index >= 0x1000 && p.Index < 0x1008));
        Assert.True(d.HasShed);   // list not read yet
        d.Outputs[1].Shed = true; d.ShedInput = 8;
        Assert.Equal(true, d.Params.Single(p => p.Index == 0x1001 && p.SubIndex == 26).GetValue());
        Assert.Equal(8, si.GetValue());
        d.ParamSet.Learn([(0, 0), (0x1000, 0)], new());   // stock upstream
        Assert.False(d.HasShed);

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, p => p.Index >= 0x1000 && p.Index < 0x1008 && p.SubIndex == 26);
        Assert.DoesNotContain(f.Params, p => p.Name == "device.shedInput");
        Assert.False(f.HasShed);
    }

    // feat/wire-load: output sub 33 nThermalTau (s, 0..600); a ReadAll that lists it adds 8 "Wire Load" vars after the
    // timers (nm dingopdm_v7.elf of feat/wire-load: pVarMap 0x3a4 bytes = 233) and decodes Msg 30 at base+32
    [Fact]
    public void WireLoad_VarMapAndFrame_WhenListed()
    {
        var outs = Enumerable.Range(0, 8).SelectMany(o => Enumerable.Range(0, 18).Select(s => (0x1000 + o, s))).ToList();
        var timer = new List<(int, int)> { (0x1A00, 0) };
        var stock = ReadAllFrom([.. outs, .. timer]);
        Assert.Equal(225, stock.VarMap.Count);
        Assert.Equal(31, stock.MaxCyclicId);

        var d = ReadAllFrom([.. outs.Concat(Enumerable.Range(0, 8).Select(o => (0x1000 + o, 33))).OrderBy(k => k.Item1), .. timer]);
        Assert.True(d.ParamSet.FromModule);
        Assert.Equal(233, d.VarMap.Count);
        Assert.Equal(("output", 1, "Wire Load"), (d.VarMap[225].OwnerKind, d.VarMap[225].OwnerNumber, d.VarMap[225].PropertyName));
        Assert.Equal(("output", 8, "Wire Load"), (d.VarMap[232].OwnerKind, d.VarMap[232].OwnerNumber, d.VarMap[232].PropertyName));
        Assert.Equal("timer", d.VarMap[224].OwnerKind);
        Assert.Equal(32, d.MaxCyclicId);
        Assert.True(d.InIdRange(0x680 + 32));
        var q = Q();
        d.Read(0x680 + 32, [38, 0, 120, 0, 0, 0, 0, 255], ref q, []);
        Assert.Equal(38, d.Outputs[0].WireLoad);
        Assert.Equal(120, d.Outputs[2].WireLoad);
        Assert.Equal(255, d.Outputs[7].WireLoad);
        d.Outputs[0].ThermalTau = 700;
        Assert.Equal(600, d.Params.Single(p => p.Index == 0x1000 && p.SubIndex == 33).GetValue());
    }

    // A full ReadAll of `keys` (values: what the app holds), so the module's param list is learned as on a real Read.
    private static void ReadAll(PdmDevice d, List<(int Index, int Sub)> keys)
    {
        var q = Q();
        var crc = new CumulativeCrc32();
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys)
        {
            var known = d.Params.FirstOrDefault(p => p.Index == i && p.SubIndex == s);
            byte[] v = known is null ? [0, 0, 0, 0] : ParamCodec.ToFrame(domain.Enums.MessageCommand.ReadAllRsp, known, 0).Payload[4..];
            crc.Update(v);
            d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, .. v], ref q, []);
        }
        d.Read(0x680, [12, (byte)keys.Count, (byte)(keys.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
    }

    // feat/pid firmware (dingopdm_v7.elf of that branch): pVarMap 0x3c4 bytes = 241 entries = 225 + 4 PIDs x
    // (Output, P, I, D) right after the timers; params 0x2300+n subs 0-20 (core/param_defs.h PID_PARAMS);
    // Msg 30 (+32) = 4 x int16 x10 outputs.
    [Fact]
    public void Pid_OnlyWhenTheModuleHasIt_VarMapParamsAndFrame()
    {
        var d = UpstreamPdm();
        Assert.Equal(225, d.VarMap.Count);              // list unknown: no PID
        Assert.False(d.InIdRange(0x680 + 32));         // +32 is a neighbour's base id: not claimed without the block

        ReadAll(d, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(0x2300, 4, 20)]);
        Assert.Equal(241, d.VarMap.Count);
        Assert.Equal(Enumerable.Range(0, 241), d.VarMap.Select(v => v.VariableIndex));
        Assert.Equal(("timer", 8), (d.VarMap[224].OwnerKind, d.VarMap[224].OwnerNumber));
        Assert.Equal(("pid", 1, "Output"), (d.VarMap[225].OwnerKind, d.VarMap[225].OwnerNumber, d.VarMap[225].PropertyName));
        Assert.Equal(("pid", 4, "D"), (d.VarMap[240].OwnerKind, d.VarMap[240].OwnerNumber, d.VarMap[240].PropertyName));
        Assert.Equal(["Output", "P", "I", "D"], d.VarMap.Skip(229).Take(4).Select(v => v.PropertyName));
        Assert.All(d.VarMap.Skip(225), v => Assert.Equal("float", v.DataType));

        // params vs PID_PARAMS: subs 0-20, Float / Var / Bool, firmware defaults
        var pid = d.Params.Where(p => p.Index == 0x2301).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 21), pid.Select(p => p.SubIndex));
        Assert.Equal(84, d.Params.Count(p => p.Index is >= 0x2300 and <= 0x2303));
        int[] floats = [4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 20], bools = [0, 13];
        Assert.All(pid, p => Assert.Equal(floats.Contains(p.SubIndex) ? typeof(double) : bools.Contains(p.SubIndex) ? typeof(bool) : typeof(int), p.ValueType));
        Assert.Equal([false, 0, 0, 1, 0.0, 0, 1.0, 0.0, 0.0, -100.0, 100.0, 0.0, 100.0, false, 0.0, 0.0, 0.0, 0.0, 0.0, 20, 0.0], pid.Select(p => p.DefaultValue));
        Assert.Equal([false, 0, 0, 1, 0.0, 0, 1.0, 0.0, 0.0, -100.0, 100.0, 0.0, 100.0, false, 0.0, 0.0, 0.0, 0.0, 0.0, 20, 0.0], pid.Select(p => p.GetValue()));
        // a float param goes out as IEEE float32
        d.Pids[1].Kp = 2.5;
        Assert.Equal(2.5f, BitConverter.ToSingle(ParamCodec.ToFrame(domain.Enums.MessageCommand.WriteAllVal, pid[6], 0).Payload, 4));

        // live output: Msg 30 at +32, signed int16 LE x10
        Assert.True(d.InIdRange(0x680 + 32));
        var q = Q();
        d.Read(0x680 + 32, [0xFA, 0x00, 0x18, 0xFC, 0xE8, 0x03, 0, 0], ref q, []);
        Assert.Equal([25.0, -100.0, 100.0, 0.0], d.Pids.Select(p => Math.Round(p.Value, 3)));
    }

    [Fact]
    public void Pid_ForkHasNone_AndProblemRefusesWhatTheFirmwareWould()
    {
        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, p => p.Index is >= 0x2300 and < 0x2400);
        Assert.DoesNotContain(f.VarMap, v => v.OwnerKind == "pid");

        var pid = new domain.Devices.Functions.PidFunction(1, "pid1");
        Assert.Null(pid.Problem());
        pid.PeriodMs = 1; Assert.NotNull(pid.Problem()); pid.PeriodMs = 20;
        pid.OutMin = 101; Assert.Contains("output min", pid.Problem()); pid.OutMin = 0;
        pid.IMin = 200; Assert.NotNull(pid.Problem()); pid.IMin = -100;
        pid.PvMin = 5; Assert.NotNull(pid.Problem()); pid.PvMax = 200; Assert.Null(pid.Problem());
        pid.Ki = -1; Assert.NotNull(pid.Problem()); pid.Ki = double.NaN; Assert.NotNull(pid.Problem()); pid.Ki = 0;
        pid.Setpoint = 2e6; Assert.Contains("setpoint", pid.Problem()); pid.Setpoint = -85; Assert.Null(pid.Problem());
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

    // feat/fault-clear (core/param_defs.h): output 0x1000+i sub 25 bClearOnReassert, device 0x0000 sub 12 nRetryAllInput
    [Fact]
    public void FaultClear_Params_UpstreamOnly()
    {
        var d = UpstreamPdm();
        Assert.Equal(8, d.Params.Count(p => p.SubIndex == 25 && p.Index >= 0x1000 && p.Index < 0x1008));
        var ra = Assert.Single(d.Params, p => p.Name == "device.retryAllInput");
        Assert.Equal((0x0000, 12), (ra.Index, ra.SubIndex));
        Assert.True(d.HasRetryAll);   // list not read yet
        d.Outputs[2].ClearOnReassert = true;
        Assert.Equal(true, d.Params.Single(p => p.Index == 0x1002 && p.SubIndex == 25).GetValue());

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, p => p.Index >= 0x1000 && p.Index < 0x1008 && p.SubIndex == 25);
        Assert.DoesNotContain(f.Params, p => p.Name == "device.retryAllInput");   // fork 0x0000:12 is the wake mask
        Assert.False(f.HasRetryAll);
    }
    // A full ReadAll of these (index, sub) keys (values 0) from an upstream module: the app learns them as its list.
    internal static void LearnParams(PdmDevice d, IEnumerable<(int Index, int Sub)> keys)
    {
        var q = Q(); var crc = new CumulativeCrc32(); var n = 0;
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys) { crc.Update([0, 0, 0, 0]); n++; d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, 0, 0, 0, 0], ref q, []); }
        d.Read(0x680, [12, (byte)n, (byte)(n >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
    }

    // feat/digital-input-pwm: DI subs 5-7, then per DI "PWM Duty" / "PWM Frequency" after the timers
    // (nm digital-input-pwm dingopdm_v7.elf: pVarMap 0x394 bytes = 229). Without sub 5 the stock 225 stay.
    [Fact]
    public void Pdm_WithDiPwm_AppendsDutyAndFreqAfterTimers()
    {
        var d = UpstreamPdm();
        LearnParams(d, [.. Block(0x0000, 1, 9), .. Block(0x1200, 2, 8), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(229, d.VarMap.Count);
        Assert.All(d.VarMap.Skip(217).Take(8), v => Assert.Equal("timer", v.OwnerKind));
        Assert.Equal([("input", 1, "PWM Duty"), ("input", 1, "PWM Frequency"), ("input", 2, "PWM Duty"), ("input", 2, "PWM Frequency")],
            d.VarMap.Skip(225).Select(v => (v.OwnerKind, v.OwnerNumber, v.PropertyName)));
        Assert.Equal(Enumerable.Range(0, 229), d.VarMap.Select(v => v.VariableIndex));
        Assert.Equal(["input[1].pwm", "input[1].pwmFreq", "input[1].pwmMinPulseUs"],
            d.Params.Where(p => p.Index == 0x1200 && p.SubIndex >= 5 && FwFamily.Has(d, p)).OrderBy(p => p.SubIndex).Select(p => p.Name));

        var s = UpstreamPdm();
        LearnParams(s, [.. Block(0x0000, 1, 9), .. Block(0x1200, 2, 5), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, s.VarMap.Count);
        Assert.DoesNotContain(s.Params, p => p.Index == 0x1200 && p.SubIndex == 5 && FwFamily.Has(s, p));
    }

    // feat/can-output-counter-checksum: CAN output sub 11 = kind (core/param_defs.h CAN_OUTPUT_PARAMS); never on the fork.
    [Fact]
    public void CanOutputKind_Sub11_OnlyWhereTheModuleHasIt()
    {
        var d = UpstreamPdm();
        LearnParams(d, [.. Block(0x0000, 1, 9), .. Block(0x2000, 32, 12)]);
        var kind = d.Params.Single(p => p.Index == 0x2000 && p.SubIndex == 11);
        Assert.Equal("canOutput[1].kind", kind.Name);
        Assert.True(FwFamily.Has(d, kind));
        d.CanOutputs[0].Kind = 4;   // CRC8 SAE J1850
        Assert.Equal(4, BitConverter.ToInt32(ParamCodec.ToFrame(domain.Enums.MessageCommand.WriteAllVal, kind, 0x681).Payload, 4));
        d.CanOutputs[0].Kind = 9;
        Assert.Equal(5, d.CanOutputs[0].Kind);   // clamped to the firmware's range 0-5

        var s = UpstreamPdm();
        LearnParams(s, [.. Block(0x0000, 1, 9), .. Block(0x2000, 32, 11)]);
        Assert.False(FwFamily.Has(s, s.Params.Single(p => p.Index == 0x2000 && p.SubIndex == 11)));

        var f = new PdmDevice("PDM", 0x680);
        Assert.DoesNotContain(f.Params, p => p.Index == 0x2000 && p.SubIndex == 11);
    }

    [Fact]
    public void RetainFlags_UpstreamOnly_AtFirmwareSubs()
    {
        // feat/retain-values param_defs.h: counter 0x1600+i sub 12, virtual input 0x1400+i sub 10, keypad button
        // 0x3100+k*32+b sub 22 (Bool). The fork has none of them, so they never reach a fork module.
        var d = UpstreamPdm();
        var c = d.Params.Single(p => p.Index == 0x1601 && p.SubIndex == 12);
        var v = d.Params.Single(p => p.Index == 0x1402 && p.SubIndex == 10);
        var b = d.Params.Single(p => p.Index == 0x3100 + 32 + 4 && p.SubIndex == 22);
        Assert.All(new[] { c, v, b }, p => Assert.Equal(typeof(bool), p.ValueType));
        c.SetValue(true); v.SetValue(true); b.SetValue(true);
        Assert.True(d.Counters[1].Retain);
        Assert.True(d.VirtualInputs[2].Retain);
        Assert.True(d.Keypads[1].Buttons[4].Retain);

        var f = new PdmDevice("PDM", 0x680);
        f.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        f.Read(0x680, [31, 0, 0, 0, 5, 6, 0, 6], ref q, []);
        Assert.DoesNotContain(f.Params, p => p.Name.EndsWith(".retain"));
    }
}
