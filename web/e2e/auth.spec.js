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

  test('unauthenticated UI redirects container actions to /login', async ({ page, request }) => {
    test.skip(!(await (await request.get(`${API}/config`)).json()).auth_required, 'auth disabled')

    await page.goto('/containers/agent-dev-be')
    await expect(page.getByTestId('status-badge')).toBeVisible()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
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
