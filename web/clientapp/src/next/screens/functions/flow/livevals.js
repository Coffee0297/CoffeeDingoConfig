// Live values for every var-map index of one module: { [idx]: true | false | number | null }.
// Sources: GET /devices/{id}/signals (kind + name + value + on) and the 10 Hz device telemetry
// (outputs[], battery, temp, state). Lua outs and keypad values have no live source (null = "—").
const SIG_KIND = { input: 'Digital input', caninput: 'CAN input', virtualinput: 'Virtual input', condition: 'Condition', counter: 'Counter', flasher: 'Flasher', timer: 'Timer', table: 'Table', digitaloutput: 'Digital output' }

export function sigIndex(signals) {
  const m = new Map()
  for (const s of signals ?? []) m.set(s.kind + '|' + s.name, s)
  return m
}

const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null }

/** One value for var `v` (a var-map entry) from the signal index + device telemetry. */
export function liveOf(v, sig, dev, model) {
  if (!v) return null
  const node = model?.nodes.get(v.kind === 'sys' ? 'sys' : v.kind === 'lua' ? 'lua' : `${v.kind}:${v.number}`)
  const name = node?.row?.name ?? ''
  switch (v.kind) {
    case 'sys':
      if (v.number === 1) return true
      if (v.number === 3) return dev?.temp != null ? +dev.temp : null
      if (v.number === 4) return dev?.battery != null ? +dev.battery : null
      return null
    case 'output': {
      const o = (dev?.outputs ?? []).find((x) => x.number === v.number)
      if (!o) return null
      if (v.prop === 'On') return String(o.state ?? '') === 'On'
      if (v.prop === 'Current') return +o.current || 0
      if (v.prop === 'Overcurrent') return /overcurrent/i.test(o.state ?? '')
      if (v.prop === 'Fault') return /fault/i.test(o.state ?? '')
      if (v.prop === 'Warning') return o.state === 'Warning'
      if (v.prop === 'Open Load') return o.state === 'OpenLoad'
      if (v.prop === 'Undercurrent') return o.state === 'Undercurrent'
      return null
    }
    case 'digitaloutput': {   // a CANBoard output
      const o = (dev?.digitalOut ?? []).find((x) => x.number === v.number)
      return o ? !!o.on : null
    }
    case 'analoginput': {
      if (v.prop === 'Millivolts') return num(sig.get('Analog input|' + name)?.value)
      if (v.prop === 'Rotary Position') return num(sig.get('Rotary position|' + name + ' Pos')?.value)
      if (v.prop === 'Switch Value') { const s = sig.get('Analog switch|' + name + ' Switch'); return s ? !!s.on : null }
      return null
    }
    case 'caninput': {
      const s = sig.get('CAN input|' + name)
      if (!s) return null
      return v.prop === 'State' ? !!s.on : num(s.value)
    }
    case 'counter': case 'table': return num(sig.get(SIG_KIND[v.kind] + '|' + name)?.value)
    default: {
      const k = SIG_KIND[v.kind]
      if (!k) return null
      if (v.kind === 'input' && v.prop !== 'State') return null
      const s = sig.get(k + '|' + name)
      return s ? !!s.on : null
    }
  }
}

/** Fill `target` (a $state object) in place: only keys whose value changed are written (no flicker, no churn). */
export function writeLive(target, model, signals, dev) {
  const sig = sigIndex(signals)
  for (const n of model.nodes.values()) for (const p of n.outs) {
    const val = liveOf(model.byIdx.get(p.idx), sig, dev, model)
    if (target[p.idx] !== val) target[p.idx] = val
  }
}

/** Short text for a value: ON / OFF / 12.4 / —. */
export function fmt(v, digits = 1) {
  if (v === true) return 'ON'
  if (v === false) return 'OFF'
  if (v == null || Number.isNaN(v)) return '—'
  if (typeof v === 'number') return Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v * 10) / 10) : v.toFixed(digits)
  return String(v)
}
