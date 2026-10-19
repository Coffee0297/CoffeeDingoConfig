using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace domain.Firmware;

/// <summary>
/// Parses Motorola S-record (.srec/.s19) and Intel HEX (.hex, what upstream dingoFW releases ship) firmware files
/// into contiguous memory segments.
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

    /// <summary>
    /// The board the image is built for, from dingoFW's "DINGO_BOARD=" marker (v5.5.109 on) without the vendor
    /// prefix, e.g. "dingoPDM v7". Null for an older image with no marker.
    /// </summary>
    public string? BoardMarker() => BoardName(Marker(Segments.Select(x => x.Data), "DINGO_BOARD="));

    /// <summary>"Dingo Electronics dingoPDM v7" -> "dingoPDM v7".</summary>
    public static string? BoardName(string? marker) => marker is not null && marker.StartsWith("Dingo Electronics ") ? marker["Dingo Electronics ".Length..] : marker;

    /// <summary>The firmware version the image carries in dingoFW's "DINGO_FW=" marker (5.6.4 on), e.g. "5.6.4". Null for an older image.</summary>
    public string? VersionMarker() => Marker(Segments.Select(x => x.Data), "DINGO_FW=");

    /// <summary>The zero-terminated text after <paramref name="key"/> in the first block that holds it (a .bin is one block).</summary>
    public static string? Marker(IEnumerable<byte[]> blocks, string key)
    {
        var k = Encoding.ASCII.GetBytes(key);
        foreach (var d in blocks)
        {
            int i = d.AsSpan().IndexOf(k);
            if (i < 0) continue;
            int start = i + k.Length, end = Array.IndexOf(d, (byte)0, start);
            return Encoding.ASCII.GetString(d, start, (end < 0 ? d.Length : end) - start);
        }
        return null;
    }

    /// <summary>"dingoPDM v7" fits a "dingoPDM", "dingoPDM-Max v1" a "dingoPDM-Max", "CANBoard v2" a "CANBoard".</summary>
    public static bool BoardMatches(string marker, string deviceType) =>
        Regex.Replace(marker, @"\s+v\d+$", "").Equals(deviceType, StringComparison.OrdinalIgnoreCase);

    public static SRecordImage ParseText(string text) => Parse(text.Split('\n'));

    public static SRecordImage Parse(IEnumerable<string> lines)
    {
        var records = new List<(uint addr, byte[] data)>();
        uint upper = 0;   // Intel HEX: extended linear (04) / segment (02) address

        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length >= 11 && line[0] == ':')
            {
                int len = Hex8(line, 1), type = Hex8(line, 7);
                if (line.Length < 11 + len * 2) continue;          // truncated → skip
                uint off = (uint)(Hex8(line, 3) << 8 | Hex8(line, 5));
                if (type == 4 && len == 2) upper = (uint)(Hex8(line, 9) << 8 | Hex8(line, 11)) << 16;
                else if (type == 2 && len == 2) upper = (uint)(Hex8(line, 9) << 8 | Hex8(line, 11)) << 4;
                else if (type == 0 && len > 0)
                {
                    var bytes = new byte[len];
                    for (int i = 0; i < len; i++) bytes[i] = (byte)Hex8(line, 9 + i * 2);
                    records.Add((upper + off, bytes));
                }
                continue;
            }
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
            throw new InvalidDataException("No data records found — not a valid S-record or Intel HEX file.");

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
