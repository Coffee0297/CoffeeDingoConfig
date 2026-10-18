// The app: an address from before the redesign (#/, #/system, …) opens Car home.
const target = document.getElementById('app')
if (!location.hash.startsWith('#/next')) history.replaceState(null, '', '#/next/car')

const app = await import('./next/main.js').then((m) => m.mountNext(target))

export default app
