# dingoConfig

Configuration and live-monitoring tool for **dingoPDM** CAN power-distribution modules and
**CANBoard** I/O modules. A single self-contained app (lean ASP.NET .NET 10 backend + Svelte/Vite
SPA) that owns the CAN link — runs on **Windows, macOS, and Linux**.

> **Firmware:** built for the matching **dingoPDM firmware**
> ([CoffeeDingoFW v5.5.101](https://github.com/Coffee0297/CoffeeDingoFW/releases)). The advanced
> features — Lua scripting, the on-device overload/trip log, warning & open-load detection, and
> input-driven sleep — only work on that build. The tool expects firmware **≥ 5.5.100** and shows a
> "firmware needs updating" notice below that.

![System view — a 5-PDM + 3-CANBoard vehicle](docs/img/system.png)

> The screenshots below are a sample **5×dingoPDM + 3×CANBoard** vehicle. One module ("Front Left")
> is live on the bus; the rest are configured-but-offline ("not found").

---

## Contents
- [Features](#features)
- [Supported hardware](#supported-hardware)
- [Install & run](#install--run)
- [Build from source](#build-from-source)
- [Distribute (Windows / macOS / Linux)](#distribute-windows--macos--linux)
- [Drive it from an AI model (MCP)](#drive-it-from-an-ai-model-mcp)
- [Project layout](#project-layout)

---

## Features

### System overview & car layout
Every module on the bus in one place — live current/temperature/state per module, a draggable
**car-layout map** to match your physical install, in-app **firmware update** and **⚙ Settings**
per module, and **cross-module functions** (define a behaviour once across modules). Live modules
show green; project modules not seen on the bus are flagged.

### Outputs — smart high-side switches
![Outputs](docs/img/outputs.png)

Each output is a current-sensing smart switch. Per output:
- **Input/rule** — the signal that turns it on (a pin, CAN signal, condition, virtual input, or Lua slot)
- **Current limit + inrush limit/time** — trip protection with a higher allowance during inrush (bulbs, motors)
- **Reset mode** — none / count (retry N times) / endless, with reset time
- **Warning limit & open-load detection** — flag a soft over-current or a disconnected load without tripping
- **PWM & soft-start** — drive at a duty cycle / frequency, or ramp up
- Live state + current, with a per-output mini graph

Save writes live to the device; **Burn** persists to flash.

### Signals & logic
![Signals & logic with live mini-charts](docs/img/signals.png)

Build logic from physical pins and CAN messages. Each block type has a guided editor:
- **CAN input** — pull a value/bit out of an incoming frame (factor/offset/byte-order/signed)
- **Digital pin** — physical input (momentary/latched, pull, debounce, invert)
- **Condition** — true when a signal crosses a value
- **Virtual input** — AND/OR/NOR up to 3 signals
- **Flasher** — blink pattern (on/off times, single-shot)
- **Counter** — count up/down/reset events
- **CAN output** — transmit any variable on the bus
- **Analog input (CANBoard)** *(new in v0.5.0-rc.1)* — use one analog input as an **on/off switch**
  (single threshold) **or** a **multi-position / rotary switch**. Design a standard-resistor ladder
  (auto pull-up + even spread) or **calibrate an existing switch** by capturing the live voltage at
  each detent — uneven steps decode via per-position tolerance windows (a reading outside every
  window reads "no position"). Needs CoffeeDingoFW ≥ v5.5.101. See [CHANGELOG](CHANGELOG.md).

Every row carries a **live mini-chart** (last 30 s) — the flasher rows above show their square-wave
output in real time.

### Wiring — node graph
![Wiring graph](docs/img/wiring.png)

A visual node-graph of a module's functions. Drag from a **purple output ●** to a **green input ●**
to wire one function into another; delete a block with its **✕** or by selecting it and pressing
**Delete**. `+ Add node` creates functions; `+ Remote signal` pulls a signal from another module
over CAN. Changes write live — Burn to keep.

### Lua scripting
Any output / virtual input / CAN output can be driven by a **Lua slot**. There's a global/shared
section plus per-function snippets, assembled into one program and uploaded to the device
(`setTickRate`, `readVar`, `setLuaOut`, `txCan`, `canRxAdd`, `onCanRx`, timers, …). Runtime errors
are read back from the device.

### Cross-module functions
Define a behaviour once that spans modules (e.g. a synchronised blinker triggered on one PDM,
clocked by another). A **rule** compiles to native CAN-input/flasher/output wiring (no Lua);
switch it to **Lua** to write it yourself — needed for clock-failover. Deploy pushes it to every
involved module.

### Plot
![Global plot](docs/img/plot.png)

Chart **any signal from any module** live. Add as many series as you like, toggle lines via the
legend chips, pause, pick the time window, and **export a PNG**.

### Dashboard
Live state of the selected module — battery, total current, board temperature, every output — plus
Read / Write / Burn and Sleep / Wakeup controls.

### Sleep (auto + input-driven)
![Device settings — sleep](docs/img/settings.png)

Per-module sleep behaviour, written and burned to the device:
- **Auto-sleep** with a configurable timeout (sleeps after outputs off, USB unplugged, CAN idle)
- **Ignore always-on outputs** so sleep can still be reached
- **Sleep input** — a digital input drives sleep directly; configurable sleep level; only that
  input wakes (no waking on other inputs/CAN); USB still wakes it for config
- A CAN sleep command waits ~2 s for the bus to settle, and sleeping is refused while USB is
  connected (prevents the wake-reset soft-lock)

### Firmware update (in-app DFU)
Update a module's firmware over USB DFU from the **⬆ Firmware** button — the app commands the
module into its bootloader and flashes the `.bin` with a live progress bar. BOOT0 recovery is
always available.

### Keypads (Blink Marine / Grayhill)
Configure keypad buttons (action, LED colour, what the LED mirrors) and the keypad's own persistent
**CANopen device settings** via an **SDO** panel (read identity, save-to-NV, expert read/write of
any object-dictionary entry).

### DBC devices
Open a `.dbc` file, add custom signals, and read live decoded values from third-party CAN devices.

### Logs
Live CAN traffic and a system log, both exportable to CSV. Modules also keep an on-device
**overload (trip) log** with a current waveform around each trip, readable for troubleshooting.

### Contextual help
![Per-view help](docs/img/help.png)

A **`?`** button in the top bar opens concise help for whatever view you're on.

---

## Supported hardware

**Adapters** (pick on the Connect screen):

| Adapter | Windows | macOS | Linux |
|---|:---:|:---:|:---:|
| **SLCAN** (CANable/CANtact serial, and the PDM's own USB) | ✅ | ✅ | ✅ |
| **PCAN** (PEAK) | ✅ | — | — |
| **SocketCAN** | — | — | ✅ |
| **Sim** (replay a CAN capture) | ✅ | ✅ | ✅ |

**Modules:** dingoPDM (V7), dingoPDM-MAX, CANBoard, plus Blink Marine / Grayhill keypads and
generic DBC devices.

---

## Install & run

1. Download the zip for your platform from a release (or build it — see below) and unzip.
2. Run the app:
   - **Windows:** double-click `dingoConfig.exe` (a browser opens at <http://localhost:5000>).
   - **macOS:** `chmod +x dingoConfig` then run it. First launch is blocked by Gatekeeper
     (unsigned) — `xattr -dr com.apple.quarantine dingoConfig`, or right-click → Open. Browse to
     <http://localhost:5000>.
   - **Linux:** `chmod +x dingoConfig && ./dingoConfig`, then browse to <http://localhost:5000>.
     Serial access needs your user in the `dialout` group (`sudo usermod -aG dialout $USER`, re-login).
3. **Connect** — pick the adapter, port (e.g. `COM3` / `/dev/ttyACM0`), and bitrate (e.g. `500K`).
4. **🔍 Add from USB** scans the bus and adds each module at its correct base ID.
   > A dingoPDM broadcasts status starting at `BaseId + 2`, so a module whose status frames are at
   > `0x0E0…` has base ID `0x0DE`. Discovery handles this `−2` automatically — entering the broadcast
   > ID by hand is the classic "read hangs / is slow" trap.
5. **Read** the config, edit outputs/signals, **Deploy/Write** to push, **Burn** to persist to flash.
   **Project ▾** saves/opens configs as JSON (in `~/Documents/dingoConfig`).

No runtime install is required — the builds are self-contained (the .NET runtime is bundled).

---

## Build from source

Prerequisites: **.NET 10 SDK** and **Node 18+**.

```bash
# 1. Frontend — Vite emits the SPA into web/wwwroot (the backend serves it)
cd web/clientapp
npm install
npm run build

# 2. Run (serves http://localhost:5000)
cd ../..
dotnet run --project web -c Release
```

> Build the frontend **first** — the backend serves the SPA from `web/wwwroot`; without it the page
> is blank. `dotnet run --project web` sets the content root correctly. If you run the built DLL
> directly, run it from the `web/` folder (or pass `--contentRoot <path-to-web>`).

**Dev mode (hot-reload UI):** two terminals — Vite (`:5173`) proxies `/api` + `/hub` to the backend (`:5000`):
```bash
dotnet run --project web                 # terminal 1 → :5000 (API + CAN)
cd web/clientapp && npm run dev           # terminal 2 → :5173 (UI, hot reload)
```

---

## Distribute (Windows / macOS / Linux)

Use the bundled scripts — they build the SPA, then publish a **single self-contained launcher
`dingoConfig(.exe)` per platform** and zip each into `publish/dingoConfig-<version>/`. The SPA and
device definitions are **embedded in the exe**, so it's one file: copy it anywhere and run it — no
.NET install, no folder, no loose files.

```powershell
./publish.ps1     # run on Windows
```
```bash
./publish.sh      # run on macOS/Linux
```

Targets: `win-x64`, `win-arm64`, `linux-x64`, `linux-arm`, `linux-arm64`, `osx-x64`, `osx-arm64`
(~50–90 MB each). `LINUX` — which enables SocketCAN — is defined automatically for any `linux-*` RID.

Single target manually:
```bash
dotnet publish web/web.csproj -c Release -r osx-arm64 --self-contained true \
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:DebugType=none -o publish/osx-arm64
```

> Want a Windows **installer** (Start-Menu entry, Add/Remove Programs)? Wrap that single exe with
> Inno Setup, WiX, or `dotnet publish -p:PublishProfile=…`/MSIX — but it isn't required, the exe
> runs as-is.

---

## Drive it from an AI model (MCP)

dingoConfig **hosts an MCP server inside the app** so AI clients can drive an entire system
directly — no UI automation. **Every UI capability is exposed as a tool (48)**, plus seven guided
**skills** (playbooks). There's an in-app **MCP** tab (endpoint, *Test connection*, copy-paste
client configs, and the live tool + skill catalog).

- **Transport — HTTP (preferred):** `POST /mcp` (Streamable-HTTP JSON-RPC 2.0). Works with
  **GitHub Copilot CLI and Claude Code** out of the box — no script, no file path, app just has to
  be running. Config:
  ```json
  { "mcpServers": { "dingopdm": { "type": "http", "url": "http://localhost:5000/mcp" } } }
  ```
  The project [`.mcp.json`](.mcp.json) registers this for project-scoped clients (e.g. Claude Code).
- **Transport — stdio bridge (fallback):** [`mcp/dingo-mcp.mjs`](mcp/dingo-mcp.mjs) is a thin
  stdio→`/mcp` forwarder (zero-dependency, Node 18+) for stdio-only clients. Use an **absolute**
  path in `args` — stdio clients launch `node` from their own cwd, so a relative path fails
  ("Connection closed"). The MCP tab emits the correct absolute path; see [`mcp/README.md`](mcp/README.md).
- **Tools (48):** full UI coverage — connection (`list_adapters`/`connect`/`discover`/`identify`),
  devices (`add_device`/`read_device`/`device_action`/`apply_profile`), config
  (`get_schema`/`get_config`/`apply_config`), outputs, params, signals & logic
  (`get_signals`/`set_function`/`get_lua`/`set_lua`), firmware (`flash_firmware`/`flash_status`),
  keypad SDO, project, and logs.
- **Skills (7):** `connect-and-discover`, `configure-a-module`, `wire-outputs-safely`,
  `signals-and-logic`, `flash-firmware`, `keypad-sdo`, `logs-and-troubleshooting`.
- **Discovery:** `GET /mcp` (health) · `GET /mcp/info` (full catalog + copy-paste configs) ·
  `GET /mcp/skills[/{id}]` (playbooks) · [`/llms.txt`](http://localhost:5000/llms.txt) and
  [`AI-CONFIG.md`](AI-CONFIG.md) document the config surface.
- **Honest writes:** a tool result with `isError: true` means the operation did **not** complete
  (no device acknowledgement) — clients must never report success on it.

Agent loop: `connect → discover → read_device → get_schema → get_config → apply_config` — every
setting reachable by name (e.g. `device.sleepTimeoutMs`, `output[1].currentLimit`).

---

## Project layout

```
dingoConfig-redesign/
├── domain/            device model + CAN protocol (dingoPDM, CANBoard, keypads, DBC)
├── application/       services (DeviceManager, SystemConfigService, SdoService, …)
├── infrastructure/    CAN adapters (USB/SLCAN, PCAN, SocketCAN, Sim) + comms pipeline
├── web/               the app
│   ├── Program.cs         DI + serves the SPA + /api + SignalR (single process)
│   ├── Api/LiveApi.cs     REST /api/* + SignalR telemetry hub (/hub/live)
│   ├── Api/McpServer.cs   in-app MCP server (POST /mcp) — 48 tools + 7 skills, loops back to /api
│   ├── clientapp/         Svelte + Vite source → builds into ../wwwroot
│   └── wwwroot/           built SPA (generated by `npm run build`)
├── mcp/               stdio→HTTP bridge for MCP clients that don't speak HTTP
├── AI-CONFIG.md       AI config-surface design
└── llms.txt           AI-client discovery doc (also served at /llms.txt)
```

The backend owns the serial/CAN port; the SPA talks to it over `/api` (REST) and `/hub/live`
(SignalR telemetry push). `web/wwwroot/` is generated from `web/clientapp` — rebuild it after UI changes.
