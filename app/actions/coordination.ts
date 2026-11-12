"use server"

/**
 * Coordination dashboard doors — the GATED half of lib/intelligence/multi-agent-router.ts.
 *
 * WHY THIS FILE EXISTS (integrator, 2026-09-03, CLAUDE.md §4). The router module
 * carried a module-level "use server", which made every export a public HTTP
 * endpoint onto a service client with the tenant taken from the PARAMETER:
 * `getActiveSessions(brokerageId)` and `getAgentMetrics(brokerageId, days)`
 * answered any brokerage's agent sessions to any signed-in caller, and
 * `endAgentSession` / `clearHumanOverride` ended or resumed any tenant's
 * sessions. The coordination dashboard client imported those exports directly.
 *
 * The router is now `server-only` (its other callers — the agent-health-check
 * cron and the INTERNAL_API_SECRET-gated coordinate route — resolve their own
 * tenant and stay in-process). This file is the only door a browser reaches:
 * every export resolves the tenant from the SESSION (lib/auth/require-caller.ts),
 * proves the session row belongs to it before mutating, and only then calls
 * the router with the session-derived brokerage.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requireCaller } from "@/lib/auth/require-caller"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import {
  getActiveSessions as routerActiveSessions,
  getAgentMetrics as routerAgentMetrics,
  endAgentSession as routerEndAgentSession,
  clearHumanOverride as routerClearHumanOverride,
} from "@/lib/intelligence/multi-agent-router"

type Gate =
  | { ok: true; brokerageId: string; userId: string }
  | { ok: false; error: string }

/** Brokers/admins/team leads of the session's tenant (the page's own gate, one roster). */
async function requireCoordinationCaller(): Promise<Gate> {
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isAdminOrBroker({ user_type: caller.userType })) {
    return { ok: false, error: "Forbidden: the coordination dashboard is a broker/admin surface" }
  }
  return { ok: true, brokerageId: caller.brokerageId, userId: caller.userId }
}

export async function getActiveSessions(): Promise<
  Awaited<ReturnType<typeof routerActiveSessions>> & { error?: string }
> {
  const gate = await requireCoordinationCaller()
  if (!gate.ok) return { sessions: [], error: gate.error }
  return routerActiveSessions(gate.brokerageId)
}

export async function getAgentMetrics(daysBack: number = 7): Promise<
  Awaited<ReturnType<typeof routerAgentMetrics>> & { error?: string }
> {
  const gate = await requireCoordinationCaller()
  // A refusal keeps the metrics SHAPE (the page renders it directly) and
  // carries the reason — zeros with an error beside them, never silent zeros.
  if (!gate.ok) {
    return {
      byAgentType: {} as Awaited<ReturnType<typeof routerAgentMetrics>>["byAgentType"],
      totalSessions: 0,
      escalationRate: 0,
      error: gate.error,
    }
  }
  const days = Number.isFinite(daysBack) ? Math.min(Math.max(Math.trunc(daysBack), 1), 90) : 7
  return routerAgentMetrics(gate.brokerageId, days)
}

/** The session row must belong to the caller's tenant — a counted, tenant-pinned read. */
async function sessionBelongsToTenant(
  brokerageId: string,
  where: { sessionId?: string; entityType?: string; entityId?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  let q = svc.from("agent_state_machine").select("id, brokerage_id").eq("brokerage_id", brokerageId)
  if (where.sessionId) q = q.eq("id", where.sessionId)
  if (where.entityType) q = q.eq("entity_type", where.entityType)
  if (where.entityId) q = q.eq("entity_id", where.entityId)
  const { data, error } = await q.limit(1)
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: "Session not found in your brokerage" }
  return { ok: true }
}

export async function endAgentSession(params: {
  sessionId: string
  outcome: "completed" | "failed" | "cancelled"
  summary?: string
}): Promise<{ success: boolean; message: string }> {
  const gate = await requireCoordinationCaller()
  if (!gate.ok) return { success: false, message: gate.error }
  const owned = await sessionBelongsToTenant(gate.brokerageId, { sessionId: params.sessionId })
  if (!owned.ok) return { success: false, message: owned.error }
  return routerEndAgentSession(params)
}

export async function clearHumanOverride(params: {
  entityType: string
  entityId: string
}): Promise<{ success: boolean; message: string }> {
  const gate = await requireCoordinationCaller()
  if (!gate.ok) return { success: false, message: gate.error }
  const owned = await sessionBelongsToTenant(gate.brokerageId, {
    entityType: params.entityType,
    entityId: params.entityId,
  })
  if (!owned.ok) return { success: false, message: owned.error }
  return routerClearHumanOverride(params)
}
