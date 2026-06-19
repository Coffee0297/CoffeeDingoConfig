using System.Text.Json.Serialization;
using domain.Common;
using domain.Enums;

namespace domain.Models;

public class DbcSignal
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("extended")] public bool IsExtended { get; set; }      // 29-bit CAN ID
    [JsonPropertyName("message")] public string MessageName { get; set; } = ""; // parent BO_ name (grouping)
    [JsonPropertyName("startBit")] public int StartBit { get; set; }
    [JsonPropertyName("length")] public int Length { get; set; }
    [JsonPropertyName("byteOrder")] public ByteOrder ByteOrder { get; set; } = ByteOrder.LittleEndian;
    [JsonPropertyName("isSigned")] public bool IsSigned { get; set; }
    [JsonPropertyName("factor")] public double Factor { get; set; } = 1.0;
    [JsonPropertyName("offset")] public double Offset { get; set; }
    [JsonPropertyName("unit")] public string Unit { get; set; } = "";
    [JsonPropertyName("min")] public double Min { get; set; }
    [JsonPropertyName("max")] public double Max { get; set; }
    [JsonPropertyName("isFloat")] public bool IsFloat { get; set; }
    [JsonIgnore] [Plotable(displayName: "Value")] public double Value { get; set; }
}