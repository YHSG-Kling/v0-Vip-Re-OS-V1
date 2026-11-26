// lib/agreements/session-actor.ts — THE SESSION ACTOR the commission-policy doors pass to the agreement / fee / closing writers
// (wave 145, lane 145C). ONE copy (§6): it was a module-private helper of app/actions/commission-policy/commission-policy.ts
// (wave 144, lane 144D), which now imports it from here with the identical body.
//
// Tenant from the SESSION (requireAuth → brokerageId), never a body field (CLAUDE.md §4). The tenant-principal fact is resolved
// fail-closed (resolveTenantPrincipalTeamLead). The writers take this actor and run on the service client AFTER their own gate.

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { resolveTenantPrincipalTeamLead } from "@/lib/auth/resolve-user-role"
import type { AgreementActor } from "./agent-agreements"

export async function resolveSessionActor(): Promise<{ ok: true; actor: AgreementActor } | { ok: false; error: string }> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { ok: false as const, error: "unauthenticated" }
  const principal = await resolveTenantPrincipalTeamLead(supabase as never, auth.userId, auth.brokerageId)
  if (!principal.ok) return { ok: false as const, error: `role_unresolved: ${principal.reason}` }
  return {
    ok: true as const,
    actor: {
      userId: auth.userId,
      agentId: auth.agentId,
      brokerageId: auth.brokerageId,
      userType: auth.userType,
      isTenantPrincipal: principal.isPrincipal,
    },
  }
}
