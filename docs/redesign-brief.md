# Design brief: a completely new dingoConfig

> Paste this whole document into the design tool. Attach the current screenshots (a set of 31: every view,
> editor and drawer, light + dark, and phone width, taken live from the simulator) as
> **"what exists today — do not copy this layout"**. They show what the app does, not how it should look.

## Your role and the ask

You are a senior product designer specialising in technical tools for non-experts (think the people who made
Home Assistant, Node-RED and Apple Shortcuts approachable). Design a **completely new** user interface and
user experience for **dingoConfig**, the configuration app for a family of automotive power-distribution and
I/O modules.

This is **not** a reskin or a tidy-up of the current UI. Throw the current layout away. Start from the people
using it and what they are trying to get done, then design the information architecture, navigation, screens,
components and flows from scratch. Every existing capability must still be reachable (see the inventory), but
most of it should be out of sight until someone needs it.

## The product, in plain terms

A car (race car, restomod, off-roader, kit car) replaces its fuse box and relays with a few electronic modules
on a CAN bus:

- **dingoPDM** v7: 8 smart high-side outputs (fused electronically, current measured per output, PWM
  capable), 2 digital inputs, embedded Lua. **dingoPDM-Max**: the same with 4 higher-current outputs, each on
  two connector pins.
- **CANBoard**: an I/O module: 8 digital inputs, 5 analog inputs (switches, rotary switches, sensors), 4
  low-side digital outputs.
- **Keypads** (Blink Marine, Grayhill) and **ECUs** (via a DBC file) also sit on the bus and provide signals.

A typical car has 2–7 modules. Example: two PDMs in the engine bay, one in the boot, two CANBoards behind the
dash reading switches.

dingoConfig is a web app (runs locally, opens in the browser) that:
1. connects to the bus through a USB adapter or straight through one module's USB port,
2. finds every module on the bus,
3. lets the user decide **what turns each output on** (headlights when the switch is on, fan above 90 °C,
   blinkers flashing in sync across two modules, wipers that park correctly…),
4. writes that to the modules and stores it permanently ("burn"),
5. shows everything live (currents, states, why something tripped), and
6. updates firmware over USB or over the CAN bus.

## Who uses it

Design for these, in this priority:

1. **The builder** (primary): a home or club mechanic wiring their own car. Handy with a multimeter, knows what
   a relay and a ground are. **Not** a programmer and doesn't think in "variables", "CAN IDs" or "boolean
   logic". Wants: "the fan comes on above 90 °C and stays on 2 minutes after the engine stops". Works on a
   laptop in a garage, often with greasy hands, sometimes standing next to the car.
2. **The tuner / race team**: knows CAN, DBCs and logic. Wants speed, keyboard shortcuts, density, live data,
   and the advanced features one click away. Uses it in the pit lane under time pressure.
3. **The loom builder / installer**: builds harnesses for customers. Wants pinouts, connector pins, wire
   gauges, printable wiring and logic sheets, and to set up many identical modules quickly.

## What is wrong today (why we redesign)

- **Too many top-level tabs of equal weight**: System, Dashboard, Outputs, Signals & logic, Wiring, Templates,
  Plot, Logs, MCP. A beginner can't tell where to start or how they relate.
- **The same logic is shown three ways in three places** (output rule editor, Signals list, Wiring node graph),
  each with its own concepts and words.
- **Engineer vocabulary everywhere**: var-map index, base ID, CAN offset, virtual input, condition, DBC, burn,
  SDO, MCP.
- **Screens are dense**: every setting of every feature is shown at once, with badges, chips, hints and
  warnings competing.
- **The module-by-module model hides the car**: the user thinks "the fan", not "PDM-02 output 4 + CANBoard-1
  analog 2 + a condition".
- **Write vs. burn vs. save project vs. deploy** is confusing: what is on the module, what is in the project
  file, what is only in RAM.

## Design goals

1. **The car, not the modules.** The main mental model is *functions of the car* (lights, cooling, fuel,
   wipers, starting, accessories). Modules, pins and CAN are where those functions *live*, shown when relevant.
2. **The block builder is the heart.** A friendly visual way to say *when → then* (see the dedicated section).
   It replaces today's three logic views with one.
3. **Progressive disclosure, three levels**, the same everywhere:
   - **Simple** (default): pick from named functions and templates ("Radiator fan", "Turn signals + hazard",
     "Wipers with park"), answer a few plain questions, done.
   - **Custom**: the block builder.
   - **Expert**: Lua, raw CAN, DBC, firmware, AI agent (MCP), raw parameters, logs.
   Expert features are always **one click away** (a consistent "Advanced" drawer, panel or command palette),
   never in the beginner's face.
4. **Live by default.** Every value, block and output shows its live state when connected. No separate
   "monitor mode".
5. **One clear "is it saved?" story.** One obvious status: *changes not sent*, *sent (lost on power-off)*,
   *stored on modules*, *project file saved*. One primary action that does the right thing ("Apply to car"),
   with the detail available underneath.
6. **Plain words.** "Turns on when…", "Stays on for…", "Trips above 15 A", "Engine-bay PDM". Engineering terms
   only in Expert, with a tooltip translation.
7. **Safe.** Anything that switches real loads or re-flashes hardware is obvious, confirmable and undoable
   where possible. Never surprise-switch a load.
8. **Calm.** Fewer colours, fewer borders, clear hierarchy, generous spacing at Simple level, density only on
   request (a density toggle for pros).

## The block builder (most important screen, design it in depth)

What it must express (these map 1:1 onto what the firmware runs; one block = one firmware function):

| Block family | Today's names | What it does, in plain words |
|---|---|---|
| **Inputs** | digital pin, analog switch / rotary (up to 10 positions) / linear sensor, PWM input (duty %, Hz), CAN input (from an ECU/DBC, from another module, from a keypad button) | "a switch", "a sensor", "a signal from the ECU", "a keypad button" |
| **Compare** | condition, with hysteresis (separate on and off point) | "coolant is above 90 °C (off again below 85 °C)" |
| **Combine** | virtual input: AND / OR / NOR, up to 3 signals, invert | "ignition on AND switch on" |
| **Time** | timer: on-delay, off-delay, pulse; flasher (on/off times, single shot) | "after 2 s", "for 2 minutes", "blink 0.5 s" |
| **Count / latch** | counter (up/down/reset, edge), push-button toggle | "press once on, again off" |
| **Table** | lookup table up to 8×8, bilinear | "fan speed from coolant temp" |
| **Outputs** | PDM output (on/off or PWM with duty and frequency from a signal, soft start), CANBoard output, CAN output (send a value on the bus) | "the fan", "send to the dash" |
| **Lua** | a Lua slot driving an output / virtual input / CAN output | "custom code" (Expert) |

Requirements and ideas (taken from the best tools on the market, see the research):

- **Sentence-first, canvas-second.** Default view reads like Home Assistant / Shortcuts:
  *When* [Coolant temp] *is above* [90 °C] *→ turn on* [Radiator fan] *and keep it on for* [2 min] *after*.
  The same logic can be opened as a **canvas** (Node-RED / Syvecs-style schematic) for complex cases. One model,
  two views, always in sync.
- **Blocks can't be wired wrongly**: typed ports (on/off vs number), shapes or colours make invalid links
  impossible (Blockly idea).
- **Every block shows its live value** on the canvas and in the sentence (on/off glow, the number, a tiny
  sparkline). You can see *why* an output is on by following the glow back.
- **Green/red completeness**: a block that isn't fully set up is visibly incomplete; partial logic is allowed,
  but "apply" warns.
- **Simulate before you apply** (Syvecs): offline, click an input to toggle it, drag a sensor value, and watch
  the outputs react. Inject an output fault.
- **Force/test an output** (on / off / auto) from the builder in live mode, clearly marked as a test.
- **Explicit combining**: never order-dependent AND/OR (a pain point of ECUMaster PMU). AND/OR are visible
  words or shapes.
- **Visible budget**: each module has a limited number of each block type (e.g. timers, conditions, Lua
  size). Show a simple "slots used" meter instead of failing at apply time (a pain point of MoTeC).
- **Across modules without thinking about CAN**: a switch on CANBoard-1 can drive an output on PDM-03. The
  builder handles the CAN link automatically; just show a small "travels over CAN" badge, with the detail
  (ID, offset) in Expert. Jump labels / link-in/link-out (Syvecs, Node-RED) keep big canvases tidy.
- **Templates are just pre-filled block groups**: applying "Wipers with park" drops an editable, collapsible
  group that can be expanded to its blocks, renamed, edited or removed as one.
- **Picking signals**: one search box that understands "coolant", "J3-7", "DI3", "PDM-02 out 4", "keypad 1
  button 3". Recently used and "suggested for this block" first.
- **Text twin (Expert)**: the same logic as readable text, and the Lua editor for anything blocks can't do.

## Full feature inventory (everything must stay reachable)

Place each in Simple, Custom or Expert, and in the new navigation. Group and rename freely. **Every item here
must be in the first deliverable (feature parity with the current UI).**

**Connect & bus**
- Adapters: USB (straight to a module, found automatically), SLCAN serial, SLCAN over TCP (simulator), PCAN,
  Kvaser, SocketCAN, Sim replay. Bitrate. Auto-connect and reconnect is wanted.
- Bus discovery: "Add from CAN" finds every module; "Add from USB" for the one plugged in.
- Module list with live state (connected / not found), type, name, base ID; rename; remove; add manually.
- Base-ID planning: CAN-ID overlap warnings, "suggest a free base ID" (with an OBD-II reserve toggle),
  re-address a module.
- "Deploy to USB module": put a project's module config onto whatever module is plugged into USB.

**Car overview**
- All modules at a glance, a draggable car-layout map (where each module sits in the car), live current,
  temperature and state per module, worst-case total load.

**Outputs (per PDM output / CANBoard output)**
- Name, connector pin (e.g. `J3-7`, two pins on the Max), what turns it on, current limit, inrush limit + time,
  reset mode (none / retry N times / endless, with delay), warning limit, open-load detection.
- PWM: fixed duty or duty from a signal, frequency fixed or from a signal, soft start, ramp.
- Wire colour/stripe/length/gauge, voltage-drop hint.
- Live: state, current with a sparkline, why it tripped (trip log with the current waveform around the trip).
- Bench test: force on / PWM for a few seconds.

**Inputs**
- Digital: momentary/latching, pull-up/down, debounce, invert, PWM measurement (duty, Hz, glitch filter).
- Analog (CANBoard): on/off threshold, rotary/multi-position switch (resistor-ladder designer, or calibrate
  from the real switch by capturing each position), linear sensor (two points → engineering units).
- CAN: from a DBC signal (ECU import, search, float, factor/offset/byte order/signed), from another module's
  broadcast by name, from a keypad. Timeout / default value wanted.

**Logic**: see the block builder (conditions + hysteresis, AND/OR/NOR, timers, flashers, counters, tables, CAN
outputs, Lua slots), plus **cross-module functions** (one behaviour spanning modules, e.g. blinkers in sync).

**Templates / guided circuits**: headlights (low/high/flash), washer + wipers, relay-switched wipers (self-park
or concealed park, from a rotary stalk or switches), turn signals + hazards, brake / reverse / DRL / interior /
courtesy lights, radiator fan (and PWM fan), fuel pump prime + run, starter interlock, push-button toggle,
lights-on reminder, after-run fan, switched load. Pins picked on any module; optional relay; shows a wiring
drawing and a signal-links drawing before applying; applied templates can be edited or removed.

**Sleep & power**
- Auto sleep (timeout, ignore always-on outputs), sleep input (e.g. ignition off), mute-transmit input, wake
  sources (per digital input, CAN, USB), a shutdown & sleep **sequence designer** for the whole car.

**Keypads**: Blink Marine / Grayhill, button mapping, LEDs, SDO settings.

**Data & diagnostics**
- Dashboard of one module (battery, total current, temperature, every output).
- Plot: any signal from any module, many series, pause, time window, PNG export. ("Click any value to graph
  it" is wanted.)
- Logs: live CAN traffic per ID (record, download, CSV), system log, trip log.
- Config diff: what's on the module vs. the project, per parameter.

**Save / apply**
- Read from module(s), write (live, lost at power-off), burn (permanent), write-all with CRC check, confirmed
  single writes (shows when a module refused a value and what it kept).
- Project file: open, save, save as (the whole car in one file).
  **Required change from today:** today the user types a file name and saves every time, which works like
  "save as". In the new design, **opening (or saving) a project keeps it as the current file**: its name is
  always visible, **Save (Ctrl+S) overwrites that same file** in one click, **Save as…** is a separate action
  for a new name, and unsaved changes are marked (e.g. a dot by the name) and warned about before opening another
  project or closing. A new project's first Save asks for a name, then behaves the same. (Backend: `GET /api/project`
  already returns the open file as `current` (and `dir`); an "unsaved changes" flag is an *API gap* to list.)

**Firmware**
- Flash over USB (DFU), flash a new/blank module, scan for DFU device, flash over CAN (per module), **update
  all modules over CAN in one go**, version per module, "firmware needs updating" notices.

**Expert / power user**
- Lua editor (global + per-function pieces, upload with read-back check, runtime errors).
- Raw CAN frame map, DBC devices.
- AI agent connection (MCP server: lets an AI assistant configure the car). Status, tools list.
- Raw parameters by name.

## New features to design in (not built yet)

These come from the upstream projects (corygrant/dingoFW + dingoConfig roadmap and issues, and paleppp's
open PRs and branches). Design them as first-class parts of the new app, not bolted on.

**Ignition & start button** (the car's "power" centre; upstream dingoFW#67–#74)
- Two modes: **key switch** (ON position held, START momentary) or **start button**.
- Start-button behaviour, like a modern car:
  - Door opens → the dash boots (timed, so a door left open doesn't keep it running).
  - Button **without** clutch/brake → ignition (ECU power) on. Then clutch + button → starter cranks.
  - Clutch/brake held + button from off → ignition on **and** cranks at once.
  - Starter stops when "engine running" goes true, or after a max crank time; a new press is needed to crank
    again. Pressing during cranking aborts.
  - Engine running + one press → everything off, then the **power-down sequence**: dash grace time → optional
    dash shutdown CAN frame (repeated) → dash power-off delay → a short CAN-quiet period → the whole bus sleeps.
  - Worth offering: "hold to stop while driving" as a safety option.
- Inputs can be a pin, a signal, or a bit read straight from a CAN frame (keypad / button module), with timeout.
- **Output roles** instead of logic: an output is simply *Ignition*, *Accessory* (drops while cranking),
  *Starter*, or *Dash* (follows the power-down sequence).
- **Several modules, one ignition**: one module is master and broadcasts the state; others follow and hold
  their last state if the link drops; the master tells everyone when to go quiet and sleep.
- **Status live**: state (off / ignition / cranking / running), dash state, sleep countdown, master link, and
  **what woke the module** last time (CAN, input, USB…).
- This deserves its own place in the IA (e.g. "Power & ignition"), a live state diagram, and a guided setup
  ("key or button? clutch or brake? which outputs are ECU, accessories, starter, dash?").

**Sleep that actually stays asleep**: every module goes CAN-quiet together before sleeping; show sleep status
and the last wake reason per module so a car that drains its battery can be diagnosed.

**New blocks for the builder**
- **CAN Message**: send a whole user-defined frame (ID standard/extended, length, 8 bytes) while a signal is
  true, repeating or once (e.g. "tell the dash to shut down").
- **Math**: A + − × ÷ min max average B (B a signal or a constant), then × factor + offset (e.g. oil temp −
  coolant temp, total current of two outputs, scale a CAN value).
- **Vehicle functions**: ready-made, editable car basics (headlights incl. flash-to-pass, fogs, DRL; tail/brake/
  reverse/rear fog; turn signals + hazards; interior light with several doors; horn; wipers; blower speeds or
  PWM blower; ECU power with hold-on after ignition off; fuel pump from ECU or prime + run; coolant fan from ECU,
  thermo switch, A/C or temperature with on/off points and run-on). They must stay **generic, not one car's
  wiring** (the upstream maintainer's concern): show them as transparent, editable block groups.

**Learn a switch from the CAN bus**: a record button next to any input. The app listens while the user works
the switch and picks the bit that followed it, ignoring counters and noisy bits. Huge beginner win: no CAN
knowledge needed.

**Connect & platform**
- **WiFi bridge**: find WiFi-CAN bridges on the network automatically (by name, last one remembered), or type
  an address.
- **Phone / tablet**: install as an app (HTTPS option), a mobile layout for live monitoring and testing next to
  the car.
- **Recently opened projects** on the start screen.
- **Export one combined DBC** of the whole car (all modules + imported ECU DBCs) for RealDash, SavvyCAN, etc.

**Dashboard ideas** (paleppp's branches): show only what is enabled (with a "show hidden" toggle and a count),
tiles with a status light, value, current-against-limit bar, tinted by state; clicking a tile opens that block
where it is configured.

**Refinements to existing features** (each answers a question the upstream maintainer asked about them):
- Warning limit as **% of the trip limit** ("warn at 80 % = 12 A"); open load as "below 0.2 A for 1 s → load
  missing?".
- Trip log as a plain sentence on the output: "Tripped 14:02: 23 A peak, limit 15 A" → waveform.
- Bench test: clear TEST banner, countdown, auto-off, only while connected.
- Worst-case load: "If every output hit its limit at once: 142 A", per module.
- CAN-ID conflicts: block applying, one-click fix ("Move to 0x6C0").
- Wire gauge: "2.5 mm² for 15 A over 2 m: 0.3 V drop (2.5 %)".
- Sleep sequence designer → merged into Power & ignition.
- Car-layout map, Add from CAN, flooded-bus handling: explain in one line where they appear.

## Research: how other PDM vendors do it (inspiration)

Summary of a survey of commercial tools. Look at them yourself too (sources in the research; screenshots on
their sites and in HP Academy webinars).

- **ECUMaster PMU Client**: the community favourite. Project tree + monitor windows; outputs show live amps
  next to their settings. Ready-made **Wipers, Blinkers and Keypad modules**. "Press Insert to graph any value".
  Built-in CAN sniffer. Criticised: "a little daunting", busy tree, order-dependent AND/OR.
- **Syvecs PduSetup**: the best graphical logic: schematic canvas with pages, link-in/out labels, components
  **green when complete / red when not**, **offline simulation** (click inputs, inject faults), printable
  logic sheets, keyboard-driven for the pit lane, validation and a memory budget bar. Weak: live mode locks
  editing and hides internal logic.
- **Life Racing**: fully graphical logic with simulation; prints "operational logic diagrams" for loom builders.
- **MoTeC PDM Manager**: one app for config, monitoring, test and firmware. Logic limited to ~200 hidden
  "operations": users hit limits they can't see. One device at a time.
- **MaxxECU PDM20**: each output picks a **named function from a list** (Horn, Wipers, Turn signals, Starter,
  Always on…), the simplest model of all.
- **Link PDM**: **downloadable presets**: "wire it, download preset, upload, done". Auto-connect, autosave,
  non-modal notification bar instead of pop-ups.
- **Haltech PD16**: auto-detected on the bus, status LED per output (off / green / red), per-output safe
  state. Limited to 3 conditions.
- **Infinitybox / Cartek**: no laptop at all for standard setups: function is chosen by which input you wire,
  or by a button and LED. Proof that most users want the common circuits pre-made.
- **AiM**: "takes 10 times longer to program than a PMU": a warning about generic logic without domain help.

Outside automotive: **Node-RED** (palette, canvas, live status under each node, link nodes), **Home
Assistant** (Trigger → Conditions → Actions sentences, test button, trace of past runs, YAML twin),
**Blockly/Scratch** (shapes that can't connect wrongly), **Apple Shortcuts** (plain-language vertical steps).

**Steal**: named function picker with an "open in builder" escape hatch; domain wizards (wipers + park,
indicators + hazard, fan with hysteresis, pump prime); green/red completeness; simulation; live values on every
block; force on/off/auto; click-anything-to-graph; inline "last seen / rate" on CAN inputs; CAN timeout →
default; validate before apply with a budget meter; presets and snippets; auto-connect; notification bar;
printable wiring + logic sheets; sentence view + text twin.

**Avoid**: order-dependent logic; hidden limits; a monitor mode that locks editing; a crowded docked desktop
with no guided path; modal error pop-ups; one-device-at-a-time thinking.

## Key flows to design end to end

1. **First run, new car**: connect → modules found automatically → name them and place them on the car map →
   pick what's in the car from a checklist ("headlights, fan, fuel pump, wipers, blinkers…") → wire-it list
   with connector pins → apply → test each function.
2. **Add one function**: "I want the fan to come on above 90 °C": from a search or "+ Add function" → template
   or sentence → choose the sensor and the output → simulate → apply.
3. **Why didn't it turn on? / why did it trip?**: from a red output to its trip log, current waveform, and the
   live logic chain that drives it.
4. **Change something in the pit lane**: open the function, change 90 → 85 °C, apply, under 10 seconds,
   keyboard only.
5. **Firmware update of the whole car**: one button, shows each module's progress, what to do if one fails.
6. **Installer**: set up 5 identical cars from one project; print pinouts, wiring lists and logic sheets.
6b. **Edit and save the same car project**: open last week's project → change two things → Ctrl+S → it is saved
   to the same file, no name typed; "Save as…" only when a copy is wanted.
7. **Expert**: open Lua, raw CAN log, or the AI-agent panel without leaving the current context.
8. **Push-button start setup**: choose start button + clutch, pick ECU / accessory / starter / dash outputs,
   door switch, dash shutdown, sleep; then watch the live state diagram while pressing the button.
9. **"My battery is flat"**: see each module's sleep status, what woke it last, and which module kept the bus
   awake.

## Implementation contract (so the design gets built, not thrown away)

A design that arrives as a stand-alone HTML mock-up with its own made-up data has failed before (it could not be
implemented). This one must be **built into the real app** screen by screen. So:

**Target.** This fork's app: a **Svelte 5** single-page app (Vite) on a .NET 10 backend, talking to the
**existing REST API** (list below), with live data polled about 10–15 times a second. The upstream dingoConfig is
.NET / Blazor Server, so keep the design stack-neutral in what it *shows*, but deliver it in the forms below, which
map onto Svelte components here (and onto Razor components if it is ever upstreamed).

**What every design must come with**
1. **Design tokens as code**: one `tokens.css` of CSS custom properties (colour for light + dark, type scale,
   spacing, radii, shadows, motion). The app imports it as is: no values typed by hand from a picture.
2. **Component specs**, not pictures: for each component its name, props, every state (default, hover, focus,
   active, disabled, loading, live / stale / offline, error, empty), events it emits, keyboard behaviour and
   accessible name/role. Reuse the same component everywhere; a new look needs a new prop, not a new component.
3. **Screen specs** that bind to real data: for every value on a screen, the API field it comes from; for every
   action, the API call it makes (from the list below). If a screen needs data the API does not have, list it
   as an **API gap** instead of inventing it.
4. **All states of every screen**: not connected, connecting, module not found, Sim adapter (programming
   disabled), reading, writing, unsaved changes, write refused by the module, firmware too old, error.
5. **Acceptance checks** per key flow, written as plain Playwright-style steps ("click X, expect Y") that can be
   run against the simulator (CoffeeDingoSim) with the real firmware.
6. **Realistic content**: use the attached screenshots' kind of data (7 modules, 8 outputs each, real signal
   names, currents), never lorem ipsum, and always the worst case (32 CAN inputs, long names).

**HTML prototypes** are fine as a way to show interaction, but only built from `tokens.css` and the specified
components, and they are illustration, not the deliverable.

**How it gets built** (plan for this): one **vertical slice** first (the block builder or the output screen, fully
working against the Sim) before the rest goes hi-fi, so any gap shows up early. The new UI then grows **next to the
old one** (its own route / toggle) screen by screen, with the old UI still there until the parity checklist is all
ticked. No big-bang switch.

**The existing API** (the data contract; group and rename for the user, never for the wire):
- Connect: `GET /api/adapters`, `POST /api/connect`, `POST /api/disconnect`, `POST /api/usb/identify`, `GET /api/discover`, `GET /api/identify`
- Modules: `GET/POST /api/devices`, `GET /api/definitions`, `POST /api/devices/{id}/rename|modify|remove|add-like`, `POST /api/devices/{id}/{read|readall|write|writeall|burn|sleep|wakeup|version|bootloader}`, `GET /api/devices/{id}/config-diff`
- Outputs: `POST /api/devices/{id}/output`, `…/outputconfig`, `…/output/{n}/test`, `GET …/overloads` (trip log), `POST …/overloads/clear`
- Signals & logic: `GET …/inputs`, `GET …/functions`, `POST …/function/{kind}/{n}`, `POST …/device-inputs`, `GET …/signals`, `GET …/broadcast-signals`, `POST …/link-remote`, `POST /api/probe`
- Params: `POST …/readparam`, `POST …/writeparam`, `GET /api/config/schema`, `GET/POST /api/config`
- Lua: `GET/POST …/lua`, `GET …/luaerror`
- DBC / ECU: `GET …/dbc/signals`, `GET …/dbc/search`, `POST /api/devices/dbc-import`, `POST …/dbc/open`, `POST …/dbc/signal`
- Templates: `POST /api/preview`, `POST /api/apply`, `POST /api/remove`, `GET/PUT /api/instances`
- Cross-module: `GET /api/system/cross-module`, `POST /api/system/cross-module/deploy`, `GET /api/can-id-map`
- Keypads: `POST /api/sdo/read|write|store`
- Firmware: `POST …/flash`, `POST /api/flash/blank`, `GET /api/flash/status`, `GET /api/flash/dfu`, `POST …/flash-can`, `GET /api/flash-can/status`
- Project: `GET /api/project`, `POST /api/project/save|open|new|upload`, `GET /api/project/download`, `POST …/apply-profile`
- Logs: `GET /api/canlog`, `GET /api/syslog`, `…/export`, `POST /api/canlog/record/start|stop`, `GET …/record/status|download`, `GET /api/rawlog`
- Sim replay: `POST /api/sim/load|play|pause|reset|loop|rate`, `GET /api/sim/status`
- App: `GET /api/version`; the AI agent server is at `/mcp`.

## Project rules (dingoElectronics CONTRIBUTING)

The work follows https://github.com/corygrant/dingoElec/blob/main/CONTRIBUTING.md. For the design and the build:
- **Small pieces**: plan the build as many small changes (one screen or one component each), each its own PR to a
  `development` branch, never one giant change. Match the surrounding code style; no reformatting of untouched
  files; no build output committed.
- **No version bumps** in the work itself (the maintainer bumps versions at release).
- **Firmware and app together**: anything that needs a new CAN message, parameter or enum (e.g. the Ignition
  block) is a firmware change *and* an app change: two linked PRs, the DBC builder updated, and the matching page
  in the dingoElec docs updated. Design those features so the screen also works (greyed out with "needs firmware
  vX") on a module running older firmware.
- **Docs**: every screen that changes what a user sees needs its user documentation updated. Deliver a short doc
  outline per area (what it is for, how to do the common task, what can go wrong).
- **Say what was tested**: each build step states whether it ran against the Sim or real hardware, on which
  device and board revision.
- **Safety first**: these modules switch real loads in vehicles. Every design that can switch an output, flash
  firmware, change current limits or fault handling, or put modules to sleep must show **what happens when it
  goes wrong** (link lost mid-flash, module refuses a value, a test left running, a wrong board's firmware), not
  only the happy path. Destructive or load-switching actions are clearly marked, confirmable, and time-limited
  where it makes sense.

## Deliverables

**Feature parity from the first deliverable.** The very first version of the new design must cover
**everything the current UI does**: every item in the *Full feature inventory*, no "phase 2" for existing
features. Nothing a user can do today may be missing, hidden without a path, or left for later. The *New
features to design in* are **also part of the first round**: design them fully, marked in the parity checklist
as "new" (they need firmware that is not released yet, so they show as "needs firmware vX" on older modules).
Include a **parity checklist**: each inventory item → the screen and level (Simple / Custom / Expert) where it
lives in the new design.

1. Information architecture: the new navigation and where every inventory item lives (Simple / Custom /
   Expert), as a map, with the parity checklist.
2. Low-fi wireframes for all key flows, then hi-fi designs for: car overview, function list, block builder
   (sentence + canvas + simulate + live), output detail, input/sensor setup (incl. rotary calibration), template
   wizard, connect/discovery, apply/save status, firmware update (single + all), diagnostics (trip log, plot,
   CAN log), settings/sleep sequence, expert drawer (Lua, CAN, MCP).
3. A small component library: block, port, wire, live value, status chip, sentence token, signal picker,
   output row, connector-pin label, notification bar, empty states.
4. Light **and** dark themes (garage in daylight; night at the track), WCAG AA contrast, colour never the only
   signal (on/off/fault also by shape or text). **Visual identity is free hand** (only the dingoConfig name is
   kept), but **every colour is a global token** in `tokens.css`: semantic names (`--color-surface`,
   `--color-text`, `--color-accent`, `--color-on`, `--color-fault`, `--color-warn`, wire colours, chart series…)
   defined once per theme. No colour value appears anywhere else in components or screens, so the whole look
   can be re-coloured later by editing that one file.
5. Desktop-first (1280–1920 wide laptop), usable on a 13" laptop; a reduced tablet/phone layout for live
   monitoring and testing next to the car.
6. A short rationale per major decision, tied to the user types and the research.
7. **Build-ready package** (see *Implementation contract*): `tokens.css`; a component spec per component; a
   screen spec per screen with its data bindings and API calls; the list of **API gaps**; acceptance checks per
   key flow; a doc outline per area; and a proposed **build order** of small PRs, vertical slice first.

## How to run this: agents, models, and what each delivers

Run it as an orchestrated job, one phase at a time, with a review stop after each phase. Models: **Opus 5.5** where
judgment and the big picture matter, **Sonnet 5.5** for focused design and build work, **Haiku 5.5** for fast
mechanical checks.

| Level | Role | Model | Delivers |
|---|---|---|---|
| Orchestrator | Lead designer: owns the brief, the IA, the parity checklist and every review | Opus 5.5 | Phase plan, IA map, parity checklist, the final review of each phase |
| Subagent | Research: competitor screenshots and videos, beyond the summary here | Sonnet 5.5 | Annotated reference board per vendor ("steal / avoid") |
| Subagent | Design system: tokens and components | Opus 5.5 | `tokens.css`, component specs, component sheet (light + dark) |
| Subagent | Block builder (the hardest screen) | Opus 5.5 | Sentence view, canvas view, simulate, live states, specs and acceptance checks |
| Subagent, one per flow | Flow designer: one key flow each (first car setup, add a function, why did it trip, pit-lane change, firmware, installer, expert, push-button start, flat battery) | Sonnet 5.5 | Low-fi wireframes, then hi-fi screens and screen specs for that flow |
| Subagent | Parity and data checker | Sonnet 5.5 | Every inventory item mapped to a screen; every value bound to an API field; API gaps listed |
| Sub-subagent (under each flow designer) | Accessibility check: contrast, focus order, names, colour-only signals | Haiku 5.5 | Pass/fail list per screen |
| Sub-subagent (under each flow designer) | Token and component lint: only tokens and existing components used | Haiku 5.5 | List of hard-coded values or one-off components to fix |
| Sub-subagent (under the parity checker) | Inventory diff: checklist vs. the inventory, line by line | Haiku 5.5 | Missing or duplicated items |
| Subagent (build phase) | Implementer: one screen or component per PR, in the real app, against the Sim | Sonnet 5.5 (Opus 5.5 for the block builder) | A small PR with tests and the "tested on" note |
| Sub-subagent (under the implementer) | Code review and silent-failure review of that PR | Sonnet 5.5 | Review findings fixed before the PR is opened |

Order: research + design system → IA + parity checklist (**review**) → block builder low-fi + flows low-fi
(**review**) → hi-fi (**review**) → parity / data / accessibility pass (**review**) → vertical slice built
(**review**) → the remaining screens as small PRs.

## Constraints

- Web app in the browser, served locally; must work offline. Built in Svelte 5 on the existing REST API; no
  heavy design dependencies needed, but propose freely (any library must be small, offline-capable and fit
  Svelte).
- Hardware limits are real: block counts per module are fixed by the firmware (show them, don't hide them).
- Live data arrives at roughly 10–15 updates per second per module; design for it without flicker.
- Several modules, one project file = one car.
- Big touch/click targets for the garage; full keyboard control for the pit lane; a command palette (Ctrl+K)
  that can reach every action and setting.
- Don't name any real vehicle model in examples; use generic cars.
- **English only** (no translation layer needed).
