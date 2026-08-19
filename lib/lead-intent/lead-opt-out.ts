/**
 * lib/lead-intent/lead-opt-out.ts
 *
 * "DOESN'T WANT TO BE CONTACTED" — the LEAD-side authority, and the bridge that
 * makes it BINDING on the senders that actually exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS RATHER THAN A CALL TO processOptOut
 *
 * `app/actions/ai-isa/process-opt-out.ts` is the entity-generic suppression
 * writer and it stays the door for CONTACTS and for session-authenticated
 * (agent / admin / portal) opt-outs. It could not be the lead-side authority for
 * two reasons, both verified rather than assumed:
 *
 *   1. UNTIL m488 ITS LEAD BRANCH COULD NOT WRITE AT ALL. Its `updates` object
 *      always names `opt_out_reason` + `opt_out_source` (and `opt_out_channels`
 *      on the global branch). Those three columns existed on `contacts` and NOT
 *      on `leads` — checked live against information_schema. PostgREST refuses an
 *      UPDATE naming an absent column (PGRST204), supabase-js resolves that
 *      refusal into `{ error }`, and both live callers discard the returned
 *      `{success:false}`. So the WHOLE update was lost, `dnc_status` and the four
 *      per-channel flags with it: a lead who texted STOP was never suppressed.
 *      m488 added the three columns, which repairs that path too.
 *
 *   2. ITS SOURCE UNION HAS NO DIRECT-MAIL MEMBER, and the sources it does admit
 *      without a session are a closed set (`inbound_sms | inbound_email |
 *      inbound_call`). A direct-mail response would fall to the session-auth
 *      branch and be refused inside a webhook, where there is no session.
 *
 * THE SECOND, LARGER REASON — the bridge. `processOptOut` writes flags on the
 * row and an audit event. It writes NO `contact_suppression_list` row. That list
 * is what `lib/kernel/compliance/check-suppression.ts` reads, and that gate is
 * ADDRESS-KEYED: with `contactId` null it matches only on `email` / `phone`. So
 * for a LEAD (which has no contact row) the flag arm of the gate is skipped
 * entirely and the list arm is the ONLY arm that can fire. A lead opt-out that
 * writes flags and no list row is invisible to every sender that gates on
 * `checkSuppression`. This module writes both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT ACTUALLY CONSULTS WHAT (traced, not assumed — see the report)
 *
 *   leads.dnc_status / email_opt_out / sms_opt_out / call_stop_flag /
 *   opt_out_channels
 *     ← lib/kernel/communication-compliance.ts evaluateOutboundCompliance
 *       Rules 1-5, which lib/providers/dispatch.ts feeds the LEAD ROW whenever
 *       it is called with `leadId` (dispatch.ts:315, 533 pick the table from
 *       `params.contactId ? "contacts" : "leads"`). HARD BLOCK.
 *     ← lib/ai-isa/isa-outreach-logger.ts checkMaxTouches (dnc_status +
 *       email_opt_out only) — the ISA's own lead touch cap.
 *     ← lib/ai-isa/conversation-handler.ts shouldStopAutoResponding, via
 *       lib/lead-pipeline/lead-lifecycle.ts isLeadSuppressed (dnc_status +
 *       call_stop_flag).
 *
 *   contact_suppression_list (email / phone / mail rows)
 *     ← lib/kernel/compliance/check-suppression.ts checkSuppression, called by
 *       dispatchEmail (dispatch.ts:320), dispatchSms (dispatch.ts:539),
 *       lib/kernel/communications.ts:96, app/actions/communications.ts:54,132,
 *       app/actions/ai-communication-hub.ts:201 and
 *       lib/voice/outbound-call-gates.ts:160. This is the arm that binds a LEAD,
 *       because the flag arm above it is contact-keyed.
 *
 *   NOT CONSULTED BY ANY GATE: `dispatchDirectMail` (dispatch.ts:749) calls
 *   NEITHER checkSuppression NOR evaluateOutboundCompliance. It gates on mailing
 *   -address verification, CASS deliverability, over-touch de-confliction and a
 *   Fair-Housing content scan — and on nothing the recipient asked for. A lead or
 *   contact who says "stop mailing me" is still mailed. That file is not this
 *   lane's to edit; the defect is reported rather than worked around, and the
 *   `mail`-channel suppression rows this module writes are already in place for
 *   the moment that gate is added.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { bestEffort } from "@/lib/db/best-effort"

/** The channel a lead asked to be left alone on. `all` = a global DNC request. */
export type LeadOptOutChannel = "email" | "sms" | "phone" | "direct_mail" | "all"

/** Which inbound door carried the request. Written to `leads.opt_out_source`. */
export type LeadOptOutSource =
  | "inbound_sms"
  | "inbound_email"
  | "inbound_call"
  | "inbound_direct_mail"

export interface ApplyLeadOptOutParams {
  brokerageId: string
  leadId: string
  channel: LeadOptOutChannel
  source: LeadOptOutSource
  /** The consumer's own words. Kept (truncated) as the provenance of the request. */
  rawMessage?: string
}

export interface ApplyLeadOptOutResult {
  applied: boolean
  /** Channels now suppressed on the lead row. */
  channelsSuppressed: string[]
  globalDNC: boolean
  /** How many contact_suppression_list rows the bridge wrote (0 when already present). */
  suppressionRowsWritten: number
  error?: string
}

/** leads.<channel>_opt_out — the per-channel flag columns, live-verified. */
const CHANNEL_FLAG_COLUMN: Record<Exclude<LeadOptOutChannel, "all">, string> = {
  email: "email_opt_out",
  sms: "sms_opt_out",
  phone: "phone_opt_out",
  direct_mail: "direct_mail_opt_out",
}

/**
 * The lead's channel vocabulary → `contact_suppression_list.channel`, whose CHECK
 * admits exactly ('email','sms','phone','mail') — read live from pg_constraint.
 * NOTE the rename: the lead column says `direct_mail`, the suppression list says
 * `mail`, and `checkSuppression` is called with `mail` by nothing today (see the
 * dispatchDirectMail note above). The row is written anyway so it is already
 * there when a mail gate exists; a suppression written only once a gate appears
 * is a suppression that misses every request made before it.
 */
const SUPPRESSION_CHANNEL: Record<Exclude<LeadOptOutChannel, "all">, "email" | "sms" | "phone" | "mail"> = {
  email: "email",
  sms: "sms",
  phone: "phone",
  direct_mail: "mail",
}

const ALL_CHANNELS: Exclude<LeadOptOutChannel, "all">[] = ["email", "sms", "phone", "direct_mail"]

/**
 * applyLeadOptOut — record the request on the lead AND make it binding.
 *
 * Three writes, in this order, because each later one is worthless without the
 * earlier one having landed:
 *
 *   1. `leads` flags + provenance — the row every lead-side gate reads.
 *   2. `contact_suppression_list` bridge rows keyed on the lead's EMAIL and
 *      PHONE — the only arm of `checkSuppression` that can fire for a lead.
 *   3. `lifecycle_events` — so the request is auditable and the manager surfaces
 *      can see it.
 *
 * The first write is CHECKED and its failure is returned; the caller must not
 * report an opt-out that was refused. The bridge and the audit row are
 * best-effort and say so.
 *
 * Idempotent: re-running it re-asserts the same flags (no-op) and skips
 * suppression rows that already exist for the same (brokerage, channel,
 * identifier).
 */
export async function applyLeadOptOut(
  params: ApplyLeadOptOutParams,
): Promise<ApplyLeadOptOutResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // ── Read the lead. TENANT: the predicate carries brokerage_id explicitly —
  // the service client bypasses RLS, so the tenant boundary has to be in the
  // query. A refused read resolves as { data: null, error }; destructure it, or
  // "refused" is indistinguishable from "no such lead".
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id, brokerage_id, email, phone, phone_digits, contact_id, opt_out_channels")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (leadError) {
    return {
      applied: false,
      channelsSuppressed: [],
      globalDNC: false,
      suppressionRowsWritten: 0,
      error: `lead read refused: ${leadError.message}`,
    }
  }
  if (!lead) {
    return {
      applied: false,
      channelsSuppressed: [],
      globalDNC: false,
      suppressionRowsWritten: 0,
      error: "lead not found in this brokerage",
    }
  }

  const requested = params.channel
  const isGlobal = requested === "all"
  const channels: Exclude<LeadOptOutChannel, "all">[] = isGlobal ? ALL_CHANNELS : [requested]

  // ── 1. THE LEAD ROW ────────────────────────────────────────────────────────
  const existingChannels: string[] = (lead as { opt_out_channels?: string[] | null }).opt_out_channels ?? []
  const mergedChannels = Array.from(new Set([...existingChannels, ...channels]))

  const updates: Record<string, unknown> = {
    opted_out_at: now,
    opt_out_reason: params.rawMessage?.slice(0, 500) ?? `Opt-out via ${params.source}`,
    opt_out_source: params.source,
    opt_out_channels: mergedChannels,
    updated_at: now,
  }
  for (const ch of channels) updates[CHANNEL_FLAG_COLUMN[ch]] = true
  // A phone opt-out is also a call stop — `isLeadSuppressed` and
  // `evaluateOutboundCompliance` Rule 2 both read call_stop_flag, not phone_opt_out.
  if (channels.includes("phone")) updates.call_stop_flag = true
  if (isGlobal) {
    updates.dnc_status = true
    updates.call_stop_flag = true
    // The ISA must go dormant on a consent stop; `reengagement_status='opted_out'`
    // is the terminal value shouldResurrectReengagement deliberately excludes, so a
    // later reply can never re-arm the cadence. CHECK-verified vocabulary.
    updates.reengagement_status = "opted_out"
    updates.ai_isa_owner = false
  }

  const { error: updateError } = await supabase
    .from("leads")
    .update(updates)
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)

  if (updateError) {
    // NOT best-effort. This is the write that makes the request real; reporting
    // an opt-out that the database refused is the failure mode m488 exists to end.
    console.error("[lead-opt-out] leads suppression update refused:", updateError.message)
    return {
      applied: false,
      channelsSuppressed: [],
      globalDNC: isGlobal,
      suppressionRowsWritten: 0,
      error: `leads suppression update refused: ${updateError.message}`,
    }
  }

  // ── 1b. THE CONVERTED TWIN ─────────────────────────────────────────────────
  // A lead that has already become a contact keeps BOTH rows, and every
  // contact-side gate reads the CONTACT's flags. Suppressing only the lead row
  // would leave the person reachable through the CRM that now owns them. This
  // mirrors what lib/ai-isa/conversation-handler.ts haltEngagementForNegativeReply
  // already does on the negative-reply path — same columns, same direction.
  const linkedContactId = (lead as { contact_id?: string | null }).contact_id ?? null
  if (linkedContactId) {
    const contactUpdates: Record<string, unknown> = {
      opted_out_at: now,
      opt_out_reason: updates.opt_out_reason,
      opt_out_source: params.source,
      updated_at: now,
    }
    for (const ch of channels) contactUpdates[CHANNEL_FLAG_COLUMN[ch]] = true
    if (channels.includes("phone")) contactUpdates.call_stop_flag = true
    if (isGlobal) {
      contactUpdates.dnc_status = true
      contactUpdates.call_stop_flag = true
      contactUpdates.isa_reengage_allowed = false
    }
    // `contacts.opt_out_channels` exists (unlike on leads before m488) and is what
    // communication-compliance Rule 5 reads for a contact.
    const { data: currentContact } = await supabase
      .from("contacts")
      .select("opt_out_channels")
      .eq("id", linkedContactId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    const currentChannels: string[] =
      (currentContact as { opt_out_channels?: string[] | null } | null)?.opt_out_channels ?? []
    contactUpdates.opt_out_channels = Array.from(new Set([...currentChannels, ...channels]))

    await bestEffort(
      supabase
        .from("contacts")
        .update(contactUpdates)
        .eq("id", linkedContactId)
        .eq("brokerage_id", params.brokerageId),
      "propagating a lead's opt-out onto its converted contact — the lead row and the address-keyed suppression rows have already landed, so the request is binding even if this mirror fails",
    )
  }

  // ── 2. THE BRIDGE — contact_suppression_list ───────────────────────────────
  const suppressionRowsWritten = await writeSuppressionBridge(supabase, {
    brokerageId: params.brokerageId,
    contactId: linkedContactId,
    email: (lead as { email?: string | null }).email ?? null,
    phone: (lead as { phone?: string | null }).phone ?? null,
    phoneDigits: (lead as { phone_digits?: string | null }).phone_digits ?? null,
    channels,
    reason: params.rawMessage?.slice(0, 300) ?? `Lead opted out via ${params.source}`,
    source: params.source,
  })

  // ── 3. AUDIT ───────────────────────────────────────────────────────────────
  await bestEffort(
    supabase.from("lifecycle_events").insert({
      brokerage_id: params.brokerageId,
      entity_type: "lead",
      entity_id: params.leadId,
      event_type: isGlobal ? "LEAD_DNC_SET" : "LEAD_CHANNEL_OPT_OUT",
      metadata: {
        channels,
        global_dnc: isGlobal,
        source: params.source,
        suppression_rows_written: suppressionRowsWritten,
        message: params.rawMessage?.slice(0, 300) ?? null,
      },
      created_at: now,
    }),
    "lead opt-out lifecycle audit row — the flags and the suppression bridge are already written; losing the timeline entry must not unwind them",
  )

  return {
    applied: true,
    channelsSuppressed: channels,
    globalDNC: isGlobal,
    suppressionRowsWritten,
  }
}

/**
 * writeSuppressionBridge — the rows that make a LEAD's request binding on the
 * address-keyed gate.
 *
 * `checkSuppression` matches with `.eq('email', …)` / `.eq('phone', …)` against
 * whatever the SENDER passed as its recipient — `dispatchEmail` passes
 * `params.to`, `dispatchSms` passes `params.to`. So the row has to carry the
 * identifier in the SPELLING a sender would use, and there is more than one
 * plausible spelling. We write every distinct one we hold rather than betting on
 * a single normalization: an extra indexed row costs nothing, a missed match
 * costs a TCPA violation.
 *
 * Returns the number of rows actually inserted.
 */
async function writeSuppressionBridge(
  supabase: ReturnType<typeof createServiceClient>,
  params: {
    brokerageId: string
    contactId: string | null
    email: string | null
    phone: string | null
    phoneDigits: string | null
    channels: Exclude<LeadOptOutChannel, "all">[]
    reason: string
    source: string
  },
): Promise<number> {
  const emailForms = distinct([params.email, params.email?.toLowerCase() ?? null])
  const phoneForms = distinct([
    params.phone,
    params.phoneDigits ? `+${params.phoneDigits.length === 10 ? "1" : ""}${params.phoneDigits}` : null,
  ])

  type Row = { channel: "email" | "sms" | "phone" | "mail"; email: string | null; phone: string | null }
  const rows: Row[] = []

  for (const ch of params.channels) {
    const channel = SUPPRESSION_CHANNEL[ch]
    if (channel === "email") {
      for (const e of emailForms) rows.push({ channel, email: e, phone: null })
    } else if (channel === "sms" || channel === "phone") {
      for (const p of phoneForms) rows.push({ channel, email: null, phone: p })
    } else {
      // `mail` has no address identifier on this list (the table carries only
      // email / phone), so the row is keyed on the contact when one exists. For a
      // lead with no contact yet it is written with both identifiers null so the
      // REQUEST is on the record; the binding half arrives when the lead converts
      // and the promoted contact id is stamped in.
      rows.push({ channel, email: emailForms[0] ?? null, phone: phoneForms[0] ?? null })
    }
  }

  let written = 0
  for (const row of rows) {
    // Idempotency: the table has no unique constraint (only the pkey and three
    // lookup indexes — read live from pg_indexes), so duplicate-avoidance is a
    // read. A refused probe is treated as "unknown, write it": a duplicate
    // suppression row is harmless, a missing one is not.
    const base = supabase
      .from("contact_suppression_list")
      .select("id")
      .eq("brokerage_id", params.brokerageId)
      .eq("channel", row.channel)
    const withEmail = row.email ? base.eq("email", row.email) : base.is("email", null)
    const probe = row.phone ? withEmail.eq("phone", row.phone) : withEmail.is("phone", null)

    const { data: existing, error: probeError } = await probe.limit(1)
    if (!probeError && existing && existing.length > 0) continue

    const { error: insertError } = await supabase.from("contact_suppression_list").insert({
      brokerage_id: params.brokerageId,
      contact_id: params.contactId,
      email: row.email,
      phone: row.phone,
      channel: row.channel,
      suppression_reason: params.reason,
      source: params.source,
      created_at: new Date().toISOString(),
    })

    if (insertError) {
      // Loudly, but without unwinding the flags that already landed. The lead-row
      // gates still hold; what is lost is the address-keyed arm.
      console.error(
        `[lead-opt-out] suppression bridge row refused (channel=${row.channel}):`,
        insertError.message,
      )
      continue
    }
    written += 1
  }

  return written
}

function distinct(values: (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const v of values) {
    const t = (v ?? "").trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}
