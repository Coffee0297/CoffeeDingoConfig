<script>
  // Pull a signal off the bus onto THIS module as a source. Lists another module's broadcast frames
  // (/broadcast-signals) or an ECU/DBC's signals (/dbc/search), and on pick creates a local CAN input
  // that decodes the frame — then emits its new varmap index via onadded(). Drop it next to any local
  // source picker so DBC + cross-module signals are selectable everywhere, not just Signals & logic.
  import { api, addCanInputFromDbc, addCanInputFromBroadcast } from './store.js'
  import { toast } from './toast.js'
  import { clickable } from './a11y.js'

  let { guid, devices = [], kind = 'num', onadded = undefined, label = '＋ from another module / ECU' } = $props()

  let open = $state(false)
  let src = $state('')        // source device guid
  let q = $state('')          // search filter
  let hits = $state([])       // normalised list: {name, meta, isDbc, sig}
  let busy = $state(false)
  let adding = $state('')     // name being added (disables the row)

  const sources = $derived((devices ?? []).filter((d) => d.guid !== guid))
  const srcDev = $derived(sources.find((d) => d.guid === src) ?? null)
  const isDbc = $derived(/dbc/i.test(srcDev?.type || ''))
  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase()

  function openPanel() { open = true; if (!src) src = sources[0]?.guid ?? '' }

  // Load (and filter) the chosen source's signals. DBC searches server-side (huge counts); a module's
  // broadcast list is small enough to fetch once and filter client-side.
  $effect(() => {
    if (!open || !src) { hits = []; return }
    const dbc = isDbc, g = src, term = q, dev = srcDev
    let alive = true; busy = true
    const done = (list) => { if (alive) { hits = list; busy = false } }
    if (dbc) {
      api.dbcSearch(g, term, 60)
        .then((r) => done((r.items ?? []).map((s) => ({ name: s.name, meta: `${hex(s.id)} · ${s.length}b${s.unit ? ' · ' + s.unit : ''}`, isDbc: true, sig: s }))))
        .catch(() => done([]))
    } else {
      api.broadcastSignals(g)
        .then((s) => {
          const t = term.trim().toLowerCase()
          const list = (Array.isArray(s) ? s : [])
            .filter((x) => !t || (x.name + ' ' + (x.unit || '')).toLowerCase().includes(t))
            .slice(0, 200)
            .map((x) => ({ name: x.name, meta: `${hex((dev?.baseId ?? 0) + x.offset)} · ${x.bitLength}b · ${x.kind}${x.unit ? ' · ' + x.unit : ''}`, isDbc: false, sig: x }))
          done(list)
        })
        .catch(() => done([]))
    }
    return () => { alive = false }
  })

  async function add(h) {
    adding = h.name
    try {
      const r = h.isDbc ? await addCanInputFromDbc(guid, h.sig) : await addCanInputFromBroadcast(guid, srcDev, h.sig)
      const idx = kind === 'bool' ? (r.stateIndex ?? r.valueIndex) : (r.valueIndex ?? r.stateIndex)
      if (idx == null) throw new Error('created the CAN input but could not resolve its signal index')
      onadded?.(idx, r)
      toast(`Added CAN input “${r.name}” decoding ${h.meta.split(' · ')[0]} — set it as the source.`, 'info')
      open = false; q = ''
    } catch (e) { toast('Couldn’t add: ' + e.message, 'error') }
    finally { adding = '' }
  }
</script>

{#if sources.length}
  {#if !open}
    <button type="button" class="linkbtn" onclick={openPanel}>{label}</button>
  {:else}
    <div class="rsa">
      <div class="rsa-row">
        <select bind:value={src}>
          {#each sources as d}<option value={d.guid}>{d.name}{d.type && /dbc/i.test(d.type) ? ' (ECU)' : ''}</option>{/each}
        </select>
        <input placeholder={isDbc ? 'search ECU signal…' : 'filter…'} bind:value={q} />
        <button type="button" class="x" aria-label="Close" onclick={() => { open = false; q = '' }}>✕</button>
      </div>
      <div class="rsa-list">
        {#each hits as h (h.name + h.meta)}
          <div class="rsa-opt" class:busy={adding === h.name} use:clickable onclick={() => add(h)}>
            <span class="nm">{h.name}</span><span class="mt">{h.meta}</span>
          </div>
        {/each}
        {#if busy}<div class="rsa-empty">loading…</div>
        {:else if !hits.length}<div class="rsa-empty">{q ? 'no match' : (isDbc ? 'type to search' : 'no broadcast signals')}</div>{/if}
      </div>
      <p class="rsa-hint">Creates a CAN input on this module that decodes the selected frame, then uses it as the source.</p>
    </div>
  {/if}
{/if}

<style>
  .rsa { border: 1px solid var(--line-2); border-radius: var(--r-sm, 8px); padding: 8px; margin: 4px 0; background: var(--surface-2); }
  .rsa-row { display: flex; gap: 6px; align-items: center; }
  .rsa-row select { flex: 1; min-width: 0; }
  .rsa-row input { flex: 1; min-width: 0; }
  .rsa-row .x { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 13px; padding: 2px 4px; }
  .rsa-list { max-height: 220px; overflow: auto; margin-top: 6px; border: 1px solid var(--line); border-radius: 6px; }
  .rsa-opt { display: flex; justify-content: space-between; gap: 8px; padding: 5px 9px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--line); }
  .rsa-opt:last-child { border-bottom: 0; }
  .rsa-opt:hover { background: var(--line); }
  .rsa-opt.busy { opacity: .5; pointer-events: none; }
  .rsa-opt .mt { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .rsa-empty { padding: 6px 9px; color: var(--muted); font-size: 12px; }
  .rsa-hint { color: var(--muted); font-size: 11px; margin: 6px 2px 0; }
</style>
