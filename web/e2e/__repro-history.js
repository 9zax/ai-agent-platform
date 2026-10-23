// Final repro: open p-001's Oat (sa) node on :3000 with the user's real strings,
// narrow viewport, mocked activity — measure blow-out.
const { chromium } = require('@playwright/test')
const fs = require('fs')
const path = require('path')

const WEB = 'http://localhost:3000'
const API = 'http://localhost:8000'
function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD
  // repo-root .env (the orchestrator's own source of truth)
  const env = fs.readFileSync(path.join(__dirname, '../../../.env'), 'utf8')
  const line = env.split('\n').find(l => l.startsWith('ADMIN_PASSWORD='))
  return line ? line.slice('ADMIN_PASSWORD='.length).trim() : ''
}
const ADMIN_PASSWORD = adminPassword()

const TASK = 'ฝังโครง Design System starter: UX/UI ทำ design tokens (สี มิติก + typography + spacing) เป็น design-system/tokens.json พร้อมคู่มือใช้ design-system/USAGE.md และตัวอย่างประกอบใน design-system/example-page.html'
const THAI_LONG = 'ทีมทำงานร่วมกันแบบอัตโนมัติ'

const mockHistory = Array.from({ length: 6 }, (_, i) => ({
  run_id: `run-2f9${i}a`,
  project_name: 'AI Agent Platform',
  kind: 'work',
  iteration: 1,
  task: TASK,
  status: 'done',
  started_at: Math.floor(Date.now() / 1000) - (i + 1) * 7200,
  finished_at: Math.floor(Date.now() / 1000) - (i + 1) * 7000,
  meetings: i % 2,
  deliverable: i % 3 === 0 ? 'design-system/tokens.json' : null,
  output_excerpt: '## ผลงาน\n\n' + THAI_LONG + '\n\n`design-system/tokens.json` ' + THAI_LONG,
}))

;(async () => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed ${res.status}`)
  const { token } = await res.json()

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1035, height: 823 } })
  await page.addInitScript(t => {
    localStorage.setItem('aap_token', t)
    localStorage.setItem('aap_user', JSON.stringify({ username: 'admin' }))
  }, token)
  await page.route('**/agents/sa/activity', r => r.fulfill({ json: { role: 'sa', current: null, history: mockHistory } }))

  await page.goto(`${WEB}/projects/p-001`)
  await page.waitForTimeout(2500)
  // click the Oat node
  const node = page.locator('[data-testid="flow-node"]').filter({ hasText: 'Oat' }).first()
  await node.click()
  await page.getByTestId('agent-detail').waitFor({ timeout: 8000 })
  await page.getByTestId('detail-tab-history').click()
  await page.waitForTimeout(600)

  const m = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="agent-detail"]')
    const r = dlg.getBoundingClientRect()
    const card = dlg.querySelector('[data-testid="history-entry"]')?.getBoundingClientRect()
    const list = dlg.querySelector('[data-testid="history-entry"]')?.parentElement
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      dlgL: Math.round(r.left), dlgR: Math.round(r.right), dlgW: Math.round(r.width),
      cardR: card && Math.round(card.right), cardW: card && Math.round(card.width),
      cardPastDlg: card && Math.round(card.right - r.right),
      docScrollW: document.documentElement.scrollWidth,
      listScrollW: list?.scrollWidth, listClientW: list?.clientWidth,
    }
  })
  console.log(JSON.stringify(m, null, 2))
  await page.screenshot({ path: '/tmp/hist-narrow.png' })

  // worst case: expand entry #1 (markdown output)
  await page.locator('[data-testid="history-entry"]').first().locator('button').first().click()
  await page.waitForTimeout(400)
  const m2 = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="agent-detail"]')
    const r = dlg.getBoundingClientRect()
    const card = dlg.querySelector('[data-testid="history-entry"]')?.getBoundingClientRect()
    return { dlgR: Math.round(r.right), cardR: Math.round(card.right), cardPastDlg: Math.round(card.right - r.right) }
  })
  console.log('expanded:', JSON.stringify(m2))
  await page.screenshot({ path: '/tmp/hist-narrow-expanded.png' })
  await browser.close()
})().catch(e => { console.error(e); process.exit(1) })
