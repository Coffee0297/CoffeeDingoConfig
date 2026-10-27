// Minimum recommended copper wire gauge to carry an output's current LIMIT (the trip
// point) on a short automotive run, with insulation/bundling headroom so the wire is
// never the weak link before the dingoPDM trips. Conservative — for long runs or
// voltage-drop-sensitive loads (lighting), step up a size. Based on the current limit,
// not the expected load, on purpose.
// ponytail: lookup table, not a thermal model — the physical world needs a margin a
// formula won't give. Edit the thresholds if your insulation/run length differ.
export function awgFor(limitA) {
  const a = Number(limitA) || 0
  if (a <= 0) return null
  // [maxAmps, AWG, EU/IEC cross-section mm²]. Automotive thin-wall, short run — sized to
  // the trip point. mm² are real EU stock sizes; AWG is the nearest equivalent.
  const tbl = [[7, '20', 0.5], [10, '18', 0.75], [15, '16', 1.5], [24, '14', 2.5], [32, '12', 4], [45, '10', 6], [60, '8', 10]]
  for (const [max, awg, mm2] of tbl) if (a <= max) return { awg, mm2 }
  return { awg: '6', mm2: 16 }
}

// Standard EU/IEC wire cross-sections with nearest AWG, for the manual gauge override.
export const WIRE_GAUGES = [
  { mm2: 0.5, awg: '20' }, { mm2: 0.75, awg: '18' }, { mm2: 1.0, awg: '17' }, { mm2: 1.5, awg: '16' },
  { mm2: 2.5, awg: '14' }, { mm2: 4, awg: '12' }, { mm2: 6, awg: '10' }, { mm2: 10, awg: '8' },
  { mm2: 16, awg: '6' }, { mm2: 25, awg: '4' }, { mm2: 35, awg: '2' },
]
export const awgForMm2 = (mm2) => WIRE_GAUGES.find((g) => g.mm2 === Number(mm2))?.awg ?? '?'

// Voltage drop over a copper wire run at a given current. lengthM is one-way; the feed +
// return path is 2·L. ρ ≈ 0.0175 Ω·mm²/m (copper, slightly warm). Returns volts + % of
// system voltage (13.8 V running) or null if inputs are incomplete.
export function vDrop(lengthM, amps, mm2, sysV = 13.8) {
  const L = Number(lengthM) || 0, I = Number(amps) || 0, A = Number(mm2) || 0
  if (L <= 0 || I <= 0 || A <= 0) return null
  const volts = (2 * L * I * 0.0175) / A
  return { volts, pct: (volts / sysV) * 100 }
}
