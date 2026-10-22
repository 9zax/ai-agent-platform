'use client'

import { authFetch, getToken } from '@/lib/auth'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  Bot, Play, Square, RotateCw, Terminal, Trash2, Send, Globe, Code, BarChart3, FileText, Plug, Image as ImageIcon, MonitorUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const VNC_URL = process.env.NEXT_PUBLIC_VNC_URL || 'http://localhost:6080'

const SKILLS = [
  { icon: Globe, label: 'Web Research' },
  { icon: Code, label: 'Code Gen' },
  { icon: BarChart3, label: 'Data Analysis' },
  { icon: FileText, label: 'File Ops' },
  { icon: Plug, label: 'API Testing' },
  { icon: ImageIcon, label: 'Image Analysis' },
]

const DEFAULT_METRICS = null

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)}${units[i]}`
}

export default function ContainerDetail() {
  const params = useParams()
  const router = useRouter()
  const id = decodeURIComponent(params.id || '')
  const [cmd, setCmd] = useState('')
  const [status, setStatus] = useState('running')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [log, setLog] = useState([])
  const [tab, setTab] = useState('console')
  const [stats, setStats] = useState(null)
  const [files, setFiles] = useState(null)
  const [inspect, setInspect] = useState(null)
  const [vncState, setVncState] = useState('disconnected') // disconnected | connecting | connected | unavailable
  const [vncScaled, setVncScaled] = useState(false)
  const [mode, setMode] = useState('ai') // 'ai' = LLM decides, 'shell' = run directly
  const [agentModel, setAgentModel] = useState('')
  const [authRequired, setAuthRequired] = useState(false) // true = must be logged in to touch containers
  const cmdBoxRef = useRef(null)

  useEffect(() => {
    authFetch(`${API}/agent/status`).then(r => r.json()).then(s => setAgentModel(s.model || '')).catch(() => {})
    authFetch(`${API}/config`).then(r => r.json()).then(c => setAdminGate(!!c.admin_password_set)).catch(() => {})
  }, [])

  // Live stats polling (every 5s) — only meaningful while running
  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const res = await authFetch(`${API}/containers/${encodeURIComponent(id)}/stats`)
        if (res.ok && alive) setStats(await res.json())
      } catch { /* keep last known */ }
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [id, status])

  // Lazy data per tab
  useEffect(() => {
    if (tab === 'files' && files === null) {
      authFetch(`${API}/containers/${encodeURIComponent(id)}/files`).then(r => r.json()).then(setFiles).catch(() => setFiles({ error: 'unreachable' }))
    }
    if ((tab === 'security' || tab === 'networks') && inspect === null) {
      authFetch(`${API}/containers/${encodeURIComponent(id)}/inspect`).then(r => r.json()).then(setInspect).catch(() => setInspect({ error: 'unreachable' }))
    }
  }, [tab, id, files, inspect])

  async function containerAction(action) {
    if (authRequired && !getToken()) return router.push('/login')
    setBusy(action)
    setError('')
    try {
      const res = await authFetch(`${API}/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setStatus(data.status === 'exited' ? 'stopped' : data.status)
      if (action !== 'stop') setStats(s => s)
    } catch (err) {
      setError(err.message)
    }
    setBusy('')
  }

  async function deleteContainer() {
    if (authRequired && !getToken()) return router.push('/login')
    setBusy('delete')
    setError('')
    try {
      const res = await authFetch(`${API}/containers/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      router.push('/')
    } catch (err) {
      setError(err.message)
      setBusy('')
    }
  }

  async function sendCommand(consult = false) {
    if (!cmd.trim()) return
    if (authRequired && !getToken()) return router.push('/login')
    setBusy('exec')
    setError('')
    const endpoint = mode === 'ai' ? 'agent' : 'exec'
    try {
      const res = await authFetch(`${API}/containers/${encodeURIComponent(id)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, consult: mode === 'ai' ? consult : false }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      if (mode === 'ai') {
        if (data.mode === 'consult') {
          setLog(l => [...l, { consult: true, request: cmd, model: data.model, reply: data.reply }])
        } else {
          setLog(l => [...l, { ai: true, request: cmd, model: data.model, command: data.command, output: data.output, exit_code: data.exit_code }])
        }
      } else {
        setLog(l => [...l, { command: cmd, output: data.output, exit_code: data.exit_code }])
      }
      setCmd('')
    } catch (err) {
      setLog(l => [...l, mode === 'ai' ? { ai: true, request: cmd, output: err.message, exit_code: null, error: true } : { command: cmd, output: err.message, exit_code: null, error: true }])
    }
    setBusy('')
  }

  async function connectVnc() {
    if (authRequired && !getToken()) {
      router.push('/login')
      return
    }
    await doConnect()
  }

  async function doConnect() {
    setVncState('connecting')
    try {
      await fetch(VNC_URL, { mode: 'no-cors', signal: AbortSignal.timeout(3000) })
      setVncState('connected')
    } catch {
      setVncState('unavailable')
    }
  }

  async function submitPassword(e) {
    e.preventDefault()
    setPwError('')
    const res = await authFetch(`${API}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwInput }),
    })
    const data = await res.json()
    if (data.ok) {
      setPwPromptOpen(false)
      await doConnect()
    } else {
      setPwError('รหัสผ่านไม่ถูกต้อง')
    }
  }

  const metrics = stats
    ? [
        { k: 'CPU', v: `${stats.cpu_percent}%`, bar: Math.min(100, stats.cpu_percent) },
        { k: 'Memory', v: fmtBytes(stats.mem_used), span: `/ ${fmtBytes(stats.mem_limit)}`, bar: stats.mem_limit ? Math.min(100, (stats.mem_used / stats.mem_limit) * 100) : 0 },
        { k: 'Network ↓', v: fmtBytes(stats.net_rx), span: 'received', bar: 40 },
        { k: 'Network ↑', v: fmtBytes(stats.net_tx), span: 'sent', bar: 25 },
      ]
    : [
        { k: 'CPU' }, { k: 'Memory' }, { k: 'Network ↓' }, { k: 'Network ↑' },
      ]

  return (
    <>
      <div className="flex items-center justify-between px-7 pb-1 pt-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gradient-to-br from-primary to-blue-500 text-white">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h1 className="flex items-center gap-3 text-[21px] font-bold tracking-tight">
              {id}
              <Badge variant={status} className="gap-1.5" data-testid="status-badge">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {status === 'stopped' ? 'Stopped' : status.charAt(0).toUpperCase() + status.slice(1)}
              </Badge>
            </h1>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">Container console &amp; AI agent control</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {error && <div className="mr-2 max-w-[280px] truncate rounded-md bg-red-500/15 px-3 py-1.5 text-[12px] text-red-400" title={error}>{error}</div>}
          <Button variant="outline" disabled={busy !== ''} onClick={() => containerAction('start')}><Play className="h-3.5 w-3.5" /> {busy === 'start' ? 'Starting…' : 'Start'}</Button>
          <Button variant="outline" disabled={busy !== ''} onClick={() => containerAction('stop')}><Square className="h-3.5 w-3.5" /> {busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
          <Button variant="outline" disabled={busy !== ''} onClick={() => containerAction('restart')}><RotateCw className="h-3.5 w-3.5" /> {busy === 'restart' ? 'Restarting…' : 'Restart'}</Button>
          <Button variant="outline" onClick={() => { setTab('console'); setTimeout(() => cmdBoxRef.current?.focus(), 100) }}>
            <Terminal className="h-3.5 w-3.5" /> Terminal
          </Button>
          <Button variant="outline" disabled={busy !== ''} className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-400" onClick={deleteContainer}>
            <Trash2 className="h-3.5 w-3.5" /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>

      <div className="grid items-start gap-4 px-7 py-5 [grid-template-columns:minmax(0,1fr)_340px] max-[1100px]:[grid-template-columns:1fr]">
        <Card>
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <div className="border-b px-4">
              <TabsList className="h-auto w-full justify-start gap-1 rounded-none border-b border-transparent bg-transparent p-0">
                {['console', 'files', 'analytics', 'security', 'networks'].map(t => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="rounded-none border-b-2 border-transparent px-3.5 py-3 text-[13px] font-semibold capitalize data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                  >
                    {t}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {/* ---- Console tab ---- */}
            <TabsContent value="console" className="mt-0 p-4">
              <div
                className={`relative mx-auto flex aspect-[16/9.5] flex-col overflow-hidden rounded-[10px] bg-[linear-gradient(135deg,#2c1e4d_0%,#1a1030_45%,#0f1a2e_100%)] transition-all ${vncScaled ? 'w-[125%]' : 'w-full'}`}
              >
                {vncState === 'connected' ? (
                  <iframe
                    src={`${VNC_URL}/vnc.html?autoconnect=1`}
                    className="h-full w-full border-0"
                    title="noVNC console"
                  />
                ) : (
                  <>
                    <div className="flex h-[30px] items-center gap-2 bg-black/55 px-3.5 text-[11.5px] text-[#cbb8ff] backdrop-blur">
                      <span className="h-2 w-2 rounded-full bg-[#b39ddb] opacity-80" />
                      <span className="h-2 w-2 rounded-full bg-[#b39ddb] opacity-80" />
                      <span className="h-2 w-2 rounded-full bg-[#b39ddb] opacity-80" />
                      <span className="ml-1.5">Containers ×</span>
                      <span className="ml-auto opacity-70">noVNC · {VNC_URL}</span>
                    </div>
                    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-4 text-center">
                      {vncState === 'connecting' ? (
                        <div className="text-[14px] text-slate-200/80">Connecting to noVNC…</div>
                      ) : vncState === 'unavailable' ? (
                        <>
                          <div className="text-[15px] font-semibold text-slate-200/90">noVNC agent not reachable</div>
                          <div className="max-w-[440px] text-[12px] leading-relaxed text-slate-200/55">
                            Start the agent container to get a live Ubuntu desktop here:
                          </div>
                          <code className="rounded-md border border-violet-400/30 bg-black/45 px-3 py-1.5 font-mono text-[11.5px] text-[#c4b5fd]">
                            docker compose --profile example up -d
                          </code>
                        </>
                      ) : (
                        <>
                          <div className="text-[34px] font-extrabold tracking-tight text-slate-200/90 [text-shadow:0_4px_30px_rgba(124,92,252,0.55)]">
                            Ubuntu Desktop
                          </div>
                          <div className="text-[12px] text-slate-200/55">XFCE · Chrome · Terminal — streamed live from the agent container</div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {vncState === 'connected' ? (
                  <>
                    <Button variant="outline" className="h-8 text-[12px]" onClick={() => setVncScaled(s => !s)}>
                      <MonitorUp className="h-3.5 w-3.5" /> {vncScaled ? 'Actual size' : 'Scale'}
                    </Button>
                    <Button variant="outline" className="h-8 border-red-500/40 text-[12px] text-red-400 hover:bg-red-500/10 hover:text-red-400" onClick={() => setVncState('disconnected')}>
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" className="h-8 text-[12px]" disabled={vncState === 'connecting'} onClick={connectVnc} data-testid="vnc-connect">
                    Connect{authRequired ? ' 🔒' : ''}
                  </Button>
                )}
              </div>

              <div className="mt-4 grid grid-cols-4 gap-3 border-t pt-4 max-[800px]:grid-cols-2">
                {metrics.map(m => (
                  <div key={m.k} data-testid="metric">
                    <div className="text-[11px] font-semibold text-muted-foreground/70">{m.k}</div>
                    <div className="mb-1.5 mt-1 text-[16px] font-bold">
                      {m.v ?? '—'} {m.span && <span className="text-[11px] font-medium text-muted-foreground/70">{m.span}</span>}
                    </div>
                    <Progress value={Math.round(m.bar || 0)} />
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* ---- Files tab ---- */}
            <TabsContent value="files" className="mt-0 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[13.5px] font-bold">Workspace files</div>
                <Button variant="outline" size="sm" onClick={() => setFiles(null)}>Refresh</Button>
              </div>
              <pre className="overflow-x-auto rounded-[10px] border bg-[#0d1420] p-4 font-mono text-[11.5px] leading-relaxed text-muted-foreground" data-testid="files-output">
                {files === null ? 'Loading…' : files.output || files.error || '(empty)'}
              </pre>
            </TabsContent>

            {/* ---- Analytics tab ---- */}
            <TabsContent value="analytics" className="mt-0 p-4">
              <div className="mb-3 text-[13.5px] font-bold">Live resource usage <span className="ml-2 text-[11px] font-medium text-muted-foreground/60">updates every 5s</span></div>
              <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
                {stats ? (
                  <>
                    {[
                      ['CPU', `${stats.cpu_percent}%`, Math.min(100, stats.cpu_percent)],
                      ['Memory', `${fmtBytes(stats.mem_used)} / ${fmtBytes(stats.mem_limit)}`, stats.mem_limit ? (stats.mem_used / stats.mem_limit) * 100 : 0],
                      ['Network ↓ (received)', fmtBytes(stats.net_rx), 40],
                      ['Network ↑ (sent)', fmtBytes(stats.net_tx), 25],
                    ].map(([k, v, bar]) => (
                      <div key={k} className="rounded-[10px] border bg-[#0d1420] p-4">
                        <div className="text-[11px] font-semibold text-muted-foreground/70">{k}</div>
                        <div className="mb-2 mt-1 text-[18px] font-bold">{v}</div>
                        <Progress value={Math.round(bar)} />
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="col-span-2 py-8 text-center text-[13px] text-muted-foreground/70">Collecting stats…</div>
                )}
              </div>
            </TabsContent>

            {/* ---- Security tab ---- */}
            <TabsContent value="security" className="mt-0 p-4">
              <div className="mb-3 text-[13.5px] font-bold">Container security &amp; metadata</div>
              {inspect?.error ? (
                <div className="py-8 text-center text-[13px] text-muted-foreground/70">Inspect unavailable</div>
              ) : inspect ? (
                <div className="rounded-[10px] border bg-[#0d1420] p-4">
                  {[
                    ['Container ID', inspect.id],
                    ['Image', inspect.image],
                    ['State', inspect.state],
                    ['Created', new Date(inspect.created).toLocaleString()],
                    ['Restart policy', inspect.restart_policy],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-4 border-b border-dashed border-border py-2.5 text-[12.5px] last:border-0">
                      <span className="text-muted-foreground/70">{k}</span>
                      <span className="truncate font-mono text-[11.5px]">{String(v)}</span>
                    </div>
                  ))}
                  <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Labels</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(inspect.labels || {}).slice(0, 12).map(([k, v]) => (
                      <Badge key={k} variant="gray" className="max-w-full truncate font-mono text-[10.5px]">{k}={v}</Badge>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="py-8 text-center text-[13px] text-muted-foreground/70">Inspecting…</div>
              )}
            </TabsContent>

            {/* ---- Networks tab ---- */}
            <TabsContent value="networks" className="mt-0 p-4">
              <div className="mb-3 text-[13.5px] font-bold">Networks</div>
              {inspect?.error ? (
                <div className="py-8 text-center text-[13px] text-muted-foreground/70">Inspect unavailable</div>
              ) : inspect ? (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                  {inspect.networks.map(n => (
                    <div key={n.name} className="rounded-[10px] border bg-[#0d1420] p-4">
                      <div className="text-[13px] font-bold">{n.name}</div>
                      <div className="mt-2 font-mono text-[11.5px] text-muted-foreground">IP: {n.ip?.filter(Boolean).join(', ') || '—'}</div>
                      {n.aliases?.length > 0 && (
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground/70">aliases: {n.aliases.filter(Boolean).join(', ')}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-[13px] text-muted-foreground/70">Inspecting…</div>
              )}
            </TabsContent>
          </Tabs>
        </Card>

        <div>
          <Card className="p-4">
            <div className="mb-3.5 text-[13.5px] font-bold">AI Agent Control</div>
            {[
              ['Model', agentModel || '—', ''],
              ['Container', status === 'running' ? 'Ready' : status, status === 'running' ? 'text-emerald-400' : ''],
            ].map(([k, v, color]) => (
              <div key={k} className="flex items-center justify-between border-b border-dashed border-border py-1.5 text-[12.5px] last:border-0">
                <span className="text-muted-foreground/70">{k}</span>
                <span className={color || 'font-semibold'}>{v}</span>
              </div>
            ))}

            <div className="mb-2.5 mt-4 flex items-center justify-between">
              <div className="text-[12.5px] font-bold">Command Center</div>
              <div className="flex rounded-md border bg-[#0d1420] p-0.5 text-[11px] font-semibold" data-testid="mode-toggle">
                <button
                  className={`rounded px-2.5 py-1 transition-colors ${mode === 'ai' ? 'bg-primary text-white' : 'text-muted-foreground'}`}
                  onClick={() => setMode('ai')}
                >
                  AI {agentModel && `· ${agentModel}`}
                </button>
                <button
                  className={`rounded px-2.5 py-1 transition-colors ${mode === 'shell' ? 'bg-primary text-white' : 'text-muted-foreground'}`}
                  onClick={() => setMode('shell')}
                >
                  Shell
                </button>
              </div>
            </div>
            <div className="relative">
              <Textarea
                ref={cmdBoxRef}
                placeholder={mode === 'ai'
                  ? 'บอก AI ว่าต้องการอะไร เช่น "สร้างไฟล์ hello.txt ที่มีข้อความสวัสดี"...'
                  : 'Type your shell command...'}
                value={cmd}
                onChange={e => setCmd(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendCommand() }}
                className="min-h-[96px] pb-6"
              />
              <div className="absolute bottom-2.5 left-3.5 text-[10.5px] text-muted-foreground/60">{cmd.length} characters</div>
            </div>
            {mode === 'ai' ? (
              <div className="mt-2.5 flex gap-2">
                <Button variant="outline" className="flex-1" disabled={busy !== '' || !cmd.trim()} onClick={() => sendCommand(true)} data-testid="consult-command">
                  💡 Consult
                </Button>
                <Button className="flex-1" disabled={busy !== '' || !cmd.trim()} onClick={() => sendCommand(false)} data-testid="send-command">
                  <Send className="h-4 w-4" /> {busy === 'exec' ? 'Working…' : 'Execute'}
                </Button>
              </div>
            ) : (
              <Button className="mt-2.5 w-full" disabled={busy !== '' || !cmd.trim()} onClick={() => sendCommand(false)} data-testid="send-command">
                <Send className="h-4 w-4" /> {busy === 'exec' ? 'Working…' : 'Send Command'}
              </Button>
            )}

            {log.length > 0 && (
              <div className="mt-3 space-y-2" data-testid="command-log">
                {log.map((entry, i) => (
                  <div key={i} className="rounded-[10px] border bg-[#0d1420] p-3 font-mono text-[11.5px]" data-testid="log-entry">
                    {(entry.ai || entry.consult) && (
                      <>
                        <div className="text-slate-400">❯ {entry.request}</div>
                        {entry.model && <div className="mt-0.5 text-[10px] uppercase tracking-wider text-violet-400">{entry.model}</div>}
                      </>
                    )}
                    {entry.consult ? (
                      <div className="mt-1.5 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-foreground/90">{entry.reply}</div>
                    ) : (
                      <>
                        <div className="text-primary">$ {entry.command}</div>
                        {entry.output && <pre className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.output}</pre>}
                        <div className={`mt-1 ${entry.error ? 'text-red-400' : 'text-emerald-400'}`}>
                          {entry.error ? 'error' : `exit code ${entry.exit_code}`}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="mb-2.5 mt-4 text-[12.5px] font-bold">Current Task</div>
            <div className="rounded-[10px] border bg-[#0d1420] p-3 text-[12px] text-muted-foreground/70">
              No active task — assign one from the Board or send a command above.
            </div>
          </Card>

          <Card className="mt-4 p-4">
            <div className="mb-3.5 text-[13.5px] font-bold">Available Skills</div>
            <div className="grid grid-cols-2 gap-2.5">
              {SKILLS.map(({ icon: Icon, label }) => (
                <div key={label} data-testid="skill" className="flex items-center gap-2.5 rounded-[9px] border bg-[#0d1420] px-3 py-2.5 text-[12px] font-semibold">
                  <Icon className="h-[15px] w-[15px] text-primary" /> {label}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

    </>
  )
}
