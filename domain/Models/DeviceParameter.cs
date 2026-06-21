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
    // ponytail: a config-surface-only setting (e.g. output name) that lives in the schema,
    // snapshot, apply doc and project file but is never read/written over CAN — the device
    // has no storage for it. The I/O loops skip these.
    public bool LocalOnly { get; init; } = false;
    public object DefaultValue { get; init; } = null!;

    [JsonIgnore]
    public bool IsModified => !Equals(GetValue(), DefaultValue);
}
