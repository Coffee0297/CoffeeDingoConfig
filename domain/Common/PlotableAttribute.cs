namespace domain.Common;

[AttributeUsage(AttributeTargets.Property)]
public class PlotableAttribute(string unit = "", string displayName = "") : Attribute
{
    public string Unit { get; set; } = unit;
    public string DisplayName { get; set; } = displayName;
}