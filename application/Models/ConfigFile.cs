using System.Text.Json;
using System.Text.Json.Serialization;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Generic;
using domain.Devices.Keypad.BlinkMarine;
using domain.Devices.Keypad.Grayhill;

namespace application.Models;

/// <summary>
/// Configuration file model that contains separate lists for each device type
/// </summary>
public class ConfigFile
{
    public List<PdmDevice> PdmDevices { get; set; } = new();
    public List<CanboardDevice> CanboardDevices { get; set; } = new();
    public List<DbcDevice> DbcDevices { get; set; } = new();
    public List<BlinkMarineKeypadDevice> BlinkMarineKeypads { get; set; } = new();
    public List<GrayhillKeypadDevice> GrayhillKeypads { get; set; } = new();

    // G4: what the app keeps outside the modules (car-map and canvas positions, function records, groups,
    // dismissed suggestions, cross-module functions, Lua snippets). Opaque to the server; same key the
    // browser-download copy has always used.
    [JsonPropertyName("dingoConfigClient"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Client { get; set; }
}
