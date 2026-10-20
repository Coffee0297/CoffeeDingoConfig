// ui-mod: project lifecycle on firmware 5.7 — re-opening a saved project, the project folder, the module page on a phone.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, waitFor, deviceByName } from './api.js'
import { forceRestoreProject } from './a-util.js'

const menu = (page) => page.getByRole('dialog', { name: 'Project' })
async function openMenu(page) {
  await page.getByTestId('project-chip').click()
  await expect(menu(page)).toBeVisible()
}
const stamp = () => 'zz-e2e-' + Date.now().toString(36)
const limitOf = async (name, n = 0) => (await apiJson('GET', '/api/project/download')).PdmDevices.find((d) => d.name === name).outputs[n].currentLimit

test('a re-opened 5.7 project: Apply says it reads the module first and writes the file\'s value, not the module\'s @exclusive', async ({ page }) => {
  test.setTimeout(420_000)
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const file = stamp()
  const p0 = await apiJson('GET', '/api/project')
  try {
    await apiJson('POST', `/api/devices/${(await deviceByName('PDM-04')).guid}/burn`, undefined, 60_000).catch(() => null)   // nothing left written-not-stored
    await apiJson('POST', '/api/project/save', { FileName: file + '.json' })
    // an edit made in the file while away from the car: one amp less on PDM-04 output 1
    const path = `${p0.dir}/${file}.json`
    const doc = JSON.parse(fs.readFileSync(path, 'utf8'))
    const rec = doc.PdmDevices.find((d) => d.name === 'PDM-04')
    const want = rec.outputs[0].currentLimit - 1
    rec.outputs[0].currentLimit = want
    fs.writeFileSync(path, JSON.stringify(doc, null, 2))
    await apiJson('POST', '/api/project/new')   // away from the car: nothing open
    await page.reload()

    await openMenu(page)
    await menu(page).getByTestId('proj-open').click()
    await menu(page).getByRole('group', { name: /Project files/ }).getByRole('button', { name: new RegExp(file) }).click()
    await waitFor(async () => (await apiJson('GET', '/api/project')).current === file + '.json' && (await devices()).length >= 7, 15_000, 'file opened')
    await waitFor(async () => (await devices()).filter((d) => /pdm|canboard/i.test(d.type)).every((d) => d.connected && d.version), 30_000, 'modules answering with their version')
    // the modules saying which firmware they run is no edit: the project stays saved
    await expect(page.getByTestId('project-chip')).toContainText(file)
    await page.waitForTimeout(2000)
    await expect(page.getByTestId('project-chip')).not.toContainText('unsaved')
    expect((await deviceByName('PDM-04')).paramsRead).toBe(false)

    await page.getByRole('button', { name: /Apply to car/ }).first().click()
    const card = page.getByTestId('apply-PDM-04')
    await expect(card.getByTestId('apply-reads-first')).toContainText('Apply reads PDM-04 first')
    await card.getByRole('button', { name: 'Apply PDM-04' }).click()
    await page.getByRole('button', { name: 'Yes, write now' }).click()
    await expect(card).toContainText('Written, not stored', { timeout: 180_000 })
    expect(await limitOf('PDM-04')).toBeCloseTo(want, 3)
    // read it back from the module: it took the file's value
    const d = await deviceByName('PDM-04')
    await apiJson('POST', `/api/devices/${d.guid}/read`)
    await waitFor(async () => !(await deviceByName('PDM-04')).reading, 90_000, 'read back')
    expect(await limitOf('PDM-04')).toBeCloseTo(want, 3)
  } finally {
    await forceRestoreProject()
    const d = await deviceByName('PDM-04')
    await apiJson('POST', `/api/devices/${d.guid}/writeall`, undefined, 180_000).catch(() => null)   // the fixture's value back on the module
    await apiJson('POST', `/api/devices/${d.guid}/burn`, undefined, 60_000).catch(() => null)
    try { fs.unlinkSync(`${p0.dir}/${file}.json`) } catch { /* gone */ }
  }
  expect(errors).toEqual([])
})

test('the project folder can be changed from the Open list, a relative path is refused, and Save then asks for a name @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const was = (await apiJson('GET', '/api/project')).dir
  const other = `${was}/${stamp()}`
  try {
    await openMenu(page)
    await menu(page).getByTestId('proj-open').click()
    await menu(page).getByTestId('proj-folder').click()
    const field = menu(page).getByRole('textbox', { name: 'Project folder' })
    await expect(field).toHaveValue(was)
    await field.fill('just-a-name')
    await menu(page).getByTestId('proj-folder-go').click()
    await expect(menu(page).getByRole('alert')).toContainText('full path')
    expect((await apiJson('GET', '/api/project')).dir).toBe(was)

    await field.fill(other)
    await menu(page).getByTestId('proj-folder-go').click()
    await expect(menu(page).getByRole('status').last()).toContainText('Project folder:')
    await expect(menu(page).getByText('Project files (0)')).toBeVisible()
    await expect(menu(page).getByText('No project files in the folder yet.')).toBeVisible()
    expect(fs.existsSync(other)).toBe(true)
    // the open project stays open, but Save no longer overwrites a file of the same name in the new folder
    await expect(menu(page).getByTestId('proj-save')).toContainText('Asks for a file name first')
    expect((await apiJson('GET', '/api/project')).current).toBeFalsy()
    expect((await devices()).length).toBeGreaterThanOrEqual(7)

    await menu(page).getByTestId('proj-folder').click()
    await field.fill(was)
    await menu(page).getByTestId('proj-folder-go').click()
    await expect(menu(page).getByText(/Project files \([1-9]/)).toBeVisible()
  } finally {
    await apiJson('POST', '/api/project/folder', { Dir: was })
    try { fs.rmSync(other, { recursive: true }) } catch { /* not made */ }
  }
  expect((await apiJson('GET', '/api/project')).dir).toBe(was)
  expect(errors).toEqual([])
})

test('the module page on a phone: the outputs list fits the screen and every output opens', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const d = await deviceByName('PDM-04')
  await page.goto(`/#/next/hardware/module/${d.guid}`)   // the phone has no side rail: no open() here
  await expect(page.getByTestId('connection-pill')).toContainText(/live/i, { timeout: 20_000 })
  const row = page.getByTestId('out-1')
  await row.scrollIntoViewIfNeeded()
  const open1 = row.getByRole('link', { name: /Open output 1/ })
  await expect(open1).toBeVisible()
  const box = await open1.boundingBox()
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await open1.click()
  await expect(page).toHaveURL(new RegExp(`module/${d.guid}/output/1`))
  expect(errors).toEqual([])
})
