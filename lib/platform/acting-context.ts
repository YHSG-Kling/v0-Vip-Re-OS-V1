// lib/platform/acting-context.ts
// ─────────────────────────────────────────────────────────────────────────────
// ★ ACT-AS WRITE SEAM (platform-wide) ★
//
// The write-side companion to the impersonation seam. getAgentContext already resolves
// WHICH tenant a request acts on (the target when a platform-staff member is acting-as).
// This module adds the two things a WRITER needs to make "operate as tenant" real
// end-to-end:
//   • db  — the client to write THROUGH. When acting-as, the staff user is not a member
//           of the target tenant, so their RLS-scoped client would be blocked — and
//           supabase-js RESOLVES that refusal as zero rows with `error: null`, so a
//           cookie-client write under act-as reports success over nothing. We hand back
//           a service client (RLS-bypassing) instead. Normal tenant users keep their
//           own RLS-scoped client, so nothing about the tenant path changes.
//   • readOnly — true when the impersonation grant is 'read_only'; writers must refuse.
//
// TWO ENTRY POINTS, ONE VOCABULARY:
//   resolveActingContext() — for READERS and mixed surfaces: yields the acting db +
//       readOnly flag; a 'read_only' grant still gets the service client so staff can
//       SEE the tenant, and the caller refuses writes itself (see onboarding/brand.ts).
//   resolveWriteContext()  — for WRITERS: same resolution, but a 'read_only' grant is
//       REFUSED HERE and never receives the service client at all. New tenant-writing
//       server actions should gate through this and write through the returned `db`.
//
// GRANT RE-VALIDATION AT CALL TIME: both entry points call getAgentContext() fresh on
// every invocation — ctx.isImpersonating is only ever true when
// lib/platform/impersonation.ts:resolveActiveImpersonation has JUST re-read the session
// row and re-checked ended_at/expires_at (isSessionActive) against the platform-staff
// roster. Neither function accepts a caller-supplied context, so a stale or tampered
// flag can never elevate a request to the service client.
//
// AUDIT: every write while acting-as remains attributable via impersonatorUserId;
// `actorUserId` is the REAL human behind the request (the staff member when
// impersonating, the user themselves otherwise) — stamp it into any audit column the
// written table carries (author_user_id, actor_user_id, lifecycle_events.actor_user_id…).

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export interface ActingContext {
  ok: boolean
  /** Set when ok is false — the seam's own refusal message, for callers to relay. */
  error?: string
  userId: string
  brokerageId: string | null
  userType: string
  isImpersonating: boolean
  impersonatorUserId: string | null
  /** The REAL actor for audit columns: the staff member when impersonating, else the user. */
  actorUserId: string
  readOnly: boolean
  /** Write/read THROUGH this client: service client when acting-as, else the caller's RLS client. */
  db: any
}

/**
 * PURE — the one decision table for which client a request may write through.
 * Unit-tested by scripts/act-as-write-seam-simulator.ts; keep it dependency-free.
 *
 * 'read_only' (and any unknown mode while impersonating) NEVER yields the service
 * client on the write path — only an explicit ACTIVE 'full' grant does.
 */
export function decideWriteChannel(ctx: {
  isAuthenticated: boolean
  isImpersonating?: boolean
  impersonationMode?: string | null
}): { channel: "cookie" | "service" } | { channel: "refused"; reason: "unauthenticated" | "read_only" } {
  if (!ctx.isAuthenticated) return { channel: "refused", reason: "unauthenticated" }
  if (!ctx.isImpersonating) return { channel: "cookie" }
  if (ctx.impersonationMode !== "full") return { channel: "refused", reason: "read_only" }
  return { channel: "service" }
}

export async function resolveActingContext(): Promise<ActingContext> {
  const ctx = await getAgentContext()
  const isImpersonating = !!ctx.isImpersonating
  return {
    ok: ctx.isAuthenticated,
    error: ctx.isAuthenticated ? undefined : "Not authenticated",
    userId: ctx.userId,
    brokerageId: ctx.brokerageId,
    userType: ctx.userType,
    isImpersonating,
    impersonatorUserId: ctx.impersonatorUserId ?? null,
    actorUserId: ctx.impersonatorUserId ?? ctx.userId,
    readOnly: ctx.impersonationMode === "read_only",
    db: isImpersonating ? createServiceClient() : await createClient(),
  }
}

/** The standard refusal when a read-only act-as session attempts a write. */
export const READ_ONLY_ACTING_ERROR = "Read-only impersonation — switch to full access to make changes."

export type WriteContext =
  | {
      ok: true
      /** The EFFECTIVE user (the impersonated tenant identity when acting-as). */
      userId: string
      /** agents.id of the effective identity, or null (broker/admin/tenant-admin view). */
      agentId: string | null
      brokerageId: string | null
      userType: string
      isImpersonating: boolean
      impersonatorUserId: string | null
      /** The REAL actor for audit columns — always the accountable human. */
      actorUserId: string
      /** Write THROUGH this client. Cookie (RLS) client normally; service client ONLY
       *  under an active FULL impersonation grant, re-validated on this very call. */
      db: any
    }
  | { ok: false; error: string }

/**
 * ★ ACT-AS WRITE SEAM ★ — gate for tenant-writing server actions.
 *
 * Returns the cookie (RLS-scoped) client for normal tenant users; under an ACTIVE
 * FULL impersonation grant — re-validated server-side on THIS call, never trusted
 * from a stale flag — returns the service client so the write is not silently
 * refused by tenant RLS. A 'read_only' grant is refused outright and never
 * receives the service client. Callers must still scope every write to
 * `brokerageId` (gate-then-service) and stamp `actorUserId` wherever the written
 * table carries an audit column.
 */
export async function resolveWriteContext(): Promise<WriteContext> {
  const ctx = await getAgentContext() // fresh resolution — re-validates the grant at call time
  const decision = decideWriteChannel(ctx)
  if (decision.channel === "refused") {
    return {
      ok: false,
      error: decision.reason === "read_only" ? READ_ONLY_ACTING_ERROR : "Unauthorized",
    }
  }
  return {
    ok: true,
    userId: ctx.userId,
    agentId: ctx.agentId,
    brokerageId: ctx.brokerageId,
    userType: ctx.userType,
    isImpersonating: !!ctx.isImpersonating,
    impersonatorUserId: ctx.impersonatorUserId ?? null,
    actorUserId: ctx.impersonatorUserId ?? ctx.userId,
    db: decision.channel === "service" ? createServiceClient() : await createClient(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ★ THE CLAIMED-TENANT RULE ★  (owner ruling, 2026-08-26: "idor shapes need to
// include them but that is a researched call for business reason")
//
// A caller-supplied `brokerageId` may legitimately EXIST — a client component
// already holds the id and passing it keeps a call self-describing — but it is
// never an AUTHORITY. It is a CLAIM, and the only correct handling of a claim is
// to verify it against the tenant the session actually acts on.
//
// THE RESEARCH BEHIND THAT, from the live database (2026-08-26), so the next
// audit does not have to redo it:
//   · `current_user_brokerage_id()` is `SELECT brokerage_id FROM users WHERE id =
//     auth.uid()` — ONE brokerage per user, by definition.
//   · `has_brokerage_access(t)` is `is_platform_admin() OR t =
//     current_user_brokerage_id()`. It consults NO multi-brokerage membership
//     table. So in the live schema the ONLY cross-tenant authority that exists is
//     platform staff.
//   · `user_brokerage_roles` (the one table shaped for a user holding seats at
//     several brokerages — it even carries `is_primary`) has 0 rows and is read
//     by NO application code: only by migrations and by RLS helpers in
//     scripts/290-*.sql that the live functions above do not use.
//   · `getAgentContext()` resolves exactly one `brokerageId` per request.
// Therefore "a broker who legitimately operates several brokerages" is NOT a
// capability this system has; it is not being narrowed by anything here. If it is
// ever wanted, the change is to give `has_brokerage_access` a membership table and
// to widen THIS function to accept any tenant the session is a member of — one
// place, not a parameter on every action.
//
// The one real cross-tenant case — platform staff operating a tenant — is already
// covered above: getAgentContext resolves the TARGET tenant while acting-as, so
// `actingBrokerageId` IS the target and the claim matches without any parameter
// being trusted. That is why gating through this seam makes act-as work rather
// than breaking it.
// ─────────────────────────────────────────────────────────────────────────────

type ClaimedTenantDecision =
  | { ok: true; brokerageId: string }
  | { ok: false; reason: "no_session_tenant" | "tenant_mismatch" }

/**
 * PURE — the one decision table for a caller-supplied tenant id.
 * Unit-tested by scripts/act-as-write-seam-simulator.ts; keep it dependency-free.
 *
 * FAILS CLOSED in both directions (§4): a session with no resolvable tenant is
 * refused rather than allowed to write untenanted, and a claim that disagrees with
 * the acting tenant is refused rather than quietly overridden — a browser holding a
 * stale tenant must be told, not silently redirected into a different brokerage's
 * data. An ABSENT claim is not a failure: the acting tenant answers.
 */
export function decideClaimedTenant(input: {
  actingBrokerageId: string | null | undefined
  claimedBrokerageId?: string | null
}): ClaimedTenantDecision {
  const acting = input.actingBrokerageId
  if (!acting) return { ok: false, reason: "no_session_tenant" }
  const claimed = input.claimedBrokerageId
  if (claimed && claimed !== acting) return { ok: false, reason: "tenant_mismatch" }
  return { ok: true, brokerageId: acting }
}

/** The standard refusal when a caller names a tenant the session does not act on.
 *  NOT exported: callers relay `error` off the result, exactly as they do for
 *  READ_ONLY_ACTING_ERROR's sibling path — a second exported constant nothing
 *  imports is an orphan export, and the seam already hands the message back. */
const CLAIMED_TENANT_ERROR = "Not authorized for that brokerage"

/**
 * ★ ACT-AS WRITE SEAM ★ — the gate for a tenant-writing server action whose
 * signature carries a caller-supplied `brokerageId`.
 *
 * Same resolution as resolveWriteContext() (fresh grant re-validation, read_only
 * refused, service client only under an ACTIVE FULL grant), plus the claimed-tenant
 * rule above. The returned `brokerageId` is the SESSION's — write that, never the
 * parameter — and every write must still be scoped to it.
 */
type TenantWriteContext =
  // `brokerageId` is NARROWED to `string`: this entry point refuses a session with
  // no tenant, so unlike resolveWriteContext() a successful result cannot carry
  // null — and callers must not have to re-prove that with a `?? ""` that would
  // silently write an untenanted row.
  | (Omit<Extract<WriteContext, { ok: true }>, "brokerageId"> & { brokerageId: string })
  | { ok: false; error: string }

export async function resolveWriteContextForTenant(
  claimedBrokerageId?: string | null,
): Promise<TenantWriteContext> {
  const wc = await resolveWriteContext()
  if (!wc.ok) return wc
  const decision = decideClaimedTenant({
    actingBrokerageId: wc.brokerageId,
    claimedBrokerageId,
  })
  if (!decision.ok) {
    return {
      ok: false,
      error: decision.reason === "no_session_tenant" ? "Unauthorized" : CLAIMED_TENANT_ERROR,
    }
  }
  return { ...wc, brokerageId: decision.brokerageId }
}
