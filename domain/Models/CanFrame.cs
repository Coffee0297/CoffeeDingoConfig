namespace domain.Models;

public record CanFrame
(
    int Id,
    int Len,
    byte[] Payload
);