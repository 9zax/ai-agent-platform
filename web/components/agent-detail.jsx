'use client'

// AgentDetail — what one AI teammate is doing right now, everything it has done,
// and its persona settings, in one dialog. Opened by clicking a node on the
// project flow chart. Polls GET /agents/{role}/activity while open so the live
// tab keeps moving with the run.

import { authFetch } from '@/lib/auth'
import { useEffect, useRef, useState } from 'react'
import { Activity, History, Settings2, Loader2, CheckCircle2, XCircle, Clock, PauseCircle, MessageCircle, Container, ChevronDown } from 'lucide-react'
import { marked } from 'marked'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PersonaForm } from '@/components/persona-editor'
import { fmtClock, fmtDateTime, fmtDur, STEP_KIND_LABEL } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

const STATE_LABEL = {
  working: { text: '● กำลังทำงาน', cls: 'text-blue-400' },
  speaking: { text: '💬 กำลังตอบใน meeting', cls: 'text-amber-300' },
  waiting_human: { text: '⏸ รอคุณตอบ', cls: 'text-rose-300' },
  pending: { text: '◔ รอรับงาน', cls: 'text-muted-foreground/70' },
}

function StatusIcon({ status }) {
  if (status === 'working') return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
  if (status === 'done') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 text-red-400" />
  if (status === 'skipped') return <PauseCircle className="h-3.5 w-3.5 text-muted-foreground/60" />
  return <Clock className="h-3.5 w-3.5 text-muted-foreground/50" />
}

function HistoryEntry({ h }) {
  const [open, setOpen] = useState(false)
  const dur = fmtDur(h.started_at, h.finished_at)
  return (
    <div className="rounded-xl border bg-[#0d1420]" data-testid="history-entry">
      <button className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left" onClick={() => setOpen(o => !o)}>
        <StatusIcon status={h.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] font-semibold">
            <span className="font-mono text-[11px] text-muted-foreground/70">{h.run_id}</span>
            <span className="text-muted-foreground/80">{h.project_name}</span>
            {h.kind && h.kind !== 'work' && <Badge variant="purple" className="text-[9px]">{STEP_KIND_LABEL[h.kind] || h.kind}</Badge>}
            {h.iteration > 1 && <Badge variant="purple" className="text-[9px]">loop รอบ {h.iteration}</Badge>}
            {h.rev && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-amber-300">rev {h.rev}</span>}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-foreground/85">“{h.task}”</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[10.5px] text-muted-foreground/60">
            <span>{fmtDateTime(h.started_at)}</span>
            {dur && <span>ใช้เวลา {dur}</span>}
            {h.meetings > 0 && <span>💬 {h.meetings} meeting</span>}
            {h.deliverable && <span className="inline-flex items-center gap-1 text-emerald-400/80"><Container className="h-3 w-3" />{h.deliverable}</span>}
          </div>
        </div>
        <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="border-t px-3.5 py-2.5">
          <div
            className="max-h-[280px] overflow-auto text-[12px] [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[14px] [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-[12px] [&_h3]:font-semibold [&_li]:list-disc [&_ol]:list-decimal [&_p]:mb-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-black/40 [&_pre]:p-2.5 [&_ul]:list-disc [&_ul]:pl-5"
            dangerouslySetInnerHTML={{ __html: marked.parse(h.output_excerpt || '_ไม่มีเนื้อหา_') }}
          />
          {h.output_excerpt?.length >= 300 && (
            <div className="mt-1.5 text-[10.5px] text-muted-foreground/50">แสดงเฉพาะ 300 ตัวอักษรแรก — ดาวน์โหลด deliverable จาก container เพื่อดูงานเต็ม</div>
          )}
        </div>
      )}
    </div>
  )
}

export function AgentDetail({ agent, open, onOpenChange, onSaved }) {
  const [activity, setActivity] = useState(null)
  const [tab, setTab] = useState('live')
  const live = activity?.current

  // Poll while the dialog is open so "กำลังทำอะไรอยู่" moves with the run
  useEffect(() => {
    if (!open || !agent) return
    let alive = true
    const load = () => authFetch(`${API}/agents/${agent.role}/activity`)
      .then(r => r.json())
      .then(d => { if (alive && !d.detail) setActivity(d) })
      .catch(() => {})
    load()
    const t = setInterval(load, 2500)
    return () => { alive = false; clearInterval(t) }
  }, [open, agent])

  if (!agent) return null
  const st = live ? STATE_LABEL[live.state] : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="agent-detail">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Avatar className="h-11 w-11 border">
              <AvatarFallback className="text-[14px] font-bold">{initials(agent.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {agent.name}
                <span className="text-[12.5px] font-medium text-primary">{agent.title}</span>
                <Badge variant="gray" className="font-mono text-[9.5px]">{agent.role}</Badge>
              </DialogTitle>
              <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-2">
                {agent.expertise}
                {st && (
                  <span className={`font-semibold ${st.cls}`} data-testid="detail-live-pill" data-state={live.state}>
                    {st.text}
                    {live.since ? <span className="ml-1 font-normal text-muted-foreground/60">ตั้งแต่ {fmtClock(live.since)}</span> : null}
                  </span>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="live" className="flex-1 gap-1.5" data-testid="detail-tab-live"><Activity className="h-3.5 w-3.5" /> กำลังทำอะไรอยู่</TabsTrigger>
            <TabsTrigger value="history" className="flex-1 gap-1.5" data-testid="detail-tab-history"><History className="h-3.5 w-3.5" /> ประวัติการทำงาน</TabsTrigger>
            <TabsTrigger value="persona" className="flex-1 gap-1.5" data-testid="detail-tab-persona"><Settings2 className="h-3.5 w-3.5" /> แก้ไข persona</TabsTrigger>
          </TabsList>

          <TabsContent value="live" className="mt-3">
            {!activity ? (
              <div className="py-8 text-center text-[12.5px] text-muted-foreground/60">กำลังโหลด…</div>
            ) : live ? (
              <div className="rounded-xl border border-blue-500/30 bg-[#0d1420] p-4" data-testid="live-card">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[13.5px] font-bold ${st?.cls || ''}`}>{st?.text}</span>
                  {live.loop_mode && <Badge variant="purple" className="text-[9.5px]">Loop รอบที่ {live.iteration}</Badge>}
                  <span className="font-mono text-[10.5px] text-muted-foreground/60">{live.run_id}</span>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground/75">{live.detail}</div>
                <div className="mt-3 rounded-lg bg-secondary/60 p-3">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/60">งานที่ทีมกำลังทำ</div>
                  <div className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">{live.task}</div>
                </div>
                {live.topic && (
                  <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                    <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <div className="min-w-0">
                      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-amber-400/80">กระทู้ที่เกี่ยวข้อง</div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-amber-100/85">{live.topic}</div>
                    </div>
                  </div>
                )}
                {live.state === 'waiting_human' && (
                  <div className="mt-2.5 rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
                    ทีมกำลังรอคำตอบจากคุณ — ตอบได้ในแชท meeting ด้านล่างหน้า project
                  </div>
                )}
              </div>
            ) : (
              <div className="py-8 text-center text-[12.5px] text-muted-foreground/60" data-testid="live-empty">
                ไม่มีงานกำลังทำอยู่ตอนนี้ — สั่งงานทีมในหน้า project แล้วสถานะจะขึ้นที่นี่
              </div>
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-3">
            {!activity ? (
              <div className="py-8 text-center text-[12.5px] text-muted-foreground/60">กำลังโหลด…</div>
            ) : activity.history?.length ? (
              <div className="flex max-h-[420px] flex-col gap-2 overflow-auto pr-1">
                {activity.history.map((h, i) => <HistoryEntry key={`${h.run_id}-${i}`} h={h} />)}
              </div>
            ) : (
              <div className="py-8 text-center text-[12.5px] text-muted-foreground/60" data-testid="history-empty">
                ยังไม่มีประวัติการทำงานของ {agent.name} — ประวัติทุก run จะถูกเก็บไว้ที่นี่ (ข้าม restart)
              </div>
            )}
          </TabsContent>

          <TabsContent value="persona" className="mt-3">
            <PersonaForm agent={agent} active={open && tab === 'persona'} onSaved={onSaved} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
