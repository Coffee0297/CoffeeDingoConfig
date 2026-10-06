// Why did an output trip? The firmware's trip log (Logs ▸ Overloads) stores the peak current, the output's
// STEADY limit and a −10 s / +3 s current waveform — but not which limit fired. A trip inside the inrush
// window (inrushTime ms after turn-on) is judged against the inrush limit instead (functions/profet.cpp), so
// work that out here from the waveform: the turn-on is the last zero → non-zero step before the trip.

const RESET = ['None', 'Count', 'Endless'];

/** Seconds from turn-on to the trip, or 0 when the output was switched on right at the trip. */
export function onTimeBeforeTrip(samples) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const before = samples.filter((s) => s.dt <= 0).sort((a, b) => a.dt - b.dt);
  if (!before.length) return null;
  let lastZero = null;
  for (const s of before) if (!(s.i > 0)) lastZero = s.dt;
  if (lastZero === null) return null;          // on for the whole 10 s window: well past any inrush
  return Math.max(0, -lastZero);
}

/**
 * @param {{state:string, peakA?:number, maxA?:number, limitA?:number, limit?:number, samples?:Array}} evt  trip-log event
 * @param {{inrushLimit?:number, inrushTime?:number, currentLimit?:number, resetMode?:number, resetTime?:number, resetCountLimit?:number}} [out]  output config
 * @returns {{kind:'inrush'|'steady', limitA:number, label:string, onS:number|null, peakA:number, text:string, clears:string}}
 */
export function tripReason(evt, out = {}) {
  const peakA = evt.peakA ?? evt.maxA ?? 0;
  const steady = out.currentLimit ?? evt.limitA ?? evt.limit ?? 0;
  const onS = onTimeBeforeTrip(evt.samples);
  const inrushMs = out.inrushTime ?? 0;
  const inInrush = inrushMs > 0 && out.inrushLimit != null && (onS === null ? false : onS * 1000 < inrushMs);
  const kind = inInrush ? 'inrush' : 'steady';
  const limitA = inInrush ? out.inrushLimit : steady;
  const when = onS === null ? '' : onS < 0.05 ? ' at turn-on' : ` ${onS.toFixed(onS < 1 ? 2 : 1)} s after turn-on`;
  const label = inInrush ? `inrush limit ${limitA} A (first ${inrushMs} ms)` : `limit ${limitA} A`;
  const text = `Overcurrent${when}: ${peakA.toFixed(1)} A peak > ${label}`;
  return { kind, limitA, label, onS, peakA, text, clears: clearsText(evt.state, out) };
}

/** How the state clears, from the output's reset mode. */
export function clearsText(state, out = {}) {
  if (state === 'Fault') return 'Latched — clears only when the module is power-cycled.';
  const mode = RESET[out.resetMode ?? 0] ?? 'None';
  if (state === 'Overcurrent' && mode === 'Count') return `Retries every ${out.resetTime ?? 0} ms, up to ${out.resetCountLimit ?? 0} times, then latches Fault.`;
  if (state === 'Overcurrent' && mode === 'Endless') return `Retries every ${out.resetTime ?? 0} ms.`;
  return '';
}
