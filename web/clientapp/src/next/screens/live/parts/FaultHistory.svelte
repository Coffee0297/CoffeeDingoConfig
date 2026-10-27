<script>
  // One PDM's fault history (upstream feat/fault-history): the last 32 output trips, kept in the module's FRAM across
  // power-off, newest first. Read when the module is on the bus; "Clear history" asks first (it is the only record).
  import { untrack } from 'svelte'
  import { Card, Button, Banner, Dialog, StateDot } from '../../../ui/index.js'
  import { api, read, toast } from '../../../lib/live.svelte.js'
  import { rows } from './faulthistory.js'

  let { dev } = $props()
  let log = $state(null), err = $state(''), reading = $state(false), confirm = $state(false), clearing = $state(false)
  async function load() {
    reading = true
    try { log = await api.faultLog(dev.guid); err = '' } catch (e) { err = e?.message ?? String(e) } finally { reading = false }
  }
  const on = $derived(!!dev.connected)
  $effect(() => { if (on) untrack(load) })   // once each time it comes on the bus, not on every telemetry push
  const list = $derived(rows(log?.entries, log?.bootCount ?? 0, dev.outputs))

  async function clear() {
    clearing = true
    const r = await read(() => api.faultLogClear(dev.guid))
    clearing = false
    if (r !== undefined) { confirm = false; toast(`Cleared the fault history on ${dev.name}.`, 'info', 2500); await load() }
  }
</script>

<Card title={`Fault history · ${dev.name}`} subtitle={log ? `${log.entries.length} of 32 kept · ${log.bootCount} power-ons since it started` : 'Kept on the module across power-off'} aria-label={`Fault history of ${dev.name}`}>
  {#snippet actions()}
    <Button size="sm" busy={reading} disabled={!on} onclick={load} data-testid="fh-read">Read again</Button>
    <Button size="sm" variant="danger" disabled={!on || !log?.entries.length} onclick={() => (confirm = true)} data-testid="fh-clear">Clear history</Button>
  {/snippet}
  {#if !on}
    <p class="muted">{dev.name} is not on the bus. Its history is read when it is.</p>
  {:else if err}
    <Banner tone="warn" title={`Could not read the fault history of ${dev.name}.`}>{err}</Banner>
  {:else if !log}
    <p class="muted" role="status">Reading the fault history…</p>
  {:else if !list.length}
    <p class="muted" data-testid="fh-empty">No output has tripped since the history was cleared.</p>
  {:else}
    <table class="nx-table" aria-label={`Fault history of ${dev.name}`} data-testid="fh-table">
      <thead><tr><th>When</th><th>Output</th><th>What</th><th>Current</th><th>Battery</th></tr></thead>
      <tbody>
        {#each list as e (e.n)}
          <tr data-testid="fh-row">
            <td>{e.when}</td>
            <td>{e.name} <span class="muted mono">out {e.output}</span></td>
            <td title={e.why}><StateDot tone="fault" shape={e.kind === 1 ? 'diamond' : 'square'} label={e.what} /></td>
            <td class="mono">{e.amps.toFixed(1)} A</td>
            <td class="mono">{e.volts.toFixed(2)} V</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="muted small">No clock on the module: each trip is timed from the power-on of its boot. A boot is every power-on, restart or wake from sleep.</p>
  {/if}
</Card>

<Dialog bind:open={confirm} title={`Clear the fault history on ${dev.name}?`} description="The history is the only record of these trips. Clearing it cannot be undone.">
  {#snippet footer()}
    <Button onclick={() => (confirm = false)}>Cancel</Button>
    <Button variant="danger" busy={clearing} onclick={clear} data-testid="fh-clear-confirm">Clear history</Button>
  {/snippet}
</Dialog>

<style>
  .small { font-size: var(--text-xs); }
</style>
