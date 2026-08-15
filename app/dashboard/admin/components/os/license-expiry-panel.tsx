"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShieldAlert, ShieldCheck, AlertTriangle, ChevronRight } from "lucide-react"
import Link from "next/link"
import type { AgentLicenseStatus } from "@/app/actions/admin/license-tracking"

const EXPIRY_FILTERS = ["30d", "60d", "90d", "all"] as const
type ExpiryFilter = (typeof EXPIRY_FILTERS)[number]

interface Props {
  agents: AgentLicenseStatus[]
}

function statusBadge(days: number | null) {
  if (days === null) return <Badge variant="outline" className="text-xs">No date</Badge>
  if (days < 0) return <Badge variant="destructive" className="text-xs">Expired</Badge>
  if (days <= 30) return <Badge className="text-xs bg-red-500 hover:bg-red-500">Expires in {days}d</Badge>
  if (days <= 60) return <Badge className="text-xs bg-orange-500 hover:bg-orange-500">Expires in {days}d</Badge>
  if (days <= 90) return <Badge className="text-xs bg-amber-500 hover:bg-amber-500">Expires in {days}d</Badge>
  return <Badge className="text-xs bg-emerald-500 hover:bg-emerald-500">{days}d remaining</Badge>
}

export function LicenseExpiryPanel({ agents }: Props) {
  const [filter, setFilter] = useState<ExpiryFilter>("90d")

  const filtered = agents.filter((a) => {
    if (filter === "all") return true
    const days = parseInt(filter)
    return a.daysUntilExpiry !== null && a.daysUntilExpiry <= days
  })

  const expiredCount = agents.filter((a) => a.daysUntilExpiry !== null && a.daysUntilExpiry < 0).length
  const criticalCount = agents.filter((a) => a.daysUntilExpiry !== null && a.daysUntilExpiry >= 0 && a.daysUntilExpiry <= 30).length
  const warningCount = agents.filter((a) => a.daysUntilExpiry !== null && a.daysUntilExpiry > 30 && a.daysUntilExpiry <= 90).length

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            License Expiry Tracking
          </CardTitle>
          <Link href="/dashboard/admin/license-tracking" className="text-xs text-primary hover:underline flex items-center gap-0.5">
            View all <ChevronRight className="h-3 w-3" />
          </Link>
        </div>

        {/* Summary strip */}
        <div className="flex gap-4 text-xs mt-2">
          {expiredCount > 0 && (
            <span className="text-red-600 font-semibold">{expiredCount} expired</span>
          )}
          {criticalCount > 0 && (
            <span className="text-orange-600 font-semibold">{criticalCount} within 30 days</span>
          )}
          {warningCount > 0 && (
            <span className="text-amber-600">{warningCount} within 90 days</span>
          )}
          {expiredCount === 0 && criticalCount === 0 && warningCount === 0 && (
            <span className="text-emerald-600 flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" /> All licenses on track
            </span>
          )}
        </div>

        {/* Filter pills */}
        <div className="flex gap-1.5 flex-wrap mt-2">
          {EXPIRY_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                filter === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-muted-foreground/30 hover:border-primary/50"
              }`}
            >
              {f === "all" ? "All agents" : `Within ${f}`}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No agents match this filter.
          </p>
        ) : (
          <div className="space-y-2">
            {filtered.slice(0, 10).map((a) => (
              <div
                key={a.userId}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{a.fullName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.licenseState ? `${a.licenseState} ` : ""}
                    {a.licenseNumber ?? "No license # on file"}
                    {a.expiryDate ? ` · Expires ${new Date(a.expiryDate).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <div className="shrink-0">
                  {statusBadge(a.daysUntilExpiry)}
                </div>
              </div>
            ))}
            {filtered.length > 10 && (
              <p className="text-xs text-center text-muted-foreground pt-1">
                +{filtered.length - 10} more agents
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
