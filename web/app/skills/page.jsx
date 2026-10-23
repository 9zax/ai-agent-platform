'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Check, Plus, X, Trash2, Wrench, FlaskConical, History, Pencil, RotateCcw, Loader2, AlertCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import PageHeader from '@/components/page-header'
import { cn } from '@/lib/utils'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function SkillsPage() {
  const [skills, setSkills] = useState(null)
  const [listError, setListError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState(null) // null = create mode
  const [form, setForm] = useState({ name: '', description: '' })
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)
  // Skill Studio — test bench + version history
  const [testing, setTesting] = useState(null)
  const [testInput, setTestInput] = useState('')
  const [testRunning, setTestRunning] = useState(false)
  const [testError, setTestError] = useState('')
  const [historySkill, setHistorySkill] = useState(null)

  async function load() {
    try {
      const res = await authFetch(`${API}/skills`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setSkills(Array.isArray(data) ? data : [])
      setListError('')
    } catch (err) {
      setSkills(prev => (Array.isArray(prev) ? prev : []))
      setListError(err.message)
    }
  }

  useEffect(() => { load() }, [])

  async function createSkill(e) {
    e.preventDefault()
    if (!form.name.trim()) return setFormError('Name is required')
    setCreating(true)
    setFormError('')
    try {
      const res = await authFetch(editingSkill ? `${API}/skills/${editingSkill.id}` : `${API}/skills`, {
        method: editingSkill ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setDialogOpen(false)
      setEditingSkill(null)
      setForm({ name: '', description: '' })
      await load()
    } catch (err) {
      setFormError(err.message)
    }
    setCreating(false)
  }

  function openEdit(skill) {
    setEditingSkill(skill)
    setForm({ name: skill.name, description: skill.description || '' })
    setFormError('')
    setDialogOpen(true)
  }

  function openCreate() {
    setEditingSkill(null)
    setForm({ name: '', description: '' })
    setFormError('')
    setDialogOpen(true)
  }

  function applySkill(updated) {
    setSkills(list => list.map(s => (s.id === updated.id ? updated : s)))
    if (testing?.id === updated.id) setTesting(updated)
    if (historySkill?.id === updated.id) setHistorySkill(updated)
  }

  function openTest(skill) {
    setTesting(skill)
    setTestInput(skill.test_inputs?.[0] || '')
    setTestError('')
  }

  async function saveTestInput() {
    if (!testing || !testInput.trim()) return
    const next = [...new Set([testInput.trim(), ...(testing.test_inputs || [])])].slice(0, 20)
    const res = await authFetch(`${API}/skills/${testing.id}/tests`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: next }),
    })
    const data = await res.json()
    if (!res.ok) return setTestError(data.detail || `HTTP ${res.status}`)
    applySkill(data)
  }

  async function runTest() {
    if (!testing || !testInput.trim()) return setTestError('พิมพ์ input ก่อนรัน')
    setTestRunning(true)
    setTestError('')
    try {
      const res = await authFetch(`${API}/skills/${testing.id}/tests/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: [testInput.trim()] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      applySkill(data)
    } catch (err) {
      setTestError(err.message)
    }
    setTestRunning(false)
  }

  async function restoreVersion(skill, version) {
    const res = await authFetch(`${API}/skills/${skill.id}/restore/${version}`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) return setTestError(data.detail || `HTTP ${res.status}`)
    applySkill(data)
  }

  async function toggle(skill) {
    const res = await authFetch(`${API}/skills/${skill.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !skill.enabled }),
    })
    const updated = await res.json()
    if (!res.ok) return setListError(updated.detail || `HTTP ${res.status}`)
    setListError('')
    setSkills(list => list.map(s => (s.id === updated.id ? updated : s)))
  }

  async function remove(skill) {
    const res = await authFetch(`${API}/skills/${skill.id}`, { method: 'DELETE' })
    // Only drop it from the list after the server confirms — a failed delete
    // used to vanish from the UI and reappear on the next load.
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return setListError(data.detail || `HTTP ${res.status}`)
    }
    setListError('')
    setSkills(list => list.filter(s => s.id !== skill.id))
  }

  return (
    <>
      <PageHeader
        icon={Wrench}
        title="Skills"
        subtitle="Capabilities available to AI agent containers — เพิ่ม/ลบ/เปิด-ปิดได้จากที่นี่"
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4" /> Add Skill</Button>}
      />

      <div className="page-body">
        {listError && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-300" data-testid="skills-error">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {listError}
          </div>
        )}
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(290px,1fr))]">
          {skills === null && [0, 1, 2].map(i => (
            <Card key={i} className="h-[170px] p-4">
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton mt-4 h-3 w-4/5" />
              <div className="skeleton mt-2 h-3 w-3/5" />
            </Card>
          ))}
          {skills?.length === 0 && (
            <Card className="col-span-full flex flex-col items-center gap-3 border-dashed bg-card/40 p-10 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.03]">
                <Wrench className="h-5 w-5 text-muted-foreground/40" />
              </div>
              <div>
                <div className="text-[14px] font-semibold text-white">No skills yet</div>
                <div className="mt-1 text-[12.5px] text-muted-foreground">Add your first capability for the AI team.</div>
              </div>
              <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4" /> Add Skill</Button>
            </Card>
          )}
          {skills?.map(s => (
            <Card key={s.id} className="group flex flex-col gap-3 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.1] hover:shadow-lift" data-testid="skill-card">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset',
                    s.enabled ? 'bg-primary/[0.1] text-primary ring-primary/15' : 'bg-white/[0.04] text-muted-foreground/50 ring-white/[0.06]')}>
                    <Wrench className="h-3.5 w-3.5" />
                  </span>
                  <div className="text-[13.5px] font-semibold text-white">{s.name}</div>
                </div>
                <Badge variant={s.enabled ? 'green' : 'gray'} data-testid="skill-status">
                  {s.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
              <div className="line-clamp-2 min-h-[36px] text-[12px] leading-relaxed text-muted-foreground/75">{s.description || '—'}</div>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" className="h-7 flex-1 gap-1.5 text-[11.5px]" onClick={() => openTest(s)} data-testid={`skill-test-${s.id}`}>
                  <FlaskConical className="h-3.5 w-3.5" /> Test
                </Button>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[11.5px]" onClick={() => setHistorySkill(s)} data-testid={`skill-history-${s.id}`}>
                  <History className="h-3.5 w-3.5" /> v{s.version}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 w-7 px-0 text-muted-foreground/50 hover:text-primary" onClick={() => openEdit(s)} aria-label="Edit skill" data-testid={`skill-edit-${s.id}`}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-white/[0.05] pt-3">
                <code className="rounded-md bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/60 ring-1 ring-inset ring-white/[0.05]">{s.id}</code>
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" data-testid="skill-toggle" onClick={() => toggle(s)}>
                    {s.enabled ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                    {s.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-8 px-0 text-muted-foreground/50 hover:bg-red-500/10 hover:text-red-400"
                    data-testid={`skill-delete-${s.id}`}
                    onClick={() => remove(s)}
                    aria-label="Delete skill"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSkill ? `Edit — ${editingSkill.name}` : 'Add Skill'}</DialogTitle>
            <DialogDescription>{editingSkill ? 'แก้ชื่อ/คำอธิบาย — ระบบเก็บ version เดิมไว้ใน history' : 'Create a new capability for AI agents.'}</DialogDescription>
          </DialogHeader>
          <form onSubmit={createSkill} className="grid gap-4 pt-2">
            <div className="grid gap-1.5">
              <label htmlFor="skill-name" className="text-[13px] font-medium">Skill name</label>
              <Input
                id="skill-name"
                placeholder="e.g. PDF Generation"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="skill-desc" className="text-[13px] font-medium">Description</label>
              <Textarea
                id="skill-desc"
                placeholder="What does this skill let the agent do?"
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
              />
            </div>
            {formError && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400">{formError}</div>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={creating}>{creating ? 'Saving…' : editingSkill ? 'Save changes' : 'Create Skill'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Skill Studio — test bench: saved inputs, a real provider run, results */}
      <Dialog open={!!testing} onOpenChange={open => { if (!open) setTesting(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FlaskConical className="h-4 w-4 text-primary" /> Test — {testing?.name}</DialogTitle>
            <DialogDescription>รันด้วย provider/model ที่ตั้งไว้จริง ค่าใช้จ่ายบันทึกที่ test run นี้เท่านั้น (ไม่ผูกกับ mission)</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {testing?.test_inputs?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/50">Saved inputs</span>
                {testing.test_inputs.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTestInput(t)}
                    className={cn(
                      'max-w-[240px] truncate rounded-full px-2.5 py-1 text-[10.5px] font-medium ring-1 ring-inset',
                      testInput === t ? 'bg-primary/15 text-primary ring-primary/30' : 'bg-white/[0.03] text-muted-foreground/70 ring-white/[0.06] hover:text-foreground',
                    )}
                    title={t}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            <Textarea
              className="min-h-[80px] text-[12.5px]"
              placeholder="ใส่อินพุตที่ต้องการทดสอบ skill นี้…"
              value={testInput}
              onChange={e => setTestInput(e.target.value)}
              data-testid="skill-test-input"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={runTest} disabled={testRunning || !testInput.trim()} data-testid="skill-test-run">
                {testRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} Run test
              </Button>
              <Button size="sm" variant="outline" onClick={saveTestInput} disabled={!testInput.trim()} data-testid="skill-test-save">
                <Plus className="h-3.5 w-3.5" /> Save input
              </Button>
              <span className="text-[10.5px] text-muted-foreground/50">เก็บได้สูงสุด 20 inputs</span>
            </div>
            {testError && <div className="flex items-center gap-2 rounded-md bg-red-500/15 px-3 py-2 text-[12px] text-red-400"><AlertCircle className="h-3.5 w-3.5 shrink-0" /> {testError}</div>}

            <div className="grid gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Run history</div>
              {testing?.test_runs?.length ? (
                <div className="flex max-h-[320px] flex-col gap-2 overflow-auto pr-1">
                  {testing.test_runs.map(r => (
                    <div key={r.id} className="rounded-lg border border-white/[0.06] bg-[#0d1420] p-2.5" data-testid="skill-test-result">
                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/50">
                        <span className="font-mono">{r.model}</span>
                        <span>· {new Date(r.at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                        {r.cost_usd > 0 && <span>· ${r.cost_usd.toFixed(4)}</span>}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground/70"><span className="font-semibold text-foreground/70">in:</span> {r.input}</div>
                      <div className="mt-1 whitespace-pre-wrap rounded-md bg-black/30 px-2 py-1.5 text-[11.5px] leading-relaxed text-foreground/85">{r.output}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-white/[0.07] px-3 py-5 text-center text-[11.5px] text-muted-foreground/50">ยังไม่มีผลทดสอบ — รันสักครั้งแล้วผลจะถูกเก็บไว้ 20 รายการล่าสุด</div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Version history — every edit snapshots the previous values */}
      <Dialog open={!!historySkill} onOpenChange={open => { if (!open) setHistorySkill(null) }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><History className="h-4 w-4 text-primary" /> History — {historySkill?.name}</DialogTitle>
            <DialogDescription>เวอร์ชันปัจจุบัน v{historySkill?.version} · กด Restore เพื่อย้อนกลับ (ระบบ snapshot ปัจจุบันไว้ก่อน)</DialogDescription>
          </DialogHeader>
          {historySkill?.history?.length ? (
            <div className="flex max-h-[320px] flex-col gap-2 overflow-auto pr-1" data-testid="skill-history">
              {historySkill.history.map(h => (
                <div key={`${h.version}-${h.at}`} className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-[#0d1420] p-2.5">
                  <Badge variant="gray" className="mt-0.5 shrink-0 font-mono text-[9.5px]">v{h.version}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-semibold text-foreground/85">{h.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/65">{h.description || '—'}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground/45">
                      {h.enabled ? 'enabled' : 'disabled'} · {new Date(h.at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-[11px]" onClick={() => restoreVersion(historySkill, h.version)} data-testid="skill-restore">
                    <RotateCcw className="h-3 w-3" /> Restore
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-white/[0.07] px-3 py-5 text-center text-[11.5px] text-muted-foreground/50" data-testid="skill-history-empty">ยังไม่มีประวัติ — เมื่อแก้ชื่อ/คำอธิบาย version เดิมจะถูกเก็บไว้ที่นี่</div>
          )}
          {testError && <div className="mt-1 rounded-md bg-red-500/15 px-3 py-2 text-[12px] text-red-400">{testError}</div>}
        </DialogContent>
      </Dialog>
    </>
  )
}
