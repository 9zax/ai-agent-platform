'use client'
// Global inbox for need-human meetings. The run engine escalates a blocking
// question to discussion status "need_human"; before this existed the user only
// saw it if they happened to be on /board or the project's Mission Control.
// Mounted inside the Sidebar so it lives on every page: a bell row with a
// pending count, a dropdown that links straight to the answer chat, and a
// toast the moment a new question arrives.

import { authFetch } from '@/lib/auth'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { BellRing, ChevronRight, MessageCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const TOAST_MS = 12000

export default function HumanInbox() {
  const [items, setItems] = useState([]) // every pending need_human question across runs
  const [agents, setAgents] = useState(new Map())
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0) // arrived since the panel was last opened
  const [toasts, setToasts] = useState([])
  // Discussion ids already toasted this session — the inbox badge keeps
  // tracking them, but they only toast once until answered.
  const seen = useRef(new Set())
  const timers = useRef([])
  const wrap = useRef(null)

  useEffect(() => {
    let alive = true
    async function load() {
      const safe = p => p.then(r => r.json()).catch(() => null)
      const [runs, ag] = await Promise.all([
        safe(authFetch(`${API}/runs`)),
        safe(authFetch(`${API}/agents`)),
      ])
      if (!alive) return
      if (Array.isArray(ag)) setAgents(new Map(ag.map(a => [a.role, a])))
      const next = []
      if (Array.isArray(runs)) {
        for (const run of runs) {
          for (const d of (run.discussions || [])) {
            if (d.status !== 'need_human') continue
            next.push({
              key: `${run.id}/${d.id}`,
              projectId: run.project_id,
              projectName: run.project_name,
              from: d.from,
              topic: d.topic,
            })
          }
        }
      }
      const fresh = next.filter(i => !seen.current.has(i.key))
      if (fresh.length) {
        for (const i of fresh) seen.current.add(i.key)
        setUnread(u => u + fresh.length)
        setToasts(t => [...t, ...fresh])
        for (const i of fresh) {
          timers.current.push(setTimeout(() => {
            setToasts(t => t.filter(x => x.key !== i.key))
          }, TOAST_MS))
        }
      }
      setItems(next)
    }
    load()
    const t = setInterval(load, 4000)
    // Close the dropdown on any click outside it
    const onDocClick = e => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false) }
    document.addEventListener('click', onDocClick)
    return () => {
      alive = false
      clearInterval(t)
      document.removeEventListener('click', onDocClick)
      timers.current.forEach(clearTimeout)
    }
  }, [])

  const dismissToast = key => setToasts(t => t.filter(x => x.key !== key))
  const togglePanel = () => {
    setOpen(o => {
      if (!o) setUnread(0)
      return !o
    })
  }

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={togglePanel}
        data-testid="inbox-button"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors',
          items.length
            ? 'bg-rose-500/10 text-rose-300 hover:bg-rose-500/15'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        )}
      >
        <span className="relative">
          <BellRing className="h-[17px] w-[17px]" />
          {unread > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-rose-400" />}
        </span>
        กล่องข้อความเข้า
        {items.length > 0 && (
          <span
            data-testid="inbox-badge"
            className={cn(
              'ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold',
              unread > 0 ? 'bg-rose-500 text-white' : 'bg-amber-500/20 text-amber-300'
            )}
          >
            {items.length}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="inbox-panel"
          className="absolute left-full top-0 z-50 ml-2.5 w-[340px] rounded-xl border border-rose-400/30 bg-[#0d1420] p-3 shadow-2xl"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-rose-300">
              <MessageCircle className="h-3.5 w-3.5" />
              รอคุณตอบ {items.length > 0 && <span className="text-muted-foreground/70">· {items.length} คำถาม</span>}
            </div>
            <button onClick={() => setOpen(false)} className="text-muted-foreground/60 hover:text-foreground" aria-label="ปิด">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {items.length === 0 ? (
            <div className="py-2 text-[12px] text-muted-foreground/70">ว่าง — ยังไม่มีคำถามที่รอคุณตอบ</div>
          ) : items.map(item => (
            <Link
              key={item.key}
              href={`/projects/${item.projectId}`}
              onClick={() => setOpen(false)}
              data-testid="inbox-item"
              className="mb-1.5 block rounded-lg border border-rose-400/20 bg-rose-500/5 p-2.5 transition-colors last:mb-0 hover:bg-rose-500/10"
            >
              <div className="flex items-center gap-1.5 truncate text-[10.5px] text-muted-foreground/80">
                <MessageCircle className="h-3 w-3 shrink-0 text-rose-400/80" />
                {agents.get(item.from)?.name || item.from} · {item.projectName}
              </div>
              <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-foreground/90">{item.topic}</div>
              <div className="mt-1.5 flex items-center gap-0.5 text-[11px] font-semibold text-rose-300">
                ไปตอบ <ChevronRight className="h-3 w-3" />
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Transient alerts — one per newly arrived question, auto-dismissing */}
      <div className="fixed bottom-5 right-5 z-[60] flex w-[340px] flex-col gap-2.5">
        {toasts.map(t => (
          <div
            key={t.key}
            data-testid="inbox-toast"
            className="toast-in rounded-xl border border-rose-400/60 bg-[#161207] p-3.5 shadow-[0_0_24px_rgba(251,113,133,.25)]"
          >
            <div className="flex items-center gap-2 text-[12px] font-semibold text-rose-300">
              <MessageCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">มีคำถามรอคุณตอบ · {t.projectName}</span>
            </div>
            <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-foreground/90">{t.topic}</div>
            <div className="mt-2.5 flex items-center justify-end gap-2.5">
              <button onClick={() => dismissToast(t.key)} className="text-[11.5px] text-muted-foreground/70 hover:text-foreground">
                ไว้ทีหลัง
              </button>
              <Link
                href={`/projects/${t.projectId}`}
                onClick={() => dismissToast(t.key)}
                data-testid="inbox-toast-answer"
                className="rounded-lg bg-rose-500 px-2.5 py-1.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-rose-400"
              >
                ไปตอบ
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
