// Route table for the redesigned UI. Each screen is its own file (lazy-loaded) so screens can be
// built and reviewed one PR at a time. `match(parts)` returns { load, params } for the current route.
const S = {
  carHome: () => import('./screens/car/CarHome.svelte'),
  firstRun: () => import('./screens/connect/FirstRun.svelte'),
  functions: () => import('./screens/functions/FunctionList.svelte'),
  addFunction: () => import('./screens/functions/AddFunction.svelte'),
  setup: () => import('./screens/functions/SetupWizard.svelte'),
  flow: () => import('./screens/functions/FlowBuilder.svelte'),
  wholeCar: () => import('./screens/functions/WholeCar.svelte'),
  power: () => import('./screens/power/PowerHome.svelte'),
  ignition: () => import('./screens/power/Ignition.svelte'),
  sleep: () => import('./screens/power/SleepWake.svelte'),
  roles: () => import('./screens/power/OutputRoles.svelte'),
  modules: () => import('./screens/hardware/Modules.svelte'),
  module: () => import('./screens/hardware/ModuleDetail.svelte'),
  output: () => import('./screens/hardware/OutputDetail.svelte'),
  input: () => import('./screens/hardware/InputDetail.svelte'),
  allOutputs: () => import('./screens/hardware/AllOutputs.svelte'),
  keypads: () => import('./screens/hardware/Keypads.svelte'),
  firmware: () => import('./screens/hardware/Firmware.svelte'),
  dashboard: () => import('./screens/live/Dashboard.svelte'),
  plot: () => import('./screens/live/Plot.svelte'),
  trips: () => import('./screens/live/Trips.svelte'),
  logs: () => import('./screens/live/Logs.svelte'),
  lua: () => import('./screens/expert/Lua.svelte'),
  expertCan: () => import('./screens/expert/ExpertCan.svelte'),
  expertTools: () => import('./screens/expert/ExpertTools.svelte'),
  notFound: () => import('./screens/NotFound.svelte'),
}

/**
 * URL scheme (#/next/...):
 *  car · connect
 *  functions · functions/add · functions/setup/<templateKey> · functions/flow[/<guid>[/<fnKey>]] · functions/whole-car
 *  power · power/ignition · power/sleep · power/roles
 *  hardware (modules) · hardware/module/<guid> · hardware/module/<guid>/output/<n> · hardware/module/<guid>/input/<kind>/<n>
 *  hardware/outputs · hardware/keypads · hardware/firmware
 *  live (dashboard) · live/plot · live/trips[/<guid>/<index>] · live/logs
 *  expert/lua · expert/can · expert/tools
 */
export function match(parts) {
  const [a, b, c, d, e, f] = parts
  switch (a) {
    case 'car': return { load: S.carHome, params: {} }
    case 'connect': return { load: S.firstRun, params: {} }
    case 'functions':
      if (!b) return { load: S.functions, params: {} }
      if (b === 'add') return { load: S.addFunction, params: {} }
      if (b === 'setup') return { load: S.setup, params: { template: c } }
      if (b === 'flow') return { load: S.flow, params: { guid: c, fn: d } }
      if (b === 'whole-car') return { load: S.wholeCar, params: {} }
      break
    case 'power':
      if (!b) return { load: S.power, params: {} }
      if (b === 'ignition') return { load: S.ignition, params: {} }
      if (b === 'sleep') return { load: S.sleep, params: {} }
      if (b === 'roles') return { load: S.roles, params: {} }
      break
    case 'hardware':
      if (!b || b === 'modules') return { load: S.modules, params: {} }
      if (b === 'module' && c && d === 'output' && e) return { load: S.output, params: { guid: c, n: Number(e) } }
      if (b === 'module' && c && d === 'input' && e && f) return { load: S.input, params: { guid: c, kind: e, n: Number(f) } }
      if (b === 'module' && c) return { load: S.module, params: { guid: c, tab: d } }
      if (b === 'outputs') return { load: S.allOutputs, params: {} }
      if (b === 'keypads') return { load: S.keypads, params: {} }
      if (b === 'firmware') return { load: S.firmware, params: {} }
      break
    case 'live':
      if (!b || b === 'dashboard') return { load: S.dashboard, params: {} }
      if (b === 'plot') return { load: S.plot, params: {} }
      if (b === 'trips') return { load: S.trips, params: { guid: c, index: d != null ? Number(d) : undefined } }
      if (b === 'logs') return { load: S.logs, params: {} }
      break
    case 'expert':
      if (b === 'lua') return { load: S.lua, params: { guid: c } }
      if (b === 'can') return { load: S.expertCan, params: {} }
      if (b === 'tools') return { load: S.expertTools, params: {} }
      break
  }
  return { load: S.notFound, params: { parts } }
}

/** Rail areas (Simple level) and the Expert drawer. `area` = first route part. */
export const AREAS = [
  { area: 'car', label: 'Car', short: 'C' },
  { area: 'functions', label: 'Functions', short: 'F' },
  { area: 'power', label: 'Power & ignition', short: 'P' },
  { area: 'hardware', label: 'Hardware', short: 'H' },
  { area: 'live', label: 'Live', short: 'L' },
]
export const EXPERT = [
  { parts: ['expert', 'lua'], label: 'Lua' },
  { parts: ['expert', 'can'], label: 'CAN & parameters' },
  { parts: ['expert', 'tools'], label: 'AI agent & Sim replay' },
]

/** Command palette entries: every screen reachable by name. */
export const COMMANDS = [
  ['Car home', ['car']], ['Connect & find modules', ['connect']],
  ['Functions', ['functions']], ['Add a function', ['functions', 'add']], ['Flow builder', ['functions', 'flow']], ['Whole car canvas', ['functions', 'whole-car']],
  ['Power & ignition', ['power']], ['Ignition & start button', ['power', 'ignition']], ['Sleep & wake', ['power', 'sleep']], ['Output roles', ['power', 'roles']],
  ['Modules', ['hardware']], ['Every output on the car', ['hardware', 'outputs']], ['Keypads', ['hardware', 'keypads']], ['Firmware', ['hardware', 'firmware']],
  ['Live dashboard', ['live']], ['Plot', ['live', 'plot']], ['Trips', ['live', 'trips']], ['Logs', ['live', 'logs']],
  ['Lua scripts', ['expert', 'lua']], ['CAN map, parameters, compare', ['expert', 'can']], ['AI agent & Sim replay', ['expert', 'tools']],
]
