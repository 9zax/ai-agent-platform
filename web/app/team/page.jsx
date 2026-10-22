'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Play, MessageSquare, Trash2, Users, Plus, Pencil, Eye, Code2, Network } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PersonaEditor } from '@/components/persona-editor'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function TeamPage() {
  const [agents, setAgents] = useState(null)
  const [busy, setBusy] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState(null) // persona object, or null = new
  const [agentStatus, setAgentStatus] = useState(null) // {model, provider, provider_id} from /agent/status

  async function load() {
    try {
      const res = await authFetch(`${API}/agents`)
      setAgents(await res.json())
    } catch {
      setAgents([])
    }
  }

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

  async function stopAgent(name) {
    setBusy(name)
    try {
      await authFetch(`${API}/containers/${encodeURIComponent(name)}/stop`, { method: 'POST' })
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

  return (
    <>
      <div className="flex items-center justify-between px-7 pb-1 pt-5">
        <div>
          <h1 className="flex items-center gap-2.5 text-[21px] font-bold tracking-tight">
            <Users className="h-5 w-5 text-primary" /> AI Team
          </h1>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">
            มืออาชีพหลายสายงาน ประสบการณ์ 14 ปีขึ้นไป แก้ไข rules ได้เป็น markdown
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.location.href = '/projects'}>
            <Network className="h-4 w-4" /> Build Team (Projects)
          </Button>
          <Button onClick={() => openEditor(null)}><Plus className="h-4 w-4" /> Add Persona</Button>
        </div>
      </div>

      <div className="grid gap-3.5 px-7 py-5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        {agents === null && <div className="text-muted-foreground/70">Loading team…</div>}
        {agents?.length === 0 && <div className="text-muted-foreground/70">Orchestrator unreachable.</div>}
        {agents?.map(a => (
          <Card key={a.role} className="flex flex-col gap-3 p-4" data-testid="agent-card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold">{a.name}</span>
                  <Badge variant="purple">{a.years}+ yrs</Badge>
                </div>
                <div className="mt-0.5 text-[12.5px] font-medium text-primary">{a.title}</div>
                <Badge
                  variant={a.model_overrides?.[agentStatus?.provider_id] ? 'blue' : 'gray'}
                  className="mt-1 max-w-full truncate font-mono text-[10px]"
                  data-testid={`agent-model-${a.role}`}
                  title={a.model_overrides?.[agentStatus?.provider_id] ? 'persona override' : 'provider default'}
                >
                  {a.model || 'ไม่ได้ตั้งโมเดล'}
                </Badge>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <code className="rounded bg-secondary px-2 py-0.5 font-mono text-[10.5px] uppercase text-muted-foreground">{a.role}</code>
                {a.container
                  ? <Badge variant={a.container.status === 'running' ? 'running' : 'stopped'} className="gap-1.5" data-testid={`agent-status-${a.role}`}>
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {a.container.status === 'running' ? 'Running' : a.container.status}
                    </Badge>
                  : <Badge variant="gray" data-testid={`agent-status-${a.role}`}>Offline</Badge>}
              </div>
            </div>

            <div className="text-[12px] leading-relaxed text-muted-foreground/80">{a.expertise}</div>

            <div className="mt-auto flex items-center gap-2">
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
                    <Button size="sm" variant="outline" disabled={busy === a.container.name} onClick={() => stopAgent(a.container.name)}>Stop</Button>
                  )}
                  <Button size="sm" variant="outline" className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-400" disabled={busy === a.container.name} onClick={() => remove(a.container.name)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" data-testid={`agent-edit-${a.role}`} onClick={() => openEditor(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" className="text-red-400 hover:bg-red-500/10 hover:text-red-400" data-testid={`agent-delete-${a.role}`} disabled={busy === a.role} onClick={() => deletePersona(a.role)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <PersonaEditor agent={editingAgent} open={editorOpen} onOpenChange={setEditorOpen} onSaved={load} />
    </>
  )
}
