using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>A module added fresh that answers 5.7.0 holds the firmware's own defaults, so its first Read shows no
/// differences. Fixtures/fw57-defaults-*.txt are stParams[] dumped from the integration/all-features ELFs
/// (Fixtures/fw_defaults.py); regenerate them when the firmware's defaults change.</summary>
public class FreshDefaultsTests
{
    private static string Dir([CallerFilePath] string f = "") => Path.GetDirectoryName(f)!;

    private static JsonElement Defs(string kind) => JsonDocument.Parse(File.ReadAllText(Path.Combine(Dir(), "..", "web", "pdm-definitions.json")))
        .RootElement.GetProperty(kind);

    private static readonly JsonSerializerOptions Opts = new() { PropertyNameCaseInsensitive = true };

    private static IDeviceConfigurable Fresh(string board)
    {
        var q = new ConcurrentDictionary<(int, int, int), DeviceCanFrame>();
        byte[] v570 = [31, 0, 0, 0, 5, 7, 0, 0];
        if (board == "canboard_v2")
        {
            var c = new CanboardDevice(Defs("canboards")[0].Deserialize<CanboardDeviceDefinition>(Opts)!, "CB", 0x660);
            c.SetLogger(NullLogger<CanboardDevice>.Instance);
            c.Read(0x660, v570, ref q, []);
            return c;
        }
        var type = board switch { "dingopdm_v7" => 0, "dingopdmmax_v1" => 1, _ => 2 };
        var def = Defs("pdms").EnumerateArray().Select(e => e.Deserialize<PdmDeviceDefinition>(Opts)!).Single(d => d.PdmType == type);
        var p = new PdmDevice(def, "PDM", 0x680);
        p.SetLogger(NullLogger<PdmDevice>.Instance);
        p.Read(0x680, v570, ref q, []);
        return p;
    }

    // The wire value as the app's Read decodes it (ParamProtocol ReadAllRsp)
    private static object Decode(DeviceParameter p, uint raw) =>
        p.ValueType == typeof(double) ? (double)BitConverter.UInt32BitsToSingle(raw)
        : p.ValueType == typeof(bool) ? raw != 0
        : p.ValueType.IsEnum ? Enum.ToObject(p.ValueType, (int)raw)
        : p.ValueType == typeof(int) ? (int)raw
        : raw;

    [Theory]
    [InlineData("dingopdm_v7")]
    [InlineData("dingopdmmax_v1")]
    [InlineData("pt-dpdm4_1")]
    [InlineData("canboard_v2")]
    public void FreshModule_On57_HoldsTheFirmwareDefaults(string board)
    {
        var d = Fresh(board);
        var diffs = new List<string>();
        foreach (var line in File.ReadLines(Path.Combine(Dir(), "Fixtures", $"fw57-defaults-{board}.txt")))
        {
            var f = line.Split(' ');
            int index = Convert.ToInt32(f[0], 16), sub = int.Parse(f[1]);
            if (index == 0 && sub == 0) continue;   // the base id is the module's address, not a default
            var p = d.Params.FirstOrDefault(x => x.Index == index && x.SubIndex == sub);
            if (p is null || p.WriteOnly) continue;   // no model in the app: sent back raw
            var fw = Decode(p, Convert.ToUInt32(f[3], 16));
            var app = p.GetValue();
            if (fw is double a ? Math.Abs(a - Convert.ToDouble(app)) > 1e-4 : !Equals(fw, app))
                diffs.Add($"{p.Name} (0x{index:X4}:{sub}) app={app} fw={fw}");
        }
        Assert.True(diffs.Count == 0, string.Join("\n", diffs));
    }
}
