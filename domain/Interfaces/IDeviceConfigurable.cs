using domain.Models;

namespace domain.Interfaces;

public interface IDeviceConfigurable : IDevice
{
    List<DeviceVariable> VarMap { get; }
    List<DeviceParameter> Params { get; }
    bool ConfigMismatch { get; set; }
    /// <summary>Firmware version as reported ("v5.6.0"; "v0.0.0" until the module answered).</summary>
    string Version { get; }
    /// <summary>A Version reply arrived (upstream firmware reports major 0, so "v0.x" is a real answer).</summary>
    bool VersionReceived { get; }
    /// <summary><see cref="domain.Common.FwFamily"/>.Fork or .Upstream; from the Version reply, saved with the project.</summary>
    string Family { get; }
    /// <summary>Upstream family: the params the module has (from its ReadAll). Unused on fork modules.</summary>
    domain.Common.DeviceParamSet ParamSet { get; }
    /// <summary>A configured fork-5.x record met a module reporting 5.7+: <see cref="domain.Common.Fw57Migration"/> converts it
    /// (DeviceManager, right after the Version reply).</summary>
    bool Migrate57Pending { get; set; }
    /// <summary>After a migration: the next Read learns the module's param list but keeps the project's values (Apply them).</summary>
    bool KeepValuesOnRead { get; set; }
    /// <summary>Upstream family: the var map and calibrated rotary params follow firmware 5.8 (false: 5.7). Saved with the project.</summary>
    bool Layout58 { get; }
    /// <summary>Switch to (or off) the 5.8 layout and rebuild the var map and params; values stay. Stored indices are not
    /// renumbered: <see cref="domain.Common.Fw58Migration"/> does that.</summary>
    void UseLayout58(bool on);
    /// <summary>What the last 5.7 migration changed or could not map; saved with the project.</summary>
    List<domain.Common.MigrationNote>? Migration { get; set; }
    /// <summary>Switch the record to <paramref name="family"/>'s layout; <paramref name="assumeAll"/>: take every param the
    /// app models for it as the module's list (the 5.7 integration firmware has them all) until a Read tells.</summary>
    void UseFamily(string family, bool assumeAll);
    /// <summary>Per-param differences captured on the last Read — explains *why* the config didn't match.</summary>
    List<ConfigDiffEntry> LastConfigDiff { get; set; }
    /// <summary>Config lock (upstream feat/config-lock, 0x0200): the app's copy of the password + contact, and Locked.</summary>
    domain.Devices.Functions.ConfigLock Lock { get; }
    DeviceCanFrame GetCheckMsg();
    List<DeviceCanFrame> GetReadMsgs(bool allParams);
    List<DeviceCanFrame> GetWriteMsgs(bool allParams);
    List<DeviceCanFrame> GetModifyMsgs(int baseId);
    DeviceCanFrame GetBurnMsg();
    DeviceCanFrame GetVersionMsg();
    bool CanSleep { get; }
    DeviceCanFrame? GetSleepMsg();
    DeviceCanFrame? GetWakeupMsg();
    bool CanBootloader { get; }
    /// <param name="canUpdate">false = USB-DFU entry (byte 6 = 0); true = OpenBLT CAN-update
    /// entry (byte 6 = 1). On the CANBoard the byte is ignored (it has no USB-DFU).</param>
    DeviceCanFrame? GetBootloaderMsg(bool canUpdate = false);
    
}