import { cn } from '@/lib/utils'

// Shared page header — one rhythm for every screen: title, one-line intent,
// and a right-aligned action cluster.
export default function PageHeader({ icon: Icon, title, subtitle, actions, leading, className, children }) {
  return (
    <header className={cn('page-header', className)}>
      <div className="flex min-w-0 items-center gap-3.5">
        {leading}
        {Icon && (
          <div className="icon-tile">
            <Icon className="h-[18px] w-[18px]" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
      </div>
      {(actions || children) && (
        <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
          {actions}
          {children}
        </div>
      )}
    </header>
  )
}
