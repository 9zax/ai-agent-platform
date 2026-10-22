'use client'

import { useEffect, useState } from 'react'
import { Server, Package, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function SettingsPage() {
  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)

  useEffect(() => {
    fetch(`${API}/health`).then(r => r.json()).then(setHealth).catch(() => setHealth(null))
    fetch(`${API}/config`).then(r => r.json()).then(setConfig).catch(() => setConfig(null))
  }, [])

  const rows = [
    ['Orchestrator', health ? 'Healthy' : 'Unreachable', health ? 'text-emerald-400' : 'text-red-400'],
    ['Docker socket', health?.docker ? 'Connected' : 'Not connected', health?.docker ? 'text-emerald-400' : 'text-amber-400'],
    ['API endpoint', API, ''],
    ['Default model', config?.default_model ?? '—', ''],
    ['Default image', config?.default_image ?? '—', ''],
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
