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
    // Concurrent: the telemetry broadcaster enumerates this 10x/s while API/frame threads add &
    // remove devices (scan, flash reboot) — a plain Dictionary threw "Collection was modified".
    private readonly ConcurrentDictionary<Guid, IDevice> _devices = new();
    private ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> _requestQueue = new();

    private Action<List<DeviceCanFrame>>? _batchTransmitCallback;
    
    private readonly Dictionary<Guid, DeviceUiState> _deviceUiState = new();

    private readonly Dictionary<Guid, System.Timers.Timer> _cyclicTimers = new();

    // --- Receive-filter (flooded-bus survival) -----------------------------------------------------
    // On a saturated bus the SLCAN/PCAN reader can't surface every frame. While we're exchanging config
    // with a module, clamp the adapter's RX to just that module's reply id so the answer can't be buried
    // (see ICommsAdapter.SetReceiveFilter). Wired by the comms pipeline; null when no adapter is active.
    private Action<int?, int?>? _setReceiveFilter;
    private System.Threading.Timer? _filterIdleTimer;
    private readonly object _filterLock = new();
    private const int FilterIdleMs = 1500;   // lift the filter this long after the last config frame

    public int QueueCount => _requestQueue.Count;

    private const int MaxRetries = 2;
    private const int TimeoutMs = 3000;

    public event EventHandler<DeviceEventArgs>? DeviceAdded;
    public event EventHandler<DeviceEventArgs>? DeviceRemoved;

    public void SetBatchTransmitCallback(Action<List<DeviceCanFrame>> callback)
    {
        _batchTransmitCallback = callback;
    }

    /// <summary>Wire how the receive filter reaches the active adapter (set by the comms pipeline).</summary>
    public void SetReceiveFilterCallback(Action<int?, int?> callback) => _setReceiveFilter = callback;

    /// <summary>
    /// Clamp the active adapter's RX to <paramref name="baseId"/>'s whole id block for the duration of a
    /// read/write/burn exchange, lifting it after <see cref="FilterIdleMs"/> of quiet. The block (not just
    /// the config-reply id) so the module's telemetry keeps flowing during the exchange — clamping to one
    /// id starves the status frames and the UI flickers the device "not found". Re-armed by every config
    /// frame, so a chunked read/write holds it until the burst ends.
    /// </summary>
    private void ArmConfigFilter(int baseId)
    {
        if (_setReceiveFilter is null) return;
        lock (_filterLock)
        {
            if (_filterOwned) return;
            // Only on a flooded bus: narrowed, the bridge drops every other module's frames, and on a normal bus that
            // cost more than it saved (a module's wake announcement, sent while the app talked to another, was lost).
            if (!BusFlooded) return;
            // The filter passes ONE module's block. When exchanges with two modules overlap (opening a project asks
            // every module for its version and CRC while a write is still running), narrowing to the newer one hid
            // the older one's reply: its write was never confirmed. Overlapping: open the filter until it is quiet.
            var other = (_filterBase is { } b && b != baseId) || _confirms.Keys.Any(k => k.BaseId != baseId);
            if (other || _filterBase == -1)
            {
                _filterBase = -1;
                _setReceiveFilter(null, null);
                domain.Devices.RxFilterWindow.Lift();
            }
            else
            {
                _filterBase = baseId;
                _setReceiveFilter(baseId, baseId + 15);   // config reply (base+0), status (base+2..) and XCP (base+12/13)
                domain.Devices.RxFilterWindow.Narrow(baseId, baseId + 15);   // the other modules aren't gone, just hidden
            }
            _filterIdleTimer ??= new System.Threading.Timer(_ =>
            {
                lock (_filterLock) { _filterBase = null; _setReceiveFilter?.Invoke(null, null); domain.Devices.RxFilterWindow.Lift(); }
            });
            _filterIdleTimer.Change(FilterIdleMs, Timeout.Infinite);
        }
    }
    private int? _filterBase;   // module the filter passes now; -1 = open because exchanges overlap; null = lifted
    // Bus load, measured while the filter is open (narrowed, it hides most frames): frames per second.
    private long _rxWindowStart = Environment.TickCount64, _rxInWindow, _rxRate;
    private const long FloodedFramesPerSecond = 2500;   // ~60 % of a 500 kbit/s bus of 8-byte frames
    private bool BusFlooded => Interlocked.Read(ref _rxRate) > FloodedFramesPerSecond;
    private void CountFrame()
    {
        if (_filterBase >= 0) return;
        Interlocked.Increment(ref _rxInWindow);
        var now = Environment.TickCount64;
        if (now - _rxWindowStart < 1000) return;
        Interlocked.Exchange(ref _rxRate, Interlocked.Exchange(ref _rxInWindow, 0) * 1000 / Math.Max(1, now - _rxWindowStart));
        _rxWindowStart = now;
    }

    /// <summary>
    /// Stop the idle auto-lift so an external filter owner (the CAN flasher, which clamps to the XCP
    /// reply id across the bootloader handoff) isn't cleared out from under it by a recently-armed config
    /// exchange. The next read/write/burn re-arms the filter normally.
    /// </summary>
    public void SuspendConfigFilter()
    {
        lock (_filterLock) { _filterIdleTimer?.Change(Timeout.Infinite, Timeout.Infinite); _filterOwned = true; }
    }

    /// <summary>The flash is over: config exchanges arm the filter again.</summary>
    public void ResumeConfigFilter()
    {
        lock (_filterLock) { _filterOwned = false; _filterBase = null; }
    }
    // A CAN flash owns the filter (the bootloader's reply id): a version request or config check sent meanwhile
    // (a module reconnecting after its own update) re-aimed it at that module and the bootloader's replies were lost.
    private bool _filterOwned;

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
    public Guid AddDevice(string deviceType, string name, int baseId)
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
        return device.Guid;
    }

    /// <summary>Add a device of the same kind as <paramref name="sourceId"/> (PDM model included) at another
    /// base id — e.g. a temporary entry to reach a module on USB before a profile is written to it.</summary>
    public Guid? AddLike(Guid sourceId, string name, int baseId) => GetDevice(sourceId) switch
    {
        PdmDevice p => AddDevice($"pdm:{p.PdmType}", name, baseId),
        CanboardDevice => AddDevice("canboard", name, baseId),
        _ => null,
    };

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
        var snapshot = _devices.Values.ToArray();   // stable copy — callers enumerate while devices mutate
        foreach (var device in snapshot)
        {
            if(device.UpdateIsConnected())
                CheckConfig(device.Guid);
            else
                RecheckUnanswered(device);
        }

        return snapshot;
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

        if (_devices.TryRemove(deviceId, out var device))
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
        // waiting edits belong to the project that was open (what the modules know, like their Lua, stays)
        foreach (var ui in _deviceUiState.Values) lock (ui.Edits) ui.Edits.Clear();
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
            else
                RecheckUnanswered(device);
        }

        return devices;
    }

    public void CheckConfig(Guid deviceId)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable deviceConfigurable) return;
        // A module that said goodbye is going to sleep (its goodbye is the frame that "reconnected" it): a request
        // now would be CAN traffic and wake the whole car. Check once it is really awake again (NoteAwake).
        var ui = GetDeviceUiState(deviceId);
        if (ui.Asleep) { ui.CheckAfterWake = true; return; }
        // Firmware not known yet: the app would CRC only the oldest firmware's params and call a module "in step"
        // that lost its newer settings. Ask which firmware it runs; the check runs when the answer comes.
        if (!VersionKnown(device)) { ui.CheckAfterVersion = true; RequestVersion(deviceId); return; }
        // Called only on the connect edge: assume out-of-sync until a Read/Write (or CRC match)
        // confirms otherwise, so the UI prompts the operator to Read the device before editing.
        deviceConfigurable.ConfigMismatch = true;
        deviceConfigurable.LastConfigDiff = new List<domain.Models.ConfigDiffEntry>();
        ui.CheckAskedAt = DateTime.UtcNow; ui.CheckRetries = 0;
        var msg = deviceConfigurable.GetCheckMsg();
        QueueMessage(msg);
        // Upstream: is it locked? A Read of the lock password is refused (58) only while locked; a module without the
        // lock answers "not found", an unlocked one 0. One frame per connect; the reply sets Lock.Locked.
        if (deviceConfigurable.Family == domain.Common.FwFamily.Upstream && (!deviceConfigurable.ParamSet.Known || deviceConfigurable.ParamSet.Contains(domain.Devices.Functions.ConfigLock.BaseIndex, 0)))
            QueueMessage(new DeviceCanFrame { SendOnly = true, DeviceBaseId = device.BaseId, Name = "Lock probe",
                Frame = new CanFrame(device.BaseId + PdmDevice.ConfigTxOffset, 8, [(byte)domain.Enums.MessageCommand.Read, 0x00, 0x02, 0, 0, 0, 0, 0]) });
    }

    /// <summary>
    /// The check on connect got no answer (a module still booting, a busy bus) and nothing was edited since:
    /// ask again, 3 times at most, 15 s apart, so a module in step is not left showing "differs".
    /// </summary>
    private void RecheckUnanswered(IDevice device)
    {
        if (device is not IDeviceConfigurable c || !c.ConfigMismatch || !device.Connected) return;
        var ui = GetDeviceUiState(device.Guid);
        if (ui.Asleep || ui.CheckRetries >= 3 || DateTime.UtcNow - ui.CheckAskedAt < TimeSpan.FromSeconds(15)) return;
        if (_confirms.ContainsKey((device.BaseId, domain.Enums.MessageCommand.WriteAllComplete))) return;   // not into a write: see WriteDeviceConfigConfirmed
        lock (ui.Edits) if (ui.Edits.Count > 0) return;   // a real difference: Apply sorts it
        ui.CheckAskedAt = DateTime.UtcNow; ui.CheckRetries++;
        QueueMessage(c.GetCheckMsg());
    }

    /// <summary>
    /// Called by CommsDataPipeline when CAN data is received
    /// Routes data to all devices so they can update their state/config
    /// </summary>
    public void OnCanDataReceived(CanFrame frame)
    {
        CountFrame();
        RecordWriteOutcome(frame);
        // a PDM's appended/ignition frame on the next module's base+0..: only that PDM reads it, or a silent module looks connected
        var sender = _devices.Values.OfType<PdmDevice>().FirstOrDefault(p => p.SendsAppended(frame.Id));
        foreach (var device in _devices.Values)
        {
            if ((sender == null || device == sender) && device.InIdRange(frame.Id))
            {
                var outgoing = new List<DeviceCanFrame>();
                device.Read(frame.Id, frame.Payload, ref _requestQueue, outgoing);
                if (device is IDeviceConfigurable { Migrate57Pending: true } mc) MigrateTo57([mc]);
                if (outgoing.Count > 0)
                    _batchTransmitCallback?.Invoke(outgoing);
                if (frame.Id == device.BaseId) RecordConfirm(device, frame, outgoing);
                else NoteAwake(device);
            }
        }
    }

    // ---- write / burn confirmation ------------------------------------------------------------------
    // Write, Write All and Burn used to be "ok" once queued, so a write that never landed (sent before the
    // module was seen, lost on a busy bus) passed silently and the module kept its old config. The module
    // answers both: WriteAllComplete with the CRC of what it received, BurnParams with a success byte.
    private readonly ConcurrentDictionary<(int BaseId, domain.Enums.MessageCommand Cmd), TaskCompletionSource<bool>> _confirms = new();

    private void RecordConfirm(IDevice device, CanFrame frame, List<DeviceCanFrame> outgoing)
    {
        // the Lua commit reply is 4 bytes: [cmd, lenHi, lenLo, stored ok]
        if (frame.Payload.Length >= 4 && frame.Payload[0] == (byte)domain.Enums.MessageCommand.LuaWriteComplete)
        {
            if (_confirms.TryRemove((device.BaseId, domain.Enums.MessageCommand.LuaWriteComplete), out var lc)) lc.TrySetResult(frame.Payload[3] == 1);
            return;
        }
        if (frame.Payload.Length != 8) return;
        var cmd = (domain.Enums.MessageCommand)frame.Payload[0];
        bool ok;
        if (cmd == domain.Enums.MessageCommand.Version && GetDeviceUiState(device.Guid) is { CheckAfterVersion: true } vu && VersionKnown(device))
        {
            vu.CheckAfterVersion = false;
            CheckConfig(device.Guid);
            return;
        }
        if (cmd == domain.Enums.MessageCommand.WriteAllComplete)
        {
            if (outgoing.Any(f => f.Name == "WriteAll (retry)")) return;   // CRC short, ParamProtocol re-sends: not final
            ok = device is IDeviceConfigurable { ConfigMismatch: false };    // ParamProtocol cleared it on a CRC match
        }
        else if (cmd == domain.Enums.MessageCommand.BurnParams) ok = frame.Payload[4] == 1;
        else if (cmd is domain.Enums.MessageCommand.Unlock or domain.Enums.MessageCommand.FactoryReset or domain.Enums.MessageCommand.Restart)
            ok = frame.Payload[cmd == domain.Enums.MessageCommand.Restart ? 6 : 1] == 1;
        // config lock: a refused WriteAll gets no WriteAllComplete; end the wait now instead of after 30 s
        else if (cmd == domain.Enums.MessageCommand.Locked)
        {
            var refused = frame.Payload[4] is (byte)domain.Enums.MessageCommand.WriteAll or (byte)domain.Enums.MessageCommand.WriteAllModified
                ? domain.Enums.MessageCommand.WriteAllComplete : (domain.Enums.MessageCommand)frame.Payload[4];
            if (_confirms.TryRemove((device.BaseId, refused), out var lt)) lt.TrySetResult(false);
            return;
        }
        else if (cmd == domain.Enums.MessageCommand.Identify) { GetDeviceUiState(device.Guid).HasLed = frame.Payload[2] != 0; ok = true; }
        else if (cmd == domain.Enums.MessageCommand.OutputTest) { GetDeviceUiState(device.Guid).TestReplied = true; ok = frame.Payload[7] == 1; }
        else if (cmd == domain.Enums.MessageCommand.ResetCause) { GetDeviceUiState(device.Guid).ResetFlags = frame.Payload[1]; ok = true; }
        else if (cmd == domain.Enums.MessageCommand.FaultLogRead) { GetDeviceUiState(device.Guid).FaultLogRx[frame.Payload[1]] = frame.Payload.ToArray(); return; }
        else if (cmd == domain.Enums.MessageCommand.FaultLogClear) ok = frame.Payload[1] == 1;
        else if (cmd == domain.Enums.MessageCommand.SleepInfo)
        {
            var ui = GetDeviceUiState(device.Guid);
            ui.WakeReason = frame.Payload[1]; ui.WakeSource = frame.Payload[2];
            ui.WakeCount = frame.Payload[3] | frame.Payload[4] << 8;
            ui.SleepBlockers = frame.Payload[6];
            if (device is PdmDevice pdm) pdm.SleepInfoSeen = true;
            ui.CheckRetries = 0; ui.CheckAskedAt = DateTime.UtcNow;   // it (re)booted: unanswered config checks get another round
            // the module announces it after every boot (5.6.3) and answers when asked: log each wake once
            if (!ui.WakeLogged)
            {
                ui.WakeLogged = true;
                var why = WakeWhy(device, ui.WakeReason ?? 0, ui.WakeSource);
                ui.LogSleep("wake", why);
                logger.LogInformation("{Name} is awake: {Why}", device.Name, why);
            }
            return;
        }
        // "going to sleep" (firmware 5.6): [Sleep, 'Z', 'Z', 'Z', why, ...]
        else if (cmd == domain.Enums.MessageCommand.Sleep && frame.Payload[1] == 'Z' && frame.Payload[2] == 'Z' && frame.Payload[3] == 'Z')
        {
            var ui = GetDeviceUiState(device.Guid);
            ui.Asleep = true; ui.AsleepSince = DateTime.UtcNow; ui.SleepInfoAsked = false; ui.WakeLogged = false;
            var why = frame.Payload[4] switch
            {
                1 => "nothing kept it awake (no CAN traffic, no output on) for its sleep delay",
                2 => "its force-sleep input is on",
                3 => "it was asked to sleep (Sleep now)",
                4 => "the car sleeps with the ignition (ignition, door and dash off for the sleep delay)",   // firmware 5.7
                _ => "reason not given",
            };
            ui.LogSleep("sleep", why);
            logger.LogInformation("{Name} is going to sleep: {Why}", device.Name, why);
            return;
        }
        else { if (cmd == domain.Enums.MessageCommand.Write) GetDeviceUiState(device.Guid).StoredOnModule = false; return; }
        if (ok && cmd is not (domain.Enums.MessageCommand.Identify or domain.Enums.MessageCommand.ResetCause or domain.Enums.MessageCommand.OutputTest or domain.Enums.MessageCommand.FaultLogClear or domain.Enums.MessageCommand.Unlock or domain.Enums.MessageCommand.Restart)) GetDeviceUiState(device.Guid).StoredOnModule = cmd == domain.Enums.MessageCommand.BurnParams;
        if (_confirms.TryRemove((device.BaseId, cmd), out var tcs)) tcs.TrySetResult(ok);
    }

    private async Task<bool> Confirmed(IDevice device, domain.Enums.MessageCommand cmd, Func<bool> send, int timeoutMs)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _confirms[(device.BaseId, cmd)] = tcs;
        if (!send()) { _confirms.TryRemove((device.BaseId, cmd), out _); return false; }
        var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs)) == tcs.Task && tcs.Task.Result;
        _confirms.TryRemove(new KeyValuePair<(int, domain.Enums.MessageCommand), TaskCompletionSource<bool>>((device.BaseId, cmd), tcs));
        return done;
    }

    /// <summary>Write (changed params, or all) and wait until the module reports it received them (CRC match).
    /// False on a CRC mismatch after the retries or no answer within 30 s — the module keeps its old config.</summary>
    public async Task<bool> WriteDeviceConfigConfirmed(Guid deviceId, bool all)
    {
        if (GetDevice(deviceId) is not { } d) return false;
        // A Write All resets every param the app does not send to its default, and until the module reports its
        // firmware the app sends only the oldest firmware's params: a write then wiped the newer settings (math
        // blocks, CAN messages, ignition…). Learn the version first; without it, do not write.
        if (!await EnsureVersionAsync(d)) { logger.LogWarning("{Name}: firmware version unknown, not writing (it would reset its newer settings)", d.Name); return false; }
        // Upstream: the WriteAll must hold exactly the module's params, so learn them (Read) first. A record from a
        // project file keeps its values on that Read (KeepValuesOnRead), so do it here instead of refusing the Apply.
        if (!ParamsKnown(d) && d is IDeviceConfigurable { KeepValuesOnRead: true } kd && !OlderLine(d))
        {
            logger.LogInformation("{Name}: learning its list of settings (Read, the project's values are kept) before writing", d.Name);
            ReadDeviceConfig(deviceId);
            for (var t = 0; t < 600 && !kd.ParamSet.FromModule; t++) await Task.Delay(100);   // ~1 s on a module, longer on a busy bus
        }
        if (!ParamsKnown(d)) { logger.LogWarning("{Name}: upstream firmware, its param list is not read yet: not writing", d.Name); return false; }
        return await Confirmed(d, domain.Enums.MessageCommand.WriteAllComplete, () => all ? WriteAllDeviceConfig(deviceId) : WriteDeviceConfig(deviceId), 30000);
    }

    public static bool VersionKnown(IDevice d) => d is IDeviceConfigurable { VersionReceived: true };

    /// <summary>Upstream firmware: Apply needs the module's own param list (from a Read this session). Fork: always.</summary>
    public static bool ParamsKnown(IDevice d) => d is not IDeviceConfigurable c || c.Family != domain.Common.FwFamily.Upstream || (c.ParamSet.FromModule && !OlderLine(d));

    /// <summary>The record has the 5.7 layout (migrated) but the module reports fork 5.0-5.6: neither Read nor Apply fits.</summary>
    public static bool OlderLine(IDevice d) => d is IDeviceConfigurable { VersionReceived: true } c && c.Family == domain.Common.FwFamily.Upstream
        && domain.Common.Firmware.Of(c.Version) is var v && domain.Common.FwFamily.Of(v.Major, v.Minor) == domain.Common.FwFamily.Fork;

    /// <summary>Convert fork-5.x records to the 5.7 layout (domain.Common.Fw57Migration): automatically when a configured fork
    /// record's module reports 5.7+, or on demand. The report lands on each device (Migration).</summary>
    public void MigrateTo57(IEnumerable<IDeviceConfigurable> targets)
    {
        var list = targets.Where(t => t.Family == domain.Common.FwFamily.Fork).ToList();
        if (list.Count == 0) return;
        domain.Common.Fw57Migration.Migrate(_devices.Values.ToList(), list);
        foreach (var d in list)
        {
            var warn = d.Migration?.Count(n => n.Level == "warn") ?? 0;
            logger.LogWarning("{Name}: project converted to the firmware 5.7 layout ({Warn} warning(s))", d.Name, warn);
            foreach (var n in d.Migration ?? []) logger.LogInformation("{Name} migration [{Level}] {Text}", d.Name, n.Level, n.Text);
            systemLogger.Notify(d.Name, $"Project converted to firmware 5.7{(warn > 0 ? $", {warn} warning(s)" : "")}: see the module's migration report. Read it, then Apply to car and Store.",
                warn > 0 ? application.Models.LogLevel.Warning : application.Models.LogLevel.Info);
        }
    }

    /// <summary>Ask for the firmware version unless it is known, and wait up to <paramref name="ms"/> for it.</summary>
    public async Task<bool> EnsureVersionAsync(IDevice d, int ms = 4000)
    {
        if (VersionKnown(d)) return true;
        RequestVersion(d.Guid);
        for (var until = DateTime.UtcNow.AddMilliseconds(ms); DateTime.UtcNow < until && !VersionKnown(d);) await Task.Delay(50);
        return VersionKnown(d);
    }

    /// <summary>G12 (firmware 5.6): blink the module's LEDs for <paramref name="seconds"/> s. Waits for the reply
    /// (2 s); the reply says whether the board has an LED (a CANBoard has none).</summary>
    public Task<bool> IdentifyConfirmed(Guid deviceId, int seconds) => GetDevice(deviceId) is { } d
        ? Confirmed(d, domain.Enums.MessageCommand.Identify, () =>
        {
            QueueMessage(new DeviceCanFrame
            {
                SendOnly = true, DeviceBaseId = d.BaseId, Name = "Identify",
                Frame = new CanFrame(d.BaseId + PdmDevice.ConfigTxOffset, 8,
                    [Convert.ToByte(domain.Enums.MessageCommand.Identify), (byte)Math.Clamp(seconds, 1, 60), 0, 0, 0, 0, 0, 0])
            });
            return true;
        }, 2000)
        : Task.FromResult(false);

    /// <summary>Upstream feat/reset-cause: ask why the module last reset; waits for the reply (2 s), which lands in
    /// DeviceUiState.ResetFlags.</summary>
    public Task<bool> ResetCauseConfirmed(Guid deviceId) => GetDevice(deviceId) is { } d
        ? Confirmed(d, domain.Enums.MessageCommand.ResetCause, () =>
        {
            QueueMessage(new DeviceCanFrame
            {
                SendOnly = true, DeviceBaseId = d.BaseId, Name = "Reset cause",
                Frame = new CanFrame(d.BaseId + PdmDevice.ConfigTxOffset, 8, [Convert.ToByte(domain.Enums.MessageCommand.ResetCause), 0, 0, 0, 0, 0, 0, 0])
            });
            return true;
        }, 2000)
        : Task.FromResult(false);

    /// <summary>Upstream feat/fault-history: read the module's fault history, newest first, and its boot count.
    /// null when the module does not answer (firmware without it).</summary>
    public async Task<(int BootCount, List<domain.Common.FaultLogEntry> Entries)?> ReadFaultLog(Guid deviceId)
    {
        if (GetDevice(deviceId) is not { } d) return null;
        var rx = GetDeviceUiState(deviceId).FaultLogRx;
        async Task<(byte[] A, byte[] B)?> Ask(int n)
        {
            for (var attempt = 0; attempt < 2; attempt++)
            {
                rx.TryRemove(n, out _); rx.TryRemove(n | 0x80, out _);
                QueueMessage(new DeviceCanFrame
                {
                    SendOnly = true, DeviceBaseId = d.BaseId, Name = "Fault log read",
                    Frame = new CanFrame(d.BaseId + PdmDevice.ConfigTxOffset, 8, [Convert.ToByte(domain.Enums.MessageCommand.FaultLogRead), (byte)n, 0, 0, 0, 0, 0, 0])
                });
                for (var w = 0; w < 1000; w += 10)
                {
                    if (rx.TryGetValue(n, out var a) && rx.TryGetValue(n | 0x80, out var b)) return (a, b);
                    await Task.Delay(10);
                }
            }
            return null;
        }
        if (await Ask(0) is not { } first) return null;
        var entries = new List<domain.Common.FaultLogEntry>();
        var count = Math.Min(domain.Common.FaultLog.Count(first.A), domain.Common.FaultLog.Size);
        for (var n = 0; n < count; n++)
        {
            var f = n == 0 ? first : await Ask(n);
            if (f is { } x && domain.Common.FaultLog.Decode(n, x.A, x.B) is { } e) entries.Add(e);
        }
        // past the count the boot field is the current boot count (entry 0 already is one on an empty log)
        var boot = count == 0 ? domain.Common.FaultLog.Boot(first.A) : await Ask(0x7F) is { } c ? domain.Common.FaultLog.Boot(c.A) : 0;
        return (boot, entries);
    }

    /// <summary>Upstream feat/fault-history: clear the module's fault history; true once it confirmed.</summary>
    public Task<bool> ClearFaultLogConfirmed(Guid deviceId) => GetDevice(deviceId) is { } d
        ? Confirmed(d, domain.Enums.MessageCommand.FaultLogClear, () =>
        {
            QueueMessage(new DeviceCanFrame
            {
                SendOnly = true, DeviceBaseId = d.BaseId, Name = "Fault log clear",
                Frame = new CanFrame(d.BaseId + PdmDevice.ConfigTxOffset, 8, [Convert.ToByte(domain.Enums.MessageCommand.FaultLogClear), 0, 0, 0, 0, 0, 0, 0])
            });
            return true;
        }, 2000)
        : Task.FromResult(false);

    // SleepInfo wake reason in words; a digital input by its name in the project
    private static string WakeWhy(IDevice device, int reason, int source) => reason switch
    {
        1 => "woke on CAN traffic",
        2 => $"woke on digital input {source}" + (InputName(device, source) is { Length: > 0 } n ? $" ({n})" : ""),
        3 => "woke on USB",
        _ => "powered on (or reset)",
    };
    private static string? InputName(IDevice device, int n) => device switch
    {
        PdmDevice p => p.Inputs.FirstOrDefault(i => i.Number == n)?.Name,
        domain.Devices.Canboard.CanboardDevice c => c.DigitalInputs.FirstOrDefault(i => i.Number == n)?.Name,
        _ => null,
    };

    /// <summary>G14 (firmware 5.6): ask why the module last woke; the reply lands in its DeviceUiState.</summary>
    public void RequestSleepInfo(Guid deviceId)
    {
        if (GetDevice(deviceId) is not { } d) return;
        QueueMessage(new DeviceCanFrame
        {
            SendOnly = true, DeviceBaseId = d.BaseId, Name = "Sleep info",
            Frame = new CanFrame(d.BaseId + PdmDevice.ConfigTxOffset, 8, [Convert.ToByte(domain.Enums.MessageCommand.SleepInfo), 0, 0, 0, 0, 0, 0, 0])
        });
    }

    // A status frame: the module is awake. A 5.6 module is asked once per wake why it woke (one frame, right
    // after it started talking again, so it never keeps a sleeping car awake).
    private void NoteAwake(IDevice device)
    {
        var ui = GetDeviceUiState(device.Guid);
        // status frames still in flight just after the goodbye (the module flushes ~100 ms before it stops): not a
        // wake. Asking SleepInfo now would itself wake the module (any CAN frame does).
        if (ui.Asleep && DateTime.UtcNow - ui.AsleepSince < TimeSpan.FromSeconds(1)) return;
        ui.Asleep = false;
        if (ui.CheckAfterWake) { ui.CheckAfterWake = false; CheckConfig(device.Guid); }
        if (device is not IDeviceConfigurable c) return;
        // version unknown (no Read since the project opened): ask once, so firmware 5.6 features show up
        if (!c.VersionReceived)
        {
            if (DateTime.UtcNow - ui.VersionAskedAt > TimeSpan.FromSeconds(30)) { ui.VersionAskedAt = DateTime.UtcNow; RequestVersion(device.Guid); }
            return;
        }
        // upstream dingoFW: asked too; only feat/sleep-wake-info answers (others ignore an unknown command)
        if (!ui.SleepInfoAsked && (c.Family == domain.Common.FwFamily.Upstream || domain.Common.Firmware.Has(c.Version, domain.Devices.Functions.MathFunction.Since)))
        {
            ui.SleepInfoAsked = true;
            RequestSleepInfo(device.Guid);
        }
    }

    // ---- config lock (upstream feat/config-lock) ----
    private Task<bool> SendConfirmed(Guid deviceId, domain.Enums.MessageCommand cmd, Func<int, CanFrame> frame, string name, int ms) => GetDevice(deviceId) is { } d
        ? Confirmed(d, cmd, () => { QueueMessage(new DeviceCanFrame { SendOnly = true, DeviceBaseId = d.BaseId, Name = name, Frame = frame(d.BaseId + PdmDevice.ConfigTxOffset) }); return true; }, ms)
        : Task.FromResult(false);
    /// <summary>Unlock until the module's next restart. False: wrong password, a try within 1 s of a wrong one, or no answer.</summary>
    public Task<bool> UnlockConfirmed(Guid deviceId, uint password) =>
        SendConfirmed(deviceId, domain.Enums.MessageCommand.Unlock, id => domain.Devices.Functions.ConfigLock.UnlockFrame(id, password), "Unlock", 2000);
    /// <summary>Every param to its default except base id and bitrate (password and contact too), applied at once and stored.
    /// True only when the module reports the defaults stored.</summary>
    public Task<bool> FactoryResetConfirmed(Guid deviceId) =>
        SendConfirmed(deviceId, domain.Enums.MessageCommand.FactoryReset, domain.Devices.Functions.ConfigLock.FactoryResetFrame, "Factory reset", 5000);
    /// <summary>Restart the module (unstored settings are lost; a stored lock takes effect).</summary>
    public Task<bool> RestartConfirmed(Guid deviceId) =>
        SendConfirmed(deviceId, domain.Enums.MessageCommand.Restart, domain.Devices.Functions.ConfigLock.RestartFrame, "Restart", 2000);

    /// <summary>Burn and wait for the module's burn reply; false if it reported a failure or never answered (10 s).</summary>
    public Task<bool> BurnSettingsConfirmed(Guid deviceId) => GetDevice(deviceId) is { } d
        ? Confirmed(d, domain.Enums.MessageCommand.BurnParams, () => BurnSettings(deviceId), 10000)
        : Task.FromResult(false);

    private void SetLoggers(IDevice device)
    {
        switch (device)
        {
            case PdmDevice pdmDevice:
                pdmDevice.SetLogger(loggerFactory.CreateLogger<PdmDevice>());
                pdmDevice.SuccessNotification += msg => systemLogger.Notify(pdmDevice.Name, msg);
                pdmDevice.ErrorNotification += msg => systemLogger.Notify(pdmDevice.Name, msg, application.Models.LogLevel.Error);
                pdmDevice.WriteAllIncomplete += () => FallBackToChunkedWrite(pdmDevice);
                break;
            case CanboardDevice canboardDevice:
                canboardDevice.SetLogger(loggerFactory.CreateLogger<CanboardDevice>());
                canboardDevice.SuccessNotification += msg => systemLogger.Notify(canboardDevice.Name, msg);
                canboardDevice.ErrorNotification += msg => systemLogger.Notify(canboardDevice.Name, msg, application.Models.LogLevel.Error);
                canboardDevice.WriteAllIncomplete += () => FallBackToChunkedWrite(canboardDevice);
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

        // Flooded-bus survival: a config exchange (read/write/burn/version/modify — addressed to
        // base+ConfigTxOffset, answered on base+ConfigRxOffset) clamps the adapter's RX to that reply id
        // so a saturated bus can't bury the answer. Skip the Bootloader command — the CAN flasher owns
        // the filter (base+13) across the XCP handoff that immediately follows it.
        if (frame.Frame.Payload.Length > 0 &&
            frame.Frame.Id == frame.DeviceBaseId + PdmDevice.ConfigTxOffset &&
            (domain.Enums.MessageCommand)frame.Frame.Payload[0] != domain.Enums.MessageCommand.Bootloader)
            ArmConfigFilter(frame.DeviceBaseId);

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

    // ---- single-write confirmation --------------------------------------------------------------
    // A Write used to be reported "written" as soon as it was queued; a value the module refused (out of
    // range) never came back and the project silently drifted from the device. The module now answers every
    // single Write: an echo of the stored value (accepted) or WriteAllOutOfRange / WriteAllParamNotFound
    // (refused; out of range carries the value it kept, which ParamProtocol puts back into the project).
    public enum WriteOutcome { Accepted, OutOfRange, NotFound, NoReply }
    public sealed record WriteResult(string Param, int Index, int SubIndex, WriteOutcome Outcome, object? Value);
    private readonly ConcurrentDictionary<(int BaseId, int Index, int SubIndex), WriteOutcome> _writeOutcomes = new();

    private void RecordWriteOutcome(CanFrame frame)
    {
        if (frame.Payload.Length != 8) return;
        var outcome = (domain.Enums.MessageCommand)frame.Payload[0] switch
        {
            domain.Enums.MessageCommand.Write => WriteOutcome.Accepted,
            domain.Enums.MessageCommand.WriteAllOutOfRange => WriteOutcome.OutOfRange,
            domain.Enums.MessageCommand.WriteAllParamNotFound => WriteOutcome.NotFound,
            _ => (WriteOutcome?)null
        };
        if (outcome is null) return;
        // replies come on the module's base id (firmware CONFIG_TX_OFFSET 0); only a pending single Write counts
        var key = (frame.Id, frame.Payload[2] << 8 | frame.Payload[1], (int)frame.Payload[3]);
        if (_requestQueue.TryGetValue(key, out var pending) && pending.Frame.Payload[0] == (byte)domain.Enums.MessageCommand.Write)
            _writeOutcomes[key] = outcome.Value;
    }

    /// <summary>
    /// Run <paramref name="write"/> (which queues single Writes for <paramref name="keys"/>) and wait for the
    /// module's verdict on each: accepted, refused (the project now holds the value the module kept), or no
    /// reply after the retries (~7 s). Values are the project's after the replies.
    /// </summary>
    public async Task<List<WriteResult>> WriteAndConfirm(Guid deviceId, IReadOnlyList<(int Index, int SubIndex)> keys, Action write, int timeoutMs = 8000)
    {
        var device = GetDevice(deviceId);
        var res = new List<WriteResult>();
        if (device is null) return res;
        var k = keys.Select(x => (device.BaseId, x.Index, x.SubIndex)).ToList();
        foreach (var key in k) _writeOutcomes.TryRemove(key, out _);
        write();
        for (var waited = 0; waited < timeoutMs && k.Any(key => !_writeOutcomes.ContainsKey(key)); waited += 50)
            await Task.Delay(50);
        var ps = (device as IDeviceConfigurable)?.Params;
        foreach (var key in k)
        {
            var p = ps?.FirstOrDefault(x => x.Index == key.Index && x.SubIndex == key.SubIndex);
            var o = _writeOutcomes.TryRemove(key, out var got) ? got : WriteOutcome.NoReply;
            res.Add(new WriteResult(p?.Name ?? $"0x{key.Index:X4}:{key.SubIndex}", key.Index, key.SubIndex, o, p?.GetValue()));
        }
        return res;
    }

    /// <summary>The (index, sub) of every device param of one function slot, as WriteFunctionParams writes them.</summary>
    public IReadOnlyList<(int Index, int SubIndex)> FunctionParamKeys(Guid deviceId, int index) =>
        (GetDevice(deviceId) as IDeviceConfigurable) is { } c ? c.Params.Where(p => p.Index == index && !p.LocalOnly && domain.Common.FwFamily.Sends(c, p))
            .Select(p => (p.Index, p.SubIndex)).ToList() : [];

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
            if (frame.Frame.Payload.Length > 0 && frame.Frame.Payload[0] == (byte)domain.Enums.MessageCommand.Write)
                _writeOutcomes[key] = WriteOutcome.NoReply;

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
            if (device is IDeviceConfigurable dc && !domain.Common.FwFamily.Sends(dc, p)) continue;   // upstream: not on this module
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

        var paramList = cfg.Params.Where(p => !p.LocalOnly && domain.Common.FwFamily.Sends(cfg, p)).ToList();
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

        var ps = cfg.Params.Where(p => p.Index == index && !p.LocalOnly && domain.Common.FwFamily.Sends(cfg, p)).ToList();
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
    /// A WriteAll that stays incomplete after its retries (frames lost on a busy bus — the device then keeps
    /// its old config) is finished with acknowledged per-parameter writes instead: each one is retried on its
    /// own, so a lost frame costs one retry instead of the whole batch.
    /// </summary>
    private void FallBackToChunkedWrite(IDevice device)
    {
        logger.LogWarning("{Name} (ID: {BaseId}): Write All incomplete after retries, writing params one by one", device.Name, device.BaseId);
        systemLogger.Notify(device.Name, $"{device.Name}: bus dropped frames during Write All — writing parameters one by one", application.Models.LogLevel.Warning);
        WriteAllParamsChunked(device.Guid);
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
            .Where(p => !p.LocalOnly && (!modifiedOnly || p.IsModified) && domain.Common.FwFamily.Sends(cfg, p))
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
            // let the queue drain (each write is acknowledged or retried) before reporting
            for (var waits = 0; _requestQueue.Count > 0 && waits < 2000; waits++) Thread.Sleep(5);
            systemLogger.Notify(device.Name, $"{device.Name}: wrote {paramList.Count} params one by one — burn to keep them");
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

    /// <summary>Bench test an output (firmware ≥ 5.5.107, MsgCmd 48): mode 0 release, 1 on, 2 PWM at duty/freq, held
    /// for holdSec. PDM Profet outputs and CANBoard digital outputs answer the same command at base+1. Send-only —
    /// the module releases by itself when the hold expires.</summary>
    public bool TestOutput(Guid deviceId, int number, int mode, int duty, int freq, int holdSec)
    {
        var dev = GetDevice(deviceId);
        if (dev is not (PdmDevice or CanboardDevice)) return false;
        QueueMessage(new DeviceCanFrame
        {
            SendOnly = true,
            DeviceBaseId = dev.BaseId,
            Frame = new CanFrame(dev.BaseId + PdmDevice.ConfigTxOffset, 8,
                [Convert.ToByte(domain.Enums.MessageCommand.OutputTest), (byte)(number - 1), (byte)mode, (byte)duty,
                 (byte)(freq & 0xFF), (byte)(freq >> 8), (byte)holdSec, 0]),
            Name = $"Test output {number}"
        });
        return true;
    }

    /// <summary>Bench test and wait for the module's echo (byte 7 = accepted). true accepted, false refused, null no
    /// reply: the firmware has no output test (upstream dingoFW without feat/output-bench-test).</summary>
    public async Task<bool?> TestOutputConfirmed(Guid deviceId, int number, int mode, int duty, int freq, int holdSec, int timeoutMs = 1000)
    {
        if (GetDevice(deviceId) is not { } d) return null;
        var ui = GetDeviceUiState(deviceId);
        ui.TestReplied = false;
        var ok = await Confirmed(d, domain.Enums.MessageCommand.OutputTest, () => TestOutput(deviceId, number, mode, duty, freq, holdSec), timeoutMs);
        return ok ? true : ui.TestReplied ? false : null;
    }

    /// <summary>
    /// Upload one assembled Lua program to the device, chunked (5 source bytes per
    /// frame) and paced so the device's RX mailbox can't overflow. The firmware
    /// stores it, persists to FRAM, and recompiles. Frames are send-only (acks are
    /// observed on the bus but not awaited here).
    /// </summary>
    /// <summary>Store a Lua program on the device RECORD only (no CAN). Persists in the project JSON
    /// so cross-module / authored Lua survives offline; push it with UploadLua when the module is live.</summary>
    public void StoreLua(Guid deviceId, string source)
    {
        if (GetDevice(deviceId) is PdmDevice p) p.LuaProgram = source ?? string.Empty;
    }

    /// <summary>The Lua program stored on the device record (empty for non-PDM / none stored).</summary>
    public string GetStoredLua(Guid deviceId) => GetDevice(deviceId) is PdmDevice p ? p.LuaProgram : string.Empty;

    /// <summary>Upload and wait for the read-back verify + commit. False when refused, not verified, or not done
    /// within 90 s — the module then keeps its previous program. Uploads must not overlap: run them one at a time.</summary>
    /// <summary>Firmware LUA_SCRIPT_MAX; upstream / 5.7 stores at most 4095 bytes (it clamps the length).</summary>
    public static int LuaMax(PdmDevice p) => p.Family == domain.Common.FwFamily.Upstream ? 4095 : 4096;

    public async Task<bool> UploadLuaAsync(Guid deviceId, string source)
    {
        var up = StartLuaUpload(deviceId, source);
        var ok = up != null && await Task.WhenAny(up, Task.Delay(TimeSpan.FromSeconds(90))) == up && up.Result;
        if (ok) GetDeviceUiState(deviceId).LuaOnModule = source ?? "";
        return ok;
    }

    /// <summary>Start a Lua upload; null when refused (too big / not a PDM). The task completes true once the
    /// program was read back identical and committed (LuaWriteComplete), false if it never verified or the
    /// device record went away mid-upload.</summary>
    public Task<bool>? StartLuaUpload(Guid deviceId, string source)
    {
        var device = GetDevice(deviceId);
        if (device is null) return null;

        // Only the PDMs run an embedded Lua engine (firmware HAS_LUA). A CANBoard / DBC / keypad
        // has none — refuse here so no path (cross-module deploy, drawer, MCP) can ever push Lua
        // frames to a device that would silently ignore or mis-parse them.
        // Upstream dingoFW: only once the module answered a Lua command (feat/lua-scripting firmware).
        if (device is not PdmDevice { RunsLua: true } pdm)
        {
            logger.LogWarning("UploadLua refused: {Name} ({Type}) has no Lua engine", device.Name, device.Type);
            return null;
        }

        var bytes = System.Text.Encoding.ASCII.GetBytes(source ?? string.Empty);
        if (bytes.Length > LuaMax(pdm)) return null;
        int txId = device.BaseId + 1;             // ConfigTxOffset — device RX channel

        logger.LogInformation("UploadLua starting: {Len} bytes to {Name} (txId 0x{TxId:X})", bytes.Length, device.Name, txId);
        void SendChunk(int off)
        {
            var p = new byte[8];
            p[0] = (byte)domain.Enums.MessageCommand.LuaWrite;
            p[1] = (byte)(off >> 8); p[2] = (byte)(off & 0xFF);
            for (int i = 0; i < 5 && off + i < bytes.Length; i++) p[3 + i] = bytes[off + i];
            QueueMessage(new DeviceCanFrame
            {
                DeviceBaseId = device.BaseId, SendOnly = true, Name = "LuaWrite",
                Frame = new CanFrame(txId, 8, p)
            });
        }

        return Task.Run(async () =>
        {
            try
            {
                for (int off = 0; off < bytes.Length; off += 5)
                {
                    if (GetDevice(deviceId) == null) return false;
                    SendChunk(off);
                    Thread.Sleep(3);
                }
                // The chunks are fire-and-forget: one lost frame left a 5-byte hole that the firmware then
                // compiled on LuaWriteComplete ("'then' expected near 'treturn'"). Read the program back and
                // re-send what differs; commit only a verified copy. The firmware persists and recompiles on
                // Complete alone, so a failed upload leaves the running program and the stored one untouched.
                var bad = new List<int>();
                for (int round = 0; round < 3; round++)
                {
                    var back = System.Text.Encoding.ASCII.GetBytes(await ReadLua(deviceId));
                    bad.Clear();
                    for (int off = 0; off < bytes.Length; off += 5)
                        for (int i = off; i < Math.Min(off + 5, bytes.Length); i++)
                            if (i >= back.Length || back[i] != bytes[i]) { bad.Add(off); break; }
                    if (bad.Count == 0) break;
                    logger.LogWarning("UploadLua: {Count} chunk(s) to {Name} did not arrive, re-sending (round {Round})", bad.Count, device.Name, round + 1);
                    foreach (var off in bad) { SendChunk(off); Thread.Sleep(3); }
                }
                if (bad.Count > 0)
                {
                    logger.LogError("UploadLua failed for {Name}: {Count} chunk(s) still wrong after 3 re-sends; not committed, the device keeps its previous program", device.Name, bad.Count);
                    return false;
                }
                // wait for the module to store it: it writes its config then (seconds on a slow store), and a read
                // started before that finished got no answer and came back empty
                var stored = await Confirmed(device, domain.Enums.MessageCommand.LuaWriteComplete, () =>
                {
                    QueueMessage(new DeviceCanFrame
                    {
                        DeviceBaseId = device.BaseId, SendOnly = true, Name = "LuaWriteComplete",
                        Frame = new CanFrame(txId, 8,
                            [(byte)domain.Enums.MessageCommand.LuaWriteComplete, (byte)(bytes.Length >> 8), (byte)(bytes.Length & 0xFF), 0, 0, 0, 0, 0])
                    });
                    return true;
                }, 10000);
                if (!stored)
                {
                    logger.LogError("UploadLua: {Name} did not confirm storing the program", device.Name);
                    return false;
                }
                logger.LogInformation("UploadLua done: {Len} bytes to {Name}, verified by read-back", bytes.Length, device.Name);
                return true;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "UploadLua failed for {Name}", device.Name);
                return false;
            }
        });
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
    /// <returns>null when the module never answered the count request (upstream firmware without the trip log).</returns>
    public async Task<List<OverloadLogEntry>?> ReadOverloadLog(Guid deviceId)
    {
        var result = new List<OverloadLogEntry>();
        var p = GetDevice<PdmDevice>(deviceId);
        if (p == null) return result;

        p.OvlCountRx = -1;
        QueueMessage(p.GetOvlCountMsg());
        int waited = 0;
        while (p.OvlCountRx < 0 && waited < 500) { await Task.Delay(10); waited += 10; }
        if (p.OvlCountRx < 0) return null;
        // 5.6: a time in the module's uptime becomes a clock time against the uptime it just reported
        var answeredAt = DateTime.UtcNow;
        long uptime = p.OvlUptimeRx;
        DateTime? At(long t) => uptime >= 0 && t > 0 && t <= uptime ? answeredAt.AddMilliseconds(t - uptime) : null;
        async Task<DateTime?> TripTime(int idx)
        {
            if (uptime < 0) return null;
            p.OvlTimeRxIdx = -1;
            QueueMessage(p.GetOvlTimeMsg(idx));
            for (int w = 0; p.OvlTimeRxIdx != idx && w < 500; w += 10) await Task.Delay(10);
            return p.OvlTimeRxIdx == idx ? At(p.OvlTimeRxMs) : null;
        }

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
            result.Add(new OverloadLogEntry(outNum + 1, state.ToString(), peak, limit, pts, await TripTime(idx)));
        }

        // 5.6 notices: an output went into Warning or OpenLoad (time and kind only)
        for (int j = 0; j < Math.Min(p.OvlNoticeCountRx, 16); j++)
        {
            p.OvlNoticeRxIdx = -1;
            QueueMessage(p.GetOvlNoticeMsg(j));
            for (int w = 0; p.OvlNoticeRxIdx != j && w < 500; w += 10) await Task.Delay(10);
            if (p.OvlNoticeRxIdx != j || p.OvlNoticeOut == 0xFF) continue;
            var kind = p.OvlNoticeKind == 2 ? "openload" : "warning";
            result.Add(new OverloadLogEntry(p.OvlNoticeOut + 1, kind == "openload" ? "OpenLoad" : "Warning", 0, 0, [], At(p.OvlNoticeMs), kind));
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
    /// <param name="atBaseId">Send to this base id instead of the project record's — the USB bridge's real id
    /// (from its 'I' identify), which differs when the record and the module disagree (a fresh 0xDE module,
    /// a re-address that wasn't burned).</param>
    public bool RequestBootloader(Guid deviceId, bool canUpdate = false)
    {
        var device = GetDevice(deviceId);
        if (device is not IDeviceConfigurable configurable)
            return false;

        var bootloaderMsg = configurable.GetBootloaderMsg(canUpdate);
        if (bootloaderMsg == null)
        {
            logger.LogInformation("No bootloader msg for {DeviceName} (Guid: {Guid})", device.Name, deviceId);
            return false;    
        }
        
        QueueMessage(bootloaderMsg);

        logger.LogInformation("Enter bootloader on {DeviceName} (Guid: {Guid})", device.Name, deviceId);
        return true;
    }

    /// <summary>
    /// Command the PDM on the USB link (at the base id its 'I' identify reported) into USB-DFU. Needs no project
    /// entry and no telemetry — the USB-DFU flash path, for a fresh module as much as a known one.
    /// </summary>
    public void RequestUsbBootloaderAt(int baseId)
    {
        QueueMessage(PdmDevice.BootloaderMsg(baseId, canUpdate: false));
        logger.LogInformation("Enter USB-DFU bootloader on the module on USB (0x{BaseId:X})", baseId);
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
// At (firmware 5.6) = when it happened (UTC), from the module's uptime; null on older firmware. Kind: "trip", or
// "warning" / "openload" for a notice (no waveform).
public record OverloadLogEntry(int Output, string State, double PeakA, double LimitA, List<OvlPoint> Samples,
    DateTime? At = null, string Kind = "trip");