import * as React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        running: 'border-transparent bg-emerald-500/15 text-emerald-400',
        busy: 'border-transparent bg-amber-500/15 text-amber-400',
        stopped: 'border-transparent bg-slate-500/20 text-slate-400',
        created: 'border-transparent bg-blue-500/15 text-blue-400',
        restarting: 'border-transparent bg-amber-500/15 text-amber-400',
        paused: 'border-transparent bg-cyan-500/15 text-cyan-400',
        dead: 'border-transparent bg-red-500/15 text-red-400',
        purple: 'border-transparent bg-violet-500/15 text-violet-400',
        blue: 'border-transparent bg-blue-500/15 text-blue-400',
        cyan: 'border-transparent bg-cyan-500/15 text-cyan-300',
        green: 'border-transparent bg-emerald-500/15 text-emerald-400',
        yellow: 'border-transparent bg-amber-500/15 text-amber-400',
        pink: 'border-transparent bg-pink-500/15 text-pink-400',
        gray: 'border-transparent bg-slate-500/20 text-slate-400',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
