<script>
  /**
   * Plain-text code editor: textarea with a line-number gutter and monospace text.
   * `marks` = { [lineNumber]: { symbol, word, tone: 'fault' | 'warn' } } shown in the gutter (symbol + hidden word).
   * `goTo(line)` selects that line and scrolls it into view. Tab inserts two spaces, Enter keeps the indent.
   */
  let { value = $bindable(''), marks = {}, label = 'Script text', readonly = false, minHeight = 360 } = $props()
  let ta = $state(null)
  let gutter = $state(null)
  const lineCount = $derived(value.split('\n').length)
  const lines = $derived(Array.from({ length: lineCount }, (_, i) => i + 1))

  function sync() { if (gutter && ta) gutter.scrollTop = ta.scrollTop }

  export function goTo(line) {
    if (!ta) return
    const rows = value.split('\n')
    const n = Math.max(1, Math.min(line, rows.length))
    let start = 0
    for (let i = 0; i < n - 1; i++) start += rows[i].length + 1
    ta.focus()
    ta.setSelectionRange(start, start + rows[n - 1].length)
    ta.scrollTop = Math.max(0, (n - 4) * 20)
    sync()
  }

  function insertText(str) {
    ta.focus()
    let ok = false
    try { ok = document.execCommand('insertText', false, str) } catch { ok = false }
    if (!ok) {
      const s = ta.selectionStart, e = ta.selectionEnd
      value = value.slice(0, s) + str + value.slice(e)
      queueMicrotask(() => { ta.selectionStart = ta.selectionEnd = s + str.length })
    }
  }
  function onKeydown(e) {
    if (readonly) return
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insertText('  ') }
    else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const pos = ta.selectionStart
      const lineStart = value.lastIndexOf('\n', pos - 1) + 1
      const indent = (value.slice(lineStart, pos).match(/^[ \t]*/) || [''])[0]
      insertText('\n' + indent)
    }
  }
</script>

<div class="ed" style="min-height: {minHeight}px">
  <div class="gut" bind:this={gutter} aria-hidden="true">
    {#each lines as n (n)}
      {@const m = marks[n]}
      <div class="ln" data-tone={m?.tone}><span class="mk">{m?.symbol ?? ''}</span><span class="nn">{n}</span></div>
    {/each}
  </div>
  <textarea bind:this={ta} bind:value aria-label={label} {readonly} spellcheck="false" wrap="off" autocomplete="off" autocapitalize="off"
    onscroll={sync} onkeydown={onKeydown} data-testid="lua-text"></textarea>
</div>
{#if Object.keys(marks).length}
  <ul class="sr-only">{#each Object.entries(marks) as [n, m] (n)}<li>Line {n}: {m.word}</li>{/each}</ul>
{/if}

<style>
  .ed { display: flex; border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-raised); overflow: hidden; height: 460px; }
  .gut { flex: none; width: 64px; overflow: hidden; padding: 10px 0; background: var(--color-surface); border-right: 1px solid var(--color-line); font-family: var(--font-mono); font-size: 13px; line-height: 20px; text-align: right; user-select: none; }
  .ln { height: 20px; display: flex; justify-content: flex-end; gap: 6px; padding-right: 8px; color: var(--color-text-muted); }
  .ln[data-tone='fault'] { background: var(--color-fault-soft); color: var(--color-fault); font-weight: 700; }
  .ln[data-tone='warn'] { background: var(--color-warn-soft); color: var(--color-warn); font-weight: 700; }
  .mk { width: 14px; text-align: center; }
  textarea { flex: 1 1 auto; min-width: 0; border: 0; resize: none; padding: 10px 12px; background: transparent; color: var(--color-text); font-family: var(--font-mono); font-size: 13px; line-height: 20px; white-space: pre; overflow: auto; tab-size: 2; }
  textarea:focus-visible { outline: 3px solid var(--color-focus); outline-offset: -3px; }
</style>
