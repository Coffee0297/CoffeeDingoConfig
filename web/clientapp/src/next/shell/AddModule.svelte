<script>
  import { Dialog } from '../ui/index.js'
  import { ui } from './ui.svelte.js'
</script>

<Dialog bind:open={() => ui.addModule, (v) => (ui.addModule = v)} title="Add module">
  <p class="muted">Being built.</p>
</Dialog>
