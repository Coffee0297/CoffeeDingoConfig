import { mount } from 'svelte'

// The redesigned UI lives next to the current one (no big-bang switch): `#/next/...` loads it,
// everything else keeps the current app. Each UI only pulls in its own CSS.
const target = document.getElementById('app')
const isNext = location.hash.startsWith('#/next')

const app = isNext
  ? await import('./next/main.js').then((m) => m.mountNext(target))
  : await Promise.all([import('./redesign.css'), import('./App.svelte')]).then(([, m]) => mount(m.default, { target }))

// Switching between the two UIs is a full reload so their global CSS never mixes.
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#/next') !== isNext) location.reload()
})

export default app
