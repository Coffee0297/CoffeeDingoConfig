using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/canboard-do-pwm on upstream dingoFW: DO params 0x2100+i subs 2-10 (core/param_defs.h
/// DIGITAL_OUTPUT_PARAMS, same numbering as the app's DigitalOutput) and Msg 9 (base+11) bytes 0-3 = DO1-4 duty %.</summary>
public class UpstreamCanboardDoPwmTests
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
    public void Canboard_WithDoPwm_HasSubs2To10_AndDecodesMsg9Duty()
    {
        var d = Cb([.. Block(0x0000, 1, 9), .. Block(0x2100, 4, 11)]);
        var do1 = d.Params.Where(p => p.Index == 0x2100 && FwFamily.Has(d, p)).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 11), do1.Select(p => p.SubIndex));
        Assert.Equal(["digitalOutput[1].pwmEnabled", "digitalOutput[1].minDutyCycle"], new[] { do1[2].Name, do1[10].Name });
        Assert.Equal(100, do1[9].DefaultValue);   // denominator default as the firmware's
        Assert.Equal(75, d.VarMap.Count);         // no var-map change

        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x660 + 11, [40, 35, 45, 55, 0, 0, 0, 0], ref q, []);
        Assert.Equal([40.0, 35, 45, 55], d.DigitalOutputs.Select(o => o.CurrentDutyCycle));
        Assert.True(d.InIdRange(0x660 + 11));
    }

    [Fact]
    public void Canboard_StockUpstream_HasNoDoPwmParams()
    {
        var d = Cb([.. Block(0x0000, 1, 9), .. Block(0x2100, 4, 2)]);
        Assert.Equal(8, d.Params.Count(p => p.Index >= 0x2100 && p.Index < 0x2104 && FwFamily.Has(d, p)));
    }
}
