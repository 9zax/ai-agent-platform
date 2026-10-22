const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'

// AI team: 9 senior personas (14+ years) — BA → SA → PO hub → UX/UI, Dev, QA
test.describe('AI Team', () => {
  test('shows nine senior personas', async ({ page }) => {
    await page.goto('/team')
    const cards = page.getByTestId('agent-card')
    await expect(cards).toHaveCount(9)
    // .first() — UX/UI Designer and Backend Developer each appear twice (pairs)
    for (const title of ['Business Analyst', 'System Analyst', 'Product Owner', 'UX/UI Designer', 'Frontend Developer', 'Backend Developer', 'QA Engineer']) {
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible()
    }
    // Every persona carries a 14+ years badge
    await expect(page.getByText(/1[4-7]\+ yrs/)).toHaveCount(9)
  })

  test('persona rules editable in the markdown editor', async ({ page }) => {
    await page.goto('/team')
    await page.getByTestId('agent-edit-po').click()
    const editor = page.getByTestId('md-editor')
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('Mickey')

    // Preview renders the markdown
    await page.getByTestId('md-toggle').click()
    await expect(page.getByTestId('md-preview')).toBeVisible()

    // Save unchanged
    await page.getByTestId('md-toggle').click()
    await page.getByTestId('save-persona').click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })
  })

  test('start PO agent, consult the persona, then clean up', async ({ page }) => {
    test.setTimeout(150_000)

    // Clean slate for the PO role (authenticated fetch — container APIs need the session token)
    await page.goto('/team')
    await page.evaluate(async url => {
      const token = localStorage.getItem('aap_token') || ''
      const res = await fetch(`${url}/agents`)
      const po = (await res.json()).find(a => a.role === 'po')?.container?.name
      if (po) await fetch(`${url}/containers/${po}`, { method: 'DELETE', headers: { 'x-session-token': token } })
    }, API)
    await page.reload()

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
      const token = localStorage.getItem('aap_token') || ''
      await fetch(`${url}/containers/agent-po`, { method: 'DELETE', headers: { 'x-session-token': token } })
    }, API)
  })

  test('persona model override persists and shows on the card', async ({ page }) => {
    await page.goto('/team')
    await page.getByTestId('agent-edit-po').click()
    await expect(page.getByTestId('model-select')).toBeVisible()
    await expect(page.getByTestId('model-provider-label')).toBeVisible() // provider label rendered
    await expect(page.getByTestId('model-source')).toBeVisible()        // live OR preset badge

    // Dropdown loads (live list with a key, preset fallback without one) — pick by index,
    // never by name, so the test works in both environments
    await page.getByTestId('model-select').click()
    const options = page.getByRole('option')
    await expect(options.first()).toBeVisible()
    expect(await options.count()).toBeGreaterThan(2) // default + ≥1 model + custom

    const opt = options.nth(1)
    const picked = (await opt.textContent()).trim()
    await opt.click()
    await page.getByTestId('save-persona').click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })

    // Card badge reflects the override
    await expect(page.getByTestId('agent-model-po')).toHaveText(picked)

    // Persists in the editor after reopen
    await page.getByTestId('agent-edit-po').click()
    await expect(page.getByTestId('model-select')).toContainText(picked)

    // Clear back to the provider default
    await page.getByTestId('model-select').click()
    await page.getByTestId('model-default').click()
    await page.getByTestId('save-persona').click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })
    await expect(page.getByTestId('agent-model-po')).not.toHaveText(picked)
  })

  test('model override is stored per provider', async ({ page }) => {
    // Set a zai override on po
    await page.goto('/team')
    await page.getByTestId('agent-edit-po').click()
    await page.getByTestId('model-select').click()
    const zaiPick = page.getByRole('option').nth(1)
    const zaiModel = (await zaiPick.textContent()).trim()
    await zaiPick.click()
    await page.getByTestId('save-persona').click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })

    // Switch the active provider → po falls back to the anthropic default
    await page.goto('/ai-config')
    await page.getByTestId('provider-anthropic').click()
    await page.getByRole('button', { name: /Save Provider Config/ }).click()
    await expect(page.getByTestId('saved-indicator')).toBeVisible()
    await page.goto('/team')
    await expect(page.getByTestId('agent-model-po')).not.toHaveText(zaiModel)

    // Set an anthropic override, switch back → the zai override must still be there
    await page.getByTestId('agent-edit-po').click()
    await page.getByTestId('model-select').click()
    const antPick = page.getByRole('option').nth(1)
    await antPick.click()
    await page.getByTestId('save-persona').click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })

    await page.goto('/ai-config')
    await page.getByTestId('provider-zai').click()
    await page.getByRole('button', { name: /Save Provider Config/ }).click()
    await expect(page.getByTestId('saved-indicator')).toBeVisible()
    await page.goto('/team')
    await expect(page.getByTestId('agent-model-po')).toHaveText(zaiModel)

    // Cleanup: clear the zai override so other specs see a pristine po
    await page.getByTestId('agent-edit-po').click()
    await page.getByTestId('model-select').click()
    await page.getByTestId('model-default').click()
    await page.getByTestId('save-persona').click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 })
  })
})
