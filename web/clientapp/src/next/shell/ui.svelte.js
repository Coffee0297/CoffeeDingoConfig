// Shell-level UI state: which top-bar panel is open, command palette, theme.
export const ui = $state({
  panel: null, // 'connect' | 'apply' | 'project' | null
  palette: false,
  addModule: false, // the one Add module dialog (opened from Car and Hardware › Modules)
  theme: (() => { try { return localStorage.getItem('nxTheme') || 'dark' } catch { return 'dark' } })(),
  expertOpen: (() => { try { return localStorage.getItem('nxExpert') === '1' } catch { return false } })(),
})

export function setTheme(t) {
  ui.theme = t
  try { localStorage.setItem('nxTheme', t) } catch {}
}
export function toggleExpert() {
  ui.expertOpen = !ui.expertOpen
  try { localStorage.setItem('nxExpert', ui.expertOpen ? '1' : '0') } catch {}
}
