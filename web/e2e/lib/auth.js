// Shared e2e auth helpers. Protected mode: the orchestrator only speaks the
// x-session-token header, so every raw API call needs the token global-setup
// persisted in .auth-state.json (spec modules load after global-setup runs).
// Use authHeaders() for Node-side request calls; for in-page fetches that run
// AFTER a page.goto, read localStorage directly instead (about:blank denies
// localStorage access, so never touch it before the first navigation).
const fs = require('fs')
const path = require('path')

function sessionToken() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.auth-state.json'), 'utf8'))
    return (state.origins?.[0]?.localStorage || []).find(e => e.name === 'aap_token')?.value || ''
  } catch {
    return ''
  }
}

const authHeaders = () => ({ 'x-session-token': sessionToken() })

module.exports = { sessionToken, authHeaders }
