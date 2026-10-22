const { test, expect } = require('@playwright/test')

// Container detail page
const CONTAINER = 'research-assistant'

test.describe('Container detail', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/containers/${CONTAINER}`)
  })

  test('shows the container name and status', async ({ page }) => {
    await expect(page.getByRole('heading', { name: new RegExp(CONTAINER) })).toBeVisible()
    await expect(page.getByTestId('status-badge')).toHaveText('Running')
  })

  test('switches tabs', async ({ page }) => {
    await page.getByRole('tab', { name: 'Files' }).click()
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Console' })).toHaveAttribute('aria-selected', 'false')
  })

  test('command box counts characters', async ({ page }) => {
    await page.getByRole('button', { name: 'Shell', exact: true }).click()
    await expect(page.getByText('0 characters')).toBeVisible()
    await page.getByPlaceholder(/shell command/).fill('run tests')
    await expect(page.getByText('9 characters')).toBeVisible()
  })

  test('shows resource metrics', async ({ page }) => {
    for (const metric of ['CPU', 'Memory', 'Network ↓', 'Network ↑']) {
      await expect(page.getByTestId('metric').filter({ hasText: metric })).toBeVisible()
    }
  })

  test('shows six available skills', async ({ page }) => {
    await expect(page.getByTestId('skill')).toHaveCount(6)
  })

  test('shows empty task state when nothing is assigned', async ({ page }) => {
    await expect(page.getByText(/No active task/)).toBeVisible()
  })

  test('sidebar containers link is active', async ({ page }) => {
    await expect(page.getByTestId('nav-containers')).toHaveAttribute('aria-current', 'page')
  })
})
