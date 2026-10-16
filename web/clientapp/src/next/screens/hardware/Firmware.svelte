<script>
  // Firmware: version per module, update one or all over CAN, update the link module over USB,
  // flash a new board over DFU. Flashing always asks first and says what happens if it goes wrong.
  import { Page, PageHeader, Card, Button, Banner, Chip, StateDot, Select } from '../../ui/index.js'
  import { live, api, toast, hex } from '../../lib/live.svelte.js'
  import Confirm from '../power/parts/Confirm.svelte'
  import FlashNewBoard from './parts/firmware/FlashNewBoard.svelte'
  import { boardOf, boardOfFile, fileVersion, cleanVersion, flashPath, pathLabel, extFor, checkFile, lastLine } from './parts/firmware/firmwareLogic.js'
  let props = $props()

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const blocked = $derived(!live.connected ? 'Connect to the car first.' : (!live.adapter || !live.programmingAllowed) ? 'Switch to a real CAN or USB adapter: the Sim cannot program hardware.' : '')

  let files = $state([]), st = $state({}), busy = $state(false), pausing = $state(false)
  let run = $state(null)          // { label, done, total } while an update-all is going
  let confirm = $state(null)      // { mode: 'one' | 'all', ... }
  let newBoard = $state(false), fileInput, reading = $state(false)

  const pathOf = (d) => flashPath(d, live.connected)
  const fileFor = (d) => { const p = pathOf(d); return p ? files.find((f) => boardOfFile(f.name)?.key === boardOf(d).key && f.name.toLowerCase().endsWith(extFor(p))) ?? null : null }
  const upToDate = (d, f) => !!f && !!fileVersion(f.name) && cleanVersion(d.version) === fileVersion(f.name)
  const plan = $derived(mods.filter((d) => pathOf(d) === 'can' && d.connected).map((d) => ({ d, file: fileFor(d) })).filter((p) => p.file && !upToDate(p.d, p.file)))
  const anyFile = $derived(files.length > 0)

  function onFiles(e) { files = [...(e.target.files ?? [])]; e.target.value = ''; checkAll() }

  // ---- release list (G7): GitHub releases with notes; images download through the backend and are kept on
  // this PC, so a release used once works offline. "Use this release" fills the same file list as picking files.
  let rel = $state({ list: [], offline: false, error: '', loading: true }), relTag = $state(''), loadingRel = $state(false)
  let checks = $state({})   // file name -> POST /api/firmware/check result
  async function loadReleases(refresh = false) {
    rel.loading = true
    try {
      const r = await fetch('/api/firmware/releases' + (refresh ? '?refresh=true' : ''))
      const b = await r.json()
      rel = { list: b.releases ?? [], offline: !!b.offline, error: b.error ?? '', loading: false }
      if (!relTag || !rel.list.some((x) => x.tag === relTag)) relTag = rel.list.find((x) => !x.prerelease)?.tag ?? rel.list[0]?.tag ?? ''
    } catch (e) { rel = { list: [], offline: true, error: e?.message ?? String(e), loading: false } }
  }
  loadReleases()
  const release = $derived(rel.list.find((x) => x.tag === relTag) ?? null)
  // the images this project needs: a .srec per board kind in it, and the .bin for PDMs (the USB link module)
  const needed = $derived(release ? release.images.filter((i) => mods.some((d) => boardOf(d).label === i.board) && (i.kind === 'srec' || i.board !== 'CANBoard')) : [])
  async function useRelease() {
    if (!release) return
    loadingRel = true
    try {
      const got = []
      for (const i of needed) {
        const r = await fetch(`/api/firmware/releases/${encodeURIComponent(release.tag)}/${encodeURIComponent(i.name)}`)
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `${i.name}: HTTP ${r.status}`)
        got.push(new File([await r.blob()], i.name))
      }
      files = got
      toast(`Loaded ${got.length} file${got.length === 1 ? '' : 's'} of ${release.version}.`, 'info', 3000)
      await checkAll()
      loadReleases()   // they are on this PC now
    } catch (e) { toast('Could not load the release: ' + (e?.message ?? e), 'error', 8000) } finally { loadingRel = false }
  }
  // pre-flight: what each image says it is (board marker), its version, and which modules it fits
  async function checkAll() {
    const out = {}
    for (const f of files) {
      try { out[f.name] = await (await fetch('/api/firmware/check?name=' + encodeURIComponent(f.name), { method: 'POST', body: f })).json() } catch { /* the module checks it again */ }
    }
    checks = out
  }
  const relDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')
  const relItems = $derived(rel.list.map((r) => ({ value: r.tag, label: `${r.version}${r.prerelease ? ' (test)' : ''} · ${relDate(r.published)}${r.images.every((i) => i.cached) ? ' · on this PC' : ''}` })))

  async function readVersions() {
    reading = true
    const ok = []
    for (const d of mods.filter((x) => x.connected)) { try { await api.action(d.guid, 'version'); ok.push(d.name) } catch (e) { toast(`${d.name}: ${e?.message ?? e}`, 'error', 6000) } }
    setTimeout(() => (reading = false), 800)
    if (ok.length) toast(`Asked ${ok.length} module${ok.length === 1 ? '' : 's'} for the version.`, 'info', 3000)
  }

  async function flashOne(d, file, path) {
    st[d.guid] = { state: 'writing', pct: 0, text: 'Starting…' }
    const poll = setInterval(async () => {
      try { const s = path === 'can' ? await api.flashCanStatus() : await api.flashStatus(); if (st[d.guid]?.state === 'writing' && (s.busy || s.percent)) st[d.guid] = { state: 'writing', pct: s.percent, text: `${s.phase || 'Writing'} · ${s.percent} %` } } catch {}
    }, 400)
    try {
      const buf = await file.arrayBuffer()
      const r = path === 'can' ? await api.flashCan(d.guid, buf) : await api.flash(d.guid, buf)
      if (r.ok) {
        st[d.guid] = { state: 'done', pct: 100, text: `Done ✓${r.version ? ' · now ' + cleanVersion(r.version) : ''}` }
        api.action(d.guid, 'version').catch(() => {})
        return true
      }
      st[d.guid] = { state: 'failed', pct: st[d.guid]?.pct ?? 0, text: `Failed: ${lastLine(r.log) || 'no reason given'}. The module stays in its bootloader and is safe. Run it again.` }
    } catch (e) {
      st[d.guid] = { state: 'failed', pct: st[d.guid]?.pct ?? 0, text: `Link lost or cut off: ${e?.message ?? e}. The module stays in its bootloader and is safe. Check power and wiring, then run it again.` }
    } finally { clearInterval(poll) }
    return false
  }

  async function startOne() {
    const { d, file, path } = confirm; confirm = null
    busy = true
    try { const ok = await flashOne(d, file, path); toast(ok ? `${d.name} updated.` : `${d.name} did not update.`, ok ? 'info' : 'error', 6000) } finally { busy = false }
  }
  async function startAll() {
    const todo = [...confirm.plan]; confirm = null
    busy = true; pausing = false
    for (const p of todo) st[p.d.guid] = { state: 'waiting', pct: 0, text: 'Waiting' }
    let failed = 0, done = 0
    try {
      for (const [i, p] of todo.entries()) {
        run = { label: p.d.name, done: i, total: todo.length }
        if (!(await flashOne(p.d, p.file, 'can'))) failed++
        done++
        if (pausing && i < todo.length - 1) {
          for (const q of todo.slice(i + 1)) st[q.d.guid] = { state: 'waiting', pct: 0, text: 'Paused. Not started.' }
          break
        }
      }
    } finally { run = null; busy = false; pausing = false }
    toast(failed ? `${failed} of ${done} module(s) failed to update.` : `${done} module(s) updated over CAN.`, failed ? 'error' : 'info', 8000)
  }
  function ask(d) {
    const path = pathOf(d), file = fileFor(d)
    confirm = { mode: 'one', d, file, path }
  }
  const cell = (d) => {
    const s = st[d.guid]
    if (s) return s
    const p = pathOf(d), f = fileFor(d)
    if (!p) return { state: 'idle', pct: 0, text: 'Cannot be flashed here' }
    if (!d.connected) return { state: 'idle', pct: 0, text: 'Not on the bus' }
    if (!anyFile) return { state: 'idle', pct: 0, text: 'Choose release files first' }
    if (!f) return { state: 'idle', pct: 0, text: `No ${extFor(p)} file for a ${boardOf(d).label}` }
    if (upToDate(d, f)) return { state: 'skip', pct: 100, text: 'Already up to date · skipped' }
    return { state: 'idle', pct: 0, text: `Ready: ${f.name}` }
  }
  const sub = $derived(run ? `One module at a time over CAN · ${run.done} of ${run.total} done · keep the car powered · you can keep working`
    : `${mods.length} modules · ${mods.filter((d) => d.connected).length} answering · pick the release files, then update one module or all`)
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Hardware', href: '#/next/hardware' }, { label: 'Firmware' }]} title={run ? `Updating ${run.label}` : 'Firmware'} subtitle={sub}>
    {#snippet actions()}
      {#if run}
        <Button onclick={() => (pausing = !pausing)} data-testid="fw-pause">{pausing ? 'Will pause after this module' : 'Pause after this module'}</Button>
      {:else}
        <Button onclick={readVersions} busy={reading} disabled={!live.connected} data-testid="fw-read-versions">Read versions</Button>
        <Button variant="primary" disabled={!!blocked || busy || !plan.length} onclick={() => (confirm = { mode: 'all', plan })} data-testid="fw-update-all">Update {plan.length} module{plan.length === 1 ? '' : 's'} over CAN</Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if blocked}<Banner tone="warn" title="Programming is off" data-testid="fw-blocked">{blocked}</Banner>{/if}

  <Card title="Modules" aria-label="Modules">
    <div class="nx-scroll">
      <table class="nx-table" data-testid="fw-table">
        <thead><tr><th>Module</th><th>Board</th><th>Now</th><th>Path</th><th>Progress</th><th><span class="sr-only">Action</span></th></tr></thead>
        <tbody>
          {#each mods as d (d.guid)}
            {@const c = cell(d)}
            {@const p = pathOf(d)}
            {@const f = fileFor(d)}
            <tr data-module={d.name} class:active={c.state === 'writing'}>
              <td><strong>{d.name}</strong> <span class="muted mono">{hex(d.baseId)}</span></td>
              <td>{boardOf(d).label}</td>
              <td class="mono" data-testid={`fw-version-${d.name}`}>{d.connected ? (cleanVersion(d.version) || 'unknown') : 'not seen'}</td>
              <td>{pathLabel(p)}</td>
              <td>
                <div class="prog"><div class="bar" role="progressbar" aria-label={`${d.name} progress`} aria-valuenow={c.pct} aria-valuemin="0" aria-valuemax="100"><span style="width: {c.pct}%" class:bad={c.state === 'failed'} class:ok={c.state === 'done'}></span></div>
                  <span class:fault={c.state === 'failed'} data-testid={`fw-status-${d.name}`}>{c.state === 'failed' ? '■ ' : ''}{c.text}</span></div>
              </td>
              <td><Button size="sm" disabled={!!blocked || busy || !d.connected || !p || !f || upToDate(d, f)} onclick={() => ask(d)} data-testid={`fw-update-${d.name}`}>{p === 'usb' ? 'Update over USB' : 'Update'}</Button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  <div class="three">
    <Card title="Release" aria-label="Release files">
      {#if rel.loading}<p class="muted" role="status">Reading the release list…</p>
      {:else if rel.list.length}
        <Select label="Firmware release" items={relItems} bind:value={relTag} data-testid="fw-release" />
        {#if rel.offline}<p class="muted note" role="status">{rel.error}</p>{/if}
        {#if release}
          <details class="notes"><summary>What is new in {release.version}</summary><div class="md" data-testid="fw-notes">{release.notes || 'No notes.'}</div></details>
          <div class="row">
            <Button variant="primary" onclick={useRelease} busy={loadingRel} disabled={busy || loadingRel || !needed.length} data-testid="fw-use-release">Use this release ({needed.length} file{needed.length === 1 ? '' : 's'})</Button>
            <Button size="sm" variant="ghost" onclick={() => loadReleases(true)} disabled={rel.loading}>Check for new releases</Button>
          </div>
        {/if}
      {:else}<p class="muted note" role="status">{rel.error || 'No releases found.'} Pick the files yourself instead.</p>{/if}
      <input bind:this={fileInput} type="file" multiple accept=".srec,.bin" class="sr-only" onchange={onFiles} data-testid="fw-files" aria-label="Release files" />
      <div class="row">
        <Button size="sm" onclick={() => fileInput.click()} disabled={busy}>Or choose files…</Button>
        {#if anyFile}<Chip tone="ok" symbol="✓">{files.length} file{files.length === 1 ? '' : 's'}</Chip>{/if}
      </div>
      {#if anyFile}
        <ul class="files mono" data-testid="fw-file-list">
          {#each files as f (f.name)}
            {@const c = checks[f.name]}
            <li>{f.name} <span class="muted">· {c?.board ?? boardOfFile(f.name)?.label ?? 'board not in the name'}{fileVersion(f.name) ? ' · ' + fileVersion(f.name) : ''}{c ? ` · fits ${c.modules.length ? c.modules.map((m) => m.name).join(', ') : 'no module in this project'}` : ''}</span>
              {#each c?.problems ?? [] as p (p)}<br /><span class="warnT" data-testid="fw-check-problem">▲ {p}</span>{/each}</li>
          {/each}
        </ul>
      {/if}
      <p class="muted note">A .srec per board goes over CAN (CANBoard, dingoPDM, dingoPDM-Max) and a .bin to the link module over USB. Each file is checked for the board it was built for.</p>
    </Card>
    <Card title="If something fails" aria-label="If something fails">
      <p>The module stays in its bootloader and is safe. Run it again from here. The ones already done keep their new firmware.</p>
      <p class="muted note">Not available yet: the app cannot list a module that sits in its bootloader (gap G9). It shows as not seen until the update works.</p>
    </Card>
    <Card title="New or blank board" aria-label="New or blank board">
      <p>Over USB (DFU) on a PDM. A CANBoard needs a probe once.</p>
      <div><Button onclick={() => (newBoard = true)} disabled={busy} data-testid="fw-new-board">Flash a new board…</Button></div>
    </Card>
  </div>
</Page>

<Confirm bind:open={() => confirm?.mode === 'one', (v) => { if (!v) confirm = null }} title={confirm?.d ? `Update ${confirm.d.name}?` : 'Update'} confirmLabel="Update now" variant="danger" onconfirm={startOne}
  consequence={confirm?.path === 'usb' ? 'dingoConfig loses its link to the whole bus while this module restarts. A board stuck in DFU can be flashed again, or recovered with BOOT0.' : 'The module stays in its bootloader and is safe. Run the update again. Nothing else on the car is touched.'}>
  {#if confirm?.d}
    <p><strong>{confirm.d.name}</strong> ({boardOf(confirm.d).label}, now {cleanVersion(confirm.d.version) || 'unknown'}) gets <span class="mono">{confirm.file?.name}</span> over {pathLabel(confirm.path)}.</p>
    <p class="muted">The module restarts and goes quiet on the bus for about a minute. Keep the car powered. Outputs it drives switch off while it restarts.</p>
    {#if checkFile(confirm.d, confirm.file, confirm.path).reason}<p class="muted" data-testid="fw-file-note">{checkFile(confirm.d, confirm.file, confirm.path).reason}</p>{/if}
  {/if}
</Confirm>
<Confirm bind:open={() => confirm?.mode === 'all', (v) => { if (!v) confirm = null }} title={`Update ${confirm?.plan?.length ?? 0} modules over CAN?`} confirmLabel="Start updating" variant="danger" onconfirm={startAll}
  consequence="A module that fails stays in its bootloader and is safe, and the next one carries on. The ones already done keep their new firmware. Closing this page stops the run after the module that is being written.">
  {#if confirm?.plan}
    <p>One at a time, in this order. Keep the car powered. Outputs on each module switch off while it restarts.</p>
    <ul class="files mono" data-testid="fw-all-list">
      {#each confirm.plan as p (p.d.guid)}<li>{p.d.name} · {cleanVersion(p.d.version) || '?'} → {fileVersion(p.file.name) ?? p.file.name}</li>{/each}
    </ul>
    <p class="muted">The link module (USB) is not part of this run. Update it last, on its own.</p>
  {/if}
</Confirm>

<FlashNewBoard bind:open={newBoard} {blocked} busyOther={busy} onflashing={(v) => (busy = v)} />

<style>
  .active { background: var(--color-on-soft); }
  .prog { display: flex; flex-direction: column; gap: 4px; min-width: 220px; }
  .bar { height: 8px; border-radius: 4px; background: var(--color-raised); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--color-on); transition: width 0.25s; }
  .bar span.ok { background: var(--color-ok); }
  .bar span.bad { background: var(--color-fault); }
  .fault { color: var(--color-fault); font-weight: 600; }
  .three { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4); align-items: start; }
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .files { margin: 0; padding-left: 18px; font-size: var(--text-xs); display: flex; flex-direction: column; gap: 2px; }
  .note { font-size: var(--text-xs); }
  .warnT { color: var(--color-warn); font-weight: 600; }
  .notes summary { cursor: pointer; font-weight: 600; }
  .md { white-space: pre-wrap; max-height: 220px; overflow: auto; font-size: var(--text-xs); margin-top: var(--space-2); }
</style>
