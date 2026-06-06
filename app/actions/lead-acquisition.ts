"use server"

/**
 * app/actions/lead-acquisition.ts — Server Action wrappers for the
 * kernel's lead-acquisition handlers.
 *
 * Client components import from here instead of "@/lib/kernel/lead-
 * acquisition-handlers" directly. The lib module uses createServiceClient
 * + processKernelEvent — server-only — and Turbopack walks its graph
 * into Remotion when a "use client" file imports it.
 */
import { handleLeadAssigned as _handleLeadAssigned } from "@/lib/kernel/lead-acquisition-handlers"

export async function handleLeadAssigned(params: {
  leadId: string
  brokerageId: string
  agentId: string
  ruleId?: string
  method: string
  scoreAtAssignment: number
}): Promise<void> {
  return _handleLeadAssigned(params)
}
