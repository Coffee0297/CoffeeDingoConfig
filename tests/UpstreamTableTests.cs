using System.Collections.Concurrent;
using domain.Common;
using domain.Devices.dingoPdm;
using domain.Devices.Functions;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

/// <summary>feat/lookup-tables on upstream dingoFW: params 0x1B00 subs 0-84 (core/param_defs.h TABLE_PARAMS), var map
/// "Table n" after the timers (nm lookup-tables dingopdm_v7.elf: pVarMap 0x38c bytes = 227), status Msg 30 at base+32.</summary>
public class UpstreamTableTests
{
    private static ConcurrentDictionary<(int BaseId, int Index, int SubIndex), DeviceCanFrame> Q() => new();

    internal static PdmDevice UpstreamPdm()
    {
        var d = new PdmDevice("PDM", 0x680);
        d.SetLogger(NullLogger<PdmDevice>.Instance);
        var q = Q();
        d.Read(0x680, [31, 0, 0, 0, 0, 6, 0, 3], ref q, []);
        return d;
    }

    internal static IEnumerable<(int, int)> Block(int baseIndex, int count, int subs) =>
        Enumerable.Range(0, count).SelectMany(i => Enumerable.Range(0, subs).Select(s => (baseIndex + i, s)));

    /// <summary>A full upstream ReadAll of these params (the app's own values), so the module's list is learned.</summary>
    internal static void LearnParams(PdmDevice d, List<(int Index, int Sub)> keys)
    {
        var q = Q();
        var crc = new CumulativeCrc32();
        d.Read(0x680, [10, 0, 0, 0, 0, 0, 0, 0], ref q, []);
        foreach (var (i, s) in keys)
        {
            var p = d.Params.First(x => x.Index == i && x.SubIndex == s);
            var v = ParamCodec.ToFrame(domain.Enums.MessageCommand.ReadAllRsp, p, 0).Payload[4..];
            crc.Update(v);
            d.Read(0x680, [11, (byte)i, (byte)(i >> 8), (byte)s, .. v], ref q, []);
        }
        d.Read(0x680, [12, (byte)keys.Count, (byte)(keys.Count >> 8), 0, .. BitConverter.GetBytes(crc.Final)], ref q, []);
        Assert.True(d.ParamSet.FromModule);
    }

    [Fact]
    public void Pdm_WithTables_AppendsTablesAfterTimers_AndDecodesMsg30()
    {
        var d = UpstreamPdm();
        LearnParams(d, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(LookupTable.UpstreamBaseIndex, 2, 85)]);
        Assert.Equal(227, d.VarMap.Count);
        Assert.Equal(2, d.TableCount);
        Assert.All(d.VarMap.Skip(217).Take(8), v => Assert.Equal("timer", v.OwnerKind));
        Assert.Equal([("table", 1), ("table", 2)], d.VarMap.Skip(225).Select(v => (v.OwnerKind, v.OwnerNumber)));
        Assert.Equal(Enumerable.Range(0, 227), d.VarMap.Select(v => v.VariableIndex));

        // params at 0x1B00 with the fork's subs; nothing of the table at the timer's 0x1A00
        var t2 = d.Params.Where(p => p.Index == 0x1B01).OrderBy(p => p.SubIndex).ToList();
        Assert.Equal(Enumerable.Range(0, 85), t2.Select(p => p.SubIndex));
        Assert.Equal("table[2].cell[0][0]", t2[21].Name);
        Assert.DoesNotContain(d.Params, p => p.Name.StartsWith("table") && p.Index < 0x1B00);
        Assert.Equal(0x1B01, LookupTable.BaseFor(d.Family) + 1);

        // Msg 30 (+32): table 1 = 1.5, table 2 = -20 (float32 LE)
        Assert.Equal(32, d.MaxCyclicId);
        var q = Q();
        d.Read(0x680 + 32, [.. BitConverter.GetBytes(1.5f), .. BitConverter.GetBytes(-20f)], ref q, []);
        Assert.Equal(1.5, d.Tables[0].Value, 3);
        Assert.Equal(-20, d.Tables[1].Value, 3);
    }

    // feat/more-tables: 4 tables (nm more-tables dingopdm_v7.elf: pVarMap 0x394 bytes = 229), tables 3-4 in Msg 31 (+33)
    [Fact]
    public void Pdm_WithFourTables_AppendsFour_AndDecodesMsg31()
    {
        var d = UpstreamPdm();
        LearnParams(d, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5), .. Block(LookupTable.UpstreamBaseIndex, 4, 85)]);
        Assert.Equal(4, d.TableCount);
        Assert.Equal(229, d.VarMap.Count);
        Assert.Equal([1, 2, 3, 4], d.VarMap.Skip(225).Select(v => { Assert.Equal("table", v.OwnerKind); return v.OwnerNumber; }));
        Assert.Equal(85, d.Params.Count(p => p.Index == 0x1B03 && FwFamily.Has(d, p)));
        Assert.Equal(33, d.MaxCyclicId);
        var q = Q();
        d.Read(0x680 + 33, [.. BitConverter.GetBytes(3.25f), .. BitConverter.GetBytes(44f)], ref q, []);
        Assert.Equal(3.25, d.Tables[2].Value, 3);
        Assert.Equal(44, d.Tables[3].Value, 3);
    }

    [Fact]
    public void Pdm_WithoutTables_KeepsStockLayout()
    {
        var d = UpstreamPdm();
        LearnParams(d, [.. Block(0x0000, 1, 9), .. Block(0x1A00, 8, 5)]);
        Assert.Equal(225, d.VarMap.Count);
        Assert.DoesNotContain(d.VarMap, v => v.OwnerKind == "table");
        Assert.Equal(31, d.MaxCyclicId);   // +32 may be the next module's base
        Assert.DoesNotContain(d.Params, p => p.Index == 0x1B00 && FwFamily.Has(d, p));
    }

    [Fact]
    public void Fork_TablesStayAt0x1A00()
    {
        var d = new PdmDevice("PDM", 0x680);
        Assert.Equal(85, d.Params.Count(p => p.Index == 0x1A00));
        Assert.Equal(2, d.TableCount);
        Assert.DoesNotContain(d.Params, p => p.Index == 0x1A02);   // the fork has 2 tables
        Assert.Equal(0x1A00, LookupTable.BaseFor(FwFamily.Fork));
    }
}
