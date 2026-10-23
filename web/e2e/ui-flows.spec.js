// UI flows on the isolated stack: the real project page drives a deterministic
// mission (mock LLM, local origin repo, no gh) and the real review/budget cards
// act on it. The web app talks to :8000 by default, so every page is routed to
// the isolated API through useIsolatedApi.
const { test, expect } = require('@playwright/test')
const { useIsolatedApi } = require('./lib/isolated-ui')
const {
  MOCK, get, post, put, login, getToken,
  createProject, deleteProject, createTask, waitRun, waitFor, REPO,
} = require('./lib/isolated')

test.describe.configure({ timeout: 120_000 })

const created = []

test.beforeEach(async ({ page, request }) => {
  test.skip(!process.env.AAP_TEST_API, 'isolated stack only — run tests/start-stack.sh')
  await login(request)
  await request.post(`${MOCK}/__reset`)
  await useIsolatedApi(page, getToken())
})

test.afterAll(async ({ request }) => {
  for (const p of created.splice(0)) if (p) await deleteProject(request, p.id)
})

async function project(request, overrides = {}) {
  const p = await createProject(request, overrides)
  created.push(p)
  return p
}

async function runOf(request, pid) {
  const runs = (await get(request, '/runs')).body.filter(r => r.project_id === pid)
  return runs[0]
}

test('task detail → dispatch → Stop, task leaves in_progress again', async ({ page, request }) => {
  const p = await project(request)
  const task = await createTask(request, p.id, { title: 'UI dispatched task' })

  await page.goto(`/projects/${p.id}/tasks/${task.id}`)
  await expect(page.getByTestId('task-detail')).toBeVisible({ timeout: 15_000 })

  // slow the mock down so Stop lands while the relay is in flight
  await request.post(`${MOCK}/__scenario`, { data: { delayMs: 600 } })

  await page.getByTestId('dispatch-task').click()
  await expect(page.getByTestId('dispatch-task')).toHaveCount(0, { timeout: 15_000 }) // becomes Stop
  const run = await waitFor(async () => runOf(request, p.id), 15_000)
  expect(run.task_id).toBe(task.id)

  const live = await get(request, `/projects/${p.id}/tasks/${task.id}`)
  expect(live.body.status).toBe('in_progress')

  await page.getByRole('button', { name: /Stop/ }).click()
  const stopped = await waitRun(request, run.id, r => r.status === 'stopped')
  expect(stopped.phase).toBe('done')

  const released = await waitFor(async () => {
    const { body } = await get(request, `/projects/${p.id}/tasks/${task.id}`)
    return body.active ? null : body
  }, 15_000)
  expect(released.status).toBe('todo')
})

test('project page mission → review card approves → tail renders (PR skip, demo, summary)', async ({ page, request }) => {
  const p = await project(request, { repo_url: REPO })

  await page.goto(`/projects/${p.id}`)
  await page.getByTestId('task-input').fill('Ship the UI flow mission through the review gate')
  await page.getByTestId('dispatch-team').click()
  await expect(page.getByTestId('run-timeline')).toBeVisible({ timeout: 20_000 })

  // the pre-push review card opens with the team's files
  await expect(page.getByTestId('review-card')).toBeVisible({ timeout: 45_000 })
  await expect(page.getByTestId('review-card')).toHaveAttribute('data-status', 'pending')
  await expect(page.getByTestId('review-card')).toContainText('docs/e2e-dev-fe.md')

  await page.getByTestId('review-comment').fill('Looks good — ship it')
  await page.getByTestId('review-approve').click()

  const run = await waitFor(async () => runOf(request, p.id), 15_000)
  const done = await waitRun(request, run.id)
  expect(done.status).toBe('done')
  expect(done.review.status).toBe('approved')
  expect(done.review.files.some(f => f.includes('docs/e2e-dev-fe.md'))).toBe(true)

  // the run is reopened by the page; tail steps and verdict render
  await page.reload()
  await expect(page.getByTestId('run-timeline')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('run-step-qa')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(page.getByTestId('run-step-dev-fe-pr')).toBeVisible()
  await expect(page.getByTestId('run-step-po-demo')).toBeVisible()
  await expect(page.getByTestId('acceptance-card')).toHaveAttribute('data-verdict', 'pass', { timeout: 20_000 })
  await expect(page.getByTestId('run-summary')).toBeVisible()
  await expect(page.getByTestId('review-card')).toHaveAttribute('data-status', 'approved')
})

test('budget pause renders a budget card; raising it in the UI resumes and finishes', async ({ page, request }) => {
  const before = (await get(request, '/config')).body
  await put(request, '/config', {
    pricing: { 'mock-model': { input_per_mtok: 1000, output_per_mtok: 1000 } },
    default_input_per_mtok: 1000,
    default_output_per_mtok: 1000,
  })
  try {
    const p = await project(request, { budget_usd: 0.5 })
    await page.goto(`/projects/${p.id}`)
    await page.getByTestId('task-input').fill('Mission that must pause on budget')
    await page.getByTestId('dispatch-team').click()

    await expect(page.getByTestId('budget-card')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByTestId('budget-card')).toHaveAttribute('data-status', 'need_human')

    const run = await waitFor(async () => runOf(request, p.id), 15_000)
    const paused = (await get(request, `/runs/${run.id}`)).body
    expect(paused.phase).toBe('budget')
    expect(paused.cost_usd).toBeGreaterThan(0.5)

    await page.getByTestId('budget-amount').fill('50')
    await page.getByTestId('budget-raise').click()
    // the card stays as a record; the pause state is what has to clear
    await expect(page.getByTestId('budget-card')).toHaveAttribute('data-status', 'resolved', { timeout: 20_000 })
    await expect(page.getByTestId('budget-raise')).toHaveCount(0)

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(done.budget_usd).toBe(50)
    await expect(page.getByTestId('acceptance-card')).toHaveAttribute('data-verdict', 'pass', { timeout: 20_000 })
  } finally {
    // never leak a temporary pricing table into the next spec
    await put(request, '/config', {
      pricing: before.pricing,
      default_input_per_mtok: before.default_input_per_mtok,
      default_output_per_mtok: before.default_output_per_mtok,
    }).catch(() => {})
  }
})
