<script>
  // The keypad face: every key with its LED state, backlight, dimming signal, remove.
  import { Card, Banner, Button, Select, StateDot } from '../../../../ui/index.js'
  import { hex } from '../../../../lib/live.svelte.js'
  import { modelOf, COLORS, SWATCH, MAX_BRIGHT, pct, write } from './keypadLogic.js'
  import Confirm from '../../../power/parts/Confirm.svelte'
  let { pad, heard, signals = [], selBtn = $bindable(1), onchanged, onretry } = $props()

  const m = $derived(modelOf(pad.kp.model))
  const keys = $derived(pad.kp.buttons.slice(0, m.buttons))
  const h = $derived(heard(pad.kp.id))
  const sigItems = $derived([{ value: '0', label: 'Never dim' }, ...signals.map((s) => ({ value: String(s.index), label: s.name }))])
  let level = $state(63), dragging = $state(false), msg = $state(''), removeOpen = $state(false), busy = $state(false)
  $effect(() => { if (!dragging) level = pad.kp.backlightBrightness })

  async function setBacklight() {
    dragging = false
    const r = await write(pad.pdm.guid, 'keypad', pad.slot, { backlightBrightness: Number(level) })
    if (r) { msg = `Backlight set to ${pct(level)} %.`; await onchanged?.() }
  }
  async function setDim(v) {
    const r = await write(pad.pdm.guid, 'keypad', pad.slot, { dimmingVar: Number(v) })
    if (r) { msg = Number(v) ? 'The backlight dims while that signal is true.' : 'The backlight no longer dims.'; await onchanged?.() }
  }
  async function remove() {
    busy = true
    const r = await write(pad.pdm.guid, 'keypad', pad.slot, { enabled: false, id: 0 })
    busy = false; removeOpen = false
    if (r) await onchanged?.()
  }
  const col = (b) => b.valColors?.[0] ?? 0
</script>

<Card title={`${pad.pdm.name} · keypad ${pad.slot} · ${m.label}`} aria-label="Keypad face">
  {#snippet actions()}
    <span role="status" data-testid="keypad-heard"><StateDot tone={h.answering ? 'ok' : 'fault'} shape={h.answering ? 'dot' : 'square'} label={h.answering ? 'Answering' : 'Not answering'} /></span>
  {/snippet}
  {#if !h.answering}
    <Banner tone="fault" title={`Keypad is not answering on node ${hex(pad.kp.id)}`} data-testid="keypad-down">
      {h.last ? `Last heard ${h.last}.` : 'No heartbeat heard since dingoConfig started.'} Check 12 V power, CAN high and low wires, the node ID on the keypad and the bitrate. Your button settings are kept.
      {#snippet actions()}<Button size="sm" onclick={onretry}>Try again</Button>{/snippet}
    </Banner>
  {/if}
  <div class="face" class:dim={!h.answering} data-testid="keypad-face">
    {#each keys as b (b.number)}
      <button type="button" class="key" class:unmapped={!b.enabled} aria-pressed={selBtn === b.number} onclick={() => (selBtn = b.number)}
        aria-label={`Button ${b.number}, ${b.enabled ? b.name : 'not mapped'}${selBtn === b.number ? ', selected' : ''}`} data-testid={`key-${b.number}`}>
        <span class="num mono">{String(b.number).padStart(2, '0')}</span>
        <span class="lbl">{b.enabled ? b.name : 'Not mapped'}</span>
        <span class="led"><span class="dot" style="--c: var({SWATCH[col(b)]}); background: {col(b) ? 'var(--c)' : 'transparent'}; border-color: var(--c)" aria-hidden="true"></span>{b.enabled ? COLORS[col(b)] : 'no LED'}</span>
      </button>
    {/each}
  </div>
  <p class="muted note">A key that is pressed on the car shows here once the keypad reports it. Not available yet: live press display (the backend does not decode keypad frames).</p>

  <div class="bl">
    <label class="nx-label" for="backlight">Backlight</label>
    <input id="backlight" type="range" min="0" max={MAX_BRIGHT} bind:value={level} oninput={() => (dragging = true)} onchange={setBacklight} data-testid="backlight" aria-valuetext={`${pct(level)} percent`} />
    <span class="mono" data-testid="backlight-pct">{pct(level)} %</span>
  </div>
  <Select label="Dim the backlight while this signal is true" items={sigItems} value={String(pad.kp.dimmingVar ?? 0)} onchange={setDim} data-testid="dim-signal" />
  {#if msg}<p class="muted" role="status" data-testid="keypad-msg">{msg}</p>{/if}
  <div><Button variant="danger" size="sm" onclick={() => (removeOpen = true)} data-testid="remove-keypad">Remove this keypad</Button></div>
</Card>

<Confirm bind:open={removeOpen} title="Remove this keypad?" confirmLabel="Remove keypad" variant="danger" {busy}
  consequence="The slot is switched off on the module and its buttons stop working. Button settings stay stored in the slot; add the keypad again to use them."
  onconfirm={remove}>
  <p>{pad.pdm.name} keypad {pad.slot} (node {hex(pad.kp.id)}) is disabled.</p>
</Confirm>

<style>
  .face { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-lg); background: var(--color-bg); border: 1px solid var(--color-line); }
  .face.dim { opacity: 0.6; }
  .key { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; text-align: left; min-height: 92px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); border: 2px solid var(--color-line-strong); background: var(--color-surface); color: var(--color-text); }
  .key.unmapped { border-style: dashed; border-color: var(--color-warn); }
  .key[aria-pressed='true'] { border: 3px solid var(--color-accent); }
  .num { font-size: var(--text-xs); color: var(--color-text-muted); }
  .lbl { font-weight: 600; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .led { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--color-text-muted); }
  .dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid; display: inline-block; }
  .bl { display: flex; align-items: center; gap: var(--space-3); }
  .bl input { flex: 1 1 auto; min-height: 32px; accent-color: var(--color-accent); }
  .note { font-size: var(--text-xs); }
</style>
