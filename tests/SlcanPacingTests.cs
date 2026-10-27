using infrastructure.Adapters;
using Xunit;

namespace tests;

/// <summary>A Write All through a USB bridge is paced to about half the bus capacity the other modules leave free.</summary>
public class SlcanPacingTests
{
    [Theory]
    [InlineData(0, 1000)]      // idle bus or the module's own USB link: the module's param thread is the limit
    [InlineData(2300, 650)]    // ECU on the bus
    [InlineData(3500, 250)]    // saturated: still moves
    public void PaceFollowsBusLoad(int busRate, double framesPerSecond) => Assert.Equal(framesPerSecond, SlcanAdapter.PaceFor(busRate));
}
