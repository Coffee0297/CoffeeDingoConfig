using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/canboard-timers on upstream dingoFW: 4 timers at 0x1A00-0x1A03 (upstream Timer params), var map
/// Timer 1-4 at 75-78 after the counters (nm canboard-timers canboard_v2.elf: pVarMap 0x13c bytes = 79), and the
/// timer outputs in Msg 2 (base+4) byte 3 bits 4-7.</summary>
public class UpstreamCanboardTimerTests
{
    private static CanboardDevice Cb(params (int Index, int Sub)[] keys)
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x660, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);   // upstream v0.6.3
        var crc = new CumulativeCrc32();
        d.Read(0x660, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys)
        {
            byte[] v = i == 0 && s == 0 ? [0x60, 0x06, 0, 0] : [0, 0, 0, 0];   // the base id stays 0x660
            crc.Update(v);
            d.Read(0x660, [11, (byte)i, (byte)(i >> 8), (byte)s, .. v], ref q, []);
        }
        d.Read(0x660, [12, (byte)keys.Length, (byte)(keys.Length >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        Assert.True(d.ParamSet.FromModule);
        return d;
    }
    private static IEnumerable<(int, int)> Block(int b, int count, int subs) =>
        Enumerable.Range(0, count).SelectMany(n => Enumerable.Range(0, subs).Select(s => (b + n, s)));

    [Fact]
    public void Canboard_WithTimers_AppendsThemAfterCounters_AndDecodesMsg2Bits()
    {
        var d = Cb([.. Block(0x0000, 1, 9), .. Block(TimerFunction.UpstreamBaseIndex, 4, 5)]);
        Assert.Equal(79, d.VarMap.Count);
        Assert.Equal(("counter", 4), (d.VarMap[74].OwnerKind, d.VarMap[74].OwnerNumber));
        Assert.Equal(Enumerable.Range(1, 4), d.VarMap.Skip(75).Select(v => { Assert.Equal(("timer", "State"), (v.OwnerKind, v.PropertyName)); return v.OwnerNumber; }));
        Assert.Equal(20, d.Params.Count(p => p.Index >= 0x1A00 && p.Index < 0x1A04 && FwFamily.Has(d, p)));

        foreach (var t in d.Timers) t.Enabled = true;
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x660 + 4, [0, 0, 0, 0b1001_0000, 0, 0, 0, 0], ref q, []);   // timers 1 and 4 on, no flashers
        Assert.Equal([true, false, false, true], d.Timers.Select(t => t.Value));
        Assert.All(d.Flashers, f => Assert.False(f.Value));
    }

    [Fact]
    public void Canboard_StockUpstream_KeepsNoTimers()
    {
        var d = Cb([.. Block(0x0000, 1, 9)]);
        Assert.Equal(75, d.VarMap.Count);
        Assert.DoesNotContain(d.VarMap, v => v.OwnerKind == "timer");
    }
}
