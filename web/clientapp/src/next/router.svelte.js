// Hash router for the redesigned UI: `#/next/<area>/<page>/<a>/<b>?k=v`.
// `route.parts` = ['hardware', 'module', '<guid>', ...]; `route.query` = { k: 'v' }.
function parse() {
  const h = location.hash.replace(/^#\/next\/?/, '')
  const [path, qs = ''] = h.split('?')
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  const query = Object.fromEntries(new URLSearchParams(qs))
  return { parts: parts.length ? parts : ['car'], query }
}

export const route = $state(parse())

addEventListener('hashchange', () => {
  const r = parse()
  route.parts = r.parts
  route.query = r.query
})

/** Build a link: href('hardware', 'module', guid) → '#/next/hardware/module/<guid>' */
export function href(...parts) {
  let q = ''
  if (parts.length && typeof parts[parts.length - 1] === 'object') {
    q = '?' + new URLSearchParams(parts.pop()).toString()
  }
  return '#/next/' + parts.map((p) => encodeURIComponent(p)).join('/') + q
}

/** Navigate: go('live', 'plot', { signal: 'x' }) */
export function go(...parts) {
  location.hash = href(...parts)
}
