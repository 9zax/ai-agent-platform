'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, Handle, Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Save, Trash2, Plus, ArrowLeft } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

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
  }, [id, setNodes, setEdges])

  // Enrich node data when personas arrive
  useEffect(() => {
    if (!personas.length) return
    setNodes(ns => ns.map(n => {
      const p = personas.find(x => x.role === n.id)
      return p ? { ...n, data: { ...n.data, name: p.name, title: p.title, years: p.years } } : n
    }))
  }, [personas, setNodes])

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

  if (error && !project) {
    return <div className="px-7 pt-5 text-red-400">{error}</div>
  }
  if (!project) {
    return <div className="px-7 pt-5 text-muted-foreground/70">Loading project…</div>
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-7 pb-1 pt-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push('/projects')}><ArrowLeft /></Button>
          <div>
            <h1 className="text-[21px] font-bold tracking-tight">{project.name}</h1>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">
              {project.description || 'Flow editor — ลากการ์ดจัดตำแหน่ง, ลากเส้นจากขอบขวาไปขอบซ้ายเพื่อบอกว่าใครคุยกับใคร'}
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

      <div className="flex gap-4 px-7 py-5">
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
        <div className="h-[640px] flex-1 overflow-hidden rounded-xl border bg-[#0d1420]" data-testid="flow-canvas">
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
    </>
  )
}
