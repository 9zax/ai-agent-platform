'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { marked } from 'marked'
import {
  ArrowLeft, Loader2, AlertTriangle, Play, Square, RotateCcw, Clock, Coins, Cpu,
  FileText, MessagesSquare, ChevronRight, ListChecks, Radio, User, Hash, HardDrive,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import PageHeader from '@/components/page-header'
import {
  StepStatusIcon, stepStatusLabel, stepStatusCls, fmtUsd, fmtTok, initials, relTime, MARKDOWN_CLS,
} from '@/components/task-ui'
import { fmtDur, fmtClock, fmtDateTime } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const RUN_STATUS = {
  running: 'running',
  waiting_human: 'busy',
  done: 'green',
  error: 'dead',
  stopped: 'stopped',
}

const MEETING_STATUS = {
  open: { variant: 'blue', label: 'กำลังคุย' },
  answering: { variant: 'busy', label: 'กำลังตอบ' },
  need_human: { variant: 'dead', label: 'รอคนตอบ' },
  resolved: { variant: 'green', label: 'สรุปแล้ว' },
}

export default function SubtaskDetailPage() {
  const { id: projectId, taskId, subtaskId } = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const runParam = searchParams.get('run') || ''
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const query = runParam ? `?run=${encodeURIComponent(runParam)}` : ''
      const res = await authFetch(`${API}/projects/${projectId}/tasks/${taskId}/subtasks/${encodeURIComponent(subtaskId)}${query}`)
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`)
      setData(payload)
    } catch (err) {
      setError(err.message)
      setData(null)
    }
    setLoading(false)
  }, [projectId, taskId, subtaskId, runParam])

  useEffect(() => { setLoading(true); load() }, [load])

  const live = data?.run?.status === 'running' || data?.run?.status === 'waiting_human'
  useEffect(() => {
    if (!live) return
    const timer = setInterval(load, 3500)
    return () => clearInterval(timer)
  }, [load, live])

  const subtask = data?.subtask
  const task = data?.task
  const run = data?.run
  const agent = data?.agent

  async function retry() {
    if (!subtask) return
    setRetrying(true)
    setError('')
    try {
      const res = await authFetch(`${API}/runs/${run.id}/steps/${subtask.role}/${subtask.kind || 'work'}/retry`, { method: 'POST' })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`)
      router.push(`/projects/${projectId}`)
    } catch (err) {
      setError(err.message)
    }
    setRetrying(false)
  }

  async function stopRun() {
    if (!run) return
    setRetrying(true)
    try {
      const res = await authFetch(`${API}/runs/${run.id}/stop`, { method: 'POST' })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload.detail || `HTTP ${res.status}`)
      }
      await load()
    } catch (err) {
      setError(err.message)
    }
    setRetrying(false)
  }

  const models = useMemo(() => Object.values(agent?.model_overrides || {}).filter(Boolean), [agent])
  const runs = data?.runs || []
  const siblings = data?.siblings || []
  const discussions = data?.discussions || []
  const output = subtask?.output || ''
  const retryable = subtask && ['error', 'skipped', 'stopped'].includes(subtask.status)
    && run && !live

  function pickRun(id) {
    const base = `/projects/${projectId}/tasks/${taskId}/subtasks/${encodeURIComponent(subtaskId)}`
    router.push(id ? `${base}?run=${id}` : base)
  }

  if (loading && !data) {
    return (
      <div className="page-body">
        <div className="skeleton h-8 w-64 rounded-lg" />
        <div className="skeleton mt-5 h-56 rounded-xl" />
        <div className="skeleton mt-3 h-40 rounded-xl" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="page-body">
        <Card className="flex flex-col items-center gap-3 border-red-400/20 bg-red-500/[0.05] p-10 text-center" data-testid="subtask-error">
          <AlertTriangle className="h-6 w-6 text-red-300" />
          <div className="text-[13.5px] font-semibold text-white">เปิด subtask ไม่ได้</div>
          <div className="max-w-md text-[12px] text-muted-foreground">{error}</div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => router.push(`/projects/${projectId}/tasks/${taskId}`)}>กลับไป task</Button>
            {runParam && <Button onClick={() => pickRun('')}>ดู run ล่าสุด</Button>}
          </div>
        </Card>
      </div>
    )
  }

  const shortId = `${subtask.role}-${subtask.kind || 'work'}`
  const duration = fmtDur(subtask.started_at, subtask.finished_at)

  return (
    <>
      <PageHeader
        icon={ListChecks}
        title={subtask.title || `${subtask.name} · ${shortId}`}
        subtitle={`${task.id} · ${task.title}`}
        leading={(
          <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground/60" onClick={() => router.push(`/projects/${projectId}/tasks/${taskId}`)} aria-label="Back to task">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        actions={(
          <>
            <Select value={runParam || run?.id || ''} onValueChange={v => pickRun(v === run?.id && !runParam ? '' : v)}>
              <SelectTrigger className="h-8 w-[190px] text-[11.5px]" data-testid="run-select">
                <SelectValue placeholder="เลือก run" />
              </SelectTrigger>
              <SelectContent>
                {runs.map((r, i) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.id} · {r.status}{i === 0 ? ' · latest' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {live ? (
              <Button variant="destructive" onClick={stopRun} disabled={retrying}>
                <Square className="h-4 w-4" /> Stop
              </Button>
            ) : retryable ? (
              <Button variant="outline" onClick={retry} disabled={retrying} data-testid="retry-subtask">
                {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Retry step
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => router.push(`/projects/${projectId}`)}>
              <Radio className="h-4 w-4" /> Mission
            </Button>
          </>
        )}
      />

      <div className="page-body" data-testid="subtask-detail">
        {error && (
          <Card className="mb-3 flex items-center gap-2 border-red-400/20 bg-red-500/[0.06] px-4 py-2.5 text-[12px] text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </Card>
        )}

        <div className="mb-3.5 flex flex-wrap items-center gap-2">
          <span className={`flex h-8 w-8 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03]`}>
            <StepStatusIcon status={subtask.status} className="h-4 w-4" />
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="gray" className="font-mono text-[9.5px]">{shortId}</Badge>
            <span className={`text-[12px] font-semibold ${stepStatusCls(subtask.status)}`}>{stepStatusLabel(subtask.status)}</span>
            {subtask.rev > 1 && <Badge variant="yellow" className="text-[9px]">rev {subtask.rev}</Badge>}
            {subtask.kind && subtask.kind !== 'work' && <Badge variant="purple" className="text-[9px]">{subtask.kind}</Badge>}
            {run && (
              <Badge variant={RUN_STATUS[run.status] || 'gray'} className="text-[9px]">
                run {run.id.replace('run-', '#')} · {run.status}
              </Badge>
            )}
            {duration && <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground/45"><Clock className="h-3 w-3" />{duration}</span>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-[10.5px]"
            onClick={() => router.push(`/projects/${projectId}/tasks/${taskId}`)}
          >
            กลับไป task <ChevronRight className="h-3 w-3" />
          </Button>
        </div>

        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1fr)_308px]">
          <div className="min-w-0 space-y-3.5">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-white/85">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground/50" /> Deliverable
                </div>
                <div className="flex items-center gap-2 text-[9.5px] text-muted-foreground/35">
                  {subtask.output_len ? <span>{fmtTok(subtask.output_len)} chars</span> : null}
                  {subtask.deliverable && <span className="font-mono">{subtask.deliverable}</span>}
                </div>
              </div>
              <div className="px-4 py-4">
                {subtask.status === 'working' ? (
                  <div className="flex items-center gap-2 py-8 text-[12px] text-blue-300">
                    <Loader2 className="h-4 w-4 animate-spin" /> {subtask.name} กำลังทำงาน…
                  </div>
                ) : subtask.status === 'pending' ? (
                  <div className="py-8 text-center text-[12px] text-muted-foreground/45">ยังไม่ถึงคิวของบทบาทนี้</div>
                ) : output ? (
                  <div
                    className={`${MARKDOWN_CLS} text-foreground/85`}
                    data-testid="subtask-output"
                    dangerouslySetInnerHTML={{ __html: marked.parse(output) }}
                  />
                ) : (
                  <div className="py-8 text-center text-[12px] text-muted-foreground/45">ไม่มีเนื้อหาที่ส่งกลับมา</div>
                )}
              </div>
            </Card>

            {discussions.length > 0 && (
              <Card className="overflow-hidden" data-testid="subtask-meetings">
                <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3 text-[12px] font-semibold text-white/85">
                  <MessagesSquare className="h-3.5 w-3.5 text-muted-foreground/50" /> Meetings ที่เกี่ยวกับบทบาทนี้
                  <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9.5px] text-muted-foreground/60">{discussions.length}</span>
                </div>
                <div className="divide-y divide-white/[0.045]">
                  {discussions.map(d => {
                    const meta = MEETING_STATUS[d.status] || MEETING_STATUS.open
                    const last = d.messages?.[d.messages.length - 1]
                    return (
                      <div key={d.id} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[9.5px] text-muted-foreground/40">{d.id}</span>
                          <Badge variant={meta.variant} className="text-[8.5px]">{meta.label}</Badge>
                          {d.kind === 'demo' && <Badge variant="purple" className="text-[8.5px]">demo</Badge>}
                          <span className="text-[10px] text-muted-foreground/45">{d.from} → {d.to.join(', ')}</span>
                          <span className="ml-auto text-[9.5px] text-muted-foreground/30">round {d.round}</span>
                        </div>
                        <div className="mt-1 text-[11.5px] font-medium text-white/80">{d.topic}</div>
                        {last && (
                          <div className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground/50">
                            <span className="font-semibold text-muted-foreground/65">{last.from}: </span>{last.text}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Card>
            )}
          </div>

          <div className="space-y-3.5">
            {agent && (
              <Card className="p-4" data-testid="subtask-agent">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/25 to-primary/10 text-[11px] font-bold text-primary ring-1 ring-inset ring-primary/20">
                    {initials(agent.name)}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px] font-semibold text-white">{agent.name}</div>
                    <div className="truncate text-[10.5px] text-primary/80">{agent.title}</div>
                  </div>
                </div>
                <div className="space-y-1.5 text-[10px]">
                  <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Role</span><span className="font-mono text-foreground/70">{agent.role}</span></div>
                  {agent.years && <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Experience</span><span className="text-foreground/70">{agent.years}y</span></div>}
                  <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Harness</span><span className="text-foreground/70">{subtask.harness || agent.harness || 'native'}</span></div>
                  {agent.reports_to && <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Reports to</span><span className="font-mono text-foreground/70">{agent.reports_to}</span></div>}
                  {models.length > 0 && (
                    <div className="pt-1">
                      <div className="mb-1 text-muted-foreground/45">Model</div>
                      <div className="flex flex-wrap gap-1">
                        {models.map(m => <span key={m} className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-blue-300/75">{m}</span>)}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}

            <Card className="p-4">
              <div className="mb-2.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-white/80">
                <Hash className="h-3.5 w-3.5 text-muted-foreground/45" /> Step facts
              </div>
              <div className="space-y-1.5 text-[10px]">
                <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Started</span><span className="text-foreground/70">{subtask.started_at ? fmtClock(subtask.started_at) : '—'}</span></div>
                <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Finished</span><span className="text-foreground/70">{subtask.finished_at ? fmtClock(subtask.finished_at) : '—'}</span></div>
                <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Duration</span><span className="text-foreground/70">{duration || '—'}</span></div>
                <div className="flex items-center justify-between"><span className="flex items-center gap-1 text-muted-foreground/45"><Coins className="h-3 w-3" /> Cost</span><span className="text-foreground/70">{subtask.metered === false ? 'unmetered' : fmtUsd(subtask.cost_usd)}</span></div>
                <div className="flex items-center justify-between"><span className="flex items-center gap-1 text-muted-foreground/45"><Cpu className="h-3 w-3" /> Tokens</span><span className="text-foreground/70">{fmtTok(subtask.input_tokens)} in · {fmtTok(subtask.output_tokens)} out</span></div>
                {subtask.model && <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Ran with</span><span className="font-mono text-[9px] text-blue-300/80">{subtask.model}</span></div>}
                {subtask.container && <div className="flex items-center justify-between"><span className="flex items-center gap-1 text-muted-foreground/45"><HardDrive className="h-3 w-3" /> Container</span><span className="truncate font-mono text-[9px] text-foreground/70">{subtask.container}</span></div>}
                <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Run</span><span className="font-mono text-foreground/70">{run?.id}</span></div>
                <div className="flex items-center justify-between"><span className="text-muted-foreground/45">Created</span><span className="text-foreground/70">{fmtDateTime(run?.created_at)}</span></div>
              </div>
            </Card>

            <Card className="overflow-hidden" data-testid="subtask-siblings">
              <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5 text-[11.5px] font-semibold text-white/80">
                <ListChecks className="h-3.5 w-3.5 text-muted-foreground/45" /> Subtasks ใน run นี้
                <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9px] text-muted-foreground/55">{siblings.length}</span>
              </div>
              <div className="divide-y divide-white/[0.045]">
                {siblings.map(s => {
                  const id = `${s.role}-${s.kind || 'work'}`
                  const active = id === shortId
                  const href = `/projects/${projectId}/tasks/${taskId}/subtasks/${encodeURIComponent(id)}${runParam ? `?run=${runParam}` : ''}`
                  return (
                    <Link
                      key={id}
                      href={href}
                      className={`flex items-center gap-2 px-4 py-2 transition-colors ${active ? 'bg-primary/[0.07]' : 'hover:bg-white/[0.025]'}`}
                      data-testid={`sibling-${id}`}
                    >
                      <StepStatusIcon status={s.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[10.5px] font-medium text-white/80">{s.name}</div>
                        <div className="truncate font-mono text-[8.5px] text-muted-foreground/35">{id}</div>
                      </div>
                      {active ? <Badge variant="blue" className="text-[8px]">กำลังดู</Badge> : <ChevronRight className="h-3 w-3 text-muted-foreground/30" />}
                    </Link>
                  )
                })}
              </div>
            </Card>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-1.5 text-[10.5px] text-muted-foreground/30">
          <User className="h-3 w-3" />
          ผลงานนี้เป็น output จริงของ {subtask.name} ใน run {run?.id} · เลือก run อื่นด้านบนเพื่อดูย้อนหลัง
        </div>
      </div>
    </>
  )
}
