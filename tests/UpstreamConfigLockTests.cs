using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/config-lock on upstream dingoFW: 0x0200 sub 0 password (write-only, reads 0), subs 1-8 contact text
/// (core/param_defs.h LOCK_PARAMS), Unlock 56 / FactoryReset 57 / Locked 58 (core/enums.h).</summary>
public class UpstreamConfigLockTests
{
    private static ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> Q() => new();
    private static readonly (int, int)[] Keys = [.. Enumerable.Range(0, 9).Select(s => (0x0000, s)), .. Enumerable.Range(0, 9).Select(s => (ConfigLock.BaseIndex, s))];

    private static PdmDevice Pdm()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);   // upstream v0.6.3
        return d;
    }

    // a full ReadAll of Keys with the module's values (password always 0), returns the CRC it reported
    private static uint ReadAll(PdmDevice d, Func<int, int, byte[]> value)
    {
        var q = Q(); var crc = new CumulativeCrc32();
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in Keys) { var v = value(i, s); crc.Update(v); d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, .. v], ref q, []); }
        d.Read(0x680, [12, (byte)Keys.Length, 0, 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        return crc.Final;
    }

    [Fact]
    public void ContactText_PacksFourCharsPerWord_FirstCharLowByte()
    {
        var w = ConfigLock.Pack("INST J. Smith 0123 456789");
        Assert.Equal(0x54534e49u, w[0]);   // "INST" as the firmware Sim test writes it
        Assert.Equal(8, w.Length);
        Assert.Equal(0u, w[7]);
        Assert.Equal("INST J. Smith 0123 456789", ConfigLock.Unpack(w));
        Assert.Equal(new string('x', 32), ConfigLock.Unpack(ConfigLock.Pack(new string('x', 40))));   // 32 chars max
        Assert.Equal("ab", ConfigLock.Clean("aé\nb"));   // the firmware stores plain ASCII bytes
    }

    [Fact]
    public void Password_IsKeptOverReads_SentOnWriteAll_CountedAsZeroInCheckCrc()
    {
        var d = Pdm();
        d.Lock.Password = 0x12345678;
        d.Lock.Contact = "Call Ann 0123";
        var contact = ConfigLock.Pack("Call Ann 0123");
        // the module holds the same contact; its password reads 0 whatever it is
        ReadAll(d, (i, s) => i == ConfigLock.BaseIndex ? BitConverter.GetBytes(s == 0 ? 0u : contact[s - 1])
            : ParamCodec.ToFrame(domain.Enums.MessageCommand.ReadAllRsp, d.Params.First(p => p.Index == i && p.SubIndex == s), 0).Payload[4..]);
        Assert.True(d.ParamSet.FromModule);
        Assert.Equal(0x12345678u, d.Lock.Password);                     // a read never clears the app's copy
        Assert.Equal("Call Ann 0123", d.Lock.Contact);
        Assert.DoesNotContain(d.LastConfigDiff, e => e.Index == ConfigLock.BaseIndex);   // no false "differs" for it

        // WriteAll resends the password (a 0 there would remove the lock)
        var q = Q(); var outgoing = new List<DeviceCanFrame>();
        d.Read(0x680, [20, 0, 0, 0, 0, 0, 0, 0], ref q, outgoing);
        var pw = outgoing.Single(f => f.Frame.Payload[1] == 0x00 && f.Frame.Payload[2] == 0x02 && f.Frame.Payload[3] == 0);
        Assert.Equal(0x12345678u, BitConverter.ToUInt32(pw.Frame.Payload, 4));
        var sentCrc = BitConverter.ToUInt32(outgoing[^1].Frame.Payload, 4);

        // CheckCrc: the module CRCs its live values, the password as 0; the app agrees (and not with the sent CRC)
        var live = new CumulativeCrc32();
        foreach (var f in outgoing.SkipLast(1)) live.Update(f == pw ? [0, 0, 0, 0] : f.Frame.Payload[4..]);
        Assert.NotEqual(sentCrc, live.Final);
        d.ConfigMismatch = true;
        d.Read(0x680, [35, 0, 0, 0, .. BitConverter.GetBytes(live.Final)], ref q, []);
        Assert.False(d.ConfigMismatch);
    }

    [Fact]
    public void LockedReply_DropsThePendingRequest_MarksLocked_ReadsTheContact()
    {
        var d = Pdm();
        var q = Q();
        q[(0x680, 0x1000, 0)] = new DeviceCanFrame { DeviceBaseId = 0x680, Frame = new CanFrame(0x681, 8, [1, 0, 0x10, 0, 0, 0, 0, 0]) };
        var outgoing = new List<DeviceCanFrame>();
        d.Read(0x680, [58, 0x00, 0x10, 0, 1, 0, 0, 0], ref q, outgoing);   // Read 0x1000:0 refused
        Assert.True(d.Lock.Locked);
        Assert.Empty(q);
        Assert.Equal(Enumerable.Range(1, 8), outgoing.Select(f => { Assert.Equal([1, 0x00, 0x02], f.Frame.Payload[..3]); return (int)f.Frame.Payload[3]; }));

        // the contact text answers while locked, before any Read taught the param list
        var w = ConfigLock.Pack("INST");
        d.Read(0x680, [1, 0x00, 0x02, 1, .. BitConverter.GetBytes(w[0])], ref q, []);
        Assert.Equal("INST", d.Lock.Contact);
        Assert.True(d.Lock.Locked);

        d.Read(0x680, [56, 0, 0, 0, 0, 0, 0, 0], ref q, []);   // wrong password
        Assert.True(d.Lock.Locked);
        d.Read(0x680, [56, 1, 0, 0, 0, 0, 0, 0], ref q, []);
        Assert.False(d.Lock.Locked);

        // factory reset: unlocked, and the project no longer matches the module (defaults)
        d.Lock.Locked = true; d.ConfigMismatch = false;
        d.Read(0x680, [57, 1, 0, 0, 0, 0, 0, 0], ref q, []);
        Assert.False(d.Lock.Locked);
        Assert.True(d.ConfigMismatch);
    }

    [Fact]
    public void Frames_MatchTheFirmware()
    {
        Assert.Equal([56, 0x78, 0x56, 0x34, 0x12, 0, 0, 0], ConfigLock.UnlockFrame(0x681, 0x12345678).Payload);
        Assert.Equal([57, (byte)'W', (byte)'I', (byte)'P', (byte)'E', 0, 0, 0], ConfigLock.FactoryResetFrame(0x681).Payload);
        Assert.Equal([36, (byte)'R', (byte)'E', (byte)'S', (byte)'E', (byte)'T', 0, 0], ConfigLock.RestartFrame(0x681).Payload);
    }

    [Fact]
    public void Fork_HasNoLockParams()
    {
        Assert.DoesNotContain(new PdmDevice("PDM", 0x680).Params, p => p.Index == ConfigLock.BaseIndex);
        Assert.DoesNotContain(new CanboardDevice("CB", 0x660).Params, p => p.Index == ConfigLock.BaseIndex);
    }
}
