const { test, expect } = require('@playwright/test')

// Pause / resume — platform pause = docker stop + registry entry, resume revives.
// Runs against real Docker via the orchestrator (:8000), same as features.spec.js.
test.describe('Pause / resume containers', () => {
  let containerName

  async function createContainer(page, name) {
    await page.goto('/')
    await page.getByRole('button', { name: /New Container/ }).click()
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create Container' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 })
    await expect(page.getByTestId('container-row').filter({ hasText: name })).toBeVisible({ timeout: 30000 })
    await page.getByTestId('container-row').filter({ hasText: name }).click()
    await expect(page).toHaveURL(new RegExp(`/containers/${name}$`))
  }

  async function deleteContainer(page, name) {
    await page.goto(`/containers/${name}`)
    await page.getByRole('button', { name: /Delete/ }).click()
    await expect(page).toHaveURL(/\/$/, { timeout: 20000 })
    await expect(page.getByTestId('container-row').filter({ hasText: name })).toHaveCount(0, { timeout: 20000 })
  }

  async function putConfig(page, request, body) {
    const token = await page.evaluate(() => localStorage.getItem('aap_token') || '')
    return request.put('http://localhost:8000/config', {
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-session-token': token } : {}) },
      data: body,
    })
  }

  test('manual pause → Paused badge → dashboard row → resume → delete', async ({ page }) => {
    containerName = `e2e-pause-${Date.now()}`
    await createContainer(page, containerName)

    // Pause → badge shows Paused (container really stopped on the host)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByTestId('status-badge')).toHaveText('Paused', { timeout: 20000 })

    // Dashboard list overlays the same paused state
    await page.goto('/')
    await expect(page.getByTestId('container-row').filter({ hasText: containerName })).toContainText('Paused', { timeout: 20000 })

    // Resume → badge shows Running again
    await page.goto(`/containers/${containerName}`)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.getByTestId('status-badge')).toHaveText('Running', { timeout: 20000 })

    await deleteContainer(page, containerName)
  })

  test('terminal transparently revives a platform-paused container', async ({ page }) => {
    containerName = `e2e-pause-term-${Date.now()}`
    await createContainer(page, containerName)

    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByTestId('status-badge')).toHaveText('Paused', { timeout: 20000 })

    // Opening the shell auto-resumes the container (terminal_ws revives it)
    await page.getByRole('button', { name: 'Shell', exact: true }).click()
    const term = page.getByTestId('terminal')
    await expect(term).toBeVisible({ timeout: 20000 })
    await term.click()
    await page.keyboard.type('echo back')
    await page.keyboard.press('Enter')
    await expect(term.filter({ hasText: 'back' })).toBeVisible({ timeout: 20000 })
    // The 5s stats poll flips the badge back to Running
    await expect(page.getByTestId('status-badge')).toHaveText('Running', { timeout: 20000 })

    await deleteContainer(page, containerName)
  })

  test('auto-pause after the configured idle window', async ({ page, request }) => {
    test.setTimeout(300_000) // sweeper ticks every 60s; needs tick + idle window
    containerName = `e2e-pause-auto-${Date.now()}`

    // Shorten the idle window for this test only; always restore afterwards
    const before = await (await request.get('http://localhost:8000/config')).json()
    const originalIdle = before.idle_timeout_secs || 900
    try {
      await putConfig(page, request, { idle_timeout_secs: 60 })
      await createContainer(page, containerName)

      // No run involves role 'agent' → after ≤ ~2 idle windows + ticks the
      // sweeper stops the container and the stats poll shows Paused
      await expect(page.getByTestId('status-badge')).toHaveText('Paused', { timeout: 180_000 })

      // Resume still works after an auto-pause
      await page.getByRole('button', { name: 'Resume', exact: true }).click()
      await expect(page.getByTestId('status-badge')).toHaveText('Running', { timeout: 20000 })
    } finally {
      await putConfig(page, request, { idle_timeout_secs: originalIdle })
      await deleteContainer(page, containerName)
    }
  })
})
