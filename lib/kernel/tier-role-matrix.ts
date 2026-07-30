// lib/kernel/tier-role-matrix.ts
//
// PURE, server+client-safe tier → roles + SEATS matrix. Plain module (NOT
// "use server") so the SAME truth drives the invite server actions, the
// role-change gate, the god-console tenant-user creator, and the invite UI —
// no drift. Only TYPE imports from the kernel (erased at compile time), so it
// is safe in client bundles.
//
// THE BUSINESS MODEL (owner-corrected, round 16):
//   • Every tier gets access to the working roles — admin, agent, tc,
//     compliance_officer, isa, team_lead — and the constraint is SEATS, not the
//     role menu: "they can use those seats anyway they want" (owner).
//   • THE ONE EXCEPTION, and it is a hard one: a SOLO subscription has NO
//     broker and NO broker_owner. Owner, explicitly: "no solo agent tier
//     subscription does NOT have a broker owner or broker." A solo
//     subscription is not a brokerage, so the roles that exist to govern one
//     are not on its menu. Its 2 seats are spent inside the remaining set.
//   • SEATS: solo_agent = 2 · team = 5 · brokerage / multi_location =
//     unlimited. A "seat" is a working staff user (SEAT_ROLES). Partner
//     users do NOT consume seats.
//   • OVER THE LIMIT IS A CHOICE, NOT A WALL. Owner's ruling: "if they try to
//     go over alloted seats, we can charge them monthly for each additional
//     seats but I would rather get them to upgrade to the team level." So the
//     gate offers both, upgrade first — see seatDecision() below. Blocking the
//     invite outright loses the expansion the tenant was asking for.
//   • THE AGENT-ROLE ADVISORY. Owner's ruling: "if they don't use atleast 1
//     agent role, then they won't get much out of the system." Advisory, never
//     a block — the OS's whole contact/deal/marketing spine hangs off an agent
//     record, so a workspace with none is quietly inert.
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
  "admin", "broker", "broker_owner", "team_lead", "agent", "tc", "isa", "compliance_officer",
]

/** The solo set: every working role EXCEPT the two brokerage-governance ones.
 *  A solo subscription is not a brokerage — owner's ruling, held firm. */
const SOLO_SEAT_ROLES: readonly UserDomainRole[] =
  SEAT_ROLES.filter((r) => r !== "broker" && r !== "broker_owner")

/** Canonical tier → invitable roles. THE matrix — every invite surface derives
 *  from it. The tier sells SEATS and how a tenant spends them is theirs; the one
 *  role constraint is that solo has no broker/broker_owner. */
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

/**
 * PRICE OF ONE ADDITIONAL SEAT, per month, when a tenant chooses to expand past
 * their tier rather than upgrade. Stated once here so the invite gate, the seat
 * meter and the billing copy quote the SAME number.
 */
export const ADDITIONAL_SEAT_MONTHLY_USD = 25

export type SeatOutcome =
  /** Inside the limit — nothing to decide. */
  | "within_limit"
  /** Over the limit, and a higher tier exists: the preferred path. */
  | "upgrade_offered"
  /** Over the limit on the TOP tier, or on a staff override: paid seat only. */
  | "paid_seat_only"

export interface SeatDecision {
  outcome: SeatOutcome
  /** May the seat be added right now, without a billing choice? */
  withinLimit: boolean
  limit: number | null
  remaining: number | null
  overridden: boolean
  /** The tier to recommend, when one is better than paying per seat. */
  upgradeTo: CanonicalTier | null
  /** Seats the recommended tier would give them (null = unlimited). */
  upgradeSeats: number | null
  /** Monthly cost if they instead add seats one at a time. */
  additionalSeatMonthlyUsd: number
  /** How many extra seats this request would put them over by. */
  seatsOver: number
}

/**
 * PURE: WHAT HAPPENS WHEN A TENANT ASKS FOR A SEAT THEY HAVE NOT PAID FOR?
 *
 * Not a wall. The owner's ruling: "if they try to go over alloted seats, we can
 * charge them monthly for each additional seats but I would rather get them to
 * upgrade to the team level." Refusing the invite is the one outcome that serves
 * nobody — the tenant is trying to GROW, which is the moment to sell, and a hard
 * stop just teaches them the OS is in the way.
 *
 * So: inside the limit, proceed silently. Over it, offer the upgrade FIRST
 * (cheaper per seat and it unlocks the rest of the tier) with the per-seat price
 * as the fallback for someone who genuinely needs one more person and nothing
 * else. On the top tier — or where staff have set an explicit override, which is
 * a deliberate cap, not an accident of pricing — there is no tier to climb, so
 * the paid seat is the only honest offer.
 */
export function seatDecision(
  tier: string | null | undefined,
  currentSeatCount: number,
  seatOverride?: number | null,
  seatsRequested = 1,
): SeatDecision {
  const { limit, overridden } = effectiveSeatLimit(tier, seatOverride)
  const base: SeatDecision = {
    outcome: "within_limit",
    withinLimit: true,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - currentSeatCount),
    overridden,
    upgradeTo: null,
    upgradeSeats: null,
    additionalSeatMonthlyUsd: ADDITIONAL_SEAT_MONTHLY_USD,
    seatsOver: 0,
  }
  if (limit === null) return base
  // Math.max(0, …), not max(1, …): a caller asking about the CURRENT state passes
  // 0, and clamping that to 1 invented an overage for a tenant sitting exactly at
  // their limit — the settings panel would have nagged a healthy full plan.
  const after = currentSeatCount + Math.max(0, seatsRequested)
  if (after <= limit) return base

  const seatsOver = after - limit
  // The next tier UP that actually grants more seats. A staff override is a
  // deliberate cap, so it is never answered with "upgrade" — that would send a
  // tenant to buy a tier they may already be on.
  let upgradeTo: CanonicalTier | null = null
  let upgradeSeats: number | null = null
  if (!overridden && isCanonicalTier(tier)) {
    for (const t of TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1)) {
      const s = TIER_SEAT_LIMITS[t]
      if (s === null || s >= after) { upgradeTo = t; upgradeSeats = s; break }
    }
  }
  return {
    ...base,
    outcome: upgradeTo ? "upgrade_offered" : "paid_seat_only",
    withinLimit: false,
    remaining: 0,
    upgradeTo,
    upgradeSeats,
    seatsOver,
  }
}

/** PURE: the sentence a tenant reads when they ask for a seat past their limit. */
export function seatDecisionMessage(d: SeatDecision): string | null {
  if (d.withinLimit) return null
  const over = `${d.seatsOver} seat${d.seatsOver === 1 ? "" : "s"}`
  if (d.outcome === "upgrade_offered" && d.upgradeTo) {
    const seats = d.upgradeSeats === null ? "unlimited seats" : `${d.upgradeSeats} seats`
    return `That is ${over} past your ${d.limit}-seat plan. Upgrading to ${TIER_LABELS[d.upgradeTo]} gives you ${seats} — or keep this plan and add the seat for $${d.additionalSeatMonthlyUsd}/month.`
  }
  return `That is ${over} past your ${d.limit}-seat plan. You can add ${d.seatsOver === 1 ? "it" : "them"} for $${d.additionalSeatMonthlyUsd}/month per seat.`
}

/**
 * PURE: does this workspace have anyone in the AGENT role?
 *
 * Owner's ruling: "they can use those seats anyway they want but if they don't
 * use atleast 1 agent role, then they won't get much out of the system." That is
 * an ADVISORY, never a gate — but it is a real one, because the contact, deal,
 * listing, commission and marketing spines all hang off an `agents` record. A
 * workspace of admins and a TC looks staffed and quietly does nothing.
 *
 * Roles come from BOTH sources (users.user_type and user_role_assignments), same
 * as the seat count — an admin who also carries agent satisfies this.
 */
export function agentRoleAdvisory(rolesInUse: readonly string[]): { hasAgent: boolean; advisory: string | null } {
  const hasAgent = rolesInUse.includes("agent")
  return {
    hasAgent,
    advisory: hasAgent
      ? null
      : "No one in this workspace holds the Agent role. Contacts, deals, listings and campaigns all attach to an agent — assign one of your seats the Agent role to switch the OS on.",
  }
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
