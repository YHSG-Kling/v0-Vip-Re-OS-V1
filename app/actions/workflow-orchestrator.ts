"use server"

/**
 * Workflow Orchestrator — server actions
 *
 * Public surface for triggering chains, advancing paused runs, and querying
 * status. UI components call these; chains themselves live in lib/.
 */

import { createServiceClient } from "@/lib/supabase/service"
import {
  startRun as engineStartRun,
  advanceRun as engineAdvanceRun,
  approveStep as engineApproveStep,
  cancelRun as engineCancelRun,
} from "@/lib/workflow-orchestrator/engine"
import { getChainsByTrigger } from "@/lib/workflow-orchestrator/chains"

export interface StartChainInput {
  chainKey: string
  brokerageId: string
  contactId?: string | null
  listingId?: string | null
  transactionId?: string | null
  agentUserId?: string | null
  metadata?: Record<string, any>
}

export async function startChainRun(input: StartChainInput) {
  return await engineStartRun(input)
}

export async function approveChainStep(params: { runId: string; stepKey: string }) {
  return await engineApproveStep(params)
}

export async function cancelChainRun(params: { runId: string; reason?: string }) {
  return await engineCancelRun(params.runId, params.reason)
}

export async function advanceChainRun(runId: string) {
  return await engineAdvanceRun(runId)
}

/**
 * Trigger every chain registered for a kernel event.
 * Called from event-emitting code paths (e.g. the listing appointment scheduler).
 */
export async function triggerChainsForEvent(params: {
  eventType: string
  brokerageId: string
  contactId?: string | null
  listingId?: string | null
  transactionId?: string | null
  agentUserId?: string | null
  metadata?: Record<string, any>
  triggerEventId?: string | null
}) {
  const chains = getChainsByTrigger(params.eventType)
  const results: Array<{ chainKey: string; runId?: string; status?: string; error?: string }> = []

  for (const chain of chains) {
    const result = await engineStartRun({
      chainKey: chain.key,
      brokerageId: params.brokerageId,
      contactId: params.contactId,
      listingId: params.listingId,
      transactionId: params.transactionId,
      agentUserId: params.agentUserId,
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
  const svc = createServiceClient()
  const { data: runs } = await svc
    .from("workflow_runs")
    .select("id, chain_key, status, current_step_index, started_at, completed_at, error_message")
    .eq("contact_id", contactId)
    .order("started_at", { ascending: false })
  return runs ?? []
}

export async function getRunDetail(runId: string) {
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
