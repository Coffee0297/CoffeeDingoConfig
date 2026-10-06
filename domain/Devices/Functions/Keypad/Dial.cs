using System.Text.Json.Serialization;
using domain.Enums;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions.Keypad;

public class Dial : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x3200;
    [JsonPropertyName("name")] public string Name {get; set; }
    [JsonPropertyName("keypadNumber")] public int KeypadNumber {get;}
    [JsonPropertyName("number")] public int Number {get;}
    [JsonPropertyName("enabled")] public bool Enabled {get; set;}
    // Firmware KEYPAD_DIAL_PARAMS range is 0 … 16 (16-LED ring); an out-of-range write is silently rejected.
    [JsonPropertyName("minCount")] public int MinCount { get => field; set => field = Math.Clamp(value, 0, 16); }
    [JsonPropertyName("maxCount")] public int MaxCount { get => field; set => field = Math.Clamp(value, 0, 16); } = 16;
    [JsonPropertyName("ledOffset")] public int LedOffset { get => field; set => field = Math.Clamp(value, 0, 16); }
    [JsonIgnore] public int TopPosition { get; set; } = 8; //Default = 8
    
    [JsonIgnore] public List<DeviceParameter> Params { get; set; } = null!;
    
    [JsonConstructor]
    public Dial(int keypadNumber, int number, string name)
    {
        KeypadNumber = keypadNumber;
        Number = number;
        Name = name;

        InitParams();
    }

    private void InitParams()
    {
        Params = new List<DeviceParameter>();
        var subIndex = 0;
        Params.AddRange(
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"keypad[{KeypadNumber}].dial[{Number}].enabled", 
                Index = BaseIndex + ((KeypadNumber - 1) * 4) + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"keypad[{KeypadNumber}].dial[{Number}].minCount", 
                Index = BaseIndex + ((KeypadNumber - 1) * 4) + (Number - 1), SubIndex = subIndex++,
                GetValue = () => MinCount, SetValue = val => MinCount = (int)val,
                ValueType = MinCount.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"keypad[{KeypadNumber}].dial[{Number}].maxCount", 
                Index = BaseIndex + ((KeypadNumber - 1) * 4) + (Number - 1), SubIndex = subIndex++,
                GetValue = () => MaxCount, SetValue = val => MaxCount = (int)val,
                ValueType = MaxCount.GetType(),
                DefaultValue = 16
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"keypad[{KeypadNumber}].dial[{Number}].ledOffset", 
                Index = BaseIndex + ((KeypadNumber - 1) * 4) + (Number - 1), SubIndex = subIndex++,
                GetValue = () => LedOffset, SetValue = val => LedOffset = (int)val,
                ValueType = LedOffset.GetType(),
                DefaultValue = 0
            }
        ]);
    }
}