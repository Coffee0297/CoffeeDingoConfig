// End-to-end tests of the redesigned UI (#/next) against the running backend + CoffeeDingoSim.
//
// Needs, before `npx playwright test`:
//   1. CoffeeDingoSim running with its SLCAN bridge (default tcp://127.0.0.1:7778, set SIM_PORT to change)
//   2. the backend on :5000 (`dotnet run --project web`)
//   3. the Vite dev server on :5173 (`npm run dev -- --host 127.0.0.1`), which proxies /api + /hub
//   4. E2E_PROJECT = path of a project file whose modules match the Sim scene (loaded if the backend
//      has no matching project open). Never a file in the user's project folder: it is uploaded, not opened.
//
// Tests tagged @exclusive change the whole bus (sleep, disconnect, re-address, flash, open/new project)
// and must run alone:  npx playwright test --grep @exclusive --workers 1
// Everything else:     npx playwright test --grep-invert @exclusive
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e-results/results.json' }]],
  globalSetup: './e2e/global-setup.js',
  outputDir: 'e2e-results/artifacts',
  use: {
    baseURL: process.env.E2E_BASE ?? 'http://127.0.0.1:5173',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
})
