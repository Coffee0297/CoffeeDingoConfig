namespace domain.Models;

public record CanFrame
(
    int Id,
    int Len,
    byte[] Payload,
    bool IsExtended = false   // true = 29-bit extended frame, false = 11-bit standard
);