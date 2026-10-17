<script>
  // One ignition signal as a small rule: [NOT] signal [is above 300] [OR / AND [NOT] signal …]. Numbers (an ECU's
  // RPM, an analog input) get a comparison; Save turns the rule into helper blocks (signalRule.js).
  import { Select, Segmented, Button } from '../../../ui/index.js'
  import { OPS, emptySide } from './signalRule.js'
  let { rule = $bindable(), items = [], numItems = [], label, disabled = false, testid } = $props()

  const all = $derived([...items, ...numItems.map((x) => ({ ...x, label: x.label + ' (number)' }))])
  const isNum = $derived(new Set(numItems.map((x) => String(x.value))))
  function pickKey(s, v) { s.key = v; s.cmp = isNum.has(v) ? (s.cmp ?? { op: '2', value: 0 }) : null }
</script>

{#snippet side(s, t, name)}
  <div class="side">
    <button type="button" class="not" aria-pressed={s.not} {disabled} title="Use the opposite: on while the signal is off" onclick={() => (s.not = !s.not)} data-testid={testid + '-not' + t}>NOT</button>
    <div class="pick"><Select label={name} hideLabel items={all} value={s.key} onchange={(v) => pickKey(s, v)} {disabled} data-testid={testid + t} /></div>
    {#if s.cmp}
      <div class="op"><Select label={name + ' comparison'} hideLabel items={OPS} bind:value={s.cmp.op} {disabled} /></div>
      <input class="nx-input val" type="number" aria-label={name + ' value'} bind:value={s.cmp.value} {disabled} data-testid={testid + '-val' + t} />
    {/if}
  </div>
{/snippet}

<div class="rule">
  {@render side(rule.a, '', label)}
  {#if rule.join}
    <div class="join">
      <Segmented label={label + ': how the two combine'} items={[{ value: 'or', label: 'OR' }, { value: 'and', label: 'AND' }]} bind:value={rule.join} size="sm" />
      <Button size="sm" variant="ghost" {disabled} onclick={() => { rule.join = ''; rule.b = emptySide() }}>Remove</Button>
    </div>
    {@render side(rule.b, '-b', label + ', second signal')}
  {:else if rule.a.key !== '0'}
    <div class="adds">
      <Button size="sm" variant="ghost" {disabled} onclick={() => (rule.join = 'or')} data-testid={testid + '-or'}>+ OR another</Button>
      <Button size="sm" variant="ghost" {disabled} onclick={() => (rule.join = 'and')}>+ AND another</Button>
    </div>
  {/if}
</div>

<style>
  .rule { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .side { display: flex; gap: 6px; align-items: center; min-width: 0; flex-wrap: wrap; }
  .pick { flex: 1 1 200px; min-width: 0; }
  .op { width: 130px; }
  .val { width: 96px; }
  .not { min-height: var(--target-min); padding: 0 10px; border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: transparent; color: var(--color-text-muted); font-weight: 700; font-size: var(--text-xs); }
  .not[aria-pressed='true'] { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-on-accent); }
  .join, .adds { display: flex; gap: 6px; align-items: center; }
</style>
