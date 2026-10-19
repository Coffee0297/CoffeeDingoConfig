using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/canboard-sleep on upstream dingoFW: a read CANBoard with device sub 2 (sleep enabled) can sleep in the
/// app (sleep settings + the Sleep request [32,'QUIT']); unread or fork CANBoards keep their old behaviour.</summary>
public class UpstreamCanboardSleepTests
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
    public void Canboard_Upstream_WithSleepParam_CanSleep_AndGetsTheSleepRequest()
    {
        var d = Cb([.. Block(0x0000, 1, 9)]);
        Assert.True(d.CanSleep);
        Assert.Equal([32, (byte)'Q', (byte)'U', (byte)'I', (byte)'T', 0, 0, 0], d.GetSleepMsg()!.Frame.Payload);
        Assert.Equal(0x661, d.GetSleepMsg()!.Frame.Id);
        // the sleep settings are upstream device subs 2, 4, 5, 8
        Assert.Equal(["device.sleepEnabled", "device.disableDigInWake", "device.disableCanWake", "device.forceSleepInput"],
            new[] { 2, 4, 5, 8 }.Select(s => d.Params.Single(p => p.Index == 0 && p.SubIndex == s && FwFamily.Has(d, p)).Name));
    }

    [Fact]
    public void Canboard_UnreadUpstream_OrFork_Unchanged()
    {
        var u = new CanboardDevice("CB", 0x660);
        u.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        u.Read(0x660, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);
        Assert.False(u.CanSleep);
        Assert.Null(u.GetSleepMsg());

        var f = new CanboardDevice("CB", 0x660);
        f.SetLogger(NullLogger<CanboardDevice>.Instance);
        f.Read(0x660, [31, 2, 0, 0, 5, 5, 0, 111], ref q, []);
        Assert.True(f.CanSleep);
        Assert.Null(f.GetSleepMsg());   // fork: as before
    }
}
