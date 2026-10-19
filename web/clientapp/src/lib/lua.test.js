// deviceHasLua: which modules run Lua (fork PDMs; upstream PDMs only once they answered a Lua command).
import assert from 'node:assert/strict'
import { deviceHasLua } from './pinmap.js'

assert.equal(deviceHasLua('dingoPDM'), true)
assert.equal(deviceHasLua('CANBoard'), false)
assert.equal(deviceHasLua({ type: 'dingoPDM', family: 'fork' }), true)
assert.equal(deviceHasLua({ type: 'dingoPDM', family: 'upstream' }), false)
assert.equal(deviceHasLua({ type: 'dingoPDM', family: 'upstream', hasLua: true }), true)
assert.equal(deviceHasLua({ type: 'CANBoard', family: 'upstream', hasLua: true }), false)
assert.equal(deviceHasLua(undefined), true)   // unknown type: as before
console.log('lua.test.js ok')
