'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FolderKanban, Plus, Trash2, Users, Network, ArrowUpRight, Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import PageHeader from '@/components/page-header'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function ProjectsPage() {
  const [projects, setProjects] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const res = await authFetch(`${API}/projects`)
      setProjects(await res.json())
    } catch {
      setProjects([])
    }
  }

  useEffect(() => { load() }, [])

  async function create(e) {
    e.preventDefault()
    if (!form.name.trim()) return setError('Name is required')
    setSaving(true)
    setError('')
    try {
      const res = await authFetch(`${API}/projects`, {
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
      setError(err.message)
    }
    setSaving(false)
  }

  async function remove(id) {
    await authFetch(`${API}/projects/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <>
      <PageHeader
        icon={FolderKanban}
        title="Projects"
        subtitle="แต่ละ project มีทีม AI ของตัวเอง — กำหนดว่าใครคุยกับใคร และเก็บเอกสารร่วมกัน"
        actions={<Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> New Project</Button>}
      />

      <div className="page-body">
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(310px,1fr))]">
          {projects === null && [0, 1, 2].map(i => (
            <Card key={i} className="h-[186px] p-5">
              <div className="skeleton h-9 w-9 rounded-xl" />
              <div className="skeleton mt-4 h-4 w-1/2" />
              <div className="skeleton mt-3 h-3 w-4/5" />
              <div className="skeleton mt-2 h-3 w-3/5" />
            </Card>
          ))}

          {projects?.length === 0 && (
            <Card className="col-span-full flex flex-col items-center gap-4 border-dashed bg-card/40 p-12 text-center" data-testid="projects-empty">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03]">
                <Network className="h-5 w-5 text-muted-foreground/50" />
              </div>
              <div>
                <div className="text-[15px] font-semibold text-white">ยังไม่มี project</div>
                <div className="mt-1 text-[12.5px] text-muted-foreground">สร้าง project แรก แล้วประกอบทีม AI ด้วย drag & drop</div>
              </div>
              <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> New Project</Button>
            </Card>
          )}

          {projects?.map(p => (
            <Card
              key={p.id}
              className="group relative flex flex-col overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lift"
              data-testid="project-card"
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

              <div className="flex items-start justify-between gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
                  <FolderKanban className="h-[17px] w-[17px]" />
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant="gray" className="font-mono text-[9.5px] uppercase">{p.id}</Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground/40 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                    title="Delete project"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => remove(p.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <Link href={`/projects/${p.id}`} className="mt-4 flex items-center gap-1.5 text-[15px] font-semibold tracking-[-0.015em] text-white transition-colors hover:text-primary" data-testid="project-open">
                <span className="truncate">{p.name}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 transition-all group-hover:text-primary/70" />
              </Link>
              <div className="mt-1.5 line-clamp-2 min-h-[36px] text-[12px] leading-relaxed text-muted-foreground/75">{p.description || 'ยังไม่มีคำอธิบาย project'}</div>

              <div className="mt-4 flex items-center gap-2 border-t border-white/[0.05] pt-3.5 text-[11px] text-muted-foreground/60">
                <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> {p.agents.length} agents</span>
                <span className="text-muted-foreground/25">·</span>
                <span className="flex items-center gap-1.5"><Network className="h-3.5 w-3.5" /> {p.links.length} links</span>
                <span className="ml-auto flex items-center gap-1 font-medium text-primary/70 opacity-0 transition-opacity group-hover:opacity-100">
                  เปิด <ArrowUpRight className="h-3 w-3" />
                </span>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
            <DialogTitle>New Project</DialogTitle>
            <DialogDescription>สร้าง project แล้วเข้าไปประกอบทีม AI ใน flow editor</DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="project-name" className="field-label">Project name</label>
              <Input id="project-name" value={form.name} placeholder="e.g. ระบบจองห้องประชุม" onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="project-desc" className="field-label">Description</label>
              <Textarea id="project-desc" value={form.description} placeholder="ทำอะไร ขอบเขตไหน" onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>
            {error && <div className="rounded-lg border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[12.5px] text-red-300">{error}</div>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving} data-testid="create-project">{saving ? 'Creating…' : 'Create Project'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
