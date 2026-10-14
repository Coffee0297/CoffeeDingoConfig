using domain.Devices;
using Xunit;

namespace tests;

/// <summary>
/// A module hidden by our own receive filter (another module's read/write in progress) stays connected, and
/// for a grace period after the filter lifts; a module that was never seen is not made connected by it.
/// </summary>
public class RxFilterWindowTests
{
    [Fact]
    public void HiddenModulesStayConnected()
    {
        RxFilterWindow.Narrow(0x680, 0x68F);                      // exchanging with PDM-01
        Assert.True(RxFilterWindow.Narrowed);                      // live guards wait for the lift before refusing
        Assert.True(RxFilterWindow.Excuses(0x6C0, wasConnected: true));    // PDM-03 is only hidden
        Assert.False(RxFilterWindow.Excuses(0x680, wasConnected: true));   // PDM-01 itself is visible: no excuse
        Assert.False(RxFilterWindow.Excuses(0x6C0, wasConnected: false));  // never seen: stays offline
        RxFilterWindow.Lift();
        Assert.False(RxFilterWindow.Narrowed);
        Assert.True(RxFilterWindow.Excuses(0x6C0, true, DateTime.Now.AddMilliseconds(RxFilterWindow.GraceMs - 500)));
        Assert.False(RxFilterWindow.Excuses(0x6C0, true, DateTime.Now.AddMilliseconds(RxFilterWindow.GraceMs + 500)));
    }
}
