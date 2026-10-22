'use client'

import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function SkillsPage() {
  const [skills, setSkills] = useState(null)

  async function load() {
    const res = await fetch(`${API}/skills`)
    setSkills(await res.json())
  }

  useEffect(() => { load() }, [])

  async function toggle(skill) {
    const res = await fetch(`${API}/skills/${skill.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !skill.enabled }),
    })
    const updated = await res.json()
    setSkills(list => list.map(s => (s.id === updated.id ? updated : s)))
  }

  return (
    <>
      <div className="px-7 pb-1 pt-5">
        <h1 className="text-[21px] font-bold tracking-tight">Skills</h1>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground/70">Capabilities available to AI agent containers</div>
      </div>

      <div className="grid gap-3.5 px-7 py-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {skills === null && <div className="text-muted-foreground/70">Loading skills…</div>}
        {skills?.map(s => (
          <Card key={s.id} className="flex flex-col gap-3 p-4" data-testid="skill-card">
            <div className="flex items-start justify-between gap-3">
              <div className="text-[14px] font-bold">{s.name}</div>
              <Badge variant={s.enabled ? 'green' : 'gray'} data-testid="skill-status">
                {s.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <div className="text-[12.5px] leading-relaxed text-muted-foreground/80">{s.description}</div>
            <div className="mt-auto flex items-center justify-between">
              <code className="rounded bg-secondary px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{s.id}</code>
              <Button variant="outline" size="sm" data-testid="skill-toggle" onClick={() => toggle(s)}>
                {s.enabled ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                {s.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  )
}
