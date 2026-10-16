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
    int[]? OutputCurrentRatings = null,
    // Timer function slots (firmware >= 5.5.107). The CANBoard has no lookup tables (2 KB config sector).
    int NumTimers = 4,
    // Board temperature (°C): at TempWarnC the module reports OverTemp; at TempCritC it switches every output
    // off with a fatal error (BOARD_TEMP_WARN / BOARD_TEMP_CRIT in dingoFW core/device_config.h).
    int TempWarnC = 55,
    int TempCritC = 80,
    // G21: board facts for the UI (see PdmDeviceDefinition.Board).
    System.Text.Json.JsonElement? Board = null,
    // Math and CAN Message blocks (firmware 5.6; fewer than a PDM: the 2 KB config sector)
    int NumMath = 4,
    int NumCanMessages = 2
);