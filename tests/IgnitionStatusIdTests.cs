using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Functions;
using domain.Models;
using Xunit;

namespace tests;

/// <summary>feat/ignition-status-id: 0x1E00 sub 23 moves the 5.7 ignition status frame off its slot (PDM base + 36,
/// CANBoard base + 12) to any std id; the app decodes it there and the slot no longer counts in the module's span.</summary>
public class IgnitionStatusIdTests
{
    private static readonly byte[] Status = [0x11, 0, 3, 1, 0, 0, 0x21, 0];   // On | follower << 4, link ok

    [Fact]
    public void Pdm_StatusFrame_DecodedAtTheCustomId_AndLeavesTheSpan()
    {
        var d = IntegrationLayoutTestsAccess.IntegrationPdm();
        d.BaseId = 0x680;
        d.Ignition.Enabled = true; d.Ignition.Role = IgnitionRole.Follower;
        Assert.Contains(d.Params, p => p.Index == Ignition.BaseIndex && p.SubIndex == 23 && p.Name == "ignition.statusId");
        Assert.Equal(36, Fw57Migration.Span(d));
        Assert.Equal(0x680 + 36, d.Ignition.FrameId(d.BaseId, d.IgnitionStateOffset));

        d.Ignition.StatusId = 0x7A0;
        Assert.Equal(0x7A0, d.Ignition.FrameId(d.BaseId, d.IgnitionStateOffset));
        Assert.True(d.InIdRange(0x7A0));
        Assert.False(d.InIdRange(0x680 + 36));
        Assert.True(Fw57Migration.Span(d) < 36);   // the 0x20 slot above is free again
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x7A0, Status, ref q, []);
        Assert.Equal((IgnitionState.On, 1, 1), (d.Ignition.State, d.Ignition.Status!.Role, d.Ignition.Status.Link));

        d.Ignition.Status = null;
        d.Read(0x680 + 36, Status, ref q, []);   // nothing is sent on the slot any more
        Assert.Null(d.Ignition.Status);
    }

    [Fact]
    public void Pdm_StatusSlot_IgnoresTheNextPdmsFrame()
    {
        var d = IntegrationLayoutTestsAccess.IntegrationPdm();
        d.BaseId = 0x6A0;
        d.Ignition.Enabled = true;
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x6A0 + 36, [0x0D, 0x05, 0x40, 0x12, 0, 0, 0, 0], ref q, []);   // PDM-03's base + 4 at 0x6C0: state 13 is no status
        Assert.Null(d.Ignition.Status);
        d.Read(0x6A0 + 36, Status, ref q, []);
        Assert.Equal(IgnitionState.On, d.Ignition.State);
    }

    [Fact]
    public void Canboard_StatusFrame_DecodedAtTheCustomId()
    {
        var d = Fw57MigrationTests.Cb(5, 7, 0);
        UpstreamAnalogScaleTests.LearnParams(d, Fw57MigrationTests.Cb57Keys());
        d.BaseId = 0x660;
        d.Ignition.Enabled = true;
        Assert.Equal(12, Fw57Migration.Span(d));
        d.Ignition.StatusId = 0x650;   // below its base
        Assert.Equal(11, Fw57Migration.Span(d));
        Assert.True(d.InIdRange(0x650));
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        d.Read(0x650, Status, ref q, []);
        Assert.Equal(IgnitionState.On, d.Ignition.State);
    }
}
