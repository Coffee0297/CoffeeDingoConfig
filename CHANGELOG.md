# Changelog

All notable changes to **dingoConfig** are recorded here. Versions follow [SemVer](https://semver.org/);
`-rc.N` tags are prereleases (feature-complete but not field-validated).

## [Unreleased]

### Added
- SLCAN adapter accepts `tcp://host:port` (CoffeeDingoSim bridge); a **Sim** button next to the port box
  fills in `tcp://127.0.0.1:7778`.
- A faulted / over-current output card says **why** it tripped (peak vs the limit that fired, read from the
  module's trip log) and how it clears (latched until power cycle, or the retry schedule).
- Logs ▸ Overloads shows the limit that actually fired: a trip inside the inrush window is judged against
  the inrush limit, which the firmware does not log (`lib/trip.js`, worked out from the stored waveform).

### Changed
- CAN-ID guard: an id sent only by Lua `txCan` calls on several modules (a master/backup failover) is listed
  as a **shared Lua ID**, not a conflict; any other owner on the same id still collides.

### Fixed
- **Analog inputs from a loaded project were written as defaults.** The JSON reader replaces each input's
  switch / rotary / scale objects after construction, but the param list still pointed at the defaults,
  so Write All sent every rotary as disabled with no points (`AnalogInput.Params` is now built on read).
- **Write All no longer fails silently.** A count/CRC mismatch is retried twice, then finished with
  acknowledged per-parameter writes (a busy bus can drop a frame or two of a 2500-frame batch, and the
  module keeps its old config when one is missing). A final failure shows an error toast.
- CANBoard success / error notifications reach the UI (only PDM ones were wired).
- **A lost Write All completion reply hung the write forever** with no message: the completion frame was sent
  untracked. It now has the normal reply timeout and retries.
- "Adapter disconnected" named the adapter "Unknown" (the name was read after it was cleared).
- **System log flooded by HTTP request lines** when dingoConfig was started from another folder (a shortcut,
  a script): the content root was that folder, `appsettings.json` was not found and ASP.NET logged every
  request at Info, pushing real messages out of the log within minutes. The content root is now the exe folder.

## [0.7.0] — 2026-10-05

Timers, 2-axis lookup tables, the expanded sleep model from upstream dingoFW #52, the upstream flow-editor
ideas folded into the Wiring graph, and the CAN-input operand fix (upstream dingoConfig #59). Pairs with
**CoffeeDingoFW v5.5.107** (`CONFIG_VERSION` 0x000F); minimum firmware is now **5.5.107**. Build- and
API-verified (unit tests + an end-to-end API smoke run), **not yet exercised on hardware**.

### Added
- **Shutdown & sleep sequence designer** (System ▸ ⚙ Settings) — describe the sleep in plain terms and see it
  as a timeline: an **ignition signal**, *sleep N s after ignition off*, *quiet on CAN at M s*, *hold these
  outputs for H s* (dash stays lit after the key), and for a **master** a *shutdown frame* (CAN ID, byte 0 = 1,
  sent G s after ignition off). **Roles**: Standalone / Master / Follower — applying Master enrols every other
  module as a follower automatically (its trigger becomes the master's frame, sleeping 10 s after it, quiet at
  8 s), after a confirm that lists them; a follower's Settings shows which master it follows. Everything
  compiles onto existing primitives — Timers named “Sleep · …”, the force-sleep / mute-TX inputs, a CAN
  output / CAN input for the frame — so it reads back from the module, works offline (Deploy later) and shows
  up on the Wiring canvas. The raw signal pickers moved under *Advanced*.
- **The module block takes wires too** — on the Wiring canvas the device node now has **Force sleep** (boards
  that sleep) and **Mute CAN TX** input ports, so a Timer, digital input or CAN input can be wired straight
  into the module like any other block (parity with upstream's flow editor, which gained the same two handles
  in dingoConfig `cf23651`). Wires persist offline and write params 0x0000:10/11 when live; the module's own
  always-true signals are refused as sources, and deleting a source clears these inputs like any consumer.
  `POST /api/devices/{guid}/device-inputs` `{ forceSleepInput?, muteTxInput? }`; `/functions` now carries a
  `device` block with the current values.
- **Output bench test** — in the Outputs editor (and a ⚡ test link on each card while the module is live):
  force an output **on**, or run **PWM at a chosen duty and frequency**, to check wiring and loads without
  touching its rule. The module holds the test for 5 s per command and the editor re-sends while it runs,
  so Stop, closing the panel or losing the link releases the output by itself; on a PDM the current limits
  and fault handling stay active, and a disabled output is refused (enable it and set its limit first).
  Works for PDM/-Max outputs and CANBoard digital outputs (incl. PWM).
  `POST /api/devices/{guid}/output/{n}/test` `{ mode: on|pwm|off, duty, freq, hold }`; needs firmware
  ≥ 5.5.107 (MsgCmd 48).
- **Timer function** (upstream dingoFW #61) — a new logic block in Signals & logic and on the Wiring
  canvas: driven by any on/off signal, with **on-delay / off-delay / pulse** modes, a preset in ms and a
  selectable active level (run while the input is *on* or *off*). 8 per PDM, 4 per CANBoard. The output
  is a normal signal — drive an output, a Condition, a CAN output, or the module's force-sleep input.
- **Lookup table function** (upstream dingoConfig #58) — a 2-axis map (up to 8×8) with bilinear
  interpolation, edited as a grid (X breakpoints across, Y down, "space axes evenly"), with a **live
  preview** of the interpolated result from the current X/Y and the value the module reports. One row =
  a 1-D curve (fan duty vs temperature); the output is a numeric signal (e.g. an output's duty source).
  PDM/-Max only (the CANBoard config sector has no room). Axes are validated ascending before save.
- **Expanded sleep settings** (System ▸ ⚙ Settings): a **force-sleep** signal picker (ignition input, a
  CAN "sleep now" input, a Timer…), a **mute CAN broadcasts** signal picker, and **wake sources** — a
  checkbox per digital input plus "CAN traffic" (USB always wakes). Replaces the digital-input-only
  sleep trigger of 0.6.x. Exposed to agents as `device.forceSleepInput`, `device.muteTxInput`,
  `device.wakeDigInputMask`, `device.wakeOnCan` (sub 10–13; the old sub 6–8 params are gone).
  Field-safety guards: always-true signals ("Always On", "State") are kept out of both pickers and
  refused on Save (they would park the module 1 s after every boot with only USB able to wake it); a
  configuration with **no** wake source is refused while sleep is possible; a new force-sleep signal is
  confirmed by name. Save writes **only the fields you changed** (an unread module's other values are
  the project record, and a banner says so), and the sleep blocks are hidden on a CANBoard, whose
  firmware never sleeps — only the mute-TX input applies there.
- `/api/devices/{guid}/inputs` entries now carry their owner (`kind`, `number`, `prop`), so the UI
  resolves a var-map index to its function exactly instead of reconstructing names (a CAN input and a
  table both called "Fan" no longer collide); pickers hide a function's own output, and disabling a
  block from Signals & logic warns which inputs still read it.
- `set_function` / the function endpoint now **refuse** a field the model can't take (an undefined enum
  value, a non-numeric) with a 400 naming it, instead of silently dropping it and reporting "saved";
  fractional numbers for integer fields are rounded. Timer preset, flasher on/off time and table sizes
  are clamped to the firmware ranges in the model, and the circuit builders validate their ms fields.
- The CANBoard/PDM **DBC** float signals (`SIG_VALTYPE_`) are now honoured when a module DBC is
  imported as an ECU device, so `Table_1` decodes as a float, not a huge integer.
- The Dashboard only shows configured flasher / timer / table slots (the API's `SignalDto` carries
  `enabled`), and the Signals-list poll, Wiring poll and Dashboard poll now depend on the module id,
  not the telemetry object — the 10 Hz push was re-running them (≈50 requests/s idle).
- **Wiring graph, upstream flow-editor ideas**: handles are **coloured by data type** (bool / int /
  real) and a wire only lands where the type fits (while you drag, the dot under the cursor rings green
  if the types fit, red if not); wires **glow green while their signal is on**; the gear on a block
  opens its editor **inline below the canvas**
  (the graph stays visible — PDM smart outputs still open the Outputs drawer); one **device node**
  carries Always On / State / Temperature / Battery; the Add menu shows **free slot counts** and opens
  the new block's editor; deleting a block that other inputs still use asks first and tells you how
  many wires go; PDM outputs expose **Duty source / Freq source** ports (wiring one switches the output
  to variable PWM); **CANBoard digital outputs now appear** on the canvas and wire like PDM outputs.
- Circuit builders: **After-run** (output holds for N s after its trigger drops — fan/turbo cooling,
  courtesy light) via an off-delay Timer; the Fuel-pump prime is now a Timer pulse instead of a
  10-minute flasher.
- `tests/LookupTableTests.cs` + `web/clientapp/src/lib/table.test.js` mirror the firmware's host
  self-test cases, so the three interpolation implementations can't drift apart.

### Fixed
- **Full review against a 7-module project (5 PDM + 2 CANBoard)** — every function slot round-tripped through the
  API, every view and editor driven headlessly, models compared with the firmware param tables. Fixed:
  - wiper and starter-disable configuration was **dropped on project load** (non-public setters), so the next Write
    pushed defaults; a dingoPDM-Max loaded from a project kept an 8-output starter-disable the firmware rejected whole;
  - output label params (name, wire colour/stripe/length/gauge) leaked into the CAN param protocol: bulk WriteAll and
    the CRC check threw, and a Read wiped the wire labels and counted them as 40 "differences";
  - `ApplyJson` rejected `string[]` and nested collections, so **every CANBoard analog-input save and every keypad save
    returned 400**; it also applied the accepted fields before refusing ("nothing was written" was false) — now two-pass;
  - `set_output_config` / `/outputconfig` with a partial body zeroed the omitted fields — now a merge;
  - the CAN input/output `Id` setter cleared an explicit extended-frame flag for ids ≤ 0x7FF; keypad model and
    message-source enums drifted from the firmware; `keypaddial` was unreachable via the function API/MCP;
  - firmware-bounded params (bit lengths, rotary positions, counters, PWM frequency/denominators/duty, times, reset
    limit, currents, node id, brightness, sleep timeout, primary output) had no clamps via API/MCP — the firmware
    dropped the write silently and the app reported "No reply";
  - table outputs were advertised as int32 to the cross-module picker (a firmware CAN input cannot decode a float32 —
    they are now marked and refused); `/can-id-map` used a 16-id span for every module (now +29 PDM / +13 CANBoard) and
    ignored Lua `txCan` transmissions; the CANBoard board temperature was discarded ("no sensor");
  - `/signals` hard-coded `enabled` for digital inputs/outputs and analog inputs, so the Dashboard and Plot listed every
    unused slot; the Plot picker, Dashboard and the Condition / CAN-output / wiper pickers now show configured signals only.
- **Lua slot lint**: uploading a program now warns when `setLuaOut(n)` writes a slot nothing reads, or an output is bound
  to a "Lua Out" the program never writes — and names the classic off-by-one (slots are 0-based: `setLuaOut(0)` drives
  "Lua Out 1"). A reviewed project had every call one slot high, so each output ran its neighbour's rule.
- UI: keypad save sent the nested button/dial arrays and bound the backlight colour to the button-colour enum (wrong
  labels for values 3–6, Amber/YellowGreen unselectable); the keypad model list covered 6 of 15 models and the Keypad view
  ignored "Button enabled"; live readouts were keyed by signal name alone (a CAN input and an output both called "Horn"
  showed the output's state on the CAN block); duplicate "—"/"None" zero rows in every picker; the SearchSelect ▾ chevron
  did nothing; disabled PDM outputs were indistinguishable from unruled ones and flagged "rated N A" in red; a CANBoard
  Wiring canvas opened with the top row clipped and Fit view could not zoom out; the cross-module pull inside Signals &
  logic showed frame-map names, listed disabled timers and left the on/off port reading inverted; the Wiring "+ Remote
  signal" list offered every var of any type and the auto bridge ids sat in the CANopen SDO-response range (keypads
  reply there) — moved to 0x101–0x13F (cross-module functions to 0x140+), configured module spans are skipped;
  rotary **position names** have an editor; with no adapter connected every programming button blamed the Sim adapter
  and "Change base ID" was disabled although it is a project edit; the Outputs base-ID "Set" had no range/overlap guard;
  System cards could stay on "acquiring…" forever and three effects re-ran on every telemetry push; a follower could not
  type a shutdown-frame ID by hand; several hints claimed "Save writes to the device" offline, the analog hints named
  labels that don't exist, the per-view help was stale (no MCP entry), and success toasts said "burned" for queued actions.
- **Signal pickers listed every var-map slot** — `digitalInput2`, `canInput7`, `condition19`… 200+ unnamed entries
  per module, whether configured or not. Every picker (outputs, logic blocks, builders, settings, the sleep
  designer) now offers only configured signals: the module's own system signals, enabled inputs and functions,
  and Lua outs when a program is stored (`/inputs?inUse=true`). The Wiring canvas and index resolution keep
  the full map, and a currently selected signal stays visible even if its function was disabled.
- **Another module's inputs were unfindable in the cross-module pickers**: the “＋ from another module” list
  showed frame-map names (`DigitalInput1.State`), so a CANBoard input you had named “ignition” never matched.
  The list now shows the function's own name, lists only configured signals, and names the CAN input it
  creates after it, and pulling the same signal again reuses that CAN input instead of adding another (the
  lists filled with “ignition” ×5). The sleep designer's ignition picker offers the same “from another module” pull.
- **Cross-module functions: “Add function” did nothing** when the Name field was empty — the save returned silently.
  An unnamed function is now saved as “Function N” (rename it from its card).
- **CAN input operand vs value** (upstream dingoConfig #59): the live CAN-input value is now decoded with
  the input's factor/offset (and as signed), so it is the same **scaled** number the firmware compares
  against **Compare to** — the editor labels the field "Compare to (scaled)", shows the scaling and the
  live value next to it. Previously the live readout was the raw bus integer while the operand was
  scaled, so "30" and "3000" looked like a mismatch.
- **Bridged / auto-created CAN inputs read inverted**: a CAN input created by the Wiring graph's remote
  bridge, the cross-module native rules, or an ECU/broadcast pick left the slot's default comparison
  (`== 0`), so its on/off State was the opposite of the bit. They now set `!= 0`. (If you deployed a
  cross-module rule with 0.6.x, re-deploy it.)
- Bridging a remote signal onto a **CANBoard** resolved the CAN input's var-map index from a stale PDM
  layout; it is now looked up by name on the real var map.
- The PDM CAN-ID footprint is `base…+29` everywhere it's checked (System overlap check, Suggest-base,
  `tools/canfree.py`, the frame map) to include the new table frame.
- Wiring graph: PDM output **Current / Overcurrent / Fault**, **wiper**, **keypad** and **Lua Out** sources
  are back in the source catalog (they had no var-map match, so an output driven by Lua or a wiper
  rendered with no wire and those handles accepted a drag that wrote nothing); a port with no var-map
  entry now says so instead of silently dropping the wire; a failed write drops its optimistic wire;
  deleting a block no longer closes an unrelated open editor; wiring a Duty/Freq source confirms the
  switch to PWM and unwiring returns the output to on/off.
- Firmware 5.5.107 re-broadcasts CAN-input values **always little-endian** (a Motorola input's value was
  undecodable before), so the live value is right for every byte order.

### Changed
- Minimum firmware **5.5.107**; `pdm-definitions.json` carries `numTimers` / `numTables` per model.
- `docs/can-frame-map.md` documents the Timer bits, PDM Msg 27 and the raw-vs-scaled CAN value rule.

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
