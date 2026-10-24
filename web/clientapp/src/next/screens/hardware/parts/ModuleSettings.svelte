<script>
  // Settings of one module: name, base CAN ID (with clash check and re-address), deploy to the module on
  // USB, and (full) the read / write / store / version / bootloader actions. Used by Hardware › Modules
  // (side panel) and by the module page (Settings tab).
  import { untrack } from 'svelte'
  import { Button, Banner, Chip, Field, Switch, StateDot } from '../../../ui/index.js'
  import Confirm from '../../../shell/parts/Confirm.svelte'
  import { live, api, toast, mutate, device, moduleState, hex, project } from '../../../lib/live.svelte.js'
  import { href, go } from '../../../router.svelte.js'
  import { ui } from '../../../shell/ui.svelte.js'
  import { addLike } from '../../../shell/parts/addmodule.svelte.js'
  import { postAction, waitRead } from '../../../shell/parts/act.js'
  import { parseId, hexId, clashOf, freeBases, hitsObd, spanText, fwText, busIds } from './ids.js'
  import { deployToUsb } from './deploy.js'
  import { loadCar, carLinks } from '../../functions/flow/car.js'
  import { linkRemote } from '../../functions/flow/net.js'

  let { guid, full = false, onremoved } = $props()

  const d = $derived(device(guid))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const isPdm = $derived(/pdm/i.test(d?.type ?? ''))
  const st = $derived(d ? moduleState(d) : null)
  const simAdapter = $derived(!live.programmingAllowed)
  const progBlock = $derived(!d ? '' : !live.connected ? 'Not connected.' : simAdapter ? 'The simulator replay cannot program modules.' : !d.connected ? `${d.name} is not answering on the bus.` : '')
  // deploy talks to the module on USB only, so the project module need not be on the bus
  const deployBlock = $derived(!live.connected ? 'Not connected.' : simAdapter ? 'The simulator replay cannot program modules.' : '')
  const askBlock =$derived(!d ? '' : !live.connected ? 'Not connected.' : !d.connected ? `${d.name} is not answering on the bus.` : '')

  // ---- name -----------------------------------------------------------------------
  let renaming = $state(false)
  let nameDraft = $state('')
  let nameErr = $state('')
  function startRename() { nameDraft = d.name; nameErr = ''; renaming = true }
  async function saveRename() {
    const v = nameDraft.trim()
    if (!v) { nameErr = 'The name cannot be empty.'; return }
    if (live.devices.some((x) => x.guid !== guid && x.name.toLowerCase() === v.toLowerCase())) { nameErr = `Another module is called ${v}.`; return }
    if (v === d.name) { renaming = false; return }
    if (await mutate(() => api.rename(guid, v), `Renamed to ${v}`)) renaming = false
  }
  function addOneLike() { addLike.guid = guid; ui.addModule = true }

  // ---- base ID ----------------------------------------------------------------------
  let draft = $state('')
  let lastBase = null
  let reserve = $state(true)
  let showSugg = $state(true)
  let reMsg = $state('')
  let reBusy = $state(false)
  $effect(() => { const b = d?.baseId; untrack(() => { if (b != null && b !== lastBase) { lastBase = b; draft = hexId(b) } }) })
  const base = $derived(parseId(draft))
  const edited = $derived(d && base !== d.baseId)
  const clash = $derived(d && base != null ? clashOf(live.devices, guid, d.type, base) : null)
  const obd = $derived(d && base != null && reserve && hitsObd(d.type, base))
  let onBus = $state(new Set())
  busIds().then((b) => (onBus = b))
  // the module's own frames are not "other traffic"
  const busTaken = $derived(d ? new Set([...onBus].filter((id) => id < d.baseId || id > d.baseId + 0x1f)) : onBus)
  const suggs = $derived(d ? freeBases(live.devices, guid, d.type, { reserve, count: 4, busy: busTaken }).filter((b) => b !== d.baseId).slice(0, 3) : [])
  const baseProblem = $derived(base == null ? 'Use a hex ID from 0x001 to 0x7FF, like 0x6C0.' : '')
  const canSetBase = $derived(!!d && edited && base != null && !clash && !reBusy)

  async function askBase() {
    const live_ = d.connected && live.connected
    // CAN inputs on other modules that read this module's frames: re-pointed at the new ID after the change
    reBusy = true
    let links = []
    try { links = carLinks(await loadCar(live.devices), live.devices).filter((l) => l.from.guid === guid && l.sig) } catch { /* no links known: nothing to re-point */ } finally { reBusy = false }
    dlg = { title: live_ ? `Re-address ${d.name} to ${hexId(base)}?` : `Change ${d.name}'s base ID in the project?`, kind: 'base', confirm: live_ ? `Re-address to ${hexId(base)}` : 'Change in project', links, run: () => setBase(links) }
  }
  /** Re-point other modules' CAN inputs at this module's new ID; toast what happened. */
  async function relink(links) {
    if (!links.length) return
    const failed = []
    for (const l of links) {
      const who = live.devices.find((x) => x.guid === l.to.guid)?.name ?? 'a module'
      try { await linkRemote(l.to.guid, Number(l.to.node.split(':')[1]), guid, l.sig.name) } catch (e) { failed.push(`${who} CAN input ${l.to.node.split(':')[1]}: ${e?.message ?? e}`) }
    }
    project.dirty = true
    const ok = links.length - failed.length
    if (failed.length) toast(`Updated ${ok} of ${links.length} CAN inputs on other modules. Not updated: ${failed.join('; ')}`, 'error', 10000)
    else toast(`Updated ${ok} CAN input${ok === 1 ? '' : 's'} on other modules to the new ID. Apply to car to send them.`, 'info', 5000)
  }
  async function setBase(links = []) {
    reBusy = true; reMsg = ''
    const wasLive = d.connected && live.connected
    const name = d.name
    const target = base
    try {
      if (!(await mutate(() => api.modify(guid, name, hexId(target)), wasLive ? undefined : `Base ID of ${name} changed to ${hexId(target)} in the project. The module itself is not changed.`))) return
      await relink(links)
      if (!wasLive) { reMsg = `The project now expects ${name} at ${hexId(target)}. The module was not answering, so it was not told.`; return }
      reMsg = `Sent. ${name} restarts and should answer on ${hexId(target)} in a few seconds…`
      let ok = false
      for (let i = 0; i < 48 && !ok; i++) { await sleep(250); ok = !!live.devices.find((x) => x.guid === guid && x.connected && x.baseId === target) }
      reMsg = ok ? `${name} answers on ${hexId(target)}.` : `${name} has not answered on ${hexId(target)} yet. It may still be restarting: run Find modules, then accept it at its new ID.`
      if (ok) toast(reMsg, 'info', 3500)
    } finally { reBusy = false }
  }

  // ---- deploy to USB -----------------------------------------------------------------
  let usbOpen = $state(false)
  let usb = $state(null) // { base, label } | { error }
  let usbBusy = $state(false)
  let deployBusy = $state(false)
  const boardLabel = (type) => (type === 'dingoPDM' ? 'dingoPDM' : type)
  const boardOk = $derived(usb?.label && d && boardLabel(d.type) === usb.label)
  async function checkUsb() {
    usbBusy = true; usb = null
    try {
      if (!live.connected) { usb = { error: 'Not connected.' }; return }
      const r = await api.usbIdentify()
      if (r?.gatewayBaseId == null) { usb = { error: 'No module answered on USB.' }; return }
      let label = null
      try { label = ((await api.identify())?.found ?? []).find((f) => f.baseId === r.gatewayBaseId)?.label ?? null } catch { /* unknown board */ }
      usb = { base: r.gatewayBaseId, label }
    } catch (e) { usb = { error: e.message } } finally { usbBusy = false }
  }
  function askDeploy() {
    const same = usb.base === d.baseId
    dlg = { kind: 'deploy', title: 'Overwrite the module on USB?', confirm: 'Overwrite module on USB', run: async () => {
      deployBusy = true
      try {
        const r = await deployToUsb(d, usb.base, () => live.devices)
        usb = { ...usb, base: r.newBase }
        toast(`The module on USB is now ${d.name} at ${hexId(r.newBase)}` + (r.luaOk ? '' : '. The Lua upload failed: upload it again from the Lua screen.'), r.luaOk ? 'info' : 'error', r.luaOk ? 4000 : 8000)
      } catch (e) { toast('Deploy failed (the module is unchanged or only partly written): ' + e.message, 'error', 8000) }
      finally { deployBusy = false }
    }, same }
  }

  // ---- actions (full) -----------------------------------------------------------------
  let busy = $state('')
  let actMsg = $state('')
  async function act(kind) {
    busy = kind; actMsg = ''
    try {
      if (kind === 'read') {
        const r = await postAction(guid, 'read')
        if (!r.ok) { actMsg = r.error; toast(`${d.name}: ${r.error}`, 'error', 6000); return }
        await waitRead(() => device(guid))
        const n = device(guid)?.configDiffCount ?? 0
        actMsg = n ? `Read ${d.name}. ${n} setting${n === 1 ? '' : 's'} differ from the project (open Apply to car to see them).` : `Read ${d.name}. It matches the project.`
      } else if (kind === 'write') {
        const r = await postAction(guid, 'write')
        actMsg = r.ok ? `Wrote the project's settings to ${d.name}. They are lost at power-off until you store them.` : `${d.name} did not take it: ${r.error}`
        if (!r.ok) toast(actMsg, 'error', 8000)
      } else if (kind === 'burn') {
        const w = await postAction(guid, 'write')
        if (!w.ok) { actMsg = `${d.name} did not take the settings, so nothing was stored: ${w.error}`; toast(actMsg, 'error', 8000); return }
        const b = await postAction(guid, 'burn')
        actMsg = b.ok ? `Stored ${d.name}'s settings in its flash.` : `Written, but ${d.name} did not confirm the store: ${b.error}`
        if (!b.ok) toast(actMsg, 'error', 8000)
      } else if (kind === 'version') {
        const r = await postAction(guid, 'version')
        await sleep(800)
        actMsg = r.ok ? `Asked ${d.name} for its firmware version. It reports ${fwText(device(guid))}.` : r.error
      } else if (kind === 'bootloader') {
        const r = await postAction(guid, 'bootloader')
        actMsg = r.ok ? `${d.name} was told to restart into its bootloader. It stops answering until you flash firmware or power-cycle it.` : r.error
      }
    } finally { busy = '' }
  }
  function askAct(kind) {
    const nm = d.name
    const t = {
      write: { title: `Write the project's settings to ${nm}?`, body: `Its outputs follow the new limits and rules at once. The values are lost at power-off until you store them.`, confirm: 'Write now' },
      burn: { title: `Store ${nm}'s settings permanently?`, body: `This writes the project's settings, then burns them into the module's flash. It starts up with them from now on.`, confirm: 'Write and store' },
      bootloader: { title: `Restart ${nm} into its bootloader?`, body: `The module stops running its program and stops answering. It only comes back after a firmware flash or a power cycle.`, confirm: 'Restart into bootloader' },
    }[kind]
    dlg = { kind: 'act', ...t, run: () => act(kind) }
  }

  // ---- remove ---------------------------------------------------------------------------
  function askRemove() {
    dlg = { kind: 'remove', title: `Remove ${d.name} from the project?`, confirm: 'Remove from project', run: async () => {
      const nm = d.name
      if (await mutate(() => api.remove(guid), `Removed ${nm} from the project.`)) onremoved?.()
    } }
  }

  // ---- confirm dialog ------------------------------------------------------------------------
  let dlg = $state(null)
  const dlgOpen = $derived(!!dlg)
  async function dlgYes() { const r = dlg?.run; dlg = null; await r?.() }
</script>

{#if !d}
  <Banner tone="fault" title="Module not found">This module is not in the project. It may have been removed.</Banner>
{:else}
  <div class="s" data-testid="module-settings">
    <div class="top">
      <div class="nm">
        {#if renaming}
          <Field label="Module name" bind:value={nameDraft} error={nameErr} onkeydown={(e) => e.key === 'Enter' && saveRename()} />
          <Button variant="primary" onclick={saveRename} data-testid="rename-save">Save</Button>
          <Button onclick={() => (renaming = false)}>Cancel</Button>
        {:else}
          <h2>{d.name}</h2>
          <Button size="sm" onclick={startRename} aria-label={`Rename ${d.name}`} data-testid="rename-start">Rename</Button>
          <Button size="sm" onclick={addOneLike} data-testid="add-like">Add one like this</Button>
        {/if}
      </div>
      <div class="meta">
        <span>{d.type}</span><span class="muted">firmware {fwText(d)}</span>
        <StateDot tone={st.key} shape={st.shape} label={st.word} />
      </div>
    </div>

    <section aria-label="Base CAN ID" class="blk">
      <div class="bh"><strong>Base CAN ID</strong><span class="muted">saved in project: <span class="mono" data-testid="saved-base">{hexId(d.baseId)}</span></span></div>
      <div class="inline">
        <Field label="What the project expects" bind:value={draft} mono error={baseProblem} data-testid="base-input" />
        {#if edited}<Button onclick={() => (draft = hexId(d.baseId))}>Undo edit</Button>{/if}
      </div>
      {#if clash}
        <Banner tone="fault" title="CAN ID clash. Setting it is blocked.">{spanText(d.type, base)} overlaps {clash.name} ({spanText(clash.type, clash.baseId)}). Both would answer the same messages. Pick another ID.</Banner>
      {:else if edited && base != null}
        <p class="ok" role="status">✓ {spanText(d.type, base)} is free. No other module uses it.</p>
      {/if}
      {#if obd}<p class="warn" role="status">▲ {hexId(base)} is in the OBD-II range 0x7DF to 0x7EF.</p>{/if}
      <div class="row">
        <Button size="sm" aria-expanded={showSugg} onclick={() => (showSugg = !showSugg)}>{showSugg ? 'Hide suggestions' : 'Suggest a free base ID'}</Button>
        {#if showSugg}<span class="muted">Free:</span>{#each suggs as b (b)}<Button size="sm" onclick={() => (draft = hexId(b))}>{hexId(b)}</Button>{/each}{/if}
      </div>
      <Switch label="Keep the OBD-II range free" hint="Skips 0x7DF to 0x7EF so a scan tool can still talk to the car." bind:checked={reserve} />
      <div class="row">
        <Button onclick={askBase} disabled={!canSetBase} busy={reBusy} title={edited ? '' : 'Type or pick a different base ID first'} data-testid="base-set">{d.connected && live.connected ? (edited && base != null ? `Re-address to ${hexId(base)}…` : 'Re-address…') : 'Change in project…'}</Button>
        {#if d.connected && live.connected}<span class="muted sm">The module is told to move and stores it. The module must answer on its saved ID.</span>{:else}<span class="muted sm">{d.name} is not answering, so only the project changes.</span>{/if}
      </div>
      {#if reMsg}<p role="status" data-testid="readdr-msg">{reMsg}</p>{/if}
      <details class="how">
        <summary>How re-addressing works</summary>
        <ol>
          <li>The module must be connected and answering on its saved ID.</li>
          <li>dingoConfig sends the new ID and stores it on the module.</li>
          <li>The module restarts and answers on the new ID.</li>
          <li>dingoConfig updates the project.</li>
        </ol>
        <p class="warn">▲ If the link drops half way, the module may already answer on the new ID while the project still has the old one. Run Find modules, then accept the module at its new ID.</p>
      </details>
    </section>

    {#if full}
      <section aria-label="Actions" class="blk">
        <div class="bh"><strong>Talk to the module</strong></div>
        {#if progBlock}<p class="muted sm" role="status">{progBlock}</p>{/if}
        <div class="row">
          <Button onclick={() => act('read')} busy={busy === 'read'} disabled={!!askBlock || !!busy} data-testid="act-read">Read from module</Button>
          <Button onclick={() => askAct('write')} busy={busy === 'write'} disabled={!!progBlock || !!busy} data-testid="act-write">Write to module…</Button>
          <Button onclick={() => askAct('burn')} busy={busy === 'burn'} disabled={!!progBlock || !!busy} data-testid="act-burn">Store on module…</Button>
          <Button onclick={() => act('version')} busy={busy === 'version'} disabled={!!askBlock || !!busy} data-testid="act-version">Ask firmware version</Button>
          <Button variant="danger" onclick={() => askAct('bootloader')} busy={busy === 'bootloader'} disabled={!!progBlock || !!busy || !d.canBootloader} title={d.canBootloader ? '' : 'This module has no CAN bootloader'} data-testid="act-bootloader">Restart into bootloader…</Button>
        </div>
        {#if actMsg}<p role="status" data-testid="act-msg">{actMsg}</p>{/if}
        {#if !d.canBootloader}<p class="muted sm">This module reports no CAN bootloader, so the bootloader restart is off.</p>{/if}
      </section>

      <section aria-label="Sleep and wake" class="blk">
        <div class="bh"><strong>Sleep and wake</strong></div>
        <p class="muted">{d.canSleep === false ? `${d.name} cannot sleep: its firmware is older than 5.5.111.` : `Sleep timeout, wake sources and the shutdown sequence live on the Sleep and wake screen.`}</p>
        <div class="row"><Button href={href('power', 'sleep')} data-testid="to-sleep">Open Sleep and wake</Button></div>
      </section>
    {/if}

    <section aria-label="Deploy to the module on USB" class="blk">
      <button type="button" class="exp" aria-expanded={usbOpen} onclick={() => (usbOpen = !usbOpen)}><span aria-hidden="true">{usbOpen ? '▾' : '▸'}</span> Deploy to the module on USB</button>
      {#if usbOpen}
        <p class="muted">Puts this module's saved settings onto whatever module is plugged into USB. Handy for a spare or a replacement.</p>
        {#if !isPdm}
          <p class="warn" role="status">▲ Deploy to USB works for dingoPDM modules only.</p>
        {:else}
          <div class="row"><Button onclick={checkUsb} busy={usbBusy} data-testid="usb-check">Check what is on USB</Button>
            {#if usb?.base != null}<span>On USB now: <span class="mono">{usb.label ?? 'unknown board'} · base {hexId(usb.base)}</span></span>{/if}</div>
          {#if usb?.error}<p class="warn" role="status">▲ {usb.error}</p>{/if}
          {#if usb?.base != null}
            {#if boardOk}<p class="ok" role="status">✓ Board check passed: {d.name} is a {d.type} and so is the module on USB.</p>
            {:else if usb.label}<p class="bad" role="status">■ Board check failed: {d.name} is a {d.type}, the module on USB is a {usb.label}. Deploy is off so a config for one board never lands on another.</p>
            {:else}<p class="bad" role="status">■ The bus scan could not tell what board is on USB, so Deploy is off.</p>{/if}
          {/if}
          {#if usb?.base != null && usb.base !== d.baseId}<p class="warn" role="status" data-testid="usb-id-warn">▲ The module on USB answers on {hexId(usb.base)}, not {d.name}'s {hexId(d.baseId)}. Deploy moves it to {hexId(d.baseId)}.</p>{/if}
          {#if deployBlock}<p class="warn" role="status">▲ {deployBlock}</p>{/if}
          <div class="row"><Button variant="primary" disabled={!boardOk || !!deployBlock || deployBusy} title={usb?.base == null ? 'Check what is on USB first' : ''} busy={deployBusy} onclick={askDeploy} data-testid="deploy-usb">Deploy to USB module…</Button></div>
        {/if}
      {/if}
    </section>

    {#if full}
      <section aria-label="Remove" class="blk">
        <div class="bh"><strong>Remove from the project</strong></div>
        <p class="muted">The module itself is not changed and keeps answering on the bus. Its outputs, inputs and functions leave this project.</p>
        <div class="row"><Button variant="danger" onclick={askRemove} data-testid="remove-module">Remove {d.name}…</Button></div>
      </section>
    {/if}
  </div>
{/if}

<Confirm bind:open={() => dlgOpen, (v) => { if (!v) dlg = null }} title={dlg?.title ?? ''} width={560}>
  {#if dlg?.kind === 'base'}
    {#if d?.connected && live.connected}
      <ol class="steps">
        <li>{d?.name} must answer on its saved ID {d ? hexId(d.baseId) : ''} now.</li>
        <li>dingoConfig sends the new ID <span class="mono">{base != null ? hexId(base) : ''}</span> and stores it on the module.</li>
        <li>The module restarts and answers on the new ID.</li>
        <li>dingoConfig updates the project.</li>
      </ol>
      <p class="warn">▲ If the link drops half way, the module may already answer on the new ID while the project still has the old one. Run Find modules, then accept the module at its new ID.</p>
    {:else}
      <p>{d?.name} is not answering, so only the project changes: it will expect the module at <span class="mono">{base != null ? hexId(base) : ''}</span>. Re-address the module itself when it is on the bus.</p>
    {/if}
    {#if dlg.links?.length}<p data-testid="base-relinks">{dlg.links.length} CAN input{dlg.links.length === 1 ? '' : 's'} on other modules read{dlg.links.length === 1 ? 's' : ''} this module; {dlg.links.length === 1 ? 'it' : 'they'} will be updated to the new ID.</p>{/if}
  {:else if dlg?.kind === 'deploy'}
    <p>The module plugged into USB ({usb?.label} at {usb ? hexId(usb.base) : ''}) gets the saved settings of {d?.name}{dlg.same ? '' : ` and restarts on base ID ${d ? hexId(d.baseId) : ''}`}. Its current settings are replaced. Read it into the project first if you want to keep them.</p>
    {#if d?.connected && !dlg.same}<p class="warn">▲ {d.name} is also live on the bus right now. Power it down first, or two modules will fight over its ID.</p>{/if}
    <p class="warn">▲ If the USB link drops half way, Read the module to see what it holds, then deploy again.</p>
  {:else if dlg?.kind === 'remove'}
    <p>{d?.name} ({d ? hexId(d.baseId) : ''}) leaves this project, including its outputs, inputs and functions. The module itself is not changed and keeps answering on the bus. The project is marked unsaved.</p>
  {:else if dlg}
    <p>{dlg.body}</p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (dlg = null)} data-testid="confirm-cancel">{dlg?.kind === 'remove' ? 'Keep it' : 'Cancel'}</Button>
    <Button variant={dlg?.kind === 'remove' || dlg?.kind === 'act' || dlg?.kind === 'deploy' ? 'danger' : 'primary'} onclick={dlgYes} data-testid="confirm-yes">{dlg?.confirm}</Button>
  {/snippet}
</Confirm>

<style>
  .s { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .top { display: flex; flex-direction: column; gap: var(--space-2); }
  .nm { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; }
  .nm h2 { font-size: var(--text-lg); }
  .meta { display: flex; gap: var(--space-4); align-items: center; flex-wrap: wrap; }
  .blk { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
  .bh { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
  .inline { display: flex; align-items: flex-end; gap: var(--space-3); }
  .inline :global(.f) { flex: 1 1 auto; max-width: 260px; }
  .row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .ok { color: var(--color-ok); font-weight: 600; }
  .warn { color: var(--color-warn); }
  .bad { color: var(--color-fault); font-weight: 600; }
  .sm { font-size: var(--text-xs); }
  .how summary { cursor: pointer; min-height: 32px; display: flex; align-items: center; }
  .how ol, .steps { margin: var(--space-2) 0; padding-left: var(--space-5); display: flex; flex-direction: column; gap: 4px; }
  .exp { display: flex; align-items: center; gap: var(--space-2); min-height: 40px; background: transparent; border: 0; color: var(--color-text); font-weight: 700; text-align: left; padding: 0; }
</style>
