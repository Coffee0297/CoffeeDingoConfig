namespace domain.Devices.Keypad.BlinkMarine.Enums;

public enum MessageId
{
    Nmt = 0x00,
    ButtonState = 0x180,
    SetLed = 0x200,
    DialState1 = 0x280,
    SetLedBlink = 0x300,
    DialState2 = 0x380,
    LedBrightness = 0x400,
    AnalogInput = 0x480,
    Backlight = 0x500,
    SdoResponse = 0x580,
    SdoRequest = 0x600,
    Heartbeat = 0x700
}