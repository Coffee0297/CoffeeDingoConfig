<script>
  // Expert > Lua scripts (board H27). One program per module: edit, check, upload with a read-back
  // verify (the backend waits for it), see the module's runtime error and what the script drives.
  import luaparse from 'luaparse'
  import { untrack } from 'svelte'
  import { Page, PageHeader, Card, Button, Chip, StateDot, Banner, Empty, Meter, Dialog } from '../../ui/index.js'
  import { live, api, toast, project, moduleState } from '../../lib/live.svelte.js'
  import { deviceHasLua } from '../../../lib/store.js'
  import { boardOf } from '../../../lib/pinmap.js'
  import { href } from '../../router.svelte.js'
  import { ui } from '../../shell/ui.svelte.js'
  import CodeEditor from './parts/CodeEditor.svelte'

  let { guid } = $props()

  // Lua space per board (firmware LUA_SCRIPT_MAX, from the board facts in /api/definitions, G21)
  const capOf = (d) => boardOf(d)?.luaBytes ?? 4096
  const fmt = (n) => Number(n).toLocaleString('en-US')
  // A textarea holds LF only. A script stored with CRLF keeps its CRLF on upload (the bytes on the module stay the same).
  const norm = (s) => (s ?? '').replace(/\r\n/g, '\n')
  const eolMemo = {} // line ending first seen per module, kept for the session
  const eolOf = (id) => { if (/\r\n/.test(stored[id] ?? '')) eolMemo[id] = '\r\n'; return eolMemo[id] ?? '\n' }
  const wire = (id, text) => (eolOf(id) === '\r\n' ? text.replace(/\n/g, '\r\n') : text)
  const wireOf = (id) => (drafts[id] !== undefined ? wire(id, drafts[id]) : (stored[id] ?? ''))
  const bytesOf = (s) => new TextEncoder().encode(s ?? '').length
  const crc16 = (s) => {
    let c = 0xffffffff
    for (const b of new TextEncoder().encode(s ?? '')) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0')
  }

  const mods = $derived(live.devices.filter((d) => deviceHasLua(d.type)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))
  const noLua = $derived(live.devices.filter((d) => !deviceHasLua(d.type)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))
  const cur = $derived(guid ? mods.find((m) => m.guid === guid) : mods[0])
  const g = $derived(cur?.guid)

  let stored = $state({}) // guid -> program saved in the project
  let loaded = $state({}) // guid -> true once read
  let drafts = $state({}) // guid -> edited text (only when different from stored)
  let phase = $state({}) // guid -> { k: 'uploading'|'verified'|'mismatch'|'failed'|'read', ... }
  let rtErr = $state({}) // guid -> runtime error text from the module
  let diffLine = $state({}) // guid -> first differing line after "show the difference"
  let busyRead = $state(false)
  let busyDiff = $state(false)
  let elapsed = $state(0)
  let varNames = $state({}) // guid -> { [index]: name }
  let editor = $state(null)
  let confirm = $state(null) // { title, body, go, label }

  const curText = $derived(g ? (drafts[g] ?? norm(stored[g])) : '')
  const edited = $derived(!!g && drafts[g] !== undefined)
  function setDraft(v) {
    if (!g) return
    if (v === norm(stored[g])) delete drafts[g]
    else drafts[g] = v
  }

  async function loadStored(id) {
    try {
      const r = await api.luaRead(id, true)
      stored[id] = r?.source ?? ''
      eolOf(id)
    } catch (e) { toast('Could not read the script from the project: ' + e.message, 'error', 6000); stored[id] = '' }
    loaded[id] = true
  }
  $effect(() => {
    for (const m of mods) if (untrack(() => loaded[m.guid]) === undefined) untrack(() => { loaded[m.guid] = false; loadStored(m.guid) })
  })

  // The module's own runtime error, polled while it is live.
  const sim = $derived(!live.programmingAllowed)
  const modLive = $derived(live.connected && !!cur?.connected)
  // The error text is read over CAN in chunks, so a read right after an upload can come back cut short.
  // An error is shown only when two reads in a row agree; an empty read clears it at once.
  const seenErr = {}
  async function pollError(id, again = true) {
    let e
    try { e = (await api.luaError(id))?.error ?? '' } catch { return /* offline: keep last */ }
    if (!e) { rtErr[id] = ''; seenErr[id] = ''; return }
    if (rtErr[id] === e) return
    if (seenErr[id] === e) { rtErr[id] = e; return }
    seenErr[id] = e
    if (again) setTimeout(() => pollError(id, false), 1500)
  }
  $effect(() => {
    const id = g
    if (!id || !modLive) return
    pollError(id)
    const t = setInterval(() => pollError(id), 5000)
    return () => clearInterval(t)
  })

  // Names of the signals the script reads (readVar index -> name).
  $effect(() => {
    const id = g
    if (!id || !modLive || id in untrack(() => varNames)) return
    untrack(() => { varNames[id] = {} })
    api.inputs(id).then((l) => { varNames[id] = Object.fromEntries((l ?? []).map((v) => [v.index, v.name])) }).catch(() => {})
  })

  // ---- syntax check (Lua 5.3 grammar in the browser; the firmware runs a newer Lua) ----
  const syntax = $derived.by(() => {
    try { luaparse.parse(curText || '', { luaVersion: '5.3', comments: false }); return { ok: true } } catch (e) {
      return { ok: false, line: e?.line ?? null, msg: String(e?.message ?? e).replace(/^\[\d+:\d+\]\s*/, '') }
    }
  })
  function checkSyntax() {
    if (syntax.ok) toast('Syntax looks fine.', 'info', 3000)
    else { toast(`Line ${syntax.line ?? '?'}: ${syntax.msg}`, 'error', 6000); if (syntax.line) editor?.goTo(syntax.line) }
  }

  // ---- status ----
  const err = $derived(g ? rtErr[g] : '')
  const errLine = $derived.by(() => { const m = /(?:line\s*|:)(\d+)/i.exec(err ?? ''); return m ? Number(m[1]) : null })
  const ph = $derived(g ? phase[g] : undefined)
  const status = $derived.by(() => {
    if (!cur) return 'none'
    if (!modLive) return 'offline'
    if (sim) return 'sim'
    if (ph?.k === 'uploading') return 'uploading'
    if (ph?.k === 'mismatch') return 'mismatch'
    if (ph?.k === 'failed') return 'failed'
    if (err) return 'error'
    if (edited) return 'edited'
    if (ph?.k === 'verified') return 'verified'
    return 'clean'
  })
  const PILL = {
    offline: ['◌', 'muted', 'Module not found'], sim: ['■', 'warn', 'Sim adapter · upload is off'], uploading: ['◐', 'accent', 'Uploading'],
    mismatch: ['≠', 'fault', 'Read-back mismatch'], failed: ['✕', 'fault', 'Upload failed'], error: ['✕', 'fault', 'Runtime error'],
    edited: ['◇', 'warn', 'Edited, not on the module'], verified: ['✓', 'ok', 'Verified'], clean: ['○', 'muted', 'Same as the project'],
  }
  const uploadOff = $derived(status === 'offline' || status === 'sim' || status === 'uploading')
  const uploadLabel = $derived(status === 'uploading' ? 'Uploading…' : uploadOff ? 'Upload (off)' : `Upload to ${cur?.name ?? ''}`)

  const marks = $derived.by(() => {
    const m = {}
    if (!syntax.ok && syntax.line) m[syntax.line] = { symbol: '✕', tone: 'fault', word: 'Syntax error: ' + syntax.msg }
    if (errLine && !edited) m[errLine] = { symbol: '✕', tone: 'fault', word: 'Runtime error: ' + err }
    const d = g ? diffLine[g] : null
    if (d) m[d] = { symbol: '≠', tone: 'warn', word: 'First difference from the module' }
    return m
  })

  // ---- pieces of an assembled program (written by the old editor as __fn_<key> blocks) ----
  const pieces = $derived.by(() => {
    const out = []
    const rows = curText.split('\n')
    const gl = rows.findIndex((r) => /^local function __fn_[a-z]+\d+\(\)/.test(r))
    if (gl > 0 || (gl < 0 && curText.trim())) out.push({ name: 'Global script', line: 1 })
    rows.forEach((r, i) => { const m = /^local function __fn_([a-z]+\d+)\(\)/.exec(r); if (m) out.push({ name: 'Piece ' + m[1], line: i + 1 }) })
    return out.length > 1 ? out : []
  })

  // ---- what the script drives (parsed from the text + live outputs) ----
  const drives = $derived.by(() => {
    const rows = []
    const t = curText
    const slots = [...new Set([...t.matchAll(/setLuaOut\s*\(\s*(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
    for (const s of slots) {
      const outs = (cur?.outputs ?? []).filter((o) => o.input === 'Lua Out ' + (s + 1))
      if (!outs.length) rows.push({ key: 'slot' + s, kind: 'LUA SLOT', name: `Lua Out ${s + 1}`, pin: `slot ${s}`, dir: 'writes', note: 'No output uses this slot yet.' })
      for (const o of outs) rows.push({ key: `o${o.number}`, kind: 'OUTPUT', name: o.name, pin: `o${o.number}`, dir: 'writes', out: o })
    }
    const reads = [...new Set([...t.matchAll(/readVar\s*\(\s*(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
    for (const i of reads) rows.push({ key: 'v' + i, kind: 'SIGNAL', name: varNames[g]?.[i] ?? `Signal ${i}`, pin: `var ${i}`, dir: 'reads' })
    for (const m of t.matchAll(/txCan\s*\(\s*\d+\s*,\s*(0[xX][0-9A-Fa-f]+|\d+)/g)) rows.push({ key: 'tx' + m[1] + '-' + rows.length, kind: 'CAN OUT', name: 'Sends frame ' + (/^0x/i.test(m[1]) ? m[1].toUpperCase().replace('0X', '0x') : '0x' + Number(m[1]).toString(16).toUpperCase()), pin: 'txCan', dir: 'sends' })
    for (const m of t.matchAll(/canRxAdd\s*\(\s*(0[xX][0-9A-Fa-f]+|\d+)/g)) rows.push({ key: 'rx' + m[1] + '-' + rows.length, kind: 'CAN IN', name: 'Listens to frame ' + (/^0x/i.test(m[1]) ? m[1].toUpperCase().replace('0X', '0x') : '0x' + Number(m[1]).toString(16).toUpperCase()), pin: 'canRxAdd', dir: 'reads' })
    return rows
  })
  const stateOf = (o) => (o?.state === 'On' ? { tone: 'on', shape: 'dot', word: 'On' } : o?.state === 'Off' ? { tone: 'off', shape: 'ring', word: 'Off' } : { tone: 'warn', shape: 'triangle', word: o?.state ?? 'No data' })

  // ---- same script elsewhere ----
  const twins = $derived(!cur || !curText.trim() ? [] : mods.filter((m) => m.guid !== g && (stored[m.guid] ?? '') === wireOf(g)))

  const used = $derived(bytesOf(g ? wireOf(g) : ''))
  const lineCount = $derived(curText ? curText.split('\n').length : 0)

  // ---- actions ----
  let timer
  function tick(on) { clearInterval(timer); elapsed = 0; if (on) { const t0 = Date.now(); timer = setInterval(() => (elapsed = Math.floor((Date.now() - t0) / 1000)), 500) } }

  async function doUpload() {
    const id = g, src = wire(g, curText), name = cur.name
    phase[id] = { k: 'uploading' }
    delete diffLine[id]
    tick(true)
    try {
      const r = await api.luaUpload(id, src)
      stored[id] = src
      delete drafts[id]
      project.dirty = true
      if (r?.written === false) phase[id] = { k: 'failed', msg: `${name} did not answer, so the script was only saved in the project.` }
      else phase[id] = { k: 'verified', bytes: bytesOf(src), crc: crc16(src), warnings: r?.warnings ?? [] }
      rtErr[id] = ''; seenErr[id] = ''
      setTimeout(() => pollError(id), 2000)
    } catch (e) {
      const m = String(e?.message ?? e)
      phase[id] = /didn't verify/i.test(m) ? { k: 'mismatch', msg: m } : { k: 'failed', msg: m }
    } finally { tick(false) }
  }
  function askUpload() {
    if (uploadOff || !cur) return
    if (!curText.trim()) return (confirm = { title: `Remove the script from ${cur.name}?`, body: `${cur.name} will have no Lua script. Outputs that follow a Lua slot will stay off.`, label: 'Remove script', go: doUpload })
    if (!syntax.ok) return (confirm = { title: 'The browser check found a mistake', body: `Line ${syntax.line ?? '?'}: ${syntax.msg}. The module runs a newer Lua than this check, so it may still be fine. Upload anyway?`, label: 'Upload anyway', go: doUpload })
    doUpload()
  }

  // Live read of the program from the module takes about a minute for a full script, so it has its own long timeout.
  async function readLive(id) {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 150000)
    try {
      const r = await fetch(`/api/devices/${id}/lua`, { signal: ac.signal })
      if (!r.ok) throw new Error((await r.text()) || 'HTTP ' + r.status)
      return await r.json()
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'The module did not answer in time.' : e.message) } finally { clearTimeout(to) }
  }
  async function doRead() {
    const id = g, name = cur.name
    busyRead = true; tick(true)
    try {
      const r = await readLive(id)
      stored[id] = r?.source ?? ''
      delete drafts[id]; delete diffLine[id]
      phase[id] = { k: 'read', live: !!r?.live }
      toast(r?.live ? `Read ${fmt(bytesOf(r.source))} bytes from ${name}.` : `${name} did not answer. Showing the project copy.`, r?.live ? 'info' : 'warn', 4000)
    } catch (e) { toast('Read failed: ' + e.message, 'error', 6000) } finally { busyRead = false; tick(false) }
  }
  function askRead() {
    if (!modLive || busyRead || !cur) return
    if (edited) return (confirm = { title: 'Replace your edits?', body: `This reads ${cur.name}'s script and replaces what is in the editor.`, label: 'Read and replace', go: doRead })
    doRead()
  }
  async function showDiff() {
    const id = g, want = wire(g, curText)
    busyDiff = true; tick(true)
    try {
      const r = await readLive(id)
      const got = r?.source ?? ''
      if (got === want) { phase[id] = { k: 'verified', bytes: bytesOf(want), crc: crc16(want), warnings: [] }; toast('The module has exactly this script.', 'info', 4000) }
      else {
        let i = 0; while (i < want.length && i < got.length && want[i] === got[i]) i++
        const line = want.slice(0, i).split('\n').length
        diffLine[id] = line
        phase[id] = { k: 'mismatch', msg: `The module has ${fmt(bytesOf(got))} bytes; the editor has ${fmt(bytesOf(want))}. The first difference is on line ${line}.` }
        editor?.goTo(line)
      }
    } catch (e) { toast('Read failed: ' + e.message, 'error', 6000) } finally { busyDiff = false; tick(false) }
  }
</script>

<Page>
  <PageHeader title="Lua scripts" subtitle="Custom code for what blocks can't do. It runs on the module itself.">
    {#snippet tag()}
      {#if cur}<Chip tone={PILL[status]?.[1] ?? 'muted'} symbol={PILL[status]?.[0] ?? ''} data-testid="lua-pill">{PILL[status]?.[2] ?? ''}</Chip>{/if}
    {/snippet}
  </PageHeader>

  {#if !live.connected}
    <Banner tone="warn" title="Not connected.">You can read and edit scripts that are stored in the project. Upload and read from module need a connection.
      {#snippet actions()}<Button onclick={() => (ui.panel = 'connect')}>Open Connect</Button>{/snippet}
    </Banner>
  {/if}

  {#if !mods.length}
    <Empty title="No modules with Lua in this project" text="Add a dingoPDM in Hardware to write a script for it." />
  {:else if guid && !cur}
    <Empty title="That module is not in this project" text="Pick a module from the list.">
      {#snippet actions()}<Button href={href('expert', 'lua')}>Show all scripts</Button>{/snippet}
    </Empty>
  {:else}
    <div class="cols">
      <Card title="Scripts on the car" subtitle="One program per module">
        <ul class="list" data-testid="lua-modules">
          {#each mods as m (m.guid)}
            {@const t = wireOf(m.guid)}
            {@const ms = moduleState(m)}
            <li>
              <a class="mod" href={href('expert', 'lua', m.guid)} aria-current={m.guid === g ? 'page' : undefined}>
                <span class="mt"><strong>{m.name}</strong>
                  {#if drafts[m.guid] !== undefined}<Chip tone="warn" symbol="◇">Edited</Chip>{/if}
                </span>
                <span class="muted ms">{loaded[m.guid] ? (t.trim() ? `${fmt(bytesOf(t))} of ${fmt(capOf(m))} B` : 'No script') : 'Reading…'}</span>
                <StateDot tone={ms.key === 'on' ? 'on' : ms.key === 'fault' ? 'fault' : ms.key === 'off' ? 'off' : 'stale'} shape={ms.shape} label={ms.word} />
              </a>
            </li>
          {/each}
        </ul>
        {#if noLua.length}<p class="muted note">{noLua.map((d) => d.name).join(', ')} {noLua.length === 1 ? 'has' : 'have'} no Lua: everything there is blocks.</p>{/if}
      </Card>

      <div class="main">
        {#if cur}
          <Card title={cur.name} subtitle={`whole program · ${fmt(used)} bytes · ${lineCount} lines`}>
            {#snippet actions()}
              <Button size="sm" onclick={checkSyntax} data-testid="lua-check">Check syntax</Button>
              <Button size="sm" onclick={askRead} busy={busyRead} disabled={!modLive || busyDiff || status === 'uploading'} title={modLive ? 'Reads the script back from the module. This takes up to a minute.' : 'The module is not connected.'} data-testid="lua-read">Read from module</Button>
              <Button variant="primary" onclick={askUpload} disabled={uploadOff} title={status === 'sim' ? 'Programming is off while the Sim adapter is active.' : status === 'offline' ? `${cur.name} is not connected.` : ''} data-testid="lua-upload">{uploadLabel}</Button>
            {/snippet}

            {#if pieces.length}
              <div class="pieces" role="group" aria-label="Jump to a part of the script">
                <span class="muted">Jump to</span>
                {#each pieces as p (p.line)}<Button size="sm" variant="ghost" onclick={() => editor?.goTo(p.line)}>{p.name} · line {p.line}</Button>{/each}
              </div>
            {/if}

            <ol class="steps" aria-label="Upload steps" data-testid="lua-steps">
              {#each [['1 Send', 0], ['2 Read back', 1], ['3 ' + (status === 'error' ? 'Run' : 'Compare'), 2]] as [name, i] (i)}
                {@const s = (() => {
                  if (status === 'verified') return [['✓', 'done', `${fmt(ph.bytes)} bytes`], ['✓', 'done', 'returned by the module'], ['✓', 'identical', `checksum ${ph.crc}`]][i]
                  if (status === 'uploading') return i === 0 ? ['◐', 'working', `${elapsed} s so far`] : ['○', 'waiting', i === 1 ? 'starts after sending' : 'byte by byte']
                  if (status === 'mismatch') return [['✓', 'done', ''], ['✓', 'done', ''], ['✕', 'differs', 'did not match']][i]
                  if (status === 'failed') return [['✕', 'failed', ''], ['○', 'skipped', ''], ['○', 'skipped', '']][i]
                  if (status === 'error') return [['✓', 'done', ''], ['✓', 'matches', ''], ['✕', 'stopped', 'error from ' + cur.name]][i]
                  if (status === 'sim' || status === 'offline') return ['■', 'off', status === 'sim' ? 'Sim adapter' : cur.name + ' not found']
                  return ['○', 'not yet', ['to ' + cur.name, 'asks the module for it', 'byte by byte'][i]]
                })()}
                <li data-bad={s[0] === '✕' || undefined}><span aria-hidden="true">{s[0]}</span><strong>{name}</strong><span>{s[1]}</span><span class="muted">{s[2]}</span></li>
              {/each}
            </ol>

            {#if status === 'edited'}
              <Banner tone="info" title="Edited. The module still has the old script.">Upload sends it, then reads it back and compares it with what you wrote. The module keeps its old script until the check passes.</Banner>
            {:else if status === 'uploading'}
              <Banner tone="info" title={`Sending ${fmt(used)} bytes and checking them.`}>Keep the cable and the battery connected. This can take up to a minute. The module keeps running its old script until the new one is verified.</Banner>
            {:else if status === 'verified'}
              <Banner tone="ok" title="Verified. The module has exactly this script.">It read back {fmt(ph.bytes)} bytes and they match. No runtime error reported by {cur.name}.
                {#if ph.warnings?.length}<br /><strong>Check:</strong> {ph.warnings.join(' · ')}{/if}</Banner>
            {:else if status === 'mismatch'}
              <Banner tone="fault" title="The module returned something different.">{ph.msg} Try uploading again. If it repeats, the script may be too big for the space.
                {#snippet actions()}<Button onclick={askUpload}>Upload again</Button><Button onclick={showDiff} busy={busyDiff} data-testid="lua-diff">Show the difference</Button>{/snippet}
              </Banner>
            {:else if status === 'failed'}
              <Banner tone="fault" title="The upload did not finish.">{ph.msg}
                {#snippet actions()}<Button onclick={askUpload}>Upload again</Button>{/snippet}
              </Banner>
            {:else if status === 'error'}
              <Banner tone="fault" title="The script stopped while running.">Reported by {cur.name}: <span class="mono" data-testid="lua-error">{err}</span>
                {#snippet actions()}{#if errLine}<Button onclick={() => editor?.goTo(errLine)}>Go to line {errLine}</Button>{/if}{/snippet}
              </Banner>
            {:else if status === 'sim'}
              <Banner tone="warn" title="Programming is disabled while the Sim adapter is active.">You can read and edit the script, but Upload is off. Switch to a real adapter in Connect to send it to the car.
                {#snippet actions()}<Button onclick={() => (ui.panel = 'connect')}>Open Connect</Button>{/snippet}
              </Banner>
            {:else if status === 'offline'}
              <Banner tone="info" title={`${cur.name} did not answer.`}>Check its power and the CAN wiring. Your script is kept in the project; upload it when the module is back.
                {#snippet actions()}<Button onclick={() => (ui.panel = 'connect')}>Open Connect</Button>{/snippet}
              </Banner>
            {/if}

            {#if loaded[g]}
              <CodeEditor bind:this={editor} bind:value={() => curText, setDraft} {marks} label={`Lua script for ${cur.name}`} />
            {:else}
              <p class="muted" role="status">Reading the script…</p>
            {/if}
            <p class="muted sy" role="status" data-testid="lua-syntax">{syntax.ok ? '✓ Syntax looks fine (checked here as Lua 5.3; the module runs a newer Lua).' : `■ Line ${syntax.line ?? '?'}: ${syntax.msg}`}</p>
          </Card>

          <div class="two">
            <Card title="Lua space">
              <Meter label={`Lua space on ${cur.name}`} value={used} max={capOf(cur)} unit="B" />
              <p class="muted">{fmt(Math.max(0, capOf(cur) - used))} B free. Space is {fmt(capOf(cur))} B on a {boardOf(cur)?.name ?? cur.type} (a fixed firmware limit).</p>
              {#if used > capOf(cur)}<Banner tone="fault" title="Too big.">This script is larger than the space on the module. The upload will be refused.</Banner>{/if}
            </Card>
            <Card title="Same script elsewhere">
              {#if twins.length}
                <p>{#each twins as t, i (t.guid)}{i ? ', ' : ''}<a href={href('expert', 'lua', t.guid)}>{t.name}</a>{/each} {twins.length === 1 ? 'has' : 'have'} the identical script in the project.</p>
                <p class="muted">After you change it, upload it to {twins.length === 1 ? 'that module' : 'those modules'} too.</p>
              {:else}<p class="muted">No other module has this exact script in the project.</p>{/if}
            </Card>
          </div>

          <Card title="This script drives" subtitle="Found in the text; states are live">
            {#if drives.length}
              <ul class="drv" data-testid="lua-drives">
                {#each drives as d (d.key)}
                  {@const st = d.out ? stateOf(d.out) : null}
                  <li><Chip tone="muted">{d.kind}</Chip><strong>{d.name}</strong><span class="mono muted">{d.pin}</span><span class="muted">{d.dir}</span>
                    {#if st}<StateDot tone={st.tone} shape={st.shape} label={modLive ? st.word : 'No data'} />{:else if d.note}<span class="muted">{d.note}</span>{/if}</li>
                {/each}
              </ul>
            {:else}<p class="muted">This script does not set an output or read a signal.</p>{/if}
          </Card>
        {/if}
      </div>
    </div>
  {/if}
</Page>

<Dialog open={!!confirm} title={confirm?.title ?? ''} description={confirm?.body ?? ''} onclose={() => (confirm = null)}>
  {#snippet footer()}
    <Button onclick={() => (confirm = null)}>Cancel</Button>
    <Button variant="primary" onclick={() => { const c = confirm; confirm = null; c?.go() }} data-testid="lua-confirm">{confirm?.label}</Button>
  {/snippet}
</Dialog>

<style>
  .cols { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: var(--space-5); align-items: start; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .mod { display: flex; flex-direction: column; gap: 2px; padding: var(--space-3); min-height: var(--target-min); border-radius: var(--radius-md); border: 1px solid var(--color-line); border-left: 4px solid transparent; text-decoration: none; color: var(--color-text); }
  .mod:hover { background: var(--color-raised); color: var(--color-text); }
  .mod[aria-current='page'] { background: var(--color-raised); border-color: var(--color-line-strong); border-left-color: var(--color-accent); }
  .mt { display: flex; align-items: center; gap: var(--space-2); }
  .ms { font-size: var(--text-xs); }
  .note { font-size: var(--text-xs); }
  .pieces { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
  .steps li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-line); border-radius: var(--radius-md); font-size: var(--text-xs); }
  .steps li[data-bad] { border-color: var(--color-fault); color: var(--color-fault); }
  .sy { font-size: var(--text-xs); }
  .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4); }
  .drv { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .drv li { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); }
</style>
