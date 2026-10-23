// Task board → task detail routes. Creates its own project + task through the
// API so it never depends on demo data, and deletes the project afterwards.
const { test, expect } = require('@playwright/test')
const { useIsolatedApi } = require('./lib/isolated-ui')
const { login, getToken } = require('./lib/isolated')

const API = process.env.API_URL || 'http://localhost:8000'

let project
let task

test.beforeEach(async ({ page, request }) => {
  // re-auth each test: a persistence spec may have restarted the orchestrator
  await login(request)
  await useIsolatedApi(page, getToken())
})

test.beforeAll(async ({ request }) => {
  await login(request)
  const pRes = await request.post(`${API}/projects`, {
    headers: { 'x-session-token': getToken() },
    data: { name: `E2E Tasks ${Date.now()}`, description: 'task route coverage' },
  })
  expect(pRes.ok()).toBeTruthy()
  project = await pRes.json()

  const tRes = await request.post(`${API}/projects/${project.id}/tasks`, {
    headers: { 'x-session-token': getToken() },
    data: {
      title: 'E2E task: task board and detail',
      description: 'Created by the Playwright suite; deleted in afterAll.',
      priority: 'high',
      status: 'todo',
    },
  })
  expect(tRes.ok()).toBeTruthy()
  task = await tRes.json()
})

test.afterAll(async ({ request }) => {
  if (project) await request.delete(`${API}/projects/${project.id}`, { headers: { 'x-session-token': getToken() } })
})

test.describe('task board → task routes', () => {
  test('board shows the task in its column', async ({ page }) => {
    await page.goto(`/projects/${project.id}/tasks`)
    await expect(page.getByTestId('task-board')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`task-card-${task.id}`)).toBeVisible()
    await expect(page.getByTestId('task-column-todo')).toContainText(task.title)
    await expect(page.getByTestId(`task-card-${task.id}`)).toContainText('High')
  })

  test('task detail opens with fields and an empty subtask state', async ({ page }) => {
    await page.goto(`/projects/${project.id}/tasks/${task.id}`)
    await expect(page.getByTestId('task-detail')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('task-status-select')).toBeVisible()
    await expect(page.getByTestId('task-priority-select')).toBeVisible()
    await expect(page.getByTestId('subtask-list')).toContainText('ยังไม่มี subtask')
    await expect(page.getByTestId('dispatch-task')).toBeVisible()
  })

  test('new-task dialog validates before create', async ({ page }) => {
    await page.goto(`/projects/${project.id}/tasks`)
    await expect(page.getByTestId('task-board')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('new-task-button').click()
    await expect(page.getByTestId('task-title-input')).toBeVisible()
    await expect(page.getByTestId('task-create-submit')).toBeDisabled()
    await page.getByTestId('task-title-input').fill('Task จาก dialog')
    await expect(page.getByTestId('task-create-submit')).toBeEnabled()
  })
})
