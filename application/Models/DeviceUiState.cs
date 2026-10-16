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

    // G2: edits saved to the project and held for "Apply to car" since the module was last in step. Only counts
    // while the module differs (a confirmed write or read clears ConfigMismatch, and with it these).
    public int PendingEdits { get; set; }
}
