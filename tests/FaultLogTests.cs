using domain.Common;
using Xunit;

namespace tests;

/// <summary>FaultLogRead (53) replies, upstream feat/fault-history: A = [53, n, count, out | kind &lt;&lt; 4, boot u16, A×10 u16],
/// B = [53, n | 0x80, uptime ms u32, V×100 u16] (the Sim run: output 1, latched, 63 A, 12.23 V, boot 1).</summary>
public class FaultLogTests
{
    [Fact]
    public void Decode_TwoFrames()
    {
        byte[] a = [53, 1, 2, 0x10, 1, 0, 0x76, 0x02], b = [53, 0x81, 0x10, 0x27, 0, 0, 0xC7, 0x04];
        var e = FaultLog.Decode(1, a, b);
        Assert.Equal(new FaultLogEntry(1, 1, 1, 1, 63.0, 12.23, 10000), e);
        Assert.Equal(2, FaultLog.Count(a));
        // kind 3 (latched) on output 8, boot 0x0102
        Assert.Equal((8, 3, 258), FaultLog.Decode(0, [53, 0, 2, 0x37, 2, 1, 0, 0], [53, 0x80, 0, 0, 0, 0, 0, 0]) is { } x ? (x.Output, x.Kind, x.Boot) : default);
    }

    [Fact]
    public void Decode_RejectsEmptyOrMismatched()
    {
        byte[] empty = [53, 5, 2, 0x00, 3, 0, 0, 0], b5 = [53, 0x85, 0, 0, 0, 0, 0, 0];
        Assert.Null(FaultLog.Decode(5, empty, b5));               // past the count: no entry...
        Assert.Equal(3, FaultLog.Boot(empty));                    // ...but the boot field is the current boot count
        Assert.Null(FaultLog.Decode(1, [53, 1, 2, 0x10, 1, 0, 0, 0], b5));   // B of another entry
        Assert.Null(FaultLog.Decode(1, [53, 1, 2, 0x10], b5));               // short frame
    }
}
