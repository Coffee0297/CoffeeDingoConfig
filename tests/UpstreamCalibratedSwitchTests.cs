using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/analog-calibrated-switch on upstream dingoFW: rotary sub 13 mode, 14 positions, 15 tolerance,
/// 16-19 point pairs on the CANBoard (core/param_defs.h ANALOG_INPUT_PARAMS, ROTARY_MAX_POS 8 there: no sub 20).
/// No var map change (nm analog-calibrated-switch canboard_v2.elf: pVarMap 0x12c bytes = 75).</summary>
public class UpstreamCalibratedSwitchTests
{
    private static readonly int[] CbSubs = [.. Enumerable.Range(0, 10), .. Enumerable.Range(13, 7)];

    // A full ReadAll from the module: each analog input's subs, AI1 with the given values (others 0).
    private static CanboardDevice ReadFrom(Dictionary<int, uint> ai1)
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = new ConcurrentDictionary<(int, int, int), DeviceCanFrame>();
        d.Read(0x660, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);
        var keys = Enumerable.Range(0, 5).SelectMany(n => CbSubs.Select(s => (AnalogInput.BaseIndex + n, s))).Prepend((0, 0)).ToList();
        var crc = new CumulativeCrc32();
        d.Read(0x660, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys)
        {
            var v = BitConverter.GetBytes(i == AnalogInput.BaseIndex && ai1.TryGetValue(s, out var x) ? x : 0u);
            crc.Update(v);
            d.Read(0x660, [11, (byte)i, (byte)(i >> 8), (byte)s, .. v], ref q, []);
        }
        d.Read(0x660, [12, (byte)keys.Count, (byte)(keys.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        return d;
    }

    private static uint Pair(int a, int b) => (uint)(a | (b << 16));

    [Fact]
    public void Calibrated_ReadsModeAndUnpacksPoints()
    {
        var d = ReadFrom(new() { [5] = 1, [13] = 1, [14] = 3, [15] = 150, [16] = Pair(500, 1500), [17] = Pair(3500, 0) });
        Assert.True(d.ParamSet.FromModule);
        var r = d.AnalogInputs[0].Rotary;
        Assert.Equal((1, 3, 150), (r.Mode, r.NumPos, r.Tolerance));
        Assert.Equal([500, 1500, 3500, 0], r.Points.Take(4));
        Assert.Equal(75, d.VarMap.Count);   // same Rotary Position variable

        // and packs them back the same way: sub 16 + k/2, even k in the low half
        r.Points[3] = 4200;
        var p17 = d.Params.Single(p => p.Index == AnalogInput.BaseIndex && p.SubIndex == 17);
        Assert.Equal((int)Pair(3500, 4200), (int)p17.GetValue());
        var sent = d.Params.Where(p => p.Index == AnalogInput.BaseIndex && FwFamily.Has(d, p)).Select(p => p.SubIndex).Order();
        Assert.Equal(CbSubs, sent);   // sub 20 (positions 9-10) not on the CANBoard
    }

    [Fact]
    public void ModuleWithoutCalibratedSwitch_SendsNoneOfIt()
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = new ConcurrentDictionary<(int, int, int), DeviceCanFrame>();
        d.Read(0x660, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);
        d.ParamSet.Learn([.. Enumerable.Range(0, 10).Select(s => (AnalogInput.BaseIndex, s))], new());
        Assert.DoesNotContain(d.Params, p => p.Index == AnalogInput.BaseIndex && p.SubIndex >= 13 && FwFamily.Has(d, p));
        d.AnalogInputs[0].Rotary.Mode = 7;
        Assert.Equal(1, d.AnalogInputs[0].Rotary.Mode);   // clamped to the firmware's 0..1
    }
}
