<script>
  import { Dialog } from '../ui/index.js'
  import { ui } from './ui.svelte.js'
</script>

<Dialog bind:open={() => ui.panel === 'project', (v) => { if (!v) ui.panel = null }} title="Project">
  <p class="muted">Being built.</p>
</Dialog>
