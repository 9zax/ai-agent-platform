const { test, expect } = require('@playwright/test')

const API = 'http://localhost:8000'

// Design + Code missions: dev/UX agents end their reply with a `## FILES`
// block; the orchestrator writes those files into the repo working tree and
// the PR commits everything (git add -A). This spec proves a REAL run produces
// a PR whose diff contains actual code/design files — not just missions/*.md.
//
// Opt-in (real LLM + a PUBLIC throwaway repo):
//   E2E_CODE_MISSION=1 E2E_TEST_REPO=https://github.com/<you>/throwaway
// (optional E2E_DEV_IMAGE to pin the agent image, default = platform default)
test.describe('Design + Code mission', () => {
  test('dev FILES block lands as real files in the mission PR', async ({ page }) => {
    test.skip(!process.env.E2E_CODE_MISSION || !process.env.E2E_TEST_REPO,
      'set E2E_CODE_MISSION=1 + E2E_TEST_REPO=<public throwaway repo URL> to run')

    const NAME = 'E2E Code Mission Project'
    const CONTAINER = `e2e-code-dev-${Date.now()}`
    test.setTimeout(600_000)

    // -- Seed: po + dev-fe + qa team with the repo, and a real dev container
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
        body: JSON.stringify({ name, description: 'code mission e2e' }),
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
      await page.goto(`/projects/${pid}`)
      await page.getByTestId('task-input').fill('เพิ่มไฟล์ design tokens ที่ design/tokens.json (สี+font 5 ตัว) และ component Button ที่ src/button.tsx แบบเรียบง่าย (ไม่ต้องถามเพิ่ม ตอบทันที)')
      await page.getByTestId('dispatch-team').click()
      await expect(page.getByTestId('run-timeline')).toBeVisible()

      const runId = await page.evaluate(async ({ api, projectId }) => {
        const runs = await (await fetch(`${api}/runs`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
        return runs.filter(r => r.project_id === projectId)[0]?.id
      }, { api: API, projectId: pid })
      expect(runId).toBeTruthy()

      // The run finishes (relay + FILES apply + PR + demo are real)
      await expect.poll(async () => {
        return await page.evaluate(async ({ api, rid }) => {
          return (await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()).status
        }, { api: API, rid: runId })
      }, { timeout: 540_000, intervals: [10_000] }).toMatch(/done|error|stopped/)

      const run = await page.evaluate(async ({ api, rid }) => {
        return await (await fetch(`${api}/runs/${rid}`, { headers: { 'x-session-token': localStorage.getItem('aap_token') || '' } })).json()
      }, { api: API, rid: runId })
      const pr = run.steps.find(s => s.kind === 'pr')

      // The dev step must show the honest applied-files note
      const dev = run.steps.find(s => s.role === 'dev-fe' && s.kind === 'work')
      expect(dev.status).toBe('done')
      expect(dev.output).toMatch(/## FILES/)
      expect(dev.output).toMatch(/applied \d+ file\(s\) to the repo working tree/)

      // The PR must exist and carry REAL files (not only missions/*.md)
      expect(pr.status).toBe('done')
      const prUrl = (pr.output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0]
      expect(prUrl).toBeTruthy()
      const files = await page.evaluate(async ({ url }) => {
        const api = url.replace('/pull/', '/pulls/')
        return (await (await fetch(api)).json()).map(f => f.filename)
      }, { url: prUrl })
      expect(files.some(f => !f.startsWith('missions/'))).toBe(true)
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
