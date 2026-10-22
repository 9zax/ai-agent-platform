const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'

// Seed data pushed through the real API — no demo data lives in the app anymore
const SEEDS = [
  { title: 'Update authentication system', description: 'Migrate from session-based to JWT authentication with refresh tokens', status: 'todo', category: 'Backend', priority: 'high', agent: 'JW', due: 'Oct 5' },
  { title: 'Improve dashboard performance', description: 'Reduce initial load time and optimize API queries with caching layer', status: 'todo', category: 'Frontend', priority: 'medium', agent: 'TC', due: 'Oct 8' },
  { title: 'Fix mobile responsiveness', description: 'Dashboard layout breaks on screens smaller than 768px', status: 'todo', category: 'Bug', priority: 'high', agent: 'MK', due: 'Oct 3' },
  { title: 'Add API documentation', description: 'Create OpenAPI specs and publish docs site for public endpoints', status: 'todo', category: 'Docs', priority: 'low', agent: 'SM', due: 'Oct 15' },
  { title: 'Refactor user service', description: 'Break monolith into smaller modules with cleaner interfaces', status: 'todo', category: 'Refactor', priority: 'low', agent: 'JW', due: 'Oct 20' },
  { title: 'Implement user authentication', description: 'JWT with refresh tokens, bcrypt hashing, and rate limiting on login', status: 'in_progress', category: 'Backend', priority: 'high', agent: 'JW', due: 'Oct 2' },
  { title: 'Design system update', description: 'New color palette, spacing scale, and component variants for dark mode', status: 'in_progress', category: 'Design', priority: 'medium', agent: 'SM', due: 'Oct 6' },
  { title: 'API rate limiting', description: 'Add sliding window rate limiter with Redis backend for public API', status: 'in_progress', category: 'Backend', priority: 'medium', agent: 'TC', due: 'Oct 4' },
  { title: 'Database optimization', description: 'Index hot queries, add read replica, tune connection pool sizes', status: 'in_progress', category: 'Database', priority: 'low', agent: 'MK', due: 'Oct 9' },
  { title: 'User service refactored', description: 'Split into auth, profile, and preferences modules — 40% less code', status: 'done', category: 'Refactor', priority: 'low', agent: 'JW', due: 'Sep 28' },
  { title: 'API rate limiting shipped', description: 'Sliding window limiter live in production, 429s down 92%', status: 'done', category: 'Backend', priority: 'low', agent: 'TC', due: 'Sep 30' },
  { title: 'Dark mode polish', description: 'Contrast fixes across all cards, tables, and form controls', status: 'done', category: 'Design', priority: 'low', agent: 'SM', due: 'Sep 25' },
]

test.describe('Board', () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.get(`${API}/tasks`)
    for (const t of await res.json()) {
      await request.delete(`${API}/tasks/${t.id}`)
    }
    for (const t of SEEDS) {
      await request.post(`${API}/tasks`, { data: t })
    }
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/board')
    await expect(page.getByRole('heading', { name: 'AI Orchestrator Board' })).toBeVisible()
  })

  test('shows three columns whose counts match the API', async ({ page }) => {
    const heads = page.getByTestId('board-col-head')
    await expect(heads).toHaveCount(3)
    await expect(heads.nth(0)).toContainText('To Do')
    await expect(heads.nth(1)).toContainText('In Progress')
    await expect(heads.nth(2)).toContainText('Done')

    // Column counts track the API even while other tests mutate it (retry until consistent)
    await expect(async () => {
      const apiTasks = await page.evaluate(async () => {
        const res = await fetch('http://localhost:8000/tasks')
        return res.json()
      })
      for (let i = 0; i < 3; i++) {
        const expected = apiTasks.filter(t => t.status === ['todo', 'in_progress', 'done'][i]).length
        const actual = Number((await heads.nth(i).textContent()).replace(/\D+/g, ''))
        if (actual !== expected) throw new Error(`column ${i}: DOM ${actual} != API ${expected}`)
      }
      const domCards = await page.getByTestId('task-card').count()
      if (domCards !== apiTasks.length) throw new Error(`cards: DOM ${domCards} != API ${apiTasks.length}`)
    }).toPass({ timeout: 15000 })
  })

  test('renders task cards with category badges', async ({ page }) => {
    await expect(page.getByText('Update authentication system')).toBeVisible()
    await expect(page.getByText('Implement user authentication')).toBeVisible()
    await expect(async () => {
      const apiCount = await page.evaluate(async () => {
        const res = await fetch('http://localhost:8000/tasks')
        return (await res.json()).length
      })
      const domCount = await page.getByTestId('task-card').count()
      if (domCount !== apiCount) throw new Error(`cards: DOM ${domCount} != API ${apiCount}`)
    }).toPass({ timeout: 15000 })
    await expect(page.getByTestId('task-card').first()).toContainText('Backend')
  })

  test('search filters task cards across columns', async ({ page }) => {
    await page.getByPlaceholder('Search tasks...').fill('authentication')
    await expect(page.getByTestId('task-card')).toHaveCount(2)
  })

  test('search with no match empties all columns', async ({ page }) => {
    await page.getByPlaceholder('Search tasks...').fill('no-such-task-xyz')
    await expect(page.getByTestId('task-card')).toHaveCount(0)
  })

  test('board nav item is active in the sidebar', async ({ page }) => {
    await expect(page.getByTestId('nav-board')).toHaveAttribute('aria-current', 'page')
  })
})
