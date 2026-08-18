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
