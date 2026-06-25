using domain.Enums;
using domain.Models;

namespace domain.Interfaces;

public delegate void DataReceivedHandler(object sender, CanFrameEventArgs e);

/// <summary>
/// Result of <see cref="ICommsAdapter.ProbeFilterAsync"/>. <c>Suitable</c>: true = the adapter can drop
/// other-id traffic at the wire (so it can flash over CAN on a busy bus), false = it forwards everything
/// (flash only on a quiet bus / use real CAN hardware), null = couldn't tell (e.g. no bus traffic to test).
/// </summary>
public record AdapterFilterProbe(bool? Suitable, string Mechanism, string Message);

public interface ICommsAdapter
{
    string? Name { get; }
    Task<bool>  InitAsync(string port, CanBitRate bitRate, CancellationToken ct);
    Task<bool>  StartAsync(CancellationToken ct);
    Task<bool>  StopAsync();
    Task<bool> WriteAsync(CanFrame frame, CancellationToken ct);
    Task<bool> WriteBatchAsync(IReadOnlyList<CanFrame> frames, CancellationToken ct);

    event DataReceivedHandler? DataReceived;
    event EventHandler? Disconnected;

    bool IsConnected { get;}

    /// <summary>
    /// Restrict which received CAN ids are surfaced via <see cref="DataReceived"/>, applied as close
    /// to the wire as the adapter allows, so a flooded bus can't bury a reply or overload the
    /// downstream handlers. Accepts an inclusive id range [<paramref name="loId"/>..<paramref name="hiId"/>]:
    /// pass a single id (hiId null) during a CAN flash to admit only the bootloader's XCP response id;
    /// pass the device's whole id block during a config exchange so its telemetry keeps flowing too
    /// (otherwise the device flickers "not found" while clamped to one id). Pass null to accept all.
    /// Implementations that can't filter cheaply may no-op.
    /// </summary>
    void SetReceiveFilter(int? loId, int? hiId = null);

    /// <summary>
    /// Probe whether this adapter actually filters received traffic at the wire — i.e. whether it is
    /// suitable for flashing a module over CAN on a busy bus. Measures the forwarded frame rate, applies
    /// the most restrictive filter the adapter supports, and re-measures; a large drop means real
    /// filtering. Needs some live bus traffic to test against. Restores the prior state before returning.
    /// </summary>
    Task<AdapterFilterProbe> ProbeFilterAsync(CancellationToken ct = default);
}