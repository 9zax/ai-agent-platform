'use client'

import { authFetch } from '@/lib/auth'
import { cn, fmtDateTime } from '@/lib/utils'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  Search, Clock, Loader2, CheckCircle2, XCircle, PauseCircle, MessagesSquare, User,
  MessageCircle, Rocket, Network, RefreshCw,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

function initialsOf(role, step, roleInfo) {
  return initials((step && step.name) || (roleInfo && roleInfo.name) || role)
}

// Run status → Badge, mirrors the Mission Control pill (projects/[id]/page.jsx)
function RunStatusBadge({ run }) {
  const variant = run.status === 'error' || run.status === 'stopped' || run.status === 'waiting_human'
    ? 'dead'
    : run.status === 'running' ? (run.phase === 'meeting' ? 'purple' : 'created') : 'running'
  return (
    <Badge variant={variant} className="gap-1.5" data-testid="board-run-status">
      {run.status === 'running'
        ? (run.phase === 'meeting'
            ? <><MessagesSquare className="h-3 w-3" /> team meeting — รอบที่ {run.round}</>
            : 'team working')
        : run.status === 'waiting_human'
          ? <><User className="h-3 w-3" /> รอคุณตอบ</>
          : run.status}
    </Badge>
  )
}

function StepIcon({ status }) {
  if (status === 'working') return <Loader2 className="h-3 w-3 animate-spin text-blue-300" />
  if (status === 'done') return <CheckCircle2 className="h-3 w-3 text-emerald-300" />
  if (status === 'error') return <XCircle className="h-3 w-3 text-red-300" />
  if (status === 'skipped') return <PauseCircle className="h-3 w-3 text-muted-foreground/60" />
  return <Clock className="h-3 w-3 text-muted-foreground/50" />
}

const STEP_TINT = {
  working: 'bg-blue-500/10 text-blue-300 border-blue-500/25',
  done: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  error: 'bg-red-500/10 text-red-300 border-red-500/25',
}

// One agent chip — step status color + rev badge + live container dot
function AgentChip({ step, role, roleInfo }) {
  const running = roleInfo && roleInfo.container && roleInfo.container.status === 'running'
  return (
    <span
      data-testid="board-agent-chip"
      data-status={step ? step.status : 'idle'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border bg-secondary px-2 py-1 text-[11px] font-medium',
        STEP_TINT[step ? step.status : ''] || 'border-transparent text-muted-foreground/80',
      )}
    >
      <StepIcon status={step ? step.status : 'idle'} />
      {(step && step.name) || (roleInfo && roleInfo.name) || role}
      {step && step.rev >= 2 && <span className="text-[9.5px] text-rose-300/90">↩ {step.rev}</span>}
      {running && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="container running" />}
    </span>
  )
}

// Per-project card: latest run state + per-agent chips + human callouts
function ProjectCard({ group, roleInfo }) {
  const { project, runs, latest } = group
  const needHuman = latest ? (latest.discussions || []).filter(d => d.status === 'need_human') : []
  const openCount = latest ? (latest.discussions || []).filter(d => d.status !== 'resolved').length : 0
  const doneCount = latest ? latest.steps.filter(s => s.status === 'done' || s.status === 'error').length : 0

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="board-project-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/projects/${project.id}`} className="truncate text-[15px] font-bold hover:underline">
            {project.name}
          </Link>
          {project.description && (
            <div className="mt-0.5 truncate text-[12px] text-muted-foreground/70">{project.description}</div>
          )}
        </div>
        {latest && <RunStatusBadge run={latest} />}
      </div>

      {latest ? (
        <div className="flex flex-col gap-2.5" data-testid="board-latest-run">
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground/70">
            {latest.loop_mode && (
              <Badge variant="purple" className="text-[9.5px]">Loop รอบที่ {latest.iteration}</Badge>
            )}
            <span>{fmtDateTime(latest.created_at)}</span>
            <span className="font-medium text-foreground/80">{doneCount}/{latest.steps.length} ส่งงานแล้ว</span>
          </div>
          <div className="truncate text-[12.5px] italic text-muted-foreground/80">“{latest.task}”</div>

          <div className="flex flex-wrap gap-1.5" data-testid="board-agent-chips">
            {latest.steps.map(step => (
              <AgentChip key={step.role} step={step} role={step.role} roleInfo={roleInfo.get(step.role)} />
            ))}
          </div>

          {needHuman.map(d => (
            <div
              key={d.id}
              data-testid="board-need-human"
              className="rounded-xl border border-rose-400/60 bg-rose-500/5 p-3 shadow-[0_0_20px_rgba(251,113,133,.18)]"
            >
              <div className="flex items-center gap-2 text-[12px] font-semibold text-rose-300">
                <MessageCircle className="h-3.5 w-3.5 shrink-0" /> รอคุณตอบ: {d.topic}
              </div>
              <Button asChild variant="outline" size="sm" className="mt-2 h-7 border-rose-500/40 text-[11.5px] text-rose-400 hover:bg-rose-500/10 hover:text-rose-300">
                <Link href={`/projects/${project.id}`}>ไปตอบใน Mission Control</Link>
              </Button>
            </div>
          ))}

          {openCount > needHuman.length && (
            <div className="flex items-center gap-1.5 text-[11.5px] text-amber-300/90">
              <MessagesSquare className="h-3.5 w-3.5 shrink-0" /> คำถามค้าง {openCount}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5" data-testid="board-empty-runs">
          <div className="text-[12px] text-muted-foreground/70">ยังไม่มี run — สั่งงานทีมได้ใน Mission Control</div>
          <div className="flex flex-wrap gap-1.5" data-testid="board-agent-chips">
            {(project.agents || []).map(role => (
              <AgentChip key={role} step={null} role={role} roleInfo={roleInfo.get(role)} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-dashed border-border pt-3">
        <span className="text-[11.5px] text-muted-foreground/70" data-testid="board-run-count">{runs.length} runs</span>
        <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 text-[11.5px]" data-testid="board-mission-control">
          <Link href={`/projects/${project.id}`}><Rocket className="h-3.5 w-3.5" /> Mission Control</Link>
        </Button>
      </div>
    </Card>
  )
}

// Attention-first: รอคุณตอบ → กำลังทำงาน → run ล่าสุดใหม่สุด → ยังไม่เคย run
const RANK = { waiting_human: 0, running: 1 }

export default function Board() {
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState(null) // null = still loading
  const [runs, setRuns] = useState([])
  const [agents, setAgents] = useState([])
  const [reachable, setReachable] = useState(true)

  async function load() {
    const safe = p => p.then(r => r.json()).catch(() => null)
    const [p, r, a] = await Promise.all([
      safe(authFetch(`${API}/projects`)),
      safe(authFetch(`${API}/runs`)),
      safe(authFetch(`${API}/agents`)),
    ])
    setReachable(p !== null)
    setProjects(Array.isArray(p) ? p : [])
    setRuns(Array.isArray(r) ? r : [])
    setAgents(Array.isArray(a) ? a : [])
  }

  const hasActive = runs.some(run => run.status === 'running' || run.status === 'waiting_human')

  useEffect(() => {
    load()
    const t = setInterval(load, hasActive ? 2000 : 5000)
    return () => clearInterval(t)
  }, [hasActive])

  const roleInfo = useMemo(() => {
    const map = new Map()
    for (const a of agents) map.set(a.role, a)
    return map
  }, [agents])

  const groups = useMemo(() => {
    const map = new Map()
    for (const p of projects || []) map.set(p.id, { project: p, runs: [], latest: null })
    for (const r of runs) {
      const g = map.get(r.project_id)
      if (!g) continue // orphan run — project deleted, skip defensively
      g.runs.push(r)
      if (!g.latest || r.created_at > g.latest.created_at) g.latest = r
    }
    return [...map.values()].sort((a, b) => {
      const ra = a.latest ? (RANK[a.latest.status] ?? 2) : 3
      const rb = b.latest ? (RANK[b.latest.status] ?? 2) : 3
      if (ra !== rb) return ra - rb
      if (a.latest && b.latest) return b.latest.created_at - a.latest.created_at
      return a.project.id.localeCompare(b.project.id)
    })
  }, [projects, runs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups.filter(g =>
      g.project.name.toLowerCase().includes(q)
      || (g.project.description || '').toLowerCase().includes(q)
      || (g.latest && g.latest.task.toLowerCase().includes(q)),
    )
  }, [groups, query])

  const activeCount = runs.filter(r => r.status === 'running').length
  const waitingCount = runs.filter(r => r.status === 'waiting_human').length

  return (
    <>
      <div className="flex items-center justify-between px-7 pb-1 pt-5">
        <div>
          <h1 className="text-[21px] font-bold tracking-tight">AI Orchestrator Board</h1>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">
            สถานะ orchestrator ของทุก project — run ล่าสุด งานของแต่ละ agent และ meeting ที่รอคุณตอบ
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground/60" />
            <Input
              className="w-[200px] pl-8"
              placeholder="Search projects..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              data-testid="board-search"
            />
          </div>
          <Avatar><AvatarFallback>AD</AvatarFallback></Avatar>
        </div>
      </div>

      <div className="px-7 py-5">
        {!reachable && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md bg-red-500/15 px-3.5 py-2.5 text-[12.5px] text-red-400" data-testid="board-unreachable">
            <span>Orchestrator API unreachable at {API} — is the stack running?</span>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 border-red-500/40 text-[11.5px] text-red-400 hover:bg-red-500/10" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        )}

        {projects === null ? (
          <div className="py-16 text-center text-[13px] text-muted-foreground/70">Loading…</div>
        ) : groups.length === 0 ? (
          <Card className="mx-auto flex max-w-md flex-col items-center gap-3 p-8 text-center" data-testid="board-empty-projects">
            <Network className="h-8 w-8 text-muted-foreground/40" />
            <div className="text-[14px] font-semibold">ยังไม่มี project</div>
            <div className="text-[12px] text-muted-foreground/70">สร้าง project แล้วประกอบทีม AI เพื่อเริ่มสั่งงาน</div>
            <Button asChild size="sm" className="gap-1.5">
              <Link href="/projects"><Rocket className="h-3.5 w-3.5" /> สร้าง project</Link>
            </Button>
          </Card>
        ) : (
          <>
            <div className="mb-3 text-[12px] text-muted-foreground/70" data-testid="board-summary">
              {groups.length} projects · {activeCount} กำลังทำงาน · {waitingCount} รอคุณตอบ
            </div>
            <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
              {filtered.map(g => <ProjectCard key={g.project.id} group={g} roleInfo={roleInfo} />)}
            </div>
            {filtered.length === 0 && (
              <div className="py-12 text-center text-[13px] text-muted-foreground/70">ไม่พบ project ตรง “{query}”</div>
            )}
          </>
        )}
      </div>
    </>
  )
}
