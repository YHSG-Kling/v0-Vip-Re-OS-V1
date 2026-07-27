import { createClient } from "@/lib/supabase/server"
import { notFound, redirect } from "next/navigation"
import { MarketingTierClient } from "./marketing-tier-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

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
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!userRow?.brokerage_id) redirect("/dashboard")

  // Marketing tiers are superadmin-only — redirect everyone else
  if (userRow.user_type !== "superadmin") {
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

  // Load current tier details if assigned
  let currentTier = null
  let tierBudgets: Array<{ id: string; channel_type: string; default_budget: number }> = []
  let tierDistributions: Array<{ id: string; asset_type: string; channel_type: string; is_required: boolean }> = []

  if (listing.marketing_tier_id) {
    const { data: tier } = await supabase
      .from("listing_marketing_tiers")
      .select("*")
      .eq("id", listing.marketing_tier_id)
      .single()

    if (tier) {
      currentTier = tier

      const { data: budgets } = await supabase
        .from("tier_budgets")
        .select("*")
        .eq("tier_id", tier.id)

      tierBudgets = budgets ?? []

      const { data: distributions } = await supabase
        .from("tier_distributions")
        .select("*")
        .eq("tier_id", tier.id)

      tierDistributions = distributions ?? []
    }
  }

  // Load all tiers for brokerage (for admin settings)
  const { data: allTiers } = await supabase
    .from("listing_marketing_tiers")
    .select("*")
    .eq("brokerage_id", userRow.brokerage_id)
    .order("min_price", { ascending: true, nullsFirst: true })

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
  let activePackage = null
  if (transactionId) {
    const { data: pkg } = await supabase
      .from("listing_marketing_packages")
      .select("id, package_name, package_type, status, total_estimated_cost, included_services, activated_at")
      .eq("transaction_id", transactionId)
      .order("activated_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    activePackage = pkg
  }

  const isAdmin = ["broker", "broker_owner", "admin", "superadmin"].includes(userRow.user_type ?? "")

  return (
    <MarketingTierClient
      listing={listing}
      currentTier={currentTier}
      tierBudgets={tierBudgets}
      tierDistributions={tierDistributions}
      allTiers={allTiers ?? []}
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
