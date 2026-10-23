'use client'

import { authFetch } from '@/lib/auth'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Figma, Github, Plug, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConnectorDialogs, connectorDisconnect } from '@/components/connector-flows'
import PageHeader from '@/components/page-header'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function connectorOf(row, type) {
  return row.connectors?.find(c => c.type === type) || { type, state: 'disconnected' }
}

function CatalogIcon({ type }) {
  if (type === 'github') return <Github className="h-[19px] w-[19px]" />
  if (type === 'figma') return <Figma className="h-[19px] w-[19px]" />
  return <Plug className="h-[19px] w-[19px]" />
}

// One connector column cell — badge + login/reason plus the action button
// (Connect opens the shared flow dialog, Disconnect runs inline). Shared by
// every connector column.
function StateCell({ conn, ctype, busy, onConnect, onDisconnect }) {
  return (
    <div className="flex items-center gap-2">
      <Badge
        variant={conn.state === 'connected' ? 'green' : conn.state === 'pending' ? 'yellow' : conn.state === 'unavailable' ? 'dead' : 'gray'}
        data-testid={`connector-row-status-${ctype}`}
      >
        {conn.state === 'connected' ? 'Connected' : conn.state === 'pending' ? 'Pending…' : conn.state === 'unavailable' ? 'Unavailable' : 'Not connected'}
      </Badge>
      {conn.state === 'connected' && conn.login && <span className="text-[12px] text-muted-foreground">@{conn.login}</span>}
      {conn.state !== 'connected' && conn.reason && <span className="max-w-[190px] truncate text-[11px] text-muted-foreground/60" title={conn.reason}>{conn.reason}</span>}
      {conn.state === 'connected' ? (
        <Button
          size="sm" variant="ghost"
          className="h-6 px-2 text-[11px] text-red-400 hover:bg-red-500/10 hover:text-red-400"
          disabled={busy}
          onClick={onDisconnect}
          data-testid={`connector-row-disconnect-${ctype}`}
        >
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      ) : conn.state === 'disconnected' && (
        <Button
          size="sm" variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={onConnect}
          data-testid={`connector-row-connect-${ctype}`}
        >
          Connect
        </Button>
      )}
    </div>
  )
}

export default function ConnectorsPage() {
  const [catalog, setCatalog] = useState(null)
  const [rows, setRows] = useState(null)
  const [flow, setFlow] = useState(null) // { container, ctype } — opens the shared dialog
  const [busyKey, setBusyKey] = useState('') // `${container}:${ctype}:disconnect`
  const [refresh, setRefresh] = useState(0) // bumped after a change → repoll now

  useEffect(() => {
    authFetch(`${API}/connectors`).then(r => r.json()).then(setCatalog).catch(() => setCatalog([]))
  }, [])

  // 5s poll — connector state is live-derived from each container
  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await authFetch(`${API}/connectors/status`)
        if (res.ok && alive) setRows(await res.json())
      } catch { /* keep last known */ }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [refresh])

  async function disconnect(container, ctype) {
    setBusyKey(`${container}:${ctype}:disconnect`)
    try {
      await connectorDisconnect(container, ctype)
      setRefresh(t => t + 1)
    } catch { /* the next poll re-derives the true state */ }
    setBusyKey('')
  }

  const cards = catalog === null
    ? [
        { type: 'github', name: 'GitHub', description: '', auth_methods: [{ id: 'device', name: 'Browser' }, { id: 'token', name: 'Token' }] },
        { type: 'figma', name: 'Figma', description: '', auth_methods: [{ id: 'token', name: 'Token' }] },
      ]
    : catalog

  return (
    <>
      <PageHeader
        icon={Plug}
        title="Connectors"
        subtitle="บริการที่ agent บนเครื่องนี้เชื่อมต่อใช้ได้ — เครื่องเดียว identity เดียว (login ครั้งเดียวทั้งทีม)"
        actions={(
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[11.5px] text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="ping-soft absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            Live · รีเฟรชทุก 5s
          </span>
        )}
      />

      <div className="page-body space-y-5">
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          {cards.map(c => (
            <Card
              key={c.type}
              className="group flex flex-col gap-3 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.1] hover:shadow-lift"
              data-testid={`connector-catalog-${c.type}`}
            >
              <div className="flex items-center gap-3">
                <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl border ring-1 ring-inset',
                  c.type === 'figma'
                    ? 'border-white/[0.08] bg-[#0d1420] text-pink-300 ring-pink-400/10'
                    : 'border-white/[0.08] bg-[#0d1420] text-white ring-white/[0.06]')}>
                  <CatalogIcon type={c.type} />
                </div>
                <div>
                  <div className="text-[14px] font-semibold text-white">{c.name || c.type}</div>
                  <div className="text-[11.5px] text-muted-foreground/50">machine-wide connection</div>
                </div>
              </div>
              <div className="min-h-[36px] text-[12.5px] leading-relaxed text-muted-foreground/80">{c.description || '—'}</div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-white/[0.05] pt-3">
                <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/40">auth</span>
                {(c.auth_methods || []).map(m => (
                  <span key={m.id} className="rounded-md border border-white/[0.07] bg-white/[0.035] px-1.5 py-0.5 text-[11px] text-muted-foreground/80">
                    {m.name || m.id}
                  </span>
                ))}
              </div>
            </Card>
          ))}
        </div>

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/[0.09] text-primary ring-1 ring-inset ring-primary/15">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <div>
                <div className="text-[13.5px] font-semibold text-white">Connector ต่อเครื่อง</div>
                <div className="text-[11.5px] text-muted-foreground/60">ใช้ร่วมทั้งทีม — state derives จากเครื่อง host จริง</div>
              </div>
            </div>
            {rows && <Badge variant="gray">{rows.length} agent{rows.length === 1 ? '' : 's'}</Badge>}
          </div>

          {rows === null ? (
            <div className="p-5">
              <div className="skeleton h-3 w-40" />
              <div className="skeleton mt-3 h-3 w-2/3" />
              <div className="skeleton mt-3 h-3 w-1/2" />
              <span className="sr-only">Loading agents…</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.03]">
                <Plug className="h-5 w-5 text-muted-foreground/40" />
              </div>
              <div className="text-[13.5px] font-semibold text-white">ยังไม่มี agent</div>
              <div className="max-w-md text-[12.5px] text-muted-foreground">
                start จากหน้า Team หรือ Dashboard ก่อน แล้วมาเชื่อมต่อที่นี่
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Container</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>GitHub</TableHead>
                  <TableHead>Figma</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(r => (
                  <TableRow key={r.id || r.name} data-testid="connector-status-row">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Link href={`/containers/${encodeURIComponent(r.name)}`} className="font-semibold text-primary hover:underline">
                          {r.name}
                        </Link>
                        {r.role && (
                          <span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/60 ring-1 ring-inset ring-white/[0.05]">
                            {r.role}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-[11.5px] text-muted-foreground/70">{r.image}</TableCell>
                    <TableCell>
                      <StateCell
                        conn={connectorOf(r, 'github')} ctype="github"
                        busy={busyKey === `${r.name}:github:disconnect`}
                        onConnect={() => setFlow({ container: r.name, ctype: 'github' })}
                        onDisconnect={() => disconnect(r.name, 'github')}
                      />
                    </TableCell>
                    <TableCell>
                      <StateCell
                        conn={connectorOf(r, 'figma')} ctype="figma"
                        busy={busyKey === `${r.name}:figma:disconnect`}
                        onConnect={() => setFlow({ container: r.name, ctype: 'figma' })}
                        onDisconnect={() => disconnect(r.name, 'figma')}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </Card>
      </div>

      <ConnectorDialogs
        containerId={flow?.container || null}
        ctype={flow?.ctype || null}
        onClose={() => setFlow(null)}
        onChanged={() => setRefresh(t => t + 1)}
      />
    </>
  )
}
