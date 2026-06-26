using domain.Models;

namespace domain.Interfaces;

public interface IDeviceConfigurable : IDevice
{
    List<DeviceVariable> VarMap { get; }
    List<DeviceParameter> Params { get; }
    bool ConfigMismatch { get; set; }
    /// <summary>Per-param differences captured on the last Read — explains *why* the config didn't match.</summary>
    List<ConfigDiffEntry> LastConfigDiff { get; set; }
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