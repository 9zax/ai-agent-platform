'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, Handle, Position, MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { marked } from 'marked'
import {
  Save, Plus, ArrowLeft, Send, Loader2, CheckCircle2, XCircle, Clock, Container, ChevronDown,
  MessageCircle, MessagesSquare, Check, GitBranch, Undo2, Square, User, Repeat, PauseCircle,
  GitPullRequest, MonitorPlay, RotateCcw, Wallet, AlertTriangle, CalendarClock, Play, Pencil,
  Trash2, ShieldCheck, X, Target, Activity, History, Timer, Layers, Users, Sparkles, Wand2,
  ChevronsUpDown, LocateFixed, Radio, ListTodo,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { AgentDetail } from '@/components/agent-detail'
import { ProjectDocs } from '@/components/project-docs'
import PageHeader from '@/components/page-header'
import { fmtClock, fmtDur, stepKey } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// Tail-stage steps (after QA verifies): icon + label chip shown next to the title.
// (deploy/staging removed with docker — the tail is now PR → demo)
const STEP_KIND_META = {
  pr: { icon: GitPullRequest, label: 'Pull Request', cls: 'bg-sky-500/10 text-sky-300' },
  demo: { icon: MonitorPlay, label: 'Acceptance demo', cls: 'bg-violet-500/10 text-violet-300' },
}

function PersonaNode({ data }) {
  const ring =
    data.state === 'waiting_human' ? 'border-rose-400 shadow-[0_0_20px_rgba(251,113,133,.35)]'
    : data.state === 'revising' ? 'border-dashed border-rose-400 shadow-[0_0_20px_rgba(251,113,133,.4)]'
    : data.state === 'speaking' ? 'border-amber-400 shadow-[0_0_20px_rgba(251,191,36,.35)]'
    : data.state === 'working' ? 'border-blue-400 shadow-[0_0_20px_rgba(96,165,250,.32)]'
    : data.state === 'done' ? 'border-emerald-500/70'
    : 'border-white/[0.12]'
  const accent =
    data.state === 'waiting_human' || data.state === 'revising' ? 'bg-rose-400'
    : data.state === 'speaking' ? 'bg-amber-400'
    : data.state === 'working' ? 'bg-blue-400'
    : data.state === 'done' ? 'bg-emerald-400'
    : 'bg-primary/40'
  // Name the teammates this agent is meeting with, so the card explains itself
  const speakingLabel = data.speakingWith?.length
    ? `คุยกับ ${data.speakingWith.join(', ')} ใน meeting`
    : 'กำลังคุยใน meeting'
  const busy = data.state === 'working' || data.state === 'speaking'
  return (
    <div
      className={`relative min-w-[182px] cursor-pointer overflow-hidden rounded-xl border-2 bg-card p-3 shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:border-primary ${ring}`}
      data-testid="flow-node"
      data-state={data.state || ''}
    >
      <span className={`pointer-events-none absolute inset-x-0 top-0 h-[2px] ${accent}`} />
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-primary !bg-background" />
      <div className="flex items-center gap-2">
        <Avatar className={`h-6 w-6 shrink-0 ${busy ? 'ring-1 ring-inset ring-white/15' : ''}`}>
          <AvatarFallback className="text-[9px]">{initials(data.name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-bold">{data.name}</span>
            {busy && <span className={`h-1.5 w-1.5 shrink-0 rounded-full animate-pulse ${data.state === 'speaking' ? 'bg-amber-400' : 'bg-blue-400'}`} />}
          </div>
          <div className="truncate text-[10px] font-medium text-primary">{data.title}</div>
        </div>
        {data.years ? <Badge variant="purple" className="shrink-0 text-[8.5px]">{data.years}y</Badge> : null}
      </div>
      {data.model && <div className="mt-1.5 truncate rounded bg-white/[0.035] px-1.5 py-0.5 font-mono text-[9px] text-blue-300/70" data-testid="node-model">{data.model}</div>}
      <div className="mt-1 truncate text-[9.5px] text-muted-foreground/55">{data.role}</div>
      {data.state && (
        <div
          className={`mt-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[9.5px] font-semibold ${
            data.state === 'waiting_human' || data.state === 'revising' ? 'bg-rose-500/10 text-rose-300'
            : data.state === 'speaking' ? 'bg-amber-500/10 text-amber-300'
            : data.state === 'working' ? 'bg-blue-500/10 text-blue-300'
            : 'bg-emerald-500/10 text-emerald-300'
          }`}
          title={data.state === 'speaking' ? speakingLabel : undefined}
        >
          {data.state === 'waiting_human' && <User className="h-3 w-3 shrink-0 animate-pulse" />}
          {data.state === 'revising' && <Undo2 className="h-3 w-3 shrink-0 animate-pulse" />}
          {data.state === 'speaking' && <MessagesSquare className="h-3 w-3 shrink-0" />}
          {data.state === 'working' && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
          {data.state === 'done' && <CheckCircle2 className="h-3 w-3 shrink-0" />}
          <span className="truncate">
            {data.state === 'waiting_human' ? '⏸ รอคุณตอบ'
              : data.state === 'revising' ? `แก้ใหม่ rev ${data.revTag || 2}`
              : data.state === 'speaking' ? speakingLabel
              : data.state === 'working' ? 'กำลังทำงาน…'
              : data.rev ? `ส่งแล้ว · rev ${data.rev}`
              : 'ส่งงานแล้ว'}
          </span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-primary !bg-background" />
    </div>
  )
}

// A live team meeting on the canvas: one agent's blocking question + everyone
// answering. kind === 'demo' renders the acceptance demo card (violet).
function MeetingNode({ data }) {
  const isDemo = data.kind === 'demo'
  return (
    <div
      className={`w-[230px] rounded-xl border-2 p-3 ${isDemo ? 'bg-[#12091f]' : 'bg-[#161207]'} ${
        data.needHuman ? 'border-rose-400/80 shadow-[0_0_24px_rgba(251,113,133,.28)]'
        : isDemo ? 'border-violet-400/80 shadow-[0_0_24px_rgba(167,139,250,.28)]'
        : 'border-amber-400/80 shadow-[0_0_24px_rgba(251,191,36,.28)]'}`}
      data-testid="meeting-node"
    >
      <div className="flex items-center gap-2">
        {isDemo
          ? <MonitorPlay className="h-4 w-4 shrink-0 text-violet-300" />
          : <MessageCircle className={`h-4 w-4 shrink-0 ${data.needHuman ? 'text-rose-400' : 'text-amber-400'}`} />}
        <span className={`text-[12.5px] font-bold ${data.needHuman ? 'text-rose-300' : isDemo ? 'text-violet-300' : 'text-amber-300'}`}>{isDemo ? 'Acceptance Demo' : 'Team Meeting'}</span>
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
  if (status === 'stopped') return <Square className="h-3.5 w-3.5 text-muted-foreground/60" />
  return <Clock className="h-4 w-4 text-muted-foreground/50" />
}

// Orchestrator notes stay plain text, except URLs become clickable links and
// GitHub device-flow codes (XXXX-XXXX) get highlighted — the PR stage's auth
// request carries both and must be actionable straight from the chat.
function noteText(text) {
  return String(text).split(/(https?:\/\/[^\s<>"]+)/g).map((part, i) => {
    if (i % 2 === 1) {
      return (
        <a key={i} href={part} target="_blank" rel="noreferrer"
           className="font-semibold not-italic underline decoration-amber-400/60 underline-offset-2 hover:text-amber-100">
          {part}
        </a>
      )
    }
    return part.split(/(\b[A-Z0-9]{4}-[A-Z0-9]{4}\b)/g).map((seg, j) =>
      j % 2 === 1
        ? <code key={`${i}-${j}`} data-testid="device-code" className="mx-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[11px] font-bold not-italic text-amber-200">{seg}</code>
        : seg
    )
  })
}

// One chat bubble row. AI teammates sit left; the user ("human") sits right in
// the platform tint; orchestrator notes render as centered system dividers.
function ChatBubble({ from, text, at, stepByRole }) {
  if (from === 'orchestrator') {
    return (
      <div className="my-1.5 flex items-center gap-2.5" data-testid="chat-note">
        <div className="h-px flex-1 bg-amber-500/15" />
        <div className="max-w-[85%] whitespace-pre-line text-center text-[10.5px] italic leading-relaxed text-amber-200/60">{noteText(text)}{at ? <span className="ml-1.5 not-italic text-muted-foreground/40">{fmtClock(at)}</span> : null}</div>
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
// kind === 'demo' renders the acceptance demo session (violet) instead.
function MeetingChat({ d, stepByRole, waitingHuman, round, onReply, replySending }) {
  const scrollRef = useRef(null)
  const [reply, setReply] = useState('')
  // Local lock: replySending is shared across threads and only flips after the
  // parent re-renders — Enter spam before that used to fire the same reply twice.
  const sendingRef = useRef(false)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [d.messages.length, d.answering, d.status])

  async function submitReply(e) {
    e.preventDefault()
    const text = reply.trim()
    if (!text || sendingRef.current) return
    sendingRef.current = true
    const ok = await onReply(d.id, text)
    // Keep the draft when the send failed — losing a long answer to a blip hurts.
    if (ok) setReply('')
    sendingRef.current = false
  }

  const isDemo = d.kind === 'demo'
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
      className={`rounded-xl border ${isDemo ? 'bg-[#12091f]' : 'bg-[#161207]'} ${d.status === 'need_human' ? 'border-rose-400/60 shadow-[0_0_20px_rgba(251,113,133,.18)]' : isDemo ? 'border-violet-500/30' : 'border-amber-500/30'}`}
      data-testid={`${isDemo ? 'demo' : 'meeting'}-${d.id}`}
    >
      <div className={`flex flex-wrap items-center gap-2 border-b px-3.5 py-2.5 ${d.status === 'need_human' ? 'border-rose-400/25' : isDemo ? 'border-violet-500/20' : 'border-amber-500/20'}`}>
        {isDemo
          ? <MonitorPlay className="h-3.5 w-3.5 shrink-0 text-violet-300" />
          : <MessageCircle className={`h-3.5 w-3.5 shrink-0 ${d.status === 'need_human' ? 'text-rose-400' : 'text-amber-400'}`} />}
        <span className={`text-[12.5px] font-semibold ${isDemo ? 'text-violet-200' : 'text-amber-200'}`}>
          {isDemo ? 'Acceptance Demo — QA แสดงหลักฐาน · Dev ส่งมอบ PR · PO ตรวจรับ' : `${asker} ถาม → ${addressees}`}
        </span>
        <Badge variant={d.status === 'resolved' ? 'running' : d.status === 'need_human' ? 'dead' : 'purple'} className="text-[9.5px]">
          {d.status === 'resolved' ? (isDemo ? 'ตรวจรับเสร็จ' : 'resolved') : d.status === 'need_human' ? '⏸ รอคุณตอบ' : d.status === 'answering' ? (isDemo ? 'กำลัง demo' : 'กำลังคุยกัน') : 'รอเปิดประชุม'}
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
          onSubmit={submitReply}
        >
          <Textarea
            className="min-h-[38px] flex-1 text-[12px]"
            placeholder="พิมพ์คำตอบถึงทีม…"
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendingRef.current) e.target.form?.requestSubmit() } }}
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

// Chip for a tail-stage step kind (pr/demo) next to the step title.
function StepKindBadge({ kind }) {
  const meta = STEP_KIND_META[kind]
  if (!meta) return null
  const Icon = meta.icon
  return (
    <span className={`ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${meta.cls}`}>
      <Icon className="h-3 w-3" /> {meta.label}
    </span>
  )
}

function fmtUsd(v) {
  const n = Number(v || 0)
  if (!n) return '$0.00'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

function fmtTok(n) {
  const v = Number(n || 0)
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
}

// ---------- Mission control building blocks ----------

const RUN_STATE = {
  running: { label: 'Team working', short: 'working', dot: 'bg-blue-400', text: 'text-blue-300', badge: 'created' },
  waiting_human: { label: 'Waiting on you', short: 'your turn', dot: 'bg-rose-400', text: 'text-rose-300', badge: 'dead' },
  done: { label: 'Complete', short: 'done', dot: 'bg-emerald-400', text: 'text-emerald-300', badge: 'running' },
  error: { label: 'Failed', short: 'error', dot: 'bg-red-400', text: 'text-red-300', badge: 'dead' },
  stopped: { label: 'Stopped', short: 'stopped', dot: 'bg-slate-400', text: 'text-slate-300', badge: 'stopped' },
  created: { label: 'Queued', short: 'queued', dot: 'bg-sky-400', text: 'text-sky-300', badge: 'created' },
}
const runState = s => RUN_STATE[s] || RUN_STATE.created

function relTime(ts) {
  if (!ts) return ''
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(ts * 1000).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
}

// Ticks once a second only while something is in flight — elapsed timers and
// the running step's duration stay honest without a global interval.
function useNow(enabled) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [enabled])
  return now
}

function runElapsed(run, nowMs) {
  if (!run?.steps?.length) return ''
  const starts = run.steps.map(s => s.started_at).filter(Boolean)
  const ends = run.steps.map(s => s.finished_at).filter(Boolean)
  if (!starts.length) return ''
  const start = Math.min(...starts)
  const live = run.status === 'running' || run.status === 'waiting_human'
  const end = live ? Math.floor(nowMs / 1000) : (ends.length ? Math.max(...ends) : start)
  return fmtDur(start, end)
}

// Long markdown deliverable → one calm line for collapsed rows.
function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const STEP_HINT = {
  pending: 'รอรับงาน…',
  working: 'กำลังทำงาน…',
  done: 'ส่งงานแล้ว',
  error: 'เกิดข้อผิดพลาด',
  skipped: 'ข้ามขั้นตอนนี้',
  stopped: 'หยุดกลางคัน',
}

const TASK_IDEAS = [
  { label: 'UX/UI pass', text: 'ตรวจ UX/UI ของหน้าหลักทั้งหมด เสนอ 3 จุดที่ควรปรับ แล้วลงมือแก้จริงให้สอดคล้อง design system' },
  { label: 'Bug sweep', text: 'ไล่ตรวจ bug จาก log ล่าสุด หาสาเหตุที่แท้จริง แก้ และเพิ่มเทสต์กัน regression' },
  { label: 'Ship a feature', text: 'เพิ่มฟีเจอร์เล็กที่มีคุณค่า: ทำให้หน้า Dashboard แสดง trend 7 วันย้อนหลัง พร้อม empty state' },
]

// Compact vertical status rail: one node per step (work + PR + demo), click to
// jump to that step's card. This is the "where is the mission now?" glance.
function StageRail({ steps, onPick }) {
  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-0.5" data-testid="stage-rail">
      {steps.map((s, i) => {
        const done = s.status === 'done'
        const live = s.status === 'working'
        const bad = s.status === 'error'
        const skip = s.status === 'skipped' || s.status === 'stopped'
        const kindLabel = s.kind === 'pr' ? 'PR' : s.kind === 'demo' ? 'Demo' : null
        return (
          <div key={stepKey(s)} className="flex items-center">
            {i > 0 && <span className={`h-px w-3 shrink-0 sm:w-5 ${done ? 'bg-emerald-500/40' : 'bg-white/[0.08]'}`} />}
            <button
              type="button"
              onClick={() => onPick(s)}
              title={`${s.name}${s.title ? ` · ${s.title}` : ''} — ${s.status}`}
              className="group flex shrink-0 flex-col items-center gap-1 rounded-lg px-1 py-0.5 outline-none transition-transform focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-[9px] font-bold transition-all group-hover:scale-110 ${
                done ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                : bad ? 'border-red-400/50 bg-red-500/15 text-red-300'
                : live ? 'stage-live border-blue-400/60 bg-blue-500/15 text-blue-300'
                : skip ? 'border-white/10 bg-white/[0.02] text-muted-foreground/35'
                : 'border-white/10 bg-white/[0.02] text-muted-foreground/50'
              }`}>
                {done ? <Check className="h-3 w-3" /> : bad ? <X className="h-3 w-3" /> : live ? <Loader2 className="h-3 w-3 animate-spin" /> : skip ? <PauseCircle className="h-3 w-3" /> : <span>{i + 1}</span>}
              </span>
              <span className={`max-w-[64px] truncate text-[9.5px] font-medium ${done ? 'text-emerald-300/80' : live ? 'text-blue-300' : bad ? 'text-red-300' : 'text-muted-foreground/50'}`}>{s.name}</span>
              {kindLabel && <span className="rounded bg-white/[0.05] px-1 text-[8px] font-semibold uppercase tracking-wide text-muted-foreground/50">{kindLabel}</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}

// What each role actually owns inside a mission — the board answers "who is
// holding which slice of the work right now?" without opening a single step.
const OWNER_SLICE = {
  po: { phase: 'Brief', slice: 'Product brief' },
  ba: { phase: 'Brief', slice: 'Business analysis' },
  sa: { phase: 'Design', slice: 'System spec' },
  'ux-ui': { phase: 'Design', slice: 'UX flows' },
  'ux-ui-2': { phase: 'Design', slice: 'UI system' },
  'dev-fe': { phase: 'Build', slice: 'Frontend' },
  'dev-be': { phase: 'Build', slice: 'Backend' },
  'dev-be-2': { phase: 'Build', slice: 'Backend' },
  qa: { phase: 'Verify', slice: 'Quality gate' },
}
const ownerMeta = role => OWNER_SLICE[role] || { phase: 'Work', slice: 'Mission work' }

const OWNER_STATUS = {
  working: { label: 'ถืองานอยู่', cls: 'text-blue-300', card: 'border-blue-400/35 bg-blue-500/[0.06]' },
  done: { label: 'ส่งงานแล้ว', cls: 'text-emerald-300', card: 'border-emerald-400/25 bg-emerald-500/[0.04]' },
  error: { label: 'พลาด', cls: 'text-red-300', card: 'border-red-400/35 bg-red-500/[0.06]' },
  pending: { label: 'รอคิว', cls: 'text-muted-foreground/55', card: 'border-white/[0.06] bg-white/[0.02]' },
  skipped: { label: 'ข้าม', cls: 'text-muted-foreground/40', card: 'border-white/[0.05] bg-white/[0.015]' },
  stopped: { label: 'หยุด', cls: 'text-slate-300/70', card: 'border-white/[0.06] bg-white/[0.02]' },
}
const ownerStatus = s => OWNER_STATUS[s] || OWNER_STATUS.pending

function OwnerCard({ step, liveNow, onPick, parallel = false, paused = false }) {
  const meta = ownerMeta(step.role)
  const st = ownerStatus(step.status)
  const busy = step.status === 'working'
  const revising = busy && (step.rev || 0) >= 2
  const elapsed = fmtDur(step.started_at, step.finished_at)
    || (busy && step.started_at ? fmtDur(step.started_at, Math.floor(liveNow / 1000)) : '')
  const label = paused ? 'รอคุณตอบ' : revising ? `ตีกลับแก้ · รอบ ${step.rev}` : st.label
  const labelCls = paused || revising ? 'text-rose-300' : st.cls
  const cardCls = paused ? 'border-rose-400/40 bg-rose-500/[0.06]' : st.card
  return (
    <button
      type="button"
      onClick={() => onPick(step)}
      title={`${step.name} · ${meta.slice} — ${label}`}
      data-testid={`run-owner-${step.role}`}
      data-owner-status={step.status}
      data-owner-parallel={parallel ? '1' : undefined}
      className={`group relative overflow-hidden rounded-lg border px-2.5 py-2 text-left transition-all hover:-translate-y-0.5 hover:border-white/25 ${cardCls} ${parallel ? 'min-w-[132px] flex-1' : 'min-w-[150px]'}`}
    >
      {busy && !paused && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-400/70 to-transparent" />
      )}
      <div className="flex items-center gap-2">
        <Avatar className="h-6 w-6 shrink-0 border border-white/10">
          <AvatarFallback className={`text-[9px] ${busy ? 'bg-blue-500/20 text-blue-200' : ''}`}>{initials(step.name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-semibold text-foreground/90">{step.name}</div>
          <div className="truncate text-[9.5px] text-muted-foreground/50">{meta.phase} · {meta.slice}</div>
        </div>
        {paused ? <span className="attention-dot h-2 w-2 shrink-0 rounded-full bg-rose-400" />
          : busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-300" />
          : step.status === 'done' ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
          : step.status === 'error' ? <X className="h-3.5 w-3.5 shrink-0 text-red-400" />
          : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/15" />}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[9.5px]">
        <span className={`shrink-0 whitespace-nowrap font-semibold ${labelCls}`}>{label}</span>
        {elapsed && <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground/35">· {elapsed}</span>}
      </div>
    </button>
  )
}

// Who holds the work in this run. Consecutive dev roles fan out as waves —
// mirror the orchestrator's plan_work_stages: a dev reports to another dev only
// when its wave must wait for that manager, so levels split the group.
function planOwnerGroups(owners, reportsTo) {
  const levels = {}
  const levelOf = (role, guard = 0) => {
    if (levels[role] != null) return levels[role]
    const mgr = reportsTo?.[role]
    const lvl = mgr && mgr.startsWith('dev') && guard < 8 ? levelOf(mgr, guard + 1) + 1 : 0
    levels[role] = lvl
    return lvl
  }
  const groups = []
  let i = 0
  while (i < owners.length) {
    if (!owners[i].role.startsWith('dev')) {
      groups.push({ dev: false, steps: [owners[i]] })
      i += 1
      continue
    }
    const start = i
    while (i < owners.length && owners[i].role.startsWith('dev')) i += 1
    const devs = owners.slice(start, i)
    const maxLevel = Math.max(...devs.map(s => levelOf(s.role)))
    for (let level = 0; level <= maxLevel; level += 1) {
      const wave = devs.filter(s => levelOf(s.role) === level)
      if (wave.length) groups.push({ dev: true, steps: wave })
    }
  }
  return groups
}

function OwnershipBoard({ steps, liveNow, onPick, waitingHumanRoles, personas }) {
  const owners = (steps || []).filter(s => (s.kind || 'work') === 'work')
  if (!owners.length) return null
  const reportsTo = Object.fromEntries((personas || []).map(p => [p.role, p.reports_to]).filter(([, m]) => m))
  const groups = planOwnerGroups(owners, reportsTo)
  const liveOwners = owners.filter(s => s.status === 'working')
  const delivered = owners.filter(s => s.status === 'done').length
  const waves = groups.filter(g => g.steps.length > 1).length
  const headline = liveOwners.length > 1
    ? `${liveOwners.length} คนกำลังทำขนานกัน`
    : liveOwners.length === 1
      ? `${liveOwners[0].name} ถืองานอยู่`
      : `${delivered}/${owners.length} คนส่งงานแล้ว${waves && delivered === owners.length ? ` · ${waves} wave ขนาน` : ''}`
  return (
    <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/20 p-3" data-testid="run-ownership">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/40">
          <Users className="h-3 w-3" /> ใครถืองานไหน <span className="text-muted-foreground/25">· {owners.length} คน</span>
        </div>
        <span className="text-[10px] text-muted-foreground/45">{headline}</span>
      </div>
      <div className="flex flex-wrap items-stretch gap-1.5">
        {groups.map(g => {
          const paused = waitingHumanRoles && g.steps.some(s => waitingHumanRoles.has(s.role))
          return g.steps.length > 1 ? (
            <div
              key={g.steps.map(stepKey).join('|')}
              className="min-w-[300px] flex-[2] rounded-lg border border-violet-400/25 bg-violet-500/[0.045] p-1.5"
              data-testid={`owner-wave-${g.steps.map(s => s.role).join('-')}`}
            >
              <div className="mb-1 flex items-center gap-1 px-0.5 text-[8.5px] font-bold uppercase tracking-[0.12em] text-violet-300/85">
                <GitBranch className="h-2.5 w-2.5" /> ขนานกัน · {g.steps.length}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.steps.map(s => (
                  <OwnerCard key={stepKey(s)} step={s} liveNow={liveNow} onPick={onPick} parallel paused={!!paused && waitingHumanRoles.has(s.role)} />
                ))}
              </div>
            </div>
          ) : (
            <OwnerCard key={stepKey(g.steps[0])} step={g.steps[0]} liveNow={liveNow} onPick={onPick} paused={!!paused} />
          )
        })}
      </div>
    </div>
  )
}

function RunHistory({ runs, current, onPick }) {
  if (!runs?.length) return null
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" data-testid="run-history">
      <span className="flex shrink-0 items-center gap-1 pr-0.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/35">
        <History className="h-3 w-3" /> Runs
      </span>
      {runs.slice(0, 8).map(r => {
        const st = runState(r.status)
        const active = current?.id === r.id
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick(r)}
            title={r.task}
            data-testid={`run-chip-${r.id}`}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10.5px] transition-all ${
              active
                ? 'border-primary/45 bg-primary/15 text-white shadow-[0_0_14px_-6px_rgba(139,92,246,.8)]'
                : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground/60 hover:border-white/20 hover:text-foreground'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${st.dot} ${r.status === 'running' ? 'animate-pulse' : ''}`} />
            <span className="font-mono">{r.id.replace('run-', '#')}</span>
            <span className="hidden sm:inline">{st.short}</span>
            <span className="hidden text-muted-foreground/35 md:inline">{relTime(r.created_at)}</span>
          </button>
        )
      })}
    </div>
  )
}

function PulseTile({ icon: Icon, label, value, meta, tone = 'text-primary', delay = 1, live = false, children }) {
  return (
    <div className={`rise-in stagger-${delay} relative overflow-hidden rounded-2xl border border-white/[0.06] bg-card/70 p-4`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/40">
        <Icon className={`h-3.5 w-3.5 ${tone}`} />
        {label}
        {live && <Radio className="ml-auto h-3 w-3 animate-pulse text-emerald-400" />}
      </div>
      <div className="mt-2.5 flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-[22px] font-semibold leading-none tracking-[-0.03em] text-white tabular-nums">{value}</span>
        {meta && <span className="truncate text-[11px] text-muted-foreground/55">{meta}</span>}
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  )
}

// Pre-push diff review: the human sees exactly what will be pushed and can send
// it back to Dev once with a comment (a second reject skips the PR entirely).
function ReviewCard({ run, onDecide, deciding }) {
  const [comment, setComment] = useState('')
  const rv = run.review
  if (!rv) return null
  const pending = rv.status === 'pending'
  const tone = rv.status === 'approved' ? 'border-emerald-500/40 bg-emerald-500/5'
    : pending ? 'border-sky-500/40 bg-sky-500/5'
    : 'border-rose-500/40 bg-rose-500/5'
  return (
    <div className={`mb-3 rounded-xl border p-3.5 ${tone}`} data-testid="review-card" data-status={rv.status}>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-sky-300" />
        <span className="text-[12.5px] font-bold text-sky-200">Diff review — ก่อน push/PR</span>
        <Badge variant={pending ? 'created' : rv.status === 'approved' ? 'running' : 'dead'} className="text-[9.5px]">
          {pending ? 'รอคุณอนุมัติ' : rv.status === 'approved' ? 'approved' : rv.status === 'timed_out' ? 'timed out — ข้าม PR' : 'rejected'}
        </Badge>
        {rv.files?.length > 0 && <span className="text-[11px] text-muted-foreground/60">{rv.files.length} ไฟล์</span>}
      </div>
      {rv.files?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {rv.files.map(f => <code key={f} className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-sky-200/80">{f}</code>)}
        </div>
      )}
      {rv.diff && (
        <div className="mt-2 max-h-[260px] overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-2.5">
          <pre className="whitespace-pre font-mono text-[10.5px] leading-relaxed text-foreground/75">{rv.diff}</pre>
        </div>
      )}
      {pending && (
        <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            className="h-8 flex-1 text-[12px]"
            placeholder="เหตุผลที่ตีกลับ (ถ้าจะให้ Dev แก้)…"
            value={comment}
            onChange={e => setComment(e.target.value)}
            data-testid="review-comment"
          />
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={() => onDecide('approve', comment.trim())} disabled={deciding} data-testid="review-approve" className="h-8">
              {deciding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDecide('reject', comment.trim())} disabled={deciding || !comment.trim()} data-testid="review-reject" className="h-8 border-rose-400/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200">
              <X className="h-3.5 w-3.5" /> Reject
            </Button>
          </div>
        </div>
      )}
      {!pending && rv.comment && <div className="mt-2 text-[11.5px] text-muted-foreground/70">คอมเมนต์: {rv.comment}</div>}
    </div>
  )
}

// Budget overrun is a pause, not a kill: the run waits for an explicit new
// ceiling. A normal chat reply deliberately cannot raise it.
function BudgetCard({ d, run, onRaise, onStop, busy }) {
  const [amount, setAmount] = useState('')
  const open = d.status === 'need_human'
  const cost = run.cost_usd || 0
  return (
    <div className={`rounded-xl border p-3.5 ${open ? 'border-amber-400/60 bg-amber-500/[0.06]' : 'border-white/[0.08] bg-white/[0.02]'}`} data-testid="budget-card" data-status={d.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Wallet className="h-4 w-4 text-amber-300" />
        <span className="text-[12.5px] font-bold text-amber-200">Budget guardrail</span>
        <Badge variant={open ? 'yellow' : 'running'} className="text-[9.5px]">{open ? '⏸ ใช้งบครบ — รออนุมัติ' : d.status}</Badge>
      </div>
      <div className="mt-1.5 text-[12px] text-muted-foreground/80">
        ใช้ไป <strong className="text-foreground">{fmtUsd(cost)}</strong> จากเพดาน <strong className="text-foreground">{fmtUsd(run.budget_usd)}</strong>
        {' · '}{fmtTok((run.input_tokens || 0) + (run.output_tokens || 0))} tokens
      </div>
      {open && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Input type="number" min="0" step="0.5" className="h-8 w-36 text-[12px]" placeholder="เพดานใหม่ (USD)" value={amount} onChange={e => setAmount(e.target.value)} data-testid="budget-amount" />
          <Button size="sm" className="h-8" disabled={busy || !(Number(amount) > cost)} onClick={() => onRaise(Number(amount))} data-testid="budget-raise">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />} เพิ่มงบ
          </Button>
          <Button size="sm" variant="outline" className="h-8 border-red-500/40 text-rose-300 hover:bg-red-500/10 hover:text-rose-200" disabled={busy} onClick={onStop}>
            <Square className="h-3.5 w-3.5 fill-current" /> หยุด run
          </Button>
          <span className="text-[10.5px] text-muted-foreground/50">ตอบแชทปกติไม่เพิ่มงบ — ต้องกดปุ่มนี้เท่านั้น</span>
        </div>
      )}
    </div>
  )
}

const EMPTY_ROUTINE = { name: '', task: '', cron: '0 9 * * 1-5', loop_mode: false, enabled: true }

function fmtWhen(secs) {
  if (!secs) return '—'
  return new Date(secs * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Scheduled missions for this project (5-field cron, local time).
function RoutinesTab({ projectId, onRunStarted }) {
  const [routines, setRoutines] = useState(null)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_ROUTINE)
  const [saving, setSaving] = useState(false)
  const [runningId, setRunningId] = useState(null)

  const load = useCallback(() => {
    authFetch(`${API}/projects/${projectId}/routines`).then(async r => {
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`)
      return d
    })
      .then(d => setRoutines(Array.isArray(d) ? d : []))
      .catch(err => { setRoutines([]); setError(err.message) })
  }, [projectId])
  useEffect(() => { load() }, [load])

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_ROUTINE)
    setError('')
    setDialogOpen(true)
  }

  function openEdit(r) {
    setEditing(r)
    setForm({ name: r.name, task: r.task, cron: r.cron, loop_mode: !!r.loop_mode, enabled: !!r.enabled })
    setError('')
    setDialogOpen(true)
  }

  async function save(e) {
    e.preventDefault()
    if (!form.name.trim() || !form.task.trim() || !form.cron.trim()) return setError('กรอกชื่อ งาน และ cron ให้ครบ')
    setSaving(true)
    setError('')
    try {
      const res = await authFetch(editing ? `${API}/routines/${editing.id}` : `${API}/projects/${projectId}/routines`, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setDialogOpen(false)
      load()
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  async function toggle(r) {
    setError('')
    const res = await authFetch(`${API}/routines/${r.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !r.enabled }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || `HTTP ${res.status}`)
    }
    load()
  }

  async function runNow(r) {
    setRunningId(r.id)
    setError('')
    try {
      const res = await authFetch(`${API}/routines/${r.id}/run`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      // Adopt the spawned run so Mission Control shows it immediately —
      // otherwise "Run now" silently starts work the user cannot see.
      if (data && data.id) onRunStarted?.(data)
      load()
    } catch (err) {
      setError(err.message)
    }
    setRunningId(null)
  }

  async function remove(r) {
    setError('')
    const res = await authFetch(`${API}/routines/${r.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || `HTTP ${res.status}`)
    }
    load()
  }

  return (
    <div data-testid="project-routines" className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-white">
            <CalendarClock className="h-4 w-4 text-primary" /> Scheduled routines
          </div>
          <div className="mt-1 text-[11.5px] text-muted-foreground/60">
            สั่งงานทีมซ้ำตามเวลา (cron 5 ช่อง, เวลาท้องถิ่น) — ถ้าโปรเจกต์กำลังมี run อยู่ รอบนั้นจะถูก skip
          </div>
        </div>
        <Button size="sm" onClick={openCreate} data-testid="routine-new"><Plus className="h-3.5 w-3.5" /> New routine</Button>
      </Card>

      {error && <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{error}</div>}

      {routines === null ? (
        <div className="text-[12px] text-muted-foreground/60">Loading routines…</div>
      ) : routines.length === 0 ? (
        <Card className="px-5 py-10 text-center text-[12.5px] text-muted-foreground/60" data-testid="routines-empty">
          ยังไม่มี routine — สร้างเพื่อให้ทีมทำงานซ้ำอัตโนมัติ เช่น สรุปงานทุกเช้าวันจันทร์
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {routines.map(r => (
            <Card key={r.id} className="p-4" data-testid="routine-row" data-enabled={r.enabled ? '1' : '0'}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-white">{r.name}</span>
                    <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-amber-200/80">{r.cron}</code>
                    {r.loop_mode && <Badge variant="purple" className="text-[9.5px]"><Repeat className="h-2.5 w-2.5" /> loop</Badge>}
                    <Badge variant={r.enabled ? 'running' : 'gray'} className="text-[9.5px]">{r.enabled ? 'enabled' : 'paused'}</Badge>
                  </div>
                  <div className="mt-1 truncate text-[12px] text-muted-foreground/75">{r.task}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground/50">
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> next: {r.enabled ? fmtWhen(r.next_run_at) : '—'}</span>
                    <span>last: {r.last_run_at ? fmtWhen(r.last_run_at) : 'never'}{r.last_result ? ` · ${r.last_result}` : ''}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[11.5px]" onClick={() => runNow(r)} disabled={runningId === r.id} data-testid="routine-run">
                    {runningId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run now
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11.5px]" onClick={() => toggle(r)} data-testid="routine-toggle">
                    {r.enabled ? 'Pause' : 'Enable'}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground/50 hover:text-foreground" onClick={() => openEdit(r)} aria-label="Edit routine"><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground/40 hover:bg-red-500/10 hover:text-red-400" onClick={() => remove(r)} aria-label="Delete routine"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit — ${editing.name}` : 'Routine ใหม่'}</DialogTitle>
            <DialogDescription>5-field cron: นาที ชั่วโมง วัน-ใน-เดือน เดือน วัน-ใน-สัปดาห์ · รองรับ * , - และ */n</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="grid gap-3.5">
            <div className="grid gap-1.5">
              <label className="field-label">ชื่อ routine</label>
              <Input value={form.name} placeholder="เช่น Morning triage" onChange={e => setForm({ ...form, name: e.target.value })} data-testid="routine-name" />
            </div>
            <div className="grid gap-1.5">
              <label className="field-label">งานที่สั่งทีม</label>
              <Textarea className="min-h-[90px] text-[12.5px]" value={form.task} placeholder="เช่น ตรวจ issue ใหม่, สรุปความคืบหน้า และอัปเดต CHANGELOG" onChange={e => setForm({ ...form, task: e.target.value })} data-testid="routine-task" />
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="grid gap-1.5">
                <label className="field-label">Cron</label>
                <Input className="font-mono text-[12.5px]" value={form.cron} onChange={e => setForm({ ...form, cron: e.target.value })} data-testid="routine-cron" />
                <span className="text-[10.5px] text-muted-foreground/50">ตัวอย่าง: <code className="font-mono">0 9 * * 1-5</code> = 09:00 ทุกวันจันทร์–ศุกร์</span>
              </div>
              <div className="flex flex-col justify-end gap-2 pb-1">
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
                  Enabled
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={form.loop_mode} onChange={e => setForm({ ...form, loop_mode: e.target.checked })} />
                  Loop mode
                </label>
              </div>
            </div>
            {error && <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12px] text-red-300" data-testid="routine-error">{error}</div>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving} data-testid="routine-save">{saving ? 'Saving…' : 'Save routine'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
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
  const [goal, setGoal] = useState('')
  const [budgetUsd, setBudgetUsd] = useState('')
  const [alertPct, setAlertPct] = useState('80')

  // Team run state
  const [task, setTask] = useState('')
  const [run, setRun] = useState(null)
  const [dispatching, setDispatching] = useState(false)
  const [runError, setRunError] = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [loopMode, setLoopMode] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryingStep, setRetryingStep] = useState(null)
  const [replySending, setReplySending] = useState(false)
  const [reviewDeciding, setReviewDeciding] = useState(false)
  const [budgetBusy, setBudgetBusy] = useState(false)
  const [openComments, setOpenComments] = useState(0)
  const [tab, setTab] = useState('mission')
  const [runHistory, setRunHistory] = useState([])
  const outputRef = useRef(null)
  const runIdRef = useRef(null)
  const latestRunIdRef = useRef(null)
  // Only ticks while a run is live, driving elapsed timers and step durations.
  const liveNow = useNow(run?.status === 'running' || run?.status === 'waiting_human')

  useEffect(() => { runIdRef.current = run?.id || null }, [run?.id])
  useEffect(() => { latestRunIdRef.current = runHistory[0]?.id || null }, [runHistory])

  // Click a node in the chart → live activity + work history of that agent
  const [detailAgent, setDetailAgent] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)

  function refreshPersonas() {
    authFetch(`${API}/agents`).then(r => r.json()).then(setPersonas).catch(() => {})
  }

  // Open doc comments across the project — badge on the Docs tab.
  const refreshOpenComments = useCallback(() => {
    authFetch(`${API}/projects/${id}/docs`).then(r => r.json()).then(list => {
      if (Array.isArray(list)) setOpenComments(list.reduce((n, d) => n + (d.open_comments || 0), 0))
    }).catch(() => {})
  }, [id])

  useEffect(() => { refreshOpenComments() }, [refreshOpenComments])

  useEffect(() => {
    authFetch(`${API}/projects/${id}`).then(r => r.json()).then(p => {
      if (p.detail) { setError(p.detail); return }
      setProject(p)
      setRepoUrl(p.repo_url || '')
      setGoal(p.goal || '')
      setBudgetUsd(p.budget_usd ? String(p.budget_usd) : '')
      setAlertPct(String(p.budget_alert_pct ?? 80))
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
    // Restore the latest run and keep this project's history for the run switcher.
    authFetch(`${API}/runs`).then(r => r.json()).then(runs => {
      const mine = (Array.isArray(runs) ? runs : [])
        .filter(r => r.project_id === id)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      setRunHistory(mine)
      if (mine.length) setRun(mine[0])
    }).catch(() => {})
  }, [id, setNodes, setEdges])

  // A run that just finished (or a scheduled one that started elsewhere) should
  // show up in the run switcher without a reload.
  useEffect(() => {
    if (!run || run.status === 'running' || run.status === 'waiting_human') return
    authFetch(`${API}/runs`).then(r => r.json()).then(list => {
      if (!Array.isArray(list)) return
      setRunHistory(list
        .filter(r => r.project_id === id)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0)))
    }).catch(() => {})
  }, [id, run?.id, run?.status])

  // While idle, watch for missions dispatched from elsewhere (another tab, a
  // routine, the API). Follow the newest run only when the user is already
  // looking at the newest one — picking an older run is never yanked away.
  useEffect(() => {
    if (run?.status === 'running' || run?.status === 'waiting_human') return
    let alive = true
    const load = async () => {
      try {
        const list = await authFetch(`${API}/runs`).then(r => r.json())
        if (!alive || !Array.isArray(list)) return
        const mine = list
          .filter(r => r.project_id === id)
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        const viewingLatest = !runIdRef.current || runIdRef.current === latestRunIdRef.current
        const prevLatest = latestRunIdRef.current
        setRunHistory(mine)
        latestRunIdRef.current = mine[0]?.id || null
        if (mine[0] && viewingLatest && mine[0].id !== runIdRef.current && mine[0].id !== prevLatest) {
          setRun(mine[0])
        }
      } catch { /* transient */ }
    }
    load()
    const t = setInterval(load, 6000)
    return () => { alive = false; clearInterval(t) }
  }, [id, run?.status])

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
    if (!run) return false
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
      return true
    } catch (e) {
      setRunError(e.message)
      return false
    } finally {
      setReplySending(false)
    }
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

  // Collapse finished steps on first view (a 9-agent run is otherwise a wall of
  // markdown), but keep failures and the live step readable.
  useEffect(() => {
    if (!run) return
    const next = {}
    for (const s of run.steps || []) {
      if (s.status !== 'working' && s.status !== 'error') next[stepKey(s)] = true
    }
    setCollapsed(next)
  }, [run?.id])

  function pickRun(r) {
    if (!r || r.id === run?.id) return
    setRun(r)
    setRunError('')
    requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  // Stage-rail click: reveal the matching step and bring it into view.
  function focusStep(step) {
    const key = stepKey(step)
    setCollapsed(c => ({ ...c, [key]: false }))
    requestAnimationFrame(() => {
      document.querySelector(`[data-step-key="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  // Layered left-to-right layout from the current links (longest-path depth).
  // Purely local until Save Team — same contract as dragging a node.
  function autoArrange() {
    const indeg = new Map(nodes.map(n => [n.id, 0]))
    const next = new Map(nodes.map(n => [n.id, []]))
    edges.forEach(e => {
      if (!indeg.has(e.target) || !next.has(e.source)) return
      indeg.set(e.target, indeg.get(e.target) + 1)
      next.get(e.source).push(e.target)
    })
    const level = new Map(nodes.map(n => [n.id, 0]))
    const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id)
    let guard = 0
    while (queue.length && guard++ < 500) {
      const cur = queue.shift()
      for (const to of next.get(cur) || []) {
        level.set(to, Math.max(level.get(to) || 0, (level.get(cur) || 0) + 1))
        indeg.set(to, indeg.get(to) - 1)
        if (indeg.get(to) === 0) queue.push(to)
      }
    }
    const columns = new Map()
    nodes.forEach(n => {
      const l = level.get(n.id) || 0
      if (!columns.has(l)) columns.set(l, [])
      columns.get(l).push(n.id)
    })
    const positions = {}
    for (const [l, ids] of columns) {
      ids.forEach((rid, i) => {
        positions[rid] = { x: 60 + Number(l) * 230, y: 50 + i * 128 }
      })
    }
    setNodes(ns => ns.map(n => positions[n.id] ? { ...n, position: positions[n.id] } : n))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    setError('')
    // Validate before sending: Number('') is 0 and Number('abc') is NaN — both
    // would silently persist a nonsense ceiling (or JSON.stringify to null).
    if (budgetUsd !== '') {
      const b = Number(budgetUsd)
      if (!Number.isFinite(b) || b <= 0) {
        setError('Budget ต้องเป็นตัวเลขมากกว่า 0 (หรือเว้นว่าง = ไม่จำกัด)')
        setSaving(false)
        return
      }
    }
    const pct = Number(alertPct)
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      setError('Alert % ต้องอยู่ระหว่าง 1–100')
      setSaving(false)
      return
    }
    try {
      const body = {
        repo_url: repoUrl,
        goal: goal.trim(),
        budget_usd: budgetUsd === '' ? null : Number(budgetUsd),
        budget_alert_pct: pct,
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
      setRunHistory(h => [data, ...h.filter(r => r.id !== data.id)])
      setRun(data)
      setCollapsed({})
      requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (err) {
      setRunError(err.message)
    }
    setDispatching(false)
  }

  // Re-dispatch the SAME task as a fresh run — the recovery path for a mission
  // whose steps died on a transient failure (e.g. provider 401 blip): nothing
  // mid-run is resumed, the team just takes the mission from the top.
  async function retryRun() {
    if (!run?.task || retrying) return
    setRetrying(true)
    setRunError('')
    try {
      const res = await authFetch(`${API}/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: run.task, loop: false }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRunHistory(h => [data, ...h.filter(r => r.id !== data.id)])
      setRun(data)
      setCollapsed({})
      requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (err) {
      setRunError(err.message)
    }
    setRetrying(false)
  }

  // Per-step retry — failures are per-step, so recovery is per-step too: only
  // THIS step is redone in place, everyone else's finished work is kept.
  async function retryOneStep(role, kind) {
    if (!run || retryingStep) return
    setRetryingStep(`${role}-${kind}`)
    setRunError('')
    try {
      const res = await authFetch(`${API}/runs/${run.id}/steps/${role}/${kind}/retry`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRun(data)
    } catch (err) {
      setRunError(err.message)
    }
    setRetryingStep(null)
  }

  async function decideReview(decision, comment) {
    if (!run || reviewDeciding) return
    setReviewDeciding(true)
    setRunError('')
    try {
      const res = await authFetch(`${API}/runs/${run.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comment }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRun(data)
    } catch (err) {
      setRunError(err.message)
    }
    setReviewDeciding(false)
  }

  // Raising the ceiling is deliberately an explicit action — a plain chat reply
  // never resumes a budget-paused run.
  async function raiseBudget(amount) {
    if (!run || budgetBusy) return
    setBudgetBusy(true)
    setRunError('')
    try {
      const res = await authFetch(`${API}/runs/${run.id}/budget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget_usd: amount }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setRun(data)
    } catch (err) {
      setRunError(err.message)
    }
    setBudgetBusy(false)
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
  // Role → that agent's WORK step only, so chat names/canvas rings never get
  // shadowed by the same agent's tail steps (pr/demo).
  const stepByRole = Object.fromEntries((run?.steps || []).filter(s => (s.kind || 'work') === 'work').map(s => [s.role, s]))
  const activeMeetings = (run?.discussions || []).filter(d => d.status !== 'resolved' && d.kind !== 'review' && d.kind !== 'budget')
  // review/budget gates get their own cards above the timeline, not chat threads
  const meetingDiscs = (run?.discussions || []).filter(d => d.kind !== 'review' && d.kind !== 'budget')
  // Agents paused on a need-human meeting
  const waitingHuman = run?.status === 'waiting_human'
  const waitingHumanRoles = new Set(
    (run?.discussions || []).filter(d => d.status === 'need_human' && d.kind !== 'review' && d.kind !== 'budget').flatMap(d => [d.from, ...d.to])
  )
  // Who each agent is talking to in a live meeting: role → display names of the others
  const meetingPartners = {}
  // Participants of a live discussion on the canvas. A demo session is the
  // orchestrator's — participants are whoever actually speaks in the thread
  // (qa / dev / po), not the "orchestrator" sender.
  const meetingParts = d => d.kind === 'demo'
    ? ([...new Set(d.messages.map(m => m.from).filter(r => r !== 'orchestrator' && r !== 'human'))].length
        ? [...new Set(d.messages.map(m => m.from).filter(r => r !== 'orchestrator' && r !== 'human'))]
        : ['po'])
    : [d.from, ...d.to.filter(r => r !== 'human')]
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
  // Work steps currently held by someone — the "who owns this mission?" glance.
  const liveOwners = (run?.steps || []).filter(s => (s.kind || 'work') === 'work' && s.status === 'working')

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
      const parts = meetingParts(d)
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
          kind: d.kind,
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
        return meetingParts(d).map(p => (reverted && p === d.from)
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

  // ---- Mission control summary values ----
  const status = run ? runState(run.status) : null
  const elapsed = run ? runElapsed(run, liveNow) : ''
  const totalTokens = run ? (run.input_tokens || 0) + (run.output_tokens || 0) : 0
  const needHumanMeetings = meetingDiscs.filter(d => d.status === 'need_human')
  const openMeetingCount = meetingDiscs.filter(d => d.status !== 'resolved').length
  const models = run ? [...new Set(run.steps.map(s => s.model).filter(Boolean))] : []
  const budgetPct = run?.budget_usd > 0 ? Math.min(100, Math.round(((run.cost_usd || 0) / run.budget_usd) * 100)) : null
  const anyExpanded = run ? run.steps.some(s => !collapsed[stepKey(s)]) : false
  const fieldCls = 'h-9 w-full rounded-lg border border-white/[0.07] bg-black/20 px-3 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 hover:border-white/[0.14] focus:border-primary/60 focus:ring-[3px] focus:ring-primary/15'

  return (
    <>
      <PageHeader
        leading={
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-white"
            onClick={() => router.push('/projects')}
            aria-label="Back to projects"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        }
        title={project.name}
        subtitle={project.goal || project.description || 'Team workspace — สั่งงานทีม AI แล้วดูทุกคนทำงานต่อกัน'}
        actions={
          <>
            {run && (
              <span className="hidden items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground/75 sm:flex">
                <span className={`h-1.5 w-1.5 rounded-full ${runState(run.status).dot} ${live ? 'animate-pulse' : ''}`} />
                {runState(run.status).label}
              </span>
            )}
            {error && <span className="text-[12px] text-red-400">{error}</span>}
            {saved && <span className="flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="flow-saved">Saved <Check className="h-3.5 w-3.5" /></span>}
            <Button variant="outline" onClick={() => router.push(`/projects/${project.id}/tasks`)} data-testid="open-task-board">
              <ListTodo className="h-4 w-4" /> Tasks
            </Button>
            <Button onClick={save} disabled={saving} data-testid="flow-save">
              <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save Team'}
            </Button>
          </>
        }
      />

      <div className="page-body">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="mb-5 h-auto w-full justify-start gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
            {[['mission', 'Mission Control'], ['routines', 'Routines'], ['docs', 'Docs']].map(([v, label]) => (
              <TabsTrigger
                key={v}
                value={v}
                data-testid={`tab-${v}`}
                className="rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold text-muted-foreground/65 transition-all hover:text-foreground data-[state=active]:bg-white/[0.07] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              >
                {label}
                {v === 'docs' && openComments > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-300" data-testid="docs-comment-badge">{openComments}</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="mission" className="mt-0">
            {/* Project pulse — the four numbers you need before touching anything */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <PulseTile
                icon={Users}
                label="Team"
                value={nodes.length}
                meta="agents"
                delay={1}
              >
                <div className="flex items-center gap-1.5">
                  <div className="flex -space-x-1.5">
                    {personas.slice(0, 6).map(p => (
                      <Avatar key={p.role} className="h-5 w-5 border border-background ring-1 ring-white/[0.08]">
                        <AvatarFallback className="text-[7.5px]">{initials(p.name)}</AvatarFallback>
                      </Avatar>
                    ))}
                  </div>
                  <span className="text-[10.5px] text-muted-foreground/45">
                    {personas.length > 6 ? `+${personas.length - 6}` : 'persona pool'} · {models.length || 0} model{models.length === 1 ? '' : 's'}
                  </span>
                </div>
              </PulseTile>

              <PulseTile
                icon={Activity}
                label="Mission"
                value={status ? status.label : 'Idle'}
                meta={run ? (run.loop_mode ? `loop ${run.iteration || 1}` : `round ${run.round || 1}`) : 'no run yet'}
                tone={status ? status.text : 'text-muted-foreground/50'}
                delay={2}
                live={live}
              >
                <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground/45">
                  <span className="font-mono">{run?.id || '—'}</span>
                  {elapsed && <span>· {elapsed}</span>}
                </div>
              </PulseTile>

              <PulseTile
                icon={Layers}
                label="Delivered"
                value={run ? `${doneCount}/${run.steps.length}` : '—'}
                meta="steps"
                tone="text-emerald-300"
                delay={3}
              >
                <Progress
                  value={run ? (doneCount / Math.max(1, run.steps.length)) * 100 : 0}
                  className="h-1"
                  indicatorClassName={run?.status === 'error' ? 'bg-gradient-to-r from-rose-500 to-red-400' : 'bg-gradient-to-r from-emerald-500 to-cyan-400'}
                />
              </PulseTile>

              <PulseTile
                icon={Wallet}
                label="Spend"
                value={run ? fmtUsd(run.cost_usd) : '$0.00'}
                meta={run?.budget_usd ? `/ ${fmtUsd(run.budget_usd)}` : 'no cap'}
                tone="text-amber-300"
                delay={4}
              >
                <div className="flex items-center justify-between text-[10px] text-muted-foreground/45">
                  <span>{fmtTok(totalTokens)} tokens</span>
                  {run?.budget_usd ? <span>{budgetPct ?? 0}% ของเพดาน</span> : <span>ไม่ได้ตั้งงบต่อ run</span>}
                </div>
              </PulseTile>
            </div>

            {/* Mission composer — one clear command surface */}
            <Card className="rise-in stagger-2 mt-5 overflow-hidden" data-testid="mission-control">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/25 via-primary/20 to-indigo-500/10 text-primary ring-1 ring-inset ring-primary/20">
                    <Send className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-[13.5px] font-semibold text-white">สั่งงานทีม AI</div>
                    <div className="text-[11px] text-muted-foreground/55">
                      {nodes.length} agents รับงานต่อกันเป็นทอด ๆ แล้วส่ง deliverable กลับมาที่นี่
                    </div>
                  </div>
                </div>
                <span className="hidden items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[10px] text-muted-foreground/45 sm:flex">
                  <kbd className="rounded bg-white/[0.07] px-1 py-0.5 font-sans text-[9.5px] font-semibold text-muted-foreground/70">⌘</kbd>
                  <span>+</span>
                  <kbd className="rounded bg-white/[0.07] px-1 py-0.5 font-sans text-[9.5px] font-semibold text-muted-foreground/70">Enter</kbd>
                  เพื่อสั่งงาน
                </span>
              </div>

              <form onSubmit={dispatch} className="flex flex-col gap-4 p-5">
                <div className="flex flex-col gap-2.5 lg:flex-row lg:items-stretch">
                  <div className="group relative flex-1">
                    <Textarea
                      data-testid="task-input"
                      placeholder="บอกทีมว่าจะทำอะไร เช่น: Redesign หน้า Dashboard ให้เป็น design tokens + layout ใหม่ พร้อม animation"
                      className="min-h-[92px] resize-none border-white/[0.07] bg-black/20 text-[13px] leading-relaxed focus:border-primary/60"
                      value={task}
                      onChange={e => setTask(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          if (!dispatching && !live) e.currentTarget.form?.requestSubmit()
                        }
                      }}
                    />
                    <span className="pointer-events-none absolute bottom-2.5 right-3 text-[10px] text-muted-foreground/30">
                      {task.trim() ? `${task.trim().length} ตัวอักษร` : 'Shift + Enter = ขึ้นบรรทัดใหม่'}
                    </span>
                  </div>
                  <Button
                    type="submit"
                    disabled={dispatching || live}
                    data-testid="dispatch-team"
                    className="btn-sheen h-auto min-h-[56px] px-5 lg:w-[158px]"
                  >
                    {dispatching || live
                      ? <><Loader2 className="h-4 w-4 animate-spin" /> กำลังทำงาน…</>
                      : <><Send className="h-4 w-4" /> สั่งงานทีม</>}
                  </Button>
                </div>

                <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/35">
                    <Layers className="h-3 w-3" /> Mission context
                  </div>
                  <div className="grid gap-2.5 lg:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                      <input
                        data-testid="project-repo"
                        aria-label="Git repository"
                        className={fieldCls}
                        placeholder="Git repo (https://github.com/owner/repo)"
                        value={repoUrl}
                        onChange={e => { setRepoUrl(e.target.value); setSaved(false) }}
                        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Target className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                      <input
                        data-testid="project-goal"
                        aria-label="Project goal"
                        className={fieldCls}
                        placeholder="Goal ของโปรเจกต์ — ทุก deliverable ยึดเป้านี้"
                        value={goal}
                        onChange={e => { setGoal(e.target.value); setSaved(false) }}
                        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                        title="Goal ancestry: ถูกใส่ใน prompt ของทุกขั้นตอน"
                      />
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
                    <div className="flex items-center gap-2">
                      <Wallet className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                      <input
                        data-testid="project-budget"
                        aria-label="Budget per run (USD)"
                        type="number"
                        min="0"
                        step="0.5"
                        className={`${fieldCls} !w-36`}
                        placeholder="Budget / run (USD)"
                        value={budgetUsd}
                        onChange={e => { setBudgetUsd(e.target.value); setSaved(false) }}
                        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                        title="เพดานต่อ run — ถึงเพดานแล้ว run จะ pause รออนุมัติ ไม่ตัดจบเอง"
                      />
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50">
                      <span>alert ที่</span>
                      <input
                        data-testid="project-budget-alert"
                        aria-label="Budget alert percentage"
                        type="number"
                        min="1"
                        max="100"
                        className={`${fieldCls} !w-16 !px-2 text-center`}
                        value={alertPct}
                        onChange={e => { setAlertPct(e.target.value); setSaved(false) }}
                        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                      />
                      <span>%</span>
                    </div>
                    <span className="hidden text-[10.5px] text-muted-foreground/35 md:inline">ถึงเพดานแล้ว pause รออนุมัติเพิ่มงบ</span>
                    <label className="ml-auto flex cursor-pointer items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11.5px] text-muted-foreground/70 transition-colors hover:border-white/[0.12] hover:text-foreground" data-testid="loop-toggle" title="จบรอบแล้ว PO ประเมินและสั่งรอบถัดไปอัตโนมัติ จนกว่า goal สำเร็จหรือกดหยุด">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-primary"
                        checked={loopMode}
                        onChange={e => setLoopMode(e.target.checked)}
                        disabled={live}
                      />
                      <Repeat className="h-3.5 w-3.5" /> ทำงานเป็น Loop
                    </label>
                  </div>
                </div>

                {runError && <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-300">{runError}</div>}
              </form>
            </Card>

            {!run && (
              <Card className="rise-in stagger-3 mt-4 overflow-hidden">
                <div className="relative flex flex-col items-center px-6 py-12 text-center">
                  <div className="pointer-events-none absolute left-1/2 top-0 h-40 w-80 -translate-x-1/2 rounded-full bg-primary/[0.08] blur-3xl" />
                  <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/[0.08] text-primary shadow-[0_18px_40px_-24px_rgba(139,92,246,0.9)]">
                    <Sparkles className="h-6 w-6" />
                  </div>
                  <div className="relative mt-4 text-[15px] font-semibold text-white">พร้อมรับ mission แรก</div>
                  <div className="relative mt-1.5 max-w-md text-[12px] leading-relaxed text-muted-foreground/55">
                    พิมพ์งานด้านบนแล้วกดสั่ง — ทีมจะรับงานตามลำดับ เปิด meeting เมื่อติดขัด และส่ง PR + demo ให้ตรวจรับ
                  </div>
                  <div className="relative mt-5 flex flex-wrap justify-center gap-1.5">
                    {TASK_IDEAS.map(idea => (
                      <button
                        key={idea.label}
                        type="button"
                        onClick={() => setTask(idea.text)}
                        className="rounded-full border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-[11px] text-muted-foreground/60 transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:text-primary"
                      >
                        {idea.label}
                      </button>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {run && (
              <div ref={outputRef} className="mt-5 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]" data-testid="run-timeline">
                <Card className="rise-in stagger-3 overflow-hidden">
                  {/* Run header — status, live timing, stage rail, run switcher */}
                  <div className="border-b border-white/[0.06] p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                          run.status === 'error' ? 'border-red-400/25 bg-red-500/10 text-red-300'
                          : run.status === 'waiting_human' ? 'border-rose-400/30 bg-rose-500/10 text-rose-300'
                          : live ? 'border-blue-400/30 bg-blue-500/10 text-blue-300'
                          : run.status === 'done' ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                          : 'border-white/10 bg-white/[0.03] text-muted-foreground/60'
                        }`}>
                          {live ? <Activity className="h-4 w-4 animate-pulse" /> : run.status === 'done' ? <CheckCircle2 className="h-4 w-4" /> : run.status === 'error' ? <XCircle className="h-4 w-4" /> : <Square className="h-3.5 w-3.5" />}
                          {live && <span className="ping-soft absolute inset-0 rounded-xl bg-blue-400/10" />}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={status.badge} className="gap-1.5">
                              <span className={`h-1.5 w-1.5 rounded-full ${status.dot} ${live ? 'animate-pulse' : ''}`} />
                              {status.label}
                            </Badge>
                            {run.phase && run.phase !== 'done' && (
                              <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/55">
                                {run.phase === 'meeting' ? 'team meeting' : run.phase === 'demo' ? 'demo & acceptance' : run.phase === 'review' ? 'diff review' : run.phase === 'budget' ? 'budget gate' : run.phase}
                              </span>
                            )}
                            {run.loop_mode && (
                              <Badge variant="purple" className="gap-1" data-testid="loop-badge">
                                <Repeat className="h-3 w-3" /> Loop{run.iteration > 1 ? ` รอบที่ ${run.iteration}` : ''}{run.status === 'done' && !run.next_run_id ? ' · กำลังประเมินรอบถัดไป…' : ''}
                              </Badge>
                            )}
                            {run.trigger === 'scheduled' && (
                              <Badge variant="cyan" className="gap-1" data-testid="scheduled-badge" title={run.routine_id ? `routine ${run.routine_id}` : 'scheduled run'}>
                                <CalendarClock className="h-3 w-3" /> scheduled
                              </Badge>
                            )}
                            <span className="font-mono text-[10px] text-muted-foreground/35">{run.id}</span>
                            {run.task_id && (
                              <button
                                type="button"
                                onClick={() => router.push(`/projects/${project.id}/tasks/${run.task_id}`)}
                                className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[9.5px] text-muted-foreground/60 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-primary/10 hover:text-primary"
                                title="เปิด task ของ mission นี้"
                                data-testid="run-task-link"
                              >
                                <ListTodo className="h-2.5 w-2.5" /> {run.task_id}
                              </button>
                            )}
                          </div>
                          <p className="mt-1.5 line-clamp-2 max-w-2xl text-[12px] leading-relaxed text-muted-foreground/70">“{run.task}”</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {live && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={stopTeam}
                            disabled={stopping}
                            data-testid="stop-team"
                            className="h-8 gap-1.5 border-red-500/35 text-[11.5px] text-red-400 hover:bg-red-500/10 hover:text-red-300"
                            title="หยุดตรงนี้ — งานที่เหลือถูกข้าม และ loop จะไม่สั่งรอบถัดไป"
                          >
                            {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />} หยุดทีม
                          </Button>
                        )}
                        {!live && run.steps.some(s => s.status === 'error') && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={retryRun}
                            disabled={retrying}
                            data-testid="retry-mission"
                            className="h-8 gap-1.5 border-amber-500/35 text-[11.5px] text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                            title="สั่งงานเดิมซ้ำเป็น run ใหม่ — ทีมทำ mission นี้ตั้งแต่ต้นอีกรอบ (ถ้า failed แค่บาง step ให้กดปุ่ม ลองซ้ำ ที่ step นั้นแทน)"
                          >
                            {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} เริ่ม mission ใหม่
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground/55">
                      <span className="flex items-center gap-1.5" data-testid="run-elapsed">
                        <Timer className="h-3.5 w-3.5 text-muted-foreground/40" /> {elapsed || '—'}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5 text-muted-foreground/40" /> {doneCount}/{run.steps.length} ส่งงานแล้ว
                      </span>
                      {liveOwners.length > 0 && (
                        <span className="flex items-center gap-1.5 text-blue-300/90" data-testid="run-live-owners" title={liveOwners.map(s => s.name).join(', ')}>
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-400" />
                          </span>
                          ถืองานอยู่: {liveOwners.map(s => s.name).join(', ')}
                          {liveOwners.length > 1 && <span className="font-semibold text-blue-200/70">· ขนาน {liveOwners.length}</span>}
                        </span>
                      )}
                      {(run.cost_usd > 0 || run.budget_usd) && (
                        <span
                          className="flex items-center gap-1.5 tabular-nums"
                          data-testid="run-cost"
                          title={`${fmtTok(run.input_tokens)} input + ${fmtTok(run.output_tokens)} output tokens`}
                        >
                          <Wallet className="h-3.5 w-3.5 shrink-0 text-emerald-400/70" />
                          <strong className="font-semibold text-foreground/85">{fmtUsd(run.cost_usd)}</strong>
                          {run.budget_usd ? <span className="text-muted-foreground/40">/ {fmtUsd(run.budget_usd)}</span> : null}
                          <span className="text-muted-foreground/35">· {fmtTok(totalTokens)} tok</span>
                        </span>
                      )}
                      {run.cost_alerted && (
                        <Badge variant="yellow" className="gap-1" data-testid="cost-alert">
                          <AlertTriangle className="h-3 w-3" /> ใช้งบ ≥ {project.budget_alert_pct ?? 80}%
                        </Badge>
                      )}
                      {meetingDiscs.length > 0 && (
                        <span className="flex items-center gap-1.5 text-amber-300/85">
                          <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
                          {meetingDiscs.length} meeting{openMeetingCount ? ` · ค้าง ${openMeetingCount}` : ' — ปิดครบแล้ว'}
                        </span>
                      )}
                      {revertTotal > 0 && (
                        <span className="flex items-center gap-1.5 text-rose-300/85" data-testid="run-reverts">
                          <Undo2 className="h-3.5 w-3.5 shrink-0" />↩ ตีกลับแก้ {revertTotal} งาน{revisingRoles.size > 0 ? ' · กำลังแก้อยู่' : ''}
                        </span>
                      )}
                    </div>

                    {run.steps.length > 0 && (
                      <div className="mt-3 flex items-center gap-3">
                        <Progress
                          value={(doneCount / Math.max(1, run.steps.length)) * 100}
                          className="h-1.5"
                          indicatorClassName={`${live ? 'progress-live ' : ''}${run.status === 'error' ? 'bg-gradient-to-r from-rose-500 to-red-400' : 'bg-gradient-to-r from-violet-500 via-primary to-indigo-400'}`}
                        />
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">
                          {Math.round((doneCount / Math.max(1, run.steps.length)) * 100)}%
                        </span>
                      </div>
                    )}

                    {run.steps.length > 0 && (
                      <div className="mt-3.5">
                        <StageRail steps={run.steps} onPick={focusStep} />
                      </div>
                    )}

                    <OwnershipBoard steps={run.steps} liveNow={liveNow} waitingHumanRoles={waitingHumanRoles} personas={personas} onPick={focusStep} />

                    <div className="mt-3">
                      <RunHistory runs={runHistory} current={run} onPick={pickRun} />
                    </div>

                    {needHumanMeetings.length > 0 && (
                      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-rose-400/35 bg-rose-500/[0.07] px-3.5 py-2.5">
                        <div className="flex items-center gap-2 text-[12px] text-rose-200">
                          <span className="attention-dot h-2 w-2 shrink-0 rounded-full bg-rose-400" />
                          <strong className="font-semibold">{needHumanMeetings.length} คำถามรอคุณตอบ</strong>
                          <span className="text-rose-200/60">— ทีมหยุดรออยู่</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-rose-400/35 text-[11px] text-rose-200 hover:bg-rose-500/10 hover:text-white"
                          onClick={() => document.getElementById('run-meetings')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                        >
                          <MessagesSquare className="h-3.5 w-3.5" /> ไปตอบ
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-3 p-4 sm:p-5">
                    {run.watchdog_note && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-200" data-testid="watchdog-note">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{run.watchdog_note}</span>
                      </div>
                    )}
                    {runError && (
                      <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-300" data-testid="run-error">
                        {runError}
                      </div>
                    )}

                    {/* Attention gates: review + budget always sit above the wall of steps */}
                    <ReviewCard run={run} onDecide={decideReview} deciding={reviewDeciding} />
                    {(run.discussions || []).filter(d => d.kind === 'budget').length > 0 && (
                      <div className="flex flex-col gap-2.5">
                        {run.discussions.filter(d => d.kind === 'budget').map(d => (
                          <BudgetCard
                            key={d.id}
                            d={d}
                            run={run}
                            onRaise={raiseBudget}
                            onStop={stopTeam}
                            busy={budgetBusy || stopping}
                          />
                        ))}
                      </div>
                    )}

                    {run.acceptance && (
                      <div
                        className={`rounded-xl border p-3.5 ${run.acceptance.verdict === 'pass' ? 'border-emerald-500/35 bg-emerald-500/[0.06]' : 'border-rose-500/35 bg-rose-500/[0.06]'}`}
                        data-testid="acceptance-card"
                        data-verdict={run.acceptance.verdict}
                      >
                        <div className={`mb-1.5 flex items-center gap-2 text-[12.5px] font-bold ${run.acceptance.verdict === 'pass' ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {run.acceptance.verdict === 'pass' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                          Acceptance: {run.acceptance.verdict.toUpperCase()} — ตัดสินโดย PO จาก demo session
                        </div>
                        <div
                          className="max-h-[260px] overflow-auto text-[12.5px] [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[13.5px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                          dangerouslySetInnerHTML={{ __html: marked.parse(run.acceptance.summary) }}
                        />
                      </div>
                    )}

                    {run.summary && (
                      <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/[0.06] p-3.5" data-testid="run-summary">
                        <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-bold text-emerald-400">
                          <CheckCircle2 className="h-4 w-4" /> สรุป mission โดย PO
                        </div>
                        <div
                          className="max-h-[260px] overflow-auto text-[12.5px] [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[13.5px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                          dangerouslySetInnerHTML={{ __html: marked.parse(run.summary) }}
                        />
                      </div>
                    )}

                    <div className="mt-1 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/35">
                        <Layers className="h-3 w-3" /> Deliverables
                        <span className="text-muted-foreground/25">· {run.steps.length}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-[11px] text-muted-foreground/50 hover:text-foreground"
                        onClick={() => {
                          const next = {}
                          run.steps.forEach(s => { next[stepKey(s)] = anyExpanded })
                          setCollapsed(next)
                        }}
                      >
                        <ChevronsUpDown className="h-3.5 w-3.5" /> {anyExpanded ? 'ย่อทั้งหมด' : 'ขยายทั้งหมด'}
                      </Button>
                    </div>

                    <div className="flex flex-col gap-2">
                      {run.steps.map((step, i) => {
                        const sKey = stepKey(step)
                        const kind = step.kind || 'work'
                        const open = !collapsed[sKey]
                        const reverting = live && kind === 'work' && revisingRoles.has(step.role) && step.status === 'working'
                        const duration = fmtDur(step.started_at, step.finished_at)
                          || (step.status === 'working' && step.started_at ? fmtDur(step.started_at, Math.floor(liveNow / 1000)) : '')
                        const preview = stripMarkdown(step.output)
                        const tone = step.status === 'done' ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-400'
                          : step.status === 'working' ? 'border-blue-400/30 bg-blue-500/10 text-blue-400'
                          : step.status === 'error' ? 'border-red-400/30 bg-red-500/10 text-red-400'
                          : step.status === 'stopped' || step.status === 'skipped' ? 'border-white/[0.08] bg-white/[0.02] text-muted-foreground/40'
                          : 'border-white/[0.08] bg-white/[0.02] text-muted-foreground/50'
                        return (
                          <div
                            key={sKey}
                            data-step-key={sKey}
                            className={`group relative overflow-hidden rounded-xl border bg-[#0d1420] transition-all ${
                              open ? 'border-white/[0.09]' : 'border-white/[0.05] hover:border-white/[0.12] hover:bg-[#101827]'
                            } ${reverting ? 'revert-flash border-rose-400/60' : ''}`}
                            data-testid={`run-step-${step.role}${kind !== 'work' ? `-${kind}` : ''}`}
                            data-status={step.status}
                            data-revert={reverting ? '1' : undefined}
                          >
                            {step.status === 'working' && (
                              <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-400/70 to-transparent" />
                            )}
                            <div className="flex w-full items-center gap-3 px-3 py-2.5">
                              <button
                                className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
                                onClick={() => setCollapsed(c => ({ ...c, [sKey]: open }))}
                                aria-expanded={open}
                              >
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${tone}`}>
                                  <StepStatusIcon status={reverting ? 'revising' : step.status} />
                                </span>
                                <Avatar className="hidden h-6 w-6 shrink-0 sm:flex">
                                  <AvatarFallback className="text-[9.5px]">{initials(step.name)}</AvatarFallback>
                                </Avatar>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="font-mono text-[9.5px] text-muted-foreground/35">{String(i + 1).padStart(2, '0')}</span>
                                    <span className="text-[13px] font-semibold text-white/95">{step.name}</span>
                                    <span className="text-[10.5px] text-muted-foreground/55">{step.title}</span>
                                    {step.rev && <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-rose-300">↩ rev {step.rev}</span>}
                                    {kind !== 'work' && <StepKindBadge kind={kind} />}
                                    {step.harness && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-violet-300" title="external CLI harness — unmetered">{step.harness}</span>}
                                  </div>
                                  {!open && (
                                    <div className="mt-1 flex min-w-0 items-center gap-1.5">
                                      <span className={`truncate text-[10.5px] ${reverting ? 'text-rose-300' : step.status === 'error' ? 'text-red-300/80' : 'text-muted-foreground/45'}`}>
                                        {preview || (reverting ? `ถูกตีกลับแก้ — กำลังทำ rev ${run.round}…` : STEP_HINT[step.status] || '')}
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <div className="hidden shrink-0 items-center gap-1.5 md:flex">
                                  {duration && <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground/50">{duration}</span>}
                                  {(step.input_tokens > 0 || step.output_tokens > 0 || step.cost_usd > 0 || step.metered === false) && (
                                    <span
                                      className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${step.metered === false ? 'bg-violet-500/10 text-violet-300' : 'bg-emerald-500/10 text-emerald-400'}`}
                                      data-testid={`step-cost-${step.role}${kind !== 'work' ? `-${kind}` : ''}`}
                                      title={step.metered === false ? 'external harness — ไม่คิดค่า token ผ่าน platform' : `input ${step.input_tokens.toLocaleString()} · output ${step.output_tokens.toLocaleString()} tokens${step.priced === false ? ' · ไม่มีราคาในตาราง (ประมาณการ)' : ''}`}
                                    >
                                      <Wallet className="h-3 w-3" />
                                      {step.metered === false
                                        ? 'unmetered'
                                        : <>{fmtTok((step.input_tokens || 0) + (step.output_tokens || 0))} tok · {fmtUsd(step.cost_usd)}{step.priced === false ? ' est.' : ''}</>}
                                    </span>
                                  )}
                                  {step.container && (
                                    <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400" title={`deliverable: ${step.deliverable || '-'}`}>
                                      <Container className="h-3 w-3" /> {step.container}
                                    </span>
                                  )}
                                </div>
                                <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                              </button>
                              {!live && (step.status === 'error' || step.status === 'skipped' || step.status === 'stopped') && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => retryOneStep(step.role, kind)}
                                  disabled={retryingStep !== null}
                                  data-testid={`retry-step-${step.role}${kind !== 'work' ? `-${kind}` : ''}`}
                                  className="h-7 shrink-0 gap-1.5 border-amber-500/35 text-[10.5px] text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                                  title={`สั่งเฉพาะ step นี้ซ้ำ — งานที่เสร็จแล้วของคนอื่นถูกเก็บไว้ทั้งหมด (สถานะเดิม: ${step.status})`}
                                >
                                  {retryingStep === sKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} ลองซ้ำ
                                </Button>
                              )}
                            </div>
                            <div className="collapse-shell" data-open={open}>
                              <div className="collapse-inner">
                                <div className="border-t border-white/[0.05] px-3.5 py-3">
                                  {step.status === 'pending' && <div className="text-[12px] text-muted-foreground/55">รอรับงาน…</div>}
                                  {reverting && (
                                    <div className="flex items-center gap-2 text-[12px] font-medium text-rose-300">
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> ↩ ถูกตีกลับแก้จาก meeting — กำลังแก้งานใหม่เป็น rev {run.round}…
                                    </div>
                                  )}
                                  {step.status === 'working' && !reverting && live && <div className="flex items-center gap-2 text-[12px] text-blue-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังทำงาน…</div>}
                                  {step.status === 'stopped' && <div className="text-[12px] text-muted-foreground/60">หยุดกลางคัน — run จบตอน step นี้กำลังทำงาน</div>}
                                  {step.status === 'error' && <div className="text-[12.5px] text-red-400">{step.output}</div>}
                                  {step.status === 'skipped' && <div className="text-[12px] text-muted-foreground/60">ข้าม — {step.output || 'ไม่มีเหตุผลระบุ'}</div>}
                                  {step.status === 'done' && (
                                    <>
                                      {step.deliverable && (
                                        <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-[10.5px] font-medium text-emerald-400 sm:hidden">
                                          <Container className="h-3 w-3" /> {step.container}: {step.deliverable}
                                        </div>
                                      )}
                                      <div
                                        className="max-h-[340px] overflow-auto text-[12.5px] [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[13.5px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-black/40 [&_pre]:p-2.5 [&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-secondary [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5"
                                        dangerouslySetInnerHTML={{ __html: marked.parse(step.output || '_ไม่มีเนื้อหา_') }}
                                      />
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </Card>

                <aside className="flex flex-col gap-4">
                  <Card id="run-meetings" className="rise-in stagger-4 overflow-hidden" data-testid="run-meetings">
                    <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
                      <div className="flex items-center gap-2 text-[12px] font-semibold text-amber-200">
                        <MessagesSquare className="h-4 w-4 text-amber-300" /> Live room
                      </div>
                      <Badge variant={openMeetingCount ? 'yellow' : 'gray'} className="text-[9.5px]">
                        {meetingDiscs.length ? `${openMeetingCount} open` : 'idle'}
                      </Badge>
                    </div>
                    <div className="flex flex-col gap-2.5 p-3">
                      {meetingDiscs.length === 0 && (
                        <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
                          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.02]">
                            <MessagesSquare className="h-4 w-4 text-muted-foreground/30" />
                          </span>
                          <div className="text-[11.5px] leading-relaxed text-muted-foreground/45">
                            ยังไม่มี meeting ใน run นี้<br />ทีมจะคุยกันตรงนี้เมื่อมีคำถามหรือ demo
                          </div>
                        </div>
                      )}
                      {meetingDiscs.map(d => (
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
                  </Card>

                  <Card className="rise-in stagger-5 overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3 text-[12px] font-semibold text-white/90">
                      <Activity className="h-4 w-4 text-primary" /> Run details
                    </div>
                    <div className="space-y-2.5 p-4 text-[11.5px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground/45">Trigger</span>
                        <span className="font-medium text-foreground/80">{run.trigger || 'manual'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground/45">Round</span>
                        <span className="font-medium text-foreground/80">{run.round || 1}{run.loop_mode ? ` · loop ${run.iteration || 1}` : ''}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground/45">Started</span>
                        <span className="font-medium text-foreground/80">{fmtWhen(run.steps.find(s => s.started_at)?.started_at) || '—'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground/45">Tokens</span>
                        <span className="font-mono text-[10.5px] text-foreground/75">{fmtTok(run.input_tokens)} in · {fmtTok(run.output_tokens)} out</span>
                      </div>
                      <div className="hairline my-1" />
                      <div>
                        <div className="mb-1.5 flex items-center justify-between text-[10.5px]">
                          <span className="text-muted-foreground/45">Cost</span>
                          <span className="tabular-nums text-foreground/80">
                            {fmtUsd(run.cost_usd)}{run.budget_usd ? ` / ${fmtUsd(run.budget_usd)}` : ''}
                          </span>
                        </div>
                        {budgetPct !== null ? (
                          <Progress
                            value={budgetPct}
                            className="h-1"
                            indicatorClassName={budgetPct >= (project.budget_alert_pct ?? 80) ? 'bg-gradient-to-r from-amber-500 to-rose-400' : 'bg-gradient-to-r from-emerald-500 to-cyan-400'}
                          />
                        ) : (
                          <div className="text-[10px] text-muted-foreground/35">ไม่ได้ตั้งเพดานต่อ run</div>
                        )}
                      </div>
                      {models.length > 0 && (
                        <>
                          <div className="hairline my-1" />
                          <div className="flex flex-wrap gap-1">
                            {models.map(m => (
                              <span key={m} className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9.5px] text-blue-300/70">{m}</span>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </Card>

                  {live && (
                    <div className="rise-in stagger-6 flex items-center gap-2 rounded-xl border border-blue-400/20 bg-blue-500/[0.06] px-3.5 py-2.5 text-[11px] text-blue-200/80">
                      <Radio className="h-3.5 w-3.5 shrink-0 animate-pulse" />
                      กำลังติดตามสถานะทุก 1.5 วินาที — หน้านี้ไม่ต้อง reload
                    </div>
                  )}
                </aside>
              </div>
            )}

            {/* Team topology — who talks to whom, with a live working state */}
            <section className="mt-6" data-testid="team-section">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-white">
                    <Users className="h-4 w-4 text-primary" /> Team topology
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground/55">
                    เส้นเชื่อม = ใครส่งงานให้ใคร · กดการ์ด agent เพื่อดูประวัติ/แก้ persona
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={autoArrange} className="h-8 gap-1.5 text-[11.5px]">
                    <Wand2 className="h-3.5 w-3.5" /> จัดเรียงอัตโนมัติ
                  </Button>
                  <Badge variant="gray" className="text-[10px]">{nodes.length} ในทีม</Badge>
                </div>
              </div>

              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] bg-white/[0.012] p-3">
                  <span className="mr-1 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/35">Personas</span>
                  {personas.map(p => {
                    const added = inProject.has(p.role)
                    return (
                      <button
                        key={p.role}
                        onClick={() => added ? removeAgent(p.role) : addAgent(p.role)}
                        className={`group flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-all ${
                          added
                            ? 'border-primary/40 bg-primary/[0.12] text-primary'
                            : 'border-white/[0.07] bg-white/[0.02] text-muted-foreground/60 hover:-translate-y-0.5 hover:border-white/20 hover:text-foreground'
                        }`}
                        data-testid={`palette-${p.role}`}
                      >
                        <Avatar className="h-4 w-4">
                          <AvatarFallback className="text-[7px]">{initials(p.name)}</AvatarFallback>
                        </Avatar>
                        {p.name}
                        <span className={`text-[10px] ${added ? 'text-primary/70' : 'text-muted-foreground/35'}`}>{added ? '−' : '+'}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="h-[520px] flex-1 overflow-hidden bg-[#0d1420]" data-testid="flow-canvas">
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
              </Card>
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/50" data-testid="flow-edit-hint">
                <LocateFixed className="h-3 w-3" />
                ลากการ์ดเพื่อจัดตำแหน่งเองได้ หรือใช้ “จัดเรียงอัตโนมัติ” · อย่าลืมกด Save Team หลังแก้ทีม
              </div>
            </section>
          </TabsContent>

          <TabsContent value="routines" className="mt-0">
            <RoutinesTab
              projectId={id}
              onRunStarted={r => {
                setRunHistory(h => [r, ...h.filter(x => x.id !== r.id)])
                setRun(r)
                setCollapsed({})
                setTab('mission')
                requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
              }}
            />
          </TabsContent>

          <TabsContent value="docs" className="mt-0">
            <ProjectDocs projectId={id} onCommentsChanged={refreshOpenComments} />
          </TabsContent>
        </Tabs>
      </div>

      <AgentDetail agent={detailAgent} open={detailOpen} onOpenChange={setDetailOpen} onSaved={refreshPersonas} />
    </>
  )
}
