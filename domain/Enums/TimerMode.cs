namespace domain.Enums;

// Mirrors the firmware TimerMode (core/enums.h).
public enum TimerMode
{
    OnDelay,    // TON: output on after the input has been active for the preset
    OffDelay,   // TOF: output follows the input on, stays on for the preset after it drops
    Pulse       // TP : one output pulse of the preset length per activation
}
