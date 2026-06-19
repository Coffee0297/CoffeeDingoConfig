using System.Text.Json.Serialization;
using domain.Interfaces;

namespace domain.Devices.Keypad;

public interface IKeypadDevice : IDevice
{
    [JsonPropertyName("model")] public string Model { get; set; }
}