namespace domain.Enums.Canboard;

// Mirrors the firmware's shared `enum class MsgSrc` (CoffeeDingoFW core/enums.h) — one list for
// every board, so the CANBoard uses the same numbering as the PDM (CANBus=7, Config=10, Analog=12,
// Init=16). Only labels info/warn/error log lines, but a wrong label points the user the wrong way.
public enum MessageSrc
{
    StateRun = 1,
    StateSleep,
    StateOvertemp,
    StateError,
    Overcurrent,
    Voltage,
    CANBus,
    USB,
    Overtemp,
    Config,
    FRAM,
    Analog,
    I2C,
    TempSensor,
    USBConnection,
    Init,
    OutputWarning,   // output current above warn limit (below trip)
    OpenLoad         // output on but current below open-load floor (broken bulb / no load)
}