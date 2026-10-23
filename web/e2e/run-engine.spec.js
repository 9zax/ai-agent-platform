// Mission-engine scenarios against the deterministic mock LLM. Each test
// exercises a real orchestrator run engine (relay, meetings, PR/review gate,
// budget guard, loops, retry) in the isolated stack — never the live server.
const { test, expect } = require('@playwright/test')
const {
  isolatedOnly, unique, get, post, put,
  createProject, deleteProject, createTask,
  mockReset, mockScenario, mockCalls,
  waitRun, waitFor, REPO, TEAM,
} = require('./lib/isolated')

test.describe.configure({ timeout: 90_000 })

const created = []
let baseConfig = null

test.beforeEach(async ({ request }) => {
  test.skip(!process.env.AAP_TEST_API, 'isolated stack only — run tests/start-stack.sh')
  await mockReset(request)
  if (!baseConfig) {
    baseConfig = (await get(request, '/config')).body
  }
  // a failed test must never leak a temporary pricing table into the next one
  await put(request, '/config', {
    pricing: baseConfig.pricing,
    default_input_per_mtok: baseConfig.default_input_per_mtok,
    default_output_per_mtok: baseConfig.default_output_per_mtok,
  })
})

test.afterEach(async ({ request }) => {
  for (const pid of created.splice(0)) {
    const runs = (await get(request, '/runs')).body.filter(r => r.project_id === pid)
    for (const r of runs) {
      if (r.status === 'running' || r.status === 'waiting_human') {
        await post(request, `/runs/${r.id}/stop`, {})
      }
    }
    await deleteProject(request, pid)
  }
})

async function project(request, overrides = {}) {
  const p = await createProject(request, overrides)
  created.push(p.id)
  return p
}

async function dispatch(request, pid, body = { task: 'Ship the isolated mission' }) {
  const res = await post(request, `/projects/${pid}/run`, body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body
}

async function waitPhase(request, id, phase, timeout = 45_000) {
  return waitRun(request, id, r => r.status === 'waiting_human' && r.phase === phase, timeout)
}

const stepOf = (run, role, kind = 'work') => run.steps.find(s => s.role === role && s.kind === kind)

test.describe('happy path + relay contract', () => {
  test('full mission delivers, parallel builders see only the SA contract, acceptance PASS', async ({ request }) => {
    const p = await project(request)
    const run = await dispatch(request, p.id, { task: 'Build the isolated dashboard' })
    const done = await waitRun(request, run.id)

    expect(done.status).toBe('done')
    expect(done.phase).toBe('done')
    expect(done.trigger).toBe('manual')
    expect(done.iteration).toBe(1)

    const work = done.steps.filter(s => s.kind === 'work')
    expect(work.map(s => s.role)).toEqual(TEAM)
    for (const s of work) {
      expect(s.status, `${s.role} status`).toBe('done')
      expect(s.output).toContain(`ROLE_TOKEN:${s.role}`)
      expect(s.rev ?? 1).toBe(1)
    }

    // no repo configured → PR stage skips honestly, the demo still runs
    expect(stepOf(done, 'dev-fe', 'pr').status).toBe('skipped')
    expect(stepOf(done, 'dev-fe', 'pr').output).toMatch(/no git repo configured/i)
    expect(stepOf(done, 'po', 'demo').status).toBe('done')
    expect(done.acceptance).toMatchObject({ verdict: 'pass' })
    expect(done.summary).toContain('Mission summary')
    // the demo session is the only discussion a clean mission opens
    expect(done.discussions.map(d => d.kind)).toEqual(['demo'])

    // relay: BA saw PO, SA saw PO+BA; the parallel builders both saw the SA
    // split but NOT each other's output.
    const calls = await mockCalls(request)
    const callsOf = (role) => calls.filter(c => c.kind === 'work' && c.role === role)
    expect(callsOf('ba')[0].user).toContain('ROLE_TOKEN:po')
    expect(callsOf('sa')[0].user).toContain('ROLE_TOKEN:ba')
    // the builders receive the SA's Work Split (its contract), not the raw brief
    expect(callsOf('dev-fe')[0].user).toContain('ROLE_TOKEN:sa')
    expect(callsOf('dev-fe')[0].user).toContain('## Work Split')
    expect(callsOf('dev-fe')[0].user).not.toContain('ROLE_TOKEN:dev-be')
    expect(callsOf('dev-be')[0].user).toContain('ROLE_TOKEN:sa')
    expect(callsOf('dev-be')[0].user).not.toContain('ROLE_TOKEN:dev-fe')
    expect(callsOf('qa')[0].user).toContain('ROLE_TOKEN:dev-be')

    // the run becomes a task on the board, closed as done
    const task = await get(request, `/projects/${p.id}/tasks/${done.task_id}`)
    expect(task.body.status).toBe('done')
    expect(task.body.latest_run.id).toBe(done.id)
    expect(task.body.subtask_counts.total).toBe(9) // 7 work + pr + demo
    expect(task.body.subtasks.find(s => s.id === 'po-work').status).toBe('done')
    const subtask = await get(request, `/projects/${p.id}/tasks/${done.task_id}/subtasks/po-work`)
    expect(subtask.status).toBe(200)
    expect(subtask.body.subtask.id).toBe('po-work')
    expect(subtask.body.agent.role).toBe('po')
    expect(subtask.body.siblings.length).toBe(9)
    expect((await get(request, `/projects/${p.id}/tasks/${done.task_id}/subtasks/nope-work`)).status).toBe(404)
  })
})

test.describe('meetings', () => {
  test('ASK to a teammate opens a meeting, the teammate answers and the asker revises', async ({ request }) => {
    await mockScenario(request, { ask: { role: 'ba', to: 'sa' } })
    const p = await project(request)
    const run = await dispatch(request, p.id)
    const done = await waitRun(request, run.id)

    expect(done.status).toBe('done')
    const meeting = done.discussions.find(d => d.from === 'ba')
    expect(meeting).toBeTruthy()
    expect(meeting.from).toBe('ba')
    expect(meeting.to).toEqual(['sa'])
    expect(meeting.status).toBe('resolved')
    expect(meeting.messages.some(m => m.from === 'sa' && m.text.length > 0)).toBe(true)
    expect(stepOf(done, 'ba').rev).toBe(2)
    expect(stepOf(done, 'ba').output).toContain('REVISION:2')

    const calls = await mockCalls(request)
    expect(calls.some(c => c.kind === 'meeting' && c.role === 'sa')).toBe(true)
  })

  test('ASK to the human pauses the run until the chat reply, then it finishes', async ({ request }) => {
    await mockScenario(request, { ask: { role: 'ba', to: 'human' } })
    const p = await project(request)
    const run = await dispatch(request, p.id)

    const waiting = await waitFor(async () => {
      const { body } = await get(request, `/runs/${run.id}`)
      return body.status === 'waiting_human' ? body : null
    }, 30_000)
    expect(waiting.phase).toBe('meeting')
    const disc = waiting.discussions.find(d => d.to.includes('human'))
    expect(disc.status).toBe('need_human')
    expect(disc.to).toEqual(['human'])

    const bad = await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, { text: '  ' })
    expect(bad.status).toBe(400)

    const replied = await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, {
      text: 'Build against the shared GET /items contract.',
    })
    expect(replied.status).toBe(200)

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(stepOf(done, 'ba').rev).toBe(2)
    const closed = done.discussions.find(d => d.id === disc.id)
    expect(closed.status).toBe('resolved')
    expect(closed.messages.some(m => m.from === 'human')).toBe(true)

    // a resolved meeting cannot be answered twice
    const again = await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, { text: 'again' })
    expect(again.status).toBe(400)
  })
})

test.describe('stop + review gate', () => {
  test('Stop while the relay is in flight closes the run as stopped', async ({ request }) => {
    await mockScenario(request, { delayMs: 800 })
    const p = await project(request)
    const run = await dispatch(request, p.id)

    const stop = await post(request, `/runs/${run.id}/stop`, {})
    expect(stop.status).toBe(200)

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('stopped')
    expect(done.phase).toBe('done')
    // no step may be left dangling — the in-flight one is closed by finish_run
    expect(done.steps.some(s => s.status === 'pending')).toBe(false)
    expect(done.acceptance ?? null).toBeNull()

    const again = await post(request, `/runs/${run.id}/stop`, {})
    expect(again.status).toBe(400)
    expect(again.body.detail).toMatch(/already stopped/i)
  })

  test('repo delivery opens the pre-push review; approve commits, then PR skips without gh', async ({ request }) => {
    const p = await project(request, { repo_url: REPO })
    const run = await dispatch(request, p.id, { task: 'Ship files through the review gate' })

    const review = await waitPhase(request, run.id, 'review')
    expect(review.review.status).toBe('pending')
    expect(review.review.files.length).toBeGreaterThan(0)
    expect(review.review.files.some(f => f.includes('docs/e2e-dev-fe.md'))).toBe(true)
    expect(review.review.diff).toContain('docs/e2e-dev-fe.md')
    const disc = review.discussions.find(d => d.kind === 'review')
    expect(disc.status).toBe('need_human')

    const badDecision = await post(request, `/runs/${run.id}/review`, { decision: 'maybe' })
    expect(badDecision.status).toBe(400)

    const approved = await post(request, `/runs/${run.id}/review`, { decision: 'approve' })
    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe('approved')

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(done.review.status).toBe('approved')
    expect(done.review.decided_at).toBeGreaterThan(0)
    const pr = stepOf(done, 'dev-fe', 'pr')
    expect(pr.status).toBe('skipped')
    expect(pr.output).toMatch(/gh CLI not installed/i)
    expect(done.acceptance.verdict).toBe('pass')

    // approving twice is rejected
    const twice = await post(request, `/runs/${run.id}/review`, { decision: 'approve' })
    expect(twice.status).toBe(400)
  })

  test('rejecting twice revises once, reopens the review, then skips the push', async ({ request }) => {
    const p = await project(request, { repo_url: REPO })
    const run = await dispatch(request, p.id, { task: 'Review me twice' })

    const first = await waitPhase(request, run.id, 'review')
    const firstDisc = first.discussions.filter(d => d.kind === 'review')
    expect(firstDisc.length).toBe(1)

    const rejected = await post(request, `/runs/${run.id}/review`, {
      decision: 'reject', comment: 'Add a test for the empty state',
    })
    expect(rejected.status).toBe(200)

    // the Dev revises, then a SECOND review discussion opens
    const second = await waitFor(async () => {
      const { body } = await get(request, `/runs/${run.id}`)
      return body.phase === 'review' && body.discussions.filter(d => d.kind === 'review').length >= 2
        ? body : null
    }, 45_000)
    expect(second.review.status).toBe('pending')
    expect(stepOf(second, 'dev-fe').rev).toBe(2)
    expect(second.review.diff).toContain('revision-dev-fe')

    const again = await post(request, `/runs/${run.id}/review`, { decision: 'reject', comment: 'Still not right' })
    expect(again.status).toBe(200)

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(done.review.status).toBe('rejected')
    expect(done.review.comment).toBe('Still not right')
    expect(stepOf(done, 'dev-fe', 'pr').output).toMatch(/second time/i)
    expect(done.acceptance.verdict).toBe('pass')
  })

  test('a REJECT chat line counts as the decision (review survives plain chatter)', async ({ request }) => {
    const p = await project(request, { repo_url: REPO })
    const run = await dispatch(request, p.id, { task: 'Chat-decided review' })

    const review = await waitPhase(request, run.id, 'review')
    const disc = review.discussions.find(d => d.kind === 'review')

    // plain chatter wakes the wait but does not decide anything
    await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, { text: 'why these files?' })
    await waitFor(async () => {
      const { body } = await get(request, `/runs/${run.id}`)
      return body.status === 'waiting_human' && body.review?.status === 'pending' ? body : null
    }, 15_000)

    // a REJECT line is the decision; the Dev revises and the gate reopens
    await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, { text: 'REJECT: rename the files' })
    const reopened = await waitFor(async () => {
      const { body } = await get(request, `/runs/${run.id}`)
      return body.discussions.filter(d => d.kind === 'review').length >= 2 ? body : null
    }, 45_000)
    expect(reopened.review.status).toBe('pending')

    // approve the second round so the run can close cleanly
    expect((await post(request, `/runs/${run.id}/review`, { decision: 'approve' })).status).toBe(200)
    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(done.review.status).toBe('approved')
  })
})

test.describe('budget guardrail', () => {
  test('spend above the budget pauses on a budget meeting; only raising the budget resumes', async ({ request }) => {
    // the active model is the provider template default (not the mock's /models
    // id), so price it through the default rate rather than a model key
    await put(request, '/config', {
      pricing: {},
      default_input_per_mtok: 1000,
      default_output_per_mtok: 1000,
    })
    const p = await project(request, { budget_usd: 0.5 })
    const run = await dispatch(request, p.id)

    const paused = await waitPhase(request, run.id, 'budget')
    const disc = paused.discussions.find(d => d.kind === 'budget')
    expect(disc).toBeTruthy()
    expect(disc.status).toBe('need_human')
    expect(paused.cost_usd).toBeGreaterThan(0.5)

    expect((await post(request, `/runs/${run.id}/budget`, { budget_usd: 0 })).status).toBe(400)
    expect((await post(request, `/runs/${run.id}/budget`, { budget_usd: -5 })).status).toBe(400)
    const tooLow = await post(request, `/runs/${run.id}/budget`, { budget_usd: 0.1 })
    expect(tooLow.status).toBe(400)
    expect(tooLow.body.detail).toMatch(/must be above/i)

    // a chat reply alone does NOT raise the budget
    const chat = await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, { text: 'please continue' })
    expect(chat.status).toBe(200)
    const still = await waitFor(async () => {
      const { body } = await get(request, `/runs/${run.id}`)
      return body.status === 'waiting_human' && body.phase === 'budget' ? body : null
    }, 10_000)
    expect(still.budget_usd).toBe(0.5)

    const raised = await post(request, `/runs/${run.id}/budget`, { budget_usd: 50 })
    expect(raised.status).toBe(200)
    expect(raised.body.status).toBe('running')
    expect(raised.body.budget_usd).toBe(50)

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(done.budget_usd).toBe(50)
    expect(done.discussions.find(d => d.id === disc.id).status).toBe('resolved')
    expect(done.cost_usd).toBeGreaterThan(0)
  })

  test('a budgeted project with an unpriced model fails closed until a price is configured', async ({ request }) => {
    await put(request, '/config', {
      pricing: {},
      default_input_per_mtok: 0,
      default_output_per_mtok: 0,
    })
    const p = await project(request, { budget_usd: 1 })
    const run = await dispatch(request, p.id)

    const paused = await waitPhase(request, run.id, 'budget')
    const disc = paused.discussions.find(d => d.kind === 'unpriced')
    expect(disc).toBeTruthy()
    expect(disc.status).toBe('need_human')
    expect(disc.messages[0].text).toContain("has no price")

    // replying without a price re-pauses
    await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, { text: 'go ahead' })
    await waitFor(async () => {
      const { body } = await get(request, `/runs/${run.id}`)
      return body.phase === 'budget' && body.status === 'waiting_human' ? body : null
    }, 15_000)

    // add a cheap price, then reply — the guard re-checks and proceeds
    await put(request, '/config', { default_input_per_mtok: 1, default_output_per_mtok: 1 })
    await post(request, `/runs/${run.id}/discussions/${disc.id}/reply`, { text: 'price is configured now' })

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(done.cost_usd).toBeGreaterThan(0)
    // the resumed calls are metered against the configured default rate
    expect(done.steps.some(s => s.cost_usd > 0)).toBe(true)
  })
})

test.describe('loop mode', () => {
  test('DONE ends the chain after one iteration', async ({ request }) => {
    await mockScenario(request, { loop: 'done' })
    const p = await project(request)
    const run = await dispatch(request, p.id, { task: 'Loop until done', loop: true })

    const done = await waitRun(request, run.id)
    expect(done.status).toBe('done')
    expect(done.loop_mode).toBe(true)
    expect(done.next_run_id ?? null).toBeNull()

    await new Promise(r => setTimeout(r, 500))
    const runs = (await get(request, '/runs')).body.filter(r => r.project_id === p.id)
    expect(runs.length).toBe(1)
  })

  test('a NEXT decision spawns exactly one child iteration, then DONE stops it', async ({ request }) => {
    await mockScenario(request, { loop: 'next' })
    const p = await project(request)
    const parent = await dispatch(request, p.id, { task: 'Add one slice per iteration', loop: true })

    const parentDone = await waitFor(async () => {
      const { body } = await get(request, `/runs/${parent.id}`)
      return body.status === 'done' && body.next_run_id ? body : null
    }, 20_000)
    expect(parentDone.next_run_id).toBeTruthy()

    const child = await waitRun(request, parentDone.next_run_id)
    expect(child.iteration).toBe(2)
    expect(child.trigger).toBe('loop')
    expect(child.status).toBe('done')
    expect(child.next_run_id ?? null).toBeNull()
    expect(child.task).toContain('follow-up slice')

    await new Promise(r => setTimeout(r, 500))
    const runs = (await get(request, '/runs')).body.filter(r => r.project_id === p.id)
    expect(runs.length).toBe(2)
    expect(runs.map(r => r.iteration).sort()).toEqual([1, 2])
  })
})

test.describe('per-step recovery', () => {
  test('a failed QA step can be retried in place without redoing the mission', async ({ request }) => {
    await mockScenario(request, { error: 'qa' })
    const p = await project(request)
    const run = await dispatch(request, p.id)

    const failed = await waitRun(request, run.id)
    expect(failed.status).toBe('done')
    const qa = stepOf(failed, 'qa')
    expect(qa.status).toBe('error')
    expect(qa.output).toMatch(/AI request failed/i)
    // the tail gate needs QA done, so no PR/demo steps exist yet
    expect(failed.steps.some(s => s.kind === 'pr')).toBe(false)
    expect(failed.acceptance ?? null).toBeNull()

    // only failed/skipped/stopped steps are retryable
    const doneStep = await post(request, `/runs/${run.id}/steps/po/work/retry`, {})
    expect(doneStep.status).toBe(400)
    expect(doneStep.body.detail).toMatch(/only failed, skipped or stopped/i)

    await mockReset(request) // the mock is healthy again
    const retry = await post(request, `/runs/${run.id}/steps/qa/work/retry`, {})
    expect(retry.status).toBe(200)
    expect(retry.body.status).toBe('running')

    const repaired = await waitRun(request, run.id)
    expect(repaired.status).toBe('done')
    expect(stepOf(repaired, 'qa').status).toBe('done')
    expect(stepOf(repaired, 'qa').output).toContain('ROLE_TOKEN:qa')
    // retrying the now-done step is rejected again
    expect((await post(request, `/runs/${run.id}/steps/qa/work/retry`, {})).status).toBe(400)
  })

  test('an empty provider answer is recorded as an error with a readable reason', async ({ request }) => {
    await mockScenario(request, { empty: 'qa' })
    const p = await project(request)
    const run = await dispatch(request, p.id)
    const done = await waitRun(request, run.id)

    expect(done.status).toBe('done')
    const qa = stepOf(done, 'qa')
    expect(qa.status).toBe('error')
    expect(qa.output).toMatch(/empty answer/i)
    expect(stepOf(done, 'po').status).toBe('done')
  })
})

test.describe('task dispatch', () => {
  test('dispatching a board task links the run, exposes subtasks and closes the task', async ({ request }) => {
    const p = await project(request)
    const task = await createTask(request, p.id, { title: 'Board-dispatched mission', priority: 'high' })

    const dispatched = await post(request, `/projects/${p.id}/tasks/${task.id}/run`, {})
    expect(dispatched.status).toBe(200)
    expect(dispatched.body.run.task_id).toBe(task.id)
    const runId = dispatched.body.run.id

    const live = await get(request, `/projects/${p.id}/tasks/${task.id}`)
    expect(live.body.active).toBe(true)
    expect(live.body.status).toBe('in_progress')

    const done = await waitRun(request, runId)
    expect(done.status).toBe('done')
    expect(done.task_id).toBe(task.id)

    const closed = await get(request, `/projects/${p.id}/tasks/${task.id}`)
    expect(closed.body.active).toBe(false)
    expect(closed.body.status).toBe('done')
    expect(closed.body.run_ids).toContain(runId)
    expect(closed.body.latest_run.id).toBe(runId)
    expect(closed.body.subtasks.length).toBe(9)

    const subtask = await get(request, `/projects/${p.id}/tasks/${task.id}/subtasks/qa-work?run=${runId}`)
    expect(subtask.status).toBe(200)
    expect(subtask.body.run.id).toBe(runId)
    expect(subtask.body.subtask.role).toBe('qa')
    expect(subtask.body.runs.map(r => r.id)).toContain(runId)

    const foreignRun = await get(request, `/projects/${p.id}/tasks/${task.id}/subtasks/qa-work?run=run-99999`)
    expect(foreignRun.status).toBe(404)
  })
})
