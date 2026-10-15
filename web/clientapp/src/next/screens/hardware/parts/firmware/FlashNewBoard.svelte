<script>
  // New or blank board over USB (DFU): scan, pick the .bin, flash. Needs the "I checked" tick first.
  import { Dialog, Button, Banner, Checkbox, Chip } from '../../../../ui/index.js'
  import { api, toast } from '../../../../lib/live.svelte.js'
  import { lastLine } from './firmwareLogic.js'
  let { open = $bindable(false), blocked = '', busyOther = false, onflashing } = $props()

  let scan = $state(null), scanning = $state(false), file = $state(null), sure = $state(false)
  let running = $state(false), pct = $state(0), phase = $state(''), result = $state(null)
  let input

  async function doScan() {
    scanning = true
    try { scan = await api.flashScan() } catch (e) { scan = { utilOk: false, devices: 0, raw: 'Scan failed: ' + (e?.message ?? e) } } finally { scanning = false }
  }
  function onFile(e) { file = e.target.files?.[0] ?? null; e.target.value = ''; result = null }
  async function flash() {
    if (!file || !sure || running) return
    running = true; result = null; pct = 0; phase = 'Starting'; onflashing?.(true)
    const poll = setInterval(async () => { try { const s = await api.flashStatus(); if (s.busy || s.percent) { pct = s.percent; phase = s.phase } } catch {} }, 400)
    try {
      const r = await api.flashBlank(await file.arrayBuffer())
      result = { ok: !!r.ok, text: lastLine(r.log) || (r.ok ? 'Done.' : 'Failed.'), log: r.log }
      if (r.ok) { pct = 100; toast('New board flashed.', 'info', 4000) }
    } catch (e) {
      result = { ok: false, text: `Link lost or the flash was cut off: ${e?.message ?? e}. A board in DFU stays in DFU: run it again.`, log: '' }
    } finally { clearInterval(poll); running = false; onflashing?.(false); sure = false }
  }
</script>

<Dialog bind:open title="Flash a new board" description="Over USB (DFU). A dingoPDM that already runs dingo firmware is put into DFU for you. A blank board needs BOOT0 held while it powers up. A CANBoard needs a probe once." width={640}>
  {#if blocked}<Banner tone="warn" title="Not available now" data-testid="newboard-blocked">{blocked}</Banner>{/if}
  <div class="row">
    <Button onclick={doScan} busy={scanning} disabled={!!blocked || running} data-testid="dfu-scan">Scan for a board in DFU</Button>
    {#if scan}
      {#if scan.devices > 0}<Chip tone="ok" symbol="●" data-testid="dfu-result">{scan.devices} board{scan.devices === 1 ? '' : 's'} in DFU, ready to flash</Chip>
      {:else if !scan.utilOk}<Chip tone="fault" symbol="■" data-testid="dfu-result">dfu-util not found</Chip>
      {:else}<Chip tone="warn" symbol="▲" data-testid="dfu-result">No board in DFU</Chip>{/if}
    {/if}
  </div>
  {#if scan && scan.devices === 0 && scan.utilOk}<p class="muted">Put the board in DFU (BOOT0 + reset) and install the WinUSB driver (Zadig) if Windows does not see it.</p>{/if}
  {#if scan?.raw}<pre class="raw mono" data-testid="dfu-raw">{scan.raw}</pre>{/if}

  <div class="row">
    <input bind:this={input} type="file" accept=".bin" class="sr-only" onchange={onFile} data-testid="newboard-file" aria-label="Firmware .bin file" />
    <Button onclick={() => input.click()} disabled={!!blocked || running}>Choose .bin file…</Button>
    {#if file}<span class="muted mono">{file.name} · {(file.size / 1024).toFixed(0)} KB</span>{/if}
  </div>
  <Checkbox bind:checked={sure} label="The board is powered and in DFU" hint="Keep it powered for about 20 seconds. The ROM bootloader can always be recovered with BOOT0." disabled={!!blocked || running} data-testid="newboard-sure" />

  {#if running || result}
    <div class="bar" role="progressbar" aria-label="Flash progress" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"><span style="width: {pct}%" class:bad={result && !result.ok}></span></div>
    <p role="status" data-testid="newboard-status">{running ? `${phase || 'Working'}… ${pct} %` : result.ok ? '✓ Done. ' + result.text : '■ Failed. ' + result.text}</p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)} disabled={running} data-testid="newboard-close">Close</Button>
    <Button variant="primary" busy={running} disabled={!!blocked || busyOther || !file || !sure} onclick={flash} data-testid="newboard-flash">Flash board</Button>
  {/snippet}
</Dialog>

<style>
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .raw { background: var(--color-bg); border: 1px solid var(--color-line); border-radius: var(--radius-md); padding: var(--space-2); font-size: var(--text-xs); max-height: 120px; overflow: auto; white-space: pre-wrap; margin: 0; }
  .bar { height: 10px; border-radius: 5px; background: var(--color-raised); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--color-on); transition: width 0.25s; }
  .bar span.bad { background: var(--color-fault); }
</style>
