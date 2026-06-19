// Small accessibility actions so the redesign's many clickable <div>/<span> surfaces and
// modal/drawer dialogs are keyboard- and screen-reader-operable without rewriting every
// element into a <button>. Applied with `use:` — zero visual change.

// Make a non-button clickable element operable by keyboard: Enter/Space fire its click,
// and it gets role=button (unless an explicit role like "tab" is already set) + tabindex.
export function clickable(node) {
  if (!node.hasAttribute('role')) node.setAttribute('role', 'button')
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0')
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      node.click()
    }
  }
  node.addEventListener('keydown', onKey)
  return { destroy() { node.removeEventListener('keydown', onKey) } }
}

// Associate every `.field > label` with its control inside `node`, so screen readers announce
// each input by name and clicking the label focuses it. Watches for dynamically-rendered
// fields (tab switches inside a drawer) via a MutationObserver. One `use:labelFields` on a
// form container covers all its fields.
let _fid = 0
export function labelFields(node) {
  const link = () => {
    for (const f of node.querySelectorAll('.field')) {
      const label = f.querySelector(':scope > label')
      const ctrl = f.querySelector('input, select, textarea')
      if (label && ctrl && !label.htmlFor) {
        if (!ctrl.id) ctrl.id = 'fld_' + (++_fid)
        label.htmlFor = ctrl.id
      }
    }
  }
  link()
  const mo = new MutationObserver(link)
  mo.observe(node, { childList: true, subtree: true })
  return { destroy() { mo.disconnect() } }
}

// Turn an element into an accessible modal dialog: role/aria-modal, a name from its title,
// focus moved inside on open and restored on close, a Tab focus-trap, and Escape-to-close.
// Usage: <aside class="drawer" use:dialog={{ onclose: () => (open = false) }}>
export function dialog(node, params = {}) {
  let onclose = params.onclose
  node.setAttribute('role', 'dialog')
  node.setAttribute('aria-modal', 'true')
  const title = node.querySelector('.nm, .mh2')?.textContent?.trim()
  if (title && !node.hasAttribute('aria-label')) node.setAttribute('aria-label', title)

  const prev = document.activeElement
  const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  const focusables = () => [...node.querySelectorAll(SEL)].filter((el) => el.offsetParent !== null)
  // focus the first control once the dialog has rendered
  Promise.resolve().then(() => { const f = focusables(); (f[0] ?? node).focus?.() })

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onclose?.(); return }
    if (e.key !== 'Tab') return
    const f = focusables(); if (!f.length) return
    const first = f[0], last = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
  node.addEventListener('keydown', onKey)
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1')
  return {
    update(p) { onclose = p?.onclose },
    destroy() { node.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus() },
  }
}
