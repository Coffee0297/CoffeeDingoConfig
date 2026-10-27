using application.Services;
using domain.Enums;
using domain.Interfaces;
using domain.Models;
using Microsoft.Extensions.Logging.Abstractions;
using web.Api;
using Xunit;

namespace tests;

/// <summary>While the app is on a real adapter it broadcasts the tool-present frame, so a sleep master can keep the car awake.</summary>
public class ConnectionKeeperHeartbeatTests
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
    }

    private class FakeManager(FakeAdapter a, string name) : ICommsAdapterManager
    {
        public (string[] adapters, string[] ports) GetAvailable() => ([], []);
        public (bool isConnected, string? activeAdapter, string? activePort) GetStatus() => (true, name, "");
        public ICommsAdapter ToAdapter(string adapterName) => a;
        public ICommsAdapter? ActiveAdapter => a;
        public bool IsConnected => true;
        public int? GatewayBaseId => 0x6D0;
        public Task<int?> ReidentifyAsync(CancellationToken ct = default) => Task.FromResult<int?>(0x6D0);
        public Task<bool> ConnectAsync(ICommsAdapter commsAdapter, string port, CanBitRate bitRate, CancellationToken ct = default) => Task.FromResult(true);
        public Task<bool> DisconnectAsync() => Task.FromResult(true);
#pragma warning disable CS0067
        public event EventHandler<CanFrameEventArgs>? DataReceived;
        public event EventHandler? Connected;
        public event EventHandler? Disconnected;
#pragma warning restore CS0067
    }

    private static async Task<List<CanFrame>> RunFor(string adapterName, int ms)
    {
        var a = new FakeAdapter();
        var keeper = new ConnectionKeeper(new FakeManager(a, adapterName), new UserPreferencesManager(NullLogger<UserPreferencesManager>.Instance),
            new ConfigFileManager(NullLogger<ConfigFileManager>.Instance, new DeviceDefinitionManager()), NullLogger<ConnectionKeeper>.Instance);
        await keeper.StartAsync(CancellationToken.None);
        await Task.Delay(ms);
        await keeper.StopAsync(CancellationToken.None);
        lock (a.Sent) return [.. a.Sent];
    }

    [Fact]
    public async Task BroadcastsToolPresentOnARealAdapter()
    {
        var sent = await RunFor("SLCAN", 2800);   // one 2 s tick, with slack
        var beat = Assert.Single(sent.Where(f => f.Id == ConnectionKeeper.ToolPresentId));
        Assert.Equal(8, beat.Len);
        Assert.Equal(1, beat.Payload[0]);
    }

    [Fact]
    public async Task StaysQuietOnTheSim()
    {
        var sent = await RunFor("Sim", 2800);
        Assert.DoesNotContain(sent, f => f.Id == ConnectionKeeper.ToolPresentId);
    }
}
