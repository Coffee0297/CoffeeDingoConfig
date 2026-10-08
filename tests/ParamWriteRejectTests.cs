using System.Collections.Concurrent;
using domain.Devices.Canboard;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>
/// Firmware 0x0011+ answers a refused single Write with WriteAllOutOfRange carrying the value the module
/// kept. The project must take that value (it used to keep the value that was never applied), and only
/// for a single Write: a WriteAll out-of-range reply carries the rejected value instead.
/// </summary>
public class ParamWriteRejectTests
{
    private static (CanboardDevice d, ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> q) Setup(byte pendingCmd)
    {
        var d = new CanboardDevice("CB", 0x660);
        d.SetLogger(NullLogger<CanboardDevice>.Instance);
        d.DigitalInputs[0].PwmFreq = 6000;   // what the user asked for
        var q = new ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame>();
        q[(0x660, 0x1200, 6)] = new DeviceCanFrame
        {
            DeviceBaseId = 0x660, Name = "Write 1200:6",
            Frame = new CanFrame(0x661, 8, [pendingCmd, 0x00, 0x12, 6, 0x70, 0x17, 0, 0])
        };
        return (d, q);
    }

    // reply on the base id: [26, idxLo, idxHi, sub, value LE] = out of range, module kept 4000 (0x0FA0)
    private static readonly byte[] OutOfRangeKept4000 = [26, 0x00, 0x12, 6, 0xA0, 0x0F, 0, 0];

    [Fact]
    public void RefusedSingleWrite_ProjectTakesTheKeptValue()
    {
        var (d, q) = Setup(pendingCmd: 2);   // Write
        d.Read(0x660, OutOfRangeKept4000, ref q, []);
        Assert.Equal(4000, d.DigitalInputs[0].PwmFreq);
        Assert.Empty(q);                     // answered: no retries
    }

    [Fact]
    public void WriteAllOutOfRange_DoesNotTouchTheProject()
    {
        var (d, q) = Setup(pendingCmd: 21);  // WriteAllVal
        d.Read(0x660, OutOfRangeKept4000, ref q, []);
        Assert.Equal(6000, d.DigitalInputs[0].PwmFreq);
    }
}
