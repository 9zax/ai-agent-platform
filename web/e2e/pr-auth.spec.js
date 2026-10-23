const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'

// The PR stage's in-mission GitHub connector: when gh is not authenticated, a
// device flow is minted for the dev's container and surfaced in the mission
// chat as a need-human note carrying the verification URL + user code. The
// browser approval itself cannot be automated — Test A mocks the run to pin
// the chat rendering; Test B (opt-in via E2E_GITHUB_DEVICE=1 + E2E_TEST_REPO)
// drives a REAL run to the waiting state and verifies the honest skip on Stop.
// Manual approval path: run Test B's setup by hand, click the linkified URL in
// the chat, enter the code — the chat should show "✅ GitHub connected as
// @<login>" and the run opens a real PR without any chat reply.

const DISC_NOTE = '🐙 ขั้นตอน PR ต้องใช้สิทธิ์ GitHub — อนุมัติให้ container ของ Dev:\n1) เปิด https://github.com/login/device\n2) ใส่รหัส ABCD-1234 (หมดอายุใน ~15 นาที)\nเชื่อมต่อสำเร็จแล้วทีมจะ push และเปิด PR ต่อทันที'

const mockRun = () => ({
  id: 'mock-run-prauth',
  project_id: 'proj-prauth-mock',
  project_name: 'PR Auth Mock Project',
  task: 'mock task',
  status: 'waiting_human',
  steps: [{ role: 'dev-fe', name: 'Dev FE', title: 'Dev', kind: 'work', status: 'done', output: '', model: null, container: null, deliverable: null, rev: null, started_at: 1, finished_at: 2 }],
  phase: 'meeting',
  round: 1,
  created_at: Math.floor(Date.now() / 1000),
  discussions: [{
    id: 'disc-prauth-1',
    kind: '',
    from: 'dev-fe',
    to: ['human'],
    topic: 'GitHub connector — อนุมัติสิทธิ์ push เพื่อเปิด PR',
    status: 'need_human',
    answering: 'human',
    messages: [{ from: 'orchestrator', text: DISC_NOTE, at: Math.floor(Date.now() / 1000) }],
    round: 1,
    created_at: Math.floor(Date.now() / 1000),
  }],
})

test.describe('PR-stage GitHub connector', () => {
  test('mission chat renders the device-flow request: linkified URL, highlighted code, reply form', async ({ page }) => {
    // scope every mock to the API origin — a bare **/projects/<id> glob would
    // also fulfill the page navigation itself
    await page.route(`${API}/runs/mock-run-prauth`, route => route.fulfill({ json: mockRun() }))
    await page.route(`${API}/runs`, route => route.fulfill({ json: [mockRun()] }))
    await page.route(`${API}/projects/proj-prauth-mock`, route => route.fulfill({
      json: { id: 'proj-prauth-mock', name: 'PR Auth Mock Project', repo_url: '', agents: ['dev-fe'], links: [] },
    }))
    await page.goto('/projects/proj-prauth-mock')

    // the need-human meeting card with the "waiting for you" badge
    const meeting = page.getByTestId('meeting-disc-prauth-1')
    await expect(meeting).toBeVisible()
    await expect(meeting).toContainText('⏸ รอคุณตอบ')

    // the orchestrator note: URL clickable, device code highlighted, reply form ready
    const note = page.getByTestId('chat-note').filter({ hasText: 'github.com/login/device' })
    await expect(note).toBeVisible()
    await expect(note.locator('a[href="https://github.com/login/device"]')).toHaveAttribute('target', '_blank')
    await expect(note.getByTestId('device-code')).toHaveText('ABCD-1234')
    await expect(page.getByTestId('human-reply')).toBeVisible()
  })

  // Opt-in: needs a real LLM key, a PUBLIC throwaway repo, and the
  // agent-base image (platform default). Set:
  //   E2E_GITHUB_DEVICE=1 E2E_TEST_REPO=https://github.com/<you>/throwaway
  // (optional E2E_DEV_IMAGE to pin the agent image)
  test('real run: waits for device approval with code in chat, skips honestly on Stop', async ({ page }) => {
    test.skip(!process.env.E2E_GITHUB_DEVICE || !process.env.E2E_TEST_REPO,
      'set E2E_GITHUB_DEVICE=1 + E2E_TEST_REPO=<public throwaway repo URL> to run')

    const NAME = 'E2E PR-Auth Project'
    const CONTAINER = `e2e-prauth-dev-${Date.now()}`
    test.setTimeout(600_000)

    // -- Seed: project with repo + po/dev-fe/qa, and a real dev container
    await page.goto('/projects')
    const pid = await page.evaluate(async ({ api, name, repo }) => {
      const token = localStorage.getItem('aap_token') || ''
      const headers = { 'Content-Type': 'application/json', 'x-session-token': token }
      const existing = await (await fetch(`${api}/projects`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      for (const p of existing.filter(p => p.name === name)) {
        await fetch(`${api}/projects/${p.id}`, { method: 'DELETE', headers })
      }
      const created = await (await fetch(`${api}/projects`, {
        method: 'POST', headers,
        body: JSON.stringify({ name, description: 'pr-auth e2e' }),
      })).json()
      await fetch(`${api}/projects/${created.id}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ agents: ['po', 'dev-fe', 'qa'], repo_url: repo }),
      })
      return created.id
    }, { api: API, name: NAME, repo: process.env.E2E_TEST_REPO })

    await page.evaluate(async ({ api, container, image }) => {
      const token = localStorage.getItem('aap_token') || ''
      await fetch(`${api}/containers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': token },
        body: JSON.stringify(image ? { name: container, role: 'dev-fe', image } : { name: container, role: 'dev-fe' }),
      })
    }, { api: API, container: CONTAINER, image: process.env.E2E_DEV_IMAGE || null })

    try {
      // -- Dispatch a short mission; the relay is real LLM work
      await page.goto(`/projects/${pid}`)
      await page.getByTestId('task-input').fill('เขียน checklist สั้น ๆ 3 ข้อสำหรับปรับปรุง README (ไม่ต้องถามเพิ่ม ตอบทันที)')
      await page.getByTestId('dispatch-team').click()
      await expect(page.getByTestId('run-timeline')).toBeVisible()

      const runId = await page.evaluate(async ({ api, projectId }) => {
        const runs = await (await fetch(`${api}/runs`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
        return runs.filter(r => r.project_id === projectId)[0]?.id
      }, { api: API, projectId: pid })
      expect(runId).toBeTruthy()

      // -- The PR stage should reach the device-flow wait: a need-human
      //    discussion carrying the URL (poll on the discussion itself, not the
      //    run status — an ordinary LLM ASK can also flip waiting_human)
      let disc = null
      await expect.poll(async () => {
        const run = await page.evaluate(async ({ api, rid }) => {
          return await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
        }, { api: API, rid: runId })
        disc = (run.discussions || []).find(d =>
          d.status === 'need_human' && (d.messages || []).some(m =>
            m.from === 'orchestrator' && /github\.com\/login\/device/.test(m.text)))
        return disc ? 'arrived' : 'waiting'
      }, { timeout: 420_000, intervals: [10_000] }).toBe('arrived')

      const run = await page.evaluate(async ({ api, rid }) => {
        return await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      }, { api: API, rid: runId })
      expect(run.status).toBe('waiting_human')

      // the container's GitHub connector is pending with a user code
      const cid = await page.evaluate(async ({ api, name }) => {
        const list = await (await fetch(`${api}/containers`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
        return (list.find(c => c.name === name) || {}).id
      }, { api: API, name: CONTAINER })
      const connectors = await page.evaluate(async ({ api, containerId }) => {
        return await (await fetch(`${api}/containers/${containerId}/connectors`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      }, { api: API, containerId: cid })
      const github = (connectors || []).find(c => c.type === 'github')
      expect(github?.state).toBe('pending')
      expect(github?.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)

      // -- UI: the linkified note + the waiting badge
      await page.goto(`/projects/${pid}`)
      const note = page.getByTestId('chat-note').filter({ hasText: 'github.com/login/device' })
      await expect(note).toBeVisible({ timeout: 30_000 })
      await expect(note.getByTestId('device-code')).toBeVisible()

      // -- Stop: the stage must end as an honest skip, the run closed cleanly
      await page.evaluate(async ({ api, rid }) => {
        const token = localStorage.getItem('aap_token') || ''
        await fetch(`${api}/runs/${rid}/stop`, { method: 'POST', headers: { 'x-session-token': token } })
      }, { api: API, rid: runId })
      await expect.poll(async () => {
        return await page.evaluate(async ({ api, rid }) => {
          return (await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()).status
        }, { api: API, rid: runId })
      }, { timeout: 60_000, intervals: [2_000] }).toBe('stopped')

      const stopped = await page.evaluate(async ({ api, rid }) => {
        return await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      }, { api: API, rid: runId })
      const prStep = stopped.steps.find(s => s.kind === 'pr')
      expect(prStep).toBeTruthy()
      expect(['skipped', 'done']).toContain(prStep.status)
      if (prStep.status === 'skipped') expect(prStep.output.length).toBeGreaterThan(10)
    } finally {
      await page.evaluate(async ({ api, container, projectId }) => {
        const token = localStorage.getItem('aap_token') || ''
        const headers = { 'x-session-token': token }
        const list = await (await fetch(`${api}/containers`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
        const mine = (list.find(c => c.name === container) || {}).id
        if (mine) await fetch(`${api}/containers/${mine}`, { method: 'DELETE', headers })
        await fetch(`${api}/projects/${projectId}`, { method: 'DELETE', headers })
      }, { api: API, container: CONTAINER, projectId: pid }).catch(() => {})
    }
  })
})
