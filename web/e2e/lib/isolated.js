// Helpers for the isolated integration stack (tests/start-stack.sh).
// Every spec that mutates state must only run with AAP_TEST_API=1 — the
// stack is a throwaway DATA_DIR + private tmux socket, never the real one.
const { authHeaders } = require('./auth')

const API = process.env.API_URL || 'http://localhost:8000'
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:9101'
const REPO = process.env.REPO_URL || 'file:///tmp/aap-test/origin'

// global-setup persists the token it got from API_URL; keep the mutable copy
// here so the auth tests can log out / log back in mid-file.
let token = authHeaders()['x-session-token'] || ''
const setToken = t => { token = t }
const getToken = () => token

const TEAM = ['po', 'ba', 'sa', 'ux-ui', 'dev-fe', 'dev-be', 'qa']
const FULL_TEAM = ['po', 'ba', 'sa', 'ux-ui', 'ux-ui-2', 'dev-fe', 'dev-be', 'dev-be-2', 'qa']

function isolatedOnly(test) {
  test.skip(!process.env.AAP_TEST_API, 'isolated stack only — run tests/run-all.sh')
}

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`
}

async function api(request, method, path, data, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (!opts.noAuth) headers['x-session-token'] = opts.token ?? token
  const send = () => request.fetch(`${API}${path}`, {
    method,
    headers,
    data: data === undefined ? undefined : data,
    timeout: opts.timeout || 30_000,
  })
  let res = await send()
  // A restart drops the in-memory sessions. Re-authenticate once instead of
  // making every spec carry restart-aware setup.
  if (res.status() === 401 && !opts.noAuth && !opts.token && !opts.noRetry) {
    const again = await login(request)
    if (again.status === 200) {
      headers['x-session-token'] = token
      res = await send()
    }
  }
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status(), body, headers: res.headers() }
}

async function login(request, username = 'admin', password = process.env.ADMIN_PASSWORD || 'testpass') {
  const res = await api(request, 'POST', '/auth/login', { username, password }, { noAuth: true })
  if (res.status === 200 && res.body?.token) token = res.body.token
  return res
}

const get = (request, path, opts) => api(request, 'GET', path, undefined, opts)
const post = (request, path, data, opts) => api(request, 'POST', path, data, opts)
const put = (request, path, data, opts) => api(request, 'PUT', path, data, opts)
const del = (request, path, opts) => api(request, 'DELETE', path, undefined, opts)

async function mockReset(request) {
  await request.post(`${MOCK}/__reset`)
}
async function mockScenario(request, scenario) {
  await request.post(`${MOCK}/__scenario`, { data: scenario })
}
async function mockCalls(request) {
  return (await request.get(`${MOCK}/__calls`)).json()
}

async function createProject(request, overrides = {}) {
  const { agents = TEAM, name = unique('E2E Project'), ...rest } = overrides
  const created = await post(request, '/projects', { name, description: 'isolated integration fixture', ...rest })
  if (created.status !== 200) throw new Error(`create project failed: ${created.status} ${JSON.stringify(created.body)}`)
  const project = created.body
  if (agents && agents.length) {
    const updated = await put(request, `/projects/${project.id}`, { agents })
    if (updated.status !== 200) throw new Error(`set team failed: ${updated.status} ${JSON.stringify(updated.body)}`)
    return updated.body
  }
  return project
}

async function deleteProject(request, id) {
  if (id) await del(request, `/projects/${id}`)
}

async function createTask(request, projectId, overrides = {}) {
  const res = await post(request, `/projects/${projectId}/tasks`, { title: unique('Task'), ...overrides })
  if (res.status !== 200) throw new Error(`create task failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

const settled = run => run && !['running', 'waiting_human'].includes(run.status)

async function waitRun(request, id, predicate = settled, timeout = 40_000) {
  const started = Date.now()
  for (;;) {
    const { status, body } = await get(request, `/runs/${id}`)
    if (status !== 200) throw new Error(`GET /runs/${id} -> ${status}`)
    if (predicate(body)) return body
    if (Date.now() - started > timeout) {
      throw new Error(`run ${id} stayed ${body.status}/${body.phase} for ${timeout}ms`)
    }
    await new Promise(r => setTimeout(r, 120))
  }
}

async function waitFor(fn, timeout = 10_000, interval = 120) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('condition not met in time')
    await new Promise(r => setTimeout(r, interval))
  }
}

module.exports = {
  API, MOCK, REPO, TEAM, FULL_TEAM,
  isolatedOnly, unique, api, get, post, put, del,
  login, setToken, getToken,
  mockReset, mockScenario, mockCalls,
  createProject, deleteProject, createTask,
  waitRun, waitFor, settled,
}
