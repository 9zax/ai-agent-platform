'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, Handle, Position, MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { marked } from 'marked'
import { Save, Plus, ArrowLeft, Send, Loader2, CheckCircle2, XCircle, Clock, Container, ChevronDown, MessageCircle, MessagesSquare, Check, GitBranch, Undo2, Square, User, Repeat, PauseCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { AgentDetail } from '@/components/agent-detail'
import { fmtClock } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function PersonaNode({ data }) {
  const ring =
    data.state === 'waiting_human' ? 'border-rose-400 shadow-[0_0_18px_rgba(251,113,133,.4)]'
    : data.state === 'revising' ? 'border-dashed border-rose-400 shadow-[0_0_18px_rgba(251,113,133,.45)]'
    : data.state === 'speaking' ? 'border-amber-400 shadow-[0_0_18px_rgba(251,191,36,.4)]'
    : data.state === 'working' ? 'border-blue-400 shadow-[0_0_18px_rgba(96,165,250,.35)]'
    : data.state === 'done' ? 'border-emerald-500/70'
    : 'border-primary/50'
  // Name the teammates this agent is meeting with, so the card explains itself
  const speakingLabel = data.speakingWith?.length
    ? `คุยกับ ${data.speakingWith.join(', ')} ใน meeting`
    : 'กำลังคุยใน meeting'
  return (
    <div className={`min-w-[170px] cursor-pointer rounded-xl border-2 bg-card p-3 shadow-lg transition-colors hover:border-primary ${ring}`} data-testid="flow-node" data-state={data.state || ''}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-primary !bg-background" />
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold">{data.name}</span>
        <Badge variant="purple" className="text-[9px]">{data.years}y</Badge>
      </div>
      <div className="mt-0.5 text-[11px] font-medium text-primary">{data.title}</div>
      {data.model && <div className="mt-0.5 truncate font-mono text-[9.5px] text-blue-300/80" data-testid="node-model">{data.model}</div>}
      <div className="mt-1 truncate text-[10px] text-muted-foreground/70">{data.role}</div>
      {data.state && (
        <div
          className={`mt-1 flex items-center gap-1.5 text-[10px] font-semibold ${data.state === 'waiting_human' ? 'text-rose-300' : data.state === 'revising' ? 'text-rose-300' : data.state === 'speaking' ? 'text-amber-300' : data.state === 'working' ? 'text-blue-400' : 'text-emerald-400'}`}
          title={data.state === 'speaking' ? speakingLabel : undefined}
        >
          {data.state === 'waiting_human' && <User className="h-3 w-3 shrink-0 animate-pulse" />}
          {data.state === 'revising' && <Undo2 className="h-3 w-3 shrink-0 animate-pulse" />}
          {data.state === 'speaking' && <MessagesSquare className="h-3 w-3 shrink-0" />}
          {data.state === 'working' && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
          {data.state === 'done' && <CheckCircle2 className="h-3 w-3 shrink-0" />}
          <span className="truncate">
            {data.state === 'waiting_human' ? '⏸ รอคุณตอบคำถาม'
              : data.state === 'revising' ? `ถูกตีกลับแก้ — กำลังแก้เป็น rev ${data.revTag || 2}`
              : data.state === 'speaking' ? speakingLabel
              : data.state === 'working' ? 'กำลังทำงาน…'
              : data.rev ? `ส่งงานแล้ว (แก้ใหม่ rev ${data.rev})`
              : 'ส่งงานแล้ว'}
          </span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-primary !bg-background" />
    </div>
  )
}

// A live team meeting on the canvas: one agent's blocking question + everyone answering.
function MeetingNode({ data }) {
  return (
    <div className={`w-[230px] rounded-xl border-2 bg-[#161207] p-3 ${data.needHuman ? 'border-rose-400/80 shadow-[0_0_24px_rgba(251,113,133,.28)]' : 'border-amber-400/80 shadow-[0_0_24px_rgba(251,191,36,.28)]'}`} data-testid="meeting-node">
      <div className="flex items-center gap-2">
        <MessageCircle className={`h-4 w-4 shrink-0 ${data.needHuman ? 'text-rose-400' : 'text-amber-400'}`} />
        <span className={`text-[12.5px] font-bold ${data.needHuman ? 'text-rose-300' : 'text-amber-300'}`}>Team Meeting</span>
        {data.status === 'resolved'
          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          : data.needHuman
            ? <User className="h-3.5 w-3.5 animate-pulse text-rose-400" />
            : <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />}
      </div>
      <div className="mt-1.5 max-h-[52px] overflow-hidden text-[11.5px] leading-relaxed text-amber-100/90">{data.topic}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {data.participants.map(p => (
          <span key={p} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-300">{p}</span>
        ))}
      </div>
      {data.needHuman ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-rose-300">
          <User className="h-3 w-3 shrink-0 animate-pulse" />
          <span className="truncate">⏸ รอคุณตอบในแชท — ตอบแล้วทีมทำต่อ</span>
        </div>
      ) : data.revising ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-rose-300">
          <Undo2 className="h-3 w-3 shrink-0 animate-pulse" />
          <span className="truncate">↩ {data.revising} ถูกตีกลับแก้ — กำลังแก้งาน…</span>
        </div>
      ) : data.speaking && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-amber-200/80">
          <MessagesSquare className="h-3 w-3 shrink-0" />
          <span className="truncate">{data.speaking} กำลังตอบ…</span>
        </div>
      )}
    </div>
  )
}

const nodeTypes = { persona: PersonaNode, meeting: MeetingNode }

function StepStatusIcon({ status }) {
  if (status === 'revising') return <Undo2 className="h-4 w-4 animate-pulse text-rose-400" />
  if (status === 'working') return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-400" />
  if (status === 'error') return <XCircle className="h-4 w-4 text-red-400" />
  if (status === 'skipped') return <PauseCircle className="h-4 w-4 text-muted-foreground/60" />
  return <Clock className="h-4 w-4 text-muted-foreground/50" />
}

// One chat bubble row. AI teammates sit left; the user ("human") sits right in
// the platform tint; orchestrator notes render as centered system dividers.
function ChatBubble({ from, text, at, stepByRole }) {
  if (from === 'orchestrator') {
    return (
      <div className="my-1.5 flex items-center gap-2.5" data-testid="chat-note">
        <div className="h-px flex-1 bg-amber-500/15" />
        <div className="max-w-[85%] text-center text-[10.5px] italic leading-relaxed text-amber-200/60">{text}{at ? <span className="ml-1.5 not-italic text-muted-foreground/40">{fmtClock(at)}</span> : null}</div>
        <div className="h-px flex-1 bg-amber-500/15" />
      </div>
    )
  }
  const isHuman = from === 'human'
  const name = isHuman ? 'คุณ' : (stepByRole[from]?.name || from)
  return (
    <div className={`flex items-end gap-2 ${isHuman ? 'flex-row-reverse' : ''}`} data-testid="chat-msg">
      <Avatar className={`h-6 w-6 shrink-0 ${isHuman ? 'border border-primary/50' : ''}`}>
        <AvatarFallback className={`text-[9px] ${isHuman ? 'bg-primary/20 font-bold text-primary' : ''}`}>
          {isHuman ? <User className="h-3 w-3" /> : initials(name)}
        </AvatarFallback>
      </Avatar>
      <div className={`flex max-w-[82%] flex-col ${isHuman ? 'items-end' : 'items-start'}`}>
        <div className="px-1 text-[10px] font-semibold text-muted-foreground/70">
          {name}{at ? <span className="ml-1.5 font-normal text-muted-foreground/40">{fmtClock(at)}</span> : null}
        </div>
        <div className={`mt-0.5 whitespace-pre-wrap rounded-2xl px-3 py-2 text-[12px] leading-relaxed chat-in ${isHuman ? 'rounded-br-sm bg-primary/20 text-foreground' : 'rounded-bl-sm bg-secondary text-foreground/90'}`}>
          {text}
        </div>
      </div>
    </div>
  )
}

// Animated "someone is typing" row that holds the last line of the thread.
function TypingRow({ label, tone = 'amber', revert = false }) {
  return (
    <div className="flex items-center gap-2" data-testid="chat-typing">
      {revert && <Undo2 className="h-3.5 w-3.5 shrink-0 animate-pulse text-rose-400" />}
      <div className="flex gap-1 rounded-2xl bg-secondary px-3 py-2.5">
        {[0, 1, 2].map(i => <span key={i} className={`typing-dot h-1.5 w-1.5 rounded-full ${tone === 'rose' ? 'bg-rose-300' : 'bg-amber-300'}`} style={{ animationDelay: `${i * 0.18}s` }} />)}
      </div>
      <span className={`text-[11px] ${tone === 'rose' ? 'font-medium text-rose-300' : 'text-amber-300/80'}`}>{label}</span>
    </div>
  )
}

// One meeting = one chat thread: the question, then everyone answering live.
function MeetingChat({ d, stepByRole, waitingHuman, round, onReply, replySending }) {
  const scrollRef = useRef(null)
  const [reply, setReply] = useState('')
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [d.messages.length, d.answering, d.status])

  const asker = stepByRole[d.from]?.name || d.from
  const addressees = d.to.map(r => r === 'human' ? 'คุณ' : (stepByRole[r]?.name || r)).join(', ')
  const askerRevising = d.status !== 'resolved' && d.answering === d.from
  const askerRev = stepByRole[d.from]?.rev
  const typing = d.status !== 'resolved' && d.answering && d.answering !== 'human'
    ? askerRevising
      ? <TypingRow revert tone="rose" label={`${asker} ถูกตีกลับแก้ — กำลังแก้งานใหม่เป็น rev ${round}…`} />
      : <TypingRow label={`${stepByRole[d.answering]?.name || d.answering} กำลังพิมพ์…`} />
    : null
  const closedNote = d.status === 'resolved' && (askerRev || 0) >= 2
    ? `↩ ${asker} แก้งานใหม่เสร็จเป็น rev ${askerRev} แล้ว`
    : null

  return (
    <div
      className={`rounded-xl border bg-[#161207] ${d.status === 'need_human' ? 'border-rose-400/60 shadow-[0_0_20px_rgba(251,113,133,.18)]' : 'border-amber-500/30'}`}
      data-testid={`meeting-${d.id}`}
    >
      <div className={`flex flex-wrap items-center gap-2 border-b px-3.5 py-2.5 ${d.status === 'need_human' ? 'border-rose-400/25' : 'border-amber-500/20'}`}>
        <MessageCircle className={`h-3.5 w-3.5 shrink-0 ${d.status === 'need_human' ? 'text-rose-400' : 'text-amber-400'}`} />
        <span className="text-[12.5px] font-semibold text-amber-200">{asker} ถาม → {addressees}</span>
        <Badge variant={d.status === 'resolved' ? 'running' : d.status === 'need_human' ? 'dead' : 'purple'} className="text-[9.5px]">
          {d.status === 'resolved' ? 'resolved' : d.status === 'need_human' ? '⏸ รอคุณตอบ' : d.status === 'answering' ? 'กำลังคุยกัน' : 'รอเปิดประชุม'}
        </Badge>
      </div>
      <div ref={scrollRef} className="max-h-[300px] overflow-y-auto px-3.5 py-3">
        <div className="flex flex-col gap-2.5">
          <ChatBubble from={d.from} text={d.topic} at={d.created_at} stepByRole={stepByRole} />
          {d.messages.map((m, i) => <ChatBubble key={i} from={m.from} text={m.text} at={m.at} stepByRole={stepByRole} />)}
          {typing}
          {closedNote && <ChatBubble from="orchestrator" text={closedNote} stepByRole={stepByRole} />}
        </div>
      </div>
      {(d.status === 'need_human' || waitingHuman) && d.status !== 'resolved' && (
        <form
          className="flex gap-2 border-t border-rose-400/25 px-3.5 py-2.5"
          data-testid="human-reply"
          onSubmit={e => { e.preventDefault(); if (!reply.trim()) return; onReply(d.id, reply.trim()) ; setReply('') }}
        >
          <Textarea
            className="min-h-[38px] flex-1 text-[12px]"
            placeholder="พิมพ์คำตอบถึงทีม…"
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form?.requestSubmit() } }}
          />
          <Button type="submit" size="sm" disabled={replySending || !reply.trim()} className="h-fit">
            {replySending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} ตอบ
          </Button>
        </form>
      )}
    </div>
  )
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
  const [repoUrl, setRepoUrl] = useState('')

  // Team run state
  const [task, setTask] = useState('')
  const [run, setRun] = useState(null)
  const [dispatching, setDispatching] = useState(false)
  const [runError, setRunError] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [loopMode, setLoopMode] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [replySending, setReplySending] = useState(false)
  const outputRef = useRef(null)

  // Click a node in the chart → live activity + work history of that agent
  const [detailAgent, setDetailAgent] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)

  function refreshPersonas() {
    authFetch(`${API}/agents`).then(r => r.json()).then(setPersonas).catch(() => {})
  }

  useEffect(() => {
    authFetch(`${API}/projects/${id}`).then(r => r.json()).then(p => {
      if (p.detail) { setError(p.detail); return }
      setProject(p)
      setRepoUrl(p.repo_url || '')
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
      return p ? { ...n, data: { ...n.data, name: p.name, title: p.title, years: p.years, model: p.model } } : n
    }))
  }, [personas, setNodes])

  // Poll while a run is in flight — including waiting_human (the chat needs to
  // show the reply landing) and the gap at the end of a loop iteration while
  // the PO decides whether a next iteration gets spawned.
  useEffect(() => {
    const inFlight = run && (run.status === 'running' || run.status === 'waiting_human')
    const loopGap = run && run.loop_mode && run.status === 'done' && !run.next_run_id
    if (!run || (!inFlight && !loopGap)) return
    const t = setInterval(async () => {
      try {
        const res = await authFetch(`${API}/runs/${run.id}`)
        const data = await res.json()
        if (data.detail) return
        // Loop chain: follow the parent into its spawned iteration
        if (data.next_run_id && data.next_run_id !== run.id) {
          const child = await authFetch(`${API}/runs/${data.next_run_id}`).then(r => r.json()).catch(() => null)
          if (child && !child.detail) { setRun(child); return }
        }
        setRun(data)
      } catch { /* transient */ }
    }, 1500)
    return () => clearInterval(t)
  }, [run])

  const onConnect = useCallback(
    (connection) => setEdges(eds => addEdge({ ...connection, animated: true }, eds)),
    [setEdges]
  )

  const onNodeClick = useCallback((_, node) => {
    const p = personas.find(x => x.role === node.id)
    if (p) { setDetailAgent(p); setDetailOpen(true) }
  }, [personas])

  // The human's answer to a need-human meeting — POST then refresh the run
  async function replyHuman(discId, text) {
    if (!run) return
    setReplySending(true)
    try {
      const res = await authFetch(`${API}/runs/${run.id}/discussions/${discId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      const fresh = await authFetch(`${API}/runs/${run.id}`).then(r => r.json()).catch(() => null)
      if (fresh && !fresh.detail) setRun(fresh)
    } catch (e) {
      setRunError(e.message)
    }
    setReplySending(false)
  }

  async function stopTeam() {
    if (!run) return
    setStopping(true)
    try {
      const res = await authFetch(`${API}/runs/${run.id}/stop`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      const fresh = await authFetch(`${API}/runs/${run.id}`).then(r => r.json()).catch(() => null)
      if (fresh && !fresh.detail) setRun(fresh)
    } catch (e) {
      setRunError(e.message)
    }
    setStopping(false)
  }

  const inProject = useMemo(() => new Set(nodes.map(n => n.id)), [nodes])

  function addAgent(role) {
    if (inProject.has(role)) return
    const p = personas.find(x => x.role === role)
    const count = nodes.length
    setNodes(ns => [...ns, {
      id: role,
      type: 'persona',
      position: { x: 80 + (count % 4) * 220, y: 60 + Math.floor(count / 4) * 140 },
      data: { role, name: p?.name || role, title: p?.title || '', years: p?.years || '', model: p?.model || '' },
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
        repo_url: repoUrl,
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
        body: JSON.stringify({ task, loop: loopMode }),
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

  // ---- Live run state on the flow canvas (plain derivations — must stay after
  // the early returns above, so no hooks here) ----
  const live = run?.status === 'running' || run?.status === 'waiting_human'
  const stepByRole = Object.fromEntries((run?.steps || []).map(s => [s.role, s]))
  const activeMeetings = (run?.discussions || []).filter(d => d.status !== 'resolved')
  // Agents paused on a need-human meeting
  const waitingHuman = run?.status === 'waiting_human'
  const waitingHumanRoles = new Set(
    (run?.discussions || []).filter(d => d.status === 'need_human').flatMap(d => [d.from, ...d.to])
  )
  // Who each agent is talking to in a live meeting: role → display names of the others
  const meetingPartners = {}
  activeMeetings.forEach(d => {
    if (!d.answering || d.answering === 'human') return
    meetingPartners[d.answering] = [d.from, ...d.to]
      .filter(r => r !== d.answering)
      .map(r => r === 'human' ? 'คุณ' : (stepByRole[r]?.name || r))
  })
  // Work sent back: the discussion handed the floor to its own asker — their
  // step flipped back to "working" to redo the deliverable (it becomes rev N).
  const revisingRoles = new Set(activeMeetings.filter(d => d.answering && d.answering === d.from).map(d => d.from))
  const revertTotal = run ? run.steps.filter(s => (s.rev || 0) >= 2 || revisingRoles.has(s.role)).length : 0

  const flowNodes = (() => {
    const withState = nodes.map(n => {
      const st = stepByRole[n.id]
      const state = !live ? null
        : waitingHuman && waitingHumanRoles.has(n.id) ? 'waiting_human'
        : revisingRoles.has(n.id) ? 'revising'
        : meetingPartners[n.id] ? 'speaking'
        : st?.status === 'working' ? 'working'
        : st?.status === 'done' ? 'done'
        : null
      return { ...n, data: { ...n.data, state, speakingWith: meetingPartners[n.id] || null, rev: st?.rev || null, revTag: run?.round } }
    })
    if (!live) return withState
    // A meeting card floating above the participants, wired to each of them
    const meetings = activeMeetings.map(d => {
      const parts = [d.from, ...d.to.filter(r => r !== 'human')]
      const ps = parts.map(r => nodes.find(n => n.id === r)?.position).filter(Boolean)
      const pos = ps.length
        ? { x: ps.reduce((a, p) => a + p.x, 0) / ps.length + 70, y: ps.reduce((a, p) => a + p.y, 0) / ps.length - 100 }
        : { x: 400, y: 60 }
      return {
        id: `meeting-${d.id}`,
        type: 'meeting',
        position: pos,
        draggable: false, selectable: false, deletable: false, connectable: false,
        data: {
          topic: d.topic,
          status: d.status,
          participants: parts.map(r => stepByRole[r]?.name || r),
          speaking: d.answering && d.answering !== 'human' ? (stepByRole[d.answering]?.name || d.answering) : null,
          revising: d.answering === d.from ? (stepByRole[d.from]?.name || d.from) : null,
          needHuman: d.status === 'need_human',
        },
      }
    })
    return [...withState, ...meetings]
  })()

  const flowEdges = live
    ? [...edges, ...activeMeetings.flatMap(d => {
        // Revert lane: while the asker redoes their deliverable, their edge flips
        // direction (meeting → asker) into a dashed rose line with an arrowhead —
        // the work is being sent back down the wire.
        const reverted = d.answering === d.from
        return [d.from, ...d.to].filter(p => p !== 'human').map(p => (reverted && p === d.from)
          ? {
              id: `m-${d.id}-${p}`,
              source: `meeting-${d.id}`,
              target: p,
              animated: true,
              style: d.status === 'need_human' ? { stroke: '#fb7185', strokeWidth: 2, strokeDasharray: '2 4' } : { stroke: '#fb7185', strokeWidth: 2, strokeDasharray: '6 4' },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#fb7185' },
              deletable: false,
            }
          : {
              id: `m-${d.id}-${p}`,
              source: p,
              target: `meeting-${d.id}`,
              animated: true,
              style: { stroke: '#fbbf24', strokeWidth: 2 },
              deletable: false,
            })
      })]
    : edges

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
          {saved && <span className="flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="flow-saved">Saved <Check className="h-3.5 w-3.5" /></span>}
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
                {nodes.length} agents รับงานตามลำดับและเขียนงานลง container ของตัวเอง — ถ้าใครติดขัด/มีคำถาม จะเปิด meeting ถามกลับแล้วแก้งานต่อ
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground/60" />
              <input
                data-testid="project-repo"
                className="h-8 w-full max-w-xl rounded-md border bg-background px-2.5 text-[12.5px] outline-none focus:ring-1 focus:ring-ring"
                placeholder="Git repo (https://github.com/owner/repo) — ทีมจะ clone ลง /workspace ของ container ก่อนทำงานทุกครั้ง"
                value={repoUrl}
                onChange={e => { setRepoUrl(e.target.value); setSaved(false) }}
              />
              {!saved && repoUrl !== (project?.repo_url || '') && (
                <span className="shrink-0 text-[11px] text-amber-400">กด Save Team เพื่อบันทึก repo</span>
              )}
            </div>
            <div className="flex gap-3">
              <Textarea
                data-testid="task-input"
                placeholder="เช่น: Redesign หน้า Dashboard ใหม่ ทำ UX/UI เป็น design tokens + layout ใหม่..."
                className="min-h-[64px] flex-1 text-[13px]"
                value={task}
                onChange={e => setTask(e.target.value)}
              />
              <div className="flex h-fit flex-col gap-2">
                <Button type="submit" disabled={dispatching || run?.status === 'running' || run?.status === 'waiting_human'} data-testid="dispatch-team">
                  {dispatching || run?.status === 'running' || run?.status === 'waiting_human'
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> กำลังทำงาน…</>
                    : <><Send className="h-4 w-4" /> สั่งงานทีม</>}
                </Button>
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground" data-testid="loop-toggle" title="จบรอบแล้ว PO ประเมินและสั่งรอบถัดไปอัตโนมัติ จนกว่า goal สำเร็จหรือกดหยุด">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={loopMode}
                    onChange={e => setLoopMode(e.target.checked)}
                    disabled={run?.status === 'running' || run?.status === 'waiting_human'}
                  />
                  <Repeat className="h-3.5 w-3.5" /> ทำงานเป็น Loop
                </label>
              </div>
            </div>
            {runError && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400">{runError}</div>}
          </form>

          {run && (
            <div ref={outputRef} className="mt-4 border-t pt-4" data-testid="run-timeline">
              <div className="mb-3 flex flex-wrap items-center gap-2.5">
                <Badge variant={run.status === 'error' || run.status === 'stopped' ? 'dead' : run.status === 'waiting_human' ? 'dead' : run.status === 'running' ? (run.phase === 'meeting' ? 'purple' : 'created') : 'running'} className="gap-1.5">
                  {run.status === 'running'
                    ? (run.phase === 'meeting'
                        ? <><MessagesSquare className="h-3 w-3" /> team meeting — รอบที่ {run.round}</>
                        : 'team working')
                    : run.status === 'waiting_human'
                      ? <><User className="h-3 w-3" /> รอคุณตอบในแชท</>
                      : run.status}
                </Badge>
                {run.loop_mode && (
                  <Badge variant="purple" className="gap-1" data-testid="loop-badge">
                    <Repeat className="h-3 w-3" /> Loop{run.iteration > 1 ? ` รอบที่ ${run.iteration}` : ''}{run.status === 'done' && !run.next_run_id ? ' · กำลังประเมินรอบถัดไป…' : ''}
                  </Badge>
                )}
                <span className="text-[12.5px] font-medium">{doneCount}/{run.steps.length} ส่งงานแล้ว</span>
                {(run.discussions || []).length > 0 && (
                  <span className="flex items-center gap-1.5 text-[12px] text-amber-300/90">
                    <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
                    {run.discussions.length} meeting{run.discussions.some(d => d.status !== 'resolved') ? ` · คำถามค้าง ${run.discussions.filter(d => d.status !== 'resolved').length}` : ' — ตัดสินใจครบแล้ว'}
                  </span>
                )}
                {revertTotal > 0 && (
                  <span className="flex items-center gap-1.5 text-[12px] text-rose-300/90" data-testid="run-reverts">
                    <Undo2 className="h-3.5 w-3.5 shrink-0" />↩ ตีกลับแก้ {revertTotal} งาน{revisingRoles.size > 0 ? ' · กำลังแก้อยู่' : ''}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/70">“{run.task}”</span>
                {(run.status === 'running' || run.status === 'waiting_human') && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={stopTeam}
                    disabled={stopping}
                    data-testid="stop-team"
                    className="h-7 gap-1.5 border-red-500/40 text-[11.5px] text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    title="หยุดตรงนี้ — งานที่เหลือถูกข้าม และ loop จะไม่สั่งรอบถัดไป"
                  >
                    {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />} หยุดทีม
                  </Button>
                )}
              </div>

              {run.summary && (
                <div className="mb-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-3.5" data-testid="run-summary">
                  <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-bold text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" /> สรุป mission โดย PO
                  </div>
                  <div
                    className="max-h-[260px] overflow-auto text-[12.5px] [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[13.5px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                    dangerouslySetInnerHTML={{ __html: marked.parse(run.summary) }}
                  />
                </div>
              )}

              <div className="flex flex-col gap-2.5">
                {run.steps.map((step, i) => {
                  const open = !collapsed[step.role]
                  const reverting = live && revisingRoles.has(step.role) && step.status === 'working'
                  return (
                    <div key={step.role} className={`rounded-xl border bg-[#0d1420] ${reverting ? 'revert-flash border-rose-400/60' : ''}`} data-testid={`run-step-${step.role}`} data-status={step.status} data-revert={reverting ? '1' : undefined}>
                      <button
                        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
                        onClick={() => setCollapsed(c => ({ ...c, [step.role]: open }))}
                      >
                        <StepStatusIcon status={reverting ? 'revising' : step.status} />
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className="text-[10px]">{initials(step.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-semibold">
                            <span className="text-muted-foreground/50">{i + 1}. </span>{step.name}
                            <span className="ml-2 text-[11px] font-normal text-muted-foreground/70">{step.title}</span>
                            {step.rev && <span className="ml-1.5 rounded bg-rose-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-rose-300">↩ rev {step.rev} · แก้ตาม meeting</span>}
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
                          {reverting && (
                            <div className="flex items-center gap-2 text-[12px] font-medium text-rose-300">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" /> ↩ ถูกตีกลับแก้จาก meeting — กำลังแก้งานใหม่เป็น rev {run.round}…
                            </div>
                          )}
                          {step.status === 'working' && !reverting && <div className="flex items-center gap-2 text-[12px] text-blue-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังทำงาน…</div>}
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

              {(run.discussions || []).length > 0 && (
                <div className="mt-4 flex flex-col gap-2.5" data-testid="run-meetings">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-400/80">
                    Meetings — คุยกันแบบแชทเรียลไทม์ {run.discussions.some(d => d.status === 'need_human') && <span className="ml-1 normal-case text-rose-300">· มีคำถามที่รอคุณตอบ</span>}
                  </div>
                  {run.discussions.map(d => (
                    <MeetingChat
                      key={d.id}
                      d={d}
                      stepByRole={stepByRole}
                      waitingHuman={run.status === 'waiting_human'}
                      round={run.round}
                      onReply={replyHuman}
                      replySending={replySending}
                    />
                  ))}
                </div>
              )}
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
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#2a3547" gap={18} />
              <Controls />
              <MiniMap pannable zoomable className="!bg-secondary" />
            </ReactFlow>
          </div>
        </div>
        <div className="mt-2 text-[11.5px] text-muted-foreground/60" data-testid="flow-edit-hint">
          กดที่การ์ด agent เพื่อดูว่ากำลังทำอะไรอยู่ + ประวัติการทำงานทั้งหมด และแก้ไข persona/โมเดลประจำตัวได้ (เส้นเชื่อม = ใครคุยกับใคร)
        </div>
      </div>

      <AgentDetail agent={detailAgent} open={detailOpen} onOpenChange={setDetailOpen} onSaved={refreshPersonas} />
    </>
  )
}
