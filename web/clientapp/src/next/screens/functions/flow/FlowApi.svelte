<script>
  // Rendered inside <SvelteFlow>: hands the viewport helpers (fitView, setCenter, zoom) to the screen.
  import { useSvelteFlow } from '@xyflow/svelte'
  let { onready } = $props()
  const flow = useSvelteFlow()
  onready?.(flow)
</script>
