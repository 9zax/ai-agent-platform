'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, LogIn } from 'lucide-react'
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
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-blue-500 text-white">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[16px] font-bold">AI Agent Platform</div>
            <div className="text-[12px] text-muted-foreground/70">เข้าสู่ระบบเพื่อเข้าถึง containers</div>
          </div>
        </div>

        {disabled ? (
          <div className="rounded-lg bg-amber-500/15 px-3.5 py-3 text-[12.5px] leading-relaxed text-amber-400">
            Authentication ปิดอยู่ — ตั้ง <code className="rounded bg-black/30 px-1.5 py-0.5">ADMIN_PASSWORD</code> ใน <code className="rounded bg-black/30 px-1.5 py-0.5">.env</code> แล้ว restart เพื่อเปิดใช้งาน login
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-3.5" data-testid="login-form">
            <div className="grid gap-1.5">
              <label htmlFor="username" className="text-[13px] font-medium">Username</label>
              <Input id="username" autoFocus value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="password" className="text-[13px] font-medium">Password</label>
              <Input id="password" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
            </div>
            {error && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400" data-testid="login-error">{error}</div>}
            <Button type="submit" disabled={busy || !form.username || !form.password}>
              <LogIn className="h-4 w-4" /> {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
