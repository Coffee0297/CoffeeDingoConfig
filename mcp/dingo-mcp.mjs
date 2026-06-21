#!/usr/bin/env node
// dingoPDM MCP stdio<->HTTP bridge.
//
// The MCP server itself now lives INSIDE the dingoConfig .NET app (single source of truth)
// and speaks Streamable-HTTP JSON-RPC 2.0 at  POST {DINGO_URL}/mcp. This script is a thin
// bridge for MCP clients that only speak stdio: it forwards every newline-delimited JSON-RPC
// message to /mcp and pipes the response back. All tools and skills are defined in C#
// (web/Api/McpServer.cs) — there is nothing tool-specific to maintain here.
//
// Register in your MCP client's config (project .mcp.json or the client's config file):
//   { "mcpServers": { "dingopdm": { "command": "node", "args": ["mcp/dingo-mcp.mjs"],
//                                   "env": { "DINGO_URL": "http://localhost:5000" } } } }
//
// Clients that speak Streamable-HTTP directly can skip this bridge and point at:
//   { "mcpServers": { "dingopdm": { "url": "http://localhost:5000/mcp" } } }

const BASE = (process.env.DINGO_URL || 'http://localhost:5000').replace(/\/$/, '')
const ENDPOINT = BASE + '/mcp'
const log = (...a) => process.stderr.write('[dingo-mcp] ' + a.join(' ') + '\n')

// Forward one JSON-RPC message to /mcp. Returns the parsed response object, or null for
// notifications (HTTP 202, no body) so the caller writes nothing back to stdout.
async function forward(msg) {
  let r
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(msg),
    })
  } catch (e) {
    // Transport failure (app not running). Only answer requests, never notifications.
    if (msg && msg.id !== undefined && msg.id !== null)
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: `cannot reach dingoConfig at ${ENDPOINT}: ${e.message}` } }
    return null
  }
  if (r.status === 202) return null
  const text = await r.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

// stdio loop: newline-delimited JSON-RPC in, newline-delimited JSON-RPC out.
let buf = ''
const pending = new Set()
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { log('bad json:', line); continue }
    const p = forward(msg)
      .then(res => { if (res) process.stdout.write(JSON.stringify(res) + '\n') })
      .catch(e => log('forward error:', e.message))
      .finally(() => pending.delete(p))
    pending.add(p)
  }
})
// Wait for any in-flight forwards to finish before exiting (don't drop the last response).
process.stdin.on('end', async () => {
  while (pending.size) await Promise.allSettled([...pending])
  process.exit(0)
})
log('bridge ready ->', ENDPOINT)
