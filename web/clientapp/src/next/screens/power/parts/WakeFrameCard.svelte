<script>
  // Wake frame per upstream PDM (feat/wake-on-frame, param 0x0100): only one frame keeps the module awake, so it can
  // sleep on a bus where other modules keep talking. Shown only for modules whose Read listed 0x0100 (dev.wakeFrame).
  import { untrack } from 'svelte'
  import { Card, Banner, Button, Checkbox, Field, Select, StateDot } from '../../../ui/index.js'
  import { live, api, hex, project, toast } from '../../../lib/live.svelte.js'
  import { INDEX, parseByte, byteText, problem, writes, fromFrame, matches } from './wakeFrame.js'

  const mods = $derived(live.devices.filter((d) => d.wakeFrame))
  const modKey = $derived(mods.map((d) => d.guid).join(','))
  let drafts = $state({}), busy = $state(''), status = $state(''), seen = $state([])
  // a draft per module from what it last reported, made once per module (edits are not overwritten by telemetry)
  $effect(() => {
    modKey
    untrack(() => { for (const d of mods) if (!drafts[d.guid]) drafts[d.guid] = $state.snapshot(d.wakeFrame) })
  })
  async function refreshSeen() {
    try { seen = ((await api.canlog()) ?? []).filter((r) => r.dir === 'Rx') } catch { seen = [] }
  }
  $effect(() => { if (modKey && live.connected) untrack(refreshSeen) })

  const idText = (wf) => wf.id.toString(16).toUpperCase()
  const frameItems = (d) => seen.filter((r) => r.id < d.baseId || r.id > d.baseId + 31)
    .map((r) => ({ value: `${r.id}:${r.ext ? 1 : 0}`, label: `${r.ext ? r.id.toString(16).toUpperCase().padStart(8, '0') : hex(r.id)} · ${r.len} B · ${r.data}` }))
  function fill(d, v) {
    const [id, ext] = String(v).split(':').map(Number)
    const f = seen.find((r) => r.id === id && (r.ext ? 1 : 0) === ext)
    if (f) drafts[d.guid] = fromFrame(drafts[d.guid], f)
  }
  const liveMatch = (wf) => { const f = seen.filter((r) => r.id === wf.id && !!r.ext === !!wf.ext); return f.length ? f.some((r) => matches(wf, r)) : null }

  async function send(d) {
    const wf = drafts[d.guid], why = problem(wf)
    if (why) { toast(`${d.name}: ${why}`, 'error', 7000); return }
    if (!d.connected) { toast(`${d.name} is not on the bus. Connect it first, then try again.`, 'error', 7000); return }
    busy = d.guid; status = ''
    try {
      for (const [sub, v] of writes(wf)) await api.writeParam(d.guid, INDEX, sub, v)
      project.dirty = true
      status = `${d.name}: wake frame ${wf.enabled ? 'on' : 'off'}. Apply to car stores it on the module.`
    } catch (e) { toast(`${d.name}: ${e?.message ?? e}`, 'error', 9000) } finally { busy = '' }
  }
</script>

{#if mods.length}
  <Card title="Wake frame" subtitle="Only one CAN frame keeps the module awake, so it can sleep while the rest of the car keeps talking." aria-label="Wake frame">
    <Banner tone="warn" title="Check the frame before you rely on it.">With a frame that never comes, the module sleeps 30 s after its outputs are off even while the car talks. Any CAN frame still wakes it, but it then restarts first, so a CAN command is followed only after the restart.</Banner>
    {#each mods as d (d.guid)}
      {@const wf = drafts[d.guid]}
      {#if wf}
        {@const m = liveMatch(wf)}
        <section class="mod" data-module={d.name}>
          <h3>{d.name} <span class="muted mono">{hex(d.baseId)}</span></h3>
          <Checkbox label="Only this frame keeps it awake" hint="Off: any CAN traffic keeps it awake (as before)" bind:checked={wf.enabled} disabled={busy === d.guid} data-testid={`wf-${d.name}-enabled`} />
          <div class="three">
            <Field label="ID (hex)" mono value={idText(wf)} onchange={(v) => { const n = parseInt(String(v).replace(/^0x/i, ''), 16); wf.id = Number.isFinite(n) ? n : -1 }} data-testid={`wf-${d.name}-id`} />
            <Checkbox label="Extended ID" bind:checked={wf.ext} />
            <Field label="At least" type="number" min="0" max="8" unit="bytes" bind:value={() => wf.minLength, (v) => (wf.minLength = Number(v))} />
          </div>
          <div class="nx-scroll">
            <table class="nx-table bytes">
              <thead><tr><th></th>{#each Array(8) as _, i (i)}<th class="c">B{i}</th>{/each}</tr></thead>
              <tbody>
                {#each [['mask', 'Must match (mask)'], ['value', 'Value']] as [k, label] (k)}
                  <tr><th scope="row">{label}</th>
                    {#each Array(8) as _, i (i)}
                      <td class="c"><input class="mono byte" aria-label={`${d.name} byte ${i} ${k}`} value={byteText(wf[k][i])}
                        onchange={(e) => { const b = parseByte(e.currentTarget.value); wf[k][i] = b ?? -1 }} /></td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="muted small">A mask bit set means that bit of the byte must equal the value. Mask 00 = any value. FF = the whole byte.</p>
          <div class="row">
            <div class="grow"><Select label="Fill from a frame on the bus" items={frameItems(d)} placeholder={seen.length ? 'Pick a frame seen just now…' : 'No frames seen yet'} value="" onchange={(v) => fill(d, v)} data-testid={`wf-${d.name}-fill`} /></div>
            <Button size="sm" onclick={refreshSeen}>Look again</Button>
          </div>
          {#if m != null}<p class="small" role="status"><StateDot tone={m ? 'ok' : 'warn'} shape="dot" label="" /> {m ? 'The frame on the bus right now matches.' : 'A frame with this ID is on the bus but does not match.'}</p>{/if}
          {#if problem(wf)}<p class="err small">{problem(wf)}</p>{/if}
          <Button variant="primary" busy={busy === d.guid} disabled={!!problem(wf) || !d.connected} onclick={() => send(d)} data-testid={`wf-${d.name}-send`}>Send to {d.name}</Button>
        </section>
      {/if}
    {/each}
    {#if status}<p class="muted" role="status" data-testid="wf-status"><StateDot tone="ok" shape="dot" label="" /> {status}</p>{/if}
  </Card>
{/if}

<style>
  .mod { display: flex; flex-direction: column; gap: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--color-line); }
  h3 { margin: 0; font-size: var(--text-md); }
  .three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); align-items: end; }
  .bytes .c { text-align: center; padding-left: 2px; padding-right: 2px; }
  .byte { width: 3.2em; min-height: 44px; text-align: center; font: inherit; border: 1px solid var(--color-line-strong); border-radius: var(--radius-sm, 4px); background: var(--color-surface, transparent); color: inherit; }
  .row { display: flex; gap: var(--space-3); align-items: end; }
  .grow { flex: 1; min-width: 0; }
  .small { font-size: var(--text-xs); }
  .err { color: var(--color-fault); }
  @media (max-width: 600px) { .three { grid-template-columns: minmax(0, 1fr); } }
</style>
