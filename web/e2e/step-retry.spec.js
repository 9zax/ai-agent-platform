const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'
const NAME = 'E2E Step Retry Project'

// Per-step retry: failures are per-step, so recovery must be per-step too.
// qa is forced to fail with a model that does not exist (hard provider error,
// fails fast inside llm_retry) while po completes normally. The per-step retry
// button then redoes ONLY qa's step in place: po's deliverable is untouched,
// no new run is created, and the run closes done. Everything is live
// (LLM + orchestrator); no mocks.
test.describe('Per-step retry — redo ONE failed step, keep the rest', () => {
  test('qa fails → retry only qa → done, po untouched, no new run', async ({ page }) => {
    test.setTimeout(600_000)

    // -- Seed: clean slate, a minimal team po + qa, and qa pointed at a
    //    nonexistent model so exactly its step dies. qa's ORIGINAL model
    //    override is snapshotted first and restored in the finally below —
    //    the spec must not leave the user's persona config mutated.
    await page.goto('/projects')
    const { id, qaOrigModel } = await page.evaluate(async ({ api, name }) => {
      const token = localStorage.getItem('aap_token') || ''
      const headers = { 'Content-Type': 'application/json', 'x-session-token': token }
      for (const p of (await (await fetch(`${api}/projects`, { headers })).json()).filter(p => p.name === name)) {
        await fetch(`${api}/projects/${p.id}`, { method: 'DELETE', headers })
      }
      const created = await (await fetch(`${api}/projects`, {
        method: 'POST', headers,
        body: JSON.stringify({ name, description: 'per-step retry e2e' }),
      })).json()
      await fetch(`${api}/projects/${created.id}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ agents: ['po', 'qa'] }),
      })
      // the override on the ACTIVE provider is the one update_persona writes
      const provider = (await (await fetch(`${api}/config`, { headers })).json()).ai_provider
      const qa = (await (await fetch(`${api}/agents`, { headers })).json()).find(a => a.role === 'qa')
      const qaOrigModel = (qa.model_overrides || {})[provider] || ''
      await fetch(`${api}/agents/qa`, {
        method: 'PUT', headers,
        body: JSON.stringify({ model: 'e2e-model-that-does-not-exist' }),
      })
      return { id: created.id, qaOrigModel }
    }, { api: API, name: NAME })

    try {
      // -- Dispatch through the real UI (loop off)
      const TASK = 'เขียนข้อควรทำ 2 ข้อสั้น ๆ เพื่อปรับปรุงหน้า Login (ไม่ต้องถามเพิ่ม ตอบทันที)'
      await page.goto(`/projects/${id}`)
      await page.getByTestId('task-input').fill(TASK)
      await page.getByTestId('dispatch-team').click()
      await expect(page.getByTestId('run-timeline')).toBeVisible()

      const getRun = runId => page.evaluate(async ({ api, rid }) => {
        return await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      }, { api: API, rid: runId })

      const runId = await page.evaluate(async ({ api, pid }) => {
        const runs = await (await fetch(`${api}/runs`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
        return runs.filter(r => r.project_id === pid)[0]?.id
      }, { api: API, pid: id })
      expect(runId).toBeTruthy()

      // -- Wait for the mission to close: po done, qa error → run done (not all-error)
      let run
      await expect.poll(async () => (await getRun(runId)).status, { timeout: 540_000, intervals: [5_000] }).toMatch(/done|error|stopped/)
      run = await getRun(runId)
      expect(run.status).toBe('done')
      const po = run.steps.find(s => s.role === 'po' && s.kind === 'work')
      const qa = run.steps.find(s => s.role === 'qa' && s.kind === 'work')
      expect(po.status).toBe('done')
      expect(qa.status).toBe('error')
      expect(qa.output.length).toBeGreaterThan(5) // the real provider error, never silence

      // -- UI: the per-step retry button exists ONLY on the failed step,
      //    and the whole-mission retry is offered separately
      await page.goto(`/projects/${id}`)
      await expect(page.getByTestId('run-timeline')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('run-step-qa')).toHaveAttribute('data-status', 'error', { timeout: 10_000 })
      await expect(page.getByTestId('retry-step-qa')).toBeVisible()
      await expect(page.getByTestId('retry-step-po')).toHaveCount(0)
      await expect(page.getByTestId('retry-mission')).toBeVisible()

      // -- Fix the cause (qa's model back to its original override), then
      //    retry ONLY qa's step through the UI
      await page.evaluate(async ({ api, model }) => {
        await fetch(`${api}/agents/qa`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-session-token': localStorage.getItem('aap_token') || '' },
          body: JSON.stringify({ model }),
        })
      }, { api: API, model: qaOrigModel })
      await page.getByTestId('retry-step-qa').click()

      // -- The step redoes in place: qa done, run closes done again
      await expect.poll(async () => {
        run = await getRun(runId)
        return run.steps.find(s => s.role === 'qa' && s.kind === 'work').status
      }, { timeout: 300_000, intervals: [5_000] }).toBe('done')
      expect(run.status).toBe('done')

      // -- Scope proof: po's deliverable is byte-identical, still exactly ONE
      //    run for the project (retry is in-place, never a new run)
      const poAfter = run.steps.find(s => s.role === 'po' && s.kind === 'work')
      expect(poAfter.output).toBe(po.output)
      expect(poAfter.rev || null).toBe(po.rev || null)
      const runsNow = await page.evaluate(async ({ api, pid }) => {
        return (await (await fetch(`${api}/runs`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json())
          .filter(r => r.project_id === pid).length
      }, { api: API, pid: id })
      expect(runsNow).toBe(1)

      // -- Nothing failed anymore → both retry buttons are gone
      await expect(page.getByTestId('retry-step-qa')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('retry-mission')).toHaveCount(0)
    } finally {
      // -- Cleanup: project away + qa's model override back to its original
      //    value (covers a failure before the fix step restored it)
      await page.evaluate(async ({ api, pid, model }) => {
        await fetch(`${api}/agents/qa`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-session-token': localStorage.getItem('aap_token') || '' },
          body: JSON.stringify({ model }),
        }).catch(() => {})
        await fetch(`${api}/projects/${pid}`, { method: 'DELETE', headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })
      }, { api: API, pid: id, model: qaOrigModel }).catch(() => {})
    }
  })
})
