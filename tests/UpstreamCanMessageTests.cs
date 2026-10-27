using domain.Common;
using domain.Devices.Functions;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>feat/can-message-block on upstream dingoFW: params 0x1D00 (core/param_defs.h CAN_MSG_PARAMS) and NO var-map
/// entry, unlike the fork's "Sending" (nm can-message-block dingopdm_v7.elf: pVarMap 0x384 bytes = 225, as stock).</summary>
public class UpstreamCanMessageTests
{
    [Fact]
    public void Pdm_WithCanMessageBlock_HasItsParams_AndNoVarMapEntry()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(CanMessage.BaseIndex, 4, 15)]);
        Assert.Equal(225, d.VarMap.Count);
        Assert.DoesNotContain(d.VarMap, v => v.OwnerKind == "canmsg");

        var m1 = d.Params.Where(p => p.Index == CanMessage.BaseIndex && FwFamily.Has(d, p)).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 15), m1.Select(p => p.SubIndex));
        Assert.Equal(["canMsg[1].enabled", "canMsg[1].input", "canMsg[1].ide", "canMsg[1].id", "canMsg[1].dlc", "canMsg[1].mode"], m1.Take(6).Select(p => p.Name));
        Assert.Equal("canMsg[1].data[7]", m1[13].Name);
        Assert.Equal(("canMsg[1].intervalMs", (object)100), (m1[14].Name, m1[14].DefaultValue));
        Assert.Equal(8, m1[4].DefaultValue);
        Assert.Equal(60, d.Params.Count(p => p.Index >= 0x1D00 && p.Index < 0x1E00 && FwFamily.Has(d, p)));
    }

    // feat/can-msg-counter-checksum: CAN_MSG_PARAMS subs 15 eChecksum (Enum 0-5, default 0), 16 nChecksumByte (0-7,
    // default 7), 17 nCounterByte (0-255, default 0xFF = none)
    [Fact]
    public void Pdm_WithCounterChecksum_HasSubs15To17()
    {
        var d = UpstreamPdm();
        LearnParams(d, 0x680, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(CanMessage.BaseIndex, 4, 18)]);
        var m1 = d.Params.Where(p => p.Index == CanMessage.BaseIndex && FwFamily.Has(d, p)).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 18), m1.Select(p => p.SubIndex));
        Assert.Equal(("canMsg[1].checksum", (object)0), (m1[15].Name, m1[15].DefaultValue));
        Assert.Equal(("canMsg[1].checksumByte", (object)7), (m1[16].Name, m1[16].DefaultValue));
        Assert.Equal(("canMsg[1].counterByte", (object)0xFF), (m1[17].Name, m1[17].DefaultValue));
        Assert.Equal(72, d.Params.Count(p => p.Index >= 0x1D00 && p.Index < 0x1E00 && FwFamily.Has(d, p)));
        var m = new CanMessage(1, "m");   // (the Read above set every value to 0)
        Assert.Equal((0, 7, 0xFF), (m.Checksum, m.ChecksumByte, m.CounterByte));
        m.Checksum = 9; m.ChecksumByte = 8;
        Assert.Equal((5, 7), (m.Checksum, m.ChecksumByte));   // the firmware's ranges
        Assert.DoesNotContain(new domain.Devices.dingoPdm.PdmDevice("PDM", 0x680).Params, p => p.Index == CanMessage.BaseIndex && p.SubIndex >= 15);   // fork
    }

    [Fact]
    public void StandardIdAbove7FF_IsSentAsExtended()
    {
        // the firmware never sends a standard id > 0x7FF; the app makes such an id extended
        var m = new CanMessage(1, "m") { Id = 0x800 };
        Assert.True(m.Ide);
    }
}
