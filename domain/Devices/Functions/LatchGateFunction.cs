using System.Text.Json.Serialization;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public enum LatchGateType { Latch = 0, Gate = 1 }

// Latch / Gate (upstream dingoFW feat/latch-gate-block, param base 0x2600, 8 per PDM, none on the CANBoard).
// Latch: on at a rising edge of Input, off at a rising edge of ControlInput (wins in the same cycle) or TimeMs after
// the last set (0 = never). Gate: follows Input while ControlInput is on, holds the last value while it is off.
// Wire layout: sub 0 enabled, 1 type, 2 input, 3 control input, 4 time (ms, 0..600000).
public class LatchGateFunction : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2600;
    [JsonIgnore] public const int MaxTimeMs = 600000;
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("number")] public int Number { get; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("type")] public LatchGateType Type { get; set; } = LatchGateType.Latch;
    [JsonPropertyName("input")] public int Input { get; set; }
    [JsonPropertyName("controlInput")] public int ControlInput { get; set; }
    [JsonPropertyName("timeMs")] public int TimeMs { get => field; set => field = Math.Clamp(value, 0, MaxTimeMs); }

    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public LatchGateFunction(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
    }

    private List<DeviceParameter> InitParams()
    {
        var i = BaseIndex + (Number - 1);
        var n = $"latchGate[{Number}]";
        return
        [
            new() { ParentName = Name, Name = $"{n}.enabled", Index = i, SubIndex = 0, GetValue = () => Enabled, SetValue = v => Enabled = (bool)v, ValueType = typeof(bool), DefaultValue = false },
            new() { ParentName = Name, Name = $"{n}.type", Index = i, SubIndex = 1, GetValue = () => Type, SetValue = v => Type = (LatchGateType)v, ValueType = typeof(LatchGateType), DefaultValue = LatchGateType.Latch },
            new() { ParentName = Name, Name = $"{n}.input", Index = i, SubIndex = 2, GetValue = () => Input, SetValue = v => Input = (int)v, ValueType = typeof(int), DefaultValue = 0 },
            new() { ParentName = Name, Name = $"{n}.controlInput", Index = i, SubIndex = 3, GetValue = () => ControlInput, SetValue = v => ControlInput = (int)v, ValueType = typeof(int), DefaultValue = 0 },
            new() { ParentName = Name, Name = $"{n}.timeMs", Index = i, SubIndex = 4, GetValue = () => TimeMs, SetValue = v => TimeMs = (int)v, ValueType = typeof(int), DefaultValue = 0 },
        ];
    }
}
