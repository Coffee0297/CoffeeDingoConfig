// Connect panel (top-bar connection pill): adapters, speed, connect / disconnect, USB identify.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, waitFor } from './api.js'
import { restoreConnection, SIM_PORT } from './a-util.js'

const panel = (page) => page.getByRole('dialog', { name: 'Connection' })
const radio = (page, re) => panel(page).getByRole('radio', { name: re })

async function openPanel(page) {
  await page.getByTestId('connection-pill').click()
  await expect(panel(page)).toBeVisible()
}

test('shows the live connection through SLCAN over TCP', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  const ad = await apiJson('GET', '/api/adapters')
  const status = page.getByTestId('connect-status')
  await expect(status).toContainText('Connected through SLCAN')
  await expect(status).toContainText(ad.activePort)
  const devs = await devices()
  await expect(status).toContainText(`${devs.filter((d) => d.connected).length} of ${devs.length} modules answering`)   // an ECU that sends nothing (on the Sim) is not answering
  await expect(radio(page, /SLCAN over TCP/)).toBeChecked()
  await expect(panel(page).getByText('In use')).toBeVisible()
  // the host and port fields show the live address
  await expect(panel(page).getByRole('textbox', { name: 'Host' })).toHaveValue('127.0.0.1')
  await expect(panel(page).getByRole('textbox', { name: 'Port', exact: true })).toHaveValue('7778')
  expect(errors).toEqual([])
})

test('every adapter choice shows its own fields', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  const heading = panel(page).getByRole('heading', { level: 3 })
  await radio(page, /USB, straight to a module/).check()
  await expect(heading).toHaveText('USB, straight to a module')
  await expect(panel(page).getByText('dingoConfig opens the first dingoPDM')).toBeVisible()
  await radio(page, /PCAN/).check()
  await expect(panel(page).getByRole('textbox', { name: 'Channel' })).toBeVisible()
  await radio(page, /SLCAN, serial port/).check()
  await expect(panel(page).getByText('Serial port').first()).toBeVisible()
  await radio(page, /SLCAN over TCP/).check()
  await expect(panel(page).getByRole('textbox', { name: 'Host' })).toBeVisible()
  await radio(page, /Simulator replay/).check()
  await expect(panel(page).getByText('Programming is off with the simulator replay').first()).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Connect to simulator' })).toBeVisible()
  await radio(page, /Kvaser/).check()
  await expect(panel(page).getByRole('textbox', { name: 'Channel' })).toBeVisible()
  // WiFi bridge (G11): search the network first; SocketCAN is visibly not on this PC
  await radio(page, /WiFi bridge/).check()
  await expect(panel(page).getByTestId('wifi-scan')).toBeVisible()
  await expect(radio(page, /SocketCAN/)).toBeDisabled()
  expect(errors).toEqual([])
})

test('adapter list comes from the backend', async ({ page }) => {
  await open(page, 'hardware')
  await openPanel(page)
  const ad = await apiJson('GET', '/api/adapters')
  for (const [name, re] of [['USB', /USB, straight/], ['PCAN', /^PCAN/], ['SLCAN', /SLCAN, serial/], ['Sim', /Simulator replay/], ['Kvaser', /Kvaser/]]) {
    if (ad.adapters.includes(name)) await expect(radio(page, re)).toBeEnabled()
  }
  // the serial port choice lists the real ports
  await radio(page, /SLCAN, serial port/).check()
  if (ad.ports.length) await expect(panel(page).getByText('Serial port').first()).toBeVisible()
})

test('CAN speed choice, auto-detect note, and the not-available-yet switches', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  const group = panel(page).getByRole('radiogroup', { name: 'CAN speed' })
  for (const l of ['125 k', '250 k', '500 k', '1000 k', 'Auto-detect']) {
    await group.getByRole('radio', { name: l }).click()
    await expect(group.getByRole('radio', { name: l })).toBeChecked()
  }
  await expect(panel(page).getByText('Auto-detect tries 500 k')).toBeVisible()
  await group.getByRole('radio', { name: '500 k' }).click()
  // auto-connect and auto-reconnect are kept by the backend (G10): the switches show and change them
  const before = await apiJson('GET', '/api/adapters')
  const autoC = panel(page).getByRole('switch', { name: /Connect automatically/ })
  await expect(autoC).toHaveAttribute('aria-checked', String(before.autoConnect))
  await expect(panel(page).getByRole('switch', { name: /Reconnect if the link drops/ })).toHaveAttribute('aria-checked', String(before.autoReconnect))
  try {
    await autoC.click()
    await waitFor(async () => (await apiJson('GET', '/api/adapters')).autoConnect === !before.autoConnect, 5000, 'auto-connect saved')
  } finally { await apiJson('POST', '/api/connection/options', { autoConnect: before.autoConnect }) }
  expect(errors).toEqual([])
})

test('bad TCP port or host blocks Connect and says why', async ({ page }) => {
  await open(page, 'hardware')
  await openPanel(page)
  await radio(page, /SLCAN over TCP/).check()
  const port = panel(page).getByRole('textbox', { name: 'Port', exact: true })
  await port.fill('99999')
  await expect(panel(page).getByText('The port is a number from 1 to 65535.')).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Reconnect' })).toBeDisabled()
  await port.fill('7778')
  await panel(page).getByRole('textbox', { name: 'Host' }).fill('')
  await expect(panel(page).getByText('Type the host, for example 127.0.0.1.')).toBeVisible()
  await panel(page).getByRole('textbox', { name: 'Host' }).fill('127.0.0.1')
  await expect(panel(page).getByRole('button', { name: 'Reconnect' })).toBeEnabled()
})

test('Identify the module on USB asks the backend and shows the base ID', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  await panel(page).getByTestId('usb-identify').click()
  const r = await apiJson('POST', '/api/usb/identify')
  if (r.gatewayBaseId != null) await expect(panel(page).getByText(`answers on 0x${r.gatewayBaseId.toString(16).toUpperCase().padStart(3, '0')}`)).toBeVisible()
  else await expect(panel(page).getByText(/No module answered on USB/)).toBeVisible()
  expect(errors).toEqual([])
})

test('Close button and Escape close the panel', async ({ page }) => {
  await open(page, 'hardware')
  await openPanel(page)
  await panel(page).getByRole('button', { name: 'Close', exact: true }).first().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await openPanel(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Disconnect then Connect over TCP @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  try {
    await openPanel(page)
    await panel(page).getByTestId('disconnect').click()
    await expect(page.getByTestId('connection-pill')).toContainText('Not connected', { timeout: 15_000 })
    await expect(panel(page).getByTestId('connect-status')).toContainText('Not connected')
    expect((await apiJson('GET', '/api/adapters')).connected).toBe(false)
    // reconnect through the form
    await radio(page, /SLCAN over TCP/).check()
    await panel(page).getByRole('textbox', { name: 'Host' }).fill('127.0.0.1')
    await panel(page).getByRole('textbox', { name: 'Port', exact: true }).fill('7778')
    await panel(page).getByRole('radiogroup', { name: 'CAN speed' }).getByRole('radio', { name: '500 k' }).click()
    await panel(page).getByTestId('connect').click()
    await expect(page.getByTestId('connection-pill')).toContainText(/of \d+ live/, { timeout: 30_000 })
    const ad = await apiJson('GET', '/api/adapters')
    expect(ad.connected).toBe(true)
    expect(ad.activePort).toBe(SIM_PORT)
    await expect(panel(page).getByTestId('connect-status')).toContainText('Connected through SLCAN')
  } finally { await restoreConnection() }
  expect(errors).toEqual([])
})

test('Connecting to a closed TCP port shows a plain error @exclusive', async ({ page }) => {
  await open(page, 'hardware')
  try {
    await openPanel(page)
    await radio(page, /SLCAN over TCP/).check()
    await panel(page).getByRole('textbox', { name: 'Port', exact: true }).fill('1')
    await panel(page).getByRole('button', { name: 'Reconnect' }).click()
    await expect(panel(page).getByTestId('connect-status')).toHaveAttribute('data-tone', 'fault', { timeout: 30_000 })
  } finally { await restoreConnection() }
})

test('Auto-detect keeps the speed where frames arrive @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  try {
    await openPanel(page)
    await radio(page, /SLCAN over TCP/).check()
    await panel(page).getByRole('radiogroup', { name: 'CAN speed' }).getByRole('radio', { name: 'Auto-detect' }).click()
    await panel(page).getByRole('button', { name: 'Reconnect' }).click()
    await expect(panel(page).getByTestId('connect-status')).toContainText('Connected through SLCAN', { timeout: 40_000 })
    await waitFor(async () => (await devices()).every((d) => d.connected || /dbc/i.test(d.type)), 30_000, 'modules answering')
    await expect(panel(page).getByRole('radiogroup', { name: 'CAN speed' }).getByRole('radio', { name: '500 k' })).toBeChecked()
  } finally { await restoreConnection() }
  expect(errors).toEqual([])
})

test('the backend reconnects by itself when the link drops, and a Disconnect stays (G10) @exclusive', async ({ page }) => {
  test.setTimeout(90_000)
  const net = await import('node:net')
  // a relay in front of the Sim bridge, so the test can cut the link and refuse it for a moment
  const sim = new URL(SIM_PORT.replace(/^tcp:/, 'http:'))
  const socks = new Set()
  let refuse = false
  const relay = net.createServer((c) => {
    if (refuse) { c.destroy(); return }
    const up = net.connect(Number(sim.port), sim.hostname)
    socks.add(c); socks.add(up)
    const end = () => { c.destroy(); up.destroy(); socks.delete(c); socks.delete(up) }
    for (const s of [c, up]) { s.on('error', end); s.on('close', end) }
    c.pipe(up).pipe(c)
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const port = `tcp://127.0.0.1:${relay.address().port}`
  const opts = await apiJson('GET', '/api/adapters')
  try {
    await apiJson('POST', '/api/connection/options', { autoReconnect: true })
    await apiJson('POST', '/api/disconnect')
    expect((await apiJson('POST', '/api/connect', { Adapter: 'SLCAN', Port: port, Bitrate: '500K' })).ok).toBe(true)
    expect((await apiJson('GET', '/api/adapters')).last).toMatchObject({ adapter: 'SLCAN', port })
    await open(page, 'hardware')
    // the link drops and stays down for 4 s: the top bar says the app is reconnecting
    refuse = true
    for (const s of [...socks]) s.destroy()
    await waitFor(async () => (await apiJson('GET', '/api/adapters')).reconnecting, 10_000, 'reconnecting')
    await expect(page.getByText('Adapter lost · reconnecting…')).toBeVisible()
    await new Promise((r) => setTimeout(r, 4000))
    refuse = false
    await waitFor(async () => { const a = await apiJson('GET', '/api/adapters'); return a.connected && a.activePort === port }, 40_000, 'reconnected')   // the retry backoff can pass 20 s
    expect((await apiJson('GET', '/api/adapters')).reconnecting).toBe(false)
    // the user's Disconnect is not undone
    await apiJson('POST', '/api/disconnect')
    await new Promise((r) => setTimeout(r, 5000))
    const a = await apiJson('GET', '/api/adapters')
    expect(a.connected).toBe(false); expect(a.reconnecting).toBe(false)
  } finally {
    relay.close(); for (const s of [...socks]) s.destroy()
    await apiJson('POST', '/api/connection/options', { autoReconnect: opts.autoReconnect })
    await restoreConnection()
  }
})

test('WiFi bridge: Search the network finds the Sim bridge and connects through it (G11) @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const found = (await apiJson('GET', '/api/adapters/discover')).bridges
  test.skip(!found.some((b) => b.url === SIM_PORT), 'the Sim does not announce its bridge (SIM_MDNS=0, or multicast is blocked)')
  await open(page, 'hardware')
  try {
    await openPanel(page)
    await panel(page).getByTestId('disconnect').click()
    await expect(page.getByTestId('connection-pill')).toContainText('Not connected', { timeout: 15_000 })
    await radio(page, /WiFi bridge/).check()
    await panel(page).getByTestId('wifi-scan').click()
    await expect(panel(page).getByTestId('wifi-bridge')).toContainText('CoffeeDingoSim')
    await panel(page).getByRole('radiogroup', { name: 'CAN speed' }).getByRole('radio', { name: '500 k' }).click()
    await panel(page).getByTestId('connect').click()
    await expect(page.getByTestId('connection-pill')).toContainText(/of \d+ live/, { timeout: 30_000 })
    expect((await apiJson('GET', '/api/adapters')).activePort).toBe(SIM_PORT)
  } finally { await restoreConnection() }
  expect(errors).toEqual([])
})
