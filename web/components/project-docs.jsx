'use client'

// ProjectDocs — the per-project document space (Confluence-style): PO / BA / SA
// and general documents, written in-app (markdown) or uploaded as files. The
// orchestrator materializes this space into the shared agent workspace at every
// run, so the team reads the same documents the human maintains here.

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Eye, Code2, Plus, Upload, Download, Pencil, Trash2, FileText, File as FileIcon,
  Search, Loader2, AlertCircle, FolderOpen, Clock, Sparkles,
} from 'lucide-react'
import { marked } from 'marked'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const QUICK_FOLDERS = ['PO', 'BA', 'SA', 'General']
const EMPTY_FORM = { title: '', folder: 'General', content_md: '' }

function fmtDate(secs) {
  if (!secs) return ''
  return new Date(secs * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function FileTypeIcon({ file, className }) {
  if (!file) return <FileText className={className} />
  return <FileIcon className={className} />
}

export function ProjectDocs({ projectId }) {
  const [docs, setDocs] = useState(null) // null = loading
  const [folder, setFolder] = useState('All')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null = create mode
  const [form, setForm] = useState(EMPTY_FORM)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [formError, setFormError] = useState('')
  const [error, setError] = useState('')
  const uploadRef = useRef(null)

  const load = useCallback(() => {
    authFetch(`${API}/projects/${projectId}/docs`).then(r => r.json()).then(d => {
      setDocs(Array.isArray(d) ? d : [])
    }).catch(() => setDocs([]))
  }, [projectId])

  useEffect(() => { load() }, [load])

  const folders = ['All', ...Array.from(new Set((docs || []).map(d => d.folder))).sort()]
  const counts = useMemo(() => {
    const map = { All: (docs || []).length }
    for (const d of docs || []) map[d.folder] = (map[d.folder] || 0) + 1
    return map
  }, [docs])
  const visible = (docs || []).filter(d =>
    (folder === 'All' || d.folder === folder)
    && (!search.trim() || d.title.toLowerCase().includes(search.trim().toLowerCase()))
  )

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, folder: folder === 'All' ? 'General' : folder })
    setPreview(false)
    setFormError('')
    setDialogOpen(true)
  }

  function openEdit(doc) {
    setEditing(doc)
    setForm({ title: doc.title, folder: doc.folder, content_md: doc.content_md || '' })
    setPreview(false)
    setFormError('')
    setDialogOpen(true)
  }

  async function save(e) {
    e.preventDefault()
    if (!form.title.trim()) return setFormError('กรอกชื่อเอกสารก่อน')
    setSaving(true)
    setFormError('')
    try {
      const res = await authFetch(editing ? `${API}/projects/${projectId}/docs/${editing.id}` : `${API}/projects/${projectId}/docs`, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setDialogOpen(false)
      load()
      setSelected(data)
    } catch (err) {
      setFormError(err.message)
    }
    setSaving(false)
  }

  async function upload(file) {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('folder', folder === 'All' ? 'General' : folder)
      fd.append('file', file)
      // NOTE: no Content-Type header — the browser must set the multipart boundary
      const res = await authFetch(`${API}/projects/${projectId}/docs/upload`, { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      load()
      setSelected(data)
    } catch (err) {
      setError(err.message)
    }
    setUploading(false)
    if (uploadRef.current) uploadRef.current.value = ''
  }

  async function download(doc) {
    try {
      const res = await authFetch(`${API}/projects/${projectId}/docs/${doc.id}?raw=1`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = doc.file?.name || `${doc.title}.md`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(`ดาวน์โหลดไม่สำเร็จ: ${err.message}`)
    }
  }

  async function remove(doc) {
    setError('')
    const res = await authFetch(`${API}/projects/${projectId}/docs/${doc.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return setError(data.detail || `HTTP ${res.status}`)
    }
    if (selected?.id === doc.id) setSelected(null)
    load()
  }

  return (
    <div data-testid="project-docs" className="grid items-start gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      {/* ---- left: folders + document list ---- */}
      <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-card/80 shadow-card">
        <div className="border-b border-white/[0.05] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-white">
                <FolderOpen className="h-4 w-4 text-primary" /> เอกสารโครงการ
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground/55">
                ทีม AI อ่านเอกสารชุดนี้อัตโนมัติทุกครั้งที่รัน mission
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={uploading} onClick={() => uploadRef.current?.click()} data-testid="doc-upload" className="flex-1">
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
            <Button size="sm" onClick={openCreate} data-testid="doc-new" className="flex-1">
              <Plus className="h-3.5 w-3.5" /> New
            </Button>
          </div>

          <div className="relative mt-3">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              className="h-8 pl-8 text-[12px]"
              placeholder="ค้นหาเอกสาร..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search documents"
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {folders.map(f => (
              <button
                key={f}
                onClick={() => setFolder(f)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[10.5px] font-semibold ring-1 ring-inset transition-colors',
                  folder === f
                    ? 'bg-primary/15 text-primary ring-primary/30'
                    : 'bg-white/[0.03] text-muted-foreground/70 ring-white/[0.06] hover:bg-white/[0.06] hover:text-foreground',
                )}
                data-testid={`doc-folder-${f}`}
              >
                {f}
                <span className={cn('ml-1 tabular-nums', folder === f ? 'text-primary/60' : 'text-muted-foreground/40')}>{counts[f] || 0}</span>
              </button>
            ))}
          </div>

          <input
            ref={uploadRef}
            type="file"
            className="hidden"
            data-testid="doc-upload-input"
            onChange={e => upload(e.target.files?.[0])}
          />
        </div>

        <div className="max-h-[540px] overflow-y-auto p-2">
          {error && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-500/[0.07] px-2.5 py-2 text-[11.5px] leading-relaxed text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {docs === null ? (
            <div className="space-y-2 p-1" data-testid="docs-loading">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                  <div className="skeleton h-8 w-8 rounded-lg" />
                  <div className="flex-1">
                    <div className="skeleton h-3 w-2/3" />
                    <div className="skeleton mt-1.5 h-2.5 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="px-4 py-10 text-center" data-testid="docs-empty">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.03]">
                <FileText className="h-5 w-5 text-muted-foreground/40" />
              </div>
              <div className="mt-3 text-[12.5px] font-medium text-foreground/80">
                {search ? 'ไม่พบเอกสารที่ค้นหา' : 'ยังไม่มีเอกสาร'}
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground/55">
                {search ? 'ลองใช้คำค้นอื่น หรือเปลี่ยนหมวด' : 'เขียนเอกสารใหม่ หรืออัปโหลดไฟล์ .md / .pdf / .docx'}
              </div>
              {!search && (
                <div className="mt-3 flex items-center justify-center gap-1.5">
                  <Button size="sm" onClick={openCreate}><Plus className="h-3.5 w-3.5" /> New</Button>
                  <Button size="sm" variant="outline" onClick={() => uploadRef.current?.click()} disabled={uploading}>
                    <Upload className="h-3.5 w-3.5" /> Upload
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {visible.map(doc => {
                const active = selected?.id === doc.id
                return (
                  <div
                    key={doc.id}
                    className={cn(
                      'group relative flex items-center gap-1 rounded-lg pr-1 transition-colors',
                      active ? 'bg-primary/[0.09]' : 'hover:bg-white/[0.03]',
                    )}
                    data-testid="doc-row"
                    data-doc-id={doc.id}
                  >
                    {active && <span className="absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-primary" />}
                    <button className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left" onClick={() => setSelected(doc)} data-testid="doc-open">
                      <span className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset',
                        doc.file ? 'bg-sky-500/[0.09] text-sky-300 ring-sky-400/15' : 'bg-primary/[0.09] text-primary ring-primary/15',
                      )}>
                        <FileTypeIcon file={doc.file} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-[12.5px] font-medium', active ? 'text-white' : 'text-foreground/85')} data-testid="doc-title">{doc.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                          <span>{doc.folder}</span>
                          <span className="text-muted-foreground/25">·</span>
                          <span>{fmtDate(doc.updated_at)}</span>
                        </span>
                      </span>
                    </button>
                    <span className={cn(
                      'flex shrink-0 items-center gap-0.5 transition-opacity',
                      active ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
                    )}>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground/50 hover:text-foreground" title="Download" aria-label="Download document" onClick={() => download(doc)} data-testid="doc-download"><Download className="h-3.5 w-3.5" /></Button>
                      {!doc.file && <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground/50 hover:text-primary" title="Edit" aria-label="Edit document" onClick={() => openEdit(doc)} data-testid="doc-edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground/40 hover:bg-red-500/10 hover:text-red-400" title="Delete" aria-label="Delete document" onClick={() => remove(doc)} data-testid="doc-delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ---- right: document viewer ---- */}
      <div className="min-h-[420px] overflow-hidden rounded-2xl border border-white/[0.06] bg-card/80 shadow-card">
        {selected ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.05] px-5 py-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset',
                  selected.file ? 'bg-sky-500/[0.09] text-sky-300 ring-sky-400/15' : 'bg-primary/[0.09] text-primary ring-primary/15',
                )}>
                  <FileTypeIcon file={selected.file} className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-[15px] font-semibold tracking-[-0.015em] text-white" data-testid="doc-view-title">{selected.title}</h2>
                    <Badge variant="purple" data-testid="doc-folder-badge">{selected.folder}</Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground/50">
                    <Clock className="h-3 w-3" /> อัปเดต {fmtDate(selected.updated_at)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="outline" onClick={() => download(selected)} data-testid="doc-view-download"><Download className="h-3.5 w-3.5" /> Download</Button>
                {!selected.file && <Button size="sm" variant="outline" onClick={() => openEdit(selected)} data-testid="doc-view-edit"><Pencil className="h-3.5 w-3.5" /> Edit</Button>}
              </div>
            </div>

            {selected.file ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-20 text-center" data-testid="doc-view">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/15 bg-sky-500/[0.08]">
                  <FileIcon className="h-6 w-6 text-sky-300" />
                </div>
                <div className="mt-2 text-[13px] font-semibold text-white">{selected.file.name}</div>
                <div className="text-[11.5px] text-muted-foreground/55">
                  ไฟล์แนบ · {(selected.file.size / 1024).toFixed(1)} KB · {selected.file.content_type}
                </div>
                <div className="mt-2 max-w-sm text-[11.5px] leading-relaxed text-muted-foreground/45">
                  ทีม AI เห็นไฟล์นี้ใน workspace (project-docs) — โหมด execute เปิดอ่านได้ตรง ๆ
                </div>
                <Button size="sm" className="mt-3" onClick={() => download(selected)}><Download className="h-3.5 w-3.5" /> Download</Button>
              </div>
            ) : (
              <div className="px-6 py-5">
                <div
                  data-testid="doc-view"
                  className="doc-prose min-h-[300px]"
                  dangerouslySetInnerHTML={{ __html: marked.parse(selected.content_md || '_เอกสารนี้ยังไม่มีเนื้อหา_') }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 px-6 text-center" data-testid="doc-view-empty">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.025]">
              <FileText className="h-6 w-6 text-muted-foreground/35" />
            </div>
            <div>
              <div className="text-[13px] font-medium text-foreground/80">เลือกเอกสารจากรายการซ้ายเพื่อเปิดอ่าน</div>
              <div className="mt-1 text-[11.5px] text-muted-foreground/45">หรือสร้างเอกสารใหม่ให้ทีม AI ใช้อ้างอิงตอนทำงาน</div>
            </div>
            <Button size="sm" variant="outline" className="mt-1" onClick={openCreate}><Sparkles className="h-3.5 w-3.5" /> เขียนเอกสารใหม่</Button>
          </div>
        )}
      </div>

      {/* ---- create / edit dialog ---- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit — ${editing.title}` : 'เอกสารใหม่'}</DialogTitle>
            <DialogDescription>เก็บ requirement/spec/วิเคราะห์ ไว้ในโปรเจกต์ — ทีม AI อ่านอัตโนมัติตอนรัน mission</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_260px]">
              <div className="grid gap-1.5">
                <label className="field-label">ชื่อเอกสาร</label>
                <Input value={form.title} placeholder="เช่น Product Requirements" onChange={e => setForm({ ...form, title: e.target.value })} data-testid="doc-title-input" />
              </div>
              <div className="grid gap-1.5">
                <label className="field-label">หมวด</label>
                <div className="flex items-center gap-1.5">
                  {QUICK_FOLDERS.map(f => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setForm({ ...form, folder: f })}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-[10.5px] font-semibold ring-1 ring-inset transition-colors',
                        form.folder === f
                          ? 'bg-primary/15 text-primary ring-primary/30'
                          : 'bg-white/[0.03] text-muted-foreground/70 ring-white/[0.06] hover:bg-white/[0.06] hover:text-foreground',
                      )}
                      data-testid="doc-folder-pick"
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <label className="field-label">เนื้อหา (Markdown)</label>
                <Button type="button" variant="ghost" size="sm" data-testid="md-toggle" className="h-7 gap-1.5 px-2 text-[11.5px]" onClick={() => setPreview(p => !p)}>
                  {preview ? <><Code2 className="h-3.5 w-3.5" /> Edit</> : <><Eye className="h-3.5 w-3.5" /> Preview</>}
                </Button>
              </div>
              {preview ? (
                <div
                  data-testid="md-preview"
                  className="doc-prose min-h-[280px] rounded-xl border border-white/[0.08] bg-black/20 p-4"
                  dangerouslySetInnerHTML={{ __html: marked.parse(form.content_md || '_ไม่มีเนื้อหา_') }}
                />
              ) : (
                <Textarea
                  data-testid="md-editor"
                  className="min-h-[280px] resize-y rounded-xl font-mono text-[12px] leading-relaxed"
                  placeholder={'# Product Requirements\n\n## Problem\n...\n\n## Goals\n- ...'}
                  value={form.content_md}
                  onChange={e => setForm({ ...form, content_md: e.target.value })}
                />
              )}
              <div className="flex items-center justify-between text-[10.5px] text-muted-foreground/40">
                <span>Markdown · หัวข้อ, list, ตาราง และ code block รองรับ</span>
                <span className="tabular-nums">{form.content_md.length.toLocaleString()} chars</span>
              </div>
            </div>

            {formError && (
              <div className="flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[12.5px] text-red-300">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {formError}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving} data-testid="doc-save">{saving ? 'Saving…' : 'Save'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
