import { createClient } from "@/lib/supabase/server"
import { notFound, redirect } from "next/navigation"
import { MarketingTierClient } from "./marketing-tier-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { resolvePlatformRole } from "@/lib/platform/require-capability"
import { getMarketingPackageStatus } from "@/app/actions/marketing-package-automation"
import {
  getTierForListing,
  getTierBudgets,
  getTiersForBrokerage,
} from "@/lib/listings/tier-assigner"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ListingMarketingTierPage({ params }: PageProps) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", user.id)
    .single()

  if (!userRow?.brokerage_id) redirect("/dashboard")

  // Marketing tiers are superadmin-only — redirect everyone else.
  //
  // THE PREDICATE THAT REDIRECTED EVERYONE. This read `user_type !==
  // 'superadmin'`, and no live users row carries that value: the one platform
  // superadmin is platform_role='superadmin' with user_type='admin' ('admin'
  // being also a tenant user_type is why the roster lives on platform_role).
  // So this page bounced 100% of visitors — including the only person it was
  // written for — straight back to the lifecycle page, silently.
  //
  // resolvePlatformRole is the canonical reader of that dual-source identity.
  // The rule is UNCHANGED and deliberately NOT widened: this is a tenant listing
  // screen whose authority the owner has not ruled on, so it stays exactly as
  // narrow as it says it is — superadmin only, which is now one real account
  // instead of none.
  if (resolvePlatformRole(userRow) !== "superadmin") {
    redirect(`/dashboard/listings/${listingId}/lifecycle`)
  }

  // Load listing with current tier
  const { data: listing } = await supabase
    .from("listings")
    .select(`
      id,
      address,
      city,
      state,
      zip,
      list_price,
      marketing_budget,
      marketing_tier_id,
      brokerage_id
    `)
    .eq("id", listingId)
    .eq("brokerage_id", userRow.brokerage_id)
    .single()

  if (!listing) notFound()

  // Load current tier details if assigned.
  //
  // These reads go through lib/listings/tier-assigner.ts rather than raw selects,
  // for the same reason the marketing-package read below already does: the tenant
  // guard travels with the reader instead of being re-typed (or forgotten) at each
  // surface. The raw selects these replace were weaker in three concrete ways —
  // the tier lookup, the tier_budgets read and the tier_distributions read all
  // filtered ONLY on the id/tier_id with no `brokerage_id` predicate (they leaned
  // entirely on RLS), and the tier lookup used `.single()`, which throws PGRST116
  // when a listing still points at a deleted tier and takes the whole page down
  // with a 500 instead of degrading to "no tier assigned".
  let currentTier: {
    id: string
    tier_name: string
    min_price: number | null
    max_price: number | null
    description: string | null
    is_active: boolean
  } | null = null
  let tierBudgets: Array<{ id: string; channel_type: string; default_budget: number }> = []
  let tierDistributions: Array<{ id: string; asset_type: string; channel_type: string; is_required: boolean }> = []

  if (listing.marketing_tier_id) {
    const tierResult = await getTierForListing(listingId)
    if (tierResult.success && (tierResult as any).tier) {
      currentTier = (tierResult as any).tier

      const budgetResult = await getTierBudgets(listing.marketing_tier_id)
      if (budgetResult.success) {
        tierBudgets = ((budgetResult as any).budgets ?? []) as typeof tierBudgets
      }

      // Distributions are read here rather than through
      // tier-assigner:getRequiredDistributions because this surface renders the
      // FULL set and badges each row required/optional — that reader returns only
      // the required ones, so swapping it in would silently hide the optional
      // distributions. The tenant predicate it carries is applied here instead.
      const { data: distributions } = await supabase
        .from("tier_distributions")
        .select("*")
        .eq("tier_id", listing.marketing_tier_id)
        .eq("brokerage_id", userRow.brokerage_id)

      tierDistributions = distributions ?? []
    }
  }

  // Load all tiers for brokerage (for admin settings)
  const allTiersResult = await getTiersForBrokerage(userRow.brokerage_id)
  const allTiers = allTiersResult.success ? ((allTiersResult as any).tiers ?? []) : []

  // Load marketing campaigns for this listing
  const { data: campaigns } = await supabase
    .from("marketing_campaigns")
    .select("id, campaign_name, campaign_type, status, budget_total, budget_spent, created_at")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })

  // Load marketing assets for completion check
  const { data: assets } = await supabase
    .from("marketing_assets")
    .select("id, asset_type, asset_name, campaign_id")
    .eq("campaign_id", campaigns?.[0]?.id ?? "00000000-0000-0000-0000-000000000000")

  // Resolve the listing's transaction — marketing packages activate against a
  // transaction row (per-deal marketing package, distinct from the price tier).
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id")
    .eq("listing_id", listingId)
    .eq("brokerage_id", userRow.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const transactionId = transaction?.id ?? null

  // Load the most recent marketing package for that transaction (if any).
  // Goes through the action rather than a raw select so the same tenant guard
  // that every other package operation uses (verifyTransactionInBrokerage)
  // applies to the read too.
  const activePackage = transactionId
    ? await getMarketingPackageStatus(transactionId)
    : null

  const isAdmin = isAdminOrBroker({ user_type: userRow.user_type ?? "" })

  return (
    <MarketingTierClient
      listing={listing}
      currentTier={currentTier}
      tierBudgets={tierBudgets}
      tierDistributions={tierDistributions}
      allTiers={allTiers}
      campaigns={campaigns ?? []}
      assets={assets ?? []}
      userId={user.id}
      brokerageId={userRow.brokerage_id}
      isAdmin={isAdmin}
      transactionId={transactionId}
      activePackage={activePackage}
    />
  )
}
