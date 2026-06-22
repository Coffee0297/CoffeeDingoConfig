using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

// Linear sensor scaling: scaled = Gain * mV + Offset. Gain/Offset are sent to the firmware, which
// publishes the scaled value in its variable map so outputs/conditions can use it (e.g. a fan driven
// by a temperature sensor). The two calibration points are kept project-side so the UI can recompute
// and re-edit them; the firmware only needs Gain and Offset.
[method: JsonConstructor]
public class AnalogScale(int number, string name) : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2200;
    [JsonPropertyName("number")] public int Number { get; set; } = number;
    [JsonPropertyName("name")] public string Name { get; set; } = name;
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("gain")] public double Gain { get; set; }       // engineering units per mV (sent to device)
    [JsonPropertyName("offset")] public double Offset { get; set; }   // engineering units at 0 mV (sent to device)

    // Two-point calibration + label — project-side only; the UI computes Gain/Offset from these.
    [JsonPropertyName("inLowMv")] public double InLowMv { get; set; }
    [JsonPropertyName("outLow")] public double OutLow { get; set; }
    [JsonPropertyName("inHighMv")] public double InHighMv { get; set; } = 5000;
    [JsonPropertyName("outHigh")] public double OutHigh { get; set; } = 100;
    [JsonPropertyName("units")] public string Units { get; set; } = "";

    [JsonIgnore][Plotable(displayName:"Scaled")] public double Scaled { get; set; }

    [JsonIgnore] public List<DeviceParameter> Params { get; } = null!;

    public List<DeviceParameter> InitParams(ref int subIndex)
    {
        return
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"analogScale[{Number}].enabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(), DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"analogScale[{Number}].gain", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Gain, SetValue = val => Gain = (double)val,
                ValueType = Gain.GetType(), DefaultValue = 0.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"analogScale[{Number}].offset", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Offset, SetValue = val => Offset = (double)val,
                ValueType = Offset.GetType(), DefaultValue = 0.0
            }
        ];
    }
}
