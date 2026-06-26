using System.Collections.Concurrent;
using domain.Common;
using domain.Enums;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace domain.Devices;

internal class ParamProtocol(IDeviceConfigurable device, List<DeviceParameter> @params)
{
    private ILogger _logger = NullLogger.Instance;

    private readonly Dictionary<(int Index, int SubIndex), object> _tempParamValues = new();
    private int _readAllCount;
    private int _writeAllCount;
    public Action<string>? NotifySuccess;
    
    private readonly CumulativeCrc32 _writeCrc32 =  new();
    private readonly CumulativeCrc32 _readCrc32 =  new();

    // Tracks the device's actual param set during a Read so we can explain a config mismatch:
    // which params the device returned, and any it sent that this app doesn't know (firmware newer).
    private readonly HashSet<(int Index, int SubIndex)> _readReceived = new();
    private readonly List<ConfigDiffEntry> _deviceOnly = new();

    public void SetLogger(ILogger logger) => _logger = logger;

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

                matchingParam = @params.FirstOrDefault(p => p.Index == index && p.SubIndex == subIndex);

                var paramName = "";
                if (matchingParam != null)
                {
                    paramName = matchingParam.Name;
                }

                key = (baseId, index, subIndex);
                if (queue.TryGetValue(key, out canFrame!))
                {
                    canFrame.TimeSentTimer?.Dispose();
                    queue.TryRemove(key, out _);
                }

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

                matchingParam = @params.FirstOrDefault(p => p.Index == index && p.SubIndex == subIndex);
                if (matchingParam is null) break;

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

                matchingParam.SetValue(convertedValue);

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

                _tempParamValues.Clear();
                foreach (var param in @params)
                    _tempParamValues[(param.Index, param.SubIndex)] = param.DefaultValue;

                _readAllCount = 0;

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
                _readCrc32.Update(data.Skip(4).Take(4).ToArray());
                _readAllCount++;

                matchingParam = @params.FirstOrDefault(p => p.Index == index && p.SubIndex == subIndex);
                if (matchingParam is null)
                {
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
                    // Diff the device's values against the app's CURRENT config BEFORE we overwrite them,
                    // so we can explain exactly what didn't match (value diffs + params each side is missing).
                    var diff = new List<ConfigDiffEntry>();
                    foreach (var param in @params)
                    {
                        var paramKey = (param.Index, param.SubIndex);
                        if (!_readReceived.Contains(paramKey))
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
                    foreach (var param in @params)
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
                
                var thisCheck = CalcCrc();

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
                outgoing.AddRange(BuildWriteAllMsgs(baseId, txId, allParams: false));

                _logger.LogInformation("{Name} ID: {BaseId}, Write All Started {Count}", name, baseId, _writeAllCount);

                break;

            case MessageCommand.WriteAllComplete:
                if (data.Length != 8) return;
                
                var writeAllCount = data[2] << 8 | data[1];
                uint writeAllCrc = (uint)(data[7] << 24 | data[6] << 16 | data[5] << 8 | data[4]);

                if (writeAllCrc == _writeCrc32.Final)
                {
                    // The device acknowledged every param the app sent — they're in sync now.
                    device.ConfigMismatch = false;
                    device.LastConfigDiff = new List<ConfigDiffEntry>();
                    _logger.LogInformation("{Name} ID: {BaseId}, Write All Completed {pdmCrc} = {thisCrc}, {fromPdm}",
                        name, baseId, writeAllCrc, _writeCrc32.Final, writeAllCount);
                    NotifySuccess?.Invoke($"{name}: Write Successful");
                }
                else
                {
                    _logger.LogError("{Name} ID: {BaseId}, Write All Failed {pdmCrc} != {thisCrc}, {fromPdm} vs {received}",
                        name, baseId, writeAllCrc, _writeCrc32.Final, writeAllCount, _writeAllCount);
                }
                
                outgoing.Add(new DeviceCanFrame
                {
                    DeviceBaseId = baseId,
                    SendOnly = true,
                    Frame = new CanFrame(Id: txId, Len: 8, Payload: [Convert.ToByte(MessageCommand.CheckCrc), 0, 0, 0, 0, 0, 0, 0]),
                    Name = "CheckCRC"
                });
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
        var writeParams = allParams ? @params : @params.Where(p => p.IsModified).ToList();
        
        List<DeviceCanFrame> msgs = [];
        _writeAllCount = writeParams.Count;

        foreach (var parameter in writeParams)
        {
            msgs.Add(new DeviceCanFrame
            {
                DeviceBaseId = baseId,
                SendOnly = true,
                Frame = ParamCodec.ToFrame(MessageCommand.WriteAllVal, parameter, txId),
                Name = parameter.Name
            });
            
            _writeCrc32.Update(msgs.Last().Frame.Payload.Skip(4).Take(4).ToArray());
        }

        //Write all complete, with num params
        msgs.Add(new DeviceCanFrame
        {
            DeviceBaseId = baseId,
            SendOnly = true,
            Frame = new CanFrame(
                Id: txId,
                Len: 8,
                Payload: [  Convert.ToByte(MessageCommand.WriteAllComplete),
                    Convert.ToByte(_writeAllCount & 0xFF),
                    Convert.ToByte((_writeAllCount >> 8) & 0xFF),
                    0, 0, 0, 0, 0]),
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
        foreach (var parameter in @params)
        {
            var data = ParamCodec.ToFrame(MessageCommand.Null, parameter, 0);
            var c = new CumulativeCrc32();
            c.Update(data.Payload.Skip(1).Take(7).ToArray());   // index(2) + subindex(1) + value(4)
            acc ^= c.Final;
        }
        return acc;
    }

    // Value comparison for the read diff. Doubles tolerate float round-trip; everything else is exact.
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
