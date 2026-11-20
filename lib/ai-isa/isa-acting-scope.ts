// lib/ai-isa/isa-acting-scope.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHICH TENANT IS THE ISA ACTING FOR RIGHT NOW? — one answer, singular, or a refusal.
//
// OWNER RULING (2026-08-24), verbatim:
//
//   "ai isa system works for 1 tenant at a time and works for the platform as well"
//
// Three claims, and only the first two are about identity:
//
//   1. the ISA MAY act for the platform             → it is a platform actor
//   2. the ISA MAY act for a tenant                 → it is not platform-ONLY
//   3. it is NEVER acting for two tenants at once   → ← this one
//
// (1) and (2) are properties of the ROLE and are answered by
// lib/platform/platform-staff-roster.ts (isPlatformActorRole / platformActorKind /
// isAiIsaSystemIdentity). Being a platform actor grants no capability: the same
// file still refuses `ai_isa_system` "total control over the complete os system"
// BY NAME, and that refusal is unchanged.
//
// (3) is a property of a SESSION and no role string can answer it. It is the half
// that matters, because the failure it prevents is the one this repo keeps
// finding: an ISA run that holds two tenants' ids in the same scope and reads
// both tenants' contacts through a service client, which bypasses RLS. Nothing
// errors, nothing logs, and the second tenant's people are simply in the batch.
//
// ── WHY THIS IS A REFUSAL AND NOT A FILTER ──────────────────────────────────
// The tempting shape is "take the first brokerage id and ignore the rest". That
// is the fail-OPEN direction wearing a bugfix: it turns a caller's confusion into
// a silent, arbitrary choice of tenant, and the tenant that got dropped never
// learns it was in the batch. CLAUDE.md §4 — a gate that cannot run must refuse.
// So a plural tenant set THROWS, and it throws the same TenantScopeRefusal the
// rest of the tree already catches (lib/kernel/tenant-scope.ts), rather than a
// second refusal vocabulary (§6).
//
// ── WHY IT REUSES TenantScope RATHER THAN RETURNING A STRING ────────────────
// `TenantScope = { kind: "tenant", brokerageId } | { kind: "platform", reason }`
// is already the repo's answer to "no tenant and every tenant must never be the
// same value". An ISA run for the platform is a genuine `platform` scope with a
// stated reason; an ISA run for one brokerage is a genuine `tenant` scope. Every
// downstream reader can then use applyTenantScope() unchanged, so the ISA does
// not get its own tenant-filtering path to drift out of alignment.
//
// PURE — no client, no session, no I/O — so both branches are exhaustively
// testable (scripts/isa-scope-per-user-simulator.ts) and the same definition gates
// a cron loop, a server action and an API route.

import { isAiIsaSystemIdentity, platformActorKind } from "@/lib/platform/platform-staff-roster"
import { platformScope, tenantScope, TenantScopeRefusal, type TenantScope } from "@/lib/kernel/tenant-scope"

/**
 * The identity shape of the AI ISA service actor, written down ONCE.
 *
 * The pair is not arbitrary: `users_isa_actor_shape_check` forces
 * `user_type='system'` for any row carrying `platform_role='ai_isa_system'`, and
 * both live ISA rows match it (measured 2026-08-24). A caller that is running AS
 * the ISA — an ISA cron, an ISA tool handler — names this constant instead of
 * re-typing two string literals, so there is one place to change if the marker
 * ever moves and no site can drift to a half-spelled identity that
 * `isAiIsaSystemIdentity` would (correctly) refuse.
 */
export const ISA_SERVICE_IDENTITY = { userType: "system", platformRole: "ai_isa_system" } as const

export interface IsaActingScopeInput {
  /** users.user_type of the acting identity. */
  userType: string | null | undefined
  /** users.platform_role of the acting identity. */
  platformRole: string | null | undefined
  /**
   * EVERY brokerage id this unit of work names — not "the" brokerage id.
   *
   * Deliberately a LIST even though the answer must be singular. A caller that
   * has one id passes `[id]`; a caller that assembled a batch passes what it
   * assembled. The plural input is what lets the refusal fire: a `string | null`
   * parameter cannot express the defect, so a resolver taking one could never
   * catch it and would read as a guard while guarding nothing.
   */
  brokerageIds: readonly (string | null | undefined)[]
  /**
   * Set ONLY when this unit of work is the ISA acting for the PLATFORM rather
   * than for a tenant — the sentence that authorises a cross-tenant read, exactly
   * as platformScope() requires. Leaving it unset is how a caller says "this is
   * tenant work"; it is never a default.
   */
  platformReason?: string | null
  /** Short human label for the refusal message (the surface name). */
  where: string
}

/**
 * Resolve the ONE scope the AI ISA is acting in for this unit of work.
 *
 * Refuses — never widens — when:
 *   · the identity is not the ISA service actor (a caller may not mint an ISA
 *     scope for a role that is not the ISA; fail closed on a malformed row too,
 *     since the DB pairs platform_role='ai_isa_system' with user_type='system')
 *   · two or more distinct tenants are named        ← "1 tenant at a time"
 *   · no tenant is named and no platform reason is given (the unset case: a
 *     missing tenant is NOT the platform)
 *   · a platform reason AND a tenant are both given (ambiguous: acting for the
 *     platform and for a tenant simultaneously is the plural case in disguise)
 */
export function resolveIsaActingScope(input: IsaActingScopeInput): TenantScope {
  const { where } = input

  if (!isAiIsaSystemIdentity(input.userType, input.platformRole)) {
    const kind = platformActorKind(input.userType, input.platformRole)
    throw new TenantScopeRefusal(
      where,
      `only the AI ISA service actor may resolve an ISA acting scope; this identity is ${
        kind ? `platform ${kind}` : "a tenant user"
      } (user_type=${input.userType ?? "null"}, platform_role=${input.platformRole ?? "null"}).`,
    )
  }

  const tenants = Array.from(
    new Set(
      input.brokerageIds
        .map((b) => (typeof b === "string" ? b.trim() : ""))
        .filter((b) => b.length > 0),
    ),
  )
  const reason = typeof input.platformReason === "string" ? input.platformReason.trim() : ""

  // THE RULING, first: two tenants in one scope is the defect, and it is refused
  // BEFORE anything else can pick a winner out of the list.
  if (tenants.length > 1) {
    throw new TenantScopeRefusal(
      where,
      `the AI ISA works for ONE TENANT AT A TIME and this scope names ${tenants.length} (${tenants.join(", ")}). ` +
        "Split the work into one scope per tenant — dropping the extras here would silently pick a tenant nobody chose.",
    )
  }

  if (tenants.length === 1) {
    if (reason) {
      throw new TenantScopeRefusal(
        where,
        `the AI ISA was given BOTH a platform reason (${reason}) and the tenant ${tenants[0]}. ` +
          "Acting for the platform and for a tenant are separate units of work; say which one this is.",
      )
    }
    // tenantScope() re-checks the id and refuses a blank, so the singular path
    // cannot decay into a platform read either.
    return tenantScope(tenants[0], where)
  }

  if (reason) return platformScope(`AI ISA (platform actor) — ${reason}`)

  throw new TenantScopeRefusal(
    where,
    "the AI ISA named no tenant and gave no platform reason. Which tenant this ISA is acting for must be " +
      "explicit and singular; an unset tenant is NOT the platform.",
  )
}

/**
 * The batch shape, stated once so callers do not each hand-roll it.
 *
 * A platform-wide ISA cron IS legitimate — it is the ISA acting for the platform
 * — but it must execute as a SEQUENCE of single-tenant scopes, never as one wide
 * scope. This turns a list of tenants into exactly that sequence, so the loop
 * body physically cannot hold two tenants: each iteration carries one
 * `TenantScope` of kind "tenant".
 *
 * Duplicate ids collapse (the same tenant twice is still one tenant); blanks are
 * dropped rather than becoming an empty predicate. An EMPTY result is returned as
 * an empty array, not as a platform scope — "no tenants to work" and "every
 * tenant" are the two facts this repo has repeatedly conflated.
 */
export function isaTenantWorkQueue(
  input: Omit<IsaActingScopeInput, "platformReason">,
): TenantScope[] {
  const seen = new Set<string>()
  const queue: TenantScope[] = []
  for (const raw of input.brokerageIds) {
    const id = typeof raw === "string" ? raw.trim() : ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    queue.push(
      resolveIsaActingScope({
        userType: input.userType,
        platformRole: input.platformRole,
        brokerageIds: [id],
        where: input.where,
      }),
    )
  }
  return queue
}
