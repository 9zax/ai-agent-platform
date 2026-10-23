'use client'

import { authFetch, getToken } from '@/lib/auth'
import { useParams, useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import {
  Bot, Play, Square, RotateCw, Terminal, Trash2, Send, Globe, Code, BarChart3, FileText, Plug, Image as ImageIcon, Lightbulb, TriangleAlert, Github, Figma, PauseCircle, PlayCircle,
} from 'lucide-react'
import { ConnectorDialogs, connectorDisconnect } from '@/components/connector-flows'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import PageHeader from '@/components/page-header'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// xterm.js touches the DOM at import time — client only
const TerminalPanel = dynamic(() => import('@/components/terminal-panel'), {
  ssr: false,
  loading: () => <div className="h-[382px] animate-pulse rounded-[10px] border bg-[#0d1420]" />,
})

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

// One connector tile — state/badge/buttons are identical for every connector;
// only the copy (name, hint, status text) and the connect flow differ. Connect
// opens the shared dialog (it owns the spinner); disconnect runs inline.
function ConnectorTile({ ctype, name, hint, icon: Icon, conn, statusText, busy, connectLabel, connectDisabled, connectTitle, onConnect, onDisconnect }) {
  const state = conn?.state
  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3.5" data-testid={`connector-card-${ctype}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Icon className="h-[18px] w-[18px] text-foreground" />
          <div>
            <div className="text-[13px] font-bold">{name}</div>
            <div className="text-[11px] text-muted-foreground/70">{hint}</div>
          </div>
        </div>
        <Badge
          variant={state === 'connected' ? 'green' : state === 'pending' ? 'yellow' : state === 'unavailable' ? 'dead' : 'gray'}
          data-testid={`connector-status-${ctype}`}
        >
          {state === 'connected' ? 'Connected' : state === 'pending' ? 'Pending…' : state === 'unavailable' ? 'Unavailable' : 'Not connected'}
        </Badge>
      </div>

      <div className="mt-2.5 text-[12px] text-muted-foreground/80">{statusText}</div>

      <div className="mt-3 flex gap-2">
        {state === 'connected' ? (
          <Button
            variant="outline" size="sm"
            className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-400"
            disabled={busy !== ''}
            onClick={onDisconnect}
            data-testid={`connector-disconnect-${ctype}`}
          >
            {busy === `${ctype}-disconnect` ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        ) : (
          <Button
            variant="outline" size="sm"
            disabled={busy !== '' || connectDisabled}
            title={connectTitle}
            onClick={onConnect}
            data-testid={`connector-connect-${ctype}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {connectLabel}
          </Button>
        )}
      </div>
    </div>
  )
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
  const [mode, setMode] = useState('ai') // 'ai' = LLM decides, 'shell' = run directly
  const [agentModel, setAgentModel] = useState('')
  const [authRequired, setAuthRequired] = useState(false) // true = must be logged in to touch containers
  const [connectors, setConnectors] = useState(null) // [{ type, state, login?, reason?, user_code? }] — null = loading
  const [flowCtype, setFlowCtype] = useState(null) // 'github' | 'figma' — opens the shared connect dialog
  const [connBusy, setConnBusy] = useState('') // `${ctype}-disconnect` while a tile disconnect runs
  const [connRefresh, setConnRefresh] = useState(0) // bumped when the dialog reports a change → repoll now
  const cmdBoxRef = useRef(null)

  // GitHub connector state — polled every 3s (the orchestrator caches its probe
  // for 10s, so this stays cheap) so status follows container start/stop and
  // device-flow completion without a manual refresh
  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await authFetch(`${API}/containers/${encodeURIComponent(id)}/connectors`)
        const list = res.ok ? await res.json() : []
        if (alive) setConnectors(Array.isArray(list) ? list : [])
      } catch { /* keep last known */ }
    }
    load()
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [id, connRefresh])

  const github = connectors?.find(c => c.type === 'github') || null
  const figma = connectors?.find(c => c.type === 'figma') || null

  // The connect flows (GitHub device/token, Figma token) live in the shared
  // ConnectorDialogs — the same one the connectors overview and AI Team cards
  // open. Tiles here only open it and handle their own disconnect.
  function openFlow(ctype) {
    if (authRequired && !getToken()) return router.push('/login')
    setFlowCtype(ctype)
  }

  async function disconnectConnector(ctype) {
    if (authRequired && !getToken()) return router.push('/login')
    setConnBusy(`${ctype}-disconnect`)
    setError('')
    try {
      await connectorDisconnect(id, ctype)
      setConnectors(list => (list || []).map(c => (c.type === ctype ? { ...c, state: 'disconnected', login: null } : c)))
    } catch (err) {
      setError(err.message)
    }
    setConnBusy('')
  }

  useEffect(() => {
    // provider default first; a persona's own model (per-provider override) wins when this
    // container belongs to one — matched by name or 12-char id
    authFetch(`${API}/agent/status`).then(r => r.json()).then(s => setAgentModel(s.model || '')).catch(() => {})
    authFetch(`${API}/agents`).then(r => r.json()).then(list => {
      const me = (Array.isArray(list) ? list : []).find(a => a.container?.name === id || a.container?.id === id)
      if (me?.model) setAgentModel(me.model)
    }).catch(() => {})
    authFetch(`${API}/config`).then(r => r.json()).then(c => setAuthRequired(!!c.auth_required)).catch(() => {})
  }, [id])

  // Live stats polling (every 5s) — also keeps the status badge in sync when
  // the idle sweeper pauses the container or an access revives it.
  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const res = await authFetch(`${API}/containers/${encodeURIComponent(id)}/stats`)
        if (res.ok && alive) {
          const data = await res.json()
          setStats(data)
          if (data.status) setStatus(data.status === 'exited' ? 'stopped' : data.status)
        }
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
  }, [tab, id, files])

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
          setLog(l => [...l, { ai: true, request: cmd, model: data.model, command: data.command, output: data.output, exit_code: data.exit_code, repo: data.repo, repo_warning: data.repo_warning }])
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

  // Host agents have no per-cgroup cpu/mem/net numbers — those render as "—".
  const metrics = [
    { k: 'CPU', v: stats?.cpu_percent != null ? `${stats.cpu_percent}%` : null, bar: stats?.cpu_percent ?? 0 },
    { k: 'Memory', v: stats?.mem_used != null ? fmtBytes(stats.mem_used) : null, span: stats?.mem_limit ? `/ ${fmtBytes(stats.mem_limit)}` : '', bar: stats?.mem_limit && stats?.mem_used ? Math.min(100, (stats.mem_used / stats.mem_limit) * 100) : 0 },
    { k: 'Disk', v: stats?.disk_used != null ? fmtBytes(stats.disk_used) : null, span: stats?.disk_total != null ? `/ ${fmtBytes(stats.disk_total)}` : '', bar: stats?.disk_total && stats?.disk_used != null ? Math.min(100, (stats.disk_used / stats.disk_total) * 100) : 0 },
  ]

  return (
    <>
      <PageHeader
        className="pb-5"
        leading={(
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-blue-500 text-white shadow-[0_10px_30px_-12px_rgba(139,92,246,0.7)]">
            <Bot className="h-5 w-5" />
          </div>
        )}
        title={(
          <span className="flex flex-wrap items-center gap-2.5">
            {id}
            <Badge variant={status} className="gap-1.5" data-testid="status-badge">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {status === 'stopped' ? 'Stopped' : status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
          </span>
        )}
        subtitle={(
          <>
            Agent console — commands run on this machine (tmux session), not in a container
            {status === 'paused' && stats?.paused_since
              ? <span className="ml-2 text-cyan-400/80">{stats.auto_paused ? 'auto-' : ''}paused {Math.max(0, Math.round((Date.now() / 1000 - stats.paused_since) / 60))} min ago</span>
              : null}
          </>
        )}
        actions={(
          <>
            {error && <div className="mr-1 max-w-[280px] truncate rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300" title={error}>{error}</div>}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => containerAction('start')}><Play className="h-3.5 w-3.5" /> {busy === 'start' ? 'Starting…' : 'Start'}</Button>
              <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => containerAction('pause')}><PauseCircle className="h-3.5 w-3.5" /> {busy === 'pause' ? 'Pausing…' : 'Pause'}</Button>
              <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => containerAction('resume')}><PlayCircle className="h-3.5 w-3.5" /> {busy === 'resume' ? 'Resuming…' : 'Resume'}</Button>
              <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => containerAction('stop')}><Square className="h-3.5 w-3.5" /> {busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>
              <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => containerAction('restart')}><RotateCw className="h-3.5 w-3.5" /> {busy === 'restart' ? 'Restarting…' : 'Restart'}</Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => { setTab('console'); setTimeout(() => cmdBoxRef.current?.focus(), 100) }}>
              <Terminal className="h-3.5 w-3.5" /> Terminal
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== ''} className="text-red-400 hover:bg-red-500/10 hover:text-red-300" onClick={deleteContainer}>
              <Trash2 className="h-3.5 w-3.5" /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        )}
      />

      <div className="page-body grid items-start gap-4 [grid-template-columns:minmax(0,1fr)_360px] max-[1100px]:[grid-template-columns:1fr]">
        <Card>
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <div className="border-b border-white/[0.06] px-3">
              <TabsList className="h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0">
                {['console', 'files'].map(t => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="rounded-none border-b-2 border-transparent px-3.5 py-3 text-[13px] font-semibold capitalize text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:shadow-none"
                  >
                    {t}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {/* ---- Console tab — the agent's live tmux session (host execution:
                  every command the orchestrator runs lands in this terminal) ---- */}
            <TabsContent value="console" className="mt-0 p-4">
              <div className="mb-2.5 flex items-center justify-between">
                <div className="text-[13.5px] font-bold">Live terminal <span className="ml-1.5 text-[11px] font-medium text-muted-foreground/60">tmux session on this machine</span></div>
                <code className="rounded-md border bg-[#0d1420] px-2.5 py-1 font-mono text-[11px] text-muted-foreground">tmux attach -t {id}</code>
              </div>
              <TerminalPanel containerId={id} tall />

              <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-4 max-[900px]:grid-cols-3 max-[600px]:grid-cols-2">
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
                <div className="text-[13.5px] font-bold">Workspace files <span className="ml-1.5 text-[11px] font-medium text-muted-foreground/60">shared working tree of the whole team</span></div>
                <Button variant="outline" size="sm" onClick={() => setFiles(null)}>Refresh</Button>
              </div>
              <pre className="overflow-x-auto rounded-[10px] border bg-[#0d1420] p-4 font-mono text-[11.5px] leading-relaxed text-muted-foreground" data-testid="files-output">
                {files === null ? 'Loading…' : files.output || files.error || '(empty)'}
              </pre>
            </TabsContent>
          </Tabs>
        </Card>

        <div>
          <Card className="p-4">
            <div className="mb-3.5 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/[0.09] text-primary ring-1 ring-inset ring-primary/15"><Bot className="h-3.5 w-3.5" /></span>
              <span className="text-[13px] font-semibold text-white">AI Agent Control</span>
            </div>
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
              <div className="text-[12.5px] font-semibold text-white">Command Center</div>
              <div className="flex rounded-lg border border-white/[0.07] bg-black/20 p-0.5 text-[11px] font-semibold" data-testid="mode-toggle">
                <button
                  className={`rounded px-2.5 py-1 transition-colors ${mode === 'ai' ? 'bg-primary text-white' : 'text-muted-foreground'}`}
                  onClick={() => setMode('ai')}
                >
                  AI {agentModel && `· ${agentModel}`}
                </button>
                <button
                  className={`rounded px-2.5 py-1 transition-colors ${mode === 'shell' ? 'bg-primary text-white' : 'text-muted-foreground'}`}
                  onClick={() => { if (authRequired && !getToken()) return router.push('/login'); setMode('shell') }}
                >
                  Shell
                </button>
              </div>
            </div>
            {mode === 'ai' ? (
              <>
                <div className="relative">
                  <Textarea
                    ref={cmdBoxRef}
                    placeholder='บอก AI ว่าต้องการอะไร เช่น "สร้างไฟล์ hello.txt ที่มีข้อความสวัสดี"...'
                    value={cmd}
                    onChange={e => setCmd(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendCommand() }}
                    className="min-h-[96px] pb-6"
                  />
                  <div className="absolute bottom-2.5 left-3.5 text-[10.5px] text-muted-foreground/60">{cmd.length} characters</div>
                </div>
                <div className="mt-2.5 flex gap-2">
                  <Button variant="outline" className="flex-1" disabled={busy !== '' || !cmd.trim()} onClick={() => sendCommand(true)} data-testid="consult-command">
                    <Lightbulb className="h-4 w-4" /> Consult
                  </Button>
                  <Button className="flex-1" disabled={busy !== '' || !cmd.trim()} onClick={() => sendCommand(false)} data-testid="send-command">
                    <Send className="h-4 w-4" /> {busy === 'exec' ? 'Working…' : 'Execute'}
                  </Button>
                </div>
              </>
            ) : (
              <TerminalPanel containerId={id} />
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
                        {entry.repo && <div className="mt-0.5 text-[10px] text-sky-400">repo: {entry.repo}</div>}
                        {entry.repo_warning && (
                          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-amber-400">
                            <TriangleAlert className="h-3 w-3 shrink-0" /> {entry.repo_warning}
                          </div>
                        )}
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

            <div className="mb-2.5 mt-4 text-[12.5px] font-semibold text-white">Current Task</div>
            <div className="rounded-xl border border-dashed border-white/[0.08] bg-black/10 p-3.5 text-[12px] leading-relaxed text-muted-foreground/60">
              No active task — assign one from the Board or send a command above.
            </div>
          </Card>

          <Card className="mt-4 p-4">
            <div className="mb-3.5 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/[0.09] text-primary ring-1 ring-inset ring-primary/15"><Plug className="h-3.5 w-3.5" /></span>
              <span className="text-[13px] font-semibold text-white">Connectors</span>
            </div>
            {connectors === null ? (
              <div className="py-2 text-[12.5px] text-muted-foreground/70">Loading connectors…</div>
            ) : (
              <div className="grid gap-3">
                <ConnectorTile
                  ctype="github"
                  name="GitHub"
                  hint="gh + git push/pull ในเครื่องนี้"
                  icon={Github}
                  conn={github}
                  busy={connBusy}
                  connectLabel="Connect GitHub"
                  connectDisabled={github?.state === 'unavailable'}
                  connectTitle={github?.state === 'unavailable' ? github?.reason : undefined}
                  onConnect={() => openFlow('github')}
                  onDisconnect={() => disconnectConnector('github')}
                  statusText={
                    <>
                      {github?.state === 'connected' && github?.login && <span className="font-semibold text-emerald-400">@{github.login}</span>}
                      {github?.state === 'connected' && !github?.login && <span className="text-emerald-400">authenticated</span>}
                      {github?.state === 'pending' && 'รออนุมัติใน browser…'}
                      {github?.state === 'disconnected' && 'ยังไม่ได้เชื่อมต่อ — Connect ผ่าน browser หรือวาง personal access token'}
                      {github?.state === 'unavailable' && (github?.reason || 'connector unavailable')}
                    </>
                  }
                />
                <ConnectorTile
                  ctype="figma"
                  name="Figma"
                  hint="Figma REST API — อ่าน design file ในเครื่องนี้"
                  icon={Figma}
                  conn={figma}
                  busy={connBusy}
                  connectLabel="Connect Figma"
                  connectDisabled={figma?.state === 'unavailable'}
                  connectTitle={figma?.state === 'unavailable' ? figma?.reason : undefined}
                  onConnect={() => openFlow('figma')}
                  onDisconnect={() => disconnectConnector('figma')}
                  statusText={
                    <>
                      {figma?.state === 'connected' && figma?.login && <span className="font-semibold text-emerald-400">@{figma.login}</span>}
                      {figma?.state === 'connected' && !figma?.login && <span className="text-emerald-400">authenticated</span>}
                      {figma?.state === 'disconnected' && 'ยังไม่ได้เชื่อมต่อ — Connect ด้วย Figma personal access token'}
                      {figma?.state === 'unavailable' && (figma?.reason || 'connector unavailable')}
                    </>
                  }
                />
              </div>
            )}
          </Card>

          <Card className="mt-4 p-4">
            <div className="mb-3.5 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/[0.09] text-primary ring-1 ring-inset ring-primary/15"><Lightbulb className="h-3.5 w-3.5" /></span>
              <span className="text-[13px] font-semibold text-white">Available Skills</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {SKILLS.map(({ icon: Icon, label }) => (
                <div key={label} data-testid="skill" className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-black/20 px-3 py-2.5 text-[12px] font-medium text-foreground/85 transition-colors hover:border-white/[0.12] hover:bg-white/[0.03]">
                  <Icon className="h-[15px] w-[15px] text-primary" /> {label}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Shared connect dialogs — GitHub (browser device flow | token) and
          Figma (token), the same component the connectors overview and the AI
          Team cards open */}
      <ConnectorDialogs
        containerId={id}
        ctype={flowCtype}
        onClose={() => setFlowCtype(null)}
        onChanged={() => setConnRefresh(t => t + 1)}
      />
    </>
  )
}
