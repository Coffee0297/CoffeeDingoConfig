<script>
  // Hardware › Modules (board H15): every module in the project with its live state, rename, remove,
  // the CAN ID map, and the settings of the selected module. Backed by telemetry (live.devices),
  // POST /devices/{id}/rename|remove|modify. Board revision is not reported (gap G21) so there is no Rev
  // column; Identify (firmware 5.6) blinks the module's LEDs.
  import { Page, PageHeader, Card, Button, Chip, StateDot, Empty } from '../../ui/index.js'
  import Confirm from '../../shell/parts/Confirm.svelte'
  import { live, api, mutate, moduleState, hex, blinkModule } from '../../lib/live.svelte.js'
  import { olderThan } from './parts/util.js'
  import { href } from '../../router.svelte.js'
  import { ui } from '../../shell/ui.svelte.js'
  import { addLike } from '../../shell/parts/addmodule.svelte.js'
  import ModuleSettings from './parts/ModuleSettings.svelte'
  import HardwareNav from './parts/HardwareNav.svelte'
  import { hexId, clashOf, fwText } from './parts/ids.js'
  import { spanAfter, ID_BEFORE } from '../../../lib/canids.js'

  let { query } = $props()

  const mods = $derived([...live.devices].sort((a, b) => a.baseId - b.baseId))
  let sel = $state(query?.sel ?? null)
  const selected = $derived(mods.find((m) => m.guid === sel) ?? mods[0] ?? null)

  // Last seen: the time this browser last saw the module answering (telemetry has no per-module timestamp).
  let seen = $state({})
  $effect(() => { for (const d of live.devices) if (d.connected && live.connected) seen[d.guid] = Date.now() })
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const lastSeen = (d) => (d.connected && live.connected ? 'now' : seen[d.guid] ? fmtTime(seen[d.guid]) : 'not seen since this page opened')

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

  // remove
  let rm = $state(null)
  async function doRemove() {
    const d = rm; rm = null
    if (!d) return
    if (await mutate(() => api.remove(d.guid), `Removed ${d.name} from the project.`) && sel === d.guid) sel = null
  }

  // CAN ID map
  const range = $derived.by(() => {
    if (!mods.length) return { lo: 0x600, hi: 0x800 }
    const lo = Math.max(0, (Math.min(...mods.map((m) => m.baseId)) - ID_BEFORE) & ~0x3f)
    const top = Math.max(...mods.map((m) => m.baseId + spanAfter(m.type) + 1))
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
  <PageHeader crumbs={[{ label: 'Hardware' }, { label: 'Modules' }]} title="Modules" subtitle={`${mods.length} in this project`}>
    {#snippet actions()}
      <Button onclick={() => (ui.addModule = true)} data-testid="find-modules">Find modules</Button>
      <Button variant="primary" onclick={() => { addLike.guid = null; ui.addModule = true }} data-testid="add-module">Add module</Button>
    {/snippet}
  </PageHeader>
  <HardwareNav current="modules" />

  {#if !mods.length}
    <Empty title="No modules in this project" text={live.connected ? 'Find the modules on the bus, or add one by hand.' : 'Connect to the car to find modules, or add one by hand.'}>
      {#snippet actions()}<Button variant="primary" onclick={() => (ui.addModule = true)}>Add module</Button>{#if !live.connected}<Button onclick={() => (ui.panel = 'connect')}>Open Connect panel</Button>{/if}{/snippet}
    </Empty>
  {:else}
    <div class="cols">
      <div class="main">
        <Card>
          <div class="tw"><table class="nx-table" aria-label="Module table">
            <thead><tr><th>State</th><th>Type</th><th>Name</th><th>Base ID</th><th>Firmware</th><th>Last seen</th><th>Actions</th></tr></thead>
            <tbody>
              {#each mods as d (d.guid)}
                {@const st = moduleState(d)} {@const oldFw = olderThan(d.version, [5, 6, 0])}
                <tr class:sel={selected?.guid === d.guid} class:bad={clashes.has(d.guid)} data-testid={'row-' + d.name}>
                  <td><StateDot tone={st.key} shape={st.shape} label={st.word} /></td>
                  <td>{d.type}</td>
                  <td>
                    {#if renaming === d.guid}
                      <span class="rn">
                        <input class="nx-input" aria-label="Module name" bind:value={draft} onkeydown={(e) => { if (e.key === 'Enter') saveRename(d); if (e.key === 'Escape') renaming = null }} />
                        <Button size="sm" variant="primary" onclick={() => saveRename(d)}>Save</Button>
                        <Button size="sm" onclick={() => (renaming = null)}>Cancel</Button>
                      </span>
                      {#if renameErr}<span class="err" role="alert">■ {renameErr}</span>{/if}
                    {:else}
                      <button type="button" class="pick" aria-pressed={selected?.guid === d.guid} onclick={() => (sel = d.guid)}>{d.name}</button>
                    {/if}
                  </td>
                  <td><span class="mono">{hexId(d.baseId)}</span>{#if clashes.has(d.guid)} <Chip tone="fault" symbol="■">ID clash</Chip>{/if}</td>
                  <td class="mono">{fwText(d)}</td>
                  <td class="muted">{lastSeen(d)}</td>
                  <td class="acts">
                    <Button size="sm" href={href('hardware', 'module', d.guid)} aria-label={`Open ${d.name}`}>Open</Button>
                    <Button size="sm" onclick={() => startRename(d)} aria-label={`Rename ${d.name}`}>Rename</Button>
                    <Button size="sm" disabled={oldFw || !d.connected || !live.connected} title={oldFw ? `Needs firmware 5.6: ${d.name} runs ${fwText(d)}` : !d.connected || !live.connected ? 'The module is not answering' : 'Blink its LEDs for 10 s'} onclick={() => blinkModule(d)} aria-label={`Identify ${d.name}: blink its LED`}>Identify</Button>
                    <Button size="sm" variant="danger" onclick={() => (rm = d)} aria-label={`Remove ${d.name} from the project`}>Remove</Button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table></div>
          <div class="legend">
            <StateDot tone="on" label="Connected: answering now" />
            <StateDot tone="off" shape="ring" label="Asleep: wakes on its wake sources" />
            <StateDot tone="fault" shape="square" label="Not found: in the project, not on the bus" />
            <span class="muted">Identify blinks a module's LEDs (firmware 5.6; a CANBoard has none and only answers)</span>
          </div>
        </Card>

        <Card title="CAN ID map" subtitle="Each module takes a span of IDs (PDM 30, CANBoard 14, plus one guard). Two boxes at the same position are a clash.">
          <div class="map" role="img" aria-label={mapLabel}>
            {#if obdIn}<span class="obd" style="left: {pct(0x7df)}; width: {w(0x11)}">OBD-II reserve</span>{/if}
            {#each mods as m, i (m.guid)}
              <span class="box" class:bad={clashes.has(m.guid)} class:on={selected?.guid === m.guid} style="left: {pct(m.baseId)}; width: {w(spanAfter(m.type) + 1)}; top: {(i % 3) * 36 + 4}px">{clashes.has(m.guid) ? '■ ' : ''}{m.name}</span>
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
  {#snippet footer()}
    <Button onclick={() => (rm = null)} data-testid="rm-keep">Keep it</Button>
    <Button variant="danger" onclick={doRemove} data-testid="rm-yes">Remove from project</Button>
  {/snippet}
</Confirm>

<style>
  .tw { overflow-x: auto; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: var(--space-5); align-items: start; }
  .main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .side { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  tr.sel td { background: var(--color-raised); }
  tr.bad td { border-bottom-color: var(--color-fault); }
  .pick { min-height: 36px; padding: 0 var(--space-2); background: transparent; border: 0; color: var(--color-accent); font-weight: 700; text-align: left; text-decoration: underline; }
  .pick[aria-pressed='true'] { color: var(--color-text); }
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
</style>
