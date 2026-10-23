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
    // host execution mode: the runtime row reflects tmux availability
    await expect(page.getByTestId('settings-card')).toContainText('tmux')
  })
})

test.describe('Agent detail', () => {
  test('live terminal tab + files tab list the shared workspace', async ({ page }) => {
    // establish the app origin first (storageState logs us in)
    await page.goto('/')
    // host agents are tmux sessions — start one (idempotent) then inspect it
    const API = 'http://localhost:8000'
    const created = await page.evaluate(async api => {
      const token = localStorage.getItem('aap_token') || ''
      const headers = { 'Content-Type': 'application/json', 'x-session-token': token }
      const res = await fetch(`${api}/agents/dev-fe/start`, { method: 'POST', headers, body: '{}' })
      return res.ok
    }, API)
    expect(created).toBeTruthy()

    await page.goto('/containers/agent-dev-fe')
    // console tab: the live terminal panel attaches to the tmux session
    await expect(page.getByTestId('terminal-panel')).toBeVisible({ timeout: 15_000 })
    // metrics render (disk is real, cpu/mem are honest "—")
    await expect(page.getByTestId('metric').first()).toBeVisible()
    // files tab lists the shared workspace
    await page.getByRole('tab', { name: 'Files' }).click()
    const output = page.getByTestId('files-output')
    await expect(output).not.toContainText('Loading…', { timeout: 10000 })
    await expect(output).toContainText('.')
    await expect(output).not.toContainText('Agent is not running')
  })
})
