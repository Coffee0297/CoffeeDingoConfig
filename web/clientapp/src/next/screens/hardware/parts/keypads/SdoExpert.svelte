<script>
  // Expert: raw CANopen SDO read / write / store on the selected keypad's node.
  import { Card, Chip, Field, Select, Button } from '../../../../ui/index.js'
  import { api, hex } from '../../../../lib/live.svelte.js'
  import Confirm from '../../../power/parts/Confirm.svelte'
  let { node = 0 } = $props()

  let open = $state(false)
  let idx = $state('0x1017'), sub = $state('0'), size = $state('2'), val = $state('1000')
  let log = $state([]), busy = $state(false), confirm = $state(null)

  const t = () => new Date().toLocaleTimeString('en-GB')
  const abortText = (r) => r.error || (r.abort != null ? `abort 0x${(r.abort >>> 0).toString(16)}` : 'no reply')
  const parseIdx = () => parseInt(String(idx).replace(/^0x/i, ''), 16)
  const parseSub = () => parseInt(String(sub).replace(/^0x/i, ''), String(sub).startsWith('0x') ? 16 : 10)
  function add(text, ok) { log = [{ at: t(), text, ok }, ...log].slice(0, 30) }
  function check() {
    const i = parseIdx(), s = parseSub()
    if (!(node >= 1 && node <= 127)) return 'Pick a keypad first (node 1 to 127).'
    if (!Number.isInteger(i) || i < 0 || i > 0xffff) return 'Index must be hex from 0x0000 to 0xFFFF.'
    if (!Number.isInteger(s) || s < 0 || s > 255) return 'Subindex must be 0 to 255.'
    return ''
  }

  async function read() {
    const bad = check(); if (bad) { add(bad, false); return }
    busy = true
    try {
      const r = await api.sdoRead(node, parseIdx(), parseSub())
      add(r.ok ? `read ${idx}:${String(sub).padStart(2, '0')} → ${r.value >>> 0} (0x${(r.value >>> 0).toString(16).toUpperCase()})` : `read ${idx}:${sub} refused: ${abortText(r)}`, !!r.ok)
    } catch (e) { add(`read ${idx}:${sub} failed: ${e.message}`, false) } finally { busy = false }
  }
  function askWrite() {
    const bad = check(); if (bad) { add(bad, false); return }
    const v = Number(val), n = Number(size)
    const max = n >= 4 ? 0xffffffff : 2 ** (n * 8) - 1
    if (!Number.isInteger(v) || v < 0) { add('Value must be a whole number, 0 or more.', false); return }
    if (v > max) { add(`${v} does not fit in ${n} byte${n > 1 ? 's' : ''} (largest is ${max}).`, false); return }
    confirm = 'write'
  }
  async function doWrite() {
    busy = true
    try {
      const r = await api.sdoWrite(node, parseIdx(), parseSub(), Number(val) >>> 0, Number(size))
      add(r.ok ? `write ${idx}:${sub} ← ${val}` : `write ${idx}:${sub} ← ${val} refused: ${abortText(r)}`, !!r.ok)
    } catch (e) { add(`write failed: ${e.message}`, false) } finally { busy = false; confirm = null }
  }
  async function doStore() {
    busy = true
    try {
      const r = await api.sdoStore(node)
      add(r.ok ? `store in keypad memory (node ${hex(node)})` : `store refused: ${abortText(r)}`, !!r.ok)
    } catch (e) { add(`store failed: ${e.message}`, false) } finally { busy = false; confirm = null }
  }
</script>

<Card aria-label="Expert settings">
  <button type="button" class="tog" aria-expanded={open} aria-controls="sdo-body" onclick={() => (open = !open)} data-testid="sdo-toggle">
    <span aria-hidden="true">{open ? '▾' : '▸'}</span> <strong>Expert: raw settings (SDO)</strong> <Chip tone="muted">EXPERT</Chip>
    <span class="muted">Read and write the keypad's own object dictionary. Most cars never need this.</span>
  </button>
  {#if open}
    <div id="sdo-body" class="body">
      {#if !node}<p class="muted" role="status">Select a keypad above first. The node ID comes from it.</p>{/if}
      <div class="grid">
        <Field label="Index (hex)" bind:value={idx} mono data-testid="sdo-index" />
        <Field label="Subindex" bind:value={sub} mono data-testid="sdo-sub" />
        <Select label="Size (write)" items={[{ value: '1', label: '1 byte' }, { value: '2', label: '2 bytes' }, { value: '4', label: '4 bytes' }]} bind:value={size} data-testid="sdo-size" />
        <Field label="Value to write" bind:value={val} mono data-testid="sdo-value" />
      </div>
      <div class="btns">
        <Button disabled={busy || !node} onclick={read} data-testid="sdo-read">Read</Button>
        <Button disabled={busy || !node} onclick={askWrite} data-testid="sdo-write">Write</Button>
        <Button variant="danger" disabled={busy || !node} onclick={() => (confirm = 'store')} data-testid="sdo-store">Store in keypad memory</Button>
        <span class="muted note">Node {node ? hex(node) : 'not set'}</span>
      </div>
      <ul class="log" role="log" aria-label="SDO results" data-testid="sdo-log">
        {#each log as l, i (i)}<li class:bad={!l.ok} class="mono"><span class="muted">{l.at}</span> {l.text} <strong>{l.ok ? '✓ ok' : '■ not done'}</strong></li>{/each}
        {#if !log.length}<li class="muted">No results yet.</li>{/if}
      </ul>
      <p class="muted note">Write changes the running keypad. Store keeps it after power-off; a wrong value can stop the keypad answering. Heartbeat time at 0x1017 is a safe one to try. Changing the node ID (0x2110) or bitrate (0x2111) moves the keypad on the bus.</p>
    </div>
  {/if}
</Card>

<Confirm bind:open={() => confirm === 'write', (v) => { if (!v) confirm = null }} title="Write this value to the keypad?" confirmLabel="Write" variant="danger" {busy}
  consequence="A wrong object can change the keypad's node ID or bitrate and it stops answering. Write the old value back to undo it, unless you also stored it."
  onconfirm={doWrite}>
  <p>Write {val} ({size} byte{size === '1' ? '' : 's'}) to {idx}:{sub} on node {hex(node)}.</p>
</Confirm>
<Confirm bind:open={() => confirm === 'store', (v) => { if (!v) confirm = null }} title="Store the keypad's settings?" confirmLabel="Store" variant="danger" {busy}
  consequence="The current settings become permanent in the keypad. If they are wrong the keypad may not answer after the next power-up."
  onconfirm={doStore}>
  <p>Save the parameters of node {hex(node)} to its non-volatile memory.</p>
</Confirm>

<style>
  .tog { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; width: 100%; text-align: left; background: transparent; border: 0; color: var(--color-text); min-height: var(--target-min); padding: 0; }
  .body { display: flex; flex-direction: column; gap: var(--space-3); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); }
  .btns { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
  .log { list-style: none; margin: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); border: 1px solid var(--color-line); display: flex; flex-direction: column; gap: 4px; font-size: var(--text-xs); }
  .log .bad strong { color: var(--color-fault); }
  .note { font-size: var(--text-xs); }
</style>
