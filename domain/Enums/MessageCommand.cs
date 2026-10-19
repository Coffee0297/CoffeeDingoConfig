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
    WriteAllMissing = 24,       // upstream: one per param a failed full WriteAll did not get
    WriteAllParamNotFound = 25,
    WriteAllOutOfRange = 26,
    WriteAllMissingDone = 27,   // upstream: ends the WriteAllMissing list; [27, countLo, countHi] (0xFFFF = too many)

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

    // Output bench test (firmware ≥ 5.5.107): [cmd, out (0-based), mode 0 off / 1 on / 2 pwm, duty %, freqLo, freqHi, holdSec, 0]
    // -> reply echoes bytes 0-6, [7] = accepted. The module releases on its own after holdSec.
    OutputTest = 48,

    // Firmware 5.6
    Identify = 49,          // [cmd, seconds] -> [cmd, seconds, hasLed]: blink the LEDs to find the module
    SleepInfo = 50,         // [cmd] -> [cmd, wakeReason, wakeSource, wakesLo, wakesHi, countdown s (0xFF none), blockers, 0]
    OvlTime = 51,           // [cmd, idx] -> [cmd, idx, t0..t3] trip time, ms since power-on
    OvlNotice = 52,         // [cmd, idx] -> [cmd, idx, out (0-based), kind 1 warning / 2 open load, t0..t3]

    // Upstream dingoFW feature branches
    FaultLogRead = 53,      // [cmd, n] -> two frames: [cmd, n, count, out|kind<<4, boot u16, A×10 u16], [cmd, n|0x80, uptime ms u32, V×100 u16]
    FaultLogClear = 54,     // [cmd] -> [cmd, 1]
    ResetCause = 55,        // [cmd] -> [cmd, RCC CSR >> 24 flags, 0...] why the module last reset (feat/reset-cause)
}