// lib/kernel/tier-role-matrix.ts
//
// PURE, server+client-safe tier → roles + SEATS matrix. Plain module (NOT
// "use server") so the SAME truth drives the invite server actions, the
// role-change gate, the god-console tenant-user creator, and the invite UI —
// no drift. Only TYPE imports from the kernel (erased at compile time), so it
// is safe in client bundles.
//
// ─── THE FOUR AXES. THEY ARE NOT THE SAME AXIS. ──────────────────────────────
//
// This file exists because the repo spent sixteen rounds conflating four
// independent things. Naming them, in the owner's own terms:
//
//   1. SUBSCRIPTION TIER   what the tenant BUYS. Decides SEATS. Nothing else.
//   2. SEATS               2 / 5 / 50 / unlimited. The ONLY tier-imposed limit.
//   3. USER TYPE           what a person IS. One per user. Costs ONE seat.
//   4. PERMISSION ROLES    grants layered ON TOP of a user type
//                          (user_role_assignments). Never a seat of their own.
//
// A TIER DOES NOT RESTRICT WHICH USER TYPES MAY BE SEATED. IT RESTRICTS HOW MANY.
//
// ─── THE RULING THAT SUPERSEDED THE OLD ROLE MENU (owner, verbatim) ──────────
//
//   "so there is a solo agent tier subscription plan, that has 2 seats and a user
//    is the type of user it is. so for example ; solo tier subsprition plan is an
//    independent real estate agent with user type agent and can be granted
//    permission roles, then the second seat can be a user type of admin and given
//    permission roles so the 2 seats are not taken up. a team is a team tier
//    subscription with 5 seats so can have a team lead user type given permission
//    roles, then an agent as a user type with permission roles, THEN A BROKER AS A
//    USER TYPE with different permisson roles which that takes up 3 of 5 seats; a
//    brokerage should be changed to 50 seats with a brokerage tier subscription
//    where a broker admin is a user type with differnt permission roles, then team
//    lead usertype with differnt permission roles then an agent usertype with
//    different permission roles. so that is 3 seats out of 50 and then the same
//    goes for multiple location brokerages but unlimited seats. everyone gets all
//    features pertaining to their needs."
//
// This file PREVIOUSLY withheld `broker` and `broker_owner` from solo and team.
// The sentence above seats a BROKER on TEAM tier explicitly, and counts it as one
// of the five. So the subtraction is gone: every tier's menu is now the SAME menu,
// and the tier's only say is the seat CAP.
//
// ─── THE EARLIER RULING IT COLLIDES WITH, AND WHY BOTH SURVIVE ───────────────
//
// EARLIER, owner: "if team tier subscriptions, they don't have a broker in the
// subscription so the team lead can see leads." m518 added `team_lead` to
// public.is_lead_visible_role() on that basis, and that grant MUST NOT be
// reverted.
//
// The two sentences do not actually contradict, and the proof is in the predicate
// rather than in the prose. READ LIVE (2026-08-22), is_lead_visible_role() is:
//
//     user_type IN ('broker','broker_owner','admin','team_lead','superadmin')
//     OR EXISTS (grant IN ('broker','broker_owner','admin','team_lead'))
//     OR is_ai_isa_system() OR is_platform_admin()
//
// It is PER-USER and takes NO tier argument and has NO "…and this tenant seats no
// broker" clause anywhere in it. Therefore seating a broker on a team tenant ADDS
// a second person who passes the predicate; it CANNOT remove the team lead from
// it. The earlier sentence supplied the MOTIVE for m518 (the team plan does not
// come with a broker, so by default nobody else is on the lead desk) — it was
// never a prohibition on buying one with a seat. "They don't have a broker IN THE
// SUBSCRIPTION" describes the PACKAGE, not the tenant's freedom to spend a seat.
//
// So: the menu opens (this file), and m518 stands untouched. Verified by
// scripts/lead-visibility-roster-simulator.ts, which pins the team lead's desk
// independently of anything here.
//
//   • SEATS: solo_agent = 2 · team = 5 · brokerage = 50 · multi_location =
//     unlimited. A "seat" is a working staff user (SEAT_ROLES). Partner
//     users, contacts, lenders and the AI-ISA system actor do NOT consume seats.
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

/**
 * Seat-consuming USER TYPES — the full staff roster of the OS. Every one of
 * these costs exactly ONE seat, on every tier.
 *
 * `broker_admin` is in this list on the owner's ruling ("a broker admin is a user
 * type with differnt permission roles") and on CLAUDE.md §4, whose tenant roster
 * is broker / broker_admin / broker_owner / team_lead / admin.
 *
 * ── broker_admin IS NOT STORABLE YET, AND THAT IS TRACKED, NOT HIDDEN ────────
 *
 * MEASURED LIVE 2026-08-22: users_user_type_check admits fourteen values and
 * `broker_admin` is NOT one of them, which is why m308 and m518 deliberately
 * REMOVED it from the RLS predicates ("the column cannot hold it"). Listing it
 * here is the PRODUCT truth; the DATABASE truth catches up in
 * supabase/migrations/m530-broker-admin-is-a-user-type-the-column-cannot-hold.sql
 * (WRITTEN, NOT APPLIED — CLAUDE.md §3).
 *
 * Nothing silently breaks in the meantime, because the invite menu is INTERSECTED
 * with the storable vocabulary — see `seatableUserTypes` below. Until m530 is
 * applied and the vocabulary cache regenerated, broker_admin is simply not
 * offered; the day it is, it appears with no further code change.
 * scripts/seat-cap-simulator.ts asserts that coupling in both directions.
 */
export const SEAT_ROLES: readonly UserDomainRole[] = [
  "admin", "broker", "broker_admin", "broker_owner", "team_lead", "agent", "tc", "isa", "compliance_officer",
]

/**
 * Canonical tier → invitable user types. THE matrix — every invite surface
 * derives from it.
 *
 * ── ONE MENU, FOUR TIERS, DELIBERATELY ──────────────────────────────────────
 *
 * There is no per-tier subtraction any more, and the four keys hold the SAME
 * expression rather than four literals. The owner's ruling makes the tier a SEAT
 * COUNT and nothing else — "everyone gets all features pertaining to their
 * needs" — so a tenant on any plan may seat any staff user type and spend their
 * seats as they like.
 *
 * The keys are kept (rather than collapsing to a single exported list) because
 * the tier remains the right place to hang a future per-tier rule, and because
 * every call site already asks the question tier-first. What is gone is the
 * ANSWER differing by tier.
 */
const ALL_SEATABLE_ROLES: readonly UserDomainRole[] = [...SEAT_ROLES, ...PARTNER_ROLES]

export const TIER_INVITABLE_ROLES: Record<CanonicalTier, readonly UserDomainRole[]> = {
  solo_agent:     ALL_SEATABLE_ROLES,
  team:           ALL_SEATABLE_ROLES,
  brokerage:      ALL_SEATABLE_ROLES,
  multi_location: ALL_SEATABLE_ROLES,
}

/**
 * Canonical tier → seat limit (null = unlimited). Seats count SEAT_ROLES users only.
 *
 * ── brokerage MOVED null → 50, TO CATCH UP WITH THE CATALOGUE ───────────────
 *
 * OWNER: "a brokerage should be changed to 50 seats". The live catalogue already
 * says so — MEASURED 2026-08-22, `subscription_tiers.max_agents` is
 * solo 2 / team 5 / brokerage 50 / multi NULL, and `plan_limits.active_users`
 * agrees (2 / 5 / 50 / -1). Both were moved live by m529.
 *
 * This literal still said `null`, i.e. UNLIMITED. It is the fallback used
 * whenever the catalogue cannot be read — a client bundle, or a refused read on a
 * display surface — so the one moment it speaks is the moment the real number is
 * unavailable, and it was answering "unlimited" for a 50-seat plan. That is a
 * fail-OPEN fallback on the seat axis, which CLAUDE.md §4 forbids. Now the two
 * agree, and scripts/seat-cap-simulator.ts pins this map against the live
 * catalogue so they cannot drift apart again.
 *
 * multi_location stays null: unlimited is the product, not a missing number.
 */
export const TIER_SEAT_LIMITS: Record<CanonicalTier, number | null> = {
  solo_agent:     2,
  team:           5,
  brokerage:      50,
  multi_location: null,
}

/**
 * UNLIMITED HAS TWO SPELLINGS IN THE CATALOGUE. This is the ONE place that
 * folds them, and it is pure so a client component can reach it.
 *
 * `subscription_tiers.max_agents` says unlimited as NULL (that is what the live
 * multi_location row holds) and historically also as -1 (what plan_limits
 * .active_users still uses, and what the upgrade modal was written against).
 * lib/kernel/seat-usage.ts `resolveCatalogSeatLimits` already folded both onto
 * null for the GATE — but three DISPLAY surfaces tested `max_agents === -1`
 * alone and therefore never recognised the spelling the database actually
 * stores:
 *
 *   · app/settings/billing/upgrade-modal.tsx    → "Up to null agents"
 *   · app/settings/billing/current-plan-card.tsx → "null agents"
 *   · app/settings/billing/usage-section.tsx     → a seat bar with max "null",
 *     fed from app/settings/billing/page.tsx `max_agents || 1`, which turns
 *     NULL into 1 — so the UNLIMITED plan printed a one-seat cap and drew its
 *     usage bar pegged over the limit.
 *
 * The gate was never wrong; only what the paying customer was shown. Same fold,
 * one implementation, so the number the tenant reads is the number enforced.
 *
 * Returns `null` for unlimited and a non-negative integer otherwise. Anything
 * unreadable is treated as unlimited ONLY here, where the answer is a LABEL —
 * seatLimitForTier below is the gate and keeps its own fail-closed direction.
 */
export function normalizeCatalogSeatLimit(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

/** Display string for a catalogue seat cap — "Unlimited" or the count. */
export function formatSeatLimit(raw: number | null | undefined): string {
  const n = normalizeCatalogSeatLimit(raw)
  return n === null ? "Unlimited" : String(n)
}

/**
 * Display string for a tenant's seat cap that DISTINGUISHES "no plan" from
 * "unlimited plan" — the second half of the NULL/-1 trap above.
 *
 * The fix recorded above folded NULL and -1 onto one another so the unlimited
 * plan stopped printing "null". It left a second reading of the SAME absent
 * value unaddressed: `formatSeatLimit(tier?.max_agents)` where the TIER ITSELF
 * is missing. `undefined` normalizes to null, so a tenant with NO subscription
 * row — which is every tenant on this database today, `subscriptions` holds 0
 * rows — was shown "No Plan" and "Unlimited seats" in the same card. An absent
 * entitlement rendered as the largest entitlement sold.
 *
 * That is the fail-open §4 forbids: "nobody checked" must never render as
 * "checked and fine". The unlimited answer must come from a catalogue row that
 * SAYS unlimited, never from the absence of a row. `hasTier` is the caller's
 * proof it read one.
 *
 * The GATE is unaffected and keeps its own direction — seatLimitForTier is
 * fail-closed; this is a label only.
 */
export function formatTenantSeatLimit(
  hasTier: boolean,
  raw: number | null | undefined,
): string {
  if (!hasTier) return "No plan"
  return formatSeatLimit(raw)
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
 * The invitable menu for an UNKNOWN / legacy / NULL tier.
 *
 * ── WHY THIS IS NOW THE SAME LIST, AND WHY THAT IS NOT A FAIL-OPEN ──────────
 *
 * It used to be the brokerage menu MINUS broker and broker_owner, because under
 * the old ruling a tier SUBTRACTED roles and "unknown tier ⇒ the widest tier"
 * would have inverted that subtraction where it was least visible.
 *
 * That reasoning is now moot: no tier subtracts anything, so there is no wider
 * and no narrower menu to fall into. Every tier's answer is this answer.
 *
 * The fail-CLOSED obligation did not go away — it MOVED to the axis that
 * actually carries the tier's constraint. `seatLimitForTier` below floors an
 * unreadable tier to the SMALLEST cap (solo, 2), and `seatGate`
 * (lib/kernel/seat-usage.ts) REFUSES outright when the tenant, the count or the
 * catalogue cannot be read. Being offered a user type you have no seat for costs
 * nothing and is caught one gate later; being handed a seat you did not buy is
 * the failure that matters, and that path is closed.
 */
const UNKNOWN_TIER_INVITABLE_ROLES: readonly UserDomainRole[] = ALL_SEATABLE_ROLES

// NO LONGER EXPORTED (CLAUDE.md §1). Every external caller — both invite
// surfaces, the settings role menu — now goes through `seatableUserTypes` below,
// which asks this the same question and then removes anything the database
// cannot store. Leaving BOTH exported would be two spellings of "what may this
// tenant seat" (§6), and the weaker one would eventually be picked by someone
// adding a third surface, reintroducing the unstorable-value bug on that surface
// alone. It stays as a module-private helper because `tierAllowsRole` and
// `seatableUserTypes` both build on it.
function invitableRolesForTier(tier: string | null | undefined): readonly UserDomainRole[] {
  return isCanonicalTier(tier) ? TIER_INVITABLE_ROLES[tier] : UNKNOWN_TIER_INVITABLE_ROLES
}

/**
 * The invitable menu, INTERSECTED with the user types the database can actually
 * store — the one place that keeps the product roster from writing a row the
 * CHECK constraint will refuse.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * `users_user_type_check` is VALIDATED and admits fourteen values. An INSERT
 * naming a fifteenth is refused ENTIRELY (CLAUDE.md §3 — not "most of the row":
 * nothing). So a menu offering a user type the column cannot hold is an invite
 * that cannot succeed, and the person clicking it gets a constraint violation
 * rather than a teammate.
 *
 * `broker_admin` is exactly that value today: the owner has ruled it a user type,
 * SEAT_ROLES lists it, and the column cannot yet hold it until m530 is applied.
 * Rather than a flag day — flip the code and the migration in the same breath and
 * hope the order holds — the menu is derived from what the database SAYS it
 * admits. Before m530: broker_admin is absent, and every other role is
 * unaffected. After m530 + `npm run schema:regen:vocabularies`: it appears, with
 * no code change and no second deploy.
 *
 * `storable` is passed IN rather than imported, because this module is
 * client-bundle-safe by contract (see the file header) and the generated
 * vocabulary cache is ~1600 lines. Server call sites pass
 * `CHECK_VOCABULARIES.users.user_type`; a client surface that has no cache passes
 * nothing and gets the full product menu, which is what it renders today.
 *
 * FAILS CLOSED ON AN EMPTY/UNREADABLE VOCABULARY BY DOING NOTHING: an empty list
 * means "we could not read what is storable", and silently returning an EMPTY
 * menu would brick every invite surface on the platform. The refusal that matters
 * is the database's own, which is still there. So an unusable vocabulary is
 * ignored and the product menu stands.
 */
export function seatableUserTypes(
  tier: string | null | undefined,
  storable?: readonly string[] | null,
): readonly UserDomainRole[] {
  const menu = invitableRolesForTier(tier)
  if (!storable || storable.length === 0) return menu
  const admitted = new Set(storable)
  const filtered = menu.filter((r) => admitted.has(r))
  // A vocabulary that admits NONE of the menu is not a vocabulary — it is a bad
  // read. Never brick the surface on it.
  return filtered.length === 0 ? menu : filtered
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

// TOMBSTONE (lane A): `minimumTierForRole(role)` DELETED.
//
// It answered "which is the cheapest tier that unlocks this role?", and it had
// exactly three callers — app/actions/admin/invite-user.ts,
// app/actions/admin/update-user.ts, app/actions/superadmin/tenant-users.ts —
// all three composing the same sentence: "The {tier} plan does not include the
// '{role}' role. Upgrade to {X}…".
//
// THE QUESTION NO LONGER HAS A MEANINGFUL ANSWER. Under the owner's ruling every
// tier seats every staff user type, so the function could only ever return
// `solo_agent` (for anything seatable) or `null` (for anything that is not a
// seat on any plan) — and in the `null` case no upgrade exists to name. Keeping
// it would leave a function whose entire output is a constant, wired into copy
// that tells a tenant to buy a tier that would change nothing.
//
// WHERE THE JOB WENT: `roleRefusalReason` below. It answers what those three
// call sites actually needed — WHY was this refused — and it never offers an
// upgrade, because a refusal is no longer about the plan. All three now call it.
//
// The seat axis kept its upgrade copy: `seatDecision` / `seatDecisionMessage`
// still name the next tier up, because THAT refusal genuinely is about the plan.

/**
 * WHY was this user type refused? The honest sentence, now that a tier never
 * withholds one.
 *
 * The old copy — "The {tier} plan does not include the '{role}' role. Upgrade to
 * {X}…" — was true under the subtraction ruling and is a LIE under this one. The
 * only user types `tierAllowsRole` still refuses are the ones that are not tenant
 * staff seats at all, on any plan: platform identities (`superadmin`, `support`),
 * non-staff people (`contact`, `system`), and `lender`, which is a vendor
 * CATEGORY rather than a role (see PARTNER_ROLES). No upgrade buys any of them,
 * so no upgrade is offered.
 *
 * Returns null when the role IS allowed — callers should not be composing a
 * refusal at all in that case.
 */
export function roleRefusalReason(role: UserDomainRole | string): string | null {
  if ((ALL_SEATABLE_ROLES as readonly string[]).includes(role)) return null
  if (role === "superadmin" || role === "support") {
    return `'${role}' is a platform staff identity, not a workspace seat. It cannot be assigned from a workspace on any plan.`
  }
  if (role === "lender") {
    return "Lenders join through the vendor directory, not as a workspace seat — invite them as a vendor and pick the lender category."
  }
  return `'${role}' is not a workspace seat and cannot be invited on any plan.`
}

/** Safe label for error copy — canonical tiers get their label, anything else "current". */
export function tierLabel(tier: string | null | undefined): string {
  return isCanonicalTier(tier) ? TIER_LABELS[tier] : "current"
}
