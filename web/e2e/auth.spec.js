const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'

// Auth gating — only meaningful when ADMIN_PASSWORD is set (auth enabled).
// We create a fresh context WITHOUT the shared storageState.
test.describe('Auth gate', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('backend rejects container access without a session', async ({ request }) => {
    const res = await request.post(`${API}/containers/nope/start`)
    expect(res.status()).toBe(401)
    expect(await res.json()).toMatchObject({ detail: 'Login required' })
  })

  test('backend rejects data reads without a session (protected mode)', async ({ request }) => {
    for (const path of ['/containers', '/runs', '/runs/run-001', '/projects', '/projects/p-001', '/agents', '/skills', '/tasks', '/connectors']) {
      const res = await request.get(`${API}${path}`)
      expect(res.status(), `GET ${path} without a session`).toBe(401)
    }
  })

  test('unauthenticated UI shows only the locked screen', async ({ page, request }) => {
    test.skip(!(await (await request.get(`${API}/config`)).json()).auth_required, 'auth disabled')

    await page.goto('/containers/agent-dev-be')
    const locked = page.getByTestId('auth-locked')
    await expect(locked).toBeVisible({ timeout: 15000 })
    // nothing beyond the gate: no sidebar nav, no page content
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)
    await expect(page.getByTestId('status-badge')).toHaveCount(0)
    await locked.getByTestId('auth-locked-signin').click()
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    await expect(page.getByTestId('login-form')).toBeVisible()
  })

  test('login with valid credentials restores access', async ({ page, request }) => {
    test.skip(!(await (await request.get(`${API}/config`)).json()).auth_required, 'auth disabled')

    await page.goto('/login')
    await page.getByLabel('Username').fill(process.env.ADMIN_USER || 'admin')
    await page.getByLabel('Password').fill(process.env.ADMIN_PASSWORD || '')
    await page.getByRole('button', { name: /Sign in/ }).click()
    await expect(page).toHaveURL(/\/$/, { timeout: 10000 })
    // Session token stored → container actions now allowed
    expect(await page.evaluate(() => !!localStorage.getItem('aap_token'))).toBe(true)
  })
})
