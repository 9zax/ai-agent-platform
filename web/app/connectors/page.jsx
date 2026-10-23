'use client'

import { authFetch } from '@/lib/auth'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Figma, Github, Plug } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConnectorDialogs, connectorDisconnect } from '@/components/connector-flows'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function connectorOf(row, type) {
  return row.connectors?.find(c => c.type === type) || { type, state: 'disconnected' }
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
      {conn.state !== 'connected' && conn.reason && <span className="text-[11px] text-muted-foreground/60">{conn.reason}</span>}
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
      <div className="px-7 pb-1 pt-5">
        <h1 className="text-[21px] font-bold tracking-tight">Connectors</h1>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">
          บริการที่ agent container เชื่อมต่อใช้ได้ — เลือกเชื่อมต่อทีละเครื่องตามงานที่ต้องการ (แบบเดียวกับ Grok connectors)
        </div>
      </div>

      <div className="grid gap-3.5 px-7 py-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {cards.map(c => (
          <Card key={c.type} className="flex flex-col gap-3 p-4" data-testid={`connector-catalog-${c.type}`}>
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-[9px] border bg-[#0d1420]">
                {c.type === 'github' ? <Github className="h-[18px] w-[18px]" /> : c.type === 'figma' ? <Figma className="h-[18px] w-[18px]" /> : <Plug className="h-[18px] w-[18px]" />}
              </div>
              <div className="text-[14px] font-bold">{c.name || c.type}</div>
            </div>
            <div className="text-[12.5px] leading-relaxed text-muted-foreground/80">{c.description || '—'}</div>
            <div className="mt-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground/60">
              auth:
              {(c.auth_methods || []).map(m => (
                <span key={m.id} className="rounded-[5px] border bg-[#0d1420] px-1.5 py-0.5">
                  {m.name || m.id}
                </span>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <div className="px-7 pb-8">
        <div className="mb-3 text-[13.5px] font-bold">Connector ต่อ container</div>
        <Card className="p-0">
          {rows === null ? (
            <div className="p-5 text-[12.5px] text-muted-foreground/70">Loading containers…</div>
          ) : rows.length === 0 ? (
            <div className="p-5 text-[12.5px] text-muted-foreground/70">ยังไม่มี container — สร้างจาก Dashboard ก่อน แล้วมาเชื่อมต่อที่นี่</div>
          ) : (
            <Table>
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
                      <Link href={`/containers/${encodeURIComponent(r.name)}`} className="font-semibold text-primary hover:underline">
                        {r.name}
                      </Link>
                      {r.role && <span className="ml-2 font-mono text-[11px] text-muted-foreground/60">{r.role}</span>}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-[11.5px] text-muted-foreground">{r.image}</TableCell>
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
