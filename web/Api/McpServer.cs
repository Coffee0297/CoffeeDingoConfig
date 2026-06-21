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

    const string Instructions =
        "dingoPDM controls Coffee Dingo CAN-bus power-distribution modules over a serial CAN link. " +
        "Typical flow: list_adapters -> connect -> discover/list_devices -> read_device -> inspect/change " +
        "outputs/params/signals -> burn to persist. Writes are queued and acknowledged by the device; a " +
        "tool result with isError:true means the operation did NOT complete. Start with the prompts/skills " +
        "(connect-and-discover, configure-a-module, wire-outputs-safely, signals-and-logic, flash-firmware, " +
        "keypad-sdo, logs-and-troubleshooting) for guided playbooks.";

    // ----------------------------------------------------------------- routing
    public static void MapMcp(this WebApplication app)
    {
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
        return new
        {
            name = ServerName,
            version = ServerVersion,
            protocolVersion = ProtocolVersion,
            transport = "streamable-http",
            httpEndpoint = $"{origin}/mcp",
            instructions = Instructions,
            // Copy-paste client configs (HTTP + stdio bridge).
            httpConfig = new { mcpServers = new { dingopdm = new { url = $"{origin}/mcp" } } },
            stdioConfig = new
            {
                mcpServers = new
                {
                    dingopdm = new
                    {
                        command = "node",
                        args = new[] { "mcp/dingo-mcp.mjs" },
                        env = new { DINGO_URL = origin }
                    }
                }
            },
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
            a => new(POST, "/api/probe", Json(new { Base = Num(a, "base") }))),

        new("raw_log", "Read recent raw CAN frames, optionally filtered by id.",
            Schema("""{"type":"object","properties":{"id":{"type":"integer"},"count":{"type":"integer"}}}"""),
            a => new(GET, "/api/rawlog" + Q(a, "id", "count"), null)),

        // -------- devices ---------------------------------------------------
        new("list_devices", "List bound devices with telemetry and output state.",
            Schema("""{"type":"object","properties":{}}"""),
            _ => new(GET, "/api/devices", null)),

        new("add_device", "Add/bind a device by type, name and base ID.",
            Schema("""{"type":"object","properties":{"type":{"type":"string","description":"e.g. dingoPDM"},"name":{"type":"string"},"baseId":{"type":"integer"}},"required":["type","baseId"]}"""),
            a => new(POST, "/api/devices", Json(new { Type = Str(a, "type"), Name = StrOpt(a, "name"), BaseId = Num(a, "baseId") }))),

        new("remove_device", "Remove a bound device.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/remove", null)),

        new("rename_device", "Rename a device.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"name":{"type":"string"}},"required":["guid","name"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/rename", Json(new { Name = Str(a, "name") }))),

        new("modify_device", "Change a device's name and/or base ID.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"name":{"type":"string"},"baseId":{"type":"integer"}},"required":["guid","name","baseId"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/modify", Json(new { Name = Str(a, "name"), BaseId = Num(a, "baseId") }))),

        new("read_device", "Read the full live config from a device (CRC-verified).",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"}},"required":["guid"]}"""),
            a => new(POST, $"/api/devices/{Str(a, "guid")}/read", null)),

        new("device_action", "Run a lifecycle action: read, write, writeall, burn, sleep, wakeup, bootloader.",
            Schema("""{"type":"object","properties":{"guid":{"type":"string"},"action":{"type":"string","enum":["read","write","writeall","burn","sleep","wakeup","bootloader"]}},"required":["guid","action"]}"""),
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

        new("set_lua", "Upload a Lua script to a device (Source = script text).",
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
    };
}
