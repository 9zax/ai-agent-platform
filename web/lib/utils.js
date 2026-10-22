import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

// unix seconds → "HH:MM" (local) — chat bubbles and history rows
export function fmtClock(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

// unix seconds → short date+time for older history entries
export function fmtDateTime(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// (started_at, finished_at) unix seconds → "2m 14s" / "1h 03m"; '' when unknown
export function fmtDur(start, end) {
  if (!start || !end || end < start) return ''
  const s = end - start
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}
