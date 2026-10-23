'use client'

import { authFetch } from '@/lib/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState, Handle, Position, MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { marked } from 'marked'
import { Save, Plus, ArrowLeft, Send, Loader2, CheckCircle2, XCircle, Clock, Container, ChevronDown, MessageCircle, MessagesSquare, Check, GitBranch, Undo2, Square, User, Repeat, PauseCircle, GitPullRequest, MonitorPlay, RotateCcw, Wallet, AlertTriangle, CalendarClock, Play, Pencil, Trash2, ShieldCheck, X, Target } from 'lucide-react'
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
import { fmtClock, stepKey } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// Tail-stage steps (after QA verifies): icon + label chip shown next to the title.
// (deploy/staging removed with docker — the tail is now PR → demo)
const STEP_KIND_META = {
  pr: { icon: GitPullRequest, label: 'Pull Request', cls: 'bg-sky-500/10 text-sky-300' },
  demo: { icon: MonitorPlay, label: 'Acceptance demo', cls: 'bg-violet-500/10 text-violet-300' },
}

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
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [d.messages.length, d.answering, d.status])

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
function RoutinesTab({ projectId }) {
  const [routines, setRoutines] = useState(null)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_ROUTINE)
  const [saving, setSaving] = useState(false)
  const [runningId, setRunningId] = useState(null)

  const load = useCallback(() => {
    authFetch(`${API}/projects/${projectId}/routines`).then(r => r.json())
      .then(d => setRoutines(Array.isArray(d) ? d : []))
      .catch(() => setRoutines([]))
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
  const outputRef = useRef(null)

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
        goal: goal.trim(),
        budget_usd: budgetUsd === '' ? null : Number(budgetUsd),
        budget_alert_pct: Math.min(100, Math.max(1, Number(alertPct) || 80)),
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
            {error && <span className="text-[12px] text-red-400">{error}</span>}
            {saved && <span className="flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="flow-saved">Saved <Check className="h-3.5 w-3.5" /></span>}
            <Button onClick={save} disabled={saving} data-testid="flow-save">
              <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save Team'}
            </Button>
          </>
        }
      />

      <div className="page-body">
        <Tabs defaultValue="mission" className="w-full">
          <TabsList className="mb-6 h-auto w-full justify-start gap-1 rounded-none border-b border-white/[0.06] bg-transparent p-0">
            {[['mission', 'Mission Control'], ['routines', 'Routines'], ['docs', 'Docs']].map(([v, label]) => (
              <TabsTrigger
                key={v}
                value={v}
                data-testid={`tab-${v}`}
                className="rounded-none border-b-2 border-transparent px-3.5 pb-3 pt-1 text-[12.5px] font-semibold text-muted-foreground/70 hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:shadow-none"
              >
                {label}
                {v === 'docs' && openComments > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-300" data-testid="docs-comment-badge">{openComments}</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="mission" className="mt-0">
        {/* Mission control — dispatch one task through the whole team */}
        <Card className="mb-5 p-5" data-testid="mission-control">
          <form onSubmit={dispatch} className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/[0.09] text-primary ring-1 ring-inset ring-primary/15">
                  <Send className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-[13.5px] font-semibold text-white">สั่งงานทีม AI</div>
                  <div className="text-[11.5px] text-muted-foreground/60">{nodes.length} agents รับงานตามลำดับและเขียนงานลง container ของตัวเอง</div>
                </div>
              </div>
              <div className="max-w-md text-[11.5px] leading-relaxed text-muted-foreground/60">
                ถ้าใครติดขัด/มีคำถาม จะเปิด meeting ถามกลับแล้วแก้งานต่อ
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground/50" />
              <input
                data-testid="project-repo"
                className="h-9 w-full max-w-xl rounded-lg border border-white/10 bg-black/20 px-3 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/45 hover:border-white/[0.16] focus:border-primary/60 focus:ring-[3px] focus:ring-primary/15"
                placeholder="Git repo (https://github.com/owner/repo) — ทีมจะ clone ลง /workspace ของ container ก่อนทำงานทุกครั้ง"
                value={repoUrl}
                onChange={e => { setRepoUrl(e.target.value); setSaved(false) }}
              />
              {!saved && repoUrl !== (project?.repo_url || '') && (
                <span className="shrink-0 text-[11px] text-amber-400">กด Save Team เพื่อบันทึก repo</span>
              )}
            </div>
            <div className="flex items-center gap-2.5">
              <Target className="h-4 w-4 shrink-0 text-muted-foreground/50" />
              <input
                data-testid="project-goal"
                className="h-9 w-full max-w-xl rounded-lg border border-white/10 bg-black/20 px-3 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/45 hover:border-white/[0.16] focus:border-primary/60 focus:ring-[3px] focus:ring-primary/15"
                placeholder="Goal ของโปรเจกต์ — ทีมจะยึดเป็นเป้าหมายหลัก ทุก deliverable"
                value={goal}
                onChange={e => { setGoal(e.target.value); setSaved(false) }}
                title="Goal ancestry: ถูกใส่ใน prompt ของทุกขั้นตอน"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Wallet className="h-4 w-4 shrink-0 text-muted-foreground/50" />
              <input
                data-testid="project-budget"
                type="number"
                min="0"
                step="0.5"
                className="h-9 w-40 rounded-lg border border-white/10 bg-black/20 px-3 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/45 hover:border-white/[0.16] focus:border-primary/60 focus:ring-[3px] focus:ring-primary/15"
                placeholder="Budget / run (USD)"
                value={budgetUsd}
                onChange={e => { setBudgetUsd(e.target.value); setSaved(false) }}
                title="เพดานต่อ run — ถึงเพดานแล้ว run จะ pause รออนุมัติ ไม่ตัดจบเอง"
              />
              <span className="text-[11.5px] text-muted-foreground/60">alert ที่</span>
              <input
                data-testid="project-budget-alert"
                type="number"
                min="1"
                max="100"
                className="h-9 w-20 rounded-lg border border-white/10 bg-black/20 px-3 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/45 hover:border-white/[0.16] focus:border-primary/60 focus:ring-[3px] focus:ring-primary/15"
                value={alertPct}
                onChange={e => { setAlertPct(e.target.value); setSaved(false) }}
                title="แจ้งเตือนเมื่อใช้ถึง % ของ budget (ไม่หยุดงาน)"
              />
              <span className="text-[11.5px] text-muted-foreground/50">% — ถึงเพดานแล้ว run pause รอคุณอนุมัติเพิ่มงบ</span>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
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
            {runError && <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-300">{runError}</div>}
          </form>

          {run && (
            <div ref={outputRef} className="mt-4 border-t pt-4" data-testid="run-timeline">
              <div className="mb-3 flex flex-wrap items-center gap-2.5">
                <Badge variant={run.status === 'error' || run.status === 'stopped' ? 'dead' : run.status === 'waiting_human' ? 'dead' : run.status === 'running' ? (run.phase === 'meeting' || run.phase === 'demo' ? 'purple' : 'created') : 'running'} className="gap-1.5">
                  {run.status === 'running'
                    ? (run.phase === 'meeting'
                        ? <><MessagesSquare className="h-3 w-3" /> team meeting — รอบที่ {run.round}</>
                        : run.phase === 'demo'
                          ? <><MonitorPlay className="h-3 w-3" /> demo & acceptance — PO ตรวจรับ</>
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
                {run.trigger === 'scheduled' && (
                  <Badge variant="cyan" className="gap-1" data-testid="scheduled-badge" title={run.routine_id ? `routine ${run.routine_id}` : 'scheduled run'}>
                    <CalendarClock className="h-3 w-3" /> scheduled
                  </Badge>
                )}
                {(run.cost_usd > 0 || run.budget_usd) && (
                  <span
                    className="flex items-center gap-1.5 text-[12px] tabular-nums text-muted-foreground/80"
                    data-testid="run-cost"
                    title={`${fmtTok(run.input_tokens)} input + ${fmtTok(run.output_tokens)} output tokens`}
                  >
                    <Wallet className="h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
                    <strong className="font-semibold text-foreground/90">{fmtUsd(run.cost_usd)}</strong>
                    {run.budget_usd ? <span>/ {fmtUsd(run.budget_usd)}</span> : null}
                    <span className="text-muted-foreground/50">· {fmtTok((run.input_tokens || 0) + (run.output_tokens || 0))} tok</span>
                  </span>
                )}
                {run.cost_alerted && (
                  <Badge variant="yellow" className="gap-1" data-testid="cost-alert">
                    <AlertTriangle className="h-3 w-3" /> ใช้งบ ≥ {project.budget_alert_pct ?? 80}%
                  </Badge>
                )}
                <span className="text-[12.5px] font-medium">{doneCount}/{run.steps.length} ส่งงานแล้ว</span>
                {meetingDiscs.length > 0 && (
                  <span className="flex items-center gap-1.5 text-[12px] text-amber-300/90">
                    <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
                    {meetingDiscs.length} meeting{meetingDiscs.some(d => d.status !== 'resolved') ? ` · คำถามค้าง ${meetingDiscs.filter(d => d.status !== 'resolved').length}` : ' — ตัดสินใจครบแล้ว'}
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
                {!live && run.steps.some(s => s.status === 'error') && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={retryRun}
                    disabled={retrying}
                    data-testid="retry-mission"
                    className="h-7 gap-1.5 border-amber-500/40 text-[11.5px] text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                    title="สั่งงานเดิมซ้ำเป็น run ใหม่ — ทีมทำ mission นี้ตั้งแต่ต้นอีกรอบ (ถ้า failed แค่บาง step ให้กดปุ่ม ลองซ้ำ ที่ step นั้นแทน)"
                  >
                    {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} เริ่ม mission ใหม่
                  </Button>
                )}
              </div>

              {run.steps.length > 0 && (
                <div className="mb-3 flex items-center gap-3">
                  <Progress
                    value={(doneCount / Math.max(1, run.steps.length)) * 100}
                    indicatorClassName={run.status === 'error' ? 'bg-gradient-to-r from-rose-500 to-red-400' : undefined}
                  />
                  <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">
                    {Math.round((doneCount / Math.max(1, run.steps.length)) * 100)}%
                  </span>
                </div>
              )}

              <ReviewCard run={run} onDecide={decideReview} deciding={reviewDeciding} />
              {(run.discussions || []).filter(d => d.kind === 'budget').length > 0 && (
                <div className="mb-3 flex flex-col gap-2.5">
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
                  className={`mb-3 rounded-xl border p-3.5 ${run.acceptance.verdict === 'pass' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5'}`}
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
                  const sKey = stepKey(step)
                  const kind = step.kind || 'work'
                  const open = !collapsed[sKey]
                  const reverting = live && kind === 'work' && revisingRoles.has(step.role) && step.status === 'working'
                  return (
                    <div key={sKey} className={`rounded-xl border bg-[#0d1420] ${reverting ? 'revert-flash border-rose-400/60' : ''}`} data-testid={`run-step-${step.role}${kind !== 'work' ? `-${kind}` : ''}`} data-status={step.status} data-revert={reverting ? '1' : undefined}>
                      <div className="flex w-full items-center gap-3 px-3.5 py-2.5">
                        <button
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          onClick={() => setCollapsed(c => ({ ...c, [sKey]: open }))}
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
                              {kind !== 'work' && <StepKindBadge kind={kind} />}
                              {step.harness && <span className="ml-1.5 rounded bg-violet-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-violet-300" title="external CLI harness — unmetered">{step.harness}</span>}
                            </div>
                          </div>
                          {(step.input_tokens > 0 || step.output_tokens > 0 || step.cost_usd > 0 || step.metered === false) && (
                            <span
                              className={`hidden shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium tabular-nums sm:flex ${step.metered === false ? 'bg-violet-500/10 text-violet-300' : 'bg-emerald-500/10 text-emerald-400'}`}
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
                            <span className="hidden items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-400 sm:flex" title={`deliverable: ${step.deliverable || '-'}`}>
                              <Container className="h-3 w-3" /> {step.container}
                            </span>
                          )}
                          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform ${open ? '' : '-rotate-90'}`} />
                        </button>
                        {!live && (step.status === 'error' || step.status === 'skipped' || step.status === 'stopped') && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => retryOneStep(step.role, kind)}
                            disabled={retryingStep !== null}
                            data-testid={`retry-step-${step.role}${kind !== 'work' ? `-${kind}` : ''}`}
                            className="h-7 shrink-0 gap-1.5 border-amber-500/40 text-[11px] text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                            title={`สั่งเฉพาะ step นี้ซ้ำ — งานที่เสร็จแล้วของคนอื่นถูกเก็บไว้ทั้งหมด (สถานะเดิม: ${step.status})`}
                          >
                            {retryingStep === sKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} ลองซ้ำ
                          </Button>
                        )}
                      </div>
                      {open && (
                        <div className="border-t px-3.5 py-3">
                          {step.status === 'pending' && <div className="text-[12px] text-muted-foreground/60">รอรับงาน…</div>}
                          {reverting && (
                            <div className="flex items-center gap-2 text-[12px] font-medium text-rose-300">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" /> ↩ ถูกตีกลับแก้จาก meeting — กำลังแก้งานใหม่เป็น rev {run.round}…
                            </div>
                          )}
                          {step.status === 'working' && !reverting && live && <div className="flex items-center gap-2 text-[12px] text-blue-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> กำลังทำงาน…</div>}
                          {step.status === 'stopped' && <div className="text-[12px] text-muted-foreground/70">หยุดกลางคัน — run จบตอน step นี้กำลังทำงาน</div>}
                          {step.status === 'error' && <div className="text-[12.5px] text-red-400">{step.output}</div>}
                          {step.status === 'skipped' && <div className="text-[12px] text-muted-foreground/70">ข้าม — {step.output || 'ไม่มีเหตุผลระบุ'}</div>}
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

              {meetingDiscs.length > 0 && (
                <div className="mt-4 flex flex-col gap-2.5" data-testid="run-meetings">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-400/80">
                    Meetings — คุยกันแบบแชทเรียลไทม์ {meetingDiscs.some(d => d.status === 'need_human') && <span className="ml-1 normal-case text-rose-300">· มีคำถามที่รอคุณตอบ</span>}
                  </div>
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
          </TabsContent>

          <TabsContent value="routines" className="mt-0">
            <RoutinesTab projectId={id} />
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
