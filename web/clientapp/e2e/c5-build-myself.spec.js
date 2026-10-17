// "Build it myself" from the function setup: the template's inputs and outputs are set up, the logic is yours.
// Blocks: the flow builder opens on the function's page with the input and the output on it (spare PDM-05 o8).
// Lua: the output follows a free Lua Out and a stub that reads the input is added to the module's Lua (spare
// PDM-03 o8, with a small program of its own). Puts the outputs, pins and Lua back.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { putOutput } from './b-helpers.js'

test.describe.configure({ timeout: 240_000 })

async function wizardTo(page, button, mod) {
  await open(page, 'functions/setup/simple')
  await page.getByTestId('pick-output').fill(`${mod} o8`)
  await page.getByRole('option', { name: new RegExp(`${mod} · .*OUT8`) }).first().click()
  await page.getByTestId('wz-next').click()
  await page.getByTestId('pick-input').fill('CB-1')
  await page.getByRole('option').first().click()
  await page.getByTestId('wz-next').click()
  const name = page.getByTestId('fn-name')
  if (await name.count()) await name.fill('c5 my own')
  while (await page.getByTestId('wz-next').count()) await page.getByTestId('wz-next').click()
  await page.getByTestId(button).click()
}

test('build it myself in blocks or in Lua: the inputs and outputs are ready, the logic is not @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const p5 = await deviceByName('PDM-05'), p3 = await deviceByName('PDM-03')
  const o8 = JSON.parse(JSON.stringify(p5.outputs.find((o) => o.number === 8)))
  const o8b = JSON.parse(JSON.stringify(p3.outputs.find((o) => o.number === 8)))
  const luaBefore = (await apiJson('GET', `/api/devices/${p3.guid}/lua?stored=true`)).source ?? ''
  const fnsBefore = { [p5.guid]: await apiJson('GET', `/api/devices/${p5.guid}/functions`), [p3.guid]: await apiJson('GET', `/api/devices/${p3.guid}/functions`) }
  try {
    // a small program of its own: the stub must fit, and the program must be kept
    await apiJson('POST', `/api/devices/${p3.guid}/lua`, { Source: '-- c5 keep\nfunction onTick()\nend\n' }, 120_000)
    // blocks: the function's page with the output and the input on the canvas
    await wizardTo(page, 'wz-self-blocks', 'PDM-05')
    await expect(page.getByTestId('fn-title')).toHaveText(/c5 my own|Simple/, { timeout: 30_000 })
    const canvas = page.getByTestId('canvas')
    await expect(canvas.locator('.svelte-flow__node[data-id="output:8"]')).toBeVisible({ timeout: 20_000 })
    expect(await canvas.locator('.svelte-flow__node').count()).toBeGreaterThanOrEqual(2)
    expect((await deviceByName('PDM-05')).outputs.find((o) => o.number === 8).inputVal).toBe(o8.inputVal)   // not wired: that is yours
    // lua: o8 follows a Lua Out, the stub reads the input and sets it
    await wizardTo(page, 'wz-self-lua', 'PDM-03')
    await expect(page).toHaveURL(new RegExp(`expert/lua/${p3.guid}`), { timeout: 60_000 })
    const lua = (await apiJson('GET', `/api/devices/${p3.guid}/lua?stored=true`)).source
    expect(lua.startsWith('-- c5 keep')).toBe(true)                  // the existing program is kept
    const m = lua.match(/setLuaOut\((\d+), 0\)\s+-- Lua Out (\d+)/)
    expect(m).toBeTruthy()
    expect(+m[2]).toBe(+m[1] + 1)
    expect(lua).toMatch(/local function fn_[a-z0-9_]+\(\)/)
    expect(lua).toMatch(/readVar\(\d+\)/)
    const vmap = await apiJson('GET', `/api/devices/${p3.guid}/inputs`)
    await waitFor(async () => {
      const now = (await deviceByName('PDM-03')).outputs.find((o) => o.number === 8).inputVal
      return vmap.find((v) => v.index === now)?.name === `Lua Out ${m[2]}`
    }, 20_000, 'o8 follows the Lua Out')
  } finally {
    await apiJson('POST', `/api/devices/${p3.guid}/lua`, { Source: luaBefore }, 120_000).catch(() => {})
    await putOutput(p5.guid, o8).catch(() => {})
    await putOutput(p3.guid, o8b).catch(() => {})
    for (const g of [p5.guid, p3.guid]) {
      const now = await apiJson('GET', `/api/devices/${g}/functions`)
      for (const [arr, kind] of [['canInputs', 'caninput'], ['inputs', 'input']])
        for (const r of fnsBefore[g][arr] ?? []) {
          const c = (now[arr] ?? []).find((x) => x.number === r.number)
          if (c && JSON.stringify(c) !== JSON.stringify(r)) await apiJson('POST', `/api/devices/${g}/function/${kind}/${r.number}`, r).catch(() => {})
        }
      await apiJson('POST', `/api/devices/${g}/writeall`, undefined, 60_000).catch(() => {})
    }
  }
  expect(errors).toEqual([])
})
