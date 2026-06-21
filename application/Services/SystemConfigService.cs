using System.Text.Json;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging;

namespace application.Services;

/// <summary>
/// Declarative, self-describing config surface for the WHOLE system — built for AI agents.
/// Everything a module exposes lives in <see cref="IDeviceConfigurable.Params"/>, so this
/// service reflects over that list and needs no per-setting code: new firmware params show up
/// automatically.
///
///   GET schema   -> every device + every setting (name, type, default, enum options) + var-map
///   GET snapshot -> current values of every setting (after a Read), plus optional Lua
///   POST apply   -> a (full or partial) target document; coerces + writes only what differs,
///                   optionally burns, uploads Lua. Returns a per-setting report.
///
/// The param Name (e.g. "device.sleepTimeoutMs", "output1.currentLimit") is the stable key an
/// agent uses; it never has to know CAN indices.
/// </summary>
public class SystemConfigService(DeviceManager devices, ILogger<SystemConfigService> logger)
{
    // ---- SCHEMA: what can be configured -------------------------------------------------
    public object BuildSchema()
    {
        var list = new List<object>();
        foreach (var d in devices.GetAllDevices())
        {
            if (d is not IDeviceConfigurable cfg) continue;
            list.Add(new
            {
                guid = d.Guid.ToString(),
                name = d.Name,
                type = d.Type,
                baseId = d.BaseId,
                connected = d.Connected,
                @params = cfg.Params.Select(p => new
                {
                    name = p.Name,
                    index = p.Index,
                    sub = p.SubIndex,
                    type = TypeName(p.ValueType),
                    @default = Jsonable(p.DefaultValue),
                    options = p.ValueType.IsEnum ? Enum.GetNames(p.ValueType) : null
                }).ToArray(),
                varMap = cfg.VarMap.Select(v => new { index = v.VariableIndex, name = SafeName(v) }).ToArray(),
                lua = HasLua(d)
            });
        }
        return new { devices = list };
    }

    // ---- TEMPLATE: a ready-to-edit apply doc with every setting at its default ----------
    public object BuildTemplate()
    {
        // Use a real PDM from the project if there is one (so enum options/var-map match the
        // user's firmware), otherwise synthesise a stock module just to enumerate its params.
        var pdm = devices.GetDevicesByType<domain.Devices.dingoPdm.PdmDevice>().FirstOrDefault()
                  ?? new domain.Devices.dingoPdm.PdmDevice("PDM-template", 0xDE00);

        var pars = new Dictionary<string, object?>();
        foreach (var p in pdm.Params) pars[p.Name] = Jsonable(p.DefaultValue);

        const string sampleLua =
            "-- Lua runs every tick on the module. Drive an output from Lua by writing its\n" +
            "-- Lua slot with setLuaOut(slot, value), then set that output's Rule input to\n" +
            "-- \"Lua Out <slot+1>\". Read any var-map signal with readVar(index).\n" +
            "function onTick()\n" +
            "  local trig = readVar(1) ~= 0   -- 1 = first digital input; see varMap in /api/config/schema\n" +
            "  setLuaOut(0, trig and 1 or 0)  -- drives the output whose Rule = \"Lua Out 1\"\n" +
            "end\n" +
            "setTickRate(50)\n";

        return new
        {
            _readme = new[]
            {
                "dingoPDM config template — every PDM setting at its default value.",
                "Import in the UI (Project ▸ Import JSON…) or via MCP apply_config.",
                "Match each device by 'name', 'baseId' (decimal) or 'guid'. Edit name/baseId to target a real module.",
                "Keep only the params you want to change and delete the rest — apply writes only what differs.",
                "'burn': false stages to RAM without writing flash; set true (or omit) to persist.",
                "Labels: output[N].name (and similar) are stored in the project file only, not on the device.",
                "Cross-module: a module broadcasts its var-map signals on CAN; another module reads them via " +
                "canInput[N] (set canInput[N].sid to the SOURCE module's base id), then uses that signal in a " +
                "condition[N] or virtualInput[N], which can drive output[N].input. See varMap names in /api/config/schema.",
                "Lua: put the program in the device-level 'lua' field (see the example below)."
            },
            burn = false,
            devices = new[]
            {
                new { name = pdm.Name, baseId = pdm.BaseId, @params = pars, lua = sampleLua }
            }
        };
    }

    // ---- SNAPSHOT: current values -------------------------------------------------------
    public async Task<object> BuildSnapshotAsync(bool includeLua)
    {
        var list = new List<object>();
        foreach (var d in devices.GetAllDevices())
        {
            if (d is not IDeviceConfigurable cfg) continue;
            var ps = new Dictionary<string, object?>();
            foreach (var p in cfg.Params) ps[p.Name] = Jsonable(p.GetValue());
            string? lua = null;
            if (includeLua && HasLua(d)) { try { lua = await devices.ReadLua(d.Guid); } catch { lua = null; } }
            list.Add(new { guid = d.Guid.ToString(), name = d.Name, type = d.Type, baseId = d.BaseId, connected = d.Connected, @params = ps, lua });
        }
        return new { devices = list };
    }

    // ---- APPLY: write a target document -------------------------------------------------
    public record ApplyReport(int DevicesTouched, int ParamsChanged, List<string> Notes, List<string> Errors);

    public ApplyReport Apply(JsonElement doc)
    {
        var notes = new List<string>();
        var errors = new List<string>();
        int devTouched = 0, totalChanged = 0;
        bool burnGlobal = !doc.TryGetProperty("burn", out var bg) || bg.ValueKind != JsonValueKind.False;

        if (!doc.TryGetProperty("devices", out var devsEl) || devsEl.ValueKind != JsonValueKind.Array)
            return new ApplyReport(0, 0, notes, new List<string> { "document has no 'devices' array" });

        foreach (var devEl in devsEl.EnumerateArray())
        {
            var dev = MatchDevice(devEl);
            if (dev is not IDeviceConfigurable cfg)
            {
                errors.Add($"no device matched {devEl.GetRawText()}");
                continue;
            }
            int changed = 0;

            if (devEl.TryGetProperty("params", out var pEl) && pEl.ValueKind == JsonValueKind.Object)
            {
                var byName = cfg.Params.ToDictionary(p => p.Name, StringComparer.OrdinalIgnoreCase);
                var toWrite = new List<DeviceParameter>();
                foreach (var kv in pEl.EnumerateObject())
                {
                    if (!byName.TryGetValue(kv.Name, out var param)) { errors.Add($"{dev.Name}: unknown setting '{kv.Name}'"); continue; }
                    if (string.Equals(param.Name, "device.baseId", StringComparison.OrdinalIgnoreCase))
                    { notes.Add($"{dev.Name}: skipped device.baseId — change base ID via /modify, not config apply"); continue; }
                    try
                    {
                        var coerced = Coerce(param.ValueType, kv.Value);
                        var before = param.GetValue();
                        if (Equals(before, coerced)) continue;   // no change -> don't write
                        param.SetValue(coerced);
                        toWrite.Add(param);
                        changed++;
                    }
                    catch (Exception ex) { errors.Add($"{dev.Name}.{kv.Name}: {ex.Message}"); }
                }
                if (toWrite.Count > 0) devices.WriteParamObjects(dev.Guid, toWrite);
            }

            if (devEl.TryGetProperty("lua", out var luaEl) && luaEl.ValueKind == JsonValueKind.String)
            {
                if (!HasLua(dev)) errors.Add($"{dev.Name}: device has no Lua support");
                else { devices.UploadLua(dev.Guid, luaEl.GetString() ?? ""); notes.Add($"{dev.Name}: Lua uploaded"); changed++; }
            }

            if (changed > 0)
            {
                devTouched++; totalChanged += changed;
                bool burnThis = devEl.TryGetProperty("burn", out var bl) ? bl.ValueKind != JsonValueKind.False : burnGlobal;
                if (burnThis) { devices.BurnSettings(dev.Guid); notes.Add($"{dev.Name}: burned"); }
            }
        }
        logger.LogInformation("Config apply: {Dev} device(s), {N} change(s), {E} error(s)", devTouched, totalChanged, errors.Count);
        return new ApplyReport(devTouched, totalChanged, notes, errors);
    }

    // ---- helpers ------------------------------------------------------------------------
    private IDevice? MatchDevice(JsonElement el)
    {
        var all = devices.GetAllDevices().ToList();
        if (el.TryGetProperty("guid", out var g) && g.ValueKind == JsonValueKind.String && Guid.TryParse(g.GetString(), out var guid))
        { var d = all.FirstOrDefault(x => x.Guid == guid); if (d != null) return d; }
        if (el.TryGetProperty("baseId", out var b) && b.ValueKind == JsonValueKind.Number)
        { var d = all.FirstOrDefault(x => x.BaseId == b.GetInt32()); if (d != null) return d; }
        if (el.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String)
        { var d = all.FirstOrDefault(x => string.Equals(x.Name, n.GetString(), StringComparison.OrdinalIgnoreCase)); if (d != null) return d; }
        return null;
    }

    private static bool HasLua(IDevice d) => d is domain.Devices.dingoPdm.PdmDevice;

    private static string SafeName(DeviceVariable v) { try { return v.GetName?.Invoke() ?? v.PropertyName; } catch { return v.PropertyName; } }

    private static string TypeName(Type t) =>
        t == typeof(bool) ? "bool" :
        t.IsEnum ? "enum" :
        t == typeof(double) || t == typeof(float) ? "float" :
        t == typeof(string) ? "string" :
        "int";

    // Box the EXACT type each DeviceParameter.SetValue hard-casts to.
    private static object Coerce(Type t, JsonElement v)
    {
        if (t == typeof(bool))
            return v.ValueKind switch
            {
                JsonValueKind.True => true, JsonValueKind.False => false,
                JsonValueKind.Number => v.GetInt32() != 0,
                JsonValueKind.String => bool.Parse(v.GetString()!),
                _ => throw new FormatException("expected bool")
            };
        if (t.IsEnum)
            return v.ValueKind == JsonValueKind.String ? Enum.Parse(t, v.GetString()!, true) : Enum.ToObject(t, v.GetInt32());
        if (t == typeof(double)) return v.GetDouble();
        if (t == typeof(float)) return v.GetSingle();
        if (t == typeof(int)) return v.GetInt32();
        if (t == typeof(uint)) return v.GetUInt32();
        if (t == typeof(short)) return (short)v.GetInt32();
        if (t == typeof(ushort)) return (ushort)v.GetInt32();
        if (t == typeof(byte)) return (byte)v.GetInt32();
        if (t == typeof(long)) return v.GetInt64();
        if (t == typeof(string)) return v.GetString()!;
        return Convert.ChangeType(v.ToString(), t);
    }

    private static object? Jsonable(object? v)
    {
        if (v == null) return null;
        if (v is Enum e) return e.ToString();
        return v;
    }
}
