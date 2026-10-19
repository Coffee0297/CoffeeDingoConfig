using System.Text.Json.Serialization;
using domain.Enums;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public class CanOutput : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2000;
    [JsonPropertyName("name")] public string Name {get; set; }
    [JsonPropertyName("number")] public int Number {get;}
    [JsonPropertyName("enabled")] public bool Enabled {get; set;}
    [JsonPropertyName("input")] public int Input {get; set;}
    [JsonPropertyName("ide")] public bool Ide {get; set;}
    // Clamped to the firmware's CAN_OUTPUT_PARAMS ranges — it silently drops an out-of-range write,
    // which the app then reports as "No reply from module".
    [JsonPropertyName("startBit")] public int StartBit { get => field; set => field = Math.Clamp(value, 0, 63); }
    [JsonPropertyName("bitLength")] public int BitLength { get => field; set => field = Math.Clamp(value, 1, 32); } = 8;
    [JsonPropertyName("factor")] public double Factor { get; set; } = 1.0;
    [JsonPropertyName("offset")] public double Offset {get; set;}
    [JsonPropertyName("byteOrder")] public ByteOrder ByteOrder {get; set;} =  ByteOrder.LittleEndian;
    [JsonPropertyName("signed")] public bool Signed {get; set;}
    [JsonPropertyName("interval")] public int Interval { get => field; set => field = Math.Clamp(value, 0, 60000); } = 1000;

    [JsonPropertyName("id")]
    public int Id
    {
        get;
        set
        {
            // 29-bit max (firmware 0..0x1FFFFFFF). An id above 11 bits can only be an extended
            // frame, so force IDE on — but never force it OFF: a small id with ide=true is a valid
            // extended frame, and JSON may well set "ide" before "id".
            field = Math.Clamp(value, 0, 0x1FFFFFFF);
            if (field > 0x7FF) Ide = true;
        }
    }

    // Upstream dingoFW feat/can-output-trigger (sub 12): a var; 0 = send on the interval. Set, the frame is sent once on each
    // rising edge of that var (with every output packed in it) and not on the interval.
    [JsonPropertyName("triggerInput")] public int TriggerInput { get; set; }

    [JsonIgnore] public List<DeviceParameter> Params { get; }
    /// <summary>Upstream: subs 0-10, then the trigger (sub 12); a module without it drops it by its param list.</summary>
    [JsonIgnore] public List<DeviceParameter> UpstreamParams { get; }

    [JsonConstructor]
    public CanOutput(int number, string name)
    {
        Number = number;
        Name = name;

        Params = InitParams();
        UpstreamParams = [.. Params, new DeviceParameter { ParentName = Name, Name = $"canOutput[{Number}].triggerInput", Index = BaseIndex + (Number - 1), SubIndex = 12,
            GetValue = () => TriggerInput, SetValue = val => TriggerInput = (int)val, ValueType = typeof(int), DefaultValue = 0 }];
    }

    private List<DeviceParameter> InitParams()
    {
        var subIndex = 0;
        return
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].enabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].input", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Input, SetValue = val => Input = (int)val,
                ValueType = Input.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].ide", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Ide, SetValue = val => Ide = (bool)val,
                ValueType = Ide.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].id", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Id, SetValue = val => Id = (int)val,
                ValueType = Id.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].startBit", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => StartBit, SetValue = val => StartBit = (int)val,
                ValueType = StartBit.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].bitLength", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => BitLength, SetValue = val => BitLength = (int)val,
                ValueType = BitLength.GetType(),
                DefaultValue = 8
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].factor", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Factor, SetValue = val => Factor = (double)val,
                ValueType = Factor.GetType(),
                DefaultValue = 1.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].offset", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Offset, SetValue = val => Offset = (double)val,
                ValueType = Offset.GetType(),
                DefaultValue = 0.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].byteOrder", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => ByteOrder, SetValue = val => ByteOrder = (ByteOrder)val,
                ValueType = ByteOrder.GetType(),
                DefaultValue = ByteOrder.LittleEndian
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].signed", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Signed, SetValue = val => Signed = (bool)val,
                ValueType = Signed.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"canOutput[{Number}].interval", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Interval, SetValue = val => Interval = (int)val,
                ValueType = Interval.GetType(),
                DefaultValue = 1000
            },
        ];
    }
}