'use client'

import {
  Check, X, Loader2, Clock, PauseCircle, CircleDot, AlertTriangle, Flame,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Jira-like columns, left → right. The order drives the board.
export const TASK_COLUMNS = [
  { id: 'backlog', label: 'Backlog', hint: 'ยังไม่พร้อมทำ', dot: 'bg-slate-400', text: 'text-slate-300' },
  { id: 'todo', label: 'To do', hint: 'พร้อมสั่งทีม', dot: 'bg-sky-400', text: 'text-sky-300' },
  { id: 'in_progress', label: 'In progress', hint: 'ทีมกำลังทำ', dot: 'bg-blue-400', text: 'text-blue-300' },
  { id: 'review', label: 'Review', hint: 'รอตรวจ / ต้องแก้', dot: 'bg-amber-400', text: 'text-amber-300' },
  { id: 'done', label: 'Done', hint: 'ส่งงานครบ', dot: 'bg-emerald-400', text: 'text-emerald-300' },
]

export const TASK_STATUS = Object.fromEntries(TASK_COLUMNS.map(c => [c.id, c]))

const STATUS_BADGE = {
  backlog: 'gray',
  todo: 'created',
  in_progress: 'blue',
  review: 'yellow',
  done: 'green',
}

const PRIORITY = {
  low: { label: 'Low', badge: 'gray', icon: null, text: 'text-muted-foreground/60' },
  medium: { label: 'Medium', badge: 'blue', icon: CircleDot, text: 'text-blue-300' },
  high: { label: 'High', badge: 'yellow', icon: AlertTriangle, text: 'text-amber-300' },
  urgent: { label: 'Urgent', badge: 'dead', icon: Flame, text: 'text-red-300' },
}

const STEP_STATUS = {
  pending: { label: 'รอคิว', cls: 'text-muted-foreground/55' },
  working: { label: 'กำลังทำ', cls: 'text-blue-300' },
  done: { label: 'ส่งงานแล้ว', cls: 'text-emerald-300' },
  error: { label: 'พลาด', cls: 'text-red-300' },
  skipped: { label: 'ข้าม', cls: 'text-muted-foreground/45' },
  stopped: { label: 'หยุด', cls: 'text-slate-300/75' },
}

export const PRIORITY_OPTIONS = Object.keys(PRIORITY)
export const TASK_STATUS_OPTIONS = TASK_COLUMNS.map(c => c.id)

export function TaskStatusBadge({ status, className }) {
  const meta = TASK_STATUS[status] || TASK_STATUS.todo
  return (
    <Badge variant={STATUS_BADGE[status] || 'gray'} className={cn('gap-1.5', className)} data-testid="task-status" data-status={status}>
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot, status === 'in_progress' && 'animate-pulse')} />
      {meta.label}
    </Badge>
  )
}

export function PriorityBadge({ priority, className }) {
  const meta = PRIORITY[priority] || PRIORITY.medium
  const Icon = meta.icon
  return (
    <Badge variant={meta.badge} className={cn('gap-1', className)} data-testid="task-priority" data-priority={priority || 'medium'}>
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {meta.label}
    </Badge>
  )
}

export function priorityText(priority) {
  return (PRIORITY[priority] || PRIORITY.medium).text
}

export function stepStatusLabel(status) {
  return (STEP_STATUS[status] || STEP_STATUS.pending).label
}

export function stepStatusCls(status) {
  return (STEP_STATUS[status] || STEP_STATUS.pending).cls
}

export function StepStatusIcon({ status, className }) {
  const cls = cn('h-3.5 w-3.5 shrink-0', className)
  if (status === 'working') return <Loader2 className={cn(cls, 'animate-spin text-blue-300')} />
  if (status === 'done') return <Check className={cn(cls, 'text-emerald-400')} />
  if (status === 'error') return <X className={cn(cls, 'text-red-400')} />
  if (status === 'skipped' || status === 'stopped') return <PauseCircle className={cn(cls, 'text-muted-foreground/40')} />
  return <Clock className={cn(cls, 'text-muted-foreground/45')} />
}

export function fmtUsd(v) {
  const n = Number(v || 0)
  if (!n) return '$0.00'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

export function fmtTok(n) {
  const v = Number(n || 0)
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
}

export function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

export function relTime(ts) {
  if (!ts) return ''
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(ts * 1000).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
}

// Markdown body styling shared by task/subtask screens (same tokens as docs).
export const MARKDOWN_CLS = 'text-[12.5px] leading-relaxed [&_a]:text-primary [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[13.5px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-[12.5px] [&_h3]:font-semibold [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_ul]:list-disc [&_ul]:pl-5'
