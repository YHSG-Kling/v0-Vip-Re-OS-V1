// lib/kernel/tier-role-matrix.ts
//
// PURE, server+client-safe tier → roles + SEATS matrix. Plain module (NOT
// "use server") so the SAME truth drives the invite server actions, the
// role-change gate, the god-console tenant-user creator, and the invite UI —
// no drift. Only TYPE imports from the kernel (erased at compile time), so it
// is safe in client bundles.
//
// THE BUSINESS MODEL (owner-corrected, round 16):
//   • Every tier gets access to ALL the working roles — admin, agent, tc,
//     compliance_officer, isa, team_lead, broker — the constraint is SEATS,
//     not the role menu. The one role exception: solo_agent has NO broker
//     role (a solo subscription is not a brokerage).
//   • SEATS: solo_agent = 2 · team = 5 · brokerage / multi_location =
//     unlimited. A "seat" is a working staff user (SEAT_ROLES). Partner
//     users do NOT consume seats.
//   • PARTNERS: vendor ONLY. There is no lender partner role — lenders ARE
//     vendors (vendor_directory categories 'lender' / 'refinance_lender');
//     they come in through the vendor invite flow. The legacy 'lender'
//     user_type remains in the vocabulary for existing rows but is no longer
//     invitable anywhere.
//
// superadmin/support/etc. are PLATFORM roles — never tenant-invitable, so they
// appear in no tier's list. Platform staff are provisioned through their own
// path (see app/actions/superadmin/tenant-users.ts).

import type { UserDomainRole, CanonicalTier } from "./users"

/** Partner roles every tier may invite (never seat-consuming). Vendor ONLY —
 *  lenders are a vendor category, not a role. */
export const PARTNER_ROLES: readonly UserDomainRole[] = ["vendor"]

/** Seat-consuming working roles — the full role set of the OS. */
export const SEAT_ROLES: readonly UserDomainRole[] = [
  "admin", "broker", "team_lead", "agent", "tc", "isa", "compliance_officer",
]

/** All working roles minus broker — the solo set (solo is not a brokerage). */
const SOLO_SEAT_ROLES: readonly UserDomainRole[] = SEAT_ROLES.filter((r) => r !== "broker")

/** Canonical tier → invitable roles. THE matrix — every invite surface derives from it. */
export const TIER_INVITABLE_ROLES: Record<CanonicalTier, readonly UserDomainRole[]> = {
  solo_agent:     [...SOLO_SEAT_ROLES, ...PARTNER_ROLES],
  team:           [...SEAT_ROLES, ...PARTNER_ROLES],
  brokerage:      [...SEAT_ROLES, ...PARTNER_ROLES],
  multi_location: [...SEAT_ROLES, ...PARTNER_ROLES],
}

/** Canonical tier → seat limit (null = unlimited). Seats count SEAT_ROLES users only. */
export const TIER_SEAT_LIMITS: Record<CanonicalTier, number | null> = {
  solo_agent:     2,
  team:           5,
  brokerage:      null,
  multi_location: null,
}

/** Ascending capability order — used to answer "which tier unlocks this?". */
export const TIER_ORDER: readonly CanonicalTier[] = ["solo_agent", "team", "brokerage", "multi_location"]

/** Human labels for upgrade copy (the only product names the UI may use). */
export const TIER_LABELS: Record<CanonicalTier, string> = {
  solo_agent:     "Solo",
  team:           "Team",
  brokerage:      "Brokerage",
  multi_location: "Multi-Location",
}

export function isCanonicalTier(tier: string | null | undefined): tier is CanonicalTier {
  return !!tier && tier in TIER_INVITABLE_ROLES
}

/**
 * Invitable roles for a tenant tier.
 * Unknown/legacy/null tiers FAIL OPEN to the full brokerage set — the
 * pre-matrix behavior — so a legacy tenant whose brokerages.plan_tier was never
 * backfilled keeps a working invite surface instead of being bricked.
 * Canonical tiers are enforced strictly.
 */
export function invitableRolesForTier(tier: string | null | undefined): readonly UserDomainRole[] {
  return isCanonicalTier(tier) ? TIER_INVITABLE_ROLES[tier] : TIER_INVITABLE_ROLES.brokerage
}

/** Is this role invitable on this tier? (Same fail-open rule for unknown tiers.) */
export function tierAllowsRole(tier: string | null | undefined, role: UserDomainRole): boolean {
  return invitableRolesForTier(tier).includes(role)
}

/** Does this role consume a seat? Partners never do. */
export function roleConsumesSeat(role: UserDomainRole): boolean {
  return (SEAT_ROLES as readonly string[]).includes(role)
}

/** Seat limit for a tier — unknown/legacy tiers fail OPEN to unlimited. */
export function seatLimitForTier(tier: string | null | undefined): number | null {
  return isCanonicalTier(tier) ? TIER_SEAT_LIMITS[tier] : null
}

/**
 * PURE: read the staff-set per-tenant seat override out of brokerages.billing_metadata
 * ({ ..., seat_override: <int> }). null / absent / non-integer / negative ⇒ no override
 * (tier default applies). Set ONLY by the platform tenant-entitlements surface (audited).
 */
export function parseSeatOverride(billingMetadata: unknown): number | null {
  if (!billingMetadata || typeof billingMetadata !== "object") return null
  const raw = (billingMetadata as Record<string, unknown>).seat_override
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null
}

/**
 * PURE keep-one seat-limit resolution: the staff override WINS when set (it can raise a
 * capped tier or cap an unlimited one); otherwise the tier default. Every seat surface —
 * both invite gates and the seat meter — resolves through THIS.
 */
export function effectiveSeatLimit(
  tier: string | null | undefined,
  seatOverride?: number | null,
): { limit: number | null; overridden: boolean } {
  if (seatOverride !== null && seatOverride !== undefined) return { limit: seatOverride, overridden: true }
  return { limit: seatLimitForTier(tier), overridden: false }
}

/**
 * PURE seat check: given the tier, the CURRENT count of seat-role users, and any staff-set
 * per-tenant override, may one more seat user be added? Returns the honest verdict + copy inputs.
 */
export function seatCheck(tier: string | null | undefined, currentSeatCount: number, seatOverride?: number | null): {
  allowed: boolean
  limit: number | null
  remaining: number | null
  /** true when the limit came from the staff-set per-tenant override, not the tier. */
  overridden: boolean
} {
  const { limit, overridden } = effectiveSeatLimit(tier, seatOverride)
  if (limit === null) return { allowed: true, limit: null, remaining: null, overridden }
  const remaining = Math.max(0, limit - currentSeatCount)
  return { allowed: remaining > 0, limit, remaining, overridden }
}

/** Lowest tier whose matrix includes the role — null for platform-only roles. */
export function minimumTierForRole(role: UserDomainRole): CanonicalTier | null {
  for (const tier of TIER_ORDER) {
    if (TIER_INVITABLE_ROLES[tier].includes(role)) return tier
  }
  return null
}

/** Safe label for error copy — canonical tiers get their label, anything else "current". */
export function tierLabel(tier: string | null | undefined): string {
  return isCanonicalTier(tier) ? TIER_LABELS[tier] : "current"
}
