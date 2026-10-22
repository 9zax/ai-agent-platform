'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Check, Plus, X, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function SkillsPage() {
  const [skills, setSkills] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)

  async function load() {
    try {
      const res = await authFetch(`${API}/skills`)
      setSkills(await res.json())
    } catch {
      setSkills([])
    }
  }

  useEffect(() => { load() }, [])

  async function createSkill(e) {
    e.preventDefault()
    if (!form.name.trim()) return setFormError('Name is required')
    setCreating(true)
    setFormError('')
    try {
      const res = await authFetch(`${API}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setDialogOpen(false)
      setForm({ name: '', description: '' })
      await load()
    } catch (err) {
      setFormError(err.message)
    }
    setCreating(false)
  }

  async function toggle(skill) {
    const res = await authFetch(`${API}/skills/${skill.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !skill.enabled }),
    })
    const updated = await res.json()
    setSkills(list => list.map(s => (s.id === updated.id ? updated : s)))
  }

  async function remove(skill) {
    await authFetch(`${API}/skills/${skill.id}`, { method: 'DELETE' })
    setSkills(list => list.filter(s => s.id !== skill.id))
  }

  return (
    <>
      <div className="flex items-center justify-between px-7 pb-1 pt-5">
        <div>
          <h1 className="text-[21px] font-bold tracking-tight">Skills</h1>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">Capabilities available to AI agent containers — เพิ่ม/ลบ/เปิด-ปิดได้จากที่นี่</div>
        </div>
        <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> Add Skill</Button>
      </div>

      <div className="grid gap-3.5 px-7 py-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {skills === null && <div className="text-muted-foreground/70">Loading skills…</div>}
        {skills?.length === 0 && <div className="text-muted-foreground/70">No skills yet — add your first one.</div>}
        {skills?.map(s => (
          <Card key={s.id} className="flex flex-col gap-3 p-4" data-testid="skill-card">
            <div className="flex items-start justify-between gap-3">
              <div className="text-[14px] font-bold">{s.name}</div>
              <Badge variant={s.enabled ? 'green' : 'gray'} data-testid="skill-status">
                {s.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <div className="text-[12.5px] leading-relaxed text-muted-foreground/80">{s.description || '—'}</div>
            <div className="mt-auto flex items-center justify-between">
              <code className="rounded bg-secondary px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{s.id}</code>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" data-testid="skill-toggle" onClick={() => toggle(s)}>
                  {s.enabled ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  {s.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                  data-testid={`skill-delete-${s.id}`}
                  onClick={() => remove(s)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Skill</DialogTitle>
            <DialogDescription>Create a new capability for AI agents.</DialogDescription>
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
              <Button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create Skill'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
