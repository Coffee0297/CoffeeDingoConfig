using System.Security.AccessControl;
using domain.Models;

namespace application.Models;

public class CanLogEntry
{
    public DateTime Timestamp { get; set; }
    public DataDirection Direction  { get; set; }
    public int Count { get; set; }
    public int Id  { get; set; }
    public int Len { get; set; }
    public byte[]? Payload { get; set; }
};