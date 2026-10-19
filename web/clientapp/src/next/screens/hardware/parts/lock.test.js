import assert from 'node:assert/strict'
import { parsePassword, contactProblem, lockSummary } from './lock.js'

assert.deepEqual(parsePassword('305419896'), { value: 0x12345678 })
assert.deepEqual(parsePassword(' 0x12345678 '), { value: 0x12345678 })
assert.deepEqual(parsePassword('4294967295'), { value: 0xffffffff })
assert.ok(parsePassword('4294967296').error)
assert.ok(parsePassword('0').error)
assert.ok(parsePassword('').error)
assert.ok(parsePassword('abc').error)
assert.ok(parsePassword('-5').error)

assert.equal(contactProblem('Ann Smith 0123 456789'), '')
assert.equal(contactProblem('x'.repeat(32)), '')
assert.ok(contactProblem('x'.repeat(33)))
assert.ok(contactProblem('Zoë'))

assert.equal(lockSummary({ name: 'P', lock: null }), null)
assert.equal(lockSummary({ name: 'P' }), null)
assert.match(lockSummary({ name: 'P', family: 'upstream', lock: { has: true, locked: true, contact: 'Call Ann' } }).text, /Call Ann/)
assert.equal(lockSummary({ name: 'P', family: 'upstream', lock: { has: true, locked: false, passwordSet: true } }).title, 'Password set in the project')
assert.equal(lockSummary({ name: 'P', family: 'upstream', lock: { has: true, locked: false, passwordSet: false } }).title, 'Not locked')
assert.equal(lockSummary({ name: 'P', family: 'fork', lock: { has: true, locked: true } }), null)
console.log('lock.test.js ok')
