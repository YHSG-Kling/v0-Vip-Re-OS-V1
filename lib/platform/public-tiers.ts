// lib/platform/public-tiers.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE public tier loader — /signup and /pricing render the SAME DB-driven
// plans (keep-one). Prices + copy are the single source of truth in
// subscription_tiers: a production price change is a DB update, not a code
// change. Nothing here is hardcoded except the row → card field mapping.

export interface PublicTier {
  tierName: string
  displayName: string
  description: string
  bullets: string[]
  featured: boolean
  monthlyCents: number
  annualCents: number
  setupCents: number
}

/** Load the active, publicly-marketable tiers (cheapest first). */
export async function loadPublicTiers(svc: any): Promise<PublicTier[]> {
  const { data, error } = await svc
    .from("subscription_tiers")
    .select("tier_name, display_name, description, marketing_bullets, is_featured, monthly_price_cents, annual_price_cents, setup_fee_cents")
    .eq("is_active", true)
    .order("monthly_price_cents", { ascending: true })
  if (error) return []
  return ((data ?? []) as any[]).map((t) => ({
    tierName: t.tier_name as string,
    displayName: (t.display_name as string) ?? t.tier_name,
    description: (t.description as string) ?? "",
    bullets: Array.isArray(t.marketing_bullets) ? (t.marketing_bullets as string[]) : [],
    featured: !!t.is_featured,
    monthlyCents: t.monthly_price_cents ?? 0,
    annualCents: t.annual_price_cents ?? 0,
    setupCents: t.setup_fee_cents ?? 0,
  }))
}

/** Format cents → whole dollars ("$149"); "—" when the tier has no price yet. */
export function formatTierPrice(cents: number | undefined | null): string {
  if (!cents || cents <= 0) return "—"
  return "$" + Math.round(cents / 100).toLocaleString("en-US")
}
