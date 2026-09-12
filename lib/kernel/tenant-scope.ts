// lib/kernel/tenant-scope.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT SCOPE DISCRIMINATOR — "no tenant" and "every tenant" must never be
// the same value.
//
// WHAT THIS EXISTS TO END. Across this repo a reader would take an optional
// brokerage id and apply the tenant predicate only when it happened to be
// truthy:
//
//     let q = svc.from("compliance_events").select(…)
//     if (brokerageId) q = q.eq("brokerage_id", brokerageId)   ← optional
//     const { data } = await q                                  ← runs anyway
//
// The query runs EITHER WAY. When the id arrives null the predicate is not
// merely skipped, it is GONE, and a service-role client (which bypasses RLS)
// then returns every brokerage's rows. Nothing errors and nothing logs: the
// caller asked "my tenant's rows" and got the platform's. CLAUDE.md §4 —
// "A gate that cannot run must refuse, not pass. 'Nobody checked' must never
// render as 'checked and fine'."
//
// It is not hypothetical. Two surfaces were reached the same way:
//
//   · lib/kernel/compliance-ledger.ts — its page computes
//     `isSuperadmin ? null : (userData?.brokerage_id ?? null)`, so a NON-superadmin
//     broker/admin whose users.brokerage_id is NULL read EVERY brokerage's Fair
//     Housing and consent audit trail.
//   · lib/kernel/command-center.ts — its page computes
//     `brokerageId: isSuperadmin ? undefined : brokerageId` while the entry gate
//     is `isAdminOrBroker(user_type)`, which does not consult brokerage_id at all.
//     Same null, seven queries, service client: approval queues, proposed client
//     messages and ad-spend proposals for the whole platform.
//
// Neither is exploitable on today's data — 0 of 23 live `users` rows carry a NULL
// brokerage_id — but the column IS nullable, so both are structurally reachable,
// and the owner's ruling ("brokerage id determines the tenant unique and platform
// only has no brokerageid") makes the absent id LOAD-BEARING rather than cosmetic.
//
// ── THE SHAPE OF THE FIX ─────────────────────────────────────────────────────
// A caller cannot express "platform" by omission any more. It says so:
//
//     applyTenantScope(q, tenantScope(brokerageId, "compliance ledger"))
//     applyTenantScope(q, platformScope("superadmin — platform-wide ledger"))
//
// `tenantScope()` REFUSES a null. `platformScope()` demands a reason, so every
// cross-tenant read carries, at the call site, the sentence that authorises it.
// `resolveTenantScope()` is for the surfaces that legitimately serve both: it
// takes the caller's platform authority as an explicit boolean and, when a
// caller has neither authority nor a tenant, THROWS rather than widening.
//
// ── WHY A THROW AND NOT A SILENT EMPTY RESULT ────────────────────────────────
// An empty list is indistinguishable from "this tenant has no rows", which is
// the same class of lie the fail-open produced in the other direction. A refusal
// names itself. Callers that must degrade gracefully catch TenantScopeRefusal and
// render an honest notice — never a fabricated zero.
//
// ── ON `public.users` ────────────────────────────────────────────────────────
// There is an OPEN OWNER DECISION about whether a NULL users.brokerage_id should
// mean platform on THAT table: live, 0 of 23 rows are NULL and the platform's only
// superadmin HAS a brokerage_id, so the discriminator there is `platform_role`,
// not the absent id. Nothing here changes identity semantics on `users`. Where a
// surface's answer depends on that decision, it implements the FAIL-CLOSED
// direction — refuse — and the ambiguity is reported, never resolved by widening.

/** The two things a tenant filter can legitimately mean. There is no third. */
export type TenantScope =
  | { readonly kind: "tenant"; readonly brokerageId: string }
  | { readonly kind: "platform"; readonly reason: string }

/** Thrown when a scope cannot be established. Fail closed: refuse, never widen. */
export class TenantScopeRefusal extends Error {
  readonly where: string
  constructor(where: string, detail: string) {
    super(`tenant scope refused at ${where} — ${detail}`)
    this.name = "TenantScopeRefusal"
    this.where = where
  }
}

export function isTenantScopeRefusal(e: unknown): e is TenantScopeRefusal {
  return e instanceof TenantScopeRefusal
}

/**
 * A single tenant. REFUSES a null/undefined/blank id — that is the whole point:
 * the absent value can no longer decay into "all tenants".
 *
 * @param where  a short human label for the refusal message (the surface name)
 */
export function tenantScope(brokerageId: string | null | undefined, where: string): TenantScope {
  const id = typeof brokerageId === "string" ? brokerageId.trim() : ""
  if (!id) {
    throw new TenantScopeRefusal(
      where,
      "no brokerage_id on the session. A missing tenant is NOT the platform — say platformScope(reason) if that is what you mean.",
    )
  }
  return { kind: "tenant", brokerageId: id }
}

/**
 * Every tenant, deliberately. The reason is REQUIRED and is not decoration: it is
 * the sentence a reviewer reads to decide whether this cross-tenant read was
 * authorised, and it appears at the call site rather than in a comment three files
 * away.
 */
export function platformScope(reason: string): TenantScope {
  const r = reason.trim()
  if (!r) throw new TenantScopeRefusal("platformScope", "a platform-wide read must state WHY it is authorised")
  return { kind: "platform", reason: r }
}

/**
 * For a surface that genuinely serves BOTH — a platform operator and a tenant.
 * Platform authority is passed as an explicit boolean the caller has already
 * established (requireSuperadmin(), a verified CRON_SECRET, platform_role), never
 * inferred from the id being absent.
 *
 * The fourth case — no authority AND no tenant — is the one that used to read as
 * "platform". It throws.
 */
export function resolveTenantScope(args: {
  brokerageId: string | null | undefined
  /** TRUE only where the caller has PROVEN platform authority. Never `!brokerageId`. */
  platformAuthorized: boolean
  /** Why platform access is authorised, when it is. */
  platformReason?: string
  where: string
}): TenantScope {
  const id = typeof args.brokerageId === "string" ? args.brokerageId.trim() : ""
  if (id) return { kind: "tenant", brokerageId: id }
  if (args.platformAuthorized) {
    return platformScope(args.platformReason ?? `${args.where} — platform-authorised caller, no tenant selected`)
  }
  throw new TenantScopeRefusal(
    args.where,
    "caller has neither a brokerage_id nor proven platform authority. Refusing rather than reading every tenant.",
  )
}

/** Narrow, structural: the sliver of a PostgREST builder this module needs. */
interface EqFilterable {
  eq(column: string, value: string): this
}

/**
 * Apply the scope to a query. A `tenant` scope adds the predicate; a `platform`
 * scope deliberately adds nothing — and the difference is now something the
 * caller ASKED for, not something that fell out of a missing value.
 *
 * The default column is `brokerage_id`; pass another for the tables that anchor
 * their tenant under a different name.
 */
export function applyTenantScope<Q extends EqFilterable>(
  query: Q,
  scope: TenantScope,
  column = "brokerage_id",
): Q {
  // Routed through `scopeBrokerageId` rather than re-testing `scope.kind` here.
  // The two were written together and read the discriminant independently, which
  // is the seam where a third case added to TenantScope later would be handled by
  // one and silently dropped by the other — the same "two spellings of one
  // question" defect §6 governs, at function scale.
  const id = scopeBrokerageId(scope)
  return id === null ? query : query.eq(column, id)
}

/** The brokerage id when the scope is a tenant, else null. For row-stamping and logs. */
export function scopeBrokerageId(scope: TenantScope): string | null {
  return scope.kind === "tenant" ? scope.brokerageId : null
}

/** One-line description for a header/label ("Platform — all brokerages" etc.). */
export function describeTenantScope(scope: TenantScope): string {
  return scope.kind === "tenant" ? `Brokerage ${scope.brokerageId}` : `Platform — all brokerages (${scope.reason})`
}
