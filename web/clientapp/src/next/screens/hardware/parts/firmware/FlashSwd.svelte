<script>
  // Flash over SWD with a debug probe (pyOCD on the PC): pick the board, look for the probe, pick the image, flash.
  // For what USB and CAN can't reach: a CANBoard's bootloader, a bricked board. Needs the "I checked" tick first.
  import { Dialog, Button, Banner, Checkbox, Chip, Select } from '../../../../ui/index.js'
  import { api, toast } from '../../../../lib/live.svelte.js'
  import { lastLine, boardOfFile, isFull, BOARDS as FILE_BOARDS } from './firmwareLogic.js'
  // files: the page's release files; the one for the picked board is used unless another file is chosen here
  let { open = $bindable(false), busyOther = false, onflashing, files = [] } = $props()

  const BOARDS = [{ value: 'canboard', label: 'CANBoard (STM32F303)', file: FILE_BOARDS.canboard }, { value: 'dingopdm', label: 'dingoPDM (STM32F446)', file: FILE_BOARDS.pdm }, { value: 'dingopdmmax', label: 'dingoPDM-Max (STM32F446)', file: FILE_BOARDS.pdmmax }]
  let board = $state('canboard'), scan = $state(null), scanning = $state(false), picked = $state(null), sure = $state(false)
  const EXT_ORDER = ['.srec', '.hex', '.elf', '.bin']
  const extRank = (n) => EXT_ORDER.findIndex((x) => n.toLowerCase().endsWith(x))
  // the release's image for this board: its _FULL_ one (bootloader + app) first, then a .srec before the others
  const pageFile = $derived(files.filter((f) => boardOfFile(f.name) === BOARDS.find((b) => b.value === board)?.file && extRank(f.name) >= 0)
    .sort((a, b) => isFull(b.name) - isFull(a.name) || extRank(a.name) - extRank(b.name))[0] ?? null)
  const file = $derived(picked ?? pageFile)
  let running = $state(false), pct = $state(0), phase = $state(''), result = $state(null)
  let input

  async function doScan() {
    scanning = true
    try { scan = await api.swdScan() } catch (e) { scan = { toolOk: false, probes: 0, raw: 'Scan failed: ' + (e?.message ?? e) } } finally { scanning = false }
  }
  function onFile(e) { picked = e.target.files?.[0] ?? picked; e.target.value = ''; result = null }
  async function flash() {
    if (!file || !sure || running) return
    running = true; result = null; pct = 0; phase = 'Starting'; onflashing?.(true)
    const poll = setInterval(async () => { try { const s = await api.flashStatus(); if (s.busy || s.percent) { pct = s.percent; phase = s.phase } } catch {} }, 400)
    try {
      const r = await api.flashSwd(board, file.name, await file.arrayBuffer())
      result = { ok: !!r.ok, text: lastLine(r.log) || (r.ok ? 'Done.' : 'Failed.'), log: r.log }
      if (r.ok) { pct = 100; toast('Flashed over SWD.', 'info', 4000) }
    } catch (e) {
      result = { ok: false, text: `The flash was cut off: ${e?.message ?? e}. Over SWD a board can always be flashed again.`, log: '' }
    } finally { clearInterval(poll); running = false; onflashing?.(false); sure = false }
  }
</script>

<Dialog bind:open title="Flash over SWD" description="With a debug probe (CMSIS-DAP, ST-Link, J-Link) on the board's SWD pins, through pyOCD on this PC. Writes only the flash the image covers: a bootloader leaves the app, an app leaves the bootloader." width={640}>
  <Select label="Board" items={BOARDS} bind:value={board} disabled={running} data-testid="swd-board" />
  <div class="row">
    <Button onclick={doScan} busy={scanning} disabled={running} data-testid="swd-scan">Look for the probe</Button>
    {#if scan}
      {#if scan.probes > 0}<Chip tone="ok" symbol="●" data-testid="swd-result">{scan.probes} probe{scan.probes === 1 ? '' : 's'} found</Chip>
      {:else if !scan.toolOk}<Chip tone="fault" symbol="■" data-testid="swd-result">pyOCD not found</Chip>
      {:else}<Chip tone="warn" symbol="▲" data-testid="swd-result">No probe</Chip>{/if}
    {/if}
  </div>
  {#if scan && !scan.toolOk}<p class="muted">Install pyOCD once: <span class="mono">pip install pyocd</span>, then look again.</p>{/if}
  {#if scan && scan.toolOk && scan.probes > 1}<Banner tone="warn" title="More than one probe">Unplug all but the one on this board: pyOCD would ask which to use.</Banner>{/if}
  {#if scan?.raw}<pre class="raw mono" data-testid="swd-raw">{scan.raw}</pre>{/if}

  <div class="row">
    <input bind:this={input} type="file" accept=".srec,.hex,.bin,.elf" class="sr-only" onchange={onFile} data-testid="swd-file" aria-label="Firmware or bootloader image" />
    <Button onclick={() => input.click()} disabled={running}>{pageFile ? 'Choose another image…' : 'Choose image…'}</Button>
    {#if file}<span class="muted mono" data-testid="swd-filename">{file.name} · {(file.size / 1024).toFixed(0)} KB{picked ? '' : ' · from the release above'}{isFull(file.name) ? ' · bootloader + app' : ' · app only'}</span>{/if}
    {#if picked && pageFile}<Button size="sm" onclick={() => (picked = null)} disabled={running}>Use the release's</Button>{/if}
  </div>
  {#if !file && files.length}<p class="muted">The release above has no image for this board. A CANBoard's bootloader is not in a release: choose it (canboard_blt.srec).</p>{/if}
  <Checkbox bind:checked={sure} label="The probe is on this board and the board is powered" hint="SWDIO, SWCLK and GND wired. The image is for the board picked above: pyOCD does not check what it writes." disabled={running} data-testid="swd-sure" />

  {#if running || result}
    <div class="bar" role="progressbar" aria-label="Flash progress" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"><span style="width: {pct}%" class:bad={result && !result.ok}></span></div>
    <p role="status" data-testid="swd-status">{running ? `${phase || 'Working'}… ${pct} %` : result.ok ? '✓ Done. ' + result.text : '■ Failed. ' + result.text}</p>
    {#if result?.log}<details open={!result.ok}><summary class="logsum">Show log</summary><pre class="raw mono" data-testid="swd-log">{result.log}</pre></details>{/if}
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)} disabled={running} data-testid="swd-close">Close</Button>
    <Button variant="primary" busy={running} disabled={busyOther || !file || !sure} onclick={flash} data-testid="swd-flash">Flash over SWD</Button>
  {/snippet}
</Dialog>

<style>
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .raw { background: var(--color-bg); border: 1px solid var(--color-line); border-radius: var(--radius-md); padding: var(--space-2); font-size: var(--text-xs); max-height: 160px; overflow: auto; white-space: pre-wrap; margin: 0; }
  .logsum { cursor: pointer; font-size: var(--text-xs); margin-bottom: var(--space-1); }
  .bar { height: 10px; border-radius: 5px; background: var(--color-raised); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--color-on); transition: width 0.25s; }
  .bar span.bad { background: var(--color-fault); }
</style>
