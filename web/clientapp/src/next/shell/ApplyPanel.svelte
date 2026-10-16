<script>
  // Apply panel (board H17, right half): which modules differ, Read, Apply to car (write),
  // Store on modules (burn), and what each module said.
  // Backed by telemetry (configMismatch, configDiffCount, reading), GET /devices/{id}/config-diff and
  // POST /devices/{id}/read|write|burn.
  // Gaps: "stored on module" is not reported by the backend (G3), so Written / Stored are tracked for this
  // session only; there is no staged "not sent" list (G2): configMismatch means "not yet compared or written".
  import { untrack } from 'svelte'
  import { Dialog, Button, Banner, StateDot, Chip } from '../ui/index.js'
  import { live, api, toast, hex, pendingModules } from '../lib/live.svelte.js'
  import { href } from '../router.svelte.js'
  import { ui } from './ui.svelte.js'
  import { postAction, waitRead } from './parts/act.js'

  const open = $derived(ui.panel === 'apply')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // session: guid → { name, state: 'working'|'written'|'refused'|'stored'|'failed', step, error, rejected[], checked }
  let session = $state({})
  let diffs = $state({}) // guid → ConfigDiffEntry[]
  let asking = $state(null) // { act: 'write'|'burn'|'read', guids[] }
  let busyAct = $state(null) // 'read'|'write'|'burn'
  let progress = $state({ done: 0, total: 0, name: '' })
  let stop = false
  let note = $state('')

  const pending = $derived(pendingModules())
  const listed = $derived.by(() => {
    const byGuid = new Map()
    for (const d of pending) byGuid.set(d.guid, d)
    for (const g of Object.keys(session)) { const d = live.devices.find((x) => x.guid === g); if (d) byGuid.set(g, d) }
    return [...byGuid.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
  const quiet = $derived(live.devices.filter((d) => d.connected && !listed.some((x) => x.guid === d.guid)))
  const cantProgram = $derived(!live.connected ? 'Not connected. Connect first.' : /^sim$/i.test(live.adapter ?? '') ? 'The simulator replay cannot program modules.' : '')
  const needWrite = $derived(listed.filter((d) => d.connected && !['written', 'stored'].includes(session[d.guid]?.state) && session[d.guid]?.state !== 'refused'))
  const needStore = $derived(listed.filter((d) => d.connected && ['written', 'refused'].includes(session[d.guid]?.state)))
  // nothing listed: Read compares every connected module with the project
  const readTargets = $derived((listed.some((d) => d.connected) ? listed : live.devices).filter((d) => d.connected).map((d) => d.guid))
  const allStored = $derived(listed.length > 0 && listed.every((d) => session[d.guid]?.state === 'stored'))
  const refusedAny = $derived(listed.some((d) => session[d.guid]?.state === 'refused'))
  const writtenNotStored = $derived(listed.filter((d) => session[d.guid]?.state === 'written'))

  let wasOpen = false
  $effect(() => {
    const o = open
    untrack(() => {
      if (o && !wasOpen) { session = {}; asking = null; note = ''; refreshDiffs() }
      wasOpen = o
    })
  })
  // Reload a module's short diff when its count changes.
  $effect(() => {
    if (!open) return
    const key = listed.map((d) => d.guid + ':' + d.configDiffCount).join('|')
    untrack(() => { key; refreshDiffs() })
  })
  async function refreshDiffs() {
    for (const d of listed) {
      if (!d.configDiffCount) { diffs[d.guid] = []; continue }
      try { diffs[d.guid] = (await api.configDiff(d.guid)) ?? [] } catch { diffs[d.guid] = [] }
    }
  }

  const dev = (g) => live.devices.find((d) => d.guid === g)

  async function readOne(d) {
    const r = await postAction(d.guid, 'read')
    if (!r.ok) return r
    await waitRead(() => dev(d.guid))
    return r
  }
  async function doRead(guids) {
    if (busyAct) return
    busyAct = 'read'; note = ''; stop = false
    const targets = guids.map(dev).filter(Boolean)
    progress = { done: 0, total: targets.length, name: '' }
    let bad = 0
    for (const d of targets) {
      progress = { ...progress, name: d.name }
      const r = await readOne(d)
      if (!r.ok) { bad++; toast(`${d.name}: ${r.error}`, 'error', 6000) }
      else if (session[d.guid]) session[d.guid] = { ...session[d.guid], checked: { diff: dev(d.guid)?.configDiffCount ?? 0 } }
      progress = { ...progress, done: progress.done + 1 }
    }
    busyAct = null
    note = bad ? `Read ${targets.length - bad} of ${targets.length}. See the messages for the others.` : `Read ${targets.length} module${targets.length === 1 ? '' : 's'}. Differences below are what a Read found.`
    await refreshDiffs()
  }

  function ask(act, guids) {
    if (cantProgram || busyAct || !guids.length) return
    asking = { act, guids }
  }
  // G2: saved edits wait in the project until Apply; a Read replaces them with what the modules have, so ask first
  function askRead(guids) {
    if (busyAct || !guids.length) return
    if (guids.some((g) => live.devices.find((d) => d.guid === g)?.pendingEdits > 0)) asking = { act: 'read', guids }
    else doRead(guids)
  }
  async function confirmAsk() {
    const a = asking; asking = null
    if (!a) return
    if (a.act === 'read') await doRead(a.guids)
    else await run(a.act, a.guids)
  }

  async function run(act, guids) {
    busyAct = act; note = ''; stop = false
    const targets = guids.map(dev).filter(Boolean)
    progress = { done: 0, total: targets.length, name: '' }
    for (const d of targets) {
      if (stop) break
      progress = { ...progress, name: d.name }
      session[d.guid] = { ...(session[d.guid] ?? {}), name: d.name, state: 'working', step: act, error: '', rejected: [] }
      const r = await postAction(d.guid, act)
      const prev = session[d.guid]
      if (r.ok) {
        if (act === 'write') session[d.guid] = { ...prev, state: 'written', written: true }
        else {
          session[d.guid] = { ...prev, state: 'stored', stored: true }
          // Check: read it back and see whether it still matches the project.
          const rr = await readOne(d)
          session[d.guid] = { ...session[d.guid], checked: rr.ok ? { diff: dev(d.guid)?.configDiffCount ?? 0 } : { error: rr.error } }
        }
      } else if (r.rejected.length) {
        session[d.guid] = { ...prev, state: 'refused', error: r.error, rejected: r.rejected }
      } else {
        session[d.guid] = { ...prev, state: 'failed', error: r.error }
        if (act === 'burn') session[d.guid].state = prev?.written ? 'written' : 'failed'
        if (act === 'burn') session[d.guid].error = r.error
      }
      progress = { ...progress, done: progress.done + 1 }
    }
    busyAct = null
    if (stop) note = 'Stopped. Modules not reached yet are unchanged.'
    await refreshDiffs()
  }

  const statusOf = (d) => {
    const s = session[d.guid]
    if (!d.connected) return { tone: 'fault', shape: 'square', word: 'Not found: cannot apply' }
    if (!s) return { tone: 'warn', shape: 'diamond', word: d.pendingEdits > 0 ? `${d.pendingEdits} change${d.pendingEdits === 1 ? '' : 's'} waiting` : 'Not sent' }
    return {
      working: { tone: 'accent', shape: 'ring', word: s.step === 'write' ? 'Writing…' : 'Storing…' },
      written: { tone: 'warn', shape: 'diamond', word: 'Written, not stored' },
      refused: { tone: 'fault', shape: 'square', word: `Refused ${s.rejected.length} value${s.rejected.length === 1 ? '' : 's'}` },
      stored: { tone: 'ok', shape: 'dot', word: 'Stored' },
      failed: { tone: 'fault', shape: 'square', word: 'Failed' },
    }[s.state]
  }

  const steps = $derived([
    { n: 1, t: 'Apply to car', d: 'write', done: listed.length > 0 && listed.every((d) => ['written', 'stored'].includes(session[d.guid]?.state)), on: needWrite.length > 0 && !busyAct },
    { n: 2, t: 'Store on modules', d: 'burn', done: allStored, on: needStore.length > 0 && needWrite.length === 0 },
    { n: 3, t: 'Check', d: 'read back', done: allStored && listed.every((d) => session[d.guid]?.checked && !session[d.guid].checked.error), on: false },
  ])

  const banner = $derived.by(() => {
    if (busyAct === 'read') return { tone: 'info', title: `Reading ${progress.name || '…'} · ${progress.done} of ${progress.total} done.`, body: 'Keep the car as it is while modules answer.' }
    if (busyAct) return { tone: 'info', title: `${busyAct === 'write' ? 'Writing' : 'Storing'} ${progress.name || '…'} · ${progress.done} of ${progress.total} done.`, body: 'Keep the car as it is. Each module confirms before the next one starts.' }
    if (allStored) return { tone: 'ok', title: `All ${listed.length} module${listed.length === 1 ? ' is' : 's are'} stored and read back.`, body: 'Safe to switch the car off.' }
    if (refusedAny) return { tone: 'fault', title: 'A module refused a value.', body: 'The refused value is not applied. Everything the module accepted is already live.' }
    if (writtenNotStored.length) return { tone: 'warn', title: `${writtenNotStored.length} module${writtenNotStored.length === 1 ? ' is' : 's are'} written but not stored.`, body: 'Written values live only until power-off. Store them before you switch the car off.' }
    if (listed.length) return { tone: 'warn', title: `${listed.length} module${listed.length === 1 ? '' : 's'} may differ from the car.`, body: 'Nothing reaches the car until you apply. Apply writes to the modules now. Storing them is a second step.' }
    return { tone: 'ok', title: 'Nothing to apply.', body: 'Every connected module matches the project as far as the app knows.' }
  })

  const confirmText = $derived(asking ? (asking.act === 'read'
    ? `Read ${asking.guids.length} module${asking.guids.length === 1 ? '' : 's'} into the project? Changes you saved but did not apply yet are replaced by what the modules have.`
    : asking.act === 'write'
    ? `Write the project's settings to ${asking.guids.length} module${asking.guids.length === 1 ? '' : 's'} now? Outputs follow the new limits and rules at once. The values are lost at power-off until you store them.`
    : `Store the current settings permanently in the flash of ${asking.guids.length} module${asking.guids.length === 1 ? '' : 's'}? This replaces what they start up with.`) : '')

  const short = (e) => `${e.name}`
  const val = (v) => (v == null ? 'not on module' : String(v))
  const fmtDiff = (e) => e.kind === 'appOnly' ? { from: 'not on module', to: val(e.appValue) } : e.kind === 'deviceOnly' ? { from: val(e.deviceValue), to: 'not in project' } : { from: val(e.deviceValue), to: val(e.appValue) }
</script>

<Dialog bind:open={() => open, (v) => { if (!v) ui.panel = null }} title="Apply to car" width={880} description="Apply writes to the modules now. Store keeps it after power-off. Check reads it back.">
  <ol class="steps" aria-label="Steps">
    {#each steps as s (s.n)}
      <li class:on={s.on} class:done={s.done}><span class="n" aria-hidden="true">{s.done ? '✓' : s.n}</span>{s.t} <span class="muted">({s.d})</span></li>
    {/each}
  </ol>

  <Banner tone={banner.tone} title={banner.title}>{banner.body}</Banner>
  {#if cantProgram}<Banner tone="warn" title="Programming is off">{cantProgram}</Banner>{/if}
  {#if writtenNotStored.length && !busyAct}
    <Banner tone="warn" title="Written, not stored">{writtenNotStored.map((d) => d.name).join(', ')} lose{writtenNotStored.length === 1 ? 's' : ''} these changes at power-off. Store {writtenNotStored.length === 1 ? 'it' : 'them'} before you switch the car off.</Banner>
  {/if}
  {#if note}<p class="muted" role="status">{note}</p>{/if}

  {#if asking}
    <div class="ask" role="alertdialog" aria-label="Confirm" data-testid="apply-confirm">
      <p>{confirmText}</p>
      <div class="row">
        <Button onclick={() => (asking = null)}>Cancel</Button>
        <Button variant={asking.act === 'burn' ? 'danger' : 'primary'} onclick={confirmAsk} data-testid="apply-confirm-yes">{asking.act === 'write' ? 'Yes, write now' : asking.act === 'read' ? 'Yes, read and replace' : 'Yes, store permanently'}</Button>
      </div>
    </div>
  {/if}

  <div class="mods">
    {#each listed as d (d.guid)}
      {@const st = statusOf(d)}
      {@const s = session[d.guid]}
      {@const dl = diffs[d.guid] ?? []}
      <section class="mod" class:bad={s?.state === 'refused' || s?.state === 'failed'} aria-label={d.name} data-testid={'apply-' + d.name}>
        <div class="mh">
          <strong>{d.name}</strong><span class="muted mono">{hex(d.baseId)}</span>
          <span class="grow"></span>
          <StateDot tone={st.tone} shape={st.shape} label={st.word} />
        </div>
        {#if dl.length}
          <div class="diffs">
            {#each dl.slice(0, 6) as e, i (i)}
              {@const f = fmtDiff(e)}
              <div class="df"><span>{short(e)}</span><span class="mono">{f.from}</span><span aria-hidden="true">→</span><span class="mono">{f.to}</span></div>
            {/each}
            {#if dl.length > 6}<p class="muted sm">and {dl.length - 6} more. Full list: <a href={href('expert', 'can')} onclick={() => (ui.panel = null)}>Expert › CAN &amp; parameters</a>.</p>{/if}
          </div>
        {:else if !s}
          <p class="muted sm">{d.configDiffCount === 0 ? 'Not compared with the module yet. Read it to see exactly what differs, or apply to send what changed.' : ''}</p>
        {/if}
        {#if s?.state === 'refused'}
          <div class="refuse" role="alert">
            <strong>■ {d.name} refused {s.rejected.length === 1 ? 'this value' : 'these values'}</strong>
            {#each s.rejected as r, i (i)}<span>{r.param} {r.reason}. The module kept <span class="mono">{r.kept}</span>.</span>{/each}
            <span class="muted">Read the module to bring the project back in line with what it kept, or fix the value and apply again.</span>
          </div>
        {:else if s?.state === 'failed'}
          <div class="refuse" role="alert"><strong>■ {d.name} did not take it</strong><span>{s.error}</span></div>
        {/if}
        <div class="marks">
          <span class:okm={s?.written || s?.state === 'stored'}>{s?.written || s?.state === 'stored' ? '✓' : '○'} Written</span>
          <span class:okm={s?.stored}>{s?.stored ? '✓' : '○'} Stored on module</span>
          <span class:okm={s?.checked && !s.checked.error && s.checked.diff === 0}>
            {#if !s?.checked}○ Not checked yet{:else if s.checked.error}■ Check failed: {s.checked.error}{:else if s.checked.diff === 0}✓ Read back: matches the project{:else}▲ Read back: {s.checked.diff} difference{s.checked.diff === 1 ? '' : 's'}{/if}
          </span>
          <span class="grow"></span>
          <Button size="sm" onclick={() => askRead([d.guid])} disabled={!!busyAct || !d.connected} aria-label={`Read ${d.name}`}>Read</Button>
          <Button size="sm" onclick={() => ask('write', [d.guid])} disabled={!!busyAct || !d.connected || !!cantProgram} aria-label={`Apply ${d.name}`}>Apply</Button>
          <Button size="sm" onclick={() => ask('burn', [d.guid])} disabled={!!busyAct || !d.connected || !!cantProgram} aria-label={`Store ${d.name}`}>Store</Button>
        </div>
      </section>
    {:else}
      <p class="muted pad">No module is waiting. {live.connected ? '' : 'You are not connected, so nothing can be compared.'}</p>
    {/each}
    {#if quiet.length}
      <details class="quiet">
        <summary data-testid="apply-quiet">{quiet.length} more module{quiet.length === 1 ? ' has' : 's have'} no changes</summary>
        <p class="muted sm">Nothing to send for {quiet.length === 1 ? 'it' : 'them'} as far as the app knows. You can still read or re-send one. Full parameter diff: <a href={href('expert', 'can')} onclick={() => (ui.panel = null)}>Expert › CAN &amp; parameters</a>.</p>
        {#each quiet as d (d.guid)}
          <div class="qrow" data-testid={'apply-quiet-' + d.name}>
            <strong>{d.name}</strong><span class="muted mono">{hex(d.baseId)}</span><span class="grow"></span>
            <Button size="sm" onclick={() => askRead([d.guid])} disabled={!!busyAct} aria-label={`Read ${d.name}`}>Read</Button>
            <Button size="sm" onclick={() => ask('write', [d.guid])} disabled={!!busyAct || !!cantProgram} aria-label={`Apply ${d.name}`}>Apply</Button>
            <Button size="sm" onclick={() => ask('burn', [d.guid])} disabled={!!busyAct || !!cantProgram} aria-label={`Store ${d.name}`}>Store</Button>
          </div>
        {/each}
      </details>
    {/if}
  </div>

  {#snippet footer()}
    {#if busyAct}
      <Button onclick={() => (stop = true)} data-testid="apply-stop">Stop after this module</Button>
      <Button variant="primary" busy disabled>{busyAct === 'read' ? 'Reading…' : busyAct === 'write' ? 'Applying…' : 'Storing…'}</Button>
    {:else}
      <span class="muted hint">{needWrite.length ? 'Writes live now. Lost at power-off until you store.' : needStore.length ? 'Store keeps the written values after power-off.' : ''}</span>
      <Button onclick={() => askRead(readTargets)} disabled={!readTargets.length} data-testid="apply-read">Read from modules</Button>
      {#if needStore.length}
        <!-- modules already written can be stored while others still wait to be applied -->
        <Button variant={needWrite.length ? 'secondary' : 'primary'} onclick={() => ask('burn', needStore.map((d) => d.guid))} disabled={!!cantProgram} title={cantProgram} data-testid="apply-store">Store on modules ({needStore.length})</Button>
      {/if}
      {#if needWrite.length || cantProgram}
        <Button variant="primary" onclick={() => ask('write', needWrite.map((d) => d.guid))} disabled={!!cantProgram || !needWrite.length} title={cantProgram} data-testid="apply-go">Apply to car{needWrite.length ? ` (${needWrite.length} module${needWrite.length === 1 ? "" : "s"})` : ""}</Button>
      {:else if !needStore.length}
        <Button variant="primary" onclick={() => (ui.panel = null)}>Done</Button>
      {/if}
    {/if}
  {/snippet}
</Dialog>

<style>
  .steps { display: flex; gap: var(--space-2); list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
  .steps li { display: inline-flex; align-items: center; gap: var(--space-2); padding: 6px 12px; border-radius: 999px; border: 1px solid var(--color-line); font-weight: 600; }
  .steps li.on { border-color: var(--color-accent); }
  .n { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--color-raised); font-size: var(--text-xs); }
  .steps li.done .n { background: var(--color-accent); color: var(--color-on-accent); }
  .mods { display: flex; flex-direction: column; gap: var(--space-3); }
  .mod { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-bg); }
  .mod.bad { border-color: var(--color-fault); }
  .mh { display: flex; align-items: center; gap: var(--space-3); }
  .grow { flex: 1 1 auto; }
  .diffs { display: flex; flex-direction: column; gap: 2px; }
  .df { display: grid; grid-template-columns: minmax(0, 1fr) auto 20px auto; gap: var(--space-3); padding: 4px 0; border-bottom: 1px solid var(--color-line); }
  .refuse { display: flex; flex-direction: column; gap: 2px; padding: var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-fault); background: var(--color-fault-soft); }
  .marks { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; font-size: var(--text-xs); color: var(--color-text-muted); }
  .okm { color: var(--color-ok); }
  .sm { font-size: var(--text-xs); }
  .pad { padding: var(--space-3); }
  .ask { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 2px solid var(--color-warn); border-radius: var(--radius-md); background: var(--color-warn-soft); }
  .row { display: flex; gap: var(--space-2); }
  .quiet summary { cursor: pointer; min-height: 36px; display: flex; align-items: center; font-weight: 600; }
  .qrow { display: flex; align-items: center; gap: var(--space-3); padding: 6px 0; border-bottom: 1px solid var(--color-line); }
  .hint { margin-right: auto; align-self: center; font-size: var(--text-xs); }
</style>
