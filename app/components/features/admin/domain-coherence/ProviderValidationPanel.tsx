'use client'

import { validateProviderBackedFeatures } from '@/lib/kernel/routes'
import { CheckCircle2, XCircle } from 'lucide-react'

const PROVIDER_DOMAINS = [
  'portal', 'billing', 'vendors', 'education', 'video',
  'lead_magnets', 'compliance', 'forms', 'transactions', 'listings',
  'communications', 'admin_tools', 'documents', 'support',
]

export function ProviderValidationPanel() {
  const { results } = validateProviderBackedFeatures({ domains: PROVIDER_DOMAINS })

  const covered = results.filter((r) => r.hasCanonicalRoute)
  const missing = results.filter((r) => !r.hasCanonicalRoute)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-sm">
        <span className="flex items-center gap-1.5 text-green-600 font-medium">
          <CheckCircle2 className="h-4 w-4" />
          {covered.length} covered
        </span>
        <span className="flex items-center gap-1.5 text-red-600 font-medium">
          <XCircle className="h-4 w-4" />
          {missing.length} missing canonical route
        </span>
      </div>

      <div className="grid gap-2">
        {results.map((r) => (
          <div
            key={r.domain}
            className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
              r.hasCanonicalRoute
                ? 'border-green-200 bg-green-50'
                : 'border-red-200 bg-red-50'
            }`}
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium capitalize">{r.domain.replace(/_/g, ' ')}</span>
              {r.kernelOwner && (
                <span className="font-mono text-xs text-muted-foreground">{r.kernelOwner}</span>
              )}
            </div>
            {r.hasCanonicalRoute
              ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
              : <XCircle className="h-4 w-4 text-red-600 shrink-0" />
            }
          </div>
        ))}
      </div>
    </div>
  )
}
