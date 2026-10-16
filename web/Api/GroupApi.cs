using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using application.Services;

namespace web.Api;

// ============================================================================
//  Function / helper block groups (G16). Per module: { groups: [...], dismissed: [...] }.
//  A group is metadata over the module's own blocks (recipe key, kind fn|helper, members "kind:n", ports,
//  settings, custom flag + original snapshot...): the blocks themselves are never changed here, so
//  dissolving a group is just a record write. Held by the server so an AI agent sees the same groups;
//  saved into and loaded from the project file's client section (G4) under "groups".
// ============================================================================
public static partial class GroupApi
{
    static readonly ConcurrentDictionary<Guid, string> _byModule = new();
    const int MaxBytes = 64 * 1024;
    internal static bool IsEmpty => _byModule.IsEmpty;

    [GeneratedRegex(@"^([a-z]+:\d{1,3}|sys|lua)$")] private static partial Regex MemberId();

    /// <summary>The records of an opened project; older files kept them in the browser keys (graph."dingoNextGroups:&lt;guid&gt;").</summary>
    internal static void Load(JsonElement? client)
    {
        _byModule.Clear();
        if (client is not { ValueKind: JsonValueKind.Object } c) return;
        if (c.TryGetProperty("groups", out var g) && g.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in g.EnumerateObject())
                if (Guid.TryParse(p.Name, out var id) && Validate(p.Value) is null) _byModule[id] = p.Value.GetRawText();
            return;
        }
        if (c.TryGetProperty("graph", out var graph) && graph.ValueKind == JsonValueKind.Object)
            foreach (var p in graph.EnumerateObject())
            {
                if (!p.Name.StartsWith("dingoNextGroups:") || p.Value.ValueKind != JsonValueKind.String) continue;
                try
                {
                    using var doc = JsonDocument.Parse(p.Value.GetString()!);
                    if (Guid.TryParse(p.Name["dingoNextGroups:".Length..], out var id) && Validate(doc.RootElement) is null) _byModule[id] = doc.RootElement.GetRawText();
                }
                catch (JsonException) { /* a broken browser key: skip it */ }
            }
    }

    /// <summary>Write the records into a client section (and drop the old browser keys).</summary>
    internal static JsonObject MergeInto(JsonObject client)
    {
        var groups = new JsonObject();
        foreach (var (id, json) in _byModule) groups[id.ToString()] = JsonNode.Parse(json);
        client["groups"] = groups;
        if (client["graph"] is JsonObject graph)
            foreach (var k in graph.Select(x => x.Key).Where(k => k.StartsWith("dingoNextGroups:")).ToList()) graph.Remove(k);
        return client;
    }

    /// <summary>null when the record is well formed, else what is wrong.</summary>
    internal static string? Validate(JsonElement r)
    {
        if (r.ValueKind != JsonValueKind.Object) return "expected { groups, dismissed }";
        if (r.GetRawText().Length > MaxBytes) return $"record too big (over {MaxBytes / 1024} KB)";
        if (!r.TryGetProperty("groups", out var gs) || gs.ValueKind != JsonValueKind.Array) return "groups must be an array";
        if (gs.GetArrayLength() > 200) return "at most 200 groups per module";
        var ids = new HashSet<string>();
        var taken = new HashSet<string>();
        foreach (var g in gs.EnumerateArray())
        {
            if (g.ValueKind != JsonValueKind.Object) return "a group must be an object";
            string? Str(string k, int max) => g.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String && v.GetString()!.Length is > 0 and var n && n <= max ? v.GetString() : null;
            var id = Str("id", 40);
            if (id is null || !ids.Add(id)) return "every group needs its own id (1-40 characters)";
            if (Str("recipe", 40) is null) return $"group {id}: recipe missing";
            if (Str("kind", 6) is not ("fn" or "helper")) return $"group {id}: kind must be fn or helper";
            if (g.TryGetProperty("name", out var nm) && (nm.ValueKind != JsonValueKind.String || nm.GetString()!.Length > 80)) return $"group {id}: name too long";
            if (!g.TryGetProperty("members", out var ms) || ms.ValueKind != JsonValueKind.Array || ms.GetArrayLength() is 0 or > 64) return $"group {id}: 1 to 64 members";
            foreach (var m in ms.EnumerateArray())
            {
                if (m.ValueKind != JsonValueKind.String || !MemberId().IsMatch(m.GetString()!)) return $"group {id}: member must look like condition:3";
                if (!taken.Add(m.GetString()!)) return $"group {id}: {m.GetString()} is already in another group";   // one block, one group
            }
        }
        if (r.TryGetProperty("dismissed", out var ds) && (ds.ValueKind != JsonValueKind.Array || ds.GetArrayLength() > 500 || ds.EnumerateArray().Any(x => x.ValueKind != JsonValueKind.String)))
            return "dismissed must be a list of up to 500 suggestion keys";
        return null;
    }

    public static void MapGroupApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/groups");
        // every module's record (for the agent and the whole-car view)
        api.MapGet("", () => Results.Text("{" + string.Join(",", _byModule.Select(kv => $"\"{kv.Key}\":{kv.Value}")) + "}", "application/json"));
        api.MapGet("/{guid}", (string guid) =>
            Guid.TryParse(guid, out var g) ? Results.Text(_byModule.TryGetValue(g, out var j) ? j : """{"groups":[],"dismissed":[]}""", "application/json") : Results.BadRequest());
        api.MapPut("/{guid}", async (string guid, HttpRequest req, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is null) return Results.NotFound(new { error = "no such module in the project" });
            JsonElement body;
            try { using var doc = await JsonDocument.ParseAsync(req.Body); body = doc.RootElement.Clone(); }
            catch (JsonException e) { return Results.BadRequest(new { error = "not JSON: " + e.Message }); }
            if (Validate(body) is { } err) return Results.BadRequest(new { error = err });
            _byModule[g] = body.GetRawText();
            return Results.Ok(new { ok = true });
        });
    }
}
