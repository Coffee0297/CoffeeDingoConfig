// Make sure the backend is connected to the Sim and a project with the Sim's modules is loaded.
import fs from 'node:fs'
import { API, apiJson, waitFor } from './api.js'

export default async function globalSetup() {
  const v = await apiJson('GET', '/api/version').catch(() => null)
  if (!v) throw new Error(`Backend not reachable at ${API}. Start it with: dotnet run --project web`)

  const ad = await apiJson('GET', '/api/adapters')
  if (!ad.connected) {
    const port = process.env.SIM_PORT ?? 'tcp://127.0.0.1:7778'
    await apiJson('POST', '/api/connect', { Adapter: 'SLCAN', Port: port, Bitrate: '500K' })
  }

  // Always the fixture, never the project that happens to be open: the tests save, rename and write modules, and
  // an uploaded project has no file name, so nothing they do can overwrite the operator's own project file.
  const file = process.env.E2E_PROJECT
  if (!file || !fs.existsSync(file)) throw new Error('Set E2E_PROJECT to a project file matching the Sim scene (the tests replace the open project with it).')
  const r = await fetch(API + '/api/project/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(file, 'utf8') })
  if (!r.ok) throw new Error('Project upload failed: ' + (await r.text()))
  // Every module in the project should answer on the Sim before tests start.
  await waitFor(async () => (await apiJson('GET', '/api/devices')).every((d) => d.connected || /dbc/i.test(d.type)), 30_000, 'all modules connected')   // an ECU (DBC) shows only while it sends
  // ...and hold the fixture: the modules keep whatever was written last (another project), and a test that writes one
  // setting and "restores" the fixture's value then leaves a mix (CB-2 muted by its own ignition input, silent for good)
  for (const d of (await apiJson('GET', '/api/devices')).filter((x) => /pdm|canboard/i.test(x.type))) {
    for (const a of ['writeall', ...(/pdm/i.test(d.type) ? ['uploadlua'] : []), 'burn']) {
      const r = await fetch(`${API}/api/devices/${d.guid}/${a}`, { method: 'POST' })
      if (!r.ok) throw new Error(`${d.name} ${a}: ${await r.text()}`)
    }
  }
}
