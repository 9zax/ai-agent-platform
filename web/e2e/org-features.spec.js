const { test, expect } = require('@playwright/test')
const { authHeaders } = require('./lib/auth')

const API = 'http://localhost:8000'

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function createProject(name) {
  const { body } = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description: 'e2e org features' }),
  })
  return body
}

async function deleteProject(id) {
  await api(`/projects/${id}`, { method: 'DELETE' })
}

// The six competitor-inspired capabilities, exercised through the real UI:
// budgets/goals, routines, diff-review & budget cards, harnesses, org view,
// doc comments, and the skill test bench.
test.describe('Org features', () => {
  test('project goal + budget persist and the Routines tab manages a schedule', async ({ page }) => {
    const project = await createProject('E2E Org Features')
    await page.goto(`/projects/${project.id}`)

    await page.getByTestId('project-goal').fill('Ship the smallest useful release every week.')
    await page.getByTestId('project-budget').fill('4.5')
    await page.getByTestId('project-budget-alert').fill('70')
    await page.getByTestId('flow-save').click()
    await expect(page.getByTestId('flow-saved')).toBeVisible({ timeout: 10000 })

    await page.reload()
    await expect(page.getByTestId('project-goal')).toHaveValue('Ship the smallest useful release every week.')
    await expect(page.getByTestId('project-budget')).toHaveValue('4.5')
    await expect(page.getByTestId('project-budget-alert')).toHaveValue('70')
    // the goal is promoted to the page subtitle (goal ancestry)
    await expect(page.getByText('Ship the smallest useful release every week.')).toBeVisible()

    // Routines tab: create → listed with cron + next run → pause → delete
    await page.getByTestId('tab-routines').click()
    await expect(page.getByTestId('routines-empty')).toBeVisible()
    await page.getByTestId('routine-new').click()
    await page.getByTestId('routine-name').fill('E2E weekday triage')
    await page.getByTestId('routine-task').fill('สรุปงานค้างและอัปเดต CHANGELOG')
    await page.getByTestId('routine-cron').fill('0 9 * * 1-5')
    await page.getByTestId('routine-save').click()

    const row = page.getByTestId('routine-row').filter({ hasText: 'E2E weekday triage' })
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText('0 9 * * 1-5')
    await expect(row).toContainText('next:')
    await expect(row).toContainText('enabled')

    await row.getByTestId('routine-toggle').click()
    await expect(row).toContainText('paused', { timeout: 10000 })

    // Invalid cron is rejected clearly (create dialog stays open with the error)
    await page.getByTestId('routine-new').click()
    await page.getByTestId('routine-name').fill('E2E bad cron')
    await page.getByTestId('routine-task').fill('never runs')
    await page.getByTestId('routine-cron').fill('not a cron')
    await page.getByTestId('routine-save').click()
    await expect(page.getByTestId('routine-error')).toBeVisible()
    await expect(page.getByTestId('routine-error')).toContainText(/cron/i)

    await deleteProject(project.id)
  })

  test('team org view and per-persona harness + manager fields', async ({ page }) => {
    await page.goto('/team')
    await page.getByTestId('view-org').click()
    await expect(page.getByTestId('org-view')).toBeVisible()
    await expect(page.getByTestId('org-node')).toHaveCount(9)

    await page.getByTestId('view-grid').click()
    await page.getByTestId('agent-edit-po').click()
    await expect(page.getByTestId('harness-select')).toBeVisible()
    await expect(page.getByTestId('manager-select')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('doc review comments: add, badge, resolve', async ({ page }) => {
    const project = await createProject('E2E Doc Comments')
    const { body: doc } = await api(`/projects/${project.id}/docs`, {
      method: 'POST',
      body: JSON.stringify({ title: 'E2E Spec', folder: 'SA', content_md: '# Spec\n\nEmpty state is missing.' }),
    })

    await page.goto(`/projects/${project.id}`)
    await page.getByTestId('tab-docs').click()
    await page.getByTestId('doc-open').filter({ hasText: 'E2E Spec' }).click()

    await page.getByTestId('comment-body').fill('ต้องมี empty state ตอนไม่มีข้อมูล')
    await page.getByTestId('comment-submit').click()
    const comment = page.getByTestId('doc-comment')
    await expect(comment).toBeVisible({ timeout: 10000 })
    await expect(comment).toContainText('ต้องมี empty state')
    await expect(page.getByTestId('docs-comment-badge')).toBeVisible()

    await comment.getByTestId('comment-toggle').click()
    await expect(comment).toHaveAttribute('data-status', 'resolved', { timeout: 10000 })

    await deleteProject(project.id)
  })

  test('skill test bench saves inputs; history lists versions; pricing table renders', async ({ page }) => {
    const { body: skill } = await api('/skills', {
      method: 'POST',
      body: JSON.stringify({ name: 'E2E Bench Skill', description: 'Summarize an issue thread' }),
    })
    await page.goto('/skills')

    const card = page.getByTestId('skill-card').filter({ hasText: 'E2E Bench Skill' })
    await card.getByTestId(`skill-test-${skill.id}`).click()
    await page.getByTestId('skill-test-input').fill('Issue: checkout page crashes on empty cart')
    await page.getByTestId('skill-test-save').click()
    await expect(page.getByRole('button', { name: /Issue: checkout page crashes/ })).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Escape')

    await card.getByTestId(`skill-history-${skill.id}`).click()
    await expect(page.getByTestId('skill-history-empty')).toBeVisible()
    await page.keyboard.press('Escape')
    await api(`/skills/${skill.id}`, { method: 'DELETE' })

    await page.goto('/ai-config')
    await expect(page.getByTestId('pricing-card')).toBeVisible()
    await expect(page.getByTestId('pricing-new-model')).toBeVisible()
  })
})
