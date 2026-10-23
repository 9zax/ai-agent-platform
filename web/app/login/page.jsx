'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, LogIn, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { setSession, clearSession } from '@/lib/auth'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function LoginPage() {
  const router = useRouter()
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [disabled, setDisabled] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    clearSession()
    fetch(`${API}/auth/me`).then(r => r.json()).then(s => setDisabled(!s.auth_required)).catch(() => setDisabled(false))
  }, [])

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Login failed')
      setSession(data.token, data.user)
      router.push('/')
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div className="pointer-events-none absolute left-1/2 top-[-16rem] h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-primary/[0.14] blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-14rem] right-[-8rem] h-[26rem] w-[26rem] rounded-full bg-sky-500/[0.07] blur-[120px]" />

      <div className="relative w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-400 via-primary to-indigo-600 text-white shadow-[0_16px_40px_-12px_rgba(139,92,246,0.85)]">
            <Bot className="h-6 w-6" />
            <span className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/20" />
          </div>
          <h1 className="mt-5 text-[23px] font-semibold tracking-[-0.03em] text-white">ยินดีต้อนรับกลับ</h1>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">เข้าสู่ระบบเพื่อควบคุมทีม AI และ host agents ของคุณ</p>
        </div>

        <Card className="p-6 shadow-pop">
          {disabled ? (
            <div className="rounded-lg border border-amber-400/20 bg-amber-500/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed text-amber-300">
              Authentication ปิดอยู่ — ตั้ง <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">ADMIN_PASSWORD</code> ใน <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">.env</code> แล้ว restart เพื่อเปิดใช้งาน login
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-4" data-testid="login-form">
              <div className="grid gap-1.5">
                <label htmlFor="username" className="field-label">Username</label>
                <Input id="username" autoFocus autoComplete="username" placeholder="admin" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="password" className="field-label">Password</label>
                <Input id="password" type="password" autoComplete="current-password" placeholder="••••••••" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
              </div>
              {error && <div className="rounded-lg border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[12.5px] text-red-300" data-testid="login-error">{error}</div>}
              <Button type="submit" className="mt-1 w-full" disabled={busy || !form.username || !form.password}>
                <LogIn className="h-4 w-4" /> {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          )}
        </Card>

        <div className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/50">
          <ShieldCheck className="h-3.5 w-3.5" />
          Session ถูกตรวจสอบกับ orchestrator ทุก 30 วินาที
        </div>
      </div>
    </div>
  )
}
