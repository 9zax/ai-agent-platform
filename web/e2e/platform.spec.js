const { test, expect } = require('@playwright/test')

// Platform pages: Skills, AI Config, Settings
test.describe('Skills', () => {
  test('lists skills and toggling persists', async ({ page }) => {
    await page.goto('/skills')
    const cards = page.getByTestId('skill-card')
    await expect(cards).toHaveCount(6)

    const first = cards.first()
    const before = (await page.getByTestId('skill-status').first().textContent()).trim()

    await page.getByTestId('skill-toggle').first().click()
    await expect(page.getByTestId('skill-status').first()).not.toHaveText(before)

    // Toggle back so the suite stays idempotent
    await page.getByTestId('skill-toggle').first().click()
    await expect(page.getByTestId('skill-status').first()).toHaveText(before)
  })
})

test.describe('AI Config', () => {
  test('provider templates switch and save', async ({ page }) => {
    await page.goto('/ai-config')
    await expect(page.getByTestId('provider-zai')).toBeVisible()

    // Picking a template fills the base URL (model config lives per-agent in AI Team, not here)
    await page.getByTestId('provider-anthropic').click()
    await expect(page.getByLabel('Base URL')).toHaveValue(/api\.anthropic\.com/)
    await expect(page.getByLabel('Model')).toHaveCount(0)
    await expect(page.getByTestId('per-agent-model-hint')).toBeVisible()

    // Switch back to the default and save
    await page.getByTestId('provider-zai').click()
    await page.getByRole('button', { name: /Save Provider Config/ }).click()
    await expect(page.getByTestId('saved-indicator')).toBeVisible()
  })
})

test.describe('Settings', () => {
  test('shows live system status', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-card')).toContainText('Healthy')
    await expect(page.getByTestId('settings-card')).toContainText('Connected')
  })
})

test.describe('Container detail tabs', () => {
  test('analytics shows live stats for a running container', async ({ page }) => {
    await page.goto('/containers/ai-agent-platform-web-1')
    await page.getByRole('tab', { name: 'Analytics' }).click()
    await expect(page.getByText(/CPU/).first()).toBeVisible()
    await expect(page.getByText(/Collecting stats/)).toHaveCount(0, { timeout: 10000 })
  })

  test('security shows container metadata', async ({ page }) => {
    await page.goto('/containers/ai-agent-platform-web-1')
    await page.getByRole('tab', { name: 'Security' }).click()
    await expect(page.getByText('Container ID')).toBeVisible()
    await expect(page.getByText('Restart policy')).toBeVisible()
  })

  test('networks shows attached networks', async ({ page }) => {
    await page.goto('/containers/ai-agent-platform-web-1')
    await page.getByRole('tab', { name: 'Networks' }).click()
    await expect(page.getByText('agent-net', { exact: false })).toBeVisible({ timeout: 10000 })
  })

  test('files tab lists workspace contents', async ({ page }) => {
    await page.goto('/containers/ai-agent-platform-orchestrator-1')
    await page.getByRole('tab', { name: 'Files' }).click()
    const output = page.getByTestId('files-output')
    await expect(output).not.toContainText('Loading…', { timeout: 10000 })
    await expect(output).toContainText('.')
  })
})
