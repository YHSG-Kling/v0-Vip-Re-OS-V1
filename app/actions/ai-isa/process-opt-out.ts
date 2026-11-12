"use server"

import { createServiceClient } from "@/lib/supabase/service"
import type { OptOutChannel } from "@/lib/ai-isa/opt-out-utils"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  optOutEntityBrokerage,
  writeOptOut,
  VERIFIED_INBOUND_OPT_OUT_SOURCES,
  type SessionOptOutSource,
  type OptOutResult,
} from "@/lib/ai-isa/opt-out-writer"

export interface OptOutParams {
  entityType: "contact" | "lead"
  entityId: string
  channel: OptOutChannel
  source: SessionOptOutSource
  rawMessage?: string
  /** Never used for the write — the tenant is the SESSION's, re-checked against the entity row. */
  brokerageId?: string
}

/**
 * processOptOut — the SESSION door of the TCPA-critical suppression writer.
 *
 * This is a "use server" export, i.e. a PUBLIC HTTP endpoint, so it trusts nothing
 * the caller labels. Until wave 146 it also had a sessionless branch for
 * `source: "inbound_sms" | "inbound_email" | "inbound_call"` that skipped the session
 * on the caller's word — anyone holding a contact or lead id could write a DNC
 * suppression by posting this action with `source: "inbound_sms"` (lane 146B
 * Outside-lane 6). That branch MOVED to lib/ai-isa/opt-out-writer.ts
 * processOptOutFromVerifiedInbound (no "use server" — server code only), which the
 * signature-verified inbound doors call; the write itself is
 * lib/ai-isa/opt-out-writer.ts writeOptOut, shared by both doors.
 *
 * Here: a session is REQUIRED, the entity must belong to the session's brokerage,
 * and an inbound provenance label is REFUSED (fail closed — only the verified doors
 * record it).
 */
export async function processOptOut(params: OptOutParams): Promise<OptOutResult> {
  const { entityType, entityId, channel, source, rawMessage } = params
  if (VERIFIED_INBOUND_OPT_OUT_SOURCES.has(source as string)) {
    return { success: false, channelsSuppressed: [], globalDNC: false, error: "inbound provenance is recorded only by the signature-verified inbound doors" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, channelsSuppressed: [], globalDNC: false, error: "Unauthorized" }
  }
  const supabase = createServiceClient()
  // Verify the entity belongs to the caller's brokerage. NEVER trust the
  // caller-supplied brokerageId.
  const entity = await optOutEntityBrokerage(supabase, entityType, entityId)
  if (entity.error) {
    return { success: false, channelsSuppressed: [], globalDNC: false, error: `entity read refused: ${entity.error}` }
  }
  if (!entity.brokerageId || entity.brokerageId !== ctx.brokerageId) {
    return { success: false, channelsSuppressed: [], globalDNC: false, error: "Forbidden" }
  }
  return writeOptOut(supabase, ctx.brokerageId, { entityType, entityId, channel, source, rawMessage })
}
