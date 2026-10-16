<script>
  /** What each module gets from a cross-module deploy — the result of previewCrossModule(). Read-only. */
  let { plan } = $props()
</script>

<div class="pv" data-testid="cm-preview">
  {#if !plan?.modules?.length}
    <p class="muted">Nothing to send yet. A function needs a trigger signal and at least one output.</p>
  {/if}
  {#each plan?.skipped ?? [] as s (s.name)}
    <p class="warn">▲ “{s.name}” is skipped: {s.why}.</p>
  {/each}
  {#each plan?.modules ?? [] as m (m.guid)}
    <section class="mod" data-testid="cm-preview-module">
      <h3>{m.name}</h3>
      {#if m.steps.length}
        <ul>{#each m.steps as s, i (i)}<li>{s}</li>{/each}</ul>
      {:else}
        <p class="muted">Only clears its old cross-module CAN slots.</p>
      {/if}
      {#each m.errors as e, i (i)}<p class="warn">▲ {e}</p>{/each}
      {#if m.lua}
        <details>
          <summary>Show the Lua it gets ({m.lua.split('\n').length} lines)</summary>
          <pre class="mono">{m.lua}</pre>
        </details>
      {/if}
    </section>
  {/each}
</div>

<style>
  .pv { display: flex; flex-direction: column; gap: var(--space-3); }
  .mod { border: 1px solid var(--color-line); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
  h3 { font-size: var(--text-md); font-weight: 700; margin: 0; }
  ul { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 2px; }
  .warn { margin: 0; color: var(--color-warn); font-weight: 600; font-size: var(--text-sm); }
  summary { cursor: pointer; font-size: var(--text-sm); }
  pre { margin: var(--space-2) 0 0; padding: var(--space-3); max-height: 260px; overflow: auto; background: var(--color-raised); border-radius: var(--radius-md); font-size: var(--text-xs); white-space: pre; }
</style>
