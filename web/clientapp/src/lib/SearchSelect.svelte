<script>
  // A drop-in searchable replacement for a long <select>. Falls back to a plain dropdown feel for
  // short lists; type-to-filter once a list is long. options = array of strings/numbers OR {value,label}.
  import { clickable } from './a11y.js'
  let { options = [], value = $bindable(), placeholder = 'Search…', disabled = false, id = undefined, onpick = undefined } = $props()

  let norm = $derived((options ?? []).map((o) => (o && typeof o === 'object') ? o : { value: o, label: String(o) }))
  let open = $state(false)
  let q = $state('')
  let root
  let active = $state(0)   // keyboard-highlighted option index (into the visible/capped list)
  let sel = $derived(norm.find((o) => o.value === value))
  let filtered = $derived(q.trim()
    ? norm.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
    : norm)
  const CAP = 200   // render cap — keep the DOM light for huge lists (e.g. 2500 DBC signals)
  let shown = $derived(filtered.slice(0, CAP))
  // Keep the highlight in range as the filter narrows.
  $effect(() => { if (active >= shown.length) active = Math.max(0, shown.length - 1) })

  function pick(o) { value = o.value; open = false; q = ''; onpick?.(o.value) }
  // Click behaves like a <select>: toggle the option list open/closed. Typing still filters.
  function toggle() { if (disabled) return; if (open) { open = false; q = '' } else { open = true; q = ''; active = 0 } }
  function onKey(e) {
    if (e.key === 'Escape') { open = false; q = ''; e.target.blur(); return }
    if (e.key === 'ArrowDown') { open = true; active = Math.min(active + 1, shown.length - 1); e.preventDefault(); return }
    if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); e.preventDefault(); return }
    if (e.key === 'Enter' && shown.length) { pick(shown[Math.min(active, shown.length - 1)]); e.target.blur() }
  }
  $effect(() => {
    if (!open) return
    const h = (e) => { if (root && !root.contains(e.target)) { open = false; q = '' } }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  })
</script>

<div class="ss" bind:this={root} style="position:relative">
  <input {id} class="ss-in" {disabled} autocomplete="off"
    value={open ? q : (sel?.label ?? '')}
    placeholder={placeholder}
    onmousedown={(e) => { e.preventDefault(); e.target.focus(); toggle() }}
    oninput={(e) => { q = e.target.value; open = true; active = 0 }}
    onkeydown={onKey} />
  <span class="ss-chev" class:open use:clickable={toggle} aria-hidden="true">▾</span>
  {#if open && !disabled}
    <div class="ss-list">
      {#each shown as o, i (i)}
        <div class="ss-opt" class:sel={o.value === value} class:active={i === active} role="option" aria-selected={o.value === value} tabindex="0" use:clickable onclick={() => pick(o)} onmousemove={() => (active = i)}>{o.label}</div>
      {/each}
      {#if filtered.length === 0}<div class="ss-empty">no match</div>{/if}
      {#if filtered.length > CAP}<div class="ss-empty">…and {filtered.length - CAP} more — keep typing to narrow</div>{/if}
    </div>
  {/if}
</div>

<style>
  .ss-in { width: 100%; padding-right: 26px; }
  /* ▾ affordance so the field reads as a dropdown, not a bare search box. */
  .ss-chev {
    position: absolute; right: 9px; top: 50%; transform: translateY(-50%);
    color: var(--muted); font-size: 11px; pointer-events: auto; cursor: pointer;
    transition: transform .15s; user-select: none;
  }
  .ss-chev.open { transform: translateY(-50%) rotate(180deg); }
  .ss-list {
    position: absolute; z-index: 60; top: calc(100% + 2px); left: 0; right: 0;
    max-height: 280px; overflow: auto;
    background: var(--surface); border: 1px solid var(--line-2); border-radius: 8px;
    box-shadow: var(--sh); padding: 4px;
  }
  .ss-opt { padding: 5px 9px; border-radius: 6px; cursor: pointer; font-size: 13px; white-space: nowrap; }
  .ss-opt:hover, .ss-opt.active { background: var(--line); }
  .ss-opt.sel { background: var(--accent); color: #fff; }
  .ss-empty { padding: 6px 9px; color: var(--muted); font-size: 12px; }
</style>
