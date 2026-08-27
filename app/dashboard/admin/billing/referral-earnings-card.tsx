"use client"

// Referral earnings — the RECIPIENT half of subscriber-referral payouts.
// Renders the payouts POSTED to this tenant (referral_payouts, m573 — this
// brokerage resolved as the referrer at post time) and lets a billing admin
// acknowledge receipt (posted → received; counted server-side, scoped to the
// SESSION tenant). Rendered only for the tenant's own billing admins — the
// page passes server-fetched rows, so an empty ledger renders nothing loud.

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { HandCoins } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  getReferralEarningsAction,
  acknowledgeReferralPayoutAction,
} from "@/app/actions/admin/referral-earnings"
import type { ReferralEarningRow } from "@/lib/platform/referral-payouts"

const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function ReferralEarningsCard({ initialRows }: { initialRows: ReferralEarningRow[] }) {
  const [rows, setRows] = useState(initialRows)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  const postedCents = rows.reduce((s, r) => s + r.amountCents, 0)
  const receivedCents = rows.filter((r) => r.status === "received").reduce((s, r) => s + r.amountCents, 0)

  function acknowledge(payoutId: string) {
    startTransition(async () => {
      const r = await acknowledgeReferralPayoutAction({ payoutId })
      if (r.ok) {
        toast({ title: "Receipt confirmed" })
        const fresh = await getReferralEarningsAction()
        if (fresh.ok) setRows(fresh.rows)
      } else {
        toast({ title: "Error", description: r.error, variant: "destructive" })
      }
    })
  }

  if (rows.length === 0) return null

  return (
    <Card id="referral-earnings">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <HandCoins className="h-4 w-4 text-primary" />
          Referral earnings
          <span className="text-xs font-normal text-muted-foreground">
            {fmt(postedCents)} posted · {fmt(receivedCents)} confirmed received
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Fees the platform owes your brokerage for subscribers you referred. Confirm each payout once it reaches you.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Period</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Posted</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-3 py-2 tabular-nums">{r.period}</td>
                  {/* The basis this payout was computed under (m576) — a percent-era
                      row (basis null) renders no chip rather than guessing. */}
                  <td className="px-3 py-2 text-right tabular-nums font-medium">
                    {fmt(r.amountCents)}
                    {r.basis && (
                      <span className="ml-1 text-[10px] uppercase text-muted-foreground">{r.basis}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(r.postedAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <Badge variant={r.status === "received" ? "default" : "outline"} className="text-[11px] capitalize">
                      {r.status}
                    </Badge>
                    {r.status === "received" && r.receivedAt && (
                      <span className="block text-[11px] text-muted-foreground">
                        confirmed {new Date(r.receivedAt).toLocaleDateString()}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.status === "posted" && (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => acknowledge(r.id)}>
                        Confirm received
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
