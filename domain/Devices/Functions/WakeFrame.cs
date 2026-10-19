using System.Text.Json.Serialization;
using domain.Models;

namespace domain.Devices.Functions;

// Upstream dingoFW feat/wake-on-frame (PDMs, param 0x0100 subs 0-7): while enabled, only a CAN frame with this
// id/IDE, at least MinLength bytes and (data & mask) == (value & mask) counts as bus activity for the sleep timer.
// Mask/value bytes go over the wire packed in two UInt32 each, byte 0 in the low byte of the Lo word. The fork has none.
public class WakeFrame
{
    public const int Index = 0x0100;
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("ext")] public bool Ext { get; set; }
    [JsonPropertyName("minLength")] public int MinLength { get; set; }
    [JsonPropertyName("mask")] public int[] Mask { get; set; } = new int[8];
    [JsonPropertyName("value")] public int[] Value { get; set; } = new int[8];

    public static uint Pack(int[] b, int from) => (uint)((b[from] & 0xFF) | (b[from + 1] & 0xFF) << 8 | (b[from + 2] & 0xFF) << 16 | (b[from + 3] & 0xFF) << 24);
    public static void Unpack(int[] b, int from, object v)
    {
        var w = Convert.ToUInt32(v);
        for (var i = 0; i < 4; i++) b[from + i] = (int)(w >> (8 * i)) & 0xFF;
    }

    public List<DeviceParameter> Params(string parent) =>
    [
        new() { ParentName = parent, Name = "wakeFrame.enabled", Index = Index, SubIndex = 0, GetValue = () => Enabled, SetValue = v => Enabled = (bool)v, ValueType = typeof(bool), DefaultValue = false },
        new() { ParentName = parent, Name = "wakeFrame.id", Index = Index, SubIndex = 1, GetValue = () => Id, SetValue = v => Id = (int)v, ValueType = typeof(int), DefaultValue = 0 },
        new() { ParentName = parent, Name = "wakeFrame.ide", Index = Index, SubIndex = 2, GetValue = () => Ext, SetValue = v => Ext = (bool)v, ValueType = typeof(bool), DefaultValue = false },
        new() { ParentName = parent, Name = "wakeFrame.minLength", Index = Index, SubIndex = 3, GetValue = () => MinLength, SetValue = v => MinLength = (int)v, ValueType = typeof(int), DefaultValue = 0 },
        // uint: the words use all 32 bits (an int would overflow on a 0xFF top byte)
        new() { ParentName = parent, Name = "wakeFrame.maskLo", Index = Index, SubIndex = 4, GetValue = () => Pack(Mask, 0), SetValue = v => Unpack(Mask, 0, v), ValueType = typeof(uint), DefaultValue = 0u },
        new() { ParentName = parent, Name = "wakeFrame.maskHi", Index = Index, SubIndex = 5, GetValue = () => Pack(Mask, 4), SetValue = v => Unpack(Mask, 4, v), ValueType = typeof(uint), DefaultValue = 0u },
        new() { ParentName = parent, Name = "wakeFrame.valueLo", Index = Index, SubIndex = 6, GetValue = () => Pack(Value, 0), SetValue = v => Unpack(Value, 0, v), ValueType = typeof(uint), DefaultValue = 0u },
        new() { ParentName = parent, Name = "wakeFrame.valueHi", Index = Index, SubIndex = 7, GetValue = () => Pack(Value, 4), SetValue = v => Unpack(Value, 4, v), ValueType = typeof(uint), DefaultValue = 0u },
    ];
}
