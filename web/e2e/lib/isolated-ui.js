// The Next app bakes its API origin at build time (default localhost:8000).
// When a spec runs against the isolated orchestrator (API_URL=:8010), rewrite
// the browser's API calls so the same UI can be exercised without a second
// Next dev server. A token can be passed in to replace the storageState one —
// required after an orchestrator restart, which drops in-memory sessions.
const API = process.env.API_URL || 'http://localhost:8000'

const REAL_API = /^https?:\/\/(?:localhost|127\.0\.0\.1):8000(?=\/|$)/

async function useIsolatedApi(page, token) {
  if (token) {
    await page.addInitScript(t => {
      try { localStorage.setItem('aap_token', t) } catch { /* about:blank */ }
    }, token)
  }
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1):8000(?=\/|$)/.test(API)) return
  await page.route(/^https?:\/\/(?:localhost|127\.0\.0\.1):8000\//, route => {
    const url = route.request().url().replace(REAL_API, API.replace(/\/$/, ''))
    return route.continue({ url })
  })
}

module.exports = { useIsolatedApi }
