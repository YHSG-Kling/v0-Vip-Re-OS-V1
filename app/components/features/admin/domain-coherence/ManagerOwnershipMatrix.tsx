'use client'

import { validateCanonicalManagerUsage } from '@/lib/kernel/routes'
import { CheckCircle2, XCircle } from 'lucide-react'

const KERNEL_MODULES = [
  'lib/kernel/portal.ts',
  'lib/kernel/billing.ts',
  'lib/kernel/vendors.ts',
  'lib/kernel/education.ts',
  'lib/kernel/video.ts',
  'lib/kernel/lead-magnets.ts',
  'lib/kernel/communication-compliance.ts',
  'lib/kernel/forms.ts',
  'lib/kernel/routes.ts',
  'lib/kernel/transactions.ts',
  'lib/kernel/listings.ts',
  'lib/kernel/crm.ts',
  'lib/kernel/marketing.ts',
  'lib/kernel/reporting.ts',
  'lib/kernel/financial.ts',
  'lib/kernel/reputation.ts',
  'lib/kernel/ai-tools.ts',
  'lib/kernel/ai-isa.ts',
]

export function ManagerOwnershipMatrix() {
  const { modules, verified, unverified } = validateCanonicalManagerUsage({ kernelModules: KERNEL_MODULES })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-sm">
        <span className="flex items-center gap-1.5 text-green-600 font-medium">
          <CheckCircle2 className="h-4 w-4" />
          {verified} verified
        </span>
        <span className="flex items-center gap-1.5 text-amber-600 font-medium">
          <XCircle className="h-4 w-4" />
          {unverified} unverified
        </span>
      </div>

      <div className="grid gap-2">
        {modules.map((m) => (
          <div
            key={m.module}
            className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
              m.status === 'verified'
                ? 'border-green-200 bg-green-50'
                : 'border-amber-200 bg-amber-50'
            }`}
          >
            <span className="font-mono text-sm">{m.module}</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {m.canonicalRouteCount} canonical {m.canonicalRouteCount === 1 ? 'route' : 'routes'}
              </span>
              {m.status === 'verified'
                ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                : <XCircle className="h-4 w-4 text-amber-600" />
              }
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
