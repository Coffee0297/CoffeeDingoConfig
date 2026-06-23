using System.Text;
using System.Text.Json;

namespace web.Api;

// ============================================================================
//  dingoPDM MCP server (single source of truth, hosted inside the .NET app).
//
//  Transport:  Streamable-HTTP JSON-RPC 2.0 at  POST /mcp
//  Discovery:  GET /mcp        -> health/handshake summary
//              GET /mcp/info   -> full catalog + copy-paste client config (UI)
//              GET /mcp/skills  + /mcp/skills/{id} -> guided playbooks (UI)
//
//  Every tool maps declaratively to one of the app's own /api/* endpoints and
//  is executed via an in-process HTTP loopback, so it reuses the exact same
//  validation, bounds checks and "honest write" notify behaviour as the SPA.
//  Non-2xx responses surface as MCP isError:true (no false success).
//
//  The Node script mcp/dingo-mcp.mjs is now a thin stdio<->/mcp bridge.
// ============================================================================
public sealed record McpCall(HttpMethod Method, string Path, HttpContent? Content);
public sealed record McpTool(string Name, string Description, JsonElement Schema, Func<JsonElement, McpCall> Build);
public sealed record McpSkill(string Id, string Title, string Summary, string Markdown);

public static class McpServer
{
    const string ProtocolVersion = "2024-11-05";
    const string ServerName = "dingopdm";
    static readonly string ServerVersion =
        System.Reflection.Assembly.GetEntryAssembly()?.GetName().Version is { } v
            ? $"{v.Major}.{v.Minor}.{v.Build}"
            : "0.0.0";

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    // Absolute path to the stdio bridge, resolved once at startup. Clients launched
    // outside the repo (e.g. a user-global config) run `node` from their own cwd, so a
    // relative path breaks ("Connection closed"). We emit the resolved absolute path.
    static string _bridgeScript = @"C:\path\to\CoffeeDingoConfig\mcp\dingo-mcp.mjs";

    static string ResolveBridgeScript(string contentRoot)
    {
        try
        {
            for (var dir = new DirectoryInfo(contentRoot); dir is not null; dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, "mcp", "dingo-mcp.mjs");
                if (File.Exists(candidate)) return candidate;
            }
        }
        catch { /* fall through to placeholder */ }
        return _bridgeScript;
    }

    // Collapse the user's home directory to a portable token so the DISPLAYED path never shows a
    // username (screenshot/share safe). The real absolute path is emitted separately for copy.
    static string MaskHome(string p)
    {
        try
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(home) && p.StartsWith(home, StringComparison.OrdinalIgnoreCase))
                return (OperatingSystem.IsWindows() ? "%USERPROFILE%" : "$HOME") + p.Substring(home.Length);
        }
        catch { /* show the raw path if home can't be resolved */ }
        return p;
    }

    const string Instructions =
        "dingoPDM controls Coffee Dingo CAN-bus power-distribution modules over a serial CAN link. " +
        "Typical flow: list_adapters -> connect -> discover/list_devices -> read_device -> inspect/change " +
        "outputs/params/signals -> burn to persist. Writes are queued and acknowledged by the device; a " +
        "tool result with isError:true means the operation did NOT complete. Start with the prompts/skills " +
        "(connect-and-discover, configure-a-module, wire-outputs-safely, signals-and-logic, lua-programming, " +
        "cross-module-signals, cross-module-functions, can-addressing, flash-firmware, keypad-sdo, " +
        "logs-and-troubleshooting) for guided playbooks — read lua-programming before writing any device Lua.";

    // ----------------------------------------------------------------- routing
    public static void MapMcp(this WebApplication app)
    {
        _bridgeScript = ResolveBridgeScript(app.Environment.ContentRootPath);

        app.MapPost("/mcp", HandlePost);

        app.MapGet("/mcp", () => Results.Json(new
        {
            name = ServerName,
            version = ServerVersion,
            protocolVersion = ProtocolVersion,
            transport = "streamable-http",
            endpoint = "/mcp",
            tools = Tools.Count,
            skills = Skills.Count,
            hint = "POST JSON-RPC 2.0 here: initialize, ping, tools/list, tools/call, prompts/list, prompts/get."
        }));

        app.MapGet("/mcp/info", (HttpRequest req) => Results.Json(BuildInfo(req)));

        app.MapGet("/mcp/skills", () =>
            Results.Json(Skills.Select(s => new { id = s.Id, title = s.Title, summary = s.Summary })));

        app.MapGet("/mcp/skills/{id}", (string id) =>
        {
            var s = Skills.FirstOrDefault(x => x.Id == id);
            return s is null
                ? Results.NotFound(new { error = "unknown skill", id })
                : Results.Json(new { id = s.Id, title = s.Title, summary = s.Summary, markdown = s.Markdown });
        });
    }

    static object BuildInfo(HttpRequest req)
    {
        var origin = $"{req.Scheme}://{req.Host}";
        // Build the stdio client config for a given bridge path. We emit two: the real absolute
        // path (used by the UI's Copy button so it works when pasted on this machine) and a
        // home-masked one for on-screen display, so a screenshot never leaks the operator's username.
        object StdioCfg(string path) => new
        {
            mcpServers = new
            {
                dingopdm = new
                {
                    type = "stdio",
                    command = "node",
                    args = new[] { path },
                    env = new Dictionary<string, string> { ["DINGO_URL"] = origin }
                }
            }
        };
        return new
        {
            name = ServerName,
            version = ServerVersion,
            protocolVersion = ProtocolVersion,
            transport = "streamable-http",
            httpEndpoint = $"{origin}/mcp",
            instructions = Instructions,
            // Copy-paste client configs. HTTP is preferred (no script, no path);
            // the stdio bridge is a fallback for stdio-only clients and needs an
            // absolute path because the client launches `node` from its own cwd.
            httpConfig = new { mcpServers = new { dingopdm = new { type = "http", url = $"{origin}/mcp" } } },
            stdioConfig = StdioCfg(_bridgeScript),                  // real absolute path — used by Copy
            stdioConfigDisplay = StdioCfg(MaskHome(_bridgeScript)), // home-masked — shown on screen
            tools = Tools.Select(t => new { name = t.Name, description = t.Description }),
            skills = Skills.Select(s => new { id = s.Id, title = s.Title, summary = s.Summary })
        };
    }

    // ------------------------------------------------------------- JSON-RPC pump
    static async Task<IResult> HandlePost(HttpRequest req)
    {
        JsonElement root;
        try
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            root = doc.RootElement.Clone();
        }
        catch (Exception e)
        {
            return Results.Json(Error(null, -32700, "parse error: " + e.Message));
        }

        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("method", out var mEl))
            return Results.Json(Error(null, -32600, "invalid request"));

        var method = mEl.GetString();
        var hasId = root.TryGetProperty("id", out var idEl);
        object? id = hasId ? JsonId(idEl) : null;
        var baseUrl = $"{req.Scheme}://{req.Host}";

        switch (method)
        {
            case "initialize":
                return Ok(id, new
                {
                    protocolVersion = ProtocolVersion,
                    capabilities = new { tools = new { }, prompts = new { } },
                    serverInfo = new { name = ServerName, version = ServerVersion },
                    instructions = Instructions
                });

            case "ping":
                return Ok(id, new { });

            case "notifications/initialized":
            case "notifications/cancelled":
                return Results.StatusCode(202);

            case "tools/list":
                return Ok(id, new
                {
                    tools = Tools.Select(t => new { name = t.Name, description = t.Description, inputSchema = t.Schema })
                });

            case "tools/call":
                return await CallTool(id, root, baseUrl);

            case "prompts/list":
                return Ok(id, new
                {
                    prompts = Skills.Select(s => new { name = s.Id, description = s.Summary, arguments = Array.Empty<object>() })
                });

            case "prompts/get":
                return GetPrompt(id, root);

            default:
                return hasId
                    ? Results.Json(Error(id, -32601, $"method not found: {method}"))
                    : Results.StatusCode(202);
        }
    }

    static async Task<IResult> CallTool(object? id, JsonElement root, string baseUrl)
    {
        if (!root.TryGetProperty("params", out var p) || !p.TryGetProperty("name", out var nEl))
            return Results.Json(Error(id, -32602, "missing params.name"));

        var name = nEl.GetString();
        var args = p.TryGetProperty("arguments", out var a) ? a : default;
        var tool = Tools.FirstOrDefault(t => t.Name == name);
        if (tool is null) return Results.Json(Error(id, -32602, $"unknown tool: {name}"));

        try
        {
            var call = tool.Build(args);
            using var msg = new HttpRequestMessage(call.Method, baseUrl + call.Path) { Content = call.Content };
            using var resp = await Http.SendAsync(msg);
            var text = await resp.Content.ReadAsStringAsync();

            if (!resp.IsSuccessStatusCode)
                return Ok(id, ToolText($"Error: HTTP {(int)resp.StatusCode} from {call.Path}\n{text}", isError: true));

            return Ok(id, ToolText(string.IsNullOrWhiteSpace(text) ? "(ok, no content)" : text));
        }
        catch (Exception e)
        {
            return Ok(id, ToolText("Error: " + e.Message, isError: true));
        }
    }

    static IResult GetPrompt(object? id, JsonElement root)
    {
        if (!root.TryGetProperty("params", out var p) || !p.TryGetProperty("name", out var nEl))
            return Results.Json(Error(id, -32602, "missing params.name"));

        var skill = Skills.FirstOrDefault(s => s.Id == nEl.GetString());
        if (skill is null) return Results.Json(Error(id, -32602, $"unknown prompt: {nEl.GetString()}"));

        return Ok(id, new
        {
            description = skill.Summary,
            messages = new[]
            {
                new { role = "user", content = new { type = "text", text = skill.Markdown } }
            }
        });
    }

    // ---------------------------------------------------------------- helpers
    static object ToolText(string text, bool isError = false) =>
        new { content = new[] { new { type = "text", text } }, isError };

    static IResult Ok(object? id, object result) => Results.Json(new { jsonrpc = "2.0", id, result });
    static object Error(object? id, int code, string message) =>
        new { jsonrpc = "2.0", id, error = new { code, message } };

    static object? JsonId(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Number => e.GetInt64(),
        JsonValueKind.String => e.GetString(),
        _ => null
    };

    static bool Has(JsonElement a, string k, out JsonElement v)
    {
        v = default;
        return a.ValueKind == JsonValueKind.Object && a.TryGetProperty(k, out v) && v.ValueKind != JsonValueKind.Null;
    }
    static string Str(JsonElement a, string k) =>
        Has(a, k, out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText())
                             : throw new ArgumentException($"missing required argument '{k}'");
    static string StrOpt(JsonElement a, string k, string def = "") =>
        Has(a, k, out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText()) : def;
    static long Num(JsonElement a, string k) =>
        Has(a, k, out var v) ? (v.ValueKind == JsonValueKind.Number ? v.GetInt64() : long.Parse(v.GetString()!))
                             : throw new ArgumentException($"missing required argument '{k}'");
    static long NumOpt(JsonElement a, string k, long def) =>
        Has(a, k, out var v) ? (v.ValueKind == JsonValueKind.Number ? v.GetInt64() : long.Parse(v.GetString()!)) : def;
    static JsonElement ObjArg(JsonElement a, string k) =>
        Has(a, k, out var v) ? v : throw new ArgumentException($"missing required object argument '{k}'");

    static HttpContent Json(object o) => new StringContent(JsonSerializer.Serialize(o), Encoding.UTF8, "application/json");
    static HttpContent JsonRaw(JsonElement e) => new StringContent(e.GetRawText(), Encoding.UTF8, "application/json");
    static HttpContent TextBody(string s) => new StringContent(s, Encoding.UTF8, "text/plain");

    static string Q(JsonElement a, params string[] keys)
    {
        var parts = new List<string>();
        foreach (var k in keys)
            if (Has(a, k, out var v))
                parts.Add($"{k}={Uri.EscapeDataString(v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText())}");
        return parts.Count == 0 ? "" : "?" + string.Join("&", parts);
    }

    static JsonElement Schema(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    static readonly HttpMethod GET = HttpMethod.Get;
    static readonly HttpMethod POST = HttpMethod.Post;

    // ================================================================ CATALOG
    public static readonly List<McpTool> Tools = new()
    {
        // -------- connection ------------------------------------------------
        new("list_adapters", "List available CAN adapters/serial ports and current connection state.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/adapters", null)),

        new("connect", "Open the CAN link. Bitrate is a string like '500K'.",
            Schema("""{"type":"object","properties":{"adapter":{"type":"string","description":"USB | PCAN | SocketCAN | Sim"},"port":{"type":"string","description":"e.g. COM3"},"bitrate":{"type":"string","enum":["1000K","500K","250K","125K","100K"]}},"required":["adapter","port","bitrate"]}"""),
            a => new(POST, "/api/connect", Json(new { Adapter = Str(a, "adapter"), Port = Str(a, "port"), Bitrate = Str(a, "bitrate") }))),

        new("disconnect", "Close the CAN link.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(POST, "/api/disconnect", null)),

        new("discover", "Auto-discover modules broadcasting on the bus and bind them.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/discover", null)),

        new("identify", "Identify modules currently seen on the bus (no bind).",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/identify", null)),

        new("probe", "Probe a single module at a given base ID.",
            Schema("""{"type":"object","properties":{"base":{"type":"integer","description":"module base CAN id"}},"required":["base"]}"""),
            a => new(POST, "/api/probe", Json(new { Base = Str(a, "base") }))),

        new("raw_log", "Read recent raw CAN frames, optionally filtered by id.",
            Schema("""{"type":"object","properties":{"id":{"type":"integer"},"count":{"type":"integer"}}}"""),
            a => new(GET, "/api/rawlog" + Q(a, "id", "count"), null)),

        // -------- devices ---------------------------------------------------
        new("list_devices", "List bound devices with telemetry and output state.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/devices", null)),

        new("add_device", "Add/bind a device by type, name and base ID.",
            Schema("""{"type":"object","properties":{"type":{"type":"string","description":"Device type string sent to the backend. One of: pdm (a dingoPDM module), canboard, dbcdevice, blinkkeypad-PKP-2400, grayhillkeypad. Use pdm for a Coffee Dingo PDM."},"name":{"type":"string"},"baseId":{"type":"integer","description":"Base CAN id, decimal (e.g. 222) or 0x-hex string (e.g. 0x0DE)."}},"required":["type","baseId"]}"""),
            a => new(POST, "/api/devices", Json(new { Type = Str(a, "type"), Name = StrOpt(a, "name"), BaseId = Str(a, "baseId") }))),

        new("remove_device", "Remove a bound device.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/remove", null)),

        new("rename_device", "Rename a device.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"name":{"type":"string"}},"required":["guid","name"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/rename", Json(new { Name = Str(a, "name") }))),

        new("modify_device", "Change a device's name and/or base ID.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"name":{"type":"string"},"baseId":{"type":"integer"}},"required":["guid","name","baseId"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/modify", Json(new { Name = Str(a, "name"), BaseId = Str(a, "baseId") }))),

        new("read_device", "Read the full live config from a device (CRC-verified).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/read", null)),

        new("device_action", "Run a lifecycle action: read, write, writeall, burn, sleep, wakeup, bootloader, or uploadlua (push the Lua stored on the record — e.g. from an offline deploy_cross_module — to the now-live module; pair with writeall to also push output bindings).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"action":{"type":"string","enum":["read","write","writeall","burn","sleep","wakeup","bootloader","uploadlua"]}},"required":["guid","action"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/{Str(a, "action")}", null)),

        new("apply_profile", "Copy another device's profile onto this device (Source = source device guid).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"source":{"type":"string","description":"source device guid"}},"required":["guid","source"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/apply-profile", Json(new { Source = Str(a, "source") }))),

        // -------- config ----------------------------------------------------
        new("get_schema", "Get the config JSON schema (device types and fields).",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/config/schema", null)),

        new("get_template", "Get an empty config template.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/config/template", null)),

        new("get_frame_map", "Get the address-agnostic CAN broadcast frame map for every device type (dingoPDM, dingoPDM-Max, PT-DPDM, CANBoard): which CAN ID offset and which bits carry each transmitted signal — rotary switches, digital/analog inputs, output state & current, CAN/virtual inputs, counters, conditions, keypads, etc. Each cyclic message N is at 'baseId + 2 + N'. Reference doc; needs no connection or bound device.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/can-frame-map.md", null)),

        new("get_definitions", "Device hardware catalog per model (from pdm-definitions.json): channel counts (outputs, digital/analog inputs, CAN/virtual inputs, flashers, counters, conditions, keypads) and per-output current ratings. Use it to learn what a model has before add_device — no connection needed.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/definitions", null)),

        new("get_config", "Get the current full project config (optionally include Lua).",
            Schema("""{"type":"object","properties":{"lua":{"type":"boolean"}}}"""),
            a => new(GET, "/api/config" + Q(a, "lua"), null)),

        new("apply_config", "Apply a full config object (writes only what differs; burn to persist). Pass the config under 'config'.",
            Schema("""{"type":"object","properties":{"config":{"type":"object"}},"required":["config"]}"""),
            a => new(POST, "/api/config", JsonRaw(ObjArg(a, "config")))),

        // -------- outputs ---------------------------------------------------
        new("set_output", "Set one output's current limit (live).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"number":{"type":"integer"},"currentLimit":{"type":"number"}},"required":["guid","number","currentLimit"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/output", Json(new { Number = Num(a, "number"), CurrentLimit = NumOpt(a, "currentLimit", 0) }))),

        new("set_output_config", "Write a full output configuration. Pass an OutputConfigReq object under 'config' (Number, Enabled, Input, CurrentLimit, InrushLimit, InrushTime, ResetMode, ResetTime, ResetCountLimit, PwmEnabled, Freq, FixedDuty, MinDuty, SoftStart, SoftStartRamp, ...).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"config":{"type":"object"}},"required":["guid","config"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/outputconfig", JsonRaw(ObjArg(a, "config")))),

        new("get_overloads", "Get latched overload state for a device's outputs.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/overloads", null)),

        new("clear_overloads", "Clear latched overloads on a device.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/overloads/clear", null)),

        // -------- raw params ------------------------------------------------
        new("read_param", "Read a raw parameter (Index 0..0xFFFF, Sub 0..0xFF).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"index":{"type":"integer"},"sub":{"type":"integer"}},"required":["guid","index","sub"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/readparam", Json(new { Index = Num(a, "index"), Sub = Num(a, "sub") }))),

        new("write_param", "Write a raw parameter (Index 0..0xFFFF, Sub 0..0xFF, unsigned Value). Burn to persist.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"index":{"type":"integer"},"sub":{"type":"integer"},"value":{"type":"integer"}},"required":["guid","index","sub","value"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/writeparam", Json(new { Index = Num(a, "index"), Sub = Num(a, "sub"), Value = Num(a, "value") }))),

        // -------- signals & logic ------------------------------------------
        new("get_inputs", "List a device's logic inputs (optionally filter by type).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"type":{"type":"string"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/inputs" + Q(a, "type"), null)),

        new("get_functions", "List a device's configured functions.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/functions", null)),

        new("set_function", "Set a function. kind/number identify the slot; pass the function params object under 'params'.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"kind":{"type":"string"},"number":{"type":"integer"},"params":{"type":"object"}},"required":["guid","kind","number","params"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/function/{Str(a, "kind")}/{Num(a, "number")}", JsonRaw(ObjArg(a, "params")))),

        new("broadcast_signals", "List the cyclic signals a module BROADCASTS on CAN (its frame map): per signal — name, byte offset from base, startBit, bitLength, factor, byteOrder, signed, unit, and kind (bool|value). Set inUse=true to return only signals whose function is enabled (exactly what the cross-module picker shows). Feed a chosen name to link_remote_signal. Needs no live device.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"inUse":{"type":"boolean","description":"only signals actually configured/enabled on the source"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/broadcast-signals" + Q(a, "inUse"), null)),

        new("link_remote_signal", "Cross-module IO picker: point a CONSUMER module's CAN input at a SOURCE module's broadcast signal (e.g. PDM-01 reads CB-1's 'RotarySwitch4.Pos'). guid = consumer; sourceGuid = the broadcasting module; canInput = consumer CAN-input slot (1-based); signal = exact name from broadcast_signals. Resolves the source's current CAN id + bit layout and writes the consumer's CAN input. Re-run after changing the source's base ID; burn to persist.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string","description":"consumer device guid"},"canInput":{"type":"integer","description":"consumer CAN-input slot, 1-based"},"sourceGuid":{"type":"string","description":"source (broadcasting) device guid"},"signal":{"type":"string","description":"signal name from broadcast_signals"}},"required":["guid","canInput","sourceGuid","signal"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/link-remote", Json(new { CanInput = Num(a, "canInput"), SourceGuid = Str(a, "sourceGuid"), Signal = Str(a, "signal") }))),

        new("deploy_cross_module", "Compile + deploy cross-module functions: each reads a TRIGGER signal on one module and drives TARGET outputs on others, with optional synchronised blink (a clock master, plus an optional failover backup that takes over if the master goes quiet). Pass 'functions' = array of { name, blink, blinkRateMs, trigger:{guid, varIndex}, targets:[{guid, output}], clockMaster?, clockBackup? }. varIndex comes from get_inputs on the trigger module. The backend compiles per-module Lua + binds each target output to its Lua slot. It SAVES to each module's record (persists in the project JSON) and pushes over CAN to whichever modules are live now — offline modules return written:false; push them later with device_action 'uploadlua' (+ 'writeall' for the bindings) when they connect, or just re-deploy. Targets must be PDMs (Lua engine) — for a CANBoard target use link_remote_signal. Set preview=true to get the compiled Lua back WITHOUT deploying. Burn each module to persist to flash. See the cross-module-functions skill.",
            Schema("""{"type":"object","properties":{"functions":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"blink":{"type":"boolean"},"blinkRateMs":{"type":"integer"},"trigger":{"type":"object","properties":{"guid":{"type":"string"},"varIndex":{"type":"integer"}},"required":["guid","varIndex"]},"targets":{"type":"array","items":{"type":"object","properties":{"guid":{"type":"string"},"output":{"type":"integer"}},"required":["guid","output"]}},"clockMaster":{"type":"string"},"clockBackup":{"type":"string"}},"required":["trigger","targets"]}},"preview":{"type":"boolean","description":"compile only and return the Lua, don't deploy"}},"required":["functions"]}"""),
            a => new(POST, "/api/system/cross-module/deploy", JsonRaw(a))),

        new("get_signals", "List a device's signals.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/signals", null)),

        new("get_dbc_signals", "List a device's DBC-decoded signals.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/dbc/signals", null)),

        new("open_dbc", "Load a DBC database for a device. Provide 'text' (raw .dbc) or 'path' (server-local file).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"text":{"type":"string"},"path":{"type":"string"}},"required":["guid"]}"""),
            a =>
            {
                var dbc = Has(a, "text", out _) ? Str(a, "text")
                        : Has(a, "path", out _) ? File.ReadAllText(Str(a, "path"))
                        : throw new ArgumentException("provide 'text' or 'path'");
                return new(POST, $"/api/devices/{Str(a, "guid")}/dbc/open", TextBody(dbc));
            }),

        new("set_dbc_signal", "Map/update a DBC signal for a device. Pass the DbcSignal object under 'signal'.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"signal":{"type":"object"}},"required":["guid","signal"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/dbc/signal", JsonRaw(ObjArg(a, "signal")))),

        // -------- lua -------------------------------------------------------
        new("get_lua", "Get a device's Lua script.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/lua", null)),

        new("set_lua", "Save a Lua program to a device (source = script text). Stored on the device record (persists in the project JSON, offline-safe) and pushed over CAN when the module is live; returns 'written' (true=pushed, false=saved offline — push later with device_action 'uploadlua'). Read the lua-programming skill first for the on-device API.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"source":{"type":"string"}},"required":["guid","source"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/lua", Json(new { Source = Str(a, "source") }))),

        new("get_lua_error", "Get the last Lua error for a device.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(GET, $"/api/devices/{Str(a, "guid")}/luaerror", null)),

        // -------- firmware --------------------------------------------------
        new("flash_firmware", "Flash a firmware binary to a device. 'path' is a server-local file; its bytes are uploaded.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"path":{"type":"string"}},"required":["guid","path"]}"""),
            a =>
            {
                var bytes = File.ReadAllBytes(Str(a, "path"));
                var c = new ByteArrayContent(bytes);
                c.Headers.ContentType = new("application/octet-stream");
                return new(POST, $"/api/devices/{Str(a, "guid")}/flash", c);
            }),

        new("flash_status", "Poll the current firmware-flash progress/result.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/flash/status", null)),

        new("scan_dfu", "Scan USB for modules in DFU mode (runs dfu-util -l). Returns whether dfu-util is present, how many boards are in DFU, and the raw listing — run before flash_blank so it isn't blind.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/flash/dfu", null)),

        new("flash_blank", "Flash a BLANK / new module already in USB DFU (BOOT0 + reset) — no CAN bus or bound device needed. 'path' is a server-local .bin whose bytes are written via dfu-util. Use scan_dfu first to confirm a board is in DFU. Destructive — only when the operator intends it.",
            Schema("""{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}"""),
            a =>
            {
                var bytes = File.ReadAllBytes(Str(a, "path"));
                var c = new ByteArrayContent(bytes);
                c.Headers.ContentType = new("application/octet-stream");
                return new(POST, "/api/flash/blank", c);
            }),

        // -------- keypad / SDO ---------------------------------------------
        new("sdo_read", "CANopen SDO read (Node 1..127).",
            Schema("""{"type":"object","properties":{"node":{"type":"integer"},"index":{"type":"integer"},"sub":{"type":"integer"}},"required":["node","index","sub"]}"""),
            a => new(POST, "/api/sdo/read", Json(new { Node = Num(a, "node"), Index = Num(a, "index"), Sub = Num(a, "sub") }))),

        new("sdo_write", "CANopen SDO write (Node 1..127, Size 1/2/4 bytes).",
            Schema("""{"type":"object","properties":{"node":{"type":"integer"},"index":{"type":"integer"},"sub":{"type":"integer"},"value":{"type":"integer"},"size":{"type":"integer","enum":[1,2,4]}},"required":["node","index","sub","value","size"]}"""),
            a => new(POST, "/api/sdo/write", Json(new { Node = Num(a, "node"), Index = Num(a, "index"), Sub = Num(a, "sub"), Value = Num(a, "value"), Size = Num(a, "size") }))),

        new("sdo_store", "CANopen SDO store-parameters (persist) on a node.",
            Schema("""{"type":"object","properties":{"node":{"type":"integer"}},"required":["node"]}"""),
            a => new(POST, "/api/sdo/store", Json(new { Node = Num(a, "node") }))),

        // -------- project ---------------------------------------------------
        new("get_project", "Get current project metadata.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/project", null)),

        new("project_new", "Start a new empty project.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(POST, "/api/project/new", null)),

        new("project_open", "Open a project file by name (server-local).",
            Schema("""{"type":"object","properties":{"fileName":{"type":"string"}},"required":["fileName"]}"""),
            a => new(POST, "/api/project/open", Json(new { FileName = Str(a, "fileName") }))),

        new("project_save", "Save the project to a file name (server-local).",
            Schema("""{"type":"object","properties":{"fileName":{"type":"string"}},"required":["fileName"]}"""),
            a => new(POST, "/api/project/save", Json(new { FileName = Str(a, "fileName") }))),

        new("project_download", "Return the whole current project as one ConfigFile JSON document (every bound device + its config). For inspecting or backing up the project inline; inverse of project_upload.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/project/download", null)),

        new("project_upload", "Replace the whole project from a ConfigFile JSON document (pass it under 'project'): clears current devices and loads those in the doc. Inverse of project_download.",
            Schema("""{"type":"object","properties":{"project":{"type":"object"}},"required":["project"]}"""),
            a => new(POST, "/api/project/upload", JsonRaw(ObjArg(a, "project")))),

        // -------- logs ------------------------------------------------------
        new("get_canlog", "Get the recent CAN traffic log.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/canlog", null)),

        new("get_syslog", "Get the recent system/diagnostic log (errors, ack timeouts).",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/syslog", null)),

        new("export_canlog", "Export the CAN log as CSV text.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/canlog/export", null)),

        new("export_syslog", "Export the system log as CSV text.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/syslog/export", null)),
    };

    // ================================================================ SKILLS
    public static readonly List<McpSkill> Skills = new()
    {
        new("connect-and-discover", "Connect to the bus and find modules",
            "Open the CAN link and bind the modules that are present.",
            """
            # Skill: connect and discover

            1. `list_adapters` — see which adapters/ports exist and whether already connected.
            2. `connect` with `{adapter, port, bitrate}`. Bitrate is a STRING like `"500K"`.
               Typical bench: `{ "adapter":"USB", "port":"COM3", "bitrate":"500K" }`.
            3. `discover` — auto-bind modules broadcasting on the bus, or `identify` to just look.
            4. `list_devices` — confirm bound modules; note each `guid` for later calls.
            5. `read_device {guid}` — pull the full, CRC-verified config from a module.

            Notes:
            - A module that is powered but not addressed correctly may broadcast yet not answer
              reads (version stays `v0.0.0`, telemetry 0). That is the "not read yet" sentinel.
            - If `connect` fails, the result is `isError:true` with the reason — do not proceed.
            """),

        new("configure-a-module", "Read, change and persist module settings",
            "The safe read -> change -> burn loop for module configuration.",
            """
            # Skill: configure a module

            1. `read_device {guid}` first — never write blind.
            2. Change settings with the specific tool:
               - `set_output {guid, number, currentLimit}` for a quick current-limit tweak, or
               - `set_output_config {guid, config:{...}}` for a full output definition.
               - `write_param {guid, index, sub, value}` for raw parameters.
            3. Writes are LIVE but volatile. To persist across power cycles:
               `device_action {guid, action:"burn"}`.
            4. Re-`read_device` to confirm the device acknowledged the change.

            Honesty rule: every write is acknowledged by the device. If a tool returns
            `isError:true` (e.g. "No reply ... did NOT complete"), the change did not take —
            do not report success. Check `get_syslog` for ack-timeout detail.
            """),

        new("wire-outputs-safely", "Pick limits and wire gauge for outputs",
            "Configure output protection with the advisory wiring helpers in mind.",
            """
            # Skill: wire outputs safely

            1. Inspect existing outputs via `list_devices` or `read_device {guid}`.
            2. Set protection with `set_output_config`:
               - `CurrentLimit` (A) is the trip point.
               - `InrushLimit`/`InrushTime` allow a brief startup surge.
               - `ResetMode`/`ResetTime`/`ResetCountLimit` control auto-retry after a trip.
            3. The UI's AWG suggestion is a LOOKUP TABLE, not a thermal model, and the voltage-drop
               figure is an ESTIMATE (rho=0.0175, sysV=13.8 V, length counted both ways). Treat wire
               sizing as advisory — verify against your loom and ambient conditions.
            4. `device_action {guid, action:"burn"}` to persist.
            5. Use `get_overloads`/`clear_overloads` to inspect and reset latched trips.
            """),

        new("signals-and-logic", "Inputs, functions, DBC signals and Lua",
            "Wire inputs to outputs via functions, DBC signals, or Lua.",
            """
            # Skill: signals and logic

            - `get_inputs {guid}` — available logic inputs (optionally `type`).
            - `get_functions {guid}` — current function slots.
            - `set_function {guid, kind, number, params:{...}}` — define a function slot. `params`
              is passed through verbatim, so match the function's expected fields.
            - DBC: `open_dbc {guid, text|path}` to load a database, `get_dbc_signals {guid}` to list,
              `set_dbc_signal {guid, signal:{...}}` to map one.
            - Lua: `get_lua {guid}` / `set_lua {guid, source}` and `get_lua_error {guid}` to debug.

            Lua upload is best-effort; always check `get_lua_error` after `set_lua`, and `burn` to persist.
            """),

        new("flash-firmware", "Update module firmware",
            "Flash a firmware binary and verify the result honestly.",
            """
            # Skill: flash firmware

            1. Confirm the target with `list_devices` and note its `guid`.
            2. (Optional) `device_action {guid, action:"bootloader"}` if the device must be put into
               the bootloader first — confirm this is intended; it interrupts normal operation.
            3. `flash_firmware {guid, path}` — `path` is a file ON THE SERVER; its bytes are uploaded.
            4. Poll `flash_status` until done. The backend parses the real flasher result; a failure
               surfaces as an error — do NOT assume success just because the upload started.

            Destructive: flashing interrupts the module. Only flash when the operator intends it.
            """),

        new("keypad-sdo", "Talk to CANopen keypads via SDO",
            "Read and write CANopen object-dictionary entries on a keypad node.",
            """
            # Skill: keypad SDO

            - `sdo_read {node, index, sub}` — read an OD entry. `node` is 1..127.
            - `sdo_write {node, index, sub, value, size}` — write; `size` is 1, 2 or 4 bytes and
              MUST match the object's width or the node rejects it.
            - `sdo_store {node}` — issue store-parameters so the change survives a power cycle.

            Bounds are enforced server-side (node 1..127, size in {1,2,4}); out-of-range calls return
            an error rather than poking the bus blindly.
            """),

        new("logs-and-troubleshooting", "Diagnose failures and ack timeouts",
            "Use the logs to find out why an operation did not complete.",
            """
            # Skill: logs and troubleshooting

            When a write/burn/action returns `isError:true` or behaves oddly:
            1. `get_syslog` — system/diagnostic events, including
               "No reply from <module> — <frame> failed after N tries" ack timeouts.
            2. `get_canlog` — raw CAN traffic; confirm the module is broadcasting at all.
            3. `raw_log {id?, count?}` — recent frames, optionally filtered to one id.
            4. `list_adapters` / `list_devices` — confirm the link is up and the module is bound.

            Common causes: wrong base ID, module not powered, bus not terminated, or a write to a
            module that is broadcasting but not answering host reads. Export with
            `export_syslog` / `export_canlog` for an offline trace.
            """),

        new("lua-programming", "Write & upload device Lua (the exact on-device API)",
            "The complete Lua API the firmware exposes, the program model, and how to upload + validate.",
            """
            # Skill: Lua programming

            Only **dingoPDM / PDM-MAX** run Lua (the CANBoard has no engine). The device runs Lua **source**
            directly — there is no separate compile step. Upload with `set_lua {guid, source}` (send the
            WHOLE program text), then ALWAYS check `get_lua_error {guid}` (empty string = healthy). `burn`
            to persist. A runaway script is killed by an instruction-budget guard. `set_lua` stores the
            program on the device record (saved in the project JSON, offline-safe) and pushes over CAN when
            the module is live; if it was offline, push later with `device_action {guid, action:"uploadlua"}`.
            `get_lua` returns the live program when connected, else the stored one.

            ## You define these callbacks
            - `function onTick()` — called every tick (rate set by `setTickRate`).
            - `function onCanRx(bus, id, dlc, data)` — called for each frame whose id you registered with
              `canRxAdd(id)`. `data` is a 1-indexed table of bytes; `bus` is always 1 (one CAN bus).

            ## The API (exactly what's registered on the device)
            - `setTickRate(hz)` — onTick frequency, 1..1000 Hz. Call once at top level (e.g. `setTickRate(50)`).
            - `readVar(index) -> number` — read any var-map signal by its **index**. Get the index↔name map
              from `get_inputs {guid}` (each entry has `index` + `name`). Booleans read as 0/1.
            - `setLuaOut(slot, value)` — drive **Lua output slot** `0..31`. To make an output/virtual-input/
              CAN-output follow it, set that target's **Input** to **"Lua Out N"** (N = slot+1) via
              `set_output_config` / `set_function` (use the var-map index of "Lua Out N" from `get_inputs`).
            - `canRxAdd(id)` — register a CAN id so `onCanRx` fires for it (call at top level).
            - `txCan(bus, id, ext, data)` — transmit. `bus`=1, `id` number, `ext` true/1 for 29-bit,
              `data` a 1-indexed table of up to 8 byte values, e.g. `txCan(1, 0x200, false, {0xFF, dlc})`.
            - `luaLog(msg)` — record a string; read it back with `get_lua_error` (handy for debugging).
            - Timers: `local t = Timer.new()` · `t:reset()` · `t:getElapsedSeconds() -> number`.

            ## Program model (over MCP)
            In the UI a program is assembled from a global section + per-function snippets; over MCP you send
            the **entire** assembled source as one `source` string. Define top-level setup (setTickRate,
            canRxAdd) once, then `onTick` / `onCanRx`.

            ## Example — mirror a CAN bit to output 1, and blink output 2 at 1 Hz
            ```lua
            setTickRate(50)
            canRxAdd(0x200)
            local blink = Timer.new()
            function onCanRx(bus, id, dlc, data)
              if id == 0x200 then setLuaOut(0, (data[1] & 0x01))  end   -- Lua Out 1 ← bit0 of 0x200
            end
            function onTick()
              if blink:getElapsedSeconds() >= 0.5 then setLuaOut(1, 1 - readVar(LUA_OUT2_IDX)); blink:reset() end
            end
            ```
            Then point output 1's Input at "Lua Out 1" and output 2's at "Lua Out 2" (`set_output_config`),
            `set_lua`, `get_lua_error`, `burn`.

            Honesty: `set_lua` can succeed yet the program have a runtime error — only `get_lua_error` (read
            from the device) confirms it's healthy. A failed read is not proof of health.
            """),

        new("cross-module-signals", "Use one module's signal on another (the IO picker)",
            "Point a consumer's CAN input at a source module's broadcast signal — feature B, server-side.",
            """
            # Skill: cross-module signals

            Make module B react to a signal module A already broadcasts (e.g. PDM-01 reads CB-1's rotary
            switch 4). This decodes A's **native** broadcast frame — no extra config on A.

            1. `list_devices` — note the **source** guid (broadcaster, A) and **consumer** guid (B).
            2. `broadcast_signals {guid: A, inUse: true}` — list what A actually broadcasts (set `inUse:true`
               to see only its configured signals, like the UI picker). Pick a signal `name`
               (e.g. `RotarySwitch4.Pos`, `Output3.Current`, `CanInput2`). `get_frame_map` documents the
               full layout if you want it with no device bound.
            3. `link_remote_signal {guid: B, canInput: N, sourceGuid: A, signal: "<name>"}` — writes B's
               CAN-input slot N to decode that signal at A's current id+bits. Now use it on B like any CAN
               input (drive an output, a condition, etc.).
            4. `device_action {guid: B, action: "burn"}` to persist.

            **Re-addressing:** the link resolves A's CURRENT base id. If you later change A's base id
            (`modify_device`), **re-run `link_remote_signal`** for each consumer so their CAN-input ids
            track the new base, then re-burn those consumers.

            Note: this is the direct-decode model. The older "re-broadcast bridge" (a CAN output on the
            source) still exists in the UI for Lua-computed values; for plain broadcast signals prefer this.
            """),

        new("can-addressing", "Base IDs, spans, and the CAN frame map",
            "Pick collision-free base IDs and find which frame/bits carry each signal.",
            """
            # Skill: CAN addressing & frame map

            - **Footprint:** a module owns `baseId .. baseId + span`, matching firmware NUM_TX_MSGS —
              **CANBoard `base..+10`**, **dingoPDM/-Max `base..+28`** (config at +0/+1, cyclic from +2).
              Two modules clash if these ranges overlap; space them apart accordingly.
            - `get_definitions` — per-model channel counts + output current ratings (before `add_device`).
            - `get_frame_map` — the address-agnostic map: which `base + offset` and bits carry each
              transmitted signal, for every device type. Needs no connection.
            - `broadcast_signals {guid}` — the same, resolved to one live module's signals (+ `inUse`).
            - **Change a base id:** `modify_device {guid, name, baseId}` (hex like `0x1A0` or decimal). Keep
              OBD-II diagnostic ids (0x7DF, 0x7E0–0x7EF, 0x7F1) clear unless the bus has no OBD. After a
              change, re-run `link_remote_signal` for any consumers of that module (see cross-module-signals).
            - Offline planning: the repo's `tools/canfree.py` reads a DBC or CAN log and reports free ids +
              suggests collision-free bases (`canfree bus.dbc --preset dingo:5pdm,2cb`).
            """),

        new("cross-module-functions", "Author & deploy a behaviour spanning modules (blinkers, etc.)",
            "Define a trigger → targets behaviour (optionally a synchronised blink) and deploy it with deploy_cross_module.",
            """
            # Skill: cross-module functions

            A cross-module function reads ONE **trigger** signal on a module and drives **target outputs**
            on other modules — optionally as a **synchronised blink** (one module is the clock master so
            every lamp flashes in lock-step), with an optional **failover backup** master. `deploy_cross_module`
            compiles this to per-module Lua + output bindings. Targets must be **dingoPDM/-Max** (Lua runs only
            on PDMs); for a CANBoard target use `link_remote_signal` + a local rule instead. It works **offline**:
            each module's Lua + bindings are saved to the project record and pushed over CAN to whatever is live
            now — push the rest when they connect (no need for every module to be live at once).

            ## Author it offline (no UI)
            1. `list_devices` → the **guid** of each module.
            2. `get_inputs {guid}` on the **trigger** module → find the **varIndex** of the trigger signal
               (each entry has `index` + `name`, e.g. a digital input, a CAN input, a condition).
            3. Note each **target** module's guid + **output number** (1-based).
            4. Build the `functions` array and call `deploy_cross_module`.

            ## Schema (one entry per function)
            ```json
            {
              "name": "Hazards",
              "blink": true,                       // false = targets simply follow the trigger
              "blinkRateMs": 350,                  // half-period; ignored when blink=false
              "trigger": { "guid": "<owner>", "varIndex": 42 },
              "targets": [
                { "guid": "<pdmA>", "output": 3 },
                { "guid": "<pdmB>", "output": 5 }
              ],
              "clockMaster": "<pdmA>",             // optional; defaults to the trigger owner. blink only.
              "clockBackup": "<pdmB>"              // optional; takes over if the master's clock stops. blink only.
            }
            ```
            - **Slots & CAN IDs:** each function's array **position** is its slot → it claims trigger id
              `0x520 + slot*2` and clock id `+1`. Keep those clear of your modules' base-ID spans and of
              other functions (deploy several in ONE call so slots don't collide).
            - **No blink:** every target output = the trigger (on/off). **Blink:** target = trigger AND clock.

            ## Deploy + verify
            - Preview first (no device touched): `deploy_cross_module {functions:[...], preview:true}` returns
              the compiled per-module Lua + output bindings so you can review it offline.
            - `deploy_cross_module {functions:[...]}` → per module `{ok, written, boundOutputs}`. `written:true`
              = pushed over CAN; `written:false` = saved to the project record (module offline). It does NOT
              require every module live — deploy now, push the offline ones later.
            - Each target output's **current limit must already be set** (Read it, or `set_output_config`) — the
              deploy refuses to guess a trip point.
            - **Deploy offline, push when online:** the Lua + bindings persist in the project JSON (save it).
              When a module connects: `device_action {guid, action:"writeall"}` (push params incl. bindings) then
              `device_action {guid, action:"uploadlua"}` (push the stored Lua) — or just re-run deploy_cross_module.
            - Verify: `get_lua_error {guid}` (empty = healthy), then `device_action {guid, action:"burn"}` to persist.

            This is the Lua deployment of the System-view "cross-module functions". The exact generated Lua
            (trigger publish over CAN, clock gen + failover, setLuaOut drives) is described in lua-programming.
            """),
    };
}
