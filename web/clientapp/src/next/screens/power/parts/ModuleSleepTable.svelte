<script>
  // Every module: its role in sleeping, live sleep status, last wake (firmware 5.6).
  import { Card, StateDot } from '../../../ui/index.js'
  import { live, hex } from '../../../lib/live.svelte.js'
  import { sleepStatus, canSleep, wakeWords, noWakeWords, noSleepWhy } from './sleepLogic.js'
  let { seq } = $props()
  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  function role(d) {
    const s = seq.state.perModule[d.guid]
    if (s?.master) return 'Sleep master: keeps the car awake, then says "sleep now"'
    if (s?.follows) return `Sleeps on the master's "sleep now"`
    if (!canSleep(d)) return d.muteTxInput ? 'Goes quiet on request' : `Stays awake (no sleep: ${noSleepWhy(d)})`
    if (d.sleepEnabled) return `Own auto-sleep, ${Math.round(d.sleepTimeoutMs / 1000)} s`
    return d.forceSleepInput ? 'Sleeps on its sleep input' : 'Stays awake'
  }
</script>

<Card title="Every module: sleep and last wake" aria-label="Modules">
  <div class="nx-scroll">
    <table class="nx-table" data-testid="power-modules">
      <thead><tr><th>Module</th><th>Role</th><th>Sleep</th><th>Last woke from</th></tr></thead>
      <tbody>
        {#each mods as d (d.guid)}
          {@const st = sleepStatus(d, live.connected)}
          <tr data-module={d.name}>
            <td><strong>{d.name}</strong> <span class="muted mono">{hex(d.baseId)}</span></td>
            <td class="muted">{role(d)}</td>
            <td><StateDot tone={st.key} shape={st.key === 'on' ? 'dot' : st.key === 'off' ? 'ring' : 'diamond'} label={st.word} /> <span class="muted">{st.detail}</span></td>
            <td class="muted">{wakeWords(d) || noWakeWords(d)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</Card>
