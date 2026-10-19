using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/can-output-trigger on upstream dingoFW: core/param_defs.h CAN_OUTPUT_PARAMS 0x2000+i sub 12 nTriggerInput
/// (UInt16 var, default 0 = send on the interval), on every board. The fork has none.</summary>
public class UpstreamCanOutputTriggerTests
{
    private static void Learn(IDevice d, int baseId, List<(int Index, int Sub)> keys)
    {
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(baseId, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);
        var crc = new CumulativeCrc32();
        d.Read(baseId, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys) { crc.Update([0, 0, 0, 0]); d.Read(baseId, [11, (byte)i, (byte)(i >> 8), (byte)s, 0, 0, 0, 0], ref q, []); }
        d.Read(baseId, [12, (byte)keys.Count, (byte)(keys.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
    }
    private static List<(int, int)> Outs(int count) =>
        [.. Enumerable.Range(0, 9).Select(s => (0, s)), .. Enumerable.Range(0, count).SelectMany(n => Enumerable.Range(0, 13).Where(s => s != 11).Select(s => (0x2000 + n, s)))];

    private static void AssertTrigger(IDeviceConfigurable d, int count)
    {
        var o1 = d.Params.Where(p => p.Index == 0x2000 && FwFamily.Has(d, p)).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12], o1.Select(p => p.SubIndex));
        Assert.Equal(("canOutput[1].triggerInput", typeof(int), (object)0), (o1[^1].Name, o1[^1].ValueType, o1[^1].DefaultValue));
        Assert.Equal(count, d.Params.Count(p => p.Index >= 0x2000 && p.Index < 0x2100 && p.SubIndex == 12 && FwFamily.Has(d, p)));
    }

    [Fact]
    public void UpstreamPdm_HasCanOutputTrigger()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        Learn(d, 0x680, Outs(32));
        AssertTrigger(d, 32);
        d.Params.Single(p => p.Name == "canOutput[2].triggerInput").SetValue(10);
        Assert.Equal(10, d.CanOutputs[1].TriggerInput);
    }

    [Fact]
    public void UpstreamCanboard_HasCanOutputTrigger()
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var n = d.CanOutputs.Count;
        Learn(d, 0x660, Outs(n));
        AssertTrigger(d, n);
    }

    [Fact]
    public void Fork_HasNoCanOutputTrigger()
    {
        Assert.DoesNotContain(new PdmDevice("PDM", 0x680).Params, p => p.Index >= 0x2000 && p.Index < 0x2100 && p.SubIndex == 12);
        Assert.DoesNotContain(new CanboardDevice("CB", 0x660).Params, p => p.Index >= 0x2000 && p.Index < 0x2100 && p.SubIndex == 12);
    }
}
