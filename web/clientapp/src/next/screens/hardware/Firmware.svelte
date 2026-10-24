<script>
  // Firmware: version per module, update one or all over CAN, update the link module over USB,
  // flash a new board over DFU. Flashing always asks first and says what happens if it goes wrong.
  import { Page, PageHeader, Card, Button, Banner, Chip, StateDot, Select, Checkbox } from '../../ui/index.js'
  import { live, api, toast, hex } from '../../lib/live.svelte.js'
  import Confirm from '../power/parts/Confirm.svelte'
  import FlashNewBoard from './parts/firmware/FlashNewBoard.svelte'
  import FlashSwd from './parts/firmware/FlashSwd.svelte'
  import { boardOf, boardOfFile, isFull, fileVersion, cleanVersion, flashPath, pathLabel, extFor, fitsPath, checkFile, lastLine, cmpVersion, relationTo, relationLabel } from './parts/firmware/firmwareLogic.js'
  import { isUpstream, ownLine } from './parts/util.js'
  let props = $props()

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  let files = $state([]), st = $state({}), busy = $state(false), pausing = $state(false)
  // an update over CAN started before this page opened (a reload, another window) still runs on the backend
  let other = $state(null)
  async function pollOther() { try { const s = await api.flashCanStatus(); other = s?.busy && !busy ? s : null } catch { /* backend away */ } }
  $effect(() => { pollOther(); const t = setInterval(pollOther, 1500); return () => clearInterval(t) })
  const blocked = $derived(!live.connected ? 'Connect to the car first.' : (!live.adapter || !live.programmingAllowed) ? 'Switch to a real CAN or USB adapter: the Sim cannot program hardware.'
    : other ? `An update over CAN is already running (${other.phase || 'writing'} · ${other.percent} %), started before this page opened or in another window. Wait until it is done.` : '')
  // a new board over DFU needs no connection: a board in DFU is no adapter (the module on USB, if any, is sent there)
  const newBoardBlocked = $derived(live.connected && (!live.adapter || !live.programmingAllowed) ? 'Disconnect the Sim first: it cannot program hardware.'
    : other ? `An update over CAN is already running (${other.phase || 'writing'} · ${other.percent} %). Wait until it is done.` : '')
  let run = $state(null)          // { label, done, total } while an update-all is going
  let confirm = $state(null)      // { mode: 'one' | 'all', ... }
  let newBoard = $state(false), swd = $state(false), fileInput, reading = $state(false)

  const pathOf = (d) => flashPath(d, live.connected)
  // over CAN only an image built for the bootloader (the pre-flight check reads where it starts; .srec/.hex)
  // once checked, the image's own board marker decides (a CANBoard image named like a PDM file was offered to the PDMs)
  const fitsBoard = (f, d) => (checks[f.name]?.board ? checks[f.name].modules.some((m) => m.guid === d.guid) : boardOfFile(f.name)?.key === boardOf(d).key)
  const fileFor = (d) => { const p = pathOf(d); return p ? files.find((f) => !isFull(f.name) && fitsBoard(f, d) && fitsPath(f.name, p) && (p !== 'can' || checks[f.name]?.relocated !== false)) ?? null : null }
  // upstream dingoFW PDM: the operator says whether it has the OpenBLT bootloader (nothing on the bus can tell)
  async function markBootloader(d, on) {
    try {
      const r = await fetch(`/api/devices/${d.guid}/openblt?on=${on}`, { method: 'POST' })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'HTTP ' + r.status)
    } catch (e) { toast(`${d.name}: ${e?.message ?? e}`, 'error', 8000) }
  }
  // the version the image carries (5.6.4 on, read by the pre-flight check), else what the file name says
  const verOf = (f) => checks[f.name]?.version ?? fileVersion(f.name)
  const upToDate = (d, f) => !!f && !!verOf(f) && cleanVersion(d.version) === verOf(f)
  // reachable: answering, or found waiting in its bootloader (G9: a CAN update can run from there)
  // or the module on USB: a USB update talks to it directly, it needs no telemetry (a muted module sends none)
  // upstream dingoFW 0.x, known: the one line where nothing tells whether OpenBLT is on it. v0.0.0 = no version heard yet
  const upstreamZero = (d) => !ownLine(d) && /^v?0\.\d+\.\d+/.test(d.version ?? '') && cleanVersion(d.version) !== '0.0.0'
  const reach = (d) => d.connected || (d.inBootloader && pathOf(d) === 'can') || (d.isGateway && pathOf(d) === 'usb')
  const plan = $derived(mods.filter((d) => pathOf(d) === 'can' && reach(d)).map((d) => ({ d, file: fileFor(d) })).filter((p) => p.file && !upToDate(p.d, p.file)))
  const anyFile = $derived(files.length > 0)

  // G9: find modules that are silent because they wait in their bootloader; Restart leaves it (app starts if valid)
  let scanning = $state(false), blResult = $state('Asks every silent module once. A module found there can be updated again, or restarted.')
  async function scanBootloaders() {
    scanning = true
    try {
      const r = await (await fetch('/api/devices/bootloader-scan', { method: 'POST' })).json()
      if (!Array.isArray(r)) throw new Error(r?.error ?? 'scan failed')
      const inBl = r.filter((x) => x.inBootloader).map((x) => x.name)
      blResult = !r.length ? 'Every module is answering. None is in its bootloader.' : inBl.length ? `In the bootloader: ${inBl.join(', ')}.` : `${r.length} silent module${r.length === 1 ? '' : 's'}, none in the bootloader (off, asleep or not wired).`
    } catch (e) { blResult = 'Could not scan: ' + (e?.message ?? e) } finally { scanning = false }
  }
  async function leaveBootloader(d) {
    try {
      const r = await fetch(`/api/devices/${d.guid}/leave-bootloader`, { method: 'POST' })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'HTTP ' + r.status)
      toast(`${d.name} restarted. It runs its firmware again if that is complete.`, 'info', 5000)
    } catch (e) { toast(`${d.name}: ${e?.message ?? e}`, 'error', 8000) }
  }

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
      // default: the newest proper release by version number (not list order, not a test build)
      const newest = rel.list.filter((x) => !x.prerelease).sort((a, b) => cmpVersion(b.version, a.version))[0] ?? rel.list[0]
      if (!relTag || !rel.list.some((x) => x.tag === relTag)) relTag = newest?.tag ?? ''
    } catch (e) { rel = { list: [], offline: true, error: e?.message ?? String(e), loading: false } }
  }
  loadReleases()
  const release = $derived(rel.list.find((x) => x.tag === relTag) ?? null)
  // the images this project needs: the over-CAN image per board kind in it (.srec, or the .hex when the release has
  // none: 5.7.0 ships .bin + .hex only), and the .bin for PDMs (the USB link module). Plus the _FULL_ images (5.7.1 on:
  // bootloader + app) for the new / blank board dialogs: the .hex for SWD and, on a PDM, the .bin for DFU.
  const canKind = (board) => (release.images.some((x) => x.board === board && !x.full && x.kind === 'srec') ? 'srec' : 'hex')
  const needed = $derived(release ? release.images.filter((i) => mods.some((d) => boardOf(d).label === i.board) && (i.full
    ? i.kind === 'hex' || (i.kind === 'bin' && i.board !== 'CANBoard')
    : i.kind === canKind(i.board) || (i.kind === 'bin' && i.board !== 'CANBoard'))) : [])
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
  // while the chosen files are read, a file's version is only what its name says (often nothing): every module
  // looked out of date for a moment and Update all offered to flash the image they already run
  let checking = $state(false)
  async function checkAll() {
    checking = true
    const out = {}
    for (const f of files) {
      try { out[f.name] = await (await fetch('/api/firmware/check?name=' + encodeURIComponent(f.name), { method: 'POST', body: f })).json() } catch { /* the module checks it again */ }
    }
    checks = out
    checking = false
  }
  // what the modules run now, and how a release compares (a downgrade asks first)
  const installed = $derived(mods.filter((d) => d.connected && d.version).map((d) => cleanVersion(d.version)))
  const relOf = (r) => (r.prerelease ? null : relationTo(r.version, installed))
  const relation = $derived(release ? relOf(release) : null)
  const downgrade = $derived(relation === 'older' || relation === 'mixed')
  let askDowngrade = $state(false)
  const relDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')
  const relItems = $derived(rel.list.map((r) => ({ value: r.tag, label: `${r.version}${r.prerelease ? ' (test)' : ''}${relOf(r) ? ' · ' + relationLabel[relOf(r)] : ''} · ${relDate(r.published)}${r.images.every((i) => i.cached) ? ' · on this PC' : ''}` })))

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
        // the backend puts the module back on its base ID when the new firmware started it on the default: say so
        const idLine = (r.log ?? '').split('\n').find((l) => l.includes('Base ID'))?.replace(/^✓\s*/, '')
        st[d.guid] = { state: 'done', pct: 100, text: `Done ✓${r.version ? ' · now ' + cleanVersion(r.version) : ''}${idLine ? ' · ' + idLine : ''}`, log: r.log }
        api.action(d.guid, 'version').catch(() => {})
        return true
      }
      st[d.guid] = { state: 'failed', pct: st[d.guid]?.pct ?? 0, text: `Failed: ${lastLine(r.log) || 'no reason given'}. ` + (path === 'can' && r.started === false
        ? 'Nothing was sent: the module runs its firmware as before.' : 'The module stays in its bootloader and is safe. Run it again.'), log: r.log }
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
    if (!reach(d)) return { state: 'idle', pct: 0, text: 'Not on the bus' }
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
        <Button variant="primary" disabled={!!blocked || busy || checking || !plan.length} onclick={() => (confirm = { mode: 'all', plan })} data-testid="fw-update-all">{checking ? 'Checking the files…' : `Update ${plan.length} module${plan.length === 1 ? '' : 's'} over CAN`}</Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if blocked}<Banner tone="warn" title="Programming is off" data-testid="fw-blocked">{blocked}</Banner>{/if}

  <Card title="1. Release" aria-label="Release files">
    {#if rel.loading}<p class="muted" role="status">Reading the release list…</p>
    {:else if rel.list.length}
      <Select label="Firmware release" items={relItems} bind:value={relTag} data-testid="fw-release" />
      {#if rel.offline}<p class="muted note" role="status">{rel.error}</p>{/if}
      {#if release}
        <details class="notes"><summary>What is new in {release.version}</summary><div class="md" data-testid="fw-notes">{release.notes || 'No notes.'}</div></details>
        <div class="row">
          {#if relation}<p class="muted note" data-testid="fw-relation">{release.version} is {relationLabel[relation]}{installed.length ? ` (modules run ${[...new Set(installed)].join(', ')})` : ''}.</p>{/if}
          {#if downgrade}
            <Button variant="danger" onclick={() => (askDowngrade = true)} busy={loadingRel} disabled={busy || loadingRel || !needed.length} data-testid="fw-use-release">Downgrade to {release.version} ({needed.length} file{needed.length === 1 ? '' : 's'})</Button>
          {:else}
            <Button variant={relation === 'same' ? 'secondary' : 'primary'} onclick={useRelease} busy={loadingRel} disabled={busy || loadingRel || !needed.length} data-testid="fw-use-release">Use this release ({needed.length} file{needed.length === 1 ? '' : 's'})</Button>
          {/if}
          <Button size="sm" variant="ghost" onclick={() => loadReleases(true)} disabled={rel.loading}>Check for new releases</Button>
        </div>
      {/if}
    {:else}<p class="muted note" role="status">{rel.error || 'No releases found.'} Pick the files yourself instead.</p>{/if}
    <input bind:this={fileInput} type="file" multiple accept=".srec,.hex,.bin" class="sr-only" onchange={onFiles} data-testid="fw-files" aria-label="Release files" />
    <div class="row">
      <Button size="sm" onclick={() => fileInput.click()} disabled={busy}>Or choose files…</Button>
      {#if anyFile}<Chip tone="ok" symbol="✓">{files.length} file{files.length === 1 ? '' : 's'}</Chip>{/if}
    </div>
    {#if anyFile}
      <ul class="files mono" data-testid="fw-file-list">
        {#each files as f (f.name)}
          {@const c = checks[f.name]}
          <li>{f.name} <span class="muted">· {c?.board ?? boardOfFile(f.name)?.label ?? 'board not in the name'}{verOf(f) ? ' · ' + verOf(f) : ''}{c?.address ? ` · starts at ${c.address}${c.relocated ? ' (for the CAN bootloader)' : ' (full image)'}` : ''}{c ? ` · fits ${c.modules.length ? c.modules.map((m) => m.name).join(', ') : 'no module in this project'}` : ''}</span>
            {#each c?.problems ?? [] as p (p)}<br /><span class="warnT" data-testid="fw-check-problem">▲ {p}</span>{/each}</li>
        {/each}
      </ul>
    {/if}
    <p class="muted note">A .srec per board goes over CAN (CANBoard, dingoPDM, dingoPDM-Max) and a .bin to the link module over USB. Upstream dingoFW ships a .hex: it goes over CAN when it is built for the bootloader (starts at 0x08004000). From firmware 5.7 a CANBoard image starts at 0x08002000 and needs the new 8 KB CANBoard bootloader, programmed once over SWD. Each file is checked for the board it was built for.</p>
  </Card>

  <Card title="2. Modules" aria-label="Modules">
    <div class="nx-scroll">
      <table class="nx-table table-cards" data-testid="fw-table">
        <thead><tr><th>Module</th><th>Board</th><th>Now</th><th>Path</th><th>Progress</th><th><span class="sr-only">Action</span></th></tr></thead>
        <tbody>
          {#each mods as d (d.guid)}
            {@const c = cell(d)}
            {@const p = pathOf(d)}
            {@const f = fileFor(d)}
            <tr data-module={d.name} class:active={c.state === 'writing'}>
              <td data-label="Module"><strong>{d.name}</strong> <span class="muted mono">{hex(d.baseId)}</span></td>
              <td data-label="Board">{boardOf(d).label}</td>
              <td class="mono" data-label="Now" data-testid={`fw-version-${d.name}`}>{d.connected ? (cleanVersion(d.version) || 'unknown') : d.inBootloader ? 'in bootloader' : d.lastFirmware ? `${cleanVersion(d.lastFirmware)} (last seen)` : 'not seen'}</td>
              <td data-label="Path">{pathLabel(p)}
                {#if isUpstream(d) && upstreamZero(d) && /pdm/i.test(d.type ?? '')}<!-- the 5.7 line is always behind OpenBLT: nothing to tick -->
                  <Checkbox label="Has the CAN bootloader" hint="Upstream dingoFW: tick once OpenBLT is programmed on it. Without it a CAN update sends the module to USB-DFU." checked={!!d.canBootloader} disabled={busy} onchange={(v) => markBootloader(d, v)} data-testid={`fw-openblt-${d.name}`} />
                {/if}</td>
              <td class="pc">
                <div class="prog"><div class="bar" role="progressbar" aria-label={`${d.name} progress`} aria-valuenow={c.pct} aria-valuemin="0" aria-valuemax="100"><span style="width: {c.pct}%" class:bad={c.state === 'failed'} class:ok={c.state === 'done'}></span></div>
                  <span class:fault={c.state === 'failed'} data-testid={`fw-status-${d.name}`}>{c.state === 'failed' ? '■ ' : ''}{c.text}</span></div>
                {#if c.log}<details class="flog"><summary>Show log</summary><pre class="mono" data-testid={`fw-log-${d.name}`}>{c.log}</pre></details>{/if}
              </td>
              <td><Button size="sm" disabled={!!blocked || busy || checking || !reach(d) || !p || !f || (d.connected && upToDate(d, f))} onclick={() => ask(d)} data-testid={`fw-update-${d.name}`}>{p === 'usb' ? 'Update over USB' : 'Update'}</Button>
                {#if d.inBootloader}<Button size="sm" variant="ghost" disabled={!!blocked || busy} onclick={() => leaveBootloader(d)} data-testid={`fw-restart-${d.name}`}>Restart it</Button>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  <div class="three">
    <Card title="If something fails" aria-label="If something fails">
      <p>The module stays in its bootloader and is safe. Run it again from here. The ones already done keep their new firmware.</p>
      <div><Button size="sm" onclick={scanBootloaders} busy={scanning} disabled={!!blocked || busy || scanning} data-testid="fw-bl-scan">Look for modules in their bootloader</Button></div>
      <p class="muted note" role="status" data-testid="fw-bl-result">{blResult}</p>
    </Card>
    <Card title="New or blank board" aria-label="New or blank board">
      <p>Over USB (DFU) on a PDM. A CANBoard needs a probe once: flash its bootloader over SWD.</p>
      <div class="btns">
        <Button onclick={() => (newBoard = true)} disabled={busy} data-testid="fw-new-board">Flash a new board…</Button>
        <Button onclick={() => (swd = true)} disabled={busy} data-testid="fw-swd">Flash over SWD…</Button>
      </div>
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
      {#each confirm.plan as p (p.d.guid)}<li>{p.d.name} · {cleanVersion(p.d.version) || '?'} → {verOf(p.file) ?? p.file.name}</li>{/each}
    </ul>
    <p class="muted">The link module (USB) is not part of this run. Update it last, on its own.</p>
  {/if}
</Confirm>

<Confirm bind:open={askDowngrade} title={`Downgrade to ${release?.version ?? ''}?`} confirmLabel={`Load ${release?.version ?? ''} anyway`} variant="danger" onconfirm={() => { askDowngrade = false; useRelease() }}
  consequence="Nothing is written yet: this only loads the files. Each module still asks before it is flashed, and you can load a newer release again at any time.">
  <p data-testid="fw-downgrade-note">{release?.version} is {relationLabel[relation] ?? 'older'}{installed.length ? `: the modules run ${[...new Set(installed)].join(', ')}` : ''}. Flashing it takes them back to older firmware, and settings added since may be lost.</p>
</Confirm>

<FlashNewBoard bind:open={newBoard} blocked={newBoardBlocked} busyOther={busy} onflashing={(v) => (busy = v)} {files} {release} boards={[...new Set(mods.map((d) => boardOf(d).key))]} />
<FlashSwd bind:open={swd} busyOther={busy} onflashing={(v) => (busy = v)} {files} {release} modules={mods} />

<style>
  .active { background: var(--color-on-soft); }
  .prog { display: flex; flex-direction: column; gap: 4px; min-width: 220px; }
  .bar { height: 8px; border-radius: 4px; background: var(--color-raised); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--color-on); transition: width 0.25s; }
  .bar span.ok { background: var(--color-ok); }
  .bar span.bad { background: var(--color-fault); }
  .fault { color: var(--color-fault); font-weight: 600; }
  .btns { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .three { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4); align-items: start; }
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .files { margin: 0; padding-left: 18px; font-size: var(--text-xs); display: flex; flex-direction: column; gap: 2px; }
  .note { font-size: var(--text-xs); }
  .warnT { color: var(--color-warn); font-weight: 600; }
  @media (max-width: 900px) { .prog { min-width: 0; flex: 1 1 100%; } }
  .notes summary { cursor: pointer; font-weight: 600; }
  .flog summary { cursor: pointer; font-size: var(--text-xs); }
  .flog pre { white-space: pre-wrap; max-height: 220px; overflow: auto; font-size: var(--text-xs); margin: var(--space-1) 0 0; padding: var(--space-2); background: var(--color-bg); border: 1px solid var(--color-line); border-radius: var(--radius-md); }
  .md { white-space: pre-wrap; max-height: 220px; overflow: auto; font-size: var(--text-xs); margin-top: var(--space-2); }
</style>
