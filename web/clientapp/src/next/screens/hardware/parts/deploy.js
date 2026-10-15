// Deploy a project module's saved settings onto the module plugged into USB (same sequence as the old
// UI): write it, re-address it to the profile's base ID, burn it, then upload the Lua. Needs the module
// on USB to answer; the module on USB gets re-addressed, so a dropped link half way can leave it at the
// new ID while the project still has the old one (Find modules, then accept it at its new ID).
import { api } from '../../../lib/live.svelte.js'
import { luaForDeploy } from '../../../../lib/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hx = (n) => '0x' + n.toString(16).toUpperCase()

/**
 * @param src      the project module whose settings are deployed
 * @param usbBase  base ID the module on USB answers on now
 * @param devices  () => current device list (live)
 * @returns { luaOk, newBase }
 */
export async function deployToUsb(src, usbBase, devices) {
  const now = (pred) => devices().find(pred)
  const same = src.baseId === usbBase
  let made = null
  try {
    let tgt = same ? src : now((d) => d.guid !== src.guid && /pdm/i.test(d.type ?? '') && d.baseId === usbBase)
    if (!tgt) { // no project entry at the module's current ID yet: add a temporary one to talk to it
      made = (await api.addLike(src.guid, `USB module ${hx(usbBase)}`, hx(usbBase))).guid
      for (let i = 0; i < 40 && !(tgt = now((d) => d.guid === made))?.connected; i++) await sleep(250)
      if (!tgt) throw new Error('could not add a project entry for it')
    }
    if (!tgt.connected) throw new Error(`the module at ${hx(usbBase)} is not answering`)
    if (same) await api.action(src.guid, 'writeall')
    else await api.applyProfile(tgt.guid, src.guid)
    // After the re-address the module answers at src's ID: wait for it, then send the Lua through src's entry.
    for (let i = 0; i < 40 && !now((d) => d.guid === src.guid)?.connected; i++) await sleep(250)
    let luaOk = true
    try { const lua = await luaForDeploy(src.guid); if (lua.trim() && !(await api.luaUpload(src.guid, lua))?.written) luaOk = false } catch { luaOk = false }
    if (made) { await api.remove(made); made = null }
    const newBase = (await api.usbIdentify().catch(() => null))?.gatewayBaseId ?? src.baseId
    return { luaOk, newBase }
  } catch (e) {
    if (made) await api.remove(made).catch(() => {})
    throw e
  }
}
