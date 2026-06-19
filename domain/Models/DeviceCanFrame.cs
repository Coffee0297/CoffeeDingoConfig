namespace domain.Models;

public class DeviceCanFrame
{
    public required CanFrame Frame { get; set; }
    public bool SendOnly { get; set; }
    public Timer? TimeSentTimer { get; set; }
    public int RxAttempts { get; set; }
    public int DeviceBaseId { get; set; }
    public string Name { get; set; } = string.Empty;
}