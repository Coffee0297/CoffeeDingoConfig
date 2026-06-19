using System.Text.Json.Serialization;

namespace domain.Models;

public class DeviceParameter
{
    public string ParentName { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public int Index { get; init; }
    public int SubIndex { get; init; }
    public Func<object> GetValue { get; init; } = null!;
    public Action<object> SetValue { get; init; } = null!;
    public Type ValueType { get; init; } = typeof(int);
    public bool IsSignedInt { get; init; } = false;
    public object DefaultValue { get; init; } = null!;

    [JsonIgnore]
    public bool IsModified => !Equals(GetValue(), DefaultValue);
}
