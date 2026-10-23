// Exhaustive REST contract + validation tests against the isolated stack
// (tests/start-stack.sh). Never runs against the real server: every test
// mutates throwaway DATA_DIR state.
const { test, expect } = require('@playwright/test')
const {
  isolatedOnly, unique, get, post, put, del, login, getToken,
  createProject, deleteProject, createTask, waitRun,
  REPO,
} = require('./lib/isolated')

test.beforeEach(() => {
  test.skip(!process.env.AAP_TEST_API, 'isolated stack only — run tests/start-stack.sh')
})

test.describe('meta + auth', () => {
  test('root, health and providers are public', async ({ request }) => {
    const root = await get(request, '/', { noAuth: true })
    expect(root.status).toBe(200)
    expect(root.body.service).toBeTruthy()

    const health = await get(request, '/health', { noAuth: true })
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({ status: 'healthy', mode: 'host', tmux: true })

    const providers = await get(request, '/providers', { noAuth: true })
    expect(providers.status).toBe(200)
    expect(Array.isArray(providers.body)).toBe(true)
    expect(providers.body.map(p => p.id)).toEqual(expect.arrayContaining(['openai', 'anthropic', 'zai']))
    for (const p of providers.body) {
      for (const key of ['id', 'label', 'protocol', 'base_url', 'model', 'models', 'local']) {
        expect(p).toHaveProperty(key)
      }
    }
  })

  test('login rejects bad credentials, me/lougout track the session, invalid token is 401', async ({ request }) => {
    const bad = await login(request, 'admin', 'definitely-wrong')
    expect(bad.status).toBe(401)
    expect(bad.body.detail).toMatch(/Invalid username or password/i)

    const wrongUser = await login(request, 'root', 'testpass')
    expect(wrongUser.status).toBe(401)

    const good = await login(request)
    expect(good.status).toBe(200)
    expect(good.body.ok).toBe(true)
    expect(good.body.token).toHaveLength(64)

    const me = await get(request, '/auth/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ auth_required: true, valid: true, user: 'admin' })

    const noToken = await get(request, '/containers', { noAuth: true })
    expect(noToken.status).toBe(401)
    expect(noToken.body.detail).toMatch(/Login required/)
    const forged = await get(request, '/containers', { token: 'f'.repeat(64) })
    expect(forged.status).toBe(401)

    const token = getToken()
    const out = await post(request, '/auth/logout', { password: token })
    expect(out.status).toBe(200)
    // logout takes the token in the body `password` field — the helper still
    // sends the old header, which must now be dead
    const stale = await get(request, '/auth/me')
    expect(stale.body.valid).toBe(false)
    const dead = await get(request, '/agents', { noRetry: true })
    expect(dead.status).toBe(401)

    const again = await login(request)
    expect(again.status).toBe(200)
    const live = await get(request, '/agents')
    expect(live.status).toBe(200)
  })

  test('auth/verify checks the stored admin password hash', async ({ request }) => {
    // the hash starts empty; set it through the config API
    const saved = await put(request, '/config', { admin_password: 'testpass' })
    expect(saved.status).toBe(200)
    expect(saved.body.admin_password_set).toBe(true)

    const wrong = await post(request, '/auth/verify', { password: 'nope' })
    expect(wrong.status).toBe(200)
    expect(wrong.body.ok).toBe(false)

    const right = await post(request, '/auth/verify', { password: 'testpass' })
    expect(right.body.ok).toBe(true)
  })

  test('agent/status reflects the isolated mock config', async ({ request }) => {
    const res = await get(request, '/agent/status')
    expect(res.status).toBe(200)
    expect(res.body.provider_id).toBe('openai')
    expect(res.body.key_configured).toBe(true)
    expect(res.body.base_url).toContain('/v1')
  })

  test('models lists the mock provider catalogue', async ({ request }) => {
    const res = await get(request, '/models')
    expect(res.status).toBe(200)
    expect(res.body.models).toContain('mock-model')
    expect(res.body.source).toBe('live')
    expect(res.body.provider_id).toBe('openai')
  })

  test('unknown route returns JSON 404', async ({ request }) => {
    const res = await get(request, '/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ detail: 'Not Found' })
  })
})

test.describe('containers (host tmux)', () => {
  test('create validates, exec runs, pause/stop/start/restart/delete lifecycle', async ({ request }) => {
    const missing = await post(request, '/containers', { name: '', role: 'dev' })
    expect(missing.status).toBe(400)

    const name = unique('e2e-api-box')
    const created = await post(request, '/containers', { name, role: 'dev' })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ id: name, name, status: 'running' })

    const listed = await get(request, '/containers?all=true')
    expect(listed.status).toBe(200)
    expect(listed.body.find(c => c.id === name)?.status).toBe('running')

    const exec = await post(request, `/containers/${name}/exec`, { command: 'echo contract-$((6*7))' })
    expect(exec.status).toBe(200)
    expect(exec.body.exit_code).toBe(0)
    expect(exec.body.output.trim()).toBe('contract-42')

    const badAction = await post(request, `/containers/${name}/nope`, {})
    expect(badAction.status).toBe(404)

    const paused = await post(request, `/containers/${name}/pause`, {})
    expect(paused.body.status).toBe('paused')
    const afterPause = (await get(request, '/containers')).body.find(c => c.id === name)
    expect(afterPause.status).toBe('paused')

    // exec transparently revives a platform-paused agent
    const revived = await post(request, `/containers/${name}/exec`, { command: 'true' })
    expect(revived.status).toBe(200)

    const stopped = await post(request, `/containers/${name}/stop`, {})
    expect(stopped.body.status).toBe('exited')
    const execStopped = await post(request, `/containers/${name}/exec`, { command: 'true' })
    expect(execStopped.status).toBe(400)
    expect(execStopped.body.detail).toMatch(/not running/i)

    const started = await post(request, `/containers/${name}/start`, {})
    expect(started.body.status).toBe('running')
    const restarted = await post(request, `/containers/${name}/restart`, {})
    expect(restarted.body.status).toBe('running')

    const gone = await del(request, `/containers/${name}`)
    expect(gone.status).toBe(200)
    expect(gone.body.status).toBe('deleted')
    const unknown = await post(request, `/containers/${name}/exec`, { command: 'true' })
    expect(unknown.status).toBe(404)

    // relative URL form should resolve agent-<role> too
    await post(request, '/containers', { name: 'agent-e2e-role-box', role: 'e2e-role-box' })
    const byRole = await post(request, '/containers/agent-e2e-role-box/exec', { command: 'echo role-ok' })
    expect(byRole.status).toBe(200)
    expect(byRole.body.output.trim()).toBe('role-ok')
    await del(request, '/containers/agent-e2e-role-box')
  })

  test('stats, inspect and files answer for a live host agent', async ({ request }) => {
    const name = unique('e2e-api-meta')
    await post(request, '/containers', { name, role: 'meta' })

    const stats = await get(request, `/containers/${name}/stats`)
    expect(stats.status).toBe(200)
    expect(stats.body.status).toBe('running')
    expect(stats.body.disk_total).toBeGreaterThan(0)
    const inspect = await get(request, `/containers/${name}/inspect`)
    expect(inspect.status).toBe(200)
    expect(inspect.body).toMatchObject({ id: name, image: 'host', state: 'running' })
    const files = await get(request, `/containers/${name}/files?path=.`)
    expect(files.status).toBe(200)
    expect(files.body).toHaveProperty('output')

    const missing = await get(request, '/containers/no-such-agent/stats')
    expect(missing.status).toBe(404)
    await del(request, `/containers/${name}`)
  })

  test('connectors catalog, status and per-container actions', async ({ request }) => {
    const catalog = await get(request, '/connectors')
    expect(catalog.status).toBe(200)
    expect(JSON.stringify(catalog.body)).toContain('github')

    const status = await get(request, '/connectors/status')
    expect(status.status).toBe(200)

    const name = unique('e2e-api-conn')
    await post(request, '/containers', { name, role: 'conn' })
    const per = await get(request, `/containers/${name}/connectors`)
    expect(per.status).toBe(200)

    const noFlow = await post(request, `/containers/${name}/connectors/github/open-browser`, {})
    expect(noFlow.status).toBe(400)
    expect(noFlow.body.detail).toMatch(/No active GitHub login flow/i)

    // this stack's PATH has no gh — the handler must say so instead of crashing
    const ghToken = await post(request, `/containers/${name}/connectors/github/connect-token`, { token: '' })
    expect(ghToken.status).toBe(400)
    expect(ghToken.body.detail).toMatch(/gh CLI not installed|Token is required/i)

    const figmaEmpty = await post(request, `/containers/${name}/connectors/figma/connect-token`, { token: ' ' })
    expect(figmaEmpty.status).toBe(400)
    expect(figmaEmpty.body.detail).toMatch(/Token is required/i)

    const ghOff = await post(request, `/containers/${name}/connectors/github/disconnect`, {})
    expect(ghOff.status).toBe(200)
    const figmaOff = await post(request, `/containers/${name}/connectors/figma/disconnect`, {})
    expect(figmaOff.status).toBe(200)
    await del(request, `/containers/${name}`)
  })
})

test.describe('personas / AI team', () => {
  test('list includes seeded roles and every documented field', async ({ request }) => {
    const res = await get(request, '/agents')
    expect(res.status).toBe(200)
    const roles = res.body.map(a => a.role)
    expect(roles).toEqual(expect.arrayContaining(['po', 'ba', 'sa', 'ux-ui', 'dev-fe', 'dev-be', 'qa']))
    const po = res.body.find(a => a.role === 'po')
    expect(po).toMatchObject({ name: 'Mickey', harness: 'native' })
    expect(po).toHaveProperty('model')
    expect(po).toHaveProperty('reports_to')
    expect(po).toHaveProperty('container')
  })

  test('create validates harness/manager/duplicates and sanitizes the role', async ({ request }) => {
    const persona = (overrides = {}) => ({
      role: unique('e2e-role'), name: 'Test Robot', title: 'QA Automation',
      years: '5', expertise: 'testing', harness: 'native', ...overrides,
    })

    const empty = await post(request, '/agents', persona({ role: '', name: '' }))
    expect(empty.status).toBe(400)

    const badHarness = await post(request, '/agents', persona({ harness: 'vim' }))
    expect(badHarness.status).toBe(400)
    expect(badHarness.body.detail).toMatch(/harness must be/i)

    const custom = await post(request, '/agents', persona({ harness: 'custom', harness_command: '  ' }))
    expect(custom.status).toBe(400)
    expect(custom.body.detail).toMatch(/custom harness needs a command template/i)

    const badManager = await post(request, '/agents', persona({ reports_to: 'ghost' }))
    expect(badManager.status).toBe(400)
    expect(badManager.body.detail).toMatch(/Unknown manager role/i)

    const created = await post(request, '/agents', persona({
      role: 'E2E Tester!', name: 'Test Robot', reports_to: 'po',
    }))
    expect(created.status).toBe(200)
    expect(created.body.role).toBe('e2e-tester')
    expect(created.body.reports_to).toBe('po')

    const dup = await post(request, '/agents', persona({ role: 'e2e-tester' }))
    expect(dup.status).toBe(409)

    // update: invalid harness transition, unknown role, then a real update
    const badUpdate = await put(request, '/agents/e2e-tester', { harness: 'ed' })
    expect(badUpdate.status).toBe(400)
    const missing = await put(request, '/agents/no-such-role', { title: 'x' })
    expect(missing.status).toBe(404)

    const updated = await put(request, '/agents/e2e-tester', {
      title: 'Senior QA', model: 'mock-model', harness: 'claude',
    })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({ title: 'Senior QA', harness: 'claude' })
    expect(updated.body.model_overrides.openai).toBe('mock-model')

    const cleared = await put(request, '/agents/e2e-tester', { model: '' })
    expect(cleared.body.model_overrides.openai).toBeUndefined()

    const started = await post(request, '/agents/e2e-tester/start', { name: 'agent-e2e-tester' })
    expect(started.status).toBe(200)
    expect(started.body.status).toBe('running')
    const badStart = await post(request, '/agents/no-such-role/start', {})
    expect(badStart.status).toBe(404)
    // idempotent start
    const again = await post(request, '/agents/e2e-tester/start', {})
    expect(again.status).toBe(200)

    const activity = await get(request, '/agents/e2e-tester/activity')
    expect(activity.status).toBe(200)

    const removed = await del(request, '/agents/e2e-tester')
    expect(removed.status).toBe(200)
    expect(removed.body.deleted).toBe('e2e-tester')
    const removedAgain = await del(request, '/agents/e2e-tester')
    expect(removedAgain.status).toBe(404)
    await del(request, '/containers/agent-e2e-tester')
  })

  test('harnesses endpoint reports installed binaries', async ({ request }) => {
    const res = await get(request, '/agents/harnesses')
    expect(res.status).toBe(200)
    const list = Array.isArray(res.body) ? res.body : res.body.harnesses
    expect(list).toBeTruthy()
    expect(JSON.stringify(res.body)).toContain('native')
  })
})

test.describe('legacy tasks', () => {
  test('create defaults, assignment and delete', async ({ request }) => {
    const missing = await del(request, '/tasks/t-99999')
    expect(missing.status).toBe(404)

    const res = await post(request, '/tasks', {
      title: 'Contract task', description: 'body', status: 'not-a-column',
      category: 'QA', priority: 'high', assign_to: 'qa',
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('todo')
    expect(res.body.agent).toBe('qa')
    expect(res.body.id).toMatch(/^t-\d+$/)

    const list = await get(request, '/tasks')
    expect(list.body.some(t => t.id === res.body.id)).toBe(true)

    const gone = await del(request, `/tasks/${res.body.id}`)
    expect(gone.status).toBe(200)
  })
})

test.describe('projects', () => {
  test('CRUD + validation + repo URL normalization', async ({ request }) => {
    const created = await post(request, '/projects', {
      name: unique('Contract Project'), description: 'desc', repo_url: `${REPO}.git`,
      goal: 'ship it', budget_usd: 5,
    })
    expect(created.status).toBe(200)
    const p = created.body
    expect(p.id).toMatch(/^p-\d+$/)
    expect(p.repo_url).toBe(REPO)
    expect(p.budget_usd).toBe(5)
    expect(p.agents).toEqual([])

    const fetched = await get(request, `/projects/${p.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.name).toBe(p.name)

    const unknownAgent = await put(request, `/projects/${p.id}`, { agents: ['ghost'] })
    expect(unknownAgent.status).toBe(400)
    expect(unknownAgent.body.detail).toMatch(/Unknown persona role/i)

    const updated = await put(request, `/projects/${p.id}`, {
      name: 'Renamed', agents: ['po', 'qa'], goal: 'new goal', budget_usd: 0, budget_alert_pct: 150,
    })
    expect(updated.status).toBe(200)
    expect(updated.body.name).toBe('Renamed')
    expect(updated.body.agents).toEqual(['po', 'qa'])
    expect(updated.body.budget_usd).toBeNull() // non-positive clears the budget
    expect(updated.body.budget_alert_pct).toBe(100) // clamped

    const badGet = await get(request, '/projects/p-99999')
    expect(badGet.status).toBe(404)
    const badPut = await put(request, '/projects/p-99999', { name: 'x' })
    expect(badPut.status).toBe(404)

    const gone = await del(request, `/projects/${p.id}`)
    expect(gone.status).toBe(200)
    const goneAgain = await del(request, `/projects/${p.id}`)
    expect(goneAgain.status).toBe(404)
  })

  test('project tasks: validation, CRUD, dispatch guards, cascade on project delete', async ({ request }) => {
    const project = await createProject(request)
    const pid = project.id

    expect((await get(request, '/projects/p-99999/tasks')).status).toBe(404)
    expect((await post(request, '/projects/p-99999/tasks', { title: 'x' })).status).toBe(404)
    expect((await post(request, `/projects/${pid}/tasks`, { title: '   ' })).status).toBe(400)
    const badPriority = await post(request, `/projects/${pid}/tasks`, { title: 'x', priority: 'whenever' })
    expect(badPriority.status).toBe(400)
    const badStatus = await post(request, `/projects/${pid}/tasks`, { title: 'x', status: 'blocked' })
    expect(badStatus.status).toBe(400)

    const task = await createTask(request, pid, { description: 'details', priority: 'urgent', assignee: 'qa' })
    expect(task.status).toBe('todo')
    expect(task.priority).toBe('urgent')
    expect(task.assignee).toBe('qa')
    expect(task.subtasks).toEqual([])

    const listed = await get(request, `/projects/${pid}/tasks`)
    expect(listed.status).toBe(200)
    expect(listed.body[0]).toMatchObject({ id: task.id, active: false })
    expect(listed.body[0]).toHaveProperty('subtask_counts')

    const detail = await get(request, `/projects/${pid}/tasks/${task.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.runs).toEqual([])

    const emptyTitle = await put(request, `/projects/${pid}/tasks/${task.id}`, { title: ' ' })
    expect(emptyTitle.status).toBe(400)
    expect((await put(request, `/projects/${pid}/tasks/${task.id}`, { status: 'elsewhere' })).status).toBe(400)
    expect((await put(request, `/projects/${pid}/tasks/${task.id}`, { priority: 'later' })).status).toBe(400)

    const moved = await put(request, `/projects/${pid}/tasks/${task.id}`, {
      title: 'Renamed task', status: 'review', priority: 'low', assignee: 'dev-fe',
    })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ title: 'Renamed task', status: 'review', priority: 'low', assignee: 'dev-fe' })

    expect((await get(request, `/projects/${pid}/tasks/tk-99999`)).status).toBe(404)
    expect((await get(request, `/projects/${pid}/tasks/${task.id}/subtasks/po-work`)).status).toBe(404)
    const dispatched = await post(request, `/projects/${pid}/tasks/${task.id}/run`, {})
    expect(dispatched.status).toBe(200)
    expect(dispatched.body.run.task_id).toBe(task.id)
    expect(dispatched.body.task.latest_run.id).toBe(dispatched.body.run.id)

    // while the mission is live the task is undeletable
    const liveDel = await del(request, `/projects/${pid}/tasks/${task.id}`)
    expect([200, 409]).toContain(liveDel.status)
    await post(request, `/runs/${dispatched.body.run.id}/stop`, {})
    await waitRun(request, dispatched.body.run.id)
    if (liveDel.status === 409) {
      expect((await del(request, `/projects/${pid}/tasks/${task.id}`)).status).toBe(200)
    }

    const second = await createTask(request, pid, { title: 'Delete me' })
    expect((await del(request, `/projects/${pid}/tasks/${second.id}`)).status).toBe(200)
    expect((await del(request, `/projects/${pid}/tasks/${second.id}`)).status).toBe(404)

    // deleting the project drops its tasks (runs stay as history)
    await deleteProject(request, pid)
    expect((await get(request, `/projects/${pid}/tasks`)).status).toBe(404)
    const orphans = await get(request, '/tasks')
    expect(orphans.status).toBe(200)
  })
})

test.describe('project docs', () => {
  test('docs CRUD, raw download and workspace materialization', async ({ request }) => {
    const project = await createProject(request)
    const pid = project.id

    expect((await get(request, '/projects/p-99999/docs')).status).toBe(404)
    expect((await post(request, '/projects/p-99999/docs', { title: 'x' })).status).toBe(404)
    expect((await post(request, `/projects/${pid}/docs`, { title: '  ' })).status).toBe(400)

    const doc = await post(request, `/projects/${pid}/docs`, { title: 'Spec', content_md: '# Hello' })
    expect(doc.status).toBe(200)
    expect(doc.body.folder).toBe('General')
    const did = doc.body.id

    const folderDoc = await post(request, `/projects/${pid}/docs`, { title: 'Other', folder: ' Design ', content_md: 'x' })
    expect(folderDoc.body.folder).toBe('Design')

    const listed = await get(request, `/projects/${pid}/docs`)
    expect(listed.status).toBe(200)
    expect(listed.body[0]).toHaveProperty('open_comments')

    const raw = await request.get(`${require('./lib/isolated').API}/projects/${pid}/docs/${did}?raw=1`, {
      headers: { 'x-session-token': require('./lib/isolated').getToken() },
    })
    expect(raw.status()).toBe(200)
    expect(raw.headers()['content-type']).toContain('text/markdown')
    expect(await raw.text()).toBe('# Hello')

    const updated = await put(request, `/projects/${pid}/docs/${did}`, { title: 'Spec v2', content_md: '# Hello v2' })
    expect(updated.status).toBe(200)
    expect(updated.body.content_md).toBe('# Hello v2')
    const blankTitle = await put(request, `/projects/${pid}/docs/${did}`, { title: '   ' })
    expect(blankTitle.body.title).toBe('Spec v2') // empty title is ignored, not an error

    // comments
    expect((await post(request, `/projects/${pid}/docs/${did}/comments`, { body: ' ' })).status).toBe(400)
    const comment = await post(request, `/projects/${pid}/docs/${did}/comments`, {
      body: 'Tighten this', quote: 'Hello', author: 'reviewer',
    })
    expect(comment.status).toBe(200)
    expect(comment.body.status).toBe('open')
    const withCount = (await get(request, `/projects/${pid}/docs`)).body.find(d => d.id === did)
    expect(withCount.open_comments).toBe(1)

    expect((await put(request, `/projects/${pid}/docs/${did}/comments/${comment.body.id}`, { status: 'maybe' })).status).toBe(400)
    const resolved = await put(request, `/projects/${pid}/docs/${did}/comments/${comment.body.id}`, { status: 'resolved' })
    expect(resolved.body.status).toBe('resolved')
    expect(resolved.body.resolved_at).toBeGreaterThan(0)

    expect((await del(request, `/projects/${pid}/docs/${did}/comments/${comment.body.id}`)).status).toBe(200)
    expect((await del(request, `/projects/${pid}/docs/${did}/comments/${comment.body.id}`)).status).toBe(404)
    expect((await put(request, `/projects/${pid}/docs/nope/comments/nope`, { status: 'open' })).status).toBe(404)

    expect((await del(request, `/projects/${pid}/docs/${did}`)).status).toBe(200)
    expect((await del(request, `/projects/${pid}/docs/${did}`)).status).toBe(404)

    await deleteProject(request, pid)
  })

  test('upload accepts markdown/binary and rejects empty or missing files', async ({ request }) => {
    const { API, getToken } = require('./lib/isolated')
    const project = await createProject(request)
    const pid = project.id
    const headers = { 'x-session-token': getToken() }

    const missing = await request.post(`${API}/projects/${pid}/docs/upload`, {
      headers, multipart: { folder: 'Uploads' },
    })
    expect(missing.status()).toBe(400)
    expect((await missing.json()).detail).toMatch(/No file in upload/i)

    const empty = await request.post(`${API}/projects/${pid}/docs/upload`, {
      headers,
      multipart: { file: { name: 'empty.md', mimeType: 'text/markdown', buffer: Buffer.alloc(0) } },
    })
    expect(empty.status()).toBe(400)
    expect((await empty.json()).detail).toMatch(/empty/i)

    const md = await request.post(`${API}/projects/${pid}/docs/upload`, {
      headers,
      multipart: {
        folder: 'Uploads',
        file: { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Uploaded\n\nfrom e2e') },
      },
    })
    expect(md.status()).toBe(200)
    const mdDoc = await md.json()
    expect(mdDoc).toMatchObject({ title: 'notes', folder: 'Uploads', content_md: '# Uploaded\n\nfrom e2e' })
    expect(mdDoc.file).toBeNull()

    const bin = await request.post(`${API}/projects/${pid}/docs/upload`, {
      headers,
      multipart: { file: { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    })
    expect(bin.status()).toBe(200)
    const binDoc = await bin.json()
    expect(binDoc.file).toMatchObject({ name: 'pixel.png', content_type: 'image/png', size: 4 })

    const rawBin = await request.get(`${API}/projects/${pid}/docs/${binDoc.id}?raw=1`, { headers })
    expect(rawBin.status()).toBe(200)
    expect(rawBin.headers()['content-type']).toContain('image/png')
    expect(rawBin.headers()['content-disposition']).toContain('pixel.png')

    await deleteProject(request, pid)
    const missingRaw = await request.get(`${API}/projects/${pid}/docs/${binDoc.id}?raw=1`, { headers })
    expect(missingRaw.status()).toBe(404)
  })
})

test.describe('skills', () => {
  test('seeded skills + create/update/history/restore/delete', async ({ request }) => {
    const list = await get(request, '/skills')
    expect(list.status).toBe(200)
    expect(list.body.map(s => s.id)).toEqual(expect.arrayContaining(['web-research', 'code-gen', 'api-testing']))

    const created = await post(request, '/skills', { name: 'E2E Skill', description: 'contract' })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ id: 'e2e-skill', version: 1, enabled: true })

    expect((await post(request, '/skills', { name: 'E2E Skill', description: 'dup' })).status).toBe(409)
    expect((await put(request, '/skills/e2e-skill', { name: ' ' })).status).toBe(400)
    expect((await put(request, '/skills/nope', { name: 'x' })).status).toBe(404)
    expect((await del(request, '/skills/nope')).status).toBe(404)

    const updated = await put(request, '/skills/e2e-skill', { name: 'E2E Skill v2', description: 'v2 desc' })
    expect(updated.status).toBe(200)
    expect(updated.body.version).toBe(2)
    expect(updated.body.history[0]).toMatchObject({ version: 1, name: 'E2E Skill' })

    const toggled = await put(request, '/skills/e2e-skill', { enabled: false })
    expect(toggled.body.version).toBe(3)
    expect(toggled.body.enabled).toBe(false)

    const restored = await post(request, '/skills/e2e-skill/restore/1')
    expect(restored.status).toBe(200)
    expect(restored.body.name).toBe('E2E Skill')
    expect(restored.body.version).toBe(4)
    const badRestore = await post(request, '/skills/e2e-skill/restore/999')
    expect(badRestore.status).toBe(404)

    const tests = await put(request, '/skills/e2e-skill/tests', { inputs: [' one ', '', 'two', '   '] })
    expect(tests.status).toBe(200)
    expect(tests.body.test_inputs).toEqual(['one', 'two'])

    const noInputs = await put(request, '/skills/e2e-skill/tests', { inputs: [] })
    expect(noInputs.body.test_inputs).toEqual([])
    const runEmpty = await post(request, '/skills/e2e-skill/tests/run', {})
    expect(runEmpty.status).toBe(400)
    expect(runEmpty.body.detail).toMatch(/at least one test input/i)

    const run = await post(request, '/skills/e2e-skill/tests/run', { inputs: ['ping'] })
    expect(run.status).toBe(200)
    expect(run.body.test_runs.length).toBe(1)
    expect(run.body.test_runs[0].input).toBe('ping')
    expect(run.body.test_runs[0].output.length).toBeGreaterThan(0)

    expect((await del(request, '/skills/e2e-skill')).status).toBe(200)
    expect((await del(request, '/skills/e2e-skill')).status).toBe(404)
  })
})

test.describe('config', () => {
  test('masks the key, validates providers and clamps numeric fields', async ({ request }) => {
    const before = await get(request, '/config')
    expect(before.status).toBe(200)
    expect(before.body.ai_api_key_masked).toMatch(/^••••/)
    expect(before.body.auth_required).toBe(true)
    expect(before.body).toHaveProperty('pricing')
    expect(before.body).not.toHaveProperty('ai_api_key')

    const bad = await put(request, '/config', { ai_provider: 'not-a-provider' })
    expect(bad.status).toBe(400)
    expect(bad.body.detail).toMatch(/ai_provider must be one of/i)

    const saved = await put(request, '/config', {
      max_containers: 7,
      auto_pause_enabled: true,
      idle_timeout_secs: 5, // clamped to 60
      pricing: { 'mock-model': { input_per_mtok: 2, output_per_mtok: 4 }, '  ': { input_per_mtok: 9, output_per_mtok: 9 } },
      default_input_per_mtok: -3,
      default_output_per_mtok: 1,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.max_containers).toBe(7)
    expect(saved.body.idle_timeout_secs).toBe(60)
    expect(saved.body.pricing['mock-model']).toEqual({ input_per_mtok: 2, output_per_mtok: 4 })
    expect(saved.body.pricing['']).toBeUndefined()
    expect(saved.body.default_input_per_mtok).toBe(0)
    expect(saved.body.default_output_per_mtok).toBe(1)

    // restore the mock booking so engine tests keep a priced model
    const restored = await put(request, '/config', {
      max_containers: 10, idle_timeout_secs: 900,
      pricing: before.body.pricing,
      default_input_per_mtok: before.body.default_input_per_mtok,
      default_output_per_mtok: before.body.default_output_per_mtok,
    })
    expect(restored.status).toBe(200)
  })
})

test.describe('runs API', () => {
  test('list/get/stop/budget/review/reply/retry validation on unknown ids', async ({ request }) => {
    const runs = await get(request, '/runs')
    expect(runs.status).toBe(200)
    expect(Array.isArray(runs.body)).toBe(true)

    expect((await get(request, '/runs/run-99999')).status).toBe(404)
    expect((await post(request, '/runs/run-99999/stop', {})).status).toBe(404)
    expect((await post(request, '/runs/run-99999/budget', { budget_usd: 1 })).status).toBe(404)
    expect((await post(request, '/runs/run-99999/review', { decision: 'approve' })).status).toBe(404)
    expect((await post(request, '/runs/run-99999/discussions/d-1/reply', { text: 'hi' })).status).toBe(404)
    expect((await post(request, '/runs/run-99999/steps/po/work/retry', {})).status).toBe(404)
  })

  test('project run validates task/team/task_id and rejects a second live mission', async ({ request }) => {
    expect((await post(request, '/projects/p-99999/run', { task: 'x' })).status).toBe(404)
    expect((await post(request, '/projects/p-001/run', { task: '   ' })).status).toBe(400)

    const teamless = await post(request, '/projects', { name: unique('Teamless') })
    const runTeamless = await post(request, `/projects/${teamless.body.id}/run`, { task: 'do it' })
    expect(runTeamless.status).toBe(400)
    expect(runTeamless.body.detail).toMatch(/no team/i)
    expect((await get(request, `/projects/${teamless.body.id}/tasks`)).body).toEqual([]) // no phantom task
    await deleteProject(request, teamless.body.id)

    const project = await createProject(request)
    const unknownTask = await post(request, `/projects/${project.id}/run`, { task: 'x', task_id: 'tk-99999' })
    expect(unknownTask.status).toBe(404)

    const first = await post(request, `/projects/${project.id}/run`, { task: 'Contract mission' })
    expect(first.status).toBe(200)
    expect(first.body.id).toMatch(/^run-\d+$/)
    expect(first.body.task_id).toMatch(/^tk-\d+$/)

    const second = await post(request, `/projects/${project.id}/run`, { task: 'Second' })
    expect(second.status).toBe(409)
    expect(second.body.detail).toMatch(/already active/i)

    const stop = await post(request, `/runs/${first.body.id}/stop`, {})
    expect(stop.status).toBe(200)
    await waitRun(request, first.body.id)
    await deleteProject(request, project.id)
  })
})

test.describe('routines', () => {
  test('create validates cron, list exposes next_run_at, run/update/delete work', async ({ request }) => {
    const project = await createProject(request)
    const pid = project.id

    expect((await get(request, '/projects/p-99999/routines')).status).toBe(404)
    expect((await post(request, '/projects/p-99999/routines', { name: 'x', task: 'y', cron: '* * * * *' })).status).toBe(404)
    expect((await post(request, `/projects/${pid}/routines`, { name: '', task: 'y', cron: '* * * * *' })).status).toBe(400)
    expect((await post(request, `/projects/${pid}/routines`, { name: 'x', task: '', cron: '* * * * *' })).status).toBe(400)
    const badCron = await post(request, `/projects/${pid}/routines`, { name: 'x', task: 'y', cron: 'every day' })
    expect(badCron.status).toBe(400)
    const never = await post(request, `/projects/${pid}/routines`, { name: 'x', task: 'y', cron: '0 0 31 2 *' })
    expect(never.status).toBe(400)
    expect(never.body.detail).toMatch(/never fires/i)

    const created = await post(request, `/projects/${pid}/routines`, {
      name: 'Daily', task: 'Check the build', cron: '0 9 * * 1-5',
    })
    expect(created.status).toBe(200)
    expect(created.body.enabled).toBe(true)
    expect(created.body.next_run_at).toBeGreaterThan(0)
    const rid = created.body.id

    const listed = await get(request, `/projects/${pid}/routines`)
    expect(listed.body.map(r => r.id)).toContain(rid)

    const disabled = await put(request, `/routines/${rid}`, { enabled: false })
    expect(disabled.body.enabled).toBe(false)
    expect(disabled.body.next_run_at).toBeNull()
    expect((await put(request, `/routines/${rid}`, { cron: 'nope' })).status).toBe(400)
    expect((await put(request, `/routines/${rid}`, { name: ' ' })).status).toBe(400)
    expect((await put(request, `/routines/${rid}`, { task: ' ' })).status).toBe(400)
    expect((await put(request, '/routines/rt-99999', { enabled: true })).status).toBe(404)

    const trip = await post(request, `/routines/${rid}/run`, {})
    expect(trip.status).toBe(200)
    expect(trip.body.id).toMatch(/^run-\d+$/)
    expect(trip.body.trigger).toBe('scheduled')
    expect(trip.body.routine_id).toBe(rid)
    await post(request, `/runs/${trip.body.id}/stop`, {})
    await waitRun(request, trip.body.id)

    expect((await del(request, `/routines/${rid}`)).status).toBe(200)
    expect((await del(request, `/routines/${rid}`)).status).toBe(404)
    await deleteProject(request, pid)
  })
})
