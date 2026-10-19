<script>
  /** "What you are building": the sentence, the wiring list, what Apply will do, and whether it fits. */
  import { StateDot } from '../../../ui/index.js'
  import { blank } from '../../../../lib/templates.js'

  let { tpl, sel, relays, preview, previewErr, drawIns, drawOuts, logic, short, remoteShort, name } = $props()

  const label = (f) => f.replace(/\s*[(/:].*$/, '')
  const where = (o) => (o ? [o.module, o.pin?.label ?? o.tag].filter(Boolean).join(' ') : '')
  const ins = $derived(drawIns.filter((x) => x.opt))
  const outs = $derived(drawOuts.filter((x) => x.opt))
  const settings = $derived(tpl.fields.filter((f) => f.t === 'number' && !blank(sel[f.k])).map((f) => `${label(f.label)} ${sel[f.k]}`))
  const flags = $derived(tpl.fields.filter((f) => f.t === 'check' && sel[f.k]).map((f) => label(f.label)))
  const remoteIns = $derived(drawIns.filter((x) => x.opt && x.opt.local === false))
  const fits = $derived(!logic ? null : short.length || remoteShort.length ? 'warn' : 'ok')
  const wiring = $derived([
    ...ins.filter((x) => x.opt.pin).map((x) => ({ what: label(x.label), pin: where(x.opt) })),
    ...ins.filter((x) => !x.opt.pin).map((x) => ({ what: label(x.label), pin: x.opt.local === false ? `${x.opt.module} · over CAN` : 'a signal, no wire' })),
    ...outs.flatMap((x) => (relays[x.k]
      ? [{ what: `${label(x.label)}: relay coil`, pin: where(x.opt) }, { what: `${label(x.label)}: load`, pin: 'relay contact 87, fused +12 V on 30' }]
      : [{ what: `${label(x.label)} ${x.opt.side === 'low' ? '(switches to ground)' : '+'}`, pin: where(x.opt) }])),
  ])
</script>

<aside class="pv" aria-label="Preview" data-testid="wizard-preview">
  <span class="eyebrow">WHAT YOU ARE BUILDING</span>
  <div class="sentence" data-testid="wizard-sentence">
    {#if ins.length || outs.length}
      <strong>{name || tpl.name}</strong>:
      {#if ins.length}when {#each ins as x, i}{i ? (i === ins.length - 1 ? ' or ' : ', ') : ''}<strong>{label(x.label)}</strong> <span class="mono muted">({where(x.opt)})</span>{/each}{:else}always{/if}
      → {#each outs as x, i}{i ? ', ' : ''}<strong>{label(x.label)}</strong> <span class="mono muted">({where(x.opt)})</span>{:else}{tpl.fields.some((f) => f.t === 'module') ? 'retry every tripped output' : 'pick an output'}{/each}.
      {#if settings.length || flags.length}<span class="muted"> {[...settings, ...flags].join(' · ')}.</span>{/if}
    {:else}
      <span class="muted">Pick outputs and inputs and the sentence appears here.</span>
    {/if}
  </div>

  <span class="eyebrow">WIRING</span>
  <div class="wires">
    {#each wiring as w}<div class="w"><span>{w.what}</span><span class="mono muted">{w.pin}</span></div>
    {:else}<span class="muted">Nothing picked yet.</span>{/each}
  </div>

  <span class="eyebrow">APPLY WILL</span>
  <ul class="will">
    {#each remoteIns as x}<li>add a CAN input on <b>{logic?.name}</b> that reads <b>{x.opt.module}</b> {x.opt.sig?.label ?? x.opt.sig?.name} (reuses one that already does)</li>{/each}
    {#each preview?.ops ?? [] as o}<li>create {o.op === 'virtual' ? 'a combination' : o.op === 'wiper' ? 'the wiper block' : o.op === 'retryall' ? 'the module’s' : 'a ' + o.op} <b>{o.name}</b> <span class="muted">({o.detail})</span></li>{/each}
    {#each preview?.wires ?? [] as w}{@const d = drawOuts.find((x) => x.num === w.out)}<li>wire <b>{d?.opt ? [d.opt.module, d.opt.pin?.label, d.opt.name].filter(Boolean).join(' · ') : 'output ' + w.out}</b>{w.pwm ? ' (PWM duty)' : ''}{relays[d?.k] ? ', through a relay' : ''}</li>{/each}
    {#if !preview && !previewErr}<li class="muted">Nothing to write yet.</li>{/if}
    {#if previewErr}<li class="muted">Not buildable yet: {previewErr}</li>{/if}
  </ul>

  <span class="grow"></span>
  {#if fits}
    <span class="fits" role="status" data-testid="wizard-fits">
      <StateDot tone={fits === 'ok' ? 'ok' : 'warn'} shape={fits === 'ok' ? 'dot' : 'triangle'}
        label={fits === 'ok' ? `Fits on ${logic.name}: enough blocks free` : `Does not fit on ${logic.name}: ${[...short, ...remoteShort].join(', ')}`} />
    </span>
  {/if}
</aside>

<style>
  .pv { align-self: start; position: sticky; top: var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); }
  .eyebrow { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .sentence { padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); line-height: 1.6; }
  .wires { display: flex; flex-direction: column; gap: 6px; font-size: var(--text-sm); }
  .w { display: flex; gap: var(--space-3); justify-content: space-between; }
  .w span:last-child { text-align: right; }
  .will { margin: 0; padding-left: var(--space-5); font-size: var(--text-sm); display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
  .grow { flex: 1 1 auto; }
  .fits { font-size: var(--text-sm); }
  @media (max-width: 900px) { .pv { position: static; } }
</style>
