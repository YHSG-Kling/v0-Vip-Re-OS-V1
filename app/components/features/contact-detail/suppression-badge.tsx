// app/components/features/contact-detail/suppression-badge.tsx
// UI COMPONENT: Display contact suppression status with reasons
// Non-blocking component — shows status but doesn't gate UI rendering

"use client"

import { Badge } from "@/app/components/ui/badge"
import { AlertCircle, CheckCircle, Info } from "lucide-react"
import { getSuppressionReasons, type ContactData } from "@/lib/kernel/communication-compliance-helpers"

interface SuppressionBadgeProps {
  contact: ContactData
  compact?: boolean
}

export function SuppressionBadge({ contact, compact = false }: SuppressionBadgeProps) {
  const suppressionReasons = getSuppressionReasons(contact)
  const isSuppressed = suppressionReasons.length > 0

  if (!isSuppressed) {
    return (
      <div className="flex items-center gap-2">
        <CheckCircle className="h-4 w-4 text-green-600" />
        <span className="text-sm text-green-600">Eligible for outbound</span>
      </div>
    )
  }

  if (compact) {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="h-3 w-3" />
        Suppressed ({suppressionReasons.length})
      </Badge>
    )
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="font-medium text-amber-900">Suppression Active</h4>
          <p className="text-sm text-amber-800 mt-1">
            This contact cannot receive outbound communications for the following reasons:
          </p>
          <ul className="mt-2 space-y-1">
            {suppressionReasons.map((reason, idx) => (
              <li key={idx} className="text-sm text-amber-800 flex items-start gap-2">
                <span className="text-amber-600 font-bold">•</span>
                {reason}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// QUICK SUPPRESSION STATUS (minimal)
// ─────────────────────────────────────────────────────────────────────────────

export function QuickSuppressionStatus({ contact }: { contact: ContactData }) {
  const suppressionReasons = getSuppressionReasons(contact)

  if (suppressionReasons.length === 0) {
    return null
  }

  return (
    <div className="text-xs font-medium text-red-600 flex items-center gap-1">
      <AlertCircle className="h-3 w-3" />
      Suppressed: {suppressionReasons[0]}
    </div>
  )
}
