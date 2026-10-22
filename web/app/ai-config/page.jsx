'use client'

import { authFetch } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { Save, Check } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
      <div className="px-7 pb-1 pt-5">
        <h1 className="text-[21px] font-bold tracking-tight">AI Config</h1>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">เลือก provider template แล้วกรอก key — สลับได้เลยไม่ต้อง restart</div>
      </div>

      <div className="px-7 py-5">
        <div className="mb-4 grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
          {providers.map(p => (
            <button
              key={p.id}
              type="button"
              data-testid={`provider-${p.id}`}
              onClick={() => pickProvider(p)}
              className={cn(
                'rounded-xl border p-3.5 text-left transition-colors',
                config.ai_provider === p.id ? 'border-primary bg-primary/10' : 'bg-card hover:border-muted-foreground/40'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13.5px] font-bold">{p.label}</span>
                {config.ai_provider === p.id && <Check className="h-4 w-4 text-primary" />}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground/70">{p.note}</div>
              <div className="mt-2 flex gap-1.5">
                <Badge variant={p.local ? 'green' : 'gray'} className="text-[10px]">{p.local ? 'no key' : p.protocol}</Badge>
                {p.model && <Badge variant="blue" className="font-mono text-[10px]" title="default ของ provider — ปรับต่อ agent ได้ที่หน้า AI Team">{p.model}</Badge>}
              </div>
            </button>
          ))}
        </div>

        <Card className="max-w-xl p-5">
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
