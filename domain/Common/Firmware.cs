namespace domain.Common;

/// <summary>Firmware version checks for params and var-map entries that newer firmware added.</summary>
public static class Firmware
{
    /// <summary>"v5.6.0" -> 5.6.0; anything unreadable (no answer yet: "v0.0.0") -> 0.0.0.</summary>
    public static Version Of(string? v) =>
        Version.TryParse((v ?? "").TrimStart('v', 'V'), out var x) ? x : new Version(0, 0, 0);

    /// <summary>Does a module reporting <paramref name="deviceVersion"/> have something added in <paramref name="since"/>?</summary>
    public static bool Has(string? deviceVersion, Version? since) => since is null || Of(deviceVersion) >= since;
}
