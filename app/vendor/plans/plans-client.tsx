"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowRight } from "lucide-react"
import type { VendorPackageChargeRow } from "@/app/actions/vendors/vendor-plan-subscriptions"

/* TOMBSTONE — `VendorPlansClient` was RENAMED to `VendorPackageChargesClient`
 * (below, :34), not removed. The orphan-export census reports it
 * as capability removed because its move-detection requires a new home in a
 * DIFFERENT file, and a rename inside one file is indistinguishable from a
 * deletion from the outside.
 *
 * The old name described a vendor EDITING ITS OWN PLANS — the inverted direction
 * m497 corrected. The component is now what the corrected direction actually
 * supports, and the name says so. */

/**
 * THE PAYER'S READ-ONLY VIEW of vendor package charges.
 *
 * This component used to be a plan EDITOR — a vendor authoring prices that
 * brokerages paid monthly. That direction does not exist (see the page header
 * and lib/vendors/vendor-money-directions.ts): a vendor package is the brokerage
 * charging the vendor. There is deliberately no create, edit, archive, default
 * or cancel control here, because the payer does not write its own bill — the
 * live write RLS on vendor_subscriptions is brokerage-finance-admin only, and a
 * button that would always be refused is worse than no button.
 *
 * Every amount on this card is money the VENDOR OWES. The direction is rendered
 * from the shared constant rather than re-typed, so a screen can never say the
 * opposite of what the writer does — which is the failure this whole pass
 * corrects.
 */
export function VendorPackageChargesClient({
  charges,
  direction,
}: {
  charges: VendorPackageChargeRow[]
  direction: string
}) {
  if (charges.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No package charges</CardTitle>
          <CardDescription>
            No brokerage is charging you for a marketplace package right now. If one enrols you, the
            package and its price appear here.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <ArrowRight className="h-3 w-3" />
        <span className="uppercase tracking-wide">{direction}</span>
      </p>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {charges.map((c) => {
          const active = c.status === "active"
          return (
            <Card key={c.subscription_id} className={active ? "border-primary" : "opacity-70"}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <span className="truncate">{c.plan_name}</span>
                  <Badge variant={active ? "secondary" : "outline"} className="text-[10px] shrink-0">
                    {active ? "Being charged" : c.status}
                  </Badge>
                </CardTitle>
                <div className="text-2xl font-bold">
                  ${c.price_per_month.toFixed(2)}
                  <span className="text-sm font-normal text-muted-foreground">
                    /{c.billing_cycle === "annual" ? "yr" : "mo"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">You pay the brokerage this amount.</p>
                {/* §1.2 — canceled_at. "Canceled" with no date could not be
                    checked against a charge; now it can. */}
                {!active && c.canceled_at && (
                  <p className="text-xs text-muted-foreground">
                    Ended {new Date(c.canceled_at).toLocaleDateString()} — no charge after this date.
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <div>
                  {c.credits_used_this_period} of{" "}
                  {c.max_credits_per_month === null ? "unlimited" : c.max_credits_per_month} credits used
                  this period
                  {c.price_per_credit !== null
                    ? ` · $${c.price_per_credit.toFixed(2)} per credit beyond that`
                    : ""}
                </div>
                <div>
                  Period {new Date(c.current_period_start).toLocaleDateString()} –{" "}
                  {new Date(c.current_period_end).toLocaleDateString()}
                </div>
                <div className="pt-1 text-[11px]">
                  Charged through the brokerage&apos;s vendor billing — not a card charge taken here.
                  To change or end this package, ask the brokerage.
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
