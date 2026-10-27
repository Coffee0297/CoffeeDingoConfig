using System.Text.RegularExpressions;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Enums;
using domain.Interfaces;
using domain.Models;
using static domain.Common.Fw57Migration;

namespace domain.Common;

/// <summary>
/// Moves the ignition main role to a CANBoard. On 5.7 a PDM main sends its state frame at base+36, past its 0x20 slot;
/// a CANBoard's (base+12) stays inside its own range. The CANBoard gets the old main's mode, limits and its four
/// signals: one of its own signals where the old main read it from the CANBoard over CAN, a copy of the old main's CAN
/// input otherwise, or a CAN input on the old main's status frame for a signal the old main works out itself. The old
/// main becomes a follower (its ignition roles still work, so its outputs keep theirs) and every follower listens to
/// the CANBoard's frame. Fails, changing nothing, when the crank interlock cannot be carried over.
/// </summary>
public static class IgnitionMain
{
    public record Result(bool Ok, string? Error, List<MigrationNote> Notes);
    public record SyncResult(string? Error, List<IDeviceConfigurable> Changed, List<string> Skipped);

    /// <summary>Firmware 5.7: give every other module whose ignition role is Follower the main's sync setting (sub 10 id
    /// or offset, sub 11 mode; offset mode: sub 12 = the main's base id). Nothing else is changed; a follower on older
    /// firmware (sub 10 = a state-frame id there) is skipped.</summary>
    public static SyncResult SyncFollowers(IReadOnlyCollection<IDevice> all, IDeviceConfigurable main)
    {
        if (Ign(main) is not { Role: IgnitionRole.Main } m) return new($"{main.Name} is not an ignition main module.", [], []);
        if (!Ignition.HasSync(main)) return new($"{main.Name} has no sync id setting (it needs firmware 5.7; Read it first).", [], []);
        var changed = new List<IDeviceConfigurable>();
        var skipped = new List<string>();
        foreach (var d in all.OfType<IDeviceConfigurable>().Where(d => d != main && Ign(d) is { Role: IgnitionRole.Follower }))
        {
            if (!Ignition.HasSync(d)) { skipped.Add(d.Name); continue; }
            var g = Ign(d)!;
            g.MainStateId = m.MainStateId;
            g.SyncMode = m.SyncMode;
            g.SyncBase = m.SyncMode == IgnitionSyncMode.BaseOffset ? main.BaseId : 0;   // as Save: a fixed id leaves no stale base (a diff to Apply)
            changed.Add(d);
        }
        return new(null, changed, skipped);
    }

    public static Ignition? Ign(IDevice d) => d switch { PdmDevice x => x.Ignition, CanboardDevice x => x.Ignition, _ => null };
    internal static List<VirtualInput> Vis(IDevice d) => d switch { PdmDevice x => x.VirtualInputs, CanboardDevice x => x.VirtualInputs, _ => [] };

    public static IDeviceConfigurable? Current(IReadOnlyCollection<IDevice> all) =>
        all.OfType<IDeviceConfigurable>().FirstOrDefault(d => Ign(d) is { Enabled: true, Role: IgnitionRole.Main });

    /// <summary>The CANBoard to offer: the one the main's ignition switch is wired to, else the first with the Ignition block.</summary>
    public static CanboardDevice? Suggest(IReadOnlyCollection<IDevice> all, IDeviceConfigurable main)
    {
        var cbs = all.OfType<CanboardDevice>().Where(c => c != main && IgnOffset(c) is not null).ToList();
        var v = Ign(main)?.IgnitionInput ?? 0;
        var ci = main.VarMap.FirstOrDefault(x => x.VariableIndex == v) is { OwnerKind: "caninput" } dv ? CanInputs(main)[dv.OwnerNumber - 1] : null;
        return cbs.FirstOrDefault(c => ci is not null && c.InIdRange(ci.Id)) ?? cbs.FirstOrDefault();
    }

    // a 1-bit status signal's var: DigitalInput3.State -> ("input", 3, "State"), VirtualInput12 -> ("virtualinput", 12, "State")
    private static readonly Regex SigBit = new(@"^(DigitalInput|Input|VirtualInput|Condition|CanInput|Flasher|Timer|DigitalOutput)(\d+)(\.State)?$");
    private static (string, int, string)? KeyOf(string sig)
    {
        var m = SigBit.Match(sig);
        if (!m.Success) return null;
        var kind = m.Groups[1].Value is "DigitalInput" or "Input" ? "input" : m.Groups[1].Value.ToLowerInvariant();
        return (kind, int.Parse(m.Groups[2].Value), kind == "condition" ? "Value" : "State");
    }

    private static int VarOf(IDeviceConfigurable d, string kind, int n, string prop = "State") =>
        d.VarMap.First(v => v.OwnerKind == kind && v.OwnerNumber == n && v.PropertyName == prop).VariableIndex;

    private static List<DeviceParameter> ParamsOf(IDeviceConfigurable d, CanInput c) => [.. d.Params.Where(p => p.Index == CanInput.BaseIndex + c.Number - 1)];

    // same frame and rule (every CAN input setting except its on/off)
    private static bool Same(IDeviceConfigurable da, CanInput a, IDeviceConfigurable db, CanInput b) =>
        ParamsOf(da, a).Where(p => p.SubIndex != 0).All(p => ParamsOf(db, b).FirstOrDefault(q => q.SubIndex == p.SubIndex) is { } q && Equals(q.GetValue(), p.GetValue()));

    /// <summary>A CAN input on the CANBoard set like <paramref name="src"/> (an identical one is reused); null when none is free.</summary>
    private static CanInput? CanInputLike(CanboardDevice cb, IDeviceConfigurable from, CanInput src)
    {
        if (cb.CanInputs.FirstOrDefault(c => c.Enabled && Same(from, src, cb, c)) is { } same) return same;
        if (cb.CanInputs.FirstOrDefault(c => !c.Enabled) is not { } slot) return null;
        var to = ParamsOf(cb, slot);
        foreach (var p in ParamsOf(from, src)) to.FirstOrDefault(q => q.SubIndex == p.SubIndex)?.SetValue(p.GetValue());
        slot.Enabled = true;
        slot.Name = src.Name;
        return slot;
    }

    /// <summary>Var on the CANBoard that gives the same on/off as var <paramref name="v"/> on the old main, with what was done;
    /// Var null when it cannot be carried over (Text says why).</summary>
    private static (int? Var, string Text) Carry(IDeviceConfigurable old, CanboardDevice cb, int v)
    {
        var dv = old.VarMap.FirstOrDefault(x => x.VariableIndex == v);
        if (dv is null) return (null, $"signal #{v} is not in {old.Name}'s list");
        var what = $"\"{Label(dv)}\"";
        if (dv is { OwnerKind: "caninput", PropertyName: "State" } && CanInputs(old).ElementAtOrDefault(dv.OwnerNumber - 1) is { Enabled: true } ci)
        {
            if (!ci.Ide && cb.InIdRange(ci.Id))
            {
                // it reads one of the CANBoard's own bits (a module never hears its own frames): use the signal itself
                var sig = Sigs(cb).FirstOrDefault(s => cb.BaseId + s.Off == ci.Id && s.Start == ci.StartBit && s.Len == 1 && ci.BitLength == 1);
                var cv = sig.Name is not null && KeyOf(sig.Name) is { } key ? cb.VarMap.FirstOrDefault(x => Key(x) == key) : null;
                bool on0 = RuleAt(ci, ci.Offset), on1 = RuleAt(ci, ci.Factor + ci.Offset);
                if (cv is null || ci.Mode != InputMode.Momentary || on0 == on1)
                    return (null, $"{what} reads {cb.Name}'s frame 0x{ci.Id:X3} in a way {cb.Name} cannot read itself");
                if (on1) return (cv.VariableIndex, $"{what} is {cb.Name}'s own {cv.OwnerKind} {cv.OwnerNumber} \"{Label(cv)}\"");
                if (NotVi(cb, cb.VirtualInputs, cv.VariableIndex) is not { } not)
                    return (null, $"{what} is NOT {cb.Name}'s {cv.OwnerKind} {cv.OwnerNumber} and {cb.Name} has no free virtual input for the NOT");
                return (VarOf(cb, "virtualinput", not.Number), $"{what} is {cb.Name}'s virtual input {not.Number} \"{not.Name}\"");
            }
            if (CanInputLike(cb, old, ci) is not { } c) return (null, $"{what} is a CAN input and {cb.Name} has no free CAN input");
            return (VarOf(cb, "caninput", c.Number), $"{what} is read by {cb.Name} CAN input {c.Number} (same frame and rule)");
        }
        // worked out on the old main: read it from the old main's status frames
        var bit = Sigs(old).FirstOrDefault(s => s.Len == 1 && KeyOf(s.Name) == Key(dv));
        if (bit.Name is null) return (null, $"{what} is worked out on {old.Name} and is not in its status frames");
        var id = old.BaseId + bit.Off;
        var slot = cb.CanInputs.FirstOrDefault(c => c.Enabled && !c.Ide && c.Id == id && c.StartBit == bit.Start && c.BitLength == 1
                && c.Operator == Operator.NotEqual && c.Operand == 0 && c.Factor == 1 && c.Offset == 0 && c.Mode == InputMode.Momentary)
            ?? cb.CanInputs.FirstOrDefault(c => !c.Enabled);
        if (slot is null) return (null, $"{what} needs a CAN input on {cb.Name} and none is free");
        if (!slot.Enabled)
        {
            // on while the bit is set; off when the old main goes quiet (timeout, 0)
            slot.Enabled = true; slot.Name = $"{old.Name} {dv.GetName?.Invoke() ?? bit.Name}"; slot.Ide = false; slot.Id = id; slot.StartBit = bit.Start; slot.BitLength = 1;
            slot.Factor = 1; slot.Offset = 0; slot.ByteOrder = ByteOrder.LittleEndian; slot.Signed = false; slot.Operator = Operator.NotEqual; slot.Operand = 0;
            slot.Mode = InputMode.Momentary; slot.TimeoutEnabled = true; slot.Timeout = 1000; slot.TimeoutValue = 0; slot.TimeoutUseValue = false;
        }
        return (VarOf(cb, "caninput", slot.Number), $"{what} is read from {old.Name}'s frame 0x{id:X3} bit {bit.Start} by {cb.Name} CAN input {slot.Number} (off if {old.Name} goes quiet)");
    }

    /// <summary>Make <paramref name="cb"/> the ignition main of the project <paramref name="all"/>. On failure nothing is
    /// changed; the caller restores a <see cref="ValuesSnapshot"/> taken before (CAN inputs / virtual inputs set up on the
    /// way are part of it).</summary>
    public static Result MoveTo(IReadOnlyCollection<IDevice> all, CanboardDevice cb)
    {
        var notes = new List<MigrationNote>();
        if (IgnOffset(cb) is not { } off) return new(false, $"{cb.Name} has no Ignition block (it needs firmware 5.6 or 5.7).", notes);
        var old = Current(all);
        if (old == cb) return new(false, $"{cb.Name} is already the ignition main.", notes);
        if (old is null) return new(false, "No module is the ignition main yet: set the ignition up first.", notes);
        var o = Ign(old)!;
        var fields = new (string Label, int Value, Action<int> Set, bool Interlock)[]
        {
            ("ignition switch", o.IgnitionInput, x => cb.Ignition.IgnitionInput = x, false),
            ("start button", o.StartInput, x => cb.Ignition.StartInput = x, false),
            ("crank allowed", o.CrankAllowInput, x => cb.Ignition.CrankAllowInput = x, true),
            ("engine running", o.RunningInput, x => cb.Ignition.RunningInput = x, false),
        };
        var got = new int[fields.Length];
        for (var i = 0; i < fields.Length; i++)
        {
            var f = fields[i];
            if (f.Value <= 0) continue;
            var (v, text) = Carry(old, cb, f.Value);
            if (v is { } x) { got[i] = x; notes.Add(new("info", $"{cb.Name} {f.Label}: {text}.")); continue; }
            var fix = $"Build it on {cb.Name} (or send it to {cb.Name} over CAN) and pick it on the Ignition page.";
            // never drop the crank interlock: the starter would turn with nothing holding it back
            if (f.Interlock) return new(false, $"The {f.Label} signal cannot move to {cb.Name}: {text}. {fix}", notes);
            notes.Add(new("warn", $"{cb.Name} {f.Label}: {text}; left unset. {fix}"));
        }

        var n = cb.Ignition;
        n.Enabled = true; n.Role = IgnitionRole.Main; n.Mode = o.Mode; n.MaxCrankMs = o.MaxCrankMs; n.CrankWhileHeld = o.CrankWhileHeld;
        n.DashHoldMs = o.DashHoldMs;
        // 5.7: the main keeps the car's sync id (followers listen to it, not to a frame of the main's own)
        var sync = Ignition.HasSync(cb);
        n.MainStateId = sync ? o.MainStateId : 0;
        if (sync) n.SyncMode = o.SyncMode;
        for (var i = 0; i < fields.Length; i++) fields[i].Set(got[i]);
        o.Role = IgnitionRole.Follower;
        o.IgnitionInput = o.StartInput = o.CrankAllowInput = o.RunningInput = 0;

        var id = cb.BaseId + off;
        var follow = all.OfType<IDeviceConfigurable>().Where(d => d != cb && Ign(d) is { Enabled: true, Role: IgnitionRole.Follower }).ToList();
        if (sync) SyncFollowers(all, cb);
        else foreach (var d in follow) Ign(d)!.MainStateId = id;
        var what = sync ? $"sync id {(n.SyncMode == IgnitionSyncMode.BaseOffset ? $"base + 0x{n.MainStateId:X}" : $"0x{n.MainStateId:X3}")}" : $"state frame 0x{id:X3}";
        notes.Insert(0, new("info", $"{cb.Name} is the ignition main ({what}); {old.Name} follows it and its outputs keep their ignition roles."));
        notes.Add(new("info", $"{follow.Count} follower(s) listen to the {what}: {string.Join(", ", follow.Select(d => d.Name))}."));

        // the migration reports' overlap warnings: say again only what is still true
        var mods = all.OfType<IDeviceConfigurable>().ToList();
        foreach (var d in mods) d.Migration?.RemoveAll(x => x.Text.StartsWith("CAN ids overlap"));
        var said = new HashSet<string>();
        foreach (var d in mods)
            foreach (var x in Overlaps(all, d).Where(x => said.Add(x.Text)))
            {
                d.Migration?.Add(x);
                notes.Add(x);
            }
        if (said.Count == 0) notes.Add(new("info", "No CAN id overlaps."));
        notes.Add(new("info", "Apply to car, then Store on the modules."));
        return new(true, null, notes);
    }
}

/// <summary>Every setting of every module (and the names / reports the app keeps beside them), to compare or put back.</summary>
public sealed class ValuesSnapshot
{
    private readonly List<(IDeviceConfigurable Dev, DeviceParameter P, object V)> _params;
    private readonly List<(Action<string> Set, string Name)> _names;   // CAN / virtual input names (not params)
    private readonly List<(IDeviceConfigurable Dev, List<MigrationNote>? Notes)> _reports;

    public ValuesSnapshot(IEnumerable<IDevice> all)
    {
        var mods = all.OfType<IDeviceConfigurable>().ToList();
        _params = [.. mods.SelectMany(d => d.Params.Select(p => (d, p, p.GetValue())))];
        _names = [.. mods.SelectMany(d => CanInputs(d).Select(c => ((Action<string>)(x => c.Name = x), c.Name))
            .Concat(IgnitionMain.Vis(d).Select(v => ((Action<string>)(x => v.Name = x), v.Name))))];
        _reports = [.. mods.Select(d => (d, d.Migration?.ToList()))];
    }

    /// <summary>"PDM-02 ignition.role: Main → Follower" for every setting that differs from the snapshot.</summary>
    public List<string> Changes() =>
        [.. _params.Where(x => !Equals(x.P.GetValue(), x.V)).Select(x => $"{x.Dev.Name} {x.P.Name}: {x.V} → {x.P.GetValue()}")];

    public void Restore()
    {
        foreach (var (_, p, v) in _params) if (!Equals(p.GetValue(), v)) p.SetValue(v);
        foreach (var (set, name) in _names) set(name);
        foreach (var (d, notes) in _reports) d.Migration = notes;
    }
}
