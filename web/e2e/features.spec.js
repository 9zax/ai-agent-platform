const { test, expect } = require('@playwright/test')

// Interactive features — full lifecycle against real Docker via the orchestrator API
test.describe('Container lifecycle', () => {
  let containerName

  test('create → exec → stop → start → restart → delete', async ({ page }) => {
    containerName = `e2e-agent-${Date.now()}`

    // 1. Create via the New Container dialog
    await page.goto('/')
    await page.getByRole('button', { name: /New Container/ }).click()
    await page.getByLabel('Name').fill(containerName)
    await page.getByRole('button', { name: 'Create Container' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 })
    await expect(page.getByTestId('container-row').filter({ hasText: containerName })).toBeVisible({ timeout: 30000 })

    // 2. Open detail and run a shell command (switch Command Center to Shell mode)
    await page.getByTestId('container-row').filter({ hasText: containerName }).click()
    await expect(page).toHaveURL(new RegExp(`/containers/${containerName}$`))
    await page.getByRole('button', { name: 'Shell', exact: true }).click()
    await page.getByPlaceholder(/shell command/).fill('echo hello')
    await page.getByRole('button', { name: /Send Command/ }).click()
    await expect(page.locator('pre').filter({ hasText: 'hello' })).toBeVisible({ timeout: 20000 })

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

test.describe('Board', () => {
  test('+ Add Task adds a new task card', async ({ page }) => {
    await page.goto('/board')
    await page.getByRole('button', { name: '+ Add Task' }).first().click()
    const input = page.getByPlaceholder('Task title...')
    await expect(input).toBeVisible()
    await input.fill('E2E test task')
    await page.getByRole('button', { name: 'Add Task', exact: true }).click()
    await expect(page.getByText('E2E test task')).toBeVisible({ timeout: 10000 })

    // Cleanup: remove the task via the API so counts stay stable for other runs
    const taskId = await page.evaluate(async () => {
      const res = await fetch('http://localhost:8000/tasks')
      const tasks = await res.json()
      return (tasks.find(t => t.title === 'E2E test task') || {}).id
    })
    if (taskId) {
      await page.evaluate(async id => {
        await fetch(`http://localhost:8000/tasks/${id}`, { method: 'DELETE' })
      }, taskId)
    }
  })
})
