<script>
  import { Dialog } from '../ui/index.js'
  import { ui } from './ui.svelte.js'
</script>

<Dialog bind:open={() => ui.panel === 'connect', (v) => { if (!v) ui.panel = null }} title="Connection">
  <p class="muted">Being built.</p>
</Dialog>
