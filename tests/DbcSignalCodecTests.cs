using domain.Common;
using domain.Enums;
using Xunit;

namespace tests;

/// <summary>
/// Round-trip tests for the pure DBC bit-packing codec used to encode/decode
/// signals on the CAN bus. These guard the most failure-prone arithmetic in the
/// app: getting a bit shift wrong here silently corrupts every value written to
/// or read from a hardware module.
/// </summary>
public class DbcSignalCodecTests
{
    [Theory]
    // startBit, length, value
    [InlineData(0, 8, 0)]
    [InlineData(0, 8, 255)]
    [InlineData(0, 8, 170)]
    [InlineData(8, 16, 4660)]   // 0x1234 byte-aligned
    [InlineData(4, 12, 2730)]   // 0xAAA cross-byte, unaligned start
    [InlineData(0, 1, 1)]
    [InlineData(3, 5, 17)]
    [InlineData(0, 32, 305419896)] // 0x12345678
    public void LittleEndianUnsigned_RoundTrips(int startBit, int length, long value)
    {
        var data = new byte[8];
        DbcSignalCodec.InsertSignalInt(data, value, startBit, length, ByteOrder.LittleEndian);
        var read = DbcSignalCodec.ExtractSignalInt(data, startBit, length, ByteOrder.LittleEndian);
        Assert.Equal(value, read);
    }

    [Theory]
    [InlineData(7, 8, 0)]
    [InlineData(7, 8, 255)]
    [InlineData(7, 16, 4660)]   // big-endian (Motorola) byte-aligned
    [InlineData(7, 12, 2730)]
    public void BigEndianUnsigned_RoundTrips(int startBit, int length, long value)
    {
        var data = new byte[8];
        DbcSignalCodec.InsertSignalInt(data, value, startBit, length, ByteOrder.BigEndian);
        var read = DbcSignalCodec.ExtractSignalInt(data, startBit, length, ByteOrder.BigEndian);
        Assert.Equal(value, read);
    }

    [Theory]
    [InlineData(0, 8, -1)]
    [InlineData(0, 8, -128)]
    [InlineData(0, 8, 127)]
    [InlineData(0, 16, -1000)]
    [InlineData(4, 12, -2048)]
    public void SignedValues_RoundTrip(int startBit, int length, long value)
    {
        var data = new byte[8];
        DbcSignalCodec.InsertSignalInt(data, value, startBit, length, ByteOrder.LittleEndian, isSigned: true);
        var read = DbcSignalCodec.ExtractSignalInt(data, startBit, length, ByteOrder.LittleEndian, isSigned: true);
        Assert.Equal(value, read);
    }

    [Theory]
    // raw 0..1000 scaled by 0.1 with +(-40) offset => physical -40.0 .. 60.0
    [InlineData(13.8, 0.1, 0.0)]
    [InlineData(-40.0, 0.1, -40.0)]
    [InlineData(25.5, 0.1, 0.0)]
    public void FactorAndOffset_RoundTrip_WithinTolerance(double physical, double factor, double offset)
    {
        var data = new byte[8];
        DbcSignalCodec.InsertSignal(data, physical, startBit: 0, length: 16,
            ByteOrder.LittleEndian, isSigned: true, factor: factor, offset: offset);
        var read = DbcSignalCodec.ExtractSignal(data, startBit: 0, length: 16,
            ByteOrder.LittleEndian, isSigned: true, factor: factor, offset: offset);
        // quantisation error is at most half a factor step
        Assert.True(Math.Abs(physical - read) <= factor / 2.0 + 1e-9,
            $"expected ~{physical}, got {read}");
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(0, false)]
    [InlineData(5, true)]
    [InlineData(7, true)]
    public void InsertBool_ExtractsBackAsBit(int startBit, bool value)
    {
        var data = new byte[8];
        DbcSignalCodec.InsertBool(data, value, startBit, ByteOrder.LittleEndian);
        var read = DbcSignalCodec.ExtractSignalInt(data, startBit, 1, ByteOrder.LittleEndian);
        Assert.Equal(value ? 1L : 0L, read);
    }

    [Fact]
    public void AdjacentSignals_DoNotCorruptEachOther()
    {
        var data = new byte[8];
        DbcSignalCodec.InsertSignalInt(data, 0x0F, startBit: 0, length: 4, ByteOrder.LittleEndian);
        DbcSignalCodec.InsertSignalInt(data, 0x0A, startBit: 4, length: 4, ByteOrder.LittleEndian);
        DbcSignalCodec.InsertSignalInt(data, 0x1234, startBit: 8, length: 16, ByteOrder.LittleEndian);

        Assert.Equal(0x0F, DbcSignalCodec.ExtractSignalInt(data, 0, 4, ByteOrder.LittleEndian));
        Assert.Equal(0x0A, DbcSignalCodec.ExtractSignalInt(data, 4, 4, ByteOrder.LittleEndian));
        Assert.Equal(0x1234, DbcSignalCodec.ExtractSignalInt(data, 8, 16, ByteOrder.LittleEndian));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65)]
    public void InvalidLength_Throws(int length)
    {
        var data = new byte[8];
        Assert.Throws<ArgumentException>(() =>
            DbcSignalCodec.ExtractSignal(data, 0, length, ByteOrder.LittleEndian));
    }
}
