namespace domain.Models;

public class DeviceVariable
{
    public Func<string> GetName { get; init; } = null!;
    public string PropertyName { get; set; } = string.Empty;
    public int VariableIndex { get; set; }
    public bool SingleVariable { get; set; }
    public string DataType { get; set; } = string.Empty;
    // Which function slot publishes this variable — the lowercase editor kind ("caninput", "timer",
    // "output", "wiper", "keypad", "lua", "sys") and its 1-based number — so a client can resolve a
    // var-map index to its owner directly instead of reconstructing names (which collide).
    public string OwnerKind { get; set; } = string.Empty;
    public int OwnerNumber { get; set; }
}