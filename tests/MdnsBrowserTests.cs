using System.Net;
using System.Text;
using infrastructure.Comms;
using Xunit;

namespace tests;

public class MdnsBrowserTests
{
    static void Name(List<byte> b, string n) { foreach (var l in n.Split('.')) { b.Add((byte)l.Length); b.AddRange(Encoding.ASCII.GetBytes(l)); } b.Add(0); }
    static void Rec(List<byte> b, int type, List<byte> data) { b.AddRange([0, (byte)type, 0, 1, 0, 0, 0, 120, (byte)(data.Count >> 8), (byte)data.Count]); b.AddRange(data); }

    // a bridge's answer: PTR -> instance, SRV -> host:port, A -> address; the SRV owner name is compressed
    static byte[] Answer()
    {
        var m = new List<byte> { 0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0 };
        Name(m, "_slcan._tcp.local");
        var ptr = new List<byte>(); Name(ptr, "Garage bridge._slcan._tcp.local");
        Rec(m, 12, ptr);
        int instanceAt = 12 + 19 + 10;                       // where the PTR target name starts
        m.AddRange([(byte)(0xC0 | instanceAt >> 8), (byte)instanceAt]);
        var srv = new List<byte> { 0, 0, 0, 0, 0x1E, 0x62 };  // priority, weight, port 7778
        Name(srv, "bridge-1.local");
        Rec(m, 33, srv);
        Name(m, "bridge-1.local");
        Rec(m, 1, [192, 168, 4, 20]);
        return m.ToArray();
    }

    [Fact]
    public void Parses_ptr_srv_and_a_into_a_bridge()
    {
        var b = Assert.Single(MdnsBrowser.Parse(Answer(), IPAddress.Parse("10.0.0.9")));
        Assert.Equal("Garage bridge", b.Name);
        Assert.Equal("bridge-1.local", b.Host);
        Assert.Equal("192.168.4.20", b.Address);
        Assert.Equal(7778, b.Port);
        Assert.Equal("tcp://192.168.4.20:7778", b.Url);
    }

    [Fact]
    public void A_query_is_ignored_and_junk_does_not_throw()
    {
        Assert.Empty(MdnsBrowser.Parse(MdnsBrowser.Query(MdnsBrowser.ServiceType), IPAddress.Loopback));
        Assert.Empty(MdnsBrowser.Parse(Answer()[..30], IPAddress.Loopback));
    }
}
