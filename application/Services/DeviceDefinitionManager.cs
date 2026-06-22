using System.Text.Json;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;

namespace application.Services;

public class DeviceDefinitionManager
{
    private const string DefinitionsFilename = "pdm-definitions.json";

    // Single source of truth shape: { "pdms": [...], "canboards": [...] }.
    // A bare JSON array is still accepted (legacy) and treated as the pdms list.
    private sealed record DefinitionsFile(
        List<PdmDeviceDefinition>? Pdms,
        List<CanboardDeviceDefinition>? Canboards);

    // Fallbacks used only if pdm-definitions.json is missing/unreadable. The file is the source of
    // truth; these mirror the documented stock hardware so the app still runs without it.
    public static readonly PdmDeviceDefinition DefaultPdm = new(
        PdmType: 0,
        TypeName: "dingoPDM",
        Icon: "Bolt",
        NumDigitalInputs: 2,
        NumOutputs: 8,
        NumCanInputs: 32,
        NumCanOutputs: 32,
        NumVirtualInputs: 16,
        NumFlashers: 4,
        NumCounters: 4,
        NumConditions: 32,
        NumKeypads: 2,
        MinMajorVersion: 5,
        MinMinorVersion: 5,
        MinBuildVersion: 100,
        OutputCurrentRatings: [14, 14, 8, 8, 8, 8, 8, 8]);

    public static readonly CanboardDeviceDefinition DefaultCanboard = new(
        CanboardType: 0,
        TypeName: "CANBoard",
        Icon: "",
        NumAnalogInputs: 5,
        NumDigitalInputs: 8,
        NumOutputs: 4,
        NumCanInputs: 8,
        NumCanOutputs: 8,
        NumVirtualInputs: 8,
        NumFlashers: 4,
        NumCounters: 4,
        NumConditions: 8,
        MinMajorVersion: 5,
        MinMinorVersion: 5,
        MinBuildVersion: 100);

    private readonly IReadOnlyList<PdmDeviceDefinition> _pdmDefinitions;
    private readonly IReadOnlyList<CanboardDeviceDefinition> _canboardDefinitions;

    public DeviceDefinitionManager()
    {
        var (pdms, canboards) = LoadDefinitions();
        _pdmDefinitions = pdms;
        _canboardDefinitions = canboards;
    }

    private static (IReadOnlyList<PdmDeviceDefinition>, IReadOnlyList<CanboardDeviceDefinition>) LoadDefinitions()
    {
        var filePath = Path.Combine(AppContext.BaseDirectory, DefinitionsFilename);
        if (!File.Exists(filePath))
            return ([DefaultPdm], [DefaultCanboard]);

        try
        {
            var json = File.ReadAllText(filePath).TrimStart();
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

            List<PdmDeviceDefinition>? pdms;
            List<CanboardDeviceDefinition>? canboards = null;
            if (json.StartsWith('['))   // legacy: a bare array of PDM definitions
            {
                pdms = JsonSerializer.Deserialize<List<PdmDeviceDefinition>>(json, opts);
            }
            else
            {
                var file = JsonSerializer.Deserialize<DefinitionsFile>(json, opts);
                pdms = file?.Pdms;
                canboards = file?.Canboards;
            }

            return (
                pdms is { Count: > 0 } ? pdms : [DefaultPdm],
                canboards is { Count: > 0 } ? canboards : [DefaultCanboard]);
        }
        catch
        {
            return ([DefaultPdm], [DefaultCanboard]);
        }
    }

    public IReadOnlyList<PdmDeviceDefinition> GetAllPdms() => _pdmDefinitions;
    public IReadOnlyList<CanboardDeviceDefinition> GetAllCanboards() => _canboardDefinitions;

    public PdmDeviceDefinition? GetByPdmType(int pdmType) =>
        _pdmDefinitions.FirstOrDefault(d => d.PdmType == pdmType);

    public CanboardDeviceDefinition? GetByCanboardType(int canboardType) =>
        _canboardDefinitions.FirstOrDefault(d => d.CanboardType == canboardType);
}
