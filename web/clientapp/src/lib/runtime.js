// Entry of wwwroot/template-runtime.js (vite.runtime.config.js): the Templates tab's engine for the backend,
// which runs it in Jint for the MCP template tools (Api/TemplateApi.cs). host.call(method, path, bodyJson)
// is a loopback to this app's own /api, so a template applied by an agent is built exactly like one
// applied in the UI. Every export takes/returns JSON strings.
import { TEMPLATES, OPS, outputCircuit, blank } from './templates.js'
import { planTemplate, applyTemplate, undoTemplate } from './apply.js'

const mkApi = (host) => {
  const j = async (m, p, b) => { const t = host.call(m, p, b === undefined ? null : JSON.stringify(b)); return t ? JSON.parse(t) : null }
  return {
    devices: () => j('GET', '/api/devices'),
    definitions: () => j('GET', '/api/definitions'),
    functions: (g) => j('GET', `/api/devices/${g}/functions`),
    inputs: (g, type, all = false) => j('GET', `/api/devices/${g}/inputs${type ? `?type=${type}${all ? '' : '&inUse=true'}` : ''}`),
    broadcastSignals: (g, inUse = false) => j('GET', `/api/devices/${g}/broadcast-signals${inUse ? '?inUse=true' : ''}`),
    setFunction: (g, kind, n, body) => j('POST', `/api/devices/${g}/function/${kind}/${n}`, body),
    outputConfig: (g, body) => j('POST', `/api/devices/${g}/outputconfig`, body),
  }
}

export function list() {
  return JSON.stringify({ ops: OPS, templates: TEMPLATES.map(({ key, name, desc, fields }) => ({ key, name, desc,
    fields: fields.map(({ k, t, label, load, opt, def, min, max }) => ({ field: k, type: t, label, load, optional: !!opt, def, min, max })) })) })
}

async function plan(host, req) {
  const api = mkApi(host)
  const [devices, defs] = await Promise.all([api.devices(), api.definitions().catch(() => null)])
  return { api, devices, p: await planTemplate(api, { devices, defs, templates: TEMPLATES, req }) }
}

// What a request resolves to and would build, plus the wiring per output (relay coil / load terminals).
const describe = (p) => p.tpl ? {
  template: p.tpl.key, logicModule: p.logic, picks: p.resolved, errors: p.errors, takesOver: p.taken,
  creates: p.preview?.ops.map((o) => ({ block: o.op, name: o.name, detail: o.detail, inputs: o.ins })) ?? [],
  wires: p.preview?.wires ?? [],
  wiring: p.tpl.fields.filter((f) => f.t === 'out' && !blank(p.sel[f.k])).map((f) => {
    const o = p.outOpts.find((x) => x.value === p.sel[f.k])
    return { field: f.k, output: o?.label, pin: o?.pin?.label ?? null, side: o?.side, relay: !!p.relays[f.k], load: f.load, circuit: outputCircuit(o?.side, !!p.relays[f.k]) }
  }),
} : { errors: p.errors }

export async function preview(host, reqJson) {
  const { p } = await plan(host, JSON.parse(reqJson))
  return JSON.stringify(describe(p))
}

// req.id = edit that applied instance; req.takeOver = allow outputs something else drives now.
export async function apply(host, reqJson, instancesJson, newId) {
  const req = JSON.parse(reqJson), instances = JSON.parse(instancesJson || '[]')
  const old = req.id ? instances.find((i) => i.id === req.id) : null
  if (req.id && !old) throw new Error(`no applied template with id ${req.id}`)
  const { api, devices, p } = await plan(host, { ...req, key: req.key ?? old?.key })
  const mine = old ? (old.wired ?? []).map((n) => `${old.guid}:${n}`) : []
  const taken = p.tpl ? p.tpl.fields.filter((f) => f.t === 'out' && p.outOpts.find((o) => o.value === p.sel[f.k])?.used && !mine.includes(p.sel[f.k])).map((f) => p.resolved[f.k]) : []
  if (p.errors.length) throw new Error(p.errors.join('; '))
  if (taken.length && !req.takeOver) throw new Error(`already driven by something else: ${taken.join(', ')} — pass takeOver: true to take ${taken.length > 1 ? 'them' : 'it'} over (remove_template gives ${taken.length > 1 ? 'them' : 'it'} back)`)
  const others = instances.filter((i) => i.id !== req.id)
  const inst = await applyTemplate(api, { devices, tpl: p.tpl, sel: p.sel, relays: p.relays, name: req.name, id: req.id ?? newId, old, others, inOpt: p.inOpt, outOpts: p.outOpts })
  return JSON.stringify({ applied: { id: inst.id, name: inst.name, module: p.logic?.name, created: inst.created, wired: inst.wired.map((n) => p.outOpts.find((o) => o.value === `${inst.guid}:${n}`)?.label ?? n) }, ...describe(p), instances: [...others, inst] })
}

export async function remove(host, id, instancesJson) {
  const instances = JSON.parse(instancesJson || '[]'), inst = instances.find((i) => i.id === id)
  if (!inst) throw new Error(`no applied template with id ${id}`)
  const api = mkApi(host), others = instances.filter((i) => i.id !== id)
  await undoTemplate(api, await api.devices(), inst, others)
  return JSON.stringify({ removed: { id, name: inst.name }, instances: others })
}
