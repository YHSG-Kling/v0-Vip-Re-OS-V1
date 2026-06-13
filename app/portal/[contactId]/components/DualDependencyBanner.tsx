// app/portal/[contactId]/components/DualDependencyBanner.tsx
//
// The cross-journey DEPENDENCY BANNER for the dual-journey portal. When a "must
// sell to buy" contact's purchase is contingent on selling their current home
// (the sale funds the purchase), this banner sits at the TOP of the tabbed portal
// so the dependency is visible on BOTH tabs. It renders the plain-language
// explanation the dual-intent linker already stamped on the journey_states rows —
// nothing is recomputed or fabricated here. Server-safe (no client hooks).

import { AlertTriangle, ArrowRight } from 'lucide-react'
import type { SaleBeforeBuyDependency } from '@/lib/kernel/dual-intent-linker'

interface DualDependencyBannerProps {
  dependency: SaleBeforeBuyDependency
}

export function DualDependencyBanner({ dependency }: DualDependencyBannerProps) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-start gap-3">
      <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-amber-900">
          Your purchase is contingent on selling your current home
        </p>
        <p className="text-sm text-amber-800 leading-relaxed mt-0.5">
          {dependency.explanation}
        </p>
        <p className="text-xs text-amber-700 mt-2 flex items-center gap-1.5">
          Here's where your sale stands
          <ArrowRight className="h-3.5 w-3.5" />
          open the <span className="font-medium">Sell</span> tab for the latest on your listing.
        </p>
      </div>
    </div>
  )
}
