# AI Agent Platform

ระบบจัดการ AI Agents หลายตัวที่ทำงานใน Docker Containers พร้อม noVNC และ Orchestrator

## สถาปัตยกรรม

- **Orchestrator** (FastAPI) — จัดการ Containers, Tasks, API
- **Web** (Next.js) — Dashboard
- **Agent Base** — Ubuntu + XFCE + noVNC + Chrome/Terminal

## วิธีรัน

```bash
cd ai-agent-platform
docker compose up --build
```
