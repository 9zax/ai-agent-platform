'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { marked } from 'marked'
import {
  ArrowLeft, ListTodo, Play, Square, Loader2, Check, AlertTriangle, History,
  ListChecks, Pencil, Trash2, ChevronRight, Radio, RotateCcw, FileText, Users,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import PageHeader from '@/components/page-header'
import {
  TASK_STATUS, TASK_STATUS_OPTIONS, PriorityBadge, PRIORITY_OPTIONS, StepStatusIcon,
  stepStatusLabel, stepStatusCls, fmtUsd, fmtTok, relTime, MARKDOWN_CLS,
} from '@/components/task-ui'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const RUN_STATUS = {
  running: { variant: 'running', label: 'กำลังทำ' },
  waiting_human: { variant: 'busy', label: 'รอคุณตอบ' },
  done: { variant: 'green', label: 'เสร็จแล้ว' },
  error: { variant: 'dead', label: 'พลาด' },
  stopped: { variant: 'stopped', label: 'หยุด' },
}

function stepId(step) {
  return `${step.role}-${step.kind || 'work'}`
}

function stepPreview(step) {
  if (step.preview) return step.preview
  return (step.output || '').replace(/[#*`>_|-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
}

function RunStatusBadge({ run }) {
  if (!run) return <Badge variant="gray">ยังไม่สั่งงาน</Badge>
  const meta = RUN_STATUS[run.status] || RUN_STATUS.running
  const failed = run.acceptance?.verdict === 'fail'
  return (
    <Badge variant={failed && run.status === 'done' ? 'yellow' : meta.variant} className="gap-1">
      {run.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
      {failed && run.status === 'done' ? 'เสร็จแต่ไม่ผ่าน' : meta.label}
    </Badge>
  )
}

export default function TaskDetailPage() {
  const { id: projectId, taskId } = useParams()
  const router = useRouter()
  const [task, setTask] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [loop, setLoop] = useState(false)
  const [selectedRun, setSelectedRun] = useState('')
  const [viewRun, setViewRun] = useState(null)
  const [runLoading, setRunLoading] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [assignee, setAssignee] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/projects/${projectId}/tasks/${taskId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setTask(data)
      setAssignee(prev => (prev === '' ? (data.assignee || '') : prev))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [projectId, taskId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const timer = setInterval(load, task?.active ? 4000 : 15000)
    return () => clearInterval(timer)
  }, [load, task?.active])

  const latestId = task?.latest_run?.id || ''

  useEffect(() => {
    if (!selectedRun || selectedRun === latestId) { setViewRun(null); return }
    let alive = true
    setRunLoading(true)
    authFetch(`${API}/runs/${selectedRun}`)
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
        if (alive) setViewRun(data)
      })
      .catch(err => { if (alive) setError(err.message) })
      .finally(() => { if (alive) setRunLoading(false) })
    return () => { alive = false }
  }, [selectedRun, latestId])

  async function update(patch) {
    setSaving(true)
    setError('')
    try {
      const res = await authFetch(`${API}/projects/${projectId}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setTask(prev => ({ ...prev, ...data, runs: prev.runs }))
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  async function dispatch() {
    setDispatching(true)
    setError('')
    try {
      const res = await authFetch(`${API}/projects/${projectId}/tasks/${taskId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loop }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setSelectedRun('')
      setTask(prev => ({ ...prev, ...data.task, runs: prev.runs }))
      await load()
    } catch (err) {
      setError(err.message)
    }
    setDispatching(false)
  }

  async function stopRun() {
    if (!task?.latest_run) return
    setSaving(true)
    try {
      const res = await authFetch(`${API}/runs/${task.latest_run.id}/stop`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      await load()
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  async function remove() {
    if (!window.confirm(`ลบ ${task.id}? runs ที่เคยรันจะยังอยู่เป็นประวัติ`)) return
    try {
      const res = await authFetch(`${API}/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      router.push(`/projects/${projectId}/tasks`)
    } catch (err) {
      setError(err.message)
    }
  }

  const showingHistorical = Boolean(selectedRun && selectedRun !== latestId)
  const subtasks = useMemo(() => {
    if (showingHistorical) return (viewRun?.steps || []).map(s => ({ ...s, id: stepId(s) }))
    return task?.subtasks || []
  }, [showingHistorical, viewRun, task?.subtasks])
  const counts = task?.subtask_counts || { total: 0, done: 0, working: 0 }
  const progress = counts.total ? Math.round((counts.done / counts.total) * 100) : 0

  if (!task && !error) {
    return (
      <div className="page-body">
        <div className="skeleton h-8 w-52 rounded-lg" />
        <div className="skeleton mt-5 h-40 rounded-xl" />
        <div className="skeleton mt-3 h-64 rounded-xl" />
      </div>
    )
  }

  if (!task) {
    return (
      <div className="page-body">
        <Card className="flex flex-col items-center gap-3 border-red-400/20 bg-red-500/[0.05] p-10 text-center">
          <AlertTriangle className="h-6 w-6 text-red-300" />
          <div className="text-[13.5px] font-semibold text-white">เปิด task ไม่ได้</div>
          <div className="text-[12px] text-muted-foreground">{error}</div>
          <Button variant="ghost" onClick={() => router.push(`/projects/${projectId}/tasks`)}>กลับไป task board</Button>
        </Card>
      </div>
    )
  }

  const latest = task.latest_run
  const taskMeta = TASK_STATUS[task.status] || TASK_STATUS.todo
  const active = task.active

  return (
    <>
      <PageHeader
        icon={ListTodo}
        title={task.title}
        subtitle={`${task.id} · ${taskMeta.label} · ${counts.total} subtasks`}
        leading={(
          <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground/60" onClick={() => router.push(`/projects/${projectId}/tasks`)} aria-label="Back to task board">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        actions={(
          <>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} className="h-3 w-3 accent-[hsl(var(--primary))]" />
              loop
            </label>
            {active ? (
              <Button variant="destructive" onClick={stopRun} disabled={saving}>
                <Square className="h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button onClick={dispatch} disabled={dispatching} data-testid="dispatch-task">
                {dispatching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {latest ? 'สั่งทีมอีกครั้ง' : 'สั่งทีม'}
              </Button>
            )}
            {latest && (
              <Button variant="ghost" onClick={() => router.push(`/projects/${projectId}`)}>
                <Radio className="h-4 w-4" /> Mission
              </Button>
            )}
          </>
        )}
      />

      <div className="page-body" data-testid="task-detail">
        {error && (
          <Card className="mb-3 flex items-center gap-2 border-red-400/20 bg-red-500/[0.06] px-4 py-2.5 text-[12px] text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </Card>
        )}

        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1fr)_318px]">
          <div className="min-w-0 space-y-3.5">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-white/85">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground/50" /> Description
                </div>
                {editingDesc ? (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => { setEditingDesc(false); setDescDraft(task.description || '') }}>Cancel</Button>
                    <Button size="sm" disabled={saving} onClick={async () => { await update({ description: descDraft }); setEditingDesc(false) }}>
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Save
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => { setDescDraft(task.description || ''); setEditingDesc(true) }}>
                    <Pencil className="h-3 w-3" /> แก้ไข
                  </Button>
                )}
              </div>
              <div className="px-4 py-3.5">
                {editingDesc ? (
                  <Textarea
                    autoFocus
                    value={descDraft}
                    onChange={e => setDescDraft(e.target.value)}
                    className="min-h-[130px] resize-y text-[12.5px]"
                    placeholder="รายละเอียดงาน เกณฑ์รับงาน และ context"
                  />
                ) : task.description ? (
                  <div className={`${MARKDOWN_CLS} text-foreground/85`} dangerouslySetInnerHTML={{ __html: marked.parse(task.description) }} />
                ) : (
                  <div className="text-[12px] text-muted-foreground/45">ยังไม่มีรายละเอียด — เพิ่ม context ให้ทีมก่อนสั่งงาน</div>
                )}
              </div>
            </Card>

            <Card className="overflow-hidden" data-testid="subtask-list">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-white/85">
                  <ListChecks className="h-3.5 w-3.5 text-muted-foreground/50" /> Subtasks
                  <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9.5px] text-muted-foreground/60">{subtasks.length}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
                  {showingHistorical && <Badge variant="purple">ประวัติ · {selectedRun}</Badge>}
                  {counts.working > 0 && (
                    <span className="flex items-center gap-1 text-blue-300">
                      <Loader2 className="h-3 w-3 animate-spin" /> {counts.working} กำลังทำ
                    </span>
                  )}
                  <span>{counts.done}/{counts.total} เสร็จ</span>
                </div>
              </div>

              {counts.total > 0 && (
                <div className="h-1 bg-white/[0.04]">
                  <div className="h-full bg-emerald-400/70 transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              )}

              <div className="divide-y divide-white/[0.045]">
                {runLoading && <div className="px-4 py-6 text-center text-[11.5px] text-muted-foreground/50"><Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />กำลังโหลด run…</div>}
                {!runLoading && subtasks.length === 0 && (
                  <div className="px-4 py-10 text-center">
                    <div className="text-[12px] text-muted-foreground/55">ยังไม่มี subtask — สั่งทีมเพื่อให้แต่ละบทบาทรับงาน</div>
                    <Button className="mt-3" size="sm" onClick={dispatch} disabled={dispatching}>
                      <Play className="h-3.5 w-3.5" /> สั่งทีม
                    </Button>
                  </div>
                )}
                {!runLoading && subtasks.map(s => {
                  const id = s.id || stepId(s)
                  const href = `/projects/${projectId}/tasks/${taskId}/subtasks/${encodeURIComponent(id)}${showingHistorical ? `?run=${selectedRun}` : ''}`
                  return (
                    <Link
                      key={id}
                      href={href}
                      className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.025]"
                      data-testid={`subtask-row-${id}`}
                    >
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03]">
                        <StepStatusIcon status={s.status} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12px] font-semibold text-white/90">{s.name}</span>
                          <Badge variant="gray" className="font-mono text-[8.5px]">{s.role}</Badge>
                          {s.kind && s.kind !== 'work' && <Badge variant="purple" className="text-[8.5px]">{s.kind}</Badge>}
                          {s.rev > 1 && <Badge variant="yellow" className="text-[8.5px]">rev {s.rev}</Badge>}
                          <span className={`text-[10px] font-medium ${stepStatusCls(s.status)}`}>{stepStatusLabel(s.status)}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground/45">{s.title}</div>
                        {stepPreview(s) && <div className="mt-1 line-clamp-1 text-[10.5px] text-muted-foreground/35">{stepPreview(s)}</div>}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1 text-[9.5px] text-muted-foreground/35">
                        <span>{fmtUsd(s.cost_usd)}</span>
                        <span className="flex items-center gap-0.5 text-primary/60 opacity-0 transition-opacity group-hover:opacity-100">
                          เปิด <ChevronRight className="h-3 w-3" />
                        </span>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </Card>

            <Card className="overflow-hidden" data-testid="run-history">
              <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3 text-[12px] font-semibold text-white/85">
                <History className="h-3.5 w-3.5 text-muted-foreground/50" /> Run history
                <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9.5px] text-muted-foreground/60">{(task.runs || []).length}</span>
              </div>
              <div className="divide-y divide-white/[0.045]">
                {(task.runs || []).length === 0 && (
                  <div className="px-4 py-6 text-[11.5px] text-muted-foreground/45">ยังไม่เคยรัน — ประวัติจะขึ้นที่นี่ทุกครั้งที่สั่งทีม</div>
                )}
                {(task.runs || []).map(run => {
                  const isLatest = run.id === latestId
                  const selected = isLatest ? !selectedRun : selectedRun === run.id
                  return (
                    <div key={run.id} className={`flex flex-wrap items-center gap-2.5 px-4 py-2.5 transition-colors ${selected ? 'bg-primary/[0.06]' : 'hover:bg-white/[0.02]'}`}>
                      <button
                        type="button"
                        onClick={() => setSelectedRun(isLatest ? '' : run.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="font-mono text-[10.5px] text-primary/80">{run.id}</span>
                        <RunStatusBadge run={run} />
                        {isLatest && <Badge variant="gray" className="text-[8.5px]">latest</Badge>}
                        {run.loop_mode && <Badge variant="cyan" className="text-[8.5px]">loop</Badge>}
                      </button>
                      <span className="text-[9.5px] text-muted-foreground/40">{run.steps_done}/{run.steps_total} steps</span>
                      <span className="text-[9.5px] text-muted-foreground/40">{fmtUsd(run.cost_usd)}</span>
                      <span className="text-[9.5px] text-muted-foreground/30">{relTime(run.created_at)}</span>
                      {isLatest && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => router.push(`/projects/${projectId}`)}>
                          <Radio className="h-3 w-3" /> ดูสด
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </Card>
          </div>

          <div className="space-y-3.5">
            <Card className="p-4">
              <div className="mb-3 text-[11.5px] font-semibold text-white/80">Fields</div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-[10.5px] font-medium text-muted-foreground/55">Status</label>
                  <Select value={task.status} onValueChange={v => update({ status: v })}>
                    <SelectTrigger className="h-8 text-[12px]" data-testid="task-status-select"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TASK_STATUS_OPTIONS.map(s => <SelectItem key={s} value={s}>{(TASK_STATUS[s] || {}).label || s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10.5px] font-medium text-muted-foreground/55">Priority</label>
                  <Select value={task.priority} onValueChange={v => update({ priority: v })}>
                    <SelectTrigger className="h-8 text-[12px]" data-testid="task-priority-select"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PRIORITY_OPTIONS.map(p => <SelectItem key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10.5px] font-medium text-muted-foreground/55">Assignee</label>
                  <div className="flex gap-1.5">
                    <Input
                      value={assignee}
                      onChange={e => setAssignee(e.target.value)}
                      onBlur={() => { if (assignee !== (task.assignee || '')) update({ assignee }) }}
                      placeholder="ชื่อคนรับผิดชอบ"
                      className="h-8 text-[12px]"
                    />
                    {assignee !== (task.assignee || '') && (
                      <Button size="icon" className="h-8 w-8 shrink-0" onClick={() => update({ assignee })} disabled={saving}>
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3.5 space-y-1.5 border-t border-white/[0.06] pt-3 text-[10px] text-muted-foreground/40">
                <div className="flex items-center justify-between"><span>Priority</span><PriorityBadge priority={task.priority} className="text-[8.5px]" /></div>
                <div className="flex items-center justify-between"><span>Created</span><span>{relTime(task.created_at)}</span></div>
                <div className="flex items-center justify-between"><span>Updated</span><span>{relTime(task.updated_at)}</span></div>
              </div>
            </Card>

            <Card className="p-4" data-testid="latest-run-card">
              <div className="mb-2.5 flex items-center justify-between">
                <div className="text-[11.5px] font-semibold text-white/80">Latest mission</div>
                <RunStatusBadge run={latest} />
              </div>
              {!latest ? (
                <div className="text-[11px] text-muted-foreground/45">ยังไม่เคยสั่งทีม — กด “สั่งทีม” เพื่อแตกงานเป็น subtask ตามบทบาท</div>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10.5px] text-primary/80">{latest.id}</span>
                    <span className="text-[10px] text-muted-foreground/40">phase {latest.phase} · round {latest.round}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div className="rounded-lg bg-white/[0.03] px-2 py-1.5">
                      <div className="text-muted-foreground/40">Steps</div>
                      <div className="mt-0.5 font-semibold text-white/80">{latest.steps_done}/{latest.steps_total}</div>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] px-2 py-1.5">
                      <div className="text-muted-foreground/40">Cost</div>
                      <div className="mt-0.5 font-semibold text-white/80">{fmtUsd(latest.cost_usd)}</div>
                    </div>
                  </div>
                  {latest.acceptance && (
                    <div className={`rounded-lg px-2.5 py-2 text-[10.5px] ${latest.acceptance.verdict === 'pass' ? 'bg-emerald-500/[0.07] text-emerald-300' : 'bg-amber-500/[0.07] text-amber-300'}`}>
                      <div className="mb-0.5 font-semibold uppercase tracking-wide">PO {latest.acceptance.verdict}</div>
                      <div className="line-clamp-3 text-foreground/65">{latest.acceptance.summary}</div>
                    </div>
                  )}
                  {latest.summary && (
                    <div>
                      <div className="mb-1 text-[10px] font-semibold text-muted-foreground/50">Summary</div>
                      <div className="line-clamp-4 text-[10.5px] leading-relaxed text-muted-foreground/60">{latest.summary}</div>
                    </div>
                  )}
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => router.push(`/projects/${projectId}`)}>
                    <Radio className="h-3.5 w-3.5" /> เปิด mission control
                  </Button>
                </div>
              )}
            </Card>

            <Card className="p-4">
              <div className="mb-2.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-white/80">
                <Users className="h-3.5 w-3.5 text-muted-foreground/45" /> Subtask model
              </div>
              <p className="text-[10.5px] leading-relaxed text-muted-foreground/45">
                Subtask = step จริงของ mission (role + kind) — เปิดดูผลงานเต็ม แยกตามบทบาทได้ และเลือกดู run เก่าจาก history
              </p>
              <div className="mt-3 border-t border-white/[0.06] pt-3">
                <Button variant="ghost" size="sm" className="w-full text-red-300 hover:bg-red-500/10" onClick={remove}>
                  <Trash2 className="h-3.5 w-3.5" /> ลบ task
                </Button>
              </div>
            </Card>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-1.5 text-[10.5px] text-muted-foreground/30">
          <RotateCcw className="h-3 w-3" />
          สถานะ task อัปเดตอัตโนมัติจาก run — done = ส่งงานครบ, review = ยังไม่ผ่านหรือพลาด
        </div>
      </div>
    </>
  )
}
