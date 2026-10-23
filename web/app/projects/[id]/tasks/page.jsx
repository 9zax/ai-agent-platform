'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ListTodo, Plus, ArrowLeft, Loader2, AlertTriangle, Network, ChevronRight, Users,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import PageHeader from '@/components/page-header'
import {
  TASK_COLUMNS, PriorityBadge, PRIORITY_OPTIONS, initials, relTime,
} from '@/components/task-ui'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const RUN_STATUS = {
  running: { variant: 'running', label: 'กำลังทำ' },
  waiting_human: { variant: 'busy', label: 'รอคุณตอบ' },
  done: { variant: 'green', label: 'เสร็จแล้ว' },
  error: { variant: 'dead', label: 'พลาด' },
  stopped: { variant: 'stopped', label: 'หยุด' },
}

function RunChip({ task }) {
  const run = task.latest_run
  if (!run) return null
  const meta = RUN_STATUS[run.status] || RUN_STATUS.running
  const failed = run.acceptance?.verdict === 'fail'
  return (
    <Badge variant={failed && run.status === 'done' ? 'yellow' : meta.variant} className="gap-1 text-[9.5px]">
      {run.status === 'running' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {failed && run.status === 'done' ? 'ต้องแก้' : meta.label}
      <span className="font-mono text-[8.5px] opacity-60">{run.id.replace('run-', '#')}</span>
    </Badge>
  )
}

function TaskCard({ task, projectId }) {
  const router = useRouter()
  const counts = task.subtask_counts || { total: 0, done: 0, working: 0 }
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0
  const open = () => router.push(`/projects/${projectId}/tasks/${task.id}`)

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      className="group cursor-pointer rounded-xl border border-white/[0.07] bg-white/[0.025] p-3 transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-white/[0.04] focus:outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/25"
      data-testid={`task-card-${task.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground/45">{task.id}</span>
        <PriorityBadge priority={task.priority} className="text-[9px]" />
      </div>

      <h3 className="mt-1.5 line-clamp-2 text-[12.5px] font-semibold leading-snug text-white/90 group-hover:text-white">
        {task.title}
      </h3>
      {task.description && (
        <p className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground/50">{task.description}</p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <RunChip task={task} />
        {counts.total > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-0.5 text-[9.5px] text-muted-foreground/60">
            {counts.working > 0 && <Loader2 className="h-2.5 w-2.5 animate-spin text-blue-300" />}
            {counts.done}/{counts.total} subtasks
          </span>
        )}
      </div>

      {counts.total > 0 && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-emerald-400/70 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between text-[9.5px] text-muted-foreground/40">
        {task.assignee ? (
          <span className="flex items-center gap-1.5 truncate">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[7.5px] font-bold text-primary">
              {initials(task.assignee)}
            </span>
            <span className="truncate">{task.assignee}</span>
          </span>
        ) : <span>{relTime(task.updated_at)}</span>}
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          เปิด <ChevronRight className="h-3 w-3" />
        </span>
      </div>
    </article>
  )
}

export default function TaskBoardPage() {
  const { id: projectId } = useParams()
  const router = useRouter()
  const [project, setProject] = useState(null)
  const [tasks, setTasks] = useState(null)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ title: '', description: '', priority: 'medium', status: 'todo' })

  const load = useCallback(async () => {
    try {
      const [pRes, tRes] = await Promise.all([
        authFetch(`${API}/projects/${projectId}`),
        authFetch(`${API}/projects/${projectId}/tasks`),
      ])
      if (!pRes.ok) throw new Error(`Project ${pRes.status}`)
      const [pData, tData] = await Promise.all([pRes.json(), tRes.json()])
      if (!tRes.ok) throw new Error(tData?.detail || `Tasks ${tRes.status}`)
      setProject(pData)
      setTasks(Array.isArray(tData) ? tData : [])
      setError('')
    } catch (err) {
      setError(err.message)
      setTasks(prev => prev ?? [])
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const active = useMemo(() => (tasks || []).some(t => t.active), [tasks])
  useEffect(() => {
    const timer = setInterval(load, active ? 4000 : 12000)
    return () => clearInterval(timer)
  }, [load, active])

  async function create(e) {
    e.preventDefault()
    if (!form.title.trim()) return setError('ต้องมีชื่อ task')
    setSaving(true)
    setError('')
    try {
      const res = await authFetch(`${API}/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setDialogOpen(false)
      setForm({ title: '', description: '', priority: 'medium', status: 'todo' })
      await load()
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  const grouped = useMemo(() => {
    const map = Object.fromEntries(TASK_COLUMNS.map(c => [c.id, []]))
    for (const t of tasks || []) (map[t.status] || map.backlog).push(t)
    return map
  }, [tasks])

  return (
    <>
      <PageHeader
        icon={ListTodo}
        title={project ? `${project.name} · Tasks` : 'Tasks'}
        subtitle="1 งาน = 1 task · แต่ละ task แตก subtask ตามบทบาทของทีม AI และเปิดดูผลงานแยกได้"
        leading={(
          <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground/60" onClick={() => router.push(`/projects/${projectId}`)} aria-label="Back to project">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        actions={(
          <>
            <Button variant="ghost" onClick={() => router.push(`/projects/${projectId}`)}>
              <Network className="h-4 w-4" /> Project
            </Button>
            <Button onClick={() => setDialogOpen(true)} data-testid="new-task-button">
              <Plus className="h-4 w-4" /> New task
            </Button>
          </>
        )}
      />

      <div className="page-body">
        {error && (
          <Card className="mb-3 flex items-center gap-2 border-red-400/20 bg-red-500/[0.06] px-4 py-2.5 text-[12px] text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </Card>
        )}

        {tasks === null ? (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {TASK_COLUMNS.map(c => (
              <div key={c.id} className="w-[262px] shrink-0 space-y-2.5 xl:w-auto xl:flex-1">
                <div className="skeleton h-7 rounded-lg" />
                <Card className="h-32 p-3"><div className="skeleton h-3 w-2/3" /><div className="skeleton mt-2 h-3 w-full" /><div className="skeleton mt-2 h-3 w-1/2" /></Card>
              </div>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <Card className="flex flex-col items-center gap-4 border-dashed bg-card/40 p-12 text-center" data-testid="tasks-empty">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <ListTodo className="h-5 w-5 text-muted-foreground/50" />
            </div>
            <div>
              <div className="text-[15px] font-semibold text-white">ยังไม่มี task</div>
              <div className="mt-1 text-[12.5px] text-muted-foreground">สร้าง task แรก แล้วสั่งทีม AI แตกงานเป็น subtask ตามบทบาท</div>
            </div>
            <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> New task</Button>
          </Card>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2" data-testid="task-board">
            {TASK_COLUMNS.map(col => {
              const items = grouped[col.id] || []
              return (
                <section key={col.id} className="flex w-[262px] shrink-0 flex-col xl:w-auto xl:flex-1" data-testid={`task-column-${col.id}`}>
                  <header className="mb-2 flex items-center gap-2 px-1">
                    <span className={`h-2 w-2 rounded-full ${col.dot} ${col.id === 'in_progress' && active ? 'animate-pulse' : ''}`} />
                    <span className="text-[11.5px] font-semibold text-white/85">{col.label}</span>
                    <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9.5px] font-semibold text-muted-foreground/55">{items.length}</span>
                    <span className="ml-auto text-[9.5px] text-muted-foreground/30">{col.hint}</span>
                  </header>
                  <div className="flex min-h-[120px] flex-1 flex-col gap-2 rounded-xl border border-white/[0.045] bg-black/15 p-2">
                    {items.map(t => <TaskCard key={t.id} task={t} projectId={projectId} />)}
                    {items.length === 0 && (
                      <div className="flex flex-1 items-center justify-center py-6 text-[10.5px] text-muted-foreground/25">ว่าง</div>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}

        {tasks !== null && tasks.length > 0 && (
          <div className="mt-4 flex items-center gap-1.5 text-[10.5px] text-muted-foreground/35">
            <Users className="h-3.5 w-3.5" />
            ทุก task แชร์ทีม AI ของ project · subtask มาจาก step จริงใน mission ไม่มีสำเนาให้เพี้ยน
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>1 งาน = 1 task — ใส่โจทย์ให้ทีม แล้วค่อยสั่ง mission จากหน้า task</DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground">Title</label>
              <Input
                autoFocus
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="เช่น: เพิ่มหน้า task board พร้อม subtask ต่อบทบาท"
                data-testid="task-title-input"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground">Description</label>
              <Textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="รายละเอียด เกณฑ์รับงาน หรือ context ที่ทีมต้องรู้"
                className="min-h-[96px] resize-none"
                data-testid="task-description-input"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-muted-foreground">Priority</label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map(p => <SelectItem key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-muted-foreground">Column</label>
                <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TASK_COLUMNS.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving || !form.title.trim()} data-testid="task-create-submit">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
