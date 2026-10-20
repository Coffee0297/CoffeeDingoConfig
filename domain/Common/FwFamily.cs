using domain.Interfaces;
using domain.Models;

namespace domain.Common;

/// <summary>
/// Which firmware line a module runs. "fork" = the operator's dingoFW 5.x; "upstream" = the maintainer's dingoFW
/// (version major 0). Same boards, different param numbering, var map and status frames.
/// </summary>
public static class FwFamily
{
    public const string Fork = "fork";
    public const string Upstream = "upstream";

    /// <summary>The family a Version reply means: upstream dingoFW (0.x) and the fork line rebuilt on it (5.7 and later,
    /// firmware integration/all-features) share the upstream layout; fork 5.0-5.6 keep the fork's.</summary>
    public static string Of(int major, int minor) => major == 0 || major > 5 || (major == 5 && minor >= 7) ? Upstream : Fork;

    /// <summary>Status-frame currents in 0.1 A (fork, and the 5.7+ line); plain upstream 0.x sends whole amps.</summary>
    public static bool TenthAmps(IDeviceConfigurable d) => d.Family != Upstream || Firmware.Of(d.Version).Major != 0;

    /// <summary>The 5.7+ line (upstream layout, major != 0): every board runs behind the OpenBLT CAN bootloader (the PDM app is
    /// linked at 0x08004000, the CANBoard app at 0x08002000), so it updates over CAN.</summary>
    public static bool OwnLine(IDeviceConfigurable d) => d.Family == Upstream && Firmware.Of(d.Version).Major != 0;

    /// <summary>Does the module have param <paramref name="p"/>? Upstream: in the list it returned on Read (none
    /// while unknown). Fork: by its firmware version (<see cref="DeviceParameter.MinFirmware"/>).</summary>
    public static bool Has(IDeviceConfigurable d, DeviceParameter p) => d.Family == Upstream
        ? d.ParamSet.Contains(p.Index, p.SubIndex)
        : Firmware.Has(d.Version, p.MinFirmware);

    /// <summary>For the per-param read/write paths, which never filtered fork modules: only upstream is filtered.</summary>
    public static bool Sends(IDeviceConfigurable d, DeviceParameter p) =>
        d.Family != Upstream || d.ParamSet.Contains(p.Index, p.SubIndex);

    /// <summary>Is an upstream block there (any param at base..base+0xFF)? While the list is unknown,
    /// <paramref name="whenUnknown"/> (the board's stock upstream layout).</summary>
    public static bool HasBlock(IDeviceConfigurable d, int baseIndex, bool whenUnknown) =>
        d.ParamSet.Known ? d.ParamSet.HasBlock(baseIndex) : whenUnknown;
}

/// <summary>
/// The params an upstream-family module has, in its ReadAll order — the same order as its CheckCrc /
/// WriteAll CRC (CalcParamsCrc walks the param table, ReadAll sends it in table order).
/// </summary>
public class DeviceParamSet
{
    private List<(int Index, int SubIndex)>? _order;
    private HashSet<(int, int)> _set = [];

    /// <summary>The list is known (from a Read this session, or from the saved project).</summary>
    public bool Known => _order != null;
    /// <summary>Learned from the module itself this session. A saved list may be older firmware's: Apply needs this.</summary>
    public bool FromModule { get; private set; }
    public IReadOnlyList<(int Index, int SubIndex)> Order => _order ?? [];
    /// <summary>Wire values of the params this app has no model for, from the last full Read: a full WriteAll
    /// must send every param the module has, so these go back unchanged.</summary>
    public Dictionary<(int Index, int SubIndex), uint> Raw { get; private set; } = new();

    public bool Contains(int index, int sub) => _set.Contains((index, sub));
    public bool HasBlock(int baseIndex) => _set.Any(k => k.Item1 >= baseIndex && k.Item1 < baseIndex + 0x100);

    public void Learn(List<(int Index, int SubIndex)> order, Dictionary<(int Index, int SubIndex), uint> raw)
    {
        _order = order; _set = order.ToHashSet(); Raw = raw; FromModule = true;
    }
    /// <summary>Taken as the module's list without asking it (a project migrated to 5.7 offline): gives the layout,
    /// but Apply still waits for a Read.</summary>
    public void Assume(IEnumerable<(int Index, int SubIndex)> keys)
    {
        _order = keys.Distinct().ToList(); _set = _order.ToHashSet(); Raw = new(); FromModule = false;
    }
    public void Forget() { _order = null; _set = []; Raw = new(); FromModule = false; }
    /// <summary>The module reports another firmware version: its list may have changed, read it again before Apply.</summary>
    public void Stale() => FromModule = false;

    /// <summary>
    /// Compact form for the project file and the UI, in order: runs [firstIndex, indexCount, sub, sub, …] of
    /// consecutive indices that have the same subs (an upstream PDM is ~15 runs). null = unknown.
    /// </summary>
    public int[][]? Runs
    {
        get
        {
            if (_order is null) return null;
            var groups = new List<(int Index, List<int> Subs)>();
            foreach (var (i, s) in _order)
                if (groups.Count > 0 && groups[^1].Index == i) groups[^1].Subs.Add(s);
                else groups.Add((i, [s]));
            var runs = new List<(int First, int Count, List<int> Subs)>();
            foreach (var g in groups)
                if (runs.Count > 0 && runs[^1].First + runs[^1].Count == g.Index && runs[^1].Subs.SequenceEqual(g.Subs))
                    runs[^1] = (runs[^1].First, runs[^1].Count + 1, runs[^1].Subs);
                else runs.Add((g.Index, 1, g.Subs));
            return runs.Select(r => new[] { r.First, r.Count }.Concat(r.Subs).ToArray()).ToArray();
        }
        set
        {
            if (value is null) { Forget(); return; }
            var order = new List<(int, int)>();
            foreach (var r in value.Where(r => r.Length >= 2))
                for (var k = 0; k < r[1]; k++)
                    foreach (var s in r.Skip(2)) order.Add((r[0] + k, s));
            _order = order; _set = order.ToHashSet(); Raw = new(); FromModule = false;
        }
    }
}
