// The app shell: rail, top bar, panels, command palette, theme, routing.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { AREAS_FOR_TEST } from './fixtures.js'

test('rail links open every area', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'car')
  for (const [label, path] of AREAS_FOR_TEST) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp('#/next/' + path + '$'))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  }
  expect(errors).toEqual([])
})

test('expert drawer opens and its links work', async ({ page }) => {
  await open(page, 'car')
  const nav = page.getByRole('navigation', { name: 'Main' })
  const toggle = nav.getByRole('button', { name: /expert/i })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  for (const [label, path] of [['Lua', 'expert/lua'], ['CAN & parameters', 'expert/can'], ['AI agent & Sim replay', 'expert/tools']]) {
    await nav.getByRole('link', { name: label }).click()
    await expect(page).toHaveURL(new RegExp('#/next/' + path))
  }
})

test('top bar shows the live connection and opens its panels', async ({ page }) => {
  await open(page, 'car')
  await expect(page.getByTestId('connection-pill')).toContainText(/of \d+ live/)
  for (const id of ['connection-pill', 'apply-pill', 'project-chip']) {
    await page.getByTestId(id).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
})

test('command palette jumps to a screen', async ({ page }) => {
  await open(page, 'car')
  await page.getByRole('button', { name: /search/i }).click()
  await page.getByPlaceholder(/search/i).fill('Plot')
  await page.getByRole('option', { name: 'Plot' }).click()
  await expect(page).toHaveURL(/#\/next\/live\/plot/)
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('theme toggle switches light / dark', async ({ page }) => {
  await open(page, 'car')
  const html = page.locator('html')
  const before = await html.getAttribute('data-theme')
  await page.getByRole('button', { name: /use (light|dark) theme/i }).click()
  await expect(html).not.toHaveAttribute('data-theme', before ?? 'dark')
  await page.getByRole('button', { name: /use (light|dark) theme/i }).click()
  await expect(html).toHaveAttribute('data-theme', before ?? 'dark')
})

test('unknown route shows not found with a way back', async ({ page }) => {
  await open(page, 'car')
  await page.goto('/#/next/nope/nothing')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to Car' }).click()
  await expect(page).toHaveURL(/#\/next\/car/)
})

test('an address from before the redesign opens Car home, and there is no Old UI link', async ({ page }) => {
  await page.goto('/#/system')
  await expect(page).toHaveURL(/#\/next\/car$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Old UI' })).toHaveCount(0)
})
