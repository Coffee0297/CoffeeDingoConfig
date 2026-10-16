// Function blocks and helper blocks (brief: "Function blocks and helper blocks", API gap G16).
// 1. CATALOG: the block sheet (FC7) as data: ports, settings, what is inside.
// 2. suggest(): a matcher over the real block graph of one module that finds plain-block patterns a
//    function or helper block covers (e.g. brake + turn combines = US rear lamp).
// 3. Group records: "Replace" only regroups existing blocks (metadata). The blocks on the module are
//    not changed. Records live in this browser (localStorage, per module guid) and travel in the
//    project file's client section (G4); the function record itself is G16.

// port notation: plain = on/off, '#' = number, '*' = bundle
export const CATALOG = [
  { key: 'lights', kind: 'fn', name: 'Lights', what: 'Exterior lights from a rotary, two switches or CAN.', ins: ['Park', 'Headlights', 'High beam', 'Flash to pass', 'Ignition'], outs: ['Position', 'Low beam', 'High beam', 'DRL'], settings: ['High beam replaces low (H4) or adds to it', 'Only with ignition: yes / no', 'DRL: none / own lamp / dimmed position'], inside: 'Lamp mode + 2 combines' },
  { key: 'indicators', kind: 'fn', name: 'Indicators & hazard', what: 'Left, right and hazard on one shared clock.', ins: ['Left', 'Right', 'Hazard'], outs: ['Left lamps', 'Right lamps', '*Turn signals'], settings: ['Rate 400 / 400 ms', 'Clock master + backups', 'Lane change: 3 flashes on a tap'], inside: 'Shared flasher + 2 any-of' },
  { key: 'brake', kind: 'fn', name: 'Brake lights', what: 'Brake lamps, separate or combined with the turn signals.', ins: ['Brake', '*Turn signals'], outs: ['Left rear', 'Right rear', 'Centre / 3rd'], settings: ['Rear lamps: separate / combined stop-turn (US)', 'Centre lamp follows the pedal'], inside: '2 × US rear lamp' },
  { key: 'reverse', kind: 'fn', name: 'Reverse', what: 'Reverse lamps from a switch or a gear position.', ins: ['Reverse', 'Ignition'], outs: ['Lamps', 'Camera'], settings: ['Off delay 0–10 s', 'Only with ignition'], inside: '1 combine + keep-on-after' },
  { key: 'wipers', kind: 'fn', name: 'Wipers & washer', what: 'Any wiper: self-park, relays, or concealed park.', ins: ['INT', 'Low', 'High', 'Washer', 'Ignition', 'Park switch', '#INT dial'], outs: ['Run', 'Fast', 'Motor supply', 'Washer pump'], settings: ['Park: self-park / relays / concealed', 'INT 4 s or from a dial', 'After wash 3 s'], inside: 'Firmware wiper block + interval + keep-on-after' },
  { key: 'courtesy', kind: 'fn', name: 'Courtesy light', what: 'Interior light with the doors, held after they close.', ins: ['Doors (any number)', 'Ignition', 'Unlock'], outs: ['Light', '#Dim level'], settings: ['Hold 60 s', 'Off at once with ignition', 'Battery saver 15 min'], inside: 'Any-of + keep-on-after + fade' },
  { key: 'accessory', kind: 'fn', name: 'Accessory power', what: 'Dash computer, radio: clean shutdown, never cut hard.', ins: ['Wake', 'Ignition'], outs: ['Power', 'Shutdown pulse', 'Wake pulse'], settings: ['Hold 60 s', 'Shutdown pulse 0.5 s at 40 s', 'Wake pulse when back after 20 s'], inside: 'Any-of + keep-on-after + pulse' },
  { key: 'sleep', kind: 'fn', name: 'Car sleep', what: 'Every module sleeps together once nothing is in use.', ins: ['In use (add any)', 'Force awake'], outs: ['Sleep now', 'In use'], settings: ['Wait 1 s after last use', 'Quiet bus 2 s', 'Which modules follow'], inside: 'Any-of + CAN message + force-sleep per module' },
  { key: 'usrear', kind: 'helper', name: 'US rear lamp', what: 'One rear lamp that is both brake and turn (US combined stop/turn).', ins: ['Brake', 'Turn active', 'Turn lamp'], outs: ['Lamp', 'Brake only', 'Turn only'], settings: ['While indicating: blink, ignore brake (US) / blink over brake', 'Tail dims instead of off'], inside: 'NOT + 2 combines + any-of' },
  { key: 'flasher', kind: 'helper', name: 'Shared flasher', what: 'One blink clock every module follows, with automatic backup.', ins: ['Run'], outs: ['Blink', '#Phase'], settings: ['On / off time', 'Master module + backups in order'], inside: 'Flasher + CAN message + watchdog' },
  { key: 'positions', kind: 'helper', name: 'Switch positions', what: 'Turns a rotary or a number into one on/off per position.', ins: ['#Position'], outs: ['Pos 0', 'Pos 1', 'Pos 2', '… up to 16'], settings: ['Names per position', '"Between detents" is its own position'], inside: 'Compare per position' },
  { key: 'pair', kind: 'helper', name: 'Left / right pair', what: 'One signal driving a left and a right lamp, with fault split.', ins: ['On', 'Left only', 'Right only'], outs: ['Left', 'Right', 'Either failed'], settings: ['Mirror both, or per side'], inside: '2 combines + fault any-of' },
  { key: 'keepon', kind: 'helper', name: 'Keep on after', what: 'Stays on for a time after its input goes off.', ins: ['In', 'Cancel'], outs: ['Out', '#Time left'], settings: ['Hold time', 'Restart while held: yes / no'], inside: 'Timer (off-delay)' },
  { key: 'engine', kind: 'helper', name: 'Engine running', what: 'Running from RPM, alternator or oil pressure.', ins: ['#RPM', 'Charge lamp', 'Oil pressure'], outs: ['Running', 'Cranking'], settings: ['Running above 400 rpm, hysteresis 100', 'Cranking: starter on, below threshold'], inside: 'Threshold with hysteresis + combine' },
  { key: 'ready', kind: 'helper', name: 'Ready to start', what: 'Lights the start button only when the car can start.', ins: ['Ignition', 'In park / neutral', 'Clutch', 'Running'], outs: ['Ready'], settings: ['Needs: park or clutch'], inside: 'Combine with NOT running' },
  { key: 'ignload', kind: 'helper', name: 'Ignition load', what: 'A load that follows the ignition, off while cranking.', ins: ['Ignition', 'Cranking', 'Request'], outs: ['On'], settings: ['Off while cranking: yes / no', 'Delay on 0–5 s (stagger inrush)'], inside: 'Combine + delay' },
  { key: 'threshold', kind: 'helper', name: 'Threshold', what: 'On/off from a number, with hysteresis.', ins: ['#Value'], outs: ['Above', 'Below'], settings: ['On at, off at', 'Min time in state'], inside: 'Compare + hysteresis' },
  { key: 'toggle', kind: 'helper', name: 'Toggle / latch', what: 'Press on, press off; or set / reset.', ins: ['Press', 'Set', 'Reset'], outs: ['Out'], settings: ['Toggle or set/reset', 'Remember through sleep'], inside: 'Latch' },
  { key: 'pulse', kind: 'helper', name: 'Pulse', what: 'A short pulse when its input changes.', ins: ['In'], outs: ['Rising', 'Falling'], settings: ['Pulse length'], inside: 'Edge + timer' },
  { key: 'cansig', kind: 'helper', name: 'Signal from CAN', what: 'One value from any CAN frame, with timeout.', ins: [], outs: ['#Value', 'Fresh'], settings: ['ID, start bit, length, scale', 'Timeout → fallback value'], inside: 'CAN input' },
  { key: 'fog', kind: 'helper', name: 'Fog lights', what: 'Front and rear fog, with the rules most countries need.', ins: ['Front fog', 'Rear fog', 'Position', 'Low beam', 'High beam'], outs: ['Front fog', 'Rear fog', 'Indicator lamp'], settings: ['Front fog needs position / low beam', 'Off with high beam', 'Rear fog needs low beam or front fog'], inside: 'Toggle + 2 combines' },
  { key: 'horn', kind: 'helper', name: 'Horn', what: 'Horn button, plus chirps for lock and alarm.', ins: ['Button', 'Chirp', 'Panic'], outs: ['Horn'], settings: ['Chirp length 50–200 ms', 'Panic pulse pattern', 'Max on time'], inside: 'Any-of + pulse + flasher' },
  { key: 'fan', kind: 'helper', name: 'Cooling fan', what: 'Radiator fan from the ECU, a thermo switch or a temperature.', ins: ['ECU request', 'Thermo switch', '#Temperature', 'A/C on', 'Ignition'], outs: ['Fan', '#Speed %'], settings: ['On at, off at (hysteresis)', 'Speed from a table or on/off', 'Run-on after ignition off'], inside: 'Threshold + table + keep-on-after' },
  { key: 'fuel', kind: 'helper', name: 'Fuel pump', what: 'Prime on ignition, then run with the engine or the ECU.', ins: ['Ignition', 'ECU request', 'Running'], outs: ['Pump'], settings: ['Prime 2 s on ignition', 'Then ECU request / engine running', 'Off after a crash input'], inside: 'Pulse + any-of + combine' },
  { key: 'blower', kind: 'helper', name: 'Blower speeds', what: 'HVAC blower from a speed switch, as steps or PWM.', ins: ['#Speed switch', 'Ignition', 'Cranking'], outs: ['#Duty %', 'On'], settings: ['Positions → duty', 'Soft start', 'Off while cranking'], inside: 'Switch positions + table' },
  { key: 'aux', kind: 'helper', name: 'Aux lights', what: 'Light bar, spots or work lights with safety interlocks.', ins: ['Switch', 'High beam', 'Ignition'], outs: ['Lights', 'Indicator lamp'], settings: ['Only with high beam', 'Only with ignition', 'Toggle or hold'], inside: 'Toggle + combine' },
  { key: 'heater', kind: 'helper', name: 'Timed heater', what: 'Heated seats, mirrors or rear screen that switch themselves off.', ins: ['Press', 'Ignition', 'Running'], outs: ['#Level', 'On', 'Level lamps'], settings: ['Levels 1–3', 'Off after 15 min', 'Only with engine running'], inside: 'Counter + table + timer' },
  { key: 'battery', kind: 'helper', name: 'Battery saver', what: 'Switches loads off when the battery is low or the car is left.', ins: ['#Battery V', 'Ignition', 'In use'], outs: ['Allow', 'Low battery'], settings: ['Cut below 11.8 V for 30 s', 'Cut after 20 min with ignition off', 'Warn first'], inside: 'Threshold + timer' },
]
export const recipe = (key) => CATALOG.find((c) => c.key === key)
export const kindWord = (k) => (k === 'fn' ? 'function block' : 'helper block')

// ---- suggestion matcher ----------------------------------------------------------------------
function ctx(model) {
  const node = (id) => model.nodes.get(id)
  const srcOf = (idx) => { const v = model.byIdx.get(idx); if (!v) return null; return node(v.kind === 'sys' ? 'sys' : v.kind === 'lua' ? 'lua' : `${v.kind}:${v.number}`) }
  const text = (idx) => { const v = model.byIdx.get(idx); const n = srcOf(idx); return ((n?.title ?? '') + ' ' + (v?.name ?? '')).toLowerCase() }
  const vis = [...model.nodes.values()].filter((n) => n.kind === 'virtualinput' && n.enabled)
  const ins = (n) => [0, 1, 2].map((i) => ({ idx: n.row['var' + i], not: !!n.row['not' + i] })).filter((x) => x.idx)
  return { node, srcOf, text, vis, ins }
}

const RULES = [
  // brake AND NOT turn, OR blink → US rear lamp
  (m, c) => {
    const out = []
    for (const or of c.vis) {
      if (or.row.cond0 !== 1) continue
      const and = c.ins(or).map((x) => c.srcOf(x.idx)).find((s) => s?.kind === 'virtualinput' && s.row.cond0 === 0 && c.ins(s).some((x) => x.not))
      if (and) out.push({ recipe: 'usrear', members: [and.id, or.id], why: `${and.title} (brake, but not while indicating) OR the blink: that is one US rear lamp.` })
    }
    return out
  },
  // AND with NOT running → Ready to start (+ the position compare feeding it)
  (m, c) => c.vis.filter((n) => n.row.cond0 === 0 && c.ins(n).some((x) => x.not && /run|engine|rpm/.test(c.text(x.idx)))).map((n) => {
    const extra = c.ins(n).map((x) => c.srcOf(x.idx)).filter((s) => s?.kind === 'condition' && s.enabled).map((s) => s.id)
    return { recipe: 'ready', members: [n.id, ...extra], why: `${n.title} is on with the ignition, in park and NOT running: the Ready to start helper.` }
  }),
  // NOT "in use" chain → Car sleep
  (m, c) => c.vis.filter((n) => /sleep|mute/i.test(n.title) && c.ins(n).some((x) => x.not)).map((n) => {
    const chain = [n.id]
    const walk = (vi, depth) => { if (depth > 3) return; for (const x of c.ins(vi)) { const s = c.srcOf(x.idx); if (s?.kind === 'virtualinput' && s.row.cond0 === 1 && !chain.includes(s.id)) { chain.unshift(s.id); walk(s, depth + 1) } } }
    walk(n, 0)
    return { recipe: 'sleep', members: chain, why: `${chain.length} combines decide when nothing is in use. The Car sleep function block shows them as "in use" inputs.` }
  }),
  // flasher + two ANDs using it → Indicators & hazard
  (m, c) => [...m.nodes.values()].filter((n) => n.kind === 'flasher' && n.enabled).map((f) => {
    const blinkIdx = f.outs[0]?.idx
    const users = c.vis.filter((n) => c.ins(n).some((x) => x.idx === blinkIdx)).map((n) => n.id)
    return users.length >= 2 ? { recipe: 'indicators', members: [f.id, ...users], why: 'One flasher with a left and a right combine: the Indicators & hazard function block.' } : null
  }).filter(Boolean),
  // compares on a wiper switch → Wipers & washer
  (m, c) => {
    const w = [...m.nodes.values()].filter((n) => n.kind === 'condition' && n.enabled && /wip/.test(c.text(n.row.input) + ' ' + n.title.toLowerCase()))
    return w.length ? [{ recipe: 'wipers', members: w.map((n) => n.id), why: `${w.length} compares turn the wiper switch into run and fast: part of the Wipers & washer function block.` }] : []
  },
  // RPM compare → Engine running
  (m, c) => [...m.nodes.values()].filter((n) => n.enabled && ((n.kind === 'condition' && [2, 4].includes(+n.row.operator) && /rpm|engine/.test(c.text(n.row.input) + ' ' + n.title.toLowerCase())) || (n.kind === 'caninput' && [2, 4].includes(+n.row.operator) && +n.row.operand >= 100 && /rpm|engine|running/i.test(n.title))))
    .map((n) => ({ recipe: 'engine', members: [n.id], why: `${n.title} is on above ${n.row.arg ?? n.row.operand} rpm: the Engine running helper.` })),
  // off-delay from a door → Courtesy light
  (m, c) => [...m.nodes.values()].filter((n) => n.kind === 'timer' && n.enabled && n.row.mode === 1 && /door/.test(c.text(n.row.input)))
    .map((n) => ({ recipe: 'courtesy', members: [n.id], why: `${n.title} holds the light after the door closes: the Courtesy light function block.` })),
  // any off-delay → Keep on after
  (m, c) => [...m.nodes.values()].filter((n) => n.kind === 'timer' && n.enabled && n.row.mode === 1).map((n) => ({ recipe: 'keepon', members: [n.id], why: `${n.title} stays on after its input goes off: the Keep on after helper.` })),
  // compares on one position / number → Switch positions
  (m, c) => {
    const by = new Map()
    for (const n of m.nodes.values()) if (n.kind === 'condition' && n.enabled && n.row.input && [0, 4, 5].includes(+n.row.operator)) {
      const v = m.byIdx.get(n.row.input)
      if (v && (v.prop === 'Rotary Position' || v.type !== 'bool')) { if (!by.has(n.row.input)) by.set(n.row.input, []); by.get(n.row.input).push(n.id) }
    }
    return [...by.entries()].filter(([idx, ids]) => ids.length >= 2 || m.byIdx.get(idx)?.prop === 'Rotary Position')
      .map(([idx, ids]) => ({ recipe: 'positions', members: ids, why: `${ids.length === 1 ? 'A compare' : ids.length + ' compares'} on ${c.srcOf(idx)?.title ?? 'one number'} pick switch positions: the Switch positions helper.` }))
  },
  // hysteresis compare → Threshold
  (m, c) => [...m.nodes.values()].filter((n) => n.kind === 'condition' && n.enabled && [2, 3, 4, 5].includes(+n.row.operator) && n.row.argOff !== n.row.arg)
    .map((n) => ({ recipe: 'threshold', members: [n.id], why: `${n.title} has an on and an off point: the Threshold helper.` })),
]

/** Suggestions for this module: each block appears in at most one (grouped or suggested). */
export function suggest(model, groups = [], dismissed = []) {
  const c = ctx(model)
  const taken = new Set(groups.flatMap((g) => g.members))
  const out = []
  for (const rule of RULES) {
    for (const s of rule(model, c)) {
      if (!s.members.length || s.members.some((id) => taken.has(id) || !model.nodes.has(id))) continue
      s.key = s.recipe + ':' + [...s.members].sort().join(',')
      if (dismissed.includes(s.key)) continue
      s.members.forEach((id) => taken.add(id))
      out.push(s)
    }
  }
  return out
}

// ---- group records (localStorage per module guid; saved with the project file, G4) ----------------
export const GROUPS_KEY = 'dingoNextGroups:'
const storeKey = (guid) => GROUPS_KEY + guid
export function loadGroups(guid) {
  try { const v = JSON.parse(localStorage.getItem(storeKey(guid)) || '{}'); return { groups: v.groups ?? [], dismissed: v.dismissed ?? [] } } catch { return { groups: [], dismissed: [] } }
}
export function saveGroups(guid, data) {
  try { localStorage.setItem(storeKey(guid), JSON.stringify({ groups: data.groups, dismissed: data.dismissed })) } catch { /* private mode: lives for this page only */ }
}
export function makeGroup(s) {
  const r = recipe(s.recipe)
  return { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), recipe: s.recipe, kind: r?.kind ?? 'helper', name: r?.name ?? s.recipe, members: [...s.members], expanded: false, why: s.why }
}
/** Drop members that no longer exist; a group with no members left is removed. */
export function pruneGroups(groups, model) {
  return groups.map((g) => ({ ...g, members: g.members.filter((id) => model.nodes.has(id)) })).filter((g) => g.members.length)
}
