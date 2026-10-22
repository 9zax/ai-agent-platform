// Logs in once (when auth is enabled) and shares the session with all tests via storageState
const { chromium } = require('@playwright/test')
const fs = require('fs')
const path = require('path')

const WEB = process.env.WEB_URL || 'http://localhost:3000'
const API = process.env.API_URL || 'http://localhost:8000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

module.exports = async function globalSetup() {
  const stateFile = path.join(__dirname, '.auth-state.json')

  let localStorage = []
  if (ADMIN_PASSWORD) {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
    })
    if (!res.ok) throw new Error(`global-setup: login failed (${res.status}) — check ADMIN_USER/ADMIN_PASSWORD`)
    const { token, user } = await res.json()
    localStorage = [
      { name: 'aap_token', value: token },
      { name: 'aap_user', value: JSON.stringify({ username: user }) },
    ]
    console.log(`global-setup: logged in as ${user}`)
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    cookies: [],
    origins: localStorage.length ? [{ origin: WEB, localStorage }] : [],
  }, null, 2))
}
