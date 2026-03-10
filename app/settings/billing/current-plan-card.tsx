"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { CreditCard, Calendar, AlertTriangle } from "lucide-react"
import { cancelSubscription } from "@/app/actions/billing"
import { UpgradeModal } from "./upgrade-modal"

interface CurrentPlanCardProps {
  subscription: any
  tier: any
  tiers: any[]
  brokerageId: string
}

export function CurrentPlanCard({ subscription, tier, tiers, brokerageId }: CurrentPlanCardProps) {
  const [isAnnual, setIsAnnual] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false)

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

  const handleCancelSubscription = async () => {
    if (!subscription?.id) return
    setIsCancelling(true)
    try {
      await cancelSubscription(subscription.id)
    } catch (error) {
      console.error("Failed to cancel subscription:", error)
    } finally {
      setIsCancelling(false)
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
              <p className="text-sm text-muted-foreground">
                {tier?.max_agents === -1 ? "Unlimited" : tier?.max_agents} agent{tier?.max_agents !== 1 ? "s" : ""}
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
            
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="text-red-600 hover:text-red-700">
                  Cancel Subscription
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel Subscription?</AlertDialogTitle>
                  <AlertDialogDescription className="space-y-2">
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
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep Subscription</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleCancelSubscription}
                    disabled={isCancelling}
                    className="bg-red-600 hover:bg-red-700"
                  >
                    {isCancelling ? "Cancelling..." : "Yes, Cancel"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

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
