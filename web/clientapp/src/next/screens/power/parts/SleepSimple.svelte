<script>
  // "Automatic sleep" card: the three simple switches, written to every module that can sleep.
  import { Card, Chip, Switch, Stepper, FwBadge } from '../../../ui/index.js'
  import { live, toast } from '../../../lib/live.svelte.js'
  import { SUB, upSub, canSleep, writeParams, TIMEOUT_MIN_S, TIMEOUT_MAX_S, secs, lastWake } from './sleepLogic.js'
  import { isUpstream } from '../../hardware/parts/util.js'

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '') && canSleep(d)))
  const reachable = $derived(mods.filter((d) => d.connected))
  const all = (f) => mods.length > 0 && mods.every(f)
  const some = (f) => mods.some(f)
  const autoOn = $derived(all((d) => d.sleepEnabled))
  const ignoreOn = $derived(all((d) => d.sleepIgnoreAlwaysOn))
  const timeoutS = $derived(mods.length ? Math.round(mods[0].sleepTimeoutMs / 1000) : 30)
  const mixed = $derived(mods.length > 1 && (some((d) => d.sleepEnabled !== mods[0].sleepEnabled) || some((d) => d.sleepTimeoutMs !== mods[0].sleepTimeoutMs) || some((d) => d.sleepIgnoreAlwaysOn !== mods[0].sleepIgnoreAlwaysOn)))
  // upstream dingoFW: sleep time fixed at 30 s, no ignore-always-on setting, unless it has feat/sleep-config (sub 9, 10)
  const allUp = $derived(all((d) => isUpstream(d) && !upSub(d, 9)))
  const noWake = (d) => (d.wakeDigInputMask ?? 0) === 0 && d.wakeOnCan === false

  let draftS = $state(30), editing = $state(false)
  $effect(() => { if (!editing) draftS = timeoutS })
  let busy = $state(false), status = $state(''), timer

  async function apply(writes, label) {
    if (!reachable.length) { status = 'No module that can sleep is answering. Connect to the car first.'; return }
    busy = true; status = `Writing ${label}…`
    let okN = 0
    const skipped = mods.length - reachable.length
    for (const d of reachable) if (await writeParams(d, writes)) okN++
    busy = false; editing = false
    status = okN === reachable.length
      ? `Written to ${okN} module${okN === 1 ? '' : 's'}${skipped ? `. ${skipped} not on the bus, skipped` : ''}. Store it with Apply to car to keep it after power-off.`
      : `Written to ${okN} of ${reachable.length} modules. See the messages above.`
  }
  function setAuto(on) {
    if (on) {
      const bad = reachable.filter(noWake)
      if (bad.length) { toast(`${bad.map((d) => `${d.name} has no way to wake up except ${lastWake(d)}`).join('; ')}. Tick a wake input or CAN activity below first.`, 'error', 9000); return }
    }
    apply([[SUB.enabled, on ? 1 : 0]], 'automatic sleep')
  }
  function setIgnore(on) { apply([[SUB.ignoreAlwaysOn, on ? 1 : 0]], 'always-on setting') }
  function onSeconds(v) {
    editing = true
    clearTimeout(timer)
    timer = setTimeout(() => apply([[SUB.timeout, Math.min(TIMEOUT_MAX_S, Math.max(TIMEOUT_MIN_S, Math.round(v))) * 1000]], 'sleep time'), 600)
  }
  const sentence = $derived(!mods.length ? 'No module here can sleep.'
    : !autoOn ? 'Automatic sleep is off. Modules stay awake until you press Sleep now or the sleep input becomes true.'
    : `The car goes to sleep ${timeoutS} s after nothing is in use (1 to 60 s). ${ignoreOn ? 'Outputs that are always on do not count as in use. ' : 'Every output that is on counts as in use. '}A door, a switch or CAN traffic wakes the modules again.`)
</script>

<Card title="Automatic sleep" aria-label="Simple sleep settings">
  {#snippet tag()}<Chip tone="muted">SIMPLE</Chip>{/snippet}
  {#if !live.connected}
    <p class="muted" role="status">Not connected. The values below are the project's. Connect to the car to change them.</p>
  {/if}
  <p class="muted scope">Applies to {mods.length} module{mods.length === 1 ? '' : 's'} that can sleep: {mods.map((d) => d.name).join(', ') || 'none'}.{mixed ? ' They differ today; a change sets them all the same.' : ''}</p>
  <Switch label="Sleep on its own" hint="When nothing is in use, the whole car goes to sleep." checked={autoOn} disabled={!reachable.length || busy} onchange={(v) => v !== autoOn && setAuto(v)} data-testid="sleep-auto" />
  {#if !allUp}
  <div class="row">
    <div class="grow"><strong>Sleep after nothing is in use for</strong><div class="muted hint">Counted from the last moment anything was in use.</div></div>
    <Stepper label="Seconds before sleep" bind:value={draftS} min={TIMEOUT_MIN_S} max={TIMEOUT_MAX_S} step={5} unit="s" disabled={!reachable.length || busy || !autoOn} onchange={onSeconds} data-testid="sleep-seconds" />
  </div>
  <div class="row">
    <div class="grow"><Switch label="Ignore always-on outputs" hint="Outputs with the role Always on (data logger, clock memory) do not count as in use." checked={ignoreOn} disabled={!reachable.length || busy} onchange={(v) => v !== ignoreOn && setIgnore(v)} data-testid="sleep-ignore" /></div>
    <FwBadge version="5.6" />
  </div>
  {:else}<p class="muted">Upstream dingoFW sleeps after 30 s with nothing in use; that time is fixed in its firmware.</p>{/if}
  <p class="sentence" role="status" aria-live="polite" data-testid="sleep-sentence">{sentence}</p>
  {#if status}<p class="muted" role="status" data-testid="sleep-status">{status}</p>{/if}
</Card>

<style>
  .row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .grow { flex: 1 1 280px; min-width: 0; }
  .hint { font-size: var(--text-xs); }
  .scope { font-size: var(--text-xs); }
  .sentence { padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); }
</style>
