// Draw the plot onto a canvas and download it as a PNG (colours read from the current theme tokens).
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
const resolve = (c) => (c.startsWith('var(') ? css(c.slice(4, -1)) : c)

/**
 * @param lines [{ label, color, dash, values:number[] (0..1 normalised, bottom to top) , unit, last }]
 * @param opts { title, xLabels: string[], yLabels: string[] (top to bottom, optional) }
 */
export function renderPlotPng(lines, opts = {}) {
  const W = 1280, H = 560, L = 72, R = 24, T = 64, B = 44
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  const field = (v) => (typeof v === 'string' ? v : '')
  g.fillStyle = css('--color-surface'); g.fillRect(0, 0, W, H)
  g.font = '600 18px sans-serif'; g.fillStyle = css('--color-text'); g.fillText(field(opts.title) || 'dingoConfig plot', L, 28)
  // legend
  g.font = '13px sans-serif'
  let lx = L
  for (const l of lines) {
    g.strokeStyle = resolve(l.color); g.lineWidth = 3; g.setLineDash((l.dash || '').split(' ').filter(Boolean).map(Number))
    g.beginPath(); g.moveTo(lx, 48); g.lineTo(lx + 26, 48); g.stroke(); g.setLineDash([])
    g.fillStyle = css('--color-text'); const t = l.label + (l.last ? '  ' + l.last : '')
    g.fillText(t, lx + 32, 53); lx += 44 + g.measureText(t).width
  }
  // grid
  g.strokeStyle = css('--color-line'); g.lineWidth = 1; g.fillStyle = css('--color-text-muted'); g.font = '12px monospace'
  const pw = W - L - R, ph = H - T - B
  for (let i = 0; i <= 4; i++) {
    const y = T + (ph * i) / 4
    g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke()
    const lab = opts.yLabels?.[i]; if (lab != null) g.fillText(String(lab), 8, y + 4)
  }
  const xl = opts.xLabels ?? []
  xl.forEach((t, i) => { const x = L + (pw * i) / Math.max(1, xl.length - 1); g.fillText(t, Math.min(x, W - R - 30), H - 14) })
  // lines
  for (const l of lines) {
    if (!l.values.length) continue
    g.strokeStyle = resolve(l.color); g.lineWidth = 2.5; g.lineJoin = 'round'; g.setLineDash((l.dash || '').split(' ').filter(Boolean).map(Number))
    g.beginPath()
    l.values.forEach((v, i) => { const x = L + (pw * i) / Math.max(1, l.values.length - 1), y = T + ph * (1 - Math.max(0, Math.min(1, v))); i ? g.lineTo(x, y) : g.moveTo(x, y) })
    g.stroke(); g.setLineDash([])
  }
  return new Promise((res) => c.toBlob((b) => res(b), 'image/png'))
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
