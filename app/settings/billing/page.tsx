import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import {
  getSubscriptionTiers,
  getCurrentSubscription,
  getBillingUsage,
  getInvoiceHistory,
} from "@/app/actions/billing"
// TOMBSTONE (§1.3): sixteen dead imports stood here — Card/CardContent/
// CardHeader/CardTitle/CardDescription, Badge, Button, Progress, the seven
// lucide icons (CreditCard, FileText, AlertTriangle, Users, Cpu, HardDrive,
// Video) and UpgradeModal. None was referenced in this file. They are leftovers
// from the inline version of this page, whose markup was EXTRACTED into the
// three child components below; the functionality did not disappear, it moved:
//   · the plan card + cancel flow → ./current-plan-card.tsx
//   · the four usage meters       → ./usage-section.tsx
//   · the invoice table           → ./invoice-history-table.tsx
// UpgradeModal is the one worth naming separately: it is not unused product,
// it is RENDERED by CurrentPlanCard (current-plan-card.tsx:300) and opened by
// its own "Upgrade Plan" button, so importing it here as well was a second
// reference to a component this page never mounts.
import { CurrentPlanCard } from "./current-plan-card"
import { UsageSection } from "./usage-section"
import { InvoiceHistoryTable } from "./invoice-history-table"
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

  // Role gate: broker-level only — use the CANONICAL set (isBrokerageFinanceAdmin), not a
  // hand-typed ["broker","admin"] that silently excluded superadmin / broker_admin
  // / broker_owner and bounced the actual owner off their own billing page.
  if (!profile?.brokerage_id || !isBrokerageFinanceAdmin(profile)) {
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
  // `max_agents || 1` was the bug: the live multi_location tier stores NULL for
  // UNLIMITED, and `|| 1` turned that into a ONE-seat cap on the tenant's own
  // billing page — the exact opposite of what they pay for. NULL now travels
  // through as null and UsageSection folds it via the shared normalizer.
  const maxAgents: number | null = currentTier?.max_agents ?? null
  // …and the SECOND reading of that same absent value: whether a catalogue row
  // was read AT ALL. Without this, a tenant with no subscription (every tenant
  // on this database today — `subscriptions` holds 0 rows) reached the identical
  // `null` and was shown UNLIMITED seats beside the words "No Plan". Absence of
  // an entitlement must not render as the largest entitlement sold (§4).
  const hasTier = Boolean(currentTier)
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
        hasTier={hasTier}
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
