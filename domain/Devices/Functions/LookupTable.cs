using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

// 2-axis lookup table (dingoConfig #58, firmware param base 0x1A00). X/Y come from the var map,
// the output is the bilinear interpolation of the 8x8 cell grid; a table with YSize = 1 is a
// 1-D curve along X. Wire layout: sub 0-4 header, 5-12 X axis, 13-20 Y axis, 21-84 cells
// (row-major, 21 + y*8 + x). Outside the axis range the edge value holds.
public class LookupTable : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1A00;
    [JsonIgnore] public const int AxisMax = 8;
    [JsonPropertyName("name")] public string Name {get; set; }
    [JsonPropertyName("number")] public int Number {get;}
    [JsonPropertyName("enabled")] public bool Enabled {get; set;}
    [JsonPropertyName("xInput")] public int XInput {get; set;}
    [JsonPropertyName("yInput")] public int YInput {get; set;}
    // Breakpoint counts, clamped to the firmware's 1..TABLE_AXIS_MAX range.
    [JsonPropertyName("xSize")] public int XSize { get => field; set => field = Math.Clamp(value, 1, AxisMax); } = 2;
    [JsonPropertyName("ySize")] public int YSize { get => field; set => field = Math.Clamp(value, 1, AxisMax); } = 1;
    [JsonPropertyName("xAxis")] public double[] XAxis { get; set; } = new double[AxisMax];
    [JsonPropertyName("yAxis")] public double[] YAxis { get; set; } = new double[AxisMax];
    // Row-major [y*8 + x], always 64 long.
    [JsonPropertyName("cells")] public double[] Cells { get; set; } = new double[AxisMax * AxisMax];

    [JsonIgnore][Plotable(displayName:"Value")] public double Value {get; set;}

    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public LookupTable(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
    }

    // Same math as the firmware (functions/table.cpp) — used for the live preview in the editor
    // and to keep the two implementations honest against each other in tests.
    public static double Interpolate(int xSize, int ySize, double[] xAxis, double[] yAxis, double[] cells, double x, double y)
    {
        var nx = Math.Clamp(xSize, 1, AxisMax);
        var ny = Math.Clamp(ySize, 1, AxisMax);
        var (ix, tx) = Locate(xAxis, nx, x);
        var (iy, ty) = Locate(yAxis, ny, y);
        var ix1 = nx > 1 ? ix + 1 : ix;
        var iy1 = ny > 1 ? iy + 1 : iy;
        double C(int yy, int xx) => cells[yy * AxisMax + xx];
        var r0 = C(iy, ix) + (C(iy, ix1) - C(iy, ix)) * tx;
        var r1 = C(iy1, ix) + (C(iy1, ix1) - C(iy1, ix)) * tx;
        return r0 + (r1 - r0) * ty;
    }

    private static (int i, double t) Locate(double[] axis, int n, double v)
    {
        if (n <= 1 || v <= axis[0]) return (0, 0);
        if (v >= axis[n - 1]) return (n - 2, 1);
        var i = 0;
        while (i < n - 2 && v > axis[i + 1]) i++;
        var span = axis[i + 1] - axis[i];
        return (i, span > 0 ? (v - axis[i]) / span : 0);
    }

    private List<DeviceParameter> InitParams()
    {
        var idx = BaseIndex + (Number - 1);
        var list = new List<DeviceParameter>
        {
            new()
            {
                ParentName = Name, Name = $"table[{Number}].enabled", Index = idx, SubIndex = 0,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val, ValueType = typeof(bool), DefaultValue = false
            },
            new()
            {
                ParentName = Name, Name = $"table[{Number}].xInput", Index = idx, SubIndex = 1,
                GetValue = () => XInput, SetValue = val => XInput = (int)val, ValueType = typeof(int), DefaultValue = 0
            },
            new()
            {
                ParentName = Name, Name = $"table[{Number}].yInput", Index = idx, SubIndex = 2,
                GetValue = () => YInput, SetValue = val => YInput = (int)val, ValueType = typeof(int), DefaultValue = 0
            },
            new()
            {
                ParentName = Name, Name = $"table[{Number}].xSize", Index = idx, SubIndex = 3,
                GetValue = () => XSize, SetValue = val => XSize = (int)val, ValueType = typeof(int), DefaultValue = 2
            },
            new()
            {
                ParentName = Name, Name = $"table[{Number}].ySize", Index = idx, SubIndex = 4,
                GetValue = () => YSize, SetValue = val => YSize = (int)val, ValueType = typeof(int), DefaultValue = 1
            },
        };
        for (var k = 0; k < AxisMax; k++)
        {
            var kk = k;
            list.Add(new DeviceParameter
            {
                ParentName = Name, Name = $"table[{Number}].xAxis[{kk}]", Index = idx, SubIndex = 5 + kk,
                GetValue = () => XAxis[kk], SetValue = val => XAxis[kk] = (double)val, ValueType = typeof(double), DefaultValue = 0.0
            });
        }
        for (var k = 0; k < AxisMax; k++)
        {
            var kk = k;
            list.Add(new DeviceParameter
            {
                ParentName = Name, Name = $"table[{Number}].yAxis[{kk}]", Index = idx, SubIndex = 13 + kk,
                GetValue = () => YAxis[kk], SetValue = val => YAxis[kk] = (double)val, ValueType = typeof(double), DefaultValue = 0.0
            });
        }
        for (var c = 0; c < AxisMax * AxisMax; c++)
        {
            var cc = c;
            list.Add(new DeviceParameter
            {
                ParentName = Name, Name = $"table[{Number}].cell[{cc / AxisMax}][{cc % AxisMax}]", Index = idx, SubIndex = 21 + cc,
                GetValue = () => Cells[cc], SetValue = val => Cells[cc] = (double)val, ValueType = typeof(double), DefaultValue = 0.0
            });
        }
        return list;
    }
}
