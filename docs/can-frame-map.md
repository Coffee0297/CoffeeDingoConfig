# dingoPDM / CANBoard — CAN broadcast frame map

What each module **transmits** on the bus (rotary switches, inputs, output state, currents, …),
written **address-agnostically**: every frame is `base ID + offset`, so it holds whatever base ID
a module is set to.

Source of truth: firmware `boards/*/msg.cpp` (the TX builders) + the firmware DBCs
(`CoffeeDingoFW/dbc/*_0.5.1.dbc`, mirrored in this repo's `dbc/`). This doc is the
address-agnostic version of those DBCs. Reflects firmware **≥ v5.5.102** — see [Notes](#notes).

## Addressing model (all devices)

A module owns 3 + N consecutive 11-bit CAN IDs off its `baseId`:

| CAN ID        | Direction       | Purpose                                                     |
|---------------|-----------------|-------------------------------------------------------------|
| `baseId + 0`  | device → tool   | config replies, version, info/warning/error                |
| `baseId + 1`  | tool → device   | config requests / commands (read/write/burn/sleep/…)        |
| `baseId + 2 + N` | device → tool | **cyclic telemetry, message N** — this document            |

So **telemetry message N is at CAN ID `baseId + 2 + N`.** Broadcast period is 100 ms
(`CAN_TX_CYCLIC_MSG_DELAY`). Default base IDs: dingoPDM / -Max = `0x0DE` (222), CANBoard = `0x640` (1600).

**Bit numbering** is DBC "Intel" / little-endian sawtooth: bit *b* lives in byte `b/8`, bit `b%8`
(LSB = 0). Multi-byte fields are little-endian. Below, `bits a–b` means start bit *a*, through *b*
inclusive; a 16-bit field at "bits 16–31" = bytes 2–3.

A frame is sent only when its **send condition** holds (always, or "any of its sources enabled").
A consumer should not assume a frame appears every cycle unless it says *always*.

---

## dingoPDM (and -Max / PT-DPDM)

Variants share one layout; they differ only in channel **counts** (`web/pdm-definitions.json`):

| Variant      | type | Outputs | Dig in | Notes                                            |
|--------------|------|---------|--------|--------------------------------------------------|
| dingoPDM     | 0    | 8       | 2      | base layout                                      |
| dingoPDM-Max | 1    | 4       | 2      | outputs 5–8 absent → those fields read 0         |
| PT-DPDM      | 2    | 4       | 4      | not in this firmware tree; same PDM frame layout |

CAN inputs 32, CAN outputs 32, virtual inputs 16, flashers 4, counters 4, conditions 32, keypads 2.
**27 cyclic messages, offsets +2 … +28.**

### Msg 0 — `base+2` — Status — *always sent*
| Bits  | Field            | Notes                                              |
|-------|------------------|----------------------------------------------------|
| 0     | DigitalInput 1   |                                                    |
| 1     | DigitalInput 2   |                                                    |
| 8–11  | DeviceState      | 0 Run · 1 Sleep · 2 Overtemp · 3 Error             |
| 12–15 | PDMType          | 0 PDM · 1 Max · 2 PT-DPDM                           |
| 16–31 | TotalCurrent     | u16, 0.1 A/bit                                     |
| 32–47 | BatteryVoltage   | u16, 0.1 V/bit                                     |
| 48–63 | BoardTemperature | u16, 0.1 °C/bit                                    |

### Msg 1 — `base+3` — Output current 1–4 — *always sent*
Bytes 0–1/2–3/4–5/6–7 = Output 1/2/3/4 current, u16, 0.1 A/bit.

### Msg 2 — `base+4` — Output current 5–8 — *always sent* (all 0 on 4-output variants)
Bytes 0–1/2–3/4–5/6–7 = Output 5/6/7/8 current, u16, 0.1 A/bit.

### Msg 3 — `base+5` — Output states / wiper / flashers — *always sent*
| Bits  | Field                | Notes                                          |
|-------|----------------------|------------------------------------------------|
| 0–3   | OutputState 1        | 0 Off · 1 On · 2 Overcurrent · 3 Fault (4-bit) |
| 4–7   | OutputState 2        | …each output is a 4-bit nibble                 |
| 8–11  | OutputState 3        |                                                |
| 12–15 | OutputState 4        |                                                |
| 16–19 | OutputState 5        |                                                |
| 20–23 | OutputState 6        |                                                |
| 24–27 | OutputState 7        |                                                |
| 28–31 | OutputState 8        |                                                |
| 32    | Wiper slow output    |                                                |
| 33    | Wiper fast output    |                                                |
| 40–43 | WiperSpeed           | 0 Park · 1 Slow · 2 Fast · 3–8 intermittent    |
| 44–47 | WiperState           | 0 Park · 1 Parking · 2 Slow · 3 Fast · 4 Int-Pause · 5 Int-On · 6 Wash · 7 Swipe |
| 48–51 | Flasher 1–4          | bit 48 = F1 … bit 51 = F4                       |

### Msg 4 — `base+6` — Output reset (overcurrent) counts — *always sent*
Bytes 0…7 = Output 1…8 reset count, u8 each.

### Msg 5 — `base+7` — CAN inputs + virtual inputs — *sent if any CAN-input or virtual-input enabled*
| Bits  | Field                | Notes                          |
|-------|----------------------|--------------------------------|
| 0–31  | CANInput 1–32 state  | bit *i* = CANInput *(i+1)*, 1-bit each |
| 32–47 | VirtualInput 1–16    | bit *32+i* = VirtualInput *(i+1)* |

### Msg 6 — `base+8` — Counters + conditions — *sent if any counter/condition enabled*
| Bits  | Field                  | Notes                       |
|-------|------------------------|-----------------------------|
| 0–7   | Counter 1              | u8                          |
| 8–15  | Counter 2              |                             |
| 16–23 | Counter 3              |                             |
| 24–31 | Counter 4              |                             |
| 32–63 | ConditionResult 1–32   | bit *32+i* = Condition *(i+1)* |

### Msg 7–22 — `base+9 … base+24` — CAN input values — *each sent if either of its two inputs enabled*
Message `7+k` carries CAN input values `2k+1` and `2k+2` (k = 0…15), so values **1–32**:
| Bits  | Field                    | Notes                                             |
|-------|--------------------------|---------------------------------------------------|
| 0–31  | CANInputValue (odd)      | bytes 0–3, 32-bit; scaling/byte-order per that input's config |
| 32–63 | CANInputValue (even)     | bytes 4–7, 32-bit; scaling/byte-order per that input's config |

### Msg 23 — `base+25` — Output duty cycle — *sent if any output PWM enabled*
Bytes 0…7 = Output 1…8 duty %, u8 each.

### Msg 24 — `base+26` — Keypad button states — *sent if any keypad enabled*
| Bits  | Field                       | Notes                              |
|-------|-----------------------------|------------------------------------|
| 0–23  | Keypad 1 (index 0) buttons  | bit *i* = button *(i+1)*, up to 24  |
| 24–47 | Keypad 2 (index 1) buttons  | bit *24+i* = button *(i+1)*         |

### Msg 25 — `base+27` — Keypad 1 dials — *sent if keypad 1 (index 0) enabled*
Bytes 0–1/2–3/4–5/6–7 = dial 1/2/3/4, u16 each.

### Msg 26 — `base+28` — Keypad 2 dials — *sent if keypad 2 (index 1) enabled*
Bytes 0–1/2–3/4–5/6–7 = dial 1/2/3/4, u16 each.

---

## CANBoard (type 0)

5 analog inputs (each also usable as rotary switch or on/off switch), 8 digital inputs,
4 low-side digital outputs, 8 CAN inputs, 8 virtual inputs, 4 flashers, 4 counters, 8 conditions.
**9 cyclic messages, offsets +2 … +10.**

### Msg 0 — `base+2` — Analog inputs 1–4 (mV) — *always sent*
Bytes 0–1/2–3/4–5/6–7 = AnalogInput 1/2/3/4 millivolts, u16, **1 mV/bit**.

### Msg 1 — `base+3` — Analog input 5 + board temp — *always sent*
| Bits  | Field            | Notes                              |
|-------|------------------|------------------------------------|
| 0–15  | AnalogInput 5 mV | u16, 1 mV/bit                      |
| 16–47 | (reserved, 0)    |                                    |
| 48–63 | BoardTemp        | u16; tool decodes ×0.01 °C         |

### Msg 2 — `base+4` — Rotary switches / inputs / switches / outputs / heartbeat — *always sent*
**This is the "rotary switch" frame.** Each rotary position is a 4-bit value (0–15):
| Bits  | Field                  | Notes                                          |
|-------|------------------------|------------------------------------------------|
| 0–3   | RotarySwitch 1 pos     | analog input 1 decoded as a rotary switch      |
| 4–7   | RotarySwitch 2 pos     |                                                |
| 8–11  | RotarySwitch 3 pos     |                                                |
| 12–15 | RotarySwitch 4 pos     |                                                |
| 16–19 | RotarySwitch 5 pos     |                                                |
| 24–27 | Flasher 1–4            | bit 24 = F1 … bit 27 = F4                       |
| 32–39 | DigitalInput 1–8       | bit 32 = DI1 … bit 39 = DI8                     |
| 40–44 | AnalogSwitch 1–5       | analog input *n* decoded as on/off; bit 40 = AI1 … bit 44 = AI5 |
| 48–51 | DigitalOutput 1–4      | low-side outputs; bit 48 = DO1 … bit 51 = DO4   |
| 56–63 | Heartbeat              | u8, increments every transmit                  |

### Msg 3 — `base+5` — CAN inputs + virtual inputs — *sent if any CAN-input or virtual-input enabled*
| Bits  | Field               | Notes                                              |
|-------|---------------------|----------------------------------------------------|
| 0–31  | CANInput state      | bit *i* = CANInput *(i+1)*; CANBoard uses 1–8       |
| 32–47 | VirtualInput        | bit *32+i* = VirtualInput *(i+1)*; CANBoard uses 1–8 |

### Msg 4 — `base+6` — Counters + conditions — *sent if any counter/condition enabled*
| Bits  | Field                | Notes                                       |
|-------|----------------------|---------------------------------------------|
| 0–7   | Counter 1            | u8                                          |
| 8–15  | Counter 2            |                                             |
| 16–23 | Counter 3            |                                             |
| 24–31 | Counter 4            |                                             |
| 32–63 | ConditionResult      | bit *32+i* = Condition *(i+1)*; CANBoard uses 1–8 |

### Msg 5–8 — `base+7 … base+10` — CAN input values — *each sent if either of its two inputs enabled*
Message `5+k` carries CAN input values `2k+1` and `2k+2` (k = 0…3), so values **1–8**:
| Bits  | Field                | Notes                                             |
|-------|----------------------|---------------------------------------------------|
| 0–31  | CANInputValue (odd)  | bytes 0–3, 32-bit; scaling/byte-order per that input's config |
| 32–63 | CANInputValue (even) | bytes 4–7, 32-bit; scaling/byte-order per that input's config |

---

## Notes

- **Firmware version.** This map reflects firmware **≥ v5.5.102** and the matching `*_0.5.1.dbc`
  (mirrored in this repo's `dbc/`). Two wire-format fixes landed in 5.5.102 — decode older
  firmware accordingly:
  - The **second CAN-input *value*** in each value-pair frame moved from bit 33 to **bit 32**
    (bytes 4–7). Firmware ≤ 5.5.101 encoded it one bit high (`EncodeLE(... 33, 32)`), so on the
    wire it sat at bits 33–63 with its MSB truncated. The odd value (bit 0) was always fine.
  - **Total/Output current** went to **0.1 A/bit** (was 1 A/bit). The DBCs were always 0.1; the
    fix made the firmware and tool agree. Battery (0.1 V) and temperature (0.1 °C) were always 0.1.
- **CAN input *values*** carry user-configured scaling (factor/offset) and byte order per input;
  the 32-bit field is just the container. CAN input *states* (the 1-bit on/off in Msg 5 / CANBoard
  Msg 3) are independent and were always correct.
- **Keypad re-broadcast** (PDM Msg 24–26, offsets +26…+28) is the PDM repeating the keypad state it
  received. The config tool reads keypad state from the keypad node directly and does **not** decode
  these frames, but they still occupy +26…+28 and count toward the device's CAN ID range.
- **Send conditions matter.** Only Msg 0–4 (PDM) / Msg 0–2 (CANBoard) are sent every cycle; the rest
  appear only when their feature is enabled (see each "sent if…" above).
