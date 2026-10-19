<script>
  /**
   * Create / edit one cross-module function: a trigger signal on one module switches outputs on others,
   * optionally blinking in step from a shared clock (with a backup clock module that takes over).
   * Saving only changes the list; nothing goes to the modules until "Check and send". `idx` -1 = new.
   */
  import { untrack } from 'svelte'
  import { get } from 'svelte/store'
  import { Dialog, Button, Field, Select, Stepper, Checkbox, Banner, Chip } from '../../../ui/index.js'
  import { live, api, isPdm, isCanboard, outputsOf } from '../../../lib/live.svelte.js'
  import { crossFns, cmfIsLua, deviceHasLua, nextCmfSlot } from '../../../../lib/store.js'
  import { blankCrossFn, commitCrossFn, involvedOf, previewCrossModule, normalizeCrossFn } from '../../../../lib/crossModule.js'
  import CodeEditor from '../../expert/parts/CodeEditor.svelte'
  import CrossPreview from './CrossPreview.svelte'

  let { idx = -1, onclose } = $props()
  let open = $state(true)

  const saved = get(crossFns)
  const init = untrack(() => (idx >= 0 && saved[idx] ? JSON.parse(JSON.stringify(saved[idx])) : blankCrossFn()))
  if (!init.luaByModule) init.luaByModule = {}
  if (!Array.isArray(init.targets)) init.targets = []
  if (typeof init.slot !== 'number') init.slot = untrack(() => (idx >= 0 ? idx : nextCmfSlot(saved)))
  let f = $state(init)

  // live.devices is replaced on every poll: rebuild the module lists only when something we show changes
  const devKey = $derived(live.devices.map((d) => [d.guid, d.name, d.type, d.connected, outputsOf(d).map((o) => o.number + '=' + (o.name ?? '')).join(',')].join('/')).join('|'))
  const devs = $derived.by(() => { devKey; return untrack(() => live.devices.map((d) => ({ guid: d.guid, name: d.name, type: d.type, connected: d.connected, outputs: outputsOf(d).map((o) => ({ number: o.number, name: o.name })) }))) })
  const isMod = (d) => isPdm(d) || isCanboard(d)
  const mods = $derived(devs.filter(isMod))
  const dName = (g) => devs.find((d) => d.guid === g)?.name ?? 'a module not in the project'

  // ---- trigger: an on/off signal of any module (the module reads it and puts it on the bus) ----
  let sigItems = $state([]), sigLoading = $state(true), sigErr = $state('')
  const modGuids = $derived(mods.map((d) => d.guid).join())
  $effect(() => { modGuids; untrack(loadSignals) })
  async function loadSignals() {
    sigLoading = true
    const out = [], failed = []
    for (const d of mods) {
      try {
        // signals in use only (an unused CAN input or keypad button never turns on); skip the app's own cmf… slots
        for (const v of (await api.inputs(d.guid, 'bool')) ?? [])
          if (v.index > 0 && v.kind !== 'sys' && v.kind !== 'lua' && v.type !== 'float' && !/^cmf\d/i.test(v.name ?? '')) out.push({ value: `${d.guid}:${v.index}`, label: `${v.name} · ${d.name}`, name: v.name })
      } catch { failed.push(d.name) }
    }
    sigItems = out
    sigErr = failed.length ? `Could not read the signals of ${failed.join(', ')}. The list may be missing some.` : ''
    sigLoading = false
  }
  const trigVal = $derived(f.trigger?.guid && f.trigger?.varIndex != null ? `${f.trigger.guid}:${f.trigger.varIndex}` : '')
  const trigItems = $derived(trigVal && !sigItems.some((i) => i.value === trigVal)
    ? [{ value: trigVal, label: `${f.trigger.varName || 'Signal #' + f.trigger.varIndex} · ${dName(f.trigger.guid)}`, name: f.trigger.varName }, ...sigItems]
    : sigItems)
  function pickTrigger(v) {
    const [guid, i] = String(v).split(':')
    f.trigger = { guid, varIndex: Number(i), varName: trigItems.find((x) => x.value === v)?.name ?? '' }
  }

  // ---- outputs it drives ----
  const outItems = $derived(devs.filter((d) => (d.outputs ?? []).length).flatMap((d) => d.outputs.map((o) => ({ value: `${d.guid}:${o.number}`, label: `${d.name} · O${o.number}${o.name?.trim() ? ' ' + o.name.trim() : ''}` }))))
  function addTarget() { f.targets = [...f.targets, { guid: '', output: null }] }
  function setTarget(i, v) { const [guid, n] = String(v).split(':'); f.targets[i] = { guid, output: Number(n) } }
  function rmTarget(i) { f.targets = f.targets.filter((_, k) => k !== i) }

  // ---- blink clock ----
  const clockItems = $derived([{ value: 'trigger', label: 'The module with the trigger signal' }, ...mods.map((d) => ({ value: d.guid, label: d.name }))])
  const backupItems = $derived([{ value: 'none', label: 'No backup' }, ...mods.filter((d) => deviceHasLua(d)).map((d) => ({ value: d.guid, label: d.name }))])

  // ---- own Lua (expert) ----
  const luaMods = $derived(involvedOf(f).filter((g) => deviceHasLua(devs.find((d) => d.guid === g))))
  let luaMod = $state('')
  $effect(() => { if (!luaMods.includes(luaMod)) luaMod = luaMods[0] ?? '' })
  $effect(() => { if (luaMod && f.luaByModule[luaMod] == null) f.luaByModule[luaMod] = '' })
  const ownLua = $derived(Object.values(f.luaByModule ?? {}).some((t) => t && t.trim()))
  const runsLua = $derived(cmfIsLua({ ...f, mode: ownLua ? 'lua' : 'rule' }))

  // ---- checks ----
  const problems = $derived.by(() => {
    const p = []
    if (!trigVal) p.push('Pick the signal that switches it on.')
    if (!f.targets.length) p.push('Add at least one output for it to switch.')
    if (f.targets.some((t) => !t.guid || !t.output)) p.push('Pick an output on every line, or remove the empty line.')
    const keys = f.targets.filter((t) => t.guid).map((t) => t.guid + ':' + t.output)
    if (new Set(keys).size !== keys.length) p.push('The same output is listed twice.')
    if (f.blink && f.clockBackup && f.clockBackup === (f.clockMaster || f.trigger.guid)) p.push('The backup clock must be a different module from the main clock.')
    if (f.blink && !(Number(f.blinkRateMs) > 0)) p.push('Set how long the lamp stays on and off.')
    return p
  })
  const noLuaMods = $derived(runsLua ? involvedOf(f).filter((g) => !deviceHasLua(devs.find((d) => d.guid === g))).map(dName) : [])

  let plan = $state(null)
  function preview() {
    const g = JSON.parse(JSON.stringify(f))
    g.mode = ownLua ? 'lua' : 'rule'
    plan = previewCrossModule([normalizeCrossFn(g)], devs)
  }
  // a changed function makes an old preview wrong: drop it
  $effect(() => { JSON.stringify(f); untrack(() => (plan = null)) })

  // Bits UI only reports user closes (Esc, ✕) through onOpenChange, so close() tells the parent itself
  function close() { open = false; onclose?.() }
  function save() {
    if (problems.length) return
    crossFns.update((list) => commitCrossFn(list, f, idx))
    close()
  }
</script>

<Dialog bind:open {onclose} width={760} title={idx >= 0 ? `Edit “${f.name || 'cross-module function'}”` : 'New cross-module function'}
  description="A switch or signal on one module turns on outputs on other modules. Nothing is sent to the modules until you press “Check and send”." data-testid="cm-editor">
  <Field label="Name" bind:value={f.name} placeholder="e.g. Left indicator" data-testid="cm-name" />

  <h3>When this is on</h3>
  {#if sigErr}<Banner tone="warn">{sigErr}</Banner>{/if}
  <Select label="Trigger signal (any module)" items={trigItems} value={trigVal} onchange={pickTrigger}
    placeholder={sigLoading ? 'Reading the modules…' : 'Pick a switch or signal'} data-testid="cm-trigger" />

  <h3>Switch these outputs</h3>
  {#each f.targets as t, i (i)}
    <div class="trow">
      <Select label={'Output ' + (i + 1)} hideLabel items={outItems} value={t.guid ? `${t.guid}:${t.output}` : ''} onchange={(v) => setTarget(i, v)}
        placeholder="Pick a module output" data-testid={'cm-target-' + i} />
      <Button variant="ghost" aria-label={'Remove output ' + (i + 1)} onclick={() => rmTarget(i)}>✕</Button>
    </div>
  {/each}
  <div><Button size="sm" onclick={addTarget} data-testid="cm-add-target">+ Add output</Button></div>

  <h3>Blink</h3>
  <Checkbox bind:checked={f.blink} label="Blink — all outputs flash together" hint="One module keeps the time so every lamp flashes in step." data-testid="cm-blink" />
  {#if f.blink}
    <div class="grid">
      <Stepper label="On / off time" unit="ms" min={50} max={5000} step={50} bind:value={f.blinkRateMs} />
      <Select label="Module that keeps the time" items={clockItems} value={f.clockMaster || 'trigger'} onchange={(v) => (f.clockMaster = v === 'trigger' ? '' : v)} data-testid="cm-clock" />
      <Select label="Backup if that module drops out" items={backupItems} value={f.clockBackup || 'none'} onchange={(v) => (f.clockBackup = v === 'none' ? '' : v)} data-testid="cm-backup" />
    </div>
    {#if f.clockBackup}<p class="muted small">A backup clock needs a Lua script on the modules involved (plain CAN wiring can't hand over between two clocks), so this function will run as Lua.</p>{/if}
  {/if}

  <p class="how">How it runs:
    {#if runsLua}<Chip tone="accent">Lua script</Chip> <span class="muted small">{ownLua ? 'you wrote your own Lua below' : 'because it has a backup clock'}</span>
    {:else}<Chip tone="ok">Native wiring</Chip> <span class="muted small">CAN messages, a flasher and output settings — no Lua</span>{/if}
  </p>
  {#if noLuaMods.length}<Banner tone="warn" title="Some modules can't run Lua">{noLuaMods.join(', ')} has no Lua engine (CANBoard). Remove the backup clock and your own Lua so it runs as native wiring, or use a PDM.</Banner>{/if}

  <details class="lua">
    <summary>Write it yourself in Lua (expert)</summary>
    {#if !luaMods.length}
      <p class="muted small">Pick a trigger and outputs on a PDM first. CANBoards have no Lua engine.</p>
    {:else}
      <Select label="Module" items={luaMods.map((g) => ({ value: g, label: dName(g) }))} bind:value={luaMod} />
      {#key luaMod}
        {#if luaMod && f.luaByModule[luaMod] != null}<CodeEditor bind:value={f.luaByModule[luaMod]} label={'Lua for ' + dName(luaMod)} minHeight={200} />{/if}
      {/key}
      <p class="muted small">Any text here replaces the generated script for this module and makes the function run as Lua. Leave it empty to let the app write it.</p>
    {/if}
  </details>

  {#if problems.length}
    <ul class="probs" data-testid="cm-problems">{#each problems as p (p)}<li>{p}</li>{/each}</ul>
  {/if}

  {#if plan}
    <h3>What each module gets</h3>
    <CrossPreview {plan} />
  {/if}

  {#snippet footer()}
    <Button onclick={close} data-testid="cm-cancel">Cancel</Button>
    <Button onclick={preview} disabled={!trigVal || !f.targets.length} data-testid="cm-preview-btn">Preview</Button>
    <Button variant="primary" onclick={save} disabled={problems.length > 0} data-testid="cm-save">{idx >= 0 ? 'Save' : 'Add function'}</Button>
  {/snippet}
</Dialog>

<style>
  h3 { font-size: var(--text-sm); font-weight: 700; margin: var(--space-2) 0 0; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-muted); }
  .trow { display: flex; gap: var(--space-2); align-items: center; }
  .trow > :global(:first-child) { flex: 1 1 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); align-items: end; }
  .small { font-size: var(--text-xs); }
  .how { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin: 0; }
  .lua summary { cursor: pointer; font-weight: 600; }
  .lua[open] { display: flex; flex-direction: column; gap: var(--space-2); }
  .probs { margin: 0; padding-left: 1.2em; color: var(--color-warn); font-size: var(--text-sm); font-weight: 600; }
</style>
