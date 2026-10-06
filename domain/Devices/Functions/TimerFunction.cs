using System.Text.Json.Serialization;
using domain.Common;
using domain.Enums;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

// Timer function (firmware #61, param base 0x1B00). One var-map input starts it; `Edge` picks
// which input level counts as active (Rising = true, Falling = false), `Mode` the PLC shape.
// Named TimerFunction (not Timer) so it never collides with System.Threading.Timer.
public class TimerFunction : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1B00;
    [JsonPropertyName("name")] public string Name {get; set; }
    [JsonPropertyName("number")] public int Number {get;}
    [JsonPropertyName("enabled")] public bool Enabled {get; set;}
    [JsonPropertyName("input")] public int Input {get; set;}
    // Rising = run while the input is on, Falling = while it's off. "Both" isn't a level, and the
    // firmware range is 0..1 (it would NAK the write) — coerce it to Rising.
    [JsonPropertyName("edge")] public InputEdge Edge { get => field; set => field = value == InputEdge.Both ? InputEdge.Rising : value; } = InputEdge.Rising;
    [JsonPropertyName("mode")] public TimerMode Mode {get; set;} = TimerMode.OnDelay;
    // ms; clamped to the firmware's TIMER_PARAMS range (0 … 1 h) so an out-of-range value can't be
    // silently NAKed by the device after the UI has already reported "saved".
    [JsonPropertyName("preset")] public int Preset { get => field; set => field = Math.Clamp(value, 0, 3600000); } = 1000;

    [JsonIgnore][Plotable(displayName:"State")] public bool Value {get; set;}

    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public TimerFunction(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
    }

    private List<DeviceParameter> InitParams()
    {
        var subIndex = 0;
        return
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"timer[{Number}].enabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"timer[{Number}].input", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Input, SetValue = val => Input = (int)val,
                ValueType = Input.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"timer[{Number}].edge", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Edge, SetValue = val => Edge = (InputEdge)val,
                ValueType = Edge.GetType(),
                DefaultValue = InputEdge.Rising
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"timer[{Number}].mode", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Mode, SetValue = val => Mode = (TimerMode)val,
                ValueType = Mode.GetType(),
                DefaultValue = TimerMode.OnDelay
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"timer[{Number}].preset", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Preset, SetValue = val => Preset = (int)val,
                ValueType = Preset.GetType(),
                DefaultValue = 1000
            }
        ];
    }
}
