const { test, expect } = require('@playwright/test')

// Connectors — per-machine integrations. Real GitHub/Figma auth needs real
// credentials (out of scope here), so these tests cover the list UI, the
// derived states and the per-method connect dialogs. Host mode: one machine =
// one identity, so every agent shares the SAME GitHub state (whatever the
// machine's `gh auth status` says) and Figma's file-based probe.
test.describe('Connectors', () => {
  test('catalog page lists the GitHub and Figma connectors with their auth methods', async ({ page }) => {
    await page.goto('/connectors')
    // Catalog cards carry per-type testids (the catalog may grow beyond these)
    await expect(page.getByTestId('connector-catalog-github')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('connector-catalog-github')).toContainText('GitHub')
    // both auth methods are listed on the GitHub card
    await expect(page.getByTestId('connector-catalog-github')).toContainText('Browser')
    await expect(page.getByTestId('connector-catalog-github')).toContainText('Personal access token')

    await expect(page.getByTestId('connector-catalog-figma')).toBeVisible()
    await expect(page.getByTestId('connector-catalog-figma')).toContainText('Figma')
    await expect(page.getByTestId('connector-catalog-figma')).toContainText('Personal access token')
  })

  test('agent detail shows connector cards driven by the machine state, and the Figma token dialog', async ({ page }) => {
    test.setTimeout(90_000)
    const name = `e2e-conn-${Date.now()}`

    await page.goto('/')
    await page.getByRole('button', { name: /New Agent/ }).click()
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create Agent' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 })
    await page.getByTestId('container-row').filter({ hasText: name }).click()
    await expect(page).toHaveURL(new RegExp(`/containers/${name}$`))

    // GitHub tile: the machine is the source of truth — if gh is installed and
    // logged in the tile shows Connected, otherwise Connected-disabled states
    // never appear; both remaining states share the same UI contract.
    const card = page.getByTestId('connector-card-github')
    await expect(card).toBeVisible({ timeout: 15000 })
    const ghState = await card.getByTestId('connector-status-github').textContent()
    expect(ghState).toMatch(/Connected|Not connected|Pending|Unavailable/)

    // Figma tile: token file probe on the machine — "Not connected" on a
    // machine without ~/.config/figma/token, and Connect opens the token
    // dialog whose submit stays disabled until a token is typed.
    const figmaCard = page.getByTestId('connector-card-figma')
    await expect(figmaCard).toBeVisible()
    await expect(figmaCard.getByTestId('connector-status-figma')).toContainText(/Not connected|Connected/, { timeout: 30000 })
    await figmaCard.getByTestId('connector-connect-figma').click()
    await expect(page.getByTestId('connector-token-input-figma')).toBeVisible()
    // empty token → submit disabled (never send a blank credential)
    await expect(page.getByTestId('connector-token-submit-figma')).toBeDisabled()
    // typing garbage only enables the button; the backend rejects the token
    await page.getByTestId('connector-token-input-figma').fill('figd_not-a-real-token')
    await expect(page.getByTestId('connector-token-submit-figma')).toBeEnabled()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('connector-token-input-figma')).toHaveCount(0)

    // Overview page: the throwaway agent shows up with status rows
    await page.goto('/connectors')
    const row = page.getByTestId('connector-status-row').filter({ hasText: name })
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row.getByTestId('connector-row-status-github')).toContainText(/Unavailable|Not connected|Connected/)
    await expect(row.getByTestId('connector-row-status-figma')).toContainText(/Not connected|Connected/)

    // Cleanup — back to the agent and delete it
    await page.goto(`/containers/${name}`)
    await page.getByRole('button', { name: /Delete/ }).click()
    await expect(page).toHaveURL(/\/$/, { timeout: 20000 })
  })

  test('nav entry reaches the connectors page', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('nav-connectors').click()
    await expect(page).toHaveURL(/\/connectors$/)
    await expect(page.getByTestId('connector-catalog-github')).toBeVisible()
  })
})
