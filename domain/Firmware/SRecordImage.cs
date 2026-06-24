using System.Globalization;

namespace domain.Firmware;

/// <summary>
/// Parses Motorola S-record (.srec/.s19) firmware files into contiguous memory segments.
/// Handles S1/S2/S3 data records (16/24/32-bit addresses); S0/S5/S6/S7/S8/S9 are ignored.
/// This is what the OpenBLT CAN bootloader expects the host to program (one XCP segment per
/// contiguous block). For the dingoFW CANBoard the application is a single contiguous block
/// starting at the relocated app base (0x08004000).
/// </summary>
public sealed class SRecordImage
{
    public sealed record Segment(uint Address, byte[] Data);

    public IReadOnlyList<Segment> Segments { get; }
    /// <summary>Lowest programmed address across all segments.</summary>
    public uint MinAddress { get; }
    /// <summary>Total number of data bytes across all segments.</summary>
    public int TotalBytes { get; }

    private SRecordImage(List<Segment> segments)
    {
        Segments = segments;
        MinAddress = segments.Count > 0 ? segments[0].Address : 0;
        TotalBytes = segments.Sum(s => s.Data.Length);
    }

    public static SRecordImage ParseText(string text) => Parse(text.Split('\n'));

    public static SRecordImage Parse(IEnumerable<string> lines)
    {
        var records = new List<(uint addr, byte[] data)>();

        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length < 10 || line[0] != 'S') continue;

            int addrBytes = line[1] switch { '1' => 2, '2' => 3, '3' => 4, _ => 0 };
            if (addrBytes == 0) continue;                       // not a data record

            int byteCount = Hex8(line, 2);                      // bytes after the count field
            int dataLen = byteCount - addrBytes - 1;            // minus address minus checksum
            int need = 4 + addrBytes * 2 + Math.Max(dataLen, 0) * 2 + 2;
            if (dataLen < 0 || line.Length < need) continue;    // malformed/truncated → skip

            int pos = 4;
            uint addr = 0;
            for (int i = 0; i < addrBytes; i++) { addr = (addr << 8) | (uint)Hex8(line, pos); pos += 2; }

            var data = new byte[dataLen];
            for (int i = 0; i < dataLen; i++) { data[i] = (byte)Hex8(line, pos); pos += 2; }

            if (dataLen > 0) records.Add((addr, data));
        }

        if (records.Count == 0)
            throw new InvalidDataException("No S1/S2/S3 data records found — not a valid S-record file.");

        // Coalesce into contiguous segments (records can arrive out of order / fragmented).
        records.Sort((a, b) => a.addr.CompareTo(b.addr));
        var segments = new List<Segment>();
        uint curStart = records[0].addr;
        var cur = new List<byte>();
        uint expected = curStart;
        foreach (var (addr, data) in records)
        {
            if (addr != expected && cur.Count > 0)
            {
                segments.Add(new Segment(curStart, cur.ToArray()));
                cur = new List<byte>();
                curStart = addr;
            }
            else if (cur.Count == 0)
            {
                curStart = addr;
            }
            cur.AddRange(data);
            expected = addr + (uint)data.Length;
        }
        if (cur.Count > 0) segments.Add(new Segment(curStart, cur.ToArray()));

        return new SRecordImage(segments);
    }

    private static int Hex8(string s, int pos) =>
        int.Parse(s.AsSpan(pos, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
}
