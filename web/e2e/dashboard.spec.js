const { test, expect } = require('@playwright/test')

// Dashboard — live data from the orchestrator API (host agents = tmux sessions)
test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })

  test('shows stat cards', async ({ page }) => {
    await expect(page.getByTestId('stat-containers')).toBeVisible()
    await expect(page.getByTestId('stat-tasks')).toBeVisible()
    await expect(page.getByTestId('stat-tasks')).toContainText('Active Tasks')
  })

  test('sidebar shows live system status', async ({ page }) => {
    await expect(page.getByText('All Systems Operational')).toBeVisible()
  })

  test('does not show the unreachable banner when API is reachable', async ({ page }) => {
    await expect(page.getByText(/Orchestrator API unreachable/)).toHaveCount(0)
  })

  test('lists live agents from the API', async ({ page }) => {
    // Other tests create/delete agents — reload until DOM and API agree
    await expect(async () => {
      const apiRows = await page.evaluate(async () => {
        // Same auth as the app itself: protected mode rejects bare fetches with 401
        const res = await fetch('http://localhost:8000/containers', {
          headers: { 'x-session-token': localStorage.getItem('aap_token') || '' },
        })
        return res.json()
      })
      expect(Array.isArray(apiRows)).toBe(true)
      await page.goto('/')
      await page.getByTestId('container-row').first().waitFor({ state: 'visible', timeout: 5000 })
      for (const c of apiRows) {
        // host rows: id == name (both render in the first cell) — match within a row
        const row = page.getByTestId('container-row').filter({ hasText: c.name }).first()
        if (!(await row.isVisible())) throw new Error(`missing ${c.name}`)
      }
    }).toPass({ timeout: 30000 })
  })

  test('search filters the agent table', async ({ page }) => {
    const query = 'dev'
    await page.getByPlaceholder('Search agents...').fill(query)

    const rows = page.getByTestId('container-row')
    await expect(rows.first()).toBeVisible()
    // every surviving row must match the query, and the no-match empty state must not
    const count = await rows.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(query)
    }
    await expect(page.getByText('No containers match your filter.')).toHaveCount(0)
  })

  test('search with no match shows empty state', async ({ page }) => {
    await page.getByPlaceholder('Search agents...').fill('no-such-agent-xyz')
    await expect(page.getByText('No containers match your filter.')).toBeVisible()
  })

  test('status filter with no matches shows the empty state', async ({ page }) => {
    await page.getByPlaceholder('Search agents...').fill('')
    await page.getByText('All Status').click()
    await page.getByRole('option', { name: 'Busy' }).click()
    await expect(page.getByText('No containers match your filter.')).toBeVisible()
  })

  test('clicking a row opens the agent detail page', async ({ page }) => {
    const first = page.getByTestId('container-row').first()
    await first.waitFor({ state: 'visible', timeout: 15000 })
    const name = await first.locator('div.font-semibold').first().textContent()
    await first.click()
    await expect(page).toHaveURL(new RegExp(`/containers/${name}$`))
    await expect(page.getByText('Agent console — commands run on this machine')).toBeVisible()
  })
})
