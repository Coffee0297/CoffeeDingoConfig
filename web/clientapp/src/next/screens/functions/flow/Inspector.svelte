<script>
  /**
   * Inspector for the selected block: what feeds it, its settings, where its outputs go, the plain
   * sentence. Edits are a draft until "Save" (one partial POST; it reaches the car with Apply, G2). Physical channels (outputs,
   * analog inputs) link to their Hardware screen for protection / calibration settings.
   */
  import { Button, Chip, Field, Select, Segmented, Checkbox, Banner } from '../../../ui/index.js'
  import { href } from '../../../router.svelte.js'
  import { FAM_COLOR, FAM_NAME, OPS, OP_WORDS, JOIN, TIMER_MODES, EDGES, MATH_OPS, isRelational, sourceOptions, canWire, hexId, parseId } from './model.js'
  import { sentenceFor } from './sentence.js'
  import { fmt } from './livevals.js'
  import { olderThan } from '../../hardware/parts/util.js'

  let { model, node, dev, lv, links = [], idMap = null, busy = false, onsave, onremove, onselect, onungroup, onopenlink } = $props()

  // ---- draft ----
  let draft = $state({})
  let hyst = $state(false)
  let base = $state({})
  let idText = $state('')
  let seededFor = ''
  const EDIT = {
    virtualinput: ['name', 'var0', 'var1', 'var2', 'not0', 'not1', 'not2', 'cond0', 'cond1', 'mode'],
    condition: ['name', 'input', 'operator', 'arg', 'argOff'],
    timer: ['name', 'input', 'mode', 'preset', 'edge'],
    flasher: ['name', 'input', 'onTime', 'offTime', 'single'],
    counter: ['name', 'incInput', 'decInput', 'resetInput', 'incEdge', 'decEdge', 'resetEdge', 'minCount', 'maxCount', 'wrapAround', 'holdToReset', 'resetTime'],
    table: ['name', 'xInput', 'yInput', 'xSize', 'ySize', 'xAxis', 'yAxis', 'cells'],
    canoutput: ['name', 'input', 'id', 'ide', 'startBit', 'bitLength', 'byteOrder', 'factor', 'offset', 'signed', 'interval'],
    caninput: ['name', 'id', 'ide', 'startBit', 'bitLength', 'factor', 'offset', 'operator', 'operand', 'mode', 'timeoutEnabled', 'timeout', 'timeoutValue'],
    math: ['name', 'inputA', 'inputB', 'op', 'constB', 'factor', 'offset'],
    canmsg: ['name', 'input', 'id', 'ide', 'dlc', 'data', 'mode', 'intervalMs'],
    comfortblink: ['name', 'leftInput', 'rightInput', 'clockInput', 'tapMs', 'blinks'],
    input: ['name', 'invert', 'mode', 'debounceTime'],
    digitaloutput: ['name', 'input'],
    output: ['name', 'input', 'dutyCycleInput'],
    sys: ['forceSleepInput', 'muteTxInput'],
  }
  const fields = $derived(EDIT[node?.kind] ?? [])
  function seed() {
    const r = node?.row ?? {}
    const b = {}
    for (const f of EDIT[node?.kind] ?? []) b[f] = node.kind === 'output' && f === 'input' ? r.inputVal ?? 0 : r[f] ?? (f === 'argOff' ? r.arg : f.startsWith('not') || ['ide', 'single', 'wrapAround', 'holdToReset', 'signed', 'invert', 'timeoutEnabled'].includes(f) ? false : 0)
    if (node?.kind === 'canmsg') b.data = Array.from({ length: 8 }, (_, k) => +(r.data?.[k] ?? 0))
    if (node?.kind === 'table') {
      // fixed-size arrays (8 / 8 / 64); a fresh slot is all zero, which is not an ascending axis
      b.xAxis = Array.from({ length: 8 }, (_, k) => +(r.xAxis?.[k] ?? 0)); b.yAxis = Array.from({ length: 8 }, (_, k) => +(r.yAxis?.[k] ?? 0))
      b.cells = Array.from({ length: 64 }, (_, k) => +(r.cells?.[k] ?? 0))
      b.xSize = Math.min(8, Math.max(1, +r.xSize || 2)); b.ySize = Math.min(8, Math.max(1, +r.ySize || 1))
    }
    base = JSON.parse(JSON.stringify(b))
    draft = JSON.parse(JSON.stringify(b))
    if (node?.kind === 'table') {
      if (draft.xAxis.every((v) => v === 0)) draft.xAxis = draft.xAxis.map((_, k) => Math.round((k * 100) / 7))
      if (draft.yAxis.every((v) => v === 0)) draft.yAxis = draft.yAxis.map((_, k) => Math.round((k * 100) / 7))
    }
    idText = hexId(r.id ?? 0)
    hyst = node?.kind === 'condition' && r.argOff != null && r.argOff !== r.arg
  }
  // reseed when another block is selected or the block changed on the module (after a save / reload)
  $effect.pre(() => {
    const key = node ? node.id + '|' + JSON.stringify(node.row) : ''
    if (key !== seededFor) { seededFor = key; seed() }
  })
  const dirtyBody = $derived.by(() => {
    const b = {}
    for (const f of fields) {
      let v = draft[f]
      if (f === 'argOff' && !hyst) v = draft.arg
      if (JSON.stringify(v) !== JSON.stringify(base[f])) b[f] = v
    }
    if (node?.kind === 'caninput' || node?.kind === 'canoutput' || node?.kind === 'canmsg') {
      const id = parseInt(String(idText).replace(/^0x/i, ''), 16)
      if (Number.isInteger(id) && id !== (node.row?.id ?? 0)) b.id = id
    }
    return b
  })
  const dirty = $derived(Object.keys(dirtyBody).length > 0)
  const idError = $derived.by(() => {
    if (node?.kind !== 'caninput' && node?.kind !== 'canoutput' && node?.kind !== 'canmsg') return ''
    const id = parseInt(String(idText).replace(/^0x/i, ''), 16)
    if (!Number.isInteger(id) || id < 0) return 'Use hex, e.g. 0x7A0'
    if (id > (draft.ide ? 0x1fffffff : 0x7ff)) return draft.ide ? 'Above the 29-bit maximum' : 'Above 0x7FF: choose 29-bit'
    return ''
  })
  const idOwners = $derived.by(() => {
    if (node?.kind !== 'canoutput' || idError || !idMap?.claimed) return null
    const id = parseInt(String(idText).replace(/^0x/i, ''), 16)
    const key = (draft.ide ? 'x' : '') + id.toString(16).toUpperCase()
    return (idMap.claimed[key] ?? []).filter((o) => !o.startsWith(dev?.name + ': CAN out'))
  })
  function validate() {
    const k = node.kind
    if (idError) return idError
    if (k === 'flasher' && (draft.onTime < 0 || draft.onTime > 5000 || draft.offTime < 0 || draft.offTime > 5000)) return 'On and off times must be 0 to 5000 ms.'
    if (k === 'timer' && (draft.preset < 0 || draft.preset > 3600000)) return 'Time must be 0 to 1 hour.'
    if ((k === 'canoutput' || k === 'caninput') && (draft.startBit < 0 || draft.startBit > 63 || draft.bitLength < 1 || draft.bitLength > 64 - draft.startBit)) return `Start bit 0–63 and length 1–${64 - (draft.startBit | 0)}.`
    if (k === 'sys' && (draft.forceSleepInput === 1 || draft.muteTxInput === 1)) return '"Always on" would keep the module asleep or muted for good. Pick a real signal.'
    if (k === 'table') {
      for (let i = 1; i < draft.xSize; i++) if (!(draft.xAxis[i] > draft.xAxis[i - 1])) return `X point ${i + 1} must be above X point ${i}.`
      if (draft.ySize > 1) for (let i = 1; i < draft.ySize; i++) if (!(draft.yAxis[i] > draft.yAxis[i - 1])) return `Y point ${i + 1} must be above Y point ${i}.`
    }
    if (k === 'counter' && draft.maxCount <= draft.minCount) return 'Max must be above min.'
    if (k === 'canmsg' && (draft.dlc < 0 || draft.dlc > 8)) return 'Length must be 0 to 8 bytes.'
    if (k === 'comfortblink' && (draft.tapMs < 100 || draft.tapMs > 5000)) return 'The tap time must be 0.1 to 5 s.'
    if (k === 'comfortblink' && (!Number.isInteger(draft.blinks) || draft.blinks < 1 || draft.blinks > 10)) return 'Blinks must be 1 to 10.'
    if (k === 'canmsg' && draft.mode === 0 && (draft.intervalMs < 10 || draft.intervalMs > 60000)) return 'Repeat every 10 to 60000 ms.'
    if (k === 'canmsg' && draft.data.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return 'Each byte must be 00 to FF.'
    return ''
  }
  let err = $state('')
  async function save() {
    err = validate()
    if (err) return
    const body = { ...dirtyBody }
    for (const k of Object.keys(body)) if (typeof base[k] === 'number' || ['input', 'var0', 'var1', 'var2', 'xInput', 'yInput', 'incInput', 'decInput', 'resetInput', 'inputA', 'inputB', 'leftInput', 'rightInput', 'clockInput'].includes(k)) body[k] = Number(body[k])
    await onsave?.(node.id, body, `${node.title}: ${Object.keys(body).join(', ')}`)
  }

  // ---- inputs ----
  const optsFor = (accepts) => sourceOptions(model, accepts, node?.id)
  const inputRows = $derived((node?.ins ?? []).filter((p) => fields.includes(p.id)))
  const typeOfIdx = (idx) => (model.byIdx.get(Number(idx))?.type === 'bool' ? 'bool' : 'num')
  const fromLabel = (idx) => optsFor('num').find((o) => o.value === String(idx))?.label ?? (idx ? '#' + idx : 'not connected')

  // ---- outputs: where they go ----
  const outsTo = $derived((node?.outs ?? []).map((p) => {
    const local = (model.consumers.get(p.idx) ?? []).map((c) => model.nodes.get(c.node)?.title).filter(Boolean)
    const remote = links.filter((l) => l.from.node === node.id && l.portIdx == null).map((l) => l.toName)
    return { ...p, to: [...local, ...remote.map((r) => r + ' (over CAN)')] }
  }))
  const remoteOut = $derived(links.filter((l) => l.from.node === node?.id))
  const sentence = $derived(node ? sentenceFor(model, node) : null)
  const sentenceText = $derived(sentence ? sentence.map((s) => s.t ?? s.label).join(' ').replace(/ ([.,)])/g, '$1').replace(/\( /g, '(') : '')
  const reads = $derived(sentenceText || ({ sys: "This module's own signals: always on, state, board temperature and battery voltage. Its force-sleep and mute-CAN inputs are set here.", input: 'A switch wired to this module. Settings for the pin are below.', analoginput: 'An analog input (sensor, switch ladder or rotary). Calibrate it on its Hardware screen.', lua: 'Values set by the Lua program on this module (Expert › Lua).', keypad: 'Buttons of a CAN keypad.' }[node?.kind] ?? 'A block on this module.'))
  const graphHref = $derived(node && dev ? href('live', 'plot', { signal: node.kind === 'output' ? `out:${dev.guid}:${node.n}` : `${dev.guid}|${node.title}` }) : '#')
  const hwHref = $derived.by(() => {
    if (!node || !dev) return null
    const { kind, n } = parseId(node.id)
    if (kind === 'output' || kind === 'digitaloutput') return href('hardware', 'module', dev.guid, 'output', String(n))
    if (kind === 'input' || kind === 'analoginput') return href('hardware', 'module', dev.guid, 'input', kind, String(n))
    return null
  })
  const segItems = (arr) => arr.map((l, i) => ({ value: String(i), label: l }))
  const toNum = (v) => (v === '' || v == null ? 0 : Number(v))
  const clampSize = (v) => Math.min(8, Math.max(1, Math.round(toNum(v)) || 1))
</script>

{#snippet seg(label, items, value, set, disabled)}
  <div class="sg"><span class="nx-label">{label}</span><Segmented {label} {items} {value} onchange={set} {disabled} size="sm" /></div>
{/snippet}

{#if !node}
  <div class="empty">
    <strong>Nothing selected</strong>
    <p class="muted">Click a block, or press Tab to walk the blocks and Enter to open one here.</p>
  </div>
{:else}
  <div class="ih">
    <span class="fam" style="color: {FAM_COLOR[node.fam]}">{node.tag ? node.tag + ' · ' : ''}{FAM_NAME[node.fam]} · {node.kindLabel.toUpperCase()} · SELECTED</span>
    <h2 class="nm">{node.title}</h2>
    <span class="muted sub">{node.sub}</span>
    <div class="chips">
      {#if node.remote}<Chip tone="on" symbol="◆">Travels over CAN</Chip>{/if}
      {#if node.incomplete?.length}<Chip tone="fault" symbol="▲" dashed>Unfinished</Chip>{/if}
      {#if node.disabledSource}<Chip tone="warn" symbol="○">Switched off</Chip>{/if}
    </div>
  </div>

  {#if node.group}
    <Banner tone="info" title={'Group of ' + node.group.members.length + ' blocks'}>
      {node.group.why} The blocks on the module are unchanged; this grouping is kept in this browser only (not in the project file yet).
      {#snippet actions()}<Button size="sm" onclick={() => onungroup?.(node.group, 'open')}>{node.group.expanded ? 'Close up' : 'Open inside'}</Button><Button size="sm" variant="ghost" onclick={() => onungroup?.(node.group, 'undo')}>Ungroup</Button>{/snippet}
    </Banner>
    <span class="sec">Inside</span>
    {#each node.group.members as m (m)}
      <button type="button" class="lnk" onclick={() => onselect?.(m, true)}>{model.nodes.get(m)?.title ?? m} <span class="muted">· {model.nodes.get(m)?.kindLabel}</span></button>
    {/each}
  {/if}

  {#if node.incomplete?.length}
    <Banner tone="fault" title="This block can't run yet">{node.incomplete.join('; ')}.</Banner>
  {/if}

  {#if node.remote}
    <div class="rem" role="note">
      <span>◆ Reads <strong>{node.remote}</strong> from the bus.</span>
      {#if node.remoteLink}<button type="button" class="lnk" onclick={() => onopenlink?.(node.remoteLink)}>Open {node.remoteLink.name} ›</button>{/if}
    </div>
  {/if}

  {#if !node.group}
    {#if fields.includes('name')}
      <Field label="Name" bind:value={() => draft.name ?? '', (v) => (draft.name = v)} />
    {/if}

    {#if node.kind === 'virtualinput'}
      <div class="two">
        {@render seg('First join', segItems(JOIN), String(draft.cond0 ?? 0), (v) => (draft.cond0 = Number(v)), false)}
        {@render seg('Second join', segItems(JOIN), String(draft.cond1 ?? 0), (v) => (draft.cond1 = Number(v)), !Number(draft.var2))}
      </div>
      {@render seg('Mode', [{ value: '0', label: 'Follows' }, { value: '1', label: 'Push on / push off' }], String(draft.mode ?? 0), (v) => (draft.mode = Number(v)), false)}
      <p class="hint">NOR here is the firmware's: on unless both are on (not A, or not B).</p>
    {/if}

    {#if inputRows.length}
      <span class="sec">Inputs</span>
      {#each inputRows as p (p.id)}
        {@const opts = optsFor(p.accepts)}
        <div class="inrow">
          <div class="ip">
            <Select label={p.label + (p.optional ? ' (optional)' : '')} items={opts.some((o) => o.value === String(draft[p.id] ?? 0)) ? opts : [...opts, { value: String(draft[p.id]), label: fromLabel(draft[p.id]) }]} bind:value={() => String(draft[p.id] ?? 0), (v) => (draft[p.id] = Number(v))} data-testid={'src-' + p.id} />
          </div>
          {#if node.kind === 'virtualinput'}
            <button type="button" class="not" aria-pressed={!!draft['not' + p.id.slice(3)]} aria-label={'NOT on ' + p.label} onclick={() => (draft['not' + p.id.slice(3)] = !draft['not' + p.id.slice(3)])}>NOT</button>
          {/if}
          <span class="iv mono" title="Live value">{fmt(lv.v[draft[p.id]])}</span>
        </div>
        {#if draft[p.id] && !canWire(typeOfIdx(draft[p.id]), p.accepts)}<p class="hint bad">▲ That is a number; an on/off input needs a Compare in between.</p>{/if}
      {/each}
    {/if}

    {#if node.kind === 'condition'}
      <span class="sec">Settings</span>
      <div class="two">
        <Select label="Is" items={OPS.map((o, i) => ({ value: String(i), label: o + '  ' + OP_WORDS[i] }))} bind:value={() => String(draft.operator ?? 0), (v) => (draft.operator = Number(v))} />
        <Field label="Value" type="number" step="any" bind:value={() => draft.arg ?? 0, (v) => (draft.arg = toNum(v))} />
      </div>
      {#if isRelational(draft.operator)}
        <Checkbox label="Separate off point (hysteresis)" hint="Stops it chattering right at the value" bind:checked={hyst} />
        {#if hyst}<Field label="Off again at" type="number" step="any" bind:value={() => draft.argOff ?? 0, (v) => (draft.argOff = toNum(v))} hint={'On past ' + draft.arg + ', off again past ' + draft.argOff + '.'} />{/if}
      {/if}
    {:else if node.kind === 'timer'}
      <span class="sec">Settings</span>
      {@render seg('Kind', [{ value: '0', label: 'On-delay' }, { value: '1', label: 'Keep on after' }, { value: '2', label: 'Pulse' }], String(draft.mode ?? 0), (v) => (draft.mode = Number(v)), false)}
      <div class="two">
        <Field label="Time" type="number" step="0.1" min="0" unit="s" bind:value={() => (draft.preset ?? 0) / 1000, (v) => (draft.preset = Math.round(toNum(v) * 1000))} />
        {@render seg('Active when input is', [{ value: '0', label: 'On' }, { value: '1', label: 'Off' }], String(draft.edge ?? 0), (v) => (draft.edge = Number(v)), false)}
      </div>
      {#if lv.sim}<p class="hint" role="status">Simulated time left: {Math.round((lv.left?.[node.id] ?? 0) / 100) / 10} s</p>{/if}
    {:else if node.kind === 'math'}
      <span class="sec">Settings</span>
      <Select label="Result" items={MATH_OPS.map((o, i) => ({ value: String(i), label: o.label }))} bind:value={() => String(draft.op ?? 0), (v) => (draft.op = Number(v))} />
      {#if !draft.inputB}<Field label="B (no B input connected)" type="number" step="any" bind:value={() => draft.constB ?? 0, (v) => (draft.constB = toNum(v))} />{/if}
      <div class="two">
        <Field label="Then × factor" type="number" step="any" bind:value={() => draft.factor ?? 1, (v) => (draft.factor = toNum(v))} />
        <Field label="+ Offset" type="number" step="any" bind:value={() => draft.offset ?? 0, (v) => (draft.offset = toNum(v))} />
      </div>
      <p class="hint">Dividing by 0 gives 0. Example: oil temperature − coolant temperature, or two fuel tank senders averaged.</p>
    {:else if node.kind === 'canmsg'}
      <span class="sec">Frame</span>
      <div class="two">
        <Field label="CAN ID (hex)" mono bind:value={idText} error={idError} />
        {@render seg('ID type', [{ value: 'false', label: '11-bit' }, { value: 'true', label: '29-bit' }], String(!!draft.ide), (v) => (draft.ide = v === 'true'), false)}
      </div>
      <Field label="Length" type="number" min="0" max="8" unit="bytes" bind:value={() => draft.dlc ?? 8, (v) => (draft.dlc = toNum(v))} />
      <div class="bytes" role="group" aria-label="Data bytes">
        {#each Array.from({ length: Math.max(0, Math.min(8, draft.dlc ?? 8)) }) as _, i (i)}
          <input class="nx-input mono cell" aria-label={'Byte ' + i} value={(draft.data?.[i] ?? 0).toString(16).toUpperCase().padStart(2, '0')}
            onchange={(e) => { const v = parseInt(e.currentTarget.value, 16); draft.data[i] = Number.isInteger(v) ? v : -1 }} />
        {/each}
      </div>
      {@render seg('Send', [{ value: '0', label: 'Repeat while on' }, { value: '1', label: 'Once each time' }], String(draft.mode ?? 0), (v) => (draft.mode = Number(v)), false)}
      {#if (draft.mode ?? 0) === 0}<Field label="Every" type="number" min="10" max="60000" unit="ms" bind:value={() => draft.intervalMs ?? 100, (v) => (draft.intervalMs = toNum(v))} />{/if}
      <p class="hint">Bytes in hex. The frame goes out on the module's bus exactly as typed, for example a command another ECU listens for.</p>
    {:else if node.kind === 'comfortblink'}
      <span class="sec">Settings</span>
      <div class="two">
        <Field label="A tap is shorter than" type="number" min="0.1" max="5" step="0.1" unit="s" bind:value={() => (draft.tapMs ?? 1000) / 1000, (v) => (draft.tapMs = Math.round(toNum(v) * 1000))} />
        <Field label="Blinks for a tap" type="number" min="1" max="10" step="1" bind:value={() => draft.blinks ?? 3, (v) => (draft.blinks = Math.round(toNum(v)))} />
      </div>
      <p class="hint">A tap of the lever blinks that many times, then stops. Held longer than the tap time it blinks until released. A tap the other way during a comfort blink cancels it. Use Left / Right as "indicator on" in place of the lever; blinks are counted on the indicator clock, so every module stops on the same blink.</p>
    {:else if node.kind === 'ignition'}
      <p class="hint">The ignition and start button are set up on their own page: mode, inputs, crank limits and which module is the main one.</p>
      <Button size="sm" href={href('power', 'ignition')}>Open ignition setup</Button>
    {:else if node.kind === 'flasher'}
      <span class="sec">Settings</span>
      <div class="two">
        <Field label="On" type="number" min="0" max="5000" unit="ms" bind:value={() => draft.onTime ?? 0, (v) => (draft.onTime = toNum(v))} />
        <Field label="Off" type="number" min="0" max="5000" unit="ms" bind:value={() => draft.offTime ?? 0, (v) => (draft.offTime = toNum(v))} />
      </div>
      <Checkbox label="Once per trigger (single shot)" bind:checked={() => !!draft.single, (v) => (draft.single = v)} />
    {:else if node.kind === 'counter'}
      <span class="sec">Settings</span>
      <div class="two">
        <Field label="Min" type="number" bind:value={() => draft.minCount ?? 0, (v) => (draft.minCount = toNum(v))} />
        <Field label="Max" type="number" bind:value={() => draft.maxCount ?? 0, (v) => (draft.maxCount = toNum(v))} />
      </div>
      <div class="three">
        <Select label="Up on" items={segItems(EDGES)} bind:value={() => String(draft.incEdge ?? 0), (v) => (draft.incEdge = Number(v))} />
        <Select label="Down on" items={segItems(EDGES)} bind:value={() => String(draft.decEdge ?? 0), (v) => (draft.decEdge = Number(v))} />
        <Select label="Reset on" items={segItems(EDGES)} bind:value={() => String(draft.resetEdge ?? 0), (v) => (draft.resetEdge = Number(v))} />
      </div>
      <Checkbox label="Wrap round past max" bind:checked={() => !!draft.wrapAround, (v) => (draft.wrapAround = v)} />
      <Checkbox label="Hold to reset" bind:checked={() => !!draft.holdToReset, (v) => (draft.holdToReset = v)} />
      {#if draft.holdToReset}<Field label="Hold for" type="number" unit="ms" bind:value={() => draft.resetTime ?? 0, (v) => (draft.resetTime = toNum(v))} />{/if}
    {:else if node.kind === 'table'}
      <span class="sec">Points</span>
      <div class="two">
        <Field label="X points (1–8)" type="number" min="1" max="8" bind:value={() => draft.xSize ?? 0, (v) => (draft.xSize = clampSize(v))} />
        <Field label="Y points (1 = curve)" type="number" min="1" max="8" bind:value={() => draft.ySize ?? 0, (v) => (draft.ySize = clampSize(v))} />
      </div>
      <div class="tgrid" style="grid-template-columns: 54px repeat({draft.xSize}, minmax(0, 1fr))">
        <span class="th muted">{draft.ySize > 1 ? 'Y \\ X' : 'X'}</span>
        {#each Array.from({ length: draft.xSize }) as _, c (c)}
          <input class="nx-input mono cell" type="number" step="any" aria-label={'X point ' + (c + 1)} bind:value={() => draft.xAxis?.[c] ?? 0, (v) => (draft.xAxis[c] = toNum(v))} />
        {/each}
        {#each Array.from({ length: draft.ySize }) as _, r (r)}
          {#if draft.ySize > 1}<input class="nx-input mono cell" type="number" step="any" aria-label={'Y point ' + (r + 1)} bind:value={() => draft.yAxis?.[r] ?? 0, (v) => (draft.yAxis[r] = toNum(v))} />{:else}<span class="th muted">out</span>{/if}
          {#each Array.from({ length: draft.xSize }) as _, c (c)}
            <input class="nx-input mono cell" type="number" step="any" aria-label={`Value at row ${r + 1}, column ${c + 1}`} bind:value={() => draft.cells?.[r * 8 + c] ?? 0, (v) => (draft.cells[r * 8 + c] = toNum(v))} />
          {/each}
        {/each}
      </div>
      <p class="hint">X points (and Y points) must increase. Between points the module interpolates; outside it holds the edge value.</p>
    {:else if node.kind === 'canoutput' || node.kind === 'caninput'}
      <span class="sec">Frame</span>
      <div class="two">
        <Field label="CAN ID (hex)" mono bind:value={idText} error={idError} />
        {@render seg('ID type', [{ value: 'false', label: '11-bit' }, { value: 'true', label: '29-bit' }], String(!!draft.ide), (v) => (draft.ide = v === 'true'), false)}
      </div>
      <div class="two">
        <Field label="Start bit" type="number" min="0" max="63" bind:value={() => draft.startBit ?? 0, (v) => (draft.startBit = toNum(v))} />
        <Field label="Length (bits)" type="number" min="1" max="64" bind:value={() => draft.bitLength ?? 0, (v) => (draft.bitLength = toNum(v))} />
      </div>
      <div class="two">
        <Field label="× Factor" type="number" step="any" bind:value={() => draft.factor ?? 0, (v) => (draft.factor = toNum(v))} />
        <Field label="+ Offset" type="number" step="any" bind:value={() => draft.offset ?? 0, (v) => (draft.offset = toNum(v))} />
      </div>
      {#if node.kind === 'canoutput'}
        <div class="two">
          {@render seg('Byte order', [{ value: '0', label: 'Little' }, { value: '1', label: 'Big' }], String(draft.byteOrder ?? 0), (v) => (draft.byteOrder = Number(v)), false)}
          <Field label="Every" type="number" min="0" unit="ms" bind:value={() => draft.interval ?? 0, (v) => (draft.interval = toNum(v))} />
        </div>
        {#if idOwners}
          <p class="hint" class:bad={idOwners.length} role="status">{idOwners.length ? '▲ ' + idText + ' is already sent by ' + idOwners.join(', ') + '. Two senders on one ID collide.' : '● ' + idText + ' is free (checked against every module and the CAN ID map).'}</p>
        {/if}
      {:else}
        <div class="two">
          <Select label="On when the value" items={OPS.map((o, i) => ({ value: String(i), label: o + '  ' + OP_WORDS[i] }))} bind:value={() => String(draft.operator ?? 0), (v) => (draft.operator = Number(v))} />
          <Field label="Than" type="number" step="any" bind:value={() => draft.operand ?? 0, (v) => (draft.operand = toNum(v))} />
        </div>
        <Checkbox label="Off when no frame arrives (timeout)" bind:checked={() => !!draft.timeoutEnabled, (v) => (draft.timeoutEnabled = v)} />
        {#if draft.timeoutEnabled}
          {@const oldFw = olderThan(dev?.version, [5, 6, 0])}
          <div class="two">
            <Field label="Timeout" type="number" unit="ms" bind:value={() => draft.timeout ?? 0, (v) => (draft.timeout = toNum(v))} />
            <Field label="Then the value is" type="number" step="any" disabled={oldFw} bind:value={() => draft.timeoutValue ?? 0, (v) => (draft.timeoutValue = toNum(v))}
              hint={oldFw ? `Reads 0: ${dev?.name} needs firmware 5.6 for another value.` : 'Used while the frame is missing.'} />
          </div>
        {/if}
      {/if}
    {:else if node.kind === 'input'}
      <span class="sec">Pin</span>
      <Checkbox label="Invert (on when the pin is low)" bind:checked={() => !!draft.invert, (v) => (draft.invert = v)} />
      {@render seg('Mode', [{ value: '0', label: 'Follows the switch' }, { value: '1', label: 'Push on / push off' }], String(draft.mode ?? 0), (v) => (draft.mode = Number(v)), false)}
      <Field label="Debounce" type="number" unit="ms" bind:value={() => draft.debounceTime ?? 0, (v) => (draft.debounceTime = toNum(v))} />
    {:else if node.kind === 'output'}
      <p class="hint">Current limit, inrush, retries and PWM are set on the output's own screen.</p>
    {/if}

    {#if err}<p class="hint bad" role="alert">■ {err}</p>{/if}
    {#if fields.length}
      <div class="act">
        <Button variant="primary" disabled={!dirty || busy} {busy} onclick={save} data-testid="insp-save">Save</Button>
        <Button variant="ghost" disabled={!dirty} onclick={seed}>Revert</Button>
      </div>
    {/if}
  {/if}

  {#if outsTo.length}
    <span class="sec">Outputs</span>
    {#each outsTo as o (o.id)}
      <div class="orow"><span class="ol">{o.label}</span><span class="muted mono to">{o.to.length ? o.to.join(', ') : '—'}</span><span class="pill" class:on={lv.v[o.idx] === true}>{fmt(lv.v[o.idx])}</span></div>
    {/each}
  {/if}
  {#if remoteOut.length}
    <span class="sec">Read by other modules (over CAN)</span>
    {#each remoteOut as l, i (i)}
      <button type="button" class="lnk" onclick={() => onopenlink?.({ guid: l.to.guid, node: l.to.node, name: l.toName })}>→ {l.toName} · {l.toTitle} ›</button>
    {/each}
  {/if}

  <div class="reads" role="note">{reads}</div>
  {#if lv.sim && lv.st[node.id]?.why}<div class="reads sim" role="status">Simulating: {lv.st[node.id].why}</div>{/if}

  <div class="act foot">
    {#if hwHref}<Button size="sm" href={hwHref}>Open in Hardware</Button>{/if}
    <Button size="sm" variant="ghost" href={graphHref}>Graph it</Button>
    <span class="grow"></span>
    {#if node.deletable}<Button size="sm" variant="danger" onclick={() => onremove?.(node.id)} data-testid="insp-remove">Remove</Button>{/if}
  </div>
{/if}

<style>
  .bytes { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: var(--space-1); }
  .empty { display: flex; flex-direction: column; gap: 6px; padding: var(--space-4); border: 1px dashed var(--color-line-strong); border-radius: var(--radius-md); }
  .ih { display: flex; flex-direction: column; gap: 2px; }
  .fam { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
  .nm { font-size: 22px; font-weight: 700; overflow-wrap: anywhere; }
  .sub { font-size: var(--text-xs); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .sec { font-size: 12px; font-weight: 600; color: var(--color-text-muted); margin-top: 4px; }
  .sg { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .tgrid { display: grid; gap: 4px; align-items: center; }
  .cell { min-height: 36px; padding: 0 6px; font-size: 12px; }
  .th { font-size: 11px; font-weight: 700; text-align: center; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); align-items: end; }
  .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-2); }
  .inrow { display: flex; align-items: flex-end; gap: 6px; }
  .ip { flex: 1 1 auto; min-width: 0; }
  .iv { min-width: 42px; text-align: right; font-size: 12px; color: var(--color-text-muted); padding-bottom: 14px; }
  .not { height: 44px; padding: 0 8px; border-radius: var(--radius-md); border: 1px solid var(--color-block-logic); background: transparent; color: var(--color-block-logic); font-weight: 700; font-size: 12px; }
  .not[aria-pressed='true'] { background: var(--color-block-logic); color: var(--color-bg); }
  .hint { font-size: var(--text-xs); color: var(--color-text-muted); }
  .hint.bad { color: var(--color-fault); font-weight: 600; }
  .orow { display: flex; align-items: center; gap: 8px; min-height: 34px; border-bottom: 1px solid var(--color-line); }
  .ol { flex: none; }
  .to { flex: 1 1 auto; min-width: 0; font-size: 12px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { font-family: var(--font-mono); font-size: 12px; padding: 1px 6px; border-radius: 999px; background: var(--color-raised); color: var(--color-text-muted); }
  .pill.on { background: var(--color-on-soft); color: var(--color-on); }
  .reads { padding: 12px; border-radius: var(--radius-md); background: var(--color-raised); color: var(--color-text-muted); line-height: 1.5; }
  .reads.sim { color: var(--color-warn); background: var(--color-warn-soft); }
  .rem { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--color-on); }
  .lnk { text-align: left; background: transparent; border: 0; padding: 6px 0; min-height: 32px; color: var(--color-accent); font-weight: 600; }
  .lnk:hover { text-decoration: underline; }
  .act { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
  .foot { margin-top: auto; padding-top: var(--space-3); border-top: 1px solid var(--color-line); }
  .grow { flex: 1 1 auto; }
</style>
