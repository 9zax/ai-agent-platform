'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Play, MessageSquare, Trash2, Users, Plus, Pencil, Network } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PersonaEditor } from '@/components/persona-editor'
import { ConnectorChips, ConnectorDialogs } from '@/components/connector-flows'
import PageHeader from '@/components/page-header'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

function statusOf(container) {
  if (!container) return { label: 'Offline', variant: 'gray', line: 'via-white/15' }
  const s = container.status
  if (s === 'running') return { label: 'Running', variant: 'running', line: 'via-emerald-400/60' }
  if (s === 'paused') return { label: 'Paused', variant: 'paused', line: 'via-cyan-400/60' }
  if (s === 'exited') return { label: 'Stopped', variant: 'stopped', line: 'via-white/15' }
  return { label: s, variant: 'gray', line: 'via-white/15' }
}

export default function TeamPage() {
  const [agents, setAgents] = useState(null)
  const [busy, setBusy] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState(null) // persona object, or null = new
  const [agentStatus, setAgentStatus] = useState(null) // {model, provider, provider_id} from /agent/status
  const [connectorRows, setConnectorRows] = useState(null) // /connectors/status rows — null = loading
  const [flow, setFlow] = useState(null) // { container, ctype } — opens the shared connect dialog
  const [connRefresh, setConnRefresh] = useState(0) // bumped after a dialog change → repoll now

  async function load() {
    try {
      const res = await authFetch(`${API}/agents`)
      setAgents(await res.json())
    } catch {
      setAgents([])
    }
  }

  // Connector states ride the same cadence as the agent list — chips stay in
  // sync with connects/disconnects done anywhere (this page, console, overview)
  useEffect(() => {
    let alive = true
    async function loadConnectors() {
      try {
        const res = await authFetch(`${API}/connectors/status`)
        if (res.ok && alive) setConnectorRows(await res.json())
      } catch { /* keep last known */ }
    }
    loadConnectors()
    const t = setInterval(loadConnectors, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [connRefresh])

  useEffect(() => {
    load()
    authFetch(`${API}/agent/status`).then(r => r.json()).then(setAgentStatus).catch(() => {})
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  async function start(role) {
    setBusy(role)
    try {
      await authFetch(`${API}/agents/${role}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      await load()
    } finally {
      setBusy('')
    }
  }

  async function containerAction(name, action) {
    setBusy(name)
    try {
      await authFetch(`${API}/containers/${encodeURIComponent(name)}/${action}`, { method: 'POST' })
      await load()
    } finally {
      setBusy('')
    }
  }

  async function remove(name) {
    setBusy(name)
    try {
      await authFetch(`${API}/containers/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await load()
    } finally {
      setBusy('')
    }
  }

  function openEditor(agent) {
    setEditingAgent(agent)
    setEditorOpen(true)
  }

  async function deletePersona(role) {
    setBusy(role)
    try {
      await authFetch(`${API}/agents/${role}`, { method: 'DELETE' })
      await load()
    } finally {
      setBusy('')
    }
  }

  const onlineCount = (agents || []).filter(a => a.container?.status === 'running').length

  return (
    <>
      <PageHeader
        icon={Users}
        title="AI Team"
        subtitle="มืออาชีพหลายสายงาน ประสบการณ์ 14 ปีขึ้นไป แก้ไข rules ได้เป็น markdown"
        actions={
          <>
            <div className="hidden items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11.5px] text-muted-foreground lg:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
              {onlineCount} online
            </div>
            <Button variant="outline" onClick={() => window.location.href = '/projects'}>
              <Network className="h-4 w-4" /> Build Team (Projects)
            </Button>
            <Button onClick={() => openEditor(null)}><Plus className="h-4 w-4" /> Add Persona</Button>
          </>
        }
      />

      <div className="page-body">
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(310px,1fr))]">
          {agents === null && [0, 1, 2, 3, 4, 5].map(i => (
            <Card key={i} className="h-[230px] p-5">
              <div className="flex items-center gap-3">
                <div className="skeleton h-10 w-10 rounded-xl" />
                <div className="flex-1">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton mt-2 h-3 w-1/3" />
                </div>
              </div>
              <div className="skeleton mt-5 h-3 w-4/5" />
              <div className="skeleton mt-2 h-3 w-3/5" />
            </Card>
          ))}
          {agents?.length === 0 && (
            <Card className="col-span-full p-10 text-center text-[12.5px] text-muted-foreground">Orchestrator unreachable.</Card>
          )}

          {agents?.map(a => {
            const status = statusOf(a.container)
            const overridden = a.model_overrides?.[agentStatus?.provider_id]
            return (
              <Card
                key={a.role}
                className="group relative flex flex-col overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.1] hover:shadow-lift"
                data-testid="agent-card"
              >
                <div className={cn('pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent', status.line)} />

                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/90 to-indigo-600 text-[11.5px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(99,102,241,0.9)]">
                      {initials(a.name)}
                      <span className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0b1019]',
                        a.container?.status === 'running' ? 'bg-emerald-400' : a.container?.status === 'paused' ? 'bg-cyan-400' : 'bg-slate-500')} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[15px] font-semibold tracking-[-0.015em] text-white">{a.name}</span>
                        <Badge variant="purple" className="shrink-0">{a.years}+ yrs</Badge>
                      </div>
                      <div className="mt-0.5 truncate text-[12px] font-medium text-primary/90">{a.title}</div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <code className="rounded-md bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground/70 ring-1 ring-inset ring-white/[0.05]">{a.role}</code>
                    {a.container
                      ? <Badge variant={status.variant} className="gap-1.5" data-testid={`agent-status-${a.role}`}>
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          {status.label}
                        </Badge>
                      : <Badge variant="gray" data-testid={`agent-status-${a.role}`}>Offline</Badge>}
                  </div>
                </div>

                <div className="mt-3.5">
                  <Badge
                    variant={overridden ? 'blue' : 'gray'}
                    className="max-w-full truncate font-mono text-[9.5px]"
                    data-testid={`agent-model-${a.role}`}
                    title={overridden ? 'persona override' : 'provider default'}
                  >
                    {a.model || 'ไม่ได้ตั้งโมเดล'}
                  </Badge>
                </div>

                <div className="mt-3 line-clamp-3 min-h-[54px] text-[12px] leading-relaxed text-muted-foreground/75">{a.expertise}</div>

                {/* Live connector state per AI — click a chip to connect/disconnect
                    without leaving the team page */}
                {a.container && (
                  <div className="mt-2">
                    <ConnectorChips
                      containerName={a.container.name}
                      connectors={connectorRows?.find(r => r.name === a.container.name)?.connectors}
                      onOpen={ctype => setFlow({ container: a.container.name, ctype })}
                    />
                  </div>
                )}

                <div className="mt-4 flex items-center gap-1.5 border-t border-white/[0.05] pt-3.5">
                  {!a.container ? (
                    <Button size="sm" data-testid={`agent-start-${a.role}`} disabled={busy === a.role} onClick={() => start(a.role)}>
                      <Play className="h-3.5 w-3.5" /> {busy === a.role ? 'Starting…' : 'Start'}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => window.location.href = `/containers/${encodeURIComponent(a.container.name)}`} data-testid="agent-console">
                        <MessageSquare className="h-3.5 w-3.5" /> Console
                      </Button>
                      {a.container.status === 'running' && (
                        <>
                          <Button size="sm" variant="outline" disabled={busy === a.container.name} onClick={() => containerAction(a.container.name, 'pause')}>Pause</Button>
                          <Button size="sm" variant="outline" disabled={busy === a.container.name} onClick={() => containerAction(a.container.name, 'stop')}>Stop</Button>
                        </>
                      )}
                      {a.container.status === 'paused' && (
                        <Button size="sm" variant="outline" disabled={busy === a.container.name} onClick={() => containerAction(a.container.name, 'resume')}>Resume</Button>
                      )}
                      {a.container.status === 'exited' && (
                        <Button size="sm" variant="outline" disabled={busy === a.container.name} onClick={() => containerAction(a.container.name, 'start')}>Start</Button>
                      )}
                      <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-400" disabled={busy === a.container.name} onClick={() => remove(a.container.name)} aria-label="Remove session">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                  <div className="ml-auto flex items-center gap-0.5">
                    <Button size="sm" variant="ghost" className="h-8 w-8 text-muted-foreground/60 hover:text-primary" data-testid={`agent-edit-${a.role}`} onClick={() => openEditor(a)} aria-label="Edit persona">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 w-8 text-muted-foreground/50 hover:bg-red-500/10 hover:text-red-400" data-testid={`agent-delete-${a.role}`} disabled={busy === a.role} onClick={() => deletePersona(a.role)} aria-label="Delete persona">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      </div>

      <PersonaEditor agent={editingAgent} open={editorOpen} onOpenChange={setEditorOpen} onSaved={load} />

      <ConnectorDialogs
        containerId={flow?.container || null}
        ctype={flow?.ctype || null}
        onClose={() => setFlow(null)}
        onChanged={() => setConnRefresh(t => t + 1)}
      />
    </>
  )
}
