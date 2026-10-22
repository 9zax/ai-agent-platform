'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FolderKanban, Plus, Trash2, Users, Network } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

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
      <div className="flex items-center justify-between px-7 pb-1 pt-5">
        <div>
          <h1 className="flex items-center gap-2.5 text-[21px] font-bold tracking-tight">
            <FolderKanban className="h-5 w-5 text-primary" /> Projects
          </h1>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">สร้างได้หลาย project — แต่ละอันประกอบทีม AI และกำหนดว่าใครคุยกับใคร</div>
        </div>
        <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> New Project</Button>
      </div>

      <div className="grid gap-3.5 px-7 py-5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        {projects === null && <div className="text-muted-foreground/70">Loading…</div>}
        {projects?.length === 0 && (
          <Card className="col-span-full flex flex-col items-center gap-3 p-10 text-center">
            <Network className="h-8 w-8 text-muted-foreground/40" />
            <div className="text-[14px] font-semibold">ยังไม่มี project</div>
            <div className="text-[12.5px] text-muted-foreground/70">สร้าง project แรก แล้วประกอบทีม AI ด้วย drag & drop</div>
            <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" /> New Project</Button>
          </Card>
        )}
        {projects?.map(p => (
          <Card key={p.id} className="flex flex-col gap-3 p-4 transition-colors hover:border-primary/40" data-testid="project-card">
            <Link href={`/projects/${p.id}`} className="text-[15px] font-bold hover:text-primary" data-testid="project-open">{p.name}</Link>
            <div className="text-[12px] leading-relaxed text-muted-foreground/80">{p.description || '—'}</div>
            <div className="mt-auto flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground/70">
                <Users className="h-3.5 w-3.5" /> {p.agents.length} agents · {p.links.length} links
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="gray" className="font-mono text-[10px]">{p.id}</Badge>
                <Button size="sm" variant="ghost" className="text-red-400 hover:bg-red-500/10 hover:text-red-400" onClick={() => remove(p.id)}>
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
            <DialogTitle>New Project</DialogTitle>
            <DialogDescription>สร้าง project แล้วเข้าไปประกอบทีม AI ใน flow editor</DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="project-name" className="text-[13px] font-medium">Project name</label>
              <Input id="project-name" value={form.name} placeholder="e.g. ระบบจองห้องประชุม" onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="project-desc" className="text-[13px] font-medium">Description</label>
              <Textarea id="project-desc" value={form.description} placeholder="ทำอะไร ขอบเขตไหน" onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>
            {error && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400">{error}</div>}
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
