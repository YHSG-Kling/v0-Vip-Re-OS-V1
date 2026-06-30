"use client"

// HomeMaintenanceCard — seasonal + tenure-based upkeep suggestions for the
// homeowner, each tied to the vendor category that does the job. When their
// agent has a trusted pro in that category, the card surfaces a "request an
// intro" (requestVendorIntro -> agent); otherwise it points to the marketplace.
// Turns the lifetime portal into a year-round home concierge, not a dead page.

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Wrench, Loader2, CheckCircle2, ArrowRight } from "lucide-react"
import { requestVendorIntro } from "@/app/actions/portal-lifetime"
import { hasVendorFor, type MaintenanceSuggestion } from "@/lib/portal/home-maintenance"

const SEASON_LABEL: Record<string, string> = {
  spring: "Spring", summer: "Summer", fall: "Fall", winter: "Winter",
}

export function HomeMaintenanceCard({
  contactId,
  season,
  suggestions,
  availableVendorCategories,
}: {
  contactId: string
  season: string
  suggestions: MaintenanceSuggestion[]
  availableVendorCategories: string[]
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())

  async function intro(s: MaintenanceSuggestion) {
    setBusy(s.key)
    const res = await requestVendorIntro({ contactId, category: s.vendorCategory, reason: s.title })
    setBusy(null)
    if (res.ok) setDone((prev) => new Set(prev).add(s.key))
  }

  if (!suggestions || suggestions.length === 0) return null

  return (
    <Card className="shadow-lg border-0 md:col-span-2 lg:col-span-3">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wrench className="h-4 w-4 text-orange-600" />
          {SEASON_LABEL[season] ?? "Seasonal"} home care
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          A few things worth doing this season — your agent can connect you with a trusted local pro for any of them.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {suggestions.map((s) => {
            const haveVendor = hasVendorFor(s.vendorCategory, availableVendorCategories)
            const isDone = done.has(s.key)
            const label = s.vendorCategory.replace(/_/g, " ")
            return (
              <div key={s.key} className="rounded-lg border border-border p-3 flex flex-col">
                <p className="font-medium text-sm text-foreground">{s.title}</p>
                <p className="text-xs text-muted-foreground mt-1 flex-1">{s.why}</p>
                {isDone ? (
                  <p className="text-xs font-medium text-emerald-600 mt-2 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" />Your agent is connecting you
                  </p>
                ) : haveVendor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 w-full"
                    disabled={busy !== null}
                    onClick={() => void intro(s)}
                  >
                    {busy === s.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Request a {label} intro</>}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" className="mt-2 w-full justify-between" asChild>
                    <Link href={`/portal/${contactId}/resources`}>
                      Find a {label} pro
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
