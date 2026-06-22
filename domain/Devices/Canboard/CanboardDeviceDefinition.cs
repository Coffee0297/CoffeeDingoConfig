namespace domain.Devices.Canboard;

public record CanboardDeviceDefinition(
    int CanboardType,
    string TypeName,
    string Icon,
    int NumAnalogInputs,
    int NumDigitalInputs,
    int NumOutputs,
    int NumCanInputs,
    int NumCanOutputs,
    int NumVirtualInputs,
    int NumFlashers,
    int NumCounters,
    int NumConditions,
    int MinMajorVersion,
    int MinMinorVersion,
    int MinBuildVersion,
    // Per-output continuous current rating (A), indexed by output number (OUT1 = index 0).
    // null/empty = unknown (the UI then shows no rating).
    int[]? OutputCurrentRatings = null
);