// lib/property/rentcast-eligibility.ts
//
// THE ONE GATE: "should RentCast run at all for this tenant, right now?"
//
// OWNER RULING (verbatim, and the reason this module exists):
//   "rentcast is platform owned and should not be used if the tenant adds their
//    idx broker credentials"
//
// That is a CONNECTION rule, not a results rule. It does not ask what IDX
// returned, or whether IDX returned anything at all. A tenant that connected
// their own IDX Broker account owns a feed, and the platform's metered RentCast
// account is not spent on their behalf from that moment on.
//
// ─── WHY ONE MODULE AND NOT THREE CHECKS ────────────────────────────────────
// The question has exactly three answers and before this file they lived in
// three different places, or nowhere:
//
//   1. is there a platform key at all      → lib/property/rentcast.ts getApiKey
//   2. does this tenant have IDX connected → NOWHERE. The rule was documentary
//      (tenancy-matrix.ts, manager-registry.ts, resolve-app-capability.ts all
//      described it in prose); the only executable precedence in the tree was
//      lib/property/listing-source.ts, and it encoded the WRONG rule.
//   3. is the vendor budget exhausted      → lib/avm/provider-chain.ts ONLY.
//      RentCast was metered on six lanes and capped on one, which is not what
//      "platform-GATED" means.
//
// Splitting them is how they drifted. They are answered here, once, and every
// RentCast export in lib/property/rentcast.ts asks this before it spends.
//
// ─── THE RESULT IS DISCRIMINATED, NEVER A BOOLEAN ───────────────────────────
// A caller MUST be able to tell "this tenant owns a feed so we deliberately did
// not call" from "we could not reach the provider". Those are opposite facts
// about the product and collapsing them into `false` is the exact conflation
// this codebase keeps paying for. Hence `reason`, and hence every underlying
// fact (`idx`, `platformKeyPresent`, `budget`) riding along beside it.
//
// ─── REASON PRECEDENCE, DECIDED RATHER THAN INCIDENTAL ──────────────────────
//   tenant_has_idx  →  idx_check_unreadable  →  no_platform_key  →
//   budget_exhausted  →  eligible
//
// The ruling outranks the outage. When a tenant owns an IDX feed AND the
// platform key happens to be unset, the honest headline is "we would not have
// called anyway" — the missing key is not why. Nothing is lost by ranking them:
// `platformKeyPresent` is a pure env read and is therefore ALWAYS accurate on
// the result regardless of which reason won.
//
// ─── FAIL-CLOSED, AND WHAT "CLOSED" MEANS FOR EACH CHECK ────────────────────
// IDX: closed means DO NOT CALL. If the connection lookup is unreadable we
// cannot prove the tenant lacks IDX, and calling RentCast in that state spends
// platform money in possible violation of an explicit owner ruling. Suppressing
// a call is recoverable — the caller reports the lane is unavailable and the
// operator retries. Spending against the ruling is not. So an unreadable IDX
// check is `idx_check_unreadable` / ineligible, and is NEVER silently read as
// "no IDX connected".
//
// BUDGET: closed means the EXISTING repo-wide contract, unchanged. The budget
// gate is documented and implemented as an ADVISORY cap that FAILS OPEN
// (lib/vendor-governance/budget-gate.ts) — a ledger read failure must not take
// customer flows down. This wave's ruling is about IDX, not about inverting the
// budget contract, and making RentCast the one vendor that hard-stops on a
// ledger outage would be an invented decision. A fail-open verdict is therefore
// honoured AND SURFACED: `budget.degraded` says the verdict was fail-open.
//
// ─── A LIMITATION, STATED RATHER THAN PAPERED OVER ──────────────────────────
// `resolveScopedConnection` (READ ONLY for this slice) swallows a refused
// platform_credentials read inside `readOwnerCredential` and returns null, so a
// REFUSED row read and an ABSENT row are indistinguishable to any caller of it,
// including this gate. `idx_check_unreadable` therefore only fires when the
// resolver THROWS. Fixing that requires changing resolve-scoped.ts to
// distinguish the two, which is outside this slice's write scope and is recorded
// as a handoff rather than guessed at here. This module does not open a second,
// rival read of the same table to work around it: the gate and
// `IDXBrokerClient.forBrokerage` MUST resolve IDX through the same resolver, or
// they can disagree about whether a tenant "has IDX" — and a gate that disagrees
// with the client it guards is worse than no gate.

// ─── WHY THIS MODULE IS NOT MARKED `server-only`, AND ITS TWO REAL READS ARE
//     DYNAMIC IMPORTS ───────────────────────────────────────────────────────
// It sits on exactly the same footing as lib/property/rentcast.ts, the module it
// guards, which is deliberately NOT a `server-only` module: the platform-gating
// proof imports those readers directly to establish that a dark vendor lane
// RESOLVES an honest empty instead of throwing, and a gate that made its own
// subject unimportable would break that guarantee at the front door. So the two
// dependencies that ARE `server-only` — the connection resolver and the budget
// gate — are reached through `await import(...)` at the moment they are needed.
// This is not an escape hatch from the client/server boundary: the repo's
// client→server-only guard follows dynamic imports too, so a client module that
// reached this file would still be caught. It only means the module can be
// LOADED anywhere while its privileged reads still happen on the server.
import type { ScopedConnection } from "@/lib/connections/resolve-scoped"
import type { ConnectionScope } from "@/lib/connections/scope"
import { resolveVendorAction } from "@/lib/vendor-governance/vendor-policy"

/** The canonical vendor name RentCast is metered and policed under. */
const RENTCAST_VENDOR = "rentcast"

/** The provider id the tenant's own listing feed is connected under. */
const IDX_PROVIDER = "idxbroker"

/**
 * WHO the question is being asked about.
 *
 * `brokerageId` is the tenant. `agentUserId` (a USERS.id — never agents.id,
 * never contacts.id) and `teamId` are the more-specific tiers of the SAME
 * cascade `IDXBrokerClient.forBrokerage` walks. A caller that holds them must
 * pass them: an agent who connected their OWN IDX Broker account files that
 * credential at agent scope, and a gate asked only at brokerage scope cannot
 * see it. See the handoff note on `resolveTenantIdxConnection` for what that
 * costs at the call sites that hold only a brokerage id.
 */
export interface RentcastEligibilityContext {
  brokerageId: string
  agentUserId?: string | null
  teamId?: string | null
}

/**
 * What the IDX-connection check actually found.
 *
 * `connected` means an OWNER-SCOPED credential with a usable key — the tenant
 * added their own. The PLATFORM tier of the cascade is deliberately NOT
 * connected: a platform-tier hit is the product's own fallback account, not the
 * tenant's credential, and counting it would suppress RentCast for every tenant
 * on the system the moment a platform IDX row exists.
 */
export type TenantIdxConnection =
  | { status: "connected"; ownerType: Exclude<ConnectionScope, "platform"> }
  | { status: "not_connected" }
  | { status: "unreadable"; detail: string }

/** The vocabulary. Every ineligible answer names WHICH of the three questions
 *  said no, so "we deliberately did not call" is never confusable with "we could
 *  not reach the provider". */
export type RentcastEligibilityReason =
  | "eligible"
  | "tenant_has_idx"
  | "idx_check_unreadable"
  | "no_platform_key"
  | "budget_exhausted"

/** Precedence, in order. Exported so a proof can assert the vocabulary exists
 *  rather than assert a particular spelling appears in a particular branch. */
export const RENTCAST_ELIGIBILITY_REASONS: readonly RentcastEligibilityReason[] = [
  "tenant_has_idx",
  "idx_check_unreadable",
  "no_platform_key",
  "budget_exhausted",
  "eligible",
] as const

interface RentcastEligibilityFacts {
  /** What the IDX check found. Always present — the answer is never inferred
   *  from `reason` alone. */
  idx: TenantIdxConnection
  /** Does the ONE platform RentCast key resolve? A pure env read, so it is
   *  accurate whichever reason won. */
  platformKeyPresent: boolean
  /** `checked` false = the gate stopped before the budget mattered. `degraded`
   *  true = the budget verdict was FAIL-OPEN (the ledger could not be read), so
   *  "under budget" is a contract, not an observation. */
  budget: { checked: boolean; degraded: boolean }
  /** One plain-language sentence a surface, a note, or a CMA disclaimer can
   *  show verbatim. */
  detail: string
}

/**
 * The gate's answer. A DISCRIMINATED UNION on `reason` — a caller that wants
 * "did it run?" reads `eligible`, and a caller that has to explain itself to a
 * seller, an appraiser or an operator reads `reason` and gets the truth.
 */
export type RentcastEligibility =
  | ({ eligible: true; reason: "eligible" } & RentcastEligibilityFacts)
  | ({ eligible: false; reason: "tenant_has_idx"; idxOwnerType: Exclude<ConnectionScope, "platform"> } & RentcastEligibilityFacts)
  | ({ eligible: false; reason: "idx_check_unreadable" } & RentcastEligibilityFacts)
  | ({ eligible: false; reason: "no_platform_key" } & RentcastEligibilityFacts)
  | ({ eligible: false; reason: "budget_exhausted" } & RentcastEligibilityFacts)

/**
 * THE platform RentCast key, read in one named place.
 *
 * RentCast is platform-GATED: one platform account serving every tenant. There
 * is no tenant RentCast key, none is offered (lib/connections/scope.ts keeps
 * RentCast out of the user-connectable providers on purpose), and nothing here
 * selects a credential by tenant.
 */
function platformRentcastKey(): string | null {
  return process.env.RENTCAST_API_KEY ?? null
}

/**
 * Does THIS TENANT have their own IDX Broker credential connected?
 *
 * Resolved through `resolveScopedConnection` — the SAME resolver
 * `IDXBrokerClient.forBrokerage` uses to pick which IDX credential to call
 * with — so the gate and the client can never disagree about whether a tenant
 * "has IDX".
 *
 * THREE things make a hit count, and each one is load-bearing:
 *
 *   1. A credential resolved at all.
 *   2. Its `ownerType` is not `platform`. The cascade is agent → team →
 *      brokerage → platform and the last tier is the PRODUCT'S account, not the
 *      tenant's. Counting it would suppress RentCast for every tenant on the
 *      system. (The legacy fallback inside resolveScopedConnection cannot
 *      produce a platform-tier hit: every legacy store it reads is filtered by
 *      brokerage_id, so a legacy hit is tenant-owned by construction.)
 *   3. It carries a non-empty `apiKey`. `forBrokerage` uses `conn?.apiKey ||
 *      process.env.IDXBROKER_API_KEY` — so a row with no api_key does NOT get
 *      the tenant served from their own account, and must not count as "the
 *      tenant added their credentials" either. Matching the client exactly here
 *      is the whole point of using its resolver.
 *
 * HANDOFF, stated where it bites: this answers at the scope the CALLER can
 * name. A caller holding only a brokerage id cannot see an AGENT-tier IDX
 * credential, so for that caller an agent-only connection reads as
 * `not_connected` and RentCast stays eligible. Every call site inside this
 * slice passes the fullest context it holds; the ones outside it are listed in
 * the wave report.
 */
async function resolveTenantIdxConnection(
  ctx: RentcastEligibilityContext,
): Promise<TenantIdxConnection> {
  let conn: ScopedConnection | null
  try {
    const { resolveScopedConnection } = await import("@/lib/connections/resolve-scoped")
    conn = await resolveScopedConnection(IDX_PROVIDER, {
      agentUserId: ctx.agentUserId ?? null,
      teamId: ctx.teamId ?? null,
      brokerageId: ctx.brokerageId,
    })
  } catch (err) {
    // A THROW is the only unreadability this gate can observe — see the module
    // header for why a REFUSED row read is invisible here and what fixing that
    // would take. Never downgraded to "not connected".
    return {
      status: "unreadable",
      detail: `the IDX Broker connection could not be resolved for this tenant (${(err as Error)?.message ?? "unknown error"}), so it is not known whether they have their own feed`,
    }
  }
  if (!conn) return { status: "not_connected" }
  if (conn.ownerType === "platform") return { status: "not_connected" }
  if (!conn.apiKey) return { status: "not_connected" }
  return { status: "connected", ownerType: conn.ownerType }
}

/**
 * Is the tenant over its monthly vendor budget for RentCast?
 *
 * The exact expression lib/avm/provider-chain.ts has always used, lifted here
 * so the AVM cascade and this gate cannot drift into two different budget
 * verdicts. `resolveVendorAction("rentcast", overBudget)` returns "degrade" over
 * budget (RentCast has a free alternative — the Perplexity/OSINT AVM tier), and
 * anything other than "allow" means this vendor does not get called.
 *
 * Exported because the AVM cascade needs the BUDGET half on its own: over budget
 * it must skip BatchData and ZenRows too, and the eligibility gate may have
 * stopped before the budget was ever reached.
 */
export async function rentcastBudgetBlocked(
  brokerageId: string,
): Promise<{ blocked: boolean; degraded: boolean }> {
  const { checkVendorBudget } = await import("@/lib/vendor-governance/budget-gate")
  const budget = await checkVendorBudget({ brokerageId })
  return {
    blocked: resolveVendorAction(RENTCAST_VENDOR, !budget.allowed) !== "allow",
    degraded: budget.degraded === true,
  }
}

/**
 * Tenants already told their RentCast lane is closed, keyed by tenant AND
 * reason — so a lane that goes dark is reported once per instance instead of on
 * every call, and a lane whose reason CHANGES is reported again.
 */
const suppressionReported = new Set<string>()

function reportOnce(brokerageId: string, reason: RentcastEligibilityReason, detail: string): void {
  const key = `${brokerageId}:${reason}`
  if (suppressionReported.has(key)) return
  suppressionReported.add(key)
  console.warn(`[rentcast] not called for brokerage ${brokerageId} — ${reason}: ${detail}`)
}

/**
 * SHOULD RENTCAST RUN AT ALL FOR THIS TENANT, RIGHT NOW?
 *
 * Checks run in precedence order and short-circuit, so the cheapest honest
 * answer costs one credential read and no budget read. The IDX check goes FIRST
 * even though the platform-key check is free, because the ruling outranks the
 * outage and because every caller in the property lane needs the IDX fact
 * whether or not RentCast is available — routing them through one call keeps
 * them from opening a second, rival IDX lookup.
 *
 * Never throws. Every RentCast reader below it returns an honest empty, so a
 * closed gate falls through the AVM cascade to the next provider rather than
 * taking a valuation down.
 */
export async function resolveRentcastEligibility(
  ctx: RentcastEligibilityContext,
): Promise<RentcastEligibility> {
  const platformKeyPresent = !!platformRentcastKey()
  const idx = await resolveTenantIdxConnection(ctx)
  const budgetUnchecked = { checked: false, degraded: false }

  if (idx.status === "connected") {
    const detail =
      `RentCast was not called: this tenant has connected their own IDX Broker credentials at ${idx.ownerType} scope, and RentCast is the platform's provider for tenants who have not. This is a deliberate decision, not a provider failure.`
    reportOnce(ctx.brokerageId, "tenant_has_idx", detail)
    return {
      eligible: false,
      reason: "tenant_has_idx",
      idxOwnerType: idx.ownerType,
      idx,
      platformKeyPresent,
      budget: budgetUnchecked,
      detail,
    }
  }

  if (idx.status === "unreadable") {
    const detail =
      `RentCast was not called: ${idx.detail}. The gate fails CLOSED here on purpose — a tenant who owns an IDX feed must not be billed for RentCast, and an unprovable answer is not permission to spend.`
    reportOnce(ctx.brokerageId, "idx_check_unreadable", detail)
    return {
      eligible: false,
      reason: "idx_check_unreadable",
      idx,
      platformKeyPresent,
      budget: budgetUnchecked,
      detail,
    }
  }

  if (!platformKeyPresent) {
    const detail =
      "RentCast was not called: the platform RentCast key is not configured, so the RentCast lane is dark for every tenant. RentCast is platform-gated — there is no tenant credential that could substitute for it."
    reportOnce(ctx.brokerageId, "no_platform_key", detail)
    return {
      eligible: false,
      reason: "no_platform_key",
      idx,
      platformKeyPresent,
      budget: budgetUnchecked,
      detail,
    }
  }

  // The budget half keeps the budget gate's OWN documented contract: advisory
  // cap, FAILS OPEN. `checkVendorBudget` already returns `degraded: true` rather
  // than throwing on a ledger read error; this catch covers the module-load path
  // and lands in the same place, so a broken budget system degrades the VERDICT
  // rather than the product — and says it degraded.
  const budget = await rentcastBudgetBlocked(ctx.brokerageId).catch(() => ({ blocked: false, degraded: true }))
  if (budget.blocked) {
    const detail =
      "RentCast was not called: this brokerage is over its monthly vendor budget, so the paid property-data tier is paused for the rest of the billing month. The free valuation tiers still run."
    reportOnce(ctx.brokerageId, "budget_exhausted", detail)
    return {
      eligible: false,
      reason: "budget_exhausted",
      idx,
      platformKeyPresent,
      budget: { checked: true, degraded: budget.degraded },
      detail,
    }
  }

  return {
    eligible: true,
    reason: "eligible",
    idx,
    platformKeyPresent,
    budget: { checked: true, degraded: budget.degraded },
    detail: budget.degraded
      ? "RentCast is eligible for this tenant: no tenant IDX Broker connection, the platform key resolves, and the vendor budget verdict was FAIL-OPEN (the spend ledger could not be read) rather than measured."
      : "RentCast is eligible for this tenant: no tenant IDX Broker connection, the platform key resolves, and the tenant is within its monthly vendor budget.",
  }
}
