using application.Services;
using domain.Interfaces;
using infrastructure.Comms;

namespace web.Api;

/// <summary>
/// G10: remembers the last connection that worked (adapter, port, bitrate) in the user preferences, connects
/// to it at startup when asked to, and reconnects when the link drops on its own. A Disconnect from the user
/// stops the reconnecting until the next Connect.
/// </summary>
public sealed class ConnectionKeeper(ICommsAdapterManager adapters, UserPreferencesManager prefs, ConfigFileManager cfg, ILogger<ConnectionKeeper> log) : BackgroundService
{
    private volatile bool _wanted;          // the user asked for a connection and has not disconnected since
    private readonly SemaphoreSlim _gate = new(1, 1);

    // Lost = the adapter manager dropped the adapter (it does on a closed port / socket). Not IsConnected: an
    // SLCAN link reads "not connected" after 500 ms without frames, e.g. while every module sleeps.
    private bool Lost => adapters.ActiveAdapter is null;
    public bool Reconnecting => _wanted && AutoReconnect && Lost;
    public bool AutoConnect => prefs.Preferences.AutoConnect;
    public bool AutoReconnect => prefs.Preferences.AutoReconnect;
    public object? Last => prefs.Preferences.SelectedAdapter is { } a
        ? new { adapter = a, port = prefs.Preferences.SelectedPort, bitrate = DingoMap.BitrateLabel(prefs.Preferences.SelectedBitrate) }
        : null;

    /// <summary>Connect as asked by the user (or a reconnect). Saves the connection when it works.</summary>
    public async Task<(bool Ok, string? Port, string? Error)> ConnectAsync(string adapter, string port, domain.Enums.CanBitRate bitrate)
    {
        await _gate.WaitAsync();
        try
        {
            var r = await ConnectCoreAsync(adapter, port, bitrate);
            if (r.Ok)
            {
                _wanted = true;
                // a log replay is not the car: keep the car's connection as the one to come back to
                if (adapter == "Sim") return r;
                var p = prefs.Preferences;
                // "USB" keeps no port: it is looked up again on every connect (the COM number can change)
                p.SelectedAdapter = adapter; p.SelectedPort = adapter == "USB" ? "" : port; p.SelectedBitrate = bitrate;
                prefs.Save();
            }
            return r;
        }
        finally { _gate.Release(); }
    }

    public async Task<bool> DisconnectAsync()
    {
        _wanted = false;
        return await adapters.DisconnectAsync();
    }

    public void SetOptions(bool? autoConnect, bool? autoReconnect)
    {
        if (autoConnect is bool c) prefs.Preferences.AutoConnect = c;
        if (autoReconnect is bool r) prefs.Preferences.AutoReconnect = r;
        prefs.Save();
    }

    private async Task<(bool Ok, string? Port, string? Error)> ConnectCoreAsync(string adapter, string port, domain.Enums.CanBitRate bitrate)
    {
        if (adapter == "USB")   // find the module's COM port; try each one found (several modules plugged in)
        {
            var found = UsbPortFinder.Find();
            if (found.Length == 0)
                return (false, null, $"No dingo module found on USB ({UsbPortFinder.Vid}:{UsbPortFinder.Pid}) — check the cable carries data and the module has 12 V.");
            foreach (var p in found)
                if (await adapters.ConnectAsync(adapters.ToAdapter("USB"), p, bitrate, CancellationToken.None))
                    return (true, p, null);
            return (false, null, $"Found {string.Join(", ", found)} but couldn't open it — is another program using the port?");
        }
        var ok = await adapters.ConnectAsync(adapters.ToAdapter(adapter), port, bitrate, CancellationToken.None);
        return (ok, port, null);
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        prefs.Initialize();
        cfg.WorkingDirectory = prefs.Preferences.WorkingDirectory;   // the project folder the preferences name (default Documents\dingoConfig)
        var p = prefs.Preferences;
        if (p.AutoConnect && p.SelectedAdapter is { } a)
        {
            log.LogInformation("Connecting to the last adapter ({Adapter} {Port})", a, p.SelectedPort);
            try { if ((await ConnectAsync(a, p.SelectedPort ?? "", p.SelectedBitrate)).Ok) log.LogInformation("Connected at startup"); }
            catch (Exception e) { log.LogWarning("Startup connect failed: {Msg}", e.Message); }
        }
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(2000, ct); } catch (OperationCanceledException) { return; }
            // The module on USB is asked for its id once, at connect. Still booting then (the reconnect after a DFU
            // update) it gave none, every PDM looked CAN-only and its update went over CAN: ask until it answers.
            if (!Lost && adapters.GatewayBaseId is null && prefs.Preferences.SelectedAdapter == "USB")
            {
                try { if (await adapters.ReidentifyAsync(ct) is int gw) log.LogInformation("Module on USB answers at 0x{Id:X3}", gw); }
                catch (Exception e) { log.LogDebug("USB identify failed: {Msg}", e.Message); }
            }
            if (!Reconnecting || prefs.Preferences.SelectedAdapter is not { } adapter) continue;
            try
            {
                if (!await _gate.WaitAsync(0, ct)) continue;   // a user connect is running
                try
                {
                    if (!Reconnecting) continue;
                    var r = await ConnectCoreAsync(adapter, prefs.Preferences.SelectedPort ?? "", prefs.Preferences.SelectedBitrate);
                    if (r.Ok) log.LogInformation("Reconnected ({Adapter} {Port})", adapter, r.Port);
                }
                finally { _gate.Release(); }
            }
            catch (Exception e) { log.LogDebug("Reconnect attempt failed: {Msg}", e.Message); }
        }
    }
}
