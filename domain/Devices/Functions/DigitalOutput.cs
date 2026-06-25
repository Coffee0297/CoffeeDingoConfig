using System.Text.Json.Serialization;
using domain.Common;
using domain.Interfaces;
using domain.Models;

namespace domain.Devices.Functions;

public class DigitalOutput : IDeviceFunction
{
    [JsonIgnore] public const int BaseIndex = 0x2100;
    [JsonPropertyName("name")] public string Name {get; set; }
    [JsonPropertyName("number")] public int Number {get;}
    [JsonPropertyName("enabled")] public bool Enabled {get; set;}
    [JsonPropertyName("input")] public int Input { get; set; }

    // PWM / dimming — same model as the PDM's smart outputs (Output.cs). Sub-indices 2-10 match
    // the firmware's DIGITAL_OUTPUT_PARAMS order exactly.
    [JsonPropertyName("pwmEnabled")] public bool PwmEnabled { get; set; }
    [JsonPropertyName("softStartEnabled")] public bool SoftStartEnabled { get; set; }
    [JsonPropertyName("variableDutyCycle")] public bool VariableDutyCycle { get; set; }
    [JsonPropertyName("dutyCycleInput")] public int DutyCycleInput { get; set; }
    [JsonPropertyName("fixedDutyCycle")] public int FixedDutyCycle { get; set; } = 100;
    [JsonPropertyName("frequency")] public int Frequency { get; set; } = 100;
    [JsonPropertyName("softStartRampTime")] public int SoftStartRampTime { get; set; }
    [JsonPropertyName("dutyCycleDenominator")] public int DutyCycleDenominator { get; set; } = 100;
    [JsonPropertyName("minDutyCycle")] public int MinDutyCycle { get; set; }
    [JsonPropertyName("variableFreq")] public bool VariableFreq { get; set; }
    [JsonPropertyName("freqInput")] public int FreqInput { get; set; }
    [JsonPropertyName("freqInputDenom")] public int FreqInputDenom { get; set; } = 1;

    [JsonIgnore][Plotable(displayName:"State")] public bool State { get; set; }
    [JsonIgnore][Plotable(displayName:"DutyCycle", unit:"%")] public double CurrentDutyCycle { get; set; }

    [JsonIgnore] public List<DeviceParameter> Params { get; }

    [JsonConstructor]
    public DigitalOutput(int number, string name)
    {
        Number = number;
        Name = name;
        Params = InitParams();
    }

    private List<DeviceParameter> InitParams()
    {
        var subIndex = 0;
        return
        [
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].enabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Enabled, SetValue = val => Enabled = (bool)val,
                ValueType = Enabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].input", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Input, SetValue = val => Input = (int)val,
                ValueType = Input.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].pwmEnabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => PwmEnabled, SetValue = val => PwmEnabled = (bool)val,
                ValueType = PwmEnabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].softStartEnabled", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => SoftStartEnabled, SetValue = val => SoftStartEnabled = (bool)val,
                ValueType = SoftStartEnabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].variableDutyCycle", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => VariableDutyCycle, SetValue = val => VariableDutyCycle = (bool)val,
                ValueType = VariableDutyCycle.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].dutyCycleInput", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => DutyCycleInput, SetValue = val => DutyCycleInput = (int)val,
                ValueType = DutyCycleInput.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].fixedDutyCycle", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => FixedDutyCycle, SetValue = val => FixedDutyCycle = (int)val,
                ValueType = FixedDutyCycle.GetType(),
                DefaultValue = 100
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].frequency", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => Frequency, SetValue = val => Frequency = (int)val,
                ValueType = Frequency.GetType(),
                DefaultValue = 100
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].softStartRampTime", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => SoftStartRampTime, SetValue = val => SoftStartRampTime = (int)val,
                ValueType = SoftStartRampTime.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].dutyCycleDenominator", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => DutyCycleDenominator, SetValue = val => DutyCycleDenominator = (int)val,
                ValueType = DutyCycleDenominator.GetType(),
                DefaultValue = 100
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].minDutyCycle", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => MinDutyCycle, SetValue = val => MinDutyCycle = (int)val,
                ValueType = MinDutyCycle.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].variableFreq", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => VariableFreq, SetValue = val => VariableFreq = (bool)val,
                ValueType = VariableFreq.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].freqInput", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => FreqInput, SetValue = val => FreqInput = (int)val,
                ValueType = FreqInput.GetType(),
                DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = $"digitalOutput[{Number}].freqInputDenom", Index = BaseIndex + (Number - 1), SubIndex = subIndex++,
                GetValue = () => FreqInputDenom, SetValue = val => FreqInputDenom = (int)val,
                ValueType = FreqInputDenom.GetType(),
                DefaultValue = 1
            }
        ];
    }
}
