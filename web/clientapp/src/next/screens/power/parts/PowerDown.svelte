<script>
  // Power-down timeline, built from the sequence the modules hold (see sequence.svelte.js).
  import { Card, Banner, Button } from '../../../ui/index.js'
  import { live, hex } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  let { seq } = $props()

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const frameMod = $derived(mods.find((d) => seq.state.perModule[d.guid]?.frame) ?? null)
  // The sequence lives on the master if there is one (it sends the shutdown frame), else on the first module with an off delay.
  const master = $derived(frameMod ?? mods.find((d) => seq.state.perModule[d.guid]?.sleepS != null) ?? null)
  const s = $derived(master ? seq.state.perModule[master.guid] : null)
  const plan = $derived.by(() => {
    if (!s || s.sleepS == null) return null
    const end = Math.max(1, s.sleepS)
    const marks = [{ at: 0, name: 'Ignition off' }]
    if (s.holdS) marks.push({ at: Math.min(s.holdS, end), name: 'Held outputs off' })
    if (s.frame && s.frameS) marks.push({ at: Math.min(s.frameS, end), name: `Shutdown frame ${hex(s.frame.id)} ends` })
    if (s.quietS != null) marks.push({ at: Math.min(s.quietS, end), name: 'Bus goes quiet' })
    marks.push({ at: end, name: 'Modules sleep' })
    marks.sort((a, b) => a.at - b.at)
    const segs = []
    for (let i = 0; i < marks.length - 1; i++) {
      const dur = marks[i + 1].at - marks[i].at
      if (dur <= 0) continue
      const quiet = s.quietS != null && marks[i].at >= s.quietS
      segs.push({ name: quiet ? 'Quiet bus' : s.holdS && marks[i].at < s.holdS ? 'Outputs held' : 'Awake, ignition off', dur, quiet })
    }
    return { end, marks, segs }
  })
</script>

<Card title="Power-down after the ignition goes off" aria-label="Power-down">
  {#if !live.connected}
    <Banner tone="warn" title="Not connected">The timeline is read from the modules. Connect to the car to see it.</Banner>
  {:else if !seq.state.loaded}
    <p class="muted" role="status">Reading the modules…</p>
  {:else if !plan}
    <Banner tone="info" title="No power-down order is set up" data-testid="no-sequence">Each module sleeps by its own timer (see the table). To make the car go quiet in order, set a shutdown sequence in the old UI under System, Settings, for now.</Banner>
  {:else}
    <p class="muted" data-testid="sequence-source">Read from {master.name}: {frameMod ? 'it sends the shutdown frame.' : 'it holds the off delay.'}</p>
    <div class="tl" role="img" aria-label={`Power-down timeline: ${plan.marks.map((m) => `${m.at} s ${m.name}`).join(', ')}`} data-testid="power-timeline">
      {#each plan.segs as g, i (i)}
        <div class="seg" class:quiet={g.quiet} style="flex: {g.dur} 1 0"><span class="n">{g.name}</span><span class="l mono">{g.dur} s</span></div>
      {/each}
      <div class="seg end" style="flex: {Math.max(1, plan.end / 3)} 1 0"><span class="n">Asleep</span><span class="l mono">until a wake source</span></div>
    </div>
    <ul class="muted rules" data-testid="power-rules">
      <li>Ignition outputs switch off when the ignition goes off.</li>
      {#if s.holdS}<li>Held outputs stay on for {s.holdS} s.</li>{/if}
      {#if s.frame}<li>Shutdown frame <span class="mono">{hex(s.frame.id)}</span> every {s.frame.intervalMs} ms for {s.frameS ?? '?'} s, so the other modules know.</li>{/if}
      {#if s.quietS != null}<li>The bus goes quiet {s.quietS} s after ignition off.</li>{/if}
      <li>All modules sleep {plan.end} s after ignition off. A door, a switch or CAN traffic wakes them.</li>
    </ul>
  {/if}
  <div><Button size="sm" href={href('power', 'sleep')}>Open sleep settings</Button></div>
</Card>

<style>
  .tl { display: flex; gap: 4px; min-height: 64px; }
  .seg { border-radius: var(--radius-md); background: var(--color-on-soft); padding: 8px 10px; display: flex; flex-direction: column; justify-content: center; min-width: 0; border: 1px solid var(--color-line); }
  .seg.quiet { background: var(--color-warn-soft); }
  .seg.end { background: var(--color-raised); }
  .n { font-weight: 600; font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l { font-size: var(--text-xs); color: var(--color-text-muted); }
  .rules { margin: 0; padding-left: 20px; line-height: 1.7; }
</style>
