namespace domain.Devices.Keypad.BlinkMarine;

public static class BlinkMarineModels
{
    public static (int numButtons, int numDials, int numAnalogInputs) Lookup(string model)
    {
        if (string.IsNullOrEmpty(model))
            throw new ArgumentException("BlinkMarine keypad requires a model specification (e.g., 'blinkkeypad-pkp2200')");
        
        return model switch
        {
            "pkp1600" => (6,0,0),
            "pkp2200" => (4, 0, 0),
            "pkp2300" => (6, 0, 0),
            "pkp2400" => (8, 0, 0),
            "pkp2500" => (10, 0, 0),
            "pkp2600" => (12, 0, 0),
            "pkp3500" => (15, 0, 0),
            "pkp1100" => (1, 0, 0),
            "pkp1200" => (2, 0, 0),
            "pkp1500" => (5, 0, 0),
            "pkp3500mt" => (15, 2, 4),
            _ => (0, 0, 0)
        };
    }
    
    
}