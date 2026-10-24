using System.Text;

namespace domain.Firmware;

/// <summary>
/// Sets the base ID a board starts on when it has no stored settings, by patching the image's "DINGO_BASEID=" marker
/// (dingoFW 5.7.4 on: 14 tag bytes, then the ID as 2 bytes little endian). Flashed over SWD, a blank board then comes up
/// on its project ID instead of the shared default. A board that has valid settings keeps its own ID.
/// </summary>
public static class BaseIdPatch
{
    private static readonly byte[] Tag = Encoding.ASCII.GetBytes("DINGO_BASEID=\0");

    /// <returns>The image to flash and its extension (.bin stays .bin, .hex / .srec come back as Intel HEX), or why not.</returns>
    public static (byte[]? Image, string Ext, string? Error) Apply(byte[] file, string ext, int baseId)
    {
        if (baseId is < 1 or > 0x7FF) return (null, ext, "the base ID must be 0x001 to 0x7FF");
        const string noMarker = "this image has no DINGO_BASEID= marker (firmware before 5.7.4): it can't take a base ID";
        if (ext == ".bin")
        {
            var b = (byte[])file.Clone();
            var i = b.AsSpan().IndexOf(Tag);
            if (i < 0 || i + Tag.Length + 2 > b.Length) return (null, ext, noMarker);
            Write(b, i + Tag.Length, baseId);
            return (b, ".bin", null);
        }
        if (ext is ".hex" or ".srec")
        {
            var img = SRecordImage.ParseText(Encoding.ASCII.GetString(file));
            var hit = false;
            foreach (var s in img.Segments)
            {
                var i = s.Data.AsSpan().IndexOf(Tag);
                if (i < 0 || i + Tag.Length + 2 > s.Data.Length) continue;
                Write(s.Data, i + Tag.Length, baseId);
                hit = true;
            }
            return hit ? (Encoding.ASCII.GetBytes(ToIntelHex(img.Segments)), ".hex", null) : (null, ext, noMarker);
        }
        return (null, ext, "only a .bin, .hex or .srec image can take a base ID");
    }

    /// <summary>The base ID patched into an image, or null when it has no marker (for the dialog and tests).</summary>
    public static int? Read(byte[] data)
    {
        var i = data.AsSpan().IndexOf(Tag);
        return i < 0 || i + Tag.Length + 2 > data.Length ? null : data[i + Tag.Length] | (data[i + Tag.Length + 1] << 8);
    }

    private static void Write(byte[] b, int at, int id) { b[at] = (byte)id; b[at + 1] = (byte)(id >> 8); }

    /// <summary>Intel HEX: 16-byte data records, an extended linear address record per 64 KB, then EOF.</summary>
    public static string ToIntelHex(IEnumerable<SRecordImage.Segment> segments)
    {
        var sb = new StringBuilder();
        uint? upper = null;
        foreach (var s in segments)
            for (var off = 0; off < s.Data.Length;)
            {
                var addr = s.Address + (uint)off;
                if (addr >> 16 != upper) { upper = addr >> 16; Rec(sb, 0x04, 0, [(byte)(upper >> 8), (byte)upper]); }
                var n = Math.Min(16, Math.Min(s.Data.Length - off, 0x10000 - (int)(addr & 0xFFFF)));   // not across 64 KB
                Rec(sb, 0x00, (ushort)addr, s.Data.AsSpan(off, n).ToArray());
                off += n;
            }
        sb.Append(":00000001FF\n");
        return sb.ToString();
    }

    private static void Rec(StringBuilder sb, byte kind, ushort addr, byte[] data)
    {
        var raw = new byte[4 + data.Length];
        raw[0] = (byte)data.Length; raw[1] = (byte)(addr >> 8); raw[2] = (byte)addr; raw[3] = kind;
        data.CopyTo(raw, 4);
        var sum = 0; foreach (var x in raw) sum += x;
        sb.Append(':').Append(Convert.ToHexString(raw)).Append(((byte)-sum).ToString("X2")).Append('\n');
    }
}
