// Logs: CAN traffic (table, names, filter, changed bytes, recording, flood warning) and the system log.
// Safe write: CAN log recording start/stop (always stopped again).
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson } from './api.js'
import { inject, devs } from './e-util.js'

const rowsOf = (page) => page.getByTestId('can-table').locator('tbody tr')

async function stopRecording() {
  try {
    const s = await apiJson('GET', '/api/canlog/record/status')
    if (s.recording) await apiJson('POST', '/api/canlog/record/stop')
  } catch { /* nothing to stop */ }
}

test('CAN traffic lists every ID with a name for module frames and live counts', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/logs')
  await expect.poll(() => rowsOf(page).count(), { timeout: 15_000 }).toBeGreaterThan(20)
  const api = await apiJson('GET', '/api/canlog')
  const uniq = Number(await page.getByTestId('can-ids').innerText())
  expect(Math.abs(uniq - api.length)).toBeLessThanOrEqual(3)
  // module frames carry the module's name
  const d = await devs()
  const pdm = d.find((x) => x.name === 'PDM-01')
  await expect(rowsOf(page).filter({ hasText: `0x${pdm.baseId.toString(16).toUpperCase()}` }).first()).toContainText('PDM-01')
  // the table's count column grows
  const first = rowsOf(page).first()
  const c0 = parseInt((await first.locator('td').last().innerText()).replace(/,/g, ''), 10)
  await page.waitForTimeout(1500)
  const c1 = parseInt((await first.locator('td').last().innerText()).replace(/,/g, ''), 10)
  expect(c1).toBeGreaterThanOrEqual(c0)
  await expect(page.getByTestId('can-fps')).toContainText(/\d/)
  await expect(page.getByText('limit 3,000')).toBeVisible()
  expect(errors).toEqual([])
})

test('the filter finds an ID by hex or by name and clears again', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/logs')
  await expect.poll(() => rowsOf(page).count(), { timeout: 15_000 }).toBeGreaterThan(20)
  const all = await rowsOf(page).count()
  const d = await devs()
  const cb = d.find((x) => x.name === 'CB-1')
  const hex = '0x' + cb.baseId.toString(16).toUpperCase()
  await page.getByLabel('Filter by ID or name').fill(hex)
  await expect.poll(() => rowsOf(page).count()).toBeLessThan(all)
  for (const t of await rowsOf(page).locator('td:first-child').allInnerTexts()) expect(t).toContain(hex)
  await page.getByLabel('Filter by ID or name').fill('PDM-02')
  await expect.poll(() => rowsOf(page).count()).toBeGreaterThan(0)
  for (const t of await rowsOf(page).locator('td:nth-child(3)').allInnerTexts()) expect(t).toContain('PDM-02')
  await page.getByLabel('Filter by ID or name').fill('zzzz-nothing')
  await expect(page.getByText('No ID matches the filter.')).toBeVisible()
  await page.getByLabel('Filter by ID or name').fill('')
  await expect.poll(() => rowsOf(page).count()).toBeGreaterThanOrEqual(all - 3)
  expect(errors).toEqual([])
})

test('bytes that change are marked bold and underlined', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/logs')
  await expect(page.getByText('bold and underlined = byte changed in the last second')).toBeVisible()
  await expect(page.locator('.b.chg').first()).toBeVisible({ timeout: 30_000 })
  const style = await page.locator('.b.chg').first().evaluate((e) => getComputedStyle(e))
  expect(style.textDecorationLine).toContain('underline')
  expect(Number(style.fontWeight)).toBeGreaterThanOrEqual(600)
  expect(errors).toEqual([])
})

test('Hide IDs silent for 10 s never shows more rows', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/logs')
  await expect.poll(() => rowsOf(page).count(), { timeout: 15_000 }).toBeGreaterThan(20)
  const all = await rowsOf(page).count()
  await page.getByRole('checkbox', { name: 'Hide IDs silent for 10 s' }).click()
  await page.waitForTimeout(800)
  expect(await rowsOf(page).count()).toBeLessThanOrEqual(all)
  await page.getByRole('checkbox', { name: 'Hide IDs silent for 10 s' }).click()
  await expect.poll(() => rowsOf(page).count()).toBeGreaterThanOrEqual(all - 3)
  expect(errors).toEqual([])
})

test('recording starts, counts frames, stops, and the CSV downloads', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/logs')
  try {
    await expect(page.getByTestId('rec-status')).not.toContainText('REC')
    await expect(page.getByTestId('rec-toggle')).toContainText('Start recording')
    await expect(page.getByRole('button', { name: 'Download raw (.bin)' })).toHaveCount(0)   // not offered: the backend records CSV only
    await page.getByTestId('rec-toggle').click()
    await expect(page.getByTestId('rec-status')).toContainText('REC')
    expect((await apiJson('GET', '/api/canlog/record/status')).recording).toBe(true)
    await expect(page.getByTestId('rec-toggle')).toContainText('Stop recording')
    await expect.poll(async () => (await apiJson('GET', '/api/canlog/record/status')).frames, { timeout: 10_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(1200)
    await page.getByTestId('rec-toggle').click()
    await expect(page.getByTestId('rec-status')).toContainText('Saved')
    const st = await apiJson('GET', '/api/canlog/record/status')
    expect(st.recording).toBe(false)
    expect(st.frames).toBeGreaterThan(0)
    await expect(page.getByTestId('dl-csv')).toBeVisible()
    const dl = page.waitForEvent('download')
    await page.getByTestId('dl-csv').click()
    const file = await dl
    expect(file.suggestedFilename()).toMatch(/\.csv$/)
    const chunks = []
    for await (const c of await file.createReadStream()) chunks.push(c)
    expect(Buffer.concat(chunks).toString('utf8').split('\n').length).toBeGreaterThan(3)
  } finally {
    await stopRecording()
  }
  expect((await apiJson('GET', '/api/canlog/record/status')).recording).toBe(false)
  expect(errors).toEqual([])
})

test('Download ID summary returns a CSV of the traffic', async ({ page }) => {
  await open(page, 'live/logs')
  const href = await page.getByTestId('dl-summary').getAttribute('href')
  expect(href).toBe('/api/canlog/export')
  const r = await page.request.get('http://127.0.0.1:5000' + href)
  expect(r.ok()).toBe(true)
  expect((await r.text()).startsWith('Dir,ID,Type,DLC,Data,Count')).toBe(true)
})

test('a flooded bus raises a warning with the top talker and ways to cut it down', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/logs')
  await expect.poll(() => rowsOf(page).count(), { timeout: 15_000 }).toBeGreaterThan(20)
  // let a few polls pass so each ID has a measured rate
  await page.waitForTimeout(1500)
  await inject(page, { top: { canRate: 5000 } })
  const alert = page.getByRole('alert').filter({ hasText: 'Bus flooded' })
  await expect(alert).toContainText('5,000 frames/s')
  await expect(alert).toContainText('120 Ω terminator')
  const all = await rowsOf(page).count()
  await alert.getByRole('button', { name: /^Show only 0x/ }).click()
  await expect.poll(() => rowsOf(page).count()).toBe(1)
  await page.getByRole('button', { name: 'Show all IDs' }).click()
  await expect.poll(() => rowsOf(page).count()).toBeGreaterThanOrEqual(all - 2)
  await alert.getByRole('button', { name: /^Hide 0x.* from the list/ }).click()
  await expect.poll(() => rowsOf(page).count()).toBe(all - 1)
  await expect(page.getByText('1 ID is hidden.')).toBeVisible()
  await page.getByRole('button', { name: 'Show all IDs' }).click()
  await expect.poll(() => rowsOf(page).count()).toBeGreaterThanOrEqual(all - 1)
  expect(errors).toEqual([])
})

test('no adapter shows an empty state with a Connect link', async ({ page }) => {
  await open(page, 'live/logs')
  await inject(page, { top: { connected: false } })
  await expect(page.getByText('No CAN adapter connected')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '#/next/connect')
})

test('System log shows entries with level words and filters by level and text', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/logs')
  await page.getByRole('tab', { name: 'System log' }).click()
  const rows = page.getByRole('region', { name: 'System log' }).locator('tbody tr')
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(5)
  const api = await apiJson('GET', '/api/syslog')
  const total = Number((await page.getByTestId('sys-count').innerText()).match(/of (\d+) entries/)[1])
  expect(Math.abs(total - api.length)).toBeLessThanOrEqual(5)
  await expect(rows.first().locator('td').nth(1)).toContainText(/Info|Warning|Error/)
  // level filter
  await page.getByRole('radio', { name: 'Errors only' }).click()
  for (const t of await rows.locator('td:nth-child(2)').allInnerTexts()) expect(t).toMatch(/Error|^$|No messages|No entry/)
  await page.getByRole('radio', { name: 'Warnings and errors' }).click()
  for (const t of await rows.locator('td:nth-child(2)').allInnerTexts()) expect(t).not.toMatch(/Info/)
  await page.getByRole('radio', { name: 'All' }).click()
  // text filter
  await page.getByLabel('Filter text').fill('CommsDataPipeline')
  await expect.poll(async () => (await rows.allInnerTexts()).every((t) => t.includes('CommsDataPipeline'))).toBe(true)
  await page.getByLabel('Filter text').fill('zzzz-nothing')
  await expect(page.getByText('No entry matches.')).toBeVisible()
  await page.getByLabel('Filter text').fill('')
  expect(errors).toEqual([])
})

test('System log export is a CSV download', async ({ page }) => {
  await open(page, 'live/logs')
  await page.getByRole('tab', { name: 'System log' }).click()
  const href = await page.getByTestId('sys-export').getAttribute('href')
  expect(href).toBe('/api/syslog/export')
  const r = await page.request.get('http://127.0.0.1:5000' + href)
  expect(r.ok()).toBe(true)
  expect((await r.text()).startsWith('Time,Level,Source,Message')).toBe(true)
  const dl = page.waitForEvent('download')
  await page.getByTestId('sys-export').click()
  expect((await dl).suggestedFilename()).toBe('syslog.csv')
})
