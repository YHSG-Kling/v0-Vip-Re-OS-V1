"use client"

import { Card, CardContent } from "@/components/ui/card"

// Same-body census, round 4 (2026-09-09, lane FC). Survivor for the
// byte-identical-in-effect private `StatCard`/`SummaryCard` icon-value-label
// tile in app/dashboard/admin/locations/locations-client.tsx:173 and
// app/dashboard/admin/manager-trust/manager-trust-client.tsx:973. `value` is
// typed as the superset `string | number` (manager-trust's copy passed
// strings) so both callers keep their existing call shape.

export function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string | number
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className="h-7 w-7 text-muted-foreground" />
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}
