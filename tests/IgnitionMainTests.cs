using System.Text.Json;
using application.Models;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Enums;
using domain.Interfaces;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static tests.Fw57MigrationTests;

namespace tests;

/// <summary>"Make a CANBoard the ignition main" (IgnitionMain.MoveTo) and "use this sync setting on all followers"
/// (IgnitionMain.SyncFollowers) on a project shaped like the Ranchero: PDM-02 at 0x6A0 is main, its key switch is CB-1 DI3
/// read over CAN, the start button a CB-2 bit, crank-allowed a virtual input and running a condition of its own. On 5.7
/// every module with the ignition on sends its status frame at base+36 (0x6C4 overlaps PDM-03 at 0x6C0), whatever its role.</summary>
public class IgnitionMainTests
{
    private static (List<IDevice> All, PdmDevice Main, CanboardDevice Cb1) Ranchero()
    {
        var pdms = new[] { 0x680, 0x6A0, 0x6C0 }.Select((b, i) => { var p = Pdm(5, 6, 6, b); p.Name = $"PDM-0{i + 1}"; return p; }).ToList();
        var cb1 = Cb(5, 6, 6, 0x660); cb1.Name = "CB-1";
        var cb2 = Cb(5, 6, 6, 0x670); cb2.Name = "CB-2";
        var main = pdms[1];
        int I(string k, int n, string p) => Idx(main, k, n, p);
        main.CanInputs[8].Enabled = true; main.CanInputs[8].Name = "Ignition"; main.CanInputs[8].Id = 0x664; main.CanInputs[8].StartBit = 34;
        main.CanInputs[8].BitLength = 1; main.CanInputs[8].Operator = Operator.GreaterThan; main.CanInputs[8].Operand = 0;
        main.CanInputs[31].Enabled = true; main.CanInputs[31].Name = "CB-2 Start Button"; main.CanInputs[31].Id = 0x674; main.CanInputs[31].StartBit = 32;
        main.CanInputs[31].BitLength = 1; main.CanInputs[31].Operator = Operator.NotEqual; main.CanInputs[31].Operand = 0;
        main.VirtualInputs[11].Enabled = true; main.VirtualInputs[11].Name = "Ign Crank OK"; main.VirtualInputs[11].Var0 = I("caninput", 9, "State");
        main.Conditions[2].Enabled = true; main.Conditions[2].Name = "Ign Running A"; main.Conditions[2].Input = I("caninput", 9, "Value");
        main.Ignition.Enabled = true; main.Ignition.Role = IgnitionRole.Main; main.Ignition.MaxCrankMs = 4000; main.Ignition.DashHoldMs = 3000;
        main.Ignition.IgnitionInput = I("caninput", 9, "State"); main.Ignition.StartInput = I("caninput", 32, "State");
        main.Ignition.CrankAllowInput = I("virtualinput", 12, "State"); main.Ignition.RunningInput = I("condition", 3, "Value");
        List<IDevice> all = [.. pdms, cb1, cb2];
        foreach (var d in all.OfType<IDeviceConfigurable>().Where(d => d != main))
        {
            var g = d is PdmDevice p ? p.Ignition : ((CanboardDevice)d).Ignition;
            g.Enabled = true; g.Role = IgnitionRole.Follower; g.MainStateId = 0x6A0 + 30;
        }
        Fw57Migration.Migrate(all, [.. all.OfType<IDeviceConfigurable>()]);
        return (all, main, cb1);
    }

    private static bool Overlap(IEnumerable<IDevice> all) =>
        all.OfType<IDeviceConfigurable>().Any(d => d.Migration?.Any(n => n.Text.StartsWith("CAN ids overlap")) == true);

    [Fact]
    public void Migration_KeepsTheMain_FollowersOnTheDefaultSyncId_NoIgnitionMainFix()
    {
        var (all, main, cb1) = Ranchero();
        Assert.Equal(main, IgnitionMain.Current(all));
        foreach (var d in all.OfType<IDeviceConfigurable>())
            Assert.Equal((d == main ? IgnitionRole.Main : IgnitionRole.Follower, 0x6F1, IgnitionSyncMode.Absolute), (IgnitionMain.Ign(d)!.Role, IgnitionMain.Ign(d)!.MainStateId, IgnitionMain.Ign(d)!.SyncMode));
        // moving the main would not help: the follower PDMs send their status frame too
        var w = main.Migration!.Single(n => n.Text.StartsWith("CAN ids overlap"));
        Assert.DoesNotContain("ignition main", w.Text);
        Assert.Null(w.Fix);
        Assert.Equal(cb1, IgnitionMain.Suggest(all, main));
    }

    [Fact]
    public void SyncFollowers_WritesOnlyFollowers()
    {
        var (all, main, _) = Ranchero();
        main.Ignition.SyncMode = IgnitionSyncMode.BaseOffset; main.Ignition.MainStateId = 0x40;
        var pdm3 = all.OfType<PdmDevice>().Single(p => p.Name == "PDM-03");
        pdm3.Ignition.Role = IgnitionRole.Standalone;
        var cb2 = all.OfType<CanboardDevice>().Single(c => c.Name == "CB-2");
        cb2.Ignition.Enabled = false;   // still a follower by role
        var fork = Pdm(5, 6, 6, 0x700); fork.Name = "PDM-FORK";
        fork.Ignition.Enabled = true; fork.Ignition.Role = IgnitionRole.Follower; fork.Ignition.MainStateId = 0x6A0 + 30;
        all.Add(fork);
        var snap = new ValuesSnapshot(all);

        var r = IgnitionMain.SyncFollowers(all, main);
        Assert.Null(r.Error);
        Assert.Equal(["CB-1", "CB-2", "PDM-01"], r.Changed.Select(d => d.Name).Order());
        Assert.Equal(["PDM-FORK"], r.Skipped);   // 5.6: sub 10 is a state-frame id there
        foreach (var d in r.Changed)
            Assert.Equal((0x40, IgnitionSyncMode.BaseOffset, 0x6A0), (IgnitionMain.Ign(d)!.MainStateId, IgnitionMain.Ign(d)!.SyncMode, IgnitionMain.Ign(d)!.SyncBase));
        // nothing else changed: only id, mode and base of the three followers (not the standalone PDM-03, the main, the fork one)
        var changes = snap.Changes();
        Assert.Equal(9, changes.Count);
        Assert.All(changes, c => Assert.Matches(@"^(PDM-01|CB-1|CB-2) ignition\.(mainStateId|syncMode|syncBase):", c));
        Assert.Equal((IgnitionRole.Standalone, 0x6F1, IgnitionSyncMode.Absolute), (pdm3.Ignition.Role, pdm3.Ignition.MainStateId, pdm3.Ignition.SyncMode));
        Assert.Equal(0x6A0 + 30, fork.Ignition.MainStateId);

        Assert.NotNull(IgnitionMain.SyncFollowers(all, pdm3).Error);   // only from a main

        // back to a fixed id: the followers' base goes back to 0 too
        main.Ignition.SyncMode = IgnitionSyncMode.Absolute; main.Ignition.MainStateId = 0x740;
        IgnitionMain.SyncFollowers(all, main);
        foreach (var d in r.Changed)
            Assert.Equal((0x740, IgnitionSyncMode.Absolute, 0), (IgnitionMain.Ign(d)!.MainStateId, IgnitionMain.Ign(d)!.SyncMode, IgnitionMain.Ign(d)!.SyncBase));
    }

    [Fact]
    public void MoveTo_CanboardBecomesMain_EveryoneFollowsItsFrame()
    {
        var (all, main, cb1) = Ranchero();
        var snap = new ValuesSnapshot(all);
        var r = IgnitionMain.MoveTo(all, cb1);
        Assert.True(r.Ok, r.Error);

        var g = cb1.Ignition;
        Assert.Equal((true, IgnitionRole.Main, 4000, 3000, 0x6F1), (g.Enabled, g.Role, g.MaxCrankMs, g.DashHoldMs, g.MainStateId));   // 5.7: keeps the car's sync id
        // the key switch is CB-1's own DI3
        Assert.Equal(Idx(cb1, "input", 3, "State"), g.IgnitionInput);
        // the start button: a copy of PDM-02's CAN input on CB-2's frame
        var start = cb1.CanInputs[cb1.VarMap.Single(v => v.VariableIndex == g.StartInput).OwnerNumber - 1];
        Assert.Equal((true, 0x674, 32, 1, Operator.NotEqual), (start.Enabled, start.Id, start.StartBit, start.BitLength, start.Operator));
        // crank allowed / running: worked out on PDM-02, read from its status frames (VI 12, condition 3)
        CanInput On(int v) => cb1.CanInputs[cb1.VarMap.Single(x => x.VariableIndex == v && x.OwnerKind == "caninput").OwnerNumber - 1];
        var sigs = main.GetStatusSigs().ToList();
        var vi = sigs.Single(s => s.Signal.Name == "VirtualInput12");
        var cond = sigs.Single(s => s.Signal.Name == "Condition3");
        Assert.Equal((vi.MessageId, vi.Signal.StartBit, true), (On(g.CrankAllowInput).Id, On(g.CrankAllowInput).StartBit, On(g.CrankAllowInput).TimeoutEnabled));
        Assert.Equal((cond.MessageId, cond.Signal.StartBit), (On(g.RunningInput).Id, On(g.RunningInput).StartBit));

        // PDM-02 follows; every follower keeps the sync id 0x6F1
        Assert.Equal((IgnitionRole.Follower, 0, 0), (main.Ignition.Role, main.Ignition.IgnitionInput, main.Ignition.CrankAllowInput));
        foreach (var d in all.OfType<IDeviceConfigurable>().Where(d => d != cb1))
        {
            var f = d is PdmDevice p ? p.Ignition : ((CanboardDevice)d).Ignition;
            Assert.Equal((IgnitionRole.Follower, 0x6F1), (f.Role, f.MainStateId));
        }
        Assert.DoesNotContain(r.Notes, n => n.Level == "warn" && !n.Text.StartsWith("CAN ids overlap"));   // the status frames still overlap
        Assert.Contains(snap.Changes(), c => c == "PDM-02 ignition.role: Main → Follower");

        // Undo puts every setting back
        snap.Restore();
        Assert.Empty(snap.Changes());
        Assert.Equal(IgnitionRole.Main, main.Ignition.Role);
        Assert.DoesNotContain(cb1.CanInputs, c => c.Enabled);
    }

    [Fact]
    public void MoveTo_CrankInterlockThatCannotMove_Refuses()
    {
        var (all, main, cb1) = Ranchero();
        main.Ignition.CrankAllowInput = Idx(main, "math", 1, "Value");   // not in any status frame
        var snap = new ValuesSnapshot(all);
        var r = IgnitionMain.MoveTo(all, cb1);
        Assert.False(r.Ok);
        Assert.Contains("crank allowed", r.Error);
        snap.Restore();
        Assert.Equal(IgnitionRole.Main, main.Ignition.Role);
    }

    [Fact]
    public void MoveTo_InvertedCanboardBit_UsesANotVirtualInput()
    {
        var (all, main, cb1) = Ranchero();
        main.CanInputs[8].Operator = Operator.Equal; main.CanInputs[8].Operand = 0;   // on while DI3 is off
        Assert.True(IgnitionMain.MoveTo(all, cb1).Ok);
        var vi = cb1.VirtualInputs[cb1.VarMap.Single(v => v.VariableIndex == cb1.Ignition.IgnitionInput).OwnerNumber - 1];
        Assert.Equal((true, Idx(cb1, "input", 3, "State"), true), (vi.Enabled, vi.Var0, vi.Not0));
    }

    /// <summary>RANCHERO_COPY=&lt;a COPY of the operator's project&gt; [RANCHERO_OUT=&lt;dir&gt;]: migrate to 5.7 (PDM-02 stays the
    /// ignition main, everyone on sync id 0x6F1), check it, and write &lt;name&gt;.57.json + .57-report.txt (never point it at
    /// the operator's own file).</summary>
    [Fact]
    public void Ranchero_FromEnv_MigratesKeepingTheMain()
    {
        var path = Environment.GetEnvironmentVariable("RANCHERO_COPY");
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
        var opts = new JsonSerializerOptions { WriteIndented = true, PropertyNameCaseInsensitive = true };
        var cfg = JsonSerializer.Deserialize<ConfigFile>(File.ReadAllText(path), opts)!;
        var all = LoadProject(path);   // same file, devices set up as the app does
        var mods = all.OfType<IDeviceConfigurable>().ToList();
        Fw57Migration.Migrate(all, mods);
        var main = IgnitionMain.Current(all)!;
        Assert.Equal("PDM-02", main.Name);
        foreach (var d in mods.Where(d => IgnitionMain.Ign(d) is { Enabled: true }))
            Assert.Equal((d == main ? IgnitionRole.Main : IgnitionRole.Follower, 0x6F1, IgnitionSyncMode.Absolute), (IgnitionMain.Ign(d)!.Role, IgnitionMain.Ign(d)!.MainStateId, IgnitionMain.Ign(d)!.SyncMode));
        if (Environment.GetEnvironmentVariable("RANCHERO_OUT") is not { Length: > 0 } outDir) return;
        var name = Path.GetFileNameWithoutExtension(path);
        cfg.PdmDevices = [.. all.OfType<PdmDevice>().OrderBy(d => d.BaseId)];
        cfg.CanboardDevices = [.. all.OfType<CanboardDevice>().Where(d => d.GetType() == typeof(CanboardDevice)).OrderBy(d => d.BaseId)];
        File.WriteAllText(Path.Combine(outDir, name + ".57.json"), JsonSerializer.Serialize(cfg, opts));
        File.WriteAllLines(Path.Combine(outDir, name + ".57-report.txt"),
            mods.SelectMany(m => m.Migration!.Select(n => $"[{n.Level}] {n.Text}")));
    }
}
