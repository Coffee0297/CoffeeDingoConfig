// Helpers of the ui-ign specs: the module's own settings over the Sim's SLCAN bridge (SIM_PORT), Sim MCP calls.
import net from 'node:net'
import { SIM_MCP, apiJson, deviceByName } from './api.js'

// the dev server's font files come from the main checkout's node_modules (a junction): 403 there, not an app error
export const appErrors = (errors) => errors.filter((e) => !/Failed to load resource: the server responded with a status of 403/.test(e))
export const fn = async (name) => (await apiJson('GET', `/api/devices/${(await deviceByName(name)).guid}/functions`)).ignition

export async function sim(name, args) {
  const r = await fetch(SIM_MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  return (await r.json()).result
}

const hx = (n, w) => n.toString(16).toUpperCase().padStart(w, '0')
async function slcan() {
  const [host, port] = (process.env.SIM_PORT ?? '').replace('tcp://', '').split(':')
  const s = net.connect(Number(port), host)
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej) })
  s.write('O\r')
  return s
}

/** Read a setting straight from the module (cmd 1 on base+1, reply on base): the module really has it. */
export async function modParam(base, index, sub) {
  const s = await slcan()
  try {
    return await new Promise((res, rej) => {
      let buf = ''
      const t = setTimeout(() => rej(new Error(`no reply 0x${hx(base, 3)} ${hx(index, 4)}.${sub}`)), 8000)
      s.on('data', (d) => {
        buf += d.toString('latin1')
        for (const line of buf.split('\r').slice(0, -1)) {
          const b = (i) => parseInt(line.slice(5 + 2 * i, 7 + 2 * i), 16)
          if (line[0] === 't' && parseInt(line.slice(1, 4), 16) === base && b(1) === (index & 0xff) && b(2) === index >> 8 && b(3) === sub && b(0) === 1) {
            clearTimeout(t); res((b(4) | b(5) << 8 | b(6) << 16 | b(7) << 24) >>> 0)
          }
        }
        buf = buf.slice(buf.lastIndexOf('\r') + 1)
      })
      s.write(`t${hx(base + 1, 3)}8${[1, index & 0xff, index >> 8, sub, 0, 0, 0, 0].map((v) => hx(v, 2)).join('')}\r`)
    })
  } finally { s.destroy() }
}

/** Write one param on the module only (cmd 2, not stored; the app hears the reply and takes the value too). */
export async function modWrite(base, index, sub, value) {
  const s = await slcan()
  s.write(`t${hx(base + 1, 3)}8${[2, index & 0xff, index >> 8, sub, value & 0xff, (value >> 8) & 0xff, 0, 0].map((v) => hx(v, 2)).join('')}\r`)
  await new Promise((r) => setTimeout(r, 1500))
  s.destroy()
}
