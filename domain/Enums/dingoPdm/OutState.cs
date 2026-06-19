namespace domain.Enums.dingoPdm;

public enum OutState
{
    Off,
    On,
    Overcurrent,
    Fault,
    Warning,    // on, current above warn limit (below trip) — report only
    OpenLoad    // on but current below open-load floor (broken bulb / no load) — report only
}