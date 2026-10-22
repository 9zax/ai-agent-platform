# AI Agent Platform — Specification & Progress

> เอกสารนี้สำหรับ AI หรือนักพัฒนาที่ทำงานต่อจากจุดนี้  
> อัปเดตล่าสุด: 2026-10-22

## 1. Project Overview

ระบบสำหรับผู้ใช้คนเดียวที่ต้องการพัฒนาซอฟต์แวร์ร่วมกับ AI Agents หลายตัว  
แต่ละ Agent ทำงานใน Linux Container แยกกัน มี Desktop (noVNC) ให้เห็น Chrome + Terminal จริง  
มี Orchestrator คอยรับงานระดับสูงแล้วแจกงานให้ Agents ตามบทบาท

**เป้าหมายหลัก**
- จัดการ Container 5–10 ตัวผ่าน Web UI
- แต่ละ Container มีบทบาทชัดเจน (PO, Backend, Frontend, QA, DevOps ฯลฯ)
- AI ใช้โมเดล ZAI GLM (config ได้จากหน้าเว็บ) และมองเห็นหน้าจอได้ (Vision)
- ผู้ใช้สั่งงานและอนุมัติ Permission ผ่าน Web ได้
- เชื่อมต่อ GitHub ได้ (ผู้ใช้ Auth เอง, อนุมัติ Permission ครั้งเดียวต่อ Scope)

## 2. Current Status

### สิ่งที่ทำเสร็จแล้ว
- [x] โครงสร้างโปรเจกต์ + Docker Compose (production build — ไม่มี dev mounts)
- [x] Orchestrator (FastAPI)
  - `GET /containers` — ดูรายการ container จริงจาก Docker API
  - `POST /containers` — สร้าง container จริง
  - `POST /containers/{id}/start|stop|restart` + `DELETE` — lifecycle จริง (guard เฉพาะ container ที่ platform สร้าง)
  - `POST /containers/{id}/exec` — รัน shell ใน container
  - `POST /containers/{id}/agent` — **ZAI GLM รับคำสั่งภาษาธรรมชาติ → เลือกคำสั่ง shell → รันจริง**
  - `GET /containers/{id}/stats|inspect|files` — สถิติจริง / metadata / ไฟล์ใน container
  - `GET/POST/DELETE /tasks` — task board จริง
  - `GET/PUT /config`, `GET /skills`, `PUT /skills/{id}` — config + skills จริง
- [x] Web Dashboard (Next.js + Tailwind + shadcn/ui) เชื่อม API จริงทุกหน้า
  - Dashboard: ตาราง container สด, สร้าง container ผ่าน dialog, search/filter
  - Container detail: noVNC console (connect จริง), metrics สดจาก docker stats, tabs Files/Analytics/Security/Networks ของจริง, Command Center (AI/Shell)
  - Board: Kanban + เพิ่ม task จริง
  - Skills / AI Config / Settings หน้าจริง ใช้งานได้
- [x] Agent Base Image (Ubuntu + XFCE + noVNC + browser จริง + Terminal; Chrome บน amd64, Firefox ESR บน arm64)
- [x] AI Integration: ZAI GLM (Anthropic-compatible endpoint) — model เปลี่ยนได้จากหน้า AI Config
- [x] Safety guard: แก้ไขได้เฉพาะ container ที่ platform สร้างเท่านั้น (label `managed-by=ai-agent-platform`)
- [x] E2E tests (Playwright) 30  tests ครอบทุก feature รวม full container lifecycle และ AI agent
- [x] Repository: https://github.com/9zax/ai-agent-platform

### สิ่งที่ยังไม่ได้ทำ
- [ ] Vision / Screenshot capability
- [ ] GitHub OAuth + Permission approval flow
- [ ] Persistent storage สำหรับ AI memory และ config (ตอนนี้ config/tasks/runs เก็บในหน่วยความจำ)
- [x] ~~ระบบ Task Queue + Assignment อัตโนมัติของ Orchestrator~~ → **Team Run engine** (2026-10-22): `POST /projects/{id}/run` สั่งงานเดียวผ่านทีมทั้งโปรเจกต์ — agent แต่ละตัวทำงานตามลำดับ เห็นงานของคนก่อน (handoff) และเขียน deliverable ลง container จริง (`/workspace/run-xxx-{role}.md`); UI หน้า project มี Mission Control + timeline สด (poll `GET /runs/{id}`)
- [x] ~~ระบบ Roles ที่ชัดเจน~~ → personas 6 บทบาท (PO, Research, FE, BE, UX/UI, QA) แก้ได้จากหน้า AI Team

## 3. Architecture

```
┌──────────────────────────────────────────┐
│           Web Dashboard (Next.js)       │
│         http://localhost:3000           │
└────────────────┬─────────────────────────┘
                  │
┌────────────────▼──────────────────────────┐
│      Orchestrator (FastAPI)             │
│      http://localhost:8000              │
│  - จัดการ Containers                    │
│  - Task assignment                      │
│  - Permission & Config                  │
└────────────────┬───────────────────────────┘
                  │ Docker API
┌────────────────▼───────────────────────────┐
│         Agent Containers (5-10)         │
│  Ubuntu + XFCE + noVNC                  │
│  - AI Agent (ZAI GLM)                   │
│  - Chrome + Terminal                    │
│  - Skills / Tools                       │
└──────────────────────────────────────────┘
```

## 4. Requirements Summary

| หัวข้อ | รายละเอียด | สถานะ |
|--------|------------|-------|
| ผู้ใช้ | 1 คน | - |
| จำนวน Container | 5–10 | สร้างได้จาก UI แล้ว |
| Runtime | Docker บน VPS | Production build ใช้งานได้ |
| Desktop | เห็น browser + Terminal จริง (noVNC) | ✅ (Chrome amd64 / Firefox ESR arm64) |
| Persistence | Mount volume | ยังไม่ implement |
| AI Model | Config จากหน้าเว็บ, เก็บใน container ได้ | ✅ config จากหน้า AI Config (ZAI GLM) |
| AI Mode | อิสระ หรือควบคุมจากกลางได้ | บางส่วน (AI/Shell toggle ต่อ container) |
| Vision | AI มองเห็นหน้าจอได้ (Screenshot) | ยังไม่ทำ |
| Orchestrator | รับงานจากผู้ใช้ แล้วแจกให้ Agents | Manual board (ยังไม่ auto-assign) |
| Skills | ผู้ใช้เพิ่ม/ลดผ่านหน้าเว็บได้ | เปิด/ปิดได้จากหน้าเว็บ (เพิ่ม/ลบยังไม่ทำ) |
| GitHub | ผู้ใช้ Auth ผ่าน UI, อนุมัติ Permission ครั้งเดียว | ยังไม่ทำ |
| Permission UI | แสดงคำขอ Permission บนหน้าเว็บ | ยังไม่ทำ |

## 5. Recommended Roles

| บทบาท | หน้าที่ | จำนวนแนะนำ |
|--------|--------|-------------|
| Orchestrator | รับงาน แบ่งงาน ติดตาม ประสานงาน | 1 (บริการกลาง) |
| Product Owner | รับ requirement เขียน User Story | 1 |
| Backend Developer | พัฒนา API, Database, Logic | 1–2 |
| Frontend Developer | พัฒนา UI และเชื่อมต่อ API | 1–2 |
| QA / Tester | เขียนและรัน Test | 1 |
| DevOps | CI/CD, Docker, Deployment | 1 |

## 6. Technology Stack

| ส่วน | เทคโนโลยี | หมายเหตุ |
|------|-----------|----------|
| Orchestrator | FastAPI (Python) | มีอยู่แล้ว |
| Web | Next.js | มีอยู่แล้ว |
| Agent Base | Ubuntu 22.04 + XFCE + noVNC | มีอยู่แล้ว |
| AI | ZAI GLM (configurable) | ยังไม่ integrate |
| Database | SQLite (เริ่มต้น) | ยังไม่ใช้ |
| GitHub | OAuth + GitHub API | ยังไม่ทำ |

## 7. Next Steps (Priority Order)

1. **เชื่อม Web กับ API**  
   ทำให้หน้า Dashboard ดึงรายการ Container จริงและมีปุ่มสร้าง Container ใหม่

2. **ปรับปรุง Agent Base**  
   - เพิ่ม Chrome แทน Firefox (ถ้าต้องการ)  
   - เตรียมจุดสำหรับใส่ AI Agent script

3. **AI Integration**  
   - สร้าง agent runner ภายใน container ที่เรียก ZAI GLM  
   - รองรับการรับคำสั่งจาก Orchestrator  
   - เพิ่ม Screenshot + Vision

4. **Task System**  
   - Orchestrator รับงานระดับสูง  
   - แบ่งงานตามบทบาท  
   - ติดตามสถานะ

5. **GitHub & Permissions**  
   - OAuth flow  
   - Permission request + approval UI  
   - เก็บ token แบบปลอดภัย

6. **Skills Management**  
   - UI สำหรับเปิด/ปิด skill ต่อ container  
   - Dynamic skill loading

## 8. How to Run (Current)

```bash
git clone https://github.com/9zax/ai-agent-platform.git
cd ai-agent-platform

# API key ของ AI provider ที่จะใช้ (เว้นว่าง = ไปตั้งในหน้า AI Config บนเว็บ)
cp /dev/null .env   # แล้วใส่: AI_API_KEY=... (ถ้าใช้ endpoint ที่ไม่ใช่ค่า default ของ provider ให้ใส่ AI_BASE_URL=... ด้วย)

docker compose up --build -d

# เปิด example agent (Ubuntu desktop + noVNC)
docker compose --profile example up -d agent-example
```

| Service | URL |
|---------|-----|
| Web | http://localhost:3000 |
| API Docs | http://localhost:8000/docs |
| noVNC (example) | http://localhost:6080 (password: `agent`) |

**E2E tests:** `cd web/e2e && npm install && npx playwright install chromium && npm test`

## 9. Notes for Future AI / Developers

- Backend เป็น **Rust binary** (Axum + bollard) — compile ครั้งเดียวรันได้ทุกที่ที่มี Docker socket ไม่ต้องมี Python
- การเก็บ API Key และ GitHub Token ต้องทำอย่างปลอดภัย (อย่าเก็บ plain text ใน container) — API key ของ provider ผ่าน `.env` (gitignored)
- เปลี่ยนโมเดล AI ได้จากหน้า **AI Config** (provider templates: Z.ai GLM / Anthropic / OpenAI / OpenRouter / Groq / DeepSeek / Ollama local / Custom)
- Login: ตั้ง `ADMIN_USER`/`ADMIN_PASSWORD` ใน `.env` → เปิดระบบ login → container endpoints ทั้งหมด (exec/AI/lifecycle/VNC console) ต้อง login ก่อน; เว้น `ADMIN_PASSWORD` ว่าง = ปิด auth
- Dashboard แสดงเฉพาะ container ของ platform (label `managed-by`) โดย default — กด "All containers" เพื่อดูทั้งเครื่อง

## 10. Browser for AI Agents — ผลสำรวจ

ข้อสรุปสำหรับให้ agent ใช้ browser ภายใน container:

| ตัวเลือก | เหมาะกับ AI ใน container? | เหตุผล |
|---|---|---|
| **Chromium/Chrome headless + CDP** ✅ | ใช่ — มาตรฐานอุตสาหกรรม | เป็น protocol เดียวกับที่ Playwright/Puppeteer/Browser Use ใช้ — AI tooling เข้ากันได้กว้างที่สุด, เปิดหลาย tab/session ได้, ควบคุม network/DOM ละเอียด |
| Playwright (บน CDP) ✅ | ใช่ — ค่าเริ่มต้นสำหรับงานใหม่ | ชั้นที่สูงกว่า CDP ตรง ๆ เขียนเร็วกว่า ใช้กับ agent framework ได้ทันที |
| ego browser | ไม่ใช่สำหรับ container | ออกแบบให้ใช้ profile/login ของ user บนเครื่อง host — เหมาะกับ agent ฝั่ง host ไม่ใช่ sandbox แยก |
| Hosted (Browserbase ฯลฯ) | กรณีพิเศษ | สะดวกแต่มีค่าใช้จ่าย + ข้อมูลออกนอกเครื่อง |

**แนวทางของ platform นี้:** agent-base ติดตั้ง browser จริงไว้แล้ว (Chrome บน amd64 / Firefox ESR บน arm64 — Chrome ไม่มี arm64 Linux build) และมี `gh` CLI ให้เปิด GitHub issue ได้ตามที่ persona ประกาศไว้ใน rules; จะเพิ่ม headless Chromium + CDP endpoint ใน container เมื่อถึงขั้นตอน Vision/Screenshot

---

**Repository:** https://github.com/9zax/ai-agent-platform  
**Last Updated:** 2026-10-22
