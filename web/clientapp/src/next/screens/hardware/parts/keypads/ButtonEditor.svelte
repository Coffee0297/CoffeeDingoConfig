<script>
  // Map one button: enabled, name, momentary / toggle, up to 4 LED states, fault LED. Every change writes at once.
  import { untrack } from 'svelte'
  import { Card, Banner, Checkbox, Field, Segmented, Select } from '../../../../ui/index.js'
  import { remoteItems, resolveRemote, isRemoteKey } from '../../../../lib/remote.js'
  import { COLORS, pad4, write } from './keypadLogic.js'
  let { pad, btn, signals = [], onchanged } = $props()

  const colorItems = COLORS.map((c, i) => ({ value: String(i), label: c }))
  // signals on other modules and ECUs: a pick claims a CAN input on the module that holds the keypad
  let remote = $state([])
  const padGuid = $derived(pad.pdm.guid)   // `pad` is a new object on every reload: key the fetch on the guid only
  $effect(() => {
    const g = padGuid
    let alive = true
    untrack(() => remoteItems(g, 'bool')).then((r) => { if (alive) remote = r }).catch(() => {})   // untracked: reads the polled device list
    return () => { alive = false }
  })
  const sigItems = $derived([{ value: '0', label: 'Not set' }, ...signals.map((s) => ({ value: String(s.index), label: s.name })), ...remote])
  let name = $state(''), msg = $state(''), busy = $state(false), editing = false
  // follow the saved name, but not while it is being typed: a reload after an earlier change (enable, a colour)
  // landed mid-typing and put the old name back, losing what was typed
  $effect(() => { const n = btn.name; untrack(() => { if (!editing) name = n }) })
  const number = $derived((pad.slot - 1) * 32 + btn.number)

  async function save(changes, said) {
    busy = true
    const body = { ...btn, valColors: pad4(btn.valColors, 0), valVars: pad4(btn.valVars, 0), valBlink: pad4(btn.valBlink, false), blinkColors: pad4(btn.blinkColors, 0), ...changes }
    const r = await write(pad.pdm.guid, 'keypadbutton', number, body)
    busy = false
    if (r) { msg = r.unconfirmed ? 'Saved in the project. The module did not confirm it.' : said; await onchanged?.() }
  }
  const setAt = (key, i, v, fill) => { const a = pad4(btn[key], fill); a[i] = v; return a }
  /** A picked signal -> a local var index (a remote one links a CAN input first); null when that failed. */
  async function local(v) {
    if (!isRemoteKey(v)) return Number(v)
    busy = true
    try { return await resolveRemote(pad.pdm.guid, v, 'bool') } catch (e) { msg = e?.message ?? String(e); return null } finally { busy = false }
  }
  const states = ['Default (state 0)', 'State 1', 'State 2', 'State 3']
</script>

<Card title={`Button ${btn.number}`} subtitle={btn.enabled ? btn.name : 'does nothing yet'} aria-label="Map a button">
  {#if !btn.enabled}
    <Banner tone="info" title="This button does nothing yet">Switch it on below and give it a name. Its LED stays off until a state is set.</Banner>
  {/if}
  <Checkbox label="Button enabled" hint="usable as an input under its name" checked={btn.enabled} disabled={busy} onchange={(v) => save({ enabled: v }, v ? 'Button enabled.' : 'Button disabled.')} data-testid="btn-enabled" />
  <Field label="Name on the keypad face" bind:value={name} disabled={busy} onfocus={() => (editing = true)} onblur={() => (editing = false)} onchange={(v) => v !== btn.name && save({ name: v }, `Named “${v}”.`)} data-testid="btn-name" />
  <div class="f"><span class="nx-label" id="act-l">What it does</span>
    <Segmented label="Button action" items={[{ value: '0', label: 'Momentary', sub: 'on while held' }, { value: '1', label: 'Toggle', sub: 'press on, press off' }]} value={String(btn.mode)} disabled={busy} onchange={(v) => Number(v) !== btn.mode && save({ mode: Number(v) }, `Action set to ${v === '1' ? 'toggle' : 'momentary'}.`)} data-testid="btn-action" /></div>

  <h3>LED: colour and signal for each state</h3>
  <p class="muted note">The first state whose signal is true wins. State 0 shows when nothing else does.</p>
  {#each states as st, i (i)}
    <div class="led" data-testid={`led-${i}`}>
      <strong>{st}</strong>
      <Select label={`${st} colour`} hideLabel items={colorItems} value={String(pad4(btn.valColors, 0)[i])} disabled={busy} onchange={(v) => save({ valColors: setAt('valColors', i, Number(v), 0) }, `${st}: ${COLORS[Number(v)]}.`)} data-testid={`led-${i}-color`} />
      <Select label={`${st} signal`} hideLabel items={sigItems} value={String(pad4(btn.valVars, 0)[i])} disabled={busy} onchange={async (v) => { const x = await local(v); if (x != null) save({ valVars: setAt('valVars', i, x, 0) }, `${st}: signal changed.`) }} data-testid={`led-${i}-signal`} />
      <Checkbox label="Blink" checked={!!pad4(btn.valBlink, false)[i]} disabled={busy} onchange={(v) => save({ valBlink: setAt('valBlink', i, v, false) }, `${st}: blink ${v ? 'on' : 'off'}.`)} data-testid={`led-${i}-blink`} />
      {#if pad4(btn.valBlink, false)[i]}
        <Select label={`${st} blink colour`} hideLabel items={colorItems} value={String(pad4(btn.blinkColors, 0)[i])} disabled={busy} onchange={(v) => save({ blinkColors: setAt('blinkColors', i, Number(v), 0) }, `${st}: blinks ${COLORS[Number(v)]}.`)} />
      {/if}
    </div>
  {/each}

  <h3>Fault LED</h3>
  <div class="led" data-testid="led-fault">
    <strong>Fault</strong>
    <Select label="Fault colour" hideLabel items={colorItems} value={String(btn.faultColor ?? 0)} disabled={busy} onchange={(v) => save({ faultColor: Number(v) }, `Fault LED: ${COLORS[Number(v)]}.`)} data-testid="led-fault-color" />
    <Select label="Fault signal" hideLabel items={sigItems} value={String(btn.faultVar ?? 0)} disabled={busy} onchange={async (v) => { const x = await local(v); if (x != null) save({ faultVar: x }, 'Fault signal changed.') }} data-testid="led-fault-signal" />
    <Checkbox label="Blink" checked={!!btn.faultBlink} disabled={busy} onchange={(v) => save({ faultBlink: v }, `Fault blink ${v ? 'on' : 'off'}.`)} data-testid="led-fault-blink" />
    {#if btn.faultBlink}<Select label="Fault blink colour" hideLabel items={colorItems} value={String(btn.faultBlinkColor ?? 0)} disabled={busy} onchange={(v) => save({ faultBlinkColor: Number(v) }, `Fault blinks ${COLORS[Number(v)]}.`)} />{/if}
  </div>
  <p class="muted note">Changes go to {pad.pdm.name} at once. Store them with Apply to car to keep them after power-off. Used by: open the flow builder to see which chains use this button.</p>
  {#if busy}<p class="muted" role="status">Writing to {pad.pdm.name}…</p>{/if}
  {#if msg}<p class="muted" role="status" data-testid="btn-msg">{msg}</p>{/if}
</Card>

<style>
  h3 { font-size: var(--text-md); font-weight: 700; margin-top: var(--space-2); }
  .led { display: grid; grid-template-columns: 130px minmax(120px, 1fr) minmax(140px, 1.4fr) auto auto; gap: var(--space-3); align-items: center; padding: var(--space-2) 0; border-top: 1px solid var(--color-line); }
  .note { font-size: var(--text-xs); }
  @media (max-width: 1100px) { .led { grid-template-columns: 1fr 1fr; } }
</style>
