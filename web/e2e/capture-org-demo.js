// Capture demo screenshots of the org features (budget/goal, routines, doc
// comments, harness + manager, org view, skill studio, pricing). Run against a
// live stack after the e2e suite:
//   set -a && source ../../.env && set +a && node capture-org-demo.js
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const API = 'http://localhost:8000'
const WEB = 'http://localhost:3000'
const OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const user = process.env.ADMIN_USER || 'admin'
  const res = await page.request.post(`${API}/auth/login`, {
    data: { username: user, password: process.env.ADMIN_PASSWORD },
  })
  const { token } = await res.json()
  await page.addInitScript(t => {
    localStorage.setItem('aap_token', t)
    localStorage.setItem('aap_user', JSON.stringify({ username: user }))
  }, token)
  const auth = { 'x-session-token': token }

  // tidy leftovers from a previous failed run
  const projects = await (await page.request.get(`${API}/projects`, { headers: auth })).json()
  for (const p of projects.filter(p => p.name === 'Demo Ops Copilot')) {
    await page.request.delete(`${API}/projects/${p.id}`, { headers: auth })
  }
  const skills = await (await page.request.get(`${API}/skills`, { headers: auth })).json()
  for (const s of skills.filter(s => s.name.startsWith('Demo — Release Notes'))) {
    await page.request.delete(`${API}/skills/${s.id}`, { headers: auth })
  }

  const project = await (await page.request.post(`${API}/projects`, {
    headers: auth,
    data: {
      name: 'Demo Ops Copilot',
      description: 'ตัวอย่างโปรเจกต์สำหรับ goal ancestry + budget + routines + doc comments',
      goal: 'ลดเวลาตอบ incident ลงครึ่งหนึ่งภายใน Q4 ด้วย ops copilot ที่สรุป root cause อัตโนมัติ',
      budget_usd: 25,
      budget_alert_pct: 80,
    },
  })).json()

  const routine = await (await page.request.post(`${API}/projects/${project.id}/routines`, {
    headers: auth,
    data: { name: 'Morning triage', task: 'สรุป incident ค้างจากเมื่อวาน + ตั้งงานให้ทีมวันนี้', cron: '0 9 * * 1-5', enabled: true },
  })).json()
  await page.request.post(`${API}/projects/${project.id}/routines`, {
    headers: auth,
    data: { name: 'Weekly release notes', task: 'รวบรวม PR ที่ merge แล้วเขียน release notes', cron: '0 17 * * 5', enabled: true, loop_mode: true },
  })

  const doc = await (await page.request.post(`${API}/projects/${project.id}/docs`, {
    headers: auth,
    data: {
      folder: 'PO',
      title: 'Incident Response Runbook',
      content_md: '# Incident Response Runbook\n\n## Severity\n- **SEV1** — ระบบล่มทั้งระบบ ตอบภายใน 5 นาที\n- **SEV2** — ฟีเจอร์หลักเสีย ตอบภายใน 15 นาที\n\n## First 15 minutes\n1. ประกาศใน `#incident` พร้อม severity\n2. เปิด timeline และ assign incident commander\n3. ระบุ recent deploy ที่น่าสงสัย',
    },
  })).json()
  await page.request.post(`${API}/projects/${project.id}/docs/${doc.id}/comments`, {
    headers: auth,
    data: { author: 'po', quote: 'SEV1 — ระบบล่มทั้งระบบ ตอบภายใน 5 นาที', body: 'ช่วยระบุว่าใครเป็นคนประกาศ และ escalate ไปหาใครถ้าไม่ตอบใน 5 นาที' },
  })
  await page.request.post(`${API}/projects/${project.id}/docs/${doc.id}/comments`, {
    headers: auth,
    data: { author: 'sa', body: 'ควรผูก runbook นี้เข้ากับ alert ใน Grafana ด้วย จะได้เปิดตอน alert เข้ามาพอดี' },
  })

  // 1) project header — goal, budget, alert threshold
  await page.goto(`${WEB}/projects/${project.id}`)
  await page.getByTestId('tab-mission').waitFor({ timeout: 20000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'project-goal-budget.png') })
  console.log('saved project-goal-budget.png')

  // 2) routines tab
  await page.getByTestId('tab-routines').click()
  await page.getByTestId('routine-row').first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, 'project-routines.png') })
  console.log('saved project-routines.png')

  // 3) docs tab + anchored comments
  await page.getByTestId('tab-docs').click()
  await page.getByTestId('doc-row').filter({ hasText: 'Incident Response Runbook' }).getByTestId('doc-open').click()
  await page.getByTestId('doc-comment').first().waitFor({ timeout: 10000 })
  await page.getByTestId('doc-comments').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'project-doc-comments.png') })
  console.log('saved project-doc-comments.png')

  // 4) team org view
  await page.goto(`${WEB}/team`)
  await page.getByTestId('view-org').click()
  await page.getByTestId('org-view').waitFor({ timeout: 15000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'team-org.png') })
  console.log('saved team-org.png')

  // 5) persona editor — manager + harness (temporarily point a Dev at Claude Code)
  const agents = await (await page.request.get(`${API}/agents`, { headers: auth })).json()
  const target = agents.find(a => a.role === 'dev-fe') || agents[0]
  const harnessBefore = { harness: target.harness, harness_command: target.harness_command }
  await page.request.put(`${API}/agents/${target.role}`, { headers: auth, data: { harness: 'claude' } })
  await page.reload()
  await page.getByTestId('view-grid').waitFor({ timeout: 15000 })
  await page.getByTestId('view-grid').click()
  await page.getByTestId(`agent-edit-${target.role}`).click()
  await page.getByTestId('harness-select').waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  await page.getByRole('dialog').screenshot({ path: path.join(OUT, 'persona-harness.png') })
  console.log('saved persona-harness.png')
  await page.keyboard.press('Escape')
  await page.request.put(`${API}/agents/${target.role}`, { headers: auth, data: harnessBefore })

  // 6) skill studio — test bench + version history on a throwaway skill
  const skill = await (await page.request.post(`${API}/skills`, {
    headers: auth,
    data: { name: 'Demo — Release Notes', description: 'ร่าง release notes จาก PR ที่ merge แล้ว' },
  })).json()
  await page.request.put(`${API}/skills/${skill.id}`, {
    headers: auth,
    data: { name: 'Demo — Release Notes', description: 'สรุปการเปลี่ยนแปลงจาก PR และ commit แล้วเขียนเป็น release notes ภาษาไทย' },
  })
  await page.request.put(`${API}/skills/${skill.id}`, {
    headers: auth,
    data: { name: 'Demo — Release Notes', description: 'สรุปการเปลี่ยนแปลงจาก PR/commit เป็น release notes 2 ภาษา (ไทย/อังกฤษ) พร้อม highlight breaking changes' },
  })
  await page.request.put(`${API}/skills/${skill.id}/tests`, {
    headers: auth,
    data: { inputs: ['ร่าง release notes จาก PR #41 ปรับหน้า dashboard', 'สรุป breaking change ของ API v2'] },
  })

  await page.goto(`${WEB}/skills`)
  await page.getByTestId(`skill-test-${skill.id}`).click()
  await page.getByTestId('skill-test-input').waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  await page.getByRole('dialog').screenshot({ path: path.join(OUT, 'skill-test-bench.png') })
  console.log('saved skill-test-bench.png')
  await page.keyboard.press('Escape')

  await page.getByTestId(`skill-history-${skill.id}`).click()
  await page.getByTestId('skill-history').waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  await page.getByRole('dialog').screenshot({ path: path.join(OUT, 'skill-history.png') })
  console.log('saved skill-history.png')
  await page.keyboard.press('Escape')

  // 7) AI config — per-model pricing + defaults
  await page.goto(`${WEB}/ai-config`)
  await page.getByTestId('pricing-card').waitFor({ timeout: 15000 })
  await page.getByTestId('pricing-card').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'ai-config-pricing.png') })
  console.log('saved ai-config-pricing.png')

  // cleanup
  await page.request.delete(`${API}/skills/${skill.id}`, { headers: auth })
  await page.request.delete(`${API}/projects/${project.id}`, { headers: auth })
  console.log('demo cleaned up (project', project.id, '/ routine', routine.id + ')')
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
