// Real process-restart persistence: everything the JSON stores own must
// survive a full orchestrator restart, and in-flight runs must close honestly
// (status stopped, meeting resolved, board task released) instead of hanging.
const { test, expect } = require('@playwright/test')
const { execFileSync } = require('child_process')
const path = require('path')
const {
  unique, get, post, put, del, login, getToken,
  createProject, deleteProject, createTask, waitRun, waitFor,
  REPO,
} = require('./lib/isolated')

test.describe.configure({ timeout: 120_000, mode: 'serial' })

const ROOT = path.resolve(__dirname, '../..')
const restartScript = path.join(ROOT, 'tests/restart-stack.sh')

let project, task, doc, skill, routine, doneRun, liveRun

function restartOrchestrator() {
  const out = execFileSync(restartScript, {
    env: { ...process.env, AAP_TEST_DIR: process.env.AAP_TEST_DIR || '/tmp/aap-test' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  expect(out).toContain('restarted')
}

test.beforeAll(async ({ request }) => {
  test.skip(!process.env.AAP_TEST_API, 'isolated stack only — run tests/start-stack.sh')
  await login(request)

  project = await createProject(request, { goal: 'survive a restart', budget_usd: 25 })
  task = await createTask(request, project.id, { title: 'Persisted board task', priority: 'high' })
  doc = await post(request, `/projects/${project.id}/docs`, {
    title: 'Persisted spec', folder: 'Design', content_md: '# Spec\nkeep me',
  })
  expect(doc.status).toBe(200)
  await post(request, `/projects/${project.id}/docs/${doc.body.id}/comments`, {
    body: 'survive too', quote: 'Spec', author: 'e2e',
  })

  const s = await post(request, '/skills', { name: unique('Restart Skill'), description: 'persisted' })
  expect(s.status).toBe(200)
  skill = s.body
  await put(request, `/skills/${skill.id}/tests`, { inputs: ['ping'] })
  await post(request, `/skills/${skill.id}/tests/run`, {})

  routine = (await post(request, `/projects/${project.id}/routines`, {
    name: 'Persisted routine', task: 'Check the build', cron: '0 9 * * 1-5',
  })).body
  expect(routine.id).toBeTruthy()

  // one mission that finishes before the restart…
  doneRun = await waitRun(request, (await post(request, `/projects/${project.id}/run`, { task: 'Mission that finishes' })).body.id)

  // …and one that is parked on the review gate, so the restart hits it live
  const reviewProject = await createProject(request, { repo_url: REPO })
  project.reviewProject = reviewProject
  liveRun = (await post(request, `/projects/${reviewProject.id}/run`, { task: 'Mission interrupted by restart' })).body
  await waitFor(async () => {
    const { body } = await get(request, `/runs/${liveRun.id}`)
    return body.status === 'waiting_human' && body.phase === 'review' ? body : null
  }, 45_000)
})

test.afterAll(async ({ request }) => {
  for (const p of [project, project?.reviewProject]) {
    if (p) await deleteProject(request, p.id)
  }
  if (skill) await del(request, `/skills/${skill.id}`)
})

test('old sessions die with the process; a fresh login works', async ({ request }) => {
  const stale = getToken()
  restartOrchestrator()

  // the old socket pool can hand back a dead connection once — retry briefly
  const health = await waitFor(async () => {
    try {
      const res = await get(request, '/health', { noAuth: true })
      return res.status === 200 ? res : null
    } catch { return null }
  }, 15_000, 250)
  expect(health.body.tmux).toBe(true)

  const dead = await get(request, '/agents', { token: stale })
  expect(dead.status).toBe(401)

  const again = await login(request)
  expect(again.status).toBe(200)
  expect((await get(request, '/agents')).status).toBe(200)
})

test('projects, docs, comments, tasks, skills and routines come back', async ({ request }) => {
  const p = await get(request, `/projects/${project.id}`)
  expect(p.status).toBe(200)
  expect(p.body).toMatchObject({ id: project.id, goal: 'survive a restart', budget_usd: 25 })
  expect(p.body.agents).toEqual(project.agents)

  const docs = await get(request, `/projects/${project.id}/docs`)
  const kept = docs.body.find(d => d.id === doc.body.id)
  expect(kept).toBeTruthy()
  expect(kept.content_md).toBe('# Spec\nkeep me')
  expect(kept.folder).toBe('Design')
  expect(kept.open_comments).toBe(1)

  const board = await get(request, `/projects/${project.id}/tasks`)
  const keptTask = board.body.find(t => t.id === task.id)
  expect(keptTask).toBeTruthy()
  expect(keptTask.title).toBe(task.title)
  expect(keptTask.priority).toBe('high')

  const skills = await get(request, '/skills')
  const keptSkill = skills.body.find(s => s.id === skill.id)
  expect(keptSkill).toBeTruthy()
  expect(keptSkill.test_inputs).toEqual(['ping'])
  expect(keptSkill.test_runs.length).toBe(1)

  const routines = await get(request, `/projects/${project.id}/routines`)
  const keptRoutine = routines.body.find(r => r.id === routine.id)
  expect(keptRoutine).toBeTruthy()
  expect(keptRoutine.name).toBe('Persisted routine')
  expect(keptRoutine.next_run_at).toBeGreaterThan(0)
})

test('a finished mission survives with its steps; the live one closes as stopped', async ({ request }) => {
  const done = await get(request, `/runs/${doneRun.id}`)
  expect(done.status).toBe(200)
  expect(done.body.status).toBe('done')
  expect(done.body.acceptance.verdict).toBe('pass')
  expect(done.body.steps.filter(s => s.kind === 'work').length).toBe(7)
  expect(done.body.steps.every(s => s.status === 'done' || s.status === 'skipped')).toBe(true)

  const stopped = await get(request, `/runs/${liveRun.id}`)
  expect(stopped.status).toBe(200)
  expect(stopped.body.status).toBe('stopped')
  expect(stopped.body.phase).toBe('done')
  expect(stopped.body.steps.some(s => s.status === 'working' || s.status === 'pending')).toBe(false)
  const open = stopped.body.discussions.filter(d => d.status !== 'resolved')
  expect(open).toEqual([])
  expect(stopped.body.discussions.some(d => d.messages.some(m => m.from === 'orchestrator' && /restarted/i.test(m.text)))).toBe(true)

  // the interrupted task was released back to the board
  const released = await get(request, `/projects/${project.reviewProject.id}/tasks/${stopped.body.task_id}`)
  expect(released.status).toBe(200)
  expect(released.body.status).toBe('todo')
  expect(released.body.latest_run.id).toBe(liveRun.id)

  // deciding a review on a dead run is refused, not silently accepted
  const late = await post(request, `/runs/${liveRun.id}/review`, { decision: 'approve' })
  expect([400, 409]).toContain(late.status)
})
