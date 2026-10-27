<script>
  // Wake sources per module: one tick per digital input (a bit of wakeDigInputMask) + CAN activity.
  import { Card, StateDot } from '../../../ui/index.js'
  import { live, hex, toast } from '../../../lib/live.svelte.js'
  import { SUB, canSleep, digCount, writeParams, noSleepWhy, lastWake } from './sleepLogic.js'

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const maxDi = 8
  let busy = $state(''), status = $state('')

  async function change(d, kind, bit, on, el) {
    const mask = d.wakeDigInputMask ?? 0
    const newMask = kind === 'di' ? (on ? mask | (1 << bit) : mask & ~(1 << bit)) : mask
    const newCan = kind === 'can' ? on : d.wakeOnCan !== false
    if ((d.sleepEnabled || d.forceSleepInput) && newMask === 0 && !newCan) {
      toast(`${d.name} would have no way to wake up except ${lastWake(d)}. Keep at least one input or CAN activity ticked.`, 'error', 9000)
      el.checked = !on
      return
    }
    busy = d.guid; status = ''
    const ok = await writeParams(d, [kind === 'di' ? [SUB.wakeMask, newMask] : [SUB.wakeCan, on ? 1 : 0]])
    busy = ''
    if (!ok) el.checked = !on
    if (ok) status = `${d.name}: ${kind === 'di' ? `DI${bit + 1}` : 'CAN activity'} ${on ? 'now wakes' : 'no longer wakes'} the module.`
  }
  const why = (d) => !canSleep(d) ? `Cannot sleep: ${noSleepWhy(d)}. No wake sources.` : !d.connected ? 'Not on the bus. Connect it to change this.' : ''
</script>

<Card title="Wake sources, per module" subtitle="A sleeping module wakes when any ticked source happens. USB always wakes it." aria-label="Wake sources">
  <p class="muted legend">✓ wakes · empty box: does not wake · dash: no such pin on this board</p>
  <div class="nx-scroll">
    <table class="nx-table" data-testid="wake-matrix">
      <thead><tr><th>Module</th>{#each Array(maxDi) as _, i (i)}<th class="c">DI{i + 1}</th>{/each}<th class="c" title="CAN activity">CAN</th></tr></thead>
      <tbody>
        {#each mods as d (d.guid)}
          {@const n = digCount(d)}
          {@const lock = why(d)}
          <tr data-module={d.name}>
            <td class="mod"><strong>{d.name}</strong> <span class="muted mono">{hex(d.baseId)}</span>
              {#if lock}<div class="muted note">{lock}</div>{/if}</td>
            {#each Array(maxDi) as _, i (i)}
              <td class="c">
                {#if i < n}
                  <label class="cell"><input type="checkbox" checked={!!((d.wakeDigInputMask ?? 0) & (1 << i))} disabled={!!lock || busy === d.guid} aria-label={`${d.name} DI${i + 1} wakes the module`} data-testid={`wake-${d.name}-di${i + 1}`}
                    onchange={(e) => change(d, 'di', i, e.currentTarget.checked, e.currentTarget)} /></label>
                {:else}<span class="dash" aria-label="no such pin">-</span>{/if}
              </td>
            {/each}
            <td class="c"><label class="cell"><input type="checkbox" checked={d.wakeOnCan !== false} disabled={!!lock || busy === d.guid} aria-label={`${d.name} CAN activity wakes the module`} data-testid={`wake-${d.name}-can`}
              onchange={(e) => change(d, 'can', 0, e.currentTarget.checked, e.currentTarget)} /></label></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if status}<p class="muted" role="status" data-testid="wake-status"><StateDot tone="ok" shape="dot" label="" /> {status}</p>{/if}
</Card>

<style>
  .legend { font-size: var(--text-xs); }
  .c { text-align: center; width: 52px; padding-left: 2px; padding-right: 2px; }
  .mod { min-width: 170px; }
  .cell { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; cursor: pointer; }
  .cell input { width: 22px; height: 22px; accent-color: var(--color-accent); }
  .dash { color: var(--color-text-muted); }
  .note { font-size: var(--text-xs); white-space: normal; }
</style>
