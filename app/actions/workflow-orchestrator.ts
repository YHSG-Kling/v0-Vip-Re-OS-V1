"use server"

/**
 * Workflow Orchestrator — server actions
 *
 * Public surface for triggering chains, advancing paused runs, and querying
 * status. UI components call these; chains themselves live in lib/.
 *
 * SECURITY: every entry point requires an authenticated session and verifies
 * that the target row (run / contact / listing / transaction) belongs to the
 * caller's brokerage BEFORE invoking the engine. Caller-supplied brokerageId
 * is never trusted — it is always re-derived from getAgentContext().
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  startRun as engineStartRun,
  advanceRun as engineAdvanceRun,
  approveStep as engineApproveStep,
  cancelRun as engineCancelRun,
} from "@/lib/workflow-orchestrator/engine"
import { getChainsByTrigger } from "@/lib/workflow-orchestrator/chains"

export interface StartChainInput {
  chainKey: string
  /** ignored — derived from session */
  brokerageId?: string
  contactId?: string | null
  listingId?: string | null
  transactionId?: string | null
  agentUserId?: string | null
  metadata?: Record<string, any>
}

// Helper: confirm a row belongs to the caller's brokerage.
async function ensureBrokerageOwnership(
  table: string,
  id: string,
  brokerageId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data } = await svc.from(table).select("brokerage_id").eq("id", id).maybeSingle()
  if (!data) return { ok: false, error: `${table} not found` }
  if (data.brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true }
}

export async function startChainRun(input: StartChainInput) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const brokerageId = ctx.brokerageId

  // Verify ownership of every referenced target row before starting the chain
  if (input.contactId) {
    const r = await ensureBrokerageOwnership("contacts", input.contactId, brokerageId)
    if (!r.ok) return { success: false, error: r.error }
  }
  if (input.listingId) {
    const r = await ensureBrokerageOwnership("listings", input.listingId, brokerageId)
    if (!r.ok) return { success: false, error: r.error }
  }
  if (input.transactionId) {
    const r = await ensureBrokerageOwnership("transactions", input.transactionId, brokerageId)
    if (!r.ok) return { success: false, error: r.error }
  }

  return await engineStartRun({
    chainKey: input.chainKey,
    brokerageId,
    contactId: input.contactId,
    listingId: input.listingId,
    transactionId: input.transactionId,
    agentUserId: input.agentUserId ?? ctx.userId,
    metadata: input.metadata,
  })
}

// Helper: verify the run belongs to the caller's brokerage.
async function ensureRunOwnership(
  runId: string,
  brokerageId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data: run } = await svc
    .from("workflow_runs")
    .select("brokerage_id")
    .eq("id", runId)
    .maybeSingle()
  if (!run) return { ok: false, error: "Run not found" }
  if (run.brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true }
}

export async function approveChainStep(params: { runId: string; stepKey: string }) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const own = await ensureRunOwnership(params.runId, ctx.brokerageId)
  if (!own.ok) return { success: false, error: own.error }
  return await engineApproveStep(params)
}

export async function cancelChainRun(params: { runId: string; reason?: string }) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const own = await ensureRunOwnership(params.runId, ctx.brokerageId)
  if (!own.ok) return { success: false, error: own.error }
  return await engineCancelRun(params.runId, params.reason)
}

export async function advanceChainRun(runId: string) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const own = await ensureRunOwnership(runId, ctx.brokerageId)
  if (!own.ok) return { success: false, error: own.error }
  return await engineAdvanceRun(runId)
}

/**
 * Trigger every chain registered for a kernel event.
 * Called from event-emitting code paths (e.g. the listing appointment scheduler
 * and the document compliance scanner). Internal callers are themselves
 * session-authenticated server actions that have already verified ownership
 * of the referenced rows; we re-check here as defense in depth.
 *
 * The caller-supplied brokerageId is IGNORED and re-derived from the session
 * so a malicious direct RPC cannot trigger chains in another brokerage.
 */
export async function triggerChainsForEvent(params: {
  eventType: string
  /** ignored — derived from session */
  brokerageId?: string
  contactId?: string | null
  listingId?: string | null
  transactionId?: string | null
  agentUserId?: string | null
  metadata?: Record<string, any>
  triggerEventId?: string | null
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { triggered: 0, results: [], error: "Unauthorized" }
  }
  const brokerageId = ctx.brokerageId

  // Verify ownership of referenced rows
  if (params.contactId) {
    const r = await ensureBrokerageOwnership("contacts", params.contactId, brokerageId)
    if (!r.ok) return { triggered: 0, results: [], error: r.error }
  }
  if (params.listingId) {
    const r = await ensureBrokerageOwnership("listings", params.listingId, brokerageId)
    if (!r.ok) return { triggered: 0, results: [], error: r.error }
  }
  if (params.transactionId) {
    const r = await ensureBrokerageOwnership("transactions", params.transactionId, brokerageId)
    if (!r.ok) return { triggered: 0, results: [], error: r.error }
  }

  const chains = getChainsByTrigger(params.eventType)
  const results: Array<{ chainKey: string; runId?: string; status?: string; error?: string }> = []

  for (const chain of chains) {
    const result = await engineStartRun({
      chainKey: chain.key,
      brokerageId,
      contactId: params.contactId,
      listingId: params.listingId,
      transactionId: params.transactionId,
      agentUserId: params.agentUserId ?? ctx.userId,
      triggerEvent: params.eventType,
      triggerEventId: params.triggerEventId,
      metadata: params.metadata,
    })
    results.push({
      chainKey: chain.key,
      runId: result.runId,
      status: result.status,
      error: result.error,
    })
  }

  return { triggered: results.length, results }
}

// ---------------------------------------------------------------------------
// Read APIs for UI surfaces (workflow status panel on contact card)
// ---------------------------------------------------------------------------

export async function getRunsForContact(contactId: string) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return []
  }
  // Verify the contact belongs to caller's brokerage
  const own = await ensureBrokerageOwnership("contacts", contactId, ctx.brokerageId)
  if (!own.ok) return []

  const svc = createServiceClient()
  const { data: runs } = await svc
    .from("workflow_runs")
    .select("id, chain_key, status, current_step_index, started_at, completed_at, error_message")
    .eq("contact_id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("started_at", { ascending: false })
  return runs ?? []
}

export async function getRunDetail(runId: string) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { run: null, steps: [] }
  }
  const own = await ensureRunOwnership(runId, ctx.brokerageId)
  if (!own.ok) return { run: null, steps: [] }

  const svc = createServiceClient()
  const [{ data: run }, { data: steps }] = await Promise.all([
    svc.from("workflow_runs").select("*").eq("id", runId).maybeSingle(),
    svc
      .from("workflow_run_steps")
      .select("*")
      .eq("run_id", runId)
      .order("step_index", { ascending: true }),
  ])
  return { run: run ?? null, steps: steps ?? [] }
}
