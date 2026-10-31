// app/dashboard/vendors/bench-coverage-panel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// WHO ON THIS BENCH CAN ACTUALLY WORK WHERE WE WORK — the tenant-side half of
// the m551 coverage model.
//
// THE RULE, from the owner: a tenant's bench may only SURFACE a vendor where the
// vendor's coverage intersects the tenant's OWN service area, and unknown
// coverage means not bookable — never "bookable everywhere".
//
// WHY THIS SHOWS THE REFUSALS INSTEAD OF HIDING THEM. Filtering the unbookable
// rows out would make a bench that is blocked look identical to a bench that is
// thin, and the two have opposite fixes. Every row carries its verdict, so
// "this title company has not declared Arizona" and "you have not declared where
// YOU work" are different sentences a broker can act on.
//
// This is a SERVER component: the read is a server action gated on the session's
// own tenant (CLAUDE.md §4 — the brokerage comes from the session, never from a
// prop), and there is nothing here to interact with.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MapPinned } from "lucide-react"
import { listSurfaceableBenchAction } from "@/app/actions/vendor-service-areas"

export async function BenchCoveragePanel() {
  const r = await listSurfaceableBenchAction()

  if (!r.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPinned className="h-4 w-4" /> Bench coverage
          </CardTitle>
          <CardDescription>{r.error}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const bookable = r.rows.filter((x) => x.bookable)
  const blocked = r.rows.filter((x) => !x.bookable)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPinned className="h-4 w-4" /> Bench coverage
        </CardTitle>
        <CardDescription>
          Which of your vendors can be booked where you work. A vendor that has not declared a
          service area is <strong>not bookable</strong> — it is never assumed to cover everywhere.
          State-licensed trades (title, lender, attorney, insurance) additionally need a current
          licence for the state.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          {bookable.length} bookable · {blocked.length} blocked · {r.rows.length} on the bench
        </div>
        {r.rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No active vendors on the bench yet.</p>
        )}
        <div className="space-y-2">
          {blocked.map((row) => (
            <div key={row.vendor_id} className="rounded-md border p-2">
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="destructive">{row.reason}</Badge>
                <span className="font-medium">{row.vendor_name}</span>
                {row.category && <span className="text-muted-foreground">{row.category}</span>}
              </div>
              {row.message && (
                <p className="text-xs text-muted-foreground mt-1">{row.message}</p>
              )}
            </div>
          ))}
          {bookable.map((row) => (
            <div key={row.vendor_id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <Badge variant="default">{row.reason}</Badge>
              <span className="font-medium">{row.vendor_name}</span>
              {row.category && <span className="text-muted-foreground">{row.category}</span>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
