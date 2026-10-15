// Shared page helpers for the redesigned UI tests.
import { expect } from '@playwright/test'

/** Open a #/next route and wait for the shell + live feed. */
export async function open(page, path = 'car') {
  await page.goto('/#/next/' + path.replace(/^\/+/, ''))
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(page.getByTestId('connection-pill')).toContainText(/live/i, { timeout: 20_000 })
  await expect(page.getByText('Loading…')).toHaveCount(0)
}

/** Collect uncaught page errors / console errors so every test can assert none happened. */
export function watchErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/favicon|Failed to load resource: the server responded with a status of 4\d\d/.test(t)) return
    errors.push('console: ' + t)
  })
  return errors
}

/** A toast with this text appeared. */
export async function expectToast(page, text) {
  await expect(page.locator('[role=status],[role=alert]').filter({ hasText: text }).first()).toBeVisible()
}
