'use client'

import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const TAG_BY_CATEGORY = {
  Backend: 'purple', Frontend: 'cyan', Bug: 'pink', Docs: 'gray',
  Refactor: 'blue', Design: 'pink', Database: 'green', General: 'gray',
}
const PRIO_COLOR = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' }

const COLUMNS = [
  { key: 'todo', title: 'To Do', dot: 'bg-slate-400', sub: 'Not started' },
  { key: 'in_progress', title: 'In Progress', dot: 'bg-blue-500', sub: 'Active work' },
  { key: 'done', title: 'Done', dot: 'bg-emerald-500', sub: 'Completed' },
]

export default function Board() {
  const [query, setQuery] = useState('')
  const [tasks, setTasks] = useState([])
  const [addingTo, setAddingTo] = useState(null)
  const [newTitle, setNewTitle] = useState('')
  const [saving, setSaving] = useState(false)

  async function loadTasks() {
    try {
      const res = await fetch(`${API}/tasks`)
      setTasks(await res.json())
    } catch {
      setTasks([])
    }
  }

  useEffect(() => { loadTasks() }, [])

  async function addTask(status) {
    if (!newTitle.trim()) return
    setSaving(true)
    try {
      await fetch(`${API}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), status }),
      })
      setNewTitle('')
      setAddingTo(null)
      await loadTasks()
    } finally {
      setSaving(false)
    }
  }

  const columns = useMemo(() => COLUMNS.map(col => ({
    ...col,
    tasks: tasks
      .filter(t => t.status === col.key)
      .filter(t => !query || t.title.toLowerCase().includes(query.toLowerCase()) || (t.category || '').toLowerCase().includes(query.toLowerCase())),
  })), [tasks, query])

  return (
    <>
      <div className="flex items-center justify-between px-7 pb-1 pt-5">
        <div>
          <h1 className="text-[21px] font-bold tracking-tight">AI Orchestrator Board</h1>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">Agent Performance · Team Overview</div>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground/60" />
            <Input
              className="w-[200px] pl-8"
              placeholder="Search tasks..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <Avatar><AvatarFallback>AD</AvatarFallback></Avatar>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 px-7 py-5">
        {columns.map(col => (
          <div key={col.key} className="rounded-xl border bg-[#0d1420] p-3.5" data-testid="board-col">
            <div className="flex items-center gap-2 text-[13.5px] font-bold" data-testid="board-col-head">
              <span className={`h-2 w-2 rounded-full ${col.dot}`} />
              {col.title}
              <span className="text-[12px] font-semibold text-muted-foreground/70">{col.tasks.length}</span>
            </div>
            <div className="mb-3 mt-0.5 text-[11px] text-muted-foreground/70">{col.sub}</div>
            {col.tasks.map(t => (
              <article key={t.id} data-testid="task-card" className="mb-2.5 rounded-[10px] border bg-card p-3.5 transition-colors hover:border-muted-foreground/30">
                <div className="mb-1 text-[13px] font-semibold">{t.title}</div>
                {t.description && <div className="mb-2.5 text-[11.5px] leading-relaxed text-muted-foreground/70">{t.description}</div>}
                <div className="mb-2.5">
                  <Badge variant={TAG_BY_CATEGORY[t.category] || 'gray'}>{t.category || 'General'}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                    <span className="h-2 w-2 rounded-full" style={{ background: PRIO_COLOR[t.priority] || PRIO_COLOR.medium }} /> {t.due || '—'}
                  </div>
                  <Avatar className="h-6 w-6"><AvatarFallback className="text-[10px]">{t.agent || 'AD'}</AvatarFallback></Avatar>
                </div>
              </article>
            ))}

            {addingTo === col.key ? (
              <div className="mb-2.5 rounded-[10px] border bg-card p-3">
                <Input
                  autoFocus
                  placeholder="Task title..."
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addTask(col.key)}
                />
                <div className="mt-2 flex gap-2">
                  <Button size="sm" className="flex-1" disabled={saving || !newTitle.trim()} onClick={() => addTask(col.key)}>
                    {saving ? 'Adding…' : 'Add Task'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setAddingTo(null); setNewTitle('') }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                className="w-full border border-dashed border-muted-foreground/30 text-[12.5px] font-semibold text-muted-foreground/70 hover:text-muted-foreground"
                onClick={() => { setAddingTo(col.key); setNewTitle('') }}
              >
                + Add Task
              </Button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
