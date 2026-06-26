<script>
  import { toast } from './toast.js'
  import { clickable } from './a11y.js'

  let info = $state(null)
  let loadErr = $state('')
  let testing = $state(false)
  let testResult = $state(null)   // { ok, text }
  let openSkill = $state(null)    // { id, title, markdown }
  let skillBusyId = $state(null)  // id of the skill currently loading — only that button shows busy

  async function load() {
    loadErr = ''
    try {
      const r = await fetch('/mcp/info', { headers: { Accept: 'application/json' } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      info = await r.json()
    } catch (e) {
      loadErr = e.message
    }
  }
  load()

  // Round-trip the live JSON-RPC transport: initialize -> tools/list. Proves /mcp answers.
  async function testConnection() {
    testing = true; testResult = null
    try {
      const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: info?.protocolVersion ?? '2024-11-05', capabilities: {}, clientInfo: { name: 'dingoConfig-ui', version: '1.0.0' } } })
      if (init.error) throw new Error(init.error.message || 'initialize failed')
      const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      if (list.error) throw new Error(list.error.message || 'tools/list failed')
      const n = list.result?.tools?.length ?? 0
      testResult = { ok: true, text: `Handshake OK — server reports ${n} tool(s).` }
      toast('MCP endpoint responded', 'ok', 4000)
    } catch (e) {
      testResult = { ok: false, text: e.message }
      toast('MCP test failed: ' + e.message, 'error', 8000)
    } finally {
      testing = false
    }
  }

  async function rpc(body) {
    const r = await fetch('/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body) })
    if (r.status === 202) return {}
    const t = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`)
    return t ? JSON.parse(t) : {}
  }

  async function showSkill(id) {
    skillBusyId = id
    try {
      const r = await fetch('/mcp/skills/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      openSkill = await r.json()
    } catch (e) {
      toast('Could not load skill: ' + e.message, 'error', 6000)
    } finally {
      skillBusyId = null
    }
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text)
      toast((label ?? 'Copied') + ' to clipboard', 'ok', 3000)
    } catch {
      toast('Copy failed — select and copy manually', 'warn', 5000)
    }
  }

  const pretty = (o) => JSON.stringify(o, null, 2)
</script>

<div class="mcp">
  <header class="head">
    <div>
      <h2>MCP server</h2>
      <p class="sub">Drive every part of dingoConfig from an AI client. The MCP server is hosted
        inside this app — same tools, same hardware, no UI scraping.</p>
    </div>
    <button class="btn" use:clickable={load}>Refresh</button>
  </header>

  {#if loadErr}
    <div class="card err">Could not load MCP info: {loadErr}</div>
  {:else if !info}
    <div class="card muted">Loading…</div>
  {:else}
    <div class="grid">
      <section class="card">
        <h3>Endpoint</h3>
        <div class="kv"><span>HTTP transport</span><code class="mono">{info.httpEndpoint}</code></div>
        <div class="kv"><span>Server</span><code>{info.name} v{info.version}</code></div>
        <div class="kv"><span>Protocol</span><code>{info.protocolVersion}</code></div>
        <div class="kv"><span>Transport</span><code>{info.transport}</code></div>
        <div class="row">
          <button class="btn primary" use:clickable={testConnection} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button class="btn" use:clickable={() => copy(info.httpEndpoint, 'Endpoint URL')}>Copy URL</button>
        </div>
        {#if testResult}
          <div class="result {testResult.ok ? 'ok' : 'bad'}">{testResult.text}</div>
        {/if}
      </section>

      <section class="card">
        <h3>Client config</h3>
        <p class="sub">Add one of these to your MCP client. <strong>HTTP is preferred</strong> — no
          script, no file path, and it works with GitHub Copilot CLI and Claude Code. The app must
          be running for either to connect.</p>
        <div class="cfg">
          <div class="cfg-h">
            <span>HTTP — recommended (Copilot CLI, Claude Code, any Streamable-HTTP client)</span>
            <button class="btn ghost sm" use:clickable={() => copy(pretty(info.httpConfig), 'HTTP config')}>Copy</button>
          </div>
          <pre class="mono">{pretty(info.httpConfig)}</pre>
        </div>
        <div class="cfg">
          <div class="cfg-h">
            <span>stdio bridge — fallback for stdio-only clients (needs Node 18+)</span>
            <button class="btn ghost sm" use:clickable={() => copy(pretty(info.stdioConfig), 'stdio config')}>Copy</button>
          </div>
          <pre class="mono">{pretty(info.stdioConfigDisplay ?? info.stdioConfig)}</pre>
          <p class="sub note">The <code>args</code> path is absolute on purpose: stdio clients launch
            <code>node</code> from their own working directory, so a relative path fails to load.
            Shown relative to your home folder; <b>Copy</b> puts the full path on your clipboard.</p>
        </div>
      </section>
    </div>

    <section class="card">
      <h3>Skills <span class="count">{info.skills?.length ?? 0}</span></h3>
      <p class="sub">Guided playbooks the AI can follow end-to-end. Click to read.</p>
      <div class="skills">
        {#each info.skills ?? [] as s}
          <button class="skill" use:clickable={() => showSkill(s.id)} disabled={skillBusyId === s.id}>
            <strong>{s.title}{#if skillBusyId === s.id} …{/if}</strong>
            <span>{s.summary}</span>
          </button>
        {/each}
      </div>
    </section>

    <section class="card">
      <h3>Tools <span class="count">{info.tools?.length ?? 0}</span></h3>
      <p class="sub">Every UI capability is exposed as a tool.</p>
      <div class="tools">
        {#each info.tools ?? [] as t}
          <div class="tool"><code>{t.name}</code><span>{t.description}</span></div>
        {/each}
      </div>
    </section>
  {/if}
</div>

{#if openSkill}
  <div class="scrim" use:clickable={() => (openSkill = null)} role="presentation">
    <div class="drawer" role="dialog" aria-label={openSkill.title} onclick={(e) => e.stopPropagation()}>
      <header class="dh">
        <h3>{openSkill.title}</h3>
        <div class="row">
          <button class="btn ghost sm" use:clickable={() => copy(openSkill.markdown, 'Skill')}>Copy</button>
          <button class="btn" use:clickable={() => (openSkill = null)}>Close</button>
        </div>
      </header>
      <pre class="md mono">{openSkill.markdown}</pre>
    </div>
  </div>
{/if}

<style>
  .mcp { padding: 16px; max-width: 1100px; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  h2 { margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 8px; font-size: 13px; }
  .sub.note { margin: 6px 0 0; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .card.err { border-color: var(--err); color: var(--err); }
  .card.muted { color: var(--muted); }
  h3 { margin: 0 0 8px; font-size: 15px; }
  .count { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 10px; background: var(--line); font-size: 12px; vertical-align: middle; }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .kv span { color: var(--muted); font-size: 13px; }
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .mono { font-family: var(--mono); }
  .result { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 13px; }
  .result.ok { background: var(--ok-bg); color: var(--ok); }
  .result.bad { background: var(--err-bg); color: var(--err); }
  .cfg { margin-top: 10px; }
  .cfg-h { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow-x: auto; font-size: 12px; margin: 0; }
  .skills { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
  .skill { text-align: left; display: flex; flex-direction: column; gap: 4px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; cursor: pointer; color: inherit; }
  .skill:hover { border-color: var(--accent); }
  .skill span { color: var(--muted); font-size: 12px; }
  .tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 6px; }
  .tool { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .tool code { color: var(--accent-text); font-size: 12px; }
  .tool span { color: var(--muted); font-size: 12px; }
  .btn.sm { padding: 2px 8px; font-size: 12px; }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; justify-content: flex-end; z-index: 50; }
  .drawer { width: min(720px, 92vw); height: 100%; background: var(--surface); border-left: 1px solid var(--line); display: flex; flex-direction: column; }
  .dh { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .md { flex: 1; overflow: auto; white-space: pre-wrap; margin: 0; border: none; border-radius: 0; }
</style>
