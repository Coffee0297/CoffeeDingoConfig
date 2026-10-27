// ui-mod: record the bus on the Live page, the log's times are culture-proof (HH:mm:ss.fff), play it back through the
// Sim adapter at the recorded speed, and Stop playback connects to the car again.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, waitFor } from './api.js'
import { SIM_PORT, restoreConnection } from './a-util.js'

test('record 10 s of the bus, the file has HH:mm:ss.fff times, play it back, pause, and Stop playback reconnects @exclusive', async ({ page }, info) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  try {
    await open(page, 'live')
    await page.getByTestId('live-rec').click()
    await expect(page.getByTestId('live-rec-status')).toContainText(/Recording 00:0\d · [\d,]+ frames/)
    await page.waitForTimeout(10_000)
    await page.getByTestId('live-rec').click()
    await expect(page.getByTestId('live-rec-status')).toContainText(/Recorded [\d,]+ frames/)
    const dl = page.waitForEvent('download')
    await page.getByTestId('live-rec-dl').click()
    const file = info.outputPath('bus.csv')
    await (await dl).saveAs(file)
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    expect(lines.length).toBeGreaterThan(50)
    // every frame line carries a time with colons, whatever the PC's culture (a Danish PC wrote 10.11.08.362)
    const timed = lines.filter((l) => /\d{2}:\d{2}:\d{2}\.\d{3}/.test(l))
    expect(timed.length).toBeGreaterThan(lines.length * 0.9)
    expect(lines.some((l) => /\b\d{2}\.\d{2}\.\d{2}\.\d{3}\b/.test(l))).toBe(false)

    // play it back: the car's connection closes first, after asking
    await page.getByTestId('live-play-file').setInputFiles(file)
    await page.getByTestId('live-play-confirm').click()
    await expect(page.getByTestId('playback-banner')).toContainText('PLAYBACK · read-only · bus.csv', { timeout: 20_000 })
    await expect(page.getByTestId('playback-status')).toContainText(/Playing at 00:0\d, frame [\d,]+ of [\d,]+/)
    // recorded speed: 10 s or more of bus is still playing 2 s later, not over in a burst
    await page.waitForTimeout(2000)
    await expect(page.getByTestId('playback-status')).toContainText('Playing at')
    await page.getByTestId('playback-toggle').click()
    await expect(page.getByTestId('playback-status')).toContainText('Paused at')
    await page.getByTestId('playback-stop').click()
    await expect(page.getByTestId('playback-banner')).toHaveCount(0, { timeout: 20_000 })
    await waitFor(async () => { const a = await apiJson('GET', '/api/adapters'); return a.connected && a.activeAdapter === 'SLCAN' && a.activePort === SIM_PORT }, 20_000, 'connected to the Sim again')
    await waitFor(async () => (await devices()).every((d) => d.connected || /dbc/i.test(d.type)), 60_000, 'modules answering again')
  } finally { await restoreConnection() }
  expect(errors).toEqual([])
})
