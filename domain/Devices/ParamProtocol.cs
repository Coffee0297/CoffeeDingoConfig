using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.Functions;
using domain.Enums;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace domain.Devices;

internal class ParamProtocol(IDeviceConfigurable device, List<DeviceParameter> @params)
{
    private ILogger _logger = NullLogger.Instance;

    // Only the params the device actually stores. LocalOnly entries (output name / wire labels —
    // strings and doubles at fake sub-indices) have no CAN counterpart: encoding them threw in
    // WriteAll/CalcCrc, and a ReadAll reset them to defaults and reported them as "appOnly".
    // Also only the ones this module's firmware has (DeviceParameter.MinFirmware): until it reports its
    // version it is treated as the oldest, so new params are never sent to a module that refuses them.
    // Upstream family: the params in the list the module returned on its last full Read (FwFamily.Has).
    private List<DeviceParameter> _params => @params.Where(p => !p.LocalOnly && FwFamily.Has(device, p)).ToList();
    private bool Upstream => device.Family == FwFamily.Upstream;
    // Upstream: a full ReadAll is how the app learns the module's params, so it matches against every param of
    // the family layout, not only the (maybe still unknown) list.
    private List<DeviceParameter> ReadCandidates => Upstream && !_readModifiedOnly ? @params.Where(p => !p.LocalOnly).ToList() : _params;
    // Called after a full upstream Read learned the module's param list (the device rebuilds what depends on it).
    public Action? ParamSetLearned;

    private readonly Dictionary<(int Index, int SubIndex), object> _tempParamValues = new();
    private int _readAllCount;
    // ReadAllModified: the device sends only non-default params, so one it didn't send is AT its default.
    private bool _readModifiedOnly;
    private int _writeAllCount;
    // A busy bus can drop a frame or two of a 600-frame WriteAll (the device then keeps its old config):
    // re-run the whole WriteAll a couple of times before reporting failure.
    private const int MaxWriteAllRetries = 2;
    private int _writeAllRetries;
    private MessageCommand _writeAllCmd = MessageCommand.WriteAll;
    public Action<string>? NotifySuccess;
    public Action<string>? NotifyError;
    // Called when a WriteAll is still incomplete after its retries; returns true when the owner took over
    // (an acknowledged per-parameter write). Otherwise the failure is reported through NotifyError.
    public Func<bool>? WriteAllFailed;
    
    private readonly CumulativeCrc32 _writeCrc32 =  new();
    private readonly CumulativeCrc32 _readCrc32 =  new();

    // Tracks the device's actual param set during a Read so we can explain a config mismatch:
    // which params the device returned, and any it sent that this app doesn't know (firmware newer).
    private readonly HashSet<(int Index, int SubIndex)> _readReceived = new();
    private readonly List<ConfigDiffEntry> _deviceOnly = new();
    // Upstream: the order the module sent its params in (= its CRC order) and the raw values of unknown ones.
    private readonly List<(int Index, int SubIndex)> _readOrder = new();
    private readonly Dictionary<(int Index, int SubIndex), uint> _readRaw = new();
    // Upstream: the params a failed full WriteAll did not get (WriteAllMissing), reported with the failure.
    private readonly List<(int Index, int SubIndex)> _writeMissing = new();

    public void SetLogger(ILogger logger) => _logger = logger;

    // The value field (bytes 4..7) of a param reply, converted to the param's type.
    private static object DecodeValue(DeviceParameter p, byte[] data)
    {
        if (p.ValueType == typeof(double))
            return DbcSignalCodec.ExtractSignal(data, startBit: 32, length: 32, isFloat: true);
        var raw = DbcSignalCodec.ExtractSignal(data, startBit: 32, length: 32, isSigned: p.IsSignedInt);
        return p.ValueType switch
        {
            { } t when t == typeof(bool) => raw != 0,
            { } t when t == typeof(int) => (int)raw,
            { IsEnum: true } t => Enum.ToObject(t, (int)raw),
            _ => raw
        };
    }

    public void HandleMessage(
        int baseId,
        int txId,
        string name,
        byte[] data,
        ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> queue,
        List<DeviceCanFrame> outgoing)
    {
        DeviceCanFrame canFrame;
        int index, subIndex;
        DeviceParameter? matchingParam;
        double rawValue;
        object convertedValue;
        (int BaseId, int, int) key;

        switch ((MessageCommand)data[0])
        {
            //Error message commands
            case MessageCommand.ReadParamNotFound:
            case MessageCommand.WriteAllParamNotFound:
            case MessageCommand.WriteAllOutOfRange:
                if (data.Length != 8) return;

                index = data[2] << 8 | data[1];
                subIndex = data[3];

                matchingParam = _params.FirstOrDefault(p => p.Index == index && p.SubIndex == subIndex);

                var paramName = "";
                if (matchingParam != null)
                {
                    paramName = matchingParam.Name;
                }

                key = (baseId, index, subIndex);
                var singleWrite = false;
                if (queue.TryGetValue(key, out canFrame!))
                {
                    singleWrite = canFrame.Frame.Payload.Length > 0 && canFrame.Frame.Payload[0] == (byte)MessageCommand.Write;
                    canFrame.TimeSentTimer?.Dispose();
                    queue.TryRemove(key, out _);
                }
                // A refused single Write carries the value the module kept (firmware 0x0011+): take it, so the
                // project matches the device instead of keeping the value that was never applied.
                if (singleWrite && (MessageCommand)data[0] == MessageCommand.WriteAllOutOfRange && matchingParam is not null)
                    matchingParam.SetValue(DecodeValue(matchingParam, data));

                var errorType = (MessageCommand)data[0] switch
                {
                    MessageCommand.ReadParamNotFound => "Read Param Not Found",
                    MessageCommand.WriteAllParamNotFound => "Write Param Not Found",
                    MessageCommand.WriteAllOutOfRange => "Write Param Out of Range",
                    _ => "Invalid error type"
                };

                _logger.LogError("{Name} ID: {BaseId}, {ErrorType} - {paramName} - 0x{index:X}:{subindex}",
                    name, baseId, errorType, paramName, index, subIndex);

                break;

            case MessageCommand.Read:
            case MessageCommand.Write:
            case MessageCommand.WriteAllVal:
                if (data.Length != 8) return;

                index = data[2] << 8 | data[1];
                subIndex = data[3];

                matchingParam = _params.FirstOrDefault(p => p.Index == index && p.SubIndex == subIndex)
                    // a locked upstream module still answers the contact text, before any Read could teach the list
                    ?? (index == ConfigLock.BaseIndex ? @params.FirstOrDefault(p => p.Index == index && p.SubIndex == subIndex) : null);
                if (matchingParam is null) break;
                if (index != ConfigLock.BaseIndex || subIndex == 0) device.Lock.Locked = false;   // it answered a request a lock refuses (the contact stays open)

                matchingParam.SetValue(DecodeValue(matchingParam, data));

                key = (baseId, index, subIndex);
                if (queue.TryGetValue(key, out canFrame!))
                {
                    canFrame.TimeSentTimer?.Dispose();
                    queue.TryRemove(key, out _);
                }

                break;

            case MessageCommand.ReadAll:
            case MessageCommand.ReadAllModified:
                if (data.Length != 8) return;

                index = data[2] << 8 | data[1];
                subIndex = data[3];

                _readCrc32.Reset();
                _readReceived.Clear();
                _deviceOnly.Clear();
                _readOrder.Clear();
                _readRaw.Clear();

                _readAllCount = 0;
                device.Lock.Locked = false;   // it started sending its config
                _readModifiedOnly = (MessageCommand)data[0] == MessageCommand.ReadAllModified;

                _tempParamValues.Clear();
                foreach (var param in _params)
                    _tempParamValues[(param.Index, param.SubIndex)] = param.DefaultValue;

                key = (baseId, index, subIndex);
                if (queue.TryGetValue(key, out canFrame!))
                {
                    canFrame.TimeSentTimer?.Dispose();
                    queue.TryRemove(key, out _);
                }

                _logger.LogInformation("{Name} ID: {BaseId}, Read All Started", name, baseId);

                break;

            case MessageCommand.ReadAllRsp:
                if (data.Length != 8) return;

                index = data[2] << 8 | data[1];
                subIndex = data[3];

                // CRC every received frame (in send order) so the read completes even when the
                // device's firmware param set differs from this app's — the diff is reported below.
                _readReceived.Add((index, subIndex));
                _readOrder.Add((index, subIndex));
                _readCrc32.Update(data.Skip(4).Take(4).ToArray());
                _readAllCount++;

                matchingParam = ReadCandidates.FirstOrDefault(p => p.Index == index && p.SubIndex == subIndex);
                if (matchingParam is null)
                {
                    _readRaw[(index, subIndex)] = (uint)(data[4] | data[5] << 8 | data[6] << 16 | data[7] << 24);
                    // The device sent a param this app doesn't know — its firmware is newer than the app.
                    var devOnly = DbcSignalCodec.ExtractSignal(data, startBit: 32, length: 32);
                    _deviceOnly.Add(new ConfigDiffEntry($"0x{index:X4}:{subIndex}", index, subIndex, "deviceOnly", null, devOnly.ToString()));
                    _logger.LogWarning("{Name} ID: {BaseId}, device sent unknown param 0x{index:X4}:{subIndex} (firmware newer than app?)", name, baseId, index, subIndex);
                    break;
                }

                if (matchingParam.ValueType == typeof(double))
                {
                    convertedValue = DbcSignalCodec.ExtractSignal(data, startBit: 32, length: 32, isFloat: true);
                }
                else
                {
                    rawValue = DbcSignalCodec.ExtractSignal(data, startBit: 32, length: 32, isSigned: matchingParam.IsSignedInt);

                    // Convert to the appropriate type based on param.ValueType
                    convertedValue = matchingParam.ValueType switch
                    {
                        { } t when t == typeof(bool) => rawValue != 0,
                        { } t when t == typeof(int) => (int)rawValue,
                        { IsEnum: true } t => Enum.ToObject(t, (int)rawValue),
                        _ => rawValue
                    };
                }

                _tempParamValues[(index, subIndex)] = convertedValue;

                break;

            case MessageCommand.ReadAllComplete:
                if (data.Length != 8) return;

                var readAllCount = data[2] << 8 | data[1];
                uint readAllCrc = (uint)(data[7] << 24 | data[6] << 16 | data[5] << 8 | data[4]);

                if (readAllCrc == _readCrc32.Final)
                {
                    // Upstream: a full Read is the module's param list, in its CRC order. Learn it before the diff, so
                    // the diff and every later read/write/CRC use exactly the params this module has.
                    if (Upstream && !_readModifiedOnly)
                    {
                        device.ParamSet.Learn([.. _readOrder], new(_readRaw));
                        ParamSetLearned?.Invoke();
                    }
// Diff the device's values against the app's CURRENT config BEFORE we overwrite them,
                    // so we can explain exactly what didn't match (value diffs + params each side is missing).
                    var diff = new List<ConfigDiffEntry>();
                    foreach (var param in _params)
                    {
                        var paramKey = (param.Index, param.SubIndex);
                        if (param.WriteOnly) continue;   // reads 0 whatever it holds
                        if (!_readReceived.Contains(paramKey) && _readModifiedOnly)
                        {
                            // Not sent in a modified-only read = the device holds the default.
                            if (!ValuesEqual(param.GetValue(), param.DefaultValue))
                                diff.Add(new ConfigDiffEntry(param.Name, param.Index, param.SubIndex, "value", FormatVal(param.GetValue()), FormatVal(param.DefaultValue)));
                        }
                        else if (!_readReceived.Contains(paramKey))
                        {
                            // App has this param but the device never sent it — device firmware older than the app.
                            diff.Add(new ConfigDiffEntry(param.Name, param.Index, param.SubIndex, "appOnly", FormatVal(param.GetValue()), null));
                        }
                        else if (_tempParamValues.TryGetValue(paramKey, out var dv) && !ValuesEqual(param.GetValue(), dv))
                        {
                            diff.Add(new ConfigDiffEntry(param.Name, param.Index, param.SubIndex, "value", FormatVal(param.GetValue()), FormatVal(dv)));
                        }
                    }
                    diff.AddRange(_deviceOnly);
                    device.LastConfigDiff = diff;

                    // End of params, apply all temporary values to actual properties
                    foreach (var param in _params)
                    {
                        var paramKey = (param.Index, param.SubIndex);
                        if (_tempParamValues.TryGetValue(paramKey, out var value))
                        {
                            param.SetValue(value);
                        }
                    }

                    _tempParamValues.Clear();
                    // The app now holds the device's config — they're in sync. Remaining entries are
                    // param-set/version differences, kept for display but no longer a content mismatch.
                    device.ConfigMismatch = false;
                    if (diff.Count == 0)
                        _logger.LogInformation("{Name} ID: {BaseId}, Read complete — config matches ({readAllCount} params)", name, baseId, readAllCount);
                    else
                    {
                        var v = diff.Count(d => d.Kind == "value"); var a = diff.Count(d => d.Kind == "appOnly"); var dz = diff.Count(d => d.Kind == "deviceOnly");
                        _logger.LogWarning("{Name} ID: {BaseId}, Read complete — {n} config difference(s): {v} value, {a} app-only, {d} device-only", name, baseId, diff.Count, v, a, dz);
                        foreach (var d in diff.Take(40))
                            _logger.LogWarning("{Name}: config diff [{kind}] {param} (0x{idx:X4}:{sub}) app='{app}' device='{dev}'", name, d.Kind, d.Name, d.Index, d.SubIndex, d.AppValue ?? "—", d.DeviceValue ?? "—");
                    }
                    NotifySuccess?.Invoke(diff.Count == 0 ? $"{name}: Read Successful — config matches" : $"{name}: Read Successful — {diff.Count} difference(s), see Logs");
                }
                else
                {
                    _tempParamValues.Clear();
                    _logger.LogError("{Name} ID: {BaseId}, Read All Incomplete {pdmCrc} != {thisCrc}, {fromPdm} vs {received}",
                                        name, baseId, readAllCrc, _readCrc32.Final, readAllCount, _readAllCount);
                }

                outgoing.Add(new DeviceCanFrame
                {
                    DeviceBaseId = baseId,
                    SendOnly = true,
                    Frame = new CanFrame(Id: txId, Len: 8, Payload: [Convert.ToByte(MessageCommand.CheckCrc), 0, 0, 0, 0, 0, 0, 0]),
                    Name = "CheckCRC"
                });
                
                break;
                
            case MessageCommand.CheckCrcRsp:
                if (data.Length != 8) return;
                
                uint checkCrc = (uint)(data[7] << 24 | data[6] << 16 | data[5] << 8 | data[4]);
                
                var thisCheck = Upstream ? UpstreamCrc() : CalcCrc();

                // The full-config CRC can only CONFIRM a match (clear the flag) — it must never raise a
                // false mismatch. A non-match here is unactionable on its own (it can mean the device's
                // firmware param set differs from the app's), so the banner is driven by Read/Write sync
                // instead, and the precise reason is reported by the Read diff above.
                if (checkCrc == thisCheck)
                {
                    device.ConfigMismatch = false;
                    device.LastConfigDiff = new List<ConfigDiffEntry>();
                    _logger.LogInformation("{Name} ID: {BaseId}, Config Matches {pdmCrc}", name, baseId, checkCrc);
                }
                else
                    _logger.LogWarning("{Name} ID: {BaseId}, Config CRC differs {pdmCrc} != {thisCrc} — Read the device to see which params differ",
                        name, baseId, checkCrc, thisCheck);

                break;

            case MessageCommand.WriteAll:
                if (data.Length != 8) return;
                
                _writeCrc32.Reset();

                index = data[2] << 8 | data[1];
                subIndex = data[3];

                key = (baseId, index, subIndex);
                if (queue.TryGetValue(key, out canFrame!))
                {
                    canFrame.TimeSentTimer?.Dispose();
                    queue.TryRemove(key, out _);
                }

                //Write all modified values
                _writeAllCmd = MessageCommand.WriteAll;
                outgoing.AddRange(BuildWriteAllMsgs(baseId, txId, allParams: true));

                _logger.LogInformation("{Name} ID: {BaseId}, Write All Started {Count}", name, baseId, _writeAllCount);

                break;
            
            case MessageCommand.WriteAllModified:
                if (data.Length != 8) return;

                _writeCrc32.Reset();
                
                index = data[2] << 8 | data[1];
                subIndex = data[3];

                key = (baseId, index, subIndex);
                if (queue.TryGetValue(key, out canFrame!))
                {
                    canFrame.TimeSentTimer?.Dispose();
                    queue.TryRemove(key, out _);
                }

                //Write all modified values
                _writeAllCmd = MessageCommand.WriteAllModified;
                outgoing.AddRange(BuildWriteAllMsgs(baseId, txId, allParams: false));

                _logger.LogInformation("{Name} ID: {BaseId}, Write All Started {Count}", name, baseId, _writeAllCount);

                break;

            case MessageCommand.WriteAllComplete:
                if (data.Length != 8) return;

                // queued under the count WE sent (index = count, sub 0); the reply carries the device's count
                key = (baseId, _writeAllCount, 0);
                if (queue.TryGetValue(key, out canFrame!))
                {
                    canFrame.TimeSentTimer?.Dispose();
                    queue.TryRemove(key, out _);
                }
                
                var writeAllCount = data[2] << 8 | data[1];
                uint writeAllCrc = (uint)(data[7] << 24 | data[6] << 16 | data[5] << 8 | data[4]);

                // Upstream replies [22, count, applied, crc]: byte 3 says whether it took the config.
                if (Upstream ? data[3] == 1 : writeAllCrc == _writeCrc32.Final)
                {
                    _writeMissing.Clear();
                    // The device acknowledged every param the app sent — they're in sync now.
                    _writeAllRetries = 0;
                    device.ConfigMismatch = false;
                    device.LastConfigDiff = new List<ConfigDiffEntry>();
                    _logger.LogInformation("{Name} ID: {BaseId}, Write All Completed {pdmCrc} = {thisCrc}, {fromPdm}",
                        name, baseId, writeAllCrc, _writeCrc32.Final, writeAllCount);
                    NotifySuccess?.Invoke($"{name}: Write Successful");
                }
                else if (_writeAllRetries < MaxWriteAllRetries)
                {
                    _writeAllRetries++;
                    _logger.LogWarning("{Name} ID: {BaseId}, Write All incomplete ({fromPdm} of {sent} params arrived), retry {Try}/{Max}",
                        name, baseId, writeAllCount, _writeAllCount, _writeAllRetries, MaxWriteAllRetries);
                    outgoing.Add(new DeviceCanFrame
                    {
                        DeviceBaseId = baseId,
                        Frame = new CanFrame(Id: txId, Len: 8, Payload: [Convert.ToByte(_writeAllCmd), 0, 0, 0, 0, 0, 0, 0]),
                        Name = "WriteAll (retry)"
                    });
                    break;
                }
                else
                {
                    _writeAllRetries = 0;
                    _logger.LogError("{Name} ID: {BaseId}, Write All Failed {pdmCrc} != {thisCrc}, {fromPdm} vs {received}",
                        name, baseId, writeAllCrc, _writeCrc32.Final, writeAllCount, _writeAllCount);
                    if (_writeMissing.Count > 0)
                        _logger.LogError("{Name}: the module did not get {Params}", name,
                            string.Join(", ", _writeMissing.Select(k => @params.FirstOrDefault(p => (p.Index, p.SubIndex) == k)?.Name ?? $"0x{k.Index:X4}:{k.SubIndex}")));
                    // The device keeps its old config when the count/CRC don't match: say so, don't let a
                    // following burn look like it stored the new one.
                    device.ConfigMismatch = true;
                    if (WriteAllFailed?.Invoke() != true)
                        NotifyError?.Invoke($"{name}: Write failed — device received {writeAllCount} of {_writeAllCount} params, config NOT applied");
                }
                
                outgoing.Add(new DeviceCanFrame
                {
                    DeviceBaseId = baseId,
                    SendOnly = true,
                    Frame = new CanFrame(Id: txId, Len: 8, Payload: [Convert.ToByte(MessageCommand.CheckCrc), 0, 0, 0, 0, 0, 0, 0]),
                    Name = "CheckCRC"
                });
                break;

            // Upstream, after a failed full WriteAll: the params it did not get, then the end of the list
            // (count, or 0xFFFF = too many to list). The retry above already re-sends everything; these say what was lost.
            case MessageCommand.WriteAllMissing:
                if (data.Length != 8) return;
                _writeMissing.Add((data[2] << 8 | data[1], data[3]));
                break;
            case MessageCommand.WriteAllMissingDone:
                if (data.Length != 8) return;
                var missingCount = data[2] << 8 | data[1];
                _logger.LogWarning("{Name} ID: {BaseId}, module missed {Count} param(s) of the Write All: {Params}", name, baseId,
                    missingCount == 0xFFFF ? "many" : missingCount.ToString(),
                    string.Join(", ", _writeMissing.Select(k => $"0x{k.Index:X4}:{k.SubIndex}")));
                break;

            // Config lock (upstream feat/config-lock): a request refused while locked. [58, idxLo, idxHi, sub, refused cmd].
            // Drop the pending request (it never gets its own reply), and on the first refusal read the contact text.
            case MessageCommand.Locked:
                if (data.Length != 8) return;
                index = data[2] << 8 | data[1];
                subIndex = data[3];
                if (queue.TryRemove((baseId, index, subIndex), out canFrame!)) canFrame.TimeSentTimer?.Dispose();
                if (!device.Lock.Locked)
                {
                    device.Lock.Locked = true;
                    _logger.LogWarning("{Name} ID: {BaseId}, configuration locked (refused cmd {Cmd})", name, baseId, data[4]);
                    NotifyError?.Invoke($"{name} is locked by its installer: Unlock it with the password, or Factory reset it (wipes its configuration)");
                    for (var k = 1; k <= 8; k++)
                        outgoing.Add(new DeviceCanFrame { DeviceBaseId = baseId, SendOnly = true, Name = $"Read lock contact {k}",
                            Frame = new CanFrame(txId, 8, [(byte)MessageCommand.Read, ConfigLock.BaseIndex & 0xFF, ConfigLock.BaseIndex >> 8, (byte)k, 0, 0, 0, 0]) });
                }
                break;

            case MessageCommand.Unlock:
                if (data.Length < 2) return;
                if (data[1] == 1) { device.Lock.Locked = false; NotifySuccess?.Invoke($"{name}: unlocked until its next restart"); }
                else _logger.LogWarning("{Name} ID: {BaseId}, unlock refused (wrong password, or tried again within 1 s)", name, baseId);
                break;

            case MessageCommand.FactoryReset:
                if (data.Length < 2) return;
                device.Lock.Locked = false;
                device.ConfigMismatch = true;   // the module holds defaults now, the project still its old config
                if (data[1] == 1) NotifySuccess?.Invoke($"{name}: factory reset and stored");
                else NotifyError?.Invoke($"{name}: factory reset, but storing the defaults failed: the old configuration (and password) come back at the next power cycle. Try again.");
                break;

		    case MessageCommand.BurnParams:
                if (data.Length != 8) return;

                if (data[4] == 1) //Successful burn
                {
                    _logger.LogInformation("{Name} ID: {BaseId}, Burn Successful", name, baseId);
                    NotifySuccess?.Invoke($"{name}: Burn Successful");

                    key = (baseId, 3 << 8 | 1, 8); //Index bytes are 1 and 3, subindex is 8
                    if (queue.TryGetValue(key, out canFrame!))
                    {
                        canFrame.TimeSentTimer?.Dispose();
                        queue.TryRemove(key, out _);
                    }
                }

                if (data[4] == 0) //Unsuccessful burn
                    _logger.LogError("{Name} ID: {BaseId}, Burn Failed", name, baseId);

                break;

            case MessageCommand.Sleep:
                if (data.Length != 8) return;
                if (data[1] == 'Z' && data[2] == 'Z' && data[3] == 'Z') return;   // the 5.6 goodbye, not a reply to a sleep request

                if (data[5] == 1) //Successful sleep
                {
                    _logger.LogInformation("{Name} ID: {BaseId}, Sleep Successful", name, baseId);
                    NotifySuccess?.Invoke($"{name}: Sleep Successful");

                    key = (baseId, 'U' << 8 | 'Q', 'I'); //Index bytes = QU, Subindex = I
                    if (queue.TryGetValue(key, out canFrame!))
                    {
                        canFrame.TimeSentTimer?.Dispose();
                        queue.TryRemove(key, out _);
                    }
                }

                if (data[5] == 0) //Unsuccessful sleep
                    _logger.LogError("{Name} ID: {BaseId}, Sleep Failed", name, baseId);

                break;
        }
    }

    private List<DeviceCanFrame> BuildWriteAllMsgs(int baseId, int txId, bool allParams)
    {
        List<DeviceCanFrame> msgs = [];
        _writeMissing.Clear();
        if (Upstream)   // every param the module has, in its CRC order (the device checks count + CalcParamsCrc)
            msgs = UpstreamFrames(txId).Select(f => new DeviceCanFrame { DeviceBaseId = baseId, SendOnly = true, Frame = f.Frame, Name = f.Name }).ToList();
        else
        {
            var writeParams = allParams ? _params : _params.Where(p => p.IsModified).ToList();
            foreach (var parameter in writeParams)
                msgs.Add(new DeviceCanFrame
                {
                    DeviceBaseId = baseId,
                    SendOnly = true,
                    Frame = ParamCodec.ToFrame(MessageCommand.WriteAllVal, parameter, txId),
                    Name = parameter.Name
                });
        }
        _writeAllCount = msgs.Count;
        foreach (var m in msgs)
            _writeCrc32.Update(m.Frame.Payload.Skip(4).Take(4).ToArray());

        //Write all complete, with num params. Tracked (not SendOnly): the reply carries the verdict, and
        //without a timeout a lost reply left the write hanging forever with no message.
        msgs.Add(new DeviceCanFrame
        {
            DeviceBaseId = baseId,
            Frame = new CanFrame(
                Id: txId,
                Len: 8,
                // upstream checks bytes 4-7 against the CRC of what it got (the fork leaves them 0)
                Payload: [  Convert.ToByte(MessageCommand.WriteAllComplete),
                    Convert.ToByte(_writeAllCount & 0xFF),
                    Convert.ToByte((_writeAllCount >> 8) & 0xFF),
                    0, .. (Upstream ? BitConverter.GetBytes(_writeCrc32.Final) : new byte[4])]),
            Name = "WriteAllComplete"
        });

        return msgs;
    }

    // Full-config signature. Hardened to be ORDER-INDEPENDENT and self-describing: each param
    // contributes a standalone CRC over its identity (index+subindex) AND value, XOR-combined.
    // XOR is commutative, so the app and firmware no longer have to build their param lists in the
    // same order to agree — and including the identity bytes means a missing/extra param changes the
    // signature (so a param-set difference is detected, not silently equal). The firmware computes
    // the identical value in CheckCrc(). (Param indices are unique, so XOR never self-cancels.)
    private uint CalcCrc()
    {
        uint acc = 0;
        foreach (var parameter in _params)
        {
            var data = ParamCodec.ToFrame(MessageCommand.Null, parameter, 0);
            var c = new CumulativeCrc32();
            c.Update(data.Payload.Skip(1).Take(7).ToArray());   // index(2) + subindex(1) + value(4)
            acc ^= c.Final;
        }
        return acc;
    }

    // Upstream: every param the module has, in its ReadAll order — the app's value, or for a param this app has no
    // model of, the value the last Read got. null when a value is missing (list from the project file, not read yet).
    // crc: a write-only param (the lock password) as the module reports it in CheckCrc, 0.
    private List<(CanFrame Frame, string Name)>? UpstreamFramesOrNull(int txId, bool crc = false)
    {
        var known = @params.Where(p => !p.LocalOnly).GroupBy(p => (p.Index, p.SubIndex)).ToDictionary(g => g.Key, g => g.First());
        var frames = new List<(CanFrame, string)>();
        foreach (var k in device.ParamSet.Order)
        {
            if (known.TryGetValue(k, out var p))
            {
                var f = ParamCodec.ToFrame(MessageCommand.WriteAllVal, p, txId);
                if (crc && p.WriteOnly) Array.Clear(f.Payload, 4, 4);
                frames.Add((f, p.Name));
            }
            else if (device.ParamSet.Raw.TryGetValue(k, out var raw))
                frames.Add((new CanFrame(txId, 8, [(byte)MessageCommand.WriteAllVal, (byte)(k.Index & 0xFF), (byte)(k.Index >> 8), (byte)k.SubIndex, .. BitConverter.GetBytes(raw)]),
                    $"0x{k.Index:X4}:{k.SubIndex}"));
            else return null;
        }
        return frames;
    }
    private List<(CanFrame Frame, string Name)> UpstreamFrames(int txId) => UpstreamFramesOrNull(txId) ?? [];

    // Upstream CheckCrc = CalcParamsCrc: CRC-32 of the values in table (= ReadAll) order. null = cannot compute.
    private uint? UpstreamCrc()
    {
        var frames = UpstreamFramesOrNull(0, crc: true);
        if (frames is null || frames.Count == 0) return null;
        var c = new CumulativeCrc32();
        foreach (var (f, _) in frames) c.Update(f.Payload.Skip(4).Take(4).ToArray());
        return c.Final;
    }
    /// <summary>The CRC an upstream module reports for this config (CheckCrc, full WriteAll); null = not computable.</summary>
    public uint? UpstreamConfigCrc() => UpstreamCrc();

    // Value comparison for the read diff.Doubles tolerate float round-trip; everything else is exact.
    private static bool ValuesEqual(object? a, object? b)
    {
        if (a is null || b is null) return Equals(a, b);
        if (a is double or float || b is double or float)
            return Math.Abs(Convert.ToDouble(a) - Convert.ToDouble(b)) < 1e-4;
        if (a.GetType().IsEnum) a = Convert.ToInt64(a);
        if (b.GetType().IsEnum) b = Convert.ToInt64(b);
        if (a is bool ab && b is bool bb) return ab == bb;
        try { return Convert.ToInt64(a) == Convert.ToInt64(b); } catch { return Equals(a, b); }
    }

    private static string FormatVal(object? v) => v switch
    {
        null => "—",
        bool b => b ? "on" : "off",
        double d => d.ToString("0.###"),
        float f => f.ToString("0.###"),
        _ => v.ToString() ?? "—"
    };
}
