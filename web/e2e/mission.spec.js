const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'
const NAME = 'E2E Mission Project'

// The first spec that dispatches a REAL team run end-to-end: relay (po → dev-fe
// → qa) → tail stages (pr / deploy / demo) → PO summary. Everything is live
// (LLM + orchestrator); no mocks. No agent containers are started, so the PR
// and deploy stages land as skipped-with-reason in a default environment — the
// acceptance demo session and its verdict always run (LLM-only) and are
// asserted unconditionally.
test.describe('Mission pipeline — relay → PR → deploy → acceptance demo', () => {
  test('full mission: QA done → (real or skipped) PR/deploy → demo verdict + PO summary', async ({ page }) => {
    test.setTimeout(600_000)

    // -- Seed: clean slate, then a minimal team po + dev-fe + qa via the API
    //    (same authenticated-fetch pattern as team.spec.js — harmless when auth is off)
    await page.goto('/projects')
    const { id } = await page.evaluate(async ({ api, name }) => {
      const token = localStorage.getItem('aap_token') || ''
      const headers = { 'Content-Type': 'application/json', 'x-session-token': token }
      const existing = await (await fetch(`${api}/projects`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      for (const p of existing.filter(p => p.name === name)) {
        await fetch(`${api}/projects/${p.id}`, { method: 'DELETE', headers })
      }
      const created = await (await fetch(`${api}/projects`, {
        method: 'POST', headers,
        body: JSON.stringify({ name, description: 'mission tail e2e' }),
      })).json()
      await fetch(`${api}/projects/${created.id}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ agents: ['po', 'dev-fe', 'qa'] }),
      })
      return { id: created.id }
    }, { api: API, name: NAME })

    // -- Dispatch through the real UI (loop off)
    const TASK = 'เขียนรายงานสั้น ๆ 3 ข้อ ว่าควรปรับปรุงหน้า Dashboard อย่างไรให้เร็วขึ้น (ไม่ต้องถามเพิ่ม ตอบทันที)'
    await page.goto(`/projects/${id}`)
    await page.getByTestId('task-input').fill(TASK)
    await page.getByTestId('dispatch-team').click()
    await expect(page.getByTestId('run-timeline')).toBeVisible()

    // The run for this project (fetch the id from the API — the UI polls the same object)
    const runId = await page.evaluate(async ({ api, pid }) => {
      const runs = await (await fetch(`${api}/runs`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      const mine = runs.filter(r => r.project_id === pid)
      return mine[0]?.id
    }, { api: API, pid: id })
    expect(runId).toBeTruthy()

    // -- Wait for the mission to finish (relay + tail + demo are real LLM calls)
    await expect.poll(async () => {
      return await page.evaluate(async ({ api, rid }) => {
        return (await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()).status
      }, { api: API, rid: runId })
    }, { timeout: 540_000, intervals: [5_000] }).toMatch(/done|error|stopped/)

    const run = await page.evaluate(async ({ api, rid }) => {
      return await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
    }, { api: API, rid: runId })
    expect(run.status).toBe('done')

    // -- Step assertions: order-independent kinds, QA done, honest tail stages
    const kinds = run.steps.map(s => `${s.role}:${s.kind || 'work'}`)
    for (const expected of ['po:work', 'dev-fe:work', 'qa:work', 'dev-fe:pr', 'dev-fe:deploy', 'po:demo']) {
      expect(kinds).toContain(expected)
    }
    expect(run.steps.find(s => s.role === 'qa' && s.kind === 'work').status).toBe('done')

    for (const kind of ['pr', 'deploy']) {
      const step = run.steps.find(s => s.kind === kind)
      expect(['done', 'skipped']).toContain(step.status)
      if (step.status === 'skipped') {
        // an honest reason, never silence
        expect(step.output.length).toBeGreaterThan(10)
      }
      if (step.status === 'done' && kind === 'pr') {
        // a REAL pull-request URL or nothing — never a fabricated link
        expect(step.output).toMatch(/https:\/\/github\.com\/\S+\/pull\/\d+/)
      }
    }
    expect(run.steps.find(s => s.kind === 'demo').status).toBe('done')

    // -- Acceptance demo session: a demo-kind discussion with the scripted flow
    const demo = (run.discussions || []).find(d => d.kind === 'demo')
    expect(demo).toBeTruthy()
    expect(demo.messages.length).toBeGreaterThanOrEqual(5) // intro + qa + dev + record + po
    // the verdict may ride the PO's closing message OR only the parsed acceptance — either is a real verdict
    expect(demo.messages.some(m => m.from === 'po' && /VERDICT:\s*(PASS|FAIL|ผ่าน|ไม่ผ่าน)/i.test(m.text)) || !!run.acceptance).toBe(true)

    // -- Acceptance verdict stored on the run
    expect(run.acceptance).toBeTruthy()
    expect(['pass', 'fail']).toContain(run.acceptance.verdict)

    // -- PO closing summary mentions the delivery
    expect(run.summary).toBeTruthy()

    // -- UI renders the whole tail: kind steps, verdict card, summary
    //    (the page restores the run via GET /runs on load — give it room)
    await page.goto(`/projects/${id}`)
    await expect(page.getByTestId('run-timeline')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('run-step-qa')).toHaveAttribute('data-status', 'done', { timeout: 10_000 })
    await expect(page.getByTestId('run-step-dev-fe-pr')).toBeVisible()
    await expect(page.getByTestId('run-step-dev-fe-deploy')).toBeVisible()
    await expect(page.getByTestId('run-step-po-demo')).toBeVisible()
    await expect(page.getByTestId(`demo-${demo.id}`)).toBeVisible()
    await expect(page.getByTestId('acceptance-card')).toHaveAttribute('data-verdict', /pass|fail/)
    await expect(page.getByTestId('run-summary')).toBeVisible()

    // -- Cleanup (runs are kept — they are the agents' work history)
    await page.evaluate(async ({ api, pid }) => {
      const token = localStorage.getItem('aap_token') || ''
      await fetch(`${api}/projects/${pid}`, { method: 'DELETE', headers: { 'x-session-token': token } })
    }, { api: API, pid: id })
  })
})
