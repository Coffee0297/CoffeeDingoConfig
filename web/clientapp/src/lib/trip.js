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
  // the module's own steady limit at the time (in the log): the project may have changed since (an old trip
  // judged against today's settings read "31 A > inrush limit 60 A")
  const steady = evt.limitA ?? evt.limit ?? out.currentLimit ?? 0;
  const onS = onTimeBeforeTrip(evt.samples);
  const inrushMs = out.inrushTime ?? 0;
  // an inrush trip needs the current above the inrush limit: below it, the module's window must have been over
  const inInrush = inrushMs > 0 && out.inrushLimit != null && (onS === null ? false : onS * 1000 < inrushMs) && peakA > out.inrushLimit;
  const kind = inInrush ? 'inrush' : 'steady';
  const limitA = inInrush ? out.inrushLimit : steady;
  // a steady trip: the current just before it, not the turn-on spike (the waveform's 40 ms points can hide it: then the peak)
  const lastA = Math.max(0, ...(evt.samples ?? []).filter((s) => s.dt <= 0 && s.dt > -0.2).map((s) => s.i ?? 0));
  const shownA = inInrush || !(lastA > steady) ? peakA : lastA;
  const when = onS === null ? '' : onS < 0.05 ? ' at turn-on' : ` ${onS.toFixed(onS < 1 ? 2 : 1)} s after turn-on`;
  const label = inInrush ? `inrush limit ${limitA} A (first ${inrushMs} ms)` : `limit ${limitA} A`;
  const text = `Overcurrent${when}: ${shownA.toFixed(1)} A ${shownA === peakA ? 'peak ' : ''}> ${label}`;
  const note = !inInrush && out.currentLimit != null && evt.limitA != null && out.currentLimit !== evt.limitA
    ? `The module had a ${evt.limitA} A limit then; the project now has ${out.currentLimit} A.` : '';
  return { kind, limitA, label, onS, peakA: shownA, text, note, clears: clearsText(evt.state, out) };
}

/** What clears a latched Fault: a power cycle, and (upstream fault clear) the output's input going off and on
 *  again (out.clearOnReassert) or the module's retry-all signal (retryAll = it has one wired). */
export function latchClears(out = {}, retryAll = false) {
  const ways = [out.clearOnReassert && 'its input switches off and on again', retryAll && 'the retry-all signal turns on', 'the module is power-cycled'].filter(Boolean);
  return ways.length > 1 ? ways.slice(0, -1).join(', ') + ' or ' + ways.at(-1) : ways[0];
}

/** How the state clears, from the output's reset mode. */
export function clearsText(state, out = {}, retryAll = false) {
  if (state === 'Fault') return out.clearOnReassert || retryAll ? `Latched — clears when ${latchClears(out, retryAll)}.` : 'Latched — clears only when the module is power-cycled.';
  const mode = RESET[out.resetMode ?? 0] ?? 'None';
  if (state === 'Overcurrent' && mode === 'Count') return `Retries every ${out.resetTime ?? 0} ms, up to ${out.resetCountLimit ?? 0} times, then latches Fault.`;
  if (state === 'Overcurrent' && mode === 'Endless') return `Retries every ${out.resetTime ?? 0} ms.`;
  return '';
}
