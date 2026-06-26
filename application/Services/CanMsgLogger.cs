using application.Models;
using domain.Models;
using System.Collections.Concurrent;

namespace application.Services;

public class CanMsgLogger(int maxHistorySize = 100000, string logDirectory = "./logs")
    : IDisposable
{
    public bool LogToFile { get; set; }
    public NumberFormat IdFormat { get; set; }
    public NumberFormat PayloadFormat { get; set; }

    // Use ConcurrentDictionary for O(1) lookups and thread safety
    private readonly ConcurrentDictionary<int, CanLogEntry> _messageSum = new();

    // Keep full history in a separate list
    private readonly List<CanLogEntry> _fullHistory = new();
    private readonly Lock _historyLock = new();

    private StreamWriter? _logWriter;

    // ---- SavvyCAN-style recording: capture EVERY frame time-ordered to a CSV (replayable by the
    // Sim adapter, and openable in SavvyCAN). Separate from the summary/history above.
    private StreamWriter? _recWriter;
    private readonly Lock _recLock = new();
    public bool IsRecording { get; private set; }
    public long RecordedFrames { get; private set; }
    public DateTime RecordingStarted { get; private set; }
    public string? RecordingPath { get; private set; }

    public string StartRecording(string dir)
    {
        StopRecording();
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"canlog_{DateTime.Now:yyyyMMdd_HHmmss}.csv");
        lock (_recLock)
        {
            // FileShare.Read so the download can read the flushed portion even mid-record.
            var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
            _recWriter = new StreamWriter(fs) { AutoFlush = false };
            _recWriter.WriteLine("Timestamp,Direction,CAN ID,Length,Data");
            RecordingPath = path; RecordedFrames = 0; RecordingStarted = DateTime.UtcNow; IsRecording = true;
        }
        return path;
    }

    public void StopRecording()
    {
        lock (_recLock)
        {
            if (_recWriter != null) { try { _recWriter.Flush(); _recWriter.Dispose(); } catch { /* best-effort */ } _recWriter = null; }
            IsRecording = false;
        }
    }

    public void FlushRecording() { lock (_recLock) { try { _recWriter?.Flush(); } catch { } } }

    /// <summary>
    /// Get the message summary for each unique CAN ID (for UI grid display)
    /// </summary>
    public List<CanLogEntry> GetMessageSum() => _messageSum.Values.ToList();

    /// <summary>
    /// Get full message history (for detailed log view)
    /// </summary>
    public List<CanLogEntry> GetFullHistory()
    {
        lock (_historyLock)
        {
            return [.._fullHistory];
        }
    }

    /// <summary>
    /// Get the most recent N messages from history
    /// </summary>
    public List<CanLogEntry> GetRecentHistory(int count)
    {
        lock (_historyLock)
        {
            return _fullHistory.TakeLast(count).ToList();
        }
    }

    public void Log(DataDirection dir, CanFrame msg)
    {
        var entry = new CanLogEntry
        {
            Id = msg.Id,
            IsExtended = msg.IsExtended,
            Payload = msg.Payload,
            Len = msg.Len,
            Direction = dir,
            Timestamp = DateTime.UtcNow,
            Count = 1
        };

        // Summary is per (id, frame-kind): a standard 0x100 and an extended 0x100 are distinct frames
        // on the bus and must not collapse into one row. Extended ids are ≤ 0x1FFFFFFF, so the high
        // bit is free to use as the std/ext discriminator in the dictionary key.
        var sumKey = msg.IsExtended ? (int)(msg.Id | unchecked((int)0x80000000)) : msg.Id;
        _messageSum.AddOrUpdate(
            sumKey,
            entry, // Add new
            (_, existing) => // Update existing
            {
                existing.Payload = msg.Payload;
                existing.Len = msg.Len;
                existing.IsExtended = msg.IsExtended;
                existing.Timestamp = DateTime.UtcNow;
                existing.Direction = dir;
                existing.Count++;
                return existing;
            });

        // Add to full history if tracking all messages
        lock (_historyLock)
        {
            _fullHistory.Add(entry);

            // Remove oldest if over limit
            if (_fullHistory.Count > maxHistorySize)
            {
                _fullHistory.RemoveAt(0);
            }
        }

        // Write to file if enabled
        if (LogToFile)
        {
            WriteToFile(entry);
        }

        // Append to the active recording (time-ordered, every frame).
        if (IsRecording)
        {
            lock (_recLock)
            {
                if (_recWriter != null)
                {
                    var data = entry.Payload == null ? "" : string.Join(" ", entry.Payload.Take(entry.Len).Select(b => b.ToString("X2")));
                    _recWriter.WriteLine($"{entry.Timestamp:yyyy-MM-dd HH:mm:ss.fff},{dir},0x{entry.Id:X},{entry.Len},{data}");
                    if ((++RecordedFrames % 500) == 0) _recWriter.Flush();   // bound data loss without flushing every frame
                }
            }
        }
    }

    public void CreateLogFile()
    {
        if (!LogToFile) return;

        Directory.CreateDirectory(logDirectory);
        var fileName = $"canlog_{DateTime.Now:yyyyMMdd_HHmmss}.csv";
        var filePath = Path.Combine(logDirectory, fileName);

        _logWriter = new StreamWriter(filePath, append: false);
        _logWriter.WriteLine("Timestamp,Direction,CAN ID,Length,Data");
    }

    private void WriteToFile(CanLogEntry entry)
    {
        if (_logWriter == null || entry.Payload == null) return;

        //Always write ID and payload as hex to make parsing easier later
        var idStr = $"0x{entry.Id:X}";

        var dataStr = BitConverter.ToString(entry.Payload).Replace("-", " ");

        _logWriter.WriteLine(
            $"{entry.Timestamp:yyyy-MM-dd HH:mm:ss.fff}," +
            $"{entry.Direction}," +
            $"{idStr}," +
            $"{entry.Len}," +
            $"{dataStr}"
        );

        _logWriter.Flush(); // Ensure data is written immediately
    }

    /// <summary>
    /// Clear all logged messages (both summary and history)
    /// </summary>
    public void Clear()
    {
        _messageSum.Clear();

        lock (_historyLock)
        {
            _fullHistory.Clear();
        }
    }

    public void Dispose()
    {
        _logWriter?.Dispose();
        StopRecording();
    }
}
