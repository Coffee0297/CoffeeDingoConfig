// Expert > AI agent & Sim replay.
// The dev server does not forward /mcp, so these tests route it to the backend (the app serves it itself in production).
// Sim replay actions need the Sim adapter: the non-exclusive tests inject the adapter state and mock /api/sim/*;
// the real run (it disconnects the car's SLCAN link and reconnects it) is tagged @exclusive.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, waitFor } from './api.js'
import { API, proxyMcp, fakeTelemetry } from './f-helpers.js'

const goTab = (page, name) => page.getByRole('tab', { name }).click()
const info = async () => (await fetch(API + '/mcp/info')).json()

test('AI agent: status, address, setup and the real tool list', async ({ page, context }) => {
  const errors = watchErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const i = await info()
  await proxyMcp(page)
  await open(page, 'expert/tools')
  await expect(page.getByTestId('ai-status')).toContainText('Running')
  await expect(page.getByTestId('ai-url')).toHaveValue(i.httpEndpoint)
  await expect(page.getByTestId('ai-config')).toContainText('"mcpServers"')
  await expect(page.getByTestId('ai-config')).toContainText(i.httpEndpoint)
  const tools = page.getByTestId('ai-tools').locator('li')
  await expect(tools).toHaveCount(i.tools.length)
  await expect(page.getByText(`${i.tools.length} tools, read from the server`)).toBeVisible()
  // search
  await page.getByTestId('ai-search').fill('lua')
  const n = i.tools.filter((t) => (t.name + ' ' + t.description).toLowerCase().includes('lua')).length
  expect(n).toBeGreaterThan(0)
  await expect(tools).toHaveCount(n)
  await page.getByTestId('ai-search').fill('zzzz-no-tool')
  await expect(page.getByText('No tool matches.')).toBeVisible()
  await page.getByTestId('ai-search').fill('')
  // copy buttons put the text on the clipboard
  await page.getByTestId('ai-copy').click()
  await expect(page.getByTestId('ai-copy')).toContainText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(i.httpEndpoint)
  await page.getByTestId('ai-copy-config').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"mcpServers"')
  // the handshake really goes to the server
  await page.getByTestId('ai-test').click()
  await expect(page.getByTestId('ai-test-result')).toContainText(`Handshake worked. The server reports ${i.tools.length} tools.`)
  expect(errors).toEqual([])
})

// ---- G22: ask first, journal + undo, connected assistants, on/off. MCP calls go straight to the backend.
const mcp = (method, params, id = 1) => fetch(API + '/mcp', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Mcp-Session-Id': 'e2e-agent' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(async (r) => ({ status: r.status, body: await r.json() }))
const tool = async (name, args = {}) => (await mcp('tools/call', { name, arguments: args })).body

test('AI agent: a tool that asks first waits for Allow or Refuse in the app, on any page (G22)', async ({ page }) => {
  const errors = watchErrors(page)
  await proxyMcp(page)
  await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e assistant', version: '1.0' } }, 0)
  await apiJson('POST', '/api/agent/ask', { tool: 'list_devices', ask: true })
  try {
    await open(page, 'expert/tools')
    await expect(page.getByTestId('ai-clients')).toContainText('e2e assistant')
    // asked on another page too: the prompt is app-wide
    await open(page, 'hardware')
    let call = tool('list_devices')
    const prompt = page.getByRole('dialog', { name: 'An AI assistant asks first' })
    await expect(prompt).toContainText('list_devices')
    await prompt.getByTestId('agent-allow').click()
    let r = await call
    expect(r.result.isError).toBe(false)
    call = tool('list_devices')
    await expect(prompt).toBeVisible()
    await prompt.getByTestId('agent-refuse').click()
    r = await call
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/^Refused/)
    await expect(prompt).toHaveCount(0)
  } finally { await apiJson('POST', '/api/agent/ask', { tool: 'list_devices', ask: false }) }
  expect(errors).toEqual([])
})

test('AI agent: Stop server turns assistants away until Start (G22)', async ({ page }) => {
  const errors = watchErrors(page)
  await proxyMcp(page)
  await open(page, 'expert/tools')
  try {
    await page.getByTestId('ai-stop').click()
    await expect(page.getByTestId('ai-status')).toContainText('Stopped')
    const r = await mcp('tools/list', {})
    expect(r.status).toBe(503)
    expect(r.body.error.message).toMatch(/switched off/)
    await page.getByTestId('ai-start').click()
    await expect(page.getByTestId('ai-status')).toContainText('Running')
    expect((await mcp('tools/list', {})).status).toBe(200)
  } finally { await apiJson('POST', '/api/agent/enabled', { enabled: true }) }
  expect(errors).toEqual([])
})

test('AI agent: what an assistant changed is in the journal and Undo puts the project back (G22) @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await proxyMcp(page)
  const d = (await apiJson('GET', '/api/devices')).find((x) => x.name === 'PDM-05')
  try {
    expect((await tool('rename_device', { guid: d.guid, name: 'zz-e2e-agent' })).result.isError).toBe(false)
    await open(page, 'expert/tools')
    const row = page.getByTestId('ai-journal').locator('li').filter({ hasText: 'rename_device' }).first()
    await expect(row).toContainText('done')
    await row.getByRole('button', { name: 'Undo' }).click()
    await page.getByTestId('confirm-go').click()
    await waitFor(async () => (await apiJson('GET', '/api/devices')).some((x) => x.name === 'PDM-05'), 10_000, 'name back')
    await expect(row).toContainText('undone')
  } finally {
    const x = (await apiJson('GET', '/api/devices')).find((y) => y.name === 'zz-e2e-agent')
    if (x) await apiJson('POST', `/api/devices/${x.guid}/rename`, { Name: 'PDM-05' })
  }
  expect(errors).toEqual([])
})

test('AI agent: an unreachable server is reported with a way to try again', async ({ page }) => {
  const errors = watchErrors(page)
  let down = true
  await page.route(/\/mcp\/info$/, async (route) => {
    if (down) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' })
    const r = await fetch(API + '/mcp/info')
    return route.fulfill({ status: 200, contentType: 'application/json', body: await r.text() })
  })
  await open(page, 'expert/tools')
  await expect(page.getByText('The AI agent server did not answer.')).toBeVisible()
  await expect(page.getByText('HTTP 503')).toBeVisible()
  down = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('ai-status')).toContainText('Running')
  expect(errors.filter((e) => !/503/.test(e))).toEqual([]) // the 503 is the one we made
})

// ---------------------------------------------------------------- Sim replay
test('Sim replay: on a real adapter it explains why and everything is off', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'expert/tools')
  await goTab(page, 'Sim replay')
  await expect(page.getByTestId('sim-banner')).toContainText('Replay needs the Sim adapter.')
  await expect(page.getByTestId('sim-status')).toContainText('Not on the Sim adapter')
  await expect(page.getByTestId('sim-play')).toBeDisabled()
  await expect(page.getByTestId('sim-reset')).toBeDisabled()
  await expect(page.getByTestId('sim-file-input')).toBeDisabled()
  await expect(page.getByRole('switch', { name: /Loop/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Open Connect' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('img', { name: /Bus activity/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('Sim replay: load, play, pause, reset, loop and speed call the right endpoints (injected Sim adapter, mocked /api/sim)', async ({ page }) => {
  const errors = watchErrors(page)
  const calls = []
  let status = { state: 'Idle', fileName: null, current: 0, total: 0, loop: false, timeMs: 0, syntheticTiming: false, fps: 1000 }
  await page.route('**/api/sim/**', async (route) => {
    const u = new URL(route.request().url())
    const path = u.pathname.replace('/api/sim/', '')
    if (path === 'status') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) })
    calls.push(path + u.search)
    if (path === 'load') {
      const body = route.request().postData() ?? ''
      if (body.includes('BAD')) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Line 2 is not a CAN frame.' }) })
      status = { ...status, fileName: 'lap.csv', total: 1000, syntheticTiming: true }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, total: 1000, fileName: 'lap.csv' }) })
    }
    if (path === 'play') status = { ...status, state: 'Playing', current: 100, timeMs: 2500 }
    if (path === 'pause') status = { ...status, state: 'Paused' }
    if (path === 'reset') status = { ...status, state: 'Idle', current: 0, timeMs: 0 }
    if (path === 'loop') status = { ...status, loop: u.searchParams.get('on') === 'true' }
    if (path === 'rate') status = { ...status, fps: Number(u.searchParams.get('fps')) }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await open(page, 'expert/tools')
  await goTab(page, 'Sim replay')
  await fakeTelemetry(page, { adapter: 'Sim' })
  await expect(page.getByTestId('sim-banner')).toHaveCount(0)
  await expect(page.getByTestId('sim-status')).toContainText('No log loaded')
  await expect(page.getByTestId('sim-play')).toBeDisabled()
  await expect(page.getByTestId('sim-play')).toHaveAttribute('title', 'Load a log first.')
  // a log the backend cannot read
  await page.getByTestId('sim-file-input').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('BAD') })
  await expect(page.getByTestId('sim-file-error')).toContainText('Line 2 is not a CAN frame.')
  // a good log
  await page.getByTestId('sim-file-input').setInputFiles({ name: 'lap.csv', mimeType: 'text/csv', buffer: Buffer.from('time,dir,id,len,data\n') })
  await expect(page.getByTestId('sim-file')).toHaveText('lap.csv')
  await expect(page.getByTestId('sim-frames')).toHaveText('1,000')
  await expect(page.getByTestId('sim-play')).toBeEnabled()
  await expect(page.getByTestId('sim-status')).toContainText('Ready at the start')
  await page.getByTestId('sim-play').click()
  await expect(page.getByTestId('sim-play')).toHaveText('Pause')
  await expect(page.getByTestId('sim-status')).toContainText('Playing')
  await page.getByTestId('sim-play').click()
  await expect(page.getByTestId('sim-play')).toHaveText('Play')
  await expect(page.getByTestId('sim-status')).toContainText('Paused')
  await page.getByTestId('sim-reset').click()
  await expect(page.getByTestId('sim-status')).toContainText('Ready at the start')
  await page.getByRole('switch', { name: /Loop/ }).click()
  await expect(page.getByRole('switch', { name: /Loop/ })).toBeChecked()
  // speed only for logs without timestamps
  await page.getByTestId('sim-rate').fill('0')
  await expect(page.getByText('Use a whole number from 1 to 100000.')).toBeVisible()
  await expect(page.getByTestId('sim-rate-set')).toBeDisabled()
  await page.getByTestId('sim-rate').fill('500')
  await page.getByTestId('sim-rate-set').click()
  await waitFor(() => calls.includes('rate?fps=500'), 5000, 'rate call')
  expect(calls.filter((c) => c === 'load')).toHaveLength(2)
  expect(calls).toEqual(expect.arrayContaining(['play', 'pause', 'reset', 'loop?on=true', 'rate?fps=500']))
  expect(errors).toEqual([])
})

test('Sim replay: a log with real timestamps plays at recorded speed (mocked status)', async ({ page }) => {
  const errors = watchErrors(page)
  await page.route('**/api/sim/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'Paused', fileName: 'real.csv', current: 10, total: 50, loop: false, timeMs: 61000, syntheticTiming: false, fps: 1000 }) }))
  await open(page, 'expert/tools')
  await goTab(page, 'Sim replay')
  await fakeTelemetry(page, { adapter: 'Sim' })
  await expect(page.getByTestId('sim-status')).toContainText('Paused at 01:01')
  await expect(page.getByTestId('sim-rate-note')).toContainText('real timestamps')
  await expect(page.getByTestId('sim-rate')).toHaveCount(0)
  await expect(page.getByRole('meter', { name: 'Replay position' })).toHaveAttribute('aria-valuenow', '10')
  expect(errors).toEqual([])
})

test('Sim replay with the real Sim adapter: load a log, play, pause, reset, loop, speed; the car link is restored @exclusive', async ({ page }) => {
  test.setTimeout(180_000)
  const errors = watchErrors(page)
  const before = await apiJson('GET', '/api/adapters')
  const lines = ['timestamp,dir,id,len,data']
  for (let i = 0; i < 60; i++) lines.push(`2024-01-01 12:00:${String(Math.floor(i / 10)).padStart(2, '0')}.${String((i % 10) * 100).padStart(3, '0')},Rx,6A2,8,00 11 22 33 44 55 66 ${(i & 255).toString(16).padStart(2, '0')}`)
  try {
    await apiJson('POST', '/api/disconnect')
    await apiJson('POST', '/api/connect', { Adapter: 'Sim', Port: '', Bitrate: '500K' })
    await open(page, 'expert/tools')
    await goTab(page, 'Sim replay')
    await expect(page.getByTestId('sim-banner')).toHaveCount(0)
    await page.getByTestId('sim-file-input').setInputFiles({ name: 'f-lap.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) })
    await expect(page.getByTestId('sim-frames')).toHaveText('60')
    await page.getByTestId('sim-play').click()
    await waitFor(async () => (await apiJson('GET', '/api/sim/status')).state === 'Playing', 5000, 'playing')
    await page.getByTestId('sim-play').click()
    await waitFor(async () => (await apiJson('GET', '/api/sim/status')).state === 'Paused', 5000, 'paused')
    await page.getByTestId('sim-reset').click()
    await waitFor(async () => (await apiJson('GET', '/api/sim/status')).current === 0, 5000, 'reset')
    await page.getByRole('switch', { name: /Loop/ }).click()
    await waitFor(async () => (await apiJson('GET', '/api/sim/status')).loop === true, 5000, 'loop on')
    await page.getByRole('switch', { name: /Loop/ }).click()
    await waitFor(async () => (await apiJson('GET', '/api/sim/status')).loop === false, 5000, 'loop off')
  } finally {
    await apiJson('POST', '/api/sim/pause').catch(() => {})
    await apiJson('POST', '/api/disconnect').catch(() => {})
    if (before.connected) await apiJson('POST', '/api/connect', { Adapter: before.activeAdapter, Port: before.activePort, Bitrate: '500K' })
  }
  expect((await apiJson('GET', '/api/adapters')).activeAdapter).toBe(before.activeAdapter)
  expect(errors).toEqual([])
})
