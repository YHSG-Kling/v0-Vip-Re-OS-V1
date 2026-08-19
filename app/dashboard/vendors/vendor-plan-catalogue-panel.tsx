"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Layers } from "lucide-react"
import {
  listVendorPlanCatalogueAction,
  subscribeToVendorPlanAction,
  cancelVendorPlanSubscriptionAction,
  type VendorPlanCatalogueEntry,
} from "@/app/actions/vendors/vendor-plan-subscriptions"

/**
 * The brokerage side of the vendor plan catalogue: the ACTIVE plans marketplace vendors have
 * published (/vendor/plans), and which of them this brokerage is on.
 *
 * Honest about what a subscription here is — an entitlement record, not a card charge. Nothing on
 * this panel takes payment, and it says so instead of implying one.
 */
export function VendorPlanCataloguePanel() {
  const [entries, setEntries] = useState<VendorPlanCatalogueEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function load() {
    const res = await listVendorPlanCatalogueAction()
    if (res.ok) { setEntries(res.entries); setError(null) }
    else { setEntries([]); setError(res.error) }
  }

  useEffect(() => { void load() }, [])

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? "That did not work.")
      await load()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5" /> Vendor plans
        </CardTitle>
        <CardDescription>
          Plans published by marketplace vendors. Subscribing records which plan your brokerage is on
          and starts its credit period — it does not charge a card. What you owe a vendor is invoiced
          through the vendor billing lane.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}
        {entries === null && <p className="text-sm text-muted-foreground">Loading vendor plans…</p>}
        {entries !== null && entries.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">
            No marketplace vendor has published a plan yet — there is nothing to subscribe to.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {(entries ?? []).map((e) => (
            <Card key={e.plan_id} className={e.subscription?.status === "active" ? "border-primary" : ""}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <span className="truncate">{e.name}</span>
                  {e.subscription?.status === "active" && (
                    <Badge variant="secondary" className="text-[10px] shrink-0">Subscribed</Badge>
                  )}
                </CardTitle>
                <p className="text-xs text-muted-foreground truncate">{e.vendor_name ?? "Unnamed vendor"}</p>
                <div className="text-2xl font-bold">
                  ${e.price_per_month.toFixed(2)}
                  <span className="text-sm font-normal text-muted-foreground">
                    /{e.billing_cycle === "annual" ? "yr" : "mo"}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                {e.description && <p className="text-muted-foreground">{e.description}</p>}
                <div className="text-muted-foreground">
                  {e.price_per_credit !== null ? `$${e.price_per_credit.toFixed(2)} per credit · ` : ""}
                  {e.max_credits_per_month === null ? "Unlimited credits" : `${e.max_credits_per_month} credits/mo`}
                  {e.trial_days > 0 ? ` · ${e.trial_days}-day trial` : ""}
                </div>
                {e.subscription && (
                  <div className="text-muted-foreground">
                    {e.subscription.credits_used_this_period} credits used this period · renews{" "}
                    {new Date(e.subscription.current_period_end).toLocaleDateString()}
                  </div>
                )}
                <div className="pt-2">
                  {e.subscription?.status === "active" ? (
                    <Button size="sm" variant="outline" disabled={pending}
                      onClick={() => act(() => cancelVendorPlanSubscriptionAction({ subscriptionId: e.subscription!.id }))}>
                      Cancel
                    </Button>
                  ) : (
                    <Button size="sm" disabled={pending}
                      onClick={() => act(() => subscribeToVendorPlanAction({ planId: e.plan_id }))}>
                      {e.subscription ? "Resume" : "Subscribe"}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
