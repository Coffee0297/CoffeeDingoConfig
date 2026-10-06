using System.Text.Json;
using application.Models;
using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Devices.Generic;
using domain.Devices.Keypad.BlinkMarine;
using domain.Devices.Keypad.Grayhill;
using domain.Interfaces;
using Microsoft.Extensions.Logging;

namespace application.Services;

public class ConfigFileManager(ILogger<ConfigFileManager> logger, DeviceDefinitionManager deviceDefinitionManager)
{
    private readonly JsonSerializerOptions _options = new() { WriteIndented = true, PropertyNameCaseInsensitive = true};

    private string _workingDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        "dingoConfig");

    public event Action? OnStateChanged;

    public string WorkingDirectory
    {
        get => _workingDirectory;
        set
        {
            if (_workingDirectory != value)
            {
                _workingDirectory = value;
                EnsureWorkingDirectoryExists();
                OnStateChanged?.Invoke();
            }
        }
    }

    public string? CurrentFileName
    {
        get;
        private set
        {
            if (field != value)
            {
                field = value;
                OnStateChanged?.Invoke();
            }
        }
    }

    private void EnsureWorkingDirectoryExists()
    {
        if (Directory.Exists(_workingDirectory)) return;
        Directory.CreateDirectory(_workingDirectory);
        logger.LogInformation($"Created working directory: {_workingDirectory}");
    }

    public List<FileInfo> ListFilesWithExtension(string extension)
    {
        EnsureWorkingDirectoryExists();
        var directory = new DirectoryInfo(_workingDirectory);
        return directory.GetFiles(extension)
            .OrderByDescending(f => f.LastWriteTime)
            .ToList();
    }

    public bool FileExists(string fileName)
    {
        var fullPath = GetFullPath(fileName);
        return File.Exists(fullPath);
    }

    public void NewFile()
    {
        CurrentFileName = null;
        logger.LogInformation("New file started");
    }

    /// <summary>Serialize devices to the project (ConfigFile) JSON. Pure — no disk I/O — so it can
    /// back a browser download (the user saves anywhere on their PC, cross-platform).</summary>
    public string SerializeDevices(IEnumerable<IDevice> devices)
    {
        var list = devices.ToList();
        var config = new ConfigFile
        {
            // Deterministic order (base ID, then name): the device manager keeps devices in a dictionary, so a
            // plain ToList() reshuffled the file on every save and made project diffs unreadable.
            PdmDevices = list.OfType<PdmDevice>().OrderBy(d => d.BaseId).ThenBy(d => d.Name).ToList(),
            CanboardDevices = list.Where(d => d.GetType() == typeof(CanboardDevice)).Cast<CanboardDevice>().OrderBy(d => d.BaseId).ThenBy(d => d.Name).ToList(),
            DbcDevices = list.Where(d => d.GetType() == typeof(DbcDevice)).Cast<DbcDevice>().OrderBy(d => d.BaseId).ThenBy(d => d.Name).ToList(),
            BlinkMarineKeypads = list.OfType<BlinkMarineKeypadDevice>().OrderBy(d => d.BaseId).ThenBy(d => d.Name).ToList(),
            GrayhillKeypads = list.OfType<GrayhillKeypadDevice>().OrderBy(d => d.BaseId).ThenBy(d => d.Name).ToList()
        };
        return JsonSerializer.Serialize(config, _options);
    }

    /// <summary>Parse a project (ConfigFile) JSON string into devices, applying definitions. Pure —
    /// no disk I/O — so it can load a file the user picked from their PC.</summary>
    public List<IDevice>? LoadDevicesFromJson(string jsonString)
    {
        var config = JsonSerializer.Deserialize<ConfigFile>(jsonString, _options);
        if (config == null) return null;

        foreach (var device in config.PdmDevices)
            device.ApplyDefinition(deviceDefinitionManager.GetByPdmType(device.PdmType) ?? DeviceDefinitionManager.DefaultPdm);
        foreach (var device in config.CanboardDevices)
            device.ApplyDefinition(deviceDefinitionManager.GetByCanboardType(device.CanboardType) ?? DeviceDefinitionManager.DefaultCanboard);

        MigrateLegacySleep(jsonString, config);

        var allDevices = new List<IDevice>();
        allDevices.AddRange(config.PdmDevices);
        allDevices.AddRange(config.CanboardDevices);
        allDevices.AddRange(config.DbcDevices);
        allDevices.AddRange(config.BlinkMarineKeypads);
        allDevices.AddRange(config.GrayhillKeypads);
        return allDevices;
    }

    /// <summary>0.6.x files carried `sleepInputEnabled` / `sleepInput` / `sleepInputActiveHigh` (a digital-input-only sleep
    /// trigger). The models no longer have those properties, so they were dropped without a word. An active-high trigger
    /// is exactly the new force-sleep input; an active-low one has no direct equivalent (the input would need inverting),
    /// so it is reported in the log instead of being guessed.</summary>
    private void MigrateLegacySleep(string jsonString, ConfigFile config)
    {
        try
        {
            using var doc = JsonDocument.Parse(jsonString);
            foreach (var key in new[] { "PdmDevices", "CanboardDevices" })
            {
                if (!doc.RootElement.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) continue;
                foreach (var el in arr.EnumerateArray())
                {
                    if (!el.TryGetProperty("sleepInputEnabled", out var en) || en.ValueKind != JsonValueKind.True) continue;
                    var input = el.TryGetProperty("sleepInput", out var si) && si.TryGetInt32(out var n) ? n : 0;
                    var activeHigh = !el.TryGetProperty("sleepInputActiveHigh", out var ah) || ah.ValueKind != JsonValueKind.False;
                    var name = el.TryGetProperty("name", out var nm) ? nm.GetString() : "?";
                    var guid = el.TryGetProperty("guid", out var gd) && Guid.TryParse(gd.GetString(), out var gg) ? gg : Guid.Empty;
                    IDevice? dev = key == "PdmDevices" ? config.PdmDevices.FirstOrDefault(d => d.Guid == guid) : config.CanboardDevices.FirstOrDefault(d => d.Guid == guid);
                    if (dev == null || input <= 0) continue;
                    if (!activeHigh)
                    {
                        logger.LogWarning("{Name}: the old active-LOW sleep input #{Input} has no direct equivalent — set a force-sleep signal (invert the input or use a Timer on it) in System ▸ Settings", name, input);
                        continue;
                    }
                    switch (dev)
                    {
                        case PdmDevice p when p.ForceSleepInput == 0: p.ForceSleepInput = input; break;
                        case CanboardDevice c when c.ForceSleepInput == 0: c.ForceSleepInput = input; break;
                        default: continue;
                    }
                    logger.LogInformation("{Name}: migrated the old sleep input #{Input} to the force-sleep input", name, input);
                }
            }
        }
        catch (Exception e) { logger.LogWarning("Legacy sleep-input migration skipped: {Message}", e.Message); }
    }

    /// <summary>
    /// Save devices to file, preserving all properties by grouping by concrete type
    /// </summary>
    public async Task SaveDevices(List<IDevice> devices, string? fileName = null)
    {
        var targetFileName = fileName ?? CurrentFileName;

        if (string.IsNullOrWhiteSpace(targetFileName))
        {
            throw new InvalidOperationException("No filename specified");
        }

        var fullPath = GetFullPath(targetFileName);

        try
        {
            var jsonString = SerializeDevices(devices);
            await File.WriteAllTextAsync(fullPath, jsonString);

            CurrentFileName = targetFileName;

            logger.LogInformation($"Saved {devices.Count} devices to {targetFileName}");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, $"Error saving devices to {targetFileName}");
            throw;
        }
    }

    /// <summary>
    /// Load devices from file, returning all devices as a single list
    /// </summary>
    public async Task<List<IDevice>?> LoadDevices(string fileName)
    {
        var fullPath = GetFullPath(fileName);

        if (!File.Exists(fullPath))
        {
            logger.LogError($"File not found: {fullPath}");
            return null;
        }

        try
        {
            var jsonString = await File.ReadAllTextAsync(fullPath);
            var allDevices = LoadDevicesFromJson(jsonString);
            if (allDevices == null) return null;

            CurrentFileName = Path.GetFileName(fileName);
            logger.LogInformation($"Loaded {allDevices.Count} devices from {fileName}");
            return allDevices;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, $"Error loading devices from {fileName}");
            throw;
        }
    }

    private string GetFullPath(string fileName)
    {
        // Ensure .json extension
        if (!fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            fileName += ".json";
        }

        // If already a full path, return it
        if (Path.IsPathRooted(fileName))
        {
            return fileName;
        }

        // Otherwise, combine with working directory
        return Path.Combine(_workingDirectory, fileName);
    }
}