# AI Agent Platform — Specification & Progress

> เอกสารนี้สำหรับ AI หรือนักพัฒนาที่ทำงานต่อจากจุดนี้  
> อัปเดตล่าสุด: 2026-10-23 (host execution migration)

## 1. Project Overview

ระบบสำหรับผู้ใช้คนเดียวที่ต้องการพัฒนาซอฟต์แวร์ร่วมกับ AI Agents หลายตัว  
แต่ละ Agent ทำงาน**บนเครื่องของผู้ใช้เอง (macOS) เป็น tmux session แยกกัน** (`agent-<role>`) — เปิดดูได้ด้วย `tmux attach` หรือ terminal ในเว็บ  
มี Orchestrator คอยรับงานระดับสูงแล้วแจกงานให้ Agents ตามบทบาท

**เป้าหมายหลัก**
- จัดการ Agent 5–10 ตัวผ่าน Web UI (tmux session บนเครื่อง — ไม่ใช้ Docker)
- แต่ละ Agent มีบทบาทชัดเจน (PO, Backend, Frontend, QA, DevOps ฯลฯ) และใช้ environment จริงของเครื่อง (tools, git config, GitHub login เดียวทั้งทีม)
- AI ใช้โมเดล ZAI GLM (config ได้จากหน้าเว็บ)
- ผู้ใช้สั่งงานและอนุมัติ Permission ผ่าน Web ได้
- เชื่อมต่อ GitHub ได้ (auth ระดับเครื่อง — เครื่องเดียว identity เดียว)

## 2. Current Status

### สิ่งที่ทำเสร็จแล้ว
- [x] **Host execution migration — agent รันบนเครื่องผู้ใช้ ไม่ใช้ Docker** (2026-10-23): ตัด Docker ออกทั้งระบบ — orchestrator (Rust/Axum) เรียกคำสั่ง agent ผ่าน **tmux session ต่อ role** (`agent-<role>`, ดูสดด้วย `tmux attach` / terminal ในหน้า agent) ทุกคำสั่งรันด้วย **environment จริงของเครื่อง** ($HOME, `~/.config/gh`, git config, tools ที่ลงไว้ — เครื่องเดียว identity เดียว), workspace ร่วมของทีมกลายเป็น **`./workspace`** (AAP_WORKSPACE) และ state เป็น **`./data`** (DATA_DIR — runs.json/paused.json/agents.json), registry ของ agent persist ที่ `agents.json`, lifecycle = จัดการ tmux session (pause = kill session + registry), idle sweeper ฆ่า session idle, terminal ในเว็บ = **PTY attach เข้า session แบบ grouped** (เปิดหลายหน้าจอพร้อมกันได้), ตัด noVNC/agent-base image/deploy staging stage ทิ้ง — mission pipeline เหลือ relay → meeting → **PR จริง → demo ตรวจรับ**, รันทั้งระบบด้วย **`make run`** (orchestrator :8000 + web :3000 เป็น host process, ไม่มี Docker เลย)
- [x] **Retry ราย step (per-step retry)** (2026-10-23): ความล้มเหลวเกิดราย step การกู้ก็เป็นราย step — ปุ่ม **"ลองซ้ำ"** ที่หัว step ที่ `error`/`skipped`/`stopped` (ถูกหยุดกลางคัน) ใน timeline (`POST /runs/{id}/steps/{role}/{kind}/retry`) สั่ง redo **เฉพาะ step นั้น in-place**: งาน done ของคนอื่นทุก step, meetings และ tail outcomes ถูกเก็บไว้ครบ ไม่ spawn run ใหม่; work step ถูกเรียกใหม่ด้วย handoff เดิม (สร้างจาก done outputs ก่อนหน้า) ตาม config ปัจจุบัน (model/persona/container/repo ณ ตอน retry — แก้สาเหตุเช่นเปลี่ยน model ที่พังแล้วกดลองซ้ำได้เลย), tail steps (pr/demo) รัน stage จริงใหม่ตาม state ปัจจุบันของ workspace; run เปิดกลับเป็น `running` ระหว่าง retry (UI poll สด + กดหยุดได้) แล้วปิดด้วยกติกาเดิม (all-error ⇒ error, ไม่งั้น done); ASK จาก deliverable ที่ retry ถูก strip (ไม่มี meeting engine ติดตาม run ที่ reopen); ปุ่มเดิมระดับ mission เปลี่ยนชื่อเป็น **"เริ่ม mission ใหม่"** (redo ทั้ง run เป็น run ใหม่); e2e `web/e2e/step-retry.spec.js`
- [x] Orchestrator API (Rust + Axum — เดิมเขียน FastAPI แล้ว port มา)
  - `GET /containers` — รายการ agent (tmux session) / `POST /containers` — start agent ใหม่
  - `POST /containers/{id}/start|stop|restart|pause|resume` + `DELETE` — lifecycle ของ session
  - `POST /containers/{id}/exec` — รัน shell ในบริบทของ agent
  - `GET /containers/{id}/terminal/ws` — interactive terminal จริง (WebSocket ⇄ PTY ⇄ tmux + xterm.js ใน UI)
  - `POST /containers/{id}/agent` — ZAI GLM รับคำสั่งภาษาธรรมชาติ → เลือกคำสั่ง shell → รันจริง
  - `GET /containers/{id}/stats|inspect|files` — สถานะ / metadata / ไฟล์ใน workspace
  - `GET/POST/DELETE /tasks` — task board จริง
  - `GET/PUT /config`, `GET /skills`, `PUT /skills/{id}` — config + skills จริง
- [x] Web Dashboard (Next.js + Tailwind + shadcn/ui) เชื่อม API จริงทุกหน้า
  - Dashboard: ตาราง agent สด, สร้าง agent ผ่าน dialog, search/filter
  - Agent detail: **live terminal (tmux)**, metrics (Disk ของ workspace — CPU/Mem เป็น "—" เพราะไม่มี cgroup), tab Files, Command Center (AI สั่งงาน / Shell = terminal จริง xterm.js)
  - Board: Kanban + เพิ่ม task จริง
  - Skills / AI Config / Settings หน้าจริง ใช้งานได้
- [x] AI Integration: ZAI GLM (Anthropic-compatible endpoint) — model เปลี่ยนได้จากหน้า AI Config
- [x] **Design + Code missions — PR มีไฟล์จริง** (2026-10-23): dev/UX agent ที่ทำงานกับ repo จบ reply ด้วย section `## FILES` → orchestrator เขียนลง working tree จริงใน workspace → PR stage commit ทุกอย่างเป็น mission branch
- [x] E2E tests (Playwright) ครอบทุก feature รวม full agent lifecycle, mission pipeline และ AI agent
- [x] Repository: https://github.com/9zax/ai-agent-platform

### สิ่งที่ยังไม่ได้ทำ
- [ ] Vision / Screenshot capability
- [ ] GitHub OAuth + Permission approval flow
- [ ] Persistent storage สำหรับ AI memory และ config (ส่วน **runs ทำแล้ว** — เก็บถาวรที่ `/data/runs.json` ผ่าน volume `agent-data` เห็นข้าม restart; เหลือ personas/tasks/config/skills ยังเก็บในหน่วยความจำ)
- [x] **Agent activity + work history** (2026-10-23): กด node agent ใน React Flow → dialog 3 tab — **กำลังทำอะไรอยู่** (สถานะสด: working / speaking / รอคนตอบ / pending + งานที่ทีมกำลังทำ) · **ประวัติการทำงาน** (ทุก run ที่ agent นั้นร่วม พร้อมเวลา/ระยะเวลา/rev/meeting/excerpt ของ deliverable — ดึงจาก `GET /agents/{role}/activity`, ประวัติ persist ข้าม restart) · **แก้ไข persona** (form เดิม); run ทุกอันถูก persist เป็น `/data/runs.json` (atomic write) และ restore ตอน boot (run ที่ค้างกลางคันปิดเป็น `stopped`)
- [x] **Connector auth แบบแยกเครื่อง — ทุกเครื่อง auth ใหม่ผ่าน browser** (2026-10-23): ตัดการ inject platform PAT เข้า `gh` ของ agent ทิ้ง — เดิม `ensure_tools` ลง `gh auth login --with-token` + `git config url.insteadOf` ด้วย token จาก Settings → Git Access ให้ **ทุก container** ทำให้ทั้งทีม push/PR ด้วย GitHub identity เดียวกันโดยไม่รู้ตัว; ตอนนี้ GitHub identity ของแต่ละเครื่องมาจากการ login ของเครื่องนั้นเองผ่าน connector เท่านั้น (browser device flow เป็นหลัก / วาง token เป็นสำรอง), platform PAT เหลือบทบาท **clone อย่างเดียว** (อ่าน — และ origin URL ถูกล้างกลับหลัง clone), `ensure_tools` strip `insteadOf` legacy ของสมัยเก่า best-effort, ไม่ force-logout เครื่องที่ login ไว้แล้ว
- [x] **Meeting = แชทเรียลไทม์ + Need human** (2026-10-23): ช่วงถาม-ตอบในหน้า project เป็น chat thread จริง — bubble ซ้าย (agent) / ขวา (คุณ), เวลาต่อข้อความ, system note กลางการ์ด, **typing indicator** ระหว่างรอคำตอบ, auto-scroll; agent ที่ตอบไม่ได้จริง ๆ ASK ถึง `human` (หรือครบ cap ของ meeting) → run เข้าสถานะ **waiting_human** หยุดรอ แล้วคนตอบในกล่องแชท (`POST /runs/{id}/discussions/{d}/reply`) ทีมทำงานต่อ — มี timeout 1 ชม. (ผ่านไปแล้วทีมไปต่อพร้อม note), node/meeting บน canvas ขึ้นสถานะ rose "รอคุณตอบ"
  - [x] **กล่องข้อความเข้า (Human inbox)** (2026-10-23): ก่อนหน้านี้คำถาม `need_human` เห็นเฉพาะเมื่อเปิดหน้า Board/Mission Control อยู่ — ตอนนี้ Sidebar (ทุกหน้า) มี inbox กระดิ่ง: poll `GET /runs` ทุก 4 วิ, badge จำนวนคำถามที่รอคุณอยู่ (rose + ping ตอนมีของใหม่, แอมเบอร์เมื่อเปิดดูแล้ว), กดเปิด dropdown รายการคำถาม (ใครถาม · โปรเจกต์ · topic) กด**ไปตอบ** → พาไป Mission Control ของโปรเจกต์นั้น, และ **toast** มุมขวาล่างแจ้งทันทีที่คำถามใหม่มาถึง (ปิดเอง 12 วิ / "ไว้ทีหลัง" / ไปตอบ) — e2e `inbox.spec.js` 3 tests (mock `GET /runs` เพราะ `need_human` เกิดกลาง run เท่านั้น)
- [x] **Loop mode** (2026-10-23): ติ๊ก "ทำงานเป็น Loop" ตอนสั่งงาน (`{task, loop: true}`) → จบ run แล้ว **PO ประเมิน** goal เทียบกับสรุปทุกรอบ แล้วเขียน task ของรอบถัดไปเอง (หรือตอบ `DONE` จบ chain) — run ถัดไปถูก spawn อัตโนมัติ (จำกัด 8 รอบ), UI ตาม chain ผ่าน `next_run_id`, กด **หยุดทีม** (`POST /runs/{id}/stop`) ได้ทุกเมื่อ (งานที่เหลือเป็น skipped)
- [x] ~~ระบบ Task Queue + Assignment อัตโนมัติของ Orchestrator~~ → **Team Run engine** (2026-10-22): `POST /projects/{id}/run` สั่งงานเดียวผ่านทีมทั้งโปรเจกต์ — agent แต่ละตัวทำงานตามลำดับ เห็นงานของคนก่อน (handoff) และเขียน deliverable ลง container จริง (`/workspace/run-xxx-{role}.md`); UI หน้า project มี Mission Control + timeline สด (poll `GET /runs/{id}`)
- [x] **Meeting loop — ทีมถามกลับกันได้** (2026-10-23): agent ที่ติดขัดจบคำตอบด้วยบล็อก `## ASK` + `to: role1, role2` → ระบบเปิดการ์ด **Team Meeting** (Discussion) — ผู้ถูกถามตอบทีละคน (เห็นสดทีละข้อความ), เจ้าของคำถามแก้ deliverable เป็น **rev 2** (เขียนทับไฟล์ใน container จริง), ถามต่อได้ (จำกัด 2 รอบ meeting แล้ว PO ตัดสิน), จบด้วย **PO เขียนสรุป mission**; React Flow แสดงสด: node ที่กำลังทำงาน (ฟ้า) / กำลังคุย (เหลือง) / ส่งงานแล้ว (เขียว) + การ์ด Meeting ลอยเชื่อมเส้น amber ถึงทุกคนที่เกี่ยวข้อง พร้อมแชทถาม-ตอบใน timeline
- [x] ~~ระบบ Roles ที่ชัดเจน~~ → personas 9 บทบาท แก้ไขได้จากหน้า AI Team — flow ตาม process จริง: **PO (Mickey) เปิดโจทย์ → BA (Petch) วิเคราะห์ business → SA (Oat) ทำ system spec แล้วคุยกับ UX/UI (Sept, Chom), Dev (Zax, Bank, Earth) และ QA (Tara)** ทุกตัวทำงานร่วมกันในทีมเดียว
- [x] Default project: **AI Agent Platform** (seed มาตอน startup) — ทีมทำงานกับตัว platform เอง (ไม่ใช่ Web Portal ทั่วไป) พร้อม flow BA→SA→PO→Specialists ในหน้า Projects
- [x] **Repo-first workspace** (2026-10-23) — หลักการ "bot ทำงานบนเครื่อง Linux": ทุกคำสั่งรันใน container ของ agent จริง, project มี `repo_url` (แก้ได้ในหน้า Projects) และ orchestrator จะ `git clone` (depth 1) ลง `/workspace/<repo>` ให้ก่อนทำงาน — idempotent (มี clone อยู่แล้ว = ไม่แตะ working tree), ติดตั้ง git ให้เองถ้า image ไม่มี (apk/apt)
  - Command Center (AI): clone repo ก่อน → รันคำสั่งด้วย cwd = repo → response แสดง `repo` path / `repo_warning`
  - Team Run: clone ครั้งเดียวใน container แรกที่ running ก่อนเริ่ม relay → prompt ทุก persona อ้าง path repo จริง (cite real paths, ทำงานไฟล์ผ่าน repo เท่านั้น)
  - Container ที่ platform สร้าง mount volume ร่วม `ai-agent-platform-workspace:/workspace` = ทั้งทีมแชร์ working tree เดียว (เหมือนทำงานบนเครื่องเดียว); compose ของ `agent-example` pin ชื่อ volume ให้ตรงกันด้วย
  - **Private repo**: ตั้ง GitHub PAT (สิทธิ์อ่าน Contents) ที่หน้า **Settings → Git Access** → orchestrator แทรก token แบบ `x-access-token` ใน URL **ตอน clone ครั้งแรกเท่านั้น** (token ไม่โผล่ใน error/log) และหลัง clone เสร็จจะ **reset origin URL กลับเป็น URL สะอาดทันที** — token ไม่ตกค้างใน `.git/config` การ fetch/push ครั้งถัดไป auth ด้วยสิทธิ์ของเครื่องนั้นเองผ่าน gh credential helper
  - หมายเหตุ: container เก่าที่สร้างก่อน feature นี้ไม่มี bind `/workspace` (Docker ใส่ bind ย้อนหลังไม่ได้) — recreate ตัว agent ถ้าต้องการแชร์ volume; `ensure_repo` ยังทำงานกับ container เก่าได้ (clone ลง layer ของ container นั้น) เพียงแต่ไม่แชร์/ไม่ persist
- [x] **Default tool belt ทุก container + tools manifest ใน prompt** (2026-10-23): หลักการ "ทุกเครื่อง Linux มี default เหมือนกัน และ AI รู้ว่ามีอะไรใช้ได้จริง"
  - `ensure_tools` (orchestrator): ก่อน AI ทำงานทุกครั้ง — ติดตั้ง core tools ที่ขาดให้อัตโนมัติ (git, gh, curl, jq, ca-certificates — รองรับทั้ง apk/apt ใช้กับ image ใดก็ได้รวมถึง container เก่า), ตั้ง git identity default (AI Agent / agent@ai-agent-platform.local) ให้ commit ไม่พัง — **ไม่ลงทะเบียน GitHub PAT ของ platform กับ `gh` ใน container ใดๆ** (auth เป็นเรื่องระดับเครื่อง — ดู connector ด้านล่าง) และ strip rewrite `url.*x-access-token*.insteadOf` แบบ legacy ที่เคยถูกเขียนสมัย shared-PAT ออก best-effort
  - `tools_manifest` (orchestrator): probe ของจริงใน container (`command -v` + `--version` + สถานะ `gh auth status`) แล้วแปะเข้า system prompt เป็นสองรายการ: **tools ที่มีจริงพร้อม version + hint การใช้** และ **tools ที่ไม่มี (ห้ามใช้/ห้ามเดา)** — แก้ปัญหา AI hallucinate เครื่องมือ (เคส `gh: not found`)
  - agent-base image เพิ่ม default tools: wget, jq, zip/unzip, ripgrep, rsync, openssh-client, file, tree, less, nano, xz-utils (เดิมมี git, gh, curl, python3+pip, Node 22, chromium อยู่แล้ว)
  - persona rules ตัด hardcoded claim "`gh` CLI is installed" ออก (ต้นเหตุ hallucination) — ความจริงเรื่องเครื่องมือมาจาก manifest ที่ probe จริงเท่านั้น
  - หมายเหตุ: ต้อง rebuild + recreate orchestrator จะได้ feature นี้; ส่วน agent container เก่าใช้ได้ทันทีผ่าน `ensure_tools` (auto-install) ไม่ต้อง recreate แต่ถ้าอยากได้ tools เต็มใน image (rg, rsync, chromium ฯลฯ) ต้อง rebuild agent-base แล้ว recreate ตัว agent
- [x] **Mission tail: PR จริง → Deploy staging จริง → Demo ตรวจรับโดย PO** (2026-10-23): หลัง QA (Tara) ทำงานเสร็จและ meeting ปิดหมด run ไม่จบแค่ deliverable — **Dev (role แรกที่ขึ้นต้น `dev`) เปิด Pull Request จริง** ใน container ของตัวเอง (สร้าง branch ชื่อเดียวกับ run id, คัดลอก deliverables ลง `missions/<run id>/`, commit, push, `gh pr create` — PR URL จริงถูกเก็บใน step; precondition ไม่ครบ เช่น ไม่มี container/ไม่มี repo/`gh` ไม่ auth → step เป็น **skipped พร้อมเหตุผลจริง** ไม่เคยปลอมแปลง URL), แล้ว **deploy จริง** ไปยัง staging compose project แยก (`docker compose -p <repo>-staging` + สร้าง compose file สำเนาเต็มที่ remap port เป็น **13000/18000** ผ่าน sed — ห้ามใช้ override file เพราะ compose จะ merge port แล้วชนกับ stack ที่รันอยู่; ตรวจ running services ด้วย `ps --services`), จากนั้นเปิด **session "demo" ชนิดใหม่ใน timeline chat (Discussion kind=demo)**: orchestrator เปิดหัว → QA นำเสนอหลักฐาน e2e จาก deliverable ของตัวเอง → Dev นำเสนอ PR/staging URL จริง (prompt บังคับใช้เฉพาะข้อเท็จจริงที่ให้) → orchestrator ปัก "delivery of record" → **PO ไล่เช็ก acceptance criteria ทีละข้อ** (quote + ✅/❌ + evidence) ปิดท้ายด้วย `VERDICT: PASS|FAIL` ซึ่งถูก parse เป็น `run.acceptance` (parse ไม่ได้ = FAIL เสมอ) และเขียน `/workspace/<run id>-demo.md` ลง container ของ PO; UI มี step kind ใหม่ (PR/Deploy/Demo + icon GitPullRequest/Rocket/MonitorPlay), badge phase "demo & acceptance", การ์ด **Acceptance verdict** และการ์ด demo session สีม่วง; **loop mode ใช้ verdict เป็นเงื่อนไข** — FAIL ต้องออก task แก้ตาม findings (ห้าม DONE), PASS อาจ DONE ได้; e2e ใหม่ `web/e2e/mission.spec.js` ครอบทั้ง flow (spec แรกที่ dispatch run จริง)
  - เงื่อนไขของ docker ใน agent: `create_container` mount `/var/run/docker.sock` ให้ทุก agent ที่ platform สร้าง (container เก่าต้อง recreate — bind ย้อนหลังไม่ได้), `ensure_tools` ติดตั้ง docker CLI + compose plugin อัตโนมัติเมื่อเจอ socket (apk `docker-cli docker-cli-compose` / apt `docker.io`), agent-base image ฝัง docker static CLI + compose v2 ไว้เลย — หมายเหตุ: mount socket = agent คุม host daemon ได้ (root-equivalent) ยอมรับได้เพราะระบบผู้ใช้คนเดียวและ orchestrator ถือ socket เต็มอยู่แล้ว
  - สิทธิ์ push/PR เป็นของเครื่อง ไม่ใช่ของแพลตฟอร์ม: `gh` ใน container ต้อง login ด้วยตัวเองผ่าน **GitHub connector** — หลักคือ **browser device flow** (แต่ละเครื่อง auth ใหม่ทีละเครื่อง ผ่าน github.com/login/device) หรือวาง PAT สิทธิ์ **Contents: Read and write** เป็นทางสำรอง; ถ้ายังไม่ login ตอนถึงขั้น PR → orchestrator เปิด device flow + ถามใน mission chat (need-human) รออนุมัติผ่าน browser; token จาก Settings → Git Access **ไม่ถูกใช้ตรงนี้** (ใช้ตอน clone อย่างเดียว)

## 3. Architecture

```
┌──────────────────────────────────────────┐
│           Web Dashboard (Next.js)        │
│         http://localhost:3000            │
└────────────────┬─────────────────────────┘
                 │
┌────────────────▼──────────────────────────┐
│   Orchestrator (Rust + Axum, host proc)  │
│        http://localhost:8000             │
│  - จัดการ Agent (tmux sessions)          │
│  - Team run engine + meetings            │
│  - Permission & Config                   │
└────────────────┬───────────────────────────┘
                 │ tmux + bash (host)
┌────────────────▼───────────────────────────┐
│      Agent tmux sessions (5-10)          │
│      agent-<role> บนเครื่องผู้ใช้เอง      │
│  - AI Agent (ZAI GLM) — shell จริง       │
│  - เครื่องมือจริงของเครื่อง (git/gh/...)  │
│  - shared workspace: ./workspace         │
│  state: ./data (runs/paused/agents.json) │
└──────────────────────────────────────────┘
```

## 4. Requirements Summary

| หัวข้อ | รายละเอียด | สถานะ |
|--------|------------|-------|
| ผู้ใช้ | 1 คน | - |
| จำนวน Agent | 5–10 (tmux session) | สร้างได้จาก UI แล้ว |
| Runtime | host process (macOS) ผ่าน `make run` | ✅ ไม่ใช้ Docker |
| Visibility | เห็น agent ทำงานสดผ่าน `tmux attach` / terminal ในเว็บ | ✅ (grouped session — ดูพร้อมกันหลายคน) |
| Persistence | ไฟล์ JSON ในเครื่อง | ✅ runs/paused/agents เก็บถาวรที่ ./data — เหลือ config/personas/tasks |
| AI Model | Config จากหน้าเว็บ | ✅ config จากหน้า AI Config (ZAI GLM) |
| AI Mode | อิสระ หรือควบคุมจากกลางได้ | บางส่วน (AI/Shell toggle ต่อ agent) |
| Vision | AI มองเห็นหน้าจอได้ (Screenshot) | ยังไม่ทำ |
| Orchestrator | รับงานจากผู้ใช้ แล้วแจกให้ Agents | Manual board (ยังไม่ auto-assign) |
| Skills | ผู้ใช้เพิ่ม/ลดผ่านหน้าเว็บได้ | เปิด/ปิดได้จากหน้าเว็บ (เพิ่ม/ลบยังไม่ทำ) |
| GitHub | ผู้ใช้ Auth ผ่าน UI | ✅ connector (browser device flow / PAT) — auth ระดับเครื่อง เครื่องเดียว identity เดียว |
| Permission UI | แสดงคำขอ Permission บนหน้าเว็บ | บางส่วน (in-mission device flow ถามใน mission chat แล้ว) |

## 5. Recommended Roles

Flow การทำงานของทีม (ตาม process จริง): **PO เปิดโจทย์ → BA วิเคราะห์ business → SA แปลงเป็น system spec แล้ว brief ให้ UX/UI + Dev + QA (ทำงานร่วมกันใน mission เดียว)** — SA เป็นคนคุยกับ Dev เป็นหลัก, BA ตามเข้าเฉพาะตอน clarify business rules, PO ประสานทั้งทีม

| บทบาท | ชื่อ Agent | หน้าที่ |
|--------|-----------|--------|
| Orchestrator | (บริการกลาง) | รับงาน แบ่งงาน ติดตาม ประสานงาน |
| Product Owner | Mickey | เปิดโจทย์ กำหนด goal/priority และประสานงานทั้งทีม (มาก่อนทุกคน) |
| Business Analyst | Petch | รับ goal จาก PO → business requirements, success metrics, ความเสี่ยง |
| System Analyst | Oat | แปลง business → system spec (data model, API contract) และ brief ให้ทีมสร้าง |
| UX/UI Designer | Sept | ฝั่ง UX — user flows, IA, wireframes, unhappy paths |
| UX/UI Designer | Chom | ฝั่ง UI — visual design, design tokens, components |
| Frontend Developer | Zax | พัฒนา UI และเชื่อมต่อ API |
| Backend Developer | Bank | Services / API design, observability |
| Backend Developer | Earth | Data, migrations, caching, CI/CD, reliability |
| QA Engineer | Tara | Test strategy, E2E (Playwright), quality gates |

## 6. Technology Stack

| ส่วน | เทคโนโลยี | หมายเหตุ |
|------|-----------|----------|
| Orchestrator | Rust + Axum + tokio | host binary — รันด้วย `make api` |
| Agent runtime | tmux + bash (host) | session `agent-<role>`, workspace `./workspace` |
| Web | Next.js | รันด้วย `make web` |
| AI | ZAI GLM (Anthropic-compatible, configurable) | ✅ |
| Database | ไม่มี — JSON files (runs/paused/agents.json) | atomic tmp+rename |
| GitHub | gh CLI + device flow connector | auth ระดับเครื่อง |

## 7. Next Steps (Priority Order)

> Roadmap นี้ปรับจาก research 2026-10-23: แนวโน้มแพลตฟอร์ม agent ระดับ Devin/OpenHands คือ multi-agent ที่ส่งมอบ **โค้ดจริงใน PR** + governance/observability, ฝั่ง design เคลื่อนไปทาง **agentic design system** (tokens/components เป็นไฟล์ที่ agent อ่าน-เขียนได้) และ **MCP** กลายเป็นมาตรฐานการต่อ context/tool ภายนอก

1. **Agent Vision — screenshot + vision QA** (ต่อยอด design/code missions)
   dev/QA ถ่าย screenshot ผล deploy staging ด้วย chromium headless ใน container แล้วส่งเข้า vision model เทียบกับ design tokens/wireframe → QA verdict มีหลักฐานภาพจริง ไม่ใช่แค่ข้อความ
2. **Persistent storage สำหรับ personas/config/skills** (runs ทำแล้ว — เหลือส่วนอื่นเก็บลง `/data` เหมือนกัน)
3. **Dynamic skills loading** — per-container skill bundle ที่ agent โหลดตอนทำงาน ไม่ใช่ toggle รวม
4. **MCP connectors** — ต่อยอดระบบ connector (GitHub/Figma) ให้ agent เรียก MCP server ภายนอกได้ per-container แบบเดียวกับ token connector ปัจจุบัน
5. **Mission observability** — นับ token/ต้นทุน/เวลาต่อ step และต่อ run สรุปใน mission summary (governance ตามแนว platform-layer agents)
6. **เชื่อม Web กับ API** *(เก่า — ทำแล้วทั้งหมด คงไว้เป็นประวัติ)*
   ทำให้หน้า Dashboard ดึงรายการ Container จริงและมีปุ่มสร้าง Container ใหม่

2. **ปรับปรุง Agent Base**  
   - ~~เพิ่ม Chrome แทน Firefox~~ เสร็จแล้ว (2026-10-23): arm64 ใช้ Chromium จาก Playwright, ลดขนาดภาพด้วย XFCE minimal  
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

# ตั้ง: AI_API_KEY (หรือไปตั้งในหน้า AI Config), ADMIN_USER/ADMIN_PASSWORD (เว้นว่าง = ปิด login)
cp .env.example .env

make build   # cargo release + web production build
make run     # orchestrator :8000 + web :3000 เป็น host process (ไม่มี Docker)

# ดู agent ทำงานสด (สร้าง agent ได้จากหน้าเว็บก่อน)
tmux attach -t agent-dev    # (Ctrl-b d เพื่อถอยออก)
```

| Service | URL |
|---------|-----|
| Web | http://localhost:3000 |
| API | http://localhost:8000 |

**E2E tests:** `make test` (หรือ `cd web/e2e && npm install && npx playwright install chromium && npx playwright test` — ต้องมี `.env` เพราะ global-setup login ด้วย ADMIN_PASSWORD)

## 9. Notes for Future AI / Developers

- Backend เป็น **Rust binary** (Axum) — agent รันผ่าน **tmux** บนเครื่อง ไม่มี Docker ในระบบอีกต่อไป (exec seam อยู่ที่ `orchestrator/src/hostexec.rs`)
- **เครื่องเดียว identity เดียว**: agent ใช้ $HOME/tools/gh login จริงของผู้ใช้ — GitHub connector disconnect = logout ทั้งเครื่อง; platform PAT (Settings → Git Access) ใช้ clone เท่านั้น
- การเก็บ API Key และ GitHub Token ต้องทำอย่างปลอดภัย — API key ของ provider ผ่าน `.env` (gitignored); secret ที่ inject ให้ agent ขี่ไฟล์ script 0600 ไม่เคยอยู่ใน command line
- เปลี่ยนโมเดล AI ได้จากหน้า **AI Config** (provider templates: Z.ai GLM / Anthropic / OpenAI / OpenRouter / Groq / DeepSeek / Ollama local / Custom)
- Login: ตั้ง `ADMIN_USER`/`ADMIN_PASSWORD` ใน `.env` → เปิดระบบ login → endpoints ทั้งหมด (exec/AI/lifecycle/terminal) ต้อง login ก่อน; เว้น `ADMIN_PASSWORD` ว่าง = ปิด auth
- 1 project มีได้หลาย subtask — แต่ละ **run = 1 subtask** (runs เก็บต่อ project ทั้งหมด; loop mode ต่อ chain ของเป้าหมายเดียว)

## 10. Browser for AI Agents — ผลสำรวจ

ข้อสรุปสำหรับให้ agent ใช้ browser ภายใน container:

| ตัวเลือก | เหมาะกับ AI ใน container? | เหตุผล |
|---|---|---|
| **Chromium/Chrome headless + CDP** ✅ | ใช่ — มาตรฐานอุตสาหกรรม | เป็น protocol เดียวกับที่ Playwright/Puppeteer/Browser Use ใช้ — AI tooling เข้ากันได้กว้างที่สุด, เปิดหลาย tab/session ได้, ควบคุม network/DOM ละเอียด |
| Playwright (บน CDP) ✅ | ใช่ — ค่าเริ่มต้นสำหรับงานใหม่ | ชั้นที่สูงกว่า CDP ตรง ๆ เขียนเร็วกว่า ใช้กับ agent framework ได้ทันที |
| ego browser | ไม่ใช่สำหรับ container | ออกแบบให้ใช้ profile/login ของ user บนเครื่อง host — เหมาะกับ agent ฝั่ง host ไม่ใช่ sandbox แยก |
| Hosted (Browserbase ฯลฯ) | กรณีพิเศษ | สะดวกแต่มีค่าใช้จ่าย + ข้อมูลออกนอกเครื่อง |

**แนวทางของ platform นี้:** agent-base ติดตั้ง browser จริงไว้แล้ว (Chrome บน amd64 / Chromium บน arm64 — Chrome ไม่มี arm64 Linux build) และมี `gh` CLI ให้เปิด GitHub issue ได้ตามที่ persona ประกาศไว้ใน rules; จะเพิ่ม headless Chromium + CDP endpoint ใน container เมื่อถึงขั้นตอน Vision/Screenshot

---

**Repository:** https://github.com/9zax/ai-agent-platform  
**Last Updated:** 2026-10-23
