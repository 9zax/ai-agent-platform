const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'

// AI team: 6 senior personas (14+ years), real containers, real GLM consults
test.describe('AI Team', () => {
  test('shows six senior personas', async ({ page }) => {
    await page.goto('/team')
    const cards = page.getByTestId('agent-card')
    await expect(cards).toHaveCount(6)
    for (const title of ['Product Owner', 'Research Engineer', 'Frontend Developer', 'Backend Developer', 'UX/UI Designer', 'QA Engineer']) {
      await expect(page.getByText(title, { exact: true })).toBeVisible()
    }
    // Every persona carries a 14+ years badge
    await expect(page.getByText(/1[4-7]\+ yrs/)).toHaveCount(6)
  })

  test('start PO agent, consult the persona, then clean up', async ({ page }) => {
    test.setTimeout(150_000)

    // Clean slate for the PO role
    const existing = await page.evaluate(async url => {
      const res = await fetch(`${url}/agents`)
      return (await res.json()).find(a => a.role === 'po')?.container?.name
    }, API)
    if (existing) {
      await page.evaluate(async ([url, name]) => {
        await fetch(`${url}/containers/${name}`, { method: 'DELETE' })
      }, [API, existing])
    }

    await page.goto('/team')
    await expect(page.getByTestId('agent-status-po')).toHaveText('Offline')
    await page.getByTestId('agent-start-po').click()
    await expect(page.getByTestId('agent-status-po')).toHaveText('Running', { timeout: 30000 })

    // Open the persona's console and consult it (advice only, nothing executed)
    await page.getByTestId('agent-console').first().click()
    await expect(page).toHaveURL(/\/containers\/agent-po$/)
    await page.getByPlaceholder(/บอก AI/).fill('แนะนำวิธีเขียน user story ที่ดี พร้อมตัวอย่างสั้นๆ 1 เรื่อง')
    await page.getByTestId('consult-command').click()
    const entry = page.getByTestId('log-entry')
    await expect(entry).toBeVisible({ timeout: 120_000 })
    const text = await entry.textContent()
    expect(text.trim().length).toBeGreaterThan(20)

    // Cleanup
    await page.evaluate(async url => {
      await fetch(`${url}/containers/agent-po`, { method: 'DELETE' })
    }, API)
  })
})
