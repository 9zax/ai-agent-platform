import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      'flex h-9 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-1 text-[13px] text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] transition-all duration-150 file:border-0 file:bg-transparent file:text-[13px] file:font-medium placeholder:text-muted-foreground/50 hover:border-white/[0.16] focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    ref={ref}
    {...props}
  />
))
Input.displayName = 'Input'

export { Input }
