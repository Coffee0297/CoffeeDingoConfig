using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using application.Models;
using application.Services;
using infrastructure.Comms;
using domain.Devices.Canboard;
using domain.Devices.Functions;
using domain.Devices.Functions.Keypad;
using domain.Devices.Generic;
using domain.Devices.dingoPdm;
using domain.Enums;
using domain.Enums.dingoPdm;
using domain.Interfaces;
using domain.Models;
using Microsoft.AspNetCore.SignalR;

namespace web.Api;

// ---------- DTOs (what the SPA consumes) ----------
public record OutputDto(int Number, string Name, string State, double Current, int ResetCount, double Duty, string Input, double CurrentLimit,
    bool Enabled, int InputVal, double InrushLimit, int InrushTime, int ResetMode, int ResetTime, int ResetCountLimit,
    bool PwmEnabled, int Freq, int FixedDuty, int MinDuty, bool SoftStart, int SoftStartRamp,
    double WarnLimit, double OpenLoadLimit, int OpenLoadTime, string WireColor, string WireStripe, double WireLength, double WireGaugeMm2,
    bool VariableDutyCycle = false, int DutyCycleInput = 0, int DutyCycleDenom = 100,
    bool VariableFreq = false, int FreqInput = 0, int FreqInputDenom = 1, bool RampDutyChanges = false,
    int PrimaryOutput = -1, double UnderLimit = 0, int UnderTime = 1000, bool UnderTrip = false, bool ClearOnReassert = false, double HardShortLimit = 0.0, int SoftStartTimeout = 0, int SoftStopTime = 0, bool Shed = false, int ThermalTau = 0, double WireLoad = 0, bool StayAlive = false);
public record DeviceDto(string Guid, string Name, string Type, int BaseId, bool Connected,
    double Battery, double Current, double Temp, string State, string Version, string Bitrate, OutputDto[] Outputs,
    bool Reading, int ReadDone, int ReadTotal, bool SleepEnabled, int SleepTimeoutMs,
    bool SleepIgnoreAlwaysOn, int ForceSleepInput, int MuteTxInput, int WakeDigInputMask, bool WakeOnCan,
    bool CanBootloader, bool ConfigMismatch = false, int ConfigDiffCount = 0, bool IsGateway = false,
    bool CanFiltersEnabled = false, bool ConnectUsbToCan = true,
    // false on a CANBoard (firmware CAN_SLEEP off): the sleep / force-sleep / wake controls do nothing there.
    bool CanSleep = true,
    // G3: null = nothing written this session; false = written, lost at power-off; true = stored on the module.
    bool? StoredOnModule = null,
    // G9: silent on the bus but answering the OpenBLT bootloader (found by POST /devices/bootloader-scan)
    bool InBootloader = false,
    // G2: edits held for "Apply to car" (0 once a write or read brings the module in step)
    int PendingEdits = 0,
    // Firmware 5.6 (null on older firmware or before the module answered)
    bool? HasLed = null,                 // G12: Identify reply; a CANBoard has no LED
    bool Asleep = false,                 // G14: said "going to sleep" and has been quiet since
    WakeDto? LastWake = null,            // G14: why it last woke
    int? SleepCountdownS = null,         // G14: seconds until auto-sleep (null = not counting)
    int? SleepBlockers = null,           // G14: bit0 sleep off, bit1 outputs on, bit2 USB, bit3 CAN traffic
    IgnitionDto? Ignition = null,
    // CANBoard: its digital outputs (a PDM's are Outputs), live: number, enabled, on
    DigitalOutDto[]? DigitalOut = null,
    // "fork" (dingoFW 5.x) or "upstream" (dingoFW 0.x). Upstream: ParamsRead = its param list came from a Read this
    // session (Apply needs it); ParamRuns = that list, [firstIndex, indexCount, sub…] (see util.js has/hasBlock).
    string Family = "fork", bool ParamsRead = false, int[][]? ParamRuns = null,
    // upstream feat/fault-clear: the signal that retries every tripped output (null = this module has none)
    int? RetryAllInput = null,
    // upstream feat/load-shed: the signal that sheds the opted-in outputs (null = this module has none)
    int? ShedInput = null,
    // upstream feat/wake-on-frame: the wake frame, when the module's Read listed 0x0100 (null otherwise)
    domain.Devices.Functions.WakeFrame? WakeFrame = null,
    // upstream feat/config-lock (null: no lock in this firmware, or not known yet)
    LockDto? Lock = null,
    // runs Lua: a PDM on the fork, or an upstream PDM that answered a Lua command (feat/lua-scripting)
    bool HasLua = false);
// Has: the module has the lock (its Read listed 0x0200, or it refused a request as locked). PasswordSet: the
// project holds a password, sent on every write. The password itself never goes to the UI.
public record LockDto(bool Has, bool Locked, string Contact, bool PasswordSet);
public record LockReq(string? Contact, uint? Password, bool ClearPassword = false);
public record UnlockReq(uint Password);
public record FactoryResetReq(string? Confirm);
public record DigitalOutDto(int Number, string Name, bool Enabled, bool On, int Input);
public record WakeDto(string Reason, int Source, int Count);
public record IgnitionDto(bool Enabled, string Role, string State, bool Dash, int MainStateId, int StateId, bool Live);
public record AdaptersDto(string[] Adapters, string[] Ports, bool Connected, string? ActiveAdapter, string? ActivePort, int? GatewayBaseId, bool ProgrammingAllowed,
    // G10: link state and the remembered connection
    bool Reconnecting = false, bool AutoConnect = false, bool AutoReconnect = true, object? Last = null);
public record ConnectionOptionsReq(bool? AutoConnect, bool? AutoReconnect);
public record TelemetryDto(bool Connected, string? Adapter, long CanTotal, long CanRate, int[] Ids, DeviceDto[] Devices, bool ProgrammingAllowed, bool Reconnecting = false,
    int AgentPending = 0, string? AgentPendingId = null);   // G22: AI agent requests waiting for the operator, and the oldest
public record ConnectReq(string Adapter, string Port, string Bitrate);
public record AddDeviceReq(string Type, string Name, string BaseId);
public record ModifyReq(string Name, string BaseId);
// Enabled = the owning function slot is configured (false for an unused timer/flasher/… slot), so a
// dashboard can hide the dozens of blank slots a stock module exposes.
// N = the slot number of the block or pin the signal comes from (0 when there is none, e.g. a DBC signal)
public record SignalDto(string Kind, string Name, string Value, bool On, bool Enabled = true, int N = 0);
public record CanLogDto(string Dir, int Id, bool Ide, int Len, string Data, int Count);
public record SysLogDto(string Time, string Level, string Source, string Message);
public record ProbeReq(string Base);
public record SetOutputReq(int Number, double CurrentLimit);
/// <summary>Output bench test: mode on | pwm | off; duty %, freq Hz (0 = the output's own), hold s (1–30).</summary>
public record OutputTestReq(string? Mode, int Duty = 100, int Freq = 0, int Hold = 5);
public record CanForceReq(int Id, bool Ide, string? Data, int PeriodMs = 50, int HoldSec = 10);
/// <summary>The module's own var-map inputs (device params 0x0000:10 / :11); null = leave unchanged, 0 = unwired.</summary>
public record DeviceInputsReq(int? ForceSleepInput, int? MuteTxInput, int? RetryAllInput = null, int? ShedInput = null);
// Everything but Number is optional: a field left out of the body keeps the output's current value, so a
// partial body (what the MCP set_output_config tool sends) merges instead of zeroing Enabled/Input/limits.
// The SPA's _binBody always sends every field, so its saves are unchanged.
public record OutputConfigReq(int Number, bool? Enabled = null, int? Input = null, double? CurrentLimit = null, double? InrushLimit = null,
    int? InrushTime = null, int? ResetMode = null, int? ResetTime = null, int? ResetCountLimit = null,
    bool? PwmEnabled = null, int? Freq = null, int? FixedDuty = null, int? MinDuty = null, bool? SoftStart = null, int? SoftStartRamp = null,
    double? WarnLimit = null, double? OpenLoadLimit = null, int? OpenLoadTime = null, string? Name = null,
    string? WireColor = null, string? WireStripe = null, double? WireLength = null, double? WireGaugeMm2 = null,
    bool? VariableDutyCycle = null, int? DutyCycleInput = null, int? DutyCycleDenom = null,
    bool? VariableFreq = null, int? FreqInput = null, int? FreqInputDenom = null, bool? RampDutyChanges = null,
    int? PrimaryOutput = null, double? UnderLimit = null, int? UnderTime = null, bool? UnderTrip = null, bool? ClearOnReassert = null, double? HardShortLimit = null, int? SoftStartTimeout = null, int? SoftStopTime = null, bool? Shed = null, int? ThermalTau = null, bool? StayAlive = null);
public record ApplyProfileReq(string Source);
public record RenameReq(string Name);
public record ReadParamReq(int Index, int Sub);
public record WriteParamReq(int Index, int Sub, uint Value);
public record SdoReadReq(int Node, int Index, int Sub);
public record SdoWriteReq(int Node, int Index, int Sub, uint Value, int Size);
public record SdoNodeReq(int Node);
// Client (G4): the app's own project state to store in the file; null keeps the one already held.
public record ProjReq(string FileName, System.Text.Json.JsonElement? Client = null);
public record LuaReq(string Source);
public record LinkRemoteReq(int CanInput, string SourceGuid, string Signal, bool? NewRule = null);   // NewRule: State = (value != 0) even on a slot in use
public record CrossTrigReq(string Guid, int? VarIndex);
public record CrossTargetReq(string Guid, int Output);
public record CrossFnReq(string? Name, bool Disabled, bool Blink, int BlinkRateMs, CrossTrigReq? Trigger,
    List<CrossTargetReq>? Targets, string? ClockMaster, string? ClockBackup);
public record DeployCrossReq(List<CrossFnReq>? Functions, bool Preview);

// ---------- editable device functions (CAN inputs, conditions, …) ----------
public static class FunctionMap
{
    // Resolve (kind, number) to the live function object + its single param index.
    public static (object? fn, int paramIndex) Resolve(IDevice device, string kind, int number)
    {
        var n = number - 1;
        var k = kind.ToLowerInvariant();
        if (device is PdmDevice p)
            return k switch
            {
                "input" or "pin"      => (p.Inputs.FirstOrDefault(x => x.Number == number), DigitalInput.BaseIndex + n),
                "caninput" or "can"   => (p.CanInputs.FirstOrDefault(x => x.Number == number), CanInput.BaseIndex + n),
                "virtualinput" or "cmb" => (p.VirtualInputs.FirstOrDefault(x => x.Number == number), VirtualInput.BaseIndex + n),
                "condition" or "cmp"  => (p.Conditions.FirstOrDefault(x => x.Number == number), Condition.BaseIndex + n),
                "counter" or "cnt"    => (p.Counters.FirstOrDefault(x => x.Number == number), Counter.BaseIndex + n),
                "flasher" or "fl"     => (p.Flashers.FirstOrDefault(x => x.Number == number), Flasher.BaseIndex + n),
                "timer" or "tmr"      => (p.Timers.FirstOrDefault(x => x.Number == number), TimerFunction.BaseFor(p.Family) + n),
                "table" or "tbl"      => (p.Tables.FirstOrDefault(x => x.Number == number), LookupTable.BaseFor(p.Family) + n),
                "math"                => (p.Maths.FirstOrDefault(x => x.Number == number), MathFunction.BaseIndex + n),
                "canmsg"              => (p.CanMessages.FirstOrDefault(x => x.Number == number), CanMessage.BaseIndex + n),
                "curve"               => (p.Curves.FirstOrDefault(x => x.Number == number), CurveFunction.BaseIndex + n),
                "latchgate" or "lg"   => (p.LatchGates.FirstOrDefault(x => x.Number == number), LatchGateFunction.BaseIndex + n),
                "ignition"            => (p.Ignition, Ignition.BaseIndex),
                "comfortblink"        => (p.ComfortBlink, ComfortBlink.BaseIndex),
                "pid"                 => (p.Pids.FirstOrDefault(x => x.Number == number), PidFunction.BaseIndex + n),
                "canoutput" or "cout" => (p.CanOutputs.FirstOrDefault(x => x.Number == number), CanOutput.BaseIndex + n),
                "wiper" or "wip"      => (p.Wipers, Wiper.BaseIndex),
                "starterdisable" or "std" => (p.StarterDisable, StarterDisable.BaseIndex),
                "keypad"              => (p.Keypads.FirstOrDefault(x => x.Number == number), KeypadMaster.BaseIndex + n),
                "keypadbutton"        => ResolveKeypadButton(p, number),
                "keypaddial"          => ResolveKeypadDial(p, number),
                _ => (null, -1)
            };
        if (device is CanboardDevice c)
            return k switch
            {
                "input" or "pin"      => (c.DigitalInputs.FirstOrDefault(x => x.Number == number), DigitalInput.BaseIndex + n),
                "digitaloutput" or "dout" => (c.DigitalOutputs.FirstOrDefault(x => x.Number == number), DigitalOutput.BaseIndex + n),
                "analoginput" or "ain" => (c.AnalogInputs.FirstOrDefault(x => x.Number == number), AnalogInput.BaseIndex + n),
                "caninput" or "can"   => (c.CanInputs.FirstOrDefault(x => x.Number == number), CanInput.BaseIndex + n),
                "virtualinput" or "cmb" => (c.VirtualInputs.FirstOrDefault(x => x.Number == number), VirtualInput.BaseIndex + n),
                "condition" or "cmp"  => (c.Conditions.FirstOrDefault(x => x.Number == number), Condition.BaseIndex + n),
                "counter" or "cnt"    => (c.Counters.FirstOrDefault(x => x.Number == number), Counter.BaseIndex + n),
                "flasher" or "fl"     => (c.Flashers.FirstOrDefault(x => x.Number == number), Flasher.BaseIndex + n),
                "timer" or "tmr"      => (c.Timers.FirstOrDefault(x => x.Number == number), TimerFunction.BaseFor(c.Family) + n),
                "canoutput" or "cout" => (c.CanOutputs.FirstOrDefault(x => x.Number == number), CanOutput.BaseIndex + n),
                "math"                => (c.Maths.FirstOrDefault(x => x.Number == number), MathFunction.BaseIndex + n),
                "canmsg"              => (c.CanMessages.FirstOrDefault(x => x.Number == number), CanMessage.BaseIndex + n),
                "ignition"            => (c.Ignition, Ignition.BaseIndex),
                "comfortblink"        => (c.ComfortBlink, ComfortBlink.BaseIndex),
                _ => (null, -1)
            };
        return (null, -1);
    }

    // keypadbutton's "number" encodes both keypad + button: number = (kp-1)*32 + buttonNo.
    static (object?, int) ResolveKeypadButton(PdmDevice p, int number)
    {
        var kp = (number - 1) / 32;
        var btn = (number - 1) % 32;
        var b = p.Keypads.ElementAtOrDefault(kp)?.Buttons.ElementAtOrDefault(btn);
        return (b, Button.BaseIndex + (kp * 32) + btn);
    }

    // keypaddial uses the same number encoding as keypadbutton (number = (kp-1)*32 + dialNo, dial 1..2) so
    // callers address both the same way; the param index follows the firmware's dial layout instead —
    // 0x3200 + keypad*4 + dial (core/param_defs.h KEYPAD_DIAL_PARAMS, Dial.InitParams).
    static (object?, int) ResolveKeypadDial(PdmDevice p, int number)
    {
        var kp = (number - 1) / 32;
        var dial = (number - 1) % 32;
        var d = p.Keypads.ElementAtOrDefault(kp)?.Dials.ElementAtOrDefault(dial);
        return (d, Dial.BaseIndex + (kp * 4) + dial);
    }

    // Apply incoming JSON fields onto a function object by JsonPropertyName. Handles the scalar,
    // enum, int[]/bool[]/double[]/string[], enum[] (e.g. Wiper.SpeedMap) and List<bool> shapes the
    // function models use. Returns the names of fields that could NOT be applied (unknown enum value,
    // wrong JSON type, …) so the caller can refuse instead of reporting a silent success. Two-pass:
    // every field is converted first and nothing is written unless all of them pass — otherwise the
    // caller's "nothing was written" on a 400 would be a lie (the good fields had already landed on the
    // record). Fractional numbers sent to an int field are rounded (a browser number input with
    // step="any" emits 60000.5).
    public static List<string> ApplyJson(object target, JsonElement body)
    {
        var rejected = new List<string>();
        var sets = new List<Action>();
        Collect(target, body, "", sets, rejected);
        if (rejected.Count == 0) foreach (var set in sets) set();
        return rejected;
    }

    // Pass 1: convert each field and queue its setter; names are prefixed ("rotary.") for nested objects.
    // Names that aren't a writable model property are skipped on purpose — the SPA posts the whole GET
    // object back (read-only `number`, live values), so those must not fail a save.
    static void Collect(object target, JsonElement body, string prefix, List<Action> sets, List<string> rejected)
    {
        var props = target.GetType().GetProperties()
            .Where(p => p.CanWrite)
            .ToDictionary(p => p.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? p.Name,
                          p => p, StringComparer.OrdinalIgnoreCase);

        foreach (var jp in body.EnumerateObject())
        {
            if (!props.TryGetValue(jp.Name, out var pi)) continue;
            var name = prefix + jp.Name;
            // Nested function objects (AnalogInput.switch / .rotary) — recurse so their fields
            // persist. Without this, an analog input's rotary-switch config was silently dropped.
            if (jp.Value.ValueKind == JsonValueKind.Object)
            {
                var nested = pi.GetValue(target);
                if (nested != null) Collect(nested, jp.Value, name + ".", sets, rejected);
                continue;
            }
            // Collections of nested functions (KeypadMaster.buttons / .dials = List<Button> / List<Dial>)
            // ride along in a round-trip body but are edited through their own kinds (keypadbutton /
            // keypaddial) — skip them rather than fail every keypad save on "invalid value for buttons".
            if (jp.Value.ValueKind == JsonValueKind.Array && IsComplexCollection(pi.PropertyType)) continue;
            var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
            try
            {
                int RoundedInt() => jp.Value.TryGetInt32(out var i) ? i : (int)Math.Round(jp.Value.GetDouble(), MidpointRounding.AwayFromZero);
                object? val =
                    t.IsEnum ? (Enum.IsDefined(t, RoundedInt()) ? Enum.ToObject(t, RoundedInt()) : throw new ArgumentOutOfRangeException(jp.Name, $"{RoundedInt()} is not a valid {t.Name}")) :
                    t == typeof(bool) ? jp.Value.GetBoolean() :
                    t == typeof(int) ? RoundedInt() :
                    t == typeof(double) ? jp.Value.GetDouble() :
                    t == typeof(string) ? jp.Value.GetString() :
                    pi.PropertyType == typeof(int[]) ? jp.Value.EnumerateArray().Select(e => e.GetInt32()).ToArray() :
                    pi.PropertyType == typeof(double[]) ? FitDoubleArray(jp.Value, (double[])pi.GetValue(target)!) :
                    pi.PropertyType == typeof(bool[]) ? jp.Value.EnumerateArray().Select(e => e.GetBoolean()).ToArray() :
                    // labels (RotarySwitch.positionNames); null entries are allowed, a non-string throws → rejected
                    pi.PropertyType == typeof(string[]) ? jp.Value.EnumerateArray().Select(e => e.GetString()).ToArray() :
                    pi.PropertyType == typeof(List<bool>) ? jp.Value.EnumerateArray().Select(e => e.GetBoolean()).ToList() :
                    // enum arrays (e.g. Wiper.SpeedMap = WiperSpeed[]) — coerce each int into the element enum
                    (pi.PropertyType.IsArray && pi.PropertyType.GetElementType()!.IsEnum) ? CoerceEnumArray(pi.PropertyType.GetElementType()!, jp.Value) :
                    null;
                if (val != null || t == typeof(string)) sets.Add(() => pi.SetValue(target, val));
                else rejected.Add(name);
            }
            catch { rejected.Add(name); }
        }
    }

    // A T[] / List<T> whose element is a model class (not string): a nested-function collection, not a value array.
    static bool IsComplexCollection(Type t)
    {
        var elem = t.IsArray ? t.GetElementType()
            : t.IsGenericType && typeof(System.Collections.IEnumerable).IsAssignableFrom(t) ? t.GetGenericArguments().FirstOrDefault()
            : null;
        return elem is { IsClass: true } && elem != typeof(string);
    }

    // Fixed-length double[] (table axes / cells): keep the model's length so a short or over-long
    // array from a client can never shift the param sub-indices — missing entries stay as they were.
    private static double[] FitDoubleArray(JsonElement arr, double[] current)
    {
        var result = (double[])current.Clone();
        var i = 0;
        foreach (var e in arr.EnumerateArray())
        {
            if (i >= result.Length) break;
            result[i++] = e.ValueKind == JsonValueKind.Number ? e.GetDouble() : 0;
        }
        return result;
    }

    // Build a typed enum[] from a JSON array of ints (System.Text.Json can't bind enum[] from raw ints here).
    private static Array CoerceEnumArray(Type elementType, JsonElement arr)
    {
        var items = arr.EnumerateArray().ToArray();
        var result = Array.CreateInstance(elementType, items.Length);
        for (var i = 0; i < items.Length; i++)
            result.SetValue(Enum.ToObject(elementType, items[i].GetInt32()), i);
        return result;
    }
}

// ---------- SignalR hub (server pushes "telemetry" to clients) ----------
public class LiveHub : Hub { }

// ---------- helpers shared by hub broadcaster + REST ----------
public static class DingoMap
{
    // Reject an unknown bitrate string instead of silently defaulting to 500K — a wrong default
    // would put the adapter on the wrong bus speed and the operator would never know why nothing
    // answers. The connect endpoint surfaces this message to the UI.
    public static CanBitRate ParseBitrate(string s) => s switch
    {
        "1000K" => CanBitRate.BitRate1000K, "500K" => CanBitRate.BitRate500K,
        "250K" => CanBitRate.BitRate250K, "125K" => CanBitRate.BitRate125K,
        "100K" => CanBitRate.BitRate100K,
        _ => throw new ArgumentException($"Unknown CAN bitrate '{s}' — use one of 1000K, 500K, 250K, 125K, 100K.")
    };
    public static string BitrateLabel(CanBitRate b) => b switch
    {
        CanBitRate.BitRate1000K => "1000K", CanBitRate.BitRate500K => "500K",
        CanBitRate.BitRate250K => "250K", CanBitRate.BitRate125K => "125K",
        CanBitRate.BitRate100K => "100K", _ => b.ToString()
    };
    public static int ParseId(string s)
    {
        s = (s ?? "").Trim();
        try
        {
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return Convert.ToInt32(s[2..], 16);
            return int.TryParse(s, out var d) ? d : Convert.ToInt32(s, 16);
        }
        catch { return -1; }
    }
    // Friendly label for a VarMap entry (what the original "Variable" dropdown showed).
    public static string VarLabel(DeviceVariable v) =>
        v.SingleVariable || v.PropertyName is "State" or "On" ? v.GetName() : $"{v.GetName()} {v.PropertyName}";

    // Resolve an output's Input index to its source name; falls back to the raw index.
    public static string InputLabel(PdmDevice p, int idx)
    {
        var v = p.VarMap?.FirstOrDefault(x => x.VariableIndex == idx);
        return v == null ? (idx == 0 ? "None" : idx.ToString()) : VarLabel(v);
    }

    // Shared projection of a DBC signal for the /dbc/signals and /dbc/search endpoints.
    public static object DbcSigDto(DbcSignal s) => new {
        s.Name, s.Id, ide = s.IsExtended, s.MessageName, s.StartBit, s.Length,
        byteOrder = (int)s.ByteOrder, s.IsSigned, s.Factor, s.Offset, s.Unit, s.Min, s.Max, s.Value };

    static LockDto? LockOf(IDeviceConfigurable c) => c.Family == domain.Common.FwFamily.Upstream && (c.Lock.Locked || c.ParamSet.Contains(domain.Devices.Functions.ConfigLock.BaseIndex, 0))
        ? new LockDto(true, c.Lock.Locked, c.Lock.Contact, c.Lock.Password != 0) : null;
    static WakeDto? Wake(DeviceUiState? ui) => ui?.WakeReason is int r
        ? new WakeDto(r switch { 1 => "can", 2 => "input", 3 => "usb", _ => "power-on" }, ui.WakeSource, ui.WakeCount) : null;
    static IgnitionDto? Ign(domain.Devices.Functions.Ignition? g, int stateId) => g is null ? null
        : new IgnitionDto(g.Enabled, g.Role == domain.Devices.Functions.IgnitionRole.Main ? "main" : "follower",
            g.State.ToString().ToLowerInvariant(), g.Dash, g.MainStateId, stateId,
            (DateTime.UtcNow - g.LastStateFrame).TotalMilliseconds < 1000);

    public static DeviceDto ToDto(IDevice d, DeviceUiState? ui = null)
    {
        var reading = ui?.Reading ?? false;
        var readDone = ui?.ReadDone ?? 0;
        var readTotal = ui?.ReadTotal ?? 0;
        if (d is IDeviceConfigurable dc) ui?.SyncEdits(() => dc.ConfigMismatch);   // a write or read cleared it: drop the edit list
        if (d is PdmDevice p)
        {
            var outs = p.Outputs.Select(o => new OutputDto(
                o.Number, o.Name, o.State.ToString(), o.Current, o.ResetCount, Math.Clamp(o.CurrentDutyCycle, 0, 100), InputLabel(p, o.Input), o.CurrentLimit,
                o.Enabled, o.Input, o.InrushCurrentLimit, o.InrushTime, (int)o.ResetMode, o.ResetTime, o.ResetCountLimit,
                o.PwmEnabled, o.Frequency, o.FixedDutyCycle, o.MinDutyCycle, o.SoftStartEnabled, o.SoftStartRampTime,
                o.WarnLimit, o.OpenLoadLimit, o.OpenLoadTime, o.WireColor, o.WireStripe, o.WireLength, o.WireGaugeMm2,
                o.VariableDutyCycle, o.DutyCycleInput, o.DutyCycleDenominator, o.VariableFreq, o.FreqInput, o.FreqInputDenom, o.RampDutyChanges,
                o.PrimaryOutput, o.UnderLimit, o.UnderTime, o.UnderTrip, o.ClearOnReassert, o.HardShortLimit, o.SoftStartTimeout, o.SoftStopTime, o.Shed, o.ThermalTau, o.WireLoad, o.StayAlive)).ToArray();
            return new DeviceDto(p.Guid.ToString(), p.Name, p.Type, p.BaseId, p.Connected,
                p.BatteryVoltage, p.TotalCurrent, p.BoardTempC, p.DeviceState.ToString(),
                p.Version, BitrateLabel(p.BitRate), outs, reading, readDone, readTotal,
                p.SleepEnabled, p.SleepTimeoutMs, p.SleepIgnoreAlwaysOn, p.ForceSleepInput, p.MuteTxInput, p.WakeDigInputMask, p.WakeOnCan,
                p.CanBootloader, p.Connected && p.ConfigMismatch, p.LastConfigDiff.Count, false,
                p.CanFiltersEnabled, p.ConnectUsbToCan, StoredOnModule: ui?.StoredOnModule, InBootloader: !p.Connected && ui?.InBootloader == true, PendingEdits: p.ConfigMismatch ? ui?.PendingEdits ?? 0 : 0,
                HasLed: ui?.HasLed, Asleep: ui?.Asleep == true && !p.Connected, LastWake: Wake(ui), SleepCountdownS: p.SleepCountdownS,
                SleepBlockers: ui?.SleepBlockers, Ignition: Ign(p.Ignition, p.BaseId + (p.IgnitionStateOffset ?? domain.Devices.Functions.Ignition.StateOffsetFor(p.Type, p.Family, p.PdmType))),
                Family: p.Family, ParamsRead: p.ParamSet.FromModule, ParamRuns: p.ParamRuns, RetryAllInput: p.HasRetryAll ? p.RetryAllInput : null, ShedInput: p.HasShed ? p.ShedInput : null,
                WakeFrame: p.ParamSet.Contains(domain.Devices.Functions.WakeFrame.Index, 0) ? p.WakeFrame : null, Lock: LockOf(p), HasLua: p.RunsLua);
        }
        if (d is domain.Devices.Canboard.CanboardDevice cb)
            // CANBoard has no battery/total-current sensing (those are PDM smart-output features) — leave
            // them 0; it DOES measure board temperature and reports a FW version, so surface those.
            // TODO: switch to cb.BoardTemp (the live value decoded from the status frame) once the domain
            // model exposes it — BoardTempC is a constant 0 placeholder today.
            return new DeviceDto(cb.Guid.ToString(), cb.Name, cb.Type, cb.BaseId, cb.Connected,
                0, 0, cb.BoardTempC, "", cb.Version, BitrateLabel(cb.BitRate), Array.Empty<OutputDto>(), reading, readDone, readTotal,
                cb.SleepEnabled, cb.SleepTimeoutMs, cb.SleepIgnoreAlwaysOn, cb.ForceSleepInput, cb.MuteTxInput, cb.WakeDigInputMask, cb.WakeOnCan,
                cb.CanBootloader, cb.Connected && cb.ConfigMismatch, cb.LastConfigDiff.Count, CanSleep: cb.CanSleep, StoredOnModule: ui?.StoredOnModule, InBootloader: !cb.Connected && ui?.InBootloader == true, PendingEdits: cb.ConfigMismatch ? ui?.PendingEdits ?? 0 : 0,
                HasLed: ui?.HasLed, Asleep: ui?.Asleep == true && !cb.Connected, LastWake: Wake(ui), SleepCountdownS: cb.SleepCountdownS,
                SleepBlockers: cb.SleepCountdownS != null ? cb.SleepBlockersRaw : ui?.SleepBlockers, Ignition: Ign(cb.Ignition, cb.BaseId + domain.Devices.Functions.Ignition.StateOffsetFor(cb.Type)),
                DigitalOut: cb.DigitalOutputs.Select(o => new DigitalOutDto(o.Number, o.Name, o.Enabled, o.State, o.Input)).ToArray(),
                Family: cb.Family, ParamsRead: cb.ParamSet.FromModule, ParamRuns: cb.ParamRuns, Lock: LockOf(cb));
        return new DeviceDto(d.Guid.ToString(), d.Name, d.Type, d.BaseId, d.Connected,
            0, 0, 0, "", "", "", Array.Empty<OutputDto>(), reading, readDone, readTotal, false, 30000, true, 0, 0, 0, true,
            (d as IDeviceConfigurable)?.CanBootloader ?? false, CanSleep: false);   // an ECU (DBC) or other device: nothing to put to sleep
    }
}

// ---------- background service: stream telemetry + CAN stats over SignalR ----------
public class TelemetryBroadcaster(
    IHubContext<LiveHub> hub,
    DeviceManager deviceManager,
    ICommsAdapterManager adapterManager,
    ConnectionKeeper keeper,
    SystemLogger systemLogger,
    ILogger<TelemetryBroadcaster> logger) : BackgroundService
{
    private long _total, _rate, _rateBase;
    private DateTime _rateStamp = DateTime.Now;
    private readonly HashSet<int> _ids = new();
    private readonly object _lock = new();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        adapterManager.DataReceived += OnFrame;

        // Bridge the (previously dead) backend "Notify" channel to the SignalR clients as a "notify"
        // event. SystemLogger.Notify fires on device success messages AND on the new ack-timeout
        // failures raised in DeviceManager.HandleMessageTimeout — so the UI can finally show a real
        // red toast when a queued write is never acknowledged, instead of a silent Logs-tab line.
        void PushNotify(application.Models.LogEntry e) =>
            _ = hub.Clients.All.SendAsync("notify",
                new { level = e.Level.ToString(), source = e.Source, message = e.Message, ts = e.Timestamp }, ct);
        systemLogger.OnNotify += PushNotify;

        logger.LogInformation("Telemetry broadcaster started");
        try
        {
            while (!ct.IsCancellationRequested)
            {
              try
              {
                var now = DateTime.Now;
                if ((now - _rateStamp).TotalMilliseconds >= 1000)
                { _rate = _total - _rateBase; _rateBase = _total; _rateStamp = now; }

                int[] ids;
                lock (_lock) ids = _ids.OrderBy(x => x).Take(48).ToArray();

                var status = adapterManager.GetStatus();
                // Mark which PDM is the USB<->CAN bridge so the UI flashes it over USB and every other
                // module over CAN. A dingoPDM bridge reports its base id via the dingoFW 'I' reply at
                // connect (GatewayBaseId); a standalone adapter (Kvaser/PCAN/generic SLCAN) never replies,
                // so GatewayBaseId is null and no module is a gateway — everything flashes over CAN.
                var gwBase = adapterManager.GatewayBaseId;
                var devices = deviceManager.GetAllDevices()
                    .Select(d =>
                    {
                        var dto = DingoMap.ToDto(d, deviceManager.GetDeviceUiState(d.Guid));
                        bool isPdm = d.Type?.Contains("pdm", StringComparison.OrdinalIgnoreCase) ?? false;
                        bool isGateway = isPdm && gwBase is int gb && d.BaseId == gb;
                        return isGateway ? dto with { IsGateway = true } : dto;
                    }).ToArray();
                var dto = new TelemetryDto(status.isConnected, status.activeAdapter, _total, _rate, ids, devices, !LiveApi.IsSim(adapterManager), keeper.Reconnecting,
                    AgentGuard.PendingCount, AgentGuard.OldestPendingId);

                await hub.Clients.All.SendAsync("telemetry", dto, ct);
              }
              catch (OperationCanceledException) { throw; }
              catch (Exception ex) { logger.LogWarning(ex, "telemetry tick failed — skipping"); }   // never let one tick stop the host
              await Task.Delay(100, ct); // 10 Hz
            }
        }
        catch (OperationCanceledException) { }
        finally { adapterManager.DataReceived -= OnFrame; systemLogger.OnNotify -= PushNotify; }
    }

    private void OnFrame(object? sender, CanFrameEventArgs e)
    {
        Interlocked.Increment(ref _total);
        // Bound the distinct-ID set: a 29-bit bus (or noise) could otherwise grow it without
        // limit. Only the 48 lowest IDs are ever surfaced, so a few thousand is ample headroom.
        lock (_lock) { if (_ids.Count < 4096) _ids.Add(e.Frame.Id); }
    }
}

// ---------- minimal REST API for commands ----------
public static class LiveApi
{
    // The project as it was last saved / opened / started (G1). null until the first GET: the startup state counts as clean.
    static string? _cleanProject;
    static void MarkClean(ConfigFileManager cfg, DeviceManager dm) => _cleanProject = cfg.SerializeDevices(dm.GetDevices());
    const string SimRefusal = "Sim adapter: programming disabled";
    static readonly System.Text.RegularExpressions.Regex ProgrammingRoute = new(
        @"^/api/(devices/[^/]+/(write|writeall|burn|bootloader|uploadlua|lua|flash|flash-can|apply-profile|output/\d+/test)|flash/blank|system/cross-module/deploy|sdo/(write|store)|can/force)$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    internal static bool IsSim(ICommsAdapterManager m)
    {
        var (connected, active, _) = m.GetStatus();
        return connected && string.Equals(active, "Sim", StringComparison.OrdinalIgnoreCase);
    }
    // G20: module count per project file, keyed by path + write time so the 5 s poll reads each file once.
    static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (DateTime At, int? Count)> _fileCounts = new();
    static int? ModuleCount(FileInfo f) => _fileCounts.AddOrUpdate(f.FullName,
        _ => (f.LastWriteTimeUtc, CountModules(f)),
        (_, old) => old.At == f.LastWriteTimeUtc ? old : (f.LastWriteTimeUtc, CountModules(f))).Count;
    static int? CountModules(FileInfo f)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(f.FullName));
            return doc.RootElement.EnumerateObject()
                .Where(p => p.Value.ValueKind == System.Text.Json.JsonValueKind.Array && (p.Name.EndsWith("Devices") || p.Name.EndsWith("Keypads")))
                .Sum(p => p.Value.GetArrayLength());
        }
        catch { return null; }   // not a project file (or being written): no count
    }
    public static void MapDingoApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        // G5: the Sim adapter replays a log; nothing on it can be programmed. Refuse every write / store /
        // flash / deploy / output test here, so the UI, the AI agent and scripts all get the same answer.
        app.Use(async (ctx, next) =>
        {
            if (HttpMethods.IsPost(ctx.Request.Method) && ProgrammingRoute.IsMatch(ctx.Request.Path.Value ?? "")
                && IsSim(ctx.RequestServices.GetRequiredService<ICommsAdapterManager>()))
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsJsonAsync(new { ok = false, error = SimRefusal });
                return;
            }
            await next();
        });

        // App version for the UI footer — single source of truth is web.csproj <Version>,
        // read from the assembly name (Major.Minor.Build, e.g. 0.6.2).
        api.MapGet("/version", () =>
        {
            var v = typeof(LiveApi).Assembly.GetName().Version;
            return Results.Ok(new { version = v is null ? "0.0.0" : $"{v.Major}.{v.Minor}.{v.Build}" });
        });

        api.MapGet("/adapters", (ICommsAdapterManager m, ConnectionKeeper keeper) =>
        {
            var (adapters, ports) = m.GetAvailable();
            var s = m.GetStatus();
            return Results.Ok(new AdaptersDto(adapters, ports, s.isConnected, s.activeAdapter, s.activePort, m.GatewayBaseId, !IsSim(m),
                keeper.Reconnecting, keeper.AutoConnect, keeper.AutoReconnect, keeper.Last));
        });

        // G11: SLCAN-over-TCP bridges that announce _slcan._tcp on the local network (DNS-SD / mDNS).
        api.MapGet("/adapters/discover", async (int? ms) =>
        {
            var list = await MdnsBrowser.BrowseAsync(TimeSpan.FromMilliseconds(Math.Clamp(ms ?? 1500, 200, 5000)));
            return Results.Ok(new { bridges = list.Select(b => new { name = b.Name, host = b.Host, address = b.Address, port = b.Port, url = b.Url }) });
        });

        api.MapPost("/connect", async (ConnectReq r, ConnectionKeeper keeper) =>
        {
            try
            {
                var (ok, port, error) = await keeper.ConnectAsync(r.Adapter, r.Port, DingoMap.ParseBitrate(r.Bitrate));
                return r.Adapter == "USB" ? Results.Ok(new { ok, port, error }) : Results.Ok(new { ok, error });
            }
            catch (Exception ex) { return Results.BadRequest(new { ok = false, error = ex.Message }); }
        });

        // G10: connect at startup / reconnect when the link drops (remembered in the user preferences)
        api.MapPost("/connection/options", (ConnectionOptionsReq r, ConnectionKeeper keeper) =>
        {
            keeper.SetOptions(r.AutoConnect, r.AutoReconnect);
            return Results.Ok(new { autoConnect = keeper.AutoConnect, autoReconnect = keeper.AutoReconnect });
        });

        // Re-ask the module on USB for its base id (it moves when re-addressed); returns { gatewayBaseId }.
        api.MapPost("/usb/identify", async (ICommsAdapterManager m) =>
            Results.Ok(new { gatewayBaseId = await m.ReidentifyAsync() }));

        api.MapPost("/disconnect", async (ConnectionKeeper keeper) =>
            Results.Ok(new { ok = await keeper.DisconnectAsync() }));

        // Is the connected adapter able to filter the bus at the wire — i.e. can it flash a module over
        // CAN on a busy bus without losing responses? Probes the live adapter (see ProbeFilterAsync) and
        // returns { suitable, mechanism, message }. Needs some bus traffic to test against.
        api.MapPost("/adapter/probe-filter", async (ICommsAdapterManager m) =>
        {
            var a = m.ActiveAdapter;
            if (a is null) return Results.Json(new { suitable = (bool?)null, mechanism = "none", message = "Not connected." });
            var p = await a.ProbeFilterAsync();
            return Results.Json(new { suitable = p.Suitable, mechanism = p.Mechanism, message = p.Message });
        });

        // Auto-discover devices on the bus: PDMs broadcast a contiguous run of status
        // frames starting at BaseId + CyclicRxOffset(2). A run of >=3 consecutive 8-byte
        // RX ids => a device at (runStart - 2).
        api.MapGet("/discover", (CanMsgLogger log) =>
        {
            var ids = log.GetMessageSum()
                .Where(m => m.Direction == DataDirection.Rx && m.Len == 8 && m.Count >= 10) // cyclic only; skip sparse config frames (see /identify)
                .Select(m => m.Id).Distinct().OrderBy(x => x).ToList();
            var found = new List<object>();
            int i = 0;
            while (i < ids.Count)
            {
                int j = i;
                while (j + 1 < ids.Count && ids[j + 1] == ids[j] + 1) j++;
                int runLen = j - i + 1;
                if (runLen >= 3)
                {
                    int baseId = ids[i] - 2; // CyclicRxOffset
                    if (baseId > 0)
                        found.Add(new { baseId, hex = "0x" + baseId.ToString("X3"), statusId = "0x" + ids[i].ToString("X3"), msgs = runLen });
                }
                i = j + 1;
            }
            return Results.Ok(found);
        });

        // Identify devices on the bus. Discovery is passive (broadcast signature); device type is
        // then confirmed actively by sending a Version request to each candidate base and reading
        // the BOARD_ID byte (data8[1]) of the reply — 0=dingoPDM, 1=PDM-MAX, 2=CANBoard, 3=PT-DPDM4 (upstream). Firmware
        // older than the BOARD_ID change replies 0, so detection falls back to the run-length
        // heuristic. CANopen keypads emit heartbeat 0x700+node + buttons 0x180+node. DBC reader
        // devices are passive and can't be detected — add those by hand.
        api.MapGet("/identify", async (CanMsgLogger log, ICommsAdapterManager adapter) =>
        {
            var rx = log.GetMessageSum().Where(m => m.Direction == DataDirection.Rx).ToList();
            var found = new List<object>();
            var claimed = new HashSet<int>();
            // Diagnostic: every RX id seen, so the UI can show "what's on the bus" even when
            // classification misses (and the user can add a device by hand from it).
            var seen = rx.OrderBy(m => m.Id)
                .Select(m => new { id = m.Id, hex = "0x" + m.Id.ToString("X3"), len = m.Len, count = m.Count })
                .ToArray();

            // CANopen keypads. A heartbeat (0x700+node) ALONE isn't enough — a busy ECU bus has frames
            // all over that range. Require the matching button TPDO (0x180+node) too, which a real
            // Blink/Grayhill keypad always broadcasts; an ECU won't have that exact pair.
            foreach (var m in rx.Where(m => m.Id is >= 0x701 and <= 0x77F).OrderBy(m => m.Id))
            {
                int node = m.Id - 0x700;
                if (!rx.Any(x => x.Id == 0x180 + node)) continue;   // heartbeat only → not a confirmed keypad
                var type = node == 0x0A ? "grayhillkeypad" : "blinkkeypad";
                found.Add(new {
                    type, baseId = node, hex = "0x" + node.ToString("X2"),
                    label = type == "grayhillkeypad" ? "Grayhill keypad" : "Blink Marine keypad",
                    confidence = "high",
                    detail = $"CANopen node {node} (heartbeat + buttons)"
                });
                foreach (var off in new[] { 0x180, 0x280, 0x380, 0x480, 0x580, 0x600, 0x700 }) claimed.Add(off + node);
            }

            // dingoPDM / CANBoard: contiguous run of 8-byte status frames, base = runStart - 2.
            // Build the run from CYCLIC broadcasts ONLY. A device's one-off config frames at base+0
            // (replies) and base+1 (request echoes) are sparse; when they linger on the bus they sit
            // just below the cyclic run (which starts at base+2), drag runStart down two IDs, and make
            // runStart-2 land two below the real base — which then probes the wrong Version id. That is
            // exactly what mis-detected the CANBoard (base 0x640 frames at 0x640/0x641 → inferred 0x63E
            // → probed 0x63F not 0x641 → no reply → "unconfirmed, default PDM"). Cyclic frames are sent
            // ~10 Hz so they pass count>=10 within a second; sparse config one-offs do not.
            const int cyclicMinCount = 10;
            var ids = rx.Where(m => m.Len == 8 && m.Count >= cyclicMinCount && !claimed.Contains(m.Id))
                        .Select(m => m.Id).Distinct().OrderBy(x => x).ToList();
            var candidates = new List<(int baseId, int runLen, int statusId)>();
            int i = 0;
            while (i < ids.Count)
            {
                int k = i;
                while (k + 1 < ids.Count && ids[k + 1] == ids[k] + 1) k++;
                int runLen = k - i + 1;
                if (runLen >= 2 && ids[i] - 2 > 0) candidates.Add((ids[i] - 2, runLen, ids[i]));
                i = k + 1;
            }

            // Active confirm — REQUIRED. A contiguous run of 8-byte cyclic frames is necessary but not
            // sufficient: a busy ECU bus (or a replayed ECU log) is full of such runs and would otherwise
            // be mis-reported as dozens of "dingoPDMs". So we only report a device that ANSWERS the dingo
            // Version probe (sent to base+1, reply with BOARD_ID at base+0) — ECU/sim traffic never does.
            // Fire every probe first, then wait once, so the scan doesn't take 250ms × candidate count.
            if (adapter.ActiveAdapter is not null && candidates.Count > 0)
            {
                // Pre-probe frame counts. A real dingo's base+0 (config-reply id) is SILENT until probed,
                // so any candidate whose base+0 is already a live frame on the bus is ECU/sim traffic, not
                // a module — drop it before we even probe (this is what mis-detected the ECU log).
                // Reject any candidate whose base+0 is a CYCLIC broadcast (an ECU id), not the occasional
                // config reply a real dingo emits. (count threshold, not >0, so a lingering reply from a
                // previous scan doesn't disqualify a real module on rescan.)
                var preCount = rx.GroupBy(m => m.Id).ToDictionary(g2 => g2.Key, g2 => g2.Sum(m => m.Count));
                // Counts are cumulative since the log started, so a module we have read or written answers
                // at base+0 far more than 10 times. Those replies are explained by our own requests at base+1:
                // only base+0 traffic that we never asked for marks an ECU id.
                var asked = log.GetMessageSum().Where(m => m.Direction == DataDirection.Tx).Select(m => m.Id).ToHashSet();
                var probe = candidates.Where(c => asked.Contains(c.baseId + 1)
                    || !(preCount.TryGetValue(c.baseId, out var c0) && c0 >= cyclicMinCount)).ToList();

                foreach (var (baseId, _, _) in probe)
                {
                    try
                    {
                        await adapter.ActiveAdapter.WriteAsync(
                            new CanFrame(baseId + 1, 8, new byte[] { (byte)MessageCommand.Version, 0, 0, 0, 0, 0, 0, 0 }),
                            CancellationToken.None);
                    }
                    catch { /* ignore — unconfirmed candidates are dropped below */ }
                }
                await Task.Delay(300);
                var sum = log.GetMessageSum();
                foreach (var (baseId, runLen, statusId) in probe)
                {
                    // Confirm: a genuine Version reply appeared at the (previously silent) base+0, echoing
                    // the Version command with a valid BOARD_ID (0=PDM, 1=Max, 2=CANBoard). ECU/sim traffic
                    // can't produce this — there's no device to answer our probe.
                    var reply = sum.FirstOrDefault(x =>
                        x.Id == baseId && x.Direction == DataDirection.Rx &&
                        x.Payload is { Length: >= 2 } p && p[0] == (byte)MessageCommand.Version);
                    if (reply?.Payload is not { Length: >= 2 } pl || pl[1] > 3) continue;
                    int boardId = pl[1];
                    // Upstream dingoFW (major 0) sends no board id (0) unless built with feat/board-id-and-image-markers
                    // (1 Max, 2 CANBoard, 3 PT-DPDM4; a dingoPDM is 0 either way). Without one: a PDM always broadcasts
                    // its first 5 status frames and says its type in Msg 0 byte 1 (high nibble), a CANBoard only 3.
                    var upstream = pl.Length >= 8 && pl[4] == 0;
                    var guessed = upstream && boardId == 0;
                    if (guessed)
                        boardId = runLen < 5 ? 2
                            : sum.FirstOrDefault(x => x.Id == statusId && x.Direction == DataDirection.Rx)?.Payload is { Length: >= 2 } st && st[1] >> 4 is 1 or 2 ? 10 + (st[1] >> 4) : 0;
                    var (type, label) = boardId switch
                    {
                        2 => ("canboard", "CANBoard"),
                        1 or 11 => ("pdm", "dingoPDM-Max"),
                        3 or 12 => ("pdm:2", "PT-DPDM"),
                        _ => ("pdm", "dingoPDM"),
                    };
                    // G8: the same reply carries the firmware version (bytes 4..7, as the device classes read it)
                    var version = pl.Length >= 8 ? $"v{pl[4]}.{pl[5]}.{(pl[6] << 8) + pl[7]}" : null;
                    found.Add(new {
                        type, baseId, hex = "0x" + baseId.ToString("X3"), label, confidence = "high", version,
                        detail = guessed ? $"upstream dingoFW at 0x{baseId:X3}, board told by its status frames ({runLen}): check the type"
                            : $"identified via BOARD_ID {boardId} at 0x{baseId:X3} ({runLen} status frames)"
                    });
                }
            }
            return Results.Ok(new { found, seen });
        });

        // Raw recent frames (decode protocol on the wire). ?id=222&count=400
        api.MapGet("/rawlog", (int? id, int? count, CanMsgLogger log) =>
            Results.Ok(log.GetRecentHistory(count ?? 400)
                .Where(e => id == null || e.Id == id)
                .Select(e => new {
                    dir = e.Direction.ToString(),
                    id = e.Id, hex = "0x" + e.Id.ToString("X3"),
                    data = e.Payload == null ? "" : string.Join(" ", e.Payload.Select(b => b.ToString("X2")))
                })));

        api.MapGet("/devices", (DeviceManager dm) =>
            Results.Ok(dm.GetAllDevices().Select(d => DingoMap.ToDto(d, dm.GetDeviceUiState(d.Guid))).ToArray()));

        // Device hardware specs (counts + per-output current ratings, per model). The single source
        // of truth is pdm-definitions.json; the UI reads ratings (etc.) from here, not hardcoded.
        api.MapGet("/definitions", (DeviceDefinitionManager defs) =>
            Results.Ok(new { pdms = defs.GetAllPdms(), canboards = defs.GetAllCanboards() }));

        api.MapPost("/devices", (AddDeviceReq r, DeviceManager dm) =>
        {
            var id = DingoMap.ParseId(r.BaseId);
            // A DBC/ECU device has no base id (its ids come from the DBC's messages), so 0 is allowed.
            var isDbc = r.Type?.StartsWith("dbc", StringComparison.OrdinalIgnoreCase) ?? false;
            if (id < 0 || (id == 0 && !isDbc)) return Results.BadRequest(new { ok = false, error = "Invalid base ID" });
            try { dm.AddDevice(r.Type, string.IsNullOrWhiteSpace(r.Name) ? r.Type : r.Name, id); }
            catch (ArgumentException ex) { return Results.BadRequest(new { ok = false, error = ex.Message }); }
            return Results.Ok(new { ok = true });
        });

        // Add a device of the same kind (and PDM model) as {guid} at another base id; returns its guid.
        api.MapPost("/devices/{guid}/add-like", (string guid, AddDeviceReq r, DeviceManager dm) =>
        {
            var id = DingoMap.ParseId(r.BaseId);
            if (!Guid.TryParse(guid, out var g) || id < 1 || id > 0x7FF) return Results.BadRequest(new { ok = false, error = "Invalid device or base ID" });
            var made = dm.AddLike(g, string.IsNullOrWhiteSpace(r.Name) ? "Module" : r.Name, id);
            return made is Guid m ? Results.Ok(new { ok = true, guid = m }) : Results.BadRequest(new { ok = false, error = "Only a PDM or CANBoard can be copied" });
        });

        // Rename only — sets the project label, no CAN traffic / no base-ID change. (The name
        // is a project-side label; the firmware doesn't store it.)
        api.MapPost("/devices/{guid}/rename", (string guid, RenameReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var name = (r.Name ?? "").Trim();
            if (name.Length == 0) return Results.Text("Name can't be empty.", "text/plain", null, 400);
            if (!dm.RenameDevice(g, name)) return Results.NotFound();
            return Results.Ok(new { ok = true });
        });

        api.MapPost("/devices/{guid}/modify", (string guid, ModifyReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var newId = DingoMap.ParseId(r.BaseId);
            // A standard CAN ID is 11-bit. The module also uses baseId-1 (settings) and
            // baseId+1/+2 (config/status), so it must sit in [1, 0x7FF]. Out-of-range IDs
            // are silently rejected by the firmware's param range check (max 0x7FF) — the
            // module just never moves. Reject up front with a clear message instead.
            if (newId < 1 || newId > 0x7FF)
                return Results.Text($"Base ID {r.BaseId} is out of range — must be 0x001–0x7FF (1–2047). A standard CAN ID is 11-bit.", "text/plain", null, 400);
            dm.ModifyDeviceConfig(g, r.Name, newId);
            return Results.Ok(new { ok = true });
        });

        // Set an output's current limit (used by the output editor; also the write-path test hook)
        api.MapPost("/devices/{guid}/output", async (string guid, SetOutputReq r, DeviceManager dm, ICommsAdapterManager adapters, HttpContext http) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var d = dm.GetDevice<PdmDevice>(g);
            var o = d?.Outputs.FirstOrDefault(x => x.Number == r.Number);
            if (o == null) return Results.NotFound();
            var track = Track("output", o.Number, $"o{o.Number}", o);
            o.CurrentLimit = r.CurrentLimit;                 // project-record edit (always)
            // Push it to the module over CAN only when it's live, and report which happened so a
            // caller (e.g. the MCP set_output tool, described as "live") never reads the in-memory
            // change as a confirmed device write.
            if (!await IsLiveEditAsync(http, g, dm, adapters, track)) return Results.Ok(new { ok = true, o.Number, o.CurrentLimit, written = false, staged = Staged(http) });
            var res = await dm.WriteAndConfirm(g, dm.FunctionParamKeys(g, 0x1000 + (r.Number - 1)), () => dm.WriteOutputParams(g, r.Number));
            return WriteReport(res, new() { ["Number"] = o.Number, ["CurrentLimit"] = o.CurrentLimit });
        });

        // Output bench test (firmware ≥ 5.5.107, MsgCmd 48): force an output on / PWM for a bounded hold.
        // Live only — nothing is saved; the module releases by itself when the hold expires, so the UI
        // re-sends while the test runs and sends mode "off" to stop early.
        api.MapPost("/devices/{guid}/output/{n:int}/test", async (string guid, int n, OutputTestReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            // PDM Profet outputs or CANBoard digital outputs — same command, same (1-based) index space.
            var dev = dm.GetDevice(g);
            bool? enabled = dev switch
            {
                PdmDevice p => p.Outputs.FirstOrDefault(x => x.Number == n)?.Enabled,
                CanboardDevice c => c.DigitalOutputs.FirstOrDefault(x => x.Number == n)?.Enabled,
                _ => null
            };
            if (enabled == null) return Results.NotFound();
            int mode = (r.Mode ?? "off").ToLowerInvariant() switch { "on" => 1, "pwm" => 2, "off" => 0, _ => -1 };
            if (mode < 0) return Results.BadRequest(new { ok = false, error = "mode must be on, pwm or off" });
            if (!await IsLiveModuleAsync(g, dm, adapters)) return Results.BadRequest(new { ok = false, error = "module is offline — an output test needs a live module" });
            if (mode != 0 && enabled == false)
                return Results.BadRequest(new { ok = false, error = dev is PdmDevice
                    ? $"output {n} is disabled — enable it and set its current limit first; the test runs under that protection"
                    : $"output {n} is disabled — enable it and Save first" });
            var hold = Math.Clamp(r.Hold, 1, 30);
            if (dev is IDeviceConfigurable { Family: domain.Common.FwFamily.Upstream })
            {
                // Upstream: only feat/output-bench-test firmware has the command, so wait for its echo (none = no
                // test); it needs a real frequency for PWM (0 = the output's own) and refuses what OutputTestRules lists.
                var freq = r.Freq > 0 ? r.Freq : (dev as PdmDevice)?.Outputs.First(x => x.Number == n).Frequency ?? 0;
                if (domain.Common.OutputTestRules.Refusals(dev, n, mode, freq) is { Count: > 0 } why)
                    return Results.Json(new { ok = false, error = $"The module would refuse this test: {string.Join("; ", why)}." }, statusCode: 409);
                var ok = await dm.TestOutputConfirmed(g, n, mode, Math.Clamp(r.Duty, 0, 100), Math.Clamp(freq, 0, 400), hold);
                if (ok == null) return Results.Json(new { ok = false, error = "No answer from the module: its firmware has no output test command (upstream dingoFW without the bench test)." }, statusCode: 409);
                if (ok == false) return Results.Json(new { ok = false, error = $"The module refused the test. It runs only on an output that is enabled on the module (Apply first), not tripped, not paired, while the module runs normally{(mode == 2 ? $", at {domain.Common.OutputTestRules.MinPwmHz}-{domain.Common.OutputTestRules.MaxPwmHz} Hz and up to 100 %" : "")}." }, statusCode: 409);
            }
            else dm.TestOutput(g, n, mode, Math.Clamp(r.Duty, 0, 100), Math.Clamp(r.Freq, 0, 400), hold);
            return Results.Ok(new { ok = true, output = n, mode = mode == 1 ? "on" : mode == 2 ? "pwm" : "off", holdSec = hold });
        });

        // Apply an output's config from the editor, then write that output's params to the
        // device (paced). Burn separately to persist to flash.
        api.MapPost("/devices/{guid}/outputconfig", async (string guid, OutputConfigReq r, DeviceManager dm, ICommsAdapterManager adapters, HttpContext http) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var d = dm.GetDevice<PdmDevice>(g);
            var o = d?.Outputs.FirstOrDefault(x => x.Number == r.Number);
            if (o == null) return Results.NotFound();
            var track = Track("output", o.Number, string.IsNullOrWhiteSpace(o.Name) ? $"o{o.Number}" : $"o{o.Number} {o.Name}", o);
            var prevDutyInput = o.DutyCycleInput;
            if (r.Name != null) o.Name = r.Name;          // label only — not written over CAN
            if (r.WireColor != null) o.WireColor = r.WireColor;    // documentation labels only
            if (r.WireStripe != null) o.WireStripe = r.WireStripe;
            if (r.WireLength != null) o.WireLength = r.WireLength.Value;
            if (r.WireGaugeMm2 != null) o.WireGaugeMm2 = r.WireGaugeMm2.Value;
            // Only fields present in the body are assigned (see OutputConfigReq) — a partial MCP body
            // must not reset the rest of the output to zero.
            if (r.Enabled is { } en) o.Enabled = en;
            if (r.Input is { } inp) o.Input = inp;
            if (r.CurrentLimit is { } cl) o.CurrentLimit = cl;
            if (r.InrushLimit is { } il) o.InrushCurrentLimit = il;
            if (r.InrushTime is { } it) o.InrushTime = it;
            if (r.ResetMode is { } rm) o.ResetMode = (ResetMode)rm;
            if (r.ResetTime is { } rt) o.ResetTime = rt;
            if (r.ResetCountLimit is { } rcl) o.ResetCountLimit = rcl;
            if (r.PwmEnabled is { } pwm) o.PwmEnabled = pwm;
            if (r.Freq is { } fq) o.Frequency = fq;
            if (r.FixedDuty is { } fd) o.FixedDutyCycle = fd;
            if (r.MinDuty is { } md) o.MinDutyCycle = md;
            if (r.SoftStart is { } ss) o.SoftStartEnabled = ss;
            if (r.SoftStartRamp is { } ssr) o.SoftStartRampTime = ssr;
            if (r.VariableDutyCycle is { } vdc) o.VariableDutyCycle = vdc;
            if (r.DutyCycleInput is { } dci) o.DutyCycleInput = dci;
            if (r.DutyCycleDenom is { } dcd) o.DutyCycleDenominator = dcd;
            if (r.VariableFreq is { } vf) o.VariableFreq = vf;
            if (r.FreqInput is { } fi) o.FreqInput = fi;
            if (r.FreqInputDenom is { } fid) o.FreqInputDenom = fid;
            if (r.RampDutyChanges is { } rdc) o.RampDutyChanges = rdc;
            if (r.PrimaryOutput is { } po) o.PrimaryOutput = po;
            if (r.StayAlive is { } sa) o.StayAlive = sa;
            if (r.WarnLimit is { } wl) o.WarnLimit = wl;
            if (r.OpenLoadLimit is { } oll) o.OpenLoadLimit = oll;
            if (r.OpenLoadTime is { } olt) o.OpenLoadTime = olt;
            if (r.UnderLimit is { } ul) o.UnderLimit = ul;
            if (r.UnderTime is { } ut) o.UnderTime = ut;
            if (r.UnderTrip is { } utr) o.UnderTrip = utr;
            if (r.ClearOnReassert is { } cor) o.ClearOnReassert = cor;
            if (r.HardShortLimit is { } nv32) o.HardShortLimit = nv32;
            if (r.SoftStartTimeout is { } nv30) o.SoftStartTimeout = nv30;
            if (r.SoftStopTime is { } nv31) o.SoftStopTime = nv31;
            if (r.Shed is { } sh) o.Shed = sh;
            if (r.ThermalTau is { } nv33) o.ThermalTau = nv33;
            // duty % = signal ÷ denominator and a PID output already is the duty in %: wiring a PID in sets it to 1
            if (o.DutyCycleInput != prevDutyInput && d!.VarMap.FirstOrDefault(v => v.VariableIndex == o.DutyCycleInput)?.OwnerKind == "pid")
                o.DutyCycleDenominator = 1;
            // The record edit above always persists (offline config authoring). Only push to the
            // module over CAN when it is actually live; report which happened so the UI can say
            // "written to device" vs "saved to project".
            if (!await IsLiveEditAsync(http, g, dm, adapters, track)) return Results.Ok(new { ok = true, written = false, staged = Staged(http) });
            return WriteReport(await dm.WriteAndConfirm(g, dm.FunctionParamKeys(g, 0x1000 + (r.Number - 1)), () => dm.WriteOutputParams(g, r.Number)));
        });

        // Single-param read/write (paced, no bulk burst) — reliable on the USB-direct link.
        api.MapPost("/devices/{guid}/readparam", async (string guid, ReadParamReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (r.Index is < 0 or > 0xFFFF || r.Sub is < 0 or > 0xFF)
                return Results.BadRequest(new { ok = false, error = "Index must be 0–65535 (0xFFFF) and Sub 0–255 (0xFF)." });
            if (await RequireLiveModuleAsync(g, dm, adapters, "read") is { } bad) return bad;
            return dm.ReadParam(g, r.Index, r.Sub) ? Results.Ok(new { ok = true }) : Results.BadRequest();
        });

        api.MapPost("/devices/{guid}/writeparam", async (string guid, WriteParamReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (r.Index is < 0 or > 0xFFFF || r.Sub is < 0 or > 0xFF)
                return Results.BadRequest(new { ok = false, error = "Index must be 0–65535 (0xFFFF) and Sub 0–255 (0xFF)." });
            if (await RequireLiveModuleAsync(g, dm, adapters, "write") is { } bad) return bad;
            if (dm.GetDevice(g) is null) return Results.BadRequest();
            return WriteReport(await dm.WriteAndConfirm(g, [(r.Index, r.Sub)], () => dm.WriteParam(g, r.Index, r.Sub, r.Value)));
        });

        api.MapPost("/devices/{guid}/remove", (string guid, DeviceManager dm) =>
        {
            if (Guid.TryParse(guid, out var g)) dm.RemoveDevice(g);
            return Results.Ok(new { ok = true });
        });

        // Selectable input sources (VarMap) — feeds output/flasher/condition pickers.
        // ?type=bool (default for an output rule) | int | float | omit for all.
        // ?inUse=true → only vars whose owning function is configured (what a picker should offer: the
        // module's own system signals, enabled inputs/functions, Lua outs when a program is stored). The
        // Wiring canvas and index resolution keep using the full map.
        api.MapGet("/devices/{guid}/inputs", (string guid, string? type, bool? inUse, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not { } dev || dev is not IDeviceConfigurable cfg) return Results.Ok(Array.Empty<object>());
            // "Lua Out N" vars are floats on the firmware but are the normal on/off drivers an output rule
            // points at (setLuaOut writes 0/1), so the bool picker must offer them too.
            var vars = type is null ? cfg.VarMap : cfg.VarMap.Where(v => v.DataType == type || (type == "bool" && v.OwnerKind == "lua"));
            if (inUse == true) vars = vars.Where(v => VarInUse(dev, v));
            // a signal newer firmware added does not exist on this module: never offer it as a source
            vars = vars.Where(v => domain.Common.Firmware.Has(cfg.Version, v.MinFirmware));
            // kind/number/prop = the owning function slot, so clients can resolve an index to its function
            // without reconstructing names (a CAN input and a table both called "Fan" collide by name).
            return Results.Ok(vars.Select(v => new { index = v.VariableIndex, name = DingoMap.VarLabel(v), kind = v.OwnerKind, number = v.OwnerNumber, prop = v.PropertyName, type = v.DataType }).ToArray());
        });

        // All editable function arrays — feeds the Signals & logic editor (PDM + CANBoard).
        api.MapGet("/devices/{guid}/functions", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.Ok(new { });
            // Upstream dingoFW: a block the module doesn't have is left out (null), so the UI shows "not on this
            // board". FEATURE BRANCHES: gate your block here by its param base (stock = in upstream's own layout).
            bool Has(IDeviceConfigurable d, int b, bool stock = false) => d.Family == domain.Common.FwFamily.Fork || domain.Common.FwFamily.HasBlock(d, b, stock);
            if (dm.GetDevice(g) is PdmDevice p)
                return Results.Ok(new
                {
                    inputs = p.Inputs, canInputs = p.CanInputs, virtualInputs = p.VirtualInputs,
                    conditions = p.Conditions, counters = p.Counters, flashers = p.Flashers,
                    timers = Has(p, TimerFunction.BaseFor(p.Family), true) ? p.Timers : null,
                    tables = Has(p, LookupTable.BaseFor(p.Family)) ? p.Tables.Take(p.TableCount).ToList() : null,
                    maths = Has(p, MathFunction.BaseIndex) ? p.Maths : null, canMessages = Has(p, CanMessage.BaseIndex) ? p.CanMessages : null,
                    curves = p.Family == domain.Common.FwFamily.Upstream && Has(p, CurveFunction.BaseIndex) ? p.Curves : null,   // upstream feat/curve-block only
                    latchGates = p.Family == domain.Common.FwFamily.Upstream && Has(p, LatchGateFunction.BaseIndex) ? p.LatchGates : null,   // upstream feat/latch-gate-block only
                    ignition = p.Ignition,   // firmware 5.6
                    comfortBlinks = Has(p, ComfortBlink.BaseIndex) ? new[] { p.ComfortBlink } : null,   // 5.6.1 (one; an array for the flow builder)
                    pids = p.Family == domain.Common.FwFamily.Upstream && Has(p, PidFunction.BaseIndex) ? p.Pids : null,   // upstream feat/pid only
                    canOutputs = p.CanOutputs, wiper = p.Wipers, starterDisable = p.StarterDisable,
                    keypads = p.Keypads,
                    device = new { forceSleepInput = p.ForceSleepInput, muteTxInput = p.MuteTxInput, canSleep = p.CanSleep, retryAllInput = p.HasRetryAll ? p.RetryAllInput : (int?)null, shedInput = p.HasShed ? p.ShedInput : (int?)null },
                });
            if (dm.GetDevice(g) is CanboardDevice c)
                return Results.Ok(new
                {
                    analogIn = c.AnalogInputs, digitalIn = c.DigitalInputs, digitalOut = c.DigitalOutputs,
                    canInputs = c.CanInputs, virtualInputs = c.VirtualInputs, conditions = c.Conditions,
                    counters = c.Counters, flashers = c.Flashers, timers = Has(c, TimerFunction.BaseFor(c.Family)) ? c.Timers : null, canOutputs = c.CanOutputs,
                    maths = Has(c, MathFunction.BaseIndex) ? c.Maths : null, canMessages = Has(c, CanMessage.BaseIndex) ? c.CanMessages : null,
                    ignition = c.Ignition,   // firmware 5.6
                    comfortBlinks = Has(c, ComfortBlink.BaseIndex) ? new[] { c.ComfortBlink } : null,   // 5.6.1
                    device = new { forceSleepInput = c.ForceSleepInput, muteTxInput = c.MuteTxInput, canSleep = c.CanSleep },
                });
            return Results.Ok(new { });
        });

        // The module's own var-map inputs — the force-sleep and mute-TX signals (device params 0x0000:10 / :11).
        // The Wiring canvas wires them like any function input. Record edit persists offline; CAN write when
        // live. Same field-safety as System ▸ Settings: a module-level always-true signal is refused.
        api.MapPost("/devices/{guid}/device-inputs", async (string guid, DeviceInputsReq r, DeviceManager dm, ICommsAdapterManager adapters, HttpContext http) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var dev = dm.GetDevice(g);
            if (dev is not IDeviceConfigurable cfg || dev is not (PdmDevice or CanboardDevice)) return Results.NotFound();
            string? Check(int? idx, string what)
            {
                if (idx is null or 0) return null;
                var v = cfg.VarMap.FirstOrDefault(x => x.VariableIndex == idx);
                if (v == null) return $"signal #{idx} is not in this module's var map";
                if (v.OwnerKind == "sys") return $"\"{DingoMap.VarLabel(v)}\" is always true on a running module — as the {what} it would {(what == "force-sleep input" ? "park the module 1 s after every boot" : "mute its telemetry for good")}; pick a real condition";
                return null;
            }
            if (r.ForceSleepInput is { } fs && !cfg.CanSleep) return Results.BadRequest(new { ok = false, error = "this module's firmware cannot sleep (a CANBoard sleeps from 5.5.111): it has no force-sleep input" });
            if (Check(r.ForceSleepInput, "force-sleep input") is { } e1) return Results.BadRequest(new { ok = false, error = e1 });
            if (Check(r.MuteTxInput, "mute-TX input") is { } e2) return Results.BadRequest(new { ok = false, error = e2 });
            if (r.RetryAllInput is { } ra)
            {
                if (dev is not PdmDevice { HasRetryAll: true }) return Results.BadRequest(new { ok = false, error = "this module's firmware has no retry-all input (upstream dingoFW with fault clear, PDMs only)" });
                if (ra != 0 && !cfg.VarMap.Any(x => x.VariableIndex == ra)) return Results.BadRequest(new { ok = false, error = $"signal #{ra} is not in this module's var map" });
            }
            if (r.ShedInput is { } sh)
            {
                if (dev is not PdmDevice { HasShed: true }) return Results.BadRequest(new { ok = false, error = "this module's firmware has no load-shed input (upstream dingoFW with load shedding, PDMs only)" });
                var sv = cfg.VarMap.FirstOrDefault(x => x.VariableIndex == sh);
                if (sh != 0 && sv == null) return Results.BadRequest(new { ok = false, error = $"signal #{sh} is not in this module's var map" });
                // a module signal (Always On, battery volts, …) is never 0 on a running module: it would shed for good
                if (sh != 0 && sv?.OwnerKind == "sys") return Results.BadRequest(new { ok = false, error = $"\"{DingoMap.VarLabel(sv)}\" is never off on a running module: as the shed input it would keep the opted-in outputs off for good; use a condition (e.g. battery below a voltage)" });
            }
            Dictionary<string, string> DevSnap() => dev is PdmDevice q
                ? new() { ["forceSleepInput"] = q.ForceSleepInput.ToString(), ["muteTxInput"] = q.MuteTxInput.ToString(), ["retryAllInput"] = q.RetryAllInput.ToString(), ["shedInput"] = q.ShedInput.ToString() }
                : new() { ["forceSleepInput"] = ((CanboardDevice)dev).ForceSleepInput.ToString(), ["muteTxInput"] = ((CanboardDevice)dev).MuteTxInput.ToString() };
            var track = new EditTrack("device", 0, "Module", DevSnap);
            switch (dev)
            {
                case PdmDevice p:
                    if (r.ForceSleepInput is { } a) p.ForceSleepInput = a;
                    if (r.MuteTxInput is { } b) p.MuteTxInput = b;
                    if (r.RetryAllInput is { } ra2) p.RetryAllInput = ra2;
                    if (r.ShedInput is { } sh2) p.ShedInput = sh2;
                    break;
                case CanboardDevice c:
                    if (r.ForceSleepInput is { } f) c.ForceSleepInput = f;
                    if (r.MuteTxInput is { } m) c.MuteTxInput = m;
                    break;
            }
            var live = await IsLiveEditAsync(http, g, dm, adapters, track);
            List<DeviceManager.WriteResult>? res = null;
            if (live)
            {
                // fork 0x0000:10 / :11, upstream :8 / :7: take them from the module's own param list
                int SubOf(string n) => cfg.Params.First(p => p.Name == n).SubIndex;
                var keys = new List<(int, int)>();
                if (r.ForceSleepInput is not null) keys.Add((0x0000, SubOf("device.forceSleepInput")));
                if (r.MuteTxInput is not null) keys.Add((0x0000, SubOf("device.muteTxInput")));
                if (r.RetryAllInput is not null) keys.Add((0x0000, SubOf("device.retryAllInput")));
                if (r.ShedInput is not null) keys.Add((0x0000, SubOf("device.shedInput")));
                res = await dm.WriteAndConfirm(g, keys, () =>
                {
                    if (r.ForceSleepInput is { } a) dm.WriteParam(g, 0x0000, SubOf("device.forceSleepInput"), (uint)a);
                    if (r.MuteTxInput is { } b) dm.WriteParam(g, 0x0000, SubOf("device.muteTxInput"), (uint)b);
                    if (r.RetryAllInput is { } c) dm.WriteParam(g, 0x0000, SubOf("device.retryAllInput"), (uint)c);
                    if (r.ShedInput is { } e) dm.WriteParam(g, 0x0000, SubOf("device.shedInput"), (uint)e);
                });
            }
            var (fsNow, mtNow) = dev is PdmDevice pp ? (pp.ForceSleepInput, pp.MuteTxInput) : (((CanboardDevice)dev).ForceSleepInput, ((CanboardDevice)dev).MuteTxInput);
            if (res is null) return Results.Ok(new { ok = true, written = false, staged = Staged(http), forceSleepInput = fsNow, muteTxInput = mtNow });
            return WriteReport(res, new() { ["forceSleepInput"] = fsNow, ["muteTxInput"] = mtNow });
        });

        // Apply one function's fields from the editor, then write its params to the device.
        api.MapPost("/devices/{guid}/function/{kind}/{number:int}", async (string guid, string kind, int number, HttpRequest req, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not IDeviceConfigurable dev) return Results.BadRequest();
            var (fn, paramIndex) = FunctionMap.Resolve(dev, kind, number);
            if (fn == null || paramIndex < 0) return Results.NotFound(new { error = $"unknown function {kind} #{number}" });
            using var doc = await JsonDocument.ParseAsync(req.Body);
            var track = Track(CanonKind(kind), number, FnLabel(kind, number, fn), fn);
            var before = fn is PidFunction ? JsonSerializer.SerializeToElement(fn, fn.GetType()) : default;
            var rejected = FunctionMap.ApplyJson(fn, doc.RootElement);
            // the firmware refuses out-of-range values and runs crossed limits as "disabled": refuse them here
            if (rejected.Count == 0 && fn is PidFunction pid && pid.Problem() is { } why)
            {
                FunctionMap.ApplyJson(fn, before);
                return Results.BadRequest(new { ok = false, error = why + " — nothing was written to the device" });
            }
            // A field the model couldn't take (bad enum value, wrong type) must not become a silent
            // "saved": refuse, and don't push a half-applied slot to the device.
            if (rejected.Count > 0)
                return Results.BadRequest(new { ok = false, error = $"invalid value for {string.Join(", ", rejected)} — nothing was written to the device" });
            // Record edit persists offline; CAN write only when live (see /outputconfig).
            if (!await IsLiveEditAsync(req.HttpContext, g, dm, adapters, track)) return Results.Ok(new { ok = true, written = false, staged = Staged(req.HttpContext) });
            return WriteReport(await dm.WriteAndConfirm(g, dm.FunctionParamKeys(g, paramIndex), () => dm.WriteFunctionParams(g, paramIndex)));
        });

        // Upload one assembled Lua program to the device (chunked, paced on the backend).
        api.MapPost("/devices/{guid}/lua", async (string guid, LuaReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            // Store on the device record (persists in the project JSON, offline-safe), then push over
            // CAN only when the module is live — same model as output/function params. Push it later
            // with device_action "uploadlua" once the module is online.
            if (await NoLuaAsync(g, dm, adapters) is { } nl) return nl;
            dm.StoreLua(g, r.Source ?? "");
            var live = await IsLiveModuleAsync(g, dm, adapters);
            if (live)
            {
                // Wait for the read-back verify + commit, so "written" means the module runs this program.
                var up = dm.StartLuaUpload(g, r.Source ?? "");
                if (up is null)
                    return Results.BadRequest(new { ok = false, error = "upload rejected (too big, or not a Lua-capable PDM)" });
                if (await Task.WhenAny(up, Task.Delay(TimeSpan.FromSeconds(90))) != up || !up.Result)
                    return Results.Json(new { ok = false, written = false, error = "Lua upload didn't verify on the module (see Logs) — it keeps its previous program" }, statusCode: 409);
                dm.GetDeviceUiState(g).LuaOnModule = r.Source ?? "";
            }
            // Slot lint: setLuaOut(n) drives "Lua Out n+1". A whole project was found with every call one slot high —
            // each output silently ran its neighbour's rule. Say so at upload time.
            return Results.Ok(new { ok = true, written = live, warnings = LuaSlotWarnings(dm.GetDevice(g), r.Source ?? "") });
        });

        // Read the stored Lua program back from the device (a live CAN read).
        api.MapGet("/devices/{guid}/lua", async (string guid, bool? stored, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            // ?stored=true: the project's program without touching the bus (a live read takes ~1 min for 2 KB)
            if (stored == true) return Results.Ok(new { source = dm.GetStoredLua(g), live = false });
            // Live: read the running program off the device. Offline: return the stored program from
            // the project record (so cross-module / authored Lua is visible without a live module).
            if (dm.GetDevice(g) is PdmDevice { RunsLua: true } && await IsLiveModuleAsync(g, dm, adapters))
                return Results.Ok(new { source = await dm.ReadLua(g), live = true });
            return Results.Ok(new { source = dm.GetStoredLua(g), live = false });
        });

        // Read the device's last Lua runtime error (empty if none).
        api.MapGet("/devices/{guid}/luaerror", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "read the error state from") is { } bad) return bad;
            if (await NoLuaAsync(g, dm, adapters) is { } nl) return nl;
            var error = await dm.ReadLuaError(g);
            return Results.Ok(new { error });
        });

        // Read the on-device overload (trip) log: events with ±window current waveforms.
        api.MapGet("/devices/{guid}/overloads", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "read trips from") is { } bad) return bad;
            var events = await dm.ReadOverloadLog(g);
            // Upstream dingoFW has the trip log only with feat/overload-trip-log: no answer to the count = no log.
            if (events is null && dm.GetDevice(g) is IDeviceConfigurable { Family: domain.Common.FwFamily.Upstream })
                return Results.Json(new { ok = false, error = "This module's firmware (upstream dingoFW) has no trip log." }, statusCode: 409);
            return Results.Ok(new { events = events ?? [] });
        });

        // Clear the on-device overload log.
        api.MapPost("/devices/{guid}/overloads/clear", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "clear trips on") is { } bad) return bad;
            dm.ClearOverloadLog(g);
            return Results.Ok(new { ok = true });
        });

        // In-app firmware update over USB DFU (raw .bin body): commands the module on USB into DFU and flashes
        // it with dfu-util at the address the image's vector table calls for (relocated app → 0x08004000, the
        // OpenBLT bootloader in sector 0 kept; full image → 0x08000000).
        api.MapPost("/devices/{guid}/flash", async (string guid, HttpRequest req, FirmwareFlashService flasher) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            using var ms = new MemoryStream();
            await req.Body.CopyToAsync(ms);
            var res = await flasher.FlashAsync(g, ms.ToArray());
            return Results.Ok(new { ok = res.Ok, log = res.Log });
        });

        // Flash a new module that isn't in the project (Guid.Empty). If it runs dingo firmware and answers on
        // USB it is commanded into DFU like any other; a blank one must be put in DFU by hand (BOOT0 + reset).
        api.MapPost("/flash/blank", async (HttpRequest req, FirmwareFlashService flasher) =>
        {
            using var ms = new MemoryStream();
            await req.Body.CopyToAsync(ms);
            var res = await flasher.FlashAsync(Guid.Empty, ms.ToArray());
            return Results.Ok(new { ok = res.Ok, log = res.Log });
        });

        // Live flash progress (polled by the UI while a flash is in flight).
        api.MapGet("/flash/status", (FirmwareFlashService flasher) =>
        {
            var s = flasher.Status();
            return Results.Ok(new { busy = s.Busy, percent = s.Percent, phase = s.Phase });
        });

        // Scan for DFU devices (runs dfu-util -l) so the operator can see what's attached before flashing.
        api.MapGet("/flash/dfu", async (FirmwareFlashService flasher) =>
        {
            var s = await flasher.ScanAsync();
            return Results.Ok(new { utilOk = s.UtilOk, util = s.Util, devices = s.DfuDevices, raw = s.Raw });
        });

        // In-app firmware update over CAN (OpenBLT XCP). Upload a .srec (raw body); commands the
        // module into its CAN bootloader and programs it over the live SLCAN link — no USB/DFU.
        // G9: which silent modules sit in their OpenBLT bootloader (after a failed or stopped update). Sends one
        // XCP CONNECT (then DISCONNECT, which keeps the bootloader waiting) per module. Only on request: probing
        // all the time would wake a sleeping car.
        api.MapPost("/devices/bootloader-scan", async (DeviceManager dm, ICommsAdapterManager adapters, CanFlashService can) =>
        {
            if (!adapters.GetStatus().isConnected) return Results.BadRequest(new { error = "Not connected to a CAN adapter — connect first." });
            if (can.Status().Busy) return Results.Json(new { error = "A CAN update is running." }, statusCode: 409);
            var found = new List<object>();
            foreach (var d in dm.GetAllDevices().OfType<IDeviceConfigurable>().Where(d => d.CanBootloader))
            {
                d.UpdateIsConnected();
                var ui = dm.GetDeviceUiState(d.Guid);
                if (d.Connected) { ui.InBootloader = false; continue; }
                using var xcp = new application.Services.XcpCanMaster(adapters, d.BaseId);
                ui.InBootloader = await xcp.ConnectAsync(2, CancellationToken.None);
                if (ui.InBootloader && d is domain.Devices.dingoPdm.PdmDevice up) up.OpenBlt = true;
                if (ui.InBootloader) await xcp.DisconnectAsync(CancellationToken.None);
                found.Add(new { guid = d.Guid, name = d.Name, inBootloader = ui.InBootloader });
            }
            return Results.Ok(found);
        });

        // G9: leave the bootloader: XCP CONNECT + PROGRAM_RESET, so OpenBLT starts the app if it is valid.
        api.MapPost("/devices/{guid}/leave-bootloader", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not { } d) return Results.NotFound();
            using var xcp = new application.Services.XcpCanMaster(adapters, d.BaseId);
            if (!await xcp.ConnectAsync(2, CancellationToken.None))
                return Results.Json(new { ok = false, error = $"{d.Name} did not answer as a bootloader." }, statusCode: 409);
            await xcp.ProgramResetAsync(CancellationToken.None);
            dm.GetDeviceUiState(g).InBootloader = false;
            return Results.Ok(new { ok = true });
        });

        // G12 (firmware 5.6): blink the module's LEDs so the operator can find it. { ok, hasLed }: a CANBoard has none.
        api.MapPost("/devices/{guid}/identify", async (string guid, int? seconds, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "identify") is { } bad) return bad;
            if (dm.GetDevice(g) is not IDeviceConfigurable c) return Results.BadRequest();
            // version not read yet (no Read since the project opened): ask once, up to ~1 s
            for (int i = 0; i < 10 && !c.VersionReceived; i++)
            {
                if (i == 0) dm.RequestVersion(g);
                await Task.Delay(100);
            }
            // upstream dingoFW: only builds with feat/identify have it; the reply tells (others ignore an unknown command)
            var upstream = c.Family == domain.Common.FwFamily.Upstream;
            if (!upstream && !domain.Common.Firmware.Has(c.Version, domain.Devices.Functions.MathFunction.Since))
                return Results.Json(new { ok = false, error = "Needs firmware 5.6: older firmware has no identify command." }, statusCode: 409);
            var ok = await dm.IdentifyConfirmed(g, seconds ?? 10);
            return ok ? Results.Ok(new { ok, hasLed = dm.GetDeviceUiState(g).HasLed })
                      : Results.Json(new { ok, error = upstream ? "No answer: this upstream dingoFW has no identify command." : "The module did not answer." }, statusCode: 409);
        });

        // Why the module last reset (upstream feat/reset-cause, request 55): power-on, brown-out, pin, software, watchdog.
        api.MapGet("/devices/{guid}/resetcause", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "read the reset cause") is { } bad) return bad;
            if (dm.GetDevice(g) is not IDeviceConfigurable c) return Results.BadRequest();
            if (c.Family != domain.Common.FwFamily.Upstream)
                return Results.Json(new { ok = false, error = "This firmware (dingoFW 5.x) does not report why it reset." }, statusCode: 409);
            if (!await dm.ResetCauseConfirmed(g) || dm.GetDeviceUiState(g).ResetFlags is not int f)
                return Results.Json(new { ok = false, error = "No answer: this firmware does not report why it reset." }, statusCode: 409);
            var cb = c is CanboardDevice;
            return Results.Ok(new { ok = true, flags = f, cause = domain.Common.ResetCause.Decode(f, cb), names = domain.Common.ResetCause.Flags(f, cb) });
        });

        // The module's fault history in FRAM (upstream feat/fault-history, PDMs): newest first, survives power-off.
        IResult? NoFaultLog(IDevice? dev) => dev switch
        {
            PdmDevice { Family: domain.Common.FwFamily.Upstream } => null,
            PdmDevice => Results.Json(new { ok = false, error = "This firmware (dingoFW 5.x) keeps no fault history: see its trip log." }, statusCode: 409),
            _ => Results.Json(new { ok = false, error = "Only a PDM keeps a fault history." }, statusCode: 409),
        };
        api.MapGet("/devices/{guid}/faultlog", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "read the fault history") is { } bad) return bad;
            if (NoFaultLog(dm.GetDevice(g)) is { } no) return no;
            if (await dm.ReadFaultLog(g) is not { } log)
                return Results.Json(new { ok = false, error = "No answer: this firmware keeps no fault history." }, statusCode: 409);
            return Results.Ok(new { ok = true, bootCount = log.BootCount, entries = log.Entries });
        });
        api.MapPost("/devices/{guid}/faultlog/clear", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "clear the fault history") is { } bad) return bad;
            if (NoFaultLog(dm.GetDevice(g)) is { } no) return no;
            return await dm.ClearFaultLogConfirmed(g) ? Results.Ok(new { ok = true })
                : Results.Json(new { ok = false, error = "The module did not confirm the clear." }, statusCode: 409);
        });

        // ---- config lock (upstream feat/config-lock, 0x0200) ----
        // The project's password + contact text (no CAN: Apply / Write sends them, a lock takes effect after Store + Restart).
        api.MapPost("/devices/{guid}/lock", (string guid, LockReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not IDeviceConfigurable c) return Results.BadRequest();
            if (r.Contact is { } t)
            {
                if (t.Length > domain.Devices.Functions.ConfigLock.ContactChars || domain.Devices.Functions.ConfigLock.Clean(t) != t)
                    return Results.Json(new { ok = false, error = "The contact text is at most 32 plain characters (letters, digits, spaces, punctuation)." }, statusCode: 400);
                c.Lock.Contact = t;
            }
            if (r.ClearPassword) c.Lock.Password = 0;
            else if (r.Password is { } pw) c.Lock.Password = pw;
            c.ConfigMismatch = true;   // the module does not hold it until the next write
            return Results.Ok(new { ok = true, passwordSet = c.Lock.Password != 0 });
        });
        api.MapPost("/devices/{guid}/unlock", async (string guid, UnlockReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (await RequireLiveModuleAsync(g, dm, adapters, "unlock") is { } bad) return bad;
            return await dm.UnlockConfirmed(g, r.Password) ? Results.Ok(new { ok = true })
                : Results.Json(new { ok = false, error = "Not unlocked: wrong password (after a wrong one, wait a second before the next try)." }, statusCode: 409);
        });
        // Wipes the configuration (password and contact too), keeps base id + bitrate. Every output turns off at once.
        api.MapPost("/devices/{guid}/factoryreset", async (string guid, FactoryResetReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (r.Confirm != "WIPE") return Results.Json(new { ok = false, error = "Type WIPE to confirm a factory reset." }, statusCode: 400);
            if (await RequireLiveModuleAsync(g, dm, adapters, "factory reset") is { } bad) return bad;
            if (dm.GetDevice(g) is not IDeviceConfigurable { Family: domain.Common.FwFamily.Upstream } c || !(c.Lock.Locked || c.ParamSet.Contains(domain.Devices.Functions.ConfigLock.BaseIndex, 0)))
                return Results.Json(new { ok = false, error = "This module's firmware has no factory reset." }, statusCode: 409);
            return await dm.FactoryResetConfirmed(g) ? Results.Ok(new { ok = true })
                : Results.Json(new { ok = false, error = "The module did not confirm that it stored the defaults (see Logs): after a power cycle it may come back with its old configuration. Try again." }, statusCode: 409);
        });

        // Upstream dingoFW: the operator says whether this PDM has the OpenBLT CAN bootloader (no command can tell, and a
        // plain upstream app answers a CAN-update request by jumping to USB-DFU). Saved in the project.
        api.MapPost("/devices/{guid}/openblt", (string guid, bool on, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not PdmDevice { Family: domain.Common.FwFamily.Upstream } p)
                return Results.BadRequest(new { ok = false, error = "Only an upstream dingoFW PDM is marked by hand." });
            p.OpenBlt = on;
            return Results.Ok(new { ok = true, canBootloader = p.CanBootloader });
        });

        api.MapPost("/devices/{guid}/flash-can", async (string guid, HttpRequest req, CanFlashService flasher) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            using var ms = new MemoryStream();
            await req.Body.CopyToAsync(ms);
            var res = await flasher.FlashAsync(g, ms.ToArray());
            return Results.Ok(new { ok = res.Ok, log = res.Log, version = res.Version });
        });

        // Live CAN-flash progress (polled by the UI while a CAN flash is in flight).
        api.MapGet("/flash-can/status", (CanFlashService flasher) =>
        {
            var s = flasher.Status();
            return Results.Ok(new { busy = s.Busy, percent = s.Percent, phase = s.Phase });
        });

        // ---- Declarative whole-system config (AI-friendly): schema + snapshot + apply ----
        // GET schema  -> every device + every setting (name/type/default/enum options) + var-map
        api.MapGet("/config/schema", (SystemConfigService cfg) => Results.Ok(cfg.BuildSchema()));
        // GET template -> a ready-to-edit apply document with EVERY setting at its default,
        // plus a sample Lua program and cross-module guidance. Download, edit, re-import.
        api.MapGet("/config/template", (SystemConfigService cfg) => Results.Ok(cfg.BuildTemplate()));
        // GET snapshot -> current value of every setting (Read the device(s) first). ?lua=true also reads Lua.
        api.MapGet("/config", async (bool? lua, SystemConfigService cfg) => Results.Ok(await cfg.BuildSnapshotAsync(lua ?? false)));
        // POST apply  -> a (full or partial) target document; writes only what differs, burns, uploads Lua.
        api.MapPost("/config", async (HttpRequest req, SystemConfigService cfg) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            var r = await cfg.ApplyAsync(doc.RootElement);
            var ok = r.Errors.Count == 0;
            var payload = new { ok, devicesTouched = r.DevicesTouched, paramsChanged = r.ParamsChanged, notes = r.Notes, errors = r.Errors };
            // Validation failures now surface as HTTP 400 (was 200 + ok:false) so the frontend's
            // !r.ok / fetch-error path fires on the transport layer too, not just the body flag.
            return ok ? Results.Ok(payload) : Results.Json(payload, statusCode: 400);
        });

        // ---- CANopen SDO: read/write a keypad's object dictionary (persistent device settings) ----
        // Bounds: Node 1–127 (CANopen node-id range), Index 0–0xFFFF, Sub 0–0xFF, Size 1/2/4 bytes.
        static IResult? SdoBounds(int node, int index, int sub)
            => node is < 1 or > 127 || index is < 0 or > 0xFFFF || sub is < 0 or > 0xFF
                ? Results.BadRequest(new { ok = false, error = "Node must be 1–127, Index 0–65535 (0xFFFF), Sub 0–255 (0xFF)." })
                : null;
        api.MapPost("/sdo/read", async (SdoReadReq r, SdoService sdo) =>
        {
            if (SdoBounds(r.Node, r.Index, r.Sub) is { } bad) return bad;
            var res = await sdo.ReadAsync(r.Node, (ushort)r.Index, (byte)r.Sub);
            return Results.Ok(new { ok = res.Ok, value = res.Value, abort = res.AbortCode, error = res.Error });
        });
        api.MapPost("/sdo/write", async (SdoWriteReq r, SdoService sdo) =>
        {
            if (SdoBounds(r.Node, r.Index, r.Sub) is { } bad) return bad;
            if (r.Size is not (<= 0 or 1 or 2 or 4))
                return Results.BadRequest(new { ok = false, error = "Size must be 1, 2 or 4 bytes." });
            var res = await sdo.WriteAsync(r.Node, (ushort)r.Index, (byte)r.Sub, r.Value, r.Size <= 0 ? 4 : r.Size);
            return Results.Ok(new { ok = res.Ok, abort = res.AbortCode, error = res.Error });
        });
        // Store (save) the node's parameters to NV memory — OD 0x1010 sub1 = "save".
        api.MapPost("/sdo/store", async (SdoNodeReq r, SdoService sdo) =>
        {
            if (r.Node is < 1 or > 127) return Results.BadRequest(new { ok = false, error = "Node must be 1–127." });
            var res = await sdo.WriteAsync(r.Node, 0x1010, 1, SdoService.SaveSignature, 4, 1500);
            return Results.Ok(new { ok = res.Ok, abort = res.AbortCode, error = res.Error });
        });

        // ---- DBC device: open a .dbc, add custom signals, read live decoded values ----
        // Big ECU DBCs run to tens of thousands of signals, so the full dump is CAPPED (the UI uses
        // /dbc/search). count = the true total; items = the first `limit`.
        api.MapGet("/devices/{guid}/dbc/signals", (string guid, int? limit, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not DbcDevice d) return Results.Ok(new { count = 0, items = Array.Empty<object>() });
            var lim = Math.Clamp(limit ?? 500, 1, 2000);
            return Results.Ok(new { count = d.DbcSignals.Count, items = d.DbcSignals.Take(lim).Select(DingoMap.DbcSigDto).ToArray() });
        });

        // Server-side signal search for big DBCs — substring match on signal OR message name, capped.
        // Returns the absolute id + bit layout so a consumer can fill a CAN input directly (no name
        // round-trip; GM DBCs reuse signal names across messages so name alone isn't unique).
        api.MapGet("/devices/{guid}/dbc/search", (string guid, string? q, int? limit, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not DbcDevice d) return Results.Ok(new { count = 0, items = Array.Empty<object>() });
            var lim = Math.Clamp(limit ?? 100, 1, 5000);
            IEnumerable<DbcSignal> hits = d.DbcSignals;
            if (!string.IsNullOrWhiteSpace(q))
            {
                var needle = q.Trim();
                hits = hits.Where(s => s.Name.Contains(needle, StringComparison.OrdinalIgnoreCase)
                                    || (s.MessageName ?? "").Contains(needle, StringComparison.OrdinalIgnoreCase));
            }
            var list = hits.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).Take(lim + 1).ToList();
            return Results.Ok(new { total = d.DbcSignals.Count, more = list.Count > lim, items = list.Take(lim).Select(DingoMap.DbcSigDto).ToArray() });
        });

        // One-step ECU import: create a DBC device and parse the uploaded .dbc into it in a single call,
        // returning the new device's guid so the UI can bind it. (Saves the add-then-find-then-open dance.)
        api.MapPost("/devices/dbc-import", async (string? name, int? @base, bool? rebase, HttpRequest req, DeviceManager dm) =>
        {
            using var reader = new StreamReader(req.Body);
            var text = await reader.ReadToEndAsync();
            // base 0 = a base-less ECU (absolute message ids). base > 0 = a base-addressed module (e.g. a
            // CANBoard described by its DBC); with rebase the DBC's messages are shifted onto that base.
            var b = @base ?? 0;
            var dev = new DbcDevice(string.IsNullOrWhiteSpace(name) ? "ECU" : name.Trim(), b);
            dm.AddDevices(new List<IDevice> { dev });   // sets the device logger before we parse (parse logs)
            var tmp = Path.Combine(Path.GetTempPath(), $"dingo_{Guid.NewGuid():N}.dbc");
            try { await File.WriteAllTextAsync(tmp, text); await dev.ParseDbcFile(tmp); }
            finally { try { File.Delete(tmp); } catch { } }
            if (b > 0 && (rebase ?? false)) dev.RebaseTo(b);
            return Results.Ok(new { ok = true, guid = dev.Guid.ToString(), count = dev.DbcSignals.Count });
        });

        // Upload the raw .dbc text; parsed via DbcParser (writes to a temp file it owns).
        api.MapPost("/devices/{guid}/dbc/open", async (string guid, HttpRequest req, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not DbcDevice d) return Results.BadRequest();
            using var reader = new StreamReader(req.Body);
            var text = await reader.ReadToEndAsync();
            var tmp = Path.Combine(Path.GetTempPath(), $"dingo_{Guid.NewGuid():N}.dbc");
            try
            {
                await File.WriteAllTextAsync(tmp, text);
                var ok = await d.ParseDbcFile(tmp);
                return Results.Ok(new { ok, count = d.DbcSignals.Count });
            }
            finally { try { File.Delete(tmp); } catch { } }
        });

        api.MapPost("/devices/{guid}/dbc/signal", async (string guid, DbcSignal sig, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not DbcDevice d) return Results.BadRequest();
            var ok = await d.AddCustomSignal(sig);
            return ok ? Results.Ok(new { ok }) : Results.BadRequest(new { ok, error = "id and length are required" });
        });

        // Broadcast-signal catalog: what this device TRANSMITS cyclically, address-agnostic
        // (offset = MessageId - BaseId, so it holds at any base ID). Feeds the cross-module
        // "remote signal" picker — a consumer decodes another module's native frame at
        // base+offset. Derived straight from GetStatusSigs() (the CAN frame map).
        api.MapGet("/devices/{guid}/broadcast-signals", (string guid, bool? inUse, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not { } d)
                return Results.NotFound();
            var baseId = d.BaseId;
            var onlyInUse = inUse ?? false;   // ?inUse=true → only signals whose function is enabled (the picker's view)
            var sigs = d.GetStatusSigs()
                .Where(t => !onlyInUse || SignalInUse(d, t.Signal.Name))
                .Select(t => new
                {
                    name = t.Signal.Name,
                    label = SignalLabel(d, t.Signal.Name),     // the user's name for the owning function ("ignition"), null if none
                    inUse = SignalInUse(d, t.Signal.Name),
                    offset = t.MessageId - baseId,
                    startBit = t.Signal.StartBit,
                    bitLength = t.Signal.Length,
                    factor = t.Signal.Factor,
                    valueOffset = t.Signal.Offset,
                    byteOrder = (int)t.Signal.ByteOrder,
                    signed = t.Signal.IsSigned,
                    // float32 LE payloads (PDM table outputs): a firmware CAN input can't decode those, so
                    // the picker greys them out.
                    isFloat = t.Signal.IsFloat,
                    unit = t.Signal.Unit,
                    kind = t.Signal.Length == 1 ? "bool" : "value",
                })
                .OrderBy(s => s.offset).ThenBy(s => s.startBit)
                .ToList();
            return Results.Ok(sigs);
        });

        // Duplicate CAN-id guard. Builds the map of who TRANSMITS each id across every device (dingo
        // broadcast frames + user CAN outputs, and an imported DBC/ECU's message ids), then reports
        // collisions (an id transmitted by more than one device) and base-id block overlaps. Listening
        // (CAN inputs) is intentionally NOT a conflict — reading an ECU frame is the whole point.
        api.MapGet("/can-id-map", (DeviceManager dm) =>
        {
            var owners = new Dictionary<(int Id, bool Ide), List<string>>();
            void Claim(int id, bool ide, string who)
            {
                var k = (id, ide);
                if (!owners.TryGetValue(k, out var l)) owners[k] = l = new();
                if (!l.Contains(who)) l.Add(who);
            }
            var ranges = new List<(string Name, int Lo, int Hi)>();
            foreach (var d in dm.GetAllDevices())
            {
                var isDbc = d is DbcDevice;
                foreach (var (mid, sig) in d.GetStatusSigs())
                    Claim(mid, sig.IsExtended, $"{d.Name}: {(isDbc ? "ECU " + (string.IsNullOrEmpty(sig.MessageName) ? "msg" : sig.MessageName) : "broadcast")}");
                var couts = d switch { PdmDevice p => p.CanOutputs, CanboardDevice c => c.CanOutputs, _ => (IEnumerable<domain.Devices.Functions.CanOutput>?)null };
                if (couts != null)
                    foreach (var co in couts.Where(x => x.Enabled))
                        Claim(co.Id, co.Ide, $"{d.Name}: CAN out '{co.Name}'");
                // A Lua program's txCan(bus, id, ext, …) frames are transmissions as well — without them a future module
                // placed on those ids would overlap silently.
                if (d is PdmDevice lp && !string.IsNullOrWhiteSpace(lp.LuaProgram))
                    foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(lp.LuaProgram, @"txCan\s*\(\s*\d+\s*,\s*(0[xX][0-9A-Fa-f]+|\d+)\s*,\s*(true|false)"))
                    {
                        var s = m.Groups[1].Value;
                        var id = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? Convert.ToInt32(s[2..], 16) : int.Parse(s);
                        Claim(id, m.Groups[2].Value == "true", $"{d.Name}: Lua txCan");
                    }
                // Span = the module's real TX footprint (same figures as clientapp canids.js and docs/can-frame-map.md):
                // a PDM's 28 cyclic frames sit at base+2..base+29; a CANBoard's 10 at base+2..base+11 plus its
                // OpenBLT bootloader ids at +12/+13.
                if (!isDbc && d is IDeviceConfigurable) ranges.Add((d.Name, d.BaseId, d.BaseId + (d is CanboardDevice ? 13 : 29)));
            }
            // An id sent ONLY by Lua txCan calls on several modules is a deliberate shared id (e.g. a master
            // PDM broadcasts a state and backups take over when it goes quiet): report it as `shared`, not as
            // a collision. Any non-Lua owner on the same id (a broadcast, a CAN output, an ECU) still collides.
            static bool AllLua(List<string> o) => o.All(w => w.EndsWith(": Lua txCan", StringComparison.Ordinal));
            object Row(KeyValuePair<(int Id, bool Ide), List<string>> kv) =>
                new { id = kv.Key.Id, hex = "0x" + kv.Key.Id.ToString("X"), ide = kv.Key.Ide, owners = kv.Value };
            var multi = owners.Where(kv => kv.Value.Count > 1).OrderBy(kv => kv.Key.Id).ToList();
            var collisions = multi.Where(kv => !AllLua(kv.Value)).Select(Row).ToList();
            var shared = multi.Where(kv => AllLua(kv.Value)).Select(Row).ToList();
            var overlaps = new List<object>();
            for (int i = 0; i < ranges.Count; i++)
                for (int j = i + 1; j < ranges.Count; j++)
                    if (ranges[i].Lo <= ranges[j].Hi && ranges[j].Lo <= ranges[i].Hi)
                        overlaps.Add(new { a = ranges[i].Name, b = ranges[j].Name,
                            aRange = $"0x{ranges[i].Lo:X}–0x{ranges[i].Hi:X}", bRange = $"0x{ranges[j].Lo:X}–0x{ranges[j].Hi:X}" });
            // id -> owners, keyed by hex (with an 'x' prefix for extended) so the editor can check one id cheaply.
            var claimed = owners.ToDictionary(kv => (kv.Key.Ide ? "x" : "") + kv.Key.Id.ToString("X"), kv => kv.Value);
            return Results.Ok(new { collisions, overlaps, shared, claimed });
        });

        // ---- Sim playback: replay a CAN-log CSV onto the simulated bus (connect the "Sim" adapter).
        // CSV format is the app's own CAN-log export: header row, then
        //   timestamp(yyyy-MM-dd HH:mm:ss.fff), Rx|Tx, id(hex), length, data(space-separated hex bytes)
        api.MapPost("/sim/load", async (HttpRequest req, application.Services.SimPlayback pb) =>
        {
            // No upload size limit — replay logs can be hundreds of MB. Stream straight to a temp file
            // (never the whole body in memory), then stream-parse it.
            var feat = req.HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
            if (feat is { IsReadOnly: false }) feat.MaxRequestBodySize = null;
            var tmp = Path.Combine(Path.GetTempPath(), $"dingo_sim_{Guid.NewGuid():N}.csv");
            try
            {
                await using (var fs = File.Create(tmp))
                    await req.Body.CopyToAsync(fs);
                var (ok, err) = await pb.LoadFile(tmp);
                return ok ? Results.Ok(new { ok, total = pb.TotalMessages, fileName = pb.CurrentFileName })
                          : Results.BadRequest(new { ok, error = err });
            }
            finally { try { File.Delete(tmp); } catch { } }
        });
        api.MapPost("/sim/play", async (application.Services.SimPlayback pb) => { await pb.Play(); return Results.Ok(new { ok = true }); });
        api.MapPost("/sim/pause", async (application.Services.SimPlayback pb) => { await pb.Pause(); return Results.Ok(new { ok = true }); });
        api.MapPost("/sim/reset", async (application.Services.SimPlayback pb) => { await pb.Reset(); return Results.Ok(new { ok = true }); });
        api.MapPost("/sim/loop", (bool on, application.Services.SimPlayback pb) => { pb.Loop = on; return Results.Ok(new { ok = true, loop = pb.Loop }); });
        api.MapPost("/sim/rate", async (int fps, application.Services.SimPlayback pb) => { await pb.SetRate(Math.Clamp(fps, 1, 100000)); return Results.Ok(new { ok = true, fps = pb.Fps }); });
        api.MapGet("/sim/status", (application.Services.SimPlayback pb) => Results.Ok(new
        {
            state = pb.State.ToString(), fileName = pb.CurrentFileName,
            current = pb.CurrentMessageIndex, total = pb.TotalMessages, loop = pb.Loop,
            timeMs = (int)pb.CurrentTime.TotalMilliseconds,
            syntheticTiming = pb.SyntheticTiming, fps = pb.Fps,
        }));

        // Per-param diff from the last Read — explains WHY a device's config didn't match the app's
        // (value differences, and params each side is missing because of a firmware/app version gap).
        api.MapGet("/devices/{guid}/config-diff", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not IDeviceConfigurable d)
                return Results.NotFound();
            return Results.Ok(d.LastConfigDiff);
        });

        // Sleep and wake log (firmware 5.6.3): every module's "going to sleep" and "woke" reports, newest first.
        api.MapGet("/sleep-log", (DeviceManager dm) =>
        {
            var rows = new List<(IDevice d, SleepEvent e)>();
            foreach (var d in dm.GetAllDevices())
            {
                var ui = dm.GetDeviceUiState(d.Guid);
                lock (ui.SleepLog) rows.AddRange(ui.SleepLog.Select(e => (d, e)));
            }
            return Results.Ok(rows.OrderByDescending(r => r.e.At).Select(r => new { module = r.d.Name, guid = r.d.Guid, kind = r.e.Kind, why = r.e.Why, at = r.e.At.ToString("o") }).ToArray());
        });

        // Item 7: the edits saved to the project and waiting for "Apply to car", one row per field, and a revert of one.
        api.MapGet("/devices/{guid}/pending", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not IDeviceConfigurable d) return Results.NotFound();
            var ui = dm.GetDeviceUiState(g);
            ui.SyncEdits(() => d.ConfigMismatch);
            lock (ui.Edits) return Results.Ok(ui.Edits.Select(e => new { e.Id, e.Kind, e.Number, e.Field, e.What, e.Old, e.New, e.Source, at = e.At.ToString("o") }).ToArray());
        });
        api.MapPost("/devices/{guid}/pending/{id:int}/revert", (string guid, int id, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not { } dev) return Results.NotFound();
            var ui = dm.GetDeviceUiState(g);
            if (dev is IDeviceConfigurable dc) ui.SyncEdits(() => dc.ConfigMismatch);   // just applied: the list is stale
            PendingEdit? e;
            lock (ui.Edits) e = ui.Edits.FirstOrDefault(x => x.Id == id);
            if (e == null) return Results.NotFound(new { ok = false, error = "That change is no longer waiting (it may have been applied)." });
            if (RevertEdit(dev, e) is { } err) return Results.BadRequest(new { ok = false, error = $"{e.What}: {err}" });
            lock (ui.Edits)
            {
                ui.Edits.RemoveAll(x => x.Id == id);
                if (dev is IDeviceConfigurable c2) c2.ConfigMismatch = true;   // the project now differs from the module again
            }
            return Results.Ok(new { ok = true });
        });

        // Cross-module IO picker (feature B), server-side: point a consumer module's CAN input at a
        // SOURCE module's broadcast signal. Resolves the signal's current absolute CAN id + bit layout
        // from the source's frame map and writes the consumer's CAN input — what the UI picker does
        // client-side, in one call. Re-run after a source base-ID change to re-resolve the id.
        api.MapPost("/devices/{guid}/link-remote", async (string guid, LinkRemoteReq r, DeviceManager dm, ICommsAdapterManager adapters, HttpContext http) =>
        {
            if (!Guid.TryParse(guid, out var cg) || dm.GetDevice(cg) is not IDeviceConfigurable consumer)
                return Results.BadRequest(new { error = "bad or non-configurable consumer guid" });
            if (!Guid.TryParse(r.SourceGuid, out var sg) || dm.GetDevice(sg) is not { } src)
                return Results.BadRequest(new { error = "bad source guid" });
            var match = src.GetStatusSigs().FirstOrDefault(t => t.Signal.Name == r.Signal);
            if (match.Signal is null)
                return Results.NotFound(new { error = $"'{r.Signal}' is not broadcast by {src.Name}" });
            var (fn, paramIndex) = FunctionMap.Resolve(consumer, "caninput", r.CanInput);
            if (fn is not CanInput ci || paramIndex < 0)
                return Results.NotFound(new { error = $"CAN input #{r.CanInput} not found on the consumer" });
            var sig = match.Signal;
            var track = Track("caninput", r.CanInput, FnLabel("caninput", r.CanInput, ci), ci);
            // A fresh slot defaults to State = (value == 0), which reads the remote signal inverted: claim it
            // as State = (value != 0). A slot already in use keeps its rule (a re-link after a base-ID change)
            // unless the caller asks for a new one (the CAN input page linking a different signal).
            var wasFree = !ci.Enabled;
            if (!ci.Enabled || r.NewRule == true) { ci.Operator = Operator.NotEqual; ci.Operand = 0; ci.Mode = InputMode.Momentary; }
            ci.Enabled = true;
            ci.Id = match.MessageId;            // absolute id = source base + offset (setter sets Ide)
            ci.StartBit = sig.StartBit;
            ci.BitLength = sig.Length;
            ci.Factor = sig.Factor;
            ci.Offset = sig.Offset;
            ci.ByteOrder = sig.ByteOrder;
            ci.Signed = sig.IsSigned;
            // a free slot keeps the name of what it last read ("CB-1 Sleep · awake" on an ignition bit): name it afresh
            if (wasFree || string.IsNullOrWhiteSpace(ci.Name) || System.Text.RegularExpressions.Regex.IsMatch(ci.Name, @"^canInput\d+$"))
                ci.Name = $"{src.Name} {SignalLabel(src, sig.Name) ?? sig.Name}";   // "CB-1 Horn", not "CB-1 DigitalInput2.State"
            var info = new Dictionary<string, object?>
            {
                ["source"] = src.Name, ["signal"] = sig.Name, ["canInput"] = r.CanInput,
                ["id"] = ci.Id, ["ide"] = ci.Ide, ["startBit"] = ci.StartBit, ["bitLength"] = ci.BitLength,
                ["factor"] = ci.Factor, ["offset"] = ci.Offset, ["byteOrder"] = (int)ci.ByteOrder, ["signed"] = ci.Signed, ["name"] = ci.Name,
            };
            if (!await IsLiveEditAsync(http, cg, dm, adapters, track)) return Results.Ok(new Dictionary<string, object?>(info) { ["ok"] = true, ["written"] = false, ["staged"] = Staged(http) });
            return WriteReport(await dm.WriteAndConfirm(cg, dm.FunctionParamKeys(cg, paramIndex), () => dm.WriteFunctionParams(cg, paramIndex)), info);
        });

        // Cross-module functions, server-side: compile a list of function definitions (trigger → target
        // outputs, optional synchronised blink with a clock master + failover backup) into per-module
        // Lua + output bindings, and deploy to each PDM. Mirrors the System-view "cross-module functions"
        // compiler. Lua runs only on PDMs, so every involved module must be a live dingoPDM/-Max.
        api.MapPost("/system/cross-module/deploy", async (HttpRequest req, DeviceManager dm, ICommsAdapterManager adapters, CrossModuleStore store) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            var root = doc.RootElement;
            var preview = root.TryGetProperty("preview", out var pv) && pv.ValueKind == JsonValueKind.True;
            var fnsEl = root.TryGetProperty("functions", out var fe) && fe.ValueKind == JsonValueKind.Array ? fe : default;
            var fns = fnsEl.ValueKind == JsonValueKind.Array
                ? JsonSerializer.Deserialize<List<CrossFnReq>>(fnsEl.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new()
                : new List<CrossFnReq>();
            // Record the raw function DEFINITIONS so the System view can list/edit MCP-deployed
            // functions (it imports them on mount). Skipped for a preview.
            if (!preview && fnsEl.ValueKind == JsonValueKind.Array) store.Set(fnsEl.GetRawText());
            var compiled = CompileCrossModule(fns);
            if (preview)
                return Results.Ok(new
                {
                    ok = true, preview = true,
                    modules = compiled.Select(kv => new
                    {
                        guid = kv.Key,
                        name = Guid.TryParse(kv.Key, out var pg) && dm.GetDevice(pg) is { } pd ? pd.Name : kv.Key,
                        lua = kv.Value.Lua, bindings = kv.Value.Bindings,
                    }).ToList(),
                });
            var results = new List<object>();
            var allOk = true;
            void Fail(string name, string error) { allOk = false; results.Add(new { name, ok = false, error }); }
            foreach (var (gs, plan) in compiled)
            {
                if (!Guid.TryParse(gs, out var g) || dm.GetDevice(g) is not { } dev) { Fail(gs, "device not in project"); continue; }
                if (dev is not PdmDevice pdm) { Fail(dev.Name, $"{dev.Name} has no Lua engine — only dingoPDM/-Max run Lua. Use link_remote_signal for a CANBoard target."); continue; }
                if (!pdm.RunsLua) { Fail(dev.Name, $"{dev.Name} runs upstream dingoFW without Lua (it never answered a Lua command)."); continue; }
                try
                {
                    // Offline-safe: store Lua + bindings on the device record (persists in the project),
                    // and push over CAN only when the module is live — exactly how params behave. A
                    // module that's offline gets "saved" (written=false); push later with device_action
                    // "uploadlua" + "writeall", or re-deploy once it's online.
                    var live = await IsLiveModuleAsync(g, dm, adapters);
                    dm.StoreLua(g, plan.Lua);
                    if (live && !await dm.UploadLuaAsync(g, plan.Lua))
                        throw new InvalidOperationException("Lua upload didn't verify on the module (see Logs) — it keeps its previous program");
                    var luaOut1 = pdm.VarMap.FirstOrDefault(v => v.GetName() == "Lua Out 1");
                    var bound = new List<int>();
                    foreach (var outNum in plan.Bindings)
                    {
                        var o = pdm.GetOutputs().FirstOrDefault(x => x.Number == outNum);
                        if (o == null) continue;
                        if (luaOut1 == null) throw new InvalidOperationException("couldn't resolve the 'Lua Out 1' var-map index");
                        if (o.CurrentLimit <= 0) throw new InvalidOperationException($"output {outNum} has no current limit yet — set it (Read or set_output_config) before binding so its trip point isn't guessed");
                        o.Enabled = true;
                        o.Input = luaOut1.VariableIndex + (outNum - 1);   // drive output N from "Lua Out N"
                        if (live) dm.WriteOutputParams(g, outNum);        // record edit persists; CAN write only when live
                        bound.Add(outNum);
                    }
                    results.Add(new { name = dev.Name, ok = true, written = live, boundOutputs = bound, luaBytes = plan.Lua.Length });
                }
                catch (Exception e) { Fail(dev.Name, e.Message); }
            }
            return Results.Ok(new { ok = allOk, modules = results });
        });

        // The cross-module function DEFINITIONS currently held on the backend (set by deploy_cross_module).
        // The System view imports these on mount so MCP-deployed functions appear in its list.
        api.MapGet("/system/cross-module", (CrossModuleStore store) => Results.Text(store.Get(), "application/json"));

        api.MapGet("/devices/{guid}/signals", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.Ok(Array.Empty<SignalDto>());
            var s = new List<SignalDto>();
            if (dm.GetDevice(g) is PdmDevice p)
            {
                foreach (var i in p.Inputs) s.Add(new("Digital input", i.Name, i.State ? "on" : "off", i.State, i.Enabled, N: i.Number));
                foreach (var c in p.CanInputs) s.Add(new("CAN input", c.Name, c.Value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture), c.Value != 0, c.Enabled, N: c.Number));
                foreach (var v in p.VirtualInputs) s.Add(new("Virtual input", v.Name, v.Value ? "on" : "off", v.Value, v.Enabled, N: v.Number));
                foreach (var c in p.Conditions) s.Add(new("Condition", c.Name, c.Value.ToString(), c.Value != 0, c.Enabled, N: c.Number));
                foreach (var c in p.Counters) s.Add(new("Counter", c.Name, c.Value.ToString(), c.Value != 0, c.Enabled, N: c.Number));
                foreach (var f in p.Flashers) s.Add(new("Flasher", f.Name, f.Value ? "on" : "off", f.Value, f.Enabled, N: f.Number));
                foreach (var t in p.Timers) s.Add(new("Timer", t.Name, t.Value ? "on" : "off", t.Value, t.Enabled, N: t.Number));
                foreach (var t in p.Tables.Take(p.TableCount)) s.Add(new("Table", t.Name, t.Value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture), t.Value != 0, t.Enabled, N: t.Number));
                if (p.Family == domain.Common.FwFamily.Upstream && domain.Common.FwFamily.HasBlock(p, PidFunction.BaseIndex, false))
                    foreach (var c in p.Pids) s.Add(new("PID", c.Name, c.Value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture), c.Value != 0, c.Enabled, N: c.Number));
                foreach (var o in p.Outputs) s.Add(new("Output", o.Name, o.State.ToString(), o.State.ToString() == "On", o.Enabled, N: o.Number));
            }
            else if (dm.GetDevice(g) is CanboardDevice cb)
            {
                // A CANBoard analog input exposes three live signals: raw mV, rotary position
                // ("<name> Pos" — drives the multi-position switch readout), and switch state. The sub-modes
                // count as enabled only when the input AND that mode are on.
                foreach (var a in cb.AnalogInputs)
                {
                    s.Add(new("Analog input", a.Name, ((int)a.Millivolts).ToString(), a.Millivolts > 0, a.Enabled, N: a.Number));
                    s.Add(new("Rotary position", a.Name + " Pos", a.Rotary.Pos.ToString(), a.Rotary.Pos != 0, a.Enabled && a.Rotary.Enabled, N: a.Number));
                    s.Add(new("Analog switch", a.Name + " Switch", a.Switch.State ? "on" : "off", a.Switch.State, a.Enabled && a.Switch.Enabled, N: a.Number));
                }
                foreach (var i in cb.DigitalInputs) s.Add(new("Digital input", i.Name, i.State ? "on" : "off", i.State, i.Enabled, N: i.Number));
                // PWM outputs report their live duty as the value (so the UI can show "ON · 45%");
                // plain on/off outputs keep the textual state.
                foreach (var o in cb.DigitalOutputs) s.Add(new("Digital output", o.Name, o.PwmEnabled ? Math.Clamp((int)o.CurrentDutyCycle, 0, 100).ToString() : (o.State ? "on" : "off"), o.State, o.Enabled, N: o.Number));
                foreach (var c in cb.CanInputs) s.Add(new("CAN input", c.Name, c.Value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture), c.Value != 0, c.Enabled, N: c.Number));
                foreach (var v in cb.VirtualInputs) s.Add(new("Virtual input", v.Name, v.Value ? "on" : "off", v.Value, v.Enabled, N: v.Number));
                foreach (var c in cb.Conditions) s.Add(new("Condition", c.Name, c.Value.ToString(), c.Value != 0, c.Enabled, N: c.Number));
                foreach (var c in cb.Counters) s.Add(new("Counter", c.Name, c.Value.ToString(), c.Value != 0, c.Enabled, N: c.Number));
                foreach (var f in cb.Flashers) s.Add(new("Flasher", f.Name, f.Value ? "on" : "off", f.Value, f.Enabled, N: f.Number));
                foreach (var t in cb.Timers) s.Add(new("Timer", t.Name, t.Value ? "on" : "off", t.Value, t.Enabled, N: t.Number));
            }
            else if (dm.GetDevice(g) is DbcDevice dbc)
            {
                // An ECU/DBC device's live decoded signals, so the Plot view (and anything using /signals)
                // can chart them. Message-qualified names disambiguate signals that share a name across
                // messages; values are invariant 3-decimal so the plot's parseFloat reads them.
                foreach (var sig in dbc.DbcSignals)
                {
                    var name = string.IsNullOrEmpty(sig.MessageName) ? sig.Name : $"{sig.MessageName}.{sig.Name}";
                    s.Add(new("DBC", name, sig.Value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture), sig.Value != 0));
                }
            }
            return Results.Ok(s.ToArray());
        });

        // Read-only discovery: send Version (non-destructive) to candidate command IDs,
        // report which makes the device reply on a fresh RX id.
        api.MapPost("/probe", async (ProbeReq r, ICommsAdapterManager m, CanMsgLogger log) =>
        {
            if (m.ActiveAdapter is null) return Results.BadRequest(new { error = "not connected" });
            int b = DingoMap.ParseId(r.Base);
            byte ver = (byte)MessageCommand.Version;
            HashSet<int> rx() => log.GetMessageSum().Where(x => x.Direction == DataDirection.Rx).Select(x => x.Id).ToHashSet();
            var before = rx();
            var results = new List<object>();
            for (int off = -2; off <= 3; off++)
            {
                int id = b + off; if (id < 0) continue;
                await m.ActiveAdapter.WriteAsync(new CanFrame(id, 8, new byte[] { ver, 0, 0, 0, 0, 0, 0, 0 }), CancellationToken.None);
                await Task.Delay(300);
                var after = rx();
                var nw = after.Except(before).Select(x => "0x" + x.ToString("X3")).ToArray();
                results.Add(new { cmdId = "0x" + id.ToString("X3"), offset = off, newRxIds = nw });
                before = after;
            }
            return Results.Ok(results);
        });

        // Project save/open (real config files via ConfigFileManager)
        api.MapGet("/project", (ConfigFileManager cfg, DeviceManager dm) =>
        {
            var now = cfg.SerializeDevices(dm.GetDevices());
            _cleanProject ??= now;
            var infos = cfg.ListFilesWithExtension("*.json");
            return Results.Ok(new {
                current = cfg.CurrentFileName, dir = cfg.WorkingDirectory, dirty = now != _cleanProject,
                files = infos.Select(f => f.Name).ToArray(),
                // G20: newest first, with the time it changed and how many modules it holds
                recent = infos.OrderByDescending(f => f.LastWriteTimeUtc).Select(f => new {
                    name = f.Name, modifiedAt = f.LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture), moduleCount = ModuleCount(f) }).ToArray() });
        });

        // The function records and groups the server holds are the newest (the AI agent may have changed
        // them): write them into the client section before the file is made.
        static void WithServerState(ConfigFileManager cfg)
        {
            if (cfg.ClientState is null && TemplateApi.Instances is null or "[]" && GroupApi.IsEmpty) return;   // nothing to keep (a new project)
            var node = (cfg.ClientState is { } cs ? System.Text.Json.Nodes.JsonNode.Parse(cs.GetRawText()) as System.Text.Json.Nodes.JsonObject : null)
                ?? new System.Text.Json.Nodes.JsonObject { ["version"] = 1 };
            if (TemplateApi.Instances is { } inst) node["templates"] = System.Text.Json.Nodes.JsonNode.Parse(inst);
            cfg.ClientState = System.Text.Json.JsonSerializer.SerializeToElement(GroupApi.MergeInto(node));
        }

        api.MapPost("/project/save", async (ProjReq r, ConfigFileManager cfg, DeviceManager dm) =>
        {
            Directory.CreateDirectory(cfg.WorkingDirectory);
            if (r.Client is { ValueKind: System.Text.Json.JsonValueKind.Object } c) cfg.ClientState = c.Clone();
            WithServerState(cfg);
            await cfg.SaveDevices(dm.GetDevices(), r.FileName);
            MarkClean(cfg, dm);
            return Results.Ok(new { ok = true, current = cfg.CurrentFileName });
        });

        api.MapPost("/project/open", async (ProjReq r, ConfigFileManager cfg, DeviceManager dm, CrossModuleStore xmod) =>
        {
            // Load FIRST; only clear the current project once we have a valid replacement. The old
            // order cleared then checked for null, silently wiping every device on a bad/missing file.
            try
            {
                var devs = await cfg.LoadDevices(r.FileName);
                if (devs == null)
                    return Results.Text($"Could not open '{r.FileName}' — not found or not a valid project file.", "text/plain", null, 400);
                dm.ClearDevices();
                xmod.Clear();   // cross-module defs are per-project; the UI re-imports for the new project
                dm.AddDevices(devs);
                TemplateApi.LoadInstances(cfg.ClientState); GroupApi.Load(cfg.ClientState);
                MarkClean(cfg, dm);
                return Results.Ok(new { ok = true, count = devs.Count, client = cfg.ClientState });
            }
            catch (Exception e)
            {
                return Results.Text($"Could not open '{r.FileName}': {e.Message}", "text/plain", null, 400);
            }
        });

        api.MapPost("/project/new", (ConfigFileManager cfg, DeviceManager dm, CrossModuleStore xmod) =>
        {
            dm.ClearDevices(); xmod.Clear(); cfg.NewFile(); cfg.ClientState = null; TemplateApi.LoadInstances(null); GroupApi.Load(null); MarkClean(cfg, dm); return Results.Ok(new { ok = true });
        });

        // Local-PC project SAVE: stream the whole project (ConfigFile JSON) back so the browser
        // saves it wherever the user chooses. No server-side folder — works on Windows/Mac/Linux.
        api.MapGet("/project/download", (ConfigFileManager cfg, DeviceManager dm) =>
        {
            WithServerState(cfg);
            return Results.Text(cfg.SerializeDevices(dm.GetDevices()), "application/json");
        });

        // Local-PC project OPEN: load a project file the user picked on their PC (raw ConfigFile
        // JSON in the body). The current project is replaced only on a successful parse.
        api.MapPost("/project/upload", async (HttpRequest req, ConfigFileManager cfg, DeviceManager dm, CrossModuleStore xmod) =>
        {
            using var reader = new StreamReader(req.Body);
            var json = await reader.ReadToEndAsync();
            try
            {
                var devs = cfg.LoadDevicesFromJson(json);
                if (devs == null) return Results.Text("Not a valid project file.", "text/plain", null, 400);
                dm.ClearDevices();
                xmod.Clear();   // cross-module defs are per-project; the UI re-imports for the new project
                dm.AddDevices(devs);
                cfg.NewFile();   // opened from an external file, not one of our working-dir files
                TemplateApi.LoadInstances(cfg.ClientState); GroupApi.Load(cfg.ClientState);
                MarkClean(cfg, dm);
                return Results.Ok(new { ok = true, count = devs.Count });
            }
            catch (Exception e)
            {
                return Results.Text("Couldn't open project: " + e.Message, "text/plain", null, 400);
            }
        });

        // G17: data changes per id with their time (Unix ms), oldest first. Poll with since = the last "now".
        api.MapGet("/canlog/changes", (long? since, int? max, CanMsgLogger log) => Results.Ok(new {
            now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            changes = log.GetChanges(since ?? 0, Math.Clamp(max ?? 5000, 1, 20000)).Select(c => new {
                t = c.T, id = c.Id, ext = c.IsExtended, dir = c.Dir.ToString(),
                data = Convert.ToHexString(c.Data), prev = c.Prev is null ? null : Convert.ToHexString(c.Prev) }) }));

        api.MapGet("/canlog", (CanMsgLogger log) => Results.Ok(
            log.GetMessageSum().OrderBy(m => m.Id).Select(m => new CanLogDto(
                m.Direction.ToString(), m.Id, m.IsExtended, m.Len,
                string.Join(" ", (m.Payload ?? Array.Empty<byte>()).Take(m.Len).Select(b => b.ToString("X2"))),
                m.Count)).ToArray()));

        api.MapGet("/syslog", (SystemLogger log) => Results.Ok(
            log.GetRecentLogs(200).Select(e => new SysLogDto(
                e.Timestamp.ToString("HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture), e.Level.ToString(), e.Source, e.Message)).ToArray()));

        // CSV export of the CAN traffic summary.
        api.MapGet("/canlog/export", (CanMsgLogger log) =>
        {
            var sb = new System.Text.StringBuilder("Dir,ID,Type,DLC,Data,Count\n");
            foreach (var m in log.GetMessageSum().OrderBy(m => m.Id))
                sb.Append($"{m.Direction},0x{m.Id:X3},{(m.IsExtended ? "EXT" : "STD")},{m.Len},{string.Join(' ', (m.Payload ?? Array.Empty<byte>()).Take(m.Len).Select(b => b.ToString("X2")))},{m.Count}\n");
            return Results.File(System.Text.Encoding.UTF8.GetBytes(sb.ToString()), "text/csv", "canlog.csv");
        });

        // ---- Force a CAN-input value: the app sends the input's source frame until the hold runs out (max 30 s)
        // or /stop. Only a CAN-sourced value can be forced without firmware support. Refused on the Sim (ProgrammingRoute).
        api.MapPost("/can/force", (CanForceReq r, CanForcer f) =>
        {
            byte[] data;
            try { data = Convert.FromHexString((r.Data ?? "").Replace(" ", "")); }
            catch (FormatException) { return Results.BadRequest(new { ok = false, error = "data must be hex bytes" }); }
            var err = f.Start(new CanFrame(r.Id, data.Length, data, r.Ide), r.PeriodMs, r.HoldSec);
            return err is null ? Results.Ok(new { ok = true, untilMs = (long)(f.Until - DateTime.UtcNow).TotalMilliseconds }) : Results.BadRequest(new { ok = false, error = err });
        });
        api.MapPost("/can/force/stop", (CanForcer f) => { f.Stop(); return Results.Ok(new { ok = true }); });
        api.MapGet("/can/force/status", (CanForcer f) =>
        {
            var fr = f.Frame;
            return Results.Ok(new { active = f.Active && fr != null, id = fr?.Id, ide = fr?.IsExtended, data = fr is null ? null : Convert.ToHexString(fr.Payload),
                remainingMs = fr is null ? 0 : Math.Max(0, (long)(f.Until - DateTime.UtcNow).TotalMilliseconds), sent = f.Sent });
        });

        // ---- CAN recorder (SavvyCAN-style): record every frame to a CSV and save it to the PC.
        // Gated on a REAL CAN interface — the simulator can't be recorded.
        api.MapPost("/canlog/record/start", (CanMsgLogger log, ICommsAdapterManager adapters) =>
        {
            var (connected, active, _) = adapters.GetStatus();
            if (!connected || string.Equals(active, "Sim", StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { ok = false, error = "Connect a real CAN interface first — the simulator can't be recorded." });
            log.StartRecording(Path.Combine(AppContext.BaseDirectory, "logs"));
            return Results.Ok(new { ok = true });
        });
        api.MapPost("/canlog/record/stop", (CanMsgLogger log) =>
        {
            log.StopRecording();
            return Results.Ok(new { ok = true, frames = log.RecordedFrames, fileName = Path.GetFileName(log.RecordingPath ?? "") });
        });
        api.MapGet("/canlog/record/status", (CanMsgLogger log) => Results.Ok(new
        {
            recording = log.IsRecording, frames = log.RecordedFrames,
            sinceMs = log.IsRecording ? (int)(DateTime.UtcNow - log.RecordingStarted).TotalMilliseconds : 0,
            fileName = Path.GetFileName(log.RecordingPath ?? ""),
        }));
        api.MapGet("/canlog/record/download", (CanMsgLogger log) =>
        {
            log.FlushRecording();
            var path = log.RecordingPath;
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return Results.NotFound();
            // Read with shared access (the writer keeps the file open while recording).
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var ms = new MemoryStream();
            fs.CopyTo(ms);
            return Results.File(ms.ToArray(), "text/csv", Path.GetFileName(path));
        });

        // CSV export of the system log.
        api.MapGet("/syslog/export", (SystemLogger log) =>
        {
            var sb = new System.Text.StringBuilder("Time,Level,Source,Message\n");
            foreach (var e in log.GetRecentLogs(2000))
                sb.Append($"{e.Timestamp:yyyy-MM-dd HH:mm:ss},{e.Level},{e.Source},\"{e.Message.Replace("\"", "\"\"")}\"\n");
            return Results.File(System.Text.Encoding.UTF8.GetBytes(sb.ToString()), "text/csv", "syslog.csv");
        });

        // Commission a connected module: write a saved profile (another project device) onto it,
        // including re-addressing it to the profile's base ID. Lua follows from the client side.
        api.MapPost("/devices/{guid}/apply-profile", (string guid, ApplyProfileReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var t)) return Results.BadRequest();
            if (!adapters.GetStatus().isConnected) return Results.Text("Not connected to a CAN adapter — connect first.", "text/plain", null, 400);
            if (!Guid.TryParse(r.Source, out var s)) return Results.Text("Invalid source profile.", "text/plain", null, 400);
            var (ok, err) = dm.ApplyProfile(t, s);
            return ok ? Results.Ok(new { ok = true, baseId = dm.GetDevice(t)?.BaseId }) : Results.Text(err, "text/plain", null, 400);
        });

        api.MapPost("/devices/{guid}/{action}", async (string guid, string action, bool? can, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();

            // These talk to live hardware over CAN. The writes are fire-and-forget, so without
            // a guard they "succeed" silently against an empty bus. Refuse unless the adapter is
            // connected AND the target module is actually broadcasting (seen within ~500 ms).
            string[] liveActions = ["read", "readall", "write", "writeall", "burn", "sleep", "bootloader", "version", "uploadlua", "restart"];
            if (liveActions.Contains(action) && await RequireLiveModuleAsync(g, dm, adapters, action) is { } bad) return bad;
            // Wake up is for a module that is NOT answering (asleep, or woken by CAN and still quiet): only the adapter must be there
            if (action == "wakeup" && !adapters.GetStatus().isConnected) return Results.Text("Not connected to a CAN adapter — connect first.", "text/plain", null, 400);

            switch (action)
            {
                // Bulk read/write: the firmware streams the whole config back in one burst
                // (~1s, CRC-checked). Far faster than the 2000+ per-param round-trips the
                // chunked path issues — that was the "super slow read". (Verified on USB-SLCAN.)
                case "read": dm.ReadDeviceConfig(g); break;
                case "readall": dm.ReadAllDeviceConfig(g); break;
                case "write" or "writeall":
                    if (!await dm.WriteDeviceConfigConfirmed(g, all: action == "writeall"))
                        return Results.Json(new { ok = false, error = dm.GetDevice(g) is { } wd && !DeviceManager.VersionKnown(wd)
                            ? "The module hasn't said which firmware it runs, so nothing was written (a write now could reset its newer settings). Try again in a moment."
                            : dm.GetDevice(g) is { } ud && !DeviceManager.ParamsKnown(ud)
                            ? "Read the module first: it runs upstream dingoFW and the app needs its list of settings before it can write them. Nothing was written."
                            : dm.GetDevice(g) is IDeviceConfigurable { Lock.Locked: true }
                            ? "The module is locked by its installer: Unlock it first. Nothing was written."
                            : "The module didn't confirm the write (see Logs) — it keeps its previous config" }, statusCode: 409);
                    // the project's Lua belongs to the config: send it unless this app already saw it on the module
                    if (dm.GetDevice(g) is PdmDevice { RunsLua: true } && dm.GetDeviceUiState(g).LuaOnModule != dm.GetStoredLua(g)
                        && !await dm.UploadLuaAsync(g, dm.GetStoredLua(g)))
                        return Results.Json(new { ok = false, error = "Settings written, but the Lua program didn't verify on the module (see Logs) — it keeps its previous program" }, statusCode: 409);
                    break;
                case "burn":
                    if (!await dm.BurnSettingsConfirmed(g))
                        return Results.Json(new { ok = false, error = "The module didn't confirm the burn (see Logs) — flash still holds the previous config" }, statusCode: 409);
                    break;
                case "sleep": dm.RequestSleep(g); break;
                case "wakeup": dm.RequestWakeup(g); break;
                // ?can=true: the OpenBLT CAN-update entry (it waits there for a tool, G9); default: the USB-DFU entry
                case "bootloader": dm.RequestBootloader(g, canUpdate: can == true); break;
                case "version": dm.RequestVersion(g); break;
                // upstream: restart (unstored settings are lost; a stored config lock takes effect)
                case "restart":
                    if (dm.GetDevice(g) is not IDeviceConfigurable { Family: domain.Common.FwFamily.Upstream })
                        return Results.Json(new { ok = false, error = "Restart over CAN is an upstream dingoFW command." }, statusCode: 409);
                    if (!await dm.RestartConfirmed(g)) return Results.Json(new { ok = false, error = "The module did not confirm the restart." }, statusCode: 409);
                    break;
                // Push the Lua program stored on the record (e.g. an offline cross-module deploy) to the
                // now-live module. Pair with "writeall" to also push the output bindings (params).
                case "uploadlua":
                    if (!await dm.UploadLuaAsync(g, dm.GetStoredLua(g)))
                        return Results.Json(new { ok = false, error = "Lua upload didn't verify on the module (see Logs) — it keeps its previous program" }, statusCode: 409);
                    break;
                default: return Results.NotFound();
            }
            return Results.Ok(new { ok = true });
        });
    }

    // Shared precondition for endpoints that talk to LIVE hardware over CAN: the adapter must be
    // open AND the target module must actually be answering on the bus. Returns an IResult to
    // short-circuit with, or null when it's safe to proceed. Mirrors the /{action} guard so every
    // CAN-commit path fails loud and consistent instead of "succeeding" against an empty bus.
    // (Base-ID/rename are offline-safe and firmware/DFU runs over USB — neither uses this.)
    // Upstream dingoFW runs Lua only with feat/lua-scripting, which no param shows: a live module that has not answered a
    // Lua command yet is asked once (the reply sets HasLua and adds the Lua slots to its var map).
    private static async Task<IResult?> NoLuaAsync(Guid g, DeviceManager dm, ICommsAdapterManager adapters)
    {
        if (dm.GetDevice(g) is not PdmDevice { Family: domain.Common.FwFamily.Upstream } p || p.RunsLua) return null;
        if (await IsLiveModuleAsync(g, dm, adapters)) await dm.ReadLuaError(g);
        return p.RunsLua ? null : Results.Json(new { ok = false, error = "This module runs upstream dingoFW without Lua (it did not answer a Lua command)." }, statusCode: 409);
    }
    private static async Task<IResult?> RequireLiveModuleAsync(Guid g, DeviceManager dm, ICommsAdapterManager adapters, string verb)
    {
        if (!adapters.GetStatus().isConnected)
            return Results.Text("Not connected to a CAN adapter — connect first.", "text/plain", null, 400);
        var dev = dm.GetDevice(g);
        if (dev == null) return Results.NotFound();
        if (!await SeenAsync(dev, waitAlways: true))
            return Results.Text($"Module 0x{dev.BaseId:X} ({dev.Name}) is not responding on the bus — nothing to {verb}. Check power, wiring, base ID and bitrate.", "text/plain", null, 400);
        return null;
    }

    // True when the adapter is open and the module is answering. Used by endpoints that ALSO
    // persist an offline project-record edit (outputconfig/function): the record edit always
    // applies; only the CAN write is conditioned on this so offline config authoring still works.
    // A live write's response: "written" only when the module acknowledged every param. A refused value is
    // named with the value the module kept (the project now holds it too); no reply after the retries is said
    // as such. Either way the status is 409 so no caller (UI toast, MCP tool) reads it as done.
    private static IResult WriteReport(List<DeviceManager.WriteResult> res, Dictionary<string, object?>? extra = null)
    {
        var rejected = res.Where(x => x.Outcome is DeviceManager.WriteOutcome.OutOfRange or DeviceManager.WriteOutcome.NotFound)
            .Select(x => new { param = x.Param, reason = x.Outcome == DeviceManager.WriteOutcome.OutOfRange ? "out of range" : "unknown to this firmware", kept = x.Value }).ToList();
        var noReply = res.Where(x => x.Outcome == DeviceManager.WriteOutcome.NoReply).Select(x => x.Param).ToList();
        var ok = rejected.Count == 0 && noReply.Count == 0;
        var body = new Dictionary<string, object?>(extra ?? []) { ["ok"] = ok, ["written"] = ok };
        if (rejected.Count > 0) body["rejected"] = rejected;
        if (noReply.Count > 0) body["noReply"] = noReply;
        if (!ok)
            body["error"] = string.Join("; ", rejected.Select(x => $"{x.param} {x.reason}: the module kept {x.kept}")
                .Concat(noReply.Count > 0 ? [$"no reply for {string.Join(", ", noReply)}: not confirmed on the device"] : []));
        return ok ? Results.Ok(body) : Results.Json(body, statusCode: 409);
    }

    // G2: the redesigned UI holds its edits until "Apply to car": it sends X-Dingo-Stage: 1, and the edit endpoints
    // then save to the project only and mark the module as differing (the Apply panel lists it; Apply writes it).
    // The old UI, scripts and the AI agent send no header and keep writing live.
    private static bool Staged(HttpContext http) => http.Request.Headers["X-Dingo-Stage"] == "1";

    private static async Task<bool> IsLiveEditAsync(HttpContext http, Guid g, DeviceManager dm, ICommsAdapterManager adapters, EditTrack? t = null)
    {
        // upstream dingoFW before a Read: the app can't tell which of the slot's params it has, so the edit waits for Apply
        if (!Staged(http) && dm.GetDevice(g) is { } ld && DeviceManager.ParamsKnown(ld) && await IsLiveModuleAsync(g, dm, adapters))
        {
            // written to the module now, the whole slot: its waiting rows are no longer waiting
            if (t != null) { var u = dm.GetDeviceUiState(g); lock (u.Edits) u.Edits.RemoveAll(e => e.Kind == t.Kind && e.Number == t.Number); }
            return true;
        }
        // Saved to the project only (staged, or the module is offline): remember what changed for the Apply panel.
        if (dm.GetDevice(g) is domain.Interfaces.IDeviceConfigurable c)
        {
            var ui = dm.GetDeviceUiState(g);
            // under the edit lock: a telemetry poll (SyncEdits) can't clear the list between the flag and the record
            lock (ui.Edits)
            {
                if (!c.ConfigMismatch) ui.Edits.Clear();   // in step since the last edit: start again
                c.ConfigMismatch = true;
                if (t != null) RecordEdits(ui, t, Staged(http) ? "app" : http.Request.Headers["X-Dingo-Source"] == "agent" ? "agent" : "api");
            }
        }
        return false;
    }

    // Item 7: a before-snapshot of the edited thing, diffed after the edit into PendingEdit rows.
    internal record EditTrack(string Kind, int Number, string Label, Func<Dictionary<string, string>> Snap)
    {
        public Dictionary<string, string> Before { get; } = Snap();
    }
    internal static EditTrack Track(string kind, int number, string label, object obj) => new(kind, number, label, () => SnapJson(obj));
    // the agent may use the short aliases; edits are recorded (and merged, and linked to) under the full kind
    static string CanonKind(string kind) => kind.ToLowerInvariant() switch
    {
        "pin" => "input", "can" => "caninput", "cmb" => "virtualinput", "cmp" => "condition", "cnt" => "counter", "fl" => "flasher",
        "tmr" => "timer", "tbl" => "table", "cout" => "canoutput", "wip" => "wiper", "std" => "starterdisable", "dout" => "digitaloutput",
        "ain" => "analoginput", var k => k,
    };
    static Dictionary<string, string> SnapJson(object o)
    {
        try
        {
            var el = JsonSerializer.SerializeToElement(o, o.GetType());
            return el.ValueKind == JsonValueKind.Object ? el.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetRawText()) : new();
        }
        catch { return new(); }
    }
    static int _editId;
    static void RecordEdits(DeviceUiState ui, EditTrack t, string source)
    {
        var after = t.Snap();
        lock (ui.Edits)
            foreach (var (field, now) in after)
            {
                var was = t.Before.GetValueOrDefault(field);
                if (was == null || was == now) continue;
                var i = ui.Edits.FindIndex(e => e.Kind == t.Kind && e.Number == t.Number && e.Field == field);
                var first = i >= 0 ? ui.Edits[i].OldJson : was;
                if (i >= 0) ui.Edits.RemoveAt(i);
                if (first == now) continue;   // edited back to where it started
                ui.Edits.Add(new PendingEdit(Interlocked.Increment(ref _editId), t.Kind, t.Number, field, $"{t.Label} {FieldLabel(field)}",
                    ShowJson(first, field), ShowJson(now, field), first, now, source, DateTime.UtcNow));
            }
    }
    static readonly Dictionary<string, (string label, string unit)> Fields = new(StringComparer.OrdinalIgnoreCase)
    {
        ["currentLimit"] = ("Trips above", " A"), ["inrushCurrentLimit"] = ("Inrush limit", " A"), ["inrushTime"] = ("Inrush time", " ms"),
        ["warnLimit"] = ("Warns above", " A"), ["openLoadLimit"] = ("Open load below", " A"), ["openLoadTime"] = ("Open load time", " ms"),
        ["resetTime"] = ("Retry after", " ms"), ["resetCountLimit"] = ("Retries", ""), ["frequency"] = ("PWM frequency", " Hz"),
        ["fixedDutyCycle"] = ("Duty", " %"), ["minDutyCycle"] = ("Min duty", " %"), ["softStartRampTime"] = ("Soft start ramp", " ms"),
    };
    // "inrushTime" -> "Inrush time" for the fields without a label above
    static string FieldLabel(string f) => Fields.TryGetValue(f, out var l) ? l.label
        : f.Length == 0 ? f : char.ToUpperInvariant(f[0]) + System.Text.RegularExpressions.Regex.Replace(f[1..], "([A-Z])", m => " " + m.Value.ToLowerInvariant());
    static string ShowJson(string json, string field)
    {
        if (json is "true" or "false") return json == "true" ? "on" : "off";
        var str = json.StartsWith('"');
        var v = str ? JsonSerializer.Deserialize<string>(json) ?? "" : json;
        if (v.Length > 40) v = v[..37] + "…";
        return str ? (v.Length == 0 ? "(empty)" : v) : v + (Fields.TryGetValue(field, out var l) ? l.unit : "");
    }
    static readonly Dictionary<string, string> KindLabels = new(StringComparer.OrdinalIgnoreCase)
    {
        ["input"] = "Input", ["pin"] = "Input", ["caninput"] = "CAN input", ["can"] = "CAN input", ["virtualinput"] = "Logic", ["cmb"] = "Logic",
        ["condition"] = "Condition", ["cmp"] = "Condition", ["counter"] = "Counter", ["cnt"] = "Counter", ["flasher"] = "Flasher", ["fl"] = "Flasher",
        ["timer"] = "Timer", ["tmr"] = "Timer", ["table"] = "Table", ["tbl"] = "Table", ["math"] = "Math", ["curve"] = "Curve", ["latchgate"] = "Latch / Gate", ["lg"] = "Latch / Gate", ["canmsg"] = "CAN message",
        ["ignition"] = "Ignition", ["comfortblink"] = "Comfort blink", ["pid"] = "PID", ["canoutput"] = "CAN output", ["cout"] = "CAN output",
        ["wiper"] = "Wiper", ["wip"] = "Wiper", ["starterdisable"] = "Starter disable", ["std"] = "Starter disable", ["keypad"] = "Keypad",
        ["keypadbutton"] = "Keypad button", ["keypaddial"] = "Keypad dial", ["digitaloutput"] = "Output", ["dout"] = "Output",
        ["analoginput"] = "Analog input", ["ain"] = "Analog input",
    };
    static readonly HashSet<string> Singles = new(StringComparer.OrdinalIgnoreCase) { "ignition", "comfortblink", "wiper", "wip", "starterdisable", "std" };
    internal static string FnLabel(string kind, int number, object fn)
    {
        var name = fn.GetType().GetProperty("Name")?.GetValue(fn) as string;
        var k = KindLabels.GetValueOrDefault(kind, kind);
        var head = Singles.Contains(kind) ? k : $"{k} {number}";
        return string.IsNullOrWhiteSpace(name) || name == head ? head : $"{head} ({name})";
    }

    // Put one staged field back to its value before the edit (project only; the module is not touched).
    internal static string? RevertEdit(IDevice dev, PendingEdit e)
    {
        try
        {
            if (e.Kind == "device")
            {
                var v = JsonSerializer.Deserialize<int>(e.OldJson);
                switch (dev, e.Field)
                {
                    case (PdmDevice p, "forceSleepInput"): p.ForceSleepInput = v; break;
                    case (PdmDevice p, "muteTxInput"): p.MuteTxInput = v; break;
                    case (PdmDevice p, "retryAllInput"): p.RetryAllInput = v; break;
                    case (PdmDevice p, "shedInput"): p.ShedInput = v; break;
                    case (CanboardDevice c, "muteTxInput"): c.MuteTxInput = v; break;
                    default: return "that setting can't be put back";
                }
                return null;
            }
            object? obj = e.Kind == "output" ? (dev as PdmDevice)?.Outputs.FirstOrDefault(x => x.Number == e.Number) : FunctionMap.Resolve(dev, e.Kind, e.Number).fn;
            if (obj == null) return "it no longer exists";
            using var doc = JsonDocument.Parse($"{{{JsonSerializer.Serialize(e.Field)}:{e.OldJson}}}");
            var bad = FunctionMap.ApplyJson(obj, doc.RootElement);
            return bad.Count > 0 ? $"could not put back {string.Join(", ", bad)}" : null;
        }
        catch (Exception ex) { return ex.Message; }
    }

    private static async Task<bool> IsLiveModuleAsync(Guid g, DeviceManager dm, ICommsAdapterManager adapters)
    {
        if (!adapters.GetStatus().isConnected) return false;
        var dev = dm.GetDevice(g);
        return dev != null && await SeenAsync(dev, waitAlways: false);
    }

    // A module can be quiet on OUR side only: just after connecting, or while another module's exchange narrows
    // the RX filter — and a module that wasn't seen before the filter narrowed gets no excuse from RxFilterWindow,
    // so a deploy's next module was refused as "not responding". Give it until the filter lifts (1.5 s idle) plus
    // a status broadcast. waitAlways=false (offline-safe paths) waits only while a filter hides the bus, so a module
    // that's really offline isn't held up. ponytail: 5 s poll, an event on first frame if this ever matters.
    private static async Task<bool> SeenAsync(IDevice dev, bool waitAlways)
    {
        var until = DateTime.Now.AddSeconds(5);
        while (true)
        {
            dev.UpdateIsConnected();
            if (dev.Connected || DateTime.Now > until || !(waitAlways || domain.Devices.RxFilterWindow.Narrowed)) return dev.Connected;
            await Task.Delay(200);
        }
    }

    // Is a broadcast signal actually wired up on its source? Mirrors the UI picker's filter so
    // broadcast_signals?inUse=true shows only configured signals. System telemetry is always live;
    // everything else follows its function's Enabled flag (analog sub-signals need the input + its
    // rotary/switch mode enabled).
    // Which Lua slots the program writes vs which "Lua Out" vars something on the module actually reads.
    private static List<string> LuaSlotWarnings(IDevice? dev, string src)
    {
        var w = new List<string>();
        if (dev is not PdmDevice p) return w;
        var written = System.Text.RegularExpressions.Regex.Matches(src, @"setLuaOut\s*\(\s*(\d+)")
            .Select(m => int.Parse(m.Groups[1].Value)).ToHashSet();
        if (written.Count == 0) return w;
        // every var-map index some function on this module consumes
        var used = new HashSet<int>();
        foreach (var o in p.GetOutputs()) { used.Add(o.Input); used.Add(o.DutyCycleInput); used.Add(o.FreqInput); }
        foreach (var c in p.GetConditions()) used.Add(c.Input);
        foreach (var f in p.GetFlashers()) used.Add(f.Input);
        foreach (var v in p.GetVirtualInputs()) { used.Add(v.Var0); used.Add(v.Var1); used.Add(v.Var2); }
        foreach (var c in p.GetCounters()) { used.Add(c.IncInput); used.Add(c.DecInput); used.Add(c.ResetInput); }
        foreach (var t in p.GetTimers()) used.Add(t.Input);
        foreach (var t in p.GetTables()) { used.Add(t.XInput); used.Add(t.YInput); }
        foreach (var c in p.GetCanOutputs()) used.Add(c.Input);
        foreach (var c in p.Pids) { used.Add(c.SetpointInput); used.Add(c.ProcessInput); used.Add(c.ActivateInput); used.Add(c.FeedFwdInput); }
        used.Add(p.ForceSleepInput); used.Add(p.MuteTxInput); used.Add(p.RetryAllInput); used.Add(p.ShedInput);
        var luaVars = p.VarMap.Where(v => v.OwnerKind == "lua").ToList();   // OwnerNumber = slot + 1
        var consumedSlots = luaVars.Where(v => used.Contains(v.VariableIndex)).Select(v => v.OwnerNumber - 1).ToHashSet();
        foreach (var s in written.Where(s => !consumedSlots.Contains(s)).OrderBy(s => s))
            w.Add($"setLuaOut({s}) writes \"Lua Out {s + 1}\", but nothing on {p.Name} reads it");
        foreach (var s in consumedSlots.Where(s => !written.Contains(s)).OrderBy(s => s))
            w.Add($"something on {p.Name} is driven by \"Lua Out {s + 1}\", but the program never calls setLuaOut({s}, …)");
        if (w.Count > 0 && written.Min() >= 1 && consumedSlots.Count > 0 && consumedSlots.Min() == written.Min() - 1)
            w.Insert(0, "Every setLuaOut slot looks one too high — slots are 0-based: setLuaOut(0) drives \"Lua Out 1\"");
        return w;
    }

    // The user's name for the function that owns a broadcast signal ("DigitalInput1.State" → "ignition"), so the
    // cross-module picker shows and searches what the user typed, not the frame-map name. Null when unknown.
    private static string? SignalLabel(IDevice d, string name)
    {
        var m = System.Text.RegularExpressions.Regex.Match(name, @"^([A-Za-z]+?)(\d+)(?:\.(\w+))?");
        if (!m.Success) return null;
        var kind = m.Groups[1].Value; var n = int.Parse(m.Groups[2].Value); var prop = m.Groups[3].Value;
        string? fn = d switch
        {
            PdmDevice p => kind switch
            {
                "Input" => p.GetInputs().FirstOrDefault(x => x.Number == n)?.Name,
                "Output" => p.GetOutputs().FirstOrDefault(x => x.Number == n)?.Name,
                "CanInput" => p.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Name,
                "VirtualInput" => p.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Name,
                "Condition" => p.GetConditions().FirstOrDefault(x => x.Number == n)?.Name,
                "Counter" => p.GetCounters().FirstOrDefault(x => x.Number == n)?.Name,
                "Flasher" => p.GetFlashers().FirstOrDefault(x => x.Number == n)?.Name,
                "Timer" => p.GetTimers().FirstOrDefault(x => x.Number == n)?.Name,
                "Table" => p.GetTables().FirstOrDefault(x => x.Number == n)?.Name,
                "Pid" => p.Pids.FirstOrDefault(x => x.Number == n)?.Name,
                _ => null,
            },
            CanboardDevice c => kind switch
            {
                "AnalogInput" or "RotarySwitch" => c.GetAnalogInputs().FirstOrDefault(x => x.Number == n)?.Name,
                "DigitalInput" => c.GetDigitalInputs().FirstOrDefault(x => x.Number == n)?.Name,
                "DigitalOutput" => c.GetDigitalOutputs().FirstOrDefault(x => x.Number == n)?.Name,
                "CanInput" => c.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Name,
                "VirtualInput" => c.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Name,
                "Condition" => c.GetConditions().FirstOrDefault(x => x.Number == n)?.Name,
                "Counter" => c.GetCounters().FirstOrDefault(x => x.Number == n)?.Name,
                "Flasher" => c.GetFlashers().FirstOrDefault(x => x.Number == n)?.Name,
                "Timer" => c.GetTimers().FirstOrDefault(x => x.Number == n)?.Name,
                _ => null,
            },
            _ => null,
        };
        if (string.IsNullOrWhiteSpace(fn)) return null;
        // ".State" is the on/off port — the bare name; other ports keep their property ("coolant · Millivolts").
        return string.IsNullOrEmpty(prop) || prop == "State" ? fn : $"{fn} · {prop}";
    }

    // Is the function that owns a var-map entry configured? Mirrors SignalInUse for the var map (owner kind/number
    // are tagged on every entry). Unknown kinds count as in use so nothing real ever disappears from a picker.
    private static bool VarInUse(IDevice d, domain.Models.DeviceVariable v)
    {
        var n = v.OwnerNumber;
        return d switch
        {
            PdmDevice p => v.OwnerKind switch
            {
                "sys" => true,
                "input" => p.GetInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "caninput" => p.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "virtualinput" => p.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "condition" => p.GetConditions().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "counter" => p.GetCounters().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "flasher" => p.GetFlashers().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "timer" => p.GetTimers().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "table" => p.GetTables().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "curve" => p.Curves.FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "latchgate" => p.LatchGates.FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "pid" => p.Pids.FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "output" => p.GetOutputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "wiper" => p.GetWipers()?.Enabled ?? false,
                "keypad" => p.GetKeypads().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "lua" => !string.IsNullOrWhiteSpace(p.LuaProgram),
                _ => true,
            },
            CanboardDevice c => v.OwnerKind switch
            {
                "sys" => true,
                "input" => c.GetDigitalInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                // The rotary-position / switch-value vars are sub-modes of the analog input: the input AND that
                // mode must be on (PropertyName values are set in CanboardDevice.InitVarMap). Raw/mV/scaled
                // follow the input alone.
                "analoginput" => c.GetAnalogInputs().FirstOrDefault(x => x.Number == n) is not { } a ? true
                    : a.Enabled && v.PropertyName switch { "Rotary Position" => a.Rotary.Enabled, "Switch Value" => a.Switch.Enabled, _ => true },
                "digitaloutput" => c.GetDigitalOutputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "caninput" => c.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "virtualinput" => c.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "condition" => c.GetConditions().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "counter" => c.GetCounters().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "flasher" => c.GetFlashers().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                "timer" => c.GetTimers().FirstOrDefault(x => x.Number == n)?.Enabled ?? true,
                _ => true,
            },
            _ => true,
        };
    }

    private static bool SignalInUse(IDevice d, string name)
    {
        if (System.Text.RegularExpressions.Regex.IsMatch(name, "^(DeviceState|PdmType|TotalCurrent|BatteryVoltage|BoardTemp|Heartbeat)"))
            return true;
        var m = System.Text.RegularExpressions.Regex.Match(name, @"^([A-Za-z]+?)(\d+)");
        if (!m.Success) return true;
        var kind = m.Groups[1].Value;
        var n = int.Parse(m.Groups[2].Value);
        var digitalMode = name.Contains("DigitalMode");
        if (d is PdmDevice p)
            return kind switch
            {
                "Input" => p.GetInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Output" => p.GetOutputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "CanInput" => p.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "VirtualInput" => p.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Condition" => p.GetConditions().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Counter" => p.GetCounters().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Flasher" => p.GetFlashers().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Timer" => p.GetTimers().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Table" => p.GetTables().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Pid" => p.Pids.FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Wiper" => p.GetWipers()?.Enabled ?? false,
                _ => true,
            };
        if (d is CanboardDevice c)
            return kind switch
            {
                "AnalogInput" => c.GetAnalogInputs().FirstOrDefault(x => x.Number == n) is { } a && a.Enabled && (!digitalMode || a.Switch.Enabled),
                "RotarySwitch" => c.GetAnalogInputs().FirstOrDefault(x => x.Number == n) is { } a && a.Enabled && a.Rotary.Enabled,
                "DigitalInput" => c.GetDigitalInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "DigitalOutput" => c.GetDigitalOutputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "CanInput" => c.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "VirtualInput" => c.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Condition" => c.GetConditions().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Counter" => c.GetCounters().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Flasher" => c.GetFlashers().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Timer" => c.GetTimers().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                _ => true,
            };
        return true;
    }

    private sealed class CmfMod
    {
        public readonly HashSet<int> Rx = new();
        public readonly List<string> Decl = new(), RxCases = new(), Tick = new();
        public readonly HashSet<int> TrigDecl = new(), ClkDecl = new(), ClkGen = new();
        public readonly List<int> Bindings = new();
    }

    // Compile cross-module function definitions into per-module Lua + output bindings — a faithful
    // port of compileCrossModule() in store.js. Each function uses a reserved CAN-ID pair from its
    // slot (array index): trigger 0x520+slot*2, clock +1. Blink uses a clock master (defaults to the
    // trigger owner) and an optional failover backup.
    private static Dictionary<string, (string Lua, List<int> Bindings)> CompileCrossModule(IReadOnlyList<CrossFnReq> fns)
    {
        const int idBase = 0x520;
        var mods = new Dictionary<string, CmfMod>();
        CmfMod M(string g) { if (!mods.TryGetValue(g, out var m)) mods[g] = m = new CmfMod(); return m; }

        for (var i = 0; i < fns.Count; i++)
        {
            var f = fns[i];
            if (f is null || f.Disabled || string.IsNullOrEmpty(f.Trigger?.Guid) || f.Trigger!.VarIndex is null) continue;
            var slot = i;
            int trig = idBase + slot * 2, clk = trig + 1;
            var half = ((f.BlinkRateMs <= 0 ? 350 : f.BlinkRateMs) / 1000.0).ToString("0.000", System.Globalization.CultureInfo.InvariantCulture);
            var p = $"_cmf{slot}";
            var blink = f.Blink;
            var ownerG = f.Trigger.Guid;
            var masterG = blink ? (string.IsNullOrEmpty(f.ClockMaster) ? ownerG : f.ClockMaster) : null;
            var backupG = blink && !string.IsNullOrEmpty(f.ClockBackup) ? f.ClockBackup : null;

            var om = M(ownerG);
            om.Tick.Add($"  {p}trig = readVar({f.Trigger.VarIndex}) ~= 0 and 1 or 0");
            om.Tick.Add($"  txCan(1, {trig}, false, {{ {p}trig }})");
            om.Decl.Add($"local {p}trig = 0");

            void NeedTrig(string g)
            {
                if (g == ownerG) return;
                var m = M(g);
                if (m.TrigDecl.Add(slot)) { m.Decl.Add($"local {p}trig = 0"); m.Rx.Add(trig); m.RxCases.Add($"  if id == {trig} then {p}trig = data[1] end"); }
            }
            void NeedClkRx(string g)
            {
                var m = M(g);
                if (m.ClkDecl.Add(slot)) { m.Decl.Add($"local {p}clk = 0"); m.Rx.Add(clk); m.RxCases.Add($"  if id == {clk} then {p}clk = data[1] end"); }
            }

            if (masterG != null)
            {
                var m = M(masterG);
                NeedTrig(masterG);
                m.Decl.Add($"local {p}clk = 0"); m.Decl.Add($"local {p}ct = Timer.new()");
                m.ClkGen.Add(slot);
                m.Tick.Add($"  if {p}trig == 1 then\n    if {p}ct:getElapsedSeconds() >= {half} then {p}ct:reset(); {p}clk = 1 - {p}clk end\n  else {p}clk = 0; {p}ct:reset() end\n  txCan(1, {clk}, false, {{ {p}clk, 0 }})");
            }
            if (backupG != null && backupG != masterG)
            {
                var m = M(backupG);
                NeedTrig(backupG);
                m.Decl.Add($"local {p}clk = 0"); m.Decl.Add($"local {p}ct = Timer.new()"); m.Decl.Add($"local {p}seen = Timer.new()");
                m.Rx.Add(clk);
                m.RxCases.Add($"  if id == {clk} and data[2] == 0 then {p}seen:reset() end");
                m.Tick.Add($"  if {p}seen:getElapsedSeconds() > 0.3 and {p}trig == 1 then\n    if {p}ct:getElapsedSeconds() >= {half} then {p}ct:reset(); {p}clk = 1 - {p}clk end\n    txCan(1, {clk}, false, {{ {p}clk, 1 }})\n  end");
            }
            foreach (var t in f.Targets ?? new List<CrossTargetReq>())
            {
                if (string.IsNullOrEmpty(t.Guid) || t.Output <= 0) continue;
                var m = M(t.Guid);
                NeedTrig(t.Guid);
                var oslot = t.Output - 1;
                string drive;
                if (blink) { if (!m.ClkGen.Contains(slot)) NeedClkRx(t.Guid); drive = $"({p}trig ~= 0 and {p}clk ~= 0) and 1 or 0"; }
                else drive = $"({p}trig ~= 0) and 1 or 0";
                m.Tick.Add($"  setLuaOut({oslot}, {drive})");
                m.Bindings.Add(t.Output);
            }
        }

        var outp = new Dictionary<string, (string, List<int>)>();
        foreach (var (g, m) in mods)
        {
            if (m.Tick.Count == 0) continue;
            var sb = new System.Text.StringBuilder();
            sb.Append("-- Cross-module functions — generated by dingoConfig (MCP deploy).\n");
            sb.Append(string.Join("\n", m.Decl.Distinct())).Append('\n');
            foreach (var id in m.Rx) sb.Append($"canRxAdd({id})\n");
            if (m.RxCases.Count > 0) sb.Append("function onCanRx(bus, id, dlc, data)\n").Append(string.Join("\n", m.RxCases.Distinct())).Append("\nend\n");
            sb.Append("function onTick()\n").Append(string.Join("\n", m.Tick)).Append("\nend\nsetTickRate(50)\n");
            outp[g] = (sb.ToString(), m.Bindings);
        }
        return outp;
    }
}
