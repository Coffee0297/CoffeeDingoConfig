<script>
  // Reusable Lua editor: textarea + starter templates + lightweight autocomplete
  // + a Compile button that syntax-checks the code (luaparse, Lua 5.3 grammar —
  // covers the bitwise ops the firmware's 5.5 uses).
  import luaparse from 'luaparse'
  let { value = $bindable(''), placeholder = '', minHeight = 160 } = $props()

  let compileMsg = $state(''), compileOk = $state(false)
  function compile() {
    try {
      luaparse.parse(value || '', { luaVersion: '5.3', comments: false })
      compileOk = true; compileMsg = '✓ syntax OK'
    } catch (e) {
      compileOk = false
      const line = e && e.line ? `line ${e.line}: ` : ''
      compileMsg = line + String(e && e.message ? e.message : e).replace(/^\[\d+:\d+\]\s*/, '')
    }
  }

  const TEMPLATES = [
    ['Follow an input', 'setLuaOut(0, readVar(1))  -- slot 0 follows var #1'],
    ['Blink while on', 'local t = Timer.new()\nfunction onTick()\n  if t:getElapsedSeconds() >= 1.0 then t:reset() end\n  setLuaOut(0, (t:getElapsedSeconds() < 0.5) and 1 or 0)\nend\nsetTickRate(50)'],
    ['Toggle on rising edge', 'local prev, state = 0, 0\nfunction onTick()\n  local v = readVar(1)\n  if v ~= 0 and prev == 0 then state = 1 - state end\n  prev = v\n  setLuaOut(0, state)\nend'],
    ['Threshold (var > value)', 'function onTick()\n  setLuaOut(0, (readVar(5) > 90) and 1 or 0)\nend'],
    ['CAN receive -> output', 'canRxAdd(0x18FEF100)\nfunction onCanRx(bus, id, dlc, data)\n  if id == 0x18FEF100 then\n    setLuaOut(0, (data[1] > 0) and 1 or 0)\n  end\nend'],
    ['CAN transmit (periodic)', 'local frame = { 0x00, 0x00, 0x00, 0x00 }\nfunction onTick()\n  frame[1] = math.floor(readVar(5)) & 0xFF\n  txCan(1, 0x200, false, frame)\nend\nsetTickRate(20)'],
    ['Blinker (tap = 3 pulses, hold = continuous)',
      '-- Tap the input: completes at least 3 output pulses. Hold it: keeps pulsing\n' +
      '-- until released, then stops immediately. Drive an output by setting its Rule\n' +
      '-- input to the Lua slot SLOT.\n' +
      'local INPUT = 1    -- trigger var-map index\n' +
      'local SLOT  = 0    -- Lua output slot to pulse\n' +
      'local HALF  = 350  -- ms; on-time = off-time (one pulse = 2*HALF)\n' +
      'local MIN   = 3    -- minimum pulses on a short tap\n' +
      'local t = Timer.new()\n' +
      'local active, on, pulses, prevIn = false, false, 0, false\n' +
      'function onTick()\n' +
      '  local inp = readVar(INPUT) ~= 0\n' +
      '  if inp and not prevIn then           -- rising edge: start a sequence\n' +
      '    active, on, pulses = true, true, 0\n' +
      '    t:reset()\n' +
      '  end\n' +
      '  prevIn = inp\n' +
      '  if active then\n' +
      '    if not inp and pulses >= MIN then   -- released after the minimum -> stop now\n' +
      '      active, on = false, false\n' +
      '    elseif t:getElapsedSeconds() >= HALF / 1000 then\n' +
      '      t:reset()\n' +
      '      if on then\n' +
      '        on = false                      -- on -> off\n' +
      '      else\n' +
      '        pulses = pulses + 1             -- a full pulse just finished\n' +
      '        if inp or pulses < MIN then\n' +
      '          on = true                     -- start another pulse\n' +
      '        else\n' +
      '          active = false                -- enough pulses and input off -> stop\n' +
      '        end\n' +
      '      end\n' +
      '    end\n' +
      '  end\n' +
      '  setLuaOut(SLOT, (active and on) and 1 or 0)\n' +
      'end\n' +
      'setTickRate(50)'],
    ['Blinker synced to a master clock (CAN)',
      '-- Left/right blinker that flashes IN SYNC with a clock pulse broadcast by the\n' +
      '-- main under-dash PDM (so every module blinks together). Tap = at least 3 flashes;\n' +
      '-- hold = flashes until released. Output follows the master clock, gated by the switch.\n' +
      '-- Drives this output via its Lua slot — set the Rule to the matching "Lua Out N".\n' +
      'local SWITCH = 5    -- var-map index of the blinker switch (a digital/CAN/keypad input)\n' +
      'local CLOCK  = 6    -- var-map index of the master clock (a CAN input from the main PDM)\n' +
      'local SLOT   = 0    -- this output\'s Lua slot (Lua Out 1 = slot 0)\n' +
      'local MIN    = 3    -- minimum flashes on a short tap\n' +
      'local active, pulses, prevSw, prevClk = false, 0, false, false\n' +
      'function onTick()\n' +
      '  local sw  = readVar(SWITCH) ~= 0\n' +
      '  local clk = readVar(CLOCK)  ~= 0\n' +
      '  if sw and not prevSw then active, pulses = true, 0 end   -- tap/hold starts a sequence\n' +
      '  prevSw = sw\n' +
      '  if active then\n' +
      '    if clk and not prevClk then pulses = pulses + 1 end    -- count master-clock pulses\n' +
      '    if not sw and pulses >= MIN then active = false end     -- released after >=3 -> stop\n' +
      '  end\n' +
      '  prevClk = clk\n' +
      '  setLuaOut(SLOT, (active and clk) and 1 or 0)              -- blink in lock-step with master\n' +
      'end\n' +
      'setTickRate(50)'],
    ['Volvo pump (CAN, full)', '-- pump "alive" message\ncanRxAdd(0x1B200002)\nlocal pumpAlive = Timer.new()\nfunction onCanRx(bus, id, dlc, data)\n  if id == 0x1B200002 then pumpAlive:reset() end\nend\nlocal d1 = { 0x00,0x00,0x22,0xe0,0x41,0x90,0x00,0x00 }\nlocal d2 = { 0xbb,0x00,0x3f,0xff,0x06,0xe0,0x00,0x00 }\nlocal slowCounter, slowRoll = 0, 0\nlocal roll = { 0x00,0x40,0x80,0xC0 }\nlocal speedVal = 1000\nfunction onTick()\n  if pumpAlive:getElapsedSeconds() < 1 then\n    if slowCounter == 0 then\n      slowRoll = (slowRoll + 1) & 3\n      d1[1] = roll[slowRoll + 1]\n      txCan(1, 0x1ae0092c, true, d1)\n      slowCounter = 30\n    end\n    slowCounter = slowCounter - 1\n    d2[7] = (speedVal >> 8) & 0xFF\n    d2[8] = speedVal & 0xFF\n    txCan(1, 0x02104136, true, d2)\n  end\nend\nsetTickRate(71)'],
  ]

  // dingoPDM API + common Lua keywords for autocomplete.
  const TOKENS = [
    'setLuaOut', 'readVar', 'txCan', 'canRxAdd', 'onCanRx', 'onTick', 'setTickRate',
    'Timer.new', 'getElapsedSeconds', 'reset',
    'function', 'local', 'end', 'then', 'else', 'elseif', 'return',
    'math.floor', 'math.abs', 'math.min', 'math.max',
  ]

  let ta
  let curWord = $state('')
  let suggestions = $derived(
    curWord.length >= 2
      ? TOKENS.filter((t) => t.toLowerCase().startsWith(curWord.toLowerCase()) && t.toLowerCase() !== curWord.toLowerCase()).slice(0, 8)
      : []
  )

  function refreshWord() {
    if (!ta) return
    const before = value.slice(0, ta.selectionStart)
    curWord = (before.match(/[A-Za-z_][\w.:]*$/) || [''])[0]
  }
  // Insert text via execCommand so the browser's native undo/redo (Ctrl-Z/Ctrl-Y) stack
  // stays intact. Fall back to manual splice if execCommand is unsupported/blocked (returns
  // false) so the editor still works (only the undo granularity is lost in that case).
  function spliceFallback(str) {
    const s = ta.selectionStart, e = ta.selectionEnd
    value = value.slice(0, s) + str + value.slice(e)
    const caret = s + str.length
    queueMicrotask(() => { ta.selectionStart = ta.selectionEnd = caret })
  }
  function insertText(str) {
    ta.focus()
    let ok = false
    try { ok = document.execCommand('insertText', false, str) } catch { ok = false }
    if (!ok) spliceFallback(str)
  }
  function insert(token) {
    const pos = ta.selectionStart
    ta.focus()
    ta.setSelectionRange(pos - curWord.length, pos)   // select the partial word
    let ok = false
    try { ok = document.execCommand('insertText', false, token) } catch { ok = false }
    if (!ok) spliceFallback(token)
    curWord = ''
  }
  function onKeydown(e) {
    if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); insert(suggestions[0]) }
    else if (e.key === 'Tab') { e.preventDefault(); insertText('  ') }              // indent
    else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // newline that keeps the current line's indentation (Enter + Shift+Enter)
      e.preventDefault()
      const pos = ta.selectionStart
      const lineStart = value.lastIndexOf('\n', pos - 1) + 1
      const indent = (value.slice(lineStart, pos).match(/^[ \t]*/) || [''])[0]
      insertText('\n' + indent)
    } else if (e.key === 'Escape') curWord = ''
  }
  function applyTemplate(e) {
    const i = e.target.value
    e.target.value = ''
    if (i === '') return
    const code = TEMPLATES[+i][1]
    ta.focus()
    if (value && value.trim()) { ta.setSelectionRange(value.length, value.length); insertText('\n\n' + code) }
    else { ta.setSelectionRange(0, value.length); insertText(code) }   // insertText has an execCommand fallback
  }
</script>

<div class="lua-ed">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
    <select onchange={applyTemplate} style="font-size:12px">
      <option value="">+ insert template…</option>
      {#each TEMPLATES as [name], i}<option value={i}>{name}</option>{/each}
    </select>
    <button class="btn ghost" style="padding:3px 10px;font-size:12px" onclick={compile}>Compile</button>
    {#if compileMsg}<span style="font-size:12px;font-weight:600;color:{compileOk ? 'var(--ok)' : 'var(--err)'}">{compileMsg}</span>{/if}
    <span class="hint" style="margin:0 0 0 auto;font-size:11px">Tab = accept · Ctrl-Z undo</span>
  </div>
  <textarea bind:this={ta} bind:value={value} {placeholder} spellcheck="false"
    oninput={refreshWord} onclick={refreshWord} onkeyup={refreshWord} onkeydown={onKeydown}
    style="width:100%;min-height:{minHeight}px;font-family:var(--mono);font-size:12.5px;line-height:1.5;border:1px solid var(--line-2);border-radius:8px;padding:10px;resize:vertical;background:var(--surface);color:var(--ink)"></textarea>
  {#if suggestions.length}
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px">
      {#each suggestions as s}
        <span class="idchip" style="cursor:pointer" onclick={() => insert(s)}>{s}</span>
      {/each}
    </div>
  {/if}
</div>
