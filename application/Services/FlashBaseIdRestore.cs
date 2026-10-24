using domain.Devices.Canboard;
using domain.Interfaces;

namespace application.Services;

/// <summary>
/// After a firmware update a module can come back on the firmware's default base ID instead of the one it had: a new
/// settings layout (5.7) or a family switch starts it from factory settings. This puts it back on the ID it had before
/// the flash, the way Deploy to USB moves a module: a temporary project entry at the default ID re-addresses it (the
/// module stores the ID), then the entry goes. The rest of its settings stay at their defaults until the project is applied.
/// </summary>
public class FlashBaseIdRestore(DeviceManager dm, ICommsAdapterManager adapters)
{
    public const int PdmDefaultBaseId = 0x0DE;       // firmware DEFAULT_BASE_ID (boards/*/port.h)
    public const int CanboardDefaultBaseId = 0x640;

    public static int DefaultBaseIdFor(IDevice d) => d is CanboardDevice ? CanboardDefaultBaseId : PdmDefaultBaseId;

    /// <summary>Wait for the flashed module on <paramref name="savedBase"/>; if it answers on its default ID instead,
    /// move it back. Returns a line for the flash log.</summary>
    /// <param name="viaUsb">The module was the one on USB: it says itself which ID it answers on (its project entry may
    /// expect another one). Over CAN its project entry answering on <paramref name="savedBase"/> is the proof.</param>
    public async Task<string> RestoreAsync(Guid deviceId, int savedBase, bool viaUsb, CancellationToken ct = default)
    {
        if (dm.GetDevice(deviceId) is not { } dev) return "";
        // a DFU update dropped the link (the module on USB is the link): wait for the reconnect
        for (var i = 0; i < 40 && !adapters.IsConnected; i++) await Task.Delay(500, ct);
        if (!adapters.IsConnected) return $"Base ID: the link did not come back, so {dev.Name} was not checked. Connect, then Find modules.";
        var def = DefaultBaseIdFor(dev);
        if (viaUsb)
        {
            int? now = null;
            for (var i = 0; i < 12 && now is null; i++) { now = await adapters.ActiveAdapter!.IdentifyBridgeBaseIdAsync(); if (now is null) await Task.Delay(500, ct); }
            if (now == savedBase) return $"Base ID: the module answers on 0x{savedBase:X3} as before.";
            if (now != def) return now is int o ? $"Base ID: the module answers on 0x{o:X3} (it had 0x{savedBase:X3}). Re-address it from Modules." : "Base ID: the module on USB did not answer. Run Find modules.";
        }
        else
        {
            // a module that was answering stays "connected" ~3 s after a filtered flash (RxFilterWindow): only trust fresh frames
            await Task.Delay(4000, ct);
            if (await WaitAsync(() => dm.GetDevice(deviceId) is { Connected: true } d && d.BaseId == savedBase, 6000, ct))
                return $"Base ID: {dev.Name} answers on 0x{savedBase:X3} as before.";
        }
        if (def == savedBase) return $"Base ID: {dev.Name} is not answering on 0x{savedBase:X3} yet. Run Find modules.";
        var temp = dm.AddLike(deviceId, $"{dev.Name} (after flash)", def);
        if (temp is not Guid t) return "";
        try
        {
            if (!await WaitAsync(() => dm.GetDevice(t)?.Connected == true, 6000, ct))
                return $"Base ID: {dev.Name} answers neither on 0x{savedBase:X3} nor on the default 0x{def:X3}. Run Find modules.";
            dm.ModifyDeviceConfig(t, dev.Name, savedBase);   // re-address at the default ID, stored on the module
        }
        finally { dm.RemoveDevice(t); }
        var back = false;
        if (viaUsb)
            for (var i = 0; i < 20 && !back; i++) { await Task.Delay(500, ct); back = adapters.ActiveAdapter is { } a && await a.IdentifyBridgeBaseIdAsync() == savedBase; }
        else back = await WaitAsync(() => dm.GetDevice(deviceId) is { Connected: true }, 10000, ct);
        return back
            ? $"✓ Base ID: {dev.Name} came back on the default 0x{def:X3} and was moved back to 0x{savedBase:X3}. Its other settings are the firmware defaults: Apply to car."
            : $"Base ID: {dev.Name} was told to move from 0x{def:X3} back to 0x{savedBase:X3} but has not answered there yet. Run Find modules.";
    }

    private static async Task<bool> WaitAsync(Func<bool> ok, int ms, CancellationToken ct)
    {
        for (var waited = 0; waited < ms; waited += 250)
        {
            if (ok()) return true;
            await Task.Delay(250, ct);
        }
        return ok();
    }
}
