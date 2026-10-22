'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Play, MessageSquare, Trash2, Users, Plus, Pencil, Eye, Code2, Network } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { marked } from 'marked'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const EMPTY_PERSONA = { role: '', name: '', title: '', years: '14', expertise: '', rules_md: '' }

export default function TeamPage() {
  const [agents, setAgents] = useState(null)
  const [busy, setBusy] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null = new
  const [form, setForm] = useState(EMPTY_PERSONA)
  const [mdPreview, setMdPreview] = useState(false)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

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
    setFormError('')
    setMdPreview(false)
    if (agent) {
      setEditing(agent.role)
      setForm({ role: agent.role, name: agent.name, title: agent.title, years: agent.years, expertise: agent.expertise, rules_md: agent.rules_md || '' })
    } else {
      setEditing(null)
      setForm(EMPTY_PERSONA)
    }
    setEditorOpen(true)
  }

  async function savePersona(e) {
    e.preventDefault()
    if (!form.name.trim() || (!editing && !form.role.trim())) return setFormError('Role and name are required')
    setSaving(true)
    setFormError('')
    try {
      const url = editing ? `${API}/agents/${editing}` : `${API}/agents`
      const res = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setEditorOpen(false)
      await load()
    } catch (err) {
      setFormError(err.message)
    }
    setSaving(false)
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

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${form.name || editing}` : 'New Persona'}</DialogTitle>
            <DialogDescription>ข้อมูลตัวตน + ความสามารถ + rules (markdown) ที่ใช้เป็น system prompt</DialogDescription>
          </DialogHeader>
          <form onSubmit={savePersona} className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <label className="text-[13px] font-medium">Role id {editing && <span className="text-muted-foreground/50">(fixed)</span>}</label>
                <Input value={form.role} disabled={!!editing} placeholder="devops" onChange={e => setForm({ ...form, role: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <label className="text-[13px] font-medium">Name</label>
                <Input value={form.name} placeholder="e.g. Rin" onChange={e => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <label className="text-[13px] font-medium">Title</label>
                <Input value={form.title} placeholder="DevOps Engineer" onChange={e => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <label className="text-[13px] font-medium">Years of experience</label>
                <Input value={form.years} placeholder="14" onChange={e => setForm({ ...form, years: e.target.value })} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <label className="text-[13px] font-medium">Expertise (สรุปสั้น)</label>
              <Input value={form.expertise} placeholder="CI/CD, Docker, Kubernetes..." onChange={e => setForm({ ...form, expertise: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium">Rules / System prompt (Markdown)</label>
                <Button type="button" variant="ghost" size="sm" data-testid="md-toggle" onClick={() => setMdPreview(p => !p)}>
                  {mdPreview ? <><Code2 className="h-3.5 w-3.5" /> Edit</> : <><Eye className="h-3.5 w-3.5" /> Preview</>}
                </Button>
              </div>
              {mdPreview ? (
                <div
                  data-testid="md-preview"
                  className="prose-invert min-h-[160px] rounded-md border bg-[#0d1420] p-3 text-[13px] [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5"
                  dangerouslySetInnerHTML={{ __html: marked.parse(form.rules_md || '_ไม่มีเนื้อหา_') }}
                />
              ) : (
                <Textarea
                  data-testid="md-editor"
                  className="min-h-[160px] font-mono text-[12px]"
                  placeholder={'# Rules\n\nYou are ... \n\n## Capabilities\n- can run shell commands\n- can open GitHub issues with `gh issue create`'}
                  value={form.rules_md}
                  onChange={e => setForm({ ...form, rules_md: e.target.value })}
                />
              )}
            </div>
            {formError && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400">{formError}</div>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving} data-testid="save-persona">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Persona'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
