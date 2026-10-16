<script>
  // AI agent tab (board H29, tab 1). The MCP server runs inside this app at /mcp. GET /api/agent (G22) gives
  // its on/off state, connected assistants, the tools that ask first, requests waiting and the journal of
  // what an assistant changed, each with Undo (the project goes back; Apply to car sends it).
  import { onMount } from 'svelte'
  import { Card, Button, StateDot, Banner, Field, Empty, Checkbox } from '../../../ui/index.js'
  import { toast, live } from '../../../lib/live.svelte.js'
  import { ago } from '../../functions/parts/catalog.js'
  import Confirm from '../../power/parts/Confirm.svelte'

  let agent = $state(null)
  async function loadAgent() { try { agent = await (await fetch('/api/agent')).json() } catch { agent = null } }
  onMount(() => { loadAgent(); const t = setInterval(loadAgent, 2000); return () => clearInterval(t) })
  $effect(() => { live.agentPending; loadAgent() })
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error(j?.error ?? 'HTTP ' + r.status)
    return j
  }
  async function setEnabled(on) {
    try { await post('/api/agent/enabled', { enabled: on }); toast(on ? 'AI agent server started.' : 'AI agent server stopped. Assistants are turned away.', 'info', 3000) }
    catch (e) { toast(e.message, 'error', 6000) }
    loadAgent()
  }
  async function setAsk(tool, ask) { try { await post('/api/agent/ask', { tool, ask }) } catch (e) { toast(e.message, 'error', 6000) } loadAgent() }
  async function answer(id, approve) { try { await post(`/api/agent/approvals/${id}`, { approve }) } catch (e) { toast(e.message, 'warn', 4000) } loadAgent() }
  let undoOf = $state(null), undoOpen = $state(false)
  async function undo() {
    const e = undoOf; undoOpen = false
    try { await post(`/api/agent/undo/${e.id}`); toast(`Undone: the project is back as it was before ${e.tool}. Apply to car sends it to the modules.`, 'info', 6000) }
    catch (err) { toast(err.message, 'error', 6000) }
    loadAgent()
  }
  const asks = (name) => !!agent?.ask?.includes(name)

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
          {#if agent?.enabled === false}<StateDot tone="off" shape="ring" label="Stopped" />{:else}<StateDot tone="on" shape="dot" label="Running" />{/if}
          <span class="muted">{info.name} {info.version} · listening on this computer</span>
        </div>
        <div class="url">
          <Field label="Address to paste into your assistant" value={info.httpEndpoint} mono readonly data-testid="ai-url" />
          <Button onclick={() => copy(info.httpEndpoint, 'Address')} data-testid="ai-copy">{copied === 'Address' ? 'Copied ✓' : 'Copy'}</Button>
        </div>
        <div class="row">
          <Button variant="primary" onclick={testConnection} busy={testing} data-testid="ai-test">Test connection</Button>
          {#if agent?.enabled === false}<Button onclick={() => setEnabled(true)} data-testid="ai-start">Start server</Button>
          {:else}<Button onclick={() => setEnabled(false)} disabled={!agent} data-testid="ai-stop">Stop server</Button>{/if}
        </div>
        <p class="muted gap">Stopped, the server turns every assistant away until you start it again. It runs again when the app restarts.</p>
        {#if test}<Banner tone={test.ok ? 'ok' : 'fault'} data-testid="ai-test-result">{test.text}</Banner>{/if}
      {/if}
    </Card>

    <Card title="Client setup" subtitle="Paste this into your assistant's server list">
      {#if info}
        <pre class="mono cfg" data-testid="ai-config">{cfgText}</pre>
        <div><Button onclick={() => copy(cfgText, 'Setup')} data-testid="ai-copy-config">{copied === 'Setup' ? 'Copied ✓' : 'Copy setup'}</Button></div>
      {:else}<p class="muted">Available when the server answers.</p>{/if}
    </Card>

    {#if agent?.pending?.length}
      <Card title="Waiting for you" aria-label="Requests waiting">
        <ul class="list" data-testid="ai-pending">
          {#each agent.pending as p (p.id)}
            <li><span><code class="mono">{p.tool}</code> · {p.client}</span>
              <span class="row"><Button size="sm" onclick={() => answer(p.id, false)}>Refuse</Button><Button size="sm" variant="primary" onclick={() => answer(p.id, true)}>Allow</Button></span></li>
          {/each}
        </ul>
      </Card>
    {/if}

    <Card title="Connected assistants">
      {#if agent?.clients?.length}
        <ul class="list" data-testid="ai-clients">
          {#each agent.clients as c (c.id)}
            <li><span><strong>{c.name}</strong> <span class="muted mono">{c.id}</span></span><span class="muted"><time datetime={c.lastCall}>{ago(c.lastCall)}</time> · {c.calls} call{c.calls === 1 ? '' : 's'}</span></li>
          {/each}
        </ul>
      {:else}<Empty title="No assistant yet" text="An assistant shows here after its first call to the address above." />{/if}
    </Card>
  </div>

  <div class="stack">
    <Card title="What an assistant can do" subtitle={info ? `${info.tools?.length ?? 0} tools, read from the server` : ''}>
      <Field label="Search the tools" bind:value={q} placeholder="for example lua" data-testid="ai-search" />
      <p class="muted gap">Tick a tool to be asked before it runs. Flashing and output changes ask by default.</p>
      <ul class="tools" data-testid="ai-tools" tabindex="0" aria-label="Tools the AI agent can use">
        {#each tools as t (t.name)}
          <li><span class="th"><code class="mono">{t.name}</code><Checkbox label="Ask me first" checked={asks(t.name)} onchange={(v) => setAsk(t.name, v)} data-testid={'ask-' + t.name} /></span><span class="muted">{t.description}</span></li>
        {:else}<li class="muted">{info ? 'No tool matches.' : 'The tools show here when the server answers.'}</li>{/each}
      </ul>
    </Card>

    <Card title="Activity journal and undo" subtitle="What an assistant changed since the app started">
      {#if agent?.journal?.length}
        <ul class="list" data-testid="ai-journal">
          {#each agent.journal as e (e.id)}
            <li class:undone={e.undone}><span><code class="mono">{e.tool}</code> · {e.client} · <time datetime={e.at}>{ago(e.at)}</time></span>
              <span class="row"><span class:muted={e.ok} class:fault={!e.ok}>{e.undone ? 'undone' : e.status}</span>
                {#if e.undoable}<Button size="sm" onclick={() => { undoOf = e; undoOpen = true }} data-testid={'undo-' + e.id}>Undo</Button>{/if}</span></li>
          {/each}
        </ul>
      {:else}<Empty title="Nothing changed yet" text="Each change an assistant makes shows here, and the recent ones can be undone." />{/if}
    </Card>
    <Confirm bind:open={undoOpen} title="Undo this change?" confirmLabel="Undo" onconfirm={undo}>
      {#if undoOf}The project goes back to how it was before <code class="mono">{undoOf.tool}</code>, and every later change by an assistant is undone too. The modules keep what they have until you Apply to car.{/if}
    </Confirm>
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
  .th { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .list li { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); flex-wrap: wrap; }
  .list li.undone { opacity: 0.6; }
  .fault { color: var(--color-fault); font-weight: 600; }
  .tools code { font-weight: 700; }
</style>
