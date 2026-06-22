# dingoPDM MCP server

Lets any MCP-capable AI client drive an entire dingoPDM system over the dingoConfig API —
**no Playwright / UI scraping**. Every capability in the UI is exposed as an MCP tool, plus
seven guided **skills** (playbooks). Start the dingoConfig app first (default
`http://localhost:5000`).

## Where the server lives

The MCP server is **hosted inside the dingoConfig .NET app** (single source of truth — tools
and skills are defined once in `web/Api/McpServer.cs`). It speaks **Streamable-HTTP JSON-RPC
2.0** at:

```
POST http://localhost:5000/mcp
```

`mcp/dingo-mcp.mjs` is now a thin **stdio↔HTTP bridge** for clients that only speak stdio — it
forwards each JSON-RPC line to `/mcp`. There is nothing tool-specific to maintain in the Node
script anymore.

## Connect

Pick whichever your client supports:

**A. HTTP — recommended (GitHub Copilot CLI, Claude Code, any Streamable-HTTP client):**
```json
{ "mcpServers": { "dingopdm": { "type": "http", "url": "http://localhost:5000/mcp" } } }
```
The project [`.mcp.json`](../.mcp.json) already registers this (approve once if prompted). Both
Copilot CLI (`~/.copilot/mcp-config.json`) and Claude Code (`claude mcp add --transport http` or a
project `.mcp.json`) accept this form. No script, no file path — the app just has to be running.

**B. stdio bridge — fallback for stdio-only clients:**
```json
{ "mcpServers": { "dingopdm": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/path/to/CoffeeDingoConfig/mcp/dingo-mcp.mjs"],
  "env": { "DINGO_URL": "http://localhost:5000" }
} } }
```
Use an **absolute** path for `args` — stdio clients launch `node` from their own working directory,
so a relative path fails to load ("Connection closed"). The MCP tab in the UI emits the correct
absolute path for this machine. Point `DINGO_URL` at the host running dingoConfig if it isn't local.
Node 18+ (global `fetch`).

**In-app setup:** open the **MCP** tab in the dingoConfig UI — it shows the endpoint, a
"Test connection" button, copy-paste configs, and the live tool + skill catalog. The same data
is available at `GET /mcp/info`.

## Discovery endpoints

- `GET /mcp` — health/handshake summary (tool + skill counts)
- `GET /mcp/info` — full catalog + copy-paste client configs (what the UI tab renders)
- `GET /mcp/skills` and `GET /mcp/skills/{id}` — the guided playbooks as markdown

## Tools (48)

Every UI capability is a tool. Highlights, grouped:

- **Connection:** `list_adapters` · `connect` · `disconnect` · `discover` · `identify` ·
  `probe` · `raw_log`
- **Devices:** `list_devices` · `add_device` · `remove_device` · `rename_device` ·
  `modify_device` · `read_device` · `device_action` (read/write/burn/sleep/wakeup/bootloader) ·
  `apply_profile`
- **Config:** `get_schema` · `get_template` · `get_config` · `apply_config`
- **Outputs:** `set_output` · `set_output_config` · `get_overloads` · `clear_overloads`
- **Params:** `read_param` · `write_param`
- **Signals & logic:** `get_inputs` · `get_functions` · `set_function` · `get_signals` ·
  `get_dbc_signals` · `open_dbc` · `set_dbc_signal` · `get_lua` · `set_lua` · `get_lua_error`
- **Firmware:** `flash_firmware` · `flash_status`
- **Keypad (CANopen SDO):** `sdo_read` · `sdo_write` · `sdo_store`
- **Project:** `get_project` · `project_new` · `project_open` · `project_save`
- **Logs:** `get_canlog` · `get_syslog` · `export_canlog` · `export_syslog`

The full list with input schemas is returned by `tools/list`.

## Skills (7)

Guided playbooks served as MCP **prompts** (`prompts/list`, `prompts/get`) and at
`/mcp/skills`:

`connect-and-discover` · `configure-a-module` · `wire-outputs-safely` · `signals-and-logic` ·
`flash-firmware` · `keypad-sdo` · `logs-and-troubleshooting`

## Honest writes

Writes are queued and acknowledged by the device. A tool result with **`isError: true`** means
the operation did **not** complete (e.g. the module never acknowledged). Never report success
on an `isError` result.

## Smoke test (no AI client)

HTTP:
```
curl -s http://localhost:5000/mcp -H "Content-Type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```
Through the stdio bridge:
```
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | node mcp/dingo-mcp.mjs
```
