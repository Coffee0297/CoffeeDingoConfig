<script>
  // The wiring and signal-links drawings of a template. The drawing itself is the old app's TemplateDrawing
  // (pure SVG, downloadable); this wrapper maps the old colour variables onto the new tokens.
  import TemplateDrawing from '../../../../lib/TemplateDrawing.svelte'
  let { title = '', ins = [], outs = [], relays = {}, preview = null, logicName = '' } = $props()
</script>

<div class="dw" data-testid="drawings">
  <TemplateDrawing {title} {ins} {outs} {relays} {preview} {logicName} />
</div>

<style>
  .dw { --line: var(--color-line); --surface: var(--color-surface); --r: var(--radius-md); --muted: var(--color-text-muted); --accent: var(--color-accent); --text: var(--color-text); }
  .dw :global(.btn) { min-height: 32px; padding: 0 var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-surface); color: var(--color-text); font-weight: 600; font-size: var(--text-xs); }
  .dw :global(.muted) { color: var(--color-text-muted); }
  .dw :global(.dh) { font-size: var(--text-sm); }
</style>
