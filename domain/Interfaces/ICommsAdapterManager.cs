using domain.Enums;
using domain.Models;

namespace domain.Interfaces;

public interface ICommsAdapterManager
{
    (string[] adapters, string[] ports) GetAvailable();
    (bool isConnected, string? activeAdapter, string? activePort) GetStatus();
    ICommsAdapter ToAdapter(string adapterName);
    ICommsAdapter? ActiveAdapter { get; }
    bool IsConnected { get; }

    /// <summary>
    /// CAN base id of the dingo board acting as the USB&lt;-&gt;CAN bridge for the active connection, learned via
    /// the dingoFW 'I' identify at connect, or null when none was identified (standalone adapter / older
    /// firmware). The bridge board must be flashed over USB; every other module can be flashed over CAN.
    /// </summary>
    int? GatewayBaseId { get; }
    Task<bool> ConnectAsync(ICommsAdapter commsAdapter, string port, CanBitRate bitRate,  CancellationToken ct = default);
    Task<bool> DisconnectAsync();

    event EventHandler<CanFrameEventArgs>? DataReceived;
    event EventHandler? Connected;
    event EventHandler? Disconnected;
}