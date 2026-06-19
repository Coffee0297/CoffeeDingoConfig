using System.Text.Json.Serialization;

namespace domain.Devices.Keypad.BlinkMarine.Functions;

public class AnalogInput(int number, string name)
{
    [JsonPropertyName("number")] public int Number { get; } = number;
    [JsonPropertyName("name")] public string Name { get; set; } = name;
    [JsonIgnore] public double Voltage { get; set; }
}