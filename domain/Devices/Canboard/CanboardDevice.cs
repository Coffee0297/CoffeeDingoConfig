using System.Collections.Concurrent;
using System.Text.Json.Serialization;
using domain.Common;
using domain.Enums;
using domain.Enums.Canboard;
using domain.Devices.Functions;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging;
using static domain.Common.DbcSignalCodec;
// ReSharper disable MemberCanBePrivate.Global

namespace domain.Devices.Canboard;

public class CanboardDevice : IDeviceConfigurable
{
    [JsonIgnore] protected ILogger<CanboardDevice> Logger = null!;

    [JsonIgnore] protected int MinMajorVersion { get; private set; } = 5;
    [JsonIgnore] protected int MinMinorVersion { get; private set; } = 5;
    [JsonIgnore] protected int MinBuildVersion { get; private set; } = 107;

    [JsonIgnore] protected int NumAnalogInputs { get; private set; } = 5; //Also serve as rotary switches and analog/dig inputs
    [JsonIgnore] protected int NumDigitalInputs { get; private set; } = 8;
    [JsonIgnore] protected int NumDigitalOutputs { get; private set; } = 4;
    [JsonIgnore] protected int NumCanInputs { get; private set; } = 8;
    [JsonIgnore] protected int NumCanOutputs { get; private set; } = 8;
    [JsonIgnore] protected int NumVirtualInputs { get; private set; } = 8;
    [JsonIgnore] protected int NumFlashers { get; private set; } = 4;
    [JsonIgnore] protected int NumCounters { get; private set; } = 4;
    [JsonIgnore] protected int NumConditions { get; private set; } = 8;
    [JsonIgnore] protected int NumTimers { get; private set; } = 4;
    [JsonIgnore] protected int NumMath { get; private set; } = 4;
    [JsonIgnore] protected int NumCanMessages { get; private set; } = 2;
    
    // Firmware 5.5.111 put the CANBoard to sleep (STOP) like the PDM; older firmware only goes quiet (mute TX).
    // Version not read yet: assumed able, like a PDM, so the sleep settings do not vanish until it answers.
    [JsonIgnore] public static readonly Version SleepSince = new(5, 5, 111);
    // Upstream dingoFW: the CANBoard build has no CAN_SLEEP.
    [JsonIgnore] public bool CanSleep => !VersionReceived || (Family == FwFamily.Fork && domain.Common.Firmware.Has(Version, SleepSince));
    [JsonPropertyName("canBootloader")] public bool CanBootloader { get; } = true;   // OpenBLT XCP-over-CAN bootloader

    [JsonIgnore] public const int BaseIndex = 0x0000;
    [JsonPropertyName("canboardType")] public int CanboardType { get; set; }
    [JsonIgnore] protected bool CanboardTypeOk;
    [JsonIgnore] public bool ConfigMismatch { get; set; } = true;
    [JsonIgnore] public List<ConfigDiffEntry> LastConfigDiff { get; set; } = new();

    [JsonPropertyName("guid")] public Guid Guid { get; set; }
    [JsonIgnore] public string Type  { get; private set; } = "CANBoard";
    [JsonIgnore] public string Icon { get; private set; } = string.Empty;
    [JsonIgnore] public int ConfigVersion { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("baseId")] public int BaseId { get; set; }
    [JsonIgnore] public static int DefaultId { get; } = 0x640;
    [JsonIgnore] public const int ConfigRxOffset = 0;
    [JsonIgnore] public const int ConfigTxOffset = 1;
    [JsonIgnore] public const int CyclicRxOffset = 2;
    
    [JsonIgnore] public int MaxCyclicId { get; private set; }
    
    [JsonIgnore] public List<DeviceVariable> VarMap { get; set; } = null!;
    [JsonIgnore] public List<DeviceParameter> Params { get; set; } = null!;
    
    // Board temperature from the MCU's internal sensor. The firmware broadcasts it as a whole °C in
    // Msg 1 bits 48-63 (boards/canboard_v2/msg.cpp TxMsg1; DBC BoardTemp factor 1, no decimals).
    [JsonIgnore][Plotable(displayName:"Temperature", unit:"degC")] public double BoardTemp { get; set; }
    // Same value under the PDM's name so the shared DeviceDto.Temp plumbing works for both device kinds.
    [JsonIgnore] public double BoardTempC => BoardTemp;
    [JsonIgnore][Plotable(displayName:"Heartbeat", unit:" ")] public int Heartbeat { get; private set; }
    
    [JsonIgnore] public string Version { get; private set; } = "v0.0.0";
    [JsonIgnore] public bool VersionReceived { get; private set; }
    // Fork (dingoFW 5.x) or upstream (dingoFW 0.x): picks the param numbering, var map and status frames.
    [JsonPropertyName("family")] public string Family { get; set; } = FwFamily.Fork;
    [JsonIgnore] public DeviceParamSet ParamSet { get; } = new();
    // Upstream: the module's param list, saved so the project reloads with its layout (Apply still needs a Read).
    [JsonPropertyName("paramRuns"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int[][]? ParamRuns { get => Family == FwFamily.Upstream ? ParamSet.Runs : null; set => ParamSet.Runs = value; }
    public event Action<string>? SuccessNotification;
    public event Action<string>? ErrorNotification;
    public event Action? WriteAllIncomplete;
    
    [JsonIgnore] private DateTime LastRxTime { get; set; }
    [JsonPropertyName("sleepEnabled")] public bool SleepEnabled { get; set; }
    // ms, clamped to the firmware's DEVICE_CONFIG range (1000 … 60000) — it silently rejects anything outside.
    [JsonPropertyName("sleepTimeoutMs")] public int SleepTimeoutMs { get => field; set => field = Math.Clamp(value, 1000, 60000); } = 30000;
    [JsonPropertyName("sleepIgnoreAlwaysOn")] public bool SleepIgnoreAlwaysOn { get; set; } = true;
    // Same device-level sleep params as the PDM (the firmware param map is shared); the CANBoard
    // doesn't sleep (CAN_SLEEP off) but the mute-TX input works everywhere.
    [JsonPropertyName("forceSleepInput")] public int ForceSleepInput { get; set; }
    [JsonPropertyName("muteTxInput")] public int MuteTxInput { get; set; }
    [JsonPropertyName("wakeDigInputMask")] public int WakeDigInputMask { get; set; } = 0xFF;
    [JsonPropertyName("wakeOnCan")] public bool WakeOnCan { get; set; } = true;
    [JsonPropertyName("filtersEnabled")] public bool CanFiltersEnabled { get; set; }
    [JsonPropertyName("connectUsbToCan")] public bool ConnectUsbToCan { get; set; } = true;
    [JsonPropertyName("bitrate")] public CanBitRate BitRate { get; set; } = CanBitRate.BitRate500K;
    [JsonIgnore] public TimeSpan CyclicGap { get; } =  TimeSpan.FromSeconds(0);
    [JsonIgnore] public TimeSpan CyclicPause { get; } = TimeSpan.FromMilliseconds(0);

    [JsonIgnore]
    public bool Connected
    {
        get;
        private set
        {
            if (field && !value)
            {
                Clear();
            }

            field = value;
        }
    }

    [JsonPropertyName("analogIn")] public List<AnalogInput> AnalogInputs { get; init; } = [];
    [JsonPropertyName("digitalIn")] public List<DigitalInput> DigitalInputs { get; init; } = [];
    [JsonPropertyName("digitalOut")] public List<DigitalOutput> DigitalOutputs { get; init; } = [];
    [JsonPropertyName("canInputs")] public List<CanInput> CanInputs { get; init; } = [];
    [JsonPropertyName("canOutputs")] public List<CanOutput> CanOutputs { get; init; } = [];
    [JsonPropertyName("virtualInputs")] public List<VirtualInput> VirtualInputs { get; init; } = [];
    [JsonPropertyName("flashers")] public List<Flasher> Flashers { get; init; } = [];
    [JsonPropertyName("counters")] public List<Counter> Counters { get; init; } = [];
    [JsonPropertyName("conditions")] public List<Condition> Conditions { get; init; } = [];
    [JsonPropertyName("timers")] public List<TimerFunction> Timers { get; init; } = [];
    // G14: from status msg 1 (firmware 5.6)
    [JsonIgnore] public int SleepCountdownRaw { get; set; } = 255;
    [JsonIgnore] public int SleepBlockersRaw { get; set; }
    [JsonIgnore] public int? SleepCountdownS => domain.Common.Firmware.Has(Version, Functions.MathFunction.Since) && SleepCountdownRaw < 255 ? SleepCountdownRaw : null;
    // firmware 5.6
    [JsonPropertyName("maths")] public List<MathFunction> Maths { get; init; } = [];
    [JsonPropertyName("canMessages")] public List<CanMessage> CanMessages { get; init; } = [];
    [JsonPropertyName("ignition")] public Ignition Ignition { get; set; } = null!;
    [JsonPropertyName("comfortBlink")] public ComfortBlink ComfortBlink { get; set; } = null!;   // 5.6.1

    [JsonIgnore] private Dictionary<int, List<(DbcSignal Signal, Action<double> SetValue)>> StatusSigs { get; set; } = null!;

    [JsonIgnore] private ParamProtocol _paramProtocol = null!;
    
    [JsonConstructor]
    public CanboardDevice(string name, int baseId)
    {
        Guid = Guid.NewGuid();
        Name = name;
        BaseId =  baseId;

        // ReSharper disable VirtualMemberCallInConstructor
        InitFunctions();
        InitVarMap();
        InitParams();
    }
    
    public CanboardDevice(CanboardDeviceDefinition definition, string name, int baseId)
    {
        Guid = Guid.NewGuid();
        Name = name;
        BaseId =  baseId;

        NumDigitalInputs = definition.NumDigitalInputs;
        NumDigitalOutputs = definition.NumOutputs;
        NumAnalogInputs = definition.NumAnalogInputs;
        NumCanInputs = definition.NumCanInputs;
        NumCanOutputs = definition.NumCanOutputs;
        NumVirtualInputs = definition.NumVirtualInputs;
        NumFlashers = definition.NumFlashers;
        NumCounters = definition.NumCounters;
        NumConditions = definition.NumConditions;
        NumTimers = definition.NumTimers;
        NumMath = definition.NumMath;
        NumCanMessages = definition.NumCanMessages;

        InitFunctions();
        ApplyDefinition(definition);
    }
    
    public void SetLogger(ILogger<CanboardDevice> logger)
    {
        Logger = logger;
        _paramProtocol.SetLogger(logger);
    }

    public void ApplyDefinition(CanboardDeviceDefinition definition)
    {
        CanboardType = definition.CanboardType;
        Type = definition.TypeName;
        Icon = definition.Icon;
        MinMajorVersion = definition.MinMajorVersion;
        MinMinorVersion = definition.MinMinorVersion;
        MinBuildVersion = definition.MinBuildVersion;
        NumDigitalInputs = definition.NumDigitalInputs;
        NumDigitalOutputs = definition.NumOutputs;
        NumAnalogInputs = definition.NumAnalogInputs;
        NumCanInputs = definition.NumCanInputs;
        NumCanOutputs = definition.NumCanOutputs;
        NumVirtualInputs = definition.NumVirtualInputs;
        NumFlashers = definition.NumFlashers;
        NumCounters = definition.NumCounters;
        NumConditions = definition.NumConditions;
        NumTimers = Timers.Count;
        NumMath = Maths.Count;
        NumCanMessages = CanMessages.Count;

        InitStatusSigs();
        InitVarMap();
        InitParams();
    }

    private void InitFunctions()
    {
        for (var i = 0; i < NumDigitalInputs; i++)
            DigitalInputs.Add(new DigitalInput(i + 1, "digitalInput" + (i + 1)));
        
        for (var i = 0; i < NumDigitalOutputs; i++)
            DigitalOutputs.Add(new DigitalOutput(i + 1, "digitalOutput" + (i + 1)));
        
        for (var i = 0; i < NumAnalogInputs; i++)
            AnalogInputs.Add(new AnalogInput(i + 1, "analogInput" + (i + 1)));
        
        for (var i = 0; i < NumCanInputs; i++)
            CanInputs.Add(new CanInput(i + 1, "canInput" + (i + 1)));
        
        for (var i = 0; i < NumCanOutputs; i++)
            CanOutputs.Add(new CanOutput(i + 1, "canOutput" + (i + 1)));

        for (var i = 0; i < NumVirtualInputs; i++)
            VirtualInputs.Add(new VirtualInput(i + 1, "virtualInput" + (i + 1)));

        for (var i = 0; i < NumFlashers; i++)
            Flashers.Add(new Flasher(i + 1,  "flasher" + (i + 1)));

        for (var i = 0; i < NumCounters; i++)
            Counters.Add(new Counter(i  + 1, "counter" + (i + 1)));

        for (var i = 0; i < NumConditions; i++)
            Conditions.Add(new Condition(i + 1, "condition" + (i + 1)));

        for (var i = 0; i < NumTimers; i++)
            Timers.Add(new TimerFunction(i + 1, "timer" + (i + 1)));

        for (var i = 0; i < NumMath; i++)
            Maths.Add(new MathFunction(i + 1, "math" + (i + 1)));
        for (var i = 0; i < NumCanMessages; i++)
            CanMessages.Add(new CanMessage(i + 1, "canMessage" + (i + 1)));
        Ignition = new Ignition("ignition");
        ComfortBlink = new ComfortBlink("Comfort blink");

        InitStatusSigs();
    }

    protected virtual void InitStatusSigs()
    {
        StatusSigs = new Dictionary<int, List<(DbcSignal Signal, Action<double> SetValue)>>();

        var cyclicIndex = CyclicRxOffset;
        
        // Message 0 (BaseId + 2): Analog inputs 0-3 millivolts
        StatusSigs[cyclicIndex] = new List<(DbcSignal, Action<double>)>();
        for (var i = 0; i < 4 && i < NumAnalogInputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"AnalogInput{index + 1}.Millivolts", StartBit = index * 16, Length = 16, Unit = "mV"},
                val => AnalogInputs[index].Millivolts = val
            ));
        }

        cyclicIndex++;

        // Message 1 (BaseId + 3): Analog input 5 millivolts + board temperature (whole °C at bit 48,
        // from the MCU's internal sensor — msg.cpp TxMsg1 / DBC BoardTemp).
        StatusSigs[cyclicIndex] =
        [
            (new DbcSignal { Name = "AnalogInput5.Millivolts", StartBit = 0, Length = 16, Unit = "mV"},
                val => AnalogInputs[4].Millivolts = val),
            // firmware 5.6: seconds until auto-sleep (255 = not counting) and what keeps it awake (SleepInfo bits)
            (new DbcSignal { Name = "SleepCountdown", StartBit = 16, Length = 8, Unit = "s" },
                val => SleepCountdownRaw = (int)val),
            (new DbcSignal { Name = "SleepBlockers", StartBit = 24, Length = 8 },
                val => SleepBlockersRaw = (int)val),
            (new DbcSignal { Name = "BoardTemp", StartBit = 48, Length = 16, Unit = "°C" },
                val => BoardTemp = val)
        ];
        cyclicIndex++;

        // Message 2 (BaseId + 4): Rotary switches, flashers, digital I/O, heartbeat
        StatusSigs[cyclicIndex] = [];

        // Rotary switch positions (4-bit each)
        for (var i = 0; i < NumAnalogInputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"RotarySwitch{index + 1}.Pos", StartBit = index * 4, Length = 4 },
                val => AnalogInputs[index].Rotary.Pos = (short)val
            ));
        }
        
        // Flashers (1-bit each starting at bit 24)
        for (var i = 0; i < NumFlashers; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Flasher{index + 1}.State", StartBit = 24 + index, Length = 1 },
                val => Flashers[index].Value = val != 0
            ));
        }

        // Timers 1-4 (1-bit each, upper nibble of byte 3: bits 28-31), firmware >= 5.5.107
        for (var i = 0; i < (Family == FwFamily.Upstream ? 0 : NumTimers) && i < 4; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Timer{index + 1}.State", StartBit = 28 + index, Length = 1 },
                val => Timers[index].Value = val != 0 && Timers[index].Enabled
            ));
        }

        // Digital inputs (1-bit each starting at bit 32)
        for (var i = 0; i < NumDigitalInputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"DigitalInput{index + 1}.State", StartBit = 32 + index, Length = 1 },
                val => DigitalInputs[index].State = val != 0
            ));
        }

        // Analog inputs digital mode (1-bit each starting at bit 40)
        for (var i = 0; i < NumAnalogInputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"AnalogInput{index + 1}.DigitalMode", StartBit = 40 + index, Length = 1 },
                val => AnalogInputs[index].Switch.State = val != 0
            ));
        }

        // Digital outputs (1-bit each starting at bit 48)
        for (var i = 0; i < NumDigitalOutputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"DigitalOutput{index + 1}.State", StartBit = 48 + index, Length = 1 },
                val => DigitalOutputs[index].State = val != 0
            ));
        }

        // Heartbeat (8-bit at bit 56)
        StatusSigs[cyclicIndex].Add((
            new DbcSignal { Name = "Heartbeat", StartBit = 56, Length = 8 },
            val => Heartbeat = (int)val
        ));
        
        cyclicIndex++;

        // Message 3 (BaseId + 5): CAN inputs & virtual inputs
        StatusSigs[cyclicIndex] = [];
        for (var i = 0; i < NumCanInputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"CanInput{index + 1}", StartBit = i, Length = 1 },
                val => CanInputs[index].Output = val != 0
            ));
        }
        for (var i = 0; i < NumVirtualInputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"VirtualInput{index + 1}", StartBit = 32 + i, Length = 1 },
                val => VirtualInputs[index].Value = val != 0
            ));
        }
        
        cyclicIndex++;

        // Message 4 (BaseId + 6): Counters & conditions
        StatusSigs[cyclicIndex] = [];
        for (var i = 0; i < NumCounters; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Counter{index + 1}", StartBit = i * 8, Length = 8 },
                val => Counters[index].Value = (int)val
            ));
        }
        for (var i = 0; i < NumConditions; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Condition{index + 1}", StartBit = 32 + i, Length = 1 },
                val => Conditions[index].Value = (int)val
            ));
        }
        cyclicIndex++;

        // Messages 5-8 (BaseId + 7 to BaseId + 10): CAN input values (2 per message)
        for (var msg = cyclicIndex; msg <= 10; msg++)
        {
            StatusSigs[msg] = [];
            for (var i = 0; i < 2; i++)
            {
                var index = (msg - cyclicIndex) * 2 + i;
                if (index < NumCanInputs)
                {
                    // Raw signed integer on the wire → scale by the input's factor/offset so the live
                    // Value is what the firmware compares against the Operand (dingoConfig #59).
                    StatusSigs[msg].Add((
                        new DbcSignal { Name = $"CanInput{index + 1}.Value", StartBit = i * 32, Length = 32, IsSigned = true },
                        val => { var c = CanInputs[index]; c.Value = val * c.Factor + c.Offset; }
                    ));
                }
            }
        }

        // Message 9 (BaseId + 11): Digital output duty cycle — 1 byte per output, 0-100 %
        // (mirrors the PDM's Msg 23). Only sent when a DO has PWM enabled.
        StatusSigs[11] = [];
        for (var i = 0; i < NumDigitalOutputs; i++)
        {
            var index = i;
            StatusSigs[11].Add((
                new DbcSignal { Name = $"DigitalOutput{index + 1}.DutyCycle", StartBit = index * 8, Length = 8, Unit = "%" },
                val => DigitalOutputs[index].CurrentDutyCycle = val
            ));
        }

        MaxCyclicId = 11; // last frame = BaseId+11 (firmware NUM_TX_MSGS=10 → offsets +2..+11)
    }
    
    private void InitVarMap()
    {
        VarMap = [];
        
        var index = 0;

        VarMap.Add(new DeviceVariable
        {
            GetName = () => "None",
            OwnerKind = "sys", OwnerNumber = 0,
            PropertyName = "Value",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => "Always On",
            OwnerKind = "sys", OwnerNumber = 1,
            PropertyName = "Value",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => "State",
            OwnerKind = "sys", OwnerNumber = 2,
            PropertyName = "State",
            DataType = "int",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        if (NumDigitalInputs > 0)
        {
            for (var i = 0; i < NumDigitalInputs; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName  = () => DigitalInputs[num].Name,
                    OwnerKind = "input", OwnerNumber = num + 1,
                    PropertyName = "State",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }
        
        if (NumDigitalOutputs > 0)
        {
            for (var i = 0; i < NumDigitalOutputs; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName  = () => DigitalOutputs[num].Name,
                    OwnerKind = "digitaloutput", OwnerNumber = num + 1,
                    PropertyName = "State",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }
        
        if (NumAnalogInputs > 0)
        {
            for (var i = 0; i < NumAnalogInputs; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName  = () => AnalogInputs[num].Name,
                    OwnerKind = "analoginput", OwnerNumber = num + 1,
                    PropertyName = "Raw ADC",
                    DataType = "float",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName  = () => AnalogInputs[num].Name,
                    OwnerKind = "analoginput", OwnerNumber = num + 1,
                    PropertyName = "Millivolts",
                    DataType = "float",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName  = () => AnalogInputs[num].Name,
                    OwnerKind = "analoginput", OwnerNumber = num + 1,
                    PropertyName = "Rotary Position",
                    DataType = "int",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName  = () => AnalogInputs[num].Name,
                    OwnerKind = "analoginput", OwnerNumber = num + 1,
                    PropertyName = "Switch Value",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                if (Family == FwFamily.Fork) VarMap.Add(new DeviceVariable   // upstream has 4 per analog input
                {
                    GetName  = () => AnalogInputs[num].Name,
                    OwnerKind = "analoginput", OwnerNumber = num + 1,
                    PropertyName = "Scaled Value",
                    DataType = "float",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }

        if (NumCanInputs > 0)
        {
            for (var i = 0; i < NumCanInputs; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => CanInputs[num].Name,
                    OwnerKind = "caninput", OwnerNumber = num + 1,
                    PropertyName = "State",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => CanInputs[num].Name,
                    OwnerKind = "caninput", OwnerNumber = num + 1,
                    PropertyName = "Value",
                    DataType = "float",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }
        
        if (NumVirtualInputs > 0)
        {
            for(var i=0; i< NumVirtualInputs; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => VirtualInputs[num].Name,
                    OwnerKind = "virtualinput", OwnerNumber = num + 1,
                    PropertyName = "State",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }  
        }
        
        if (NumFlashers > 0)
        {
            for (var i = 0; i < NumFlashers; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => Flashers[num].Name,
                    OwnerKind = "flasher", OwnerNumber = num + 1,
                    PropertyName = "State",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }
        
        if (NumConditions > 0)
        {
            for (var i = 0; i < NumConditions; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => Conditions[num].Name,
                    OwnerKind = "condition", OwnerNumber = num + 1,
                    PropertyName = "Value",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }
        
        if (NumCounters > 0)
        {
            for (var i = 0; i < NumCounters; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => Counters[num].Name,
                    OwnerKind = "counter", OwnerNumber = num + 1,
                    PropertyName = "Value",
                    DataType = "int",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }

        if (Family == FwFamily.Upstream) { AddUpstreamTail(ref index); return; }

        // Timers are appended last, mirroring the firmware var map (no Lua / tables on a CANBoard).
        for (var i = 0; i < NumTimers; i++)
        {
            var num = i;
            VarMap.Add(new DeviceVariable
            {
                GetName = () => Timers[num].Name,
                OwnerKind = "timer", OwnerNumber = num + 1,
                PropertyName = "State",
                DataType = "bool",
                VariableIndex = index++,
                SingleVariable = false
            });
        }

        // Digital-input PWM measurement (duty %, Hz), appended after the timers like the firmware.
        for (var i = 0; i < NumDigitalInputs; i++)
        {
            var num = i;
            VarMap.Add(new DeviceVariable
            {
                GetName = () => DigitalInputs[num].Name, OwnerKind = "input", OwnerNumber = num + 1,
                PropertyName = "PWM Duty", DataType = "float", VariableIndex = index++, SingleVariable = false
            });
            VarMap.Add(new DeviceVariable
            {
                GetName = () => DigitalInputs[num].Name, OwnerKind = "input", OwnerNumber = num + 1,
                PropertyName = "PWM Frequency", DataType = "float", VariableIndex = index++, SingleVariable = false
            });
        }

        // Firmware 5.6, appended last like the firmware: Math blocks, CAN Message blocks, then the ignition roles
        var since56 = MathFunction.Since;
        for (var i = 0; i < NumMath; i++)
        {
            var num = i;
            VarMap.Add(new DeviceVariable { GetName = () => Maths[num].Name, OwnerKind = "math", OwnerNumber = num + 1,
                PropertyName = "Value", DataType = "float", VariableIndex = index++, SingleVariable = false, MinFirmware = since56 });
        }
        for (var i = 0; i < NumCanMessages; i++)
        {
            var num = i;
            VarMap.Add(new DeviceVariable { GetName = () => CanMessages[num].Name, OwnerKind = "canmsg", OwnerNumber = num + 1,
                PropertyName = "Sending", DataType = "bool", VariableIndex = index++, SingleVariable = false, MinFirmware = since56 });
        }
        foreach (var role in new[] { "Ignition", "Accessory", "Cranking", "Running", "Ready", "Dash", "Link OK" })
            VarMap.Add(new DeviceVariable { GetName = () => "Ignition", OwnerKind = "ignition", OwnerNumber = 1,
                PropertyName = role, DataType = "bool", VariableIndex = index++, SingleVariable = false, MinFirmware = since56 });
        // firmware 5.6.1: comfort blink, "indicator on" per side
        foreach (var side in new[] { "Left", "Right" })
            VarMap.Add(new DeviceVariable { GetName = () => ComfortBlink.Name, OwnerKind = "comfortblink", OwnerNumber = 1,
                PropertyName = side, DataType = "bool", VariableIndex = index++, SingleVariable = false, MinFirmware = Functions.ComfortBlink.Since });
    }

    // Upstream dingoFW var map: same order as the fork's up to here (InitVarMap in core/device.cpp), then the timers
    // LAST (if the module has the 0x1A00 timer block), no Lua slots.
    // FEATURE BRANCHES: append your block's entries below the timers, in the canonical upstream order, each guarded
    // by FwFamily.HasBlock(this, <your param base>, false) so a module without the block keeps its indices.
    private void AddUpstreamTail(ref int index)
    {
        if (FwFamily.HasBlock(this, TimerFunction.UpstreamBaseIndex, false /* stock upstream CANBoard: NUM_TIMERS 0 */))
            for (var i = 0; i < NumTimers; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable { GetName = () => Timers[num].Name, OwnerKind = "timer", OwnerNumber = num + 1,
                    PropertyName = "State", DataType = "bool", VariableIndex = index++, SingleVariable = false });
            }
        // feat/analog-linear-scaling: one scaled value per analog input (0x2200 sub 10; the block itself always exists)
        if (ParamSet.Contains(AnalogInput.BaseIndex, 10))
            for (var i = 0; i < NumAnalogInputs; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable { GetName = () => AnalogInputs[num].Name, OwnerKind = "analoginput", OwnerNumber = num + 1,
                    PropertyName = "Scaled Value", DataType = "float", VariableIndex = index++, SingleVariable = false });
            }
        // feat/math-block: one value per math block
        if (FwFamily.HasBlock(this, MathFunction.BaseIndex, false))
            for (var i = 0; i < NumMath; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable { GetName = () => Maths[num].Name, OwnerKind = "math", OwnerNumber = num + 1,
                    PropertyName = "Value", DataType = "float", VariableIndex = index++, SingleVariable = false });
            }
    }

    private void InitParams()
    {
        var allParams = new List<DeviceParameter>();
        var subIndex = 0;
        if (Family == FwFamily.Upstream) allParams.AddRange(UpstreamDeviceParams());
        else allParams.AddRange(
        [
            new DeviceParameter
            {
                ParentName = Name, Name = "device.baseId", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => BaseId, SetValue = val => BaseId = (int)val,
                ValueType = BaseId.GetType(),
                DefaultValue = DefaultId
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.canSpeed", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => BitRate, SetValue = val => BitRate = (CanBitRate)val,
                ValueType = BitRate.GetType(),
                DefaultValue = CanBitRate.BitRate500K
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.sleepEnabled", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => SleepEnabled, SetValue = val => SleepEnabled = (bool)val,
                ValueType = SleepEnabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.canFiltersEnabled", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => CanFiltersEnabled, SetValue = val => CanFiltersEnabled = (bool)val,
                ValueType = CanFiltersEnabled.GetType(),
                DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.connectUsbToCan", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => ConnectUsbToCan, SetValue = val => ConnectUsbToCan = (bool)val,
                ValueType = ConnectUsbToCan.GetType(),
                DefaultValue = true
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.sleepTimeoutMs", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => SleepTimeoutMs, SetValue = val => SleepTimeoutMs = (int)val,
                ValueType = SleepTimeoutMs.GetType(),
                DefaultValue = 30000
            },
            // sub 6-8 (digital-input sleep trigger of firmware 5.5.106) are retired; 9 onwards:
            new DeviceParameter
            {
                ParentName = Name, Name = "device.sleepIgnoreAlwaysOn", Index = BaseIndex, SubIndex = 9,
                GetValue = () => SleepIgnoreAlwaysOn, SetValue = val => SleepIgnoreAlwaysOn = (bool)val,
                ValueType = SleepIgnoreAlwaysOn.GetType(), DefaultValue = true
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.forceSleepInput", Index = BaseIndex, SubIndex = 10,
                GetValue = () => ForceSleepInput, SetValue = val => ForceSleepInput = (int)val,
                ValueType = ForceSleepInput.GetType(), DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.muteTxInput", Index = BaseIndex, SubIndex = 11,
                GetValue = () => MuteTxInput, SetValue = val => MuteTxInput = (int)val,
                ValueType = MuteTxInput.GetType(), DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.wakeDigInputMask", Index = BaseIndex, SubIndex = 12,
                GetValue = () => WakeDigInputMask, SetValue = val => WakeDigInputMask = (int)val,
                ValueType = WakeDigInputMask.GetType(), DefaultValue = (1 << NumDigitalInputs) - 1
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.wakeOnCan", Index = BaseIndex, SubIndex = 13,
                GetValue = () => WakeOnCan, SetValue = val => WakeOnCan = (bool)val,
                ValueType = WakeOnCan.GetType(), DefaultValue = true
            }
        ]);
        WakeDigInputMask &= (1 << NumDigitalInputs) - 1;

        foreach (var input in DigitalInputs) allParams.AddRange(input.Params);
        foreach (var canInput in CanInputs) allParams.AddRange(Family == FwFamily.Upstream ? canInput.UpstreamParams : canInput.Params);
        foreach (var virtualInput in VirtualInputs) allParams.AddRange(virtualInput.Params);
        foreach (var condition in Conditions) allParams.AddRange(Family == FwFamily.Upstream ? condition.UpstreamParams : condition.Params);
        foreach (var counter in Counters) allParams.AddRange(counter.Params);
        foreach (var flasher in Flashers) allParams.AddRange(flasher.Params);
        foreach (var timer in Timers) allParams.AddRange(Family == FwFamily.Upstream ? timer.UpstreamParams : timer.Params);
        foreach (var m in Maths) allParams.AddRange(m.Params);
        foreach (var m in CanMessages) allParams.AddRange(m.Params);
        allParams.AddRange(Ignition.Params);
        allParams.AddRange(ComfortBlink.Params);
        foreach (var canOutput in CanOutputs) allParams.AddRange(canOutput.Params);
        foreach (var digitalOutput in DigitalOutputs) allParams.AddRange(digitalOutput.Params);
        foreach (var analogInput in AnalogInputs) allParams.AddRange(Family == FwFamily.Upstream ? analogInput.UpstreamParams : analogInput.Params);
        
        Params = allParams;

        _paramProtocol = new ParamProtocol(this, Params)
        {
            NotifySuccess = msg => SuccessNotification?.Invoke(msg),
            NotifyError = msg => ErrorNotification?.Invoke(msg),
            WriteAllFailed = () => { var h = WriteAllIncomplete; h?.Invoke(); return h != null; },
            ParamSetLearned = InitVarMap   // upstream: which blocks the module has decides the var map tail
        };
    }

    // Upstream dingoFW device params (0x0000 sub 0-8). The wake bools map onto the fork's wake mask / wake-on-CAN
    // and the mute / force-sleep inputs keep their names, so the same UI drives both families.
    private List<DeviceParameter> UpstreamDeviceParams() =>
    [
        new() { ParentName = Name, Name = "device.baseId", Index = BaseIndex, SubIndex = 0,
            GetValue = () => BaseId, SetValue = val => BaseId = (int)val, ValueType = typeof(int), DefaultValue = DefaultId },
        new() { ParentName = Name, Name = "device.canSpeed", Index = BaseIndex, SubIndex = 1,
            GetValue = () => BitRate, SetValue = val => BitRate = (CanBitRate)val, ValueType = typeof(CanBitRate), DefaultValue = CanBitRate.BitRate500K },
        new() { ParentName = Name, Name = "device.sleepEnabled", Index = BaseIndex, SubIndex = 2,
            GetValue = () => SleepEnabled, SetValue = val => SleepEnabled = (bool)val, ValueType = typeof(bool), DefaultValue = false },
        new() { ParentName = Name, Name = "device.canFiltersEnabled", Index = BaseIndex, SubIndex = 3,
            GetValue = () => CanFiltersEnabled, SetValue = val => CanFiltersEnabled = (bool)val, ValueType = typeof(bool), DefaultValue = false },
        new() { ParentName = Name, Name = "device.disableDigInWake", Index = BaseIndex, SubIndex = 4,
            GetValue = () => WakeDigInputMask == 0, SetValue = val => WakeDigInputMask = (bool)val ? 0 : (1 << NumDigitalInputs) - 1, ValueType = typeof(bool), DefaultValue = false },
        new() { ParentName = Name, Name = "device.disableCanWake", Index = BaseIndex, SubIndex = 5,
            GetValue = () => !WakeOnCan, SetValue = val => WakeOnCan = !(bool)val, ValueType = typeof(bool), DefaultValue = false },
        new() { ParentName = Name, Name = "device.connectUsbToCan", Index = BaseIndex, SubIndex = 6,
            GetValue = () => ConnectUsbToCan, SetValue = val => ConnectUsbToCan = (bool)val, ValueType = typeof(bool), DefaultValue = true },
        new() { ParentName = Name, Name = "device.muteTxInput", Index = BaseIndex, SubIndex = 7,
            GetValue = () => MuteTxInput, SetValue = val => MuteTxInput = (int)val, ValueType = typeof(int), DefaultValue = 0 },
        new() { ParentName = Name, Name = "device.forceSleepInput", Index = BaseIndex, SubIndex = 8,
            GetValue = () => ForceSleepInput, SetValue = val => ForceSleepInput = (int)val, ValueType = typeof(int), DefaultValue = 0 },
    ];

    private void Clear()
    {
        foreach (var input in AnalogInputs)
        {
            input.Switch.State = false;
            input.Millivolts = 0.0;
            input.Rotary.Pos = 0;
        }

        foreach (var input in DigitalInputs)
            input.State = false;

        foreach (var output in DigitalOutputs)
            output.State = false;

        Logger.LogDebug("CANBoard {Name} cleared", Name);
    }
    
    /// <remarks>
    /// Returns true only on Connected false to true transition
    /// </remarks>
    public bool UpdateIsConnected()
    {
        var lastConnected = Connected;
        var timeSpan = DateTime.Now - LastRxTime;
        // ponytail: heartbeat window — 3000ms tolerates a couple of dropped status broadcasts so
        // the "live" badge doesn't strobe on sub-second feed gaps. See PdmDevice.UpdateIsConnected.
        Connected = timeSpan.TotalMilliseconds < 3000 || RxFilterWindow.Excuses(BaseId, lastConnected);   // quiet only because our RX filter hides it

        return Connected & !lastConnected;
    }

    public bool InIdRange(int id)
    {
        // + the ignition state frame (firmware 5.6), the first id after the module's own range
        return (id >= BaseId) && (id <= MaxCyclicId + BaseId || id == BaseId + Functions.Ignition.StateOffsetFor(Type));
    }

    public void Read(int id, byte[] data, 
                     ref ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> queue, 
                     List<DeviceCanFrame> outgoing)
    {
        var offset = id - BaseId;

        // Ignition state frame (firmware 5.6), sent by a main module: ['I', state, flags]
        if (Family == FwFamily.Fork && offset == Functions.Ignition.StateOffsetFor(Type) && data.Length >= 3 && data[0] == 'I')
        {
            Ignition.State = (Functions.IgnitionState)data[1];
            Ignition.Dash = (data[2] & 0x10) != 0;
            Ignition.LastStateFrame = DateTime.UtcNow;
            return;
        }

        // Use dictionary lookup for status messages
        if (StatusSigs.TryGetValue(offset, out var signals))
        {
            foreach (var (signal, setValue) in signals)
            {
                var value = ExtractSignal(data, signal);
                setValue(value);
            }
        }
        // Handle param, version and info/warn/error messages
        else
        {
            if (id == BaseId + ConfigRxOffset)
            {
                _paramProtocol.HandleMessage(BaseId,BaseId + ConfigTxOffset, Name, data, queue, outgoing);
                
                ReadInfoWarnErrorMessage(data);
                
                if (((MessageCommand)data[0]) == MessageCommand.Version)
                    ReadVersion(BaseId, Name, data, queue);
            }
        }

        // A frame at BaseId+ConfigTxOffset is our OWN config request echoed back by the bus
        // (self-reception), NOT proof the module is present. Only frames the device actually
        // originates count toward the liveness heartbeat, so writing to an absent module can't
        // make it momentarily look connected and defeat the live-write guards.
        if (offset != ConfigTxOffset)
            LastRxTime = DateTime.Now;
    }

    public IEnumerable<(int MessageId, DbcSignal Signal)> GetStatusSigs()
    {
        foreach (var kvp in StatusSigs)
        {
            var messageId = BaseId + kvp.Key;
            foreach (var (signal, _) in kvp.Value)
            {
                // Create a copy with the ID populated
                var signalCopy = new DbcSignal
                {
                    Name = signal.Name,
                    Id = messageId,
                    StartBit = signal.StartBit,
                    Length = signal.Length,
                    ByteOrder = signal.ByteOrder,
                    IsSigned = signal.IsSigned,
                    IsFloat = signal.IsFloat,
                    Factor = signal.Factor,
                    Offset = signal.Offset,
                    Unit = signal.Unit,
                    Min = signal.Min,
                    Max = signal.Max
                };
                yield return (messageId, signalCopy);
            }
        }
    }
    
    protected void ReadInfoWarnErrorMessage(byte[] data)
    {
        //Response is lowercase version of set/get prefix
        var type = (MessageType)char.ToUpper(Convert.ToChar(data[0]));
        var src = (MessageSrc)data[1];

        switch (type)
        {
            case MessageType.Info:
                Logger.LogInformation("{Name} ID: {BaseId}, Src: {MessageSrc} {I} {I1} {I2}", 
                    Name, BaseId, src, (data[3] << 8) + data[2], (data[5] << 8) + data[4], (data[7] << 8) + data[6]);
                break;
            case MessageType.Warning:
                Logger.LogWarning("{Name} ID: {BaseId}, Src: {MessageSrc} {I} {I1} {I2}", 
                    Name, BaseId, src, (data[3] << 8) + data[2], (data[5] << 8) + data[4], (data[7] << 8) + data[6]);
                break;
            case MessageType.Error:
                Logger.LogError("{Name} ID: {BaseId}, Src: {MessageSrc} {I} {I1} {I2}", 
                    Name, BaseId, src, (data[3] << 8) + data[2], (data[5] << 8) + data[4], (data[7] << 8) + data[6]);
                break;
        }
    }

    public List<DeviceCanFrame> GetReadMsgs(bool allParams)
    {
        // Upstream: a full ReadAll is how the app learns the module's param list (a modified-only read can't tell it)
        if (Family == FwFamily.Upstream && !ParamSet.FromModule) allParams = true;
        var cmd = allParams ? MessageCommand.ReadAll : MessageCommand.ReadAllModified;
        var name = allParams ? "ReadAll" : "ReadAllModified";
        
        List<DeviceCanFrame>  msgs =
        [
            GetVersionMsg(),
            new()
            {
                DeviceBaseId = BaseId,
                SendOnly = true,
                Frame = new CanFrame(
                    Id: BaseId + ConfigTxOffset,
                    Len: 8,
                    Payload: [Convert.ToByte(cmd), 0, 0, 0, 0, 0, 0, 0]),
                Name = name
            }
        ];

		return msgs;
    }

    public List<DeviceCanFrame> GetWriteMsgs(bool allParams)
    {
        // Upstream: always the full WriteAll. A modified-only one resets every param not sent to the FIRMWARE's
        // default, and the full one is checked by count + CRC and answered with the list of params it missed.
        if (Family == FwFamily.Upstream) allParams = true;
        var cmd = allParams ? MessageCommand.WriteAll : MessageCommand.WriteAllModified;
        var name = allParams ? "WriteAll" : "WriteAllModified";
        
        List<DeviceCanFrame> msgs =
        [
            new()
            {
                DeviceBaseId = BaseId,
                Frame = new CanFrame
                (
                    Id: BaseId + ConfigTxOffset,
                    Len: 8,
                    Payload: [Convert.ToByte(cmd), 0, 0, 0, 0, 0, 0, 0]
                ),
                Name = name
            }
        ];

        return msgs;
    }
    
    public DeviceCanFrame GetCheckMsg()
    {
        return new DeviceCanFrame
        {
            DeviceBaseId = BaseId,
            SendOnly = true,
            Frame = new CanFrame
            (
                Id: BaseId + ConfigTxOffset,
                Len: 8,
                Payload: [Convert.ToByte(MessageCommand.CheckCrc), 0, 0, 0, 0, 0, 0, 0]
            ),
            Name = "Check"
        };
    }
    
    public List<DeviceCanFrame> GetModifyMsgs(int newId)
    {
        List<DeviceParameter> modifyParams = [];
        
        //Copy params:
        //ID: 0x0000, Subindex: 0, Base ID
        var baseIdParam = Params.First(p => p is { Index: 0x0000, SubIndex: 0});
        baseIdParam.SetValue(newId);
        modifyParams.Add(baseIdParam);
        
        List<DeviceCanFrame> msgs = [];

        foreach (var parameter in modifyParams)
        {
            msgs.Add(new DeviceCanFrame
            {
                SendOnly = true,
                DeviceBaseId = newId,
                Frame = ParamCodec.ToFrame(MessageCommand.Write, parameter, BaseId),
                Name = $"Modify {parameter.Index}:{parameter.SubIndex}"
            });
        }
        
        return msgs;
    }
    
    public DeviceCanFrame GetBurnMsg()
    {
        return new DeviceCanFrame
        {
            DeviceBaseId = BaseId,
            Frame = new CanFrame
            (
                Id: BaseId + ConfigTxOffset,
                Len: 8,
                Payload: [Convert.ToByte(MessageCommand.BurnParams), 1, 3, 8, 0, 0, 0, 0]
            ),
            Name = "Burn"
        };
    }

    public DeviceCanFrame? GetSleepMsg()
    {
        return null;
    }
    
    public DeviceCanFrame GetVersionMsg()
    {
        return new DeviceCanFrame
        {
            DeviceBaseId = BaseId,
            Frame = new CanFrame
            (
                Id: BaseId + ConfigTxOffset,
                Len: 8,
                Payload: [Convert.ToByte(MessageCommand.Version), 0, 0, 0, 0, 0, 0, 0]
            ),
            Name = "Version"
        };
    }
    
    public DeviceCanFrame? GetWakeupMsg()
    {
        return null;
    }

    public DeviceCanFrame? GetBootloaderMsg(bool canUpdate = false)
    {
        // The CANBoard now has the OpenBLT CAN bootloader: MsgCmd::Bootloader (33) with the
        // "BOOTL" signature, sent to BaseId+1 (config RX), makes the app enter it. Same frame
        // shape as the PDM (see PdmDevice.GetBootloaderMsg). The CANBoard has no USB-DFU, so it
        // always enters OpenBLT-CAN and ignores byte 6; we still set it for a uniform frame.
        return new DeviceCanFrame
        {
            SendOnly = true,
            DeviceBaseId = BaseId,
            Frame = new CanFrame
            (
                Id: BaseId + ConfigTxOffset,
                Len: 8,
                Payload: [
                    Convert.ToByte(MessageCommand.Bootloader), (byte)'B', (byte)'O', (byte)'O', (byte)'T', (byte)'L',
                    (byte)(canUpdate ? 1 : 0), 0
                ]
            ),
            Name = "Bootloader"
        };
    }

    public List<CanFrame> GetCyclicMsgs()
    {
        return [];
    }
    
    private void ReadVersion(int baseId, string name, byte[] data,
        ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> queue)
    {
        if (data.Length != 8) return;

        var version = $"v{data[4]}.{data[5]}.{(data[6] << 8) + (data[7])}";

        if (data[4] != 0 && !CheckVersion(data[4], data[5], (data[6] << 8) + (data[7])))
        {
            Logger.LogError("{Name} ID: {BaseId}, Firmware needs to be updated. V{MinMajorVersion}.{MinMinorVersion}.{MinBuildVersion} or greater",
                name, baseId, MinMajorVersion, MinMinorVersion, MinBuildVersion);
        }
        
        (int BaseId, int, int) key = (baseId, 0, 0); //Version request message index =0, subindex = 0
        if (queue.TryGetValue(key, out var canFrame))
        {
            canFrame.TimeSentTimer?.Dispose();
            queue.TryRemove(key, out _);
        }

        Logger.LogInformation("{Name} FW version received: {Version}", name, version);

        var family = FwFamily.Of(data[4]);
        if (family != Family) { Family = family; ParamSet.Forget(); Rebuild(); }
        else if (VersionReceived && version != Version) ParamSet.Stale();   // reflashed: read its param list again
        Version = version;
        VersionReceived = true;
    }

    // The family changed: rebuild everything that has a per-family layout (values stay on the function objects).
    private void Rebuild()
    {
        InitStatusSigs();
        InitVarMap();
        InitParams();
        if (Logger is not null) _paramProtocol.SetLogger(Logger);
    }
    
    private bool CheckVersion(int major, int minor, int build)
    {
        if (major > MinMajorVersion)
            return true;

        if ((major == MinMajorVersion) && (minor > MinMinorVersion))
            return true;

        if ((major == MinMajorVersion) && (minor == MinMinorVersion) && (build >= MinBuildVersion))
            return true;

        return false;
    }
    
    // Collection accessors
    public IReadOnlyList<DigitalInput> GetDigitalInputs() => DigitalInputs.AsReadOnly();
    public IReadOnlyList<DigitalOutput> GetDigitalOutputs() => DigitalOutputs.AsReadOnly();
    public IReadOnlyCollection<AnalogInput> GetAnalogInputs() => AnalogInputs.AsReadOnly();
    public IReadOnlyList<CanInput> GetCanInputs() => CanInputs.AsReadOnly();
    public IReadOnlyList<CanOutput> GetCanOutputs() => CanOutputs.AsReadOnly();
    public IReadOnlyList<VirtualInput> GetVirtualInputs() => VirtualInputs.AsReadOnly();
    public IReadOnlyList<Flasher> GetFlashers() => Flashers.AsReadOnly();
    public IReadOnlyList<Counter> GetCounters() => Counters.AsReadOnly();
    public IReadOnlyList<Condition> GetConditions() => Conditions.AsReadOnly();
    public IReadOnlyList<TimerFunction> GetTimers() => Timers.AsReadOnly();

}