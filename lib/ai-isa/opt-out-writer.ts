/**
 * lib/ai-isa/opt-out-writer.ts — THE ONE TCPA/DNC SUPPRESSION WRITER (wave 146, lane 146Z).
 *
 * NOT a "use server" module, on purpose. Before wave 146 the whole writer lived in
 * app/actions/ai-isa/process-opt-out.ts, a "use server" file — i.e. a PUBLIC HTTP
 * endpoint — and its webhook branch trusted the CALLER's `source` label: posting the
 * action with `source: "inbound_sms"` skipped the session entirely, so anyone holding
 * a contact or lead id could write a suppression (lane 146B Outside-lane 6, release
 * critical under ruling 20 priority 1). The split:
 *
 *   · processOptOutFromVerifiedInbound — the sessionless door. Importable only by
 *     server code; called ONLY by the signature-verified inbound doors
 *     (app/api/providers/inbound, the Twilio voice turn route, the voice relay plan,
 *     lib/communications/inbound-record.ts's processInboundCommunication). It is not
 *     reachable over HTTP because this file carries no "use server" directive.
 *   · app/actions/ai-isa/process-opt-out.ts processOptOut — the session door
 *     (agent / admin / portal / voice); it REFUSES every webhook provenance label.
 *   · writeOptOut — the shared write both doors run once the tenant is known.
 *
 * In both doors the effective brokerage is the ENTITY ROW's — never a caller param —
 * and a caller-supplied brokerageId that disagrees with the row is refused (the
 * pre-146 comment promised that re-check; the code never made it).
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { KernelEvent } from "@/lib/kernel/events"
// From its own module, not the lib/kernel barrel (the barrel would drag every kernel module into each importer's graph).
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import type { OptOutChannel } from "@/lib/ai-isa/opt-out-utils"

/**
 * Inbound provenance — the doors that verified a provider signature before calling.
 * `inbound_social` (wave 146): a social DM / message STOP, which the C1 record used to
 * write as `inbound_sms` provenance for want of a value. `opt_out_source` has no CHECK.
 */
type VerifiedInboundOptOutSource = "inbound_sms" | "inbound_email" | "inbound_call" | "inbound_social"
/** Session provenance — a signed-in person recorded it. */
export type SessionOptOutSource = "portal" | "agent" | "admin" | "voice"
type OptOutSource = VerifiedInboundOptOutSource | SessionOptOutSource

export const VERIFIED_INBOUND_OPT_OUT_SOURCES: ReadonlySet<string> = new Set<VerifiedInboundOptOutSource>([
  "inbound_sms", "inbound_email", "inbound_call", "inbound_social",
])

interface OptOutWriteParams {
  entityType: "contact" | "lead"
  entityId: string
  channel: OptOutChannel
  source: OptOutSource
  rawMessage?: string
}

export interface OptOutResult {
  success: boolean
  channelsSuppressed: string[]
  globalDNC: boolean
  error?: string
}

type Svc = ReturnType<typeof createServiceClient>

const refused = (error: string): OptOutResult => ({ success: false, channelsSuppressed: [], globalDNC: false, error })

/** The tenant of the entity row, read on the service client; the read error is READ, never swallowed. */
export async function optOutEntityBrokerage(
  supabase: Svc,
  entityType: "contact" | "lead",
  entityId: string,
): Promise<{ brokerageId: string | null; error: string | null }> {
  const table = entityType === "contact" ? "contacts" : "leads"
  const { data, error } = await supabase.from(table).select("brokerage_id").eq("id", entityId).maybeSingle()
  if (error) return { brokerageId: null, error: error.message }
  return { brokerageId: (data as { brokerage_id?: string | null } | null)?.brokerage_id ?? null, error: null }
}

/**
 * The SESSIONLESS door — for the signature-verified inbound routes only. Never a
 * "use server" export. The tenant is the entity row's; a caller brokerageId that
 * disagrees with it is refused (fail closed — a forged id cannot redirect the write).
 */
export async function processOptOutFromVerifiedInbound(
  params: OptOutWriteParams & { source: VerifiedInboundOptOutSource; brokerageId?: string | null },
  deps: OptOutWriteDeps = {},
): Promise<OptOutResult> {
  if (!VERIFIED_INBOUND_OPT_OUT_SOURCES.has(params.source)) return refused("not an inbound provenance")
  const supabase = deps.client ?? createServiceClient()
  const entity = await optOutEntityBrokerage(supabase, params.entityType, params.entityId)
  if (entity.error) return refused(`entity read refused: ${entity.error}`)
  if (!entity.brokerageId) return refused("Entity not found")
  if (params.brokerageId && params.brokerageId !== entity.brokerageId) return refused("Forbidden")
  return writeOptOut(supabase, entity.brokerageId, params, deps)
}

/** Seams for the in-memory proofs (scripts/inbound-communication-guard.ts §I); production passes none. */
interface OptOutWriteDeps {
  client?: Svc
  /** the kernel event fan-out (default: lib/kernel processKernelEvent). */
  emit?: typeof processKernelEvent
}

/** The shared write — run by both doors once the tenant is proven. */
export async function writeOptOut(supabase: Svc, brokerageId: string, params: OptOutWriteParams, deps: OptOutWriteDeps = {}): Promise<OptOutResult> {
  const { entityType, entityId, channel, source, rawMessage } = params
  const channelsSuppressed: string[] = []
  let globalDNC = false
  const now = new Date().toISOString()

  // Determine scope of suppression
  const isGlobal =
    channel === "all" ||
    (rawMessage != null &&
      /\b(stop all|do not contact|dnc|remove me from everything|unsubscribe all)\b/i.test(rawMessage))

  const updates: Record<string, unknown> = {
    opted_out_at: now,
    opt_out_reason: rawMessage?.slice(0, 500) ?? `Opt-out via ${source}`,
    opt_out_source: source,
    updated_at: now,
  }

  const table = entityType === "contact" ? "contacts" : "leads"

  if (isGlobal) {
    updates.dnc_status = true
    updates.email_opt_out = true
    updates.sms_opt_out = true
    updates.phone_opt_out = true
    updates.direct_mail_opt_out = true
    updates.opt_out_channels = ["email", "sms", "phone", "direct_mail"]
    // contacts table has isa_reengage_allowed; leads table does not
    if (entityType === "contact") {
      updates.isa_reengage_allowed = false
    }
    channelsSuppressed.push("email", "sms", "phone", "direct_mail")
    globalDNC = true
  } else {
    const channelColumn: Partial<Record<OptOutChannel, string>> = {
      email: "email_opt_out",
      sms: "sms_opt_out",
      phone: "phone_opt_out",
      direct_mail: "direct_mail_opt_out",
    }
    const col = channelColumn[channel]
    if (col) {
      updates[col] = true
      channelsSuppressed.push(channel)
      // Append channel to opt_out_channels array via fetch-and-update
      // (Supabase does not expose array append in a single update call)
      const { data: current } = await supabase
        .from(table)
        .select("opt_out_channels")
        .eq("id", entityId)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()

      if (current) {
        const existing: string[] = (current as { opt_out_channels?: string[] }).opt_out_channels ?? []
        if (!existing.includes(channel)) {
          updates.opt_out_channels = [...existing, channel]
        }
      }
    }
  }

  // The suppression itself. COUNTED (CLAUDE.md §3): an UPDATE that matches nothing
  // resolves exactly like one that worked, and "opted out" must never be reported for a
  // row that was not written.
  const { data: updated, error: updateError } = await supabase
    .from(table)
    .update(updates)
    .eq("id", entityId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (updateError) {
    console.error("[processOptOut] DB update failed:", updateError)
    return refused(updateError.message)
  }
  if (!updated || updated.length === 0) return refused("suppression matched no row in this brokerage")

  // Compliance audit — always write, never block on failure.
  //
  // "Never block on failure" was the intent; dropping the result was the
  // implementation. supabase-js resolves a rejected insert, so a failed write to
  // the OPT-OUT audit record — the row proving the OS honoured a consumer's
  // request to be left alone — produced no error, no log, and no row. bestEffort
  // keeps it non-blocking AND makes the failure visible, which is what
  // "tolerated" is supposed to mean.
  //
  // sentinelWrite rather than bestEffort: `supabase` here is createServiceClient(),
  // so the loss reaches self_heal_events and the weekly repair digest RANKS it,
  // instead of a console.warn nobody greps. The split is a precondition, not a
  // preference — on a user-scoped client the ledger insert is RLS-refused and the
  // sentinel would be WEAKER (lib/kernel/write-sentinel.ts).
  await sentinelWrite(
    supabase,
    supabase
    .from("compliance_events")
    .insert({
      brokerage_id: brokerageId,
      gate_name: "opt_out_processor",
      allowed: false,
      violations: [`Opt-out received via ${source}: ${channel}`],
      blocked_reason: `Contact opted out of ${channel} via ${source}`,
      actor_role: "system",
      entity_type: entityType,
      entity_id: entityId,
      message_type: channel,
    }),
    {
      table: "compliance_events",
      flow: "opt_out_audit",
      brokerageId,
      reason: "opt-out compliance audit row — the suppression itself is written above and error-checked; this is the proof-of-honouring echo, and it must never block a consumer's request to be left alone",
    },
  )

  // Agent notification via activities (uses notes: text, not metadata)
  const { data: entity } = await supabase
    .from(table)
    .select("agent_id, first_name, last_name")
    .eq("id", entityId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (entity?.agent_id) {
    const notesPayload = JSON.stringify({
      opt_out_channel: channel,
      source,
      global_dnc: globalDNC,
      channels_suppressed: channelsSuppressed,
    })

    // THE consumer-facing compliance record of an opt-out. This is the row a
    // broker would hand a regulator to show the request was received and acted
    // on, so it does not get to fail quietly.
    const { error: optOutActivityError } = await supabase
      .from("activities")
      .insert({
        agent_id: entity.agent_id,
        contact_id: entityType === "contact" ? entityId : null,
        brokerage_id: brokerageId,
        activity_type: globalDNC ? "contact_dnc_set" : "contact_channel_opt_out",
        title: globalDNC
          ? `${entity.first_name} opted out of ALL communications`
          : `${entity.first_name} opted out of ${channel}`,
        description: rawMessage
          ? `Message received: "${rawMessage.slice(0, 200)}"`
          : `Opt-out recorded via ${source}`,
        status: "completed",
        priority: "high",
        notes: notesPayload,
      })
    if (optOutActivityError) {
      console.error("[processOptOut] opt-out activity REJECTED — the suppression is applied but has no timeline record:", optOutActivityError.message)
    }
  }

  // Kernel event — downstream automation stops automatically
  await (deps.emit ?? processKernelEvent)({
    event: globalDNC ? KernelEvent.CONTACT_DNC_SET : KernelEvent.CONTACT_CHANNEL_OPT_OUT,
    brokerageId,
    entityType,
    entityId,
  })

  return { success: true, channelsSuppressed, globalDNC }
}
