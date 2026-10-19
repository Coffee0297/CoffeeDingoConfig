using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public enum CanMessageMode { Repeat = 0, Once = 1 }

// CAN Message block (firmware 5.6, param base 0x1D00): sends a whole user frame (11/29-bit id, length,
// 8 fixed bytes) while Input is true — every IntervalMs (Repeat) or once each time it turns true (Once).
// E.g. "tell the dash to shut down". CanOutput sends one signal; this sends fixed bytes.
public class CanMessage : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1D00;
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("number")] public int Number { get; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("input")] public int Input { get; set; }
    [JsonPropertyName("ide")] public bool Ide { get; set; }
    [JsonPropertyName("id")]
    public int Id
    {
        get;
        set { field = Math.Clamp(value, 0, 0x1FFFFFFF); if (field > 0x7FF) Ide = true; }
    }
    [JsonPropertyName("dlc")] public int Dlc { get => field; set => field = Math.Clamp(value, 0, 8); } = 8;
    [JsonPropertyName("data")] public int[] Data { get => field; set => field = (value ?? []).Select(b => Math.Clamp(b, 0, 255)).Concat(Enumerable.Repeat(0, 8)).Take(8).ToArray(); } = new int[8];
    [JsonPropertyName("mode")] public CanMessageMode Mode { get; set; } = CanMessageMode.Repeat;
    [JsonPropertyName("intervalMs")] public int IntervalMs { get => field; set => field = Math.Clamp(value, 10, 60000); } = 100;

    // Upstream dingoFW feat/can-msg-counter-checksum (subs 15-17): 0 none, 2 XOR, 3 sum, 4 CRC8 SAE J1850, 5 CRC8 AUTOSAR
    // (1 acts as none) in byte ChecksumByte; a 4-bit rolling counter in the low nibble of CounterByte (0xFF = none).
    // A byte at or past the length is ignored by the firmware; the same byte for both: the checksum wins.
    [JsonPropertyName("checksum")] public int Checksum { get => field; set => field = Math.Clamp(value, 0, 5); }
    [JsonPropertyName("checksumByte")] public int ChecksumByte { get => field; set => field = Math.Clamp(value, 0, 7); } = 7;
    [JsonPropertyName("counterByte")] public int CounterByte { get => field; set => field = Math.Clamp(value, 0, 255); } = 0xFF;

    [JsonIgnore][Plotable(displayName: "Sending")] public bool Value { get; set; }
    [JsonIgnore] public List<DeviceParameter> Params { get; }
    /// <summary>Upstream: subs 0-14, then checksum / checksum byte / counter byte; a module without them drops them by its list.</summary>
    [JsonIgnore] public List<DeviceParameter> UpstreamParams { get; }

    [JsonConstructor]
    public CanMessage(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
        var i = BaseIndex + (Number - 1);
        var n = $"canMsg[{Number}]";
        UpstreamParams =
        [
            .. Params,
            new() { ParentName = Name, Name = $"{n}.checksum", Index = i, SubIndex = 15, GetValue = () => Checksum, SetValue = x => Checksum = (int)x, ValueType = typeof(int), DefaultValue = 0 },
            new() { ParentName = Name, Name = $"{n}.checksumByte", Index = i, SubIndex = 16, GetValue = () => ChecksumByte, SetValue = x => ChecksumByte = (int)x, ValueType = typeof(int), DefaultValue = 7 },
            new() { ParentName = Name, Name = $"{n}.counterByte", Index = i, SubIndex = 17, GetValue = () => CounterByte, SetValue = x => CounterByte = (int)x, ValueType = typeof(int), DefaultValue = 0xFF },
        ];
    }

    private List<DeviceParameter> InitParams()
    {
        var i = BaseIndex + (Number - 1);
        var n = $"canMsg[{Number}]";
        var v = MathFunction.Since;
        var list = new List<DeviceParameter>
        {
            new() { ParentName = Name, Name = $"{n}.enabled", Index = i, SubIndex = 0, GetValue = () => Enabled, SetValue = x => Enabled = (bool)x, ValueType = typeof(bool), DefaultValue = false, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.input", Index = i, SubIndex = 1, GetValue = () => Input, SetValue = x => Input = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.ide", Index = i, SubIndex = 2, GetValue = () => Ide, SetValue = x => Ide = (bool)x, ValueType = typeof(bool), DefaultValue = false, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.id", Index = i, SubIndex = 3, GetValue = () => Id, SetValue = x => Id = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.dlc", Index = i, SubIndex = 4, GetValue = () => Dlc, SetValue = x => Dlc = (int)x, ValueType = typeof(int), DefaultValue = 8, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.mode", Index = i, SubIndex = 5, GetValue = () => Mode, SetValue = x => Mode = (CanMessageMode)x, ValueType = typeof(CanMessageMode), DefaultValue = CanMessageMode.Repeat, MinFirmware = v },
        };
        for (var k = 0; k < 8; k++)
        {
            var b = k;
            list.Add(new() { ParentName = Name, Name = $"{n}.data[{b}]", Index = i, SubIndex = 6 + b, GetValue = () => Data[b], SetValue = x => Data[b] = Math.Clamp((int)x, 0, 255), ValueType = typeof(int), DefaultValue = 0, MinFirmware = v });
        }
        list.Add(new() { ParentName = Name, Name = $"{n}.intervalMs", Index = i, SubIndex = 14, GetValue = () => IntervalMs, SetValue = x => IntervalMs = (int)x, ValueType = typeof(int), DefaultValue = 100, MinFirmware = v });
        return list;
    }
}
