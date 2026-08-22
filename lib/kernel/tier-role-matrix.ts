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
//   • THE EXCEPTION, and it is a hard one: NEITHER a SOLO nor a TEAM
//     subscription has a broker or a broker_owner.
//       – Solo: owner, explicitly — "no solo agent tier subscription does NOT
//         have a broker owner or broker." A solo subscription is not a
//         brokerage, so the roles that exist to govern one are not on its menu.
//         Its 2 seats are spent inside the remaining set.
//       – Team: owner, explicitly — "if team tier subscriptions, they don't have
//         a broker in the subscription so the team lead can see leads." The
//         missing broker is the PREMISE of the lead ruling: the team lead is
//         admitted to the lead desk (lib/auth/lead-visibility.ts) precisely
//         because on that tier there is nobody else to work it. This header used
//         to record the exception as SOLO-ONLY while the matrix gave `team` the
//         full seat list — the two halves of one ruling disagreeing in the same
//         file. Its 5 seats are spent inside the remaining set.
//   • SEATS: solo_agent = 2 · team = 5 · brokerage / multi_location =
//     unlimited. A "seat" is a working staff user (SEAT_ROLES). Partner
//     users do NOT consume seats.
//   • OVER THE LIMIT IS AN UPGRADE, NOT A PAID EXTRA SEAT — OWNER, VERBATIM,
//     SUPERSEDING THE EARLIER HALF OF THIS RULE:
//
//       "team tier only has 5 seats for the subscription and if they need more
//        than they need to upgrade to a brokerage plan. agent tier subscription
//        only has 2 seats and if they need more than they need to upgrade to a
//        team subscription. but these lower plans need to be treated like mini
//        brokerages."
//
//     The PREVIOUS ruling recorded here was "if they try to go over alloted
//     seats, we can charge them monthly for each additional seats but I would
//     rather get them to upgrade to the team level" — an offer of BOTH paths.
//     The owner has now named the path: solo → team, team → brokerage. So where
//     a tier ABOVE exists, the add is refused and the refusal names that tier;
//     the per-seat price is no longer offered beside it, because offering it is
//     offering the tenant the thing the owner just said they may not have.
//
//     The per-seat price SURVIVES in exactly the case the new ruling does not
//     speak to and the old one did: there is no tier to climb — the top tier, or
//     a staff-set override, which is a deliberate cap rather than a pricing
//     accident. That is `paid_seat_only` below, and it is the ONLY outcome that
//     still quotes a dollar figure.
//   • THE NUMBERS ARE CATALOGUE DATA, NOT CODE. TIER_SEAT_LIMITS below is the
//     FALLBACK, not the source: the administrable home is
//     `subscription_tiers.max_agents`, which the superadmin plan catalogue
//     already edits (app/actions/superadmin/plan-catalog.ts, validated by
//     lib/billing/plan-catalog.ts `maxAgents`). Every seat surface may pass a
//     CatalogSeatLimits map read from that table; when it is absent — a client
//     bundle, a refused read on a display surface — these literals answer, and
//     they are kept in agreement with the catalogue by the migration named at
//     supabase/migrations/m523-the-seat-number-a-prospect-is-quoted-and-the-one-
//     the-gate-enforces-were-two-different-numbers.sql. See lib/kernel/seat-usage.ts
//     `resolveCatalogSeatLimits` for the reader and `seatGate` for the one
//     enforcement entry every add path goes through.
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

/**
 * The TEAM set. Same subtraction as solo, and it is the SAME EXPRESSION on
 * purpose rather than a second literal.
 *
 * ── THE RULING THAT MOVED THIS ──────────────────────────────────────────────
 *
 * OWNER, verbatim: "if team tier subscriptions, they don't have a broker in the
 * subscription so the team lead can see leads."
 *
 * The header of this file recorded the no-broker exception as SOLO-ONLY, and the
 * matrix below duly gave `team` the full SEAT_ROLES including broker and
 * broker_owner. The owner has now said a team-tier subscription has no broker
 * either — which is the PREMISE of the lead ruling, not an aside: the reason the
 * team lead sees leads is that on that tier there is nobody else to. A tier that
 * could still invite a broker would contradict the sentence that admits the team
 * lead to the lead desk in the first place.
 *
 * ── WHY DERIVED, NOT RETYPED ────────────────────────────────────────────────
 *
 * Written as a literal, `team` and `solo_agent` would drift the first time a
 * working role is added to SEAT_ROLES: it would land in one and be forgotten in
 * the other. Both tiers ask the SAME question — "every working role except the
 * two that exist to govern a brokerage" — so both are the same filter, and a new
 * role joins both tiers automatically, which is the safe default for a seat
 * menu. The subtraction is visible in one line instead of buried in a diff
 * between two lists.
 *
 * The two are kept as SEPARATE named constants rather than one shared alias
 * because they are two RULINGS that currently agree, not one ruling: solo has no
 * broker because it is not a brokerage, team has no broker because the
 * subscription does not include one. If either moves, it moves alone.
 */
const TEAM_SEAT_ROLES: readonly UserDomainRole[] =
  SEAT_ROLES.filter((r) => r !== "broker" && r !== "broker_owner")

/** Canonical tier → invitable roles. THE matrix — every invite surface derives
 *  from it. The tier sells SEATS and how a tenant spends them is theirs; the
 *  role constraint is that neither solo NOR team has broker/broker_owner. */
export const TIER_INVITABLE_ROLES: Record<CanonicalTier, readonly UserDomainRole[]> = {
  solo_agent:     [...SOLO_SEAT_ROLES, ...PARTNER_ROLES],
  team:           [...TEAM_SEAT_ROLES, ...PARTNER_ROLES],
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
 *
 * ── THIS NOW FAILS CLOSED ON THE TWO GOVERNANCE ROLES ───────────────────────
 *
 * It used to return `TIER_INVITABLE_ROLES.brokerage` for an unknown / legacy /
 * null tier — the pre-matrix behaviour, chosen so a tenant whose
 * `brokerages.plan_tier` was never backfilled kept a working invite surface
 * instead of being bricked. That reasoning still holds for MOST of the menu and
 * is kept.
 *
 * What it can no longer do is hand back the seats a ruling just removed. Under a
 * ruling that SUBTRACTS roles from a tier, "unknown tier ⇒ the widest tier"
 * inverts the ruling exactly where it is least visible: a team-tier tenant whose
 * plan_tier is NULL, mis-cased, or spelled with a legacy value would fall
 * through to the brokerage menu and be offered `broker` and `broker_owner` —
 * the two roles the owner has now removed from both non-brokerage tiers — and
 * nothing would report it, because being offered a role is not an error.
 *
 * So the fallback is the brokerage menu MINUS the two brokerage-governance
 * roles: every operational seat still invitable (nobody is bricked), and the two
 * roles that only a real brokerage subscription buys withheld until the tenant's
 * tier can actually be read. A tenant that IS on brokerage or multi_location is
 * unaffected — their tier is canonical and matches strictly.
 *
 * Derived from SEAT_ROLES with the same one-line subtraction the tiers use, so a
 * new working role joins the fallback automatically and a new governance role
 * does not have to be remembered in three places.
 */
const UNKNOWN_TIER_INVITABLE_ROLES: readonly UserDomainRole[] = [
  ...SEAT_ROLES.filter((r) => r !== "broker" && r !== "broker_owner"),
  ...PARTNER_ROLES,
]

export function invitableRolesForTier(tier: string | null | undefined): readonly UserDomainRole[] {
  return isCanonicalTier(tier) ? TIER_INVITABLE_ROLES[tier] : UNKNOWN_TIER_INVITABLE_ROLES
}

/** Is this role invitable on this tier? (Same fail-CLOSED rule for unknown tiers.) */
export function tierAllowsRole(tier: string | null | undefined, role: UserDomainRole): boolean {
  return invitableRolesForTier(tier).includes(role)
}

/** Does this role consume a seat? Partners never do. */
export function roleConsumesSeat(role: UserDomainRole): boolean {
  return (SEAT_ROLES as readonly string[]).includes(role)
}

/**
 * Per-tier seat caps read out of the PLAN CATALOGUE (subscription_tiers.max_agents).
 * `null` = unlimited. A tier absent from the map falls back to TIER_SEAT_LIMITS.
 * Produced by lib/kernel/seat-usage.ts `resolveCatalogSeatLimits`; passed through
 * every resolver below so the catalogue is the administered number and these
 * literals are only the floor under a missing row.
 */
export type CatalogSeatLimits = Partial<Record<CanonicalTier, number | null>>

/**
 * Seat limit for a tier. Catalogue first, tier literal second — and an
 * UNRECOGNISED tier now resolves to the SMALLEST tier's limit, not unlimited.
 *
 * ── THIS DIRECTION CHANGED, DELIBERATELY ────────────────────────────────────
 *
 * It used to return `null` (unlimited) for an unknown / legacy / NULL tier, on
 * the same "don't brick an unbackfilled tenant" reasoning that shapes
 * invitableRolesForTier. But a seat cap is not a role menu: "we could not read
 * this tenant's plan" rendering as "this tenant may hire without limit" is
 * exactly the shape CLAUDE.md §4 forbids — nobody checked, displayed as checked
 * and fine. It is also the opposite of what the tier reader beside it already
 * does: lib/billing/plan-tier.ts `toPlanTier` falls an unreadable tier to
 * FALLBACK_TIER, the TIGHTEST, so a mis-tagged tenant is never handed a free
 * upgrade. This now matches that.
 *
 * Nobody is bricked by it: `brokerages.plan_tier` is CHECK-constrained to the
 * four canonical names and DEFAULTs to solo_agent, and both live tenants carry
 * a canonical value — so "unknown" means genuinely broken, and a broken tenant
 * gets the floor plus a refusal that names the upgrade, not silent unlimited
 * hiring. The ROLE menu still fails open-ish (minus the two governance roles),
 * because being offered a role you cannot fill costs nothing.
 */
export function seatLimitForTier(
  tier: string | null | undefined,
  catalog?: CatalogSeatLimits | null,
): number | null {
  const key: CanonicalTier = isCanonicalTier(tier) ? tier : TIER_ORDER[0]
  const fromCatalog = catalog?.[key]
  return fromCatalog !== undefined ? fromCatalog : TIER_SEAT_LIMITS[key]
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
  catalog?: CatalogSeatLimits | null,
): { limit: number | null; overridden: boolean } {
  if (seatOverride !== null && seatOverride !== undefined) return { limit: seatOverride, overridden: true }
  return { limit: seatLimitForTier(tier, catalog), overridden: false }
}

/**
 * PURE seat check: given the tier, the CURRENT count of seat-role users, and any staff-set
 * per-tenant override, may one more seat user be added? Returns the honest verdict + copy inputs.
 *
 * ── THE VERDICT, WITHOUT THE BILLING OFFER ───────────────────────────────────
 *
 * This is the DISPLAY projection of `seatDecision` below: the same four fields,
 * for a surface that is reporting where a tenant stands rather than selling them
 * a way past it. The seat meter on the admin roster is exactly that — it prints
 * "4 of 5 seats used" and turns it red at the line; it must not offer an upgrade
 * or a $25 seat, because nobody is trying to add anyone at the moment it renders.
 *
 * ── AND IT IS COMPUTED BY THE SURVIVOR, NOT BESIDE IT (CLAUDE.md §1, §6) ─────
 *
 * It used to re-derive `allowed` and `remaining` from `effectiveSeatLimit` in its
 * own arithmetic. That was a second spelling of "is this tenant at its limit",
 * and this file already holds the richer one — so a future change to the seat
 * rule (a grace seat, a different clamp) could land in `seatDecision`, which the
 * ENFORCEMENT path uses, while this one, which the DISPLAY path uses, kept the
 * old answer and told the tenant they were fine. It now delegates: one request,
 * which is the question this function asks. `withinLimit` and `remaining` are
 * exactly what the old arithmetic produced for every input — `seatDecision`
 * clamps `remaining` to 0 on the over-limit branch, and `Math.max(0, limit -
 * count)` is already 0 whenever `count >= limit` — so this is a merge onto the
 * survivor, not a behaviour change. scripts/seat-cap-simulator.ts pins the two
 * together across the whole grid.
 */
export function seatCheck(
  tier: string | null | undefined,
  currentSeatCount: number,
  seatOverride?: number | null,
  catalog?: CatalogSeatLimits | null,
): {
  allowed: boolean
  limit: number | null
  remaining: number | null
  /** true when the limit came from the staff-set per-tenant override, not the tier. */
  overridden: boolean
} {
  const d = seatDecision(tier, currentSeatCount, seatOverride, 1, catalog)
  return { allowed: d.withinLimit, limit: d.limit, remaining: d.remaining, overridden: d.overridden }
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
  catalog?: CatalogSeatLimits | null,
): SeatDecision {
  const { limit, overridden } = effectiveSeatLimit(tier, seatOverride, catalog)
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
  //
  // The tier the tenant is ON is resolved the same fail-CLOSED way the limit is
  // (unknown ⇒ the floor), so a tenant whose plan_tier cannot be read is still
  // told where to go — "unreadable" must not read as "nothing to offer".
  const fromTier: CanonicalTier = isCanonicalTier(tier) ? tier : TIER_ORDER[0]
  if (!overridden) {
    for (const t of TIER_ORDER.slice(TIER_ORDER.indexOf(fromTier) + 1)) {
      // Catalogue first — the upgrade copy must quote the seats the tenant will
      // actually be sold, not a literal that drifted from the plan they buy.
      const s = seatLimitForTier(t, catalog)
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

/**
 * PURE: the sentence a tenant reads when they ask for a seat past their limit.
 *
 * WHERE A TIER ABOVE EXISTS, THIS NAMES IT AND NOTHING ELSE. The owner's ruling
 * ("if they need more than they need to upgrade to a brokerage plan… agent tier
 * … upgrade to a team subscription") makes the upgrade THE answer, so quoting a
 * per-seat price beside it would offer the tenant the very thing that ruling
 * withdrew. The dollar figure survives only in `paid_seat_only` — the top tier
 * or a staff override, where there is no tier to climb and the earlier ruling is
 * still the only one that speaks.
 *
 * It is a REFUSAL and it is also a product moment: it says what they have, what
 * it costs them, and where to go — never "deactivate someone".
 */
export function seatDecisionMessage(d: SeatDecision): string | null {
  if (d.withinLimit) return null
  const over = `${d.seatsOver} seat${d.seatsOver === 1 ? "" : "s"}`
  if (d.outcome === "upgrade_offered" && d.upgradeTo) {
    const seats = d.upgradeSeats === null ? "unlimited seats" : `${d.upgradeSeats} seats`
    return `Your plan includes ${d.limit} seats and all ${d.limit} are in use — that is ${over} more. Upgrade to ${TIER_LABELS[d.upgradeTo]} for ${seats} to add this person.`
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
