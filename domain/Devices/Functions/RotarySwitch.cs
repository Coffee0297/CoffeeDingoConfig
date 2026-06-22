using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public class RotarySwitch(int number, string name) : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2200;
    [JsonIgnore] public const int MaxPositions = 10;   // matches firmware MAX_SWITCH_POS

    [JsonPropertyName("number")] public int Number { get; set; } = number;
    [JsonPropertyName("name")] public string Name { get; set; } = name;
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("invert")] public bool Invert { get; set; }

    // Calibrated per-position decode (uneven switches): each position has a centre voltage (mV);
    // a position registers within ±tolerance, capped at the midpoint to its neighbours. The point
    // voltages are sent to the firmware PACKED two per 32-bit word (CanBoard flash is tight).
    [JsonPropertyName("numPos")] public int NumPos { get; set; } = 2;
    [JsonPropertyName("tolerance")] public int Tolerance { get; set; } = 200;
    [JsonPropertyName("points")] public int[] Points { get; set; } = new int[MaxPositions];   // mV per position
    // Position labels — project-side only (the firmware doesn't store names); not a device param.
    [JsonPropertyName("positionNames")] public string[] PositionNames { get; set; } = new string[MaxPositions];

    [JsonIgnore][Plotable(displayName:"Pos")] public int Pos { get; set; }

    [JsonIgnore] public List<DeviceParameter> Params { get; } = null!;

    private int PointAt(int k) => k >= 0 && k < Points.Length ? Points[k] : 0;
    private void SetPointAt(int k, int v) { if (k >= 0 && k < Points.Length) Points[k] = v; }

    public List<DeviceParameter> InitParams(ref int subIndex)
    {
        List<DeviceParameter> list =
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].enabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(), DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].invert", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Invert, SetValue = val => Invert = (bool)val,
                ValueType = Invert.GetType(), DefaultValue = false
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
        // Calibrated point voltages, packed two per 32-bit word: low half = even position, high half = odd.
        for (var p = 0; p < MaxPositions / 2; p++)
        {
            var lo = p * 2;
            var hi = p * 2 + 1;
            list.Add(new DeviceParameter
            {
                ParentName = Name, Name = $"rotarySwitch[{Number}].pointPair[{p}]", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => (PointAt(lo) & 0xFFFF) | ((PointAt(hi) & 0xFFFF) << 16),
                SetValue = val => { var w = Convert.ToInt32(val); SetPointAt(lo, w & 0xFFFF); SetPointAt(hi, (w >> 16) & 0xFFFF); },
                ValueType = typeof(int), DefaultValue = 0
            });
        }
        return list;
    }
}
