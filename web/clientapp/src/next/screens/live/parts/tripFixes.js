// Plain-language reasons and suggested fixes for one trip. Pure: no API calls. Fixes are links to
// the output page (where the limit and inrush settings live), never silent changes.
import { awgFor } from '../../../../lib/store.js'
import { href } from '../../../router.svelte.js'

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }

/** Current held between 1 s and 0.1 s before the trip, i.e. after any start spike. */
export function steadyBefore(samples) {
  return median((samples ?? []).filter((s) => s.dt >= -1 && s.dt <= -0.1 && s.i > 0).map((s) => s.i))
}

/**
 * @param t trip row from readTrips()
 * @param rating board rating of the output in A (or null)
 * @returns [{ tag, title, why, label, href, tone }]
 */
export function tripFixes(t, rating) {
  const out = t.out ?? {}
  const page = href('hardware', 'module', t.guid, 'output', t.output)
  const fixes = []
  const steady = steadyBefore(t.samples)
  const limit = t.limitA
  const wire = Number(out.wireGaugeMm2) || 0

  if (t.kind === 'inrush') {
    fixes.push({
      tag: 'MOST LIKELY', title: 'The start spike is above the inrush limit',
      why: `The current peaked at ${t.peakA.toFixed(1)} A in the first ${out.inrushTime ?? '?'} ms, above the inrush limit of ${limit} A. Lamps and motors draw much more when they switch on.`,
      label: 'Change the inrush settings', href: page, tone: 'accent',
    })
  } else if (steady != null && steady > limit * 0.9) {
    const want = Math.ceil(steady * 1.15)
    const over = rating != null && want > rating
    const need = awgFor(want)
    const thin = wire && need && wire < need.mm2
    fixes.push({
      tag: 'MOST LIKELY', title: `The load draws more than ${limit} A`,
      why: `After the start spike the current stays near ${steady.toFixed(1)} A. That is not a spike: the load is simply higher than the limit.`
        + (over ? ` This output is rated for ${rating} A, so a limit of ${want} A is not allowed. Use a lighter load or a bigger output.` : ` A limit of about ${want} A would let it run.`)
        + (thin && !over ? ` The wire is ${wire} mm², and ${need.mm2} mm² is the smallest size for ${want} A, so change the wire first.` : ''),
      label: over ? 'Open the output' : `Set the limit (about ${want} A)`, href: page, tone: 'accent',
    })
  } else {
    fixes.push({
      tag: 'MOST LIKELY', title: 'A short spike went over the limit',
      why: `The current peaked at ${t.peakA.toFixed(1)} A for a moment against the ${limit} A limit, but it does not stay there. A longer inrush time lets a start spike through.`,
      label: 'Change the inrush settings', href: page, tone: 'accent',
    })
  }
  if (t.peakA > limit * 2) {
    fixes.push({
      tag: 'ALSO', title: 'Look for a short circuit first',
      why: `${t.peakA.toFixed(1)} A is more than twice the limit. A damaged wire or a failed lamp can do this. Check them before you raise any limit.`,
      label: 'Open the output', href: page, tone: 'muted',
    })
  }
  fixes.push({
    tag: 'THEN', title: 'Test it',
    why: 'Switch the output on for a moment from its page and watch the current. The module records a new waveform if it trips again.',
    label: 'Open the output to test', href: page, tone: 'muted',
  })
  return fixes
}
