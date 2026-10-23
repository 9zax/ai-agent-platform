'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Package, ListChecks, Search, Plus, RefreshCw, Activity, Gauge, AlertTriangle, ChevronRight, Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import PageHeader from '@/components/page-header'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const STATUS_LABEL = {
  running: 'Running', busy: 'Busy', stopped: 'Stopped', created: 'Created',
  paused: 'Paused', restarting: 'Restarting', dead: 'Dead',
}

function mapLive(c) {
  const raw = (c.status || '').split(' ')[0]
  const st = raw === 'exited' ? 'stopped' : raw
  const role = c.labels?.role
  return {
    id: c.id,
    name: c.name,
    type: role || 'host',
    tag: role ? 'purple' : 'blue',
    model: c.labels?.model || 'host shell',
    status: st,
    paused_since: c.paused_since,
    auto_paused: c.auto_paused,
    idle_secs: c.idle_secs,
    uptime: '—',
    tasks: '—',
    // host mode: every listed agent is one this platform started
    managed: true,
  }
}

function StatCard({ icon: Icon, tone, label, value, meta, progress, testId, className }) {
  return (
    <div className={cn('stat-card', className)} data-testid={testId}>
      <div className="relative flex items-center gap-2.5">
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset', tone)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="relative mt-4 text-[30px] font-semibold leading-none tracking-[-0.035em] tabular-nums text-white">{value}</div>
      <div className="relative mt-3 text-[11.5px] leading-relaxed text-muted-foreground/70">{meta}</div>
      {typeof progress === 'number' && (
        <Progress value={progress} className="relative mt-3 h-1" />
      )}
    </div>
  )
}

export default function Dashboard() {
  const router = useRouter()
  const [rows, setRows] = useState([])
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [activeTasks, setActiveTasks] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', role: 'agent' })
  const [formError, setFormError] = useState('')

  async function createContainer(e) {
    e.preventDefault()
    if (!form.name.trim()) return setFormError('Name is required')
    setCreating(true)
    setFormError('')
    try {
      const res = await authFetch(`${API}/containers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setDialogOpen(false)
      setForm({ name: '', role: 'agent' })
      await load()
    } catch (err) {
      setFormError(err.message)
    }
    setCreating(false)
  }

  async function load() {
    setLoading(true)
    try {
      const [cRes, tRes] = await Promise.all([
        authFetch(`${API}/containers`).then(r => r.json()),
        authFetch(`${API}/tasks`).then(r => r.json()).catch(() => []),
      ])
      setRows(cRes.map(mapLive))
      setLive(true)
      const inProgress = (Array.isArray(tRes) ? tRes : []).filter(t => t.status === 'in_progress').length
      setActiveTasks(inProgress)
    } catch {
      setRows([])
      setLive(false)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = useMemo(() => rows
    .filter(r => {
      const q = query.toLowerCase()
      const matchQ = !q || r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.type.toLowerCase().includes(q)
      const matchS = filter === 'all' || r.status === filter
      return matchQ && matchS
    }), [rows, query, filter])

  const running = rows.filter(r => r.managed && (r.status === 'running' || r.status === 'busy')).length
  const pausedCount = rows.filter(r => r.managed && r.status === 'paused').length
  const managedCount = rows.filter(r => r.managed).length
  const utilization = managedCount ? Math.round((running / managedCount) * 100) : 0

  return (
    <>
      <PageHeader
        icon={Activity}
        title="Dashboard"
        subtitle="ภาพรวมทีม AI และ host agents ที่ทำงานบนเครื่องนี้"
        actions={
          <>
            <div className="hidden items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11.5px] text-muted-foreground md:flex">
              <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-muted-foreground/40')} />
              {live ? 'Live data' : 'Offline'}
            </div>
            <Button variant="outline" size="icon" onClick={load} title="Refresh" aria-label="Refresh">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
            <Avatar><AvatarFallback>AD</AvatarFallback></Avatar>
          </>
        }
      />

      <div className="page-body">
        {!live && !loading && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-red-400/20 bg-red-500/[0.06] px-4 py-3 text-[12.5px] text-red-300">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Orchestrator API unreachable at {API} — is the stack running?
            </span>
            <Button variant="outline" size="sm" onClick={load}>Retry</Button>
          </div>
        )}

        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          <StatCard
            testId="stat-containers"
            icon={Package}
            tone="bg-primary/[0.12] text-primary ring-primary/20"
            label="Agent Containers"
            value={managedCount}
            meta={<>
              <span className="font-semibold text-emerald-400">{running} running</span>
              <span className="mx-1.5 text-muted-foreground/30">·</span>
              <span className={cn(pausedCount > 0 && 'font-semibold text-cyan-400')}>{pausedCount} paused</span>
              <span className="mx-1.5 text-muted-foreground/30">·</span>
              {managedCount - running - pausedCount} idle
            </>}
          />
          <StatCard
            testId="stat-tasks"
            icon={ListChecks}
            tone="bg-sky-500/[0.12] text-sky-300 ring-sky-400/20"
            label="Active Tasks"
            value={activeTasks}
            meta="งานที่ทีมกำลังดำเนินการอยู่ตอนนี้"
          />
          <StatCard
            icon={Gauge}
            tone="bg-emerald-500/[0.12] text-emerald-300 ring-emerald-400/20"
            label="Team Capacity"
            value={`${utilization}%`}
            meta={<><span className="font-semibold text-foreground/75">{running}</span> of {managedCount} agents working</>}
            progress={utilization}
          />
        </div>

        <Card className="mt-4 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] p-4">
            <div>
              <div className="text-[14px] font-semibold text-white">AI Agents</div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground/60">tmux sessions on this machine</div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
                <Input
                  className="w-[190px] pl-8"
                  placeholder="Search agents..."
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
              </div>
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="w-[130px] text-muted-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="busy">Busy</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="stopped">Stopped</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> New Agent</Button>
            </div>
          </div>
          <div className="overflow-x-auto">
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/4">Container</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Uptime</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Tasks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(r => (
                <TableRow key={r.id} className="group cursor-pointer" data-testid="container-row" onClick={() => router.push(`/containers/${encodeURIComponent(r.name || r.id)}`)}>
                  <TableCell>
                    {r.id !== r.name && <div className="font-mono text-[10.5px] text-primary/70">{r.id}</div>}
                    <div className={cn('flex items-center gap-1.5 font-semibold text-foreground/95', r.id !== r.name && 'mt-0.5')}>
                      <span className="max-w-[240px] truncate">{r.name}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60" />
                    </div>
                  </TableCell>
                  <TableCell><Badge variant={r.tag} className="whitespace-nowrap">{r.type}</Badge></TableCell>
                  <TableCell><span className="whitespace-nowrap font-mono text-[11.5px] text-muted-foreground/80">{r.model}</span></TableCell>
                  <TableCell>
                    <Badge variant={r.status} className="gap-1.5" data-testid="status-badge">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {STATUS_LABEL[r.status] || r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell"><span className="text-muted-foreground/60 tabular-nums">{r.uptime}</span></TableCell>
                  <TableCell className="hidden text-right lg:table-cell"><span className="text-muted-foreground/60 tabular-nums">{r.tasks}</span></TableCell>
                </TableRow>
              ))}
              {!filtered.length && (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center text-muted-foreground/60">
                    {loading ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading agents…</span>
                    ) : (
                      <span className="flex flex-col items-center gap-2">
                        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03]">
                          <Search className="h-4 w-4 text-muted-foreground/50" />
                        </span>
                        No containers match your filter.
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        </Card>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Agent</DialogTitle>
              <DialogDescription>Start a host agent (a tmux session on this machine) with the given role. Name defaults to agent-&lt;role&gt;.</DialogDescription>
            </DialogHeader>
            <form onSubmit={createContainer} className="grid gap-4 pt-1">
              <div className="grid gap-1.5">
                <label htmlFor="container-name" className="field-label">Name</label>
                <Input
                  id="container-name"
                  placeholder="agent-dev"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="container-role" className="field-label">Role</label>
                <Input
                  id="container-role"
                  placeholder="dev"
                  value={form.role}
                  onChange={e => setForm({ ...form, role: e.target.value })}
                />
                <span className="field-hint">ใช้เป็นชื่อ session และป้ายกำกับใน flow — เช่น dev, qa, po</span>
              </div>
              {formError && <div className="rounded-lg border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[12.5px] text-red-300">{formError}</div>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create Agent'}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </>
  )
}
