using System.Text.RegularExpressions;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Enums;
using domain.Interfaces;
using domain.Models;

namespace domain.Common;

/// <summary>One line of a migration report. Level "info" (changed as planned) or "warn" (check it / could not map).</summary>
public record MigrationNote(string Level, string Text, string? Fix = null);

/// <summary>
/// Carries a project made for fork 5.x modules over to the 5.7 line (firmware integration/all-features: upstream
/// numbering). Values stay on the function objects (both families' params read the same properties), so what moves is
/// what the numbering means: var-map bindings by (owner kind, number, property), Lua readVar(n), the timer's falling
/// edge, CAN-input timeout values, the calibrated rotary mode, other modules' CAN inputs reading this module's
/// frames, ignition followers' main id. Every change and every loss goes into the device's Migration report.
/// </summary>
public static class Fw57Migration
{
    // int params that hold a var-map index (output.input, math.inputA, virtualInput.var0, keypad valVar0, ...)
    private static readonly Regex BindingName = new(@"\.(\w*input|input[ab]|var\d|valvar\d|faultvar|dimmingvar)$", RegexOptions.IgnoreCase);
    public static bool IsBinding(DeviceParameter p) => p.ValueType == typeof(int) && BindingName.IsMatch(p.Name);

    /// <summary>The record holds a configuration (anything set outside the device block), so a 5.7 module must not
    /// simply get the module's values on the next Read: it is converted instead.</summary>
    public static bool Configured(IDeviceConfigurable d) =>
        d.Params.Any(p => p.Index >= 0x1000 && p.Name.EndsWith(".enabled") && p.GetValue() is true);

    private record Snapshot(IDeviceConfigurable Dev, List<DeviceVariable> Map, List<DeviceParameter> Params,
        List<(int Off, string Name, int Start, int Len)> Sigs, int IgnOff);

    internal static List<(int Off, string Name, int Start, int Len)> Sigs(IDeviceConfigurable d) =>
        [.. d.GetStatusSigs().Select(s => (s.MessageId - d.BaseId, s.Signal.Name, s.Signal.StartBit, s.Signal.Length))];

    internal static int? IgnOffset(IDeviceConfigurable d) => d switch
    {
        PdmDevice p => p.IgnitionStateOffset,
        CanboardDevice c => c.IgnitionStateOffset,
        _ => null,
    };

    /// <summary>Convert the fork-family <paramref name="targets"/> to the 5.7 layout; <paramref name="all"/> = every
    /// device of the project (their CAN inputs / ignition followers may point at a target's frames).</summary>
    public static void Migrate(IReadOnlyCollection<IDevice> all, IEnumerable<IDeviceConfigurable> targets)
    {
        var snaps = new List<Snapshot>();
        foreach (var d in targets.Where(t => t.Family == FwFamily.Fork && t is PdmDevice or CanboardDevice))
        {
            snaps.Add(new Snapshot(d, [.. d.VarMap], [.. d.Params], Sigs(d), IgnOffset(d) ?? 0));
            d.Migrate57Pending = false;
            d.UseFamily(FwFamily.Upstream, assumeAll: true);
            d.KeepValuesOnRead = true;
        }
        // a module converted now is no longer a 5.6 follower: drop that warning from the reports of mains converted before it
        foreach (var o in all.OfType<IDeviceConfigurable>())
            o.Migration?.RemoveAll(n => snaps.Any(s => n.Text.StartsWith($"{s.Dev.Name} ignition follower: stays on firmware 5.6")));
        foreach (var s in snaps)
        {
            var notes = new List<MigrationNote> { new("info", $"{s.Dev.Name}: converted to the firmware 5.7 layout ({s.Map.Count} → {s.Dev.VarMap.Count} signals).") };
            Convert(s, notes);
            s.Dev.Migration = notes;
        }
        foreach (var s in snaps) CrossModule(all, s);
        var said = new HashSet<string>();   // an overlap concerns two modules: say it once
        foreach (var s in snaps) s.Dev.Migration!.AddRange(Overlaps(all, s.Dev).Where(n => said.Add(n.Text)));
        // the default sync id may be a frame of a module of this car (e.g. a PDM at 0x6E0 sends 0x6E0..0x704): say so once
        if (snaps.Select(s => s.Dev).FirstOrDefault(d => IgnitionMain.Ign(d) is { Enabled: true }) is { } ig
            && all.Where(x => x is PdmDevice or CanboardDevice).FirstOrDefault(x => Ignition.DefaultSyncId >= x.BaseId && Ignition.DefaultSyncId <= x.BaseId + Span(x)) is { } hit)
            ig.Migration!.Add(new("warn", $"Ignition sync id 0x{Ignition.DefaultSyncId:X3} is one of {hit.Name}'s frames (0x{hit.BaseId:X3}..0x{hit.BaseId + Span(hit):X3}). Fix: on the Ignition page pick a free id (or an offset from the main module's base) and use it on all followers."));
        foreach (var s in snaps)
            s.Dev.Migration!.Add(new("info", $"{s.Dev.Name}: next, Read the module (it learns the module's list and keeps this project), then Apply to car and Store."));
    }

    private static void Convert(Snapshot s, List<MigrationNote> notes)
    {
        var d = s.Dev;
        Rebind(d, s.Map, s.Params, notes);
        if (d is PdmDevice p) RemapLua(p, s.Map, notes);
        var timers = d switch { PdmDevice x => x.Timers, CanboardDevice x => x.Timers, _ => [] };
        var vis = d switch { PdmDevice x => x.VirtualInputs, CanboardDevice x => x.VirtualInputs, _ => [] };
        foreach (var t in timers.Where(t => t.Enabled)) Timer(d, t, vis, notes);
        var conds = d switch { PdmDevice x => x.Conditions, CanboardDevice x => x.Conditions, _ => [] };
        foreach (var c in conds.Where(c => c.Enabled && c.ArgOff != c.Arg))
            notes.Add(c.HystBand > 0
                ? new("info", $"{d.Name} {c.Name}: hysteresis \"off again at {c.ArgOff}\" kept as a band of {c.HystBand}.")
                : new("warn", $"{d.Name} {c.Name}: hysteresis \"off again at {c.ArgOff}\" has no 5.7 equivalent with this operator (5.7 takes a band past the value); it is dropped. Check the condition."));
        foreach (var ci in CanInputs(d).Where(c => c.Enabled && c.TimeoutEnabled))
        {
            if (ci.TimeoutValue != 0 || RuleAt(ci, 0))
            {
                ci.TimeoutUseValue = true;
                notes.Add(new("info", $"{d.Name} {ci.Name}: on timeout it takes {ci.TimeoutValue} as before (\"use the timeout value\" turned on)."));
            }
        }
        // ignition: the role stays (the main stays the main); 5.7 syncs on its own id, every module of the car on the same one
        if (IgnitionMain.Ign(d) is { Enabled: true } ign)
        {
            ign.MainStateId = Ignition.DefaultSyncId; ign.SyncMode = IgnitionSyncMode.Absolute; ign.SyncBase = 0;
            notes.Add(new("info", ign.Role == IgnitionRole.Follower
                ? $"{d.Name} ignition follower: follows the sync frame on 0x{Ignition.DefaultSyncId:X3} (the default; every module of the car uses the same id)."
                : $"{d.Name} ignition {ign.Role.ToString().ToLowerInvariant()}: sends the sync frame on 0x{Ignition.DefaultSyncId:X3} (the default); its old state frame is now the ignition status."));
        }
        if (d is CanboardDevice cb)
            foreach (var a in cb.AnalogInputs.Where(a => a.Rotary.Enabled && a.Rotary.Mode != 1))
            {
                a.Rotary.Mode = 1;
                notes.Add(new("info", $"{d.Name} {a.Name}: rotary switch kept as calibrated positions ({a.Rotary.NumPos})."));
            }
        // settings that have no place in the 5.7 layout (by name; the timer edge is handled above)
        var now = d.Params.Select(x => x.Name).ToHashSet();
        foreach (var x in s.Params.Where(x => !now.Contains(x.Name) && !x.Name.EndsWith(".edge") && !x.Name.EndsWith(".argOff") && !x.WriteOnly && !Equals(x.GetValue(), x.DefaultValue)))
            notes.Add(new("warn", $"{d.Name}: setting {x.Name} = {x.GetValue()} does not exist on 5.7 and is not sent."));
    }

    // a CAN input's rule on value v (the fork pushed the timeout value through it)
    internal static bool RuleAt(CanInput c, double v) => c.Operator switch
    {
        Operator.Equal => v == c.Operand,
        Operator.NotEqual => v != c.Operand,
        Operator.GreaterThan => v > c.Operand,
        Operator.LessThan => v < c.Operand,
        Operator.GreaterThanOrEqual => v >= c.Operand,
        Operator.LessThanOrEqual => v <= c.Operand,
        Operator.BitwiseAnd => ((long)v & (long)c.Operand) != 0,
        Operator.BitwiseNand => ((long)v & (long)c.Operand) == 0,
        _ => false,
    };

    internal static List<CanInput> CanInputs(IDevice d) => d switch { PdmDevice x => x.CanInputs, CanboardDevice x => x.CanInputs, _ => [] };

    internal static (string, int, string) Key(DeviceVariable v) => (v.OwnerKind, v.OwnerNumber, v.PropertyName);
    internal static string Label(DeviceVariable v) => $"{v.GetName?.Invoke() ?? v.OwnerKind} {v.PropertyName}".Trim();

    /// <summary>Each binding param's var index from <paramref name="before"/> to the same signal in the device's current
    /// var map. A signal the new layout lacks becomes 0 (none) and is reported.</summary>
    public static void Rebind(IDeviceConfigurable d, List<DeviceVariable> before, IEnumerable<DeviceParameter> bindings, List<MigrationNote> notes, string fw = "5.7")
    {
        var now = d.VarMap.GroupBy(Key).ToDictionary(g => g.Key, g => g.First().VariableIndex);
        int moved = 0;
        foreach (var p in bindings.Where(IsBinding).DistinctBy(p => p.Name))
        {
            var v = (int)p.GetValue();
            if (v <= 0) continue;
            var old = before.FirstOrDefault(x => x.VariableIndex == v);
            if (old is null) { notes.Add(new("warn", $"{d.Name} {p.Name}: signal #{v} is not in the old layout; set to none.")); p.SetValue(0); continue; }
            if (!now.TryGetValue(Key(old), out var n))
            {
                notes.Add(new("warn", $"{d.Name} {p.Name}: \"{Label(old)}\" does not exist on {fw}; set to none. Pick another signal."));
                p.SetValue(0);
                continue;
            }
            if (n != v) { p.SetValue(n); moved++; }
        }
        if (moved > 0) notes.Add(new("info", $"{d.Name}: {moved} signal choice(s) renumbered to the {fw} list."));
    }

    private static readonly Regex ReadVar = new(@"readVar\s*\(\s*(\d+)\s*\)");

    internal static void RemapLua(PdmDevice p, List<DeviceVariable> before, List<MigrationNote> notes, string fw = "5.7")
    {
        if (string.IsNullOrWhiteSpace(p.LuaProgram)) return;
        var now = p.VarMap.GroupBy(Key).ToDictionary(g => g.Key, g => g.First().VariableIndex);
        int moved = 0;
        p.LuaProgram = ReadVar.Replace(p.LuaProgram, m =>
        {
            var v = int.Parse(m.Groups[1].Value);
            var old = before.FirstOrDefault(x => x.VariableIndex == v);
            if (old is null || !now.TryGetValue(Key(old), out var n))
            {
                notes.Add(new("warn", $"{p.Name} Lua: readVar({v}) has no {fw} signal; left as is. Fix the script."));
                return m.Value;
            }
            if (n != v) moved++;
            return $"readVar({n})";
        });
        if (moved > 0) notes.Add(new("info", $"{p.Name} Lua: {moved} readVar() number(s) renumbered."));
        var computed = Regex.Matches(p.LuaProgram, @"readVar\s*\(").Count - ReadVar.Matches(p.LuaProgram).Count;
        if (computed > 0)
        {
            // signals before the first one that moved keep their number: a name set to one of those is fine
            var same = before.Zip(p.VarMap).TakeWhile(x => Key(x.First) == Key(x.Second)).Count();
            notes.Add(new("warn", $"{p.Name} Lua: {computed} readVar() call(s) take a name, not a number (e.g. readVar(SHOW)). Signals #0–#{same - 1} keep their numbers on {fw}; check any name set to a number above {same - 1} against the {fw} signal list."));
        }
    }

    private static void Timer(IDeviceConfigurable d, TimerFunction t, List<VirtualInput> vis, List<MigrationNote> notes)
    {
        if (t.Preset > TimerFunction.UpstreamMaxMs)
        {
            notes.Add(new("warn", $"{d.Name} {t.Name}: {t.Preset / 1000.0} s is longer than 5.7's 600 s; set to 600 s."));
            t.Preset = TimerFunction.UpstreamMaxMs;
        }
        if (t.Mode == TimerMode.Pulse)
            notes.Add(new("info", $"{d.Name} {t.Name}: pulse mode is \"pulse, restarts on a new edge\" on 5.7."));
        if (t.Edge != InputEdge.Falling) return;
        // fork Falling = runs while the input is off. 5.7 runs on the input being on: put NOT in front.
        if (NotVi(d, vis, t.Input) is not { } free)
        {
            notes.Add(new("warn", $"{d.Name} {t.Name}: ran while its input was OFF; 5.7 timers run on the input being ON and no virtual input is free for a NOT. Add a NOT virtual input in front of it."));
            return;
        }
        t.Input = d.VarMap.First(m => m.OwnerKind == "virtualinput" && m.OwnerNumber == free.Number && m.PropertyName == "State").VariableIndex;
        t.Edge = InputEdge.Rising;
        notes.Add(new("info", $"{d.Name} {t.Name}: ran while its input was OFF; now fed by virtual input {free.Number} \"{free.Name}\" (NOT of the input)."));
    }

    /// <summary>Turn a free virtual input (off, empty, nothing reads it) into NOT <paramref name="input"/>; null when none is free.</summary>
    internal static VirtualInput? NotVi(IDeviceConfigurable d, List<VirtualInput> vis, int input)
    {
        var used = d.Params.Where(IsBinding).Select(p => (int)p.GetValue()).ToHashSet();
        var free = vis.FirstOrDefault(v => !v.Enabled && v.Var0 == 0 && v.Var1 == 0 && v.Var2 == 0
            && d.VarMap.FirstOrDefault(m => m.OwnerKind == "virtualinput" && m.OwnerNumber == v.Number) is { } mv && !used.Contains(mv.VariableIndex));
        if (free is null) return null;
        var src = d.VarMap.FirstOrDefault(m => m.VariableIndex == input);
        free.Enabled = true; free.Name = $"NOT {src?.GetName?.Invoke() ?? "input"}";
        free.Var0 = input; free.Not0 = true; free.Var1 = 0; free.Not1 = false; free.Cond0 = Conditional.Or; free.Var2 = 0; free.Mode = InputMode.Momentary;
        return free;
    }

    // other modules' CAN inputs that decode a target's status frames; a fork follower of a target main cannot follow it on 5.7
    private static void CrossModule(IReadOnlyCollection<IDevice> all, Snapshot s)
    {
        var a = s.Dev;
        var now = Sigs(a);
        foreach (var b in all.OfType<IDeviceConfigurable>().Where(b => b != a))
        {
            foreach (var c in CanInputs(b).Where(c => c.Enabled && !c.Ide && c.Id >= a.BaseId && c.Id <= a.BaseId + 40))
            {
                var off = c.Id - a.BaseId;
                var old = s.Sigs.FirstOrDefault(x => x.Off == off && x.Start == c.StartBit && x.Len == c.BitLength);
                if (old.Name is null) continue;   // not one of a's status signals (a bridge frame, another sender)
                var n = now.FirstOrDefault(x => x.Name == old.Name);
                if (n.Name is null) { a.Migration!.Add(new("warn", $"{b.Name} {c.Name}: reads {a.Name} {old.Name}, which 5.7 does not send. Re-pick it.")); continue; }
                if (n.Off == off && n.Start == c.StartBit && n.Len == c.BitLength) continue;
                c.Id = a.BaseId + n.Off; c.StartBit = n.Start; c.BitLength = n.Len;
                a.Migration!.Add(new("info", $"{b.Name} {c.Name}: reads {a.Name} {old.Name} at its 5.7 place (0x{c.Id:X3} bit {n.Start})."));
            }
            if (b.Family == FwFamily.Fork && IgnitionMain.Ign(b) is { Enabled: true, Role: IgnitionRole.Follower } ign && ign.MainStateId == a.BaseId + s.IgnOff)
                a.Migration!.Add(new("warn", $"{b.Name} ignition follower: stays on firmware 5.6, which cannot follow {a.Name}'s 5.7 sync frame. Flash {b.Name} with 5.7 and convert it too."));
        }
    }

    /// <summary>Highest id offset a module sends with its current settings (its range is base .. base + this).</summary>
    public static int Span(IDevice d) => d switch
    {
        PdmDevice p when p.Family == FwFamily.Upstream => new[]
        {
            p.PdmType == 2 ? 32 : 31,
            p.Outputs.Any(o => o.Enabled && o.ThermalTau > 0) ? p.UpstreamFrames().Wire ?? 0 : 0,
            p.Tables.Take(2).Any(t => t.Enabled) ? p.UpstreamFrames().Tables12 ?? 0 : 0,
            p.Tables.Skip(2).Take(2).Any(t => t.Enabled) ? p.UpstreamFrames().Tables34 ?? 0 : 0,
            p.Pids.Any(x => x.Enabled) ? p.UpstreamFrames().Pid ?? 0 : 0,
            IgnFrame(p) && p.Ignition.StatusId == 0 ? p.IgnitionStateOffset ?? 0 : 0,
        }.Max(),
        PdmDevice p => p.Ignition is { Enabled: true, Role: IgnitionRole.Main } ? 30 : 29,
        CanboardDevice c => Math.Max(IgnFrame(c) && c.Ignition.StatusId == 0 ? c.IgnitionStateOffset ?? 11 : 11,
            c.Family == FwFamily.Upstream && c.Pids.Any(x => x.Enabled) ? CanboardDevice.PidFrameOffset : 0),   // 5.7: PID frame + 13
        _ => 0,
    };

    // the module sends its ignition frame: a main (fork / 0.x state frame), or any role with the block on (5.7 status frame)
    public static bool IgnFrame(IDeviceConfigurable d) =>
        IgnitionMain.Ign(d) is { Enabled: true } g && (g.Role == IgnitionRole.Main || Ignition.HasSync(d));

    /// <summary>Modules whose id ranges overlap <paramref name="d"/>'s after the migration, with a fix.</summary>
    public static IEnumerable<MigrationNote> Overlaps(IReadOnlyCollection<IDevice> all, IDevice d)
    {
        var mods = all.Where(x => x is PdmDevice or CanboardDevice).OrderBy(x => x.BaseId).ToList();
        foreach (var o in mods.Where(o => o != d))
        {
            var (lo, hi) = d.BaseId < o.BaseId ? (d, o) : (o, d);
            var end = lo.BaseId + Span(lo);
            if (end < hi.BaseId) continue;
            var free = (end + 2 + 0xF) & ~0xF;
            var why = lo is PdmDevice p && p.Family == FwFamily.Upstream
                ? $"{lo.Name} sends up to 0x{end:X3} on 5.7 (wire load, tables, PID and ignition frames sit at base+32..+36)"
                : $"{lo.Name} sends up to 0x{end:X3}";
            // a fork / 0.x main's state frame is the one that sticks out: a CANBoard can take the role (its frame stays in
            // its range). Not on 5.7: every module with the ignition on sends its status frame, whatever its role.
            var cb = lo is not CanboardDevice && lo is IDeviceConfigurable lc && !Ignition.HasSync(lc) && IgnitionMain.Current(all) == lc && IgnOffset(lc) == Span(lo)
                ? IgnitionMain.Suggest(all, lc) : null;
            // 5.7: the highest frame is the ignition status on its slot, which can go out on its own id (sub 23)
            var st = lo is IDeviceConfigurable sc && Ignition.HasSync(sc) && IgnFrame(sc) && IgnitionMain.Ign(sc)!.StatusId == 0 && IgnOffset(sc) == Span(lo);
            yield return new("warn", $"CAN ids overlap: {why}, into {hi.Name}'s range from 0x{hi.BaseId:X3}. Fix: move {hi.Name} to 0x{free:X3} or higher (space PDMs 0x30 apart), "
                + (cb is null ? "" : $"or make {cb.Name} the ignition main, ") + (st ? $"or give {lo.Name}'s ignition status frame a free CAN id on the Ignition page, " : "")
                + "or turn off the feature that sends the highest frame.", cb is null ? null : $"ignition-main:{cb.Guid}");
        }
    }

    /// <summary>A Read after a migration learned the module's real list: move bindings from the assumed layout to it and
    /// report project settings the module does not have.</summary>
    public static void Relearned(IDeviceConfigurable d, List<DeviceVariable> before)
    {
        var notes = d.Migration ??= [];
        if (!before.Select(Key).SequenceEqual(d.VarMap.Select(Key)))
        {
            Rebind(d, before, d.Params, notes);
            if (d is PdmDevice p) RemapLua(p, before, notes);
        }
        foreach (var x in d.Params.Where(x => !d.ParamSet.Contains(x.Index, x.SubIndex) && !x.WriteOnly && !Equals(x.GetValue(), x.DefaultValue)))
            notes.Add(new("warn", $"{d.Name}: the module has no {x.Name} (set to {x.GetValue()} in the project); it is not sent."));
    }
}
