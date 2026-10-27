using domain.Common;
using Xunit;

namespace tests;

/// <summary>
/// The ECU templates shipped in web/clientapp/src/lib/ecu-dbc parse with the app's own DbcParser and decode a frame
/// built by hand from the cited spec to the value the spec says (RPM, coolant, oil pressure per template).
/// </summary>
public class EcuTemplateTests
{
    static string Dir()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            var p = Path.Combine(d.FullName, "web", "clientapp", "src", "lib", "ecu-dbc");
            if (Directory.Exists(p)) return p;
        }
        throw new DirectoryNotFoundException("ecu-dbc");
    }

    [Theory]
    // Haltech: big endian, 0.1 kPa abs (-101.3 = gauge), 0.1 K (-273.15 = degC)
    [InlineData("haltech.dbc", "RPM", 0x360, "0BB8000000000000", 3000)]
    [InlineData("haltech.dbc", "Oil_Pressure", 0x361, "00000BF700000000", 205.0)]
    [InlineData("haltech.dbc", "Coolant_Temperature", 0x3E0, "0E6F000000000000", 96.35)]
    // rusEFI verbose, base 0x200: little endian
    [InlineData("rusefi.dbc", "RPM", 0x201, "B80B000000000000", 3000)]
    [InlineData("rusefi.dbc", "CoolantTemp", 0x203, "0000820000000000", 90)]
    [InlineData("rusefi.dbc", "OilPress", 0x204, "0000282300000000", 299.99997)]
    // EMU Black, base 0x600: little endian, CLT signed
    [InlineData("emublack.dbc", "RPM", 0x600, "B80B000000000000", 3000)]
    [InlineData("emublack.dbc", "OilPressure", 0x602, "0000000040000000", 4.0)]
    [InlineData("emublack.dbc", "CoolantTemp", 0x602, "0000000000005A00", 90)]
    [InlineData("emublack.dbc", "CoolantTemp", 0x602, "000000000000F6FF", -10)]
    // MaxxECU: little endian int16
    [InlineData("maxxecu.dbc", "RPM", 0x520, "B80B000000000000", 3000)]
    [InlineData("maxxecu.dbc", "Coolant_Temp", 0x530, "0000000000008403", 90.0)]
    [InlineData("maxxecu.dbc", "Oil_Pressure", 0x536, "00000000B80B0000", 300.0)]
    public void RoleSignalDecodesTheSpecFrame(string file, string signal, int id, string hex, double expected)
    {
        var sigs = DbcParser.ParseFile(Path.Combine(Dir(), file));
        var s = Assert.Single(sigs, x => x.Name == signal);
        Assert.Equal(id, s.Id);
        Assert.False(s.IsExtended);
        Assert.InRange(s.Length, 1, 32);   // a module CAN input reads at most 32 bits
        Assert.Equal(expected, DbcSignalCodec.ExtractSignal(Convert.FromHexString(hex), s), 3);
    }
}
