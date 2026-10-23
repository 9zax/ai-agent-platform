const { test, expect } = require('@playwright/test')
const { sessionToken } = require('./lib/auth')

const API = 'http://localhost:8000'

// Projects: multi-project team builder with React Flow
test.describe('Projects', () => {
  test('create project, build a team in the flow editor, save, reload, delete', async ({ page }) => {
    // Clean slate
    const existing = await page.evaluate(async ([url, token]) => {
      const res = await fetch(`${url}/projects`, { headers: { 'x-session-token': token } })
      return (await res.json()).filter(p => p.name.startsWith('E2E Flow'))
    }, [API, sessionToken()])
    for (const p of existing) {
      await page.evaluate(async ([url, token, id]) => { await fetch(`${url}/projects/${id}`, { method: 'DELETE', headers: { 'x-session-token': token } }) }, [API, sessionToken(), p.id])
    }

    // Create
    await page.goto('/projects')
    await page.getByRole('button', { name: /New Project/ }).first().click()
    await page.getByLabel('Project name').fill('E2E Flow Project')
    await page.getByLabel('Description').fill('team builder test')
    await page.getByTestId('create-project').click()
    const card = page.getByTestId('project-card').filter({ hasText: 'E2E Flow Project' })
    await expect(card).toBeVisible({ timeout: 10000 })

    // Open flow editor
    await card.getByTestId('project-open').click()
    await expect(page.getByRole('heading', { name: 'E2E Flow Project' })).toBeVisible()

    // Add two personas from the palette
    await page.getByTestId('palette-po').click()
    await page.getByTestId('palette-qa').click()
    await expect(page.getByTestId('flow-node')).toHaveCount(2)

    // Drag an edge: po (source handle) → qa (target handle)
    const src = page.locator('.react-flow__handle.source').first()
    const dst = page.locator('.react-flow__handle.target').last()
    const s = await src.boundingBox()
    const d = await dst.boundingBox()
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await page.mouse.down()
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(page.locator('.react-flow__edge')).toHaveCount(1)

    // Save
    await page.getByTestId('flow-save').click()
    await expect(page.getByTestId('flow-saved')).toBeVisible({ timeout: 10000 })

    // Reload — team persists
    await page.reload()
    await expect(page.getByTestId('flow-node')).toHaveCount(2, { timeout: 10000 })
    await expect(page.locator('.react-flow__edge')).toHaveCount(1)

    // API sanity
    const saved = await page.evaluate(async url => {
      const res = await fetch(`${url}/projects`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })
      return (await res.json()).find(p => p.name === 'E2E Flow Project')
    }, API)
    expect(saved.agents).toEqual(expect.arrayContaining(['po', 'qa']))
    expect(saved.links).toContainEqual({ from: 'po', to: 'qa' })

    // Delete
    await page.goto('/projects')
    const card2 = page.getByTestId('project-card').filter({ hasText: 'E2E Flow Project' })
    await card2.locator('button').last().click()
    await expect(page.getByTestId('project-card').filter({ hasText: 'E2E Flow Project' })).toHaveCount(0, { timeout: 10000 })
  })

  test('clicking a flow node opens the agent detail: live activity + work history', async ({ page }) => {
    // Clean slate
    const existing = await page.evaluate(async ([url, token]) => {
      const res = await fetch(`${url}/projects`, { headers: { 'x-session-token': token } })
      return (await res.json()).filter(p => p.name.startsWith('E2E Detail'))
    }, [API, sessionToken()])
    for (const p of existing) {
      await page.evaluate(async ([url, token, id]) => { await fetch(`${url}/projects/${id}`, { method: 'DELETE', headers: { 'x-session-token': token } }) }, [API, sessionToken(), p.id])
    }

    await page.goto('/projects')
    await page.getByRole('button', { name: /New Project/ }).first().click()
    await page.getByLabel('Project name').fill('E2E Detail Project')
    await page.getByTestId('create-project').click()
    const card = page.getByTestId('project-card').filter({ hasText: 'E2E Detail Project' })
    await expect(card).toBeVisible({ timeout: 10000 })
    await card.getByTestId('project-open').click()

    // Add one persona and click its node on the canvas
    await page.getByTestId('palette-po').click()
    await expect(page.getByTestId('flow-node')).toHaveCount(1)
    await page.getByTestId('flow-node').first().click()

    // Agent detail dialog with the three tabs
    const dialog = page.getByTestId('agent-detail')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('detail-tab-live')).toBeVisible()
    await expect(page.getByTestId('detail-tab-history')).toBeVisible()

    // The live tab reflects whatever the PO is really doing right now — on a
    // long-lived backend another spec's run may be in flight, so accept either
    // the idle state or the live card. Same for persisted history below.
    await expect(page.getByTestId('live-empty').or(page.getByTestId('live-card'))).toBeVisible()
    await page.getByTestId('detail-tab-history').click()
    await expect(page.getByTestId('history-empty').or(page.getByTestId('history-entries'))).toBeVisible()

    // Activity API sanity (persisted history endpoint, no LLM needed)
    const activity = await page.evaluate(async url => {
      const res = await fetch(`${url}/agents/po/activity`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })
      return await res.json()
    }, API)
    expect(activity.role).toBe('po')
    expect(activity.current === null || typeof activity.current === 'object').toBe(true)
    expect(Array.isArray(activity.history)).toBe(true)

    // Delete
    await page.goto('/projects')
    const card2 = page.getByTestId('project-card').filter({ hasText: 'E2E Detail Project' })
    await card2.locator('button').last().click()
    await expect(page.getByTestId('project-card').filter({ hasText: 'E2E Detail Project' })).toHaveCount(0, { timeout: 10000 })
  })
})
