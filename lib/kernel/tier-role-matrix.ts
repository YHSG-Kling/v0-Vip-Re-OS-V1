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
//   2. SEATS               2 / 10 / 30 / custom (TIER_SEAT_BANDS) + purchased
//                          seat packages. The ONLY tier-imposed limit.
//   3. USER TYPE           what a person IS. One per user. Costs ONE seat when
//                          it is a PRODUCER (roleConsumesSeat); staff cost none.
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
//   • SEATS: solo_agent = 2 · team = 10 · brokerage = 30 · multi_location =
//     custom (lib/billing/plan-catalog.ts TIER_SEAT_BANDS — the ONE
//     derivation; wave 79A, owner 2026-09-23: "solo tier is 2 seats; team tier
//     is 10 seats; brokerage tier is 30 seats; multi location tier is custom
//     pricing for seats", superseding wave 78A's 2/5/∞/∞). A "seat" is a
//     LICENSED PRODUCER (see the three rosters below); staff, partner users,
//     contacts, lenders and the AI-ISA system actor do NOT consume seats.
//   • THE LIMIT IS A DOOR WITH THREE WAYS THROUGH — OWNER, VERBATIM (wave 79A),
//     SUPERSEDING "over the limit is an upgrade, not a paid extra seat":
//
//       "there will be an opportunity for buying more seat packages and if the
//        tenant hits a limit they will be able to either upgrade to a higher
//        tier (or lower tier if their business changes) or buy more seats."
//
//     So a producer add past the EFFECTIVE limit (band + purchased extra seats)
//     is refused, and the refusal offers (1) the next tier UP whose band fits,
//     (2) a tier DOWN when the producers they already have fit on it — the
//     business-changed path, never a way past the limit — and (3) a SEAT
//     PACKAGE, quoted from the catalogue (seat_package_size /
//     seat_package_price_cents, synced from Stripe), never from a literal.
//     A tier whose seat price is not linked in Stripe cannot sell a package,
//     and the door says so instead of showing a button that charges nothing.
//     multi_location has no band: its seats are negotiated
//     (subscriptions.custom_seat_limit) and past them the answer is a person.
//     A staff-set override is still a deliberate cap: it is not answered with
//     an upgrade, only with the package (or a person when none is sellable).
//   • WHO IS A PRODUCER (wave 80A, owner: "brokers and broker owners can be a
//     producing seat."): agent and team_lead by type; broker and broker_owner
//     by type UNLESS the tenant marks them non-producing; admin while they
//     hold an agents record; everyone else never. See the four rosters below.
//
//     TOMBSTONE — `ADDITIONAL_SEAT_MONTHLY_USD` (a $25 literal) and the
//     `upgrade_offered` / `paid_seat_only` outcomes are retired here. Survivor
//     for the price: the catalogue row (lib/billing/plan-catalog.ts
//     SeatPackageFacts, read by lib/kernel/seat-usage.ts
//     resolveCatalogSeatLimits). Survivor for the outcome: `SeatDecision.paths`.
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
import { TIER_SEAT_BANDS, seatPackageSellable, seatPackagesNeeded, type SeatPackageCatalog, type SeatPackageFacts } from "@/lib/billing/plan-catalog"
import { requiresAgentRow } from "./tenant-provisioning-spec"

/** Partner roles every tier may invite (never seat-consuming). Vendor ONLY —
 *  lenders are a vendor category, not a role. */
export const PARTNER_ROLES: readonly UserDomainRole[] = ["vendor"]

// ─── WHAT A SEAT IS (wave 78A, owner verbatim 2026-09-22) ────────────────────
//
//   "staff should not take up seats. need your expertise to confirm that."
//
// Confirmed, and this is the industry norm the OS now follows: a seat is a
// LICENSED PRODUCER — the person whose book of business the subscription
// exists to run. Follow Up Boss, Lofty, Sierra and BoldTrail all price the
// producing user; admins, transaction coordinators, ISAs, marketing and
// compliance staff are either free or on a separate allowance, never the
// thing the plan counts. The previous roster (`SEAT_ROLES`, retired below)
// charged a seat for every working user type, so a solo agent who hired a TC
// was at 2 of 2 and could not add a second agent — the plan was measuring the
// wrong thing.
//
// FOUR ROSTERS, ONE PREDICATE (`roleConsumesSeat`):
//
//   PRODUCER_SEAT_ROLES        a seat by TYPE. agent and team_lead always carry
//                              a book of business (AGENT_ROLES in
//                              tenant-provisioning-spec.ts) and always count.
//
//   LICENSED_SEAT_ROLES        a seat by TYPE — UNLESS THE TENANT EXEMPTS THEM.
//                              (wave 80A, owner verbatim 2026-09-23: "brokers
//                              and broker owners can be a producing seat.")
//                              broker and broker_owner are licensed producers:
//                              the industry norm (Follow Up Boss, Sierra, Lofty,
//                              BoldTrail, TotalBrokerage, BrokerTeq — every
//                              login on the roster is a priced user and the
//                              selling owner is the first one) is that the
//                              broker-owner who sells counts, and the ONE
//                              exemption vendors sell is an explicit non-
//                              producing / admin-only licence. So the default
//                              is a seat, and the exemption is a STATEMENT the
//                              tenant makes — `produces: false` — recorded on
//                              brokerages.billing_metadata.non_producing_user_ids
//                              (parseNonProducingUserIds; written only by the
//                              tenant's commerce admin or the invite that seats
//                              them as staff). Never inferred from the agents
//                              table: a broker of record with no agents row is
//                              still a licensed producer until someone says
//                              otherwise. The previous rule ("brokers count
//                              only if they produce", wave 78A) inferred the
//                              opposite from that same absence, so a selling
//                              broker seated without an agents row was FREE —
//                              the plan under-billed the person it is sold to.
//
//   SEAT_BY_PRODUCTION_ROLES   a seat ONLY WHILE THEY PRODUCE. admin is staff —
//                              EXCEPT that the solo/team tenant OWNER is
//                              provisioned as `admin` wearing an agents row
//                              (provisionTenantOwner + requiresAgentRow), and
//                              that owner IS the producing agent the plan is
//                              sold to. So admin counts exactly when they hold
//                              an active `agents` record.
//
//   FREE_STAFF_ROLES           never a seat, even when the desk gave them an
//                              agents record for operational reasons (the ISA
//                              holds contacts, so AGENT_ROLES seeds one; that
//                              is a desk, not a licence).
//
// The solo owner is therefore still seat 1 of 2 (they produce), a TC or ISA
// they hire is free, and their second seat is a second producer. A broker on
// a team tenant is seat 3 of 10 the day they are seated, and seat 0 the day
// the tenant marks them non-producing. Positive controls in
// scripts/seat-cap-simulator.ts, scripts/seat-bands-guard.ts and
// scripts/seat-producer-roles-guard.ts pin every direction: a staff add never
// moves the count, a broker add DOES, an exempted broker does not, the 11th
// team producer is refused.
export const PRODUCER_SEAT_ROLES: readonly UserDomainRole[] = ["agent", "team_lead"]
export const LICENSED_SEAT_ROLES: readonly UserDomainRole[] = ["broker", "broker_owner"]
export const SEAT_BY_PRODUCTION_ROLES: readonly UserDomainRole[] = ["admin"]
export const FREE_STAFF_ROLES: readonly UserDomainRole[] = ["broker_admin", "tc", "isa", "compliance_officer"]

/**
 * The full WORKING roster of the OS — every user type a tenant may seat at a
 * desk, seat-consuming or not. This is the INVITE MENU (with PARTNER_ROLES),
 * not the seat count: `roleConsumesSeat` below decides who is billed.
 *
 * TOMBSTONE — `SEAT_ROLES` (this same nine-name list) was retired in wave 78A
 * because its name asserted that every entry consumed a seat, and the owner
 * ruled that staff do not. Nothing merged: the roster is unchanged, only its
 * meaning split into "may be seated" (here) and "is billed" (the four lists
 * above). Survivor for the billing question: `roleConsumesSeat`,
 * this file; for the count: lib/kernel/seat-usage.ts resolveSeatUsage.
 *
 * `broker_admin` is here on the owner's ruling ("a broker admin is a user type
 * with differnt permission roles") and CLAUDE.md §4's tenant roster; m530 made
 * it storable and the live vocabulary now admits it. The invite menu is still
 * INTERSECTED with the storable vocabulary (`seatableUserTypes`), so a future
 * product-only user type is never offered before its migration lands.
 */
export const WORKSPACE_STAFF_ROLES: readonly UserDomainRole[] = [
  ...PRODUCER_SEAT_ROLES, ...LICENSED_SEAT_ROLES, ...SEAT_BY_PRODUCTION_ROLES, ...FREE_STAFF_ROLES,
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
const ALL_SEATABLE_ROLES: readonly UserDomainRole[] = [...WORKSPACE_STAFF_ROLES, ...PARTNER_ROLES]

export const TIER_INVITABLE_ROLES: Record<CanonicalTier, readonly UserDomainRole[]> = {
  solo_agent:     ALL_SEATABLE_ROLES,
  team:           ALL_SEATABLE_ROLES,
  brokerage:      ALL_SEATABLE_ROLES,
  multi_location: ALL_SEATABLE_ROLES,
}

/**
 * Canonical tier → seat limit (null = unlimited). Seats count PRODUCERS only
 * (roleConsumesSeat).
 *
 * ── NOT A SECOND TABLE: THE SAME OBJECT AS TIER_SEAT_BANDS ──────────────────
 *
 * This used to be a literal — 2 / 5 / 50 / null — kept "in agreement with the
 * catalogue by a migration". It drifted anyway: the owner's 2026-09-22 ruling
 * moved the numbers, and three files held three numbers. The fallback
 * the gate uses when the catalogue cannot be read is now BY IDENTITY the one
 * product statement in lib/billing/plan-catalog.ts (`TIER_SEAT_LIMITS ===
 * TIER_SEAT_BANDS`, asserted by scripts/seat-bands-guard.ts), so there is
 * nothing left to keep in agreement. The name survives because thirty-odd
 * call sites and proofs read it and it says exactly what it is here: the
 * limit a tier imposes.
 *
 * It still fails CLOSED where it must: an unknown tier resolves to the floor
 * (seatLimitForTier), and the GATE refuses outright when the catalogue read
 * is refused (lib/kernel/seat-usage.ts) rather than falling to this.
 */
export const TIER_SEAT_LIMITS: Readonly<Record<CanonicalTier, number | null>> = TIER_SEAT_BANDS

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

/**
 * Does this role consume a seat? THE predicate — the count (resolveSeatUsage)
 * and the gate (seatGate) both ask it, so the meter and the refusal cannot
 * disagree about who is billed.
 *
 *   producer by type          → true
 *   licensed role             → true UNLESS `produces` is EXPLICITLY false
 *   (broker, broker_owner)      (the tenant's exemption). Undefined is not an
 *                               exemption: "nobody said" means a licensed
 *                               producer is billed (wave 80A).
 *   seat-by-production role   → `produces` (holds / will hold an active agents
 *   (admin)                     record). Absent that fact the answer is FALSE:
 *                               an admin is staff until they sell.
 *   free staff / partner /
 *   contact / system / platform → false, whatever else is true
 *
 * `produces` is a FACT the caller supplies, with three values: true (an agents
 * record / the caller's statement), false (the tenant's exemption — the meter
 * reads billing_metadata.non_producing_user_ids, the gate takes the invite's
 * statement) and undefined (no statement). The resolver and the gate hand it
 * over; it is never inferred here from the role alone, because that is the
 * inference the retired SEAT_ROLES made.
 */
export function roleConsumesSeat(role: UserDomainRole | string, opts?: { produces?: boolean }): boolean {
  if ((PRODUCER_SEAT_ROLES as readonly string[]).includes(role)) return true
  if ((LICENSED_SEAT_ROLES as readonly string[]).includes(role)) return opts?.produces !== false
  if ((SEAT_BY_PRODUCTION_ROLES as readonly string[]).includes(role)) return opts?.produces === true
  return false
}

/**
 * PURE: will a person invited as `role` onto a tenant on `tier` produce?
 * A LICENSED role produces by type on every tier (the broker of record on a
 * brokerage tenant gets no agents row from the provisioning spec, and is a
 * producer regardless — the spec answers "who needs an agents ROW", not "who
 * is billed"). For everyone else the provisioning spec already answers "does
 * this (role, tier) get an agents row" — that IS production for the
 * seat-by-production admin (the solo/team owner is an admin wearing an agents
 * row; a brokerage-tier admin is not). FREE_STAFF_ROLES are excluded before
 * the spec is consulted so the ISA's operational agents row never reads as a
 * licence.
 */
export function roleProducesOnTier(role: UserDomainRole | string, tier: string | null | undefined): boolean {
  if ((FREE_STAFF_ROLES as readonly string[]).includes(role)) return false
  if ((LICENSED_SEAT_ROLES as readonly string[]).includes(role)) return true
  return requiresAgentRow(role, tier ?? null)
}

/**
 * PURE: the tenant's NON-PRODUCING exemptions out of brokerages.billing_metadata
 * ({ ..., non_producing_user_ids: [<users.id>, …] }). The ids are users.id —
 * NEVER agents.id (the two classes are disjoint, CLAUDE.md §3; the meter joins
 * the agents table through agents.user_id and looks this list up by the users
 * row, so one person can never be counted twice or exempted by the wrong id).
 * Anything that is not an array of non-empty strings reads as NO exemptions —
 * a malformed blob must fail toward BILLING the licensed producer, never toward
 * a free seat. Written only by lib/kernel/seat-usage.ts setLicensedProducerExemption
 * (the tenant's commerce admin from the seat door, or an invite that seats a
 * broker as staff with `produces: false`).
 */
export function parseNonProducingUserIds(billingMetadata: unknown): ReadonlySet<string> {
  if (!billingMetadata || typeof billingMetadata !== "object") return new Set()
  const raw = (billingMetadata as Record<string, unknown>).non_producing_user_ids
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((v): v is string => typeof v === "string" && v.trim() !== ""))
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
 * The tenant-side seat facts that sit ON TOP of the tier band (wave 79A):
 * purchased extra seats (seat packages × size, synced from the Stripe
 * subscription item) and, for the custom tier, the negotiated seat count.
 * Read from `subscriptions` by lib/kernel/seat-usage.ts resolveTenantSeatTerms.
 */
export interface TenantSeatTerms {
  /** Seats purchased beyond the band (subscriptions.extra_seats). */
  extraSeats?: number | null
  /** Package units purchased (subscriptions.seat_packages) — for copy only. */
  seatPackages?: number | null
  /** multi_location: the negotiated seat count (subscriptions.custom_seat_limit). */
  customSeatLimit?: number | null
}

/**
 * PURE keep-one seat-limit resolution. Base = the staff override when set (it
 * can raise a capped tier or cap an unlimited one), else the tenant's
 * negotiated custom count, else the tier band. The EFFECTIVE limit is base +
 * purchased extra seats; a null base (custom tier, nothing negotiated) stays
 * unlimited. Every seat surface — both invite gates and the seat meter —
 * resolves through THIS.
 */
export function effectiveSeatLimit(
  tier: string | null | undefined,
  seatOverride?: number | null,
  catalog?: CatalogSeatLimits | null,
  terms?: TenantSeatTerms | null,
): { limit: number | null; bandLimit: number | null; extraSeats: number; overridden: boolean; custom: boolean } {
  const extraSeats = Math.max(0, Math.floor(Number(terms?.extraSeats ?? 0)) || 0)
  const custom = typeof terms?.customSeatLimit === "number" && Number.isInteger(terms.customSeatLimit) && terms.customSeatLimit >= 0
  const band = seatLimitForTier(tier, catalog)
  let base: number | null
  let overridden = false
  if (seatOverride !== null && seatOverride !== undefined) { base = seatOverride; overridden = true }
  else if (custom) base = terms!.customSeatLimit as number
  else base = band
  return { limit: base === null ? null : base + extraSeats, bandLimit: band, extraSeats, overridden, custom: custom && !overridden }
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
  terms?: TenantSeatTerms | null,
): {
  allowed: boolean
  limit: number | null
  remaining: number | null
  /** true when the limit came from the staff-set per-tenant override, not the tier. */
  overridden: boolean
} {
  const d = seatDecision(tier, currentSeatCount, seatOverride, 1, catalog, { terms })
  return { allowed: d.withinLimit, limit: d.limit, remaining: d.remaining, overridden: d.overridden }
}

export type SeatOutcome =
  /** Inside the effective limit — nothing to decide. */
  | "within_limit"
  /** Past it: the door opens with the paths below (never a wall). */
  | "over_limit"

/** One way through the limit door (wave 79A). */
export type SeatPath =
  /** The next tier UP whose band fits the request. */
  | { kind: "upgrade"; tier: CanonicalTier; seats: number | null }
  /** A tier DOWN the tenant's CURRENT producers still fit on — the
   *  "business changed" path. It never admits the requested seat. */
  | { kind: "downgrade"; tier: CanonicalTier; seats: number | null }
  /** Buy seat packages on the current tier: `packages` units of `size`
   *  seats at `priceCents` per unit per month, from the catalogue. */
  | { kind: "buy_seats"; size: number; priceCents: number; packages: number; seatsAdded: number }
  /** Custom pricing (multi_location, an unpriced package, or a staff cap): a
   *  person decides — the door names who, never a number. */
  | { kind: "contact"; reason: "custom_pricing" | "package_not_sellable" | "staff_cap" }

export interface SeatDecision {
  outcome: SeatOutcome
  /** May the seat be added right now, without a billing choice? */
  withinLimit: boolean
  /** The EFFECTIVE limit: band (or override / custom count) + extra seats. */
  limit: number | null
  /** The tier band alone (TIER_SEAT_BANDS / catalogue), before extra seats. */
  bandLimit: number | null
  /** Purchased seats beyond the band (seat packages × size). */
  extraSeats: number
  remaining: number | null
  overridden: boolean
  /** The tier to recommend upward, when one fits (also in `paths`). */
  upgradeTo: CanonicalTier | null
  /** Seats the recommended tier would give them (null = custom/unlimited). */
  upgradeSeats: number | null
  /** The tier the tenant could step DOWN to and still fit today's producers. */
  downgradeTo: CanonicalTier | null
  downgradeSeats: number | null
  /** Every way through the door, in the order the copy states them. Empty
   *  only when withinLimit. */
  paths: SeatPath[]
  /** How many extra seats this request would put them over by. */
  seatsOver: number
}

/**
 * PURE: WHAT HAPPENS WHEN A TENANT ASKS FOR A SEAT THEY HAVE NOT PAID FOR?
 *
 * Not a wall. Owner (wave 79A): "if the tenant hits a limit they will be able
 * to either upgrade to a higher tier (or lower tier if their business
 * changes) or buy more seats." Inside the effective limit, proceed silently.
 * Over it, the decision carries every path that is genuinely open:
 *
 *   upgrade    the next tier up whose band fits the request (catalogue first)
 *   downgrade  the highest tier BELOW whose band fits the producers already
 *              seated — offered because the owner said so, and stated as what
 *              it is (it does not admit the requested seat)
 *   buy_seats  the tier's seat package, quoted from `packages` — only when it
 *              is SELLABLE (size, price and a Stripe price all present)
 *   contact    custom pricing (multi_location), an unpriced package, or a
 *              staff-set cap — a person, never an invented number
 *
 * A staff override is a deliberate cap, so it is never answered with
 * "upgrade"; it is answered with the package or a person.
 */
export function seatDecision(
  tier: string | null | undefined,
  currentSeatCount: number,
  seatOverride?: number | null,
  seatsRequested = 1,
  catalog?: CatalogSeatLimits | null,
  seat?: { terms?: TenantSeatTerms | null; packages?: SeatPackageCatalog | null } | null,
): SeatDecision {
  const { limit, bandLimit, extraSeats, overridden, custom } = effectiveSeatLimit(tier, seatOverride, catalog, seat?.terms)
  // The tier the tenant is ON is resolved the same fail-CLOSED way the limit is
  // (unknown ⇒ the floor), so a tenant whose plan_tier cannot be read is still
  // told where to go — "unreadable" must not read as "nothing to offer".
  const fromTier: CanonicalTier = isCanonicalTier(tier) ? tier : TIER_ORDER[0]
  const fromIndex = TIER_ORDER.indexOf(fromTier)

  // DOWN is computed whether or not the tenant is over: the highest lower tier
  // whose band still fits today's producers (the CURRENT count, not the
  // request — a downgrade is a business change, not a way past the limit).
  // It is carried on every decision so the billing surface can offer "move
  // down" to a tenant whose business shrank, and it joins `paths` at the door.
  // Never offered against a staff cap or a negotiated custom count.
  let downgradeTo: CanonicalTier | null = null
  let downgradeSeats: number | null = null
  if (!overridden && !custom) {
    for (const t of TIER_ORDER.slice(0, fromIndex).reverse()) {
      const s = seatLimitForTier(t, catalog)
      if (s !== null && s >= currentSeatCount) { downgradeTo = t; downgradeSeats = s; break }
    }
  }

  const base: SeatDecision = {
    outcome: "within_limit",
    withinLimit: true,
    limit,
    bandLimit,
    extraSeats,
    remaining: limit === null ? null : Math.max(0, limit - currentSeatCount),
    overridden,
    upgradeTo: null,
    upgradeSeats: null,
    downgradeTo,
    downgradeSeats,
    paths: [],
    seatsOver: 0,
  }
  if (limit === null) return base
  // Math.max(0, …), not max(1, …): a caller asking about the CURRENT state passes
  // 0, and clamping that to 1 invented an overage for a tenant sitting exactly at
  // their limit — the settings panel would have nagged a healthy full plan.
  const after = currentSeatCount + Math.max(0, seatsRequested)
  if (after <= limit) return base

  const seatsOver = after - limit
  const paths: SeatPath[] = []

  // (1) UP — the next tier whose band fits the request. Catalogue first: the
  //     copy must quote the seats the tenant will actually be sold. Never
  //     offered against a staff cap (it would send a tenant to buy a tier they
  //     may already be on) or a negotiated custom count.
  let upgradeTo: CanonicalTier | null = null
  let upgradeSeats: number | null = null
  if (!overridden && !custom) {
    for (const t of TIER_ORDER.slice(fromIndex + 1)) {
      const s = seatLimitForTier(t, catalog)
      if (s === null || s >= after) { upgradeTo = t; upgradeSeats = s; break }
    }
  }
  if (upgradeTo) paths.push({ kind: "upgrade", tier: upgradeTo, seats: upgradeSeats })

  // (2) DOWN — joins the door when it fits (computed above).
  if (downgradeTo) paths.push({ kind: "downgrade", tier: downgradeTo, seats: downgradeSeats })

  // (3) BUY — the tier's seat package, only when the catalogue can actually
  //     sell it. multi_location sells no package: custom pricing is a person.
  const facts: SeatPackageFacts | null | undefined = seat?.packages?.[fromTier]
  if (fromTier === "multi_location" || custom) {
    paths.push({ kind: "contact", reason: "custom_pricing" })
  } else if (seatPackageSellable(facts)) {
    const packages = seatPackagesNeeded(seatsOver, facts.size)
    paths.push({ kind: "buy_seats", size: facts.size, priceCents: facts.priceCents, packages, seatsAdded: packages * facts.size })
  } else if (overridden) {
    paths.push({ kind: "contact", reason: "staff_cap" })
  } else {
    paths.push({ kind: "contact", reason: "package_not_sellable" })
  }

  return {
    ...base,
    outcome: "over_limit",
    withinLimit: false,
    remaining: 0,
    upgradeTo,
    upgradeSeats,
    downgradeTo,
    downgradeSeats,
    paths,
    seatsOver,
  }
}

/** Dollars from integer cents for copy — "$49" or "$49.50", never float math on money. */
function centsLabel(cents: number): string {
  const whole = Math.floor(cents / 100)
  const rest = cents % 100
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`
}

/**
 * PURE: the sentence a tenant reads when they ask for a seat past their limit.
 * It is a REFUSAL and it is also a product moment: it says what they have and
 * every way through — upgrade, downgrade when it fits, buy seats when the
 * package is sellable — and hands off to a person where pricing is custom.
 * The only dollar figure it ever quotes is the catalogue's package price.
 */
export function seatDecisionMessage(d: SeatDecision): string | null {
  if (d.withinLimit) return null
  const over = `${d.seatsOver} seat${d.seatsOver === 1 ? "" : "s"}`
  const have = d.extraSeats > 0
    ? `Your plan includes ${d.bandLimit ?? d.limit} seats plus ${d.extraSeats} purchased, and all ${d.limit} are in use`
    : `Your plan includes ${d.limit} seats and all ${d.limit} are in use`
  const options: string[] = []
  for (const p of d.paths) {
    if (p.kind === "upgrade") options.push(`upgrade to ${TIER_LABELS[p.tier]} for ${p.seats === null ? "custom seats" : `${p.seats} seats`}`)
    else if (p.kind === "buy_seats") options.push(`buy ${p.packages} seat package${p.packages === 1 ? "" : "s"} (${p.size} seats each, ${centsLabel(p.priceCents)}/month per package)`)
    else if (p.kind === "downgrade") options.push(`or, if your business has changed, move down to ${TIER_LABELS[p.tier]} (${p.seats} seats — your current team fits)`)
    else if (p.reason === "custom_pricing") options.push("seats on this plan are priced for you — contact us to add more")
    else if (p.reason === "staff_cap") options.push("your seat count was set by platform staff — contact support to raise it")
    else options.push("seat packages for this plan are not on sale yet — contact us")
  }
  return `${have} — that is ${over} more. You can ${options.join("; ")}.`
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
