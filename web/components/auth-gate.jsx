'use client'

// Protected mode: until the user signs in, NOTHING beyond the login page is
// shown — no sidebar, no page skeletons, no data. The gate checks the server's
// auth_required flag first (auth disabled ⇒ everything stays open) and then
// validates the stored session token against /auth/me, so an expired token
// (e.g. after an orchestrator restart) locks the UI instead of error-spamming.
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Bot, Lock, Loader2, Menu, X } from 'lucide-react'
import { getToken } from '@/lib/auth'
import Sidebar from '@/components/Sidebar'
import { Button } from '@/components/ui/button'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function AuthGate({ children }) {
  const pathname = usePathname()
  // 'checking' → probe in flight; 'open' → auth off or session valid; 'locked' → sign-in required
  const [state, setState] = useState('checking')
  const [navOpen, setNavOpen] = useState(false)

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setNavOpen(false) }, [pathname])

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        // /auth/me is the only public probe: it reports auth_required itself, so
        // the gate never needs the (session-protected) /config endpoint.
        const token = getToken()
        const headers = token ? { 'x-session-token': token } : {}
        const me = await fetch(`${API}/auth/me`, { headers }).then(r => r.json())
        if (!alive) return
        if (!me.auth_required) { setState('open'); return }
        setState(me.valid ? 'open' : 'locked')
      } catch {
        if (alive) setState('open') // backend unreachable — let pages surface their own errors
      }
    }
    check()
    const t = setInterval(check, 30_000) // re-lock promptly when a session dies
    return () => { alive = false; clearInterval(t) }
  }, [pathname])

  if (pathname === '/login') return children

  if (state === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2.5 text-muted-foreground/70">
        <Loader2 className="h-4 w-4 animate-spin text-primary" /> <span className="text-[13px]">กำลังตรวจสอบสิทธิ์…</span>
      </div>
    )
  }

  if (state === 'locked') {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-6" data-testid="auth-locked">
        <div className="pointer-events-none absolute left-1/2 top-[-16rem] h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-primary/[0.12] blur-[120px]" />
        <div className="relative flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border border-white/[0.08] bg-card/80 p-8 text-center shadow-pop">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-400 via-primary to-indigo-600 text-white shadow-[0_12px_32px_-12px_rgba(139,92,246,0.8)]">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <div className="text-[17px] font-semibold tracking-[-0.02em] text-white">AI Agent Platform</div>
            <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              โหมดป้องกัน — ยังไม่ได้เข้าสู่ระบบ ข้อมูลและการทำงานทั้งหมดถูกล็อกไว้จนกว่าจะ sign in
            </div>
          </div>
          <Button asChild className="w-full gap-1.5" data-testid="auth-locked-signin">
            <Link href="/login"><Lock className="h-3.5 w-3.5" /> เข้าสู่ระบบ</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      {/* Mobile drawer — the sidebar is 248px fixed, so below lg it slides in
          over the content instead of squeezing it off-screen. */}
      <div
        className={`fixed inset-y-0 left-0 z-50 -translate-x-full transition-transform duration-300 ease-out lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : ''
        }`}
      >
        <Sidebar />
      </div>
      {navOpen && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-white/[0.06] bg-background/85 px-4 py-2.5 backdrop-blur-xl lg:hidden">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400 via-primary to-indigo-600 text-white shadow-[0_8px_20px_-8px_rgba(139,92,246,0.8)]">
              <Bot className="h-4 w-4" />
            </span>
            <span className="truncate text-[13px] font-semibold text-white">AI Agent Platform</span>
          </div>
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-muted-foreground transition-colors hover:text-white"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen}
            onClick={() => setNavOpen(o => !o)}
          >
            {navOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
