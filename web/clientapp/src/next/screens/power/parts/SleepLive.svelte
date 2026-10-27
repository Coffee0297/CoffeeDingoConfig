<script>
  // Live sleep status for every module, plus Sleep now / Wake up for the whole car.
  import { Card, Chip, StateDot, Button, Banner } from '../../../ui/index.js'
  import { live, api, toast, hex } from '../../../lib/live.svelte.js'
  import { sleepStatus, canSleep, wakeWords, noWakeWords, upSub } from './sleepLogic.js'
  import Confirm from './Confirm.svelte'

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const rows = $derived(mods.map((d) => ({ d, st: sleepStatus(d, live.connected) })))
  const awake = $derived(rows.filter((r) => r.st.key === 'on').length)
  const asleep = $derived(rows.filter((r) => r.st.word === 'Asleep').length)
  const unseen = $derived(rows.filter((r) => r.st.word === 'Not seen').length)
  const gone = $derived(asleep + unseen)
  const banner = $derived(!live.connected ? { tone: 'warn', title: 'Not connected', text: 'Connect to the car to see which modules are awake.' }
    : gone === 0 ? { tone: 'ok', title: `Awake: ${awake} of ${mods.length} modules answer`, text: 'The sleep timer counts while nothing is in use.' }
    : { tone: 'info', title: `${awake} of ${mods.length} modules answer`, text: [asleep && `${asleep} asleep`, unseen && `${unseen} not seen: asleep on older firmware, or unplugged`].filter(Boolean).join(', ') + '.' })

  let confirmOpen = $state(false), busy = $state(''), result = $state('')
  async function each(action, targets) {
    busy = action; result = ''
    let ok = 0; const failed = []
    for (const d of targets) {
      try { await api.action(d.guid, action); ok++ } catch (e) { failed.push(`${d.name}: ${e?.message ?? e}`) }
    }
    busy = ''; confirmOpen = false
    result = `${action === 'sleep' ? 'Sleep' : 'Wake up'} sent to ${ok} module${ok === 1 ? '' : 's'}.` + (failed.length ? ` ${failed.length} refused: ${failed.join('; ')}` : '')
    if (failed.length) toast(result, 'error', 9000)
  }
  const sleepTargets = $derived(mods.filter((d) => d.connected && canSleep(d)))
  // upstream dingoFW with feat/sleep-config: the request only acts with automatic sleep on, nothing on and no USB, 2 s later
  const strict = $derived(sleepTargets.filter((d) => upSub(d, 9)))
  const wakeTargets = $derived(mods.filter((d) => /pdm|canboard/i.test(d.type ?? '') ))
</script>

<Card title="Live: every module" aria-label="Live sleep status">
  {#snippet tag()}<Chip tone="on" symbol="●">LIVE</Chip>{/snippet}
  <Banner tone={banner.tone} title={banner.title} data-testid="sleep-banner">{banner.text}</Banner>
  <div class="nx-scroll">
    <table class="nx-table" data-testid="sleep-live">
      <thead><tr><th>Module</th><th>Sleep</th><th>Last woke from</th></tr></thead>
      <tbody>
        {#each rows as { d, st } (d.guid)}
          <tr data-module={d.name}>
            <td><strong>{d.name}</strong> <span class="muted mono">{hex(d.baseId)}</span></td>
            <td><StateDot tone={st.key} shape={st.key === 'on' ? 'dot' : st.key === 'off' ? 'ring' : 'diamond'} label={st.word} /> <span class="muted">{st.detail}</span></td>
            <td class="muted" data-testid="last-wake">{wakeWords(d) || noWakeWords(d)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="actions">
    <Button variant="danger" disabled={!sleepTargets.length || !!busy} busy={busy === 'sleep'} onclick={() => (confirmOpen = true)} data-testid="sleep-now">Sleep now</Button>
    <Button disabled={!live.connected || !!busy} busy={busy === 'wakeup'} onclick={() => each('wakeup', wakeTargets)} data-testid="wake-up">Wake up</Button>
    <span class="muted note">Both ask every module that answers. A module asleep cannot answer sleep; it needs a wake source.</span>
  </div>
  {#if result}<p class="muted" role="status" data-testid="sleep-result">{result}</p>{/if}
</Card>

<Confirm bind:open={confirmOpen} title="Put the car to sleep now?" confirmLabel="Sleep now" variant="danger" busy={busy === 'sleep'}
  consequence="The modules go quiet and dingoConfig stops seeing them. Wake them with a wake source (door, switch, CAN traffic) or USB. Modules do not sleep while USB is connected."
  onconfirm={() => each('sleep', sleepTargets)}>
  <p>This asks {sleepTargets.length} module{sleepTargets.length === 1 ? '' : 's'} to sleep: {sleepTargets.map((d) => d.name).join(', ')}. Outputs they drive switch off.</p>
  {#if strict.length}<p data-testid="sleep-strict">{strict.map((d) => d.name).join(', ')} only sleep{strict.length === 1 ? 's' : ''} this way with automatic sleep on, no output on and no USB connected, 2 s after the request. Otherwise {strict.length === 1 ? 'it answers but stays' : 'they answer but stay'} awake.</p>{/if}
</Confirm>

<style>
  .actions { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .note { font-size: var(--text-xs); flex: 1 1 240px; }
</style>
