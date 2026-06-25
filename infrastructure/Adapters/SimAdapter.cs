using application.Models;
using application.Services;
using domain.Enums;
using domain.Interfaces;
using domain.Models;

namespace infrastructure.Adapters;

public class SimAdapter(SimPlayback playback) : ICommsAdapter
{
    public string Name => "Sim";

    public Task<bool> InitAsync(string port, CanBitRate bitRate, CancellationToken ct)
    {
        IsConnected = false;
        return Task.FromResult(true);
    }

    public Task<bool> StartAsync(CancellationToken ct)
    {
        IsConnected = true;
        playback.MessageReady += OnMessageReady;
        return Task.FromResult(true);
    }

    public Task<bool> StopAsync()
    {
        playback.MessageReady -= OnMessageReady;
        playback.Clear();
        IsConnected = false;
        return Task.FromResult(true);
    }

    public Task<bool> WriteAsync(CanFrame frame, CancellationToken ct) => Task.FromResult(true);

    public Task<bool> WriteBatchAsync(IReadOnlyList<CanFrame> frames, CancellationToken ct) => Task.FromResult(true);

    private void OnMessageReady(CanFrame frame, DataDirection direction)
    {
        DataReceived?.Invoke(this, new CanFrameEventArgs(frame));
    }

    public event DataReceivedHandler? DataReceived;

#pragma warning disable CS0067 // Event is never used - SimAdapter does not disconnect unexpectedly
    public event EventHandler? Disconnected;
#pragma warning restore CS0067

    public bool IsConnected { get; private set; }

    // Simulated playback has no live bus to flood, so there is nothing to filter.
    public void SetReceiveFilter(int? loId, int? hiId = null) { }

    public Task<AdapterFilterProbe> ProbeFilterAsync(CancellationToken ct = default) =>
        Task.FromResult(new AdapterFilterProbe(null, "sim", "N/A — simulation has no live bus."));
}
