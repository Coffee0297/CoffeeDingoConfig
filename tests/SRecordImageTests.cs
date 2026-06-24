using domain.Firmware;
using Xunit;

namespace tests;

/// <summary>
/// Tests for the S-record parser that feeds the XCP-over-CAN flasher. Getting the byte-count
/// or address arithmetic wrong here would program firmware to the wrong address — exactly the
/// kind of silent corruption worth a guard.
/// </summary>
public class SRecordImageTests
{
    // S3 (32-bit address) data record: "S3" + count + addr(8 hex) + data + checksum(00, not validated).
    private static string S3(uint addr, params byte[] data)
    {
        int count = 4 + data.Length + 1;                 // addr(4) + data + checksum(1)
        var hex = string.Concat(data.Select(b => b.ToString("X2")));
        return $"S3{count:X2}{addr:X8}{hex}00";
    }

    [Fact]
    public void ParsesSingleRecord_AddressAndBytes()
    {
        var img = SRecordImage.ParseText(S3(0x08004000, 0xDE, 0xAD, 0xBE, 0xEF));
        var seg = Assert.Single(img.Segments);
        Assert.Equal(0x08004000u, seg.Address);
        Assert.Equal(new byte[] { 0xDE, 0xAD, 0xBE, 0xEF }, seg.Data);
        Assert.Equal(0x08004000u, img.MinAddress);
        Assert.Equal(4, img.TotalBytes);
    }

    [Fact]
    public void CoalescesContiguousRecords_IntoOneSegment()
    {
        var text = string.Join('\n',
            S3(0x08004000, 0xDE, 0xAD, 0xBE, 0xEF),
            S3(0x08004004, 0x11, 0x22, 0x33, 0x44));
        var img = SRecordImage.ParseText(text);
        var seg = Assert.Single(img.Segments);
        Assert.Equal(0x08004000u, seg.Address);
        Assert.Equal(new byte[] { 0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22, 0x33, 0x44 }, seg.Data);
    }

    [Fact]
    public void SplitsOnGap_IntoTwoSegments()
    {
        var text = string.Join('\n',
            S3(0x08004000, 0x01, 0x02),
            S3(0x08004010, 0x03, 0x04));     // 14-byte gap
        var img = SRecordImage.ParseText(text);
        Assert.Equal(2, img.Segments.Count);
        Assert.Equal(0x08004000u, img.Segments[0].Address);
        Assert.Equal(0x08004010u, img.Segments[1].Address);
        Assert.Equal(4, img.TotalBytes);
    }

    [Fact]
    public void IgnoresHeaderAndStartAddressRecords()
    {
        var text = string.Join('\n',
            "S00600004844521B",                 // S0 header
            S3(0x08004000, 0xAA, 0xBB),
            "S70508004000F7");                  // S7 start address (32-bit)
        var img = SRecordImage.ParseText(text);
        var seg = Assert.Single(img.Segments);
        Assert.Equal(new byte[] { 0xAA, 0xBB }, seg.Data);
    }

    [Fact]
    public void ParsesS1_16BitAddress()
    {
        var img = SRecordImage.ParseText("S1051000AABB00");   // S1, addr 0x1000, data AA BB
        var seg = Assert.Single(img.Segments);
        Assert.Equal(0x1000u, seg.Address);
        Assert.Equal(new byte[] { 0xAA, 0xBB }, seg.Data);
    }

    [Fact]
    public void ThrowsOnNoDataRecords()
    {
        Assert.Throws<InvalidDataException>(() => SRecordImage.ParseText("S00600004844521B"));
    }
}
