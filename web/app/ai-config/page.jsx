'use client'

import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function AIConfigPage() {
  const [config, setConfig] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch(`${API}/config`).then(r => r.json()).then(setConfig)
  }, [])

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    const res = await fetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_model: config.default_model,
        default_image: config.default_image,
        max_containers: Number(config.max_containers),
        auto_restart: config.auto_restart,
      }),
    })
    setConfig(await res.json())
    setSaving(false)
    setSaved(true)
  }

  if (!config) {
    return <div className="px-7 pt-5 text-muted-foreground/70">Loading configuration…</div>
  }

  return (
    <>
      <div className="px-7 pb-1 pt-5">
        <h1 className="text-[21px] font-bold tracking-tight">AI Config</h1>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">Platform defaults for new agents and containers</div>
      </div>

      <div className="px-7 py-5">
        <Card className="max-w-xl p-5">
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="default-model" className="text-[13px] font-medium">Default Model</label>
              <Input
                id="default-model"
                value={config.default_model}
                onChange={e => setConfig({ ...config, default_model: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="default-image" className="text-[13px] font-medium">Default Container Image</label>
              <Input
                id="default-image"
                value={config.default_image}
                onChange={e => setConfig({ ...config, default_image: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="max-containers" className="text-[13px] font-medium">Max Containers</label>
              <Input
                id="max-containers"
                type="number"
                min={1}
                value={config.max_containers}
                onChange={e => setConfig({ ...config, max_containers: e.target.value })}
              />
            </div>
            <label className="flex cursor-pointer items-center justify-between rounded-lg border bg-[#0d1420] px-3.5 py-3">
              <span className="text-[13px] font-medium">Auto-restart crashed agents</span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(252,96%,67%)]"
                checked={config.auto_restart}
                onChange={e => setConfig({ ...config, auto_restart: e.target.checked })}
              />
            </label>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save Changes'}
              </Button>
              {saved && <span className="text-[12.5px] font-medium text-emerald-400" data-testid="saved-indicator">Saved ✓</span>}
            </div>
          </form>
        </Card>
      </div>
    </>
  )
}
