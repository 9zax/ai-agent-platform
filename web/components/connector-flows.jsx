'use client'

// Shared connector flows — the GitHub (browser device flow | personal access
// token) and Figma (token) connect dialogs, usable from every page that shows
// a container: the console, the connectors overview rows and the AI Team
// cards. Self-contained: given a container name it polls that container's
// connector state while open, starts/resumes the GitHub device flow by itself
// and exposes onChanged so the host page can refresh its own list at once.

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Github, Figma, Globe, KeyRound, Loader2, ExternalLink, Monitor, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// ---- Connector API (one helper per backend endpoint; all throw on error) --

async function postConnector(containerId, path, body) {
  const res = await authFetch(`${API}/containers/${encodeURIComponent(containerId)}/connectors/${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
  return data
}

/// Start (or resume — it's idempotent server-side) the GitHub device flow
export function githubConnectDevice(containerId) {
  return postConnector(containerId, 'github/connect')
}

/// Validate + store a personal access token inside the container (github | figma)
export function connectorConnectToken(containerId, ctype, token) {
  return postConnector(containerId, `${ctype}/connect-token`, { token })
}

/// Remove the stored credential from the container
export function connectorDisconnect(containerId, ctype) {
  return postConnector(containerId, `${ctype}/disconnect`)
}

/// Open the verification URL on the container's own desktop — best effort
export function githubOpenBrowserInContainer(containerId) {
  return postConnector(containerId, 'github/open-browser').catch(() => {})
}

// ---- The dialogs -----------------------------------------------------------

/**
 * `<ConnectorDialogs containerId ctype onClose onChanged />` — one instance
 * per page; pass containerId + ctype to open ('github' | 'figma'), null/null
 * to close. ctype drives which flow renders; GitHub gets the two-method tabs.
 */
export function ConnectorDialogs({ containerId, ctype, onClose, onChanged }) {
  const open = !!containerId && !!ctype
  const [conn, setConn] = useState(null) // this connector's live state while open
  const [tab, setTab] = useState('device') // github only: 'device' | 'token'
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState('') // 'flow' | 'token' | 'disconnect'
  const [error, setError] = useState('') // shown inside the dialog

  // Poll the container's connector state while the dialog is open — the
  // device flow completes out-of-band (user approves in a browser), so the
  // dialog follows the state rather than the response of any one call.
  useEffect(() => {
    if (!open) return
    let alive = true
    async function load() {
      try {
        const res = await authFetch(`${API}/containers/${encodeURIComponent(containerId)}/connectors`)
        const list = res.ok ? await res.json() : []
        if (alive) setConn((Array.isArray(list) ? list : []).find(c => c.type === ctype) || { type: ctype, state: 'unavailable', reason: 'unknown connector' })
      } catch { /* keep last known */ }
    }
    load()
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [open, containerId, ctype])

  // Open → reset stale input from a previous container/connector
  useEffect(() => {
    if (open) { setToken(''); setError(''); setBusy(''); setTab('device'); setConn(null) }
  }, [open, containerId, ctype])

  // GitHub: auto-start the device flow once we know the connector is free
  // (connected → show state instead; pending → the flow already has a code).
  // Idempotent server-side, so a re-opened dialog resumes rather than remints.
  useEffect(() => {
    if (!open || ctype !== 'github' || !conn || conn.state === 'connected' || conn.state === 'pending' || conn.state === 'unavailable') return
    let alive = true
    setBusy('flow')
    setError('')
    githubConnectDevice(containerId)
      .catch(err => { if (alive) setError(err.message) })
      .finally(() => { if (alive) setBusy('') })
    return () => { alive = false }
  }, [open, containerId, ctype, conn?.state])

  async function submitToken() {
    if (!token.trim()) return
    setBusy('token')
    setError('')
    try {
      await connectorConnectToken(containerId, ctype, token.trim())
      setToken('')
      onClose()
      onChanged?.()
    } catch (err) {
      setError(err.message)
    }
    setBusy('')
  }

  async function disconnect() {
    setBusy('disconnect')
    setError('')
    try {
      await connectorDisconnect(containerId, ctype)
      onClose()
      onChanged?.()
    } catch (err) {
      setError(err.message)
    }
    setBusy('')
  }

  if (!open) return null

  const state = conn?.state || 'disconnected'
  const FlowIcon = ctype === 'github' ? Github : ctype === 'figma' ? Figma : Plug
  const name = ctype === 'github' ? 'GitHub' : ctype === 'figma' ? 'Figma' : ctype

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FlowIcon className="h-4 w-4" /> Connect {name}</DialogTitle>
          <DialogDescription>เลือกวิธี login ให้เครื่อง <span className="font-mono">{containerId}</span></DialogDescription>
        </DialogHeader>

        {state === 'unavailable' ? (
          <div className="grid gap-3 py-1">
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-400" data-testid="connector-flow-error">
              {conn?.reason || 'connector unavailable'}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </DialogFooter>
          </div>
        ) : state === 'connected' ? (
          <div className="grid gap-3 py-1">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-400">
              เชื่อมต่ออยู่{conn?.login ? <> ในชื่อ <span className="font-semibold">@{conn.login}</span></> : null}
            </div>
            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-400" data-testid="connector-flow-error">{error}</div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button
                variant="outline"
                className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                disabled={busy !== ''}
                onClick={disconnect}
                data-testid="connector-dialog-disconnect"
              >
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </DialogFooter>
          </div>
        ) : ctype === 'figma' ? (
          // Figma — token-only (no device flow). The platform validates the
          // token once, then it lives only inside the container.
          <div className="grid gap-3 pt-2">
            <div className="text-[12.5px] leading-relaxed text-muted-foreground">
              วาง Figma personal access token — สร้างได้ที่ Figma → Settings → Security → Personal access tokens
            </div>
            <div className="text-[12.5px] leading-relaxed text-muted-foreground">
              token จะถูกเก็บในเครื่องนี้ที่ <span className="font-mono">~/.config/figma/token</span> พร้อม export <span className="font-mono">FIGMA_TOKEN</span> ให้ shell เรียก Figma REST API ได้ทันที
            </div>
            <Input
              type="password" autoComplete="off" placeholder="figd_…"
              value={token} onChange={e => setToken(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitToken() }}
              data-testid="connector-token-input-figma"
            />
            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-400" data-testid="connector-flow-error">{error}</div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={submitToken} disabled={busy !== '' || !token.trim()} data-testid="connector-token-submit-figma">
                {busy === 'token' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                Connect ด้วย token
              </Button>
            </DialogFooter>
          </div>
        ) : state === 'pending' ? (
          // GitHub device flow in flight — show the code until approved
          <div className="grid gap-4 pt-2">
            <div className="text-[12.5px] text-muted-foreground">เปิด GitHub ใน browser แล้วกรอกรหัสนี้เพื่อ login ให้เครื่องนี้ (github.com/login/device)</div>
            <button
              type="button"
              className="mx-auto rounded-xl border border-primary/40 bg-primary/10 px-8 py-4 font-mono text-[28px] font-bold tracking-[0.12em] text-primary transition-colors hover:bg-primary/20"
              data-testid="connector-user-code"
              title="คลิกเพื่อคัดลอกรหัส"
              onClick={e => {
                navigator.clipboard?.writeText(conn?.user_code || '')
                e.currentTarget.textContent = 'Copied ✓'
                setTimeout(() => { e.currentTarget.textContent = conn?.user_code || '' }, 1200)
              }}
            >
              {conn?.user_code || '····-····'}
            </button>
            <div className="flex items-center justify-center gap-2 text-[12.5px]">
              <a href={conn?.verification_url || 'https://github.com/login/device'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                {conn?.verification_url || 'https://github.com/login/device'} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
            <div className="flex items-center justify-center gap-2 rounded-md bg-secondary px-3 py-2 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              Waiting for authorization… ระบบเชื่อมต่ออัตโนมัติเมื่ออนุมัติแล้ว
            </div>
            <DialogFooter className="items-center sm:justify-between">
              <Button variant="outline" onClick={() => githubOpenBrowserInContainer(containerId)}>
                <Monitor className="h-3.5 w-3.5" /> เปิด browser ในเดสก์ท็อป container
              </Button>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
          // GitHub, no flow yet — two methods: browser device flow (auto-started
          // on open; minting or failed) or pasting a personal access token
          <Tabs value={tab} onValueChange={setTab} className="pt-1">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="device"><Globe className="mr-1.5 h-3.5 w-3.5" />Browser</TabsTrigger>
              <TabsTrigger value="token"><KeyRound className="mr-1.5 h-3.5 w-3.5" />Token <span className="text-[10px] font-normal text-muted-foreground">(สำรอง)</span></TabsTrigger>
            </TabsList>

            <TabsContent value="device" className="grid gap-4 pt-4">
              <div className="text-[12.5px] leading-relaxed text-muted-foreground">
                วิธีหลัก — login ให้เครื่องนี้ผ่าน browser: ขอรหัสจาก GitHub แล้วเปิด github.com/login/device เพื่ออนุมัติ (สิทธิ์ที่ได้เป็นของเครื่องนี้เท่านั้น ไม่แชร์กับเครื่องอื่น)
              </div>
              {error ? (
                <>
                  <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-400" data-testid="connector-flow-error">{error}</div>
                  <Button onClick={() => { setError(''); setBusy('flow'); githubConnectDevice(containerId).catch(err => setError(err.message)).finally(() => setBusy('')) }} disabled={busy !== ''}>
                    {busy === 'flow' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
                    ลองขอรหัสใหม่
                  </Button>
                </>
              ) : (
                <div className="flex items-center justify-center gap-2 rounded-md bg-secondary px-3 py-3 text-[12.5px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  กำลังขอรหัสจาก GitHub…
                </div>
              )}
            </TabsContent>

            <TabsContent value="token" className="grid gap-3 pt-4">
              <div className="text-[12.5px] leading-relaxed text-muted-foreground">
                ทางสำรอง — วาง GitHub personal access token (classic หรือ fine-grained — scope <span className="font-mono">repo</span> เพื่อ push ได้)
                สร้างได้ที่ Settings → Developer settings → Personal access tokens — token จะถูกเก็บเฉพาะในเครื่องนี้ เช่นเดียวกับการ login ผ่าน browser
              </div>
              <Input
                type="password" autoComplete="off" placeholder="ghp_… หรือ github_pat_…"
                value={token} onChange={e => setToken(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitToken() }}
                data-testid="connector-token-input-github"
              />
              {error && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-400" data-testid="connector-flow-error">{error}</div>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={submitToken} disabled={busy !== '' || !token.trim()} data-testid="connector-token-submit-github">
                  {busy === 'token' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                  Connect ด้วย token
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Compact per-container connector chips — one icon button per connector,
 * colored by live state, click opens the shared dialog. Used on cards (AI
 * Team) where a full tile row would not fit.
 */
export function ConnectorChips({ containerName, connectors, onOpen }) {
  if (!containerName) return null
  const items = [
    { ctype: 'github', icon: Github },
    { ctype: 'figma', icon: Figma },
  ]
  const known = Array.isArray(connectors) // null/undefined = status not loaded yet → neutral, not red
  return (
    <div className="flex items-center gap-1.5" data-testid="agent-connectors">
      {items.map(({ ctype, icon: Icon }) => {
        const conn = known ? connectors.find(c => c.type === ctype) : null
        const state = !known ? 'loading' : (conn?.state || 'unavailable')
        const color = state === 'connected' ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
          : state === 'pending' ? 'text-yellow-400 border-yellow-500/40 bg-yellow-500/10'
          : state === 'unavailable' ? 'text-red-400/80 border-red-500/30 bg-red-500/5'
          : 'text-muted-foreground/70 border-border bg-[#0d1420]'
        const title = state === 'loading' ? `${ctype} — checking…`
          : `${ctype}${conn?.login ? ` — @${conn.login}` : state === 'connected' ? ' — connected' : state === 'unavailable' ? ` — ${conn?.reason || 'unavailable'}` : ' — not connected'}`
        return (
          <button
            key={ctype}
            type="button"
            className={`inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition-colors hover:bg-secondary ${color}`}
            title={title}
            onClick={() => onOpen?.(ctype)}
            data-testid={`agent-connector-${ctype}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {conn?.login ? `@${conn.login}` : ctype}
          </button>
        )
      })}
    </div>
  )
}
