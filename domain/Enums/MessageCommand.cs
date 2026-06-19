namespace domain.Enums;

public enum MessageCommand
{
    Null = 0,
    Read = 1,
    Write = 2,
    ReadParamNotFound = 5,

    ReadAll = 10,
    ReadAllRsp = 11,
    ReadAllComplete = 12,
    ReadAllModified = 13,

    WriteAll = 20,
    WriteAllVal = 21,
    WriteAllComplete = 22,
    WriteAllModified = 23,
    WriteAllParamNotFound = 25,
    WriteAllOutOfRange = 26,
    
    BurnParams = 30,
    Version = 31,
    Sleep = 32,
    Bootloader = 33,
    CheckCrc = 34,
    CheckCrcRsp = 35,

    // Lua program upload (chunked) — matches the firmware's request_msg handler.
    LuaWrite = 40,          // [cmd, offHi, offLo, b0..b4]
    LuaWriteComplete = 41,  // [cmd, lenHi, lenLo]
    LuaRead = 42,           // [cmd, offHi, offLo]
    LuaErr = 43,            // [cmd, offHi, offLo] -> last runtime error bytes

    // On-device overload (trip) log read-back.
    OvlCount = 44,          // [cmd] -> [cmd, count]
    OvlHeader = 45,         // [cmd, idx] -> [cmd, idx, outNum(0xFF=invalid), state, peakLo, peakHi, limitLo, limitHi] (0.1A)
    OvlData = 46,           // [cmd, idx, offHi, offLo] -> [cmd, idx, offHi, offLo, b0..b3] (samples @ 0.5A)
    OvlClear = 47,          // [cmd] -> clear
}