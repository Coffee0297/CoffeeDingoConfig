using System.Collections.Concurrent;
using System.Text.Json.Serialization;
using domain.Common;
using domain.Enums;
using domain.Enums.dingoPdm;
using domain.Devices.Functions;
using domain.Devices.Functions.Keypad;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging;
using static domain.Common.DbcSignalCodec;
// ReSharper disable MemberCanBePrivate.Global

namespace domain.Devices.dingoPdm;

public class PdmDevice : IDeviceConfigurable
{
    [JsonIgnore] protected ILogger<PdmDevice> Logger = null!;

    [JsonIgnore] protected int MinMajorVersion { get; private set; } = 5;
    [JsonIgnore] protected int MinMinorVersion { get; private set; } = 5;
    [JsonIgnore] protected int MinBuildVersion { get; private set; } = 100;

    [JsonIgnore] protected int NumDigitalInputs { get; private set; } = 2;
    [JsonIgnore] protected int NumOutputs { get; private set; } = 8;
    [JsonIgnore] protected int NumCanInputs { get; private set; } = 32;
    [JsonIgnore] protected int NumCanOutputs { get; private set; } = 32;
    [JsonIgnore] protected int NumVirtualInputs { get; private set; } = 16;
    [JsonIgnore] protected int NumFlashers { get; private set; } = 4;
    [JsonIgnore] protected int NumCounters { get; private set; } = 4;
    [JsonIgnore] protected int NumConditions { get; private set; } = 32;
    [JsonIgnore] protected int NumKeypads { get; private set; } = 2;
    [JsonIgnore] protected const int LuaOutputSlots = 32;  // matches firmware NUM_LUA_OUTPUTS

    [JsonIgnore] public bool CanSleep { get; } = true;
    [JsonIgnore] public bool CanBootloader { get; } = true;

    [JsonIgnore] public const int BaseIndex = 0x0000;
    [JsonPropertyName("pdmType")] public int PdmType { get; set; }
    [JsonIgnore] protected bool PdmTypeOk;
    [JsonIgnore] public bool ConfigMismatch { get; set; } = true;

    [JsonIgnore] public Guid Guid { get; }
    [JsonIgnore] public string Type { get; private set; } = "dingoPDM";
    [JsonIgnore] public string Icon { get; private set; } = string.Empty;
    [JsonIgnore] public int ConfigVersion { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("baseId")] public int BaseId { get; set; }
    [JsonIgnore] public static int DefaultId { get; set; } = 0x0DE;
    [JsonIgnore] public const int ConfigRxOffset = 0;
    [JsonIgnore] public const int ConfigTxOffset = 1;
    [JsonIgnore] public const int CyclicRxOffset = 2;
    [JsonIgnore] public int MaxCyclicId { get; private set; }

    [JsonIgnore] public List<DeviceVariable> VarMap { get; set; } = null!;

    // Lua read-back buffer (filled by LuaRead replies in Read()); 4 KB matches the
    // firmware's LUA_SCRIPT_MAX.
    [JsonIgnore] public byte[] LuaReadBuffer { get; } = new byte[4096];
    [JsonIgnore] public byte[] LuaErrBuffer { get; } = new byte[128];

    public DeviceCanFrame GetLuaReadMsg(int offset) => new()
    {
        DeviceBaseId = BaseId,
        SendOnly = true,
        Name = "LuaRead",
        Frame = new CanFrame(BaseId + ConfigTxOffset, 8,
            [(byte)MessageCommand.LuaRead, (byte)(offset >> 8), (byte)(offset & 0xFF), 0, 0, 0, 0, 0])
    };

    public DeviceCanFrame GetLuaErrMsg(int offset) => new()
    {
        DeviceBaseId = BaseId,
        SendOnly = true,
        Name = "LuaErr",
        Frame = new CanFrame(BaseId + ConfigTxOffset, 8,
            [(byte)MessageCommand.LuaErr, (byte)(offset >> 8), (byte)(offset & 0xFF), 0, 0, 0, 0, 0])
    };

    // On-device overload (trip) log read-back. Layout constants MUST match the firmware's
    // overload_log.h (OVL_SAMPLE_MS / OVL_PRE_S / OVL_POST_S / OVL_AMP_STEP).
    public const int OvlSampleMs = 40;
    public const int OvlPreSamples = 250;
    public const int OvlPostSamples = 75;
    public const int OvlTotalSamples = OvlPreSamples + OvlPostSamples;
    public const double OvlAmpStep = 0.5;

    // Reply latches, filled by Read() as the device answers (sentinels mean "not yet").
    [JsonIgnore] public int OvlCountRx { get; set; } = -1;
    [JsonIgnore] public int OvlHdrRxIdx { get; set; } = -1;
    [JsonIgnore] public int OvlHdrOut { get; set; }
    [JsonIgnore] public int OvlHdrState { get; set; }
    [JsonIgnore] public double OvlHdrPeak { get; set; }
    [JsonIgnore] public double OvlHdrLimit { get; set; }
    [JsonIgnore] public int OvlDataRxIdx { get; set; } = -1;
    [JsonIgnore] public int OvlDataRxOff { get; set; } = -1;
    [JsonIgnore] public byte[] OvlDataRxBytes { get; } = new byte[4];

    public DeviceCanFrame GetOvlCountMsg() => new()
    {
        DeviceBaseId = BaseId, SendOnly = true, Name = "OvlCount",
        Frame = new CanFrame(BaseId + ConfigTxOffset, 8,
            [(byte)MessageCommand.OvlCount, 0, 0, 0, 0, 0, 0, 0])
    };

    public DeviceCanFrame GetOvlHeaderMsg(int idx) => new()
    {
        DeviceBaseId = BaseId, SendOnly = true, Name = "OvlHeader",
        Frame = new CanFrame(BaseId + ConfigTxOffset, 8,
            [(byte)MessageCommand.OvlHeader, (byte)idx, 0, 0, 0, 0, 0, 0])
    };

    public DeviceCanFrame GetOvlDataMsg(int idx, int offset) => new()
    {
        DeviceBaseId = BaseId, SendOnly = true, Name = "OvlData",
        Frame = new CanFrame(BaseId + ConfigTxOffset, 8,
            [(byte)MessageCommand.OvlData, (byte)idx, (byte)(offset >> 8), (byte)(offset & 0xFF), 0, 0, 0, 0])
    };
    [JsonIgnore] public List<DeviceParameter> Params { get; set; } = null!;
    
    [JsonIgnore][Plotable(displayName:"DevState")] public DeviceState DeviceState { get; private set; }
    [JsonIgnore][Plotable(displayName:"TotalCurrent", unit:"A")] public double TotalCurrent { get; private set; }
    [JsonIgnore][Plotable(displayName:"BatteryVoltage", unit:"V")] public double BatteryVoltage { get; private set; }
    [JsonIgnore][Plotable(displayName:"Temperature", unit:"degC")] public double BoardTempC { get; private set; }
    [JsonIgnore] public string Version { get; private set; } = "v0.0.0";
    public event Action<string>? SuccessNotification;
    
    [JsonPropertyName("sleepEnabled")] public bool SleepEnabled { get; set; }
    [JsonPropertyName("sleepTimeoutMs")] public int SleepTimeoutMs { get; set; } = 30000;
    [JsonPropertyName("sleepInputEnabled")] public bool SleepInputEnabled { get; set; }
    [JsonPropertyName("sleepInput")] public int SleepInput { get; set; }
    [JsonPropertyName("sleepInputActiveHigh")] public bool SleepInputActiveHigh { get; set; }
    [JsonPropertyName("sleepIgnoreAlwaysOn")] public bool SleepIgnoreAlwaysOn { get; set; } = true;
    [JsonPropertyName("filtersEnabled")] public bool CanFiltersEnabled { get; set; }
    [JsonPropertyName("connectUsbToCan")] public bool ConnectUsbToCan { get; set; } = true;
    [JsonPropertyName("bitrate")] public CanBitRate BitRate { get; set; } = CanBitRate.BitRate500K;
    [JsonIgnore] public TimeSpan CyclicGap { get; } =  TimeSpan.FromSeconds(0);
    [JsonIgnore] public TimeSpan CyclicPause { get; } = TimeSpan.FromMilliseconds(0);
    
    [JsonPropertyName("inputs")] public List<DigitalInput> Inputs { get; init; } = [];
    [JsonPropertyName("outputs")] public List<Output> Outputs { get; init; } = [];
    [JsonPropertyName("canInputs")] public List<CanInput> CanInputs { get; init; } = [];
    [JsonPropertyName("canOutputs")] public List<CanOutput> CanOutputs { get; init; } = [];
    [JsonPropertyName("virtualInputs")] public List<VirtualInput> VirtualInputs { get; init; } = [];
    [JsonPropertyName("wipers")] public Wiper Wipers { get; protected set; } = null!;
    [JsonPropertyName("flashers")] public List<Flasher> Flashers { get; init; } = [];
    [JsonPropertyName("starterDisable")] public StarterDisable StarterDisable { get; protected set; } = null!;
    [JsonPropertyName("counters")] public List<Counter> Counters { get; init; } = [];
    [JsonPropertyName("conditions")] public List<Condition> Conditions { get; init; } = [];
    [JsonPropertyName("keypads")] public List<KeypadMaster> Keypads { get; init; } = [];
    
    [JsonIgnore] private DateTime LastRxTime { get; set; }

    [JsonIgnore] private Dictionary<int, List<(DbcSignal Signal, Action<double> SetValue)>> StatusSigs { get; set; } = null!;

    [JsonIgnore] private ParamProtocol _paramProtocol = null!;

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
    
    [JsonConstructor]
    public PdmDevice(string name, int baseId)
    {
        Name = name;
        BaseId = baseId;
        Guid = Guid.NewGuid();

        InitFunctions();
        InitVarMap();
        InitParams();
    }

    public void SetLogger(ILogger<PdmDevice> logger)
    {
        Logger = logger;
        _paramProtocol.SetLogger(logger);
    }

    public PdmDevice(PdmDeviceDefinition definition, string name, int id)
    {
        Name = name;
        BaseId = id;
        Guid = Guid.NewGuid();
        NumDigitalInputs = definition.NumDigitalInputs;
        NumOutputs = definition.NumOutputs;
        NumCanInputs = definition.NumCanInputs;
        NumCanOutputs = definition.NumCanOutputs;
        NumVirtualInputs = definition.NumVirtualInputs;
        NumFlashers = definition.NumFlashers;
        NumCounters = definition.NumCounters;
        NumConditions = definition.NumConditions;
        NumKeypads = definition.NumKeypads;
        InitFunctions();
        ApplyDefinition(definition);
    }

    public void ApplyDefinition(PdmDeviceDefinition definition)
    {
        PdmType = definition.PdmType;
        Type = definition.TypeName;
        Icon = definition.Icon;
        MinMajorVersion = definition.MinMajorVersion;
        MinMinorVersion = definition.MinMinorVersion;
        MinBuildVersion = definition.MinBuildVersion;
        NumDigitalInputs = Inputs.Count;
        NumOutputs = Outputs.Count;
        NumCanInputs = CanInputs.Count;
        NumCanOutputs = CanOutputs.Count;
        NumVirtualInputs = VirtualInputs.Count;
        NumFlashers = Flashers.Count;
        NumCounters = Counters.Count;
        NumConditions = Conditions.Count;
        NumKeypads = Keypads.Count;
        InitStatusSigs();
        InitVarMap();
        InitParams();
    }

    private void InitFunctions()
    {
        for (var i = 0; i < NumDigitalInputs; i++)
            Inputs.Add(new DigitalInput(i + 1, "digitalInput" + (i + 1)));

        for (var i = 0; i < NumOutputs; i++)
            Outputs.Add(new Output(i + 1, "output" + (i + 1)));

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
        
        StarterDisable = new StarterDisable("starterDisable", NumOutputs);

        Wipers = new Wiper("wiper");
        
        for (var i = 0; i < NumKeypads; i++)
            Keypads.Add(new KeypadMaster(i + 1, "keypad" + (i + 1)));

        InitStatusSigs();
    }

    private void InitStatusSigs()
    {
        StatusSigs = new Dictionary<int, List<(DbcSignal Signal, Action<double> SetValue)>>();

        var cyclicIndex = CyclicRxOffset;

        // Message 0: System status
        StatusSigs[cyclicIndex] = new List<(DbcSignal, Action<double>)>();
        for (var i = 0; i < NumDigitalInputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Input{index + 1}.State", StartBit = i, Length = 1 },
                val => Inputs[index].State = val != 0
            ));
        }
        StatusSigs[cyclicIndex].AddRange(new List<(DbcSignal, Action<double>)>
        {
            (new DbcSignal { Name = "DeviceState", StartBit = 8, Length = 4 },
                val => DeviceState = (DeviceState)val),
            (new DbcSignal { Name = "PdmType", StartBit = 12, Length = 4 },
                val => PdmTypeOk = PdmType == (int)val),
            (new DbcSignal { Name = "TotalCurrent", StartBit = 16, Length = 16, Factor = 1.0, Unit = "A" },
                val => TotalCurrent = val),
            (new DbcSignal { Name = "BatteryVoltage", StartBit = 32, Length = 16, Factor = 0.1, Unit = "V" },
                val => BatteryVoltage = val),
            (new DbcSignal { Name = "BoardTemp", StartBit = 48, Length = 16, Factor = 0.1, Unit = "°C" },
                val => BoardTempC = Math.Round(val, 1))
        });
        cyclicIndex++;

        // Message 1: Output currents 0-3
        StatusSigs[cyclicIndex] = [];
        for (var i = 0; i < 4 && i < NumOutputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Output{index + 1}.Current", StartBit = i * 16, Length = 16, Factor = 1.0, Unit = "A" },
                val => Outputs[index].Current = val
            ));
        }

        cyclicIndex++;

        // Message 2: Output currents 4-7
        StatusSigs[cyclicIndex] = [];
        for (var i = 4; i < NumOutputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Output{index + 1}.Current", StartBit = (i - 4) * 16, Length = 16, Factor = 1.0, Unit = "A" },
                val => Outputs[index].Current = val
            ));
        }

        cyclicIndex++;

        // Message 3: Output states, wiper, flashers
        StatusSigs[cyclicIndex] = [];
        for (var i = 0; i < NumOutputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Output{index + 1}.State", StartBit = i * 4, Length = 4 },
                val => Outputs[index].State = (OutState)val
            ));
        }
        StatusSigs[cyclicIndex].AddRange(new List<(DbcSignal, Action<double>)>
        {
            (new DbcSignal { Name = "WiperSlowState", StartBit = 32, Length = 1 },
                val => Wipers.SlowState = val != 0),
            (new DbcSignal { Name = "WiperFastState", StartBit = 33, Length = 1 },
                val => Wipers.FastState = val != 0),
            (new DbcSignal { Name = "WiperSpeed", StartBit = 40, Length = 4 },
                val => Wipers.Speed = (WiperSpeed)val),
            (new DbcSignal { Name = "WiperState", StartBit = 44, Length = 4 },
                val => Wipers.State = (WiperState)val)
        });
        for (var i = 0; i < NumFlashers; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Flasher{index + 1}", StartBit = 48 + i, Length = 1 },
                val => Flashers[index].Value = val != 0 && Flashers[index].Enabled
            ));
        }
        cyclicIndex++;

        // Message 4: Output reset counts
        StatusSigs[cyclicIndex] = [];
        for (var i = 0; i < NumOutputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Output{index + 1}.ResetCount", StartBit = i * 8, Length = 8 },
                val => Outputs[index].ResetCount = (int)val
            ));
        }

        cyclicIndex++;

        // Message 5: CAN inputs & virtual inputs
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

        // Message 6: Counters & conditions
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

        // Messages 7-22: CAN input values (2 per message)
        for (var msg = cyclicIndex; msg <= 22; msg++)
        {
            StatusSigs[msg] = [];
            for (var i = 0; i < 2; i++)
            {
                var index = (msg - cyclicIndex) * 2 + i;
                if (index < NumCanInputs)
                {
                    StatusSigs[msg].Add((
                        new DbcSignal { Name = $"CanInput{index + 1}.Value", StartBit = i * 32, Length = 32 },
                        val => CanInputs[index].Value = (int)val
                    ));
                }
            }
        }

        cyclicIndex++;

        // Message 23: Output duty cycles
        StatusSigs[cyclicIndex] = [];
        for (var i = 0; i < NumOutputs; i++)
        {
            var index = i;
            StatusSigs[cyclicIndex].Add((
                new DbcSignal { Name = $"Output{index + 1}.DutyCycle", StartBit = i * 8, Length = 8, Unit = "%" },
                val => Outputs[index].CurrentDutyCycle = val
            ));
        }

        MaxCyclicId = cyclicIndex;
    }

    private void InitVarMap()
    {
        VarMap = [];
        
        var index = 0;

        VarMap.Add(new DeviceVariable
        {
            GetName = () => "None",
            PropertyName = "Value",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => "Always On",
            PropertyName = "Value",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => "State",
            PropertyName = "Value",
            DataType = "int",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => "Temperature",
            PropertyName = "Value",
            DataType = "float",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName =  () => "Battery Voltage",
            PropertyName = "Value",
            DataType = "float",
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
                    GetName  = () => Inputs[num].Name,
                    PropertyName = "State",
                    DataType = "bool",
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
                    PropertyName = "State",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => CanInputs[num].Name,
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
                    PropertyName = "State",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }  
        }
        
        if (NumOutputs > 0)
        {
            for (var i = 0; i < NumOutputs; i++)
            {
                var num = i;
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => Outputs[num].Name,
                    PropertyName = "On",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => Outputs[num].Name,
                    PropertyName = "Current",
                    DataType = "float",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => Outputs[num].Name,
                    PropertyName = "Overcurrent",
                    DataType = "bool",
                    VariableIndex = index++,
                    SingleVariable = false
                });
                VarMap.Add(new DeviceVariable
                {
                    GetName = () => Outputs[num].Name,
                    PropertyName = "Fault",
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
                    PropertyName = "Value",
                    DataType = "int",
                    VariableIndex = index++,
                    SingleVariable = false
                });
            }
        }
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => Wipers.Name,
            PropertyName = "Slow Output",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => Wipers.Name,
            PropertyName = "Fast Output",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => Wipers.Name,
            PropertyName = "Park Output",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => Wipers.Name,
            PropertyName = "Inter Output",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => Wipers.Name,
            PropertyName = "Wash Output",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        VarMap.Add(new DeviceVariable
        {
            GetName = () => Wipers.Name,
            PropertyName = "Swipe Output",
            DataType = "bool",
            VariableIndex = index++,
            SingleVariable = true
        });
        
        if (NumKeypads > 0)
        {
            for (var i = 0; i < NumKeypads; i++)
            {
                var kp = i;
                for (var j = 0; j < KeypadMaster.MaxButtons; j++)
                {
                    var num = j;
                    VarMap.Add(new DeviceVariable
                    {
                        GetName = () => $"{Keypads[kp].Name} - {Keypads[kp].Buttons[num].Name}",
                        PropertyName = "State",
                        DataType = "bool",
                        VariableIndex = index++,
                        SingleVariable = false
                    });
                }
                
                for (var j = 0; j < KeypadMaster.MaxDials; j++)
                {
                    var num = j;
                    VarMap.Add(new DeviceVariable
                    {
                        GetName = () => $"{Keypads[kp].Name} - {Keypads[kp].Dials[num].Name}",
                        PropertyName = "Position",
                        DataType = "int",
                        VariableIndex = index++,
                        SingleVariable = false
                    });
                }
                
                for (var j = 0; j < KeypadMaster.MaxAnalogInputs; j++)
                {
                    var num = j;
                    VarMap.Add(new DeviceVariable
                    {
                        GetName = () => $"{Keypads[kp].Name} - analogIn{num}",
                        PropertyName = "Value",
                        DataType = "float",
                        VariableIndex = index++,
                        SingleVariable = false
                    });
                }
            }
        }

        // Lua output slots — written by setLuaOut(n, v) in the device's Lua program.
        // MUST be last and match the firmware's VAR_MAP layout (NUM_LUA_OUTPUTS). Adding
        // them here is what lets an output/virtual-input/CAN-output pick "Lua Out N" as its
        // driving input — i.e. be driven by Lua. (1-based name -> slot N-1.)
        for (var i = 0; i < LuaOutputSlots; i++)
        {
            var slot = i;
            VarMap.Add(new DeviceVariable
            {
                GetName = () => $"Lua Out {slot + 1}",
                PropertyName = "Value",
                DataType = "float",
                VariableIndex = index++,
                SingleVariable = true
            });
        }
    }

    private void InitParams()
    {
        var allParams = new List<DeviceParameter>();
        var subIndex = 0;
        allParams.AddRange(
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
            new DeviceParameter
            {
                ParentName = Name, Name = "device.sleepInputEnabled", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => SleepInputEnabled, SetValue = val => SleepInputEnabled = (bool)val,
                ValueType = SleepInputEnabled.GetType(), DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.sleepInput", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => SleepInput, SetValue = val => SleepInput = (int)val,
                ValueType = SleepInput.GetType(), DefaultValue = 0
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.sleepInputActiveHigh", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => SleepInputActiveHigh, SetValue = val => SleepInputActiveHigh = (bool)val,
                ValueType = SleepInputActiveHigh.GetType(), DefaultValue = false
            },
            new DeviceParameter
            {
                ParentName = Name, Name = "device.sleepIgnoreAlwaysOn", Index = BaseIndex, SubIndex = subIndex++,
                GetValue = () => SleepIgnoreAlwaysOn, SetValue = val => SleepIgnoreAlwaysOn = (bool)val,
                ValueType = SleepIgnoreAlwaysOn.GetType(), DefaultValue = true
            }
        ]);
        
        foreach (var output in Outputs) allParams.AddRange(output.Params);
        foreach (var input in Inputs) allParams.AddRange(input.Params);
        foreach (var canInput in CanInputs) allParams.AddRange(canInput.Params);
        foreach (var virtualInput in VirtualInputs) allParams.AddRange(virtualInput.Params);
        foreach (var condition in Conditions) allParams.AddRange(condition.Params);
        foreach (var counter in Counters) allParams.AddRange(counter.Params);
        foreach (var flasher in Flashers) allParams.AddRange(flasher.Params);
        allParams.AddRange(StarterDisable.Params);
        allParams.AddRange(Wipers.Params);
        foreach (var canOutput in CanOutputs) allParams.AddRange(canOutput.Params);
        foreach (var keypad in Keypads) allParams.AddRange(keypad.BaseParams);
        foreach (var keypad in Keypads) allParams.AddRange(keypad.ButtonParams);
        foreach (var keypad in Keypads) allParams.AddRange(keypad.DialParams);
        Params = allParams;

        _paramProtocol = new ParamProtocol(this, Params)
        {
            NotifySuccess = msg => SuccessNotification?.Invoke(msg)
        };
    }

    private void Clear()
    {
        foreach(var input in Inputs)
            input.State = false;

        foreach(var output in Outputs)
        {
            output.Current = 0;
            output.State = OutState.Off;
        }

        foreach(var input in VirtualInputs)
            input.Value = false;

        foreach(var canInput in CanInputs)
            canInput.Output = false;
        
        Logger.LogDebug("PDM {Name} cleared", Name);
    }

    /// <remarks>
    /// Returns true only on Connected false to true transition
    /// </remarks>
    public bool UpdateIsConnected()
    {
        var lastConnected = Connected;
        var timeSpan = DateTime.Now - LastRxTime;
        Connected = timeSpan.TotalMilliseconds < 500;
        
        return Connected & !lastConnected;
    }
    
    public bool InIdRange(int id)
    {
        return (id >= BaseId) && (id <= MaxCyclicId + BaseId);
    }
    
    public void Read(int id, byte[] data, 
            ref ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> queue, 
            List<DeviceCanFrame> outgoing)
    {
        var offset = id - BaseId;

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

                // Lua read-back: reply carries [cmd, offHi, offLo, b0..b4]
                if (((MessageCommand)data[0]) == MessageCommand.LuaRead && data.Length >= 8)
                {
                    int off = (data[1] << 8) | data[2];
                    for (int i = 0; i < 5 && off + i < LuaReadBuffer.Length; i++)
                        LuaReadBuffer[off + i] = data[3 + i];
                }
                if (((MessageCommand)data[0]) == MessageCommand.LuaErr && data.Length >= 8)
                {
                    int off = (data[1] << 8) | data[2];
                    for (int i = 0; i < 5 && off + i < LuaErrBuffer.Length; i++)
                        LuaErrBuffer[off + i] = data[3 + i];
                }

                // Overload-log read-back replies.
                if (((MessageCommand)data[0]) == MessageCommand.OvlCount && data.Length >= 2)
                    OvlCountRx = data[1];
                if (((MessageCommand)data[0]) == MessageCommand.OvlHeader && data.Length >= 8)
                {
                    OvlHdrOut = data[2];   // 0xFF = invalid index
                    OvlHdrState = data[3];
                    OvlHdrPeak = ((data[5] << 8) | data[4]) / 10.0;
                    OvlHdrLimit = ((data[7] << 8) | data[6]) / 10.0;
                    OvlHdrRxIdx = data[1];
                }
                if (((MessageCommand)data[0]) == MessageCommand.OvlData && data.Length >= 8)
                {
                    for (int i = 0; i < 4; i++) OvlDataRxBytes[i] = data[4 + i];
                    OvlDataRxIdx = data[1];
                    OvlDataRxOff = (data[2] << 8) | data[3];
                }
            }
        }

        LastRxTime = DateTime.Now;
    }

    public IEnumerable<(int MessageId, DbcSignal Signal)> GetStatusSigs()
    {
        foreach (var kvp in StatusSigs)
        {
            int messageId = BaseId + kvp.Key;
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
        var id = BaseId;

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

    public DeviceCanFrame GetSleepMsg()
    {
        return new DeviceCanFrame
        {
            SendOnly = true,
            DeviceBaseId = BaseId,
            Frame = new CanFrame
            (
                Id: BaseId + ConfigTxOffset,
                Len: 8,
                Payload: [Convert.ToByte(MessageCommand.Sleep), Convert.ToByte('Q'), Convert.ToByte('U'), 
                            Convert.ToByte('I'), Convert.ToByte('T'), 0, 0, 0
                ]
            ),
            Name = "Sleep"
        };
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

    public DeviceCanFrame GetWakeupMsg()
    {
        return new DeviceCanFrame
        {
            SendOnly = true,
            DeviceBaseId = BaseId,
            Frame = new CanFrame
            (
                Id: BaseId + ConfigTxOffset,
                Len: 8,
                Payload: [Convert.ToByte('!'), 0, 0, 0, 0, 0, 0, 0]
            ),
            Name = "Wakeup"
        };
    }

    public DeviceCanFrame GetBootloaderMsg()
    {
        return new DeviceCanFrame
        {
            SendOnly = true,
            DeviceBaseId = BaseId,
            Frame = new CanFrame
            (
                Id: BaseId + ConfigTxOffset,
                Len: 8,
                Payload: [
                    Convert.ToByte(MessageCommand.Bootloader), (byte)'B', (byte)'O', (byte)'O', (byte)'T', (byte)'L', 0,
                    0
                ]
            ),
            Name = "Bootloader"
        };
    }
    
    public List<CanFrame> GetCyclicMsgs()
    {
        return [];
    }

    public bool SetKeypad(int index, int id, KeypadModel model)
    {
        if (index > NumKeypads - 1) return false;
        
        Keypads[index].Id = id;
        Keypads[index].Model = model;
        
        return true;
    }

    private void ReadVersion(int baseId, string name, byte[] data,
        ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> queue)
    {
        if (data.Length != 8) return;

        var version = $"v{data[4]}.{data[5]}.{(data[6] << 8) + (data[7])}";

        if (!CheckVersion(data[4], data[5], (data[6] << 8) + (data[7])))
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

        Version = version;
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
    public IReadOnlyList<DigitalInput> GetInputs() => Inputs.AsReadOnly();
    public IReadOnlyList<Output> GetOutputs() => Outputs.AsReadOnly();
    public IReadOnlyList<CanInput> GetCanInputs() => CanInputs.AsReadOnly();
    public IReadOnlyList<CanOutput> GetCanOutputs() => CanOutputs.AsReadOnly();
    public IReadOnlyList<VirtualInput> GetVirtualInputs() => VirtualInputs.AsReadOnly();
    public IReadOnlyList<Flasher> GetFlashers() => Flashers.AsReadOnly();
    public IReadOnlyList<Counter> GetCounters() => Counters.AsReadOnly();
    public IReadOnlyList<Condition> GetConditions() => Conditions.AsReadOnly();
    public Wiper GetWipers() => Wipers;
    public StarterDisable GetStarterDisable() => StarterDisable;
    public IReadOnlyList<KeypadMaster> GetKeypads() => Keypads.AsReadOnly();
}