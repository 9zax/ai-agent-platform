'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Check, Plus, X, Trash2, Wrench } from 'lucide-react'
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
      <PageHeader
        icon={Wrench}
        title="Skills"
        subtitle="Capabilities available to AI agent containers — เพิ่ม/ลบ/เปิด-ปิดได้จากที่นี่"
        actions={<Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> Add Skill</Button>}
      />

      <div className="page-body">
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
              <Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> Add Skill</Button>
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
