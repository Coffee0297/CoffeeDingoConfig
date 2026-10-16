<script>
  // Project menu (board H17, left half): Save, Save as, Open, New, browser copy, config import/export,
  // and the unsaved-changes dialog before Open / New / Upload.
  // Backed by GET /api/project, POST /api/project/save|open|new|upload, GET /api/project/download.
  // The "unsaved" flag comes from GET /api/project (dirty); edits set it at once.
  import { Dialog, Button, Chip, Field, Banner } from '../ui/index.js'
  import Confirm from './parts/Confirm.svelte'
  import { live, project, api, toast, refreshProject } from '../lib/live.svelte.js'
  import { gatherClientState, restoreClientState } from '../../lib/store.js'
  import { ui } from './ui.svelte.js'
  import { go } from '../router.svelte.js'
  import { pm } from './parts/project.svelte.js'
  import { ago } from '../screens/functions/parts/catalog.js'

  const open = $derived(ui.panel === 'project')
  const stem = (f) => (f ?? '').replace(/\.json$/i, '')
  const projName = $derived(project.current ? stem(project.current) : 'Untitled car')
  // A project that was never saved but has modules counts as unsaved: leaving it would lose it.
  const unsaved = $derived(project.dirty || (!project.current && live.devices.length > 0))
  const files = $derived([...project.files].sort((a, b) => a.localeCompare(b)))
  // newest first with time and module count (G20); an older backend gives names only
  const listed = $derived(project.recent.length ? project.recent : files.map((name) => ({ name })))

  let view = $state('menu') // 'menu' | 'saveas'
  let showFiles = $state(false)
  let nameDraft = $state('')
  let busy = $state(false)
  let msg = $state('')
  let msgTone = $state('info')
  let upEl = $state(null)
  let importEl = $state(null)
  // dlg: the confirmation dialog shown before something that would lose work.
  let dlg = $state(null) // { kind: 'unsaved'|'confirm', title, body, confirm, run }
  let dlgName = $state('')
  let dlgOpen = $state(false)

  function say(text, tone = 'info') { msg = text; msgTone = tone }

  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) { view = pm.view === 'saveas' ? 'saveas' : 'menu'; showFiles = pm.view === 'open'; msg = ''; nameDraft = project.current ? stem(project.current) : ''; pm.view = null }
    wasOpen = open
  })

  // ---- file name rules ------------------------------------------------------
  function fileFor(name) {
    const n = (name ?? '').trim().replace(/\.json$/i, '')
    if (!n) return { error: 'Type a file name.' }
    if (!/^[\w .\-()]+$/.test(n)) return { error: 'Use letters, numbers, spaces, dashes and underscores only.' }
    return { file: n + '.json' }
  }

  // ---- save -----------------------------------------------------------------
  async function saveTo(file) {
    busy = true
    try {
      const r = await api.projSave(file, gatherClientState())   // G4: the app's own state goes in the file
      project.dirty = false
      await refreshProject()
      say(`Saved ${r?.current ?? file}.`)
      toast(`Saved ${r?.current ?? file}`, 'info', 2500)
      return true
    } catch (e) { say('Could not save: ' + e.message, 'fault'); toast('Could not save: ' + e.message, 'error', 6000); return false }
    finally { busy = false }
  }
  async function save() {
    if (busy) return false
    if (!project.current) { if (open) { view = 'saveas' } else { pm.view = 'saveas'; ui.panel = 'project' } return false }
    return saveTo(project.current)
  }
  async function saveAs() {
    const f = fileFor(nameDraft)
    if (f.error) { say(f.error, 'fault'); return false }
    if (files.includes(f.file) && f.file !== project.current && !confirmedOverwrite) { confirmedOverwrite = true; say(`${f.file} already exists. Press Save again to replace it.`, 'warn'); return false }
    confirmedOverwrite = false
    const ok = await saveTo(f.file)
    if (ok) view = 'menu'
    return ok
  }
  let confirmedOverwrite = false
  $effect(() => { nameDraft; confirmedOverwrite = false })

  // ---- guarded actions (Open / New / Upload replace the project) ----------------
  function guard(then, what) {
    if (!unsaved) { then(); return }
    dlg = { kind: 'unsaved', what, then }
    dlgName = project.current ? stem(project.current) : ''
    ui.panel = null
    dlgOpen = true
  }
  async function dlgSaveThen() {
    if (!dlg) return
    const target = project.current ?? fileFor(dlgName).file
    if (!target) { say('Type a file name.', 'fault'); return }
    if (!project.current && files.includes(target)) { dlgErr = `${target} already exists. Pick another name.`; return }
    dlgErr = ''
    if (!(await saveTo(target))) return
    const t = dlg.then; dlgOpen = false; dlg = null; t()
  }
  let dlgErr = $state('')
  function dlgDiscard() { const t = dlg?.then; dlgOpen = false; dlg = null; t?.() }
  function dlgCancel() { dlgOpen = false; dlg = null }

  async function openFile(file) {
    busy = true
    try {
      const r = await api.projOpen(file)
      restoreClientState(r?.client)   // G4: positions, groups, function records (a file without them clears them)
      project.dirty = false
      await refreshProject()
      ui.panel = null
      toast(`Opened ${file}: ${r?.count ?? 0} module${r?.count === 1 ? '' : 's'}`, 'info', 3500)
    } catch (e) { say('Could not open: ' + e.message, 'fault'); ui.panel = 'project'; toast('Could not open: ' + e.message, 'error', 6000) }
    finally { busy = false }
  }
  const pickFile = (f) => { if (f === project.current && !unsaved) { say('This project is already open.'); return } guard(() => openFile(f), `open ${f}`) }

  async function newProject() {
    busy = true
    try {
      await api.projNew()
      restoreClientState(null)   // a new project has none of the old one's layout or records
      live.devices = []   // the telemetry lags: an untitled project with old modules would count as unsaved
      project.dirty = false
      await refreshProject()
      ui.panel = null
      toast('New project started. It is empty.', 'info', 3500)
    } catch (e) { say('Could not start a new project: ' + e.message, 'fault') }
    finally { busy = false }
  }

  // ---- browser copy ------------------------------------------------------------
  function download(name, obj) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function downloadCopy() {
    busy = true
    try {
      const doc = await api.projDownload()
      doc.dingoConfigClient = { ...gatherClientState(), groups: doc.dingoConfigClient?.groups ?? {} }   // groups live on the server (G16)
      const name = (project.current ? stem(project.current) : 'project') + '.json'
      download(name, doc)
      say(`Downloaded ${name} to this PC. The project in the app is not marked saved.`)
    } catch (e) { say('Could not download: ' + e.message, 'fault') }
    finally { busy = false }
  }
  async function uploadChosen(ev) {
    const file = ev.target.files?.[0]; ev.target.value = ''
    if (!file) return
    guard(async () => {
      busy = true
      try {
        const text = await file.text()
        const r = await api.projUpload(text)
        try { restoreClientState(JSON.parse(text).dingoConfigClient) } catch { /* no client section */ }
        project.dirty = false
        await refreshProject()
        ui.panel = null
        toast(`Opened ${file.name}: ${r?.count ?? 0} module${r?.count === 1 ? '' : 's'}`, 'info', 3500)
      } catch (e) { toast('Could not open: ' + e.message, 'error', 6000); ui.panel = 'project'; say('Could not open: ' + e.message, 'fault') }
      finally { busy = false }
    }, `open ${file.name}`)
  }

  // ---- config import / export ---------------------------------------------------
  async function exportConfig(withLua = false) {
    busy = true
    say(withLua ? 'Reading the Lua programs from the modules. This can take a few minutes…' : 'Exporting…')
    try {
      let doc
      if (withLua) {
        // Lua is read back from each module over CAN: far longer than api.configSnapshot's 15 s limit.
        const ac = new AbortController()
        const to = setTimeout(() => ac.abort(), 600_000)
        try {
          const r = await fetch('/api/config?lua=true', { signal: ac.signal })
          if (!r.ok) throw new Error(await r.text())
          doc = await r.json()
        } finally { clearTimeout(to) }
      } else doc = await api.configSnapshot(false)
      download((project.current ? stem(project.current) : 'dingo-config') + '-export.json', doc)
      say(`Exported ${doc.devices?.length ?? 0} module${doc.devices?.length === 1 ? '' : 's'}${withLua ? ' with their Lua' : ' without Lua'}.`)
    } catch (e) { say('Export failed: ' + e.message, 'fault') } finally { busy = false }
  }
  async function exportTemplate() {
    busy = true
    try { download('dingopdm-template.json', await api.configTemplate()); say('Template downloaded.') }
    catch (e) { say('Could not build the template: ' + e.message, 'fault') } finally { busy = false }
  }
  async function importChosen(ev) {
    const file = ev.target.files?.[0]; ev.target.value = ''
    if (!file) return
    let doc
    try { doc = JSON.parse(await file.text()) } catch { say(`${file.name} is not a JSON file.`, 'fault'); return }
    ui.panel = null
    dlg = { kind: 'confirm', title: `Import ${file.name}?`, body: `This applies its settings over the current project (${live.devices.length} module${live.devices.length === 1 ? '' : 's'}). Nothing is sent to the car until you apply.`, confirm: 'Import', run: async () => {
      try {
        const r = await api.applyConfig(doc)
        project.dirty = true
        if (r?.ok) toast(`Imported ${file.name}: ${r.devicesTouched} module(s), ${r.paramsChanged} setting(s)`, 'info', 4000)
        else toast(`Imported with ${r?.errors?.length ?? 0} issue(s): ${r?.errors?.[0] ?? ''}`, 'error', 8000)
      } catch (e) { toast('Import failed: ' + e.message, 'error', 8000) }
    } }
    dlgOpen = true
  }
  async function dlgConfirm() { const r = dlg?.run; dlgOpen = false; dlg = null; await r?.() }

  // ---- shortcuts -------------------------------------------------------------------
  function onKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const k = e.key.toLowerCase()
    if (k === 's') { e.preventDefault(); if (e.shiftKey) { pm.view = 'saveas'; if (open) { view = 'saveas'; nameDraft = project.current ? stem(project.current) : ''; pm.view = null } else ui.panel = 'project' } else save() }
    else if (k === 'o' && !e.shiftKey) { e.preventDefault(); if (open) showFiles = true; else { pm.view = 'open'; ui.panel = 'project' } }
    else if (k === 'n' && !e.shiftKey) { e.preventDefault(); guard(newProject, 'start a new project') }
  }
</script>

<svelte:window onkeydown={onKey} />

<Dialog bind:open={() => open, (v) => { if (!v) ui.panel = null }} title="Project" width={620}>
  <div class="head">
    <strong class="nm">{projName}</strong>
    {#if unsaved}<Chip tone="warn" symbol="●">Unsaved changes</Chip>{:else if project.current}<Chip tone="ok" symbol="✓">Saved</Chip>{/if}
    <span class="muted file" role="status">{project.current ?? 'not saved to a file yet'}{live.devices.length ? ' · ' + live.devices.length + ' module' + (live.devices.length === 1 ? '' : 's') : ''}</span>
  </div>

  {#if view === 'saveas'}
    <div class="box">
      <Field label="File name" bind:value={nameDraft} hint={`Saved in ${project.dir || 'the project folder'} as <name>.json`} mono />
      <div class="row">
        <Button onclick={() => (view = 'menu')}>Back</Button>
        <Button variant="primary" onclick={saveAs} busy={busy} data-testid="saveas-go">Save</Button>
      </div>
    </div>
  {:else}
    <div class="group" role="group" aria-label="File">
      <button type="button" class="act" onclick={save} disabled={busy} data-testid="proj-save">
        <span class="at"><strong>Save</strong><span class="muted">{project.current ? `Overwrites ${project.current}` : 'Asks for a file name first'}</span></span><kbd>Ctrl+S</kbd>
      </button>
      <button type="button" class="act" onclick={() => { view = 'saveas'; nameDraft = project.current ? stem(project.current) : '' }} data-testid="proj-saveas">
        <span class="at"><strong>Save as…</strong><span class="muted">Keep this file and write a new one</span></span><kbd>Ctrl+Shift+S</kbd>
      </button>
      <button type="button" class="act" aria-expanded={showFiles} onclick={() => (showFiles = !showFiles)} data-testid="proj-open">
        <span class="at"><strong>Open…</strong><span class="muted">Choose a project file from the folder</span></span><kbd>Ctrl+O</kbd>
      </button>
      <button type="button" class="act" onclick={() => guard(newProject, 'start a new project')} disabled={busy} data-testid="proj-new">
        <span class="at"><strong>New project</strong><span class="muted">Start empty</span></span><kbd>Ctrl+N</kbd>
      </button>
    </div>

    {#if showFiles}
      <span class="nx-label" id="files-l">Project files ({files.length}) · {project.dir}</span>
      <div class="files" role="group" aria-labelledby="files-l">
        {#each listed as r (r.name)}
          <button type="button" class="file" onclick={() => pickFile(r.name)} disabled={busy}>
            <span class="mono">{r.name}</span>
            {#if r.modifiedAt}<span class="muted meta">{r.moduleCount != null ? `${r.moduleCount} module${r.moduleCount === 1 ? '' : 's'} · ` : ''}<time datetime={r.modifiedAt} title={new Date(r.modifiedAt).toLocaleString()}>{ago(r.modifiedAt)}</time></span>{/if}
            {#if r.name === project.current}<Chip tone="ok">open now</Chip>{/if}
          </button>
        {:else}
          <p class="muted pad">No project files in the folder yet.</p>
        {/each}
      </div>
    {/if}

    <span class="nx-label">Copy to or from this PC</span>
    <div class="row">
      <Button onclick={downloadCopy} disabled={busy} data-testid="proj-download">Download a copy</Button>
      <Button onclick={() => upEl?.click()} disabled={busy} data-testid="proj-upload">Upload a project file…</Button>
      <input bind:this={upEl} type="file" accept=".json,application/json" class="sr-only" tabindex="-1" aria-label="Project file to upload" onchange={uploadChosen} data-testid="proj-upload-input" />
    </div>

    <span class="nx-label">Move config around</span>
    <div class="row">
      <Button onclick={() => importEl?.click()} disabled={busy}>Import config…</Button>
      <input bind:this={importEl} type="file" accept=".json,application/json" class="sr-only" tabindex="-1" aria-label="Config file to import" onchange={importChosen} />
      <Button onclick={() => exportConfig(false)} disabled={busy}>Export config…</Button>
      <Button onclick={() => exportConfig(true)} disabled={busy} title="Reads each module's Lua program over CAN first: slow">Export config with Lua…</Button>
      <Button onclick={exportTemplate} disabled={busy}>Export template…</Button>
      <Button onclick={() => { ui.panel = null; go('expert', 'can', { tab: 'dbc' }) }} title="Opens Expert › CAN & parameters › DBC devices, where you pick what goes in the file" data-testid="proj-dbc">Export combined DBC…</Button>
    </div>
  {/if}

  {#if msg}<div class="msg" data-tone={msgTone} role={msgTone === 'fault' ? 'alert' : 'status'}>{msg}</div>{/if}
</Dialog>

<Confirm bind:open={() => dlgOpen, (v) => { if (!v) dlgCancel() }} title={dlg?.kind === 'unsaved' ? `Save changes to ${projName} first?` : (dlg?.title ?? '')} width={560}>
  {#if dlg?.kind === 'unsaved'}
    <p>You changed {projName}. If you {dlg.what} now, those changes are lost unless you save them.</p>
    {#if project.current}
      <p class="muted"><span class="mono">{project.current}</span> will be overwritten by Save.</p>
    {:else}
      <Field label="File name to save as" bind:value={dlgName} mono hint="Saved as <name>.json in the project folder" error={dlgErr} />
    {/if}
  {:else if dlg}
    <p>{dlg.body}</p>
  {/if}
  {#snippet footer()}
    <Button onclick={dlgCancel} data-testid="dlg-cancel">Cancel</Button>
    {#if dlg?.kind === 'unsaved'}
      <Button variant="danger" onclick={dlgDiscard} data-testid="dlg-discard">Discard and continue</Button>
      <Button variant="primary" onclick={dlgSaveThen} busy={busy} data-testid="dlg-save">Save, then continue</Button>
    {:else}
      <Button variant="primary" onclick={dlgConfirm}>{dlg?.confirm ?? 'OK'}</Button>
    {/if}
  {/snippet}
</Confirm>

<style>
  .head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .nm { font-size: var(--text-lg); }
  .file { font-size: var(--text-xs); flex-basis: 100%; }
  .group { display: flex; flex-direction: column; gap: var(--space-1); }
  .act { display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: 0 var(--space-4); text-align: left; background: var(--color-raised); border: 1px solid var(--color-line); border-radius: var(--radius-md); color: var(--color-text); }
  .act:hover:not(:disabled) { border-color: var(--color-line-strong); }
  .at { flex: 1 1 auto; display: flex; flex-direction: column; }
  .at .muted { font-size: var(--text-xs); }
  kbd { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); }
  .files { display: flex; flex-direction: column; max-height: 220px; overflow: auto; border: 1px solid var(--color-line); border-radius: var(--radius-md); }
  .meta { margin-left: auto; font-size: var(--text-xs); white-space: nowrap; }
  .file { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 44px; padding: 0 var(--space-3); border: 0; border-bottom: 1px solid var(--color-line); background: transparent; color: var(--color-text); text-align: left; }
  .file:hover:not(:disabled) { background: var(--color-raised); }
  .pad { padding: var(--space-3); }
  .sm { font-size: var(--text-xs); }
  .row { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .box { display: flex; flex-direction: column; gap: var(--space-3); }
  .msg { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-raised); border: 1px solid var(--color-line-strong); }
  .msg[data-tone='fault'] { border-color: var(--color-fault); background: var(--color-fault-soft); }
  .msg[data-tone='warn'] { border-color: var(--color-warn); background: var(--color-warn-soft); }
</style>
