<script>
  /**
   * "+ Add" a block. Each item claims the first free slot of its kind on this module (the firmware has a
   * fixed number of each) and opens it in the inspector. Items newer firmware added (Math and CAN message: 5.6,
   * Comfort blink: 5.6.1) are shown disabled on an older module with the firmware they need (`version`).
   */
  import { Dialog, FwBadge, Button } from '../../../ui/index.js'
  import { FAM_COLOR } from './model.js'
  import { DUTY_CURVE } from './curve.js'
  import { olderThan } from '../../hardware/parts/util.js'

  let { open = $bindable(false), funcs, cb = false, slots = [], version = '', onadd, onremote, hardwareHref } = $props()
  const free = (arr) => (funcs?.[arr] ?? []).filter((x) => !x.enabled).length
  const has = (arr) => Array.isArray(funcs?.[arr])
  const GROUPS = $derived([
    { name: 'INPUTS', fam: 'in', items: [
      { label: 'CAN input', sub: 'a value or bit from a frame', kind: 'caninput', arr: 'canInputs' },
      { label: 'Signal from another module', sub: 'over CAN, set up for you', remote: true, arr: 'canInputs' },
      { label: 'Switch or sensor on a pin', sub: 'set up on the Hardware screen', hw: true },
    ] },
    { name: 'LOGIC', fam: 'logic', items: [
      { label: 'Compare', sub: 'on above / below a value, with hysteresis', kind: 'condition', arr: 'conditions', body: { operator: 2 } },
      { label: 'Combine AND / OR / NOR', sub: 'up to 3 signals, NOT per input', kind: 'virtualinput', arr: 'virtualInputs' },
      { label: 'Push-button toggle', sub: 'press on, press off (a counter 0–1)', kind: 'counter', arr: 'counters', body: { minCount: 0, maxCount: 1, wrapAround: true, incEdge: 0 } },
      { label: 'Math', sub: 'A + − × ÷ B, then scale', kind: 'math', arr: 'maths', fw: '5.6', body: { op: 0, factor: 1, offset: 0 } },
      // only on a module whose firmware has the curve block (upstream dingoFW, param 0x2400): hidden elsewhere
      { label: 'Curve', sub: 'a value from up to 12 points: fan duty from temperature', kind: 'curve', arr: 'curves', onlyIfPresent: true, body: DUTY_CURVE },
      // only on a module whose firmware has the PID block (upstream dingoFW, param 0x2300): hidden elsewhere.
      // Every field set: a free slot keeps what it held before.
      { label: 'PID', sub: 'holds a value at a target: fan or pump speed from a temperature', kind: 'pid', arr: 'pids', onlyIfPresent: true,
        body: { setpointInput: 0, processInput: 0, activateInput: 1, feedForward: 0, feedFwdInput: 0, kp: 1, ki: 0, kd: 0, iMin: -100, iMax: 100, outMin: 0, outMax: 100, invert: false, spRate: 0, deadband: 0, pvMin: 0, pvMax: 0, fallback: 0, periodMs: 20, setpoint: 0 } },
    ] },
    { name: 'TIME & STATE', fam: 'time', items: [
      { label: 'On-delay', sub: 'on after a time', kind: 'timer', arr: 'timers', body: { mode: 0, preset: 2000 } },
      { label: 'Keep on after', sub: 'stays on for a time', kind: 'timer', arr: 'timers', body: { mode: 1, preset: 60000 } },
      { label: 'Pulse / limit', sub: 'one pulse of a set length', kind: 'timer', arr: 'timers', body: { mode: 2, preset: 1000 } },
      { label: 'Flasher', sub: 'blink on / off', kind: 'flasher', arr: 'flashers', body: { onTime: 500, offTime: 500 } },
      { label: 'Comfort blink', sub: 'a lever tap blinks 3 times; held, a normal blink', kind: 'comfortblink', arr: 'comfortBlinks', fw: '5.6.1', body: { tapMs: 1000, blinks: 3 } },
      { label: 'Counter', sub: 'count presses up / down', kind: 'counter', arr: 'counters' },
      // only on a module whose firmware has the latch/gate block (upstream dingoFW, param 0x2600): hidden elsewhere
      { label: 'Latch (set / reset)', sub: 'on at a set edge, off at a reset edge or after a time', kind: 'latchgate', arr: 'latchGates', onlyIfPresent: true, body: { type: 0, timeMs: 0 } },
      { label: 'Gate (hold a value)', sub: 'follows a value while enabled, holds it while not', kind: 'latchgate', arr: 'latchGates', onlyIfPresent: true, body: { type: 1 } },
      { label: 'Table', sub: 'a value from a curve or map', kind: 'table', arr: 'tables', pdmOnly: true },
    ] },
    { name: 'OUTPUTS', fam: 'out', items: [
      { label: 'CAN output', sub: 'send a value on the bus', kind: 'canoutput', arr: 'canOutputs', body: { interval: 100, bitLength: 8 } },
      { label: 'CAN message', sub: 'a whole frame while a signal is on', kind: 'canmsg', arr: 'canMessages', fw: '5.6', body: { dlc: 8, mode: 0, intervalMs: 100 } },
      { label: 'Output', sub: 'a load on this module: set it up on Hardware', hw: true },
    ] },
  ])
  const slotOf = (arr) => slots.find((s) => s.arr === arr)
</script>

<Dialog bind:open title="Add a block" description="Each block uses one slot of this module. The slots meter shows what is left." width={720}>
  {#each GROUPS as g (g.name)}
    <div class="grp">
      <span class="gn" style="color: {FAM_COLOR[g.fam]}">{g.name}</span>
      <div class="items">
        {#each g.items.filter((x) => !x.onlyIfPresent || has(x.arr)) as it (it.label)}
          {@const old = !!it.fw && olderThan(version, it.fw.split('.').map(Number))}
          {@const avail = old ? false : it.hw ? true : has(it.arr) && free(it.arr) > 0}
          {@const absent = it.arr && !has(it.arr)}
          {#if it.hw}
            <a class="it" href={hardwareHref} style="--fam: {FAM_COLOR[g.fam]}"><span class="l">{it.label}</span><span class="s">{it.sub}</span></a>
          {:else}
            <button type="button" class="it" style="--fam: {FAM_COLOR[g.fam]}" disabled={!avail} onclick={() => (it.remote ? onremote?.() : onadd?.(it))} data-testid={'add-' + it.label}>
              <span class="l">{it.label}</span>
              <span class="s">{it.sub}</span>
              {#if old}<FwBadge version={it.fw} />{:else if absent}<span class="cnt">not on this board</span>{:else}<span class="cnt">{free(it.arr)} of {slotOf(it.arr)?.max ?? (funcs?.[it.arr] ?? []).length} free</span>{/if}
            </button>
          {/if}
        {/each}
      </div>
    </div>
  {/each}
  {#snippet footer()}<Button onclick={() => (open = false)}>Close</Button>{/snippet}
</Dialog>

<style>
  .grp { display: flex; flex-direction: column; gap: 6px; }
  .gn { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
  .items { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .it { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 64px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--color-line); border-left: 3px solid var(--fam); background: var(--color-raised); color: var(--color-text); text-align: left; text-decoration: none; }
  .it:hover:not(:disabled) { border-color: var(--color-line-strong); border-left-color: var(--fam); }
  .it:disabled { opacity: 0.6; }
  .l { font-weight: 600; }
  .s { font-size: var(--text-xs); color: var(--color-text-muted); }
  .cnt { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); margin-top: 2px; }
</style>
