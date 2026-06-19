// Clickable <div>/<span> menus, cards, rows, tiles and modal/drawer dialogs are made
// keyboard- and screen-reader-operable at RUNTIME by the `use:clickable` / `use:dialog` /
// `use:labelFields` actions in src/lib/a11y.js (role, tabindex, Enter/Space, focus-trap,
// Escape, label association). Svelte's compile-time linter can't see attributes an action
// adds, so it still flags these — silence exactly those rules. Genuine warnings still surface.
const SILENCED = new Set([
  'a11y_click_events_have_key_events',
  'a11y_no_static_element_interactions',
  'a11y_no_noninteractive_element_interactions',
  'a11y_interactive_supports_focus',   // tabindex is added by use:clickable at runtime
  'a11y_label_has_associated_control',
])

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  compilerOptions: {
    warningFilter: (w) => !SILENCED.has(w.code),
  },
}
