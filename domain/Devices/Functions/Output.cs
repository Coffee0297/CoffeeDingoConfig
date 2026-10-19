using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using domain.Common;
using domain.Enums.dingoPdm;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public class Output : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x1000;
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("wireColor")] public string WireColor { get; set; } = "";
    [JsonPropertyName("wireStripe")] public string WireStripe { get; set; } = "";
    [JsonPropertyName("wireLength")] public double WireLength { get; set; } = 0.0;   // metres, one-way
    [JsonPropertyName("wireGaugeMm2")] public double WireGaugeMm2 { get; set; } = 0.0; // 0 = auto/recommended
    [JsonPropertyName("number")] public int Number { get; }
    // Ranges below are the firmware's OUTPUT_PARAMS min/max (core/param_defs.h). The device silently
    // rejects an out-of-range write — which the app then reports as "No reply from module" — so the
    // model clamps at the source instead.
    [JsonPropertyName("currentLimit")] public double CurrentLimit { get => field; set => field = Math.Clamp(value, 0.0, 100.0); } = 20.0;
    [JsonPropertyName("resetCountLimit")] public int ResetCountLimit { get => field; set => field = Math.Clamp(value, 0, 20); } = 3;
    [JsonPropertyName("resetMode")] public ResetMode ResetMode { get; set; } = ResetMode.None;
    [JsonPropertyName("resetTime")] public int ResetTime { get => field; set => field = Math.Clamp(value, 0, 60000); } = 1000;

    [JsonPropertyName("inrushCurrentLimit")]
    public double InrushCurrentLimit { get => field; set => field = Math.Clamp(value, 0.0, 100.0); } = 50.0;

    [JsonPropertyName("inrushTime")] public int InrushTime { get => field; set => field = Math.Clamp(value, 0, 10000); } = 1000;
    [JsonPropertyName("input")] public int Input { get; set; }
    [JsonPropertyName("pwmEnabled")] public bool PwmEnabled { get; set; }
    [JsonPropertyName("softStartEnabled")] public bool SoftStartEnabled { get; set; }
    [JsonPropertyName("variableDutyCycle")] public bool VariableDutyCycle { get; set; }
    [JsonPropertyName("dutyCycleInput")] public int DutyCycleInput { get; set; }
    [JsonPropertyName("fixedDutyCycle")] public int FixedDutyCycle { get => field; set => field = Math.Clamp(value, 0, 100); } = 100;
    [JsonPropertyName("frequency")] public int Frequency { get => field; set => field = Math.Clamp(value, 0, 400); } = 100;
    [JsonPropertyName("softStartRampTime")] public int SoftStartRampTime { get => field; set => field = Math.Clamp(value, 0, 10000); }

    [JsonPropertyName("dutyCycleDenominator")]
    public int DutyCycleDenominator { get => field; set => field = Math.Clamp(value, 1, 5000); } = 100;
    [JsonPropertyName("minDutyCycle")] public int MinDutyCycle { get => field; set => field = Math.Clamp(value, 0, 100); } = 0;
    [JsonPropertyName("variableFreq")] public bool VariableFreq { get; set; }
    [JsonPropertyName("freqInput")] public int FreqInput { get; set; }
    [JsonPropertyName("freqInputDenom")] public int FreqInputDenom { get => field; set => field = Math.Clamp(value, 1, 5000); } = 1;
    [JsonPropertyName("rampDutyChanges")] public bool RampDutyChanges { get; set; }
    // -1 = pairing disabled; otherwise a 0-based output index (firmware int8, -1 … NUM_OUTPUTS-1).
    [JsonPropertyName("primaryOutput")] public int PrimaryOutput { get => field; set => field = Math.Clamp(value, -1, 7); } = -1;

    [JsonPropertyName("warnLimit")] public double WarnLimit { get => field; set => field = Math.Clamp(value, 0.0, 100.0); } = 0.0;        //A, 0 = disabled
    [JsonPropertyName("openLoadLimit")] public double OpenLoadLimit { get => field; set => field = Math.Clamp(value, 0.0, 100.0); } = 0.0; //A, 0 = disabled
    [JsonPropertyName("openLoadTime")] public int OpenLoadTime { get => field; set => field = Math.Clamp(value, 0, 60000); } = 1000;     //ms below floor before flagging
    // upstream feat/undercurrent-trip (subs 27-29): below UnderLimit A (0 = off) for UnderTime ms while on, past inrush:
    // report Undercurrent, or with UnderTrip latch Fault and switch the output off
    [JsonPropertyName("underLimit")] public double UnderLimit { get => field; set => field = Math.Clamp(value, 0.0, 100.0); } = 0.0;
    [JsonPropertyName("underTime")] public int UnderTime { get => field; set => field = Math.Clamp(value, 0, 60000); } = 1000;
    [JsonPropertyName("underTrip")] public bool UnderTrip { get; set; }
    // upstream feat/fault-clear: a latched Fault clears when the output's input goes off, so switching it on again retries
    [JsonPropertyName("clearOnReassert")] public bool ClearOnReassert { get; set; }
    // upstream feat/hard-short-trip: A, 0 = off; above it the output latches Fault at once, also inside the inrush time
    [JsonPropertyName("hardShortLimit")] public double HardShortLimit { get => field; set => field = Math.Clamp(value, 0.0, 100.0); } = 0.0;
    // upstream feat/soft-start-current-limit: ms, 0 = off; a PWM soft start holds while over the inrush limit and trips if not done in this time
    [JsonPropertyName("softStartTimeout")] public int SoftStartTimeout { get => field; set => field = Math.Clamp(value, 0, 60000); } = 0;
    // upstream feat/soft-stop: ms, 0 = off; a PWM output's duty ramps to 0 over this time when its input turns off
    [JsonPropertyName("softStopTime")] public int SoftStopTime { get => field; set => field = Math.Clamp(value, 0, 10000); } = 0;
    // upstream feat/load-shed: held off while the module's shed input is on
    [JsonPropertyName("shed")] public bool Shed { get; set; }
    // upstream feat/wire-load: wire time constant, s, 0 = off; the module estimates the wire's load % from I² (report only)
    [JsonPropertyName("thermalTau")] public int ThermalTau { get => field; set => field = Math.Clamp(value, 0, 600); } = 0;
    
    [JsonIgnore][Plotable(displayName:"Current", unit:"A")] public double Current { get; set; }
    [JsonIgnore][Plotable(displayName:"State")] public OutState State { get; set; }
    [JsonIgnore][Plotable(displayName:"ResetCount")] public int ResetCount { get; set; }
    // upstream feat/wire-load: the wire's estimated load % (100 = the temperature the current limit reaches for good)
    [JsonIgnore][Plotable(displayName:"WireLoad", unit:"%")] public double WireLoad { get; set; }
    [JsonIgnore][Plotable(displayName:"DutyCycle", unit:"%")] public double CurrentDutyCycle
    {
        get;
        set
        {
            field = value;
            CalculatedCurrent = (field / 100.0) * Current;
        }
    }
    [JsonIgnore][Plotable(displayName:"CalcCurrent", unit:"A")] public double CalculatedCurrent { get; private set; }

    // Upstream dingoFW feat/stay-alive-outputs (sub 34): an output that is on when the module goes to sleep stays on
    // (solid, 100 % even with PWM) with NO firmware current protection while asleep. The fork has none.
    [JsonPropertyName("stayAlive")] public bool StayAlive { get; set; }

    [JsonIgnore] public List<DeviceParameter> Params { get; }
    // Upstream-only subs (free in the fork, whose firmware lacks them): added on upstream modules only.
    [JsonIgnore] public List<DeviceParameter> UpstreamParams { get; }

    [JsonConstructor]
    public Output(int number, string name)
    {
        Number = number;
        Name = name;

        Params = InitParams();
        var idx = BaseIndex + (Number - 1);
        UpstreamParams =
        [
            new DeviceParameter { ParentName = Name, Name = $"output[{Number}].clearOnReassert", Index = idx, SubIndex = 25,
                GetValue = () => ClearOnReassert, SetValue = val => ClearOnReassert = (bool)val, ValueType = typeof(bool), DefaultValue = false },
            new DeviceParameter { ParentName = Name, Name = $"output[{Number}].underLimit", Index = idx, SubIndex = 27,
                GetValue = () => UnderLimit, SetValue = val => UnderLimit = (double)val, ValueType = typeof(double), DefaultValue = 0.0 },
            new DeviceParameter { ParentName = Name, Name = $"output[{Number}].underTime", Index = idx, SubIndex = 28,
                GetValue = () => UnderTime, SetValue = val => UnderTime = (int)val, ValueType = typeof(int), DefaultValue = 1000 },
            new DeviceParameter { ParentName = Name, Name = $"output[{Number}].underTrip", Index = idx, SubIndex = 29,
                GetValue = () => UnderTrip, SetValue = val => UnderTrip = (bool)val, ValueType = typeof(bool), DefaultValue = false },
            new DeviceParameter { ParentName = Name, Name = $"output[{Number}].hardShortLimit", Index = idx, SubIndex = 32,
                GetValue = () => HardShortLimit, SetValue = val => HardShortLimit = (double)val, ValueType = typeof(double), DefaultValue = 0.0 },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].softStartTimeout", Index = BaseIndex + (Number - 1), SubIndex = 30,
                GetValue = () => SoftStartTimeout, SetValue = val => SoftStartTimeout = (int)val,
                ValueType = typeof(int), DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].softStopTime", Index = BaseIndex + (Number - 1), SubIndex = 31,
                GetValue = () => SoftStopTime, SetValue = val => SoftStopTime = (int)val,
                ValueType = typeof(int), DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].shed", Index = BaseIndex + (Number - 1), SubIndex = 26,
                GetValue = () => Shed, SetValue = val => Shed = (bool)val,
                ValueType = typeof(bool), DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].thermalTau", Index = BaseIndex + (Number - 1), SubIndex = 33,
                GetValue = () => ThermalTau, SetValue = val => ThermalTau = (int)val,
                ValueType = typeof(int), DefaultValue = 0
            },
            new() { ParentName = Name, Name = $"output[{Number}].stayAlive", Index = BaseIndex + (Number - 1), SubIndex = 34,
                GetValue = () => StayAlive, SetValue = v => StayAlive = (bool)v, ValueType = typeof(bool), DefaultValue = false },
        ];
    }

    private List<DeviceParameter> InitParams()
    {
        var subIndex = 0;
        return
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].name", Index = BaseIndex + (Number - 1), SubIndex = 0x40,
                GetValue = () => Name, SetValue = val => Name = (string)val,
                ValueType = typeof(string),
                DefaultValue = Name,
                LocalOnly = true   // label only — no CAN storage on the device
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].wireColor", Index = BaseIndex + (Number - 1), SubIndex = 0x41,
                GetValue = () => WireColor, SetValue = val => WireColor = (string)val,
                ValueType = typeof(string),
                DefaultValue = "",
                LocalOnly = true   // documentation label only — no CAN storage
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].wireStripe", Index = BaseIndex + (Number - 1), SubIndex = 0x42,
                GetValue = () => WireStripe, SetValue = val => WireStripe = (string)val,
                ValueType = typeof(string),
                DefaultValue = "",
                LocalOnly = true   // documentation label only — no CAN storage
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].wireLength", Index = BaseIndex + (Number - 1), SubIndex = 0x43,
                GetValue = () => WireLength, SetValue = val => WireLength = (double)val,
                ValueType = typeof(double),
                DefaultValue = 0.0,
                LocalOnly = true   // documentation label only — no CAN storage
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].wireGaugeMm2", Index = BaseIndex + (Number - 1), SubIndex = 0x44,
                GetValue = () => WireGaugeMm2, SetValue = val => WireGaugeMm2 = (double)val,
                ValueType = typeof(double),
                DefaultValue = 0.0,
                LocalOnly = true   // documentation label only — no CAN storage
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].enabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].input", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Input, SetValue = val => Input = (int)val,
                ValueType = Input.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].currentLimit", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => CurrentLimit, SetValue = val => CurrentLimit = (double)val,
                ValueType = CurrentLimit.GetType(),
                DefaultValue = 20.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].inrushCurrentLimit", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => InrushCurrentLimit, SetValue = val => InrushCurrentLimit = (double)val,
                ValueType = InrushCurrentLimit.GetType(),
                DefaultValue = 50.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].inrushTime", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => InrushTime, SetValue = val => InrushTime = (int)val,
                ValueType = InrushTime.GetType(),
                DefaultValue = 1000
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].resetMode", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => ResetMode, SetValue = val => ResetMode = (ResetMode)val,
                ValueType = ResetMode.GetType(),
                DefaultValue = ResetMode.None
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].resetTime", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => ResetTime, SetValue = val => ResetTime = (int)val,
                ValueType = ResetTime.GetType(),
                DefaultValue = 1000
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].resetCountLimit", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => ResetCountLimit, SetValue = val => ResetCountLimit = (int)val,
                ValueType = ResetCountLimit.GetType(),
                DefaultValue = 3
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].pwmEnabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => PwmEnabled, SetValue = val => PwmEnabled = (bool)val,
                ValueType = PwmEnabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].softStartEnabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => SoftStartEnabled, SetValue = val => SoftStartEnabled = (bool)val,
                ValueType = SoftStartEnabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].variableDutyCycle", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => VariableDutyCycle, SetValue = val => VariableDutyCycle = (bool)val,
                ValueType = VariableDutyCycle.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].dutyCycleInput", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => DutyCycleInput, SetValue = val => DutyCycleInput = (int)val,
                ValueType = DutyCycleInput.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].fixedDutyCycle", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => FixedDutyCycle, SetValue = val => FixedDutyCycle = (int)val,
                ValueType = FixedDutyCycle.GetType(),
                DefaultValue = 100
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].frequency", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Frequency, SetValue = val => Frequency = (int)val,
                ValueType = Frequency.GetType(),
                DefaultValue = 100
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].softStartRampTime", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => SoftStartRampTime, SetValue = val => SoftStartRampTime = (int)val,
                ValueType = SoftStartRampTime.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].dutyCycleDenominator", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => DutyCycleDenominator, SetValue = val => DutyCycleDenominator = (int)val,
                ValueType = DutyCycleDenominator.GetType(),
                DefaultValue = 100
            },
            new DeviceParameter
            {
                ParentName  = Name, Name = $"output[{Number}].minDutyCycle",  Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => MinDutyCycle, SetValue = val => MinDutyCycle = (int)val,
                ValueType = MinDutyCycle.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].primaryOutput", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => PrimaryOutput, SetValue = val => PrimaryOutput = (int)val,
                ValueType = PrimaryOutput.GetType(),
                DefaultValue = -1,
                IsSignedInt = true
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].warnLimit", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => WarnLimit, SetValue = val => WarnLimit = (double)val,
                ValueType = WarnLimit.GetType(),
                DefaultValue = 0.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].openLoadLimit", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => OpenLoadLimit, SetValue = val => OpenLoadLimit = (double)val,
                ValueType = OpenLoadLimit.GetType(),
                DefaultValue = 0.0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].openLoadTime", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => OpenLoadTime, SetValue = val => OpenLoadTime = (int)val,
                ValueType = OpenLoadTime.GetType(),
                DefaultValue = 1000
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].variableFreq", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => VariableFreq, SetValue = val => VariableFreq = (bool)val,
                ValueType = VariableFreq.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].freqInput", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => FreqInput, SetValue = val => FreqInput = (int)val,
                ValueType = FreqInput.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].freqInputDenom", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => FreqInputDenom, SetValue = val => FreqInputDenom = (int)val,
                ValueType = FreqInputDenom.GetType(),
                DefaultValue = 1
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"output[{Number}].rampDutyChanges", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => RampDutyChanges, SetValue = val => RampDutyChanges = (bool)val,
                ValueType = RampDutyChanges.GetType(),
                DefaultValue = false
            }
        ];
    }
}