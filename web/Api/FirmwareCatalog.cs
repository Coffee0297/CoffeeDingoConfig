using System.Text.Json;
using System.Text.RegularExpressions;
using domain.Firmware;
using domain.Interfaces;
using application.Services;

namespace web.Api;

/// <summary>
/// G7: the firmware releases of Coffee0297/CoffeeDingoFW on GitHub, with notes and one image per board and
/// path (.srec over CAN, .bin over USB). The list and every downloaded image are cached on disk, so a release
/// used once still works with no internet (in the workshop). POST /check reads an image the way a module
/// would judge it: the DINGO_BOARD marker inside, the version from the release file name.
/// </summary>
public static partial class FirmwareCatalog
{
    const string Repo = "Coffee0297/CoffeeDingoFW";
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    static readonly string CacheDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dingoConfig", "firmware");
    static readonly TimeSpan ListFresh = TimeSpan.FromMinutes(10);   // GitHub allows 60 unauthenticated calls an hour
    static (DateTime At, List<Release> List)? _list;

    public record Image(string Board, string Kind, string Name, long Size, string Url, bool Cached);
    public record Release(string Tag, string Version, string? Name, bool Prerelease, string? Published, string Notes, List<Image> Images);

    // release asset name -> board, kind: dingopdm_v7_FW_v5-5-112.srec, dingopdmmax_v1_FW_v5-5-112.bin, canboard_v2_FW_...
    [GeneratedRegex(@"^(dingopdm_v7|dingopdmmax_v1|canboard_v2)_FW_v(\d+)-(\d+)-(\d+)\.(srec|bin)$", RegexOptions.IgnoreCase)]
    private static partial Regex AssetName();
    static string BoardOf(string prefix) => prefix.ToLowerInvariant() switch
    {
        "dingopdm_v7" => "dingoPDM", "dingopdmmax_v1" => "dingoPDM-Max", _ => "CANBoard",
    };

    public static void MapFirmwareCatalog(this WebApplication app)
    {
        var api = app.MapGroup("/api/firmware");

        // ?refresh=true skips the 10 min cache. offline=true: GitHub could not be reached, this is the saved list.
        api.MapGet("/releases", async (bool? refresh) =>
        {
            try { return Results.Ok(new { offline = false, releases = await ReleasesAsync(refresh == true) }); }
            catch (Exception e)
            {
                var saved = LoadSavedList();
                return saved is null
                    ? Results.Json(new { offline = true, releases = Array.Empty<Release>(), error = $"Could not reach GitHub ({e.Message}) and no release list is saved yet." }, statusCode: 503)
                    : Results.Ok(new { offline = true, releases = Mark(saved), error = $"Could not reach GitHub ({e.Message}). Showing the saved list." });
            }
        });

        // One image: from the cache, else downloaded once and kept.
        api.MapGet("/releases/{tag}/{name}", async (string tag, string name) =>
        {
            if (!SafeName(tag) || !AssetName().IsMatch(name)) return Results.BadRequest(new { error = "unknown release file" });
            var path = Path.Combine(CacheDir, tag, name);
            if (!File.Exists(path))
            {
                var rel = (_list?.List ?? LoadSavedList() ?? []).FirstOrDefault(r => r.Tag == tag)
                          ?? (await ReleasesAsync(false)).FirstOrDefault(r => r.Tag == tag);
                var img = rel?.Images.FirstOrDefault(i => i.Name == name);
                if (img is null) return Results.NotFound(new { error = $"{name} is not in release {tag}" });
                try
                {
                    var bytes = await Http.GetByteArrayAsync(img.Url);
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    await File.WriteAllBytesAsync(path + ".part", bytes);
                    File.Move(path + ".part", path, overwrite: true);
                }
                catch (Exception e) { return Results.Json(new { error = $"Could not download {name}: {e.Message}" }, statusCode: 503); }
            }
            return Results.File(path, "application/octet-stream", name);
        });

        // Pre-flight for one image: POST the file as the body, ?name=<file name>. Which board the image says it is
        // for, the version, and which modules in the project it fits.
        api.MapPost("/check", async (HttpRequest req, string? name, DeviceManager dm) =>
        {
            using var ms = new MemoryStream();
            await req.Body.CopyToAsync(ms);
            return Results.Ok(Check(ms.ToArray(), name ?? "", dm.GetAllDevices()));
        });
    }

    /// <summary>Board marker, version and fitting modules for one image (pure; unit-testable).</summary>
    public static object Check(byte[] data, string name, IEnumerable<IDevice> devices)
    {
        var problems = new List<string>();
        var isSrec = name.EndsWith(".srec", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".s19", StringComparison.OrdinalIgnoreCase);
        string? marker = null;
        if (isSrec)
        {
            try { marker = SRecordImage.ParseText(System.Text.Encoding.ASCII.GetString(data)).BoardMarker(); }
            catch (InvalidDataException) { problems.Add("Not an S-record image: it has no data records."); }
        }
        else
        {
            var key = "DINGO_BOARD="u8;
            int i = data.AsSpan().IndexOf(key);
            if (i >= 0)
            {
                int start = i + key.Length, end = Array.IndexOf(data, (byte)0, start);
                var s = System.Text.Encoding.ASCII.GetString(data, start, (end < 0 ? data.Length : end) - start);
                marker = s.StartsWith("Dingo Electronics ") ? s["Dingo Electronics ".Length..] : s;
            }
        }
        var m = AssetName().Match(name);
        var nameBoard = m.Success ? BoardOf(m.Groups[1].Value) : null;
        var version = m.Success ? $"{m.Groups[2].Value}.{m.Groups[3].Value}.{m.Groups[4].Value}" : null;
        var board = marker is null ? nameBoard : Regex.Replace(marker, @"\s+v\d+$", "");
        if (marker is null) problems.Add("The image carries no board marker (firmware before 5.5.109): only the file name says which board it is for.");
        else if (nameBoard is not null && !SRecordImage.BoardMatches(marker, nameBoard)) problems.Add($"The file name says {nameBoard}, but the image is built for {board}.");
        if (version is null) problems.Add("The file name does not give a version.");
        var modules = board is null ? [] : devices.Where(d => SRecordImage.BoardMatches(board, d.Type))
            .Select(d => new { guid = d.Guid, name = d.Name, current = CurrentVersion(d) }).ToList<object>();
        return new { name, kind = isSrec ? "srec" : "bin", size = data.Length, board, marker, version, modules, problems };
    }

    static string? CurrentVersion(IDevice d) => d switch
    {
        domain.Devices.dingoPdm.PdmDevice p => p.Version,
        domain.Devices.Canboard.CanboardDevice c => c.Version,
        _ => null,
    };

    static async Task<List<Release>> ReleasesAsync(bool refresh)
    {
        if (!refresh && _list is { } l && DateTime.UtcNow - l.At < ListFresh) return Mark(l.List);
        using var req = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repo}/releases?per_page=30");
        req.Headers.UserAgent.ParseAdd("dingoConfig");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var res = await Http.SendAsync(req);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var list = new List<Release>();
        foreach (var r in doc.RootElement.EnumerateArray())
        {
            var tag = r.GetProperty("tag_name").GetString() ?? "";
            if (!SafeName(tag)) continue;
            var images = new List<Image>();
            foreach (var a in r.GetProperty("assets").EnumerateArray())
            {
                var n = a.GetProperty("name").GetString() ?? "";
                var m = AssetName().Match(n);
                if (!m.Success) continue;
                images.Add(new Image(BoardOf(m.Groups[1].Value), m.Groups[5].Value.ToLowerInvariant(), n,
                    a.GetProperty("size").GetInt64(), a.GetProperty("browser_download_url").GetString() ?? "", false));
            }
            if (images.Count == 0) continue;
            list.Add(new Release(tag, tag.TrimStart('v'), r.GetProperty("name").GetString(), r.GetProperty("prerelease").GetBoolean(),
                r.GetProperty("published_at").GetString(), r.GetProperty("body").GetString() ?? "", images));
        }
        _list = (DateTime.UtcNow, list);
        try { Directory.CreateDirectory(CacheDir); File.WriteAllText(Path.Combine(CacheDir, "releases.json"), JsonSerializer.Serialize(list)); }
        catch { /* the cache is a convenience */ }
        return Mark(list);
    }

    static List<Release>? LoadSavedList()
    {
        try { return JsonSerializer.Deserialize<List<Release>>(File.ReadAllText(Path.Combine(CacheDir, "releases.json"))); }
        catch { return null; }
    }

    // which images are already on this PC
    static List<Release> Mark(List<Release> list) =>
        list.Select(r => r with { Images = r.Images.Select(i => i with { Cached = File.Exists(Path.Combine(CacheDir, r.Tag, i.Name)) }).ToList() }).ToList();

    static bool SafeName(string s) => s.Length is > 0 and < 64 && s.All(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_');
}
