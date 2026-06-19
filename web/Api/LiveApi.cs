using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using application.Models;
using application.Services;
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
    double WarnLimit, double OpenLoadLimit, int OpenLoadTime);
public record DeviceDto(string Guid, string Name, string Type, int BaseId, bool Connected,
    double Battery, double Current, double Temp, string State, string Version, string Bitrate, OutputDto[] Outputs,
    bool Reading, int ReadDone, int ReadTotal, bool SleepEnabled, int SleepTimeoutMs,
    bool SleepInputEnabled, int SleepInput, bool SleepInputActiveHigh, bool SleepIgnoreAlwaysOn);
public record AdaptersDto(string[] Adapters, string[] Ports, bool Connected, string? ActiveAdapter, string? ActivePort);
public record TelemetryDto(bool Connected, string? Adapter, long CanTotal, long CanRate, int[] Ids, DeviceDto[] Devices);
public record ConnectReq(string Adapter, string Port, string Bitrate);
public record AddDeviceReq(string Type, string Name, string BaseId);
public record ModifyReq(string Name, string BaseId);
public record SignalDto(string Kind, string Name, string Value, bool On);
public record CanLogDto(string Dir, int Id, int Len, string Data, int Count);
public record SysLogDto(string Time, string Level, string Source, string Message);
public record ProbeReq(string Base);
public record SetOutputReq(int Number, double CurrentLimit);
public record OutputConfigReq(int Number, bool Enabled, int Input, double CurrentLimit, double InrushLimit,
    int InrushTime, int ResetMode, int ResetTime, int ResetCountLimit,
    bool PwmEnabled, int Freq, int FixedDuty, int MinDuty, bool SoftStart, int SoftStartRamp,
    double WarnLimit = 0, double OpenLoadLimit = 0, int OpenLoadTime = 1000);
public record ReadParamReq(int Index, int Sub);
public record WriteParamReq(int Index, int Sub, uint Value);
public record SdoReadReq(int Node, int Index, int Sub);
public record SdoWriteReq(int Node, int Index, int Sub, uint Value, int Size);
public record SdoNodeReq(int Node);
public record ProjReq(string FileName);
public record LuaReq(string Source);

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
                "canoutput" or "cout" => (p.CanOutputs.FirstOrDefault(x => x.Number == number), CanOutput.BaseIndex + n),
                "wiper" or "wip"      => (p.Wipers, Wiper.BaseIndex),
                "starterdisable" or "std" => (p.StarterDisable, StarterDisable.BaseIndex),
                "keypad"              => (p.Keypads.FirstOrDefault(x => x.Number == number), KeypadMaster.BaseIndex + n),
                "keypadbutton"        => ResolveKeypadButton(p, number),
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
                "canoutput" or "cout" => (c.CanOutputs.FirstOrDefault(x => x.Number == number), CanOutput.BaseIndex + n),
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

    // Apply incoming JSON fields onto a function object by JsonPropertyName. Handles the scalar
    // + enum + List<bool> shapes the function models use; arrays like SpeedMap are left untouched.
    public static void ApplyJson(object target, JsonElement body)
    {
        var props = target.GetType().GetProperties()
            .Where(p => p.CanWrite)
            .ToDictionary(p => p.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? p.Name,
                          p => p, StringComparer.OrdinalIgnoreCase);

        foreach (var jp in body.EnumerateObject())
        {
            if (!props.TryGetValue(jp.Name, out var pi)) continue;
            var t = Nullable.GetUnderlyingType(pi.PropertyType) ?? pi.PropertyType;
            try
            {
                object? val =
                    t.IsEnum ? Enum.ToObject(t, jp.Value.GetInt32()) :
                    t == typeof(bool) ? jp.Value.GetBoolean() :
                    t == typeof(int) ? jp.Value.GetInt32() :
                    t == typeof(double) ? jp.Value.GetDouble() :
                    t == typeof(string) ? jp.Value.GetString() :
                    pi.PropertyType == typeof(int[]) ? jp.Value.EnumerateArray().Select(e => e.GetInt32()).ToArray() :
                    pi.PropertyType == typeof(bool[]) ? jp.Value.EnumerateArray().Select(e => e.GetBoolean()).ToArray() :
                    pi.PropertyType == typeof(List<bool>) ? jp.Value.EnumerateArray().Select(e => e.GetBoolean()).ToList() :
                    null;
                if (val != null || t == typeof(string)) pi.SetValue(target, val);
            }
            catch { /* skip a malformed field rather than failing the whole save */ }
        }
    }
}

// ---------- SignalR hub (server pushes "telemetry" to clients) ----------
public class LiveHub : Hub { }

// ---------- helpers shared by hub broadcaster + REST ----------
public static class DingoMap
{
    public static CanBitRate ParseBitrate(string s) => s switch
    {
        "1000K" => CanBitRate.BitRate1000K, "500K" => CanBitRate.BitRate500K,
        "250K" => CanBitRate.BitRate250K, "125K" => CanBitRate.BitRate125K,
        "100K" => CanBitRate.BitRate100K, _ => CanBitRate.BitRate500K
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

    public static DeviceDto ToDto(IDevice d, DeviceUiState? ui = null)
    {
        var reading = ui?.Reading ?? false;
        var readDone = ui?.ReadDone ?? 0;
        var readTotal = ui?.ReadTotal ?? 0;
        if (d is PdmDevice p)
        {
            var outs = p.Outputs.Select(o => new OutputDto(
                o.Number, o.Name, o.State.ToString(), o.Current, o.ResetCount, o.CurrentDutyCycle, InputLabel(p, o.Input), o.CurrentLimit,
                o.Enabled, o.Input, o.InrushCurrentLimit, o.InrushTime, (int)o.ResetMode, o.ResetTime, o.ResetCountLimit,
                o.PwmEnabled, o.Frequency, o.FixedDutyCycle, o.MinDutyCycle, o.SoftStartEnabled, o.SoftStartRampTime,
                o.WarnLimit, o.OpenLoadLimit, o.OpenLoadTime)).ToArray();
            return new DeviceDto(p.Guid.ToString(), p.Name, p.Type, p.BaseId, p.Connected,
                p.BatteryVoltage, p.TotalCurrent, p.BoardTempC, p.DeviceState.ToString(),
                p.Version, BitrateLabel(p.BitRate), outs, reading, readDone, readTotal,
                p.SleepEnabled, p.SleepTimeoutMs, p.SleepInputEnabled, p.SleepInput, p.SleepInputActiveHigh, p.SleepIgnoreAlwaysOn);
        }
        if (d is domain.Devices.Canboard.CanboardDevice cb)
            return new DeviceDto(cb.Guid.ToString(), cb.Name, cb.Type, cb.BaseId, cb.Connected,
                0, 0, 0, "", "", BitrateLabel(cb.BitRate), Array.Empty<OutputDto>(), reading, readDone, readTotal,
                cb.SleepEnabled, cb.SleepTimeoutMs, cb.SleepInputEnabled, cb.SleepInput, cb.SleepInputActiveHigh, cb.SleepIgnoreAlwaysOn);
        return new DeviceDto(d.Guid.ToString(), d.Name, d.Type, d.BaseId, d.Connected,
            0, 0, 0, "", "", "", Array.Empty<OutputDto>(), reading, readDone, readTotal, false, 30000, false, 0, false, true);
    }
}

// ---------- background service: stream telemetry + CAN stats over SignalR ----------
public class TelemetryBroadcaster(
    IHubContext<LiveHub> hub,
    DeviceManager deviceManager,
    ICommsAdapterManager adapterManager,
    ILogger<TelemetryBroadcaster> logger) : BackgroundService
{
    private long _total, _rate, _rateBase;
    private DateTime _rateStamp = DateTime.Now;
    private readonly HashSet<int> _ids = new();
    private readonly object _lock = new();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        adapterManager.DataReceived += OnFrame;
        logger.LogInformation("Telemetry broadcaster started");
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var now = DateTime.Now;
                if ((now - _rateStamp).TotalMilliseconds >= 1000)
                { _rate = _total - _rateBase; _rateBase = _total; _rateStamp = now; }

                int[] ids;
                lock (_lock) ids = _ids.OrderBy(x => x).Take(48).ToArray();

                var devices = deviceManager.GetAllDevices()
                    .Select(d => DingoMap.ToDto(d, deviceManager.GetDeviceUiState(d.Guid))).ToArray();
                var status = adapterManager.GetStatus();
                var dto = new TelemetryDto(status.isConnected, status.activeAdapter, _total, _rate, ids, devices);

                await hub.Clients.All.SendAsync("telemetry", dto, ct);
                await Task.Delay(100, ct); // 10 Hz
            }
        }
        catch (OperationCanceledException) { }
        finally { adapterManager.DataReceived -= OnFrame; }
    }

    private void OnFrame(object? sender, CanFrameEventArgs e)
    {
        Interlocked.Increment(ref _total);
        lock (_lock) _ids.Add(e.Frame.Id);
    }
}

// ---------- minimal REST API for commands ----------
public static class LiveApi
{
    public static void MapDingoApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/adapters", (ICommsAdapterManager m) =>
        {
            var (adapters, ports) = m.GetAvailable();
            var s = m.GetStatus();
            return Results.Ok(new AdaptersDto(adapters, ports, s.isConnected, s.activeAdapter, s.activePort));
        });

        api.MapPost("/connect", async (ConnectReq r, ICommsAdapterManager m) =>
        {
            try
            {
                var adapter = m.ToAdapter(r.Adapter);
                var ok = await m.ConnectAsync(adapter, r.Port, DingoMap.ParseBitrate(r.Bitrate), CancellationToken.None);
                return Results.Ok(new { ok });
            }
            catch (Exception ex) { return Results.BadRequest(new { ok = false, error = ex.Message }); }
        });

        api.MapPost("/disconnect", async (ICommsAdapterManager m) =>
            Results.Ok(new { ok = await m.DisconnectAsync() }));

        // Auto-discover devices on the bus: PDMs broadcast a contiguous run of status
        // frames starting at BaseId + CyclicRxOffset(2). A run of >=3 consecutive 8-byte
        // RX ids => a device at (runStart - 2).
        api.MapGet("/discover", (CanMsgLogger log) =>
        {
            var ids = log.GetMessageSum()
                .Where(m => m.Direction == DataDirection.Rx && m.Len == 8)
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
        // the BOARD_ID byte (data8[1]) of the reply — 0=dingoPDM, 1=PDM-MAX, 2=CANBoard. Firmware
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

            // CANopen keypads
            foreach (var m in rx.Where(m => m.Id is >= 0x701 and <= 0x77F).OrderBy(m => m.Id))
            {
                int node = m.Id - 0x700;
                bool hasButtons = rx.Any(x => x.Id == 0x180 + node);
                var type = node == 0x0A ? "grayhillkeypad" : "blinkkeypad";
                found.Add(new {
                    type, baseId = node, hex = "0x" + node.ToString("X2"),
                    label = type == "grayhillkeypad" ? "Grayhill keypad" : "Blink Marine keypad",
                    confidence = hasButtons ? "high" : "low",
                    detail = $"CANopen node {node}" + (hasButtons ? " (heartbeat + buttons)" : " (heartbeat only)")
                });
                foreach (var off in new[] { 0x180, 0x280, 0x380, 0x480, 0x580, 0x600, 0x700 }) claimed.Add(off + node);
            }

            // dingoPDM / CANBoard: contiguous run of 8-byte status frames, base = runStart - 2.
            var ids = rx.Where(m => m.Len == 8 && !claimed.Contains(m.Id)).Select(m => m.Id).Distinct().OrderBy(x => x).ToList();
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

            foreach (var (baseId, runLen, statusId) in candidates)
            {
                // Active confirm: send Version to base+1 (CONFIG_RX_OFFSET), read BOARD_ID from the
                // reply at base+0. Falls back to the run-length heuristic if the device doesn't reply
                // with a BOARD_ID (older firmware always replies 0 → treated as PDM).
                int? boardId = null;
                if (adapter.ActiveAdapter is not null)
                {
                    try
                    {
                        await adapter.ActiveAdapter.WriteAsync(
                            new CanFrame(baseId + 1, 8, new byte[] { (byte)MessageCommand.Version, 0, 0, 0, 0, 0, 0, 0 }),
                            CancellationToken.None);
                        await Task.Delay(250);
                        var reply = log.GetMessageSum().FirstOrDefault(x =>
                            x.Id == baseId && x.Direction == DataDirection.Rx &&
                            x.Payload is { Length: >= 2 } p && p[0] == (byte)MessageCommand.Version);
                        if (reply?.Payload is { Length: >= 2 } pl) boardId = pl[1];
                    }
                    catch { /* fall through to heuristic */ }
                }

                var (type, label) = boardId switch
                {
                    2 => ("canboard", "CANBoard"),
                    1 => ("pdm", "dingoPDM-Max"),
                    0 => ("pdm", "dingoPDM"),
                    _ => ("pdm", "dingoPDM"),     // no BOARD_ID reply → default PDM
                };
                found.Add(new {
                    type, baseId, hex = "0x" + baseId.ToString("X3"), label,
                    confidence = boardId is not null ? "high" : "medium",
                    detail = boardId is not null
                        ? $"identified via BOARD_ID {boardId} at 0x{baseId:X3}"
                        : $"{runLen} status frames at 0x{statusId:X3} — type unconfirmed, set below"
                });
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

        api.MapPost("/devices", (AddDeviceReq r, DeviceManager dm) =>
        {
            var id = DingoMap.ParseId(r.BaseId);
            if (id <= 0) return Results.BadRequest(new { ok = false, error = "Invalid base ID" });
            dm.AddDevice(r.Type, string.IsNullOrWhiteSpace(r.Name) ? r.Type : r.Name, id);
            return Results.Ok(new { ok = true });
        });

        api.MapPost("/devices/{guid}/modify", (string guid, ModifyReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            dm.ModifyDeviceConfig(g, r.Name, DingoMap.ParseId(r.BaseId));
            return Results.Ok(new { ok = true });
        });

        // Set an output's current limit (used by the output editor; also the write-path test hook)
        api.MapPost("/devices/{guid}/output", (string guid, SetOutputReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var d = dm.GetDevice<PdmDevice>(g);
            var o = d?.Outputs.FirstOrDefault(x => x.Number == r.Number);
            if (o == null) return Results.NotFound();
            o.CurrentLimit = r.CurrentLimit;
            return Results.Ok(new { ok = true, o.Number, o.CurrentLimit });
        });

        // Apply an output's config from the editor, then write that output's params to the
        // device (paced). Burn separately to persist to flash.
        api.MapPost("/devices/{guid}/outputconfig", (string guid, OutputConfigReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var d = dm.GetDevice<PdmDevice>(g);
            var o = d?.Outputs.FirstOrDefault(x => x.Number == r.Number);
            if (o == null) return Results.NotFound();
            o.Enabled = r.Enabled;
            o.Input = r.Input;
            o.CurrentLimit = r.CurrentLimit;
            o.InrushCurrentLimit = r.InrushLimit;
            o.InrushTime = r.InrushTime;
            o.ResetMode = (ResetMode)r.ResetMode;
            o.ResetTime = r.ResetTime;
            o.ResetCountLimit = r.ResetCountLimit;
            o.PwmEnabled = r.PwmEnabled;
            o.Frequency = r.Freq;
            o.FixedDutyCycle = r.FixedDuty;
            o.MinDutyCycle = r.MinDuty;
            o.SoftStartEnabled = r.SoftStart;
            o.SoftStartRampTime = r.SoftStartRamp;
            o.WarnLimit = r.WarnLimit;
            o.OpenLoadLimit = r.OpenLoadLimit;
            o.OpenLoadTime = r.OpenLoadTime;
            dm.WriteOutputParams(g, r.Number);
            return Results.Ok(new { ok = true });
        });

        // Single-param read/write (paced, no bulk burst) — reliable on the USB-direct link.
        api.MapPost("/devices/{guid}/readparam", (string guid, ReadParamReq r, DeviceManager dm) =>
            Guid.TryParse(guid, out var g) && dm.ReadParam(g, r.Index, r.Sub)
                ? Results.Ok(new { ok = true }) : Results.BadRequest());

        api.MapPost("/devices/{guid}/writeparam", (string guid, WriteParamReq r, DeviceManager dm) =>
            Guid.TryParse(guid, out var g) && dm.WriteParam(g, r.Index, r.Sub, r.Value)
                ? Results.Ok(new { ok = true }) : Results.BadRequest());

        api.MapPost("/devices/{guid}/remove", (string guid, DeviceManager dm) =>
        {
            if (Guid.TryParse(guid, out var g)) dm.RemoveDevice(g);
            return Results.Ok(new { ok = true });
        });

        // Selectable input sources (VarMap) — feeds output/flasher/condition pickers.
        // ?type=bool (default for an output rule) | int | float | omit for all.
        api.MapGet("/devices/{guid}/inputs", (string guid, string? type, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not IDeviceConfigurable cfg) return Results.Ok(Array.Empty<object>());
            var vars = type is null ? cfg.VarMap : cfg.VarMap.Where(v => v.DataType == type);
            return Results.Ok(vars.Select(v => new { index = v.VariableIndex, name = DingoMap.VarLabel(v) }).ToArray());
        });

        // All editable function arrays — feeds the Signals & logic editor (PDM + CANBoard).
        api.MapGet("/devices/{guid}/functions", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.Ok(new { });
            if (dm.GetDevice(g) is PdmDevice p)
                return Results.Ok(new
                {
                    inputs = p.Inputs, canInputs = p.CanInputs, virtualInputs = p.VirtualInputs,
                    conditions = p.Conditions, counters = p.Counters, flashers = p.Flashers,
                    canOutputs = p.CanOutputs, wiper = p.Wipers, starterDisable = p.StarterDisable,
                    keypads = p.Keypads,
                });
            if (dm.GetDevice(g) is CanboardDevice c)
                return Results.Ok(new
                {
                    analogIn = c.AnalogInputs, digitalIn = c.DigitalInputs, digitalOut = c.DigitalOutputs,
                    canInputs = c.CanInputs, virtualInputs = c.VirtualInputs, conditions = c.Conditions,
                    counters = c.Counters, flashers = c.Flashers, canOutputs = c.CanOutputs,
                });
            return Results.Ok(new { });
        });

        // Apply one function's fields from the editor, then write its params to the device.
        api.MapPost("/devices/{guid}/function/{kind}/{number:int}", async (string guid, string kind, int number, HttpRequest req, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not IDeviceConfigurable dev) return Results.BadRequest();
            var (fn, paramIndex) = FunctionMap.Resolve(dev, kind, number);
            if (fn == null || paramIndex < 0) return Results.NotFound(new { error = $"unknown function {kind} #{number}" });
            using var doc = await JsonDocument.ParseAsync(req.Body);
            FunctionMap.ApplyJson(fn, doc.RootElement);
            dm.WriteFunctionParams(g, paramIndex);
            return Results.Ok(new { ok = true });
        });

        // Upload one assembled Lua program to the device (chunked, paced on the backend).
        api.MapPost("/devices/{guid}/lua", (string guid, LuaReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var ok = dm.UploadLua(g, r.Source ?? "");
            return ok ? Results.Ok(new { ok = true }) : Results.BadRequest(new { ok = false, error = "upload rejected (too big or no device)" });
        });

        // Read the stored Lua program back from the device.
        api.MapGet("/devices/{guid}/lua", async (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var source = await dm.ReadLua(g);
            return Results.Ok(new { source });
        });

        // Read the device's last Lua runtime error (empty if none).
        api.MapGet("/devices/{guid}/luaerror", async (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var error = await dm.ReadLuaError(g);
            return Results.Ok(new { error });
        });

        // Read the on-device overload (trip) log: events with ±window current waveforms.
        api.MapGet("/devices/{guid}/overloads", async (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var events = await dm.ReadOverloadLog(g);
            return Results.Ok(new { events });
        });

        // Clear the on-device overload log.
        api.MapPost("/devices/{guid}/overloads/clear", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            dm.ClearOverloadLog(g);
            return Results.Ok(new { ok = true });
        });

        // In-app firmware update: upload a .bin (raw body); commands DFU + flashes via dfu-util.
        api.MapPost("/devices/{guid}/flash", async (string guid, HttpRequest req, FirmwareFlashService flasher) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            using var ms = new MemoryStream();
            await req.Body.CopyToAsync(ms);
            var res = await flasher.FlashAsync(g, ms.ToArray());
            return Results.Ok(new { ok = res.Ok, log = res.Log });
        });

        // Live flash progress (polled by the UI while a flash is in flight).
        api.MapGet("/flash/status", (FirmwareFlashService flasher) =>
        {
            var s = flasher.Status();
            return Results.Ok(new { busy = s.Busy, percent = s.Percent, phase = s.Phase });
        });

        // ---- Declarative whole-system config (AI-friendly): schema + snapshot + apply ----
        // GET schema  -> every device + every setting (name/type/default/enum options) + var-map
        api.MapGet("/config/schema", (SystemConfigService cfg) => Results.Ok(cfg.BuildSchema()));
        // GET snapshot -> current value of every setting (Read the device(s) first). ?lua=true also reads Lua.
        api.MapGet("/config", async (bool? lua, SystemConfigService cfg) => Results.Ok(await cfg.BuildSnapshotAsync(lua ?? false)));
        // POST apply  -> a (full or partial) target document; writes only what differs, burns, uploads Lua.
        api.MapPost("/config", async (HttpRequest req, SystemConfigService cfg) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            var r = cfg.Apply(doc.RootElement);
            return Results.Ok(new { ok = r.Errors.Count == 0, devicesTouched = r.DevicesTouched, paramsChanged = r.ParamsChanged, notes = r.Notes, errors = r.Errors });
        });

        // ---- CANopen SDO: read/write a keypad's object dictionary (persistent device settings) ----
        api.MapPost("/sdo/read", async (SdoReadReq r, SdoService sdo) =>
        {
            var res = await sdo.ReadAsync(r.Node, (ushort)r.Index, (byte)r.Sub);
            return Results.Ok(new { ok = res.Ok, value = res.Value, abort = res.AbortCode, error = res.Error });
        });
        api.MapPost("/sdo/write", async (SdoWriteReq r, SdoService sdo) =>
        {
            var res = await sdo.WriteAsync(r.Node, (ushort)r.Index, (byte)r.Sub, r.Value, r.Size <= 0 ? 4 : r.Size);
            return Results.Ok(new { ok = res.Ok, abort = res.AbortCode, error = res.Error });
        });
        // Store (save) the node's parameters to NV memory — OD 0x1010 sub1 = "save".
        api.MapPost("/sdo/store", async (SdoNodeReq r, SdoService sdo) =>
        {
            var res = await sdo.WriteAsync(r.Node, 0x1010, 1, SdoService.SaveSignature, 4, 1500);
            return Results.Ok(new { ok = res.Ok, abort = res.AbortCode, error = res.Error });
        });

        // ---- DBC device: open a .dbc, add custom signals, read live decoded values ----
        api.MapGet("/devices/{guid}/dbc/signals", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not DbcDevice d) return Results.Ok(Array.Empty<object>());
            return Results.Ok(d.DbcSignals.Select(s => new {
                s.Name, s.Id, s.IsExtended, s.MessageName, s.StartBit, s.Length, byteOrder = (int)s.ByteOrder, s.IsSigned,
                s.Factor, s.Offset, s.Unit, s.Min, s.Max, s.Value }).ToArray());
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

        api.MapGet("/devices/{guid}/signals", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not PdmDevice p) return Results.Ok(Array.Empty<SignalDto>());
            var s = new List<SignalDto>();
            foreach (var i in p.Inputs) s.Add(new("Digital input", i.Name, i.State ? "on" : "off", i.State));
            foreach (var c in p.CanInputs) s.Add(new("CAN input", c.Name, c.Value.ToString(), c.Value != 0));
            foreach (var v in p.VirtualInputs) s.Add(new("Virtual input", v.Name, v.Value ? "on" : "off", v.Value));
            foreach (var c in p.Conditions) s.Add(new("Condition", c.Name, c.Value.ToString(), c.Value != 0));
            foreach (var c in p.Counters) s.Add(new("Counter", c.Name, c.Value.ToString(), c.Value != 0));
            foreach (var f in p.Flashers) s.Add(new("Flasher", f.Name, f.Value ? "on" : "off", f.Value));
            foreach (var o in p.Outputs) s.Add(new("Output", o.Name, o.State.ToString(), o.State.ToString() == "On"));
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
        api.MapGet("/project", (ConfigFileManager cfg) => Results.Ok(new {
            current = cfg.CurrentFileName, dir = cfg.WorkingDirectory,
            files = cfg.ListFilesWithExtension("*.json").Select(f => f.Name).ToArray() }));

        api.MapPost("/project/save", async (ProjReq r, ConfigFileManager cfg, DeviceManager dm) =>
        {
            Directory.CreateDirectory(cfg.WorkingDirectory);
            await cfg.SaveDevices(dm.GetDevices(), r.FileName);
            return Results.Ok(new { ok = true, current = cfg.CurrentFileName });
        });

        api.MapPost("/project/open", async (ProjReq r, ConfigFileManager cfg, DeviceManager dm) =>
        {
            var devs = await cfg.LoadDevices(r.FileName);
            dm.ClearDevices();
            if (devs != null) dm.AddDevices(devs);
            return Results.Ok(new { ok = true, count = devs?.Count ?? 0 });
        });

        api.MapPost("/project/new", (ConfigFileManager cfg, DeviceManager dm) =>
        {
            dm.ClearDevices(); cfg.NewFile(); return Results.Ok(new { ok = true });
        });

        api.MapGet("/canlog", (CanMsgLogger log) => Results.Ok(
            log.GetMessageSum().OrderBy(m => m.Id).Select(m => new CanLogDto(
                m.Direction.ToString(), m.Id, m.Len,
                string.Join(" ", (m.Payload ?? Array.Empty<byte>()).Take(m.Len).Select(b => b.ToString("X2"))),
                m.Count)).ToArray()));

        api.MapGet("/syslog", (SystemLogger log) => Results.Ok(
            log.GetRecentLogs(200).Select(e => new SysLogDto(
                e.Timestamp.ToString("HH:mm:ss"), e.Level.ToString(), e.Source, e.Message)).ToArray()));

        // CSV export of the CAN traffic summary.
        api.MapGet("/canlog/export", (CanMsgLogger log) =>
        {
            var sb = new System.Text.StringBuilder("Dir,ID,DLC,Data,Count\n");
            foreach (var m in log.GetMessageSum().OrderBy(m => m.Id))
                sb.Append($"{m.Direction},0x{m.Id:X3},{m.Len},{string.Join(' ', (m.Payload ?? Array.Empty<byte>()).Take(m.Len).Select(b => b.ToString("X2")))},{m.Count}\n");
            return Results.File(System.Text.Encoding.UTF8.GetBytes(sb.ToString()), "text/csv", "canlog.csv");
        });

        // CSV export of the system log.
        api.MapGet("/syslog/export", (SystemLogger log) =>
        {
            var sb = new System.Text.StringBuilder("Time,Level,Source,Message\n");
            foreach (var e in log.GetRecentLogs(2000))
                sb.Append($"{e.Timestamp:yyyy-MM-dd HH:mm:ss},{e.Level},{e.Source},\"{e.Message.Replace("\"", "\"\"")}\"\n");
            return Results.File(System.Text.Encoding.UTF8.GetBytes(sb.ToString()), "text/csv", "syslog.csv");
        });

        api.MapPost("/devices/{guid}/{action}", (string guid, string action, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            switch (action)
            {
                // Bulk read/write: the firmware streams the whole config back in one burst
                // (~1s, CRC-checked). Far faster than the 2000+ per-param round-trips the
                // chunked path issues — that was the "super slow read". (Verified on USB-SLCAN.)
                case "read": dm.ReadDeviceConfig(g); break;
                case "readall": dm.ReadAllDeviceConfig(g); break;
                case "write": dm.WriteDeviceConfig(g); break;
                case "writeall": dm.WriteAllDeviceConfig(g); break;
                case "burn": dm.BurnSettings(g); break;
                case "sleep": dm.RequestSleep(g); break;
                case "wakeup": dm.RequestWakeup(g); break;
                case "bootloader": dm.RequestBootloader(g); break;
                case "version": dm.RequestVersion(g); break;
                default: return Results.NotFound();
            }
            return Results.Ok(new { ok = true });
        });
    }
}
