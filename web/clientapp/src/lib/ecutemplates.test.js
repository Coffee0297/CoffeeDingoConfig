// node src/lib/ecutemplates.test.js — every shipped ECU template parses, names real signals for its roles, and each
// role signal is one a module CAN input can read (1..32 bits inside an 8-byte frame, 11-bit id).
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { ECU_TEMPLATES, ROLES } from './ecutemplates.js'

const dir = new URL('./ecu-dbc/', import.meta.url)
const parse = (text) => {
  const sigs = []
  let id = null
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    const bo = /^BO_ (\d+) /.exec(line)
    if (bo) id = +bo[1]
    const sg = /^SG_ (\w+) : (\d+)\|(\d+)@([01])([+-]) \(([^,]+),([^)]+)\)/.exec(line)
    if (sg) sigs.push({ id, name: sg[1], start: +sg[2], len: +sg[3], intel: sg[4] === '1' })
  }
  return sigs
}
// The frame bits a signal covers (0..63 means it fits), walked like the firmware's DecodeLE/DecodeBE.
const bits = (s) => {
  const out = []
  if (s.intel) for (let k = 0; k < s.len; k++) out.push(s.start + k)
  else for (let k = 0, b = s.start; k < s.len; k++) { out.push(b); b = b % 8 === 0 ? b + 15 : b - 1 }
  return out
}

const files = readdirSync(dir).filter((f) => f.endsWith('.dbc'))
assert.ok(files.length >= 4)
for (const t of ECU_TEMPLATES) assert.ok(files.includes(t.file), `${t.key}: ${t.file} is shipped`)
for (const f of files) {
  const text = readFileSync(new URL(f, dir), 'utf8')
  assert.match(text, /CM_ "Sources?: /, `${f} cites its sources`)
  const sigs = parse(text)
  assert.ok(sigs.length, `${f} has signals`)
  for (const s of sigs) {
    assert.ok(s.id <= 0x7ff, `${f} ${s.name}: 11-bit id`)
    assert.ok(s.len >= 1 && s.len <= 32, `${f} ${s.name}: 1..32 bits`)
    assert.ok(bits(s).every((b) => b >= 0 && b < 64), `${f} ${s.name}: inside 8 bytes`)
  }
  for (const t of ECU_TEMPLATES.filter((x) => x.file === f))
    for (const r of ROLES) assert.ok(sigs.some((s) => s.name === t.roles[r.key][0]), `${t.key}: ${r.key} signal ${t.roles[r.key][0]} exists`)
}
// The Motorola walk: a 16-bit big-endian value in bytes 0..1 has its MSB at bit 7 and its LSB at bit 8.
assert.deepEqual(bits({ start: 7, len: 16, intel: false }).slice(0, 1).concat(bits({ start: 7, len: 16, intel: false }).slice(-1)), [7, 8])
console.log('ecutemplates.test.js: ok')
