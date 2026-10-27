using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/condition-delay on upstream dingoFW: core/param_defs.h CONDITION_PARAMS 0x1500+i sub 5 nDelayOn,
/// sub 6 nDelayOff (UInt16 ms, default 0), on every board. The fork has neither.</summary>
public class UpstreamConditionDelayTests
{
    // upstream Version reply, then a full ReadAll of exactly these params (values 0)
    private static void Learn(IDevice d, int baseId, List<(int Index, int Sub)> keys)
    {
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(baseId, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);
        var crc = new CumulativeCrc32();
        d.Read(baseId, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys) { crc.Update([0, 0, 0, 0]); d.Read(baseId, [11, (byte)i, (byte)(i >> 8), (byte)s, 0, 0, 0, 0], ref q, []); }
        d.Read(baseId, [12, (byte)keys.Count, (byte)(keys.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
    }
    private static List<(int, int)> Conds(int count) =>
        [.. Enumerable.Range(0, 9).Select(s => (0, s)), .. Enumerable.Range(0, count).SelectMany(n => new[] { 0, 1, 2, 3, 5, 6 }.Select(s => (0x1500 + n, s)))];

    private static void AssertDelays(IDeviceConfigurable d, int count)
    {
        var c1 = d.Params.Where(p => p.Index == 0x1500 && FwFamily.Has(d, p)).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal([0, 1, 2, 3, 5, 6], c1.Select(p => p.SubIndex));   // no sub 4 (hysteresis) on this firmware
        Assert.Equal(("condition[1].delayOn", "condition[1].delayOff"), (c1[4].Name, c1[5].Name));
        Assert.All(c1.Skip(4), p => { Assert.Equal(typeof(int), p.ValueType); Assert.Equal(0, p.DefaultValue); });
        Assert.Equal(count * 2, d.Params.Count(p => p.Index >= 0x1500 && p.Index < 0x1600 && p.SubIndex >= 5 && FwFamily.Has(d, p)));
    }

    [Fact]
    public void UpstreamPdm_HasConditionDelays()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        Learn(d, 0x680, Conds(32));
        AssertDelays(d, 32);
        var on = d.Params.Single(p => p.Name == "condition[3].delayOn");
        on.SetValue(2000);
        Assert.Equal(2000, d.Conditions[2].DelayOn);
    }

    [Fact]
    public void UpstreamCanboard_HasConditionDelays()
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        Learn(d, 0x660, Conds(8));
        AssertDelays(d, 8);
    }

    [Fact]
    public void Fork_HasNoConditionDelays()
    {
        Assert.DoesNotContain(new PdmDevice("PDM", 0x680).Params, p => p.Index == 0x1500 && p.SubIndex >= 5);
        Assert.DoesNotContain(new CanboardDevice("CB", 0x660).Params, p => p.Index == 0x1500 && p.SubIndex >= 5);
    }
}
