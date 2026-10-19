using domain.Devices.Canboard;
using domain.Devices.dingoPdm;
using domain.Enums.dingoPdm;
using domain.Interfaces;

namespace domain.Common;

/// <summary>
/// Why upstream dingoFW (feat/output-bench-test, MsgCmd 48) refuses a bench test, as far as the app can see it:
/// SetTest refuses paired outputs, a tripped output, a module not in Run, a PWM frequency outside 16-400 Hz, and PWM
/// on a CANBoard. The app checks these first so the operator gets the reason, not just "refused".
/// </summary>
public static class OutputTestRules
{
    public const int MinPwmHz = 16, MaxPwmHz = 400;

    /// <summary>Reasons the module would refuse starting a test (mode 1 on, 2 PWM) on output n (1-based). Empty = none known.</summary>
    public static List<string> Refusals(IDevice dev, int n, int mode, int freq)
    {
        var why = new List<string>();
        if (mode == 0) return why;   // a release is always accepted
        switch (dev)
        {
            case PdmDevice p when p.Outputs.FirstOrDefault(o => o.Number == n) is { } o:
                if (o.PrimaryOutput >= 0 || p.Outputs.Any(x => x.PrimaryOutput == n - 1))
                    why.Add($"output {n} is paired with another output: one half of a pair would carry the whole load, so paired outputs are not tested");
                if (o.State is OutState.Overcurrent or OutState.Fault)
                    why.Add($"output {n} is tripped ({o.State}): clear the trip first");
                if (p.DeviceState != DeviceState.Run)
                    why.Add($"{p.Name} is not running normally (state {p.DeviceState})");
                if (mode == 2 && (freq < MinPwmHz || freq > MaxPwmHz))
                    why.Add($"the PWM frequency must be {MinPwmHz} to {MaxPwmHz} Hz");
                break;
            case CanboardDevice when mode == 2:
                why.Add("a CANBoard output can only be tested on (it has no PWM)");
                break;
        }
        return why;
    }
}
