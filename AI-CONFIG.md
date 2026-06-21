# AI system configuration

A declarative, self-describing config surface so an AI model can read and write **every
setting on every module** without knowing CAN indices or wire formats.

It is built directly over each device's `IDeviceConfigurable.Params` list — the same list the
firmware exposes and the UI edits — so it is **complete by construction**: every setting that
exists is reachable, and any new firmware parameter shows up automatically with zero extra code.

## Why this design

| Option | Verdict |
|---|---|
| One endpoint per setting | ❌ thousands of routes, drifts from firmware |
| Raw `writeparam index/sub/value` | ❌ AI must know CAN indices + float/enum/bit encoding |
| **Schema + snapshot + apply over `Params`** | ✅ stable names, typed, validated, idempotent, auto-complete |

The agent works in three moves: **discover → read → write**, all by stable name
(`device.sleepTimeoutMs`, `output1.currentLimit`, …) — never a CAN index.

## The contract (3 endpoints)

### 1. `GET /api/config/schema` — what can be configured
Every device, every setting, with type/default/enum options + the var-map (signal names):
```json
{ "devices": [ {
  "guid": "…", "name": "front left", "type": "dingoPDM", "baseId": 222, "connected": true,
  "params": [
    { "name": "device.sleepEnabled",   "type": "bool", "default": false },
    { "name": "device.sleepTimeoutMs", "type": "int",  "default": 30000 },
    { "name": "device.canSpeed",       "type": "enum", "default": "BitRate500K",
      "options": ["BitRate1000K","BitRate500K","BitRate250K","BitRate125K","BitRate100K"] },
    { "name": "output1.currentLimit",  "type": "float","default": 20.0 }
  ],
  "varMap": [ {"index":1,"name":"Always On"}, {"index":2,"name":"State"}, … ],
  "lua": true
} ] }
```

### 2. `GET /api/config` — current values (snapshot)
Read the device(s) first (`POST /api/devices/{guid}/read`) so values are live. Add `?lua=true`
to also pull each module's Lua program (slower).
```json
{ "devices": [ {
  "guid":"…","name":"front left","type":"dingoPDM","baseId":222,"connected":true,
  "params": { "device.sleepEnabled": false, "device.sleepTimeoutMs": 30000,
              "output1.currentLimit": 20.0, "output1.input": 2, … },
  "lua": null
} ] }
```

### 3. `POST /api/config` — apply a target document
Send a **full or partial** document. The service matches each device (by `guid`, else `baseId`,
else `name`), **coerces and validates each value to the setting's exact type**, writes **only the
settings that differ**, then **burns** (unless `burn:false`), and uploads Lua if present.
```json
{
  "burn": true,
  "devices": [
    { "guid": "…",
      "params": {
        "device.sleepEnabled": true,
        "device.sleepTimeoutMs": 12000,
        "device.canSpeed": "BitRate500K",
        "output1.name": "Headlights",
        "output1.currentLimit": 25.0,
        "output1.input": 2
      },
      "lua": "setTickRate(50)\nsetLuaOut(0, readVar(1))\n"
    }
  ]
}
```
Response is a report:
```json
{ "ok": true, "devicesTouched": 1, "paramsChanged": 6,
  "notes": ["front left: Lua uploaded","front left: burned"], "errors": [] }
```
Unknown setting names, bad values, and unmatched devices come back in `errors` (the rest still
applies). `device.baseId` is intentionally skipped here — change a base ID via
`POST /api/devices/{guid}/modify` so the device can be re-targeted cleanly.

## Typical agent loop
1. `GET /api/config/schema` — learn the modules + valid setting names, types, enum options.
2. `POST /api/devices/{guid}/read` for each module, then `GET /api/config` — see current state.
3. Build the target document and `POST /api/config`.
4. Check the report; re-read to confirm.

## Coverage
- **Every device parameter** (outputs, inputs, CAN in/out, conditions, counters, flashers,
  virtual inputs, keypads, wiper, device/sleep/bitrate settings, …) — automatically.
- **Lua** program per module (read via `?lua=true`, write via the `lua` field).
- Base ID / name via `/modify`; keypad CANopen device settings via `/api/sdo/*`.

## MCP server (shipped)

A full MCP server is **hosted inside this app** at `POST /mcp` (Streamable-HTTP JSON-RPC 2.0).
It exposes **every UI capability as a tool (48)** — not just these three config endpoints — plus
seven guided **skills** (playbooks). `get_schema` / `get_config` / `apply_config` are the
config-surface tools; the rest cover connection, devices, outputs, signals/logic, firmware,
keypad SDO, project, and logs. The HTTP API stays the single source of truth — the MCP server
loops back to `/api/*`, so all validation and honest-write behaviour is reused. See
[mcp/README.md](mcp/README.md) and the in-app **MCP** tab (or `GET /mcp/info`).
