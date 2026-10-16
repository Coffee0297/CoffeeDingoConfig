using System.Text.Json.Serialization;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public enum IgnitionMode { SwitchButton = 0, ButtonOnly = 1, Key = 2 }
public enum IgnitionRole { Main = 0, Follower = 1 }
public enum IgnitionState { Off = 0, On = 1, Cranking = 2, Running = 3 }

// Ignition & start button (firmware 5.6, param base 0x1E00, one per module). The main module reads the switch /
// button and runs the state machine; it broadcasts the state every 100 ms at the first id after its own range
// (PDM base + 30, CANBoard base + 14: StateOffsetFor) and followers copy it.
// The state is published as var-map signals (Ignition, Accessory, Cranking, Running, Ready, Dash, Link OK), so an
// output gets a role by following one of them.
public class Ignition : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1E00;
    /// <summary>The state frame's offset from the base id: the first id after the board's own range.</summary>
    public static int StateOffsetFor(string? deviceType) => deviceType?.Contains("canboard", StringComparison.OrdinalIgnoreCase) == true ? 14 : 30;
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("number")] public int Number => 1;
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("mode")] public IgnitionMode Mode { get; set; } = IgnitionMode.SwitchButton;
    [JsonPropertyName("role")] public IgnitionRole Role { get; set; } = IgnitionRole.Main;
    [JsonPropertyName("ignitionInput")] public int IgnitionInput { get; set; }
    [JsonPropertyName("startInput")] public int StartInput { get; set; }
    [JsonPropertyName("crankAllowInput")] public int CrankAllowInput { get; set; }
    [JsonPropertyName("runningInput")] public int RunningInput { get; set; }
    [JsonPropertyName("maxCrankMs")] public int MaxCrankMs { get => field; set => field = Math.Clamp(value, 500, 30000); } = 5000;
    [JsonPropertyName("crankWhileHeld")] public bool CrankWhileHeld { get; set; } = true;
    [JsonPropertyName("dashHoldMs")] public int DashHoldMs { get => field; set => field = Math.Clamp(value, 0, 60000); }
    // Follower: the CAN id of the main module's state frame (its base + StateOffsetFor(its type))
    [JsonPropertyName("mainStateId")] public int MainStateId { get => field; set => field = Math.Clamp(value, 0, 2047); }

    // live, from this module's own state frame (a main module)
    [JsonIgnore] public IgnitionState State { get; set; }
    [JsonIgnore] public bool Dash { get; set; }
    [JsonIgnore] public DateTime LastStateFrame { get; set; }

    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public Ignition(string name)
    {
        Name = name;
        Params = InitParams();
    }

    private List<DeviceParameter> InitParams()
    {
        var v = MathFunction.Since;
        const string n = "ignition";
        return
        [
            new() { ParentName = Name, Name = $"{n}.enabled", Index = BaseIndex, SubIndex = 0, GetValue = () => Enabled, SetValue = x => Enabled = (bool)x, ValueType = typeof(bool), DefaultValue = false, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.mode", Index = BaseIndex, SubIndex = 1, GetValue = () => Mode, SetValue = x => Mode = (IgnitionMode)x, ValueType = typeof(IgnitionMode), DefaultValue = IgnitionMode.SwitchButton, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.role", Index = BaseIndex, SubIndex = 2, GetValue = () => Role, SetValue = x => Role = (IgnitionRole)x, ValueType = typeof(IgnitionRole), DefaultValue = IgnitionRole.Main, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.ignitionInput", Index = BaseIndex, SubIndex = 3, GetValue = () => IgnitionInput, SetValue = x => IgnitionInput = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.startInput", Index = BaseIndex, SubIndex = 4, GetValue = () => StartInput, SetValue = x => StartInput = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.crankAllowInput", Index = BaseIndex, SubIndex = 5, GetValue = () => CrankAllowInput, SetValue = x => CrankAllowInput = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.runningInput", Index = BaseIndex, SubIndex = 6, GetValue = () => RunningInput, SetValue = x => RunningInput = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.maxCrankMs", Index = BaseIndex, SubIndex = 7, GetValue = () => MaxCrankMs, SetValue = x => MaxCrankMs = (int)x, ValueType = typeof(int), DefaultValue = 5000, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.crankWhileHeld", Index = BaseIndex, SubIndex = 8, GetValue = () => CrankWhileHeld, SetValue = x => CrankWhileHeld = (bool)x, ValueType = typeof(bool), DefaultValue = true, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.dashHoldMs", Index = BaseIndex, SubIndex = 9, GetValue = () => DashHoldMs, SetValue = x => DashHoldMs = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
            new() { ParentName = Name, Name = $"{n}.mainStateId", Index = BaseIndex, SubIndex = 10, GetValue = () => MainStateId, SetValue = x => MainStateId = (int)x, ValueType = typeof(int), DefaultValue = 0, MinFirmware = v },
        ];
    }
}
