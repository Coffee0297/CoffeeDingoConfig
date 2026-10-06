using domain.Devices.Functions;
using Xunit;

namespace tests;

/// <summary>
/// The app's LookupTable.Interpolate mirrors the firmware's Table::Interpolate (functions/table.cpp)
/// for the editor's live preview. These cases are the same ones the firmware's host self-test
/// (tests/host_selftest.cpp in CoffeeDingoFW) asserts, so the two can't silently drift apart.
/// </summary>
public class LookupTableTests
{
    private static (double[] xs, double[] ys, double[] cells) Grid()
    {
        var xs = new double[8]; var ys = new double[8]; var cells = new double[64];
        xs[0] = 0; xs[1] = 10; xs[2] = 20;
        ys[0] = 0; ys[1] = 100;
        for (var x = 0; x < 3; x++) { cells[x] = xs[x]; cells[8 + x] = 100 + xs[x]; }   // row0: 0 10 20, row1: 100 110 120
        return (xs, ys, cells);
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(5, 0, 5)]        // linear along x
    [InlineData(15, 0, 15)]
    [InlineData(10, 50, 60)]     // linear along y
    [InlineData(5, 50, 55)]      // bilinear
    [InlineData(-99, 0, 0)]      // clamp low
    [InlineData(999, 100, 120)]  // clamp high on both axes
    public void Bilinear_MatchesFirmware(double x, double y, double expected)
    {
        var (xs, ys, cells) = Grid();
        Assert.Equal(expected, LookupTable.Interpolate(3, 2, xs, ys, cells, x, y), 4);
    }

    [Fact]
    public void OneDimensional_IgnoresY_AndDegenerateSizesReturnOrigin()
    {
        var (xs, ys, cells) = Grid();
        Assert.Equal(15, LookupTable.Interpolate(3, 1, xs, ys, cells, 15, 12345), 4);
        Assert.Equal(0, LookupTable.Interpolate(0, 0, xs, ys, cells, 7, 7), 4);
    }

    [Fact]
    public void Params_CoverEveryCellWithTheFirmwareSubIndexLayout()
    {
        var t = new LookupTable(1, "t");
        Assert.Equal(5 + 8 + 8 + 64, t.Params.Count);
        Assert.Equal(21 + 3 * 8 + 5, t.Params.Single(p => p.Name == "table[1].cell[3][5]").SubIndex);
        t.Params.Single(p => p.SubIndex == 21 + 3 * 8 + 5).SetValue(42.5);
        Assert.Equal(42.5, t.Cells[3 * 8 + 5]);
    }
}
