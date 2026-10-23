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

  test('command box counts characters (AI mode) and Shell opens a real terminal', async ({ page }) => {
    // AI mode keeps the textarea with a live character counter
    await page.getByPlaceholder(/บอก AI ว่าต้องการอะไร/).fill('run tests')
    await expect(page.getByText('9 characters')).toBeVisible()

    // Shell mode swaps the Command Center box for a real interactive terminal
    // (xterm.js over WebSocket); the Console tab also hosts one — scope to the
    // Command Center's terminal (the taller Console-tab panel stays mounted)
    await page.getByRole('button', { name: 'Shell', exact: true }).click()
    await expect(page.getByTestId('terminal').nth(1)).toBeVisible({ timeout: 10000 })
    await expect(page.getByPlaceholder(/บอก AI ว่าต้องการอะไร/)).toHaveCount(0)
  })

  test('shows resource metrics', async ({ page }) => {
    // host mode: CPU/Memory have no cgroup numbers (render as "—"), Disk is real
    for (const metric of ['CPU', 'Memory', 'Disk']) {
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
