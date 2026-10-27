<script>
  // Hardware › Modules (board H15): every module in the project with its live state, rename, remove,
  // the CAN ID map, and the settings of the selected module. Backed by telemetry (live.devices),
  // POST /devices/{id}/rename|remove|modify. A module cannot report its own board revision (the definitions name the
  // documented board only, G21), so there is no Rev column; Identify (firmware 5.6) blinks the module's LEDs.
  import { DropdownMenu } from 'bits-ui'
  import { Page, PageHeader, Card, Button, Chip, StateDot, Empty, Banner } from '../../ui/index.js'
  import Confirm from '../../shell/parts/Confirm.svelte'
  import { live, api, mutate, moduleState, hex, blinkModule, modulesOf, toast } from '../../lib/live.svelte.js'
  import { lacks, isUpstream } from './parts/util.js'
  import { href } from '../../router.svelte.js'
  import { ui } from '../../shell/ui.svelte.js'
  import { addLike } from '../../shell/parts/addmodule.svelte.js'
  import ModuleSettings from './parts/ModuleSettings.svelte'
  import HardwareNav from './parts/HardwareNav.svelte'
  import { hexId, clashOf, fwText } from './parts/ids.js'
  import { spanAfter, ID_BEFORE } from '../../../lib/canids.js'

  let { query } = $props()

  // firmware 5.7 (the operator's new 5.x line) uses the upstream layout: convert the fork-5.x records of this project
  const forkMods = $derived(mods.filter((d) => d.family === 'fork'))
  let askMigrate = $state(false)
  async function migrate() {
    askMigrate = false
    const r = await mutate(() => api.migrate57())
    if (!r) return
    const warn = r.reduce((n, m) => n + (m.migration ?? []).filter((x) => x.level === 'warn').length, 0)
    toast(`${r.length} module${r.length === 1 ? '' : 's'} converted to firmware 5.7${warn ? `, ${warn} warning${warn === 1 ? '' : 's'}` : ''}. Open each module for its report.`, warn ? 'warn' : 'info', 8000)
  }

  // an ECU described by a DBC file is not a module (no firmware, base ID or settings): it gets its own list
  const mods = $derived(modulesOf(live.devices).sort((a, b) => a.baseId - b.baseId))
  const ecus = $derived(live.devices.filter((d) => !mods.includes(d)))
  let sel = $state(null)
  $effect.pre(() => { sel = query?.sel ?? null })   // a link to another module while this page is open
  const selected = $derived(mods.find((m) => m.guid === sel) ?? mods[0] ?? null)
  // the module on USB answers on an ID no module of this project has (re-addressed in the project, or a spare): its
  // frames can land in a neighbour's ID range and make that one look connected with no version
  const strayUsb = $derived(live.connected && live.usbBaseId != null && !mods.some((m) => m.baseId === live.usbBaseId) ? live.usbBaseId : null)

  // Last seen: the time this browser last saw the module answering (telemetry has no per-module timestamp).
  let seen = $state({})
  $effect(() => { for (const d of live.devices) if (d.connected && live.connected) seen[d.guid] = Date.now() })
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const lastSeen = (d) => (d.connected && live.connected ? 'now' : seen[d.guid] ? fmtTime(seen[d.guid]) : 'not seen since this page opened')

  // a click on the row (not on a control in it) picks the module for the side panel; the name opens it
  function rowClick(e, d) { if (!e.target.closest('a, button, input')) sel = d.guid }
  function rowKey(e, d) { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); sel = d.guid } }

  // inline rename
  let renaming = $state(null)
  let draft = $state('')
  let renameErr = $state('')
  function startRename(d) { sel = d.guid; renaming = d.guid; draft = d.name; renameErr = '' }
  async function saveRename(d) {
    const v = draft.trim()
    if (!v) { renameErr = 'The name cannot be empty.'; return }
    if (live.devices.some((x) => x.guid !== d.guid && x.name.toLowerCase() === v.toLowerCase())) { renameErr = `Another module is called ${v}.`; return }
    if (v === d.name || (await mutate(() => api.rename(d.guid, v), `Renamed to ${v}`))) renaming = null
  }

  // remove: typing the module name arms the button
  let rm = $state(null)
  let rmTyped = $state('')
  const rmArmed = $derived(!!rm && rmTyped.trim() === rm.name)
  function askRemove(d) { rm = d; rmTyped = '' }
  async function doRemove() {
    if (!rmArmed) return
    const d = rm; rm = null
    if (!d) return
    if (await mutate(() => api.remove(d.guid), `Removed ${d.name} from the project.`) && sel === d.guid) sel = null
  }

  // CAN ID map
  const range = $derived.by(() => {
    if (!mods.length) return { lo: 0x600, hi: 0x800 }
    const lo = Math.max(0, (Math.min(...mods.map((m) => m.baseId)) - ID_BEFORE) & ~0x3f)
    const top = Math.max(...mods.map((m) => m.baseId + spanAfter(m.type, m) + 1))
    const hi = Math.min(0x800, Math.ceil(top / 0x40) * 0x40)
    return { lo, hi: Math.max(hi, lo + 0x40) }
  })
  const pct = (n) => (((n - range.lo) / (range.hi - range.lo)) * 100).toFixed(2) + '%'
  const w = (n) => ((n / (range.hi - range.lo)) * 100).toFixed(2) + '%'
  const ticks = $derived.by(() => { const t = []; const step = (range.hi - range.lo) / 8; for (let i = 0; i <= 8; i++) t.push(Math.round(range.lo + i * step)); return t })
  const obdIn = $derived(range.hi > 0x7df)
  const clashes = $derived(new Set(mods.filter((m) => clashOf(live.devices, m.guid, m.type, m.baseId)).map((m) => m.guid)))
  const mapLabel = $derived(`CAN base IDs from ${hexId(range.lo)} to ${hexId(range.hi)}. ` + mods.map((m) => `${m.name} at ${hexId(m.baseId)}`).join(', ') + (obdIn ? '. 0x7DF to 0x7EF is reserved for OBD-II.' : '.') + (clashes.size ? ` ${clashes.size} modules clash.` : ''))
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Hardware' }, { label: 'Modules' }]} title="Modules" subtitle={`${mods.length} in this project${ecus.length ? ` · ${ecus.length} ECU${ecus.length === 1 ? '' : 's'} from a DBC` : ''}`}>
    {#snippet actions()}
      {#if forkMods.length}<Button onclick={() => (askMigrate = true)} data-testid="migrate57">Migrate project to firmware 5.7…</Button>{/if}
      <Button onclick={() => (ui.addModule = true)} data-testid="find-modules">Find modules</Button>
      <Button variant="primary" onclick={() => { addLike.guid = null; ui.addModule = true }} data-testid="add-module">Add module</Button>
    {/snippet}
  </PageHeader>
  <HardwareNav current="modules" />
  {#if strayUsb != null}
    <Banner tone="warn" title={`The module on USB answers on ${hexId(strayUsb)}, which no module in this project uses`} data-testid="usb-stray">
      Its frames can make a neighbouring module look connected. Click the module it should be, then use Deploy to the module on USB: it moves there with that module's settings.
    </Banner>
  {/if}

  {#if !mods.length}
    <Empty title="No modules in this project" text={live.connected ? 'Find the modules on the bus, or add one by hand.' : 'Connect to the car to find modules, or add one by hand.'}>
      {#snippet actions()}<Button variant="primary" onclick={() => (ui.addModule = true)}>Add module</Button>{#if !live.connected}<Button onclick={() => (ui.panel = 'connect')}>Open Connect panel</Button>{/if}{/snippet}
    </Empty>
  {:else}
    <div class="cols">
      <div class="main">
        <Card>
          <div class="tw"><table class="nx-table table-cards" aria-label="Module table">
            <thead><tr><th>State</th><th>Type</th><th>Name</th><th>Base ID</th><th>Firmware</th><th>Last seen</th><th>Actions</th></tr></thead>
            <tbody>
              {#each mods as d (d.guid)}
                {@const st = moduleState(d)} {@const oldFw = !isUpstream(d) && lacks(d, [5, 6, 0])}
                <tr class:sel={selected?.guid === d.guid} class:bad={clashes.has(d.guid)} data-testid={'row-' + d.name} tabindex="0" aria-current={selected?.guid === d.guid ? 'true' : undefined}
                  title="Click to show its settings" onclick={(e) => rowClick(e, d)} onkeydown={(e) => rowKey(e, d)}>
                  <td data-label="State"><StateDot tone={st.key} shape={st.shape} label={st.word} /></td>
                  <td data-label="Type">{d.type}</td>
                  <td class="nmc" data-label="Name">
                    {#if renaming === d.guid}
                      <span class="rn">
                        <!-- svelte-ignore a11y_autofocus -->
                        <input class="nx-input" aria-label="Module name" autofocus bind:value={draft} onkeydown={(e) => { if (e.key === 'Enter') saveRename(d); if (e.key === 'Escape') renaming = null }} />
                        <Button size="sm" variant="primary" onclick={() => saveRename(d)}>Save</Button>
                        <Button size="sm" onclick={() => (renaming = null)}>Cancel</Button>
                      </span>
                      {#if renameErr}<span class="err" role="alert">■ {renameErr}</span>{/if}
                    {:else}
                      <a class="pick" href={href('hardware', 'module', d.guid)} aria-label={`Open ${d.name}`}>{d.name}</a>
                    {/if}
                  </td>
                  <td data-label="Base ID"><span class="mono">{hexId(d.baseId)}</span>{#if clashes.has(d.guid)} <Chip tone="fault" symbol="■">ID clash</Chip>{/if}</td>
                  <td class="mono" data-label="Firmware">{fwText(d)}</td>
                  <td class="muted" data-label="Last seen">{lastSeen(d)}</td>
                  <td class="acts">
                    <Button size="sm" disabled={oldFw || !d.connected || !live.connected} title={oldFw ? `Needs firmware 5.6: ${d.name} runs ${fwText(d)}` : !d.connected || !live.connected ? 'The module is not answering' : isUpstream(d) ? 'Blink its LEDs for 10 s (upstream dingoFW: only if its build has identify)' : 'Blink its LEDs for 10 s'} onclick={() => blinkModule(d)} aria-label={`Identify ${d.name}: blink its LED`}>Identify</Button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger class="more" aria-label={`More actions for ${d.name}`} data-testid={'more-' + d.name}>⋯</DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content class="nx-menu" align="end" sideOffset={4}>
                          <DropdownMenu.Item class="nx-menu-item" onSelect={() => startRename(d)}>Rename</DropdownMenu.Item>
                          <DropdownMenu.Item class="nx-menu-item danger" onSelect={() => askRemove(d)}>Remove from project…</DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table></div>
          <div class="legend">
            <StateDot tone="on" label="Connected: answering now" />
            <StateDot tone="off" shape="ring" label="Asleep: wakes on its wake sources" />
            <StateDot tone="fault" shape="square" label="Not found: in the project, not on the bus" />
            <span class="muted">Click a row to see its settings; the name opens the module. Identify blinks a module's LEDs (firmware 5.6; a CANBoard has none and only answers)</span>
          </div>
        </Card>

        {#if ecus.length}
          <Card title="ECUs" subtitle="Other controllers on the bus, known from their DBC file. Their signals can drive anything: pick them in any signal list." data-testid="ecu-list">
            <ul class="ecus">
              {#each ecus as e (e.guid)}
                <li><strong>{e.name}</strong><StateDot tone={e.connected ? 'on' : 'off'} label={e.connected ? 'Sending' : 'Nothing heard: off, or not on this bus'} /></li>
              {/each}
            </ul>
            <Button size="sm" href={href('expert', 'can', { tab: 'dbc' })}>Manage ECUs and DBC files</Button>
          </Card>
        {/if}

        <Card title="CAN ID map" subtitle="Each module takes a span of IDs (PDM 30, CANBoard 14, plus one guard). Two boxes at the same position are a clash.">
          <div class="map" role="img" aria-label={mapLabel}>
            {#if obdIn}<span class="obd" style="left: {pct(0x7df)}; width: {w(0x11)}">OBD-II reserve</span>{/if}
            {#each mods as m, i (m.guid)}
              <span class="box" class:bad={clashes.has(m.guid)} class:on={selected?.guid === m.guid} style="left: {pct(m.baseId)}; width: {w(spanAfter(m.type, m) + 1)}; top: {(i % 3) * 36 + 4}px">{clashes.has(m.guid) ? '■ ' : ''}{m.name}</span>
            {/each}
          </div>
          <div class="ticks" aria-hidden="true">{#each ticks as t (t)}<span class="mono">{hexId(t)}</span>{/each}</div>
        </Card>
      </div>

      <aside aria-label="Module settings" class="side">
        <span class="nx-label">MODULE SETTINGS</span>
        {#if selected}
          {#key selected.guid}<ModuleSettings guid={selected.guid} />{/key}
          <Button href={href('hardware', 'module', selected.guid)} data-testid="open-module">Open {selected.name}: outputs, inputs, actions</Button>
        {/if}
      </aside>
    </div>
  {/if}
</Page>

<Confirm bind:open={() => !!rm, (v) => { if (!v) rm = null }} title={`Remove ${rm?.name ?? ''}?`} width={520}>
  <p>{rm?.name} ({rm ? hexId(rm.baseId) : ''}) leaves this project, including its outputs, inputs and functions. The module itself is not changed and keeps answering on the bus. The project is marked unsaved.</p>
  <label class="type">Type <strong class="mono">{rm?.name}</strong> to remove it
    <input class="nx-input" bind:value={rmTyped} autocomplete="off" spellcheck="false" data-testid="rm-type" onkeydown={(e) => e.key === 'Enter' && doRemove()} /></label>
  {#snippet footer()}
    <Button onclick={() => (rm = null)} data-testid="rm-keep">Keep it</Button>
    <Button variant="danger" disabled={!rmArmed} onclick={doRemove} data-testid="rm-yes">Remove from project</Button>
  {/snippet}
</Confirm>

<Confirm bind:open={askMigrate} title="Migrate project to firmware 5.7?" width={560}>
  <p>Firmware 5.7 numbers its settings and signals like upstream dingoFW. This converts {forkMods.map((d) => d.name).join(', ')} to that layout: signal choices, Lua readVar numbers, timers, CAN timeouts, other modules' CAN inputs and ignition followers. Each module then shows a report of what changed and what could not be carried over.</p>
  <p>Save the project under a new name afterwards (keep the 5.6 file). A module still on 5.6 refuses Read and Apply until it runs 5.7. After flashing, Read each module (it keeps this project), then Apply to car and Store.</p>
  {#snippet footer()}
    <Button onclick={() => (askMigrate = false)}>Cancel</Button>
    <Button variant="primary" onclick={migrate} data-testid="migrate57-yes">Migrate {forkMods.length} module{forkMods.length === 1 ? '' : 's'}</Button>
  {/snippet}
</Confirm>

<style>
  .tw { overflow-x: auto; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: var(--space-5); align-items: start; }
  .main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .side { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  tbody tr { cursor: pointer; }
  tbody tr:hover td { background: var(--color-raised); }
  tr.sel td { background: var(--color-raised); }
  tr.sel td:first-child { box-shadow: inset 4px 0 0 var(--color-accent); }
  tbody tr:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
  tr.bad td { border-bottom-color: var(--color-fault); }
  .pick { display: inline-flex; align-items: center; min-height: 36px; padding: 0 var(--space-2); color: var(--color-accent); font-weight: 700; text-decoration: underline; }
  .acts :global(.more) { min-width: 36px; min-height: 32px; border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-surface); color: var(--color-text); font-weight: 700; font-size: var(--text-md); line-height: 1; }
  .acts :global(.more:hover) { background: var(--color-raised); }
  :global(.nx-menu) { z-index: 60; min-width: 200px; padding: var(--space-1); border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: 0 8px 24px rgb(0 0 0 / 0.3); }
  :global(.nx-menu-item) { display: flex; align-items: center; min-height: 40px; padding: 0 var(--space-3); border-radius: 4px; cursor: pointer; font-weight: 600; outline: none; }
  :global(.nx-menu-item[data-highlighted]) { background: var(--color-raised); }
  :global(.nx-menu-item.danger) { color: var(--color-fault); }
  .type { display: flex; flex-direction: column; gap: var(--space-2); }
  .acts { display: flex; gap: var(--space-1); flex-wrap: nowrap; white-space: nowrap; }
  td { white-space: nowrap; }
  .rn { display: flex; gap: var(--space-2); align-items: center; }
  .rn input { max-width: 220px; }
  .err { color: var(--color-fault); font-size: var(--text-xs); font-weight: 600; }
  .legend { display: flex; gap: var(--space-5); flex-wrap: wrap; align-items: center; padding-top: var(--space-2); font-size: var(--text-xs); }
  .map { position: relative; height: 124px; border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-bg); overflow: hidden; }
  .box { position: absolute; height: 30px; display: flex; align-items: center; padding: 0 6px; border: 1px solid var(--color-line-strong); border-radius: 6px; background: var(--color-raised); font-size: 11px; font-weight: 600; overflow: hidden; white-space: nowrap; }
  .box.on { border: 2px solid var(--color-accent); }
  .box.bad { border: 2px solid var(--color-fault); background: var(--color-fault-soft); color: var(--color-fault); }
  .obd { position: absolute; top: 0; bottom: 0; background: var(--color-warn-soft); border-left: 2px dashed var(--color-warn); font-size: 11px; color: var(--color-warn); writing-mode: vertical-rl; display: flex; align-items: center; justify-content: center; }
  .ticks { display: flex; justify-content: space-between; font-size: 11px; color: var(--color-text-muted); }
  @media (max-width: 1400px) { .cols { grid-template-columns: 1fr; } }
  @media (max-width: 900px) {
    td { white-space: normal; }
    .acts { justify-content: flex-end; }
    .rn { flex-wrap: wrap; }
    tr.sel { box-shadow: inset 4px 0 0 var(--color-accent); background: var(--color-raised); }
    tr.sel td { background: transparent; }
    tr.sel td:first-child { box-shadow: none; }
  }
  .ecus { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .ecus li { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
</style>
