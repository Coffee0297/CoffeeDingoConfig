#!/usr/bin/env node
// dingoPDM MCP server — lets any MCP-capable AI client drive the whole system over the
// dingoConfig HTTP API (no Playwright / UI scraping). Zero dependencies: speaks JSON-RPC 2.0
// over stdio (newline-delimited), proxies to http://localhost:5000 by default (env DINGO_URL).
//
// Register in your MCP client's config (project .mcp.json or the client's config file):
//   { "mcpServers": { "dingopdm": { "command": "node", "args": ["mcp/dingo-mcp.mjs"],
//                                   "env": { "DINGO_URL": "http://localhost:5000" } } } }

const BASE = (process.env.DINGO_URL || 'http://localhost:5000').replace(/\/$/, '')
const log = (...a) => process.stderr.write('[dingo-mcp] ' + a.join(' ') + '\n')

async function http(method, path, body) {
  const opt = { method, headers: {} }
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body) }
  const r = await fetch(BASE + path, opt)
  const text = await r.text()
  let data; try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
  return data
}

// ---- tools: each maps to one HTTP call. Together they configure an entire system. ----
const TOOLS = [
  { name: 'list_adapters', description: 'List CAN adapters + serial ports and current connection state.',
    schema: { type: 'object', properties: {} },
    run: () => http('GET', '/api/adapters') },

  { name: 'connect', description: 'Connect to a CAN adapter. adapter e.g. "USB"/"SLCAN"/"PCAN"/"Sim", port e.g. "COM3", bitrate e.g. "500K".',
    schema: { type: 'object', required: ['adapter', 'port', 'bitrate'],
      properties: { adapter: { type: 'string' }, port: { type: 'string' }, bitrate: { type: 'string', enum: ['1000K', '500K', '250K', '125K', '100K'] } } },
    run: (a) => http('POST', '/api/connect', { Adapter: a.adapter, Port: a.port, Bitrate: a.bitrate }) },

  { name: 'disconnect', description: 'Disconnect from the CAN adapter.',
    schema: { type: 'object', properties: {} },
    run: () => http('POST', '/api/disconnect') },

  { name: 'discover', description: 'Scan the bus and return modules (base IDs) currently broadcasting.',
    schema: { type: 'object', properties: {} },
    run: () => http('GET', '/api/discover') },

  { name: 'list_devices', description: 'List devices in the project with live state (guid, name, type, baseId, connected, version, outputs).',
    schema: { type: 'object', properties: {} },
    run: () => http('GET', '/api/devices') },

  { name: 'add_device', description: 'Add a module to the project. type e.g. "pdm"/"canboard", baseId hex ("0xDE") or decimal.',
    schema: { type: 'object', required: ['type', 'baseId'],
      properties: { type: { type: 'string' }, name: { type: 'string' }, baseId: { type: 'string' } } },
    run: (a) => http('POST', '/api/devices', { Type: a.type, Name: a.name ?? a.type, BaseId: String(a.baseId) }) },

  { name: 'remove_device', description: 'Remove a module from the project by guid.',
    schema: { type: 'object', required: ['guid'], properties: { guid: { type: 'string' } } },
    run: (a) => http('POST', `/api/devices/${a.guid}/remove`) },

  { name: 'read_device', description: 'Read the full config of a module off the device (so get_config reflects live values).',
    schema: { type: 'object', required: ['guid'], properties: { guid: { type: 'string' } } },
    run: (a) => http('POST', `/api/devices/${a.guid}/read`) },

  { name: 'get_schema', description: 'Every device and EVERY setting it has: name, type (bool/int/float/enum), default, enum options, plus the var-map signal names. Start here to learn valid setting names.',
    schema: { type: 'object', properties: {} },
    run: () => http('GET', '/api/config/schema') },

  { name: 'get_config', description: 'Current value of every setting on every module (a snapshot). Call read_device first for live values. lua=true also reads each module\'s Lua program (slower).',
    schema: { type: 'object', properties: { lua: { type: 'boolean' } } },
    run: (a) => http('GET', '/api/config' + (a.lua ? '?lua=true' : '')) },

  { name: 'apply_config', description: 'Apply a full or partial config document. Writes only settings that differ, then burns (unless burn:false), and uploads Lua. Returns a per-setting report. Match each device by guid, baseId, or name. Setting names come from get_schema (e.g. "device.sleepTimeoutMs", "output1.currentLimit").',
    schema: { type: 'object', required: ['devices'], properties: {
      burn: { type: 'boolean' },
      devices: { type: 'array', items: { type: 'object', properties: {
        guid: { type: 'string' }, baseId: { type: 'number' }, name: { type: 'string' },
        params: { type: 'object', description: 'map of settingName -> value' },
        lua: { type: 'string' }, burn: { type: 'boolean' } } } } } },
    run: (a) => http('POST', '/api/config', a) },

  { name: 'device_action', description: 'Run a device action: read, write, writeall, burn, sleep, wakeup, bootloader.',
    schema: { type: 'object', required: ['guid', 'action'],
      properties: { guid: { type: 'string' }, action: { type: 'string', enum: ['read', 'write', 'writeall', 'burn', 'sleep', 'wakeup', 'bootloader'] } } },
    run: (a) => http('POST', `/api/devices/${a.guid}/${a.action}`) },

  { name: 'sdo_read', description: 'CANopen SDO read (keypad device settings). node = keypad node id, index hex (e.g. 4120 for 0x1018), sub.',
    schema: { type: 'object', required: ['node', 'index', 'sub'],
      properties: { node: { type: 'number' }, index: { type: 'number' }, sub: { type: 'number' } } },
    run: (a) => http('POST', '/api/sdo/read', { Node: a.node, Index: a.index, Sub: a.sub }) },

  { name: 'sdo_write', description: 'CANopen SDO write (keypad device settings). size 1/2/4 bytes.',
    schema: { type: 'object', required: ['node', 'index', 'sub', 'value', 'size'],
      properties: { node: { type: 'number' }, index: { type: 'number' }, sub: { type: 'number' }, value: { type: 'number' }, size: { type: 'number', enum: [1, 2, 4] } } },
    run: (a) => http('POST', '/api/sdo/write', { Node: a.node, Index: a.index, Sub: a.sub, Value: a.value, Size: a.size }) },
]

// ---- JSON-RPC 2.0 over stdio (newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'dingopdm', version: '1.0.0' },
      instructions: 'Configure a dingoPDM CAN power-distribution system. Flow: connect -> discover/add_device -> read_device -> get_schema -> get_config -> apply_config. Every setting is reachable by name via get_schema/apply_config.'
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return // no response
  if (method === 'ping') { reply(id, {}); return }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) })
    return
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) { fail(id, -32602, `unknown tool: ${params?.name}`); return }
    try {
      const out = await tool.run(params.arguments || {})
      reply(id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] })
    } catch (e) {
      reply(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true })
    }
    return
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { log('bad json:', line); continue }
    Promise.resolve(handle(msg)).catch((e) => log('handler error:', e.message))
  }
})
process.stdin.on('end', () => process.exit(0))
log('ready, proxying', BASE)
