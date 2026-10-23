'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Server, Package, ShieldCheck, KeyRound, GitBranch, Check, Moon, SlidersHorizontal } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import PageHeader from '@/components/page-header'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function CardHeading({ icon: Icon, children }) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/[0.09] text-primary ring-1 ring-inset ring-primary/15">
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-[13.5px] font-semibold text-white">{children}</span>
    </div>
  )
}

function Code({ children }) {
  return (
    <code className="rounded-md bg-white/[0.045] px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 ring-1 ring-inset ring-white/[0.06]">
      {children}
    </code>
  )
}

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
  const [idleMins, setIdleMins] = useState('')
  const [apSaving, setApSaving] = useState(false)
  const [apSaved, setApSaved] = useState(false)

  async function loadConfig() {
    authFetch(`${API}/config`).then(r => r.json()).then(setConfig).catch(() => setConfig(null))
  }

  useEffect(() => {
    authFetch(`${API}/health`).then(r => r.json()).then(setHealth).catch(() => setHealth(null))
    authFetch(`${API}/agent/status`).then(r => r.json()).then(setAiStatus).catch(() => setAiStatus(null))
    loadConfig()
  }, [])

  // Prefill the idle-minutes input with the live config once it arrives
  useEffect(() => {
    if (config?.idle_timeout_secs && idleMins === '') {
      setIdleMins(String(Math.round(config.idle_timeout_secs / 60)))
    }
  }, [config, idleMins])

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

  async function toggleAutoPause() {
    setApSaving(true)
    setApSaved(false)
    const res = await authFetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_pause_enabled: !config?.auto_pause_enabled }),
    })
    if (res.ok) {
      setApSaved(true)
      await loadConfig()
    }
    setApSaving(false)
  }

  async function saveIdleTimeout(e) {
    e.preventDefault()
    const mins = parseInt(idleMins, 10)
    if (!mins || mins < 1) return
    setApSaving(true)
    setApSaved(false)
    const res = await authFetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idle_timeout_secs: mins * 60 }),
    })
    if (res.ok) {
      setApSaved(true)
      await loadConfig()
    }
    setApSaving(false)
  }

  const rows = [
    ['Orchestrator', health ? 'Healthy' : 'Unreachable', health ? 'text-emerald-400' : 'text-red-400'],
    ['Execution mode', health?.mode === 'host' ? 'Host (tmux sessions)' : health ? 'Unknown' : '—', health ? 'text-emerald-400' : ''],
    ['tmux', health?.tmux ? 'Available' : 'Not found — agents run headless', health?.tmux ? 'text-emerald-400' : 'text-amber-400'],
    ['API endpoint', API, ''],
    ['AI provider', aiStatus?.provider || config?.ai_provider || '—', ''],
    ['Model (provider default)', aiStatus?.model || '—', ''],
    ['Max agents', config?.max_containers ?? '—', ''],
    ['Auto-restart', config ? (config.auto_restart ? 'On' : 'Off') : '—', ''],
    ['Auto-pause', config ? (config.auto_pause_enabled ? `On · ${Math.round((config.idle_timeout_secs || 0) / 60)} min` : 'Off') : '—', ''],
  ]

  return (
    <>
      <PageHeader
        icon={SlidersHorizontal}
        title="Settings"
        subtitle="ข้อมูล runtime ของ platform — สถานะระบบ, สิทธิ์การเข้าถึง และพฤติกรรมของ agent"
      />

      <div className="page-body space-y-3.5">
        <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
          <Card className="p-5" data-testid="settings-card">
            <CardHeading icon={Server}>System</CardHeading>
            <div className="space-y-0">
              {rows.map(([k, v, color]) => (
                <div key={k} className="flex items-center justify-between gap-4 border-b border-dashed border-white/[0.07] py-2.5 text-[12.5px] last:border-0">
                  <span className="shrink-0 text-muted-foreground/70">{k}</span>
                  <span className={`min-w-0 truncate text-right ${color || 'font-medium text-foreground/90'}`} title={String(v)}>{v}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5" data-testid="access-card">
            <CardHeading icon={KeyRound}>Admin Access</CardHeading>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground/80">
              ตั้ง password เดียวสำหรับเข้าถึง console ของ container ทุกตัว (noVNC) — ถามทุกครั้งก่อนเชื่อมต่อ
            </p>
            <div className="mt-3">
              <Badge variant={config?.admin_password_set ? 'green' : 'gray'} data-testid="admin-password-status">
                {config?.admin_password_set ? 'Password set' : 'No password (open access)'}
              </Badge>
            </div>
            <form onSubmit={savePassword} className="mt-4 flex gap-2">
              <Input
                type="password"
                value={password}
                placeholder="ตั้ง/เปลี่ยน admin password"
                onChange={e => setPassword(e.target.value)}
                aria-label="Admin password"
              />
              <Button type="submit" disabled={pwSaving || !password} data-testid="save-admin-password">
                {pwSaving ? 'Saving…' : 'Save'}
              </Button>
            </form>
            {pwSaved && <div className="mt-2 flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="password-saved">Saved <Check className="h-3.5 w-3.5" /></div>}
          </Card>

          <Card className="p-5" data-testid="auto-pause-card">
            <CardHeading icon={Moon}>Auto-pause</CardHeading>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground/80">
              Container ที่ไม่มี activity นานเกินกำหนดจะถูก <b className="font-semibold text-foreground/90">ปิดอัตโนมัติ</b> เพื่อประหยัด RAM/CPU บนเครื่อง host — พอมีงาน หรือเปิด terminal/AI command เข้าไป container จะกลับมาทำงานเองภายในไม่กี่วินาที (agent ที่กำลังทำงานอยู่ใน mission จะไม่ถูกปิด)
            </p>
            <div className="mt-3">
              <Badge variant={config?.auto_pause_enabled ? 'green' : 'gray'} data-testid="auto-pause-status">
                {config ? (config.auto_pause_enabled ? `On · idle ${Math.round((config.idle_timeout_secs || 0) / 60)} min` : 'Off') : '—'}
              </Badge>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={apSaving || !config}
                onClick={toggleAutoPause}
                data-testid="auto-pause-toggle"
              >
                {apSaving ? 'Saving…' : config?.auto_pause_enabled ? 'Disable' : 'Enable'}
              </Button>
              <form onSubmit={saveIdleTimeout} className="flex gap-2">
                <Input
                  type="number"
                  min="1"
                  className="w-[110px]"
                  value={idleMins}
                  placeholder="นาที"
                  onChange={e => setIdleMins(e.target.value)}
                  data-testid="idle-timeout-input"
                  aria-label="Idle timeout minutes"
                />
                <Button type="submit" disabled={apSaving || !idleMins || parseInt(idleMins, 10) < 1} data-testid="save-auto-pause">
                  {apSaving ? 'Saving…' : 'Set idle'}
                </Button>
              </form>
            </div>
            {apSaved && <div className="mt-2 flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="auto-pause-saved">Saved <Check className="h-3.5 w-3.5" /></div>}
          </Card>
        </div>

        <Card className="p-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
            <div>
              <CardHeading icon={GitBranch}>Git Access</CardHeading>
              <div className="space-y-2.5 text-[12.5px] leading-relaxed text-muted-foreground/80">
                <p>
                  GitHub token สำหรับให้ platform <b className="font-semibold text-foreground/90">clone private repo</b> ลง container ได้ — ใช้เฉพาะตอน clone <b className="font-semibold text-foreground/90">สิทธิ์อ่าน (Contents: Read-only)</b> เท่านั้น และ <b className="font-semibold text-foreground/90">ไม่ถูกลงทะเบียนกับ <Code>gh</Code></b> ใน container ของ agent ใดๆ ทั้งสิ้น (clone เสร็จ origin URL จะถูกล้างกลับเป็น URL ปกติด้วย)
                </p>
                <p>
                  การ <b className="font-semibold text-foreground/90">push branch / เปิด Pull Request</b> เป็นสิทธิ์ระดับเครื่อง: ต้อง login GitHub ให้ container นั้นๆ ทีละเครื่องผ่าน connector (หน้า Containers หรือ AI Team → GitHub → login ผ่าน browser เป็นหลัก หรือวาง token เป็นทางสำรอง)
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <span className="field-label">Clone token</span>
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
                  aria-label="GitHub token"
                />
                <Button type="submit" disabled={gtSaving || !gitToken} data-testid="save-git-token">
                  {gtSaving ? 'Saving…' : 'Save'}
                </Button>
              </form>
              <p className="field-hint mt-2">ใช้ token แบบ read-only (Contents: Read-only) เท่านั้น</p>
              {gtSaved && <div className="mt-2 flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="git-token-saved">Saved <Check className="h-3.5 w-3.5" /></div>}
            </div>
          </div>
        </Card>

        <div className="grid gap-3.5 lg:grid-cols-2">
          <Card className="p-5">
            <CardHeading icon={ShieldCheck}>Safety</CardHeading>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground/80">
              Only agents started by this platform (tmux session <Code>agent-*</Code>) can be
              stopped, restarted, executed in, or deleted through the UI and API. Commands run on
              your machine with your environment — the platform never installs anything.
            </p>
            <div className="mt-4"><Badge variant="green">Lifecycle guarded</Badge></div>
          </Card>

          <Card className="p-5">
            <CardHeading icon={Package}>Deployment</CardHeading>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground/80">
              Host processes via <Code>make run</Code>: orchestrator (Rust/Axum) ·
              web: Next.js <Code>next start</Code> — no Docker.
            </p>
            <div className="mt-4"><Badge variant="purple">Host mode</Badge></div>
          </Card>
        </div>
      </div>
    </>
  )
}
