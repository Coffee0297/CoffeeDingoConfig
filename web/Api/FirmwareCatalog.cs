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

    public record Image(string Board, string Kind, string Name, long Size, string Url, bool Cached, bool Full = false);
    public record Release(string Tag, string Version, string? Name, bool Prerelease, string? Published, string Notes, List<Image> Images);

    // release asset name -> board, kind: dingopdm_v7_FW_v5-5-112.srec, dingopdmmax_v1_FW_v5-5-112.bin, canboard_v2_FW_...
    // _FULL_ (5.7.1 on): the OpenBLT bootloader and the app in one image from 0x08000000, for a blank board (SWD / DFU)
    // .hex: upstream dingoFW releases (no .srec); it goes over CAN like a .srec when it starts at 0x08004000
    [GeneratedRegex(@"^(dingopdm_v7|dingopdmmax_v1|canboard_v2)_(?:FW|FULL)_v(\d+)-(\d+)-(\d+)\.(srec|bin|hex)$", RegexOptions.IgnoreCase)]
    private static partial Regex AssetName();
    [GeneratedRegex(@"v(\d+)[.-](\d+)[.-](\d+)\.(srec|s19|bin|hex)$", RegexOptions.IgnoreCase)]
    private static partial Regex NameVersion();
    static bool IsFull(string name) => name.Contains("_FULL_", StringComparison.OrdinalIgnoreCase);
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
        var isHex = name.EndsWith(".hex", StringComparison.OrdinalIgnoreCase);
        IEnumerable<byte[]> blocks = [data];
        // where the image starts: 0x08004000 = an app built for the OpenBLT bootloader, 0x08000000 = a full image. With
        // no DINGO_FW marker (upstream dingoFW) this is what tells a CAN-flashable image from one for USB only.
        uint? address = isSrec || isHex ? null : DfuImage.FlashAddress(data);
        if (isSrec || isHex)
        {
            try
            {
                var img = SRecordImage.ParseText(System.Text.Encoding.ASCII.GetString(data));
                blocks = img.Segments.Select(s => s.Data).ToList();
                address = img.MinAddress;
            }
            catch (InvalidDataException) { problems.Add($"Not {(isHex ? "an Intel HEX" : "an S-record")} image: it has no data records."); blocks = []; }
        }
        var marker = SRecordImage.BoardName(SRecordImage.Marker(blocks, "DINGO_BOARD="));
        var imageVersion = SRecordImage.Marker(blocks, "DINGO_FW=");
        var m = AssetName().Match(name);
        var nameBoard = m.Success ? BoardOf(m.Groups[1].Value) : null;
        // the image says which version it is (5.6.4 on); older images only by name: "…_FW_v5-6-4.bin", "…_v5.6.4.bin"
        var nv = NameVersion().Match(name);
        var nameVersion = nv.Success ? $"{nv.Groups[1].Value}.{nv.Groups[2].Value}.{nv.Groups[3].Value}" : null;
        var version = imageVersion ?? nameVersion;
        if (imageVersion is not null && nameVersion is not null && imageVersion != nameVersion) problems.Add($"The file name says {nameVersion}, but the image is {imageVersion}.");
        var board = marker is null ? nameBoard : Regex.Replace(marker, @"\s+v\d+$|(?<=^PT-DPDM)\d+$", "");
        if (marker is null) problems.Add("The image carries no board marker (stock upstream dingoFW, or older firmware): only the file name says which board it is for.");
        else if (nameBoard is not null && !SRecordImage.BoardMatches(marker, nameBoard)) problems.Add($"The file name says {nameBoard}, but the image is built for {board}.");
        if (version is null) problems.Add("Neither the image nor the file name gives a version.");
        var cb = board is not null && board.Contains("CANBoard", StringComparison.OrdinalIgnoreCase);
        var relocated = address is uint ra && DfuImage.IsAppBase(ra, cb);
        var full = IsFull(name) && address == 0x08000000;
        if (full)
            problems.Add("Bootloader and app in one image: for a blank board over SWD or USB DFU, not for an update (it would rewrite the bootloader).");
        else if ((isSrec || isHex) && address is uint a && !relocated)
            problems.Add($"It starts at 0x{a:X8}, not 0x{DfuImage.AppBase:X8}{(cb ? $" or 0x{DfuImage.CanboardAppBase:X8}" : "")}: not built for the CAN bootloader, so it cannot go over CAN (and over USB it would replace the bootloader).");
        if (cb && address == DfuImage.CanboardAppBase)
            problems.Add("Built for the new 8 KB CANBoard bootloader (app at 0x08002000, firmware 5.7). Each CANBoard needs that bootloader programmed once over SWD first: with the old 16 KB one the update fails and the module stays in its bootloader.");
        var fits = board is null ? [] : devices.Where(d => SRecordImage.BoardMatches(board, d.Type)).ToList();
        var modules = fits.Select(d => new { guid = d.Guid, name = d.Name, current = CurrentVersion(d) }).ToList<object>();
        // upstream dingoFW (0.x) <-> the fork (5.x): another param layout, the module starts from its defaults
        var imageFamily = SRecordImage.FamilyOf(version);
        var switching = fits.Where(d => SRecordImage.FamilyOf(CurrentVersion(d)) is { } f && imageFamily is not null && f != imageFamily && CurrentVersion(d) != "v0.0.0").Select(d => d.Name).ToList();
        if (switching.Count > 0)
            problems.Add(SRecordImage.FamilyOf(version) == "upstream" && !version!.TrimStart('v').StartsWith("0.")
                ? $"This is {version}, the 5.7 line (new settings layout); {string.Join(", ", switching)} run{(switching.Count == 1 ? "s" : "")} fork 5.x. The module starts from its defaults: when it reports {version} the app converts this project to the 5.7 layout (see the module's migration report). Then Read, Apply to car and Store."
                : $"This is {(imageFamily == "upstream" ? "upstream dingoFW" : "the dingoFW fork")} {version}; {string.Join(", ", switching)} run{(switching.Count == 1 ? "s" : "")} the {(imageFamily == "upstream" ? "fork" : "upstream firmware")}. Its settings do not carry over: after the update Read the module, then Apply and Store the project again.");
        return new { name, kind = isSrec ? "srec" : isHex ? "hex" : "bin", size = data.Length, board, marker, version, modules, problems,
            address = address is uint ad ? $"0x{ad:X8}" : null, relocated, full };
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
                    a.GetProperty("size").GetInt64(), a.GetProperty("browser_download_url").GetString() ?? "", false, IsFull(n)));
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
