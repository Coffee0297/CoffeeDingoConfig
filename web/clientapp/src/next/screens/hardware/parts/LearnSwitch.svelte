<script>
  // Learn a switch (H20): record the bus while the operator flips a switch, then rank the bits that followed it.
  // The backend has no timestamped frame history (gap G17), so this polls /api/canlog about 10 times a second
  // and diffs the snapshots in the browser. Very short pulses can be missed; the dialog says so.
  import { Dialog, Button, LineChart, Banner } from '../../../ui/index.js'
  import { api } from '../../../lib/live.svelte.js'
  import { createLearner } from './learn.js'

  let { open = $bindable(false), onuse } = $props()
  const SECONDS = 8
  let phase = $state('idle'), left = $state(SECONDS), sel = $state(0), result = $state(null), stats = $state({ polls: 0, ids: 0, bits: 0 }), err = $state(''), activity = $state([])
  let learner = null, timer = null, startedAt = 0, busy = false, prevBits = 0

  function clear() { if (timer) { clearInterval(timer); timer = null } }
  async function tick() {
    if (busy) return
    busy = true
    try {
      const snap = await api.canlog()
      const t = Date.now()
      learner.feed(snap, t)
      stats = learner.stats()
      // bits changed per second, for the activity graph
      const sec = Math.floor((t - startedAt) / 1000)
      if (sec >= 0 && sec < SECONDS) { activity[sec] = (activity[sec] ?? 0) + Math.max(0, stats.bits - prevBits); activity = [...activity] }
      prevBits = stats.bits
      left = Math.max(0, Math.ceil(SECONDS - (t - startedAt) / 1000))
      if (left <= 0) finish()
    } catch (e) { err = e?.message ?? String(e); clear(); phase = 'error' } finally { busy = false }
  }
  function start() {
    err = ''; result = null; sel = 0; activity = []; prevBits = 0
    learner = createLearner(); startedAt = Date.now(); left = SECONDS; phase = 'learning'
    clear(); timer = setInterval(tick, 100); tick()
  }
  function finish() {
    clear()
    result = learner.result()
    phase = result.cands.length ? 'learned' : 'none'
    sel = 0
  }
  $effect(() => { if (open && phase === 'idle') start(); if (!open) { clear(); phase = 'idle' } })
  $effect(() => () => clear())

  const traceVals = (c) => {
    const n = 40, span = Math.max(1, c.t1 - c.t0), out = []
    let v = c.start, j = 0
    for (let i = 0; i < n; i++) {
      const t = c.t0 + (span * i) / (n - 1)
      while (j < c.trace.length && c.trace[j].t <= t) v = c.trace[j++].v
      out.push(v)
    }
    return out
  }
  const all = $derived(result ? [...result.cands, ...result.ignored] : [])
  const chosen = $derived(all[sel])
  const note = $derived(!chosen ? '' : chosen.kind === 'counter' ? 'This looks like a counter and will not follow your switch.' : chosen.kind === 'noisy' ? 'This bit changes all the time. It is noise, not your switch.'
    : chosen.kind === 'maybe' ? 'It changed with your flips but also on its own. It may flicker in use.' : `Using ${chosen.hex} bit ${chosen.startBit} fills in the ID, start bit and length. You can still edit them.`)
  const badge = (c) => (c.kind === 'best' ? `Best match · ${c.percent} %` : c.kind === 'maybe' ? `Possible · ${c.percent} %` : c.kind === 'counter' ? 'Ignored · counter' : 'Ignored · noisy')
  function use() { if (chosen && chosen.kind !== 'counter' && chosen.kind !== 'noisy') { onuse?.(chosen); open = false } }
  const STEPS = ['Record', 'Work the switch', 'Pick the bit']
  const stepNow = $derived(phase === 'learning' ? 1 : 2)
</script>

<Dialog bind:open title="Learn a switch" description="Flip the switch while the bus is recorded. The bit that follows it is found for you." width={640}>
  <ol class="steps" aria-label="Steps">
    {#each STEPS as s, i (s)}<li class:done={i < stepNow} class:now={i === stepNow}><span aria-hidden="true">{i < stepNow ? '✓' : i === stepNow ? '●' : '○'}</span> {i + 1} {s}</li>{/each}
  </ol>

  {#if phase === 'learning'}
    <div class="timer" role="timer" aria-label={`${left} seconds left`} data-testid="learn-timer"><span class="n mono">{left}</span> seconds</div>
    <p><strong>Work the switch now</strong><br /><span class="muted">Turn it on and off three or four times, a second apart. Leave it off at the end.</span></p>
    <div class="stats">
      <div><span class="nx-label">Snapshots</span><strong class="mono">{stats.polls}</strong></div>
      <div><span class="nx-label">IDs seen</span><strong class="mono">{stats.ids}</strong></div>
      <div><span class="nx-label">Bits that changed</span><strong class="mono" data-testid="learn-bits">{stats.bits}</strong></div>
    </div>
    <LineChart series={[{ label: 'Bits changing per second', values: activity.length > 1 ? activity.map((x) => x ?? 0) : [0, 0], color: 'var(--color-on)' }]} min={0} height={70} label="Line graph of how many bits changed each second while recording. Activity rises each time you flip the switch." />
    <span class="muted small">bits changing per second</span>
  {:else if phase === 'learned'}
    <p data-testid="learn-summary">{result.changedBits} bits changed in {SECONDS} s. {result.cands.length} {result.cands.length === 1 ? 'is' : 'are'} worth a look. The best match changed about as often as you flipped the switch.</p>
    <div role="group" aria-label="Candidate bits, best first" class="cands">
      {#each all as c, i (c.hex + ':' + c.bit)}
        <button type="button" class="cand" class:ign={c.kind === 'counter' || c.kind === 'noisy'} aria-pressed={sel === i} onclick={() => (sel = i)} data-testid="cand">
          <span class="ring" aria-hidden="true">{sel === i ? '●' : '○'}</span>
          <span class="tt"><strong>{c.hex} · bit {c.startBit} · 1 bit</strong><span class="muted">Changed {c.changes} time{c.changes === 1 ? '' : 's'}.</span></span>
          <span class="tr"><LineChart series={[{ label: 'Bit', values: traceVals(c), color: c.kind === 'best' ? 'var(--color-on)' : 'var(--color-text-muted)' }]} min={-0.2} max={1.2} height={36} label={`Trace of ${c.hex} bit ${c.startBit}: ${c.changes} changes.`} /></span>
          <span class="bdg" data-kind={c.kind}>{badge(c)}</span>
        </button>
      {/each}
    </div>
    <p class="muted" role="status" data-testid="learn-note">{note}</p>
    <p class="muted small">Found by checking the bus about 10 times a second, so very short pulses can be missed.</p>
  {:else if phase === 'none'}
    <Banner tone="fault" title="Nothing followed the switch">{result?.changedBits ?? 0} bits changed, but none changed 3 to 8 times. Counters and noisy bits are left out on purpose.</Banner>
    <ul class="tips">
      <li>Is the switch wired to the ECU or to a module that sends on this bus? A switch wired to the car only is not on the bus.</li>
      <li>Is the ignition on? Some ECUs only send that frame with the key on.</li>
      <li>Flip it slower: once a second, three or four times, and end where you started.</li>
    </ul>
  {:else if phase === 'error'}
    <Banner tone="fault" title="Could not read the bus">{err}</Banner>
  {/if}

  {#snippet footer()}
    {#if phase === 'learning'}
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button variant="primary" onclick={finish} data-testid="learn-stop">Stop now</Button>
    {:else if phase === 'learned'}
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button onclick={start} data-testid="learn-again">Record again</Button>
      <Button variant="primary" disabled={!chosen || chosen.kind === 'counter' || chosen.kind === 'noisy'} onclick={use} data-testid="learn-use">Use this bit</Button>
    {:else}
      <Button onclick={() => (open = false)}>Pick the bit by hand</Button>
      <Button variant="primary" onclick={start} data-testid="learn-again">Record again</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .steps { display: flex; gap: var(--space-2); list-style: none; padding: 0; margin: 0; flex-wrap: wrap; }
  .steps li { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--color-line); color: var(--color-text-muted); font-size: var(--text-sm); }
  .steps li.now { background: var(--color-raised); border-color: var(--color-focus); color: var(--color-text); }
  .steps li.done { color: var(--color-ok); }
  .timer { display: flex; align-items: baseline; gap: var(--space-2); }
  .n { font-size: var(--text-3xl); font-weight: 700; color: var(--color-accent); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
  .stats > div { display: flex; flex-direction: column; }
  .stats strong { font-size: var(--text-xl); }
  .cands { display: flex; flex-direction: column; gap: var(--space-2); }
  .cand { display: grid; grid-template-columns: auto 1fr 140px auto; gap: var(--space-3); align-items: center; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line); background: transparent; min-height: 52px; }
  .cand[aria-pressed='true'] { border: 2px solid var(--color-focus); background: var(--color-raised); }
  .cand.ign { border-style: dashed; color: var(--color-text-muted); }
  .tt { display: flex; flex-direction: column; }
  .bdg { font-size: 11px; font-weight: 700; }
  .bdg[data-kind='best'] { color: var(--color-ok); }
  .bdg[data-kind='maybe'] { color: var(--color-warn); }
  .tips { margin: 0; padding-left: var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); }
  .small { font-size: var(--text-xs); }
</style>
