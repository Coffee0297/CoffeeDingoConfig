using System.Collections.Concurrent;
using application.Models;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Generic;
using domain.Devices.Keypad.BlinkMarine;
using domain.Devices.Keypad.Grayhill;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging;

namespace application.Services;

public class DeviceManager(ILogger<DeviceManager> logger, ILoggerFactory loggerFactory, SystemLogger systemLogger, DeviceDefinitionManager deviceDefinitionManager)
{
    private readonly Dictionary<Guid, IDevice> _devices = new();
    private ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> _requestQueue = new();

    private Action<List<DeviceCanFrame>>? _batchTransmitCallback;
    
    private readonly Dictionary<Guid, DeviceUiState> _deviceUiState = new();

    private readonly Dictionary<Guid, System.Timers.Timer> _cyclicTimers = new();

    public int QueueCount => _requestQueue.Count;

    private const int MaxRetries = 2;
    private const int TimeoutMs = 3000;

    public event EventHandler<DeviceEventArgs>? DeviceAdded;
    public event EventHandler<DeviceEventArgs>? DeviceRemoved;

    public void SetBatchTransmitCallback(Action<List<DeviceCanFrame>> callback)
    {
        _batchTransmitCallback = callback;
    }

    /// <summary>
    /// Get UI state for a device (creates device UI state if it doesn't exist)
    /// </summary>
    public DeviceUiState GetDeviceUiState(Guid deviceId)
    {
        if (_deviceUiState.TryGetValue(deviceId, out var state)) return state;

        state = new DeviceUiState();
        _deviceUiState[deviceId] = state;
        return state;
    }

    /// <summary>
    /// Create and add a device of the specified type
    /// </summary>
    public void AddDevice(string deviceType, string name, int baseId)
    {
        var parts = deviceType.ToLower().Split('-', 2); // Limit to 2 parts max
        var devType = parts[0];
        var model = parts.Length > 1 ? parts[1] : string.Empty;

        // Handle pdm:{typeId} format
        int pdmTypeId = 0;
        if (devType.Contains(':'))
        {
            var pdmParts = devType.Split(':', 2);
            devType = pdmParts[0];
            int.TryParse(pdmParts[1], out pdmTypeId);
        }

        IDevice device = devType switch
        {
            "pdm" => new PdmDevice(
                deviceDefinitionManager.GetByPdmType(pdmTypeId) ?? DeviceDefinitionManager.DefaultPdm,
                name, baseId),
            "canboard" => new CanboardDevice(
                deviceDefinitionManager.GetByCanboardType(0) ?? DeviceDefinitionManager.DefaultCanboard,
                name, baseId),
            "dbcdevice" => new DbcDevice(name, baseId),
            "blinkkeypad" => new BlinkMarineKeypadDevice(name, baseId, model),
            "grayhillkeypad" => new GrayhillKeypadDevice(name, baseId, model),
            _ => throw new ArgumentException($"Unknown device type: '{deviceType}'")
        };

        SetLoggers(device);
        _devices[device.Guid] = device;

        // Keypads don't need read - they're passive reporting devices
        var needsRead = device is not BlinkMarineKeypadDevice and not GrayhillKeypadDevice;
        GetDeviceUiState(device.Guid).NeedsRead = needsRead;

        logger.LogInformation("Device added: {DeviceType} '{Name}' (ID: {BaseId}, Guid: {Guid})",
            deviceType, name, baseId, device.Guid);

        SetCyclicTimer(device);
        OnDeviceAdded(new DeviceEventArgs(device));
    }

    /// <summary>
    /// Get a device by Guid
    /// </summary>
    public IDevice? GetDevice(Guid id)
    {
        _devices.TryGetValue(id, out var device);
        if(device?.UpdateIsConnected() == true) 
            CheckConfig(id);
        return device;
    }

    /// <summary>
    /// Get a device by Guid as a specific type
    /// </summary>
    public T? GetDevice<T>(Guid id) where T : class, IDevice
    {
        return GetDevice(id) as T;
    }

    /// <summary>
    /// Get a device by BaseId (for routing CAN message)
    /// </summary>
    private IDevice? GetDeviceByBaseId(int baseId)
    {
        return _devices.Values.FirstOrDefault(d => d.BaseId == baseId);
    }

    /// <summary>
    /// Get all devices
    /// </summary>
    public IEnumerable<IDevice> GetAllDevices()
    {
        foreach (var device in _devices.Values)
        {
            if(device.UpdateIsConnected())
                CheckConfig(device.Guid); 
        }

        return _devices.Values;
    }

    /// <summary>
    /// Get all devices of a specific type
    /// </summary>
    public IEnumerable<T> GetDevicesByType<T>() where T : class, IDevice
    {
        var devices = _devices.Values.OfType<T>().ToList();
        foreach (var device in devices)
        {
            if(device.UpdateIsConnected())
                CheckConfig(device.Guid);
        }

        return devices;
    }

    /// <summary>
    /// Remove a device
    /// </summary>
    public void RemoveDevice(Guid deviceId)
    {
        RemoveCyclicTimer(deviceId);

        if (_devices.Remove(deviceId, out var device))
        {
            logger.LogInformation("Device removed: {Name} (Guid: {Guid})", device.Name, deviceId);

            OnDeviceRemoved(new DeviceEventArgs(device));
        }
    }

    /// <summary>
    /// Add multiple devices
    /// Injects loggers into devices
    /// </summary>
    public void AddDevices(List<IDevice> devices)
    {
        foreach (var device in devices)
        {
            SetLoggers(device);

            _devices[device.Guid] = device;
            GetDeviceUiState(device.Guid).NeedsRead = true;
            SetCyclicTimer(device);
            OnDeviceAdded(new DeviceEventArgs(device));
        }

        logger.LogInformation("Added {Count} devices", devices.Count);
    }

    /// <summary>
    /// Clear all devices
    /// </summary>
    public void ClearDevices()
    {
        RemoveAllCyclicTimers();
        _devices.Clear();
        _requestQueue.Clear();
        logger.LogInformation("All devices cleared");
    }

    /// <summary>
    /// Get all devices
    /// </summary>
    public List<IDevice> GetDevices()
    {
        var devices = _devices.Values.ToList();
        foreach (var device in devices)
        {
            if(device.UpdateIsConnected())
                CheckConfig(device.Guid);
        }

        return devices;
    }

    public void CheckConfig(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable) return;
        var deviceConfigurable = (IDeviceConfigurable)device;
        var msg = deviceConfigurable.GetCheckMsg();
        QueueMessage(msg);
    }

    /// <summary>
    /// Called by CommsDataPipeline when CAN data is received
    /// Routes data to all devices so they can update their state/config
    /// </summary>
    public void OnCanDataReceived(CanFrame frame)
    {
        foreach (var device in _devices.Values)
        {
            if (device.InIdRange(frame.Id))
            {
                var outgoing = new List<DeviceCanFrame>();
                device.Read(frame.Id, frame.Payload, ref _requestQueue, outgoing);
                if (outgoing.Count > 0)
                    _batchTransmitCallback?.Invoke(outgoing);
            }
        }
    }

    private void SetLoggers(IDevice device)
    {
        switch (device)
        {
            case PdmDevice pdmDevice:
                pdmDevice.SetLogger(loggerFactory.CreateLogger<PdmDevice>());
                pdmDevice.SuccessNotification += msg => systemLogger.Notify(pdmDevice.Name, msg);
                break;
            case CanboardDevice canboardDevice:
                canboardDevice.SetLogger(loggerFactory.CreateLogger<CanboardDevice>());
                break;
            case DbcDevice dbcDevice:
                dbcDevice.SetLogger(loggerFactory.CreateLogger<DbcDevice>());
                dbcDevice.UpdateIdRange();
                break;
            case BlinkMarineKeypadDevice blinkKeypad:
                blinkKeypad.SetLogger(loggerFactory.CreateLogger<BlinkMarineKeypadDevice>());
                break;
            case GrayhillKeypadDevice grayhillKeypad:
                grayhillKeypad.SetLogger(loggerFactory.CreateLogger<GrayhillKeypadDevice>());
                break;
        }
    }

    private void SetCyclicTimer(IDevice device)
    {
        //Cyclic timers not used or configured
        if ((device.CyclicGap <= TimeSpan.FromMilliseconds(0)) ||
            (device.CyclicPause <= TimeSpan.FromMilliseconds(0))) return;

        var timer = new System.Timers.Timer(device.CyclicGap);
        timer.Elapsed += (_, _) => SendCyclicMessages(device);
        timer.AutoReset = true;
        timer.Start();

        _cyclicTimers[device.Guid] = timer;
    }

    private void RemoveAllCyclicTimers()
    {
        foreach (var timer in _cyclicTimers)
        {
            timer.Value.Stop();
            timer.Value.Dispose();
        }

        _cyclicTimers.Clear();
    }

    private void RemoveCyclicTimer(Guid deviceId)
    {
        if (!_cyclicTimers.TryGetValue(deviceId, out var timer)) return;
        
        timer.Stop();
        _cyclicTimers.Remove(deviceId);
    }

    private void SendCyclicMessages(IDevice device)
    {
        var msgs = device.GetCyclicMsgs();
        if (msgs.Count == 0) return;

        foreach (var msg in msgs)
        {
            var devMsg = new DeviceCanFrame()
            {
                SendOnly = true,
                Frame = msg
            };
            QueueMessage(devMsg);
            Thread.Sleep(device.CyclicPause);
        }
    }

    // ============================================
    // Message Queuing & Timeout Management
    // ============================================

    /// <summary>
    /// Queue a message for transmission
    /// </summary>
    private void QueueMessage(DeviceCanFrame frame)
    {
        // Queue for transmission
        if (_batchTransmitCallback != null)
        {
            _batchTransmitCallback([frame]);
        }
        else
        {
            logger.LogWarning("Transmit callback not set - message not transmitted");
            return;
        }

        //Some messages have no response, don't queue
        if (frame.SendOnly) return;

        int index = frame.Frame.Payload[2] << 8 | frame.Frame.Payload[1];
        int subIndex = frame.Frame.Payload[3];

        //Unique message key, used to find message in transmit queue later
        var key = (frame.DeviceBaseId, index, subIndex);

        if (!_requestQueue.TryAdd(key, frame))
        {
            logger.LogWarning("Message already in queue: BaseId={BaseId}, Prefix={Prefix:X}, Index={Index}",
                key.Item1, key.Item2, key.Item3);
            return;
        }

        // NOTE: Timer starts after transmission in OnFrameTransmitted
    }

    private void StartMessageTimer((int, int, int) key, DeviceCanFrame frame)
    {
        frame.TimeSentTimer = new Timer(_ => { HandleMessageTimeout(key, frame); }, null, TimeoutMs, Timeout.Infinite);
    }

    private void HandleMessageTimeout((int BaseId, int Prefix, int Index) key, DeviceCanFrame frame)
    {
        if (!_requestQueue.TryGetValue(key, out _))
            return;

        frame.RxAttempts++;

        if (frame.RxAttempts >= MaxRetries)
        {
            // Max retries exceeded - remove and log error
            _requestQueue.TryRemove(key, out _);
            frame.TimeSentTimer?.Dispose();

            int index =  frame.Frame.Payload[2] << 8 | frame.Frame.Payload[1];
            int subIndex = frame.Frame.Payload[3];
            
            var device = GetDeviceByBaseId(key.BaseId);
            logger.LogError("Message failed after {MaxRetries} retries: {Index:X}:{SubIndex} on {DeviceName} (ID: {BaseId}) - {Name}",
                MaxRetries, index, subIndex, device?.Name ?? "Unknown", key.BaseId, frame.Name);

            // Surface the failed ack to the UI as a red toast. Without this, a queued write that the
            // device never acknowledges only ever lands as an Error line in the Logs tab — the action
            // button has already flashed green ("sent"), so the user is told a write succeeded when it
            // physically did not. This closes that false-success gap for write/burn/sleep/wake/etc.
            systemLogger.Notify(device?.Name ?? "CAN",
                $"No reply from {device?.Name ?? "module"} — {frame.Name} ({index:X4}:{subIndex}) failed after {MaxRetries} tries. The module did not acknowledge — the operation did NOT complete.",
                application.Models.LogLevel.Error);
        }
        else
        {
            // Retry - queue again
            _batchTransmitCallback?.Invoke([frame]);

            // NOTE: Timer restarts after transmission in OnFrameTransmitted

            logger.LogWarning("Message retry {Attempt}/{MaxRetries}: (BaseId={BaseId}) - {Name}",
                frame.RxAttempts, MaxRetries, key.BaseId, frame.Name);
        }
    }

    /// <summary>
    /// Called by CommsDataPipeline after a frame has been physically transmitted.
    /// Starts the response timeout timer only after the frame is actually sent.
    /// </summary>
    public void OnFrameTransmitted(DeviceCanFrame frame)
    {
        if (frame.SendOnly) return;

        int index = frame.Frame.Payload[2] << 8 | frame.Frame.Payload[1];
        int subIndex = frame.Frame.Payload[3];
        var key = (frame.DeviceBaseId, index, subIndex);

        if (_requestQueue.TryGetValue(key, out var queuedFrame))
            StartMessageTimer(key, queuedFrame);
    }

    /// <summary>
    /// Read configuration from device to host
    /// Only modified params
    /// </summary>
    public void ReadDeviceConfig(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return;

        GetDeviceUiState(deviceId).NeedsRead = false;

        var readMsgs = configurable.GetReadMsgs(allParams: false);
        foreach (var msg in readMsgs)
        {
            QueueMessage(msg);
            Thread.Sleep(1); //Slow down to give device time to respond
        }
        
        logger.LogInformation("Read started for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
    }
    
    /// <summary>
    /// Read a single parameter (index/subindex) from the device — paced, no bulk burst.
    /// Response is parsed by the device's ParamProtocol (sets the matching value).
    /// </summary>
    public bool ReadParam(Guid deviceId, int index, int subIndex)
    {
        var device = GetDevice(deviceId);
        if (device == null) return false;
        var payload = new byte[]
        {
            (byte)domain.Enums.MessageCommand.Read,
            (byte)(index & 0xFF), (byte)((index >> 8) & 0xFF), (byte)subIndex,
            0, 0, 0, 0
        };
        QueueMessage(new DeviceCanFrame
        {
            DeviceBaseId = device.BaseId,
            Frame = new CanFrame(device.BaseId + 1, 8, payload), // +1 = ConfigTxOffset
            Name = $"Read {index:X}:{subIndex}"
        });
        return true;
    }

    /// <summary>
    /// Write a single parameter (index/subindex) to the device — paced, no bulk burst.
    /// value is the raw 32-bit wire value (float params: pass the IEEE-754 bit pattern).
    /// </summary>
    /// <summary>
    /// Write a specific set of already-set DeviceParameters to the device, paced. Encodes each
    /// via ParamCodec (honours float/signed/enum/bool), so callers just SetValue then call this.
    /// Used by the declarative system-config apply path. Returns the number queued.
    /// </summary>
    public int WriteParamObjects(Guid deviceId, IEnumerable<DeviceParameter> ps)
    {
        var device = GetDevice(deviceId);
        if (device == null) return 0;
        int n = 0;
        // Windowed back-pressure: never let more than `window` writes go un-acked. A flat 2ms
        // blast overran the module on a full-config write (a profile flash writes the WHOLE param
        // set), so its config-write acks couldn't keep up and many CfgWrites failed after retries.
        // This matches the proven pacing of WriteFunctionParams/ReadAllParamsChunked. The 400×5ms
        // cap means a genuinely stuck param can't stall the whole write (it ages out via retry).
        const int window = 8;
        foreach (var p in ps)
        {
            if (p.LocalOnly) continue;   // label-only setting, nothing to send over CAN
            if (GetDevice(deviceId) == null) return n;   // device removed mid-write
            var waits = 0;
            while (_requestQueue.Count >= window && waits++ < 400)
                Thread.Sleep(5);
            QueueMessage(new DeviceCanFrame
            {
                DeviceBaseId = device.BaseId,
                Frame = domain.Common.ParamCodec.ToFrame(domain.Enums.MessageCommand.Write, p, device.BaseId + 1),
                Name = $"CfgWrite {p.Index:X}:{p.SubIndex}"
            });
            n++;
        }
        return n;
    }

    public bool WriteParam(Guid deviceId, int index, int subIndex, uint value)
    {
        var device = GetDevice(deviceId);
        if (device == null) return false;
        var payload = new byte[]
        {
            (byte)domain.Enums.MessageCommand.Write,
            (byte)(index & 0xFF), (byte)((index >> 8) & 0xFF), (byte)subIndex,
            (byte)(value & 0xFF), (byte)((value >> 8) & 0xFF),
            (byte)((value >> 16) & 0xFF), (byte)((value >> 24) & 0xFF)
        };
        QueueMessage(new DeviceCanFrame
        {
            DeviceBaseId = device.BaseId,
            Frame = new CanFrame(device.BaseId + 1, 8, payload),
            Name = $"Write {index:X}:{subIndex}"
        });
        return true;
    }

    /// <summary>
    /// Read the entire config one parameter at a time (paced, windowed) instead of the
    /// firmware's bulk ReadAll burst — the burst wedges the device's blocking send loop on
    /// a slow USB-SLCAN link. Each Read is a discrete request/response (with retry), and we
    /// keep only a few outstanding so the half-duplex link never saturates. Runs in the
    /// background; values populate progressively as responses arrive.
    /// </summary>
    public void ReadAllParamsChunked(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable cfg) return;

        var paramList = cfg.Params.Where(p => !p.LocalOnly).ToList();
        var ui = GetDeviceUiState(deviceId);
        ui.NeedsRead = false;
        ui.Reading = true;
        ui.ReadDone = 0;
        ui.ReadTotal = paramList.Count;

        Task.Run(() =>
        {
            try
            {
                const int window = 8;      // max outstanding requests (back-pressure)
                foreach (var p in paramList)
                {
                    if (GetDevice(deviceId) == null) return; // device removed/disconnected

                    // Wait while too many requests are in flight so we don't outrun the link.
                    var waits = 0;
                    while (_requestQueue.Count >= window && waits++ < 400)
                        Thread.Sleep(5);

                    ReadParam(deviceId, p.Index, p.SubIndex);
                    ui.ReadDone++;
                }
                logger.LogInformation("Chunked Read All: requested {Count} params for {Name} (ID: {BaseId})",
                    paramList.Count, device.Name, device.BaseId);
            }
            finally { ui.Reading = false; }
        });
    }

    /// <summary>
    /// Write the params for a single output (index 0x1000 + (number-1)) to the device, paced.
    /// Used by the output editor's Save. Burn separately to persist to flash.
    /// </summary>
    // Back-compat: outputs live at param index 0x1000 + (n-1).
    public void WriteOutputParams(Guid deviceId, int outputNumber) =>
        WriteFunctionParams(deviceId, 0x1000 + (outputNumber - 1));

    /// <summary>
    /// Write every param at a single function's param index (BaseIndex + (Number-1)) to the
    /// device, paced/windowed. Serves any function grid — outputs, CAN inputs, conditions, etc.
    /// </summary>
    public void WriteFunctionParams(Guid deviceId, int index)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable cfg) return;

        var ps = cfg.Params.Where(p => p.Index == index && !p.LocalOnly).ToList();
        if (ps.Count == 0) return;

        Task.Run(() =>
        {
            const int window = 8;
            foreach (var p in ps)
            {
                if (GetDevice(deviceId) == null) return;
                var waits = 0;
                while (_requestQueue.Count >= window && waits++ < 400)
                    Thread.Sleep(5);

                var frame = domain.Common.ParamCodec.ToFrame(domain.Enums.MessageCommand.Write, p, device.BaseId + 1);
                uint value = (uint)(frame.Payload[4] | frame.Payload[5] << 8 | frame.Payload[6] << 16 | frame.Payload[7] << 24);
                WriteParam(deviceId, p.Index, p.SubIndex, value);
            }
            logger.LogInformation("Wrote function params at index 0x{Index:X} for {Name} (ID: {BaseId})", index, device.Name, device.BaseId);
        });
    }

    /// <summary>
    /// Write the entire config (or only modified params) one parameter at a time, paced and
    /// windowed — the chunked counterpart to <see cref="ReadAllParamsChunked"/>.
    /// </summary>
    public void WriteAllParamsChunked(Guid deviceId, bool modifiedOnly = false)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable cfg) return;

        var paramList = cfg.Params
            .Where(p => !p.LocalOnly && (!modifiedOnly || p.IsModified))
            .ToList();

        Task.Run(() =>
        {
            const int window = 8;
            foreach (var p in paramList)
            {
                if (GetDevice(deviceId) == null) return;

                var waits = 0;
                while (_requestQueue.Count >= window && waits++ < 400)
                    Thread.Sleep(5);

                // Encode the param to its wire frame and pull the 32-bit value out (handles
                // float/int/enum/bool encoding consistently with the firmware).
                var frame = domain.Common.ParamCodec.ToFrame(domain.Enums.MessageCommand.Write, p, device.BaseId + 1);
                uint value = (uint)(frame.Payload[4] | frame.Payload[5] << 8 | frame.Payload[6] << 16 | frame.Payload[7] << 24);
                WriteParam(deviceId, p.Index, p.SubIndex, value);
            }
            logger.LogInformation("Chunked Write All: wrote {Count} params for {Name} (ID: {BaseId})",
                paramList.Count, device.Name, device.BaseId);
        });
    }

    /// <summary>
    /// Read configuration from device to host
    /// All parameters
    /// </summary>
    public void ReadAllDeviceConfig(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return;

        GetDeviceUiState(deviceId).NeedsRead = false;

        var readMsgs = configurable.GetReadMsgs(allParams: true);
        foreach (var msg in readMsgs)
        {
            QueueMessage(msg);
            Thread.Sleep(1); //Slow down to give device time to respond
        }

        logger.LogInformation("Read started for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
    }

    /// <summary>
    /// Write configuration to device
    /// Only modified parameters
    /// </summary>
    /// <returns>
    /// Send write config success
    /// </returns>
    public bool WriteDeviceConfig(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var downloadMsgs = configurable.GetWriteMsgs(allParams: false);
        foreach (var msg in downloadMsgs)
        {
            QueueMessage(msg);
            Thread.Sleep(1); //Slow down to give device time to respond
        }

        logger.LogInformation("Write started for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }
    
    /// <summary>
    /// Write all configuration to device
    /// Write all parameters
    /// </summary>
    /// <returns>
    /// Send write config success
    /// </returns>
    public bool WriteAllDeviceConfig(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var downloadMsgs = configurable.GetWriteMsgs(allParams: true);
        foreach (var msg in downloadMsgs)
        {
            QueueMessage(msg);
            Thread.Sleep(1); //Slow down to give device time to respond
        }

        logger.LogInformation("Write started for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }

    /// <summary>
    /// Modify device, name and base ID
    /// Sends modify message to device
    /// </summary>
    public void ModifyDeviceConfig(Guid deviceId, string newName, int baseId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
        {
            if (device == null) return;
            
            device.Name = newName;
            device.BaseId = baseId;
            return;
        }

        var modifyMsgs = configurable.GetModifyMsgs(baseId);
        foreach (var msg in modifyMsgs)
        {
            QueueMessage(msg);
            Thread.Sleep(1); //Slow down to give device time to respond
        }

        logger.LogInformation("Modify started for {DeviceName} (Guid: {Guid})", device.Name, deviceId);

        //Wait for modify messages to be sent, then update the base ID
        Thread.Sleep(300);

        device.Name = newName;
        device.BaseId = baseId;
    }

    /// <summary>
    /// Commission a connected module by writing a saved profile's whole config onto it and
    /// re-addressing it to the profile's base ID — the module ends up *being* the profile.
    ///
    /// The entire hardware sequence is issued at the module's CURRENT id and is FIFO-ordered:
    ///   write every param (-> RAM) → modify base id (writes base id, then burns).
    /// The single burn inside the modify persists EVERYTHING in RAM (config + new base id) and
    /// triggers the firmware's CAN re-init, so the module comes up at its new id with no power
    /// cycle. Crucially there is NO write/burn addressed to the *new* id here — that used to
    /// race the re-address and fail. Lua lives client-side; the caller uploads it after.
    /// Returns (ok, error).
    /// </summary>
    /// <summary>Rename a device (project label only — no CAN traffic).</summary>
    public bool RenameDevice(Guid deviceId, string name)
    {
        var device = GetDevice(deviceId);
        if (device == null) return false;
        device.Name = name;
        return true;
    }

    public (bool ok, string error) ApplyProfile(Guid targetId, Guid sourceId)
    {
        var target = GetDevice(targetId);
        var source = GetDevice(sourceId);
        if (target is not IDeviceConfigurable tc || source is not IDeviceConfigurable sc)
            return (false, "Both the target and the profile must be configurable modules.");
        if (targetId == sourceId) return (false, "Pick a different profile to flash.");
        target.UpdateIsConnected();
        if (!target.Connected)
            return (false, $"Target module 0x{target.BaseId:X} isn't responding — connect it over USB first.");
        if (source.BaseId < 1 || source.BaseId > 0x7FF)
            return (false, $"Profile '{source.Name}' has an invalid base ID 0x{source.BaseId:X} — must be 0x001–0x7FF.");

        // 1. Copy every setting value from the profile onto the target (base ID is Index 0/Sub 0,
        //    handled by the re-address step below; everything else — outputs, limits, flashers,
        //    CAN in/out, conditions, labels, wire data — comes across).
        var byName = tc.Params.ToDictionary(p => p.Name, StringComparer.OrdinalIgnoreCase);
        foreach (var sp in sc.Params)
        {
            if (sp is { Index: 0x0000, SubIndex: 0 }) continue;
            if (byName.TryGetValue(sp.Name, out var tp)) { try { tp.SetValue(sp.GetValue()); } catch { /* skip incompatible */ } }
        }

        // 2. Push all params to the module's RAM at its CURRENT id (skips LocalOnly labels, FIFO).
        WriteParamObjects(targetId, tc.Params.Where(p => p is not { Index: 0x0000, SubIndex: 0 }).ToList());

        // 2b. WAIT for every config write to be ACKNOWLEDGED before re-addressing. The base-id
        //     change burns and re-inits the module's CAN; any param still in flight at that instant
        //     is addressed to the OLD id the module just left, so it never acks (the tail CfgWrites
        //     that failed in testing were exactly the last few params racing the re-address).
        //     Draining the request queue first guarantees the full config is confirmed on the module
        //     before it moves. Capped (~8s) so a genuinely unanswerable param ages out via the normal
        //     retry/fail path rather than hanging the commission.
        var drainWaits = 0;
        while (_requestQueue.Count > 0 && drainWaits++ < 800) Thread.Sleep(10);

        // 3. Re-address: ModifyDeviceConfig writes the new base id then burns — both at the OLD
        //    id. That burn persists the config written above AND the new id, then re-inits CAN.
        ModifyDeviceConfig(targetId, source.Name, source.BaseId);

        logger.LogInformation("ApplyProfile: wrote '{Src}' onto module, now 0x{Id:X} ({Name})", source.Name, target.BaseId, target.Name);
        return (true, "");
    }

    /// <summary>
    /// Burn settings to device flash memory
    /// </summary>
    /// <returns>
    /// Send burn request success
    /// </returns>
    public bool BurnSettings(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var burnMsg = configurable.GetBurnMsg();
        QueueMessage(burnMsg);

        logger.LogInformation("Burn initiated for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }

    /// <summary>
    /// Upload one assembled Lua program to the device, chunked (5 source bytes per
    /// frame) and paced so the device's RX mailbox can't overflow. The firmware
    /// stores it, persists to FRAM, and recompiles. Frames are send-only (acks are
    /// observed on the bus but not awaited here).
    /// </summary>
    public bool UploadLua(Guid deviceId, string source)
    {
        var device = GetDevice(deviceId);
        if (device is null) return false;

        // Only the PDMs run an embedded Lua engine (firmware HAS_LUA). A CANBoard / DBC / keypad
        // has none — refuse here so no path (cross-module deploy, drawer, MCP) can ever push Lua
        // frames to a device that would silently ignore or mis-parse them.
        if (device is not PdmDevice)
        {
            logger.LogWarning("UploadLua refused: {Name} ({Type}) has no Lua engine", device.Name, device.Type);
            return false;
        }

        var bytes = System.Text.Encoding.ASCII.GetBytes(source ?? string.Empty);
        if (bytes.Length > 4096) return false;   // matches firmware LUA_SCRIPT_MAX
        int txId = device.BaseId + 1;             // ConfigTxOffset — device RX channel

        logger.LogInformation("UploadLua starting: {Len} bytes to {Name} (txId 0x{TxId:X})", bytes.Length, device.Name, txId);
        Task.Run(() =>
        {
            try
            {
                for (int off = 0; off < bytes.Length; off += 5)
                {
                    if (GetDevice(deviceId) == null) return;
                    var p = new byte[8];
                    p[0] = (byte)domain.Enums.MessageCommand.LuaWrite;
                    p[1] = (byte)(off >> 8); p[2] = (byte)(off & 0xFF);
                    for (int i = 0; i < 5 && off + i < bytes.Length; i++) p[3 + i] = bytes[off + i];
                    QueueMessage(new DeviceCanFrame
                    {
                        DeviceBaseId = device.BaseId, SendOnly = true, Name = "LuaWrite",
                        Frame = new CanFrame(txId, 8, p)
                    });
                    Thread.Sleep(3);
                }
                QueueMessage(new DeviceCanFrame
                {
                    DeviceBaseId = device.BaseId, SendOnly = true, Name = "LuaWriteComplete",
                    Frame = new CanFrame(txId, 8,
                        [(byte)domain.Enums.MessageCommand.LuaWriteComplete, (byte)(bytes.Length >> 8), (byte)(bytes.Length & 0xFF), 0, 0, 0, 0, 0])
                });
                logger.LogInformation("UploadLua done: {Len} bytes to {Name}", bytes.Length, device.Name);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "UploadLua failed for {Name}", device.Name);
            }
        });
        return true;
    }

    /// <summary>
    /// Read the stored Lua program back from the device. Sends LuaRead requests
    /// (5 bytes/reply) from offset 0 and accumulates until the null terminator.
    /// Uses a 0xFF sentinel so "not yet received" is distinct from a real '\0'.
    /// </summary>
    public async Task<string> ReadLua(Guid deviceId)
    {
        var p = GetDevice<PdmDevice>(deviceId);
        if (p == null) return "";

        var buf = p.LuaReadBuffer;
        for (int i = 0; i < buf.Length; i++) buf[i] = 0xFF;

        int end = 0;
        for (int off = 0; off < buf.Length; off += 5)
        {
            if (GetDevice(deviceId) == null) break;
            // Retry each chunk so a single dropped reply (USB-CAN frame loss) doesn't truncate
            // the whole read. 0xFF is a safe sentinel — valid Lua source is 7-bit ASCII.
            for (int tries = 0; tries < 5 && buf[off] == 0xFF; tries++)
            {
                QueueMessage(p.GetLuaReadMsg(off));
                int waited = 0;
                while (buf[off] == 0xFF && waited < 120) { await Task.Delay(10); waited += 10; }
            }
            if (buf[off] == 0xFF) break;   // no reply after retries — genuine end of program

            bool done = false;
            for (int i = off; i < off + 5 && i < buf.Length; i++)
            {
                if (buf[i] == 0x00) { end = i; done = true; break; }
                end = i + 1;
            }
            if (done) break;
        }

        logger.LogInformation("ReadLua: {Len} bytes from {Name}", end, p.Name);
        return System.Text.Encoding.ASCII.GetString(buf, 0, end);
    }

    /// <summary>Read the device's last Lua runtime error string (empty if none).</summary>
    public async Task<string> ReadLuaError(Guid deviceId)
    {
        var p = GetDevice<PdmDevice>(deviceId);
        if (p == null) return "";
        var buf = p.LuaErrBuffer;
        for (int i = 0; i < buf.Length; i++) buf[i] = 0xFF;

        int end = 0;
        for (int off = 0; off < buf.Length; off += 5)
        {
            if (GetDevice(deviceId) == null) break;
            for (int tries = 0; tries < 5 && buf[off] == 0xFF; tries++)
            {
                QueueMessage(p.GetLuaErrMsg(off));
                int waited = 0;
                while (buf[off] == 0xFF && waited < 120) { await Task.Delay(10); waited += 10; }
            }
            if (buf[off] == 0xFF) break;
            bool done = false;
            for (int i = off; i < off + 5 && i < buf.Length; i++)
            {
                if (buf[i] == 0x00) { end = i; done = true; break; }
                end = i + 1;
            }
            if (done) break;
        }
        return System.Text.Encoding.ASCII.GetString(buf, 0, end);
    }

    /// <summary>
    /// Read the on-device overload (trip) log: count, then each event's header +
    /// waveform, chunked over CAN. The device records these autonomously so a trip
    /// that happened while disconnected is still here for troubleshooting.
    /// </summary>
    public async Task<List<OverloadLogEntry>> ReadOverloadLog(Guid deviceId)
    {
        var result = new List<OverloadLogEntry>();
        var p = GetDevice<PdmDevice>(deviceId);
        if (p == null) return result;

        p.OvlCountRx = -1;
        QueueMessage(p.GetOvlCountMsg());
        int waited = 0;
        while (p.OvlCountRx < 0 && waited < 500) { await Task.Delay(10); waited += 10; }
        if (p.OvlCountRx <= 0) return result;

        int count = Math.Min(p.OvlCountRx, 16);
        for (int idx = 0; idx < count; idx++)
        {
            if (GetDevice(deviceId) == null) break;

            p.OvlHdrRxIdx = -1;
            QueueMessage(p.GetOvlHeaderMsg(idx));
            waited = 0;
            while (p.OvlHdrRxIdx != idx && waited < 500) { await Task.Delay(10); waited += 10; }
            if (p.OvlHdrRxIdx != idx || p.OvlHdrOut == 0xFF) continue;   // no reply / invalid slot

            int outNum = p.OvlHdrOut;
            var state = (domain.Enums.dingoPdm.OutState)p.OvlHdrState;
            double peak = p.OvlHdrPeak, limit = p.OvlHdrLimit;

            var samples = new byte[PdmDevice.OvlTotalSamples];
            for (int off = 0; off < PdmDevice.OvlTotalSamples; off += 4)
            {
                p.OvlDataRxIdx = -1; p.OvlDataRxOff = -1;
                QueueMessage(p.GetOvlDataMsg(idx, off));
                waited = 0;
                while (!(p.OvlDataRxIdx == idx && p.OvlDataRxOff == off) && waited < 300) { await Task.Delay(5); waited += 5; }
                if (!(p.OvlDataRxIdx == idx && p.OvlDataRxOff == off)) break;
                for (int k = 0; k < 4 && off + k < samples.Length; k++) samples[off + k] = p.OvlDataRxBytes[k];
            }

            var pts = new List<OvlPoint>(samples.Length);
            for (int k = 0; k < samples.Length; k++)
            {
                double dt = (k - PdmDevice.OvlPreSamples) * (PdmDevice.OvlSampleMs / 1000.0);
                pts.Add(new OvlPoint(Math.Round(dt, 3), samples[k] * PdmDevice.OvlAmpStep));
            }
            result.Add(new OverloadLogEntry(outNum + 1, state.ToString(), peak, limit, pts));
        }
        logger.LogInformation("ReadOverloadLog: {N} events from {Name}", result.Count, p.Name);
        return result;
    }

    /// <summary>Clear the on-device overload log.</summary>
    public void ClearOverloadLog(Guid deviceId)
    {
        var p = GetDevice<PdmDevice>(deviceId);
        if (p == null) return;
        QueueMessage(new DeviceCanFrame
        {
            DeviceBaseId = p.BaseId, SendOnly = true, Name = "OvlClear",
            Frame = new CanFrame(p.BaseId + PdmDevice.ConfigTxOffset, 8,
                [(byte)domain.Enums.MessageCommand.OvlClear, 0, 0, 0, 0, 0, 0, 0])
        });
    }

    /// <summary>
    /// Request device enter sleep
    /// </summary>
    /// <returns>
    /// Send sleep request success
    /// </returns>
    public bool RequestSleep(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var sleepMsg = configurable.GetSleepMsg();

        if (sleepMsg == null)
        {
            logger.LogInformation("No sleep msg for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
            return false;
        }    
            
        QueueMessage(sleepMsg);

        logger.LogInformation("Sleep requested for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }

    /// <summary>
    /// Request device version/info
    /// </summary>
    /// <returns>
    /// Send request version success
    /// </returns>
    public bool RequestVersion(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var versionMsg = configurable.GetVersionMsg();
        QueueMessage(versionMsg);

        logger.LogInformation("Version requested for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }

    /// <summary>
    /// Request device wakeup
    /// </summary>
    /// <returns>
    /// Send wakeup success
    /// </returns>
    public bool RequestWakeup(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var wakeupMsg = configurable.GetWakeupMsg();

        if (wakeupMsg == null)
        {
            logger.LogInformation("No wake up msg for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
            return false;
        }    
        
        QueueMessage(wakeupMsg);

        logger.LogInformation("Wake up for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }

    /// <summary>
    /// Request enter bootloader
    /// </summary>
    /// <returns>
    /// Send enter bootloader success
    /// </returns>
    public bool RequestBootloader(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var bootloaderMsg = configurable.GetBootloaderMsg();

        if (bootloaderMsg == null)
        {
            logger.LogInformation("No bootloader msg for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
            return false;    
        }
        
        QueueMessage(bootloaderMsg);

        logger.LogInformation("Enter bootloader on {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }

    private void OnDeviceAdded(DeviceEventArgs e)
    {
        DeviceAdded?.Invoke(this, e);
    }

    private void OnDeviceRemoved(DeviceEventArgs e)
    {
        DeviceRemoved?.Invoke(this, e);
    }
}

public class DeviceEventArgs(IDevice device) : EventArgs
{
    public IDevice Device { get; } = device;
}

/// <summary>One waveform point of an overload event: dt seconds relative to the trip, current in amps.</summary>
public record OvlPoint(double Dt, double I);

/// <summary>A single on-device overload (trip) event read back over CAN.</summary>
public record OverloadLogEntry(int Output, string State, double PeakA, double LimitA, List<OvlPoint> Samples);