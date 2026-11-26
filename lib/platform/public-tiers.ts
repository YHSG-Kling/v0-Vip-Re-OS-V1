// lib/platform/public-tiers.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE public tier loader — /signup and /pricing render the SAME DB-driven
// plans (keep-one). Prices + copy are the single source of truth in
// subscription_tiers: a production price change is a DB update, not a code
// change. Nothing here is hardcoded except the row → card field mapping.
//
// CUSTOM-PRICED TIERS (wave 87C — owner: "multi location tier is custom pricing
// for seats"; the live Multi-Location row still carries a 199900 / 1999000
// placeholder, which /pricing rendered as "$1,999 / month" with a "Start free
// trial" button). A tier whose seat band is null (lib/billing/plan-catalog.ts
// isCustomPricedTier — derived, never a second list) is loaded with
// customPriced: true and its catalogue amounts ZEROED here, at the one loader,
// so no public surface (pricing, get-started, the AI sales rep's tier lines,
// the growth board) can show or quote the placeholder; each renders the
// custom-pricing door instead. The owner's catalogue value is untouched.

import { isCustomPricedTier, customPricingDoorPath } from "@/lib/billing/plan-catalog"

export interface PublicTier {
  tierName: string
  displayName: string
  description: string
  bullets: string[]
  featured: boolean
  monthlyCents: number
  annualCents: number
  setupCents: number
  /** Quoted by a person — amounts are zeroed; render tierPriceLabel + tierCallToAction. */
  customPriced: boolean
}

/** Load the active, publicly-marketable tiers (cheapest first). */
export async function loadPublicTiers(svc: any): Promise<PublicTier[]> {
  const { data, error } = await svc
    .from("subscription_tiers")
    .select("tier_name, display_name, description, marketing_bullets, is_featured, monthly_price_cents, annual_price_cents, setup_fee_cents")
    .eq("is_active", true)
    .order("monthly_price_cents", { ascending: true })
  if (error) return []
  return ((data ?? []) as any[]).map((t) => publicTierFromRow(t))
}

/** PURE: one subscription_tiers row → the public card. A custom-priced tier's
 *  catalogue amounts never leave this function. */
export function publicTierFromRow(t: Record<string, any>): PublicTier {
  const customPriced = isCustomPricedTier(t.tier_name as string)
  return {
    tierName: t.tier_name as string,
    displayName: (t.display_name as string) ?? t.tier_name,
    description: (t.description as string) ?? "",
    bullets: Array.isArray(t.marketing_bullets) ? (t.marketing_bullets as string[]) : [],
    featured: !!t.is_featured,
    monthlyCents: customPriced ? 0 : (t.monthly_price_cents ?? 0),
    annualCents: customPriced ? 0 : (t.annual_price_cents ?? 0),
    setupCents: customPriced ? 0 : (t.setup_fee_cents ?? 0),
    customPriced,
  }
}

/** Format cents → whole dollars ("$149"); "—" when the tier has no price yet. */
export function formatTierPrice(cents: number | undefined | null): string {
  if (!cents || cents <= 0) return "—"
  return "$" + Math.round(cents / 100).toLocaleString("en-US")
}

/** The headline price for a public card: "Custom pricing" for a quoted tier. */
export function tierPriceLabel(t: Pick<PublicTier, "monthlyCents" | "customPriced">): string {
  return t.customPriced ? "Custom pricing" : formatTierPrice(t.monthlyCents)
}

/** The card's call to action: a quoted tier opens the sales door, never a trial/checkout. */
export function tierCallToAction(t: Pick<PublicTier, "tierName" | "customPriced">): { label: string; href: string } {
  return t.customPriced
    ? { label: "Contact sales", href: customPricingDoorPath(t.tierName) }
    : { label: "Start free trial", href: `/signup?tier=${encodeURIComponent(t.tierName)}` }
}
