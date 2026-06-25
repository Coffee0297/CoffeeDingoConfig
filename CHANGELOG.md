# Changelog

All notable changes to **dingoConfig** are recorded here. Versions follow [SemVer](https://semver.org/);
`-rc.N` tags are prereleases (feature-complete but not field-validated).

## [0.6.0] — 2026-06-25

Flash firmware over CAN + bus-load-resilient comms, Kvaser support, smarter flash routing, CANBoard
digital-output PWM + always-live analog inputs, CAN frame-map reference + decode fixes. Pairs with
**CoffeeDingoFW v5.5.104** (OpenBLT CAN bootloader + always-live analog).

### Added
- **Flash firmware over CAN (OpenBLT XCP)** — "Update firmware over CAN" reflashes a module's app
  through the bootloader (`CanFlashService`, XCP cmd/resp `base+12`/`base+13`), no USB/DFU. Verified
  end-to-end through a dingoPDM CAN bridge on a Kvaser-saturated **3000 msg/s** bus.
- **Kvaser CAN adapter** (CANlib `canlib32.dll`, Windows) — a dedicated bus interface alongside
  SLCAN/PCAN; channel = the port field (0-based). Driver not bundled (it's a vendor driver the
  hardware needs anyway); the build needs nothing extra (P/Invoke, loaded lazily on connect).
- **Per-module flash routing** — each System card shows one context-aware flash button: the USB↔CAN
  bridge flashes over **USB** (identified at connect via the dingoFW `I` slcan-extension, which
  reports the bridge's base id), while every downstream module and the CANBoard flash over **CAN**.
  `DeviceDto.CanBootloader` / `IsGateway` drive it.
- **Receive accept-filter on read / write / burn / flash** — `ICommsAdapter.SetReceiveFilter(loId,
  hiId)` (SLCAN/PCAN/SocketCAN/Sim); `DeviceManager` arms a device-block filter during config
  exchange and auto-lifts it when idle, so a flooded bus can't starve config or telemetry.
  `ProbeFilterAsync` reports whether an adapter can hardware-filter — i.e. whether it's suitable for
  flashing on a busy bus.
- **Flash to the correct app address** (`FirmwareFlashService`) — USB-DFU now writes the app at its
  real base (`0x08004000` for an in-app update, preserving the OpenBLT bootloader; `0x08000000` only
  for a blank/full image), instead of always erasing from `0x08000000`.
- **CANBoard digital-output PWM** — DO1–DO4 now expose the PDM's full PWM/dimming UI (PWM enable,
  freq, duty %, min duty, soft-start + ramp) in the digital-output editor. New params on
  `DigitalOutput` (sub 2–10, matching the firmware) round-trip through `set_function` /
  `apply_config` automatically, so the MCP config surface exposes `digitalOutput[N].pwmEnabled` etc.
  Live duty is decoded from the new **Msg 9 (`base+11`)** frame into each output's `CurrentDutyCycle`
  (plotable). CANBoard CAN-ID footprint grew to `base−1…+11`; the System overlap check,
  `canids.js`, `tools/canfree.py` and the frame map were updated to match.
- **`docs/can-frame-map.md`** — address-agnostic CAN broadcast frame map for every device type
  (which `baseId + 2 + N` offset and which bits carry each signal). Served at `/can-frame-map.md`
  and via the new MCP **`get_frame_map`** tool, so an agent can decode the bus with no device bound.
- Refreshed `dbc/` with the authoritative `CANBoard_0.5.1.dbc`, `dingoPdm_0.5.1.dbc` and
  `dingoPdm-Max_0.5.1.dbc`; removed the stale `CANBoard_2.1.1.dbc` (wrong layout).

### Fixed
- **dingoPDM cyclic decode** (`PdmDevice`): CAN-input values now decode through offset +24 (1–32);
  the output **duty-cycle** frame reads at +25 (it was overwriting +10 / CAN values 7–8); and
  `MaxCyclicId` is +28 so frames +11…+28 are routed instead of dropped by `InIdRange`.
- **CANBoard** `MaxCyclicId` is +10 (was +7) so CAN-value frames +8…+10 reach the decoder; stale
  message-offset comments corrected.
- **Current scaling** now decodes at **0.1 A/bit** to match firmware ≥ 5.5.102.
- **"live" status badge no longer strobes** — the device-liveness window was widened 500 ms → 3000 ms,
  so a single late/dropped status broadcast no longer flips a module to "not found" (and stops
  `Clear()` wiping its live values each flicker).
- **CANBoard analog inputs always read live** (needs **CoffeeDingoFW v5.5.104**) — the raw mV is
  sampled and broadcast whether or not the input is "enabled"; only the rotary/switch/scale decoders
  stay config-gated. Previously a disabled input read 0 mV.
- **CANBoard board temperature removed** — the CANBoard has no temperature sensor, so the bogus Msg 1
  reading is no longer decoded, plotted, or shown on its dashboard.
- **"Not connected" vs "not responding"** — the System and Dashboard alarms now say *"Not connected to
  a CAN adapter"* when there's no bus link, instead of wrongly reporting each module as "not on the bus".

### Changed
- Minimum firmware bumped to **5.5.102** (the 0.1 A/bit + bit-32 CAN-value wire format); older
  firmware logs a "needs update" notice.
- **Removed the redundant "USB" adapter** — a dingoPDM connected over USB speaks SLCAN, so it *is* the
  SLCAN adapter; the duplicate entry is gone (USB-DFU firmware flashing is unaffected — it runs through
  dfu-util, not a comms adapter).

## [0.6.0-rc.2] — 2026-06-22 (prerelease)

Built-in firmware flasher improvements.

### Added
- **Flash a brand-new / blank module over USB DFU** from the System view (**⬆ Flash new module**) — no CAN
  bus needed; put the board in DFU (BOOT0 + reset, USB) and dfu-util writes it.
- **🔍 Scan for DFU device** in the flash drawer — shows how many boards are in DFU (plus the raw
  `dfu-util -l` listing) so a failed flash isn't blind.

### Fixed
- DFU scan counts **distinct boards** (by devnum), not the per-alt-setting lines — one STM32 in DFU
  exposes 4 interfaces (Internal Flash, Option Bytes, OTP, Device Feature), which previously read as
  "4 devices".

## [0.6.0-rc.1] — 2026-06-22 (prerelease)

Adds **linear sensor scaling** on a CANBoard analog input, and reworks the multi-position switch to
match the optimised firmware. Pairs with **CoffeeDingoFW v5.5.101**.

### Added
- **Linear scaling (sensor) mode** for an analog input. Enter two datasheet points (mV → value) and
  the input reads out in **engineering units** (bar, °C, …); the tool computes gain/offset and the
  firmware publishes the scaled value for use in Conditions, outputs and CAN. On/off **or**
  multi-position **or** linear-scaled — the three are mutually exclusive.
- A **"Scaled Value"** variable per analog input in the variable map (selectable as a logic input).

### Changed
- **Multi-position switch protocol reworked** to match firmware v5.5.101: point voltages are sent
  **packed two per 32-bit word** (5 words instead of 12), the legacy uniform offset/step params are
  gone, and the cap is **10 positions**. Re-save any existing analog-switch config against v5.5.101.

### Notes
- The CANBoard analog features need **CoffeeDingoFW ≥ v5.5.101**, which **has not been flashed/tested
  on a CanBoard yet**. Verify on hardware before relying on it. This config build is compile-validated.

## [0.5.0-rc.1] — 2026-06-22 (prerelease)

Headline: **multi-position & calibrated switches on a CANBoard analog input**, plus a CANBoard-focused
UI pass. Pairs with **CoffeeDingoFW v5.5.101** (per-position decode lives in firmware).

### Added
- **Multi-position switch on an analog input.** Turn one analog input into a rotary/selector with up
  to 10 positions. Two ways to set it up:
  - **Design a resistor ladder** — pick the number of positions and the tool recommends standard
    (E12/E24) resistors for an even spread on the 5 V input, shows each position's voltage and the
    worst-case noise margin, and lets you override any resistor or voltage by hand.
  - **Calibrate an existing switch** — a guided capture that reads the live voltage and fills each
    position's value (complements manual entry); step through the detents and it logs the points.
- **Per-position calibrated decode (uneven switches).** Each position stores its own measured
  centre voltage, so wiper/blinker-style switches with *uneven* steps decode correctly. A position
  registers within a **sensing window** (`±tolerance`, auto-sized from the spacing and capped, never
  crossing the midpoint to a neighbour). A reading in a dead zone reports **"no position"**.
- **On/off (single-threshold) analog switch.** Use an analog input as a simple on/off input at a
  voltage threshold (momentary/latched, invert), exposed as `"<name> Switch"`. An input is on/off
  **or** multi-position — the two are mutually exclusive.
- **Auto pull-up sizing** for the ladder, with a live **standing-current** readout, and an **Auto**
  that re-sizes when the position count changes.
- **Live readouts for CANBoards** — analog millivolts, decoded position, digital I/O and logic
  signals now stream to the UI (mini-charts, the per-switch live position, dashboard tiles).
- **Reload resumes where you left off** — the last view and selected module are restored (System
  overview on first run).

### Changed
- **CANBoard Outputs tab** is now a focused digital-output card grid (matching the PDM output cards),
  instead of duplicating the whole Signals list.
- **Signals & logic** is reordered to lead with the physical I/O (analog → digital inputs/outputs),
  then logic blocks, with group headers.
- **CANBoard dashboard** shows only what the board measures — board temperature, FW version, CAN
  bitrate, and its own I/O — instead of the PDM-only battery/total-current tiles.
- Lua UI is hidden on devices without a Lua engine (CANBoard), and a cross-module function can no
  longer push Lua to one (config-tool and backend both refuse it).

### Fixed
- Nested analog-input config (rotary / switch) is now **persisted on save** — previously the
  rotary/switch settings were silently dropped, so the "decode as a switch" toggle reset on reopen
  (`ApplyJson` now recurses into nested function objects).
- The multi-position panel recalculates on the **first** press after changing the position count or
  on a freshly opened input (positions is now a bound value, not the rendered row count).

### Notes
- The calibrated per-position decode runs **in the firmware** — it needs **CoffeeDingoFW ≥
  v5.5.101** flashed to the CANBoard. The tool stores/sends the points either way.
