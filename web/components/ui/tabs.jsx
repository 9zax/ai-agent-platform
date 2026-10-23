'use client'

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('inline-flex h-9 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.025] p-1 text-muted-foreground', className)}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-white/[0.07] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60', className)}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
