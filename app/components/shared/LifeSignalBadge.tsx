'use client'

import { formatDistanceToNow } from 'date-fns'

interface LifeSignalBadgeProps {
  signal: {
    id: string
    change_type: string
    detected_at: string
    contacts: {
      id: string
      first_name: string
      last_name: string
    } | null
  }
  compact?: boolean
}

export function LifeSignalBadge({ signal, compact = false }: LifeSignalBadgeProps) {
  const relativeTime = formatDistanceToNow(new Date(signal.detected_at), { addSuffix: true })

  const humanReadableChangeType = signal.change_type
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <div className="h-2 w-2 rounded-full bg-amber-500" />
        <span>
          {signal.contacts?.first_name} {signal.contacts?.last_name}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 p-3 border rounded-lg bg-background">
      <div className="h-3 w-3 rounded-full bg-amber-500 mt-1 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">
          {signal.contacts?.first_name} {signal.contacts?.last_name}
        </p>
        <p className="text-sm text-muted-foreground">{humanReadableChangeType}</p>
        <p className="text-xs text-muted-foreground mt-1">{relativeTime}</p>
        <p className="text-xs text-muted-foreground mt-2 italic">A thoughtful check-in may be timely</p>
      </div>
    </div>
  )
}
