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

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER DIRECTION — REOPENING A LEAD WHO CAME BACK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OWNER RULING (this lane): "A positive reply from an opted-out lead REOPENS them
 * automatically." The inbound message IS the consent signal — the person
 * re-initiated contact — and the reopen must be RECORDED, not silent.
 *
 * ── WHAT GUARDS THIS, ABOVE ─────────────────────────────────────────────────
 *
 * This function does NOT decide that a message is positive. It is called from
 * lib/lead-intent/inbound-lead-intent.ts ONLY after:
 *   1. `detectOptOutIntent` has already run and did NOT fire (opt-out detection
 *      is Step 2 and still wins — a message saying "stop" can never reach here);
 *   2. the ONE existing classifier (lib/ai-isa/inbound-intent-classifier.ts
 *      classifyAndRouteInbound) returned a CLEAR POSITIVE. Ambiguous stays held.
 *
 * ── WHAT IT UNDOES: EXACTLY WHAT applyLeadOptOut WROTE, AND NOTHING ELSE ────
 *
 * The mirror image of the three writes above, in the same order and with the same
 * failure discipline:
 *
 *   1. `leads` flags + provenance — cleared. CHECKED; a refused clear is returned,
 *      never reported as a reopen. This is the write that makes the reopen real:
 *      `evaluateOutboundCompliance` Rule 1 hard-blocks EVERY channel on
 *      dnc_status alone, so a reopen that does not clear it is a no-op.
 *   2. the converted twin's `contacts` flags — mirrored back (best-effort; the
 *      lead row and the list rows are what bind a lead).
 *   3. `contact_suppression_list` — the rows THIS module wrote are removed. That
 *      table has no `removed_at`/`is_active` column (live schema: id,
 *      brokerage_id, contact_id, email, phone, channel, suppression_reason,
 *      source, created_at) and `checkSuppression` matches any row it finds, so
 *      "un-suppress" can only be a delete. The removed rows are captured VERBATIM
 *      into the audit event below, so the ledger keeps the record the table can
 *      no longer hold. Only rows whose `source` is one of the four lead inbound
 *      sources are touched — an email-footer unsubscribe or an admin-entered
 *      suppression is somebody else's record and survives.
 *   4. `lifecycle_events` — the SAME audit ledger applyLeadOptOut writes
 *      (LEAD_DNC_SET / LEAD_CHANNEL_OPT_OUT); this is its counterpart,
 *      LEAD_REOPENED_ON_INBOUND_INTENT. NOT best-effort, unlike the opt-out side:
 *      the ruling says the reopen must be recorded, so a refused audit write is
 *      surfaced in the result rather than swallowed.
 *
 * ── WHAT IT DELIBERATELY DOES **NOT** TOUCH ─────────────────────────────────
 *
 *   `tcpa_consent` — never set true here. TCPA express consent is a thing the
 *   person gives on a form, not something an inbound "yes" back-fills. Rule 7 of
 *   evaluateOutboundCompliance still gates sms/phone/voicemail on it after a
 *   reopen, which is the point.
 *   `email_unsubscribed` / `sms_unsubscribed` on the contact — those are the
 *   email-footer/carrier lane's columns; applyLeadOptOut never wrote them, so
 *   this must not clear them.
 */
export interface ReopenLeadOnInboundConsentParams {
  brokerageId: string
  leadId: string
  /** The transport the person re-initiated on. Recorded; the reopen itself is global. */
  source: LeadOptOutSource
  /** The lead's own words — the consent signal that justifies the reopen. REQUIRED. */
  rawMessage: string
  /** What decided this was a clear positive, from the ONE classifier. */
  intent?: { side?: string | null; reason?: string | null }
  /** Provider message id of the message that justified it, when the channel has one. */
  providerRef?: string | null
}

export interface ReopenLeadResult {
  reopened: boolean
  /** Channels no longer suppressed on the lead row. */
  channelsReopened: string[]
  /** Was a global DNC standing before this? */
  clearedGlobalDNC: boolean
  /** contact_suppression_list rows removed (and captured into the audit event). */
  suppressionRowsRemoved: number
  /** Did the compliance/audit event actually land? A reopen must not be silent. */
  recorded: boolean
  error?: string
}

/** The four sources applyLeadOptOut stamps. Only rows carrying one of these are
 *  ours to remove — anything else on the suppression list is another lane's record. */
const LEAD_INBOUND_SOURCES: LeadOptOutSource[] = [
  "inbound_sms",
  "inbound_email",
  "inbound_call",
  "inbound_direct_mail",
]

export async function reopenLeadOnInboundConsent(
  params: ReopenLeadOnInboundConsentParams,
): Promise<ReopenLeadResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const fail = (error: string): ReopenLeadResult => ({
    reopened: false,
    channelsReopened: [],
    clearedGlobalDNC: false,
    suppressionRowsRemoved: 0,
    recorded: false,
    error,
  })

  const message = (params.rawMessage ?? "").trim()
  if (!message) {
    // The message IS the consent signal. Without it there is nothing to record and
    // therefore nothing that justifies lifting a consent stop.
    return fail("reopen refused: no message text to justify it")
  }

  // ── Read the lead. TENANT in the predicate — the service client bypasses RLS.
  // A refused read resolves as { data: null, error }; a swallowed one would be
  // indistinguishable from "no such lead" and would lift a stop on a row we never saw.
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select(
      "id, brokerage_id, email, phone, phone_digits, contact_id, dnc_status, opt_out_channels, " +
        "opt_out_source, opt_out_reason, opted_out_at, email_opt_out, sms_opt_out, phone_opt_out, " +
        "direct_mail_opt_out, call_stop_flag, reengagement_status",
    )
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (leadError) return fail(`lead read refused: ${leadError.message}`)
  if (!lead) return fail("lead not found in this brokerage")

  // The generated Supabase types predate m488's three columns, so the select
  // resolves to an error shape rather than a row. Cast through `unknown` — the
  // columns are live-verified (m488) and the values are read defensively below.
  const row = lead as unknown as Record<string, unknown>
  const before = {
    dnc_status: row.dnc_status ?? null,
    opt_out_channels: (row.opt_out_channels as string[] | null) ?? [],
    opt_out_source: row.opt_out_source ?? null,
    opt_out_reason: row.opt_out_reason ?? null,
    opted_out_at: row.opted_out_at ?? null,
    email_opt_out: row.email_opt_out ?? null,
    sms_opt_out: row.sms_opt_out ?? null,
    phone_opt_out: row.phone_opt_out ?? null,
    direct_mail_opt_out: row.direct_mail_opt_out ?? null,
    call_stop_flag: row.call_stop_flag ?? null,
    reengagement_status: row.reengagement_status ?? null,
  }

  // ── 1. THE LEAD ROW — clear every flag applyLeadOptOut can set ─────────────
  // A GLOBAL stop is ONE request, and it is that one request the person has just
  // retracted, so the reopen is global too. Leaving three of four channels
  // standing would produce a lead the OS calls "reopened" and still cannot reach.
  const updates: Record<string, unknown> = {
    dnc_status: false,
    call_stop_flag: false,
    opt_out_channels: [],
    opted_out_at: null,
    opt_out_reason: null,
    opt_out_source: null,
    // The ISA went dormant with reengagement_status='opted_out' (the terminal value
    // shouldResurrectReengagement deliberately excludes). Re-arm it here, because
    // that resurrection path is the one thing that can NEVER re-arm it itself.
    reengagement_status: "active",
    reengagement_attempt_count: 0,
    updated_at: now,
  }
  for (const ch of ALL_CHANNELS) updates[CHANNEL_FLAG_COLUMN[ch]] = false

  const { error: updateError } = await supabase
    .from("leads")
    .update(updates)
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)

  if (updateError) {
    // NOT best-effort, exactly as on the opt-out side: reporting a reopen the
    // database refused is the same class of lie m488 exists to end.
    console.error("[lead-opt-out] reopen update refused:", updateError.message)
    return fail(`leads reopen update refused: ${updateError.message}`)
  }

  // ── 2. THE CONVERTED TWIN ──────────────────────────────────────────────────
  const linkedContactId = (row.contact_id as string | null) ?? null
  if (linkedContactId) {
    const contactUpdates: Record<string, unknown> = {
      dnc_status: false,
      call_stop_flag: false,
      opt_out_channels: [],
      opted_out_at: null,
      opt_out_reason: null,
      opt_out_source: null,
      isa_reengage_allowed: true,
      updated_at: now,
    }
    for (const ch of ALL_CHANNELS) contactUpdates[CHANNEL_FLAG_COLUMN[ch]] = false

    await bestEffort(
      supabase
        .from("contacts")
        .update(contactUpdates)
        .eq("id", linkedContactId)
        .eq("brokerage_id", params.brokerageId),
      "mirroring a lead's reopen onto its converted contact — the lead row has already been cleared, so a failed mirror leaves the person MORE suppressed than intended, which is the safe direction",
    )
  }

  // ── 3. THE BRIDGE ROWS — capture, then remove ──────────────────────────────
  const removed = await removeSuppressionBridge(supabase, {
    brokerageId: params.brokerageId,
    contactId: linkedContactId,
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    phoneDigits: (row.phone_digits as string | null) ?? null,
  })

  // ── 4. THE RECORD — same ledger as the opt-out, and NOT best-effort ────────
  const { error: auditError } = await supabase.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "lead",
    entity_id: params.leadId,
    event_type: "LEAD_REOPENED_ON_INBOUND_INTENT",
    metadata: {
      // WHAT justified it — the person's own words, which are the consent signal.
      message: message.slice(0, 2000),
      source: params.source,
      provider_ref: params.providerRef ?? null,
      intent_side: params.intent?.side ?? null,
      intent_reason: params.intent?.reason ?? null,
      // WHO/WHAT reopened. No human is in this loop by design; say so plainly
      // rather than leaving the actor blank.
      reopened_by: "system:lib/lead-intent/inbound-lead-intent.ts",
      reopened_by_kind: "automatic_on_positive_inbound_intent",
      // WHEN.
      reopened_at: now,
      // WHAT WAS LIFTED — the exact prior state, so the ledger can reconstruct
      // the suppression that stood before this message arrived.
      previous_state: before,
      channels_reopened: ALL_CHANNELS,
      cleared_global_dnc: before.dnc_status === true,
      suppression_rows_removed: removed.rows,
      suppression_rows_removed_count: removed.rows.length,
      suppression_removal_error: removed.error ?? null,
      // Stated for the auditor: a reopen restores REACHABILITY, never consent.
      tcpa_consent_untouched: true,
    },
    created_at: now,
  })

  if (auditError) {
    console.error("[lead-opt-out] reopen audit row refused:", auditError.message)
  }

  return {
    reopened: true,
    channelsReopened: [...ALL_CHANNELS],
    clearedGlobalDNC: before.dnc_status === true,
    suppressionRowsRemoved: removed.rows.length,
    recorded: !auditError,
    error: auditError
      ? `reopen applied but the compliance record was refused: ${auditError.message}`
      : removed.error,
  }
}

/**
 * removeSuppressionBridge — take the address-keyed rows back off the list, and
 * hand the caller what was removed so the ledger can keep it.
 *
 * Matching mirrors writeSuppressionBridge: every identifier spelling this lead
 * holds, plus the contact id when there is one. Restricted to the four inbound
 * lead sources so only rows THIS module wrote are removed.
 */
async function removeSuppressionBridge(
  supabase: ReturnType<typeof createServiceClient>,
  params: {
    brokerageId: string
    contactId: string | null
    email: string | null
    phone: string | null
    phoneDigits: string | null
  },
): Promise<{ rows: Array<Record<string, unknown>>; error?: string }> {
  const emailForms = distinct([params.email, params.email?.toLowerCase() ?? null])
  const phoneForms = distinct([
    params.phone,
    params.phoneDigits ? `+${params.phoneDigits.length === 10 ? "1" : ""}${params.phoneDigits}` : null,
  ])

  const orClauses: string[] = []
  if (params.contactId) orClauses.push(`contact_id.eq.${params.contactId}`)
  for (const e of emailForms) orClauses.push(`email.eq.${e}`)
  for (const p of phoneForms) orClauses.push(`phone.eq.${p}`)
  if (orClauses.length === 0) return { rows: [] }

  // CAPTURE FIRST. The table has no soft-delete column, so the audit event is the
  // only place these rows can survive; deleting before reading them would destroy
  // the record the ruling requires.
  const { data: doomed, error: readError } = await supabase
    .from("contact_suppression_list")
    .select("id, channel, email, phone, contact_id, suppression_reason, source, created_at")
    .eq("brokerage_id", params.brokerageId)
    .in("source", LEAD_INBOUND_SOURCES)
    .or(orClauses.join(","))

  if (readError) {
    console.error("[lead-opt-out] suppression rows unreadable, none removed:", readError.message)
    return { rows: [], error: `suppression rows unreadable, none removed: ${readError.message}` }
  }

  const rows = (doomed ?? []) as Array<Record<string, unknown>>
  if (rows.length === 0) return { rows: [] }

  const ids = rows.map((r) => r.id as string)
  const { error: deleteError } = await supabase
    .from("contact_suppression_list")
    .delete()
    .eq("brokerage_id", params.brokerageId)
    .in("id", ids)

  if (deleteError) {
    // The lead-row flags are already cleared; the list rows are not. The person
    // stays suppressed on the address-keyed arm, which is the safe direction —
    // but the caller must be told, or the reopen reads as complete when it is not.
    console.error("[lead-opt-out] suppression row removal refused:", deleteError.message)
    return { rows: [], error: `suppression row removal refused: ${deleteError.message}` }
  }

  return { rows }
}

function distinct(values: (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const v of values) {
    const t = (v ?? "").trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}
