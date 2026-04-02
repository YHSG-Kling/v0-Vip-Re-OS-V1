'use client'

import { useState } from 'react'
import { enumerateDomainRoutes, normalizeNavigationVisibility } from '@/lib/kernel/routes'
import type { NormalizeNavInput } from '@/lib/kernel/routes'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, EyeOff } from 'lucide-react'

type UserType = NormalizeNavInput['userType']

const USER_TYPES: { value: UserType; label: string }[] = [
  { value: 'public',        label: 'Public' },
  { value: 'authenticated', label: 'Authenticated' },
  { value: 'agent',         label: 'Agent' },
  { value: 'broker',        label: 'Broker' },
  { value: 'superadmin',    label: 'Superadmin' },
]

export function NavigationNormalizationPanel() {
  const [selectedType, setSelectedType] = useState<UserType>('agent')

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const { visible, hidden } = normalizeNavigationVisibility({ userType: selectedType, routes })

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Simulate user type</p>
        <div className="flex flex-wrap gap-2">
          {USER_TYPES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setSelectedType(value)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedType === value
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <span className="text-sm font-medium text-green-700">Visible ({visible.length})</span>
          </div>
          <div className="space-y-1.5 rounded-lg border p-3">
            {visible.length === 0 && (
              <p className="text-xs text-muted-foreground py-2 text-center">No routes visible for this role.</p>
            )}
            {visible.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted/50">
                <span className="font-mono text-xs">{r.path}</span>
                <span className="text-[10px] text-muted-foreground">{r.domain}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <EyeOff className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Hidden ({hidden.length})</span>
          </div>
          <div className="space-y-1.5 rounded-lg border p-3 bg-muted/20">
            {hidden.length === 0 && (
              <p className="text-xs text-muted-foreground py-2 text-center">All routes are visible.</p>
            )}
            {hidden.slice(0, 15).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded px-2 py-1.5">
                <span className="font-mono text-xs text-muted-foreground">{r.path}</span>
                <Badge variant="outline" className="text-[10px]">{r.classification}</Badge>
              </div>
            ))}
            {hidden.length > 15 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{hidden.length - 15} more hidden
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
