'use client'
import { authFetch } from '@/lib/auth'

import HumanInbox from '@/components/human-inbox'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  Bot, LayoutDashboard, Waypoints, Package, Users, FolderKanban, Sparkles, Wrench, Plug, Github, Settings, ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Progress } from '@/components/ui/progress'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const MAIN = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/board', label: 'Orchestrator', icon: Waypoints },
  { href: '/team', label: 'AI Team', icon: Users },
  { href: '/projects', label: 'Projects', icon: FolderKanban, match: '/projects' },
  { href: '/', label: 'Containers', icon: Package, match: '/containers' },
]

const PLATFORM = [
  { href: '/ai-config', label: 'AI Config', icon: Sparkles },
  { href: '/connectors', label: 'Connectors', icon: Plug },
  { href: '/skills', label: 'Skills', icon: Wrench },
  { href: 'https://github.com/9zax/ai-agent-platform', label: 'GitHub', icon: Github, external: true },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [health, setHealth] = useState(null)
  const [agents, setAgents] = useState({ running: 0, total: 0 })
  const [session, setSession] = useState(null)

  useEffect(() => {
    authFetch(`${API}/health`).then(r => r.json()).then(setHealth).catch(() => setHealth(null))
    authFetch(`${API}/auth/me`).then(r => r.json()).then(setSession).catch(() => setSession(null))
    authFetch(`${API}/containers`)
      .then(r => r.json())
      .then(list => {
        const managed = (Array.isArray(list) ? list : []).filter(c => c.labels?.['managed-by'] === 'ai-agent-platform')
        setAgents({
          running: managed.filter(c => c.status === 'running').length,
          total: managed.length,
        })
      })
      .catch(() => {})
  }, [pathname])

  return (
    <aside className="sticky top-0 flex h-screen w-[232px] min-w-[232px] flex-col border-r bg-[#0d1420] px-3.5 py-4">
      <div className="flex shrink-0 items-center gap-2.5 px-2.5 pb-3">
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-gradient-to-br from-primary to-blue-500 text-white">
          <Bot className="h-4 w-4" />
        </div>
        <div>
          <div className="text-[15px] font-bold tracking-tight">AI Agent Platform</div>
          <div className="text-[10.5px] text-muted-foreground/70">ทุก AI agent ทำงานด้วยกัน</div>
        </div>
      </div>

      {/* Scrollable middle — on short viewports the nav must scroll, not overflow the screen */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Global inbox — need-human meeting alerts on every page */}
        <HumanInbox />

        <nav className="mt-1 flex flex-col gap-0.5">
        <div className="px-2.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/60">
          Main
        </div>
        {MAIN.map(item => {
          const active = item.match
            ? pathname.startsWith(item.match)
            : pathname === item.href && !pathname.startsWith('/containers')
          const Icon = item.icon
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors',
                active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              <Icon className="h-[17px] w-[17px]" />
              {item.label}
            </Link>
          )
        })}
        <div className="px-2.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/60">
          Platform
        </div>
        {PLATFORM.map(item => {
          const Icon = item.icon
          const active = !item.external && pathname === item.href
          if (item.external) {
            return (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Icon className="h-[17px] w-[17px]" />
                {item.label}
              </a>
            )
          }
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors',
                active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              )}
            >
              <Icon className="h-[17px] w-[17px]" />
              {item.label}
            </Link>
          )
        })}
        </nav>
      </div>

      <div className="mt-3 shrink-0 rounded-xl border bg-card p-3">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold">
          <span className={cn('h-2 w-2 rounded-full', health ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]' : 'bg-muted-foreground/50')} />
          {health ? 'All Systems Operational' : 'Orchestrator Offline'}
        </div>
        <div className="mb-1.5 mt-2 text-[11.5px] text-muted-foreground/70">
          {agents.running} of {agents.total} agents active
        </div>
        <Progress value={agents.total ? Math.round((agents.running / agents.total) * 100) : 0} />
      </div>

      <div className="mt-2.5 flex shrink-0 items-center gap-2.5 rounded-xl border bg-card p-2.5">
        <Avatar className="h-[30px] w-[30px]">
          <AvatarFallback>{session?.valid ? session.user.slice(0, 2).toUpperCase() : '?'}</AvatarFallback>
        </Avatar>
        {session?.valid ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold">{session.user}</div>
            <button
              className="text-[10.5px] text-muted-foreground/70 hover:text-red-400"
              onClick={async () => {
                await authFetch(`${API}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: localStorage.getItem('aap_token') || '' }) })
                localStorage.removeItem('aap_token')
                localStorage.removeItem('aap_user')
                window.location.href = '/login'
              }}
            >
              Log out
            </button>
          </div>
        ) : session?.auth_required ? (
          <a href="/login" className="flex items-center gap-1 text-[12.5px] font-semibold text-primary">Sign in <ArrowRight className="h-3.5 w-3.5" /></a>
        ) : (
          <div>
            <div className="text-[12.5px] font-semibold">Admin</div>
            <div className="text-[10.5px] text-muted-foreground/70">no auth required</div>
          </div>
        )}
      </div>
    </aside>
  )
}
