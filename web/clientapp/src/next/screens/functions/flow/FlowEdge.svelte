<script>
  /**
   * A wire. data: { lv, idx, type: 'bool' | 'num', link? }. An on/off wire glows while its signal is on;
   * a number wire is drawn muted with a dash so the two kinds read apart without colour. Link wires
   * (to another module, over CAN) are dashed and thicker. data.hl (shared, whole car): { on, e: { [edgeId]: true } }
   * lights the wires of the hovered block and fades the rest.
   */
  import { BaseEdge, getBezierPath } from '@xyflow/svelte'
  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = $props()
  const path = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0])
  const v = $derived(data?.lv?.v?.[data?.idx])
  const hot = $derived(data?.type === 'bool' && v === true)
  const lit = $derived(!!(data?.hl?.on && data.hl.e[id]))
  const dim = $derived(!!(data?.hl?.on && !data.hl.e[id]))
  const style = $derived(
    `stroke: ${selected || lit ? 'var(--color-focus)' : hot ? 'var(--color-on)' : data?.type === 'num' ? 'var(--color-text-muted)' : 'var(--color-line-strong)'};` +
    `stroke-width: ${lit ? 6 : data?.link ? 4 : hot || selected ? 3 : 2};` + (dim ? 'opacity: 0.15;' : '') +
    (data?.link ? 'stroke-dasharray: 2 7;' : data?.type === 'num' ? 'stroke-dasharray: 8 4;' : '') + 'stroke-linecap: round;'
  )
</script>

<BaseEdge {id} {path} {style} interactionWidth={16} />
