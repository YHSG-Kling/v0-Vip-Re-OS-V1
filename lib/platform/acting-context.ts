// lib/platform/acting-context.ts
// ─────────────────────────────────────────────────────────────────────────────
// The write-side companion to the impersonation seam. getAgentContext already resolves
// WHICH tenant a request acts on (the target when a platform-staff member is acting-as).
// resolveActingContext adds the two things a WRITER needs to make "operate as tenant"
// real end-to-end:
//   • db  — the client to write THROUGH. When acting-as, the staff user is not a member
//           of the target tenant, so their RLS-scoped client would be blocked; we hand
//           back a service client (RLS-bypassing) instead. Normal tenant users keep their
//           own RLS-scoped client, so nothing about the tenant path changes.
//   • readOnly — true when the impersonation grant is 'read_only'; writers must refuse.
// Every write while acting-as remains attributable via impersonatorUserId.

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
  readOnly: boolean
  /** Write/read THROUGH this client: service client when acting-as, else the caller's RLS client. */
  db: any
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
    readOnly: ctx.impersonationMode === "read_only",
    db: isImpersonating ? createServiceClient() : await createClient(),
  }
}

/** The standard refusal when a read-only act-as session attempts a write. */
export const READ_ONLY_ACTING_ERROR = "Read-only impersonation — switch to full access to make changes."
