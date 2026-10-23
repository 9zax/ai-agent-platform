// Capture demo screenshots of the Project Docs space (run AFTER the e2e suite
// so both don't churn the same backend). Usage:
//   set -a && source ../../.env && set +a && node capture-docs-demo.js
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const API = 'http://localhost:8000'
const WEB = 'http://localhost:3000'
const OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()

  // login
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const user = process.env.ADMIN_USER || 'admin'
  const res = await page.request.post(`${API}/auth/login`, {
    data: { username: user, password: process.env.ADMIN_PASSWORD },
  })
  const { token } = await res.json()
  await page.addInitScript(t => { localStorage.setItem('aap_token', t); localStorage.setItem('aap_user', JSON.stringify({ username: user })) }, token)
  // APIRequestContext does NOT read localStorage — attach the session header ourselves
  const auth = { 'x-session-token': token }

  // demo project + docs via API (fast, deterministic); a previous failed run
  // may have left the demo behind — clean it first
  const old = await (await page.request.get(`${API}/projects`, { headers: auth })).json()
  for (const p of old.filter(p => p.name === 'Demo Food Delivery App')) {
    await page.request.delete(`${API}/projects/${p.id}`, { headers: auth })
  }
  const proj = await (await page.request.post(`${API}/projects`, { headers: auth, data: { name: 'Demo Food Delivery App', description: 'ตัวอย่างโปรเจกต์พร้อมชุดเอกสาร PO/BA/SA' } })).json()
  const post = (folder, title, content_md) => page.request.post(`${API}/projects/${proj.id}/docs`, { headers: auth, data: { folder, title, content_md } })
  await post('PO', 'Product Requirements (PRD)', `# PRD — แอปสั่งอาหาร\n\n## Problem\nผู้ใช้ต้องการสั่งอาหารจากร้านใกล้บ้านใน 3 นาที\n\n## Goals\n- สั่งอาหารจบใน 3 แตะ\n- ติดตามไรเดอร์แบบเรียลไทม์\n\n## Non-goals\n- ไม่ทำ wallet ภายในแอปในเฟสแรก`)
  await post('BA', 'Business Flow & Rules', `# Business Flow\n\n1. ลูกค้าเลือกเมนู → ตะกร้า\n2. ชำระเงินผ่าน promptpay\n3. ร้านรับออเดอร์ภายใน 5 นาที ไม่งั้น auto-refund\n\n| กรณี | กติกา |\n|---|---|\n| ร้านปิด | ซ่อนเมนู + แจ้งเวลาเปิด |`)
  await post('SA', 'System Architecture', `# Architecture\n\n- **Mobile**: React Native\n- **API**: Go + Postgres\n- **Tracking**: WebSocket ต่อ order id\n\n\`\`\`\n[App] → [API GW] → [Order SVC] → [PG]\n                 ↘ [Tracking WS]\n\`\`\``)
  const upload = await page.request.post(`${API}/projects/${proj.id}/docs/upload`, {
    headers: auth,
    multipart: { folder: 'BA', file: { name: 'pricing-research.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo pricing research') } },
  })
  const upDoc = await upload.json()

  await page.goto(`${WEB}/projects/${proj.id}`)
  await page.getByTestId('tab-mission').waitFor({ timeout: 20000 })
  await page.getByRole('tab', { name: 'Docs' }).click()
  await page.getByTestId('doc-row').filter({ hasText: 'Product Requirements' }).getByTestId('doc-open').click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(OUT, 'project-docs.png'), fullPage: false })
  console.log('saved docs/screenshots/project-docs.png')

  // editor dialog
  await page.getByTestId('doc-new').click()
  await page.getByTestId('doc-title-input').fill('User Stories')
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'project-docs-editor.png') })
  console.log('saved docs/screenshots/project-docs-editor.png')
  await page.keyboard.press('Escape')

  // file attachment view
  await page.getByTestId('doc-row').filter({ hasText: 'pricing-research' }).getByTestId('doc-open').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'project-docs-upload.png') })
  console.log('saved docs/screenshots/project-docs-upload.png')

  // cleanup — delete the demo project (docs cascade with it)
  await page.request.delete(`${API}/projects/${proj.id}`, { headers: auth })
  console.log('demo project deleted:', proj.id, '(uploaded:', upDoc.id + ')')

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
