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
            PdmDevices = list.OfType<PdmDevice>().ToList(),
            CanboardDevices = list.Where(d => d.GetType() == typeof(CanboardDevice)).Cast<CanboardDevice>().ToList(),
            DbcDevices = list.Where(d => d.GetType() == typeof(DbcDevice)).Cast<DbcDevice>().ToList(),
            BlinkMarineKeypads = list.OfType<BlinkMarineKeypadDevice>().ToList(),
            GrayhillKeypads = list.OfType<GrayhillKeypadDevice>().ToList()
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

        var allDevices = new List<IDevice>();
        allDevices.AddRange(config.PdmDevices);
        allDevices.AddRange(config.CanboardDevices);
        allDevices.AddRange(config.DbcDevices);
        allDevices.AddRange(config.BlinkMarineKeypads);
        allDevices.AddRange(config.GrayhillKeypads);
        return allDevices;
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