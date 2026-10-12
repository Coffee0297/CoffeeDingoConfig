namespace domain.Devices;

/// <summary>
/// While a read / write / burn exchange runs, DeviceManager narrows the adapter's receive filter to that
/// module's id block, so every other module goes quiet on our side — not on the bus. A device's "connected"
/// heartbeat (no frame for 3 s = gone) must not read that silence as the module dropping off: it used to,
/// and then writes to it (a template's second module, a deploy's next module) were saved to the project only.
/// Devices ask <see cref="Excuses"/>: true while the filter hides them, and for <see cref="GraceMs"/> after
/// it lifts so their frames have time to arrive again.
/// </summary>
public static class RxFilterWindow
{
    public const int GraceMs = 3000;
    private static readonly object Gate = new();
    private static int _lo = -1, _hi = -1;            // the id block let through; -1 = no filter
    private static DateTime _liftedAt = DateTime.MinValue;
    private static int _lastLo = -1, _lastHi = -1;    // the block of the filter that lifted at _liftedAt

    public static void Narrow(int lo, int hi) { lock (Gate) { _lo = lo; _hi = hi; } }

    public static void Lift()
    {
        lock (Gate)
        {
            if (_lo < 0) return;
            (_lastLo, _lastHi, _liftedAt) = (_lo, _hi, DateTime.Now);
            _lo = _hi = -1;
        }
    }

    /// <summary>A device at <paramref name="baseId"/> that was connected: is its silence the filter's doing?</summary>
    public static bool Excuses(int baseId, bool wasConnected, DateTime? now = null)
    {
        if (!wasConnected) return false;
        var t = now ?? DateTime.Now;
        lock (Gate)
        {
            if (_lo >= 0) return baseId < _lo || baseId > _hi;
            return (t - _liftedAt).TotalMilliseconds < GraceMs && (baseId < _lastLo || baseId > _lastHi);
        }
    }
}
