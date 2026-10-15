<script>
  /**
   * A wire. data: { lv, idx, type: 'bool' | 'num', link? }. An on/off wire glows while its signal is on;
   * a number wire is drawn muted with a dash so the two kinds read apart without colour. Link wires
   * (to another module, over CAN) are dashed and thicker.
   */
  import { BaseEdge, getBezierPath } from '@xyflow/svelte'
  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = $props()
  const path = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0])
  const v = $derived(data?.lv?.v?.[data?.idx])
  const hot = $derived(data?.type === 'bool' && v === true)
  const style = $derived(
    `stroke: ${selected ? 'var(--color-focus)' : hot ? 'var(--color-on)' : data?.type === 'num' ? 'var(--color-text-muted)' : 'var(--color-line-strong)'};` +
    `stroke-width: ${data?.link ? 4 : hot || selected ? 3 : 2};` +
    (data?.link ? 'stroke-dasharray: 2 7;' : data?.type === 'num' ? 'stroke-dasharray: 8 4;' : '') + 'stroke-linecap: round;'
  )
</script>

<BaseEdge {id} {path} {style} interactionWidth={16} />
