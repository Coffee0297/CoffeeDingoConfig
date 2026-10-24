using domain.Devices.dingoPdm;
using domain.Devices.Generic;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>Which frames make a device look connected. Modules 0x20 apart: a 5.7 PDM's appended frames (base+32..)
/// sit on the next module's base+0.., so a PDM may only claim them while the feature that sends them is on; and a DBC
/// device only claims the ids in its DBC, not everything between its lowest and highest.</summary>
public class IdRangeTests
{
    private static PdmDevice Pdm57WithWireAndPid(int baseId)
    {
        var d = new PdmDevice("PDM", baseId);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = UpstreamFamilyTests.Q();
        d.Read(baseId, [31, 0, 0, 0, 5, 7, 0, 1], ref q, []);   // version 5.7.1
        // the module's param list: outputs incl. wire load (sub 33) and PID blocks, as a 5.7 PDM reports it
        var keys = new List<(int, int)>();
        for (var o = 0; o < 8; o++) for (var s = 0; s <= 34; s++) keys.Add((0x1000 + o, s));
        for (var p = 0; p < 4; p++) for (var s = 0; s <= 20; s++) keys.Add((0x2300 + p, s));
        UpstreamFamilyTests.LearnParams(d, baseId, keys);
        return d;
    }

    [Fact]
    public void Pdm_IdleAppendedSlots_DontClaimTheNextModulesFrames()
    {
        var pdm1 = Pdm57WithWireAndPid(0x680);
        var fr = pdm1.UpstreamFrames();
        Assert.NotNull(fr.Wire);
        Assert.NotNull(fr.Pid);
        // the core range is always its own
        Assert.True(pdm1.InIdRange(0x680));
        Assert.True(pdm1.InIdRange(0x680 + 31));
        // features off: base+32.. belong to the next module (PDM-02 at 0x6A0)
        for (var id = 0x6A0; id <= 0x6A3; id++) Assert.False(pdm1.InIdRange(id), $"0x{id:X3}");

        pdm1.Pids[0].Enabled = true;
        Assert.True(pdm1.InIdRange(0x680 + fr.Pid!.Value));
        pdm1.Outputs[0].Enabled = true;
        pdm1.Outputs[0].ThermalTau = 30;
        Assert.True(pdm1.InIdRange(0x680 + fr.Wire!.Value));
    }

    [Fact]
    public void Pdm_SendsAppended_OnlyItsActiveAppendedFrames()
    {
        // PDM-01 at 0x680, PDM-02 at 0x6A0: PDM-01's PID frame sits in PDM-02's core range
        var pdm1 = Pdm57WithWireAndPid(0x680);
        var pid = 0x680 + pdm1.UpstreamFrames().Pid!.Value;
        Assert.False(pdm1.SendsAppended(pid));            // PID off: the id is PDM-02's
        pdm1.Pids[0].Enabled = true;
        Assert.True(pdm1.SendsAppended(pid));             // PID on: PDM-01 sends it, PDM-02 must not read it
        Assert.False(pdm1.SendsAppended(0x682));          // a core frame is never "appended"
        Assert.False(new PdmDevice("old", 0x680).SendsAppended(0x6A0));   // pre-5.7: no appended frames
    }

    [Fact]
    public void Pdm_OnlyItsConfigReplyAndMsg0_MakeItConnected()
    {
        // PDM-03 at 0x6C0, absent; PDM-02 at 0x6A0 sends its tables (+33) and ignition (+36) frames = 0x6C1 / 0x6C4
        var pdm3 = new PdmDevice("PDM-03", 0x6C0);
        pdm3.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = UpstreamFamilyTests.Q();
        pdm3.Read(0x6C4, new byte[8], ref q, []);
        pdm3.Read(0x6C1, new byte[8], ref q, []);
        pdm3.UpdateIsConnected();
        Assert.False(pdm3.Connected);
        pdm3.Read(0x6C2, new byte[8], ref q, []);   // its own Msg0
        pdm3.UpdateIsConnected();
        Assert.True(pdm3.Connected);
    }

    [Fact]
    public void Dbc_OnlyItsOwnMessages()
    {
        var ecu = new DbcDevice("ECU", 0)
        {
            DbcSignals = [new DbcSignal { Id = 0x0C9, Name = "Rpm", StartBit = 0, Length = 16 },
                          new DbcSignal { Id = 0x7E8, Name = "Diag", StartBit = 0, Length = 8 }]
        };
        Assert.True(ecu.InIdRange(0x0C9));
        Assert.True(ecu.InIdRange(0x7E8));
        Assert.False(ecu.InIdRange(0x6A2));   // a dingo module's frame between the two
        Assert.False(ecu.InIdRange(0x731));
    }
}
