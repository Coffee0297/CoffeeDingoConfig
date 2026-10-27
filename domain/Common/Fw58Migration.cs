using domain.Devices.dingoPdm;
using domain.Interfaces;

namespace domain.Common;

/// <summary>
/// Firmware 5.8 regrouped the var-map entries after the timers (math, comfort blink, curves, latch/gate, output
/// signals, PID, tables, analog scaled, DI PWM, ignition + DashShutdown, Lua) and sends each calibrated rotary centre
/// on its own sub (16-25). Params, frames and sizes are as 5.7's. Converting moves every stored signal number to the
/// same signal (owner kind, number, property) in the other layout; the report lands on the device (Migration).
/// </summary>
public static class Fw58Migration
{
    /// <summary>Does firmware <paramref name="major"/>.<paramref name="minor"/> use the 5.8 layout?</summary>
    public static bool Is58(int major, int minor) => major > 5 || (major == 5 && minor >= 8);

    /// <summary>Switch <paramref name="d"/> (upstream family) to the 5.8 layout (<paramref name="to58"/>) or back to 5.7's,
    /// renumbering its signal choices and literal Lua readVar(n). The module's param list is read again before Apply.</summary>
    public static void Convert(IDeviceConfigurable d, bool to58)
    {
        var fw = to58 ? "5.8" : "5.7";
        var before = d.VarMap.ToList();
        d.UseLayout58(to58);
        var notes = new List<MigrationNote> { new("info", $"{d.Name}: converted to the firmware {fw} layout ({before.Count} → {d.VarMap.Count} signals).") };
        Fw57Migration.Rebind(d, before, d.Params, notes, fw);
        if (d is PdmDevice p) Fw57Migration.RemapLua(p, before, notes, fw);
        d.ParamSet.Stale();
        d.KeepValuesOnRead = true;   // a flash to another CONFIG_VERSION reset the module: the next Read keeps the project
        notes.Add(new("info", $"{d.Name}: next, Read the module (it learns the module's list and keeps this project), then Apply to car and Store."));
        d.Migration = notes;
    }
}
