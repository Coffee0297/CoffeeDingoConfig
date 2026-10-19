using System.Diagnostics;
using application.Models;
using application.Services;
using domain.Enums;
using domain.Models;
using infrastructure.Adapters;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace tests;

// A recording made by the CAN recorder plays back through the Sim adapter as the same frames, with the recorded spacing.
public class CanLogTimeFormatTests
{
    [Fact]
    public async Task RecordedLogPlaysBackTheSameFramesWithTheirTiming()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dingo_rec_test_" + Guid.NewGuid().ToString("N"));
        var culture = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            // da-DK writes '.' between time parts unless the recorder is culture-invariant
            System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo("da-DK");
            var log = new CanMsgLogger(100, dir);
            var path = log.StartRecording(dir);
            log.Log(DataDirection.Rx, new CanFrame(0x682, 8, [1, 2, 3, 4, 5, 6, 7, 8]));
            Thread.Sleep(150);
            log.Log(DataDirection.Rx, new CanFrame(0x1F0A003, 3, [0xAA, 0xBB, 0xCC], IsExtended: true));
            log.Log(DataDirection.Tx, new CanFrame(0x681, 2, [0x01, 0x00]));
            log.StopRecording();
            Assert.Equal(3, log.RecordedFrames);
            Assert.Matches(@"(?m)^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3},Rx,0x682,", File.ReadAllText(path));

            var pb = new SimPlayback(NullLogger<SimPlayback>.Instance);
            var (ok, err) = await pb.LoadFile(path);
            Assert.True(ok, err);
            Assert.Equal(3, pb.TotalMessages);
            Assert.False(pb.SyntheticTiming, File.ReadAllText(path));

            var sim = new SimAdapter(pb);
            await sim.InitAsync("", CanBitRate.BitRate500K, CancellationToken.None);
            await sim.StartAsync(CancellationToken.None);
            var got = new List<(CanFrame Frame, long Ms)>();
            var done = new TaskCompletionSource();
            var sw = Stopwatch.StartNew();
            sim.DataReceived += (_, e) => { lock (got) { got.Add((e.Frame, sw.ElapsedMilliseconds)); if (got.Count == 3) done.TrySetResult(); } };
            await pb.Play();
            await done.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await sim.StopAsync();

            Assert.Equal(0x682, got[0].Frame.Id);
            Assert.Equal(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }, got[0].Frame.Payload);
            Assert.Equal(0x1F0A003, got[1].Frame.Id);
            Assert.Equal(3, got[1].Frame.Len);
            Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC }, got[1].Frame.Payload);
            Assert.Equal(0x681, got[2].Frame.Id);
            Assert.True(got[1].Ms - got[0].Ms >= 120, $"second frame came {got[1].Ms - got[0].Ms} ms after the first; recorded ~150 ms");
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = culture;
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    // Recordings made before the recorder wrote culture-invariant times ("10.11.08.362") keep their timing.
    [Fact]
    public async Task OlderDotSeparatedTimestampsStillPlayAtRecordedSpeed()
    {
        var path = Path.Combine(Path.GetTempPath(), $"dingo_rec_old_{Guid.NewGuid():N}.csv");
        try
        {
            File.WriteAllText(path, "Timestamp,Direction,CAN ID,Length,Data\n2026-10-19 10.11.08.362,Rx,0x682,1,01\n2026-10-19 10.11.08.519,Rx,0x683,1,02\n");
            var pb = new SimPlayback(NullLogger<SimPlayback>.Instance);
            var (ok, err) = await pb.LoadFile(path);
            Assert.True(ok, err);
            Assert.Equal(2, pb.TotalMessages);
            Assert.False(pb.SyntheticTiming);
        }
        finally { File.Delete(path); }
    }
}
