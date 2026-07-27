import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
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
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

export default async function BillingSettingsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  // Role gate: broker-level only — use the CANONICAL set (isAdminOrBroker), not a
  // hand-typed ["broker","admin"] that silently excluded superadmin / broker_admin
  // / broker_owner and bounced the actual owner off their own billing page.
  if (!profile?.brokerage_id || !isAdminOrBroker(profile)) {
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
