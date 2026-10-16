using System.Text.Json.Serialization;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

// Comfort blink (lane change) (firmware 5.6.1, param base 0x1F00, one per module). A short tap of the turn lever
// blinks Blinks times and stops; held longer than TapMs it is a normal blink that stops on release; a tap the
// other way during a comfort blink cancels it. Blinks are counted on the shared indicator clock (ClockInput), so
// each module running its own copy stops on the same blink. Var-map signals Left / Right = "indicator on".
public class ComfortBlink : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1F00;
    [JsonIgnore] public static readonly Version Since = new(5, 6, 1);
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("number")] public int Number => 1;
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("leftInput")] public int LeftInput { get; set; }
    [JsonPropertyName("rightInput")] public int RightInput { get; set; }
    [JsonPropertyName("clockInput")] public int ClockInput { get; set; }
    [JsonPropertyName("tapMs")] public int TapMs { get => field; set => field = Math.Clamp(value, 100, 5000); } = 1000;
    [JsonPropertyName("blinks")] public int Blinks { get => field; set => field = Math.Clamp(value, 1, 10); } = 3;

    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public ComfortBlink(string name)
    {
        Name = name;
        Params = InitParams();
    }

    private List<DeviceParameter> InitParams()
    {
        var v = Since;
        const string n = "comfortBlink";
        return
        [
            new() { ParentName = Name, Name = $"{n}.enabled", Index = BaseIndex, SubIndex = 0, GetValue = () => Enabled, SetValue = x => Enabled = (bool)x, ValueType = typeof(bool), DefaultValue = false, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.leftInput", Index = BaseIndex, SubIndex = 1, GetValue = () => LeftInput, SetValue = x => LeftInput = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.rightInput", Index = BaseIndex, SubIndex = 2, GetValue = () => RightInput, SetValue = x => RightInput = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.clockInput", Index = BaseIndex, SubIndex = 3, GetValue = () => ClockInput, SetValue = x => ClockInput = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.tapMs", Index = BaseIndex, SubIndex = 4, GetValue = () => TapMs, SetValue = x => TapMs = (int)x, ValueType = typeof(int), DefaultValue = 1000, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.blinks", Index = BaseIndex, SubIndex = 5, GetValue = () => Blinks, SetValue = x => Blinks = (int)x, ValueType = typeof(int), DefaultValue = 3, MinFirmware = v },
        ];
    }
}
