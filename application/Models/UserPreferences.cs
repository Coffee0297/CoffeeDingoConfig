using domain.Enums;

namespace application.Models;

public class UserPreferences
{
    public string WorkingDirectory { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        "dingoConfig");

    public string? SelectedAdapter { get; set; }
    public string? SelectedPort { get; set; }
    public CanBitRate SelectedBitrate { get; set; }
    public NumberFormat IdFormat { get; set; }

    // G10: connect to the last adapter when the app starts; reconnect when the link drops on its own.
    public bool AutoConnect { get; set; }
    public bool AutoReconnect { get; set; } = true;
}
