const { test, expect } = require('@playwright/test')

// Interactive features — full lifecycle against real host agents via the orchestrator API
test.describe('Container lifecycle', () => {
  let containerName

  test('create → exec → stop → start → restart → delete', async ({ page }) => {
    containerName = `e2e-agent-${Date.now()}`

    // 1. Create via the New Agent dialog
    await page.goto('/')
    await page.getByRole('button', { name: /New Agent/ }).click()
    await page.getByLabel('Name').fill(containerName)
    await page.getByRole('button', { name: 'Create Agent' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 })
    await expect(page.getByTestId('container-row').filter({ hasText: containerName })).toBeVisible({ timeout: 30000 })

    // 2. Open detail and type in the real interactive terminal (Shell mode)
    await page.getByTestId('container-row').filter({ hasText: containerName }).click()
    await expect(page).toHaveURL(new RegExp(`/containers/${containerName}$`))
    await page.getByRole('button', { name: 'Shell', exact: true }).click()
    const term = page.getByTestId('terminal').nth(1)
    await expect(term).toBeVisible({ timeout: 20000 })
    await term.click()
    await page.keyboard.type('echo hello')
    await page.keyboard.press('Enter')
    await expect(term.filter({ hasText: 'hello' })).toBeVisible({ timeout: 20000 })

    // 3. Stop → badge shows Stopped
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByTestId('status-badge')).toHaveText('Stopped', { timeout: 20000 })

    // 4. Start → badge shows Running again
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('status-badge')).toHaveText('Running', { timeout: 20000 })

    // 5. Restart → still Running
    await page.getByRole('button', { name: 'Restart', exact: true }).click()
    await expect(page.getByTestId('status-badge')).toHaveText('Running', { timeout: 20000 })

    // 6. Delete → back to dashboard, row gone
    await page.getByRole('button', { name: /Delete/ }).click()
    await expect(page).toHaveURL(/\/$/, { timeout: 20000 })
    await expect(page.getByTestId('container-row').filter({ hasText: containerName })).toHaveCount(0, { timeout: 20000 })
  })
})
