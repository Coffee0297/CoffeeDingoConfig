using System.Net;
using System.Net.Sockets;
using System.Text;

namespace infrastructure.Comms;

/// <summary>
/// G11: finds SLCAN-over-TCP bridges on the local network with DNS-SD over mDNS (RFC 6762/6763). A bridge
/// announces the service type <c>_slcan._tcp.local</c> with its port; this sends one PTR question and collects
/// the answers (PTR -> instance, SRV -> host + port, A -> IPv4) for a short time.
/// ponytail: IPv4 only and one question (no known-answer suppression or retries); add those if bridges are missed.
/// </summary>
public static class MdnsBrowser
{
    public const string ServiceType = "_slcan._tcp.local";
    static readonly IPEndPoint Group = new(IPAddress.Parse("224.0.0.251"), 5353);

    public record Bridge(string Name, string Host, string Address, int Port)
    {
        public string Url => $"tcp://{Address}:{Port}";
    }

    public static async Task<List<Bridge>> BrowseAsync(TimeSpan listen, CancellationToken ct = default)
    {
        var found = new Dictionary<string, Bridge>();
        foreach (var nic in LocalIPv4())
        {
            try
            {
                using var udp = new UdpClient(new IPEndPoint(nic, 0));
                udp.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, nic.GetAddressBytes());
                var q = Query(ServiceType);
                await udp.SendAsync(q, q.Length, Group);
                var until = DateTime.UtcNow + listen;
                while (DateTime.UtcNow < until && !ct.IsCancellationRequested)
                {
                    var left = until - DateTime.UtcNow;
                    var recv = udp.ReceiveAsync(ct).AsTask();
                    if (await Task.WhenAny(recv, Task.Delay(left, ct)) != recv) break;
                    foreach (var b in Parse(recv.Result.Buffer, recv.Result.RemoteEndPoint.Address)) found[b.Name] = b;
                }
            }
            catch (SocketException) { /* an interface we cannot send on */ }
            catch (OperationCanceledException) { break; }
        }
        return found.Values.OrderBy(b => b.Name).ToList();
    }

    static IEnumerable<IPAddress> LocalIPv4() =>
        System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up && n.SupportsMulticast)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Select(a => a.Address)
            .Where(a => a.AddressFamily == AddressFamily.InterNetwork)
            .DefaultIfEmpty(IPAddress.Loopback);

    /// <summary>A PTR question for <paramref name="service"/> with the unicast-response bit set.</summary>
    public static byte[] Query(string service)
    {
        var b = new List<byte> { 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0 };   // id 0, flags 0, 1 question
        WriteName(b, service);
        b.AddRange([0, 12, 0x80, 1]);                                     // type PTR, class IN | QU
        return b.ToArray();
    }

    /// <summary>The bridges in one mDNS response. <paramref name="from"/> stands in when no A record came along.</summary>
    public static List<Bridge> Parse(byte[] msg, IPAddress from)
    {
        var ptr = new List<string>();
        var srv = new Dictionary<string, (string Host, int Port)>();
        var a = new Dictionary<string, string>();
        try
        {
            if (msg.Length < 12 || (msg[2] & 0x80) == 0) return [];       // not a response
            int qd = msg[4] << 8 | msg[5], records = (msg[6] << 8 | msg[7]) + (msg[8] << 8 | msg[9]) + (msg[10] << 8 | msg[11]);
            int p = 12;
            for (int i = 0; i < qd; i++) { ReadName(msg, ref p); p += 4; }
            for (int i = 0; i < records && p + 10 <= msg.Length; i++)
            {
                var name = ReadName(msg, ref p);
                int type = msg[p] << 8 | msg[p + 1], len = msg[p + 8] << 8 | msg[p + 9];
                int data = p + 10;
                p = data + len;
                if (type == 12 && name.Equals(ServiceType, StringComparison.OrdinalIgnoreCase)) { int q = data; ptr.Add(ReadName(msg, ref q)); }
                else if (type == 33) { int q = data + 6; srv[name] = (ReadName(msg, ref q), msg[data + 4] << 8 | msg[data + 5]); }
                else if (type == 1 && len == 4) a[name] = new IPAddress(msg.AsSpan(data, 4)).ToString();
            }
        }
        // any malformed packet from the LAN (truncated, a label running past the end, a short record) ends the parse;
        // what was read before it is kept. Never an exception: one bad device must not break the search.
        catch (Exception e) when (e is IndexOutOfRangeException or ArgumentException) { }
        return ptr.Where(srv.ContainsKey).Select(n =>
        {
            var (host, port) = srv[n];
            var label = n.EndsWith("." + ServiceType, StringComparison.OrdinalIgnoreCase) ? n[..^(ServiceType.Length + 1)] : n;
            return new Bridge(label, host, a.GetValueOrDefault(host) ?? from.ToString(), port);
        }).ToList();
    }

    static void WriteName(List<byte> b, string name)
    {
        foreach (var label in name.TrimEnd('.').Split('.')) { var x = Encoding.UTF8.GetBytes(label); b.Add((byte)x.Length); b.AddRange(x); }
        b.Add(0);
    }

    static string ReadName(byte[] m, ref int p)
    {
        var parts = new List<string>();
        int jumps = 0, end = -1;
        while (true)
        {
            int len = m[p];
            if (len == 0) { p++; break; }
            if ((len & 0xC0) == 0xC0)                                     // compression pointer
            {
                if (end < 0) end = p + 2;
                p = (len & 0x3F) << 8 | m[p + 1];
                if (++jumps > 20) throw new IndexOutOfRangeException();
                continue;
            }
            parts.Add(Encoding.UTF8.GetString(m, p + 1, len));
            p += len + 1;
        }
        if (end >= 0) p = end;
        return string.Join('.', parts);
    }
}
