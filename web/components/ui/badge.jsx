import * as React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold leading-5 tracking-[0.01em] ring-1 ring-inset transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary/15 text-primary ring-primary/25',
        secondary: 'bg-secondary text-secondary-foreground ring-white/[0.06]',
        destructive: 'bg-destructive/15 text-red-300 ring-red-400/25',
        outline: 'text-foreground/80 ring-white/[0.12]',
        running: 'bg-emerald-500/[0.12] text-emerald-300 ring-emerald-400/25',
        busy: 'bg-amber-500/[0.12] text-amber-300 ring-amber-400/25',
        stopped: 'bg-slate-500/[0.14] text-slate-400 ring-slate-400/20',
        created: 'bg-blue-500/[0.12] text-blue-300 ring-blue-400/25',
        restarting: 'bg-amber-500/[0.12] text-amber-300 ring-amber-400/25',
        paused: 'bg-cyan-500/[0.12] text-cyan-300 ring-cyan-400/25',
        dead: 'bg-red-500/[0.12] text-red-300 ring-red-400/25',
        purple: 'bg-violet-500/[0.12] text-violet-300 ring-violet-400/25',
        blue: 'bg-blue-500/[0.12] text-blue-300 ring-blue-400/25',
        cyan: 'bg-cyan-500/[0.12] text-cyan-300 ring-cyan-400/25',
        green: 'bg-emerald-500/[0.12] text-emerald-300 ring-emerald-400/25',
        yellow: 'bg-amber-500/[0.12] text-amber-300 ring-amber-400/25',
        pink: 'bg-pink-500/[0.12] text-pink-300 ring-pink-400/25',
        gray: 'bg-white/[0.05] text-muted-foreground ring-white/[0.08]',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
