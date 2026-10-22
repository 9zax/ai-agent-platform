const { test, expect } = require('@playwright/test')

// Sidebar human-inbox — need_human can only appear mid-run (the engine sets it
// while an LLM step is blocked), so these tests mock GET /runs with route
// interception instead of driving a real run.
const mockRun = (discStatus) => ({
  id: 'mock-run-inbox',
  project_id: 'proj-inbox-mock',
  project_name: 'Inbox Mock Project',
  task: 'mock task',
  status: discStatus === 'need_human' ? 'waiting_human' : 'running',
  steps: [],
  phase: 'meeting',
  round: 1,
  created_at: Math.floor(Date.now() / 1000),
  discussions: discStatus
    ? [{
        id: 'disc-inbox-1',
        from: 'po',
        to: ['human'],
        topic: 'ต้องการเวอร์ชันภาษาไทยหรืออังกฤษ?',
        status: discStatus,
        messages: [],
        round: 1,
        created_at: Math.floor(Date.now() / 1000),
      }]
    : [],
})

test.describe('Human inbox', () => {
  test('badge + panel surface a need_human question on any page, item links to Mission Control', async ({ page }) => {
    await page.route('**/runs', route => route.fulfill({ json: [mockRun('need_human')] }))
    // /team has no need-human UI of its own — only the sidebar inbox can carry it
    await page.goto('/team')

    await expect(page.getByTestId('inbox-badge')).toHaveText('1')
    await page.getByTestId('inbox-button').click()
    const panel = page.getByTestId('inbox-panel')
    await expect(panel).toBeVisible()
    const item = panel.getByTestId('inbox-item')
    await expect(item).toContainText('Inbox Mock Project')
    await expect(item).toContainText('ต้องการเวอร์ชันภาษาไทยหรืออังกฤษ?')
    await expect(item).toHaveAttribute('href', '/projects/proj-inbox-mock')
  })

  test('no badge while nothing needs the user; panel opens empty', async ({ page }) => {
    await page.route('**/runs', route => route.fulfill({ json: [] }))
    await page.goto('/team')

    await expect(page.getByTestId('inbox-badge')).toHaveCount(0)
    await page.getByTestId('inbox-button').click()
    await expect(page.getByTestId('inbox-panel')).toContainText('ว่าง')
  })

  test('toast fires when a question arrives mid-session and ไปตอบ navigates to the project', async ({ page }) => {
    let needHuman = false
    await page.route('**/runs', route => route.fulfill({ json: [mockRun(needHuman ? 'need_human' : null)] }))
    await page.goto('/team')
    await expect(page.getByTestId('inbox-toast')).toHaveCount(0)

    // Next 4s poll picks the escalation up
    needHuman = true
    const toast = page.getByTestId('inbox-toast')
    await expect(toast).toBeVisible({ timeout: 15000 })
    await expect(toast).toContainText('ต้องการเวอร์ชันภาษาไทยหรืออังกฤษ?')
    await toast.getByTestId('inbox-toast-answer').click()
    await expect(page).toHaveURL(/\/projects\/proj-inbox-mock/)
  })
})
