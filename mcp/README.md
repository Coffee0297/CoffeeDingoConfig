# dingoPDM MCP server

Lets any MCP-capable AI client configure an entire dingoPDM system over the dingoConfig HTTP
API — **no Playwright / UI scraping**. Zero dependencies; needs Node 18+ (for global `fetch`).
Start the dingoConfig app first (default `http://localhost:5000`).

## Auto-connect

- **Clients with project config:** the project [`.mcp.json`](../.mcp.json) registers the
  `dingopdm` server automatically (approve it once if prompted). The tools then appear.
- **Any AI client at runtime:** fetch [`/llms.txt`](http://localhost:5000/llms.txt) from the
  running app — it advertises the API and this server.

## Manual register

Add this server to your MCP client's config (JSON):
```json
{ "mcpServers": { "dingopdm": {
  "command": "node",
  "args": ["/abs/path/to/mcp/dingo-mcp.mjs"],
  "env": { "DINGO_URL": "http://localhost:5000" }
} } }
```

Point `DINGO_URL` at the host running dingoConfig if it isn't local.

## Tools

`list_adapters` · `connect` · `disconnect` · `discover` · `list_devices` · `add_device` ·
`remove_device` · `read_device` · `get_schema` · `get_config` · `apply_config` ·
`device_action` (read/write/burn/sleep/wakeup/bootloader) · `sdo_read` · `sdo_write`

**Flow:** `connect` → `discover`/`add_device` → `read_device` → `get_schema` → `get_config` →
`apply_config`. Every setting is reachable by name (e.g. `device.sleepTimeoutMs`,
`output1.currentLimit`) — see [AI-CONFIG.md](../AI-CONFIG.md).

## Smoke test (no AI client)
```
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/dingo-mcp.mjs
```
Prints the tool catalog as JSON.
