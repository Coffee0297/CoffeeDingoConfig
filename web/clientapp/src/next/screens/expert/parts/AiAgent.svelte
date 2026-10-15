<script>
  // AI agent tab (board H29, tab 1). The MCP server runs inside this app at /mcp. What the backend can
  // report today: its address, name, tool list and a live handshake. Server status, connected clients,
  // per-tool approval and the activity journal are gap G22 and are shown as not available yet.
  import { onMount } from 'svelte'
  import { Card, Button, Chip, StateDot, Banner, Field, Empty } from '../../../ui/index.js'
  import { toast } from '../../../lib/live.svelte.js'

  let info = $state(null)
  let loadErr = $state('')
  let testing = $state(false)
  let test = $state(null) // { ok, text }
  let q = $state('')
  let copied = $state('')

  async function load() {
    loadErr = ''
    try {
      const r = await fetch('/mcp/info', { headers: { Accept: 'application/json' } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      if (!/json/i.test(r.headers.get('content-type') ?? '')) throw new Error('the address /mcp is not served here (the dev server does not forward it; use the app on its own port)')
      info = await r.json()
    } catch (e) { loadErr = e.message; info = null }
  }
  onMount(load)

  async function rpc(body) {
    const r = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
    if (r.status === 202) return {}
    const t = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}${t ? ': ' + t.slice(0, 160) : ''}`)
    return t ? JSON.parse(t) : {}
  }
  // Round trip the live JSON-RPC transport: initialize, then tools/list.
  async function testConnection() {
    testing = true; test = null
    try {
      const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: info?.protocolVersion ?? '2024-11-05', capabilities: {}, clientInfo: { name: 'dingoConfig-ui', version: '1.0.0' } } })
      if (init.error) throw new Error(init.error.message || 'initialize failed')
      const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      if (list.error) throw new Error(list.error.message || 'tools/list failed')
      test = { ok: true, text: `Handshake worked. The server reports ${list.result?.tools?.length ?? 0} tools.` }
    } catch (e) { test = { ok: false, text: 'The server did not answer: ' + e.message } } finally { testing = false }
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); copied = what; toast(`${what} copied.`, 'info', 2500) }
    catch { toast('Copy failed. Select the text and copy it by hand.', 'warn', 5000) }
  }

  const tools = $derived((info?.tools ?? []).filter((t) => !q.trim() || (t.name + ' ' + t.description).toLowerCase().includes(q.trim().toLowerCase())))
  const cfgText = $derived(info ? JSON.stringify(info.httpConfig, null, 2) : '')
</script>

<div class="cols">
  <div class="stack">
    <Card title="AI agent server" subtitle="Lets an AI assistant read and change the car through this app">
      {#if loadErr}
        <Banner tone="fault" title="The AI agent server did not answer.">{loadErr}. It starts with the app. Restart dingoConfig if this stays.
          {#snippet actions()}<Button onclick={load}>Try again</Button>{/snippet}
        </Banner>
      {:else if !info}<p class="muted" role="status">Asking the server…</p>
      {:else}
        <div class="run" data-testid="ai-status">
          <StateDot tone="on" shape="dot" label="Running" />
          <span class="muted">{info.name} {info.version} · listening on this computer</span>
        </div>
        <div class="url">
          <Field label="Address to paste into your assistant" value={info.httpEndpoint} mono readonly data-testid="ai-url" />
          <Button onclick={() => copy(info.httpEndpoint, 'Address')} data-testid="ai-copy">{copied === 'Address' ? 'Copied ✓' : 'Copy'}</Button>
        </div>
        <div class="row">
          <Button variant="primary" onclick={testConnection} busy={testing} data-testid="ai-test">Test connection</Button>
          <Button disabled title="Not available yet: the server starts and stops with the app.">Stop server</Button>
        </div>
        <p class="muted gap"><Chip tone="muted" dashed>Not available yet</Chip> Start and stop. The backend has no switch for the server, so it always runs while the app runs (gap G22).</p>
        {#if test}<Banner tone={test.ok ? 'ok' : 'fault'} data-testid="ai-test-result">{test.text}</Banner>{/if}
      {/if}
    </Card>

    <Card title="Client setup" subtitle="Paste this into your assistant's server list">
      {#if info}
        <pre class="mono cfg" data-testid="ai-config">{cfgText}</pre>
        <div><Button onclick={() => copy(cfgText, 'Setup')} data-testid="ai-copy-config">{copied === 'Setup' ? 'Copied ✓' : 'Copy setup'}</Button></div>
      {:else}<p class="muted">Available when the server answers.</p>{/if}
    </Card>

    <Card title="Connected assistants">
      <Empty title="Not available yet" text="The server does not keep a list of connected assistants yet (gap G22), so who is connected and when they last called cannot be shown." />
    </Card>
  </div>

  <div class="stack">
    <Card title="What an assistant can do" subtitle={info ? `${info.tools?.length ?? 0} tools, read from the server` : ''}>
      <Field label="Search the tools" bind:value={q} placeholder="for example lua" data-testid="ai-search" />
      <p class="muted gap"><Chip tone="muted" dashed>Not available yet</Chip> Which tools ask you first. The server has no approval setting yet (gap G22), so every tool below runs when the assistant calls it.</p>
      <ul class="tools" data-testid="ai-tools" tabindex="0" aria-label="Tools the AI agent can use">
        {#each tools as t (t.name)}
          <li><code class="mono">{t.name}</code><span class="muted">{t.description}</span></li>
        {:else}<li class="muted">{info ? 'No tool matches.' : 'The tools show here when the server answers.'}</li>{/each}
      </ul>
    </Card>

    <Card title="Activity journal and undo">
      <Empty title="Not available yet" text="The server does not record what an assistant changed (gap G22), so there is no list of its actions and nothing to undo here. Save the project often while an assistant works." />
    </Card>
  </div>
</div>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
  .stack { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .run { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .url { display: flex; align-items: flex-end; gap: var(--space-3); }
  .url :global(.f) { flex: 1 1 auto; }
  .row { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .gap { font-size: var(--text-xs); }
  .cfg { margin: 0; padding: var(--space-3); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-raised); overflow-x: auto; font-size: var(--text-xs); }
  .tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 520px; overflow: auto; }
  .tools li { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); }
  .tools code { font-weight: 700; }
</style>
