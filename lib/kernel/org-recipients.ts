// lib/kernel/org-recipients.ts
//
// TIER-SAFE ORG RECIPIENTS — who receives a brokerage-level red-flag / report. In a team, brokerage, or
// multi-location org that's the broker/admin/compliance staff. In a SOLO-agent subscription there is no
// separate broker — the one-person shop's brokerage row carries the brokerage name, but the human is the
// agent themselves — so the report must reach the SOLO AGENT, not fall into a void because no
// broker/admin user exists. This resolves the right recipients regardless of tier: staff when present,
// the active agents (the solo owner) as the fallback, so a red-flag is NEVER silently dropped for a solo.

import { createServiceClient } from "@/lib/supabase/service"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

type Svc = ReturnType<typeof createServiceClient>

/**
 * Staff roles that receive brokerage-level reports when the org has them: the tenant's OPERATIONAL
 * admin class (CLAUDE.md §4 — spread the Set, never restate it) minus `team_lead` by NAMED
 * subtraction, because a team is a mini brokerage that sees only its own board and a brokerage-level
 * red-flag is the brokerage's. Wave 141K found the old hand-typed list omitted `broker_owner`, so a
 * brokerage whose only staff seat was its owner fell through to the solo fallback and the owner was
 * reached as "an agent" (or not at all when they hold no agents row).
 */
export const ORG_STAFF_ROLES: readonly string[] = Object.freeze([...TENANT_ADMIN_USER_TYPES].filter((r) => r !== "team_lead"))

/**
 * Resolve the USER ids that should receive a brokerage-level red-flag/report. Broker/admin/compliance
 * staff when present; otherwise the brokerage's active agents (the solo owner). Never throws.
 */
export async function resolveOrgRecipients(svc: Svc, brokerageId: string, opts: { limit?: number; roles?: readonly string[] } = {}): Promise<string[]> {
  const limit = opts.limit ?? 10
  const roles = opts.roles ?? ORG_STAFF_ROLES
  try {
    const { data: staff } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).in("user_type", roles as string[]).limit(limit)
    const staffIds = ((staff ?? []) as Array<{ id: string }>).map((u) => u.id)
    if (staffIds.length > 0) return staffIds

    // SOLO fallback — no staff, so the report goes to the agent(s) who run this brokerage.
    const { data: agents } = await svc.from("agents").select("user_id").eq("brokerage_id", brokerageId).eq("is_active", true).not("user_id", "is", null).limit(limit)
    return Array.from(new Set(((agents ?? []) as Array<{ user_id: string | null }>).map((a) => a.user_id).filter((x): x is string => !!x)))
  } catch {
    return []
  }
}
