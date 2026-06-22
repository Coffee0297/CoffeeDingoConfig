using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public class RotarySwitch(int number, string name) : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2200;
    [JsonPropertyName("number")] public int Number { get; set; } = number;
    [JsonPropertyName("name")] public string Name { get; set; } = name;
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("invert")] public bool Invert { get; set; }
    [JsonPropertyName("fOffset")] public double Offset { get; set; }
    [JsonPropertyName("fStep")] public double Step { get; set; }
    [JsonPropertyName("fMaxPos")] public double MaxPos { get; set; }

    // Calibrated per-position decode (uneven switches): each position has a centre voltage (mV);
    // a position registers within ±tolerance, capped at the midpoint to its neighbours.
    [JsonPropertyName("usePoints")] public bool UsePoints { get; set; }
    [JsonPropertyName("numPos")] public int NumPos { get; set; } = 2;
    [JsonPropertyName("tolerance")] public int Tolerance { get; set; } = 200;
    [JsonPropertyName("points")] public int[] Points { get; set; } = new int[12];   // mV per position (matches firmware MAX_SWITCH_POS)
    // Position labels — project-side only (the firmware doesn't store names); not a device param.
    [JsonPropertyName("positionNames")] public string[] PositionNames { get; set; } = new string[12];

    [JsonIgnore][Plotable(displayName:"Pos")] public int Pos { get; set; }
    
    [JsonIgnore] public List<DeviceParameter> Params { get; } = null!;

    public List<DeviceParameter> InitParams(ref int subIndex)
    {
        List<DeviceParameter> list =
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].enabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].invert", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Invert, SetValue = val => Invert = (bool)val,
                ValueType = Invert.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].offset", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Offset, SetValue = val => Offset = (double)val,
                ValueType = Offset.GetType(),
                DefaultValue = 0.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].step", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Step, SetValue = val => Step = (double)val,
                ValueType = Step.GetType(),
                DefaultValue = 100.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].maxpos", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => MaxPos, SetValue = val => MaxPos = (double)val,
                ValueType = MaxPos.GetType(),
                DefaultValue = 10.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].usePoints", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => UsePoints, SetValue = val => UsePoints = (bool)val,
                ValueType = UsePoints.GetType(), DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].numpos", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => NumPos, SetValue = val => NumPos = (int)val,
                ValueType = NumPos.GetType(), DefaultValue = 2
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].tolerance", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Tolerance, SetValue = val => Tolerance = (int)val,
                ValueType = Tolerance.GetType(), DefaultValue = 200
            }
        ];
        // One param per calibrated point voltage (firmware subindices 13..24).
        for (var k = 0; k < Points.Length; k++)
        {
            var idx = k;
            list.Add(new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].point[{idx}]", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Points[idx], SetValue = val => Points[idx] = (int)val,
                ValueType = typeof(int), DefaultValue = 0
            });
        }
        return list;
    }
}