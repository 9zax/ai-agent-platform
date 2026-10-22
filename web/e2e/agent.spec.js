const { test, expect } = require('@playwright/test')

// ZAI GLM integration: natural-language command → model picks a shell command → executed in the container
test.describe('AI Agent (ZAI GLM)', () => {
  test('natural-language request creates a file inside the container', async ({ page }) => {
    test.setTimeout(150_000)
    const name = `e2e-ai-${Date.now()}`

    await page.goto('/')
    await page.getByRole('button', { name: /New Container/ }).click()
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create Container' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 })
    await page.getByTestId('container-row').filter({ hasText: name }).click()
    await expect(page).toHaveURL(new RegExp(`/containers/${name}$`))

    // AI mode is the default — ask in natural language
    await page.getByPlaceholder(/บอก AI/).fill('สร้างไฟล์ demo.txt ที่มีข้อความ hello-from-glm แล้วพิมพ์ข้อความในไฟล์ออกมา')
    await page.getByTestId('send-command').click()

    const log = page.getByTestId('command-log')
    await expect(log).toBeVisible({ timeout: 120_000 })
    await expect(log).toContainText('$', { timeout: 10_000 })
    await expect(log).toContainText('exit code 0', { timeout: 10_000 })
    await expect(log).toContainText('hello-from-glm', { timeout: 10_000 })

    // Verify the file really exists via shell mode
    await page.getByRole('button', { name: 'Shell', exact: true }).click()
    await page.getByPlaceholder(/shell command/).fill('cat demo.txt')
    await page.getByRole('button', { name: /Send Command/ }).click()
    await expect(page.locator('pre').filter({ hasText: 'hello-from-glm' })).toBeVisible({ timeout: 20000 })

    // Cleanup
    await page.getByRole('button', { name: /Delete/ }).click()
    await expect(page).toHaveURL(/\/$/, { timeout: 20000 })
  })
})
