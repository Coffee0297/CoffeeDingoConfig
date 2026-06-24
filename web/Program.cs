using application.Services;
using infrastructure.Adapters;
using infrastructure.BackgroundServices;
using infrastructure.Comms;
using infrastructure.Logging;
using web.Api;
using domain.Interfaces;
using Microsoft.AspNetCore.Connections;

var builder = WebApplication.CreateBuilder(args);
builder.Host.ConfigureHostOptions(opts => opts.ShutdownTimeout = TimeSpan.FromSeconds(5));

// --- Device engine (CAN adapters + device/comms services) ---
builder.Services.AddTransient<UsbAdapter>();
builder.Services.AddTransient<SlcanAdapter>();
builder.Services.AddTransient<SocketCanAdapter>();   // only listed/resolved on Linux (runtime-gated)
builder.Services.AddTransient<PcanAdapter>();
builder.Services.AddTransient<SimAdapter>();

builder.Services.AddSingleton<ICommsAdapterManager, CommsAdapterManager>();
builder.Services.AddSingleton<DeviceDefinitionManager>();
builder.Services.AddSingleton<ConfigFileManager>();
builder.Services.AddSingleton<DeviceManager>();
builder.Services.AddSingleton<CrossModuleStore>();
builder.Services.AddSingleton<FirmwareFlashService>();
builder.Services.AddSingleton<CanFlashService>();
builder.Services.AddSingleton<SdoService>();
builder.Services.AddSingleton<SystemConfigService>();
builder.Services.AddSingleton<CanMsgLogger>();
builder.Services.AddSingleton<SystemLogger>();
builder.Services.AddSingleton<SimPlayback>();

builder.Services.AddHostedService<CommsDataPipeline>();

// --- Redesign SPA backend: SignalR live telemetry + REST commands ---
builder.Services.AddSignalR();
builder.Services.AddHostedService<TelemetryBroadcaster>();
// CORS only matters for the Vite dev server (5173) talking to this API (5000).
builder.Services.AddCors(o => o.AddPolicy("spa", p => p
    .WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
    .AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

// Route framework + app logs into the in-app SystemLogger (so /api/syslog has them)
builder.Logging.Services.AddSingleton<ILoggerProvider>(sp =>
    new SystemLoggerProvider(sp.GetRequiredService<SystemLogger>()));

var app = builder.Build();

// Serve the built Svelte SPA. Use the physical wwwroot when it exists (dev / folder deploy);
// otherwise fall back to the copy embedded in the assembly so a single-file exe needs no
// loose files (static web assets aren't bundled into single-file by default).
var physicalWwwroot = Path.Combine(app.Environment.ContentRootPath, "wwwroot");
Microsoft.Extensions.FileProviders.IFileProvider spaFiles =
    File.Exists(Path.Combine(physicalWwwroot, "index.html"))
        ? new Microsoft.Extensions.FileProviders.PhysicalFileProvider(physicalWwwroot)
        : new Microsoft.Extensions.FileProviders.ManifestEmbeddedFileProvider(typeof(Program).Assembly, "wwwroot");

// SPA cache policy: Vite emits content-hashed bundles under /assets (the name changes when the
// content does), so cache those forever (immutable) — but index.html must always be revalidated,
// or the browser keeps serving an old index that points at an old bundle after a republish (the
// "I don't see the new UI" trap). no-cache = "may store, but revalidate first" → a 304 when
// unchanged (cheap) or the new index after a deploy. API/MCP/SignalR + /llms.txt etc. are not
// static files, so none of this touches them.
void SpaCache(Microsoft.AspNetCore.StaticFiles.StaticFileResponseContext ctx)
{
    if (ctx.File.Name.Equals("index.html", StringComparison.OrdinalIgnoreCase))
        ctx.Context.Response.Headers.CacheControl = "no-cache";
    else if (ctx.Context.Request.Path.StartsWithSegments("/assets"))
        ctx.Context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
}

app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = spaFiles });
app.UseStaticFiles(new StaticFileOptions { FileProvider = spaFiles, OnPrepareResponse = SpaCache });
app.UseCors("spa");

app.MapHub<LiveHub>("/hub/live");
app.MapDingoApi();
app.MapMcp();   // Streamable-HTTP MCP server at POST /mcp (+ GET /mcp/info, /mcp/skills)

// AI-client discovery: /llms.txt advertises the API + bundled MCP server; /AI-CONFIG.md is the
// config-surface design. Read from the SPA provider (embedded copy) first, then loose files.
IResult ServeDoc(string file, string mime)
{
    var fi = spaFiles.GetFileInfo(file);
    if (fi.Exists) { using var s = fi.CreateReadStream(); using var r = new StreamReader(s); return Results.Text(r.ReadToEnd(), mime); }
    foreach (var dir in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
    {
        var p = Path.Combine(dir, file);
        if (File.Exists(p)) return Results.Text(File.ReadAllText(p), mime);
    }
    return Results.NotFound();
}
app.MapGet("/llms.txt", () => ServeDoc("llms.txt", "text/markdown"));
app.MapGet("/AI-CONFIG.md", () => ServeDoc("AI-CONFIG.md", "text/markdown"));
// Address-agnostic CAN broadcast frame map (which ID offset + bits carry each signal). Served
// raw and via the MCP get_frame_map tool so an agent can decode the bus with no device bound.
app.MapGet("/can-frame-map.md", () => ServeDoc("can-frame-map.md", "text/markdown"));

// SPA fallback so a refresh on any route returns index.html (from the same provider).
app.MapFallbackToFile("index.html", new StaticFileOptions { FileProvider = spaFiles, OnPrepareResponse = SpaCache });

var isDevelopment = app.Environment.IsDevelopment();
const string url = "http://localhost:5000";
// The packaged exe keeps its console window open and only quits on a confirmed Q / Ctrl+C —
// so a stray key or window focus change never kills a live CAN session. In dev (dotnet run)
// or when stdin is redirected (service/background), use the normal host lifetime instead.
bool interactiveConsole = !isDevelopment && Environment.UserInteractive && !Console.IsInputRedirected;

try
{
    if (interactiveConsole)
    {
        await app.StartAsync();
        OpenBrowser(url);
        PrintBanner(url);
        await ConsoleQuitLoop(app, url);   // never throws; blocks here so the window stays open
        Console.WriteLine("Shutting down…");
        await app.StopAsync();
    }
    else
    {
        if (!isDevelopment) OpenBrowser(url);
        app.Run();
    }
}
catch (IOException ex) when (ex.InnerException is AddressInUseException)
{
    // Already running — just surface the existing instance.
    OpenBrowser(url);
}

// Keep the console window open until the operator confirms quit (Q / Ctrl+C). Crash-proof:
// if the console can't be read (some launch contexts), it just blocks instead of exiting, so
// the window never vanishes on its own.
static async Task ConsoleQuitLoop(WebApplication app, string url)
{
    var life = app.Services.GetRequiredService<IHostApplicationLifetime>();
    bool keys = true;
    try { Console.TreatControlCAsInput = true; } catch { keys = false; }
    while (!life.ApplicationStopping.IsCancellationRequested)
    {
        try
        {
            if (!keys) { await Task.Delay(500); continue; }          // can't read keys → just stay open
            if (!Console.KeyAvailable) { await Task.Delay(150); continue; }
            var key = Console.ReadKey(intercept: true);
            var wantsQuit = key.Key == ConsoleKey.Q ||
                (key.Modifiers.HasFlag(ConsoleModifiers.Control) && key.Key == ConsoleKey.C);
            if (!wantsQuit) continue;
            Console.Write("\nQuit dingoConfig and close the CAN link? (y/N): ");
            var ans = Console.ReadLine();
            if (ans?.Trim().StartsWith("y", StringComparison.OrdinalIgnoreCase) == true) return;
            Console.WriteLine($"Still running — {url}\n");
        }
        catch { keys = false; }   // console read failed — keep the window open rather than crash
    }
}

static void PrintBanner(string url)
{
    Console.WriteLine();
    Console.WriteLine("  ┌─────────────────────────────────────────────────┐");
    Console.WriteLine("  │  dingoConfig is running                         │");
    Console.WriteLine($"  │  Open:  {url,-40}│");
    Console.WriteLine("  │                                                 │");
    Console.WriteLine("  │  Keep this window open while you work.          │");
    Console.WriteLine("  │  Press  Q  or  Ctrl+C  to quit (asks first).    │");
    Console.WriteLine("  └─────────────────────────────────────────────────┘");
    Console.WriteLine();
}

static void OpenBrowser(string url)
{
    try
    {
        if (OperatingSystem.IsWindows())
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = url, UseShellExecute = true });
        else if (OperatingSystem.IsLinux())
            System.Diagnostics.Process.Start("xdg-open", url);
        else if (OperatingSystem.IsMacOS())
            System.Diagnostics.Process.Start("open", url);
    }
    catch { /* browser launch is best-effort */ }
}
