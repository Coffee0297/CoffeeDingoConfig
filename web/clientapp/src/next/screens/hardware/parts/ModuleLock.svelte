<script>
  // Config lock of one module (upstream dingoFW feat/config-lock, 0x0200), in the module's Settings tab: the state
  // (locked + the installer's contact text), Unlock, set / remove the password and the contact text, Factory reset.
  // Shown only when the module's firmware has the lock (dev.lock from the backend; null on fork 5.x and on modules without it).
  import { Button, Banner, Field } from '../../../ui/index.js'
  import Confirm from '../../../shell/parts/Confirm.svelte'
  import { live, api, toast, device, project } from '../../../lib/live.svelte.js'
  import { postAction, waitRead } from '../../../shell/parts/act.js'
  import { parsePassword, contactProblem, lockSummary } from './lock.js'

  let { guid } = $props()
  const d = $derived(device(guid))
  const sum = $derived(lockSummary(d))
  const offline = $derived(!d ? '' : !live.connected ? 'Not connected.' : !d.connected ? `${d.name} is not answering on the bus.` : '')

  let busy = $state('')
  let msg = $state('')

  // ---- unlock ----
  let unlockOpen = $state(false)
  let pwTry = $state('')
  const pwTryErr = $derived(pwTry ? parsePassword(pwTry).error ?? '' : '')
  async function unlock() {
    const p = parsePassword(pwTry)
    if (p.error) return
    busy = 'unlock'
    try {
      await api.unlock(guid, p.value)
      unlockOpen = false; pwTry = ''
      msg = `${d.name} is unlocked until it restarts. Read it to see its settings.`
      toast(msg, 'info', 5000)
    } catch (e) { msg = e.message } finally { busy = '' }
  }
  async function readNow() {
    busy = 'read'
    try {
      const r = await postAction(guid, 'read')
      if (!r.ok) { msg = r.error; return }
      await waitRead(() => device(guid))
      msg = `Read ${d.name}.`
    } finally { busy = '' }
  }

  // ---- password + contact ----
  let contact = $state('')
  let pw = $state('')
  let pw2 = $state('')
  let seeded = ''
  $effect(() => { const c = d?.lock?.contact ?? ''; if (c !== seeded) { seeded = c; contact = c } })
  const cErr = $derived(contactProblem(contact))
  const pwErr = $derived(pw ? parsePassword(pw).error ?? '' : '')
  const pw2Err = $derived(pw && pw2 && pw !== pw2 ? 'The two passwords differ.' : '')
  const canLock = $derived(!!pw && !pwErr && pw === pw2 && !cErr && !offline && !busy)

  /** Save to the project, write (it sends the password), store, restart: the lock is on from the restart. */
  async function apply(body, done) {
    busy = 'lock'; msg = ''
    try {
      await api.setLock(guid, body)
      project.dirty = true
      const w = await postAction(guid, 'write')
      if (!w.ok) { msg = `Saved in the project, but ${d.name} did not take it: ${w.error}`; toast(msg, 'error', 8000); return }
      const b = await postAction(guid, 'burn')
      if (!b.ok) { msg = `Written, but ${d.name} did not confirm the store: ${b.error}`; toast(msg, 'error', 8000); return }
      const r = await postAction(guid, 'restart')
      msg = r.ok ? done : `Stored. ${d.name} did not confirm the restart: power-cycle it for the change to take effect.`
      toast(msg, r.ok ? 'info' : 'error', 7000)
      pw = ''; pw2 = ''
    } catch (e) { msg = e.message } finally { busy = '' }
  }
  const lockNow = () => apply({ Contact: contact, Password: parsePassword(pw).value },
    `${d.name} stored the password and restarted: it is locked now. This session can't read it any more; Unlock it with the password.`)
  const saveContact = () => apply({ Contact: contact }, `${d.name} stored the contact text and restarted.`)
  const removePw = () => apply({ Contact: contact, ClearPassword: true }, `${d.name} has no password any more (stored, restarted).`)

  // ---- factory reset ----
  let resetOpen = $state(false)
  let wipe = $state('')
  async function factoryReset() {
    if (wipe !== 'WIPE') return
    busy = 'reset'; resetOpen = false; wipe = ''
    try {
      await api.factoryReset(guid)
      msg = `${d.name} is back to its factory settings (base ID and bitrate kept). Its outputs are off. The project still holds the old configuration: Apply it, or Read the module.`
      toast(msg, 'info', 9000)
    } catch (e) { msg = e.message; toast(`${d.name}: ${e.message}`, 'error', 9000) } finally { busy = '' }
  }
</script>

{#if d && sum}
  <section aria-label="Configuration lock" class="blk" data-testid="module-lock">
    <div class="bh"><strong>Configuration lock</strong></div>
    <Banner tone={sum.tone} title={sum.title} data-testid="lock-state">{sum.text}</Banner>
    {#if offline}<p class="muted sm" role="status">{offline}</p>{/if}

    {#if d.lock.locked}
      <p class="muted">While locked it runs its configuration as before and still sends its status, but it refuses reads, changes and the bootloader until it is unlocked with the installer's password. A restart locks it again.</p>
      <div class="row">
        <Button variant="primary" onclick={() => (unlockOpen = true)} disabled={!!offline || !!busy} data-testid="lock-unlock">Unlock…</Button>
      </div>
    {:else}
      {#if msg && /unlocked/.test(msg)}<div class="row"><Button onclick={readNow} busy={busy === 'read'} disabled={!!offline || !!busy}>Read from module</Button></div>{/if}
      <Field label="Contact text (shown to whoever finds it locked)" bind:value={contact} error={cErr} hint={`${contact.length} of 32 characters, e.g. a name and phone number.`} maxlength="40" data-testid="lock-contact" />
      <div class="two">
        <Field label="New password" type="password" bind:value={pw} error={pwErr} hint="Digits (or 0x hex), up to 4294967295." autocomplete="new-password" data-testid="lock-pw" />
        <Field label="Repeat it" type="password" bind:value={pw2} error={pw2Err} autocomplete="new-password" data-testid="lock-pw2" />
      </div>
      <p class="muted sm">Locking writes the project to {d.name} (with the password), stores it and restarts it. Keep the password: the module never shows it again, and without it only a factory reset (which erases its configuration) gets back in. The project file keeps a copy so every later write sends it again.</p>
      <div class="row">
        <Button variant="primary" onclick={lockNow} disabled={!canLock} busy={busy === 'lock'} data-testid="lock-set">Lock: write, store and restart</Button>
        <Button onclick={saveContact} disabled={!!cErr || !!offline || !!busy} data-testid="lock-contact-save">Save contact only</Button>
        {#if d.lock.passwordSet}<Button onclick={removePw} disabled={!!offline || !!busy} data-testid="lock-clear">Remove the password</Button>{/if}
      </div>
    {/if}

    <div class="row">
      <Button variant="danger" onclick={() => (resetOpen = true)} disabled={!!offline || !!busy} busy={busy === 'reset'} data-testid="lock-factory">Factory reset…</Button>
      <span class="muted sm">Erases the configuration, password included. Works locked or not.</span>
    </div>
    {#if msg}<p role="status" data-testid="lock-msg">{msg}</p>{/if}
  </section>

  <Confirm bind:open={unlockOpen} title={`Unlock ${d.name}`} width={480}>
    {#if d.lock.contact}<p>Installer: <strong>{d.lock.contact}</strong></p>{/if}
    <Field label="Password" type="password" bind:value={pwTry} error={pwTryErr} autocomplete="current-password" onkeydown={(e) => e.key === 'Enter' && unlock()} data-testid="unlock-pw" />
    <p class="muted sm">It stays unlocked until it restarts. After a wrong password, wait a second before trying again.</p>
    {#snippet footer()}
      <Button onclick={() => (unlockOpen = false)}>Cancel</Button>
      <Button variant="primary" onclick={unlock} disabled={!pwTry || !!pwTryErr} busy={busy === 'unlock'} data-testid="unlock-yes">Unlock</Button>
    {/snippet}
  </Confirm>

  <Confirm bind:open={resetOpen} title={`Factory reset ${d.name}?`} width={560}>
    <p class="bad">■ Every output of {d.name} turns off at once. On a running car that includes the fuel pump, fans and lights it drives.</p>
    <p>Its whole configuration is erased and stored: outputs, inputs, functions, the password and the contact text. Its base ID ({'0x' + d.baseId.toString(16).toUpperCase()}) and CAN speed are kept so it stays reachable. This cannot be undone; the project still has its configuration if you want to write it back.</p>
    <Field label="Type WIPE to confirm" bind:value={wipe} mono data-testid="reset-wipe" />
    {#snippet footer()}
      <Button onclick={() => { resetOpen = false; wipe = '' }}>Cancel</Button>
      <Button variant="danger" onclick={factoryReset} disabled={wipe !== 'WIPE'} data-testid="reset-yes">Erase {d.name}</Button>
    {/snippet}
  </Confirm>
{/if}

<style>
  .blk { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
  .bh { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
  .row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
  @media (max-width: 520px) { .two { grid-template-columns: 1fr; } }
  .sm { font-size: var(--text-xs); }
  .bad { color: var(--color-fault); font-weight: 600; }
</style>
