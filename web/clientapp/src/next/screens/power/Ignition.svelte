<script>
  // Ignition modes + start button. Built as designed; every control is disabled until firmware 5.6 has the
  // Ignition block (gap G13). Navigation (Cancel, Next) works.
  import { Page, PageHeader, Banner, Button, Card, FwBadge, Select, Checkbox } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { live } from '../../lib/live.svelte.js'
  let props = $props()

  const MODES = [
    { value: 'switch', name: 'Ignition switch + start button', what: 'A switch (or key with only ON) powers the ignition. The button only cranks, and only while the ignition is on.' },
    { value: 'button', name: 'Start button only', what: 'One button does both. Pressed alone it turns the ignition on or off; with the clutch or brake held it also cranks.' },
    { value: 'key', name: 'Key switch', what: 'The key holds ON; START is a spring-back position that cranks. Everything in one switch.' },
  ]
  let mode = $state('switch'), hold = $state('hold')
  const FIELDS = [
    { k: 'Ignition switch', hint: 'held on while the ignition should be on' },
    { k: 'Start button', hint: 'a pin, a keypad button, or a bit in a CAN frame' },
    { k: 'Also required to crank', hint: 'any of these must be true · optional' },
    { k: 'Engine running', hint: 'stops the starter; no cranking while it runs' },
    { k: 'Max crank time', hint: 'then release and press again', mono: true },
    { k: 'Start button light', hint: 'lit when ready to start: ignition on, engine not running' },
    { k: 'Main module', hint: 'reads the switch and button, tells the others' },
  ]
  const RULES = {
    switch: [
      ['Ignition switch on', 'Ignition on: ECU power, accessories, dash. The button light comes on: ready to start.'],
      ['Switch on · clutch + press and hold', 'Cranks while the button is held, stops when the engine runs or after the max crank time.'],
      ['Engine running', 'Button light off. A press does nothing: the button never stops the engine in this mode.'],
      ['Ignition switch off', 'Engine off, dash power-down, quiet bus, all modules sleep.'],
    ],
    button: [
      ['Press, engine off', 'Ignition on. Press again to turn it off.'],
      ['Clutch or brake held + press', 'Cranks, stops when the engine runs or after the max crank time.'],
      ['Press while running', 'Turns everything off and starts the power-down.'],
    ],
    key: [
      ['Key at ON', 'Ignition on: ECU power, accessories, dash.'],
      ['Key at START', 'Cranks, stops when the engine runs or after the max crank time.'],
      ['Key off', 'Engine off, dash power-down, quiet bus, all modules sleep.'],
    ],
  }
  const oldest = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')).map((d) => d.version).filter(Boolean)[0] ?? 'unknown')
</script>

<Page>
  <PageHeader crumbs={[{ label: 'Power & ignition', href: href('power') }, { label: 'Ignition setup' }]} title="How is the car started?">
    {#snippet tag()}<FwBadge version="5.6" />{/snippet}
  </PageHeader>

  <Banner tone="warn" title="Needs firmware 5.6" data-testid="ignition-banner">
    The modules run {oldest} and have no Ignition block yet, so nothing on this page can be saved or written (gap G13). It is shown as designed. The power-down order and sleep settings already work.
  </Banner>

  <fieldset class="modes" disabled aria-label="How is the car started?">
    <legend class="sr-only">Start mode</legend>
    {#each MODES as m (m.value)}
      <label class="mode" class:sel={mode === m.value}>
        <input type="radio" name="mode" value={m.value} bind:group={mode} disabled />
        <span><strong>{m.name}</strong><span class="muted">{m.what}</span></span>
      </label>
    {/each}
  </fieldset>

  <Card title="Signals and limits">
    {#snippet tag()}<FwBadge version="5.6" />{/snippet}
    <div class="fields">
      {#each FIELDS as f (f.k)}
        <div class="field">
          <div><strong>{f.k}</strong><div class="muted hint">{f.hint}</div></div>
          <div class="val"><Select label={f.k} hideLabel items={[]} placeholder="Not set" disabled /><span class="muted live mono">live: unknown</span></div>
        </div>
      {/each}
    </div>
  </Card>

  <Card title="What the switch and button do">
    {#snippet tag()}<FwBadge version="5.6" />{/snippet}
    <fieldset class="hold" disabled>
      <legend class="nx-label">Cranking</legend>
      <label><input type="radio" name="hold" value="hold" bind:group={hold} disabled /> Crank while the button is held</label>
      <label><input type="radio" name="hold" value="press" bind:group={hold} disabled /> One press cranks until it runs</label>
    </fieldset>
    <ul class="rules" data-testid="ignition-rules">
      {#each RULES[mode] as [when, then] (when)}
        <li><strong>{when}</strong><span class="muted">{then}</span></li>
      {/each}
    </ul>
    <Checkbox checked label="No cranking with the engine running" hint="protects the starter if the button is pressed by mistake" disabled />
    <p class="muted">In "Start button only" mode the button also stops the engine, and a "hold to stop while moving" safety option appears here.</p>
  </Card>

  <div class="foot">
    <Button href={href('power')} data-testid="ignition-cancel">Cancel</Button>
    <span class="grow"></span>
    <Button disabled title="Needs firmware 5.6: the simulator follows the firmware state machine">Simulate the sequence</Button>
    <Button variant="primary" href={href('power', 'roles')} data-testid="ignition-next">Next: output roles</Button>
  </div>
</Page>

<style>
  .modes { border: 0; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-3); }
  .mode { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-4); border: 2px dashed var(--color-line-strong); border-radius: var(--radius-lg); background: var(--color-surface); opacity: 0.85; }
  .mode.sel { border-color: var(--color-text-muted); background: var(--color-raised); }
  .mode span { display: flex; flex-direction: column; gap: 4px; }
  .mode input { margin-top: 4px; width: 20px; height: 20px; }
  .fields { display: flex; flex-direction: column; }
  .field { display: grid; grid-template-columns: minmax(200px, 1fr) minmax(260px, 1.3fr); gap: var(--space-4); align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); }
  .hint { font-size: var(--text-xs); }
  .val { display: flex; align-items: center; gap: var(--space-3); }
  .val :global(.f) { flex: 1 1 auto; }
  .live { font-size: var(--text-xs); white-space: nowrap; }
  .hold { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .rules { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--space-2); }
  .rules li { display: grid; grid-template-columns: minmax(180px, 0.6fr) minmax(0, 1.4fr); gap: var(--space-4); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); }
  .foot { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }
</style>
