using domain.Devices.dingoPdm;
using web.Api;
using Xunit;

namespace tests;

/// <summary>A CAN Message block is a sender: PDM-04's backup indicator clock on 0x730 collided with PDM-01's and the
/// duplicate-id check never saw it.</summary>
public class CanIdMapTests
{
    [Fact]
    public void EnabledCanMessages_AreSenders_OnePerId()
    {
        var d = new PdmDevice("PDM-04", 0x6F8);
        d.CanMessages[0].Enabled = true; d.CanMessages[0].Id = 0x730; d.CanMessages[0].Name = "Backup clock on";
        d.CanMessages[1].Enabled = true; d.CanMessages[1].Id = 0x730; d.CanMessages[1].Name = "Backup clock off";
        d.CanMessages[2].Enabled = false; d.CanMessages[2].Id = 0x731;
        var s = DingoMap.CanMessageSenders(d).ToList();
        var only = Assert.Single(s);
        Assert.Equal((0x730, false), (only.Id, only.Ide));
        Assert.Contains("Backup clock on", only.Who);
        Assert.Contains("Backup clock off", only.Who);
    }
}
