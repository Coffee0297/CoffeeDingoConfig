using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public class AnalogInput : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2200;
    [JsonPropertyName("number")] public int Number { get; set; }

    [JsonPropertyName("name")]
    public string Name
    {
        get;
        set
        {
            Switch?.Name = value;
            Rotary?.Name = value;
            Scale?.Name = value;
            field = value;
        }
    }

    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("switch")] public AnalogSwitch Switch { get; set; }
    [JsonPropertyName("rotary")] public RotarySwitch Rotary { get; set; }
    [JsonPropertyName("scale")] public AnalogScale Scale { get; set; }
    
    [JsonIgnore][Plotable(displayName:"Millivolts")] public double Millivolts { get; set; }
    
    // Built on every read: the JSON reader replaces Switch/Rotary/Scale after the constructor runs, so a list
    // captured there would read and write the constructor's default objects (a loaded project then wrote
    // every rotary/switch/scale setting as its default).
    [JsonIgnore] public List<DeviceParameter> Params => InitParams();
    
    [JsonConstructor]
    public AnalogInput(int number, string name)
    {
        Number = number;
        Name = name;
        
        Switch = new AnalogSwitch(number, name);
        Rotary = new RotarySwitch(number, name);
        Scale = new AnalogScale(number, name);
    }
    
    private List<DeviceParameter> InitParams()
    {
        var allParams = new List<DeviceParameter>();
        var subIndex = 0;
        allParams.AddRange(

            new DeviceParameter
            {
                ParentName = Name, Name = $"analogInput[{Number}].enabled", Index = BaseIndex + (Number - 1),
                SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(),
                DefaultValue = false
            }
        );

        allParams.AddRange(Switch.InitParams(ref subIndex));
        allParams.AddRange(Rotary.InitParams(ref subIndex));
        allParams.AddRange(Scale.InitParams(ref subIndex));

        return allParams;
    }
}