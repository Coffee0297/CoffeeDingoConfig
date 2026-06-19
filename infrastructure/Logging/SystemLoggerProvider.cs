using application.Services;
using Microsoft.Extensions.Logging;
using LogLevel = application.Models.LogLevel;

namespace infrastructure.Logging;

public class SystemLoggerProvider(SystemLogger systemLogger) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName)
    {
        return new SystemLoggerAdapter(categoryName, systemLogger);
    }

    public void Dispose()
    {
        // Nothing to dispose
    }
}

internal class SystemLoggerAdapter(string categoryName, SystemLogger systemLogger) : ILogger
{
    public void Log<TState>(
        Microsoft.Extensions.Logging.LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel))
            return;

        // Map Microsoft.Extensions.Logging.LogLevel to application.Models.LogLevel
        var mappedLevel = MapLogLevel(logLevel);

        // Extract source from category (e.g., "application.Services.DeviceManager" → "DeviceManager")
        var source = ExtractSourceFromCategory(categoryName);

        var message = formatter(state, exception);
        var exceptionStr = exception?.ToString();

        systemLogger.Log(mappedLevel, source, message, exceptionStr, categoryName);
    }

    public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel)
    {
        return logLevel != Microsoft.Extensions.Logging.LogLevel.None;
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull
    {
        return null;
    }

    private static LogLevel MapLogLevel(Microsoft.Extensions.Logging.LogLevel logLevel)
    {
        return logLevel switch
        {
            Microsoft.Extensions.Logging.LogLevel.Trace => LogLevel.Debug,
            Microsoft.Extensions.Logging.LogLevel.Debug => LogLevel.Debug,
            Microsoft.Extensions.Logging.LogLevel.Information => LogLevel.Info,
            Microsoft.Extensions.Logging.LogLevel.Warning => LogLevel.Warning,
            Microsoft.Extensions.Logging.LogLevel.Error => LogLevel.Error,
            Microsoft.Extensions.Logging.LogLevel.Critical => LogLevel.Error,
            _ => LogLevel.Info
        };
    }

    private static string ExtractSourceFromCategory(string categoryName)
    {
        // Extract the last segment from the category name
        // e.g., "application.Services.DeviceManager" → "DeviceManager"
        var segments = categoryName.Split('.');
        return segments.Length > 0 ? segments[^1] : categoryName;
    }
}
