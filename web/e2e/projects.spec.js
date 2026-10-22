const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'

// Projects: multi-project team builder with React Flow
test.describe('Projects', () => {
  test('create project, build a team in the flow editor, save, reload, delete', async ({ page }) => {
    // Clean slate
    const existing = await page.evaluate(async url => {
      const res = await fetch(`${url}/projects`)
      return (await res.json()).filter(p => p.name.startsWith('E2E Flow'))
    }, API)
    for (const p of existing) {
      await page.evaluate(async ([url, id]) => { await fetch(`${url}/projects/${id}`, { method: 'DELETE' }) }, [API, p.id])
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
      const res = await fetch(`${url}/projects`)
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
})
