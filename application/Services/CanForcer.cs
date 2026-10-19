using domain.Interfaces;
using domain.Models;

namespace application.Services;

/// <summary>
/// Force a CAN-input-driven value from the app: transmit one frame every period until the hold runs out,
/// <see cref="Stop"/>, or the adapter goes away. A new <see cref="Start"/> replaces the frame (a +/- step)
/// and restarts the hold. The hold is the safety net when the browser that started it is gone.
/// </summary>
public class CanForcer(ICommsAdapterManager adapters, CanMsgLogger log)
{
    private readonly Lock _lock = new();
    private CancellationTokenSource? _cts;
    private int _periodMs;

    public CanFrame? Frame { get; private set; }
    public DateTime Until { get; private set; }
    public long Sent { get; private set; }
    public bool Active { get { lock (_lock) return _cts != null; } }

    /// <summary>Start or update the forced frame. Returns an error message, or null when it runs.</summary>
    public string? Start(CanFrame frame, int periodMs, int holdSec)
    {
        if (frame.Id < 0 || frame.Id > (frame.IsExtended ? 0x1FFFFFFF : 0x7FF))
            return frame.IsExtended ? "An extended id is 0 to 1FFFFFFF." : "A standard id is 0 to 7FF.";
        if (frame.Len is < 0 or > 8 || frame.Payload.Length != frame.Len) return "A frame carries 0 to 8 data bytes.";
        if (!adapters.IsConnected || adapters.ActiveAdapter is null) return "Not connected to the car.";
        lock (_lock)
        {
            Frame = frame;
            _periodMs = Math.Clamp(periodMs, 10, 1000);
            Until = DateTime.UtcNow.AddSeconds(Math.Clamp(holdSec, 1, 30));
            if (_cts == null) { _cts = new CancellationTokenSource(); _ = Loop(_cts); }
        }
        return null;
    }

    public void Stop()
    {
        lock (_lock) { _cts?.Cancel(); _cts = null; Frame = null; }
    }

    private async Task Loop(CancellationTokenSource cts)
    {
        try
        {
            while (!cts.IsCancellationRequested)
            {
                CanFrame f; int period; var a = adapters.ActiveAdapter;
                lock (_lock)
                {
                    if (_cts != cts) return;
                    if (Frame is null || DateTime.UtcNow >= Until || a is null || !adapters.IsConnected) { _cts = null; Frame = null; return; }
                    f = Frame; period = _periodMs;
                }
                if (await a.WriteAsync(f, cts.Token)) { log.Log(application.Models.DataDirection.Tx, f); Sent++; }
                await Task.Delay(period, cts.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch { lock (_lock) if (_cts == cts) { _cts = null; Frame = null; } }   // adapter error: stop forcing
    }
}
