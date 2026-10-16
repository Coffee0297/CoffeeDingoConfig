<script>
  // G22: an AI assistant asks before a tool on the ask-first list runs (flashing, switching loads, …).
  // Telemetry says how many requests wait (agentPending); this shows the oldest on any page.
  import { Dialog, Button } from '../ui/index.js'
  import { live, toast } from '../lib/live.svelte.js'

  let req = $state(null), busy = $state(false)
  async function refresh() {
    try { req = (await (await fetch('/api/agent')).json()).pending?.[0] ?? null } catch { req = null }
  }
  // keyed on the oldest request's id: a new request after an answer changes it even when the count stays 1
  $effect(() => { live.agentPendingId; refresh() })
  async function answer(approve) {
    if (!req) return
    busy = true
    try {
      const r = await fetch(`/api/agent/approvals/${req.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve }) })
      if (!r.ok) toast((await r.json().catch(() => null))?.error ?? 'The request is no longer waiting.', 'warn', 4000)
      else toast(approve ? `Allowed ${req.tool}.` : `Refused ${req.tool}. Nothing was done.`, 'info', 3000)
    } finally { busy = false; await refresh() }
  }
  const args = $derived(req ? JSON.stringify(req.args, null, 2) : '')
</script>

{#if req}
  <Dialog open={true} title="An AI assistant asks first" width={520} onclose={() => answer(false)} data-testid="agent-prompt">
    <p><strong>{req.client}</strong> wants to run <code class="mono">{req.tool}</code>.</p>
    <pre class="mono args">{args}</pre>
    <p class="muted">Refused or not answered within 2 minutes: nothing is done. Expert › AI agent sets which tools ask.</p>
    {#snippet footer()}
      <Button onclick={() => answer(false)} disabled={busy} data-testid="agent-refuse">Refuse</Button>
      <Button variant="primary" onclick={() => answer(true)} disabled={busy} data-testid="agent-allow">Allow</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .args { margin: 0; padding: var(--space-3); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-raised); max-height: 220px; overflow: auto; font-size: var(--text-xs); }
</style>
