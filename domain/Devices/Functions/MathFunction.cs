using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public enum MathOp { Add = 0, Sub = 1, Mul = 2, Div = 3, Min = 4, Max = 5, Average = 6 }

// Math block (firmware 5.6, param base 0x1C00): Value = (A op B) × Factor + Offset. B is a signal, or
// ConstB when InputB is 0. Division by zero gives 0.
public class MathFunction : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1C00;
    [JsonIgnore] public static readonly Version Since = new(5, 6, 0);
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("number")] public int Number { get; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("op")] public MathOp Op { get; set; } = MathOp.Add;
    [JsonPropertyName("inputA")] public int InputA { get; set; }
    [JsonPropertyName("inputB")] public int InputB { get; set; }
    [JsonPropertyName("constB")] public double ConstB { get; set; }
    [JsonPropertyName("factor")] public double Factor { get; set; } = 1.0;
    [JsonPropertyName("offset")] public double Offset { get; set; }

    [JsonIgnore][Plotable(displayName: "Value")] public double Value { get; set; }
    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public MathFunction(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
    }

    private List<DeviceParameter> InitParams()
    {
        var i = BaseIndex + (Number - 1);
        var n = $"math[{Number}]";
        return
        [
            new() { ParentName = Name, Name = $"{n}.enabled", Index = i, SubIndex = 0, GetValue = () => Enabled, SetValue = v => Enabled = (bool)v, ValueType = typeof(bool), DefaultValue = false, MinFirmware = Since },
            new() { ParentName = Name, Name = $"{n}.op", Index = i, SubIndex = 1, GetValue = () => Op, SetValue = v => Op = (MathOp)v, ValueType = typeof(MathOp), DefaultValue = MathOp.Add, MinFirmware = Since },
            new() { ParentName = Name, Name = $"{n}.inputA", Index = i, SubIndex = 2, GetValue = () => InputA, SetValue = v => InputA = (int)v, ValueType = typeof(int), DefaultValue = 0, MinFirmware = Since },
            new() { ParentName = Name, Name = $"{n}.inputB", Index = i, SubIndex = 3, GetValue = () => InputB, SetValue = v => InputB = (int)v, ValueType = typeof(int), DefaultValue = 0, MinFirmware = Since },
            new() { ParentName = Name, Name = $"{n}.constB", Index = i, SubIndex = 4, GetValue = () => ConstB, SetValue = v => ConstB = (double)v, ValueType = typeof(double), DefaultValue = 0.0, MinFirmware = Since },
            new() { ParentName = Name, Name = $"{n}.factor", Index = i, SubIndex = 5, GetValue = () => Factor, SetValue = v => Factor = (double)v, ValueType = typeof(double), DefaultValue = 1.0, MinFirmware = Since },
            new() { ParentName = Name, Name = $"{n}.offset", Index = i, SubIndex = 6, GetValue = () => Offset, SetValue = v => Offset = (double)v, ValueType = typeof(double), DefaultValue = 0.0, MinFirmware = Since },
        ];
    }
}
