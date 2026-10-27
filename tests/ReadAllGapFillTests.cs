using domain.Common;
using domain.Models;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>A full Read through the USB bridge on a busy bus lost a few replies and every write was refused. With the
/// module's list known (saved in the project), the app asks for the missing params one by one and accepts the read only
/// if the CRC over the completed list equals the module's.</summary>
public class ReadAllGapFillTests
{
    // the module's table order is not sorted: a later block can come first
    private static readonly List<(int Index, int Sub)> Keys = [.. Block(0x1001, 2, 10), .. Block(0x1000, 1, 10)];   // outputs 2-3 before output 1 (not the device block: sub 0 is the base ID)
    private static byte[] Val(int i, int s) => BitConverter.GetBytes((uint)(i * 31 + s));

    private static (domain.Devices.dingoPdm.PdmDevice d, List<DeviceCanFrame> asked) ShortRead(int[] lost, int extra = 0)
    {
        var d = UpstreamPdm();
        LearnParams(d, Keys);
        d.ParamSet.Stale();   // as after reopening the project: the order is known, not read this session
        var q = Q(); var asked = new List<DeviceCanFrame>(); var crc = new CumulativeCrc32();
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, asked);
        for (var n = 0; n < Keys.Count; n++)
        {
            var (i, s) = Keys[n];
            crc.Update(Val(i, s));
            if (!lost.Contains(n)) d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, .. Val(i, s)], ref q, asked);
        }
        d.Read(0x680, [12, (byte)(Keys.Count + extra), 0, 0, .. BitConverter.GetBytes(crc.Final)], ref q, asked);
        return (d, asked);
    }

    [Fact]
    public void MissingReplies_AreAsked_AndTheReadCompletesWhenTheCrcMatches()
    {
        var (d, asked) = ShortRead([3, 12]);
        var reads = asked.Where(f => f.Frame.Payload[0] == 1).Select(f => (f.Frame.Payload[2] << 8 | f.Frame.Payload[1], (int)f.Frame.Payload[3])).ToList();
        Assert.Equal([Keys[3], Keys[12]], reads.OrderBy(k => Keys.IndexOf(k)));
        Assert.False(d.ParamSet.FromModule);

        var q = Q(); var after = new List<DeviceCanFrame>();
        foreach (var (i, s) in reads) d.Read(0x680, [1, (byte)i, (byte)(i >> 8), (byte)s, .. Val(i, s)], ref q, after);
        Assert.True(d.ParamSet.FromModule);
        Assert.Equal(Keys, d.ParamSet.Order);
        Assert.Contains(after, f => f.Frame.Payload[0] == 34);   // CheckCrc follows
    }

    [Fact]
    public void AFilledValueThatBreaksTheCrc_LeavesTheReadIncomplete()
    {
        var (d, asked) = ShortRead([5]);
        var (i, s) = Keys[5];
        var q = Q();
        d.Read(0x680, [1, (byte)i, (byte)(i >> 8), (byte)s, 9, 9, 9, 9], ref q, []);
        Assert.False(d.ParamSet.FromModule);
    }

    [Fact]
    public void AModuleWhoseListDiffersFromTheSavedOne_IsNotFilled()
    {
        var (_, asked) = ShortRead([2], extra: 1);   // it reports one param more than the saved list has
        Assert.DoesNotContain(asked, f => f.Frame.Payload[0] == 1);
    }
}
