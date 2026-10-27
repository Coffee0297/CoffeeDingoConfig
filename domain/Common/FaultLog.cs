namespace domain.Common;

/// <summary>One entry of the module's fault history (upstream feat/fault-history, FRAM ring of 32). Output is 1-based;
/// Kind 1 Overcurrent, 2 Fault, 3 Overcurrent latched to Fault; UptimeMs counts from that boot's power-on.</summary>
public record FaultLogEntry(int N, int Output, int Kind, int Boot, double Amps, double Volts, uint UptimeMs);

/// <summary>
/// Reply to FaultLogRead [53, n]: two frames on the base id.
/// A = [53, n, count, out | kind &lt;&lt; 4, boot u16 LE, current A×10 u16 LE], B = [53, n | 0x80, uptime ms u32 LE, battery V×100 u16 LE].
/// For n &gt;= count the kind is 0 and the boot field holds the module's current boot count.
/// </summary>
public static class FaultLog
{
    public const int Size = 32;
    private static int U16(byte[] d, int i) => d[i] | d[i + 1] << 8;

    public static int Count(byte[] a) => a[2];
    public static int Boot(byte[] a) => U16(a, 4);

    /// <summary>The entry from frames A and B of request n; null if they don't belong to n or hold no entry.</summary>
    public static FaultLogEntry? Decode(int n, byte[] a, byte[] b)
    {
        if (a.Length < 8 || b.Length < 8 || a[1] != n || b[1] != (n | 0x80) || a[3] >> 4 == 0) return null;
        return new FaultLogEntry(n, (a[3] & 0x0F) + 1, a[3] >> 4, U16(a, 4), U16(a, 6) / 10.0, U16(b, 6) / 100.0,
            (uint)(b[2] | b[3] << 8 | b[4] << 16 | b[5] << 24));
    }
}
