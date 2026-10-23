const { test, expect } = require('@playwright/test')

// Dashboard — live data from the orchestrator API
test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })

  async function showAllContainers(page) {
    const btn = page.getByTestId('toggle-all-containers')
    if (await btn.isVisible()) await btn.click()
  }

  test('shows stat cards', async ({ page }) => {
    await expect(page.getByTestId('stat-containers')).toBeVisible()
    await expect(page.getByTestId('stat-tasks')).toBeVisible()
    await expect(page.getByTestId('stat-containers')).toContainText('Containers')
    await expect(page.getByTestId('stat-tasks')).toContainText('Active Tasks')
  })

  test('sidebar shows live system status', async ({ page }) => {
    await expect(page.getByText('All Systems Operational')).toBeVisible()
  })

  test('does not show the unreachable banner when API is reachable', async ({ page }) => {
    await expect(page.getByText(/Orchestrator API unreachable/)).toHaveCount(0)
  })

  test('lists live containers from the API', async ({ page }) => {
    // Other tests create/delete containers in parallel — reload until DOM and API agree
    await expect(async () => {
      const apiRows = await page.evaluate(async () => {
        // Same auth as the app itself: protected mode rejects bare fetches with 401
        const res = await fetch('http://localhost:8000/containers', {
          headers: { 'x-session-token': localStorage.getItem('aap_token') || '' },
        })
        return res.json()
      })
      expect(Array.isArray(apiRows)).toBe(true)
      expect(apiRows.length).toBeGreaterThan(0)
      await page.goto('/')
      await showAllContainers(page)
      await page.getByTestId('container-row').first().waitFor({ state: 'visible', timeout: 5000 })
      for (const c of apiRows) {
        const row = page.getByText(c.name, { exact: true })
        if (!(await row.isVisible())) throw new Error(`missing ${c.name}`)
      }
    }).toPass({ timeout: 30000 })
  })

  test('search filters the container table', async ({ page }) => {
    await showAllContainers(page)
    await page.getByPlaceholder('Search containers...').fill('orchestrator')

    const rows = page.getByTestId('container-row')
    await expect(rows.first()).toBeVisible()
    // The host may run more than one orchestrator (prod + staging) — every
    // surviving row must match the query, and the no-match empty state must not.
    const count = await rows.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('orchestrator')
    }
    await expect(page.getByText('No containers match your filter.')).toHaveCount(0)
  })

  test('search with no match shows empty state', async ({ page }) => {
    await page.getByPlaceholder('Search containers...').fill('no-such-container-xyz')
    await expect(page.getByText('No containers match your filter.')).toBeVisible()
  })

  test('status filter with no matches shows the empty state', async ({ page }) => {
    await showAllContainers(page)
    await page.getByPlaceholder('Search containers...').fill('')
    await page.getByText('All Status').click()
    await page.getByRole('option', { name: 'Busy' }).click()
    await expect(page.getByText('No containers match your filter.')).toBeVisible()
  })

  test('clicking a row opens the container detail page', async ({ page }) => {
    await showAllContainers(page)
    await page.getByText('ai-agent-platform-orchestrator-1').click()
    await expect(page).toHaveURL(/\/containers\/ai-agent-platform-orchestrator-1$/)
    await expect(page.getByText('Container console & AI agent control')).toBeVisible()
  })
})
