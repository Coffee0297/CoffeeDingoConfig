<script>
  // "On the car" list + "Add a keypad".
  import { Card, Chip, StateDot, Select, Field, Button } from '../../../../ui/index.js'
  import { hex } from '../../../../lib/live.svelte.js'
  import { MODELS, modelOf, write } from './keypadLogic.js'
  let { pads, free, selKey = $bindable(''), heard, onchanged } = $props()

  let addPdm = $state(''), addModel = $state('6'), addNode = $state('21'), busy = $state(false), err = $state('')
  const slotKey = (f) => `${f.pdm.guid}:${f.slot}`
  $effect(() => { if (!free.some((f) => slotKey(f) === addPdm)) addPdm = free[0] ? slotKey(free[0]) : '' })
  const pdmItems = $derived(free.map((f) => ({ value: slotKey(f), label: `${f.pdm.name} · keypad ${f.slot}` })))
  const modelItems = MODELS.map((m) => ({ value: String(m.value), label: `${m.label} · ${m.buttons} buttons` }))

  async function add() {
    err = ''
    const node = Number(addNode)
    if (!Number.isInteger(node) || node < 1 || node > 127) { err = 'The node ID must be a whole number from 1 to 127.'; return }
    if (pads.some((p) => p.kp.id === node)) { err = `Node ${node} is already used by another keypad.`; return }
    const slot = free.find((f) => slotKey(f) === addPdm)
    if (!slot) { err = 'Pick a module with a free keypad slot.'; return }
    busy = true
    const r = await write(slot.pdm.guid, 'keypad', slot.slot, { enabled: true, id: node, model: Number(addModel) })
    busy = false
    if (r) { await onchanged?.(); selKey = `${slot.pdm.guid}:${slot.slot}` }
  }
</script>

<Card title="On the car" subtitle={`${pads.length} keypad${pads.length === 1 ? '' : 's'}`} aria-label="Keypads on the car">
  {#if !pads.length}
    <p class="muted" data-testid="no-keypads">No keypad is set up on any module yet. Add one below.</p>
  {/if}
  <ul class="pads" data-testid="keypad-list">
    {#each pads as p (p.key)}
      {@const h = heard(p.kp.id)}
      <li><button type="button" class="pad" aria-pressed={selKey === p.key} onclick={() => (selKey = p.key)} data-testid={`keypad-${p.pdm.name}-${p.slot}`}>
        <span class="t"><strong>{p.pdm.name} · keypad {p.slot}</strong>
          <StateDot tone={h.answering ? 'ok' : 'fault'} shape={h.answering ? 'dot' : 'square'} label={h.answering ? 'Answering' : 'Not answering'} /></span>
        <span class="muted">{modelOf(p.kp.model).label} · node {hex(p.kp.id)} · {modelOf(p.kp.model).buttons} buttons</span>
        <span class="muted">{p.kp.buttons.slice(0, modelOf(p.kp.model).buttons).filter((b) => b.enabled).length} of {modelOf(p.kp.model).buttons} buttons mapped</span>
      </button></li>
    {/each}
  </ul>
</Card>

<Card title="Add a keypad" aria-label="Add a keypad">
  {#if !free.length}
    <p class="muted" data-testid="no-free-slot">Every keypad slot on every module is in use.</p>
  {:else}
    <Select label="Keypad slot" items={pdmItems} bind:value={addPdm} data-testid="add-keypad-pdm" />
    <Select label="Keypad model" items={modelItems} bind:value={addModel} data-testid="add-keypad-model" />
    <Field label="Node ID (1 to 127)" bind:value={addNode} mono hint="Set on the keypad itself. The PDM listens for its heartbeat on this node." error={err} data-testid="add-keypad-node" />
    <div><Button variant="primary" {busy} onclick={add} data-testid="add-keypad">Add keypad</Button></div>
  {/if}
</Card>

<style>
  .pads { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .pad { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 4px; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); border: 2px solid var(--color-line-strong); background: transparent; color: var(--color-text); min-height: var(--target-min); }
  .pad[aria-pressed='true'] { border-color: var(--color-accent); background: var(--color-raised); }
  .t { display: flex; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
</style>
