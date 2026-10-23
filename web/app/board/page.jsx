'use client'

import { authFetch } from '@/lib/auth'
import { cn, fmtDateTime } from '@/lib/utils'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  Search, Clock, Loader2, CheckCircle2, XCircle, PauseCircle, MessagesSquare, User,
  MessageCircle, Rocket, Network, RefreshCw, Waypoints,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import PageHeader from '@/components/page-header'

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
  working: 'bg-blue-500/10 text-blue-300 ring-blue-400/20',
  done: 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20',
  error: 'bg-red-500/10 text-red-300 ring-red-400/20',
}

// One agent chip — step status color + rev badge + live container dot
function AgentChip({ step, role, roleInfo }) {
  const running = roleInfo && roleInfo.container && roleInfo.container.status === 'running'
  return (
    <span
      data-testid="board-agent-chip"
      data-status={step ? step.status : 'idle'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-white/[0.03] px-2 py-1 text-[11px] font-medium ring-1 ring-inset ring-white/[0.05]',
        STEP_TINT[step ? step.status : ''] || 'text-muted-foreground/75',
      )}
    >
      <StepIcon status={step ? step.status : 'idle'} />
      {(step && step.name) || (roleInfo && roleInfo.name) || role}
      {step && step.rev >= 2 && <span className="text-[9.5px] text-rose-300/90">↩ {step.rev}</span>}
      {running && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" title="container running" />}
    </span>
  )
}

// Per-project card: latest run state + per-agent chips + human callouts
function ProjectCard({ group, roleInfo }) {
  const { project, runs, latest } = group
  const needHuman = latest ? (latest.discussions || []).filter(d => d.status === 'need_human') : []
  const openCount = latest ? (latest.discussions || []).filter(d => d.status !== 'resolved').length : 0
  const doneCount = latest ? latest.steps.filter(s => s.status === 'done' || s.status === 'error').length : 0
  const live = latest && (latest.status === 'running' || latest.status === 'waiting_human')
  const line = latest?.status === 'waiting_human' ? 'via-rose-400/70'
    : latest?.status === 'running' ? 'via-primary/70'
    : 'via-white/10'

  return (
    <Card className="group relative flex flex-col overflow-hidden transition-all duration-200 hover:border-white/[0.1] hover:shadow-lift" data-testid="board-project-card">
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent', line)} />

      <div className="flex items-start justify-between gap-3 p-5 pb-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.03] text-[10.5px] font-semibold text-muted-foreground/80">
            {initials(project.name)}
          </div>
          <div className="min-w-0">
            <Link href={`/projects/${project.id}`} className="block truncate text-[15px] font-semibold tracking-[-0.015em] text-white transition-colors hover:text-primary">
              {project.name}
            </Link>
            {project.description && (
              <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground/60">{project.description}</div>
            )}
          </div>
        </div>
        {latest && <RunStatusBadge run={latest} />}
      </div>

      <div className="flex flex-1 flex-col px-5">
        {latest ? (
          <div className="flex flex-col gap-3" data-testid="board-latest-run">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/60">
              {latest.loop_mode && (
                <Badge variant="purple" className="text-[9.5px]">Loop รอบที่ {latest.iteration}</Badge>
              )}
              <span>{fmtDateTime(latest.created_at)}</span>
              <span className="text-muted-foreground/25">·</span>
              <span className="font-semibold text-foreground/75">{doneCount}/{latest.steps.length} ส่งงานแล้ว</span>
              {live && (
                <span className="ml-auto flex items-center gap-1.5 text-primary/80">
                  <span className="relative flex h-1.5 w-1.5"><span className="ping-soft absolute inset-0 rounded-full bg-primary/70" /><span className="h-1.5 w-1.5 rounded-full bg-primary" /></span>
                  live
                </span>
              )}
            </div>
            <div className="rounded-lg border border-white/[0.05] bg-black/15 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground/85">
              <span className="mr-1 text-muted-foreground/35">“</span>{latest.task}<span className="ml-1 text-muted-foreground/35">”</span>
            </div>

            <div className="flex flex-wrap gap-1.5" data-testid="board-agent-chips">
              {latest.steps.map(step => (
                <AgentChip key={`${step.role}-${step.kind || 'work'}`} step={step} role={step.role} roleInfo={roleInfo.get(step.role)} />
              ))}
            </div>

            {needHuman.map(d => (
              <div
                key={d.id}
                data-testid="board-need-human"
                className="rounded-xl border border-rose-400/25 bg-rose-500/[0.06] p-3"
              >
                <div className="flex items-center gap-2 text-[11.5px] font-semibold text-rose-200">
                  <MessageCircle className="h-3.5 w-3.5 shrink-0" /> รอคุณตอบ: {d.topic}
                </div>
                <Button asChild variant="outline" size="sm" className="mt-2 h-7 border-rose-500/30 text-[11.5px] text-rose-300 hover:bg-rose-500/10 hover:text-rose-200">
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
            <div className="text-[12px] text-muted-foreground/60">ยังไม่มี run — สั่งงานทีมได้ใน Mission Control</div>
            <div className="flex flex-wrap gap-1.5" data-testid="board-agent-chips">
              {(project.agents || []).map(role => (
                <AgentChip key={role} step={null} role={role} roleInfo={roleInfo.get(role)} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-white/[0.05] px-5 py-3">
        <span className="text-[11px] text-muted-foreground/55" data-testid="board-run-count">{runs.length} runs</span>
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[11.5px] text-primary/80 hover:bg-primary/10 hover:text-primary" data-testid="board-mission-control">
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
      <PageHeader
        icon={Waypoints}
        title="AI Orchestrator Board"
        subtitle="สถานะ orchestrator ของทุก project — run ล่าสุด งานของแต่ละ agent และ meeting ที่รอคุณตอบ"
        actions={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                className="w-[210px] pl-8"
                placeholder="Search projects..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                data-testid="board-search"
              />
            </div>
            <Avatar><AvatarFallback>AD</AvatarFallback></Avatar>
          </>
        }
      />

      <div className="page-body">
        {!reachable && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-red-400/20 bg-red-500/[0.06] px-4 py-3 text-[12.5px] text-red-300" data-testid="board-unreachable">
            <span>Orchestrator API unreachable at {API} — is the stack running?</span>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 border-red-500/30 text-[11.5px] text-red-300 hover:bg-red-500/10" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        )}

        {projects === null ? (
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
            {[0, 1].map(i => (
              <Card key={i} className="h-[230px] p-5">
                <div className="skeleton h-4 w-1/2" />
                <div className="skeleton mt-3 h-3 w-3/4" />
                <div className="skeleton mt-5 h-12 w-full" />
                <div className="skeleton mt-4 h-5 w-2/3" />
              </Card>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <Card className="mx-auto flex max-w-md flex-col items-center gap-4 border-dashed bg-card/40 p-10 text-center" data-testid="board-empty-projects">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <Network className="h-5 w-5 text-muted-foreground/50" />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-white">ยังไม่มี project</div>
              <div className="mt-1 text-[12.5px] text-muted-foreground">สร้าง project แล้วประกอบทีม AI เพื่อเริ่มสั่งงาน</div>
            </div>
            <Button asChild size="sm" className="gap-1.5">
              <Link href="/projects"><Rocket className="h-3.5 w-3.5" /> สร้าง project</Link>
            </Button>
          </Card>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11.5px]" data-testid="board-summary">
              <span className="rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-muted-foreground/70">{groups.length} projects</span>
              <span className="flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/[0.07] px-2.5 py-1 font-medium text-primary/90">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {activeCount} กำลังทำงาน
              </span>
              <span className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium',
                waitingCount ? 'border-rose-400/20 bg-rose-500/[0.07] text-rose-300' : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground/60')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', waitingCount ? 'bg-rose-400' : 'bg-muted-foreground/40')} /> {waitingCount} รอคุณตอบ
              </span>
            </div>
            <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(360px,1fr))]">
              {filtered.map(g => <ProjectCard key={g.project.id} group={g} roleInfo={roleInfo} />)}
            </div>
            {filtered.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <Search className="h-6 w-6 text-muted-foreground/30" />
                <div className="text-[13px] text-muted-foreground/70">ไม่พบ project ตรง “{query}”</div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
