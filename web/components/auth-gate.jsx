'use client'

// Protected mode: until the user signs in, NOTHING beyond the login page is
// shown — no sidebar, no page skeletons, no data. The gate checks the server's
// auth_required flag first (auth disabled ⇒ everything stays open) and then
// validates the stored session token against /auth/me, so an expired token
// (e.g. after an orchestrator restart) locks the UI instead of error-spamming.
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Bot, Lock, Loader2 } from 'lucide-react'
import { getToken } from '@/lib/auth'
import Sidebar from '@/components/Sidebar'
import { Button } from '@/components/ui/button'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function AuthGate({ children }) {
  const pathname = usePathname()
  // 'checking' → probe in flight; 'open' → auth off or session valid; 'locked' → sign-in required
  const [state, setState] = useState('checking')

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const cfg = await (await fetch(`${API}/config`)).json()
        if (!alive) return
        if (!cfg.auth_required) { setState('open'); return }
        const token = getToken()
        if (!token) { setState('locked'); return }
        const me = await fetch(`${API}/auth/me`, { headers: { 'x-session-token': token } }).then(r => r.json())
        if (!alive) return
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
      <div className="flex min-h-screen items-center justify-center gap-2 text-muted-foreground/70">
        <Loader2 className="h-4 w-4 animate-spin" /> <span className="text-sm">กำลังตรวจสอบสิทธิ์…</span>
      </div>
    )
  }

  if (state === 'locked') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#070b13] px-6" data-testid="auth-locked">
        <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-amber-500/20 bg-[#0d1420] p-8 text-center shadow-[0_0_40px_rgba(245,158,11,.06)]">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/15">
            <Bot className="h-6 w-6 text-amber-400" />
          </div>
          <div>
            <div className="text-[16px] font-bold">AI Agent Platform</div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground/80">
              โหมดป้องกัน — ยังไม่ได้เข้าสู่ระบบ ข้อมูลและการทำงานทั้งหมดถูกล็อกไว้จนกว่าจะ sign in
            </div>
          </div>
          <Button asChild className="gap-1.5" data-testid="auth-locked-signin">
            <Link href="/login"><Lock className="h-3.5 w-3.5" /> เข้าสู่ระบบ</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
