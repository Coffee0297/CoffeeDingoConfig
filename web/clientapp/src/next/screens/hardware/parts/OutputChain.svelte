<script>
  // "What drives it": the chain of blocks behind each port of this output, the driving-input picker,
  // and the Compare / Combine builders. The picker edits the form (saved with the page's Save);
  // a builder writes its new block to a free slot at once, then points the form at it.
  import { untrack } from 'svelte'
  import { Card, Button, Select, Switch, Dialog, Field, Checkbox, Chip, FwBadge, Empty } from '../../../ui/index.js'
  import { api, mutate, toast } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { BLOCK, walkChain, funcArray, lacks, isUpstream } from './util.js'
  import { remoteItems, resolveRemote, isRemoteKey } from '../../../lib/remote.js'

  let { guid, dev, f = $bindable(), feed, connected = false, raw = null } = $props()
  let showRaw = $state(false)

  let varmap = $state([]), funcs = $state(null), bools = $state([]), nums = $state([]), loadErr = $state(''), loaded = $state(false)
  async function load() {
    try {
      const [vm, fx, b, fl, it] = await Promise.all([api.inputs(guid), api.functions(guid), api.inputs(guid, 'bool'), api.inputs(guid, 'float'), api.inputs(guid, 'int')])
      varmap = vm ?? []; funcs = fx; bools = b ?? []; nums = [...(fl ?? []), ...(it ?? [])]; loadErr = ''
    } catch (e) { loadErr = e?.message ?? String(e) } finally { loaded = true }
  }
  $effect(() => { guid; load() })
  // signals on other modules and ECUs; a pick claims a CAN input on this module (staged like any edit)
  let rBool = $state([]), rNum = $state([])
  $effect(() => {
    const g = guid
    let alive = true
    untrack(() => Promise.all([remoteItems(g, 'bool'), remoteItems(g, 'num')])).then(([b, n]) => { if (alive) { rBool = b; rNum = n } }).catch(() => {})   // untracked: reads the polled device list
    return () => { alive = false }
  })

  const lanes = $derived.by(() => {
    const L = [{ port: 'On', idx: f.input, key: 'input' }]
    if (f.pwmEnabled && f.variableDutyCycle) L.push({ port: 'Duty cycle', idx: f.dutyCycleInput, key: 'duty' })
    if (f.pwmEnabled && f.variableFreq) L.push({ port: 'Frequency', idx: f.freqInput, key: 'freq' })
    return L.map((l) => ({ ...l, blocks: walkChain(l.idx, varmap, funcs) }))
  })

  const SIG_KIND = { input: 'Digital input', caninput: 'CAN input', condition: 'Condition', virtualinput: 'Virtual input', flasher: 'Flasher', timer: 'Timer', counter: 'Counter', table: 'Table', analoginput: 'Analog input' }
  function liveText(b) {
    const k = SIG_KIND[b.kind]
    const s = k && feed?.get(k, b.name)
    if (!s) return connected ? '' : 'no live value'
    return k === 'Analog input' ? s.value + ' mV' : s.value
  }
  function liveOn(b) { const k = SIG_KIND[b.kind]; return !!(k && feed?.get(k, b.name)?.on) }
  function blockHref(b) {
    if (['input', 'caninput', 'analoginput'].includes(b.kind)) return href('hardware', 'module', guid, 'input', b.kind, b.number)
    return href('functions', 'flow', guid)
  }

  const driverItems = $derived.by(() => {
    const items = [{ value: '0', label: 'Nothing (stays off)' }, ...bools.filter((v) => v.index !== 0).map((v) => ({ value: String(v.index), label: v.name }))]
    const cur = Number(f.input) || 0
    if (cur && !items.some((i) => i.value === String(cur))) items.push({ value: String(cur), label: varmap.find((v) => v.index === cur)?.name ?? '#' + cur })
    return [...items, ...rBool]
  })
  let driverVal = $state('0'), linking = $state(false)
  $effect(() => { driverVal = String(f.input ?? 0) })
  async function pickDriver(v) {
    let idx = Number(v)
    if (isRemoteKey(v)) {
      linking = true
      try { idx = await resolveRemote(guid, v, 'bool'); await load() } catch (e) { toast(e?.message ?? String(e), 'error', 8000); driverVal = String(f.input ?? 0); return } finally { linking = false }
    }
    f.input = idx; if (idx && !f.enabled) { f.enabled = true; toast('Output turned on, because you gave it a rule.', 'info', 3000) } enableSource(idx)
  }

  // A source that is switched off would drive nothing: switch it on (what the old editor did).
  async function enableSource(idx) {
    const v = varmap.find((x) => x.index === idx)
    if (!v) return
    const fn = funcArray(funcs, v.kind).find((x) => x.number === v.number)
    if (fn && fn.enabled === false) {
      const r = await mutate(() => api.setFunction(guid, v.kind, fn.number, { enabled: true }), `Turned on "${fn.name}", it was off`)
      if (r) { fn.enabled = true; await load() }
    }
  }

  // ---- builders ----
  const OPS = ['=', 'is not', 'is above', 'is below', 'is at least', 'is at most', 'has bits', 'lacks bits'].map((label, i) => ({ value: String(i), label }))
  const JOIN = [{ value: '0', label: 'AND' }, { value: '1', label: 'OR' }, { value: '2', label: 'NOR' }]
  let dlg = $state(null)   // null | 'compare' | 'combine'
  let busy = $state(false), bErr = $state('')
  let cmp = $state({ name: '', input: '0', operator: '2', arg: 0, hyst: false, argOff: 0 })
  let comb = $state({ name: '', mode: '0', n0: false, v0: '0', c0: '0', n1: false, v1: '0', c1: '0', n2: false, v2: '0' })
  function open(kind) { bErr = ''; dlg = kind; if (kind === 'compare') cmp = { name: '', input: '0', operator: '2', arg: 0, hyst: false, argOff: 0 }; else comb = { name: '', mode: '0', n0: false, v0: '0', c0: '0', n1: false, v1: '0', c1: '0', n2: false, v2: '0' } }
  const numItems = $derived([{ value: '0', label: 'Choose a value' }, ...nums.filter((v) => v.index !== 0).map((v) => ({ value: String(v.index), label: v.name })), ...rNum])
  const boolItems = $derived([{ value: '0', label: 'Not used' }, ...bools.filter((v) => v.index !== 0).map((v) => ({ value: String(v.index), label: v.name })), ...rBool])

  async function freeSlot(arr) {
    const fx = await api.functions(guid)
    return (fx?.[arr] ?? []).find((x) => x.enabled === false) ?? null
  }
  async function bind(kind, number, name, written) {
    const vm = await api.inputs(guid, 'bool')
    const v = vm.find((x) => x.kind === kind && x.number === number)
    await load()
    if (v) { f.input = v.index; if (!f.enabled) f.enabled = true }
    dlg = null
    toast(v ? `"${name}" now drives this output. Save to keep.` : `Built "${name}" but could not find its signal. Pick it by hand.`, v ? 'ok' : 'info', 5000)
  }
  async function createCompare() {
    bErr = ''
    if (cmp.input === '0') { bErr = 'Pick the value to compare.'; return }
    busy = true
    try {
      const slot = await freeSlot('conditions')
      if (!slot) { bErr = 'No free compare blocks on this module. Free one in the flow builder.'; return }
      const name = cmp.name.trim() || `condition${slot.number}`
      const arg = Number(cmp.arg)
      const input = await resolveRemote(guid, cmp.input, 'num')
      const r = await api.setFunction(guid, 'condition', slot.number, { enabled: true, name, input, operator: Number(cmp.operator), arg, argOff: cmp.hyst ? Number(cmp.argOff) : arg })
      await bind('condition', slot.number, name, !!r?.written)
    } catch (e) { bErr = e?.message ?? String(e) } finally { busy = false }
  }
  async function createCombine() {
    bErr = ''
    if (comb.v0 === '0' && comb.v1 === '0' && comb.v2 === '0') { bErr = 'Pick at least one signal.'; return }
    busy = true
    try {
      const slot = await freeSlot('virtualInputs')
      if (!slot) { bErr = 'No free combine blocks on this module. Free one in the flow builder.'; return }
      const name = comb.name.trim() || `virtualInput${slot.number}`
      const done = {}, at = async (v) => (done[v] ??= await resolveRemote(guid, v, 'bool'))   // one CAN input per distinct remote pick
      const [var0, var1, var2] = [await at(comb.v0), await at(comb.v1), await at(comb.v2)]
      const r = await api.setFunction(guid, 'virtualinput', slot.number, { enabled: true, name, mode: Number(comb.mode),
        not0: comb.n0, var0, cond0: Number(comb.c0), not1: comb.n1, var1, cond1: Number(comb.c1), not2: comb.n2, var2 })
      await bind('virtualinput', slot.number, name, !!r?.written)
    } catch (e) { bErr = e?.message ?? String(e) } finally { busy = false }
  }
  const flowHref = $derived(href('functions', 'flow', guid))
</script>

<Card title="What drives it" subtitle="each port of the output, as a chain of blocks" aria-label="Output builder">
  {#snippet actions()}
    <Switch bind:checked={f.enabled} label="Output enabled" />
  {/snippet}

  {#if loadErr}
    <p class="err" role="alert">■ Could not read this module's signals: {loadErr}</p>
  {:else if !loaded}
    <p class="muted" role="status">Reading signals…</p>
  {:else}
    {#each lanes as l (l.key)}
      <div class="lane" data-testid={'lane-' + l.key}>
        {#if !l.blocks.length}
          <span class="empty">{l.idx ? 'Source #' + l.idx + ' is not in the signal list.' : l.key === 'input' ? 'Nothing drives this output, so it stays off.' : 'No signal chosen yet.'}</span>
        {/if}
        {#each l.blocks as b (b.index)}
          <a class="blk" href={blockHref(b)} style="--fam: {(BLOCK[b.kind] ?? BLOCK.sys).fam}" class:live={liveOn(b)}>
            <span class="k">{(BLOCK[b.kind] ?? BLOCK.sys).label}</span>
            <span class="n">{b.name}</span>
            <span class="v mono">{liveText(b)}{#if b.also.length} · also {b.also.join(', ')}{/if}</span>
          </a>
          <span class="wire" aria-hidden="true"></span>
        {/each}
        <span class="blk this"><span class="k">THIS OUTPUT</span><span class="n">{l.port}</span></span>
      </div>
    {/each}

    <div class="pick">
      <Select label="Change what turns it on" items={driverItems} bind:value={driverVal} onchange={pickDriver} disabled={linking} data-testid="driver-select" />
    </div>

    <div class="chips">
      <span class="muted">Add to a chain:</span>
      <Button size="sm" onclick={() => open('compare')}>+ Compare</Button>
      <Button size="sm" onclick={() => open('combine')}>+ Combine</Button>
      {#if lacks(dev, [5, 6, 0], 0x1C00)}<Button size="sm" disabled title="Needs firmware 5.6">+ Math</Button><FwBadge upstream={isUpstream(dev)} />
      {:else}<Button size="sm" href={flowHref} title="Build this in the flow builder">+ Math</Button>{/if}
      {#each ['On-delay', 'Keep on after', 'Flasher', 'Table', 'Signal', 'Lua'] as c (c)}
        <Button size="sm" href={flowHref} title="Build this in the flow builder">+ {c}</Button>
      {/each}
    </div>
  {/if}

  <div class="acts">
    <Button href={flowHref}>Open in flow builder</Button>
    {#if lacks(dev, [5, 6, 0], 0x1E00)}<Button disabled title="Output roles need firmware 5.6">Use a role instead…</Button><FwBadge upstream={isUpstream(dev)} />
    {:else}<Button href={href('power', 'roles')}>Use a role instead…</Button>{/if}
    <Button variant="ghost" aria-pressed={showRaw} onclick={() => (showRaw = !showRaw)} data-testid="show-raw">{showRaw ? 'Hide raw' : 'Show raw'}</Button>
  </div>
  {#if showRaw}
    <pre class="raw mono" aria-label="Raw output settings">{JSON.stringify(raw, null, 2)}</pre>
  {/if}
</Card>

<Dialog open={dlg === 'compare'} title="New compare block" description="Turns a number into on / off, then makes it drive this output." onclose={() => (dlg = null)}>
  <div class="form">
    <Field label="Name (optional)" bind:value={cmp.name} placeholder="Engine hot" />
    <Select label="Value to compare" items={numItems} bind:value={cmp.input} />
    <div class="two">
      <Select label="It is on when the value" items={OPS} bind:value={cmp.operator} />
      <Field label="This number" type="number" bind:value={cmp.arg} />
    </div>
    {#if ['2', '3', '4', '5'].includes(cmp.operator)}
      <Checkbox bind:checked={cmp.hyst} label="Turn off at a different number" hint="Stops flicker around the limit." />
      {#if cmp.hyst}<Field label="Turn off at" type="number" bind:value={cmp.argOff} />{/if}
    {/if}
    {#if bErr}<p class="err" role="alert">■ {bErr}</p>{/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (dlg = null)}>Cancel</Button>
    <Button variant="primary" {busy} onclick={createCompare} data-testid="create-compare">Create and use</Button>
  {/snippet}
</Dialog>

<Dialog open={dlg === 'combine'} title="New combine block" description="On when up to three signals agree. Makes it drive this output." onclose={() => (dlg = null)}>
  <div class="form">
    <div class="two">
      <Field label="Name (optional)" bind:value={comb.name} placeholder="Lights and door" />
      <Select label="Behaviour" items={[{ value: '0', label: 'Follows the signals' }, { value: '1', label: 'Latches' }]} bind:value={comb.mode} />
    </div>
    <Select label="Signal 1" items={boolItems} bind:value={comb.v0} />
    <Checkbox bind:checked={comb.n0} label="Not signal 1" />
    <Select label="Join with signal 2" items={JOIN} bind:value={comb.c0} />
    <Select label="Signal 2" items={boolItems} bind:value={comb.v1} />
    <Checkbox bind:checked={comb.n1} label="Not signal 2" />
    <Select label="Join with signal 3" items={JOIN} bind:value={comb.c1} />
    <Select label="Signal 3" items={boolItems} bind:value={comb.v2} />
    <Checkbox bind:checked={comb.n2} label="Not signal 3" />
    {#if bErr}<p class="err" role="alert">■ {bErr}</p>{/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (dlg = null)}>Cancel</Button>
    <Button variant="primary" {busy} onclick={createCombine} data-testid="create-combine">Create and use</Button>
  {/snippet}
</Dialog>

<style>
  .lane { display: flex; align-items: center; flex-wrap: wrap; gap: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); row-gap: var(--space-2); }
  .blk { display: flex; flex-direction: column; gap: 2px; min-width: 120px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); border: 2px solid var(--color-line-strong); background: var(--color-surface); text-decoration: none; color: var(--color-text); }
  .blk.live { border-color: var(--color-on); }
  .blk .k { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--fam, var(--color-block-output)); }
  .blk .n { font-weight: 600; font-size: var(--text-sm); }
  .blk .v { font-size: var(--text-xs); color: var(--color-text-muted); }
  .blk.live .v { color: var(--color-on); }
  .blk.this { border-style: dashed; border-color: var(--color-block-output); --fam: var(--color-block-output); }
  .wire { flex: none; width: 22px; height: 3px; background: var(--color-line-strong); }
  .empty { color: var(--color-text-muted); margin-right: var(--space-3); }
  .pick { max-width: 420px; }
  .chips, .acts { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
  .raw { margin: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); font-size: var(--text-xs); overflow: auto; max-height: 260px; }
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .err { color: var(--color-fault); font-weight: 600; }
</style>
