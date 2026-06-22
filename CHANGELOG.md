# Changelog

All notable changes to **dingoConfig** are recorded here. Versions follow [SemVer](https://semver.org/);
`-rc.N` tags are prereleases (feature-complete but not field-validated).

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
