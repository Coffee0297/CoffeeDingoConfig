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
    double WarnLimit, double OpenLoadLimit, int OpenLoadTime, string WireColor, string WireStripe, double WireLength, double WireGaugeMm2);
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
    double WarnLimit = 0, double OpenLoadLimit = 0, int OpenLoadTime = 1000, string? Name = null,
    string? WireColor = null, string? WireStripe = null, double? WireLength = null, double? WireGaugeMm2 = null);
public record ApplyProfileReq(string Source);
public record RenameReq(string Name);
public record ReadParamReq(int Index, int Sub);
public record WriteParamReq(int Index, int Sub, uint Value);
public record SdoReadReq(int Node, int Index, int Sub);
public record SdoWriteReq(int Node, int Index, int Sub, uint Value, int Size);
public record SdoNodeReq(int Node);
public record ProjReq(string FileName);
public record LuaReq(string Source);
public record LinkRemoteReq(int CanInput, string SourceGuid, string Signal);
public record CrossTrigReq(string Guid, int? VarIndex);
public record CrossTargetReq(string Guid, int Output);
public record CrossFnReq(string? Name, bool Disabled, bool Blink, int BlinkRateMs, CrossTrigReq? Trigger,
    List<CrossTargetReq>? Targets, string? ClockMaster, string? ClockBackup);
public record DeployCrossReq(List<CrossFnReq>? Functions, bool Preview);

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
            // Nested function objects (AnalogInput.switch / .rotary) — recurse so their fields
            // persist. Without this, an analog input's rotary-switch config was silently dropped.
            if (jp.Value.ValueKind == JsonValueKind.Object)
            {
                var nested = pi.GetValue(target);
                if (nested != null) ApplyJson(nested, jp.Value);
                continue;
            }
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
                o.WarnLimit, o.OpenLoadLimit, o.OpenLoadTime, o.WireColor, o.WireStripe, o.WireLength, o.WireGaugeMm2)).ToArray();
            return new DeviceDto(p.Guid.ToString(), p.Name, p.Type, p.BaseId, p.Connected,
                p.BatteryVoltage, p.TotalCurrent, p.BoardTempC, p.DeviceState.ToString(),
                p.Version, BitrateLabel(p.BitRate), outs, reading, readDone, readTotal,
                p.SleepEnabled, p.SleepTimeoutMs, p.SleepInputEnabled, p.SleepInput, p.SleepInputActiveHigh, p.SleepIgnoreAlwaysOn);
        }
        if (d is domain.Devices.Canboard.CanboardDevice cb)
            // CANBoard has no battery/total-current sensing (those are PDM smart-output features) — leave
            // them 0; it DOES measure board temperature and reports a FW version, so surface those.
            return new DeviceDto(cb.Guid.ToString(), cb.Name, cb.Type, cb.BaseId, cb.Connected,
                0, 0, cb.BoardTempC, "", cb.Version, BitrateLabel(cb.BitRate), Array.Empty<OutputDto>(), reading, readDone, readTotal,
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
    SystemLogger systemLogger,
    ILogger<TelemetryBroadcaster> logger) : BackgroundService
{
    private long _total, _rate, _rateBase;
    private DateTime _rateStamp = DateTime.Now;
    private readonly HashSet<int> _ids = new();
    private readonly object _lock = new();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        adapterManager.DataReceived += OnFrame;

        // Bridge the (previously dead) backend "Notify" channel to the SignalR clients as a "notify"
        // event. SystemLogger.Notify fires on device success messages AND on the new ack-timeout
        // failures raised in DeviceManager.HandleMessageTimeout — so the UI can finally show a real
        // red toast when a queued write is never acknowledged, instead of a silent Logs-tab line.
        void PushNotify(application.Models.LogEntry e) =>
            _ = hub.Clients.All.SendAsync("notify",
                new { level = e.Level.ToString(), source = e.Source, message = e.Message, ts = e.Timestamp }, ct);
        systemLogger.OnNotify += PushNotify;

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
        finally { adapterManager.DataReceived -= OnFrame; systemLogger.OnNotify -= PushNotify; }
    }

    private void OnFrame(object? sender, CanFrameEventArgs e)
    {
        Interlocked.Increment(ref _total);
        // Bound the distinct-ID set: a 29-bit bus (or noise) could otherwise grow it without
        // limit. Only the 48 lowest IDs are ever surfaced, so a few thousand is ample headroom.
        lock (_lock) { if (_ids.Count < 4096) _ids.Add(e.Frame.Id); }
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

        // Device hardware specs (counts + per-output current ratings, per model). The single source
        // of truth is pdm-definitions.json; the UI reads ratings (etc.) from here, not hardcoded.
        api.MapGet("/definitions", (DeviceDefinitionManager defs) =>
            Results.Ok(new { pdms = defs.GetAllPdms(), canboards = defs.GetAllCanboards() }));

        api.MapPost("/devices", (AddDeviceReq r, DeviceManager dm) =>
        {
            var id = DingoMap.ParseId(r.BaseId);
            if (id <= 0) return Results.BadRequest(new { ok = false, error = "Invalid base ID" });
            dm.AddDevice(r.Type, string.IsNullOrWhiteSpace(r.Name) ? r.Type : r.Name, id);
            return Results.Ok(new { ok = true });
        });

        // Rename only — sets the project label, no CAN traffic / no base-ID change. (The name
        // is a project-side label; the firmware doesn't store it.)
        api.MapPost("/devices/{guid}/rename", (string guid, RenameReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var name = (r.Name ?? "").Trim();
            if (name.Length == 0) return Results.Text("Name can't be empty.", "text/plain", null, 400);
            if (!dm.RenameDevice(g, name)) return Results.NotFound();
            return Results.Ok(new { ok = true });
        });

        api.MapPost("/devices/{guid}/modify", (string guid, ModifyReq r, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var newId = DingoMap.ParseId(r.BaseId);
            // A standard CAN ID is 11-bit. The module also uses baseId-1 (settings) and
            // baseId+1/+2 (config/status), so it must sit in [1, 0x7FF]. Out-of-range IDs
            // are silently rejected by the firmware's param range check (max 0x7FF) — the
            // module just never moves. Reject up front with a clear message instead.
            if (newId < 1 || newId > 0x7FF)
                return Results.Text($"Base ID {r.BaseId} is out of range — must be 0x001–0x7FF (1–2047). A standard CAN ID is 11-bit.", "text/plain", null, 400);
            dm.ModifyDeviceConfig(g, r.Name, newId);
            return Results.Ok(new { ok = true });
        });

        // Set an output's current limit (used by the output editor; also the write-path test hook)
        api.MapPost("/devices/{guid}/output", (string guid, SetOutputReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var d = dm.GetDevice<PdmDevice>(g);
            var o = d?.Outputs.FirstOrDefault(x => x.Number == r.Number);
            if (o == null) return Results.NotFound();
            o.CurrentLimit = r.CurrentLimit;                 // project-record edit (always)
            // Push it to the module over CAN only when it's live, and report which happened so a
            // caller (e.g. the MCP set_output tool, described as "live") never reads the in-memory
            // change as a confirmed device write.
            var live = IsLiveModule(g, dm, adapters);
            if (live) dm.WriteOutputParams(g, r.Number);
            return Results.Ok(new { ok = true, o.Number, o.CurrentLimit, written = live });
        });

        // Apply an output's config from the editor, then write that output's params to the
        // device (paced). Burn separately to persist to flash.
        api.MapPost("/devices/{guid}/outputconfig", (string guid, OutputConfigReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            var d = dm.GetDevice<PdmDevice>(g);
            var o = d?.Outputs.FirstOrDefault(x => x.Number == r.Number);
            if (o == null) return Results.NotFound();
            if (r.Name != null) o.Name = r.Name;          // label only — not written over CAN
            if (r.WireColor != null) o.WireColor = r.WireColor;    // documentation labels only
            if (r.WireStripe != null) o.WireStripe = r.WireStripe;
            if (r.WireLength != null) o.WireLength = r.WireLength.Value;
            if (r.WireGaugeMm2 != null) o.WireGaugeMm2 = r.WireGaugeMm2.Value;
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
            // The record edit above always persists (offline config authoring). Only push to the
            // module over CAN when it is actually live; report which happened so the UI can say
            // "written to device" vs "saved to project".
            var live = IsLiveModule(g, dm, adapters);
            if (live) dm.WriteOutputParams(g, r.Number);
            return Results.Ok(new { ok = true, written = live });
        });

        // Single-param read/write (paced, no bulk burst) — reliable on the USB-direct link.
        api.MapPost("/devices/{guid}/readparam", (string guid, ReadParamReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (r.Index is < 0 or > 0xFFFF || r.Sub is < 0 or > 0xFF)
                return Results.BadRequest(new { ok = false, error = "Index must be 0–65535 (0xFFFF) and Sub 0–255 (0xFF)." });
            if (RequireLiveModule(g, dm, adapters, "read") is { } bad) return bad;
            return dm.ReadParam(g, r.Index, r.Sub) ? Results.Ok(new { ok = true }) : Results.BadRequest();
        });

        api.MapPost("/devices/{guid}/writeparam", (string guid, WriteParamReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (r.Index is < 0 or > 0xFFFF || r.Sub is < 0 or > 0xFF)
                return Results.BadRequest(new { ok = false, error = "Index must be 0–65535 (0xFFFF) and Sub 0–255 (0xFF)." });
            if (RequireLiveModule(g, dm, adapters, "write") is { } bad) return bad;
            return dm.WriteParam(g, r.Index, r.Sub, r.Value) ? Results.Ok(new { ok = true }) : Results.BadRequest();
        });

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
        api.MapPost("/devices/{guid}/function/{kind}/{number:int}", async (string guid, string kind, int number, HttpRequest req, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not IDeviceConfigurable dev) return Results.BadRequest();
            var (fn, paramIndex) = FunctionMap.Resolve(dev, kind, number);
            if (fn == null || paramIndex < 0) return Results.NotFound(new { error = $"unknown function {kind} #{number}" });
            using var doc = await JsonDocument.ParseAsync(req.Body);
            FunctionMap.ApplyJson(fn, doc.RootElement);
            // Record edit persists offline; CAN write only when live (see /outputconfig).
            var live = IsLiveModule(g, dm, adapters);
            if (live) dm.WriteFunctionParams(g, paramIndex);
            return Results.Ok(new { ok = true, written = live });
        });

        // Upload one assembled Lua program to the device (chunked, paced on the backend).
        api.MapPost("/devices/{guid}/lua", (string guid, LuaReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            // Store on the device record (persists in the project JSON, offline-safe), then push over
            // CAN only when the module is live — same model as output/function params. Push it later
            // with device_action "uploadlua" once the module is online.
            dm.StoreLua(g, r.Source ?? "");
            var live = IsLiveModule(g, dm, adapters);
            if (live && !dm.UploadLua(g, r.Source ?? ""))
                return Results.BadRequest(new { ok = false, error = "upload rejected (too big, or not a Lua-capable PDM)" });
            return Results.Ok(new { ok = true, written = live });
        });

        // Read the stored Lua program back from the device (a live CAN read).
        api.MapGet("/devices/{guid}/lua", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            // Live: read the running program off the device. Offline: return the stored program from
            // the project record (so cross-module / authored Lua is visible without a live module).
            if (IsLiveModule(g, dm, adapters))
                return Results.Ok(new { source = await dm.ReadLua(g), live = true });
            return Results.Ok(new { source = dm.GetStoredLua(g), live = false });
        });

        // Read the device's last Lua runtime error (empty if none).
        api.MapGet("/devices/{guid}/luaerror", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (RequireLiveModule(g, dm, adapters, "read the error state from") is { } bad) return bad;
            var error = await dm.ReadLuaError(g);
            return Results.Ok(new { error });
        });

        // Read the on-device overload (trip) log: events with ±window current waveforms.
        api.MapGet("/devices/{guid}/overloads", async (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (RequireLiveModule(g, dm, adapters, "read trips from") is { } bad) return bad;
            var events = await dm.ReadOverloadLog(g);
            return Results.Ok(new { events });
        });

        // Clear the on-device overload log.
        api.MapPost("/devices/{guid}/overloads/clear", (string guid, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();
            if (RequireLiveModule(g, dm, adapters, "clear trips on") is { } bad) return bad;
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

        // Flash a BLANK / new module (no firmware on the bus yet). The operator puts it in DFU by hand
        // (BOOT0 + reset, USB connected); we skip the CAN bootloader command (Guid.Empty = no bus device)
        // and let dfu-util flash whatever STM32 ROM-DFU device is present.
        api.MapPost("/flash/blank", async (HttpRequest req, FirmwareFlashService flasher) =>
        {
            using var ms = new MemoryStream();
            await req.Body.CopyToAsync(ms);
            var res = await flasher.FlashAsync(Guid.Empty, ms.ToArray());
            return Results.Ok(new { ok = res.Ok, log = res.Log });
        });

        // Live flash progress (polled by the UI while a flash is in flight).
        api.MapGet("/flash/status", (FirmwareFlashService flasher) =>
        {
            var s = flasher.Status();
            return Results.Ok(new { busy = s.Busy, percent = s.Percent, phase = s.Phase });
        });

        // Scan for DFU devices (runs dfu-util -l) so the operator can see what's attached before flashing.
        api.MapGet("/flash/dfu", async (FirmwareFlashService flasher) =>
        {
            var s = await flasher.ScanAsync();
            return Results.Ok(new { utilOk = s.UtilOk, util = s.Util, devices = s.DfuDevices, raw = s.Raw });
        });

        // ---- Declarative whole-system config (AI-friendly): schema + snapshot + apply ----
        // GET schema  -> every device + every setting (name/type/default/enum options) + var-map
        api.MapGet("/config/schema", (SystemConfigService cfg) => Results.Ok(cfg.BuildSchema()));
        // GET template -> a ready-to-edit apply document with EVERY setting at its default,
        // plus a sample Lua program and cross-module guidance. Download, edit, re-import.
        api.MapGet("/config/template", (SystemConfigService cfg) => Results.Ok(cfg.BuildTemplate()));
        // GET snapshot -> current value of every setting (Read the device(s) first). ?lua=true also reads Lua.
        api.MapGet("/config", async (bool? lua, SystemConfigService cfg) => Results.Ok(await cfg.BuildSnapshotAsync(lua ?? false)));
        // POST apply  -> a (full or partial) target document; writes only what differs, burns, uploads Lua.
        api.MapPost("/config", async (HttpRequest req, SystemConfigService cfg) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            var r = cfg.Apply(doc.RootElement);
            var ok = r.Errors.Count == 0;
            var payload = new { ok, devicesTouched = r.DevicesTouched, paramsChanged = r.ParamsChanged, notes = r.Notes, errors = r.Errors };
            // Validation failures now surface as HTTP 400 (was 200 + ok:false) so the frontend's
            // !r.ok / fetch-error path fires on the transport layer too, not just the body flag.
            return ok ? Results.Ok(payload) : Results.Json(payload, statusCode: 400);
        });

        // ---- CANopen SDO: read/write a keypad's object dictionary (persistent device settings) ----
        // Bounds: Node 1–127 (CANopen node-id range), Index 0–0xFFFF, Sub 0–0xFF, Size 1/2/4 bytes.
        static IResult? SdoBounds(int node, int index, int sub)
            => node is < 1 or > 127 || index is < 0 or > 0xFFFF || sub is < 0 or > 0xFF
                ? Results.BadRequest(new { ok = false, error = "Node must be 1–127, Index 0–65535 (0xFFFF), Sub 0–255 (0xFF)." })
                : null;
        api.MapPost("/sdo/read", async (SdoReadReq r, SdoService sdo) =>
        {
            if (SdoBounds(r.Node, r.Index, r.Sub) is { } bad) return bad;
            var res = await sdo.ReadAsync(r.Node, (ushort)r.Index, (byte)r.Sub);
            return Results.Ok(new { ok = res.Ok, value = res.Value, abort = res.AbortCode, error = res.Error });
        });
        api.MapPost("/sdo/write", async (SdoWriteReq r, SdoService sdo) =>
        {
            if (SdoBounds(r.Node, r.Index, r.Sub) is { } bad) return bad;
            if (r.Size is not (<= 0 or 1 or 2 or 4))
                return Results.BadRequest(new { ok = false, error = "Size must be 1, 2 or 4 bytes." });
            var res = await sdo.WriteAsync(r.Node, (ushort)r.Index, (byte)r.Sub, r.Value, r.Size <= 0 ? 4 : r.Size);
            return Results.Ok(new { ok = res.Ok, abort = res.AbortCode, error = res.Error });
        });
        // Store (save) the node's parameters to NV memory — OD 0x1010 sub1 = "save".
        api.MapPost("/sdo/store", async (SdoNodeReq r, SdoService sdo) =>
        {
            if (r.Node is < 1 or > 127) return Results.BadRequest(new { ok = false, error = "Node must be 1–127." });
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

        // Broadcast-signal catalog: what this device TRANSMITS cyclically, address-agnostic
        // (offset = MessageId - BaseId, so it holds at any base ID). Feeds the cross-module
        // "remote signal" picker — a consumer decodes another module's native frame at
        // base+offset. Derived straight from GetStatusSigs() (the CAN frame map).
        api.MapGet("/devices/{guid}/broadcast-signals", (string guid, bool? inUse, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g) || dm.GetDevice(g) is not { } d)
                return Results.NotFound();
            var baseId = d.BaseId;
            var onlyInUse = inUse ?? false;   // ?inUse=true → only signals whose function is enabled (the picker's view)
            var sigs = d.GetStatusSigs()
                .Where(t => !onlyInUse || SignalInUse(d, t.Signal.Name))
                .Select(t => new
                {
                    name = t.Signal.Name,
                    offset = t.MessageId - baseId,
                    startBit = t.Signal.StartBit,
                    bitLength = t.Signal.Length,
                    factor = t.Signal.Factor,
                    valueOffset = t.Signal.Offset,
                    byteOrder = (int)t.Signal.ByteOrder,
                    signed = t.Signal.IsSigned,
                    unit = t.Signal.Unit,
                    kind = t.Signal.Length == 1 ? "bool" : "value",
                })
                .OrderBy(s => s.offset).ThenBy(s => s.startBit)
                .ToList();
            return Results.Ok(sigs);
        });

        // Cross-module IO picker (feature B), server-side: point a consumer module's CAN input at a
        // SOURCE module's broadcast signal. Resolves the signal's current absolute CAN id + bit layout
        // from the source's frame map and writes the consumer's CAN input — what the UI picker does
        // client-side, in one call. Re-run after a source base-ID change to re-resolve the id.
        api.MapPost("/devices/{guid}/link-remote", (string guid, LinkRemoteReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var cg) || dm.GetDevice(cg) is not IDeviceConfigurable consumer)
                return Results.BadRequest(new { error = "bad or non-configurable consumer guid" });
            if (!Guid.TryParse(r.SourceGuid, out var sg) || dm.GetDevice(sg) is not { } src)
                return Results.BadRequest(new { error = "bad source guid" });
            var match = src.GetStatusSigs().FirstOrDefault(t => t.Signal.Name == r.Signal);
            if (match.Signal is null)
                return Results.NotFound(new { error = $"'{r.Signal}' is not broadcast by {src.Name}" });
            var (fn, paramIndex) = FunctionMap.Resolve(consumer, "caninput", r.CanInput);
            if (fn is not CanInput ci || paramIndex < 0)
                return Results.NotFound(new { error = $"CAN input #{r.CanInput} not found on the consumer" });
            var sig = match.Signal;
            ci.Enabled = true;
            ci.Id = match.MessageId;            // absolute id = source base + offset (setter sets Ide)
            ci.StartBit = sig.StartBit;
            ci.BitLength = sig.Length;
            ci.Factor = sig.Factor;
            ci.Offset = sig.Offset;
            ci.ByteOrder = sig.ByteOrder;
            ci.Signed = sig.IsSigned;
            if (string.IsNullOrWhiteSpace(ci.Name) || System.Text.RegularExpressions.Regex.IsMatch(ci.Name, @"^canInput\d+$"))
                ci.Name = $"{src.Name} {sig.Name}";
            var live = IsLiveModule(cg, dm, adapters);
            if (live) dm.WriteFunctionParams(cg, paramIndex);
            return Results.Ok(new
            {
                ok = true, written = live, source = src.Name, signal = sig.Name, canInput = r.CanInput,
                id = ci.Id, ide = ci.Ide, startBit = ci.StartBit, bitLength = ci.BitLength,
                factor = ci.Factor, offset = ci.Offset, byteOrder = (int)ci.ByteOrder, signed = ci.Signed, name = ci.Name,
            });
        });

        // Cross-module functions, server-side: compile a list of function definitions (trigger → target
        // outputs, optional synchronised blink with a clock master + failover backup) into per-module
        // Lua + output bindings, and deploy to each PDM. Mirrors the System-view "cross-module functions"
        // compiler. Lua runs only on PDMs, so every involved module must be a live dingoPDM/-Max.
        api.MapPost("/system/cross-module/deploy", async (HttpRequest req, DeviceManager dm, ICommsAdapterManager adapters, CrossModuleStore store) =>
        {
            using var doc = await JsonDocument.ParseAsync(req.Body);
            var root = doc.RootElement;
            var preview = root.TryGetProperty("preview", out var pv) && pv.ValueKind == JsonValueKind.True;
            var fnsEl = root.TryGetProperty("functions", out var fe) && fe.ValueKind == JsonValueKind.Array ? fe : default;
            var fns = fnsEl.ValueKind == JsonValueKind.Array
                ? JsonSerializer.Deserialize<List<CrossFnReq>>(fnsEl.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new()
                : new List<CrossFnReq>();
            // Record the raw function DEFINITIONS so the System view can list/edit MCP-deployed
            // functions (it imports them on mount). Skipped for a preview.
            if (!preview && fnsEl.ValueKind == JsonValueKind.Array) store.Set(fnsEl.GetRawText());
            var compiled = CompileCrossModule(fns);
            if (preview)
                return Results.Ok(new
                {
                    ok = true, preview = true,
                    modules = compiled.Select(kv => new
                    {
                        guid = kv.Key,
                        name = Guid.TryParse(kv.Key, out var pg) && dm.GetDevice(pg) is { } pd ? pd.Name : kv.Key,
                        lua = kv.Value.Lua, bindings = kv.Value.Bindings,
                    }).ToList(),
                });
            var results = new List<object>();
            var allOk = true;
            void Fail(string name, string error) { allOk = false; results.Add(new { name, ok = false, error }); }
            foreach (var (gs, plan) in compiled)
            {
                if (!Guid.TryParse(gs, out var g) || dm.GetDevice(g) is not { } dev) { Fail(gs, "device not in project"); continue; }
                if (dev is not PdmDevice pdm) { Fail(dev.Name, $"{dev.Name} has no Lua engine — only dingoPDM/-Max run Lua. Use link_remote_signal for a CANBoard target."); continue; }
                try
                {
                    // Offline-safe: store Lua + bindings on the device record (persists in the project),
                    // and push over CAN only when the module is live — exactly how params behave. A
                    // module that's offline gets "saved" (written=false); push later with device_action
                    // "uploadlua" + "writeall", or re-deploy once it's online.
                    var live = IsLiveModule(g, dm, adapters);
                    dm.StoreLua(g, plan.Lua);
                    if (live) dm.UploadLua(g, plan.Lua);
                    var luaOut1 = pdm.VarMap.FirstOrDefault(v => v.GetName() == "Lua Out 1");
                    var bound = new List<int>();
                    foreach (var outNum in plan.Bindings)
                    {
                        var o = pdm.GetOutputs().FirstOrDefault(x => x.Number == outNum);
                        if (o == null) continue;
                        if (luaOut1 == null) throw new InvalidOperationException("couldn't resolve the 'Lua Out 1' var-map index");
                        if (o.CurrentLimit <= 0) throw new InvalidOperationException($"output {outNum} has no current limit yet — set it (Read or set_output_config) before binding so its trip point isn't guessed");
                        o.Enabled = true;
                        o.Input = luaOut1.VariableIndex + (outNum - 1);   // drive output N from "Lua Out N"
                        if (live) dm.WriteOutputParams(g, outNum);        // record edit persists; CAN write only when live
                        bound.Add(outNum);
                    }
                    results.Add(new { name = dev.Name, ok = true, written = live, boundOutputs = bound, luaBytes = plan.Lua.Length });
                }
                catch (Exception e) { Fail(dev.Name, e.Message); }
            }
            return Results.Ok(new { ok = allOk, modules = results });
        });

        // The cross-module function DEFINITIONS currently held on the backend (set by deploy_cross_module).
        // The System view imports these on mount so MCP-deployed functions appear in its list.
        api.MapGet("/system/cross-module", (CrossModuleStore store) => Results.Text(store.Get(), "application/json"));

        api.MapGet("/devices/{guid}/signals", (string guid, DeviceManager dm) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.Ok(Array.Empty<SignalDto>());
            var s = new List<SignalDto>();
            if (dm.GetDevice(g) is PdmDevice p)
            {
                foreach (var i in p.Inputs) s.Add(new("Digital input", i.Name, i.State ? "on" : "off", i.State));
                foreach (var c in p.CanInputs) s.Add(new("CAN input", c.Name, c.Value.ToString(), c.Value != 0));
                foreach (var v in p.VirtualInputs) s.Add(new("Virtual input", v.Name, v.Value ? "on" : "off", v.Value));
                foreach (var c in p.Conditions) s.Add(new("Condition", c.Name, c.Value.ToString(), c.Value != 0));
                foreach (var c in p.Counters) s.Add(new("Counter", c.Name, c.Value.ToString(), c.Value != 0));
                foreach (var f in p.Flashers) s.Add(new("Flasher", f.Name, f.Value ? "on" : "off", f.Value));
                foreach (var o in p.Outputs) s.Add(new("Output", o.Name, o.State.ToString(), o.State.ToString() == "On"));
            }
            else if (dm.GetDevice(g) is CanboardDevice cb)
            {
                // A CANBoard analog input exposes three live signals: raw mV, rotary position
                // ("<name> Pos" — drives the multi-position switch readout), and switch state.
                foreach (var a in cb.AnalogInputs)
                {
                    s.Add(new("Analog input", a.Name, ((int)a.Millivolts).ToString(), a.Millivolts > 0));
                    s.Add(new("Rotary position", a.Name + " Pos", a.Rotary.Pos.ToString(), a.Rotary.Pos != 0));
                    s.Add(new("Analog switch", a.Name + " Switch", a.Switch.State ? "on" : "off", a.Switch.State));
                }
                foreach (var i in cb.DigitalInputs) s.Add(new("Digital input", i.Name, i.State ? "on" : "off", i.State));
                foreach (var o in cb.DigitalOutputs) s.Add(new("Digital output", o.Name, o.State ? "on" : "off", o.State));
                foreach (var c in cb.CanInputs) s.Add(new("CAN input", c.Name, c.Value.ToString(), c.Value != 0));
                foreach (var v in cb.VirtualInputs) s.Add(new("Virtual input", v.Name, v.Value ? "on" : "off", v.Value));
                foreach (var c in cb.Conditions) s.Add(new("Condition", c.Name, c.Value.ToString(), c.Value != 0));
                foreach (var c in cb.Counters) s.Add(new("Counter", c.Name, c.Value.ToString(), c.Value != 0));
                foreach (var f in cb.Flashers) s.Add(new("Flasher", f.Name, f.Value ? "on" : "off", f.Value));
            }
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

        api.MapPost("/project/open", async (ProjReq r, ConfigFileManager cfg, DeviceManager dm, CrossModuleStore xmod) =>
        {
            // Load FIRST; only clear the current project once we have a valid replacement. The old
            // order cleared then checked for null, silently wiping every device on a bad/missing file.
            try
            {
                var devs = await cfg.LoadDevices(r.FileName);
                if (devs == null)
                    return Results.Text($"Could not open '{r.FileName}' — not found or not a valid project file.", "text/plain", null, 400);
                dm.ClearDevices();
                xmod.Clear();   // cross-module defs are per-project; the UI re-imports for the new project
                dm.AddDevices(devs);
                return Results.Ok(new { ok = true, count = devs.Count });
            }
            catch (Exception e)
            {
                return Results.Text($"Could not open '{r.FileName}': {e.Message}", "text/plain", null, 400);
            }
        });

        api.MapPost("/project/new", (ConfigFileManager cfg, DeviceManager dm, CrossModuleStore xmod) =>
        {
            dm.ClearDevices(); xmod.Clear(); cfg.NewFile(); return Results.Ok(new { ok = true });
        });

        // Local-PC project SAVE: stream the whole project (ConfigFile JSON) back so the browser
        // saves it wherever the user chooses. No server-side folder — works on Windows/Mac/Linux.
        api.MapGet("/project/download", (ConfigFileManager cfg, DeviceManager dm) =>
            Results.Text(cfg.SerializeDevices(dm.GetDevices()), "application/json"));

        // Local-PC project OPEN: load a project file the user picked on their PC (raw ConfigFile
        // JSON in the body). The current project is replaced only on a successful parse.
        api.MapPost("/project/upload", async (HttpRequest req, ConfigFileManager cfg, DeviceManager dm, CrossModuleStore xmod) =>
        {
            using var reader = new StreamReader(req.Body);
            var json = await reader.ReadToEndAsync();
            try
            {
                var devs = cfg.LoadDevicesFromJson(json);
                if (devs == null) return Results.Text("Not a valid project file.", "text/plain", null, 400);
                dm.ClearDevices();
                xmod.Clear();   // cross-module defs are per-project; the UI re-imports for the new project
                dm.AddDevices(devs);
                cfg.NewFile();   // opened from an external file, not one of our working-dir files
                return Results.Ok(new { ok = true, count = devs.Count });
            }
            catch (Exception e)
            {
                return Results.Text("Couldn't open project: " + e.Message, "text/plain", null, 400);
            }
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

        // Commission a connected module: write a saved profile (another project device) onto it,
        // including re-addressing it to the profile's base ID. Lua follows from the client side.
        api.MapPost("/devices/{guid}/apply-profile", (string guid, ApplyProfileReq r, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var t)) return Results.BadRequest();
            if (!adapters.GetStatus().isConnected) return Results.Text("Not connected to a CAN adapter — connect first.", "text/plain", null, 400);
            if (!Guid.TryParse(r.Source, out var s)) return Results.Text("Invalid source profile.", "text/plain", null, 400);
            var (ok, err) = dm.ApplyProfile(t, s);
            return ok ? Results.Ok(new { ok = true, baseId = dm.GetDevice(t)?.BaseId }) : Results.Text(err, "text/plain", null, 400);
        });

        api.MapPost("/devices/{guid}/{action}", (string guid, string action, DeviceManager dm, ICommsAdapterManager adapters) =>
        {
            if (!Guid.TryParse(guid, out var g)) return Results.BadRequest();

            // These talk to live hardware over CAN. The writes are fire-and-forget, so without
            // a guard they "succeed" silently against an empty bus. Refuse unless the adapter is
            // connected AND the target module is actually broadcasting (seen within ~500 ms).
            string[] liveActions = ["read", "readall", "write", "writeall", "burn", "sleep", "wakeup", "bootloader", "version", "uploadlua"];
            if (liveActions.Contains(action))
            {
                if (!adapters.GetStatus().isConnected)
                    return Results.Text("Not connected to a CAN adapter — connect first.", "text/plain", null, 400);
                var dev = dm.GetDevice(g);
                if (dev == null) return Results.NotFound();
                dev.UpdateIsConnected();
                if (!dev.Connected)
                    return Results.Text($"Module 0x{dev.BaseId:X} ({dev.Name}) is not responding on the bus — nothing to {action}. Check power, wiring, base ID and bitrate.", "text/plain", null, 400);
            }

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
                // Push the Lua program stored on the record (e.g. an offline cross-module deploy) to the
                // now-live module. Pair with "writeall" to also push the output bindings (params).
                case "uploadlua": dm.UploadLua(g, dm.GetStoredLua(g)); break;
                default: return Results.NotFound();
            }
            return Results.Ok(new { ok = true });
        });
    }

    // Shared precondition for endpoints that talk to LIVE hardware over CAN: the adapter must be
    // open AND the target module must actually be answering on the bus. Returns an IResult to
    // short-circuit with, or null when it's safe to proceed. Mirrors the /{action} guard so every
    // CAN-commit path fails loud and consistent instead of "succeeding" against an empty bus.
    // (Base-ID/rename are offline-safe and firmware/DFU runs over USB — neither uses this.)
    private static IResult? RequireLiveModule(Guid g, DeviceManager dm, ICommsAdapterManager adapters, string verb)
    {
        if (!adapters.GetStatus().isConnected)
            return Results.Text("Not connected to a CAN adapter — connect first.", "text/plain", null, 400);
        var dev = dm.GetDevice(g);
        if (dev == null) return Results.NotFound();
        dev.UpdateIsConnected();
        if (!dev.Connected)
            return Results.Text($"Module 0x{dev.BaseId:X} ({dev.Name}) is not responding on the bus — nothing to {verb}. Check power, wiring, base ID and bitrate.", "text/plain", null, 400);
        return null;
    }

    // True when the adapter is open and the module is answering. Used by endpoints that ALSO
    // persist an offline project-record edit (outputconfig/function): the record edit always
    // applies; only the CAN write is conditioned on this so offline config authoring still works.
    private static bool IsLiveModule(Guid g, DeviceManager dm, ICommsAdapterManager adapters)
    {
        if (!adapters.GetStatus().isConnected) return false;
        var dev = dm.GetDevice(g);
        if (dev == null) return false;
        dev.UpdateIsConnected();
        return dev.Connected;
    }

    // Is a broadcast signal actually wired up on its source? Mirrors the UI picker's filter so
    // broadcast_signals?inUse=true shows only configured signals. System telemetry is always live;
    // everything else follows its function's Enabled flag (analog sub-signals need the input + its
    // rotary/switch mode enabled).
    private static bool SignalInUse(IDevice d, string name)
    {
        if (System.Text.RegularExpressions.Regex.IsMatch(name, "^(DeviceState|PdmType|TotalCurrent|BatteryVoltage|BoardTemp|Heartbeat)"))
            return true;
        var m = System.Text.RegularExpressions.Regex.Match(name, @"^([A-Za-z]+?)(\d+)");
        if (!m.Success) return true;
        var kind = m.Groups[1].Value;
        var n = int.Parse(m.Groups[2].Value);
        var digitalMode = name.Contains("DigitalMode");
        if (d is PdmDevice p)
            return kind switch
            {
                "Input" => p.GetInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Output" => p.GetOutputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "CanInput" => p.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "VirtualInput" => p.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Condition" => p.GetConditions().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Counter" => p.GetCounters().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Flasher" => p.GetFlashers().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Wiper" => p.GetWipers()?.Enabled ?? false,
                _ => true,
            };
        if (d is CanboardDevice c)
            return kind switch
            {
                "AnalogInput" => c.GetAnalogInputs().FirstOrDefault(x => x.Number == n) is { } a && a.Enabled && (!digitalMode || a.Switch.Enabled),
                "RotarySwitch" => c.GetAnalogInputs().FirstOrDefault(x => x.Number == n) is { } a && a.Enabled && a.Rotary.Enabled,
                "DigitalInput" => c.GetDigitalInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "DigitalOutput" => c.GetDigitalOutputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "CanInput" => c.GetCanInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "VirtualInput" => c.GetVirtualInputs().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Condition" => c.GetConditions().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Counter" => c.GetCounters().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                "Flasher" => c.GetFlashers().FirstOrDefault(x => x.Number == n)?.Enabled ?? false,
                _ => true,
            };
        return true;
    }

    private sealed class CmfMod
    {
        public readonly HashSet<int> Rx = new();
        public readonly List<string> Decl = new(), RxCases = new(), Tick = new();
        public readonly HashSet<int> TrigDecl = new(), ClkDecl = new(), ClkGen = new();
        public readonly List<int> Bindings = new();
    }

    // Compile cross-module function definitions into per-module Lua + output bindings — a faithful
    // port of compileCrossModule() in store.js. Each function uses a reserved CAN-ID pair from its
    // slot (array index): trigger 0x520+slot*2, clock +1. Blink uses a clock master (defaults to the
    // trigger owner) and an optional failover backup.
    private static Dictionary<string, (string Lua, List<int> Bindings)> CompileCrossModule(IReadOnlyList<CrossFnReq> fns)
    {
        const int idBase = 0x520;
        var mods = new Dictionary<string, CmfMod>();
        CmfMod M(string g) { if (!mods.TryGetValue(g, out var m)) mods[g] = m = new CmfMod(); return m; }

        for (var i = 0; i < fns.Count; i++)
        {
            var f = fns[i];
            if (f is null || f.Disabled || string.IsNullOrEmpty(f.Trigger?.Guid) || f.Trigger!.VarIndex is null) continue;
            var slot = i;
            int trig = idBase + slot * 2, clk = trig + 1;
            var half = ((f.BlinkRateMs <= 0 ? 350 : f.BlinkRateMs) / 1000.0).ToString("0.000", System.Globalization.CultureInfo.InvariantCulture);
            var p = $"_cmf{slot}";
            var blink = f.Blink;
            var ownerG = f.Trigger.Guid;
            var masterG = blink ? (string.IsNullOrEmpty(f.ClockMaster) ? ownerG : f.ClockMaster) : null;
            var backupG = blink && !string.IsNullOrEmpty(f.ClockBackup) ? f.ClockBackup : null;

            var om = M(ownerG);
            om.Tick.Add($"  {p}trig = readVar({f.Trigger.VarIndex}) ~= 0 and 1 or 0");
            om.Tick.Add($"  txCan(1, {trig}, false, {{ {p}trig }})");
            om.Decl.Add($"local {p}trig = 0");

            void NeedTrig(string g)
            {
                if (g == ownerG) return;
                var m = M(g);
                if (m.TrigDecl.Add(slot)) { m.Decl.Add($"local {p}trig = 0"); m.Rx.Add(trig); m.RxCases.Add($"  if id == {trig} then {p}trig = data[1] end"); }
            }
            void NeedClkRx(string g)
            {
                var m = M(g);
                if (m.ClkDecl.Add(slot)) { m.Decl.Add($"local {p}clk = 0"); m.Rx.Add(clk); m.RxCases.Add($"  if id == {clk} then {p}clk = data[1] end"); }
            }

            if (masterG != null)
            {
                var m = M(masterG);
                NeedTrig(masterG);
                m.Decl.Add($"local {p}clk = 0"); m.Decl.Add($"local {p}ct = Timer.new()");
                m.ClkGen.Add(slot);
                m.Tick.Add($"  if {p}trig == 1 then\n    if {p}ct:getElapsedSeconds() >= {half} then {p}ct:reset(); {p}clk = 1 - {p}clk end\n  else {p}clk = 0; {p}ct:reset() end\n  txCan(1, {clk}, false, {{ {p}clk, 0 }})");
            }
            if (backupG != null && backupG != masterG)
            {
                var m = M(backupG);
                NeedTrig(backupG);
                m.Decl.Add($"local {p}clk = 0"); m.Decl.Add($"local {p}ct = Timer.new()"); m.Decl.Add($"local {p}seen = Timer.new()");
                m.Rx.Add(clk);
                m.RxCases.Add($"  if id == {clk} and data[2] == 0 then {p}seen:reset() end");
                m.Tick.Add($"  if {p}seen:getElapsedSeconds() > 0.3 and {p}trig == 1 then\n    if {p}ct:getElapsedSeconds() >= {half} then {p}ct:reset(); {p}clk = 1 - {p}clk end\n    txCan(1, {clk}, false, {{ {p}clk, 1 }})\n  end");
            }
            foreach (var t in f.Targets ?? new List<CrossTargetReq>())
            {
                if (string.IsNullOrEmpty(t.Guid) || t.Output <= 0) continue;
                var m = M(t.Guid);
                NeedTrig(t.Guid);
                var oslot = t.Output - 1;
                string drive;
                if (blink) { if (!m.ClkGen.Contains(slot)) NeedClkRx(t.Guid); drive = $"({p}trig ~= 0 and {p}clk ~= 0) and 1 or 0"; }
                else drive = $"({p}trig ~= 0) and 1 or 0";
                m.Tick.Add($"  setLuaOut({oslot}, {drive})");
                m.Bindings.Add(t.Output);
            }
        }

        var outp = new Dictionary<string, (string, List<int>)>();
        foreach (var (g, m) in mods)
        {
            if (m.Tick.Count == 0) continue;
            var sb = new System.Text.StringBuilder();
            sb.Append("-- Cross-module functions — generated by dingoConfig (MCP deploy).\n");
            sb.Append(string.Join("\n", m.Decl.Distinct())).Append('\n');
            foreach (var id in m.Rx) sb.Append($"canRxAdd({id})\n");
            if (m.RxCases.Count > 0) sb.Append("function onCanRx(bus, id, dlc, data)\n").Append(string.Join("\n", m.RxCases.Distinct())).Append("\nend\n");
            sb.Append("function onTick()\n").Append(string.Join("\n", m.Tick)).Append("\nend\nsetTickRate(50)\n");
            outp[g] = (sb.ToString(), m.Bindings);
        }
        return outp;
    }
}
