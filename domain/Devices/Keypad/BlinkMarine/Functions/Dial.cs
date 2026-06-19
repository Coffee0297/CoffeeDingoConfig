using System.Text.Json.Serialization;
using domain.Devices.Keypad.BlinkMarine.Enums;
using domain.Devices.Keypad.Enums;

namespace domain.Devices.Keypad.BlinkMarine.Functions;

public class Dial(int number, string name)
{
    [JsonPropertyName("number")] public int Number { get; } = number;
    [JsonPropertyName("name")] public string Name { get; set; } = name;
    
    [JsonPropertyName("minCount")] public int MinCount { get; set; }
    [JsonPropertyName("maxCount")] public int MaxCount { get; set; }
    [JsonPropertyName("ledOffset")] public int LedOffset { get; set; }
    [JsonIgnore] public int TopPosition { get; set; } = 8; //Default = 8
    [JsonIgnore] public int Ticks { get; set; }
    [JsonIgnore] public DialDirection Direction { get; set; }
    [JsonIgnore] public int Counter { get; set; }
    [JsonIgnore] public bool[] RingLeds {get; set;} = new bool[16];
}