using System.Text.Json.Serialization;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

// 1-D curve (upstream dingoFW feat/curve-block, param base 0x2400, PDMs only): up to 12 (X, Y) points, linear
// between them, the end values held outside. A point whose X is not above the last used X is skipped.
// Wire layout: sub 0 enabled, 1 input, 2 points (2-12), 3-14 X, 15-26 Y.
public class CurveFunction : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2400;
    [JsonIgnore] public const int MaxPoints = 12;
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("number")] public int Number { get; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("input")] public int Input { get; set; }
    [JsonPropertyName("points")] public int Points { get => field; set => field = Math.Clamp(value, 2, MaxPoints); } = 2;
    // always 12 long, so the per-point params never index past the end
    [JsonPropertyName("x")] public double[] X { get => field; set => field = Fit(value); } = new double[MaxPoints];
    [JsonPropertyName("y")] public double[] Y { get => field; set => field = Fit(value); } = new double[MaxPoints];

    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public CurveFunction(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
    }

    private static double[] Fit(double[]? v) { var a = new double[MaxPoints]; if (v != null) Array.Copy(v, a, Math.Min(v.Length, MaxPoints)); return a; }

    private List<DeviceParameter> InitParams()
    {
        var i = BaseIndex + (Number - 1);
        var n = $"curve[{Number}]";
        var list = new List<DeviceParameter>
        {
            new() { ParentName = Name, Name = $"{n}.enabled", Index = i, SubIndex = 0, GetValue = () => Enabled, SetValue = v => Enabled = (bool)v, ValueType = typeof(bool), DefaultValue = false },
            new() { ParentName = Name, Name = $"{n}.input", Index = i, SubIndex = 1, GetValue = () => Input, SetValue = v => Input = (int)v, ValueType = typeof(int), DefaultValue = 0 },
            new() { ParentName = Name, Name = $"{n}.points", Index = i, SubIndex = 2, GetValue = () => Points, SetValue = v => Points = (int)v, ValueType = typeof(int), DefaultValue = 2 },
        };
        for (var k = 0; k < MaxPoints; k++)
        {
            var kk = k;
            list.Add(new() { ParentName = Name, Name = $"{n}.x[{kk}]", Index = i, SubIndex = 3 + kk, GetValue = () => X[kk], SetValue = v => X[kk] = (double)v, ValueType = typeof(double), DefaultValue = 0.0 });
        }
        for (var k = 0; k < MaxPoints; k++)
        {
            var kk = k;
            list.Add(new() { ParentName = Name, Name = $"{n}.y[{kk}]", Index = i, SubIndex = 15 + kk, GetValue = () => Y[kk], SetValue = v => Y[kk] = (double)v, ValueType = typeof(double), DefaultValue = 0.0 });
        }
        return list;
    }
}
