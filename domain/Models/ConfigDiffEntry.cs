namespace domain.Models;

/// <summary>
/// One parameter that differs between the app's config and the device, captured during a Read.
/// Kind: "value" = both have it but the values differ; "appOnly" = the app has this param but the
/// device's firmware never sent it (device firmware older than the app); "deviceOnly" = the device
/// sent a param the app doesn't know (device firmware newer than the app).
/// </summary>
public record ConfigDiffEntry(string Name, int Index, int SubIndex, string Kind, string? AppValue, string? DeviceValue);
