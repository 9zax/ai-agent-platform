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
        const res = await fetch('http://localhost:8000/containers')
        return res.json()
      })
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
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('orchestrator')
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
