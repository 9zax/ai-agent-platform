'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Package, ListChecks, Search, Plus, RefreshCw, CalendarDays } from 'lucide-react'
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

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const STATUS_LABEL = {
  running: 'Running', busy: 'Busy', stopped: 'Stopped', created: 'Created',
  paused: 'Paused', restarting: 'Restarting', dead: 'Dead',
}

function mapLive(c) {
  const raw = (c.status || '').split(' ')[0]
  const st = raw === 'exited' ? 'stopped' : raw
  const image = (c.image || '').split(':')[0].replace('ai-agent-platform-', '')
  const role = c.labels?.role
  return {
    id: c.id,
    name: c.name,
    type: role || image || 'docker',
    tag: role ? 'purple' : 'blue',
    model: c.labels?.model || 'docker',
    status: st,
    paused_since: c.paused_since,
    auto_paused: c.auto_paused,
    idle_secs: c.idle_secs,
    uptime: '—',
    tasks: '—',
    managed: c.labels?.['managed-by'] === 'ai-agent-platform',
  }
}

export default function Dashboard() {
  const router = useRouter()
  const [rows, setRows] = useState([])
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [showAll, setShowAll] = useState(false)
  const [activeTasks, setActiveTasks] = useState(3)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', role: 'agent', image: 'alpine:latest' })
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
      setForm({ name: '', role: 'agent', image: 'alpine:latest' })
      await load()
    } catch (err) {
      setFormError(err.message)
    }
    setCreating(false)
  }

  async function load(showEverything = false) {
    setLoading(true)
    try {
      const [cRes, tRes] = await Promise.all([
        authFetch(`${API}/containers${showEverything ? '?all=true' : ''}`).then(r => r.json()),
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

  useEffect(() => { load(showAll) }, [showAll])

  const filtered = useMemo(() => rows
    .filter(r => showAll || r.managed)
    .filter(r => {
      const q = query.toLowerCase()
      const matchQ = !q || r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.type.toLowerCase().includes(q)
      const matchS = filter === 'all' || r.status === filter
      return matchQ && matchS
    }), [rows, query, filter, showAll])

  const running = rows.filter(r => r.managed && (r.status === 'running' || r.status === 'busy')).length
  const pausedCount = rows.filter(r => r.managed && r.status === 'paused').length
  const managedCount = rows.filter(r => r.managed).length

  return (
    <>
      <div className="flex items-center justify-between px-7 pb-1 pt-5">
        <div>
          <h1 className="text-[21px] font-bold tracking-tight">Dashboard</h1>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">Last 24 hours</div>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="outline" size="icon" onClick={load} title="Refresh"><RefreshCw className="h-4 w-4" /></Button>
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-[12.5px] text-muted-foreground">
            <CalendarDays className="h-4 w-4" /> Sep 24 – 25, 2025
          </div>
          <Avatar><AvatarFallback>AD</AvatarFallback></Avatar>
        </div>
      </div>

      <div className="px-7 py-5">
        {!live && !loading && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-500/15 px-3.5 py-2.5 text-[12.5px] text-red-400">
            <span>Orchestrator API unreachable at {API} — is the stack running?</span>
            <Button variant="outline" size="sm" onClick={load}>Retry</Button>
          </div>
        )}

        <div className="mb-4 grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <Card className="p-4" data-testid="stat-containers">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
              <Package className="h-[15px] w-[15px] text-primary" /> Agent Containers
            </div>
            <div className="mt-2 text-[27px] font-bold tracking-tight">{managedCount}</div>
            <div className="mt-2 text-[11.5px] text-muted-foreground/70">
              <span className="font-semibold text-emerald-400">{running} running</span> · {pausedCount > 0 && <><span className="font-semibold text-cyan-400">{pausedCount} paused</span> · </>}{managedCount - running} idle
            </div>
          </Card>
          <Card className="p-4" data-testid="stat-tasks">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
              <ListChecks className="h-[15px] w-[15px] text-primary" /> Active Tasks
            </div>
            <div className="mt-2 text-[27px] font-bold tracking-tight">{activeTasks}</div>
            <div className="mb-1.5 mt-2 text-[11.5px] text-muted-foreground/70">
              <span className="font-semibold text-emerald-400">75%</span> capacity utilized
            </div>
            <Progress value={75} />
          </Card>
        </div>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
            <div className="text-[14.5px] font-bold">AI Agent Containers</div>
            <div className="flex items-center gap-2.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground/60" />
                <Input
                  className="w-[180px] pl-8"
                  placeholder="Search containers..."
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
              <Button variant="outline" data-testid="toggle-all-containers" onClick={() => setShowAll(s => !s)}>
                {showAll ? 'My agents only' : `All containers (${rows.length})`}
              </Button>
              <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> New Container</Button>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/4">Container</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uptime</TableHead>
                <TableHead>Tasks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(r => (
                <TableRow key={r.id} className="cursor-pointer" data-testid="container-row" onClick={() => router.push(`/containers/${encodeURIComponent(r.name || r.id)}`)}>
                  <TableCell>
                    <div className="font-mono text-[12px] text-primary">{r.id}</div>
                    <div className="mt-0.5 font-semibold">{r.name}</div>
                  </TableCell>
                  <TableCell><Badge variant={r.tag}>{r.type}</Badge></TableCell>
                  <TableCell>{r.model}</TableCell>
                  <TableCell>
                    <Badge variant={r.status} className="gap-1.5" data-testid="status-badge">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {STATUS_LABEL[r.status] || r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.uptime}</TableCell>
                  <TableCell>{r.tasks}</TableCell>
                </TableRow>
              ))}
              {!filtered.length && (
                <TableRow>
                  <TableCell colSpan={6} className="py-7 text-center text-muted-foreground/70">
                    {loading ? 'Loading containers…' : 'No containers match your filter.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Container</DialogTitle>
              <DialogDescription>Create an AI agent container. It will appear in the table once created.</DialogDescription>
            </DialogHeader>
            <form onSubmit={createContainer} className="grid gap-4 pt-2">
              <div className="grid gap-1.5">
                <label htmlFor="container-name" className="text-[13px] font-medium">Name</label>
                <Input
                  id="container-name"
                  placeholder="my-agent-01"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="container-role" className="text-[13px] font-medium">Role</label>
                <Input
                  id="container-role"
                  placeholder="agent"
                  value={form.role}
                  onChange={e => setForm({ ...form, role: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="container-image" className="text-[13px] font-medium">Image</label>
                <Input
                  id="container-image"
                  placeholder="alpine:latest"
                  value={form.image}
                  onChange={e => setForm({ ...form, image: e.target.value })}
                />
              </div>
              {formError && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400">{formError}</div>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create Container'}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </>
  )
}
