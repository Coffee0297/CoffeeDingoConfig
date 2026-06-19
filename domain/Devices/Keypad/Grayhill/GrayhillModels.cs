namespace domain.Devices.Keypad.Grayhill;

public static class GrayhillModels
{
    public static int Lookup(string model)
    {
        if (string.IsNullOrEmpty(model))
            throw new ArgumentException("Grayhill keypad requires a model specification (e.g., 'grayhillkeypad-3kx08')");
        
        //3Kxyy
        //x = button symbol (doesn't matter)
        //y = num buttons
        return model switch
        {
            "3kx06" => 6,
            "3kx08" => 8,
            "3kx12" => 12,
            "3kx15" => 15,
            "3kx20" => 20,
            _ => 0
        };
    }
}