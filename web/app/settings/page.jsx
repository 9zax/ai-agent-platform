'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Server, Package, ShieldCheck, KeyRound, GitBranch, Check } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function SettingsPage() {
  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [aiStatus, setAiStatus] = useState(null)
  const [password, setPassword] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwSaved, setPwSaved] = useState(false)
  const [gitToken, setGitToken] = useState('')
  const [gtSaving, setGtSaving] = useState(false)
  const [gtSaved, setGtSaved] = useState(false)

  async function loadConfig() {
    authFetch(`${API}/config`).then(r => r.json()).then(setConfig).catch(() => setConfig(null))
  }

  useEffect(() => {
    authFetch(`${API}/health`).then(r => r.json()).then(setHealth).catch(() => setHealth(null))
    authFetch(`${API}/agent/status`).then(r => r.json()).then(setAiStatus).catch(() => setAiStatus(null))
    loadConfig()
  }, [])

  async function savePassword(e) {
    e.preventDefault()
    if (!password) return
    setPwSaving(true)
    setPwSaved(false)
    const res = await authFetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_password: password }),
    })
    if (res.ok) {
      setPassword('')
      setPwSaved(true)
      await loadConfig()
    }
    setPwSaving(false)
  }

  async function saveGitToken(e) {
    e.preventDefault()
    if (!gitToken) return
    setGtSaving(true)
    setGtSaved(false)
    const res = await authFetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_token: gitToken }),
    })
    if (res.ok) {
      setGitToken('')
      setGtSaved(true)
      await loadConfig()
    }
    setGtSaving(false)
  }

  const rows = [
    ['Orchestrator', health ? 'Healthy' : 'Unreachable', health ? 'text-emerald-400' : 'text-red-400'],
    ['Docker socket', health?.docker ? 'Connected' : 'Not connected', health?.docker ? 'text-emerald-400' : 'text-amber-400'],
    ['API endpoint', API, ''],
    ['AI provider', aiStatus?.provider || config?.ai_provider || '—', ''],
    ['Model (provider default)', aiStatus?.model || '—', ''],
    ['Max containers', config?.max_containers ?? '—', ''],
    ['Auto-restart', config ? (config.auto_restart ? 'On' : 'Off') : '—', ''],
  ]

  return (
    <>
      <div className="px-7 pb-1 pt-5">
        <h1 className="text-[21px] font-bold tracking-tight">Settings</h1>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">Platform runtime information</div>
      </div>

      <div className="grid gap-3.5 px-7 py-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        <Card className="p-5" data-testid="settings-card">
          <div className="mb-4 flex items-center gap-2 text-[14px] font-bold">
            <Server className="h-4 w-4 text-primary" /> System
          </div>
          {rows.map(([k, v, color]) => (
            <div key={k} className="flex items-center justify-between border-b border-dashed border-border py-2.5 text-[12.5px] last:border-0">
              <span className="text-muted-foreground/70">{k}</span>
              <span className={color || 'font-semibold'}>{v}</span>
            </div>
          ))}
        </Card>

        <Card className="p-5" data-testid="access-card">
          <div className="mb-2 flex items-center gap-2 text-[14px] font-bold">
            <KeyRound className="h-4 w-4 text-primary" /> Admin Access
          </div>
          <div className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground/80">
            ตั้ง password เดียวสำหรับเข้าถึง console ของ container ทุกตัว (noVNC) — ถามทุกครั้งก่อนเชื่อมต่อ
          </div>
          <div className="mb-3">
            <Badge variant={config?.admin_password_set ? 'green' : 'gray'} data-testid="admin-password-status">
              {config?.admin_password_set ? 'Password set' : 'No password (open access)'}
            </Badge>
          </div>
          <form onSubmit={savePassword} className="flex gap-2">
            <Input
              type="password"
              value={password}
              placeholder="ตั้ง/เปลี่ยน admin password"
              onChange={e => setPassword(e.target.value)}
            />
            <Button type="submit" disabled={pwSaving || !password} data-testid="save-admin-password">
              {pwSaving ? 'Saving…' : 'Save'}
            </Button>
          </form>
          {pwSaved && <div className="mt-2 flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="password-saved">Saved <Check className="h-3.5 w-3.5" /></div>}
        </Card>

        <Card className="p-5">
          <div className="mb-2 flex items-center gap-2 text-[14px] font-bold">
            <GitBranch className="h-4 w-4 text-primary" /> Git Access
          </div>
          <div className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground/80">
            GitHub token สำหรับให้ agent <b>clone private repo</b> ลง container ได้ (แบบเดียวกับ bot ที่มี credential บนเครื่อง Linux ของตัวเอง) — ใช้ PAT สิทธิ์อ่าน (Contents: Read-only) ก็พอ
          </div>
          <div className="mb-3">
            <Badge variant={config?.git_token_set ? 'green' : 'gray'} data-testid="git-token-status">
              {config?.git_token_set ? 'Token set' : 'No token (public repos only)'}
            </Badge>
          </div>
          <form onSubmit={saveGitToken} className="flex gap-2">
            <Input
              type="password"
              value={gitToken}
              placeholder="GitHub PAT (ghp_… / github_pat_…)"
              onChange={e => setGitToken(e.target.value)}
            />
            <Button type="submit" disabled={gtSaving || !gitToken} data-testid="save-git-token">
              {gtSaving ? 'Saving…' : 'Save'}
            </Button>
          </form>
          {gtSaved && <div className="mt-2 flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="git-token-saved">Saved <Check className="h-3.5 w-3.5" /></div>}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-[14px] font-bold">
            <ShieldCheck className="h-4 w-4 text-primary" /> Safety
          </div>
          <div className="text-[12.5px] leading-relaxed text-muted-foreground/80">
            Only containers created by this platform (label <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">managed-by=ai-agent-platform</code>) can be
            stopped, restarted, executed in, or deleted through the UI and API.
          </div>
          <div className="mt-4"><Badge variant="green">Lifecycle guarded</Badge></div>
          <div className="mb-4 mt-6 flex items-center gap-2 text-[14px] font-bold">
            <Package className="h-4 w-4 text-primary" /> Deployment
          </div>
          <div className="text-[12.5px] leading-relaxed text-muted-foreground/80">
            Production build: Next.js <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">next start</code> ·
            API: FastAPI/Uvicorn · Orchestrated with Docker Compose.
          </div>
        </Card>
      </div>
    </>
  )
}
