'use client'

// PersonaEditor — dialog form for creating/editing an AI team persona, including the
// per-provider model override. Shared by the AI Team page and the project flow chart
// (click a node in the chart to edit that agent and pick its model).

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Eye, Code2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { marked } from 'marked'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const EMPTY_PERSONA = { role: '', name: '', title: '', years: '14', expertise: '', rules_md: '', model: '' }

// The form body shared by the PersonaEditor dialog and the agent detail panel's
// "แก้ไข persona" tab. `active` gates the load effect (a tab that mounts hidden
// must not fetch until shown); `onDone` closes whatever container holds it.
export function PersonaForm({ agent, active = true, onSaved, onDone }) {
  const [form, setForm] = useState(EMPTY_PERSONA)
  const [mdPreview, setMdPreview] = useState(false)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [agentStatus, setAgentStatus] = useState(null) // {model, provider, provider_id}
  const [modelsInfo, setModelsInfo] = useState(null)   // {models, source, provider}

  const editing = !!agent

  // On active: snapshot the persona and load the active provider + its model list
  // (server caches /models for 60s) before seeding the model override field.
  useEffect(() => {
    if (!active) return
    setFormError('')
    setMdPreview(false)
    let alive = true
    Promise.all([
      authFetch(`${API}/agent/status`).then(r => r.json()).catch(() => null),
      authFetch(`${API}/models`).then(r => r.json()).catch(() => null),
    ]).then(([status, models]) => {
      if (!alive) return
      setAgentStatus(status)
      setModelsInfo(models)
      const base = agent
        ? { role: agent.role, name: agent.name, title: agent.title, years: agent.years, expertise: agent.expertise, rules_md: agent.rules_md || '' }
        : { ...EMPTY_PERSONA }
      setForm({ ...base, model: agent?.model_overrides?.[status?.provider_id] || '' })
    })
    return () => { alive = false }
  }, [active, agent])

  async function savePersona(e) {
    e.preventDefault()
    if (!form.name.trim() || (!editing && !form.role.trim())) return setFormError('Role and name are required')
    setSaving(true)
    setFormError('')
    try {
      const providerId = agentStatus?.provider_id
      // PUT: model "" clears the override for the active provider; POST seeds model_overrides directly
      const body = editing
        ? { ...form, model: form.model }
        : { ...form, model: undefined, model_overrides: form.model && providerId ? { [providerId]: form.model } : {} }
      const res = await authFetch(editing ? `${API}/agents/${agent.role}` : `${API}/agents`, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      onDone?.()
      onSaved?.()
    } catch (err) {
      setFormError(err.message)
    }
    setSaving(false)
  }

  // stored override that isn't offered by the current provider's list (e.g. set under
  // another provider) — shown as its own option so it stays visible without free typing
  const staleModel = form.model !== '' && !modelsInfo?.models?.includes(form.model)

  return (
    <form onSubmit={savePersona} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-[13px] font-medium">Role id {editing && <span className="text-muted-foreground/50">(fixed)</span>}</label>
              <Input value={form.role} disabled={editing} placeholder="devops" onChange={e => setForm({ ...form, role: e.target.value })} />
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
              <label className="text-[13px] font-medium">โมเดลประจำตัว (per-persona)</label>
              <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground/60" data-testid="model-provider-label">
                {modelsInfo ? modelsInfo.provider : '…'}
                {modelsInfo && (
                  <Badge variant={modelsInfo.source === 'live' ? 'green' : 'gray'} className="text-[9px]" data-testid="model-source">
                    {modelsInfo.source === 'live' ? 'live' : 'preset'}
                  </Badge>
                )}
              </span>
            </div>
            <Select
              value={form.model === '' ? 'default' : form.model}
              onValueChange={v => setForm({ ...form, model: v === 'default' ? '' : v })}
            >
              <SelectTrigger data-testid="model-select">
                <SelectValue placeholder="เลือกโมเดล" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default" data-testid="model-default">
                  ใช้ default ของ provider{agentStatus?.model ? ` (${agentStatus.model})` : ' (ไม่มี — ต้องตั้งเอง)'}
                </SelectItem>
                {modelsInfo?.models?.map(m => (
                  <SelectItem key={m} value={m} data-testid="model-option">{m}</SelectItem>
                ))}
                {staleModel && (
                  <SelectItem value={form.model} data-testid="model-stale">
                    {form.model} (ค่าเดิม — ไม่อยู่ใน list ของ provider นี้)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <div className="text-[11px] text-muted-foreground/60">
              ตั้งค่าต่อ provider — สลับ provider แล้ว persona นี้จะจำโมเดลของแต่ละ provider แยกกัน
            </div>
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
          <div className="flex justify-end gap-2.5">
            {onDone && <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>}
            <Button type="submit" disabled={saving} data-testid="save-persona">{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Persona'}</Button>
          </div>
        </form>
  )
}

// Dialog wrapper — the AI Team page and anywhere else that edits a persona standalone.
export function PersonaEditor({ agent, open, onOpenChange, onSaved }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name || agent.role}` : 'New Persona'}</DialogTitle>
          <DialogDescription>ข้อมูลตัวตน + ความสามารถ + rules (markdown) ที่ใช้เป็น system prompt</DialogDescription>
        </DialogHeader>
        <PersonaForm agent={agent} active={open} onSaved={onSaved} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
