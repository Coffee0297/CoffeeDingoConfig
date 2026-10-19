using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/analog-linear-scaling on upstream dingoFW: CANBoard analog subs 10-12 (core/param_defs.h
/// ANALOG_INPUT_PARAMS) and the scaled values after the timers (core/device.cpp; nm analog-linear-scaling
/// canboard_v2.elf: pVarMap 0x140 bytes = 80).</summary>
public class UpstreamAnalogScaleTests
{
    internal static CanboardDevice UpstreamCb()
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = new ConcurrentDictionary<(int, int, int), DeviceCanFrame>();
        d.Read(0x660, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);
        return d;
    }

    // A full ReadAll from the module with exactly these params (values 0): the app learns the list.
    internal static void LearnParams(CanboardDevice d, IEnumerable<(int Index, int Sub)> keys)
    {
        var q = new ConcurrentDictionary<(int, int, int), DeviceCanFrame>();
        var list = keys.ToList();
        var crc = new CumulativeCrc32();
        d.Read(0x660, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in list)
        {
            crc.Update([0, 0, 0, 0]);
            d.Read(0x660, [11, (byte)i, (byte)(i >> 8), (byte)s, 0, 0, 0, 0], ref q, []);
        }
        d.Read(0x660, [12, (byte)list.Count, (byte)(list.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
    }

    internal static IEnumerable<(int, int)> Analog(params int[] subs) =>
        Enumerable.Range(0, 5).SelectMany(n => subs.Select(s => (AnalogInput.BaseIndex + n, s)));

    [Fact]
    public void Canboard_WithScaling_AppendsScaledValuesAfterTimers()
    {
        var d = UpstreamCb();
        LearnParams(d, [(0, 0), .. Analog([.. Enumerable.Range(0, 13)])]);
        Assert.True(d.ParamSet.FromModule);
        Assert.Equal(80, d.VarMap.Count);
        Assert.Equal(Enumerable.Range(1, 5), d.VarMap.Skip(75).Select(v =>
        {
            Assert.Equal(("analoginput", "Scaled Value", "float"), (v.OwnerKind, v.PropertyName, v.DataType));
            return v.OwnerNumber;
        }));
        Assert.Equal(Enumerable.Range(0, 80), d.VarMap.Select(v => v.VariableIndex));

        var ai1 = d.Params.Where(p => p.Index == AnalogInput.BaseIndex && p.SubIndex >= 10).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(["analogScale[1].enabled", "analogScale[1].gain", "analogScale[1].offset"], ai1.Select(p => p.Name));
        Assert.Equal([10, 11, 12], ai1.Select(p => p.SubIndex));
        Assert.Equal(1.0, ai1[1].DefaultValue);
        Assert.All(ai1, p => Assert.True(FwFamily.Has(d, p)));
    }

    [Fact]
    public void Canboard_WithoutScaling_KeepsStockLayout()
    {
        var d = UpstreamCb();
        LearnParams(d, [(0, 0), .. Analog([.. Enumerable.Range(0, 10)])]);
        Assert.Equal(75, d.VarMap.Count);
        Assert.DoesNotContain(d.Params, p => p.Index == AnalogInput.BaseIndex && p.SubIndex == 10 && FwFamily.Has(d, p));
    }
}
