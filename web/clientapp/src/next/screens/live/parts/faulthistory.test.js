// node src/next/screens/live/parts/faulthistory.test.js
import assert from 'node:assert/strict'
import { upText, bootText, rows } from './faulthistory.js'

assert.equal(upText(3200), '3.2 s')
assert.equal(upText(245000), '4 min 05 s')
assert.equal(upText(7440000), '2 h 04 min')
assert.equal(bootText(5, 5), 'this boot')
assert.equal(bootText(4, 5), 'the boot before')
assert.equal(bootText(1, 5), '4 boots ago')
assert.equal(bootText(9, 0), 'boot 9')   // boot count not known
const r = rows([{ n: 0, output: 1, kind: 3, boot: 2, amps: 0, volts: 12.2, uptimeMs: 12500 }, { n: 1, output: 4, kind: 1, boot: 2, amps: 63, volts: 12.23, uptimeMs: 12400 }], 3, [{ number: 1, name: 'Fuel pump ' }])
assert.deepEqual(r.map((x) => [x.name, x.what, x.when]), [['Fuel pump', 'Latched off', 'the boot before · 12.5 s after power-on'], ['Output 4', 'Overcurrent', 'the boot before · 12.4 s after power-on']])
console.log('faulthistory.test OK')
