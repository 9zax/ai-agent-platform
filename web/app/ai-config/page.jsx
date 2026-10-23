'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Save, Check, Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import PageHeader from '@/components/page-header'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function AIConfigPage() {
  const [providers, setProviders] = useState([])
  const [config, setConfig] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    authFetch(`${API}/providers`).then(r => r.json()).then(setProviders).catch(() => setProviders([]))
    authFetch(`${API}/config`).then(r => r.json()).then(setConfig).catch(() => setConfig(null))
  }, [])

  function pickProvider(p) {
    setConfig({
      ...config,
      ai_provider: p.id,
      ai_base_url: p.base_url,
    })
    setSaved(false)
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const body = {
        ai_provider: config.ai_provider,
        ai_base_url: config.ai_base_url,
      }
      if (apiKey) body.ai_api_key = apiKey
      const res = await authFetch(`${API}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setConfig(data)
      setApiKey('')
      setSaved(true)
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  if (!config) {
    return <div className="px-7 pt-5 text-muted-foreground/70">Loading configuration…</div>
  }

  return (
    <>
      <PageHeader
        icon={Sparkles}
        title="AI Config"
        subtitle="เลือก provider template แล้วกรอก key — สลับได้เลยไม่ต้อง restart"
      />

      <div className="page-body">
        <div className="mb-5 grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          {providers.map(p => {
            const active = config.ai_provider === p.id
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`provider-${p.id}`}
                onClick={() => pickProvider(p)}
                className={cn(
                  'group relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-150',
                  active
                    ? 'border-primary/50 bg-primary/[0.08] shadow-[0_0_0_1px_rgba(139,92,246,0.12),0_14px_30px_-20px_rgba(139,92,246,0.7)]'
                    : 'border-white/[0.06] bg-card/60 hover:-translate-y-0.5 hover:border-white/[0.12] hover:bg-white/[0.03]'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-white">{p.label}</span>
                  <span className={cn('flex h-5 w-5 items-center justify-center rounded-full ring-1 ring-inset transition-colors',
                    active ? 'bg-primary text-white ring-primary' : 'text-transparent ring-white/[0.1] group-hover:ring-white/20')}>
                    <Check className="h-3 w-3" />
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 min-h-[30px] text-[11px] leading-relaxed text-muted-foreground/60">{p.note}</div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <Badge variant={p.local ? 'green' : 'gray'}>{p.local ? 'no key' : p.protocol}</Badge>
                  {p.model && <Badge variant="blue" className="font-mono" title="default ของ provider — ปรับต่อ agent ได้ที่หน้า AI Team">{p.model}</Badge>}
                </div>
              </button>
            )
          })}
        </div>

        <Card className="max-w-2xl p-5">
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="ai-base" className="text-[13px] font-medium">Base URL</label>
              <Input id="ai-base" value={config.ai_base_url} placeholder="https://..." onChange={e => setConfig({ ...config, ai_base_url: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="ai-key" className="text-[13px] font-medium">
                API Key {config.ai_api_key_masked && <span className="ml-1 font-mono text-[11px] text-muted-foreground/60">current: {config.ai_api_key_masked}</span>}
              </label>
              <Input id="ai-key" type="password" value={apiKey} placeholder={providers.find(p => p.id === config.ai_provider)?.key_hint || 'API key'} onChange={e => setApiKey(e.target.value)} />
            </div>
            {error && <div className="rounded-md bg-red-500/15 px-3 py-2 text-[12.5px] text-red-400">{error}</div>}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}><Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save Provider Config'}</Button>
              {saved && <span className="flex items-center gap-1 text-[12.5px] font-medium text-emerald-400" data-testid="saved-indicator">Saved <Check className="h-3.5 w-3.5" /></span>}
            </div>
          </form>
        </Card>
        <div className="mt-3 text-[12px] text-muted-foreground/70" data-testid="per-agent-model-hint">
          เลือกโมเดลทำที่ระดับ agent — ตั้ง per-persona model ได้ที่หน้า <a className="text-primary underline" href="/team">AI Team</a>
        </div>
      </div>
    </>
  )
}
