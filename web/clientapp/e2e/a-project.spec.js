// Project menu (project chip): Save, Save as, Open, New, download / upload, config export, unsaved dialog.
// Tests that write a project file only use names that start with zz-e2e- and are tagged @exclusive.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, waitFor } from './api.js'
import { FIXTURE, forceRestoreProject, restoreProject } from './a-util.js'

const menu = (page) => page.getByRole('dialog', { name: 'Project' })
const confirm = (page) => page.getByRole('alertdialog')
async function openMenu(page) {
  await page.getByTestId('project-chip').click()
  await expect(menu(page)).toBeVisible()
}
const stamp = () => 'zz-e2e-' + Date.now().toString(36)

test('the menu shows the project name, module count and the four file actions', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const proj = await apiJson('GET', '/api/project')
  const devs = await devices()
  await openMenu(page)
  await expect(menu(page).getByText(proj.current ? proj.current.replace(/\.json$/i, '') : 'Untitled car').first()).toBeVisible()
  await expect(menu(page)).toContainText(`${devs.length} modules`)
  for (const [id, k] of [['proj-save', 'Ctrl+S'], ['proj-saveas', 'Ctrl+Shift+S'], ['proj-open', 'Ctrl+O'], ['proj-new', 'Ctrl+N']]) await expect(menu(page).getByTestId(id)).toContainText(k)
  await expect(menu(page).getByTestId('proj-save')).toContainText(proj.current ? `Overwrites ${proj.current}` : 'Asks for a file name first')
  expect(errors).toEqual([])
})

test('Open lists the project files from the backend', async ({ page }) => {
  await open(page, 'hardware')
  const proj = await apiJson('GET', '/api/project')
  await openMenu(page)
  await menu(page).getByTestId('proj-open').click()
  await expect(menu(page).getByText(`Project files (${proj.files.length})`)).toBeVisible()
  const list = menu(page).getByRole('group', { name: /Project files/ })
  await expect(list.getByRole('button')).toHaveCount(proj.files.length)
  for (const f of proj.files.slice(0, 5)) await expect(list.getByRole('button', { name: f, exact: false }).first()).toBeVisible()
  // newest first, each with its module count and when it changed (G20)
  expect(proj.recent.map((r) => r.name).sort()).toEqual([...proj.files].sort())
  const ts = proj.recent.map((r) => Date.parse(r.modifiedAt))
  expect(ts.every(Number.isFinite), 'modifiedAt is ISO 8601').toBe(true)
  expect(ts).toEqual([...ts].sort((a, b) => b - a))
  if (proj.recent.length) {
    const top = proj.recent[0]
    await expect(list.getByRole('button').first()).toContainText(top.name)
    if (top.moduleCount != null) await expect(list.getByRole('button').first()).toContainText(`${top.moduleCount} module`)
    await expect(list.getByRole('button').first().locator('time')).toHaveAttribute('datetime', top.modifiedAt)
  }
  await menu(page).getByTestId('proj-open').click()
  await expect(list).toHaveCount(0)
})

test('Save as: a bad name is explained, an existing name needs a second press, nothing is written', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const before = await apiJson('GET', '/api/project')
  await openMenu(page)
  await menu(page).getByTestId('proj-saveas').click()
  const name = menu(page).getByRole('textbox', { name: 'File name' })
  await name.fill('')
  await menu(page).getByTestId('saveas-go').click()
  await expect(menu(page).getByText('Type a file name.')).toBeVisible()
  await name.fill('a/b')
  await menu(page).getByTestId('saveas-go').click()
  await expect(menu(page).getByText('Use letters, numbers, spaces, dashes and underscores only.')).toBeVisible()
  // an existing name: first press only warns (no overwrite)
  await name.fill(before.files[0].replace(/\.json$/i, ''))
  await menu(page).getByTestId('saveas-go').click()
  await expect(menu(page).getByText(/already exists\. Press Save again to replace it\./)).toBeVisible()
  await menu(page).getByRole('button', { name: 'Back' }).click()
  await expect(menu(page).getByTestId('proj-save')).toBeVisible()
  const after = await apiJson('GET', '/api/project')
  expect(after.current).toBe(before.current)
  expect(after.files).toEqual(before.files)
  expect(errors).toEqual([])
})

test('Ctrl+Shift+S, Ctrl+O and Ctrl+S (with no file yet) open the right view', async ({ page }) => {
  await open(page, 'hardware')
  const before = await apiJson('GET', '/api/project')
  await page.keyboard.press('Control+Shift+S')
  await expect(menu(page).getByTestId('saveas-go')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await page.keyboard.press('Control+o')
  await expect(menu(page).getByText(/Project files \(\d+\)/)).toBeVisible()
  await page.keyboard.press('Escape')
  if (!before.current) {
    await page.keyboard.press('Control+s')
    await expect(menu(page).getByTestId('saveas-go')).toBeVisible()
    await page.keyboard.press('Escape')
  }
  expect((await apiJson('GET', '/api/project')).files).toEqual(before.files)
})

test('Download a copy saves the whole project as a file on this PC', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openMenu(page)
  const [dl] = await Promise.all([page.waitForEvent('download'), menu(page).getByTestId('proj-download').click()])
  expect(dl.suggestedFilename()).toMatch(/\.json$/)
  const doc = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'))
  const devs = await devices()
  const count = (j) => ['PdmDevices', 'CanboardDevices', 'DbcDevices', 'BlinkMarineKeypads', 'GrayhillKeypads'].reduce((n, k) => n + (j[k]?.length ?? 0), 0)
  expect(count(doc)).toBe(devs.length)
  expect(doc.dingoConfigClient).toBeTruthy()
  await expect(menu(page).getByText(/Downloaded .*\.json to this PC/)).toBeVisible()
  expect(errors).toEqual([])
})

test('Export config and Export template download JSON; the two missing exports are off and say so', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openMenu(page)
  const [c] = await Promise.all([page.waitForEvent('download'), menu(page).getByRole('button', { name: 'Export config…' }).click()])
  expect(c.suggestedFilename()).toMatch(/-export\.json$/)
  const cfg = JSON.parse(fs.readFileSync(await c.path(), 'utf8'))
  expect(cfg.devices.length).toBe((await devices()).length)
  await expect(menu(page).getByText(/Exported \d+ modules? without Lua\./)).toBeVisible()
  const [t] = await Promise.all([page.waitForEvent('download'), menu(page).getByRole('button', { name: 'Export template…' }).click()])
  expect(t.suggestedFilename()).toBe('dingopdm-template.json')
  expect(JSON.parse(fs.readFileSync(await t.path(), 'utf8'))).toBeTruthy()
  await expect(menu(page).getByRole('button', { name: 'Export profile…' })).toBeDisabled()
  await expect(menu(page).getByRole('button', { name: 'Export combined DBC…' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('Import config rejects a file that is not JSON, and asks before applying a real one', async ({ page }) => {
  await open(page, 'hardware')
  await openMenu(page)
  const input = menu(page).getByLabel('Config file to import')
  await input.setInputFiles({ name: 'not-json.json', mimeType: 'application/json', buffer: Buffer.from('this is not json') })
  await expect(menu(page).getByText('not-json.json is not a JSON file.')).toBeVisible()
  await input.setInputFiles({ name: 'empty-config.json', mimeType: 'application/json', buffer: Buffer.from('{"devices":[]}') })
  await expect(confirm(page)).toContainText('Import empty-config.json?')
  await expect(confirm(page)).toContainText('Nothing is sent to the car until you apply.')
  await confirm(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm(page)).toHaveCount(0)
})

test('Open or New on a never-saved project warns first and Cancel changes nothing', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const proj = await apiJson('GET', '/api/project')
  const n = (await devices()).length
  // a project that is not saved (no file, or changed since) must warn; skip when the open project is clean
  const unsaved = !proj.current
  test.skip(!unsaved, 'the open project already has a file; the warning is covered by the exclusive test')
  await openMenu(page)
  await menu(page).getByTestId('proj-new').click()
  await expect(confirm(page)).toContainText('Save changes to Untitled car first?')
  await expect(confirm(page).getByRole('textbox', { name: 'File name to save as' })).toBeVisible()
  await confirm(page).getByTestId('dlg-cancel').click()
  await expect(confirm(page)).toHaveCount(0)
  expect((await devices()).length).toBe(n)
  await openMenu(page)
  await menu(page).getByTestId('proj-open').click()
  await menu(page).getByRole('group', { name: /Project files/ }).getByRole('button').first().click()
  await expect(confirm(page)).toContainText('If you open')
  await confirm(page).getByTestId('dlg-cancel').click()
  expect((await devices()).length).toBe(n)
  expect(errors).toEqual([])
})

test('Upload rejects a file that is not a project', async ({ page }) => {
  await open(page, 'hardware')
  const proj = await apiJson('GET', '/api/project')
  test.skip(!!proj.current, 'with a saved project the unsaved warning is skipped; covered by the exclusive upload test')
  await openMenu(page)
  await menu(page).getByTestId('proj-upload-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"nothing":true}') })
  // never-saved project: the warning comes first, Cancel leaves everything as is
  await expect(confirm(page)).toContainText('If you open bad.json')
  await confirm(page).getByTestId('dlg-cancel').click()
  expect((await devices()).length).toBeGreaterThan(0)
})

// ----- writes project files, replaces the project: run alone ---------------------------------------

test('Save as, Save (Ctrl+S) and the unsaved chip follow each other @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const file = stamp()
  try {
    await openMenu(page)
    await menu(page).getByTestId('proj-saveas').click()
    await menu(page).getByRole('textbox', { name: 'File name' }).fill(file)
    await menu(page).getByTestId('saveas-go').click()
    await waitFor(async () => (await apiJson('GET', '/api/project')).current === file + '.json', 10_000, 'file saved')
    const proj = await apiJson('GET', '/api/project')
    expect(proj.files).toContain(file + '.json')
    await expect(page.getByTestId('project-chip')).toContainText(file)
    await expect(page.getByTestId('project-chip')).not.toContainText('unsaved')
    // the saved file holds every module
    const copy = await apiJson('GET', '/api/project/download')
    expect(['PdmDevices', 'CanboardDevices', 'DbcDevices', 'BlinkMarineKeypads', 'GrayhillKeypads'].reduce((n, k) => n + (copy[k]?.length ?? 0), 0)).toBe((await devices()).length)
    // change something through the UI: the chip says unsaved, Ctrl+S saves and clears it
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Rename PDM-05' }).first().click()
    await page.getByTestId('row-PDM-05').getByLabel('Module name').fill('zz-e2e-chip')
    await page.getByTestId('row-PDM-05').getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('project-chip')).toContainText('unsaved')
    expect((await apiJson('GET', '/api/project')).dirty).toBe(true)
    await page.keyboard.press('Control+s')
    await expect(page.getByTestId('project-chip')).not.toContainText('unsaved', { timeout: 10_000 })
    expect((await apiJson('GET', '/api/project')).dirty).toBe(false)
    const saved = await apiJson('GET', '/api/project/download')
    expect(JSON.stringify(saved)).toContain('zz-e2e-chip')
    // a change made outside this page (another tab, the AI agent) shows too, and undoing it clears the chip
    const g = (await devices()).find((x) => x.name === 'zz-e2e-chip').guid
    await apiJson('POST', `/api/devices/${g}/rename`, { Name: 'zz-e2e-chip2' })
    await expect(page.getByTestId('project-chip')).toContainText('unsaved', { timeout: 10_000 })
    await apiJson('POST', `/api/devices/${g}/rename`, { Name: 'zz-e2e-chip' })
    await expect(page.getByTestId('project-chip')).not.toContainText('unsaved', { timeout: 10_000 })
  } finally {
    const d = (await devices()).find((x) => x.name.startsWith('zz-e2e-chip'))
    if (d) await apiJson('POST', `/api/devices/${d.guid}/rename`, { Name: 'PDM-05' })
  }
  expect(errors).toEqual([])
})

test('New project, Upload and Open replace the project and warn about unsaved changes @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const file = stamp()
  try {
    // save the current project as a zz file so there is something safe to open
    await openMenu(page)
    await menu(page).getByTestId('proj-saveas').click()
    await menu(page).getByRole('textbox', { name: 'File name' }).fill(file)
    await menu(page).getByTestId('saveas-go').click()
    await waitFor(async () => (await apiJson('GET', '/api/project')).current === file + '.json', 10_000, 'file saved')
    const n = (await devices()).length
    await page.keyboard.press('Escape')

    // make it dirty, then New: the warning offers Cancel / Discard / Save
    await page.getByRole('button', { name: 'Rename PDM-05' }).first().click()
    await page.getByTestId('row-PDM-05').getByLabel('Module name').fill('zz-e2e-dirty')
    await page.getByTestId('row-PDM-05').getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('project-chip')).toContainText('unsaved')
    await openMenu(page)
    await menu(page).getByTestId('proj-new').click()
    await expect(confirm(page)).toContainText(`Save changes to ${file} first?`)
    await confirm(page).getByTestId('dlg-cancel').click()
    expect((await devices()).length).toBe(n)
    // Discard and continue: the project is emptied
    await openMenu(page)
    await menu(page).getByTestId('proj-new').click()
    await confirm(page).getByTestId('dlg-discard').click()
    await waitFor(async () => (await devices()).length === 0, 10_000, 'new project is empty')
    expect((await apiJson('GET', '/api/project')).current).toBeFalsy()
    await expect(page.getByTestId('project-chip')).toContainText('Untitled car')

    // Upload the fixture through the file picker
    await openMenu(page)
    await menu(page).getByTestId('proj-upload-input').setInputFiles(FIXTURE)
    await waitFor(async () => (await devices()).length === n, 15_000, 'upload restored the modules')
    await waitFor(async () => (await devices()).every((d) => d.connected), 30_000, 'modules answering')

    // Open the saved zz file from the list (the project from the fixture is unsaved, so Save first is offered)
    await openMenu(page)
    await menu(page).getByTestId('proj-open').click()
    await menu(page).getByRole('group', { name: /Project files/ }).getByRole('button', { name: new RegExp(file) }).click()
    await expect(confirm(page)).toContainText('If you open')
    await confirm(page).getByTestId('dlg-discard').click()
    await waitFor(async () => (await apiJson('GET', '/api/project')).current === file + '.json', 15_000, 'file opened')
    await waitFor(async () => (await devices()).length === n, 15_000, 'opened file has all modules')
    await expect(page.getByTestId('project-chip')).toContainText(file)
    await expect(page.getByTestId('project-chip')).not.toContainText('unsaved')
  } finally { await forceRestoreProject() }
  expect(errors).toEqual([])
  void restoreProject
})

test('Save, then continue saves first and then opens @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const file = stamp()
  try {
    await openMenu(page)
    await menu(page).getByTestId('proj-saveas').click()
    await menu(page).getByRole('textbox', { name: 'File name' }).fill(file)
    await menu(page).getByTestId('saveas-go').click()
    await waitFor(async () => (await apiJson('GET', '/api/project')).current === file + '.json', 10_000, 'saved')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Rename PDM-05' }).first().click()
    await page.getByTestId('row-PDM-05').getByLabel('Module name').fill('zz-e2e-keep')
    await page.getByTestId('row-PDM-05').getByRole('button', { name: 'Save' }).click()
    await openMenu(page)
    await menu(page).getByTestId('proj-open').click()
    await menu(page).getByRole('group', { name: /Project files/ }).getByRole('button', { name: new RegExp(file) }).click()
    await confirm(page).getByTestId('dlg-save').click()
    await expect(confirm(page)).toHaveCount(0, { timeout: 20_000 })
    // the dialog closes before the open runs: wait for it, or the restore below races the open
    await expect(page.getByText(new RegExp(`Opened ${file}\\.json`)).first()).toBeVisible({ timeout: 20_000 })
    // the change was saved to the file before it was opened again: the name is still there
    await waitFor(async () => (await devices()).some((d) => d.name === 'zz-e2e-keep'), 15_000, 'saved change survived the open')
  } finally {
    const d = (await devices()).find((x) => x.name === 'zz-e2e-keep')
    if (d) await apiJson('POST', `/api/devices/${d.guid}/rename`, { Name: 'PDM-05' })
    await forceRestoreProject()
  }
  expect(errors).toEqual([])
})

test('Save keeps the app\'s own state and the function groups in the file, New clears them and Open brings them back (G4, G16) @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const file = stamp()
  const g = (await devices())[0].guid
  const posKey = 'dingoNextFlowPos:' + g, pos = JSON.stringify({ 'output:1': { x: 123, y: 45 } })
  const read = () => page.evaluate((k) => localStorage.getItem(k), posKey)
  try {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [posKey, pos])
    const grp = { groups: [{ id: 'gE2E', recipe: 'threshold', kind: 'helper', name: 'Threshold', members: ['condition:1'] }], dismissed: ['x:1'] }
    await apiJson('PUT', `/api/groups/${g}`, grp)
    await openMenu(page)
    await menu(page).getByTestId('proj-saveas').click()
    await menu(page).getByRole('textbox', { name: 'File name' }).fill(file)
    await menu(page).getByTestId('saveas-go').click()
    await waitFor(async () => (await apiJson('GET', '/api/project')).current === file + '.json', 10_000, 'file saved')
    // the file holds it (and a save without it, like the AI agent's, keeps it)
    expect((await apiJson('GET', '/api/project/download')).dingoConfigClient.graph[posKey]).toBe(pos)
    expect((await apiJson('GET', '/api/project/download')).dingoConfigClient.groups[g]).toEqual(grp)
    await apiJson('POST', '/api/project/save', { FileName: file + '.json' })
    expect((await apiJson('GET', '/api/project/download')).dingoConfigClient.graph[posKey]).toBe(pos)
    await page.keyboard.press('Escape')
    // forget it in the browser and start a new project: nothing comes back from the old one
    await page.evaluate((k) => localStorage.removeItem(k), posKey)
    await openMenu(page)
    await menu(page).getByTestId('proj-new').click()
    await waitFor(async () => (await devices()).length === 0, 10_000, 'new project is empty')
    expect((await apiJson('GET', '/api/project/download')).dingoConfigClient).toBeUndefined()
    expect(await apiJson('GET', '/api/groups')).toEqual({})
    // Open the file again: the browser gets it back
    await openMenu(page)
    await menu(page).getByTestId('proj-open').click()
    await menu(page).getByRole('group', { name: /Project files/ }).getByRole('button', { name: new RegExp(file) }).click()
    await expect(page.getByText(new RegExp(`Opened ${file}\.json`)).first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(read).toBe(pos)
    expect(await apiJson('GET', `/api/groups/${g}`)).toEqual(grp)
  } finally {
    await page.evaluate((k) => localStorage.removeItem(k), posKey).catch(() => {})
    await forceRestoreProject()
  }
  expect(errors).toEqual([])
})
