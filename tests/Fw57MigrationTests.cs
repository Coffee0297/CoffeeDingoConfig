using System.Text.Json;
using application.Models;
using application.Services;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Enums;
using domain.Firmware;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static tests.UpstreamFamilyTests;

namespace tests;

/// <summary>
/// The 5.7 line (firmware integration/all-features) is the operator's new 5.x: upstream layout from 5.7.0 on, fork
/// layout below. Currents 0.1 A/bit on 5.7 (as the fork), 1 A on upstream 0.x. Fork projects are converted
/// (Fw57Migration). CANBoard 5.7: ignition at 0x1E00, var map 88-94, state frame Msg 10 = base+12, var map 97 =
/// nm pVarMap 0x184 of canboard_v2.elf (integration).
/// </summary>
public class Fw57MigrationTests
{
    internal static byte[] Ver(int maj, int min, int build) => [31, 0, 0, 0, (byte)maj, (byte)min, (byte)(build >> 8), (byte)build];

    internal static PdmDevice Pdm(int maj, int min, int build, int baseId = 0x680)
    {
        var d = new PdmDevice("PDM", baseId);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(baseId, Ver(maj, min, build), ref q, []);
        return d;
    }

    internal static CanboardDevice Cb(int maj, int min, int build, int baseId = 0x660)
    {
        var d = new CanboardDevice("CB", baseId);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        var q = Q();
        d.Read(baseId, Ver(maj, min, build), ref q, []);
        return d;
    }

    internal static int Idx(IDeviceConfigurable d, string kind, int n, string prop) =>
        d.VarMap.Single(v => v.OwnerKind == kind && v.OwnerNumber == n && v.PropertyName == prop).VariableIndex;
    private static DeviceVariable At(IDeviceConfigurable d, int i) => d.VarMap.Single(v => v.VariableIndex == i);

    // ---- family -----------------------------------------------------------------------------------

    [Theory]
    [InlineData(0, 6, FwFamily.Upstream)]
    [InlineData(5, 6, FwFamily.Fork)]
    [InlineData(5, 5, FwFamily.Fork)]
    [InlineData(5, 7, FwFamily.Upstream)]
    [InlineData(5, 8, FwFamily.Upstream)]
    [InlineData(6, 0, FwFamily.Upstream)]
    public void Family_FromVersion(int maj, int min, string family) => Assert.Equal(family, FwFamily.Of(maj, min));

    [Fact]
    public void VersionReply_56IsFork_57IsUpstreamLayout_OnBothBoards()
    {
        Assert.Equal(FwFamily.Fork, Pdm(5, 6, 6).Family);
        Assert.Equal(FwFamily.Upstream, Pdm(5, 7, 0).Family);
        Assert.Equal(FwFamily.Fork, Cb(5, 6, 6).Family);
        Assert.Equal(FwFamily.Upstream, Cb(5, 7, 0).Family);
    }

    [Fact]
    public void A57Module_DoesNotGetForkOnlyParams_ByItsVersionNumber()
    {
        // 5.7 >= 5.6, but on the upstream layout params come from the module's list, not from "Since" versions
        var d = Pdm(5, 7, 0);
        var math = d.Params.First(p => p.Index == MathFunction.BaseIndex);
        Assert.False(FwFamily.Has(d, math));   // list unknown yet: nothing
        Assert.DoesNotContain(d.Params, p => p.Name.EndsWith(".edge"));   // the fork's timer edge
        Assert.Contains(d.Params, p => p.Index == TimerFunction.UpstreamBaseIndex && p.SubIndex == 2);   // reset input
        var f = Pdm(5, 6, 6);
        Assert.True(FwFamily.Has(f, f.Params.First(p => p.Index == MathFunction.BaseIndex)));
    }

    // ---- currents ---------------------------------------------------------------------------------

    [Theory]
    [InlineData(5, 7, 0, 7.4)]   // integration: 0.1 A/bit
    [InlineData(5, 6, 6, 7.4)]   // fork
    [InlineData(0, 6, 3, 74.0)]  // plain upstream: whole amps
    public void Currents_PerFirmwareLine(int maj, int min, int build, double amps)
    {
        var d = Pdm(maj, min, build);
        var q = Q();
        d.Read(0x680 + 2, [0, 0, 74, 0, 120, 0, 250, 0], ref q, []);   // Msg 0: total current raw 74
        Assert.Equal(amps, d.TotalCurrent, 3);
        d.Read(0x680 + 3, [74, 0, 0, 0, 0, 0, 0, 0], ref q, []);        // Msg 1: output 1 raw 74
        Assert.Equal(amps, d.Outputs[0].Current, 3);
    }

    [Fact]
    public void Currents_ProjectSavedUpstream_ThenModuleSays57_TenthAmps()
    {
        var d = new PdmDevice("PDM", 0x680) { Family = FwFamily.Upstream };
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        d.ApplyDefinition(new PdmDeviceDefinition(0, "dingoPDM", "", 2, 8, 32, 32, 16, 4, 4, 32, 2, 5, 5, 107));
        var q = Q();
        d.Read(0x680, Ver(5, 7, 0), ref q, []);
        d.Read(0x680 + 2, [0, 0, 74, 0, 0, 0, 0, 0], ref q, []);
        Assert.Equal(7.4, d.TotalCurrent, 3);
    }

    [Fact]
    public void CanBootloader_57LineAlways_PlainUpstreamOnlyWhenTicked()
    {
        Assert.True(Pdm(5, 7, 0).CanBootloader);   // 5.7 apps are linked behind OpenBLT
        Assert.True(Cb(5, 7, 0).CanBootloader);
        Assert.True(Pdm(5, 6, 6).CanBootloader);
        Assert.False(Pdm(0, 6, 3).CanBootloader);   // plain upstream: the operator ticks it (OpenBlt)
        Assert.False(Cb(0, 6, 3).CanBootloader);
    }

    [Fact]
    public void ProjectFile_HasNoCanBootloader_ItFollowsTheReportedVersion()
    {
        // in the file it flipped to true when a just-opened 5.7 project's modules reported their version: "unsaved" at once
        Assert.DoesNotContain("canBootloader", JsonSerializer.Serialize(Pdm(5, 7, 0)));
        Assert.DoesNotContain("canBootloader", JsonSerializer.Serialize(Cb(5, 7, 0)));
    }

    // ---- CANBoard 5.7 -----------------------------------------------------------------------------

    internal static List<(int, int)> Cb57Keys() =>
    [
        .. Block(0x0000, 1, 3), .. Block(TimerFunction.UpstreamBaseIndex, 4, 5), .. Block(AnalogInput.BaseIndex, 5, 21),
        .. Block(MathFunction.BaseIndex, 4, 3), .. Block(CanMessage.BaseIndex, 2, 3), .. Block(Ignition.BaseIndex, 1, 24),
        .. Block(ComfortBlink.BaseIndex, 1, 3), .. Block(DigitalInput.BaseIndex, 8, 8), .. Block(PidFunction.BaseIndex, 2, 21),
    ];

    [Fact]
    public void Canboard57_VarMap_122()
    {
        var d = Cb(5, 7, 0);
        UpstreamAnalogScaleTests.LearnParams(d, Cb57Keys());
        Assert.Equal(122, d.VarMap.Count);   // nm canboard_v2.elf (integration c828e5c): pVarMap 0x1E8 bytes
        Assert.Equal(Enumerable.Range(0, 122), d.VarMap.Select(v => v.VariableIndex));
        Assert.Equal(("timer", 1), (At(d, 75).OwnerKind, At(d, 75).OwnerNumber));
        for (var n = 1; n <= 8; n++)
        {
            Assert.Equal(("input", n, "PWM Duty"), (At(d, 79 + 2 * (n - 1)).OwnerKind, At(d, 79 + 2 * (n - 1)).OwnerNumber, At(d, 79 + 2 * (n - 1)).PropertyName));
            Assert.Equal(("input", n, "PWM Frequency"), (At(d, 80 + 2 * (n - 1)).OwnerKind, At(d, 80 + 2 * (n - 1)).OwnerNumber, At(d, 80 + 2 * (n - 1)).PropertyName));
        }
        Assert.Equal(("analoginput", 1, "Scaled Value"), (At(d, 95).OwnerKind, At(d, 95).OwnerNumber, At(d, 95).PropertyName));
        Assert.Equal(("math", 1), (At(d, 100).OwnerKind, At(d, 100).OwnerNumber));
        Assert.Equal(["Ignition", "Accessory", "Cranking", "Running", "Ready", "Dash", "Link OK"], Enumerable.Range(104, 7).Select(i => At(d, i).PropertyName));
        Assert.All(Enumerable.Range(104, 7), i => Assert.Equal("ignition", At(d, i).OwnerKind));
        Assert.Equal(("comfortblink", "Left"), (At(d, 111).OwnerKind, At(d, 111).PropertyName));
        Assert.Equal(("comfortblink", "Right"), (At(d, 112).OwnerKind, At(d, 112).PropertyName));
        Assert.Equal(("pid", 1, "Output"), (At(d, 113).OwnerKind, At(d, 113).OwnerNumber, At(d, 113).PropertyName));
        Assert.Equal(("pid", 2, "Output"), (At(d, 117).OwnerKind, At(d, 117).OwnerNumber, At(d, 117).PropertyName));
        Assert.Equal(("pid", 2, "D"), (At(d, 120).OwnerKind, At(d, 120).OwnerNumber, At(d, 120).PropertyName));
        Assert.Equal(("ignition", "Dash Shutdown"), (At(d, 121).OwnerKind, At(d, 121).PropertyName));
        Assert.Equal(Enumerable.Range(0, 24).ToList(), d.Params.Where(p => p.Index == Ignition.BaseIndex).Select(p => p.SubIndex).Order().ToList());   // no output roles
        Assert.Equal(Enumerable.Range(0, 21).ToList(), d.Params.Where(p => p.Index == PidFunction.BaseIndex + 1).Select(p => p.SubIndex).Order().ToList());
    }

    [Fact]
    public void Canboard57_PidFrame_IsMsg11_Base13()
    {
        var d = Cb(5, 7, 0);
        UpstreamAnalogScaleTests.LearnParams(d, Cb57Keys());
        d.BaseId = 0x660;
        Assert.True(d.InIdRange(0x660 + 13));
        Assert.False(d.InIdRange(0x660 + 14));
        var q = Q();
        d.Read(0x660 + 13, [0x2C, 0x01, 0xF6, 0xFF, 0, 0, 0, 0], ref q, []);   // 300 -> 30.0, -10 -> -1.0
        Assert.Equal((30.0, -1.0), (d.Pids[0].Value, d.Pids[1].Value));
        var c = Cb(5, 7, 0); c.BaseId = 0x660;
        c.Pids[0].Enabled = true;
        Assert.Equal(13, Fw57Migration.Span(c));
        Assert.DoesNotContain(Cb(5, 6, 6).Params, p => p.Index == PidFunction.BaseIndex);   // the fork CANBoard has none
    }

    [Fact]
    public void Canboard57_IgnitionStateFrame_IsMsg10_Base12()
    {
        var d = Cb(5, 7, 0);
        UpstreamAnalogScaleTests.LearnParams(d, Cb57Keys());
        d.BaseId = 0x660;   // the all-zero Read set it to 0
        Assert.Equal(12, d.IgnitionStateOffset);
        Assert.True(d.InIdRange(0x660 + 12));
        Assert.False(d.InIdRange(0x660 + 14));
        var q = Q();
        d.Read(0x660 + 12, [(byte)'I', 3, 0x1F, 0, 0, 0, 0, 0], ref q, []);
        Assert.Equal(IgnitionState.Running, d.Ignition.State);
        Assert.True(d.Ignition.Dash);
        Assert.Equal(14, Cb(5, 6, 6).IgnitionStateOffset);   // fork unchanged
        Assert.Null(Cb(0, 6, 1).IgnitionStateOffset);          // stock upstream: no ignition
    }

    [Fact]
    public void Assumed57Layout_EqualsTheLearnedOne()
    {
        var p = Pdm(5, 6, 6);
        p.UseFamily(FwFamily.Upstream, assumeAll: true);
        var learned = IntegrationLayoutTestsAccess.IntegrationPdm();
        Assert.Equal(343, p.VarMap.Count);   // nm dingopdm_v7.elf (integration c828e5c): pVarMap 0x55c
        Assert.Equal(learned.VarMap.Select(v => (v.OwnerKind, v.OwnerNumber, v.PropertyName)), p.VarMap.Select(v => (v.OwnerKind, v.OwnerNumber, v.PropertyName)));
        Assert.False(p.ParamSet.FromModule);   // Apply still waits for a Read

        var c = Cb(5, 6, 6);
        c.UseFamily(FwFamily.Upstream, assumeAll: true);
        Assert.Equal(122, c.VarMap.Count);
        var cl = Cb(5, 7, 0);
        UpstreamAnalogScaleTests.LearnParams(cl, Cb57Keys());
        Assert.Equal(cl.VarMap.Select(v => (v.OwnerKind, v.OwnerNumber, v.PropertyName)), c.VarMap.Select(v => (v.OwnerKind, v.OwnerNumber, v.PropertyName)));
    }

    // ---- migration --------------------------------------------------------------------------------

    /// <summary>A fork 5.6 PDM with one binding to each kind of signal that moves on 5.7.</summary>
    private static PdmDevice ForkPdm(int baseId = 0x680)
    {
        var d = Pdm(5, 6, 6, baseId);
        d.Name = $"PDM-{baseId:X3}";
        int I(string k, int n, string p) => Idx(d, k, n, p);
        d.Outputs[0].Enabled = true; d.Outputs[0].Input = I("math", 1, "Value");
        d.Outputs[1].Enabled = true; d.Outputs[1].Input = I("comfortblink", 1, "Right");
        d.Outputs[2].Enabled = true; d.Outputs[2].Input = I("ignition", 1, "Accessory");
        d.Outputs[3].Enabled = true; d.Outputs[3].Input = I("lua", 3, "Value");
        d.Outputs[4].Enabled = true; d.Outputs[4].Input = I("timer", 2, "State");
        d.Outputs[5].Enabled = true; d.Outputs[5].Input = I("canmsg", 1, "Sending");   // no 5.7 equivalent
        d.Outputs[6].Enabled = true; d.Outputs[6].Input = I("output", 1, "On");         // same place on both
        d.Maths[0].Enabled = true; d.Maths[0].InputA = I("table", 1, "Value");
        d.MuteTxInput = I("ignition", 1, "Running");
        d.ComfortBlink.LeftInput = I("input", 1, "State");
        d.Timers[0].Enabled = true; d.Timers[0].Input = I("input", 2, "State"); d.Timers[0].Edge = InputEdge.Falling; d.Timers[0].Preset = 1800000;
        d.Timers[1].Enabled = true; d.Timers[1].Input = I("condition", 3, "Value"); d.Timers[1].Mode = TimerMode.Pulse;
        d.Conditions[0].Enabled = true; d.Conditions[0].Operator = Operator.GreaterThan; d.Conditions[0].Arg = 90; d.Conditions[0].ArgOff = 85;
        d.Conditions[0].Input = I("caninput", 1, "Value");
        d.Conditions[1].Enabled = true; d.Conditions[1].Operator = Operator.Equal; d.Conditions[1].Arg = 3; d.Conditions[1].ArgOff = 4;
        d.CanInputs[0].Enabled = true; d.CanInputs[0].TimeoutEnabled = true; d.CanInputs[0].TimeoutValue = 50;
        d.CanInputs[1].Enabled = true; d.CanInputs[1].TimeoutEnabled = true; d.CanInputs[1].TimeoutValue = 0; d.CanInputs[1].Operator = Operator.NotEqual; d.CanInputs[1].Operand = 1;   // true at 0
        d.CanInputs[2].Enabled = true; d.CanInputs[2].TimeoutEnabled = true; d.CanInputs[2].TimeoutValue = 0; d.CanInputs[2].Operator = Operator.Equal; d.CanInputs[2].Operand = 1;   // false at 0
        d.LuaProgram = $"local a = readVar({I("math", 2, "Value")})\nlocal b = readVar({I("output", 2, "On")})\nlocal c = readVar(n)\n";
        return d;
    }

    private static List<MigrationNote> Notes(IDeviceConfigurable d) => d.Migration ?? [];
    private static bool Has(IDeviceConfigurable d, string level, string text) => Notes(d).Any(n => n.Level == level && n.Text.Contains(text));

    [Fact]
    public void Migrate_RemapsEveryBinding_BySignalIdentity()
    {
        var d = ForkPdm();
        Fw57Migration.Migrate([d], [d]);
        Assert.Equal(FwFamily.Upstream, d.Family);
        Assert.True(d.KeepValuesOnRead);
        int I(string k, int n, string p) => Idx(d, k, n, p);
        Assert.Equal(I("math", 1, "Value"), d.Outputs[0].Input);
        Assert.Equal(229, d.Outputs[0].Input);   // integration v7: math 229-236
        Assert.Equal(I("comfortblink", 1, "Right"), d.Outputs[1].Input);
        Assert.Equal(I("ignition", 1, "Accessory"), d.Outputs[2].Input);
        Assert.Equal(I("lua", 3, "Value"), d.Outputs[3].Input);
        Assert.Equal(I("timer", 2, "State"), d.Outputs[4].Input);
        Assert.Equal(0, d.Outputs[5].Input);
        Assert.True(Has(d, "warn", "output[6].input"));
        Assert.Equal(I("output", 1, "On"), d.Outputs[6].Input);
        Assert.Equal(I("table", 1, "Value"), d.Maths[0].InputA);
        Assert.Equal(I("ignition", 1, "Running"), d.MuteTxInput);
        Assert.Equal(I("input", 1, "State"), d.ComfortBlink.LeftInput);
        Assert.Equal(I("condition", 3, "Value"), d.Timers[1].Input);
        Assert.Equal(I("caninput", 1, "Value"), d.Conditions[0].Input);
        Assert.True(Has(d, "info", "renumbered"));
    }

    [Fact]
    public void Migrate_FallingEdgeTimer_GetsANotVirtualInput()
    {
        var d = ForkPdm();
        var src = Idx(d, "input", 2, "State");
        Fw57Migration.Migrate([d], [d]);
        var t = d.Timers[0];
        Assert.Equal(InputEdge.Rising, t.Edge);
        var vi = d.VirtualInputs.Single(v => v.Enabled);
        Assert.Equal(Idx(d, "virtualinput", vi.Number, "State"), t.Input);
        Assert.Equal(Idx(d, "input", 2, "State"), vi.Var0);   // same index on both layouts
        Assert.Equal(src, vi.Var0);
        Assert.True(vi.Not0);
        Assert.Equal(0, vi.Var1);
        Assert.Equal(Conditional.Or, vi.Cond0);   // NOT a OR off = NOT a
        Assert.Equal(TimerFunction.UpstreamMaxMs, t.Preset);
        Assert.True(Has(d, "warn", "600 s"));
        Assert.True(Has(d, "info", "restarts on a new edge"));
        Assert.True(Has(d, "info", "NOT of the input"));
    }

    [Fact]
    public void Migrate_FallingEdge_NoFreeVirtualInput_IsReported()
    {
        var d = ForkPdm();
        foreach (var v in d.VirtualInputs) { v.Enabled = true; v.Var0 = 1; }
        Fw57Migration.Migrate([d], [d]);
        Assert.True(Has(d, "warn", "no virtual input is free"));
    }

    [Fact]
    public void Migrate_Conditions_CanTimeouts_Lua()
    {
        var d = ForkPdm();
        Fw57Migration.Migrate([d], [d]);
        Assert.Equal(5, d.Conditions[0].HystBand);
        Assert.True(Has(d, "info", "band of 5"));
        Assert.True(Has(d, "warn", "condition2: hysteresis"));
        Assert.True(d.CanInputs[0].TimeoutUseValue);    // value 50
        Assert.True(d.CanInputs[1].TimeoutUseValue);    // value 0, rule true at 0
        Assert.False(d.CanInputs[2].TimeoutUseValue);   // value 0, rule false at 0: upstream's "off" is the same
        Assert.Contains($"readVar({Idx(d, "math", 2, "Value")})", d.LuaProgram);
        Assert.Contains($"readVar({Idx(d, "output", 2, "On")})", d.LuaProgram);
        Assert.Contains("readVar(n)", d.LuaProgram);
        Assert.True(Has(d, "warn", "take a name"));
    }

    [Fact]
    public void Migrate_CanboardRotary_CalibratedMode()
    {
        var c = Cb(5, 6, 6);
        c.AnalogInputs[0].Enabled = true; c.AnalogInputs[0].Rotary.Enabled = true; c.AnalogInputs[0].Rotary.NumPos = 6;
        c.DigitalOutputs[0].Enabled = true; c.DigitalOutputs[0].Input = Idx(c, "math", 1, "Value");
        c.DigitalOutputs[1].Enabled = true; c.DigitalOutputs[1].Input = Idx(c, "input", 2, "PWM Duty");
        Fw57Migration.Migrate([c], [c]);
        Assert.Equal(1, c.AnalogInputs[0].Rotary.Mode);
        Assert.Equal(100, c.DigitalOutputs[0].Input);   // integration CANBoard: math 100-103
        Assert.Equal(81, c.DigitalOutputs[1].Input);    // DI PWM is on the 5.7 CANBoard: DI 2 duty = 79 + 2
        Assert.DoesNotContain(c.Migration!, n => n.Text.Contains("PWM"));
    }

    [Fact]
    public void Migrate_CrossModule_FramesAndFollowers_AndOverlap()
    {
        var main = ForkPdm(0x680);
        main.Ignition.Enabled = true; main.Ignition.Role = IgnitionRole.Main;
        main.Tables[0].Enabled = true;
        var next = ForkPdm(0x6A0);
        next.Ignition.Enabled = true; next.Ignition.Role = IgnitionRole.Follower; next.Ignition.MainStateId = 0x680 + 30;
        // next reads main's table 1 (fork Msg 27 = +29) and output 2 current (Msg 1 = +3)
        next.CanInputs[5].Enabled = true; next.CanInputs[5].Id = 0x680 + 29; next.CanInputs[5].StartBit = 0; next.CanInputs[5].BitLength = 32;
        next.CanInputs[6].Enabled = true; next.CanInputs[6].Id = 0x680 + 3; next.CanInputs[6].StartBit = 16; next.CanInputs[6].BitLength = 16;
        var cb = Cb(5, 6, 6, 0x660);   // a fork CANBoard that also follows: not migrated, it cannot follow a 5.7 main
        cb.Ignition.Enabled = true; cb.Ignition.Role = IgnitionRole.Follower; cb.Ignition.MainStateId = 0x680 + 30;
        Fw57Migration.Migrate([main, next, cb], [main, next]);

        Assert.Equal(0x680 + 33, next.CanInputs[5].Id);   // integration: tables 1-2 at +33
        Assert.Equal(0, next.CanInputs[5].StartBit);
        Assert.Equal(0x680 + 3, next.CanInputs[6].Id);    // unchanged
        // 5.7 syncs on its own id: both migrated modules on the default, main stays main
        Assert.Equal((IgnitionRole.Main, 0x6F1, IgnitionSyncMode.Absolute), (main.Ignition.Role, main.Ignition.MainStateId, main.Ignition.SyncMode));
        Assert.Equal((IgnitionRole.Follower, 0x6F1, IgnitionSyncMode.Absolute), (next.Ignition.Role, next.Ignition.MainStateId, next.Ignition.SyncMode));
        Assert.Equal(0x680 + 30, cb.Ignition.MainStateId);   // the fork CANBoard is left alone, and told
        Assert.True(Has(main, "warn", "CB ignition follower"));
        Assert.True(Has(main, "info", "reads PDM-680 Table1.Value"));
        // main's ignition status frame (+36 = 0x6A4) lands in next's range (0x6A0..)
        Assert.True(Has(main, "warn", "CAN ids overlap"));
        Assert.True(Has(main, "warn", "move PDM-6A0 to 0x6B0"));
        Assert.Equal(FwFamily.Fork, cb.Family);
    }

    [Fact]
    public void Migrate_DefaultSyncIdInsideAModulesRange_Warns()
    {
        var a = ForkPdm(0x680); a.Ignition.Enabled = true;
        var b = ForkPdm(0x6E0); b.Ignition.Enabled = true; b.Ignition.Role = IgnitionRole.Follower;   // 0x6E0..0x704 holds 0x6F1
        Fw57Migration.Migrate([a, b], [a, b]);
        Assert.True(Has(a, "warn", "sync id 0x6F1 is one of PDM-6E0's frames"));
        var c = ForkPdm(0x680); c.Ignition.Enabled = true;
        Fw57Migration.Migrate([c], [c]);
        Assert.False(Has(c, "warn", "sync id"));
    }

    [Fact]
    public void AutoTrigger_ConfiguredForkRecord_On57Reply_ThenReadKeepsTheProject()
    {
        var d = ForkPdm();
        d.Outputs[0].CurrentLimit = 12.5;
        var q = Q();
        d.Read(0x680, Ver(5, 7, 0), ref q, []);
        Assert.True(d.Migrate57Pending);   // DeviceManager converts right after this frame
        Assert.Equal(FwFamily.Fork, d.Family);
        Fw57Migration.Migrate([d], [d]);
        Assert.False(d.Migrate57Pending);
        var math1 = d.Outputs[0].Input;

        // the module's Read (all values 0) learns its list but keeps the project
        LearnParams(d, 0x680, IntegrationLayoutTestsAccess.PdmKeys(8, 2));
        Assert.True(d.ParamSet.FromModule);
        Assert.False(d.KeepValuesOnRead);
        Assert.Equal(12.5, d.Outputs[0].CurrentLimit);
        Assert.Equal(math1, d.Outputs[0].Input);
        Assert.True(d.ConfigMismatch);

        // the next Read takes the module's values as usual
        LearnParams(d, 0x680, IntegrationLayoutTestsAccess.PdmKeys(8, 2));
        Assert.Equal(0, d.Outputs[0].Input);
    }

    [Fact]
    public void ReopenedProject_TheReadBeforeApplyKeepsTheFilesValues()
    {
        // a 5.7 project saved after a Read, edited, opened again: the app needs a Read before it may write, and that
        // Read used to replace the edit with the module's value
        var d = ForkPdm();
        var q = Q();
        d.Read(0x680, Ver(5, 7, 0), ref q, []);
        Fw57Migration.Migrate([d], [d]);
        LearnParams(d, 0x680, IntegrationLayoutTestsAccess.PdmKeys(8, 2));
        d.Outputs[0].CurrentLimit = 12.5;
        var cfg = new ConfigFileManager(NullLogger<ConfigFileManager>.Instance, new DeviceDefinitionManager());
        var back = (PdmDevice)cfg.LoadDevicesFromJson(cfg.SerializeDevices([d]))!.Single();
        back.SetLogger(NullLogger<PdmDevice>.Instance);
        Assert.True(back.KeepValuesOnRead);
        LearnParams(back, 0x680, IntegrationLayoutTestsAccess.PdmKeys(8, 2));
        Assert.True(back.ParamSet.FromModule);
        Assert.Equal(12.5, back.Outputs[0].CurrentLimit);
    }

    [Fact]
    public void AutoTrigger_FreshRecord_JustSwitchesLayout()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, Ver(5, 7, 0), ref q, []);
        Assert.False(d.Migrate57Pending);
        Assert.Equal(FwFamily.Upstream, d.Family);
        Assert.Null(d.Migration);
    }

    [Fact]
    public void MigratedRecord_MeetingA56Module_KeepsTheLayout()
    {
        var d = ForkPdm();
        Fw57Migration.Migrate([d], [d]);
        string? err = null;
        d.ErrorNotification += m => err = m;
        var q = Q();
        d.Read(0x680, Ver(5, 6, 6), ref q, []);
        Assert.Equal(FwFamily.Upstream, d.Family);
        Assert.Contains("flash 5.7 first", err);
        Assert.False(DeviceManager.ParamsKnown(d));
        Assert.True(DeviceManager.OlderLine(d));
    }

    // ---- flash over CAN ---------------------------------------------------------------------------

    [Fact]
    public void AppBase_CanboardTakes08002000_PdmDoesNot()
    {
        Assert.True(DfuImage.IsAppBase(0x08004000, isCanboard: false));
        Assert.False(DfuImage.IsAppBase(0x08002000, isCanboard: false));
        Assert.True(DfuImage.IsAppBase(0x08002000, isCanboard: true));
        Assert.True(DfuImage.IsAppBase(0x08004000, isCanboard: true));
        Assert.False(DfuImage.IsAppBase(0x08000000, isCanboard: true));
        Assert.Equal("upstream", SRecordImage.FamilyOf("5.7.0"));
        Assert.Equal("fork", SRecordImage.FamilyOf("5.6.6"));
        Assert.Equal("upstream", SRecordImage.FamilyOf("0.6.1"));
    }

    // ---- fixture projects -------------------------------------------------------------------------

    internal static List<IDevice> LoadProject(string path)
    {
        var cfg = JsonSerializer.Deserialize<ConfigFile>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        foreach (var p in cfg.PdmDevices) { p.SetLogger(NullLogger<PdmDevice>.Instance); p.ApplyDefinition(DeviceDefinitionManager.DefaultPdm); }
        foreach (var c in cfg.CanboardDevices) { c.SetLogger(NullLogger<CanboardDevice>.Instance); c.ApplyDefinition(DeviceDefinitionManager.DefaultCanboard); }
        return [.. cfg.PdmDevices, .. cfg.CanboardDevices, .. cfg.DbcDevices];
    }

    private static void AssertMigratedSane(List<IDevice> all)
    {
        foreach (var d in all.OfType<IDeviceConfigurable>())
        {
            Assert.Equal(FwFamily.Upstream, d.Family);
            Assert.NotNull(d.Migration);
            var max = d.VarMap.Count;
            foreach (var p in d.Params.Where(Fw57Migration.IsBinding))
                Assert.InRange((int)p.GetValue(), 0, max - 1);
        }
    }

    [Fact]
    public void Migrate_TestBenchProject()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "configs", "TestBench.json");
        var all = LoadProject(path);
        var mods = all.OfType<IDeviceConfigurable>().ToList();
        Assert.All(mods, m => Assert.Equal(FwFamily.Fork, m.Family));
        var before = mods.ToDictionary(m => m, m => m.Params.Where(Fw57Migration.IsBinding).DistinctBy(p => p.Name)
            .Where(p => (int)p.GetValue() > 0).ToDictionary(p => p.Name, p => m.VarMap.First(v => v.VariableIndex == (int)p.GetValue())));
        Fw57Migration.Migrate(all, mods);
        AssertMigratedSane(all);
        // every binding still names the same signal (or was reported)
        foreach (var (m, b) in before)
            foreach (var (name, v) in b)
            {
                var now = (int)m.Params.First(p => p.Name == name).GetValue();
                if (now == 0) { Assert.Contains(m.Migration!, n => n.Level == "warn" && n.Text.Contains(name)); continue; }
                var nv = m.VarMap.First(x => x.VariableIndex == now);
                if (name.StartsWith("timer") && nv.OwnerKind == "virtualinput") continue;   // falling edge: NOT in front
                Assert.Equal((v.OwnerKind, v.OwnerNumber, v.PropertyName), (nv.OwnerKind, nv.OwnerNumber, nv.PropertyName));
            }
    }

    /// <summary>MIGRATION_FIXTURE=&lt;a COPY of a real project&gt; [MIGRATION_REPORT=&lt;file&gt;]: migrate it and write the report
    /// (never point this at the operator's own project file; it only reads it).</summary>
    [Fact]
    public void Migrate_ProjectFromEnv_WritesReport()
    {
        var path = Environment.GetEnvironmentVariable("MIGRATION_FIXTURE");
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
        var all = LoadProject(path);
        var mods = all.OfType<IDeviceConfigurable>().ToList();
        Fw57Migration.Migrate(all, mods);
        AssertMigratedSane(all);
        if (Environment.GetEnvironmentVariable("MIGRATION_REPORT") is { Length: > 0 } outp)
            File.WriteAllLines(outp, mods.SelectMany(m => m.Migration!.Select(n => $"[{n.Level}] {n.Text}")));
    }
}

/// <summary>The integration PDM fixture of IntegrationLayoutTests, shared here.</summary>
internal static class IntegrationLayoutTestsAccess
{
    internal static List<(int, int)> PdmKeys(int outputs, int inputs) =>
    [
        .. Block(0x0000, 1, 14),
        .. Block(Output.BaseIndex, outputs, 35),
        .. Block(DigitalInput.BaseIndex, inputs, 8),
        .. Block(TimerFunction.UpstreamBaseIndex, 8, 5),
        .. Block(LookupTable.UpstreamBaseIndex, 4, 3),
        .. Block(MathFunction.BaseIndex, 8, 3),
        .. Block(CanMessage.BaseIndex, 4, 3),
        .. Block(Ignition.BaseIndex, 1, 24),
        .. Enumerable.Range(0x30, outputs).Select(s => (Ignition.BaseIndex, s)),
        .. Block(ComfortBlink.BaseIndex, 1, 3),
        .. Block(PidFunction.BaseIndex, 4, 3),
        .. Block(CurveFunction.BaseIndex, 4, 3),
        .. Block(LatchGateFunction.BaseIndex, 8, 3),
    ];

    internal static PdmDevice IntegrationPdm()
    {
        var d = UpstreamPdm();
        d.HasLua = true;
        LearnParams(d, 0x680, PdmKeys(8, 2));
        return d;
    }
}
