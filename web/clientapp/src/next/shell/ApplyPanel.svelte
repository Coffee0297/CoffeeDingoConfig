<script>
  import { Dialog } from '../ui/index.js'
  import { ui } from './ui.svelte.js'
</script>

<Dialog bind:open={() => ui.panel === 'apply', (v) => { if (!v) ui.panel = null }} title="Apply to car">
  <p class="muted">Being built.</p>
</Dialog>
