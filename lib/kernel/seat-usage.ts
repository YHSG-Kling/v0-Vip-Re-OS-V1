// lib/kernel/seat-usage.ts
// ─────────────────────────────────────────────────────────────────────────────
// HOW MANY SEATS IS THIS TENANT USING? One answer, and it counts USERS.
//
// A seat is a PERSON, not a role. The OS assigns roles two ways and both are
// real:
//
//   users.user_type          the user's primary type — what most surfaces read
//   user_role_assignments    the RBAC table: a user may hold SEVERAL roles
//                            (live today: 2 users hold more than one, and 3
//                            assignments disagree with that user's user_type)
//
// Counting only `user_type` therefore under-counts by construction: a user whose
// primary type is not a seat role but who has been ASSIGNED one — an admin also
// carrying agent, a contact granted isa — held a seat the meter could not see. It
// happens to agree on today's data, which is exactly why it would have gone
// unnoticed until a tenant slipped past their limit.
//
// So: a user consumes ONE seat if they are not suspended and ANY of their roles
// (primary or assigned) is seat-consuming. Distinct users, never role rows —
// giving a user a second role must never charge them twice.
//
// AND A SEAT IS A PRODUCER (wave 78A, owner: "staff should not take up seats").
// The third read below is the `agents` table: a broker, broker_owner or admin
// counts only while they hold an ACTIVE agents record (they produce — the
// solo/team owner is exactly this), an agent or team_lead counts by type, and
// free staff (broker_admin, tc, isa, compliance_officer) never count even when
// the desk seeded them an agents row. The predicate is lib/kernel/
// tier-role-matrix.ts roleConsumesSeat — this file supplies the FACT it needs.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  isCanonicalTier, roleConsumesSeat, roleProducesOnTier, WORKSPACE_STAFF_ROLES,
  seatDecision, seatDecisionMessage, parseSeatOverride,
  normalizeCatalogSeatLimit,
  type CatalogSeatLimits, type SeatDecision,
} from "./tier-role-matrix"
import type { UserDomainRole, CanonicalTier } from "./users"

type Svc = SupabaseClient<any, any, any>

export interface SeatUsage {
  /**
   * DID THE COUNT ACTUALLY GET COUNTED? supabase-js RESOLVES a refused query
   * (CLAUDE.md §3), so a zero here is otherwise indistinguishable from "this
   * read was refused" — and a zero on an ENFORCEMENT path admits every add.
   * Display surfaces may ignore this and render an honest empty state; a gate
   * must REFUSE on `ok: false`.
   */
  ok: boolean
  /** Distinct non-suspended PRODUCERS (roleConsumesSeat with the agents-record fact). */
  seatCount: number
  /** Their user ids — so a surface can show WHO, not just how many. */
  seatHolderIds: string[]
  /** Everyone in the workspace, seat-holding or not (partners, contacts, system). */
  peopleCount: number
  /** Non-suspended working staff who hold NO seat (admin, tc, isa, compliance,
   *  broker_admin, a non-producing broker) — shown beside the seat count so a
   *  tenant sees that staff are free rather than uncounted. */
  freeStaffCount: number
  /**
   * Every DISTINCT role in use by a non-suspended seat holder, from BOTH sources.
   *
   * Exists for the owner's agent-role advisory: "they can use those seats anyway
   * they want but if they don't use atleast 1 agent role, then they won't get much
   * out of the system." Answering that needs the roles, not just the count — and it
   * must consider assigned roles too, or an admin who also carries agent would read
   * as a workspace with no agent.
   */
  rolesInUse: string[]
}

/**
 * Resolve a brokerage's seat usage. Never throws — a read failure returns zeroes
 * rather than a misleading number, and the caller renders an honest empty state.
 */
export async function resolveSeatUsage(svc: Svc, brokerageId: string): Promise<SeatUsage> {
  const [usersRes, rolesRes, agentsRes] = await Promise.all([
    svc.from("users").select("id, user_type, status").eq("brokerage_id", brokerageId),
    svc.from("user_role_assignments").select("user_id, role").eq("brokerage_id", brokerageId),
    // The PRODUCTION fact — an active agents record is what makes a broker,
    // broker_owner or admin a seat. agents.user_id → users.id (the two id
    // classes are disjoint, CLAUDE.md §3; this is the documented crossing).
    svc.from("agents").select("user_id, is_active").eq("brokerage_id", brokerageId),
  ])

  // ALL THREE reads must have succeeded for the number to mean anything: the
  // seat count is a UNION over users.user_type and user_role_assignments,
  // qualified by the agents table, so a refusal on any part silently
  // under-counts, which on a gate is an admit.
  const ok = !usersRes.error && !rolesRes.error && !agentsRes.error

  const users = (usersRes.data ?? []) as Array<{ id: string; user_type: string | null; status: string | null }>
  const assignments = (rolesRes.data ?? []) as Array<{ user_id: string | null; role: string | null }>
  const agentRows = (agentsRes.data ?? []) as Array<{ user_id: string | null; is_active: boolean | null }>

  // user_id → who produces (an agents row that is not switched off). A row
  // with is_active NULL is treated as active — the column defaults true and a
  // NULL is an unbackfilled row, not a deactivated agent.
  const producing = new Set<string>()
  for (const a of agentRows) if (a.user_id && a.is_active !== false) producing.add(a.user_id)

  // user_id → every role they hold by ASSIGNMENT
  const assignedRoles = new Map<string, string[]>()
  for (const a of assignments) {
    if (a.user_id && a.role) assignedRoles.set(a.user_id, [...(assignedRoles.get(a.user_id) ?? []), a.role])
  }

  const rolesOf = (u: { id: string; user_type: string | null }): string[] =>
    [u.user_type ?? "", ...(assignedRoles.get(u.id) ?? [])].filter(Boolean)

  const working = users.filter((u) => u.status !== "suspended")
  const holders = working.filter((u) =>
    rolesOf(u).some((r) => roleConsumesSeat(r, { produces: producing.has(u.id) })),
  )
  const holderIds = new Set(holders.map((u) => u.id))
  // Free staff: working people who hold a WORKSPACE role but no seat.
  const staffRoles = new Set<string>(WORKSPACE_STAFF_ROLES as readonly string[])
  const freeStaff = working.filter((u) => !holderIds.has(u.id) && rolesOf(u).some((r) => staffRoles.has(r)))

  // Roles actually in use across both sources, restricted to seat holders — a
  // suspended user's role is not "in use", and a partner's never was. A holder
  // who produces is reported as holding the agent role too: the agent-role
  // advisory asks "does anyone here carry a book of business", and an admin
  // owner wearing an agents row does.
  const rolesInUse = new Set<string>()
  for (const u of holders) {
    for (const r of rolesOf(u)) if (staffRoles.has(r)) rolesInUse.add(r)
    if (producing.has(u.id)) rolesInUse.add("agent")
  }

  return {
    ok,
    seatCount: holders.length,
    seatHolderIds: holders.map((u) => u.id),
    peopleCount: users.length,
    freeStaffCount: freeStaff.length,
    rolesInUse: [...rolesInUse].sort(),
  }
}

// ─── THE PLAN CATALOGUE IS WHERE THE SEAT NUMBER LIVES ───────────────────────
//
// Seat caps are ADMINISTERED DATA, not a literal in a branch. The home is
// `subscription_tiers.max_agents` — the column the superadmin plan catalogue
// already edits (app/dashboard/superadmin/plans, through
// app/actions/superadmin/plan-catalog.ts, validated by lib/billing/plan-catalog.ts
// as `maxAgents`), and the same column the tenant's own billing page and the
// platform voice receptionist quote to a caller.
//
// THE COLUMN NAME IS RIGHT AGAIN. m523 recorded that `max_agents` was misnamed
// because a seat was then "any working staff user"; wave 78A's ruling ("staff
// should not take up seats") made a seat a PRODUCER — an agent, a team lead, or
// a broker/owner/admin who holds an agents record — so the column now counts
// exactly what its name says, and the rename m523 reported as a follow-up is
// withdrawn (m655 states this in a COMMENT ON COLUMN). What m655 DOES move is
// the number: brokerage 50 → unlimited (NULL), matching TIER_SEAT_BANDS.
//
// UNLIMITED has two spellings in the catalogue — NULL and -1 (the upgrade modal
// renders -1 as "Unlimited") — and both normalise to null here, because a raw -1
// compared against a seat count would refuse every add on the biggest plan.

/** Result of reading the per-tier seat caps out of the plan catalogue. */
export interface CatalogSeatLimitRead {
  /** False when the catalogue read was REFUSED — gates must fail closed on it. */
  ok: boolean
  /** Tier → cap (null = unlimited). Tiers with no active row are simply absent. */
  limits: CatalogSeatLimits
  error: string | null
}

export async function resolveCatalogSeatLimits(svc: Svc): Promise<CatalogSeatLimitRead> {
  const { data, error } = await svc
    .from("subscription_tiers")
    .select("tier_name, max_agents, is_active")
    .eq("is_active", true)

  // READ the error — supabase-js resolves refusals, and an empty `limits` map
  // would otherwise degrade silently into "use the literals", which is exactly
  // the drift this reader exists to end.
  if (error) return { ok: false, limits: {}, error: error.message }

  const limits: CatalogSeatLimits = {}
  for (const row of (data ?? []) as Array<{ tier_name?: string | null; max_agents?: number | null }>) {
    const name = row.tier_name ?? ""
    if (!isCanonicalTier(name)) continue
    // NULL / -1 / unreadable ⇒ unlimited. The fold moved to
    // tier-role-matrix.ts:normalizeCatalogSeatLimit so the tenant's billing
    // page and this gate share ONE implementation — the display surfaces were
    // testing only for -1 and rendering the live NULL as the word "null".
    limits[name as CanonicalTier] = normalizeCatalogSeatLimit(row.max_agents)
  }
  return { ok: true, limits, error: null }
}

// ─── ONE GATE, EVERY ADD PATH ────────────────────────────────────────────────
//
// A cap enforced on one path is not a cap. Before this, two of the five ways a
// person becomes a seat holder in a tenant checked seats (the tenant invite and
// the god-console create) and three did not: the recruiting provisioner
// (app/api/recruiting/provision-agent) minted an `agent` user outright, a role
// CHANGE through updateUser turned a contact or a vendor into an agent, and
// REACTIVATING a suspended user handed back a seat the count had already
// released. All five now call this.
//
// IT FAILS CLOSED, in all three of the ways it can fail to know:
//   · the tenant row cannot be read      ⇒ refuse
//   · the seat count cannot be read      ⇒ refuse   (SeatUsage.ok)
//   · the plan catalogue cannot be read  ⇒ refuse   (CatalogSeatLimitRead.ok)
// and each refusal says WHICH, so an operator is never left reading "denied".
// An unknown TIER is not in that list: it resolves to the floor tier's cap
// (seatLimitForTier) and produces an ordinary over-limit refusal naming the
// upgrade, which is a better answer than a dead end.

export type SeatGateReason =
  | "not_a_seat"          // partner/contact/system role — never consumed a seat
  | "already_seated"      // this person already holds one of this tenant's seats
  | "within_limit"
  | "over_limit"
  | "tenant_unreadable"
  | "seat_count_unreadable"
  | "catalog_unreadable"

export interface SeatGateVerdict {
  allowed: boolean
  reason: SeatGateReason
  /** Present whenever the gate could actually run — carries the upgrade target. */
  decision: SeatDecision | null
  /** The sentence to show. Null only when allowed. */
  message: string | null
  seatCount: number | null
  tier: string | null
}

/**
 * THE seat gate. Tenant is taken as an ID the caller resolved FROM THE SESSION
 * (CLAUDE.md §4) — never from a request body; every call site below resolves it
 * from the authenticated user or from a platform-staff-gated target.
 *
 * `seatsRequested` defaults to 1 (adding one person). Pass 0 to ask "what is the
 * state right now" without inventing an overage.
 */
export async function seatGate(
  svc: Svc,
  brokerageId: string,
  role: UserDomainRole | string,
  opts?: {
    seatsRequested?: number
    subjectUserId?: string | null
    /** Will this person PRODUCE (hold an agents record)? Only consulted for a
     *  seat-by-production role (broker / broker_owner / admin). Omitted → the
     *  provisioning spec answers for the tenant's tier (roleProducesOnTier). */
    produces?: boolean
  },
): Promise<SeatGateVerdict> {
  // Roles that are never a seat, whatever the tenant looks like: free staff,
  // partners, contacts, lenders, the AI-ISA system actor. They must never eat
  // a subscription seat — a brokerage's contact list would swallow the plan on
  // its first import, and (wave 78A) a TC or ISA hired by a solo agent would
  // have taken the seat the plan sold for a second producer.
  if (!roleConsumesSeat(role, { produces: true })) {
    return { allowed: true, reason: "not_a_seat", decision: null, message: null, seatCount: null, tier: null }
  }

  const { data: tenant, error: tenantErr } = await svc
    .from("brokerages")
    .select("plan_tier, billing_metadata")
    .eq("id", brokerageId)
    .maybeSingle()
  if (tenantErr || !tenant) {
    return {
      allowed: false,
      reason: "tenant_unreadable",
      decision: null,
      seatCount: null,
      tier: null,
      message: `Seat check could not run: this workspace's plan could not be read${tenantErr ? ` (${tenantErr.message})` : ""}. The seat was not added.`,
    }
  }

  const tier = (tenant as { plan_tier?: string | null }).plan_tier ?? null

  // A seat-by-production role is a seat only if this person will produce. The
  // tier had to be read first (the solo/team owner produces, a brokerage-tier
  // admin does not), which is why this check sits after the tenant read.
  const produces = opts?.produces ?? roleProducesOnTier(role, tier)
  if (!roleConsumesSeat(role, { produces })) {
    return { allowed: true, reason: "not_a_seat", decision: null, message: null, seatCount: null, tier }
  }

  const usage = await resolveSeatUsage(svc, brokerageId)
  if (!usage.ok) {
    return {
      allowed: false,
      reason: "seat_count_unreadable",
      decision: null,
      seatCount: null,
      tier,
      message: "Seat check could not run: the number of seats in use could not be read. The seat was not added.",
    }
  }

  // A person who ALREADY holds one of this tenant's seats is not an ADD: a
  // rename, a swap from tc to agent, a re-invite of someone already seated. They
  // are inside seatHolderIds, so charging them a second seat would refuse an
  // edit that costs the plan nothing. Checked HERE rather than from a caller's
  // guess, off the same single read the count comes from. Note a SUSPENDED user
  // is deliberately not in that set — reactivating them IS an add.
  if (opts?.subjectUserId && usage.seatHolderIds.includes(opts.subjectUserId)) {
    return {
      allowed: true, reason: "already_seated", decision: null, message: null,
      seatCount: usage.seatCount, tier,
    }
  }

  const catalog = await resolveCatalogSeatLimits(svc)
  if (!catalog.ok) {
    return {
      allowed: false,
      reason: "catalog_unreadable",
      decision: null,
      seatCount: usage.seatCount,
      tier,
      message: `Seat check could not run: the plan catalogue could not be read${catalog.error ? ` (${catalog.error})` : ""}. The seat was not added.`,
    }
  }

  const decision = seatDecision(
    tier,
    usage.seatCount,
    parseSeatOverride((tenant as { billing_metadata?: unknown }).billing_metadata),
    opts?.seatsRequested ?? 1,
    catalog.limits,
  )

  return {
    allowed: decision.withinLimit,
    reason: decision.withinLimit ? "within_limit" : "over_limit",
    decision,
    seatCount: usage.seatCount,
    tier,
    message: decision.withinLimit ? null : seatDecisionMessage(decision),
  }
}
// NOT ADDED: an `upgradeTargetOf(verdict)` convenience. It would have had zero
// callers the moment it was written — every surface that wants the tier reads
// `verdict.decision.upgradeTo` directly (see app/api/recruiting/provision-agent),
// and an export nothing references is the orphan this repo keeps burning down.
