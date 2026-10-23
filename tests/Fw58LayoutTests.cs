using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using application.Models;
using domain.Common;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace tests;

/// <summary>
/// Firmware 5.8.0 (CoffeeDingoFW integration/groups) against 5.7.1 (integration/all-features): the var-map entries after
/// the timers are regrouped (core/device.cpp InitVarMap) and the calibrated rotary sends one centre per sub (16-25,
/// core/param_defs.h ANALOG_INPUT_CENTER). Sizes from the ELFs' pVarMap: dingopdm_v7 343, dingopdmmax_v1 311,
/// canboard_v2 122 (pt-dpdm4_1 321: the app models its analog inputs 3-4 as digital, so it has 317 on both lines).
/// </summary>
public class Fw58LayoutTests(ITestOutputHelper output)
{
    private static string Dir([CallerFilePath] string f = "") => Path.GetDirectoryName(f)!;
    private static readonly JsonSerializerOptions Opts = new() { PropertyNameCaseInsensitive = true };
    private static JsonElement Defs(string kind) => JsonDocument.Parse(File.ReadAllText(Path.Combine(Dir(), "..", "web", "pdm-definitions.json"))).RootElement.GetProperty(kind);
    private static ConcurrentDictionary<(int, int, int), DeviceCanFrame> Q() => new();
    private static byte[] Ver(int maj, int min, int build) => Fw57MigrationTests.Ver(maj, min, build);

    /// <summary>A module of <paramref name="board"/> that answered 5.<paramref name="minor"/>.0, with every param the app models.</summary>
    private static IDeviceConfigurable Board(string board, int minor)
    {
        var q = Q();
        IDeviceConfigurable d;
        if (board == "canboard_v2")
        {
            var c = new CanboardDevice(Defs("canboards")[0].Deserialize<CanboardDeviceDefinition>(Opts)!, "CB", 0x660);
            c.SetLogger(NullLogger<CanboardDevice>.Instance);
            c.Read(0x660, Ver(5, minor, 0), ref q, []);
            d = c;
        }
        else
        {
            var type = board switch { "dingopdm_v7" => 0, "dingopdmmax_v1" => 1, _ => 2 };
            var p = new PdmDevice(Defs("pdms").EnumerateArray().Select(e => e.Deserialize<PdmDeviceDefinition>(Opts)!).Single(x => x.PdmType == type), "PDM", 0x680);
            p.SetLogger(NullLogger<PdmDevice>.Instance);
            p.Read(0x680, Ver(5, minor, 0), ref q, []);
            d = p;
        }
        d.UseFamily(FwFamily.Upstream, assumeAll: true);
        return d;
    }

    // the firmware's InitVarMap groups after the timers
    private static string Group(DeviceVariable v) => (v.OwnerKind, v.PropertyName) switch
    {
        ("output", "Warning" or "Open Load") => "output-flags",
        ("output", "Undercurrent") => "undercurrent",
        ("output", "Wire Load") => "wire-load",
        ("input", "PWM Duty" or "PWM Frequency") => "di-pwm",
        ("analoginput", "Scaled Value") => "scaled",
        ("ignition", "Dash Shutdown") => "dash-shutdown",
        var (k, _) => k,
    };

    private static List<string> Tail(IDeviceConfigurable d)
    {
        var afterTimers = d.VarMap.SkipWhile(v => v.OwnerKind != "timer").SkipWhile(v => v.OwnerKind == "timer").Select(Group).ToList();
        return [.. afterTimers.Where((g, i) => i == 0 || afterTimers[i - 1] != g)];
    }

    private static List<(string, int, string)> Keys(IDeviceConfigurable d) => [.. d.VarMap.Select(v => (v.OwnerKind, v.OwnerNumber, v.PropertyName))];

    [Theory]
    [InlineData("dingopdm_v7", 343)]
    [InlineData("dingopdmmax_v1", 311)]
    [InlineData("pt-dpdm4_1", 317)]
    [InlineData("canboard_v2", 122)]
    public void VarMap_57And58_FirmwareOrder_SameSize(string board, int size)
    {
        var a = Board(board, 7);
        var b = Board(board, 8);
        Assert.False(a.Layout58);
        Assert.True(b.Layout58);
        Assert.Equal(size, a.VarMap.Count);
        Assert.Equal(size, b.VarMap.Count);
        Assert.Equal(Enumerable.Range(0, size), b.VarMap.Select(v => v.VariableIndex));
        // same signals, same place up to the last timer
        Assert.Equal(Keys(a).Order(), Keys(b).Order());
        var timersEnd = Keys(a).FindLastIndex(k => k.Item1 == "timer");
        Assert.Equal(Keys(a).Take(timersEnd + 1), Keys(b).Take(timersEnd + 1));
        if (board == "canboard_v2")
        {
            Assert.Equal(["di-pwm", "scaled", "math", "ignition", "comfortblink", "pid", "dash-shutdown"], Tail(a));
            Assert.Equal(["math", "comfortblink", "pid", "scaled", "di-pwm", "ignition", "dash-shutdown"], Tail(b));
        }
        else
        {
            Assert.Equal(["di-pwm", "math", "table", "ignition", "comfortblink", "pid", "curve", "latchgate", "output-flags", "undercurrent", "wire-load", "lua", "dash-shutdown"], Tail(a));
            Assert.Equal(["math", "comfortblink", "curve", "latchgate", "output-flags", "undercurrent", "wire-load", "pid", "table", "di-pwm", "ignition", "dash-shutdown", "lua"], Tail(b));
        }
    }

    [Fact]
    public void Pdm_v7_58_Indices()
    {
        var d = Board("dingopdm_v7", 8);
        (string, int, string) At(int i) => (d.VarMap[i].OwnerKind, d.VarMap[i].OwnerNumber, d.VarMap[i].PropertyName);
        Assert.Equal(("timer", 8, "State"), At(224));
        Assert.Equal(("math", 1, "Value"), At(225));
        Assert.Equal(("comfortblink", 1, "Left"), At(233));
        Assert.Equal(("curve", 1, "Value"), At(235));
        Assert.Equal(("latchgate", 1, "Value"), At(239));
        Assert.Equal(("output", 1, "Warning"), At(247));
        Assert.Equal(("output", 1, "Undercurrent"), At(263));
        Assert.Equal(("output", 1, "Wire Load"), At(271));
        Assert.Equal(("pid", 1, "Output"), At(279));
        Assert.Equal(("table", 1, "Value"), At(295));
        Assert.Equal(("input", 1, "PWM Duty"), At(299));
        Assert.Equal(("ignition", 1, "Ignition"), At(303));
        Assert.Equal(("ignition", 1, "Dash Shutdown"), At(310));
        Assert.Equal(("lua", 1, "Value"), At(311));
        Assert.Equal(("lua", 32, "Value"), At(342));
    }

    // ---- calibrated rotary ------------------------------------------------------------------------

    [Fact]
    public void CalibratedRotary_57Packed_58OneCentrePerSub()
    {
        var a = (CanboardDevice)Board("canboard_v2", 7);
        var b = (CanboardDevice)Board("canboard_v2", 8);
        int[] pts = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
        a.AnalogInputs[0].Rotary.Points = [.. pts];
        b.AnalogInputs[0].Rotary.Points = [.. pts];
        var pa = a.Params.Where(p => p.Index == AnalogInput.BaseIndex && p.SubIndex >= 16).OrderBy(p => p.SubIndex).ToList();
        var pb = b.Params.Where(p => p.Index == AnalogInput.BaseIndex && p.SubIndex >= 16).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(16, 5), pa.Select(p => p.SubIndex));
        Assert.Equal(Enumerable.Range(0, 5).Select(k => pts[2 * k] | (pts[2 * k + 1] << 16)), pa.Select(p => (int)p.GetValue()));
        Assert.Equal(Enumerable.Range(16, 10), pb.Select(p => p.SubIndex));
        Assert.Equal(pts, pb.Select(p => (int)p.GetValue()));
        pb[3].SetValue(2222);   // a Read lands in the same project data
        Assert.Equal(2222, b.AnalogInputs[0].Rotary.Points[3]);
    }

    // ---- conversion -------------------------------------------------------------------------------

    // every var-map reference the firmware stores (param_defs.h: max VAR_MAP_SIZE - 1), by block base and sub
    private static readonly (int Index, int Sub)[] FirmwareRefs =
    [
        (0x0000, 7), (0x0000, 8), (0x0000, 12), (0x0000, 13), (0x1000, 1), (0x1000, 11), (0x1000, 22), (0x1400, 2), (0x1400, 5), (0x1400, 8),
        (0x1500, 1), (0x1600, 1), (0x1600, 2), (0x1600, 3), (0x1700, 1), (0x1800, 1), (0x1900, 2), (0x1900, 3), (0x1900, 4), (0x1900, 5),
        (0x1900, 6), (0x1900, 7), (0x1900, 9), (0x1900, 10), (0x1A00, 1), (0x1A00, 2), (0x1B00, 1), (0x1B00, 2), (0x1C00, 2), (0x1C00, 3),
        (0x1D00, 1), (0x1E00, 3), (0x1E00, 4), (0x1E00, 5), (0x1E00, 6), (0x1E00, 13), (0x1E00, 20), (0x1F00, 1), (0x1F00, 2), (0x1F00, 3),
        (0x2000, 1), (0x2000, 12), (0x2100, 1), (0x2100, 5), (0x2300, 1), (0x2300, 2), (0x2300, 3), (0x2300, 5), (0x2400, 1), (0x2600, 2),
        (0x2600, 3), (0x3000, 8), (0x3100, 7), (0x3100, 8), (0x3100, 9), (0x3100, 10), (0x3100, 11),
    ];

    [Theory]
    [InlineData("dingopdm_v7")]
    [InlineData("canboard_v2")]
    public void EveryFirmwareVarReference_IsABindingTheConversionMoves(string board)
    {
        var d = Board(board, 8);
        var refs = FirmwareRefs.ToHashSet();
        var missed = d.Params.Where(p => refs.Contains((p.Index & 0xFF00, p.SubIndex)) && !Fw57Migration.IsBinding(p)).Select(p => p.Name).ToList();
        Assert.True(missed.Count == 0, string.Join(", ", missed));
    }

    /// <summary>For each module: binding param name -> the signal it points at.</summary>
    private static Dictionary<IDeviceConfigurable, Dictionary<string, (string, int, string)>> Refs(IEnumerable<IDeviceConfigurable> mods) =>
        mods.ToDictionary(m => m, m => m.Params.Where(Fw57Migration.IsBinding).DistinctBy(p => p.Name).Where(p => (int)p.GetValue() > 0)
            .ToDictionary(p => p.Name, p => m.VarMap.Single(v => v.VariableIndex == (int)p.GetValue()) is var v ? (v.OwnerKind, v.OwnerNumber, v.PropertyName) : default));

    /// <summary>Each module answers 5.8.0: the project converts. Returns how many references moved per module.</summary>
    private static Dictionary<IDeviceConfigurable, int> ConvertAndCheck(List<IDeviceConfigurable> mods, out Dictionary<IDeviceConfigurable, Dictionary<string, (string, int, string)>> before)
    {
        before = Refs(mods);
        var idx = mods.ToDictionary(m => m, m => m.Params.Where(Fw57Migration.IsBinding).DistinctBy(p => p.Name).ToDictionary(p => p.Name, p => (int)p.GetValue()));
        foreach (var m in mods)
        {
            Assert.False(m.Layout58);
            var q = Q();
            m.Read(m.BaseId, Ver(5, 8, 0), ref q, []);
            Assert.True(m.Layout58);
            Assert.Contains(m.Migration!, n => n.Text.Contains("firmware 5.8 layout"));
        }
        var after = Refs(mods);
        var moved = new Dictionary<IDeviceConfigurable, int>();
        foreach (var m in mods)
        {
            Assert.Equal(before[m], after[m]);   // same (owner kind, number, property) for every stored reference
            moved[m] = idx[m].Count(kv => (int)m.Params.First(p => p.Name == kv.Key).GetValue() != kv.Value);
        }
        return moved;
    }

    /// <summary>A 5.7 PDM and CANBoard with a reference to every kind of signal that moves on 5.8, saved and loaded
    /// like a project file.</summary>
    [Fact]
    public void Convert_Synthetic57Project_EveryReferenceKeepsItsSignal()
    {
        var p = (PdmDevice)Board("dingopdm_v7", 7);
        var c = (CanboardDevice)Board("canboard_v2", 7);
        int I(IDeviceConfigurable d, string k, int n, string prop) => Fw57MigrationTests.Idx(d, k, n, prop);
        p.Outputs[0].Input = I(p, "math", 2, "Value");
        p.Outputs[1].Input = I(p, "comfortblink", 1, "Right");
        p.Outputs[2].Input = I(p, "ignition", 1, "Accessory");
        p.Outputs[3].Input = I(p, "lua", 3, "Value");
        p.Outputs[4].Input = I(p, "timer", 2, "State");                 // before the tail: stays
        p.Outputs[5].Input = I(p, "output", 3, "Undercurrent");
        p.Outputs[6].Input = I(p, "ignition", 1, "Dash Shutdown");
        p.Outputs[7].Input = I(p, "input", 2, "PWM Frequency");
        p.Maths[0].InputA = I(p, "table", 1, "Value"); p.Maths[0].InputB = I(p, "pid", 2, "I");
        p.Curves[0].Input = I(p, "latchgate", 4, "Value");
        p.LatchGates[0].Input = I(p, "curve", 2, "Value");
        p.VirtualInputs[0].Var0 = I(p, "output", 8, "Wire Load"); p.VirtualInputs[0].Var1 = I(p, "output", 1, "Open Load");
        p.Conditions[0].Input = I(p, "pid", 4, "Output");
        p.Counters[0].IncInput = I(p, "math", 8, "Value");
        p.CanOutputs[0].Input = I(p, "table", 4, "Value");
        p.Flashers[0].Input = I(p, "comfortblink", 1, "Left");
        p.MuteTxInput = I(p, "ignition", 1, "Running");
        p.ShedInput = I(p, "output", 2, "Warning");
        p.ComfortBlink.LeftInput = I(p, "input", 1, "PWM Duty");
        c.DigitalOutputs[0].Input = I(c, "pid", 2, "D");
        c.VirtualInputs[0].Var0 = I(c, "analoginput", 3, "Scaled Value");
        c.Conditions[0].Input = I(c, "input", 8, "PWM Duty");
        c.CanOutputs[0].Input = I(c, "ignition", 1, "Dash Shutdown");
        c.Maths[0].InputA = I(c, "comfortblink", 1, "Right");
        c.MuteTxInput = I(c, "math", 4, "Value");

        // through a project file, as the operator's project is
        var json = JsonSerializer.Serialize(new ConfigFile { PdmDevices = [p], CanboardDevices = [c] });
        Assert.DoesNotContain("layout58", json);   // a 5.7 project file is unchanged
        var mods = Fw57MigrationTests.LoadProjectJson(json).OfType<IDeviceConfigurable>().ToList();
        var moved = ConvertAndCheck(mods, out var before);
        Assert.All(mods, m => Assert.DoesNotContain(m.Migration!, n => n.Level == "warn"));
        Assert.Equal(33, before.Values.Sum(b => b.Count));   // 26 set here + each PID's activate input (default: always on)
        Assert.Equal(20, moved[mods[0]]);   // all but the timer and the PIDs' "always on"
        Assert.Equal(5, moved[mods[1]]);    // the CANBoard's Dash Shutdown is last on both (121)

        // saved as 5.8: reloads on the 5.8 layout, nothing moves again
        var json58 = JsonSerializer.Serialize(new ConfigFile { PdmDevices = [(PdmDevice)mods[0]], CanboardDevices = [(CanboardDevice)mods[1]] });
        var again = Fw57MigrationTests.LoadProjectJson(json58).OfType<IDeviceConfigurable>().ToList();
        Assert.All(again, m => Assert.True(m.Layout58));
        Assert.Equal(Refs(mods).Values.Select(r => r.OrderBy(x => x.Key).ToList()), Refs(again).Values.Select(r => r.OrderBy(x => x.Key).ToList()));
        var q = Q();
        again[0].Read(again[0].BaseId, Ver(5, 8, 1), ref q, []);
        Assert.Contains(again[0].Migration!, n => n.Text.Contains("firmware 5.8 layout"));   // the report it was saved with
        Assert.Equal(Refs(mods)[mods[0]], Refs(again)[again[0]]);   // 5.8.1 is the same layout: nothing moved
    }

    [Fact]
    public void Convert_LuaReadVar_LiteralRenumbered_NamedFlagged()
    {
        var p = (PdmDevice)Board("dingopdm_v7", 7);
        var math1 = Fw57MigrationTests.Idx(p, "math", 1, "Value");
        p.LuaProgram = $"local a = readVar({math1})\nlocal b = readVar(SHOW)\nlocal c = readVar(3)";
        var q = Q();
        p.Read(p.BaseId, Ver(5, 8, 0), ref q, []);
        Assert.NotEqual(math1, Fw57MigrationTests.Idx(p, "math", 1, "Value"));
        Assert.Contains($"readVar({Fw57MigrationTests.Idx(p, "math", 1, "Value")})", p.LuaProgram);
        Assert.Contains("readVar(3)", p.LuaProgram);
        Assert.Contains(p.Migration!, n => n.Level == "warn" && n.Text.Contains("take a name"));
    }

    /// <summary>FW58_FIXTURE=&lt;a COPY of a 5.7 project&gt; [FW58_REPORT=&lt;file&gt;]: convert it as each module answers 5.8.0 and
    /// check every stored reference (never point this at the operator's own file; it only reads it).</summary>
    [Fact]
    public void Convert_ProjectFromEnv_EveryReferenceKeepsItsSignal()
    {
        var path = Environment.GetEnvironmentVariable("FW58_FIXTURE");
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
        var mods = Fw57MigrationTests.LoadProject(path).OfType<IDeviceConfigurable>().Where(m => m.Family == FwFamily.Upstream).ToList();
        var moved = ConvertAndCheck(mods, out var before);
        var lines = mods.Select(m => $"{m.Name}: {before[m].Count} references, {moved[m]} renumbered, "
                + (m is PdmDevice pd && pd.LuaProgram.Contains("readVar") ? "Lua uses readVar: check by hand" : "no Lua readVar"))
            .Concat(mods.SelectMany(m => m.Migration!.Select(n => $"  [{n.Level}] {n.Text}"))).ToList();
        foreach (var l in lines) output.WriteLine(l);
        if (Environment.GetEnvironmentVariable("FW58_REPORT") is { Length: > 0 } outp) File.WriteAllLines(outp, lines);
    }
}
