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
    // Firmware ranges (ANALOG_INPUT_PARAMS): 2 … MAX_SWITCH_POS positions, tolerance 0 … 5000 mV;
    // an out-of-range write is silently rejected.
    [JsonPropertyName("numPos")] public int NumPos { get => field; set => field = Math.Clamp(value, 2, MaxPositions); } = 2;
    [JsonPropertyName("tolerance")] public int Tolerance { get => field; set => field = Math.Clamp(value, 0, 5000); } = 200;
    [JsonPropertyName("points")] public int[] Points { get; set; } = new int[MaxPositions];   // mV per position
    // Position labels — project-side only (the firmware doesn't store names); not a device param.
    [JsonPropertyName("positionNames")] public string[] PositionNames { get; set; } = new string[MaxPositions];

    // Upstream dingoFW's uniform decode (0x2200 sub 7-9): position = (mV - offset) / step, at most maxPos.
    [JsonPropertyName("offsetMv")] public double OffsetMv { get; set; }
    [JsonPropertyName("stepMv")] public double StepMv { get => field; set => field = Math.Max(value, 1e-6); } = 100;
    [JsonPropertyName("maxPos")] public double MaxPos { get => field; set => field = Math.Max(value, 0); } = 10;
    // Upstream feat/analog-calibrated-switch (sub 13): 0 = uniform (above), 1 = calibrated (NumPos / Tolerance /
    // Points at sub 14-20, same packing as the fork). The fork's rotary is always calibrated.
    [JsonPropertyName("mode")] public int Mode { get => field; set => field = Math.Clamp(value, 0, 1); }

    [JsonIgnore][Plotable(displayName:"Pos")] public int Pos { get; set; }

    /// <summary>Upstream layout: enabled, invert, then offset / step / max position (floats); then the calibrated
    /// mode at sub 13-15 and the position voltages from sub 16 (a module without feat/analog-calibrated-switch drops
    /// them by its param list). 5.7: packed two per word at sub 16-20; 5.8 (<paramref name="fw58"/>): one centre (mV)
    /// per position at sub 16-25.</summary>
    public List<DeviceParameter> UpstreamParams(ref int subIndex, bool fw58 = false)
    {
        var idx = BaseIndex + (Number - 1);
        return
        [
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].enabled", Index = idx, SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val, ValueType = typeof(bool), DefaultValue = false },
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].invert", Index = idx, SubIndex = subIndex++,
                GetValue = () => Invert, SetValue = val => Invert = (bool)val, ValueType = typeof(bool), DefaultValue = false },
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].offsetMv", Index = idx, SubIndex = subIndex++,
                GetValue = () => OffsetMv, SetValue = val => OffsetMv = Convert.ToDouble(val), ValueType = typeof(double), DefaultValue = 0.0 },
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].stepMv", Index = idx, SubIndex = subIndex++,
                GetValue = () => StepMv, SetValue = val => StepMv = Convert.ToDouble(val), ValueType = typeof(double), DefaultValue = 100.0 },
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].maxPos", Index = idx, SubIndex = subIndex++,
                GetValue = () => MaxPos, SetValue = val => MaxPos = Convert.ToDouble(val), ValueType = typeof(double), DefaultValue = 10.0 },
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].mode", Index = idx, SubIndex = 13,
                GetValue = () => Mode, SetValue = val => Mode = Convert.ToInt32(val), ValueType = typeof(int), DefaultValue = 0 },
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].numpos", Index = idx, SubIndex = 14,
                GetValue = () => NumPos, SetValue = val => NumPos = Convert.ToInt32(val), ValueType = typeof(int), DefaultValue = 2 },
            new DeviceParameter { ParentName = Name, Name = $"rotarySwitch[{Number}].tolerance", Index = idx, SubIndex = 15,
                GetValue = () => Tolerance, SetValue = val => Tolerance = Convert.ToInt32(val), ValueType = typeof(int), DefaultValue = 200 },
            .. (fw58 ? Centres(idx, 16) : PointPairs(idx, 16)),
        ];
    }

    // Calibrated point voltages, packed two per 32-bit word: low half = even position, high half = odd.
    private IEnumerable<DeviceParameter> PointPairs(int idx, int firstSub) =>
        Enumerable.Range(0, MaxPositions / 2).Select(p => new DeviceParameter
        {
            ParentName = Name, Name = $"rotarySwitch[{Number}].pointPair[{p}]", Index = idx, SubIndex = firstSub + p,
            GetValue = () => (PointAt(p * 2) & 0xFFFF) | ((PointAt(p * 2 + 1) & 0xFFFF) << 16),
            SetValue = val => { var w = Convert.ToInt32(val); SetPointAt(p * 2, w & 0xFFFF); SetPointAt(p * 2 + 1, (w >> 16) & 0xFFFF); },
            ValueType = typeof(int), DefaultValue = 0
        });

    // Firmware 5.8: the centre of position k (uint16 mV, 0-5000) at sub firstSub + k.
    private IEnumerable<DeviceParameter> Centres(int idx, int firstSub) =>
        Enumerable.Range(0, MaxPositions).Select(k => new DeviceParameter
        {
            ParentName = Name, Name = $"rotarySwitch[{Number}].centre[{k}]", Index = idx, SubIndex = firstSub + k,
            GetValue = () => PointAt(k), SetValue = val => SetPointAt(k, Math.Clamp(Convert.ToInt32(val), 0, 5000)),
            ValueType = typeof(int), DefaultValue = 0
        });

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
        list.AddRange(PointPairs(BaseIndex + (Number - 1), subIndex));
        subIndex += MaxPositions / 2;
        return list;
    }
}
