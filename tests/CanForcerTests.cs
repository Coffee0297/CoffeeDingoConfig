using application.Services;
using domain.Enums;
using domain.Interfaces;
using domain.Models;
using Xunit;

namespace tests;

/// <summary>Forcing a CAN value: the frame repeats, a new value replaces it, and it stops on Stop, at the hold, or offline.</summary>
public class CanForcerTests
{
    private class FakeAdapter : ICommsAdapter
    {
        public readonly List<CanFrame> Sent = [];
        public string? Name => "Fake";
        public Task<bool> InitAsync(string port, CanBitRate bitRate, CancellationToken ct) => Task.FromResult(true);
        public Task<bool> StartAsync(CancellationToken ct) => Task.FromResult(true);
        public Task<bool> StopAsync() => Task.FromResult(true);
        public Task<bool> WriteAsync(CanFrame frame, CancellationToken ct) { lock (Sent) Sent.Add(frame); return Task.FromResult(true); }
        public Task<bool> WriteBatchAsync(IReadOnlyList<CanFrame> frames, CancellationToken ct) => Task.FromResult(true);
#pragma warning disable CS0067
        public event DataReceivedHandler? DataReceived;
        public event EventHandler? Disconnected;
#pragma warning restore CS0067
        public bool IsConnected => true;
        public void SetReceiveFilter(int? loId, int? hiId = null) { }
        public Task<AdapterFilterProbe> ProbeFilterAsync(CancellationToken ct = default) => Task.FromResult(new AdapterFilterProbe(null, "", ""));
        public int Count { get { lock (Sent) return Sent.Count; } }
    }

    private class FakeManager(FakeAdapter a) : ICommsAdapterManager
    {
        public bool Up = true;
        public (string[] adapters, string[] ports) GetAvailable() => ([], []);
        public (bool isConnected, string? activeAdapter, string? activePort) GetStatus() => (Up, "Fake", "");
        public ICommsAdapter ToAdapter(string adapterName) => a;
        public ICommsAdapter? ActiveAdapter => Up ? a : null;
        public bool IsConnected => Up;
        public int? GatewayBaseId => null;
        public Task<int?> ReidentifyAsync(CancellationToken ct = default) => Task.FromResult<int?>(null);
        public Task<bool> ConnectAsync(ICommsAdapter commsAdapter, string port, CanBitRate bitRate, CancellationToken ct = default) => Task.FromResult(true);
        public Task<bool> DisconnectAsync() => Task.FromResult(true);
#pragma warning disable CS0067
        public event EventHandler<CanFrameEventArgs>? DataReceived;
        public event EventHandler? Connected;
        public event EventHandler? Disconnected;
#pragma warning restore CS0067
    }

    private static (CanForcer, FakeAdapter, FakeManager) Make()
    {
        var a = new FakeAdapter(); var m = new FakeManager(a);
        return (new CanForcer(m, new CanMsgLogger()), a, m);
    }

    private static async Task Until(Func<bool> ok, int ms = 3000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(ms);
        while (!ok() && DateTime.UtcNow < end) await Task.Delay(10);
        Assert.True(ok());
    }

    [Fact]
    public async Task RepeatsReplacesAndStops()
    {
        var (f, a, _) = Make();
        Assert.Null(f.Start(new CanFrame(0x123, 2, [1, 2]), 10, 10));
        await Until(() => a.Count >= 3);
        Assert.Null(f.Start(new CanFrame(0x123, 2, [9, 9]), 10, 10));   // a +/- step
        await Until(() => { lock (a.Sent) return a.Sent[^1].Payload[0] == 9; });
        f.Stop();
        await Task.Delay(50);
        var n = a.Count;
        await Task.Delay(100);
        Assert.Equal(n, a.Count);
        Assert.False(f.Active);
    }

    [Fact]
    public async Task StopsAtTheHold()
    {
        var (f, a, _) = Make();
        Assert.Null(f.Start(new CanFrame(0x7FF, 8, new byte[8]), 10, 1));
        await Until(() => !f.Active, 3000);
        var n = a.Count;
        await Task.Delay(100);
        Assert.Equal(n, a.Count);
        Assert.InRange(n, 20, 130);   // ~1 s at 10 ms
    }

    [Fact]
    public async Task StopsWhenTheAdapterGoes()
    {
        var (f, a, m) = Make();
        Assert.Null(f.Start(new CanFrame(0x100, 1, [1]), 10, 30));
        await Until(() => a.Count >= 1);
        m.Up = false;
        await Until(() => !f.Active);
    }

    [Fact]
    public void Refuses()
    {
        var (f, _, m) = Make();
        Assert.NotNull(f.Start(new CanFrame(0x800, 1, [1]), 10, 5));                     // standard id over 7FF
        Assert.Null(f.Start(new CanFrame(0x800, 1, [1], IsExtended: true), 10, 5));
        f.Stop();
        Assert.NotNull(f.Start(new CanFrame(0x20000000, 1, [1], IsExtended: true), 10, 5));
        Assert.NotNull(f.Start(new CanFrame(0x100, 9, new byte[9]), 10, 5));
        m.Up = false;
        Assert.NotNull(f.Start(new CanFrame(0x100, 1, [1]), 10, 5));                     // not connected
        Assert.False(f.Active);
    }
}
