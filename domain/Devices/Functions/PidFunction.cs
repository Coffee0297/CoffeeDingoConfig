using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

// PID controller (upstream-family dingoFW feat/pid, param base 0x2300, 4 on the PDMs, 2 on the 5.7 CANBoard).
// Every PeriodMs: error = setpoint − pv (inverted: pv − setpoint) with a deadband; P = Kp·e; I += Ki·e·dt, clamped
// to IMin..IMax and not pushed further into a saturated output; D on the measurement; output = feed-forward
// (constant + var) + P + I + D, clamped to OutMin..OutMax. pv outside PvMin..PvMax (both 0 = no window) → Fallback.
// SetpointInput 0 → the fixed Setpoint (sub 20). Activate input off → feed-forward only. Crossed limits make the firmware treat it as disabled (output 0).
public class PidFunction : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2300;
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("number")] public int Number { get; }
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("setpointInput")] public int SetpointInput { get; set; }
    [JsonPropertyName("processInput")] public int ProcessInput { get; set; }
    [JsonPropertyName("activateInput")] public int ActivateInput { get; set; } = 1;   // var 1 = Always On
    [JsonPropertyName("feedForward")] public double FeedForward { get; set; }
    [JsonPropertyName("feedFwdInput")] public int FeedFwdInput { get; set; }
    [JsonPropertyName("kp")] public double Kp { get; set; } = 1.0;
    [JsonPropertyName("ki")] public double Ki { get; set; }
    [JsonPropertyName("kd")] public double Kd { get; set; }
    [JsonPropertyName("iMin")] public double IMin { get; set; } = -100.0;
    [JsonPropertyName("iMax")] public double IMax { get; set; } = 100.0;
    [JsonPropertyName("outMin")] public double OutMin { get; set; }
    [JsonPropertyName("outMax")] public double OutMax { get; set; } = 100.0;
    [JsonPropertyName("invert")] public bool Invert { get; set; }
    [JsonPropertyName("spRate")] public double SpRate { get; set; }
    [JsonPropertyName("deadband")] public double Deadband { get; set; }
    [JsonPropertyName("pvMin")] public double PvMin { get; set; }
    [JsonPropertyName("pvMax")] public double PvMax { get; set; }
    [JsonPropertyName("fallback")] public double Fallback { get; set; }
    [JsonPropertyName("periodMs")] public int PeriodMs { get; set; } = 20;
    [JsonPropertyName("setpoint")] public double Setpoint { get; set; }   // used while SetpointInput is 0

    // live output from the PID status frame (×10 int16)
    [JsonIgnore][Plotable(displayName: "Output")] public double Value { get; set; }
    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public PidFunction(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
    }

    /// <summary>Why the firmware would refuse or ignore this config (null = fine). Its param ranges, plus the
    /// crossed limits it treats as "disabled".</summary>
    public string? Problem()
    {
        bool Bad(double v, double lo = -1e6, double hi = 1e6) => !double.IsFinite(v) || v < lo || v > hi;
        if (PeriodMs is < 2 or > 1000) return "the update period must be 2 to 1000 ms";
        if (Bad(Kp, 0) || Bad(Ki, 0) || Bad(Kd, 0)) return "Kp, Ki and Kd must be 0 to 1000000 (use invert for the direction)";
        if (Bad(SpRate, 0) || Bad(Deadband, 0)) return "the setpoint rate and deadband must be 0 or more";
        if (Bad(FeedForward) || Bad(IMin) || Bad(IMax) || Bad(OutMin) || Bad(OutMax) || Bad(PvMin) || Bad(PvMax) || Bad(Fallback) || Bad(Setpoint))
            return "limits, setpoint, feed-forward and fallback must be within ±1000000";
        if (OutMin > OutMax) return "output min must not be above output max";
        if (IMin > IMax) return "I min must not be above I max";
        if (PvMin > PvMax) return "the sensor window's low end must not be above its high end";
        return null;
    }

    private List<DeviceParameter> InitParams()
    {
        var i = BaseIndex + (Number - 1);
        var n = $"pid[{Number}]";
        DeviceParameter F(int sub, string f, Func<double> get, Action<double> set, double def) =>
            new() { ParentName = Name, Name = $"{n}.{f}", Index = i, SubIndex = sub, GetValue = () => get(), SetValue = v => set((double)v), ValueType = typeof(double), DefaultValue = def };
        DeviceParameter V(int sub, string f, Func<int> get, Action<int> set, int def) =>
            new() { ParentName = Name, Name = $"{n}.{f}", Index = i, SubIndex = sub, GetValue = () => get(), SetValue = v => set((int)v), ValueType = typeof(int), DefaultValue = def };
        DeviceParameter B(int sub, string f, Func<bool> get, Action<bool> set) =>
            new() { ParentName = Name, Name = $"{n}.{f}", Index = i, SubIndex = sub, GetValue = () => get(), SetValue = v => set((bool)v), ValueType = typeof(bool), DefaultValue = false };
        return
        [
            B(0, "enabled", () => Enabled, v => Enabled = v),
            V(1, "setpointInput", () => SetpointInput, v => SetpointInput = v, 0),
            V(2, "processInput", () => ProcessInput, v => ProcessInput = v, 0),
            V(3, "activateInput", () => ActivateInput, v => ActivateInput = v, 1),
            F(4, "feedForward", () => FeedForward, v => FeedForward = v, 0.0),
            V(5, "feedFwdInput", () => FeedFwdInput, v => FeedFwdInput = v, 0),
            F(6, "kp", () => Kp, v => Kp = v, 1.0),
            F(7, "ki", () => Ki, v => Ki = v, 0.0),
            F(8, "kd", () => Kd, v => Kd = v, 0.0),
            F(9, "iMin", () => IMin, v => IMin = v, -100.0),
            F(10, "iMax", () => IMax, v => IMax = v, 100.0),
            F(11, "outMin", () => OutMin, v => OutMin = v, 0.0),
            F(12, "outMax", () => OutMax, v => OutMax = v, 100.0),
            B(13, "invert", () => Invert, v => Invert = v),
            F(14, "spRate", () => SpRate, v => SpRate = v, 0.0),
            F(15, "deadband", () => Deadband, v => Deadband = v, 0.0),
            F(16, "pvMin", () => PvMin, v => PvMin = v, 0.0),
            F(17, "pvMax", () => PvMax, v => PvMax = v, 0.0),
            F(18, "fallback", () => Fallback, v => Fallback = v, 0.0),
            V(19, "periodMs", () => PeriodMs, v => PeriodMs = v, 20),
            F(20, "setpoint", () => Setpoint, v => Setpoint = v, 0.0),
        ];
    }
}
