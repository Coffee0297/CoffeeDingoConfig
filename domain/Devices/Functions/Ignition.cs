using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public enum IgnitionMode { SwitchButton = 0, ButtonOnly = 1, Key = 2 }
public enum IgnitionRole { Main = 0, Follower = 1, Standalone = 2 }   // Standalone: firmware 5.7 (main logic, broadcasts nothing)
public enum IgnitionSyncMode { Absolute = 0, BaseOffset = 1 }
public enum IgnitionOutputRole { None = 0, Ignition = 1, Accessory = 2, Dash = 3, Starter = 4 }
public enum IgnitionState { Off = 0, On = 1, Cranking = 2, Running = 3 }

// Ignition & start button (firmware 5.6, param base 0x1E00, one per module). The main module reads the switch /
// button and runs the state machine; it broadcasts the state every 100 ms at the first id after its own range
// (PDM base + 30, CANBoard base + 14: StateOffsetFor) and followers copy it.
// The state is published as var-map signals (Ignition, Accessory, Cranking, Running, Ready, Dash, Link OK), so an
// output gets a role by following one of them.
public class Ignition : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1E00;
    /// <summary>The state frame's offset from the base id: the first id after the board's own range. Upstream dingoFW
    /// (feat/ignition-block alone) sends it as cyclic Msg 30 = base + 32 (PT-DPDM Msg 31 = base + 33); with other
    /// appended frames it comes after them (PdmDevice.UpstreamFrames: + 36 on integration/all-features). Its CANBoard has none.</summary>
    public static int StateOffsetFor(string? deviceType, string family = FwFamily.Fork, int pdmType = 0) =>
        family == FwFamily.Upstream ? (pdmType == 2 ? 33 : 32)
        : deviceType?.Contains("canboard", StringComparison.OrdinalIgnoreCase) == true ? 14 : 30;
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
    // Sub 10. Fork / upstream 0.x: a follower's main state-frame id (main base + StateOffsetFor). Firmware 5.7 (sub 11
    // present): the sync id, on every module of the car: absolute (default 0x6F1) or an offset from the main's base.
    [JsonPropertyName("mainStateId")] public int MainStateId { get => field; set => field = Math.Clamp(value, 0, 2047); }

    // firmware 5.7 (ignition parity, subs 11-22 and 0x30 + output)
    [JsonIgnore] public const int DefaultSyncId = 0x6F1;
    [JsonPropertyName("syncMode")] public IgnitionSyncMode SyncMode { get; set; }
    [JsonPropertyName("syncBase")] public int SyncBase { get => field; set => field = Math.Clamp(value, 0, 2047); }   // follower, offset mode: the main's base id
    [JsonPropertyName("stopInput")] public int StopInput { get; set; }
    [JsonPropertyName("buttonExtended")] public bool ButtonExtended { get; set; }
    [JsonPropertyName("buttonId")] public int ButtonId { get => field; set => field = Math.Clamp(value, 0, 0x1FFFFFFF); }
    [JsonPropertyName("buttonByte")] public int ButtonByte { get => field; set => field = Math.Clamp(value, 0, 7); }
    [JsonPropertyName("buttonMask")] public int ButtonMask { get => field; set => field = Math.Clamp(value, 0, 255); }   // 0 = the start input var is used
    [JsonPropertyName("buttonTimeoutMs")] public int ButtonTimeoutMs { get => field; set => field = Math.Clamp(value, 0, 60000); } = 1000;
    [JsonPropertyName("dashOffDelayMs")] public int DashOffDelayMs { get => field; set => field = Math.Clamp(value, 0, 60000); }
    [JsonPropertyName("doorInput")] public int DoorInput { get; set; }
    [JsonPropertyName("doorOnMs")] public int DoorOnMs { get => field; set => field = Math.Clamp(value, 1000, 3600000); } = 60000;
    [JsonPropertyName("sleepDelayMs")] public int SleepDelayMs { get => field; set => field = Math.Clamp(value, 0, 3600000); }
    // PDMs: one role per output; a fixed 8 so a short array from a client never shifts a sub
    [JsonPropertyName("outputRoles")] public IgnitionOutputRole[] OutputRoles { get => field; set => Array.Copy(value, field, Math.Min(value.Length, field.Length)); } = new IgnitionOutputRole[8];

    /// <summary>The module has the 5.7 sync settings (sub 11 in its list): sub 10 is the sync id, every role sends the status frame.</summary>
    public static bool HasSync(IDeviceConfigurable d) => d.ParamSet.Contains(BaseIndex, 11);

    // live, from this module's own state frame (a main module) or 5.7 status frame (any role)
    [JsonIgnore] public IgnitionState State { get; set; }
    [JsonIgnore] public bool Dash { get; set; }
    [JsonIgnore] public DateTime LastStateFrame { get; set; }
    [JsonIgnore] public IgnitionStatus? Status { get; set; }

    /// <summary>This module's ignition frame: fork / 0.x ['I', state, flags], or the 5.7 status (8 bytes, byte 0 =
    /// state | role << 4, never 'I'). False when it is neither.</summary>
    public bool ReadFrame(byte[] d)
    {
        if (d.Length >= 3 && d[0] == 'I') { State = (IgnitionState)d[1]; Dash = (d[2] & 0x10) != 0; }
        else if (d.Length >= 8) { Status = IgnitionStatus.From(d); State = Status.State; Dash = (d[6] & 0x04) != 0; }
        else return false;
        LastStateFrame = DateTime.UtcNow;
        return true;
    }

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

    /// <summary>Upstream family: subs 0-10 plus the 5.7 parity subs and <paramref name="outputs"/> output roles (the param
    /// filter drops what a module's list lacks, e.g. upstream 0.x with subs 0-10 only).</summary>
    public List<DeviceParameter> UpstreamParams(int outputs)
    {
        const string n = "ignition";
        DeviceParameter P(int sub, string name, Func<object> get, Action<object> set, Type t, object def) =>
            new() { ParentName = Name, Name = $"{n}.{name}", Index = BaseIndex, SubIndex = sub, GetValue = get, SetValue = set, ValueType = t, DefaultValue = def };
        return
        [
            .. Params,
            P(11, "syncMode", () => SyncMode, x => SyncMode = (IgnitionSyncMode)x, typeof(IgnitionSyncMode), IgnitionSyncMode.Absolute),
            P(12, "syncBase", () => SyncBase, x => SyncBase = (int)x, typeof(int), 0),
            P(13, "stopInput", () => StopInput, x => StopInput = (int)x, typeof(int), 0),
            P(14, "buttonExtended", () => ButtonExtended, x => ButtonExtended = (bool)x, typeof(bool), false),
            P(15, "buttonId", () => ButtonId, x => ButtonId = (int)x, typeof(int), 0),
            P(16, "buttonByte", () => ButtonByte, x => ButtonByte = (int)x, typeof(int), 0),
            P(17, "buttonMask", () => ButtonMask, x => ButtonMask = (int)x, typeof(int), 0),
            P(18, "buttonTimeoutMs", () => ButtonTimeoutMs, x => ButtonTimeoutMs = (int)x, typeof(int), 1000),
            P(19, "dashOffDelayMs", () => DashOffDelayMs, x => DashOffDelayMs = (int)x, typeof(int), 0),
            P(20, "doorInput", () => DoorInput, x => DoorInput = (int)x, typeof(int), 0),
            P(21, "doorOnMs", () => DoorOnMs, x => DoorOnMs = (int)x, typeof(int), 60000),
            P(22, "sleepDelayMs", () => SleepDelayMs, x => SleepDelayMs = (int)x, typeof(int), 0),
            .. Enumerable.Range(0, Math.Min(outputs, OutputRoles.Length)).Select(i =>
                P(0x30 + i, $"outputRole{i + 1}", () => OutputRoles[i], x => OutputRoles[i] = (IgnitionOutputRole)x, typeof(IgnitionOutputRole), IgnitionOutputRole.None)),
        ];
    }
}

/// <summary>The 5.7 ignition status frame (PDM base+36, CANBoard base+12), dingoFW #74's layout: role 0 main / 1 follower /
/// 2 standalone; dash 0 Off 1 On 2 Grace 3 Halting 4 Restart; sleep 0 Disabled 1 Awake 2 Counting 3 Following 4 WaitingDash
/// 5 Held 6 Quiet 7 Sleep; link 0 not a follower 1 ok 2 lost 3 sync id invalid; flags bit0 ignition 1 accessory 2 dash
/// 3 starter 4 running 5 ready 6 dash shutdown; wake 0x80 woke from sleep | 1 CAN 2 input 4 USB 8 other.</summary>
public record IgnitionStatus(IgnitionState State, int Role, int Dash, int Sleep, int Link, int SleepInS, int Flags, int Wake)
{
    public static IgnitionStatus From(byte[] d) =>
        new((IgnitionState)(d[0] & 0x0F), d[0] >> 4, d[1], d[2], d[3], d[4] | d[5] << 8, d[6], d[7]);
}
