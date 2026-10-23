'use client'
import { authFetch } from '@/lib/auth'

import HumanInbox from '@/components/human-inbox'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  Bot, LayoutDashboard, Waypoints, Users, FolderKanban, Sparkles, Wrench, Plug, Github, Settings,
  ArrowRight, ArrowUpRight, LogOut,
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
]

const PLATFORM = [
  { href: '/ai-config', label: 'AI Config', icon: Sparkles },
  { href: '/connectors', label: 'Connectors', icon: Plug },
  { href: '/skills', label: 'Skills', icon: Wrench },
  { href: 'https://github.com/9zax/ai-agent-platform', label: 'GitHub', icon: Github, external: true },
  { href: '/settings', label: 'Settings', icon: Settings },
]

function NavItem({ item, active }) {
  const Icon = item.icon
  const className = cn(
    'group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium tracking-[-0.005em] transition-all duration-150',
    active
      ? 'bg-white/[0.06] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
      : 'text-muted-foreground/85 hover:bg-white/[0.035] hover:text-foreground'
  )
  const inner = (
    <>
      {active && (
        <span className="absolute -left-0.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_12px_rgba(139,92,246,0.9)]" />
      )}
      <Icon className={cn('h-[16px] w-[16px] shrink-0 transition-colors', active ? 'text-primary' : 'text-muted-foreground/55 group-hover:text-muted-foreground')} />
      <span className="truncate">{item.label}</span>
      {item.external && (
        <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/35 transition-colors group-hover:text-muted-foreground/70" />
      )}
    </>
  )

  if (item.external) {
    return (
      <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className={className}>
        {inner}
      </a>
    )
  }
  return (
    <Link
      key={item.label}
      href={item.href}
      aria-current={active ? 'page' : undefined}
      data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
      className={className}
    >
      {inner}
    </Link>
  )
}

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
        // Host agents have no Docker labels — every listed agent is a tmux
        // session started by this platform, so count the list as-is.
        const managed = (Array.isArray(list) ? list : []).filter(c => c.image === 'host' || c.labels?.['managed-by'] === 'ai-agent-platform')
        setAgents({
          running: managed.filter(c => c.status === 'running').length,
          total: managed.length,
        })
      })
      .catch(() => {})
  }, [pathname])

  const pct = agents.total ? Math.round((agents.running / agents.total) * 100) : 0

  return (
    <aside className="sticky top-0 flex h-screen w-[248px] min-w-[248px] flex-col border-r border-white/[0.06] bg-[#070b12]/90 backdrop-blur-xl">
      {/* Brand */}
      <div className="flex shrink-0 items-center gap-3 px-5 pb-5 pt-6">
        <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 via-primary to-indigo-600 text-white shadow-[0_10px_28px_-10px_rgba(139,92,246,0.85)]">
          <Bot className="h-[19px] w-[19px]" />
          <span className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-white/20" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold tracking-[-0.02em] text-white">AI Agent Platform</div>
          <div className="mt-0.5 truncate text-[10.5px] font-medium text-muted-foreground/55">ศูนย์บัญชาการทีม AI</div>
        </div>
      </div>

      <div className="hairline mx-auto w-[calc(100%-40px)] shrink-0" />

      {/* Scrollable middle — on short viewports the nav must scroll, not overflow the screen */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3">
        {/* Global inbox — need-human meeting alerts on every page */}
        <HumanInbox />

        <nav className="flex flex-col gap-0.5">
          <div className="section-label">Workspace</div>
          {MAIN.map(item => {
            const active = item.match
              ? pathname.startsWith(item.match)
              : pathname === item.href || (item.href === '/' && pathname.startsWith('/containers'))
            return <NavItem key={item.label} item={item} active={active} />
          })}

          <div className="section-label">Platform</div>
          {PLATFORM.map(item => (
            <NavItem key={item.label} item={item} active={!item.external && pathname === item.href} />
          ))}
        </nav>
      </div>

      {/* Live system state */}
      <div className="shrink-0 space-y-2 px-3 pb-4 pt-2">
        <div className="relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
          <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[11.5px] font-semibold text-foreground/90">
              <span className="relative flex h-2 w-2 shrink-0">
                {health && <span className="ping-soft absolute inset-0 rounded-full bg-emerald-400/60" />}
                <span className={cn('relative h-2 w-2 rounded-full', health ? 'bg-emerald-400' : 'bg-muted-foreground/45')} />
              </span>
              <span className="truncate">{health ? 'All Systems Operational' : 'Orchestrator Offline'}</span>
            </div>
            <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/35">live</span>
          </div>
          <div className="mt-2.5 flex items-center justify-between text-[10.5px] text-muted-foreground/60">
            <span><span className="font-semibold text-foreground/80">{agents.running}</span> / {agents.total} agents active</span>
            <span className="font-mono text-[10px] tabular-nums">{pct}%</span>
          </div>
          <Progress
            value={pct}
            className="mt-2 h-1 bg-white/[0.06]"
            indicatorClassName="bg-gradient-to-r from-emerald-400 to-cyan-400"
          />
        </div>

        {/* Account */}
        <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-[10.5px]">
              {session?.valid ? session.user.slice(0, 2).toUpperCase() : '?'}
            </AvatarFallback>
          </Avatar>
          {session?.valid ? (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold text-foreground/90">{session.user}</div>
                <div className="text-[10px] text-muted-foreground/50">Administrator</div>
              </div>
              <button
                className="rounded-md p-1.5 text-muted-foreground/50 transition-colors hover:bg-white/[0.06] hover:text-red-400"
                title="Log out"
                aria-label="Log out"
                onClick={async () => {
                  await authFetch(`${API}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: localStorage.getItem('aap_token') || '' }) })
                  localStorage.removeItem('aap_token')
                  localStorage.removeItem('aap_user')
                  window.location.href = '/login'
                }}
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </>
          ) : session?.auth_required ? (
            <a href="/login" className="flex items-center gap-1 text-[12px] font-semibold text-primary">Sign in <ArrowRight className="h-3.5 w-3.5" /></a>
          ) : (
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold text-foreground/90">Admin</div>
              <div className="text-[10px] text-muted-foreground/50">no auth required</div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
