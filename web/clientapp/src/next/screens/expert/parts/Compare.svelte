<script>
  // Compare tab (board H28, tab 4): what the project holds versus what a module held at its last read.
  // The backend keeps the per-parameter differences of the last Read of each module. A Read copies the
  // module's values into the project, so "Use module" needs no action; "Use project" writes the
  // project's old value back to the module and reads it back to confirm.
  import { onMount } from 'svelte'
  import { Card, Button, Chip, Banner, Dialog, Empty } from '../../../ui/index.js'
  import { live, api, toast, project, isPdm, isCanboard } from '../../../lib/live.svelte.js'
  import { getSchema, writeConfirmed, writable } from './params.js'

  let diffs = $state({}) // guid -> entries | undefined
  let schema = $state(null)
  let sel = $state(null)
  let choice = $state({}) // `${guid}|${name}` -> 'p' | 'm'
  let done = $state({}) // key -> { k, t }
  let busy = $state(false)
  let readBusy = $state(false)
  let confirmRead = $state(false)
  let applied = $state('')
  let loadErr = $state('')

  const mods = $derived(live.devices.filter((d) => isPdm(d) || isCanboard(d)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))
  const cur = $derived(mods.find((m) => m.guid === sel) ?? mods[0])
  const sim = $derived(live.adapter === 'Sim')
  const modLive = $derived(live.connected && !!cur?.connected)

  async function loadDiff(guid) {
    try { diffs[guid] = (await api.configDiff(guid)) ?? [] } catch (e) { loadErr = e.message }
  }
  onMount(() => { getSchema().then((s) => (schema = s)).catch(() => {}) })
  $effect(() => { for (const m of mods) if (!(m.guid in diffs)) { diffs[m.guid] = undefined; loadDiff(m.guid) } })

  const entries = $derived(cur ? (diffs[cur.guid] ?? []) : [])
  const key = (e) => `${cur.guid}|${e.name}`
  // 'mismatch' = the project differs from the module (the app noticed) but no Read has listed the differences yet.
  const cmpState = (m) => {
    const n = diffs[m.guid]?.length
    if (n === undefined) return { w: 'checking…', tone: 'muted' }
    if (n) return { w: `${n} differ`, tone: 'warn' }
    return m.configMismatch ? { w: 'not read yet', tone: 'warn' } : { w: 'same', tone: 'ok' }
  }
  const unread = $derived(!!cur && !entries.length && cur.configMismatch)
  const canWrite = (e) => e.kind === 'value' && writable(paramOf(e) ?? { type: 'string' })
  const paramOf = (e) => schema?.devices?.find((d) => d.guid === cur?.guid)?.params?.find((p) => p.name === e.name)
  const nP = $derived(entries.filter((e) => choice[key(e)] === 'p').length)
  const nM = $derived(entries.filter((e) => choice[key(e)] === 'm').length)
  const nU = $derived(entries.filter((e) => canWrite(e) && !choice[key(e)]).length)
  const blocked = $derived(nP > 0 && (!modLive || sim))
  const applyOff = $derived(nP + nM === 0 || blocked || busy)

  function setAll(v) {
    const c = { ...choice }
    for (const e of entries) if (canWrite(e)) c[key(e)] = v
    choice = c; applied = ''
  }

  async function apply() {
    busy = true; applied = ''
    const g = cur.guid, name = cur.name
    let ok = 0, kept = 0, bad = 0
    const rowsP = entries.filter((e) => choice[key(e)] === 'p')
    for (const e of rowsP) {
      const p = paramOf(e), k = key(e)
      if (!p || e.appValue == null || e.appValue === '—') { done[k] = { k: 'fault', t: 'The project has no value to send.' }; bad++; continue }
      try {
        const r = await writeConfirmed(g, p, e.appValue)
        done[k] = { k: r.state === 'ok' ? 'ok' : r.state === 'refused' ? 'fault' : 'warn', t: r.text }
        if (r.state === 'ok') ok++; else bad++
      } catch (err) { done[k] = { k: 'fault', t: err.message }; bad++ }
    }
    for (const e of entries.filter((x) => choice[key(x)] === 'm')) { done[key(e)] = { k: 'ok', t: 'The project keeps the module\'s value.' }; kept++ }
    if (rowsP.length) project.dirty = true
    applied = `Sent ${ok} to ${name}${bad ? `, ${bad} did not match` : ' and read back: all match'}. The project keeps the module's value for ${kept}.`
    busy = false
  }

  async function doRead() {
    confirmRead = false
    const g = cur.guid, name = cur.name
    readBusy = true
    try {
      await api.action(g, 'read')
      await loadDiff(g)
      const n = diffs[g]?.length ?? 0
      toast(n ? `${name}: ${n} setting${n === 1 ? '' : 's'} differ.` : `${name}: same settings as the project.`, 'info', 4000)
    } catch (e) { toast('Read failed: ' + e.message, 'error', 7000) } finally { readBusy = false }
  }
  const KIND = { value: '', appOnly: 'The module does not have this setting (older firmware).', deviceOnly: 'The module has a setting this app does not know (newer firmware).' }
  const MARK = { ok: ['✓', 'var(--color-ok)'], warn: ['■', 'var(--color-warn)'], fault: ['✕', 'var(--color-fault)'] }
</script>

{#if loadErr}<Banner tone="fault" title="Could not load the differences.">{loadErr}</Banner>{/if}
{#if !live.connected}
  <Banner tone="info" title="Not connected.">The differences are from the last read of each module. Send project value is off. Use module still works.</Banner>
{:else if sim}
  <Banner tone="warn" title="Sim adapter active.">Programming is off: Use project is disabled. Reading and Use module still work.</Banner>
{/if}

<Card title="Project against module" subtitle="Per module, from its last read">
  <div class="chips" role="group" aria-label="Module">
    {#each mods as m (m.guid)}
      {@const s = cmpState(m)}
      <button class="chip" aria-pressed={m.guid === cur?.guid} onclick={() => { sel = m.guid; applied = '' }} data-testid="cmp-mod">
        <strong>{m.name}</strong><Chip tone={s.tone} symbol={s.tone === 'ok' ? '✓' : s.tone === 'warn' ? '◇' : '○'}>{s.w}</Chip>
      </button>
    {/each}
  </div>

  {#if !mods.length}<Empty title="No modules" text="Add a module to compare it." />
  {:else if cur}
    {#if unread}
      <Banner tone="warn" title={`${cur.name} differs from the project, but the differences are not listed yet.`}>
        Reading brings the module's values into the project. The differences stay listed here so you can send the project's value back.
        {#snippet actions()}<Button onclick={() => (confirmRead = true)} busy={readBusy} disabled={!modLive} title={modLive ? '' : cur.name + ' is not connected.'} data-testid="cmp-read">Read {cur.name} to compare</Button>{/snippet}
      </Banner>
    {:else if !entries.length}
      <div class="same" data-testid="cmp-same">
        <p><strong>{cur.name}</strong> has the same settings as the project.</p>
        <Button onclick={() => (confirmRead = true)} busy={readBusy} disabled={!modLive} title={modLive ? '' : cur.name + ' is not connected.'} data-testid="cmp-read">Read {cur.name} again</Button>
      </div>
    {:else}
      <p class="muted" data-testid="cmp-summary">{cur.name} · {entries.length} {entries.length === 1 ? 'setting differs' : 'settings differ'}. "Project" is what the project held before the read. "Module" is what the module held.</p>
      <div class="bulk">
        <Button size="sm" onclick={() => setAll('p')} data-testid="cmp-all-project">Use project for all</Button>
        <Button size="sm" onclick={() => setAll('m')} data-testid="cmp-all-module">Use module for all</Button>
      </div>
      <div class="nx-scroll tw">
        <table class="nx-table" data-testid="cmp-table">
          <thead><tr><th>Setting</th><th>Project</th><th>Module</th><th>Keep</th><th>State</th></tr></thead>
          <tbody>
            {#each entries as e (e.name + e.index + ':' + e.subIndex + e.kind)}
              {@const k = key(e)}
              {@const w = canWrite(e)}
              {@const c = choice[k]}
              {@const d = done[k]}
              <tr data-param={e.name}>
                <td class="mono nm">{e.name}{#if !w}<div class="muted ty">{KIND[e.kind] || 'This setting is a label stored in the project only.'}</div>{/if}</td>
                <td class="mono">{e.appValue ?? '—'}</td>
                <td class="mono">{e.deviceValue ?? '—'}</td>
                <td>
                  <fieldset class="rg" disabled={!w} aria-label={`Which value to keep for ${e.name}`}>
                    <label><input type="radio" name={'c-' + k} checked={c === 'p'} onchange={() => { choice[k] = 'p'; applied = '' }} disabled={!w || !modLive || sim} data-testid="cmp-use-project" /> Use project</label>
                    <label><input type="radio" name={'c-' + k} checked={c === 'm'} onchange={() => { choice[k] = 'm'; applied = '' }} disabled={!w} data-testid="cmp-use-module" /> Use module</label>
                  </fieldset>
                </td>
                <td aria-live="polite" style="color: {d ? MARK[d.k][1] : c ? 'var(--color-text)' : 'var(--color-warn)'}">
                  {#if d}<span aria-hidden="true">{MARK[d.k][0]}</span> {d.t}
                  {:else if c === 'p'}→ Will be sent to the module
                  {:else if c === 'm'}← Project keeps the module's value
                  {:else if w}◇ Undecided{:else}○ Can't be changed here{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="foot">
        <p class="muted" role="status" data-testid="cmp-foot">{#if applied}{applied}{:else if blocked}{!live.connected ? 'Not connected' : 'Sim adapter'}: sending to the module is off. Choose Use module, or connect a real adapter.{:else}{nU} undecided · {nP} will be sent to the module · {nM} keep the module's value.{/if}</p>
        <Button variant="primary" onclick={apply} disabled={applyOff} busy={busy} data-testid="cmp-apply">Apply choices</Button>
      </div>
    {/if}
  {/if}
</Card>

<Dialog bind:open={confirmRead} title={`Read ${cur?.name ?? 'the module'}?`} description="The module's values replace the project's copy of this module. The differences stay listed here, so you can send the project's value back afterwards. Reading takes a few seconds.">
  {#snippet footer()}
    <Button onclick={() => (confirmRead = false)}>Cancel</Button>
    <Button variant="primary" onclick={doRead} data-testid="cmp-read-go">Read</Button>
  {/snippet}
</Dialog>

<style>
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .chip { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--target-min); padding: 0 var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: transparent; }
  .chip[aria-pressed='true'] { background: var(--color-raised); border-color: var(--color-accent); }
  .same { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .bulk { display: flex; gap: var(--space-2); }
  .tw { max-height: 520px; }
  .nm { word-break: break-all; font-weight: 700; }
  .ty { font-size: 11px; font-weight: 500; }
  .rg { border: 0; margin: 0; padding: 0; display: flex; gap: var(--space-3); min-width: 0; }
  .rg label { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; white-space: nowrap; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
</style>
