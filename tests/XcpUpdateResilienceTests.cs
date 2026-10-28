using application.Services;
using domain.Enums;
using domain.Interfaces;
using domain.Models;
using Xunit;

namespace tests;

/// <summary>An update over CAN must not leave a module erased because one reply was lost: a lost PROGRAM reply is
/// retried at the same address, and a link that loses replies is caught before anything is erased.</summary>
public class XcpUpdateResilienceTests
{
    private const int Base = 0x749;

    /// <summary>A bootloader on the bus: answers XCP commands into a memory map, and drops the replies listed.</summary>
    private sealed class FakeBoot : ICommsAdapter, ICommsAdapterManager
    {
        public readonly Dictionary<uint, byte> Mem = [];
        public readonly HashSet<int> DropReply = [];   // 0-based count of commands whose reply is lost (after acting)
        public bool Silent;                            // bus-off: no replies at all
        private uint _mta; private int _n;

        public Task<bool> WriteAsync(CanFrame f, CancellationToken ct)
        {
            if (f.Id != Base + 12) return Task.FromResult(true);
            var c = f.Payload; byte[] resp = [0xFF];
            switch (c[0])
            {
                case 0xFF: resp = [0xFF, 0x10, 0x00, 0x08, 0x08, 0x00, 0x01, 0x01]; break;   // CONNECT
                case 0xF6: _mta = BitConverter.ToUInt32(c, 4); break;                          // SET_MTA (Intel)
                case 0xC9: for (int i = 1; i < 8; i++) Mem[_mta++] = c[i]; break;               // PROGRAM_MAX
                case 0xD0: for (int i = 0; i < c[1]; i++) Mem[_mta++] = c[2 + i]; break;        // PROGRAM
                case 0xF5: resp = [0xFF, .. Enumerable.Range(0, c[1]).Select(_ => Mem[_mta++])]; break; // UPLOAD
            }
            var drop = Silent || DropReply.Contains(_n++);
            if (!drop) Task.Run(() => DataReceived?.Invoke(this, new CanFrameEventArgs(new CanFrame(Base + 13, resp.Length, [.. resp, .. new byte[8 - resp.Length]]))));
            return Task.FromResult(true);
        }

        // ---- ICommsAdapterManager / ICommsAdapter plumbing ----
        public event EventHandler<CanFrameEventArgs>? DataReceived;
        public ICommsAdapter? ActiveAdapter => this;
        public bool IsConnected => true;
        public string? Name => "Fake";
        public (string[] adapters, string[] ports) GetAvailable() => ([], []);
        public (bool isConnected, string? activeAdapter, string? activePort) GetStatus() => (true, "Fake", "");
        public ICommsAdapter ToAdapter(string adapterName) => this;
        public int? GatewayBaseId => null;
        public Task<int?> ReidentifyAsync(CancellationToken ct = default) => Task.FromResult<int?>(null);
        public Task<bool> ConnectAsync(ICommsAdapter a, string port, CanBitRate bitRate, CancellationToken ct = default) => Task.FromResult(true);
        public Task<bool> DisconnectAsync() => Task.FromResult(true);
        public Task<bool> InitAsync(string port, CanBitRate bitRate, CancellationToken ct) => Task.FromResult(true);
        public Task<bool> StartAsync(CancellationToken ct) => Task.FromResult(true);
        public Task<bool> StopAsync() => Task.FromResult(true);
        public Task<bool> WriteBatchAsync(IReadOnlyList<CanFrame> frames, CancellationToken ct) => Task.FromResult(true);
        public void SetReceiveFilter(int? loId, int? hiId = null) { }
        public Task<AdapterFilterProbe> ProbeFilterAsync(CancellationToken ct = default) => Task.FromResult(new AdapterFilterProbe(null, "", ""));
#pragma warning disable CS0067
        event DataReceivedHandler? ICommsAdapter.DataReceived { add { } remove { } }
        public event EventHandler? Disconnected;
        public event EventHandler? Connected;
#pragma warning restore CS0067
    }

    [Fact]
    public async Task ALostProgramReply_IsRetried_AndTheDataLandsOnce()
    {
        var boot = new FakeBoot();
        using var xcp = new XcpCanMaster(boot, Base);
        Assert.True(await xcp.ConnectAsync(1, default));
        boot.DropReply.Add(5);                                   // the 4th PROGRAM_MAX's reply is lost (it was written)
        var data = Enumerable.Range(0, 100).Select(i => (byte)i).ToArray();
        Assert.True(await xcp.WriteDataAsync(0x08004000, data, null, default));
        Assert.Equal(data, Enumerable.Range(0, 100).Select(i => boot.Mem[0x08004000u + (uint)i]).ToArray());
    }

    [Fact]
    public async Task ALostUploadReply_IsRetried_AndTheReadBackIsWhole()
    {
        var boot = new FakeBoot();
        using var xcp = new XcpCanMaster(boot, Base);
        Assert.True(await xcp.ConnectAsync(1, default));
        var data = Enumerable.Range(0, 100).Select(i => (byte)(i * 7)).ToArray();
        for (int i = 0; i < data.Length; i++) boot.Mem[0x08004000u + (uint)i] = data[i];
        boot.DropReply.Add(1); boot.DropReply.Add(6);            // the initial SET_MTA's reply and a later UPLOAD's
        Assert.Equal(data, await xcp.ReadDataAsync(0x08004000, data.Length, null, default));
    }

    [Fact]
    public async Task ASilentBootloader_FailsTheWrite_AndTheLinkCheckCountsLostReplies()
    {
        var boot = new FakeBoot();
        using var xcp = new XcpCanMaster(boot, Base);
        Assert.True(await xcp.ConnectAsync(1, default));
        boot.DropReply.Add(3); boot.DropReply.Add(7);
        Assert.Equal(2, await xcp.LinkCheckAsync(10, default));
        boot.Silent = true;
        Assert.False(await xcp.WriteDataAsync(0x08004000, new byte[14], null, default));
    }
}
