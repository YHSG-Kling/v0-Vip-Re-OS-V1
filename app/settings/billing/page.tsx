import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import {
  getSubscriptionTiers,
  getCurrentSubscription,
  getBillingUsage,
  getInvoiceHistory,
} from "@/app/actions/billing"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { CreditCard, FileText, AlertTriangle, Users, Cpu, HardDrive, Video } from "lucide-react"
import { CurrentPlanCard } from "./current-plan-card"
import { UsageSection } from "./usage-section"
import { InvoiceHistoryTable } from "./invoice-history-table"
import { UpgradeModal } from "./upgrade-modal"

export const dynamic = "force-dynamic"

export default async function BillingSettingsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  // Role gate: broker + admin only
  if (!profile?.brokerage_id || !["broker", "admin"].includes(profile.role || "")) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id

  // Parallel data fetching
  const [tiers, subscription, usage, invoices] = await Promise.all([
    getSubscriptionTiers(),
    getCurrentSubscription(brokerageId),
    getBillingUsage(brokerageId),
    getInvoiceHistory(brokerageId),
  ])

  const currentTier = subscription?.subscription_tiers
  const maxAgents = currentTier?.max_agents || 1
  const features = currentTier?.features as Record<string, number> | null

  // Usage limits from tier features
  const aiCallsLimit = features?.ai_calls_monthly || 1000
  const storageLimit = features?.storage_gb || 5
  const videoMinutesLimit = features?.video_minutes_monthly || 60

  return (
    <div className="container mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Billing & Subscription</h1>
        <p className="text-muted-foreground mt-1">
          Manage your subscription plan, view usage, and download invoices
        </p>
      </div>

      {/* Current Plan Card */}
      <CurrentPlanCard
        subscription={subscription}
        tier={currentTier}
        tiers={tiers}
        brokerageId={brokerageId}
      />

      {/* Usage Section */}
      <UsageSection
        usage={usage}
        maxAgents={maxAgents}
        aiCallsLimit={aiCallsLimit}
        storageLimitGb={storageLimit}
        videoMinutesLimit={videoMinutesLimit}
      />

      {/* Invoice History */}
      <InvoiceHistoryTable invoices={invoices} />
    </div>
  )
}
