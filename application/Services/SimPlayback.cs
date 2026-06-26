using System.Globalization;
using application.Models;
using domain.Models;
using Microsoft.Extensions.Logging;

namespace application.Services;

public enum PlaybackState { Idle, Playing, Paused, Stopped }

public class SimPlayback(ILogger<SimPlayback> logger)
{
    private List<PlaybackMessage> _messages = [];
    private CancellationTokenSource? _playCts;
    private readonly Lock _stateLock = new();

    public PlaybackState State { get; private set; } = PlaybackState.Idle;

    public int CurrentMessageIndex { get; private set; }

    public int TotalMessages => _messages.Count;
    public TimeSpan CurrentTime { get; private set; }
    public bool Loop { get; set; }

    public string? CurrentFileName { get; private set; }

    // True when the loaded log had no usable timestamps and frames are spaced at a chosen rate instead.
    public bool SyntheticTiming { get; private set; }
    public int Fps { get; private set; } = 1000;
    private static TimeSpan FpsGap(int fps) => TimeSpan.FromTicks((long)(TimeSpan.TicksPerSecond / (double)Math.Clamp(fps, 1, 1_000_000)));

    /// <summary>Set the replay rate (msg/s) for a no-timestamp log; re-spaces frames live, even while playing.</summary>
    public Task SetRate(int fps)
    {
        lock (_stateLock)
        {
            Fps = Math.Clamp(fps, 1, 1_000_000);
            if (!SyntheticTiming || _messages.Count == 0) return Task.CompletedTask;
            var gap = FpsGap(Fps);
            for (int k = 0; k < _messages.Count; k++) _messages[k].RelativeTime = gap * k;
            if (State == PlaybackState.Playing)
            {
                _playCts?.Cancel();
                _playCts = new CancellationTokenSource();
                _ = PlaybackLoop(_playCts.Token);   // re-anchor timing at the new rate from the current index
            }
        }
        return Task.CompletedTask;
    }

    public event Action<CanFrame, DataDirection>? MessageReady;

    public async Task<(bool success, string? error)> LoadFile(string filePath)
    {
        try
        {
            if (!File.Exists(filePath))
            {
                return (false, "File not found");
            }

            var messages = new List<PlaybackMessage>();
            // Stream the file line-by-line (never the whole file in memory at once) so an extreme log
            // doesn't blow up — only the parsed message list is held.
            using var reader = new StreamReader(filePath);
            var headerLine = await reader.ReadLineAsync();
            if (headerLine == null) return (false, "File is empty");

            // Auto-detect the column layout from the header so common loggers (SavvyCAN, the app's own
            // export, …) all work. Look up columns by name; fall back to the app's positional format.
            var cols = headerLine.Split(',').Select(c => c.Trim().ToLowerInvariant()).ToArray();
            int Idx(params string[] names) { foreach (var n in names) { var i = Array.IndexOf(cols, n); if (i >= 0) return i; } return -1; }
            int ciTs = Idx("time stamp", "timestamp", "time"), ciId = Idx("id", "can id", "arbitration id"),
                ciDir = Idx("dir", "direction"), ciLen = Idx("len", "length", "dlc"),
                ciData = Idx("data", "data bytes"), ciD1 = Idx("d1", "data0", "byte0", "b0");
            bool perByte = ciD1 >= 0;
            bool headerLayout = ciId >= 0;   // recognised headers → use them; else legacy positional
            // Numeric timestamps: a value with a '.' is seconds; a bare integer is microseconds (SavvyCAN).
            bool? tsIsSeconds = null;

            DateTime? firstDt = null; double? firstNum = null;
            string? line; long lineNo = 1; int bad = 0;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                lineNo++;
                if (string.IsNullOrWhiteSpace(line)) continue;
                var p = line.Split(',');
                try
                {
                    int canId; byte length; byte[] dataBytes; DataDirection direction;
                    DateTime dt = default; double num = 0; bool isDateTime = false;

                    if (!headerLayout)
                    {
                        // Legacy/app format: timestamp(datetime), Dir, ID(hex), Len, Data(space-separated hex)
                        if (p.Length < 5) continue;
                        dt = DateTime.ParseExact(p[0].Trim(), "yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture); isDateTime = true;
                        direction = p[1].Trim().Equals("Tx", StringComparison.OrdinalIgnoreCase) ? DataDirection.Tx : DataDirection.Rx;
                        canId = Convert.ToInt32(p[2].Trim(), 16);
                        length = byte.Parse(p[3].Trim());
                        dataBytes = p[4].Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(b => Convert.ToByte(b, 16)).ToArray();
                    }
                    else
                    {
                        canId = Convert.ToInt32(p[ciId].Trim(), 16);
                        length = ciLen >= 0 && byte.TryParse(p[ciLen].Trim(), out var l) ? l : (byte)8;
                        if (length > 8) length = 8;
                        direction = ciDir >= 0 && p[ciDir].Trim().Equals("Tx", StringComparison.OrdinalIgnoreCase) ? DataDirection.Tx : DataDirection.Rx;
                        if (perByte)
                        {
                            var bl = new List<byte>(length);
                            for (int k = 0; k < length && ciD1 + k < p.Length; k++)
                            {
                                var s = p[ciD1 + k].Trim();
                                if (s.Length == 0) break;
                                bl.Add(Convert.ToByte(s, 16));
                            }
                            dataBytes = bl.ToArray();
                        }
                        else if (ciData >= 0)
                            dataBytes = p[ciData].Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(b => Convert.ToByte(b, 16)).ToArray();
                        else dataBytes = Array.Empty<byte>();

                        if (ciTs >= 0 && ciTs < p.Length)
                        {
                            var ts = p[ciTs].Trim();
                            if (DateTime.TryParseExact(ts, "yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out dt))
                                isDateTime = true;
                            else if (double.TryParse(ts, System.Globalization.NumberStyles.Float, CultureInfo.InvariantCulture, out num))
                                tsIsSeconds ??= ts.Contains('.');
                        }
                    }

                    if (dataBytes.Length < length) { var pad = new byte[length]; Array.Copy(dataBytes, pad, dataBytes.Length); dataBytes = pad; }
                    var frame = new CanFrame(canId, length, dataBytes.Take(length).ToArray());

                    TimeSpan rel;
                    if (isDateTime) { firstDt ??= dt; rel = dt - firstDt.Value; }
                    else
                    {
                        firstNum ??= num;
                        var delta = num - firstNum.Value;
                        rel = (tsIsSeconds ?? false) ? TimeSpan.FromSeconds(delta) : TimeSpan.FromMicroseconds(delta);
                    }

                    messages.Add(new PlaybackMessage { Frame = frame, RelativeTime = rel, Direction = direction });
                }
                catch
                {
                    // Skip a malformed line rather than aborting the whole import on one glitch; bail only
                    // if nothing parses at all early on (wrong format), so we don't spin through a huge file.
                    if (++bad > 100 && messages.Count == 0)
                        return (false, $"Could not parse this CSV — check the column layout (failed by line {lineNo}).");
                }
            }

            if (messages.Count == 0)
            {
                return (false, "No valid CAN messages found in file");
            }

            // Some logs have no usable timestamps (all zero / identical) — playback would fire the whole
            // file at once. Flag it so the UI offers a msg/s rate, and space frames at the chosen Fps.
            SyntheticTiming = messages.Count > 1 && messages[^1].RelativeTime <= TimeSpan.FromMilliseconds(1);
            if (SyntheticTiming)
            {
                var gap = FpsGap(Fps);
                for (int k = 0; k < messages.Count; k++) messages[k].RelativeTime = gap * k;
                logger.LogInformation("Log has no usable timestamps — replaying at {Fps} msg/s", Fps);
            }

            lock (_stateLock)
            {
                _messages = messages;
                CurrentMessageIndex = 0;
                State = PlaybackState.Idle;
                CurrentTime = TimeSpan.Zero;
                CurrentFileName = Path.GetFileName(filePath);
            }

            logger.LogInformation("Loaded {Count} CAN messages from {FileName}", messages.Count, CurrentFileName);
            return (true, null);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to load CAN log file: {FilePath}", filePath);
            return (false, ex.Message);
        }
    }

    public Task Play()
    {
        lock (_stateLock)
        {
            if (State == PlaybackState.Playing || _messages.Count == 0)
                return Task.CompletedTask;

            // If stopped or at end, reset to beginning
            if (State == PlaybackState.Stopped || CurrentMessageIndex >= _messages.Count)
            {
                CurrentMessageIndex = 0;
                CurrentTime = TimeSpan.Zero;
            }

            State = PlaybackState.Playing;
            _playCts?.Cancel();
            _playCts = new CancellationTokenSource();
        }

        logger.LogInformation("Starting playback from index {Index}", CurrentMessageIndex);
        _ = PlaybackLoop(_playCts.Token);
        return Task.CompletedTask;
    }

    public Task Pause()
    {
        lock (_stateLock)
        {
            if (State != PlaybackState.Playing)
                return Task.CompletedTask;

            _playCts?.Cancel();
            State = PlaybackState.Paused;
        }

        logger.LogInformation("Playback paused at index {Index}", CurrentMessageIndex);
        return Task.CompletedTask;
    }

    public Task Reset()
    {
        lock (_stateLock)
        {
            _playCts?.Cancel();
            CurrentMessageIndex = 0;
            CurrentTime = TimeSpan.Zero;
            State = PlaybackState.Idle;
        }

        logger.LogInformation("Playback reset");
        return Task.CompletedTask;
    }

    private async Task PlaybackLoop(CancellationToken ct)
    {
        var startTime = DateTime.UtcNow;
        var startIndex = CurrentMessageIndex;

        // Adjust start time to account for current position
        if (startIndex > 0 && startIndex < _messages.Count)
        {
            startTime -= _messages[startIndex].RelativeTime;
        }

        try
        {
            while (CurrentMessageIndex < _messages.Count && !ct.IsCancellationRequested)
            {
                var msg = _messages[CurrentMessageIndex];
                var elapsedTime = DateTime.UtcNow - startTime;
                var delay = msg.RelativeTime - elapsedTime;

                if (delay > TimeSpan.Zero)
                {
                    await Task.Delay(delay, ct);
                }

                MessageReady?.Invoke(msg.Frame, msg.Direction);
                CurrentTime = msg.RelativeTime;
                CurrentMessageIndex++;
            }

            // Handle completion
            lock (_stateLock)
            {
                if (ct.IsCancellationRequested)
                    return;

                if (Loop && _messages.Count > 0)
                {
                    CurrentMessageIndex = 0;
                    CurrentTime = TimeSpan.Zero;
                    logger.LogInformation("Looping playback");
                    _ = PlaybackLoop(ct);
                }
                else
                {
                    State = PlaybackState.Stopped;
                    logger.LogInformation("Playback completed");
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected when paused or reset
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during playback");
            lock (_stateLock)
            {
                State = PlaybackState.Stopped;
            }
        }
    }

    public Task Clear()
    {
        lock (_stateLock)
        {
            _playCts?.Cancel();
            CurrentMessageIndex = 0;
            CurrentTime = TimeSpan.Zero;
            State = PlaybackState.Idle;
            
            _messages.Clear();
        }
        
        logger.LogInformation("Playback cleared");

        return Task.CompletedTask;
    }

    private class PlaybackMessage
    {
        public required CanFrame Frame { get; init; }
        public required TimeSpan RelativeTime { get; set; }   // set: rewritten when a log has no usable timing
        public required DataDirection Direction { get; init; }
    }
}
