"use server"

/**
 * app/actions/coverage-mode.ts — set/clear COVERAGE (forgotten-items #12).
 * Principal-gated (tier parity); coverage is reversible by construction:
 * the away agent's book never moves, only NEW work redirects while the
 * window is open. Both set and clear land on the lifecycle ledger.
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isTenancyPrincipal } from "@/lib/kernel/tenancy-principal"

async function principalGate() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  // user_type, never legacy users.role — PRINCIPAL_ROLES is user_type vocabulary.
  const { data: me } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  const brokerageId = (me as any)?.brokerage_id as string | null
  if (!brokerageId) return null
  const svc = createServiceClient()
  const principal = await isTenancyPrincipal(svc, { userId: user.id, brokerageId, role: String((me as any)?.user_type ?? "") })
  return principal ? { svc, brokerageId, userId: user.id } : null
}

export async function setCoverageAction(input: {
  awayAgentId: string
  coveringAgentId: string | null
  /** ISO date coverage ends; required when setting, ignored when clearing. */
  until?: string | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await principalGate()
  if (!gate) return { ok: false, error: "Principals only" }
  if (input.coveringAgentId === input.awayAgentId) return { ok: false, error: "An agent cannot cover themselves" }

  const { data: rows } = await gate.svc.from("agents")
    .select("id, brokerage_id")
    .in("id", [input.awayAgentId, input.coveringAgentId].filter(Boolean) as string[])
  const mine = ((rows ?? []) as any[]).filter((r) => r.brokerage_id === gate.brokerageId)
  if (mine.length !== (input.coveringAgentId ? 2 : 1)) return { ok: false, error: "Agent not found in your brokerage" }

  const setting = !!input.coveringAgentId
  if (setting && (!input.until || new Date(input.until).getTime() <= Date.now())) {
    return { ok: false, error: "Coverage needs an end date in the future" }
  }

  const { error } = await gate.svc.from("agents").update({
    covering_agent_id: setting ? input.coveringAgentId : null,
    coverage_until: setting ? input.until : null,
  }).eq("id", input.awayAgentId)
  if (error) return { ok: false, error: error.message }

  await sentinelWrite(gate.svc, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    brokerageId: gate.brokerageId,
    entityType: "agent",
    entityId: input.awayAgentId,
    event: setting ? "coverage_started" : "coverage_cleared",
    actorUserId: gate.userId,
    metadata: { covering_agent_id: input.coveringAgentId, until: input.until ?? null },
    auditOnly: true,
  }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  return { ok: true }
}
