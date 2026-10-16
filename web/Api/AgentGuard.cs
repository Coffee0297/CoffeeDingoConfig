using System.Collections.Concurrent;
using System.Text.Json;
using application.Services;

namespace web.Api;

/// <summary>
/// G22: what stands between an AI agent (MCP client) and the car. Tools on the ask-first list wait for the
/// operator to approve or refuse in the app (refused after 2 minutes). Every write an agent makes goes into a
/// journal with a snapshot of the project just before it, so one can be undone (the project goes back; Apply
/// sends it to the car). Clients are seen per MCP session. The server can be switched off.
/// ponytail: in memory for the app's lifetime; journal capped at 200, snapshots at the last 20 writes.
/// </summary>
public static class AgentGuard
{
    public static bool Enabled { get; set; } = true;
    static readonly TimeSpan AskTimeout = TimeSpan.FromMinutes(2);
    // By default every tool that reaches the modules asks first: flashing, and anything that can switch a load or
    // change what a module does (an output's config or function can switch it on as well as set_output can).
    // Project-only edits (rename, add, remove, open) run and are journaled with undo.
    static readonly HashSet<string> _ask = [
        "flash_firmware", "flash_firmware_can", "flash_blank", "set_output", "set_output_config", "set_function",
        "write_param", "apply_config", "apply_profile", "device_action", "modify_device", "clear_overloads",
        "link_remote_signal", "deploy_cross_module", "apply_template", "remove_template", "set_lua", "sdo_write", "sdo_store"];
    static readonly object _lock = new();

    public sealed record Client(string Id, string Name, DateTime FirstSeen, DateTime LastCall, int Calls);
    sealed record Pending(string Id, string Client, string Tool, string Args, DateTime At, TaskCompletionSource<bool> Answer);
    public sealed record Entry(int Id, DateTime At, string Client, string Tool, string Args, bool Ok, string Status, bool Undoable, bool Undone);

    static readonly ConcurrentDictionary<string, Client> _clients = new();
    static readonly ConcurrentDictionary<string, Pending> _pending = new();
    static readonly List<Entry> _journal = [];
    static readonly Dictionary<int, string> _snapshots = [];
    static int _nextId;

    public static int PendingCount => _pending.Count;
    /// <summary>The oldest waiting request (null: none). Changes with every new request, unlike the count.</summary>
    public static string? OldestPendingId => _pending.Values.OrderBy(p => p.At).FirstOrDefault()?.Id;
    public static bool NeedsApproval(string tool) { lock (_lock) return _ask.Contains(tool); }

    public static void SetAsk(string tool, bool ask) { lock (_lock) { if (ask) _ask.Add(tool); else _ask.Remove(tool); } }

    /// <summary>Note a call from a client (name from its initialize clientInfo, when it sent one).</summary>
    public static void Seen(string id, string? name = null) =>
        _clients.AddOrUpdate(id, _ => new Client(id, name ?? "MCP client", DateTime.UtcNow, DateTime.UtcNow, 0),
            (_, c) => c with { Name = name ?? c.Name, LastCall = DateTime.UtcNow, Calls = c.Calls + (name is null ? 1 : 0) });

    /// <summary>Wait for the operator. False when refused, timed out or the server was switched off meanwhile.</summary>
    public static async Task<bool> AskAsync(string client, string tool, JsonElement args)
    {
        var p = new Pending(Guid.NewGuid().ToString("N")[..12], client, tool, args.ValueKind == JsonValueKind.Undefined ? "{}" : args.GetRawText(),
            DateTime.UtcNow, new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously));
        _pending[p.Id] = p;
        try { return await p.Answer.Task.WaitAsync(AskTimeout).ConfigureAwait(false); }
        catch (TimeoutException) { return false; }
        finally { _pending.TryRemove(p.Id, out _); }
    }

    public static bool Answer(string id, bool approve) => _pending.TryGetValue(id, out var p) && p.Answer.TrySetResult(approve);

    /// <summary>Journal a write; <paramref name="before"/> is the project just before it (null: nothing to undo).</summary>
    public static void Record(string client, string tool, JsonElement args, bool ok, string status, string? before)
    {
        lock (_lock)
        {
            var id = ++_nextId;
            _journal.Add(new Entry(id, DateTime.UtcNow, client, tool, args.ValueKind == JsonValueKind.Undefined ? "{}" : args.GetRawText(), ok, status, before is not null && ok, false));
            if (before is not null && ok) _snapshots[id] = before;
            while (_journal.Count > 200) _journal.RemoveAt(0);
            foreach (var old in _snapshots.Keys.OrderByDescending(k => k).Skip(20).ToList()) _snapshots.Remove(old);
            // an entry whose snapshot was dropped can no longer be undone
            for (int i = 0; i < _journal.Count; i++) if (_journal[i].Undoable && !_snapshots.ContainsKey(_journal[i].Id)) _journal[i] = _journal[i] with { Undoable = false };
        }
    }

    /// <summary>The project as it was before entry <paramref name="id"/>, and mark it (and every later write) undone.</summary>
    public static string? TakeUndo(int id)
    {
        lock (_lock)
        {
            if (!_snapshots.TryGetValue(id, out var snap)) return null;
            for (int i = 0; i < _journal.Count; i++)
                if (_journal[i].Id >= id && _journal[i].Ok) { _journal[i] = _journal[i] with { Undone = true, Undoable = false }; _snapshots.Remove(_journal[i].Id); }
            return snap;
        }
    }

    public static object Status(string origin) => new
    {
        enabled = Enabled,
        url = $"{origin}/mcp",
        clients = _clients.Values.OrderByDescending(c => c.LastCall).Select(c => new { c.Id, c.Name, firstSeen = Iso(c.FirstSeen), lastCall = Iso(c.LastCall), c.Calls }),
        pending = _pending.Values.OrderBy(p => p.At).Select(p => new { p.Id, p.Client, p.Tool, args = JsonDocument.Parse(p.Args).RootElement, at = Iso(p.At), expiresAt = Iso(p.At + AskTimeout) }),
        ask = AskList(),
        journal = Journal().Select(e => new { e.Id, at = Iso(e.At), e.Client, e.Tool, args = JsonDocument.Parse(e.Args).RootElement, e.Ok, e.Status, e.Undoable, e.Undone }),
    };

    static string[] AskList() { lock (_lock) return [.. _ask.Order()]; }
    static List<Entry> Journal() { lock (_lock) return [.. Enumerable.Reverse(_journal)]; }
    static string Iso(DateTime t) => t.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture);

    public record AnswerReq(bool Approve);
    public record AskReq(string Tool, bool Ask);
    public record EnabledReq(bool Enabled);

    public static void MapAgentGuard(this WebApplication app)
    {
        var api = app.MapGroup("/api/agent");
        // Answers, the ask list and on/off are for the operator in the app, not for an assistant: only a request a
        // browser marks as coming from the page itself (Sec-Fetch-Site: same-origin) changes them. ponytail: a speed
        // bump against an assistant answering its own request with a plain HTTP call, not a lock: anything running
        // on this PC can set that header (or edit the project file). Real auth needs a session the agent never sees.
        var operatorOnly = api.MapGroup("").AddEndpointFilter(async (ctx, next) =>
            ctx.HttpContext.Request.Headers["Sec-Fetch-Site"] == "same-origin"
                ? await next(ctx)
                : Results.Json(new { error = "Only the dingoConfig app can do this." }, statusCode: 403));
        api.MapGet("", (HttpRequest req) => Results.Ok(Status($"{req.Scheme}://{req.Host}")));
        operatorOnly.MapPost("/approvals/{id}", (string id, AnswerReq r) =>
            Answer(id, r.Approve) ? Results.Ok(new { ok = true }) : Results.NotFound(new { error = "That request is no longer waiting." }));
        operatorOnly.MapPost("/ask", (AskReq r) => { SetAsk(r.Tool, r.Ask); return Results.Ok(new { ask = AskList() }); });
        operatorOnly.MapPost("/enabled", (EnabledReq r) =>
        {
            Enabled = r.Enabled;
            if (!Enabled) foreach (var p in _pending.Values) p.Answer.TrySetResult(false);
            return Results.Ok(new { enabled = Enabled });
        });
        // Put the project back as it was before an agent's write (and drop that write and every later one).
        // Like opening a file: the modules keep what they have until Apply to car sends the project.
        operatorOnly.MapPost("/undo/{id:int}", (int id, ConfigFileManager cfg, DeviceManager dm, CrossModuleStore xmod) =>
        {
            var snap = TakeUndo(id);
            if (snap is null) return Results.NotFound(new { error = "That change can no longer be undone." });
            var devs = cfg.LoadDevicesFromJson(snap);
            if (devs is null) return Results.Json(new { error = "The saved project could not be read." }, statusCode: 500);
            dm.ClearDevices(); xmod.Clear(); dm.AddDevices(devs);
            return Results.Ok(new { ok = true, count = devs.Count });
        });
    }
}
