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

## 2. Current Status (MVP Scaffold)

### สิ่งที่ทำเสร็จแล้ว
- [x] โครงสร้างโปรเจกต์ + Docker Compose
- [x] Orchestrator (FastAPI) พื้นฐาน
  - `GET /containers` — ดูรายการ container
  - `POST /containers` — สร้าง container ใหม่
  - `GET/POST /tasks` — placeholder
- [x] Agent Base Image (Ubuntu + XFCE + noVNC + Firefox + Terminal)
- [x] Web Dashboard เริ่มต้น (Next.js)
- [x] Repository: https://github.com/9zax/ai-agent-platform

### สิ่งที่ยังไม่ได้ทำ
- [ ] เชื่อม Web frontend กับ Orchestrator API จริง
- [ ] UI สำหรับสร้าง/จัดการ Container
- [ ] ระบบ Task Queue + Assignment ของ Orchestrator
- [ ] AI Agent logic ภายใน Container (เรียก ZAI GLM)
- [ ] Vision / Screenshot capability
- [ ] Skills management (เพิ่ม/ลดผ่านหน้าเว็บ)
- [ ] GitHub OAuth + Permission approval flow
- [ ] Persistent storage สำหรับ AI memory และ config
- [ ] ระบบ Roles ที่ชัดเจน

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
| จำนวน Container | 5–10 | - |
| Runtime | Docker บน VPS | Scaffold done |
| Desktop | เห็น Chrome + Terminal จริง (noVNC) | Base image done |
| Persistence | Mount volume | ยังไม่ implement |
| AI Model | Config จากหน้าเว็บ, เก็บใน container ได้ | ยังไม่ทำ |
| AI Mode | อิสระ หรือควบคุมจากกลางได้ | ยังไม่ทำ |
| Vision | AI มองเห็นหน้าจอได้ (Screenshot) | ยังไม่ทำ |
| Orchestrator | รับงานจากผู้ใช้ แล้วแจกให้ Agents | Placeholder |
| Skills | ผู้ใช้เพิ่ม/ลดผ่านหน้าเว็บได้ | ยังไม่ทำ |
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
docker compose up --build

# Optional: เปิด example agent
docker compose --profile example up -d agent-example
```

| Service | URL |
|---------|-----|
| Web | http://localhost:3000 |
| API Docs | http://localhost:8000/docs |
| noVNC (example) | http://localhost:6080 (password: `agent`) |

## 9. Notes for Future AI / Developers

- โปรเจกต์นี้เป็น **MVP Scaffold** ยังไม่ใช่ระบบที่ใช้งานได้เต็มรูปแบบ
- โฟกัสต่อไปควรเป็น "ทำให้ Web ใช้งานได้จริง" ก่อน แล้วค่อยเพิ่ม AI logic
- การเก็บ API Key และ GitHub Token ต้องทำอย่างปลอดภัย (อย่าเก็บ plain text ใน container)
- ถ้าต้องการเปลี่ยนโมเดล AI ให้แก้ที่ configuration layer ไม่ใช่ hardcode

---

**Repository:** https://github.com/9zax/ai-agent-platform  
**Last Updated:** 2026-10-22
