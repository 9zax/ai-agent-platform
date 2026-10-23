// Deterministic OpenAI-compatible mock used by the isolated test stack.
// The orchestrator talks to this at /v1/chat/completions; tests steer the
// behaviour of the NEXT calls through POST /__scenario.
const http = require('http')

const PORT = Number(process.env.MOCK_PORT || 9101)

const DEFAULT_SCENARIO = {
  // ask: { role: 'ba', to: 'sa' | 'human' } — the role emits a trailing ## ASK
  ask: null,
  // files: emit a ## FILES block from builders (only when the orchestrator asks for it)
  files: true,
  // empty / error: role name, or 'all' — empty body / HTTP 500 for that role
  empty: null,
  error: null,
  // verdict for the PO acceptance check: pass | fail | none
  verdict: 'pass',
  // loop decision: done | next
  loop: 'done',
  // usage override per call
  usage: null,
  delayMs: 0,
}

let scenario = { ...DEFAULT_SCENARIO }
let calls = []

const NAMES = {
  Mickey: 'po', Petch: 'ba', Oat: 'sa', Sept: 'ux-ui', Chom: 'ux-ui-2',
  Zax: 'dev-fe', Bank: 'dev-be', Earth: 'dev-be-2', Tara: 'qa',
}

function roleOf(system) {
  for (const [name, role] of Object.entries(NAMES)) {
    if (new RegExp(`You are ${name}\\b`).test(system)) return role
  }
  return 'unknown'
}

function kindOf(system) {
  if (system.includes('Write the pull request')) return 'pr'
  if (system.includes('running the acceptance check')) return 'acceptance'
  if (system.includes('in a LOOP')) return 'loop'
  if (system.includes('live team meeting')) return 'meeting'
  if (system.includes('presenting your test evidence') || system.includes('presenting the REAL delivery')) return 'demo'
  if (system.includes('closing a team mission')) return 'summary'
  return 'work'
}

function workReply(role, system, user) {
  const revision = user.includes('Reviewer comment') || user.includes('Answers from the team')
  const title = role === 'po' ? 'Product brief' : role === 'ba' ? 'Business analysis' : role === 'sa' ? 'System spec'
    : role.startsWith('dev') ? 'Implementation slice' : role === 'qa' ? 'Test strategy' : 'Design deliverable'
  const lines = [
    `# ${title} — ${role}`,
    '',
    `ROLE_TOKEN:${role}`,
    `REVISION:${revision ? '2' : '1'}`,
    '',
    'Delivered by the mock team for the isolated integration suite.',
  ]
  if (role === 'sa') {
    lines.push('', '## Work Split', 'FRONTEND: UI slice', 'BACKEND: API slice', 'SHARED CONTRACT: GET /items')
  }
  if (role === 'po') {
    lines.push('', '## Acceptance criteria', '- Given a user, when they open the page, then it renders.', '- Given an empty list, then an empty state is shown.')
  }
  // Only when the orchestrator invited a FILES block (builders/designers with a repo).
  if (scenario.files && system.includes('section exactly titled "## FILES"')) {
    const body = revision ? `revision-${role}` : `first-${role}`
    lines.push('', '## FILES', `### docs/e2e-${role}.md`, '```', `# ${role} output`, body, '```')
  }
  if (scenario.ask && scenario.ask.role === role && !user.includes('Answers from the team')) {
    lines.push('', '## ASK', `To: ${scenario.ask.to}`, 'Which contract should we build against?')
  }
  return lines.join('\n')
}

function replyFor(kind, role, system, user) {
  switch (kind) {
    case 'pr':
      return 'TITLE: E2E mission — deterministic delivery\nBODY:\nShips the mission deliverables under missions/.'
    case 'acceptance': {
      const body = '## Acceptance check\n- ✅ Given a user opens the page, it renders.\n- ✅ Empty state covered.'
      const verdict = scenario.verdict === 'none' ? '' : `\nVERDICT: ${scenario.verdict.toUpperCase()}`
      return body + verdict
    }
    case 'loop': {
      // 'next' spawns exactly one child iteration, then reports DONE so a
      // loop-mode test cannot run away to the 8-iteration cap.
      const loopCalls = calls.filter(c => c.kind === 'loop').length
      return scenario.loop === 'next' && loopCalls <= 1
        ? `Iteration ${loopCalls}: add the follow-up slice`
        : 'DONE'
    }
    case 'meeting':
      return 'Answer: build against the shared GET /items contract.'
    case 'demo':
      return 'Demo evidence: unit + e2e tests green, delivery of record shown.'
    case 'summary':
      return '# Mission summary\n\nThe team delivered the scope and the acceptance check ran.'
    default:
      return workReply(role, system, user)
  }
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { /* keep {} */ }

    if (req.url === '/__reset' && req.method === 'POST') {
      scenario = { ...DEFAULT_SCENARIO }
      calls = []
      return json(res, 200, { ok: true })
    }
    if (req.url === '/__scenario' && req.method === 'POST') {
      scenario = { ...DEFAULT_SCENARIO, ...body }
      return json(res, 200, scenario)
    }
    if (req.url === '/__calls' && req.method === 'GET') {
      return json(res, 200, calls)
    }
    if (req.url === '/v1/models' && req.method === 'GET') {
      return json(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] })
    }
    if ((req.url === '/v1/chat/completions' || req.url === '/chat/completions') && req.method === 'POST') {
      const messages = Array.isArray(body.messages) ? body.messages : []
      const system = messages.find(m => m.role === 'system')?.content || ''
      const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n') || ''
      const role = roleOf(system)
      const kind = kindOf(system)
      const call = { n: calls.length + 1, kind, role, system: system.slice(0, 200), user: user.slice(0, 2000) }
      calls.push(call)

      const finish = () => {
        if (scenario.error === 'all' || scenario.error === role) {
          return json(res, 500, { error: { message: `mock failure for ${role}` } })
        }
        const content = (scenario.empty === 'all' || scenario.empty === role) ? '' : replyFor(kind, role, system, user)
        const usage = scenario.usage || { prompt_tokens: 1200, completion_tokens: 400 }
        return json(res, 200, {
          id: `mock-${call.n}`,
          object: 'chat.completion',
          model: body.model || 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: content ? 'stop' : 'stop' }],
          usage,
        })
      }
      if (scenario.delayMs > 0) return setTimeout(finish, scenario.delayMs)
      return finish()
    }
    json(res, 404, { error: 'not found' })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm listening on 127.0.0.1:${PORT}`)
})
