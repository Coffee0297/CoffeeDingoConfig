<script>
  // Live rolling sparkline. Pushes `value` into a time buffer and redraws.
  let { value = 0, win = 60, color = '#594ae2', tick = 0 } = $props()
  let canvas
  let pts = []

  $effect(() => {
    tick // re-run every telemetry update even when value is unchanged
    const v = Number(value) || 0
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    pts.push({ t: now, v })
    const w = win * 1000
    while (pts.length > 2 && now - pts[0].t > w * 1.2) pts.shift()
    draw(now, w)
  })

  function draw(now, w) {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    const vis = pts.filter((p) => now - p.t <= w)
    if (vis.length < 2) return
    let lo = Infinity, hi = -Infinity
    for (const p of vis) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v) }
    if (hi - lo < 1e-6) { hi += 1; lo -= 1 }
    const pad = (hi - lo) * 0.15; lo -= pad; hi += pad
    const X = (p) => ((p.t - (now - w)) / w) * W
    const Y = (v) => H - ((v - lo) / (hi - lo)) * H
    // area
    ctx.beginPath(); ctx.moveTo(X(vis[0]), H)
    for (const p of vis) ctx.lineTo(X(p), Y(p.v))
    ctx.lineTo(X(vis[vis.length - 1]), H); ctx.closePath()
    ctx.fillStyle = color + '22'; ctx.fill()
    // line
    ctx.beginPath()
    vis.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p.v)) : ctx.moveTo(X(p), Y(p.v))))
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke()
    // last dot
    const last = vis[vis.length - 1]
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(last), Y(last.v), 2.5, 0, 7); ctx.fill()
  }
</script>

<canvas bind:this={canvas} class="spark" width="560" height="64"></canvas>
