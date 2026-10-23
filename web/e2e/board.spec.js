const { test, expect } = require('@playwright/test')
const { authHeaders } = require('./lib/auth')

const API = 'http://localhost:8000'
const SEED_NAME = 'E2E Board Project'

// Orchestrator board — per-project state cards fed by the real /projects + /runs APIs.
// Runs are never created here: POST /projects/{id}/run spawns a real LLM/container run.
test.describe('Board', () => {
  let projectId

  test.beforeEach(async ({ request }) => {
    // Clean leftovers from a previous aborted run, then seed a fresh no-run project
    const res = await request.get(`${API}/projects`, { headers: authHeaders() })
    for (const p of await res.json()) {
      if (p.name === SEED_NAME) await request.delete(`${API}/projects/${p.id}`, { headers: authHeaders() })
    }
    const created = await request.post(`${API}/projects`, {
      headers: authHeaders(),
      data: { name: SEED_NAME, description: 'orchestrator board test' },
    })
    projectId = (await created.json()).id
  })

  test.afterEach(async ({ request }) => {
    if (projectId) await request.delete(`${API}/projects/${projectId}`, { headers: authHeaders() })
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'AI Orchestrator Board' })).toBeVisible()
  })

  test('shows a card per project with empty-run state for the seed', async ({ page }) => {
    const card = page.getByTestId('board-project-card').filter({ hasText: SEED_NAME })
    await expect(card).toBeVisible()
    await expect(card).toContainText('orchestrator board test')
    await expect(card.getByTestId('board-empty-runs')).toBeVisible()
    await expect(card.getByTestId('board-run-count')).toHaveText('0 runs')
    await expect(card.getByTestId('board-mission-control')).toHaveAttribute('href', `/projects/${projectId}`)
  })

  test('card count tracks the API even while other serial tests mutate projects', async ({ page }) => {
    await expect(async () => {
      const apiProjects = await page.evaluate(async () => {
        const res = await fetch('http://localhost:8000/projects', {
          headers: { 'x-session-token': localStorage.getItem('aap_token') || '' },
        })
        return res.json()
      })
      const domCards = await page.getByTestId('board-project-card').count()
      if (domCards !== apiProjects.length) throw new Error(`cards: DOM ${domCards} != API ${apiProjects.length}`)
    }).toPass({ timeout: 15000 })
  })

  test('renders latest run with per-agent chips when the project has runs', async ({ page, request }) => {
    // Only assert against runs that already exist — creating one here is too heavy
    const [runs, projects] = await Promise.all([
      request.get(`${API}/runs`, { headers: authHeaders() }).then(r => r.json()),
      request.get(`${API}/projects`, { headers: authHeaders() }).then(r => r.json()),
    ])
    const withRuns = new Map(runs.map(r => [r.project_id, r]))
    const target = projects.find(p => withRuns.has(p.id))
    test.skip(!target, 'no pre-existing runs on the backend')

    const card = page.getByTestId('board-project-card').filter({ hasText: target.name }).first()
    await expect(card.getByTestId('board-latest-run')).toBeVisible()
    await expect(card.getByTestId('board-run-status')).toBeVisible()

    // Chip count tracks the latest run's steps. Re-read the API on every try:
    // a live mission keeps appending steps (and may spawn the next run), so a
    // snapshot taken once would go stale while the card correctly moves on.
    await expect(async () => {
      const current = await request.get(`${API}/runs`, { headers: authHeaders() }).then(r => r.json())
      const latest = current
        .filter(r => r.project_id === target.id)
        .sort((a, b) => b.created_at - a.created_at)[0]
      const chips = await card.getByTestId('board-agent-chip').count()
      if (chips !== latest.steps.length) throw new Error(`chips: DOM ${chips} != API ${latest.steps.length}`)
    }).toPass({ timeout: 20000 })
  })

  test('search filters project cards', async ({ page }) => {
    await page.getByTestId('board-search').fill(SEED_NAME)
    await expect(page.getByTestId('board-project-card')).toHaveCount(1)
    await page.getByTestId('board-search').fill('no-such-project-xyz')
    await expect(page.getByTestId('board-project-card')).toHaveCount(0)
  })

  test('orchestrator nav item is active in the sidebar', async ({ page }) => {
    await expect(page.getByTestId('nav-orchestrator')).toHaveAttribute('aria-current', 'page')
  })
})
