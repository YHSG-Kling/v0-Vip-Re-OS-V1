"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CreditCard, Calendar, AlertTriangle, BadgePercent, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  cancelSubscription,
  getCancellationSaveOfferAction,
  acceptCancellationSaveOfferAction,
} from "@/app/actions/billing"
import type { SaveOffer } from "@/lib/platform/save-offer"
import { formatSeatLimit, normalizeCatalogSeatLimit } from "@/lib/kernel/tier-role-matrix"
import { UpgradeModal } from "./upgrade-modal"

interface CurrentPlanCardProps {
  subscription: any
  tier: any
  tiers: any[]
  brokerageId: string
}

const fmtCents = (c: number) =>
  `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: c % 100 === 0 ? 0 : 2 })}`

export function CurrentPlanCard({ subscription, tier, tiers, brokerageId }: CurrentPlanCardProps) {
  const [isAnnual, setIsAnnual] = useState(false)
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false)
  const { toast } = useToast()

  // Cancellation flow: loading offer → (offer | confirm) → done.
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelStep, setCancelStep] = useState<"loading" | "offer" | "confirm">("loading")
  const [saveOffer, setSaveOffer] = useState<SaveOffer | null>(null)
  const [busy, setBusy] = useState(false)

  const status = subscription?.status || "inactive"
  const renewalDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString()
    : "N/A"

  const monthlyPrice = tier?.monthly_price_cents
    ? `$${(tier.monthly_price_cents / 100).toFixed(2)}`
    : "N/A"
  const annualPrice = tier?.annual_price_cents
    ? `$${(tier.annual_price_cents / 100).toFixed(2)}`
    : "N/A"

  const annualSavings = tier?.monthly_price_cents && tier?.annual_price_cents
    ? Math.round(100 - (tier.annual_price_cents / (tier.monthly_price_cents * 12)) * 100)
    : 0

  // Open the cancel flow — check for a retention offer BEFORE showing confirm.
  const startCancelFlow = async () => {
    setCancelOpen(true)
    setCancelStep("loading")
    setSaveOffer(null)
    try {
      const res = await getCancellationSaveOfferAction()
      if (res.ok && res.offer) {
        setSaveOffer(res.offer)
        setCancelStep("offer")
      } else {
        setCancelStep("confirm") // no offer configured / ineligible — straight to confirm
      }
    } catch {
      setCancelStep("confirm")
    }
  }

  const handleAcceptOffer = async () => {
    setBusy(true)
    try {
      const res = await acceptCancellationSaveOfferAction()
      if (res.ok) {
        toast({ title: "Offer applied — glad you're staying", description: `Your discount: ${res.summary}. It will show on your next invoice.` })
        setCancelOpen(false)
      } else {
        toast({ title: "Could not apply the offer", description: res.error, variant: "destructive" })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleCancelSubscription = async () => {
    if (!subscription?.id) return
    setBusy(true)
    try {
      await cancelSubscription(subscription.id)
      toast({ title: "Cancellation scheduled", description: `Your subscription remains active until ${renewalDate}.` })
      setCancelOpen(false)
    } catch (error: any) {
      toast({ title: "Cancellation failed", description: error?.message ?? "Please try again.", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-green-100 text-green-800">Active</Badge>
      case "trialing":
        return <Badge className="bg-blue-100 text-blue-800">Trial</Badge>
      case "past_due":
        return <Badge className="bg-red-100 text-red-800">Past Due</Badge>
      case "cancelled":
        return <Badge className="bg-gray-100 text-gray-800">Cancelled</Badge>
      default:
        return <Badge variant="outline">Inactive</Badge>
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Current Plan
              </CardTitle>
              <CardDescription>Your active subscription and billing cycle</CardDescription>
            </div>
            {getStatusBadge(status)}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
            <div>
              <p className="text-2xl font-bold">{tier?.display_name || "No Plan"}</p>
              {/* Unlimited is spelled NULL in subscription_tiers.max_agents (what
                  the live multi_location row holds) and -1 in the older
                  plan_limits convention. Testing only for -1 rendered the
                  UNLIMITED plan as "null agents". One fold, shared with the
                  seat gate — lib/kernel/tier-role-matrix.ts. */}
              <p className="text-sm text-muted-foreground">
                {formatSeatLimit(tier?.max_agents)} seat{normalizeCatalogSeatLimit(tier?.max_agents) === 1 ? "" : "s"}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xl font-semibold">
                {isAnnual ? annualPrice : monthlyPrice}
                <span className="text-sm font-normal text-muted-foreground">
                  /{isAnnual ? "year" : "month"}
                </span>
              </p>
              {annualSavings > 0 && isAnnual && (
                <p className="text-xs text-green-600">Save {annualSavings}% annually</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label htmlFor="billing-cycle">Billing Cycle</Label>
            </div>
            <div className="flex items-center gap-2">
              <span className={!isAnnual ? "font-medium" : "text-muted-foreground"}>Monthly</span>
              <Switch
                id="billing-cycle"
                checked={isAnnual}
                onCheckedChange={setIsAnnual}
              />
              <span className={isAnnual ? "font-medium" : "text-muted-foreground"}>Annual</span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Calendar className="h-4 w-4" />
            <span>Renewal Date: {renewalDate}</span>
          </div>

          {subscription?.cancel_at && (
            <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
              <AlertTriangle className="h-4 w-4" />
              <span>
                Your subscription will end on {new Date(subscription.cancel_at).toLocaleDateString()}
              </span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button onClick={() => setUpgradeModalOpen(true)}>
              Upgrade Plan
            </Button>

            <Button
              variant="outline"
              className="text-red-600 hover:text-red-700"
              onClick={startCancelFlow}
              disabled={!subscription?.id}
            >
              Cancel Subscription
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Cancellation flow — save-offer first (when configured), then confirm */}
      <Dialog open={cancelOpen} onOpenChange={(open) => { if (!busy) setCancelOpen(open) }}>
        <DialogContent className="max-w-md">
          {cancelStep === "loading" && (
            <>
              <DialogHeader>
                <DialogTitle>One moment…</DialogTitle>
                <DialogDescription>Checking your account before cancelling.</DialogDescription>
              </DialogHeader>
              <div className="flex justify-center py-6">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            </>
          )}

          {cancelStep === "offer" && saveOffer && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <BadgePercent className="h-5 w-5 text-emerald-600" />
                  {saveOffer.headline}
                </DialogTitle>
                <DialogDescription>
                  Accept the offer below and keep your AI team working — or continue to cancellation.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 space-y-1">
                <p className="text-lg font-semibold text-emerald-800">{saveOffer.summary}</p>
                {saveOffer.currentMonthlyCents > 0 && (
                  <p className="text-sm text-emerald-800">
                    {fmtCents(saveOffer.discountedMonthlyCents)}/month instead of {fmtCents(saveOffer.currentMonthlyCents)}
                    {saveOffer.appliesForMonths != null
                      ? ` for ${saveOffer.appliesForMonths} month${saveOffer.appliesForMonths === 1 ? "" : "s"}`
                      : " for as long as you stay"}
                    {" — "}saving {fmtCents(saveOffer.savingsPerMonthCents)}/month.
                  </p>
                )}
                <p className="text-xs text-emerald-700">Applied to your subscription — the discount appears on your Stripe invoice.</p>
              </div>
              <div className="flex flex-col gap-2 pt-2">
                <Button onClick={handleAcceptOffer} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700">
                  {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Accept offer &amp; stay
                </Button>
                <Button variant="ghost" className="text-red-600" disabled={busy} onClick={() => setCancelStep("confirm")}>
                  No thanks — continue to cancel
                </Button>
              </div>
            </>
          )}

          {cancelStep === "confirm" && (
            <>
              <DialogHeader>
                <DialogTitle>Cancel Subscription?</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-2">
                    <p>Are you sure you want to cancel your subscription? This will:</p>
                    <ul className="list-disc list-inside space-y-1 text-sm">
                      <li>Remove access to premium features at period end</li>
                      <li>Limit your agent count to the free tier</li>
                      <li>Disable AI-powered features</li>
                      <li>Archive data beyond retention limits</li>
                    </ul>
                    <p className="font-medium pt-2">
                      Your subscription will remain active until {renewalDate}.
                    </p>
                  </div>
                </DialogDescription>
              </DialogHeader>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" disabled={busy} onClick={() => setCancelOpen(false)}>
                  Keep Subscription
                </Button>
                <Button
                  onClick={handleCancelSubscription}
                  disabled={busy}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {busy ? "Cancelling…" : "Yes, Cancel"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
        tiers={tiers}
        currentTierId={tier?.id}
        brokerageId={brokerageId}
        isAnnual={isAnnual}
      />
    </>
  )
}
