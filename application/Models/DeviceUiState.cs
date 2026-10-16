namespace application.Models;

/// <summary>
/// Tracks UI-related state for devices (persists across navigation)
/// </summary>
public class DeviceUiState
{
    public bool NeedsRead { get; set; }

    // Progress of a chunked (one-param-at-a-time) Read All, surfaced to the UI.
    public bool Reading { get; set; }
    public int ReadDone { get; set; }
    public int ReadTotal { get; set; }

    // Firmware 5.6
    public bool? HasLed { get; set; }               // Identify reply (G12)
    public bool Asleep { get; set; }                // announced "going to sleep" and quiet since (G14)
    public DateTime? AsleepSince { get; set; }
    public int? WakeReason { get; set; }            // SleepInfo: 0 power-on, 1 CAN, 2 digital input, 3 USB (G14)
    public int WakeSource { get; set; }             // the digital input number for 2
    public int WakeCount { get; set; }
    public int? SleepBlockers { get; set; }         // bit0 sleep off, bit1 outputs on, bit2 USB, bit3 CAN traffic
    public bool SleepInfoAsked { get; set; }        // asked once per connect
    public DateTime VersionAskedAt { get; set; }    // last automatic version request (unknown version)
}
