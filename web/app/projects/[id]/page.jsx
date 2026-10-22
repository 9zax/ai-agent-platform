'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, Handle, Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { marked } from 'marked'
import { Save, Plus, ArrowLeft, Send, Loader2, CheckCircle2, XCircle, Clock, Container, ChevronDown } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function PersonaNode({ data }) {
  return (
    <div className="min-w-[170px] rounded-xl border-2 border-primary/50 bg-card p-3 shadow-lg" data-testid="flow-node">
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-primary !bg-background" />
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold">{data.name}</span>
        <Badge variant="purple" className="text-[9px]">{data.years}y</Badge>
      </div>
      <div className="mt-0.5 text-[11px] font-medium text-primary">{data.title}</div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground/70">{data.role}</div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-primary !bg-background" />
    </div>
  )
}

const nodeTypes = { persona: PersonaNode }

function StepStatusIcon({ status }) {
  if (status === 'working') return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-400" />
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-400" />
  return <Clock className="h-4 w-4 text-muted-foreground/50" />
}

function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

export default function ProjectFlow() {
  const params = useParams()
  const router = useRouter()
  const id = params.id

  const [project, setProject] = useState(null)
  const [personas, setPersonas] = useState([])
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // Team run state
  const [task, setTask] = useState('')
  const [run, setRun] = useState(null)
  const [dispatching, setDispatching] = useState(false)
  const [runError, setRunError] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const outputRef = useRef(null)

  useEffect(() => {
    authFetch(`${API}/projects/${id}`).then(r => r.json()).then(p => {
      if (p.detail) { setError(p.detail); return }
      setProject(p)
      const initial = (p.agents || []).map((role, i) => ({
        id: role,
        type: 'persona',
        position: p.positions?.[role] || { x: 80 + (i % 4) * 220, y: 60 + Math.floor(i / 4) * 140 },
        data: { role, name: role, title: '', years: '' },
      }))
      setNodes(initial)
      setEdges((p.links || []).map((l, i) => ({
        id: `e-${l.from}-${l.to}-${i}`,
        source: l.from,
        target: l.to,
        animated: true,
      })))
    }).catch(e => setError(String(e)))
    authFetch(`${API}/agents`).then(r => r.json()).then(setPersonas).catch(() => setPersonas([]))
    // restore the latest run for this project
    authFetch(`${API}/runs`).then(r => r.json()).then(runs => {
      const mine = (Array.isArray(runs) ? runs : []).filter(r => r.project_id === id)
      if (mine.length) setRun(mine[0])
    }).catch(() => {})
  }, [id, setNodes, setEdges])

  // Enrich node data when personas arrive
  useEffect(() => {
    if (!personas.length) return
    setNodes(ns => ns.map(n => {
      const p = personas.find(x => x.role === n.id)
      return p ? { ...n, data: { ...n.data, name: p.name, title: p.title, years: p.years } } : n
    }))
  }, [personas, setNodes])

  // Poll while a run is in flight
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const t = setInterval(async () => {
      try {
        const res = await authFetch(`${API}/runs/${run.id}`)
        const data = await res.json()
        if (!data.detail) setRun(data)
      } catch { /* transient */ }
    }, 1500)
    return () => clearInterval(t)
  }, [run])

  const onConnect = useCallback(
    (connection) => setEdges(eds => addEdge({ ...connection, animated: true }, eds)),
    [setEdges]
  )

  const inProject = useMemo(() => new Set(nodes.map(n => n.id)), [nodes])

  function addAgent(role) {
    if (inProject.has(role)) return
    const p = personas.find(x => x.role === role)
    const count = nodes.length
    setNodes(ns => [...ns, {
      id: role,
      type: 'persona',
      position: { x: 80 + (count % 4) * 220, y: 60 + Math.floor(count / 4) * 140 },
      data: { role, name: p?.name || role, title: p?.title || '', years: p?.years || '' },
    }])
    setSaved(false)
  }

  function removeAgent(role) {
    setNodes(ns => ns.filter(n => n.id !== role))
    setEdges(es => es.filter(e => e.source !== role && e.target !== role))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const body = {
        agents: nodes.map(n => n.id),
        links: edges.map(e => ({ from: e.source, to: e.target })),
        positions: Object.fromEntries(nodes.map(n => [n.id, { x: n.position.x, y: n.position.y }])),
      }
      const res = await authFetch(`${API}/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setProject(data)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  async function dispatch(e) {
    e.preventDefault()
    if (!task.trim()) return setRunError('พิมพ์งานที่ต้องการสั่งก่อน')
    setDispatching(true)
    setRunError('')
    try {
      const res = await authFetch(`${API}/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRun(data)
      setCollapsed({})
      requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (err) {
      setRunError(err.message)
    }
    setDispatching(false)
  }

  if (error && !project) {
    return <div className="px-7 pt-5 text-red-400">{error}</div>
  }
  if (!project) {
    return <div className="px-7 pt-5 text-muted-foreground/70">Loading project…</div>
  }

  const doneCount = run ? run.steps.filter(s => s.status === 'done' || s.status === 'error').length : 0

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-7 pb-1 pt-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push('/projects')}><ArrowLeft /></Button>
          <div>
            <h1 className="text-[21px] font-bold tracking-tight">{project.name}</h1>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">
              {project.description || 'Team workspace — สั่งงานทีม AI แล้วดูทุกคนทำงานต่อกัน'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {error && <span className="text-[12px] text-red-400">{error}</span>}
          {saved && <span className="text-[12.5px] font-medium text-emerald-400" data-testid="flow-saved">Saved ✓</span>}
          <Button onClick={save} disabled={saving} data-testid="flow-save">
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save Team'}
          </Button>
        </div>
      </div>

      <div className="px-7 py-5">
        {/* Mission control — dispatch one task through the whole team */}
        <Card className="mb-5 p-4" data-testid="mission-control">
          <form onSubmit={dispatch} className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-[14.5px] font-bold">สั่งงานทีม AI</div>
              <div className="text-[11.5px] text-muted-foreground/70">
                {nodes.length} agents จะรับงานนี้ตามลำดับ และเขียนงานลง container ของตัวเอง
              </div>
            </div>
            <div className="flex gap-3">
              <Textarea
                data-testid="task-input"
                placeholder="เช่น: Redesign หน้า Dashboard ใหม่ ทำ UX/UI เป็น design tokens + layout ใหม่..."
                className="min-h-[64px] flex-1 text-[13px]"
                value={task}
                onChange={e => setTask(e.target.value)}
              />
              <Button type="submit" disabled={dispatching || (run?.status === 'running')} data-testid="dispatch-team" className="h-fit">
                {dispatching || run?.status === 'running'
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> กำลังทำงาน…</>
                  : <><Send className="h-4 w-4" /> สั่งงานทีม</>}
              </Button>
            </div>
            {runError && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400">{runError}</div>}
          </form>

          {run && (
            <div ref={outputRef} className="mt-4 border-t pt-4" data-testid="run-timeline">
              <div className="mb-3 flex flex-wrap items-center gap-2.5">
                <Badge variant={run.status === 'running' ? 'created' : run.status === 'error' ? 'dead' : 'running'}>
                  {run.status === 'running' ? 'team working' : run.status}
                </Badge>
                <span className="text-[12.5px] font-medium">{doneCount}/{run.steps.length} ส่งงานแล้ว</span>
                <span className="truncate text-[12px] text-muted-foreground/70">“{run.task}”</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {run.steps.map((step, i) => {
                  const open = !collapsed[step.role]
                  return (
                    <div key={step.role} className="rounded-xl border bg-[#0d1420]" data-testid={`run-step-${step.role}`} data-status={step.status}>
                      <button
                        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
                        onClick={() => setCollapsed(c => ({ ...c, [step.role]: open }))}
                      >
                        <StepStatusIcon status={step.status} />
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className="text-[10px]">{initials(step.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-semibold">
                            <span className="text-muted-foreground/50">{i + 1}. </span>{step.name}
                            <span className="ml-2 text-[11px] font-normal text-muted-foreground/70">{step.title}</span>
                          </div>
                        </div>
                        {step.container && (
                          <span className="hidden items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-400 sm:flex" title={`deliverable: ${step.deliverable || '-'}`}>
                            <Container className="h-3 w-3" /> {step.container}
                          </span>
                        )}
                        <ChevronDown className={`h-4 w-4 text-muted-foreground/50 transition-transform ${open ? '' : '-rotate-90'}`} />
                      </button>
                      {open && (
                        <div className="border-t px-3.5 py-3">
                          {step.status === 'pending' && <div className="text-[12px] text-muted-foreground/60">รอรับงาน…</div>}
                          {step.status === 'working' && <div className="flex items-center gap-2 text-[12px] text-blue-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังทำงาน…</div>}
                          {step.status === 'error' && <div className="text-[12.5px] text-red-400">{step.output}</div>}
                          {step.status === 'done' && (
                            <>
                              {step.deliverable && (
                                <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-[10.5px] font-medium text-emerald-400 sm:hidden">
                                  <Container className="h-3 w-3" /> {step.container}: {step.deliverable}
                                </div>
                              )}
                              <div
                                className="max-h-[320px] overflow-auto text-[12.5px] [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[13.5px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-black/40 [&_pre]:p-2.5 [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-secondary [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5"
                                dangerouslySetInnerHTML={{ __html: marked.parse(step.output || '_ไม่มีเนื้อหา_') }}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </Card>

        <div className="flex gap-4">
          {/* Persona palette */}
          <Card className="w-[210px] shrink-0 p-3">
            <div className="mb-2.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Personas</div>
            <div className="flex flex-col gap-1.5">
              {personas.map(p => {
                const added = inProject.has(p.role)
                return (
                  <button
                    key={p.role}
                    onClick={() => added ? removeAgent(p.role) : addAgent(p.role)}
                    className={`flex items-center justify-between rounded-lg border px-2.5 py-2 text-left text-[12px] transition-colors ${added ? 'border-primary/60 bg-primary/10 text-primary' : 'bg-[#0d1420] hover:border-muted-foreground/40'}`}
                    data-testid={`palette-${p.role}`}
                  >
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-[10px] text-muted-foreground/60">{added ? '− remove' : '+ add'}</span>
                  </button>
                )
              })}
            </div>
          </Card>

          {/* Flow canvas */}
          <div className="h-[560px] flex-1 overflow-hidden rounded-xl border bg-[#0d1420]" data-testid="flow-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#2a3547" gap={18} />
              <Controls />
              <MiniMap pannable zoomable className="!bg-secondary" />
            </ReactFlow>
          </div>
        </div>
      </div>
    </>
  )
}
