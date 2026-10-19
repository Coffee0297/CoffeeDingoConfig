# Prompt: PDM / PDU competitor feature research

You are researching commercial and open-source automotive power distribution modules (PDM / PDU / power
control units) to find features that our system (dingoPDM v7, dingoPDM-Max, CANBoard v2 + the dingoConfig app)
is missing or does worse. Use the web: product pages, manuals/PDF user guides, software help files, release notes,
forum threads (e.g. HP Academy, FactoryFive, Link/ECUMaster/Haltech forums), YouTube walkthroughs.

## Products to cover (at least)

Priority — go deep (read manuals / software help, not just brochures):
- **APEX** (Apex PDM range)
- **ECUMaster** PMU16 / PMU24 / PMU16DL / PMU-Client software (incl. functions, tables, PID, CAN keyboards, logging)
- **Syvecs** PDM / power modules
- **Life Racing** PDU / power control units and their config software
- **Link ECU Razor PDM** (PID control, functions, logging — the user rates this one highly)

Also cover: MoTeC PDM15/16/30/32 (+ PDM manager), Haltech PD16 / PD16 Gen2 / PDM in NSP, AiM PDM08/PDM32,
Bosch PBX90 / PBX190, Cartek PDM / Power Distribution Panel, Racegrade / Raceparts, OBR (Ohio/Oz) PDMs,
EMtron PDM, Hardwire Electronics / PowerCore, Rotronics, Infinitybox (MASTERCELL), PDM60 (Ross/PE3), Holley
(EFI) Power Module, CAN-based keypads/PDMs from Blink Marine, Grayhill, and any open-source PDM projects.
Add anything else notable you find.

## For each product capture

- Hardware: output count, current per output, total current, outputs that can be paired/bridged, H-bridges,
  low-side outputs, input count/types (digital, analog, frequency, thermistor, ratiometric), CAN buses, LIN,
  USB/Ethernet/Wi-Fi/Bluetooth, onboard sensors (IMU, accelerometer, GPS, temperature), sealing, connectors,
  logging memory, sleep current.
- Output control: protection (current limit, inrush curves, I²t, thermal model, retries, fault latch & clear),
  PWM (frequency range, soft start, duty from table/PID), load-specific modes (lamps, motors, fuel pump,
  fans, wipers, H-bridge motors, starter), battery-voltage compensation, open-load detection, load shedding by
  battery voltage / priority, brownout behaviour.
- Logic: logic functions, timers, counters, flashers, tables (1D/2D/3D, sizes), math/expressions, PID loops
  (what they control, tuning aids, anti-windup), state machines, scripting (Lua etc.), number of each.
- CAN: receive/transmit, DBC import/export, templates for ECUs/dashes/keypads, CAN keypads supported, CANopen,
  J1939, OBD-II, gateway/bridging between buses, Lua/scripted CAN.
- Power management: ignition/start logic, sleep/wake, timed wake, battery monitoring, alternator control,
  shutdown sequencing, keep-alive for infotainment/PC.
- Diagnostics & data: onboard logging (rate, channels, triggers), trip/fault history, live view, scope,
  cloud/phone apps, dash integration, LEDs, self-test.
- Software/UX: config tool features (offline editing, simulation, wizards, templates, wiring diagrams,
  harness/BOM output, project compare, firmware update, multi-module projects, version control, password
  protection/locking), ease of use, notable praise or complaints from users.
- Price range (EUR if possible) and target market.

## What we already have (do not report these as missing unless a competitor does them clearly better)

**Hardware**
- dingoPDM v7: 8 Profet high-side outputs (2 × 14 A BTS7002, 6 × 8 A BTS7008 in dual-channel pairs),
  2 digital inputs (PWM-capable up to 1 kHz), no analog inputs, 1 CAN bus (125 k–1 M), USB-C (SLCAN bridge + DFU),
  battery voltage, board temperature, FRAM config, ~7 mA sleep current.
- dingoPDM-Max: 4 × 26 A outputs (BTS70012), otherwise as v7.
- CANBoard v2: 4 low-side outputs (no current sense), 8 digital inputs (PWM up to 5 kHz), 5 analog 0–5 V inputs
  with 5 V supply, 1 CAN bus.

**Output control**
- Current limit and inrush limit (0–100 A) with inrush time.
- Reset modes none / count / endless with a retry delay.
- Fault latches until power cycle.
- Warning and open-load detection are report-only.
- Output pairing (follower outputs share current and PWM phase).
- PWM 0–400 Hz with fixed or variable duty/frequency from any signal, min duty, soft start/ramp.
- PWM-synchronised current sampling, peak-hold current.
- Starter disable per output.
- Bench test with a link-loss watchdog.
- Trip log in RAM: 3 trips with a 13 s waveform at 25 Hz, plus 16 warning notices.

**Inputs**
- Digital inputs: momentary/latching, invert, debounce, pull up/down, PWM duty + frequency measurement.
- CANBoard analog inputs: threshold, multi-position resistor-ladder switch (2–10 positions), linear scaling.

**Logic** (per PDM / per CANBoard)
- Virtual inputs (2–3 signal AND/OR/NOR, with NOT; 16 / 8).
- Conditions (8 compare ops + hysteresis; 32 / 8).
- Timers (on-delay / off-delay / pulse, up to 1 h; 8 / 4).
- Counters (inc/dec/reset, edges, wrap, hold-reset; 4 / 4).
- Flashers (4 / 4).
- 8×8 bilinear tables (2 per PDM; none on the CANBoard).
- Math blocks (add / sub / mul / div / min / max / avg + scale/offset; 8 / 4).
- CAN message blocks (fixed frame, repeat or once; 4 / 2).
- **No PID.**

**Special functions**
- Ignition/start-button state machine: switch+button / button / key, max crank time, crank-allow and running
  inputs, dash hold, main/follower across modules.
- Comfort (lane-change) blink synchronised across modules.
- Wiper controller: slow/fast/intermittent with 6 delays, speed map, wash wipes, park switch.
- Blink Marine / Grayhill CANopen keypads (2 per PDM; LEDs, backlight, dials).

**CAN**
- 32 CAN inputs: any bit field, factor/offset, byte order, signed, compare operator, timeout with a set value.
- 32 CAN outputs: any signal, merged per ID.
- 28 status broadcast frames at 10 Hz.
- Hardware filters.

**Scripting**
- Lua 5.5 on the PDMs: 4 KB script, 32 output slots, CAN RX/TX, tick 1–1000 Hz, timers.

**Sleep / wake**
- Auto-sleep when idle.
- Force-sleep and mute-TX signals.
- Wake on input mask / CAN / USB.
- Wake reason and count.
- App-built master plan: keep-awake signals, hold time, pre-sleep pulse for a Pi/infotainment halt, wake pulse.
- **No timed wake.**

**Updates**
- CAN bootloader (OpenBLT) for every module, firmware update of all modules from the app, USB DFU.

**Config app** (.NET + Svelte, runs in the browser)
- Adapters: SLCAN / USB / PCAN / Kvaser / SocketCAN / TCP.
- Multi-module project files.
- Staged edits → Apply to car → Store.
- Car map home screen.
- 18 function templates with a setup wizard and wiring/signal SVG diagrams.
- Visual flow builder with an offline simulator and fault injection.
- Cross-module functions compiled to CAN wiring or Lua.
- Ignition and sleep wizards; output roles.
- Output pages: rule chains, protection, PWM, wire gauge / voltage drop, bench test, current chart.
- Analog ladder designer and calibration.
- DBC import/export; learn a CAN switch from the bus.
- Keypad editor.
- Firmware catalog from GitHub releases.
- Live dashboard, plots, trip waveforms, CAN traffic log.
- Lua editor with lint.
- CAN-map clash checker.
- MCP server for AI agents, with approvals and undo.
- Renode-based simulator that runs the real firmware.

**Known gaps we already know about**
- No PID.
- No onboard data logging beyond the trip log.
- No persistent fault log.
- No fault clear without a power cycle.
- No timed wake.
- Only one CAN bus.
- No analog or thermistor inputs on the PDMs.
- No H-bridge.
- No load shedding by battery voltage.
- No current sense on the CANBoard outputs.
- No password/lock.

## Deliverable

1. **Comparison table**: products × key capabilities (outputs/current, inputs, CAN buses, PID, tables, scripting,
   logging, load shedding, H-bridge, sleep/timed wake, keypads, price).
2. **Missing features list**, each with:
   - which products have it and how they do it (quote or paraphrase the manual, with a link);
   - why it matters in a road/race car;
   - how hard it would be for us. Classify each as:
     - **firmware-only** on current hardware;
     - **app-only**: can be built from existing blocks, like the Sleep plan;
     - **needs new hardware**.
   - suggested priority (high/medium/low).

   Be specific on PID (Link Razor, ECUMaster): inputs, outputs, setpoint sources, tuning, limits, typical uses
   (fan speed by coolant temp, fuel pump by pressure, boost/idle solenoids).
3. **Better-than-ours list**: features we have but a competitor does notably better (e.g. a smarter inrush model,
   nicer software UX), with what to copy.
4. **Ideas worth stealing for the config app** (wizards, diagrams, diagnostics, harness tools).
5. **Sources**: links for every claim; mark anything you could not verify.

Be thorough over fast. Prefer primary sources (manufacturer manuals/help files) and say when a claim is from a
forum or a reseller.
