namespace domain.Devices.dingoPdm;

public record PdmDeviceDefinition(
    int PdmType,
    string TypeName,
    string Icon,
    int NumDigitalInputs,
    int NumOutputs,
    int NumCanInputs,
    int NumCanOutputs,
    int NumVirtualInputs,
    int NumFlashers,
    int NumCounters,
    int NumConditions,
    int NumKeypads,
    int MinMajorVersion,
    int MinMinorVersion,
    int MinBuildVersion,
    // Per-output continuous current rating (A), indexed by output number (OUT1 = index 0).
    // null/empty = unknown (the UI then shows no rating for that model).
    int[]? OutputCurrentRatings = null,
    // Timer / lookup-table function slots (firmware >= 5.5.107). Defaults match dingoFW's PDM boards.
    int NumTimers = 8,
    int NumTables = 2
    );
