using System.Text;
using Jint;
using Microsoft.Extensions.FileProviders;

namespace web.Api;

// ============================================================================
//  Templates over HTTP (and so MCP): list / preview / apply / remove the Templates tab's ready-made
//  circuits. The engine is the SPA's own (clientapp/src/lib/templates.js + apply.js, bundled into
//  wwwroot/template-runtime.js) run in Jint, talking to this app's /api over a loopback — one engine,
//  so an agent builds exactly what the UI builds.
//
//  Applied templates (what each one created, so it can be edited or removed) are a JSON list kept here
//  and mirrored by the SPA, which bundles it into the saved project file.
//  In memory; the project file keeps it (G4: saved into and loaded from the file's client section).
// ============================================================================
public static class TemplateApi
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(2) };
    static readonly SemaphoreSlim Gate = new(1, 1);   // one run at a time: the instance list is read-modify-write
    static string? _instances;   // null until the SPA (or an apply) seeds it
    /// <summary>The function records as JSON (G4: written into the project file on save).</summary>
    internal static string? Instances => _instances;
    /// <summary>Take the records from an opened project; null = the project has none.</summary>
    internal static void LoadInstances(System.Text.Json.JsonElement? client) =>
        _instances = client is { ValueKind: System.Text.Json.JsonValueKind.Object } c && c.TryGetProperty("templates", out var t)
            && t.ValueKind == System.Text.Json.JsonValueKind.Array ? t.GetRawText() : "[]";

    public static void MapTemplateApi(this WebApplication app, IFileProvider spaFiles)
    {
        var api = app.MapGroup("/api/templates");

        api.MapGet("", (HttpRequest req) => Run(spaFiles, req, e => e.Evaluate("DingoTpl.list()")));

        api.MapPost("/preview", async (HttpRequest req) =>
        {
            var body = await Body(req);
            return Run(spaFiles, req, e => { e.SetValue("reqJson", body); return e.Evaluate("DingoTpl.preview(host, reqJson)"); });
        });

        api.MapPost("/apply", async (HttpRequest req) =>
        {
            var body = await Body(req);
            await Gate.WaitAsync();
            try
            {
                return Run(spaFiles, req, e =>
                {
                    e.SetValue("reqJson", body).SetValue("instJson", _instances ?? "[]").SetValue("newId", Guid.NewGuid().ToString());
                    return e.Evaluate("DingoTpl.apply(host, reqJson, instJson, newId)");
                }, keep: true);
            }
            finally { Gate.Release(); }
        });

        api.MapPost("/remove", async (HttpRequest req) =>
        {
            var body = await Body(req);
            await Gate.WaitAsync();
            try
            {
                return Run(spaFiles, req, e =>
                {
                    e.SetValue("reqJson", body).SetValue("instJson", _instances ?? "[]");
                    return e.Evaluate("DingoTpl.remove(host, JSON.parse(reqJson).id, instJson)");
                }, keep: true);
            }
            finally { Gate.Release(); }
        });

        // The SPA's mirror of the applied list.
        api.MapGet("/instances", () => Results.Text(_instances ?? "null", "application/json"));
        api.MapPut("/instances", async (HttpRequest req) =>
        {
            var body = await Body(req);
            try { using var _ = System.Text.Json.JsonDocument.Parse(body); } catch { return Results.BadRequest("not JSON"); }
            await Gate.WaitAsync();
            try { _instances = body; } finally { Gate.Release(); }
            return Results.Ok();
        });
    }

    static async Task<string> Body(HttpRequest req)
    {
        using var r = new StreamReader(req.Body, Encoding.UTF8);
        return await r.ReadToEndAsync();
    }

    // Load the runtime, run `call`, unwrap its promise. Errors (a JS throw, an /api call that failed)
    // come back as 400 with the message. keep: the result carries `instances` — store them.
    static IResult Run(IFileProvider spaFiles, HttpRequest req, Func<Engine, Jint.Native.JsValue> call, bool keep = false)
    {
        var file = spaFiles.GetFileInfo("template-runtime.js");
        if (!file.Exists) return Results.Problem("template-runtime.js is missing from wwwroot — run `npm run build` in web/clientapp");
        string script;
        using (var s = new StreamReader(file.CreateReadStream())) script = s.ReadToEnd();

        var baseUrl = $"{req.Scheme}://{req.Host}";
        using var engine = new Engine(o => o.CatchClrExceptions().TimeoutInterval(TimeSpan.FromMinutes(2)));
        engine.SetValue("host", new Host(baseUrl));
        try
        {
            engine.Execute(script);
            var json = call(engine).UnwrapIfPromise().AsString();
            if (keep)
            {
                using var doc = System.Text.Json.JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("instances", out var inst)) _instances = inst.GetRawText();
            }
            return Results.Text(json, "application/json");
        }
        catch (Exception e) when (e is Jint.Runtime.JavaScriptException or Jint.Runtime.PromiseRejectedException or InvalidOperationException)
        {
            return Results.BadRequest(new { error = e is Jint.Runtime.PromiseRejectedException p ? ErrText(p.RejectedValue) : e.Message });
        }
    }

    static string ErrText(Jint.Native.JsValue v) =>
        v.IsObject() && v.AsObject().Get("message") is var m && m.IsString() ? m.AsString() : v.ToString();

    // host.call(method, path, bodyJson) from the runtime: a synchronous loopback to /api. Non-2xx throws, which
    // the JS sees as a rejected api call (and rolls back on).
    public sealed class Host(string baseUrl)
    {
        public string call(string method, string path, string? body)
        {
            using var msg = new HttpRequestMessage(new HttpMethod(method), baseUrl + path);
            if (body is not null) msg.Content = new StringContent(body, Encoding.UTF8, "application/json");
            using var resp = Http.Send(msg);
            using var r = new StreamReader(resp.Content.ReadAsStream());
            var text = r.ReadToEnd();
            if (!resp.IsSuccessStatusCode) throw new InvalidOperationException($"HTTP {(int)resp.StatusCode} from {path}: {text}");
            return text;
        }
    }
}
