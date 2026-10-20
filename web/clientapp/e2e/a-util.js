// Helpers for the a-* specs (connect, project, apply, add module, modules, module page, first run).
import { expect } from '@playwright/test'
import fs from 'node:fs'
import { apiJson, devices, waitFor, API, readUpstream } from './api.js'

export const FIXTURE = process.env.E2E_PROJECT
export const SIM_PORT = process.env.SIM_PORT ?? 'tcp://127.0.0.1:7778'
export const SIM_TCP_PORT = SIM_PORT.split(':').pop()   // the Sim's SLCAN port as the Connect panel shows it

/** Open the hash route and wait for the shell + live pill, but do not require a connection. */
export async function openAny(page, path) {
  await page.goto('/#/next/' + path.replace(/^\/+/, ''))
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(page.getByText('Loading…')).toHaveCount(0)
}

export const guidOf = async (name) => (await devices()).find((d) => d.name === name)?.guid

/** Put the Sim connection back (used in `finally` of every @exclusive test that disconnects). */
export async function restoreConnection() {
  const ad = await apiJson('GET', '/api/adapters')
  if (!ad.connected || ad.activePort !== SIM_PORT) {
    await apiJson('POST', '/api/connect', { Adapter: 'SLCAN', Port: SIM_PORT, Bitrate: '500K' })
  }
  await waitFor(async () => (await devices()).every((d) => d.connected || /dbc/i.test(d.type)), 30_000, 'all modules answering again')
}

/** Put the fixture project back (used after New / Open tests). */
export async function restoreProject() {
  const devs = await devices()
  if (devs.length >= 7) return
  const r = await fetch(API + '/api/project/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(FIXTURE, 'utf8') })
  if (!r.ok) throw new Error('could not restore the project: ' + (await r.text()))
  await waitFor(async () => (await devices()).length >= 7, 15_000, 'project restored')
  await waitFor(async () => (await devices()).every((d) => d.connected || /dbc/i.test(d.type)), 30_000, 'modules answering again')
  await readUpstream()   // an uploaded project is a fresh record: 5.7 modules need a Read before any write
}

export const hex3 = (n) => '0x' + n.toString(16).toUpperCase().padStart(3, '0')

/** Replace the project with the fixture, whatever it holds now (the fixture matches the Sim scene). */
export async function forceRestoreProject() {
  const r = await fetch(API + '/api/project/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(FIXTURE, 'utf8') })
  if (!r.ok) throw new Error('could not restore the project: ' + (await r.text()))
  await waitFor(async () => (await devices()).length >= 7, 15_000, 'project restored')
  await waitFor(async () => (await devices()).every((d) => d.connected || /dbc/i.test(d.type)), 30_000, 'modules answering again')
  await readUpstream()   // an uploaded project is a fresh record: 5.7 modules need a Read before any write
}

/** Wait until a module answers (other runs on the shared Sim can briefly take one off the bus). */
export async function ready(...names) {
  await waitFor(async () => { const devs = await devices(); return names.every((n) => devs.find((d) => d.name === n)?.connected) }, 45_000, `${names.join(', ')} answering`)
}
