// "Learn a switch": find the CAN bit that followed a switch the operator flipped a few times.
// Fed with the backend's change history (GET /api/canlog/changes, G17: every data change per id with its time),
// or with snapshots of /api/canlog ([{ dir, id, ide, data: '22 00 ..', count }]). Pure functions: no DOM, no network.

const bytesOf = (data) => String(data ?? '').trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16)).filter((v) => Number.isFinite(v))
const spaced = (hex) => String(hex ?? '').replace(/(..)(?!$)/g, '$1 ')   // 'AA0B' -> 'AA 0B'
const keyOf = (e) => (e.ide ? 'x' : '') + e.id

export function createLearner() {
  const ids = new Map()   // key -> { id, ide, last: number[], bits: Map<bitIndex, { n, lastT, value }>, frames, seen }
  let startT = null, lastT = 0, polls = 0

  return {
    /** Add one snapshot taken at time t (ms). */
    feed(entries, t) {
      if (startT === null) startT = t
      lastT = t; polls++
      for (const e of entries ?? []) {
        if (e.dir && e.dir !== 'Rx') continue
        const b = bytesOf(e.data)
        if (!b.length) continue
        const k = keyOf(e)
        let s = ids.get(k)
        if (!s) { s = { id: e.id, ide: !!e.ide, last: b, bits: new Map(), frames: e.count ?? 0, firstCount: e.count ?? 0, seen: 1 }; ids.set(k, s); continue }
        s.frames = e.count ?? s.frames
        s.seen++
        const len = Math.min(b.length, s.last.length)
        for (let i = 0; i < len; i++) {
          const diff = b[i] ^ s.last[i]
          if (!diff) continue
          for (let bit = 0; bit < 8; bit++) {
            if (!(diff & (1 << bit))) continue
            const idx = i * 8 + bit
            const st = s.bits.get(idx) ?? { n: 0, lastT: t, value: 0, start: (s.last[i] >> bit) & 1, trace: [] }
            st.n++; st.lastT = t; st.value = (b[i] >> bit) & 1
            if (st.trace.length < 60) st.trace.push({ t, v: st.value })
            s.bits.set(idx, st)
          }
        }
        s.last = b
      }
    },
    /** Add change events { t, id, ext, dir, data: 'AA0B..', prev } (oldest first), then move the clock to `now`. */
    feedChanges(changes, now) {
      for (const c of changes ?? []) {
        const e = { dir: c.dir, id: c.id, ide: !!c.ext }
        // the frame before the first change seeds the comparison, so that first change counts too
        if (c.prev != null && !ids.has(keyOf(e))) this.feed([{ ...e, data: spaced(c.prev) }], c.t)
        this.feed([{ ...e, data: spaced(c.data) }], c.t)
      }
      this.tick(now)
    },
    /** Move the clock without data (the bus was quiet), so "held steady since" is measured to now. */
    tick(now) { if (startT === null) startT = now; if (now > lastT) lastT = now },
    stats() {
      let bits = 0
      for (const s of ids.values()) bits += s.bits.size
      return { polls, ids: ids.size, bits, seconds: startT === null ? 0 : (lastT - startT) / 1000 }
    },
    /**
     * Rank the bits. A switch bit changed a handful of times (a flip is one change) and then held steady.
     * Counters (several neighbouring bits all changing a lot) and noisy bits are listed but left out.
     */
    result() {
      const span = Math.max(1, lastT - (startT ?? lastT))
      const good = [], ignored = [], maybe = []
      for (const s of ids.values()) {
        // a byte whose low bits all change a lot is a counter or a measurement
        const busyByte = new Map()
        for (const [idx, st] of s.bits) if (st.n > 12) busyByte.set(Math.floor(idx / 8), (busyByte.get(Math.floor(idx / 8)) ?? 0) + 1)
        for (const [idx, st] of s.bits) {
          const byte = Math.floor(idx / 8), bit = idx % 8
          const hex = (s.ide ? '0x' : '0x') + s.id.toString(16).toUpperCase().padStart(3, '0')
          const base = { id: s.id, ide: s.ide, hex, bit: idx, startBit: idx, byte, bitInByte: bit, changes: st.n, final: st.value, start: st.start, trace: st.trace, t0: startT, t1: lastT }
          const steady = (lastT - st.lastT) >= Math.min(1200, span * 0.15)   // quiet for the last stretch
          if (st.n > 12) {
            const counter = (busyByte.get(byte) ?? 0) >= 3
            ignored.push({ ...base, kind: counter ? 'counter' : 'noisy' })
          } else if (st.n >= 3 && st.n <= 8) {
            good.push({ ...base, kind: 'best', score: 0.75 + (steady ? 0.2 : 0) + (st.n >= 4 && st.n <= 6 ? 0.05 : 0) })
          } else if (st.n >= 2) {
            maybe.push({ ...base, kind: 'maybe', score: 0.35 + (steady ? 0.1 : 0) })
          }
        }
      }
      const rank = [...good, ...maybe].sort((a, b) => b.score - a.score || a.id - b.id || a.bit - b.bit)
      const cands = rank.slice(0, 4).map((c, i) => ({ ...c, kind: i === 0 && c.kind === 'best' ? 'best' : 'maybe', percent: Math.round(Math.min(0.99, c.score) * 100) }))
      ignored.sort((a, b) => b.changes - a.changes)
      return { cands, ignored: ignored.slice(0, 2), changedBits: ids.size ? [...ids.values()].reduce((n, s) => n + s.bits.size, 0) : 0 }
    },
  }
}

/**
 * Which CAN input already reads a learned bit: [{ guid, mod, canInputs }] -> { guid, mod, number, name, exact }
 * or null. A 1-bit input on that exact bit wins; else an Intel-order field that covers the bit.
 */
export function findReader(modules, c) {
  let best = null
  for (const m of modules ?? []) {
    for (const x of m.canInputs ?? []) {
      if (!x.enabled || x.id !== c.id || !!x.ide !== !!c.ide) continue
      const exact = x.bitLength === 1 && x.startBit === c.startBit
      const covers = (x.byteOrder ?? 0) === 0 && x.startBit <= c.startBit && c.startBit < x.startBit + x.bitLength
      if (exact) return { guid: m.guid, mod: m.mod, number: x.number, name: x.name, exact: true }
      if (covers && !best) best = { guid: m.guid, mod: m.mod, number: x.number, name: x.name, exact: false }
    }
  }
  return best
}
