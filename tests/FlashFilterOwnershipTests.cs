using application.Services;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>A CAN flash owns the bridge filter (the bootloader's reply id). A frame sent meanwhile to the module the
/// filter was last narrowed to restarted the idle timer, which then lifted the filter mid-flash: on a busy bus the
/// bootloader's replies were lost and PDM-05 and PDM-02 failed with "Programming failed in segment".</summary>
public class FlashFilterOwnershipTests
{
    [Fact]
    public async Task AFrameToTheFilteredModule_DoesNotLiftTheFilterAFlashOwns()
    {
        var dm = new DeviceManager(NullLogger<DeviceManager>.Instance, NullLoggerFactory.Instance,
            new SystemLogger(Path.Combine(Path.GetTempPath(), "dingo-test-logs")), new DeviceDefinitionManager());
        var changes = new List<(int? Lo, int? Hi)>();
        dm.SetBatchTransmitCallback(_ => { });
        dm.SetReceiveFilterCallback((lo, hi) => { lock (changes) changes.Add((lo, hi)); });

        var g = dm.AddDevice("pdm", "PDM-05", 0x749);
        dm.ReadAllDeviceConfig(g);                       // a full read narrows the filter to 0x749
        lock (changes) Assert.Contains(changes, c => c.Lo == 0x749);

        dm.SuspendConfigFilter();                        // the flash takes it over (it aims the adapter at base + 13)
        lock (changes) changes.Clear();
        dm.OnFrameTransmitted(new DeviceCanFrame { DeviceBaseId = 0x749, Frame = new CanFrame(0x74A, 8, [1, 0, 0, 0, 0, 0, 0, 0]) });

        await Task.Delay(2500);                          // past the 1.5 s idle lift
        lock (changes) Assert.Empty(changes);
        dm.ResumeConfigFilter();
    }
}
