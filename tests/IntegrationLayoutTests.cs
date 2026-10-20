using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>
/// integration/all-features firmware (every feature branch merged): the var-map tail and the appended status frames
/// as the firmware numbers them. Var-map sizes = pVarMap length read with arm-none-eabi-nm from the integration ELFs:
/// dingopdm_v7 0x55c bytes = 343 (DashShutdown last, ignition parity c828e5c), dingopdmmax_v1 0x4dc = 311, canboard_v2 0x168 = 90. Frames: status/integration-frames.md.
/// </summary>
public class IntegrationLayoutTests
{
    // every param block / sub that decides a var-map entry or a frame on the integration PDM
    private static List<(int, int)> PdmKeys(int outputs, int inputs) =>
    [
        .. Block(0x0000, 1, 14),
        .. Block(Output.BaseIndex, outputs, 35),
        .. Block(DigitalInput.BaseIndex, inputs, 8),
        .. Block(TimerFunction.UpstreamBaseIndex, 8, 5),
        .. Block(LookupTable.UpstreamBaseIndex, 4, 3),
        .. Block(MathFunction.BaseIndex, 8, 3),
        .. Block(CanMessage.BaseIndex, 4, 3),
        .. Block(Ignition.BaseIndex, 1, 23),
        .. Enumerable.Range(0x30, outputs).Select(s => (Ignition.BaseIndex, s)),   // output roles
        .. Block(ComfortBlink.BaseIndex, 1, 3),
        .. Block(PidFunction.BaseIndex, 4, 3),
        .. Block(CurveFunction.BaseIndex, 4, 3),
        .. Block(LatchGateFunction.BaseIndex, 8, 3),
    ];

    private static PdmDevice IntegrationPdm(PdmDevice d, int outputs, int inputs)
    {
        d.HasLua = true;   // it answers the Lua commands
        LearnParams(d, 0x680, PdmKeys(outputs, inputs));
        d.BaseId = 0x680;
        return d;
    }

    private static (string Kind, int Number, string Prop) At(PdmDevice d, int i) => (d.VarMap[i].OwnerKind, d.VarMap[i].OwnerNumber, d.VarMap[i].PropertyName);

    [Fact]
    public void Pdm_v7_VarMapTail_MatchesTheIntegrationFirmware()
    {
        var d = IntegrationPdm(UpstreamPdm(), 8, 2);
        Assert.Equal(343, d.VarMap.Count);
        Assert.Equal(Enumerable.Range(0, 343), d.VarMap.Select(v => v.VariableIndex));
        Assert.Equal(("timer", 8, "State"), At(d, 224));
        Assert.Equal(("input", 1, "PWM Duty"), At(d, 225));
        Assert.Equal(("math", 1, "Value"), At(d, 229));
        Assert.Equal(("table", 1, "Value"), At(d, 237));
        Assert.Equal(("table", 4, "Value"), At(d, 240));
        Assert.Equal(("ignition", 1, "Ignition"), At(d, 241));
        Assert.Equal(("comfortblink", 1, "Left"), At(d, 248));
        Assert.Equal(("pid", 1, "Output"), At(d, 250));
        Assert.Equal(("curve", 1, "Value"), At(d, 266));
        Assert.Equal(("latchgate", 1, "Value"), At(d, 270));
        Assert.Equal(("output", 1, "Warning"), At(d, 278));
        Assert.Equal(("output", 1, "Undercurrent"), At(d, 294));
        Assert.Equal(("output", 1, "Wire Load"), At(d, 302));
        Assert.Equal(("lua", 1, "Value"), At(d, 310));
        Assert.Equal(("lua", 32, "Value"), At(d, 341));
        Assert.Equal(("ignition", 1, "Dash Shutdown"), At(d, 342));
        Assert.Equal([.. Enumerable.Range(0, 23), .. Enumerable.Range(0x30, 8)], d.Params.Where(p => p.Index == Ignition.BaseIndex && domain.Common.FwFamily.Has(d, p)).Select(p => p.SubIndex).Order());
    }

    [Fact]
    public void Pdm_Max_VarMapTail_MatchesTheIntegrationFirmware()
    {
        var max = new PdmDeviceDefinition(1, "dingoPDM-Max", "", 2, 4, 32, 32, 16, 4, 4, 32, 2, 5, 5, 107);
        var d = new PdmDevice(max, "Max", 0x680);
        d.SetLogger(Microsoft.Extensions.Logging.Abstractions.NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, [31, 1, 0, 0, 0, 6, 0, 3], ref q, []);
        IntegrationPdm(d, 4, 2);
        Assert.Equal(311, d.VarMap.Count);
        Assert.Equal(("ignition", 1, "Dash Shutdown"), At(d, 310));
        Assert.Equal(("input", 1, "PWM Duty"), At(d, 209));
        Assert.Equal(("math", 1, "Value"), At(d, 213));
        Assert.Equal(("table", 1, "Value"), At(d, 221));
        Assert.Equal(("ignition", 1, "Ignition"), At(d, 225));
        Assert.Equal(("comfortblink", 1, "Left"), At(d, 232));
        Assert.Equal(("pid", 1, "Output"), At(d, 234));
        Assert.Equal(("curve", 1, "Value"), At(d, 250));
        Assert.Equal(("latchgate", 1, "Value"), At(d, 254));
        Assert.Equal(("output", 1, "Warning"), At(d, 262));
        Assert.Equal(("output", 1, "Undercurrent"), At(d, 270));
        Assert.Equal(("output", 1, "Wire Load"), At(d, 274));
        Assert.Equal(("lua", 1, "Value"), At(d, 278));
    }

    [Fact]
    public void Canboard_VarMapTail_MatchesTheIntegrationFirmware()
    {
        var d = UpstreamAnalogScaleTests.UpstreamCb();
        UpstreamAnalogScaleTests.LearnParams(d, [.. Block(0x0000, 1, 3), .. Block(TimerFunction.UpstreamBaseIndex, 4, 5),
            .. Block(AnalogInput.BaseIndex, 5, 21), .. Block(MathFunction.BaseIndex, 4, 3), .. Block(CanMessage.BaseIndex, 2, 3),
            .. Block(ComfortBlink.BaseIndex, 1, 3)]);
        Assert.Equal(90, d.VarMap.Count);
        Assert.Equal(("timer", 1), (d.VarMap[75].OwnerKind, d.VarMap[75].OwnerNumber));
        Assert.Equal(("analoginput", 1, "Scaled Value"), (d.VarMap[79].OwnerKind, d.VarMap[79].OwnerNumber, d.VarMap[79].PropertyName));
        Assert.Equal(("math", 1), (d.VarMap[84].OwnerKind, d.VarMap[84].OwnerNumber));
        Assert.Equal(("comfortblink", "Right"), (d.VarMap[89].OwnerKind, d.VarMap[89].PropertyName));
        Assert.Equal(11, d.MaxCyclicId);   // DO PWM duty frame, Msg 9
    }

    [Fact]
    public void Pdm_AppendedFrames_TakeOneIndexEach_InMergeOrder()
    {
        var d = IntegrationPdm(UpstreamPdm(), 8, 2);
        Assert.Equal((32, 33, 34, 35, 36), ((int, int, int, int, int))(d.UpstreamFrames().Wire!, d.UpstreamFrames().Tables12!, d.UpstreamFrames().Tables34!, d.UpstreamFrames().Pid!, d.UpstreamFrames().Ignition!));
        Assert.Equal(36, d.IgnitionStateOffset);
        Assert.Equal(35, d.MaxCyclicId);
        Assert.True(d.InIdRange(0x680 + 36));
        Assert.False(d.InIdRange(0x680 + 37));

        var q = Q();
        d.Read(0x680 + 32, [10, 20, 30, 40, 50, 60, 70, 80], ref q, []);
        Assert.Equal(30, d.Outputs[2].WireLoad);
        d.Read(0x680 + 33, [.. BitConverter.GetBytes(15f), .. BitConverter.GetBytes(-2.5f)], ref q, []);
        d.Read(0x680 + 34, [.. BitConverter.GetBytes(7f), .. BitConverter.GetBytes(8f)], ref q, []);
        Assert.Equal([15.0, -2.5, 7.0, 8.0], d.Tables.Take(4).Select(t => t.Value));
        d.Read(0x680 + 35, [0xF4, 0x01, 0x9C, 0xFF, 0, 0, 0, 0], ref q, []);   // 50.0, -10.0
        Assert.Equal((50.0, -10.0), (d.Pids[0].Value, d.Pids[1].Value));
        d.Read(0x680 + 36, [(byte)'I', 3, 0x1C, 0, 0, 0, 0, 0], ref q, []);
        Assert.Equal((IgnitionState.Running, true), (d.Ignition.State, d.Ignition.Dash));
        // ignition parity: the status frame (any role): Cranking | follower << 4, dash Halting, sleep Counting, link ok,
        // 300 s to sleep, flags ignition + dash + starter + dash shutdown, woke from sleep on CAN
        d.Read(0x680 + 36, [0x12, 3, 2, 1, 0x2C, 0x01, 0x4D, 0x81], ref q, []);
        Assert.Equal(new IgnitionStatus(IgnitionState.Cranking, 1, 3, 2, 1, 300, 0x4D, 0x81), d.Ignition.Status);
        Assert.Equal((IgnitionState.Cranking, true), (d.Ignition.State, d.Ignition.Dash));
        d.Read(0x680 + 36, [0x01, 1, 1, 0, 0, 0, 0x01, 0], ref q, []);   // on, dash flag off
        Assert.Equal((IgnitionState.On, false), (d.Ignition.State, d.Ignition.Dash));

        // a module with only the PID and the ignition: PID at the first appended frame, ignition next
        var p = UpstreamPdm();
        LearnParams(p, 0x680, [.. Block(0x0000, 1, 9), .. Block(TimerFunction.UpstreamBaseIndex, 8, 5),
            .. Block(PidFunction.BaseIndex, 4, 3), .. Block(Ignition.BaseIndex, 1, 11)]);
        Assert.Equal(((int?)null, (int?)null, (int?)null, (int?)32, (int?)33), p.UpstreamFrames());
    }
}
