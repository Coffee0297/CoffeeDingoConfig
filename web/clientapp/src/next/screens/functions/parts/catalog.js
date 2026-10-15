// Pure helpers for the Functions screens: which system a template or an output belongs to, what a template
// needs, and the plain sentences. No API calls here.
import { TEMPLATES, isInput, blank } from '../../../../lib/templates.js'

export const SYSTEMS = [
  { key: 'lights', name: 'Lights' },
  { key: 'signals', name: 'Signals & horn' },
  { key: 'wipers', name: 'Wipers' },
  { key: 'cooling', name: 'Cooling' },
  { key: 'fuel', name: 'Fuel & engine' },
  { key: 'power', name: 'Starting & power' },
  { key: 'accessories', name: 'Accessories' },
  { key: 'other', name: 'Other' },
]
export const systemName = (k) => SYSTEMS.find((s) => s.key === k)?.name ?? 'Other'

// The templates carry no group (API gap G16), so the screen keeps this map.
const TEMPLATE_SYSTEM = {
  headlights: 'lights', interior: 'lights', reverse: 'lights', brake: 'lights', drl: 'lights', reminder: 'lights',
  blinker: 'signals',
  washwipe: 'wipers', wipers: 'wipers', relaywipe: 'wipers',
  radfan: 'cooling', pwmfan: 'cooling',
  fuelpump: 'fuel',
  starter: 'power',
  simple: 'accessories', analog: 'accessories', afterrun: 'accessories', toggle: 'accessories',
}
export const templateSystem = (key) => TEMPLATE_SYSTEM[key] ?? 'other'
export const templateByKey = (key) => TEMPLATES.find((t) => t.key === key)

// Output name -> system (hand-built functions only). First match wins.
const RULES = [
  [/horn|indicator|turn\b|hazard|blink/i, 'signals'],
  [/wiper|washer|wash\b/i, 'wipers'],
  [/fan|coolant|radiator/i, 'cooling'],
  [/fuel|engine|power steering|\becu\b|o2/i, 'fuel'],
  [/beam|position|sidemarker|brake|reverse|lamp|light|plate|angel/i, 'lights'],
  [/ignition|start|dash|\bpi\b|radio|sleep|power/i, 'power'],
  [/blower|hvac|seat|heat|pump/i, 'accessories'],
]
export const outputSystem = (name) => RULES.find(([re]) => re.test(name ?? ''))?.[1] ?? 'other'

// "Left Low Beam x2" and "Right Low Beam x2" are one function: "Low Beam".
export function functionName(outputName) {
  const n = String(outputName ?? '').replace(/\([^)]*\)/g, ' ').replace(/\b(left|right)\b/gi, ' ').replace(/\bx\d+\b/gi, ' ')
    .replace(/\bL\s*\+\s*R\b/gi, ' ').replace(/\s*[-+]\s*$/, ' ').replace(/\s+/g, ' ').trim()
  return n || String(outputName ?? '').trim()
}

// Short "You need: ..." line from a template's fields.
export function needText(tpl) {
  const ins = tpl.fields.filter((f) => isInput(f) && !f.opt).length
  const optIns = tpl.fields.filter((f) => isInput(f) && f.opt).length
  const outs = tpl.fields.filter((f) => f.t === 'out' && !f.opt).length
  const optOuts = tpl.fields.filter((f) => f.t === 'out' && f.opt).length
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const parts = []
  if (ins || optIns) parts.push(ins ? plural(ins, 'input') + (optIns ? ` (+${optIns} optional)` : '') : `${optIns} optional input${optIns === 1 ? '' : 's'}`)
  if (outs) parts.push(plural(outs, 'output') + (optOuts ? ` (+${optOuts} optional)` : ''))
  return parts.join(', ') || 'nothing'
}

// First sentence of a template description, for cards.
export const shortDesc = (tpl) => { const m = /^.*?[.](?=\s+[A-Z]|$)/.exec(tpl.desc ?? ''); return m ? m[0].trim() : tpl.desc }

// Signal key 'remote:<guid>:DigitalInput6.State' -> 'CB-2 DI6'
export function remoteText(v, devices) {
  const [, g, sig] = String(v).split(':')
  const d = devices.find((x) => x.guid === g)
  const m = /^(?:Digital)?Input(\d+)\.State$/.exec(sig ?? '')
  const analog = /^AnalogInput(\d+)/.exec(sig ?? '')
  return [d?.name ?? 'a module', m ? 'DI' + m[1] : analog ? 'AI' + analog[1] : (sig ?? '').replace(/\.State$/, '')].join(' ')
}

// "just now", "5 min ago", "2 days ago"
export function ago(iso) {
  const t = Date.parse(iso); if (!t) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return Math.floor(s / 86400) + ' days ago'
}

export { blank }
