/**
 * lib/direct-mail/mail-unsubscribe.ts
 *
 * "STOP MAILING ME" — the write side of the mail channel, reached by the token
 * PRINTED ON THE PIECE and by nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING (measured, not assumed)
 *
 * `lib/providers/dispatch.ts` dispatchDirectMail now GATES on mail suppression:
 * it reads the lead row's own flags (`dnc_status`, `direct_mail_opt_out`,
 * `opt_out_channels` honouring BOTH the 'direct_mail' and 'mail' spellings) and
 * then `checkSuppression({ channel: "mail" })`. The READ side is complete.
 *
 * Nothing could WRITE to it from outside. `app/api/unsubscribe/route.ts` refuses
 * any channel that is not 'email' or 'sms', and requires a `contacts` row — so a
 * LEAD, which is the normal recipient of an acquisition mailer and the case
 * `campaign-drain.ts` actually mails, had no door at all. A gate with a complete
 * read side and no public write side blocks nobody.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MODULE BUILDS NO SUPPRESSION PATH OF ITS OWN.
 *
 * It is a RESOLVER plus a DISPATCHER onto the two writers that already exist:
 *
 *   LEAD    → lib/lead-intent/lead-opt-out.ts applyLeadOptOut(channel:'direct_mail')
 *             which sets the lead flags AND writes the contact_suppression_list
 *             bridge rows. That is the pair dispatchDirectMail reads back.
 *   CONTACT → lib/kernel/compliance/check-suppression.ts addSuppression(channel:'mail')
 *             which is the row checkSuppression's list arm matches on contact_id.
 *
 * A converted lead carries BOTH rows and gets BOTH writes, because the two gates
 * read two different tables and honouring one is honouring neither reliably.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CONTACT WRITE IS READ BACK, AND THE LEAD WRITE IS NOT.
 *
 * `applyLeadOptOut` destructures its errors and RETURNS them; a refused write is
 * reported as `{ applied:false, error }` and this module surfaces it.
 *
 * `addSuppression` returns `Promise<void>` and destructures NOTHING. Its three
 * writes — the suppression row, the contact flag update, the consent event —
 * are each `await supabase.from(...)...` with the result discarded. supabase-js
 * RESOLVES a refusal rather than throwing, so a REFUSED insert is indistinguishable
 * from a successful one and the caller reports "you have been unsubscribed" over
 * a database that recorded nothing. This is not hypothetical here: the legacy
 * route hands it `contacts.contact_id` where `contact_suppression_list.contact_id`
 * is an FK onto `contacts(id)` — a foreign-key violation on every call, silently
 * swallowed (see app/api/unsubscribe/route.ts for the full account).
 *
 * That function is in another lane, so this module does not edit it. It calls it
 * and then READS BACK the row it was supposed to write, and refuses to report
 * success unless the row is actually there. An opt-out surface that lies is worse
 * than one that errors: the person stops looking, and the mail keeps coming.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TENANT BOUNDARY ON AN UNAUTHENTICATED SURFACE.
 *
 * There is no session — the caller is a member of the public holding a postcard.
 * So the boundary is: the token resolves ONE recipient row, and the brokerage,
 * the lead and the contact are all read OFF THAT ROW. No identifier is ever
 * accepted from the caller except the token itself. An attacker holding a valid
 * token reaches exactly one recipient of one campaign and can do exactly one
 * thing to them — the thing that recipient is entitled to ask for anyway.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { addSuppression, type SuppressionChannel } from "@/lib/kernel/compliance/check-suppression"
import { applyLeadOptOut } from "@/lib/lead-intent/lead-opt-out"
import { normalizeMailUnsubToken } from "@/lib/direct-mail/unsubscribe-token"

/**
 * What the person on the surface can ask for.
 *   'mail' — stop the physical mail. The default, and what the piece asks about.
 *   'all'  — stop everything. Offered because someone moved enough to find and
 *            type a code off a postcard often means all of it, and making them
 *            hunt for a second surface to say so is how opt-outs get ignored.
 */
export type MailUnsubRequest = "mail" | "all"

/** Which entity the suppression actually became binding on. */
export type MailUnsubBinding = "lead" | "contact" | "lead+contact" | "recipient_only"

export interface ResolvedMailRecipient {
  recipientId: string
  brokerageId: string
  campaignId: string | null
  leadId: string | null
  contactId: string | null
  /** Printed on the piece the caller is holding — disclosing it back discloses nothing. */
  firstName: string | null
  /** Non-null when this token has already been used. Makes a re-visit idempotent. */
  alreadyUnsubscribedAt: string | null
}

export type MailUnsubRefusal =
  /** Not a token at all — wrong length, or characters outside the printed alphabet. */
  | "malformed"
  /** Well-formed but minted by nobody. */
  | "not_found"
  /** The database refused the read. NEVER reported as "not found". */
  | "unreadable"

export type ResolveMailTokenResult =
  | { ok: true; recipient: ResolvedMailRecipient }
  | { ok: false; reason: MailUnsubRefusal; detail?: string }

export interface ApplyMailUnsubscribeResult {
  ok: boolean
  /** Channels now suppressed, in the vocabulary the caller asked in. */
  channelsSuppressed: string[]
  /** Which entity the suppression became binding on. */
  boundTo?: MailUnsubBinding
  /** True when this token had already been used — nothing was rewritten. */
  alreadyApplied: boolean
  firstName?: string | null
  /**
   * Set when the request was RECORDED but could not be made BINDING on any
   * sender gate — the recipient row names neither a lead nor a contact, so
   * there is no entity for `dispatchDirectMail` to check. Surfaced, never
   * swallowed: this is a real gap and the person must not be told otherwise.
   */
  bindingGap?: string
  reason?: MailUnsubRefusal | "write_refused"
  error?: string
}

/**
 * resolveMailUnsubscribeToken — token → the one recipient it names.
 *
 * Normalises first (so a typo'd O-for-0 off print still resolves), then refuses
 * MALFORMED input BEFORE touching the database: a shape check is free and it
 * keeps garbage traffic off the connection pool on an unauthenticated surface.
 */
export async function resolveMailUnsubscribeToken(
  rawToken: string | null | undefined,
): Promise<ResolveMailTokenResult> {
  const token = normalizeMailUnsubToken(rawToken)
  if (!token) return { ok: false, reason: "malformed" }

  const supabase = createServiceClient()

  // Only the columns the surface needs. Not the mailing address, not
  // lob_address_id: a token holder is entitled to act, not to read the file.
  const { data, error } = await supabase
    .from("direct_mail_recipients")
    .select("id, brokerage_id, campaign_id, lead_id, contact_id, first_name, unsubscribed_at")
    .eq("unsubscribe_token", token)
    .maybeSingle()

  // supabase-js RESOLVES a refusal. Reporting a refused read as "no such token"
  // would tell a real recipient their printed code is invalid and send them away.
  // "unreadable" is a 500 the person can retry; "not_found" is a dead end.
  if (error) {
    console.error("[mail-unsubscribe] recipient token read refused:", error.message)
    return { ok: false, reason: "unreadable", detail: error.message }
  }
  if (!data) return { ok: false, reason: "not_found" }

  const row = data as {
    id: string
    brokerage_id: string
    campaign_id: string | null
    lead_id: string | null
    contact_id: string | null
    first_name: string | null
    unsubscribed_at: string | null
  }

  return {
    ok: true,
    recipient: {
      recipientId: row.id,
      brokerageId: row.brokerage_id,
      campaignId: row.campaign_id,
      leadId: row.lead_id,
      contactId: row.contact_id,
      firstName: row.first_name,
      alreadyUnsubscribedAt: row.unsubscribed_at,
    },
  }
}

/** The contact-side channels a global request expands to. */
const ALL_CONTACT_CHANNELS: SuppressionChannel[] = ["email", "sms", "phone", "mail"]

/**
 * applyMailUnsubscribe — record the request and MAKE IT BINDING.
 *
 * Order matters. The recipient row is stamped LAST, because that stamp is what
 * makes a re-visit idempotent: stamping it first would let a partial failure
 * leave a token that reports "already unsubscribed" over a suppression that was
 * never written.
 */
export async function applyMailUnsubscribe(args: {
  rawToken: string | null | undefined
  request: MailUnsubRequest
  /** Free text from the surface, kept as the provenance of the request. */
  note?: string | null
}): Promise<ApplyMailUnsubscribeResult> {
  const resolved = await resolveMailUnsubscribeToken(args.rawToken)
  if (!resolved.ok) {
    return { ok: false, channelsSuppressed: [], alreadyApplied: false, reason: resolved.reason, error: resolved.detail }
  }

  const r = resolved.recipient
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const reason = (args.note?.slice(0, 300) || "Opted out via the code printed on a mail piece")

  // A re-visit re-asserts nothing. The suppression is already binding; writing it
  // again would add a second consent-ledger entry for one human decision, which
  // makes the ledger overstate how many times the person asked.
  if (r.alreadyUnsubscribedAt) {
    return {
      ok: true,
      channelsSuppressed: args.request === "all" ? ["email", "sms", "phone", "mail"] : ["mail"],
      boundTo: bindingOf(r),
      alreadyApplied: true,
      firstName: r.firstName,
    }
  }

  const channelsSuppressed: string[] = []
  const errors: string[] = []
  let wroteSomethingBinding = false

  // ── THE LEAD ARM ──────────────────────────────────────────────────────────
  // applyLeadOptOut is the lead-side authority: it writes the flags that
  // dispatchDirectMail reads directly off the lead row AND the
  // contact_suppression_list bridge rows that checkSuppression matches. Its
  // source union already carries 'inbound_direct_mail' — this is the door that
  // vocabulary was waiting for.
  if (r.leadId) {
    const leadResult = await applyLeadOptOut({
      brokerageId: r.brokerageId,
      leadId: r.leadId,
      channel: args.request === "all" ? "all" : "direct_mail",
      source: "inbound_direct_mail",
      rawMessage: reason,
    })
    if (leadResult.applied) {
      wroteSomethingBinding = true
      for (const c of leadResult.channelsSuppressed) if (!channelsSuppressed.includes(c)) channelsSuppressed.push(c)
    } else {
      // Returned, never swallowed. This is the write that makes the request real.
      errors.push(`lead opt-out refused: ${leadResult.error ?? "unknown"}`)
    }
  }

  // ── THE CONTACT ARM ───────────────────────────────────────────────────────
  // Runs IN ADDITION to the lead arm when the recipient row names both: a
  // converted lead keeps both rows and the contact-side gates read the CONTACT.
  // (applyLeadOptOut mirrors flags onto a linked contact, but only one it can see
  // through `leads.contact_id`; the recipient row may name a contact that link
  // does not, so this arm is not redundant.)
  if (r.contactId) {
    const wanted: SuppressionChannel[] = args.request === "all" ? ALL_CONTACT_CHANNELS : ["mail"]
    for (const channel of wanted) {
      // addSuppression returns void and checks none of its three writes. Call it
      // — it is the existing writer and duplicating it would be the second
      // suppression path this module exists to avoid — then verify.
      await addSuppression({
        brokerageId: r.brokerageId,
        contactId: r.contactId,
        email: null,
        phone: null,
        channel,
        reason,
        source: "inbound_direct_mail",
      })

      const landed = await suppressionRowExists(supabase, r.brokerageId, r.contactId, channel)
      if (landed === true) {
        wroteSomethingBinding = true
        if (!channelsSuppressed.includes(channel)) channelsSuppressed.push(channel)
      } else if (landed === false) {
        errors.push(`contact suppression row for channel '${channel}' was not written`)
      } else {
        // The read-back itself was refused: we do not know. Say so rather than
        // claiming either outcome.
        errors.push(`contact suppression row for channel '${channel}' could not be confirmed`)
      }
    }
  }

  // ── THE RECIPIENT-ONLY CASE ───────────────────────────────────────────────
  // A recipient row that names neither a lead nor a contact (a purchased farm
  // list, an audience import) has no entity for any sender gate to check, and
  // contact_suppression_list is keyed on contact_id / email / phone — it has no
  // mailing-address column. So this request can be RECORDED and cannot be made
  // BINDING. That is reported to the caller, not papered over.
  let bindingGap: string | undefined
  if (!r.leadId && !r.contactId) {
    bindingGap =
      "This request was recorded against the mail piece, but the mailing list row it came from is not linked to a lead or contact, " +
      "so no sender gate can enforce it automatically. It needs manual removal from the source list."
    await recordRecipientOnlyRequest(supabase, r, args.request, reason, now)
    channelsSuppressed.push("mail")
  }

  // Nothing binding written and no honest recipient-only fallback → refuse.
  // Reporting success here is the failure mode this module exists to end.
  if (!wroteSomethingBinding && !bindingGap) {
    return {
      ok: false,
      channelsSuppressed: [],
      alreadyApplied: false,
      firstName: r.firstName,
      reason: "write_refused",
      error: errors.join("; ") || "no suppression was written",
    }
  }

  // ── THE STAMP ─────────────────────────────────────────────────────────────
  // Last, and only now that something binding landed. This is the trace half of
  // the ruling: which piece, on which campaign, produced this opt-out.
  const { error: stampError } = await supabase
    .from("direct_mail_recipients")
    .update({ unsubscribed_at: now })
    .eq("id", r.recipientId)
  if (stampError) {
    // Does NOT unwind the suppression, which is already binding and is the part
    // that matters to the person. What is lost is idempotency and attribution.
    console.error("[mail-unsubscribe] recipient unsubscribed_at stamp refused:", stampError.message)
  }

  return {
    ok: true,
    channelsSuppressed,
    boundTo: bindingGap ? "recipient_only" : bindingOf(r),
    alreadyApplied: false,
    firstName: r.firstName,
    bindingGap,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  }
}

function bindingOf(r: ResolvedMailRecipient): MailUnsubBinding {
  if (r.leadId && r.contactId) return "lead+contact"
  if (r.leadId) return "lead"
  if (r.contactId) return "contact"
  return "recipient_only"
}

/**
 * Did addSuppression's row actually land?
 *
 * Returns true / false / null, and `null` — "the check itself was refused" — is
 * a distinct answer on purpose. Collapsing it into `false` would report a write
 * failure that may not have happened; collapsing it into `true` would report a
 * success that may not have happened. The caller says "could not be confirmed".
 */
async function suppressionRowExists(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  contactId: string,
  channel: SuppressionChannel,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("contact_suppression_list")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .limit(1)

  if (error) {
    console.error("[mail-unsubscribe] suppression read-back refused:", error.message)
    return null
  }
  return Array.isArray(data) && data.length > 0
}

/**
 * The audit row for a request that could not be bound to an entity. It is the
 * only durable record that this person asked, so it is written even though
 * nothing reads it as a gate — a human clearing the source list needs to find it.
 */
async function recordRecipientOnlyRequest(
  supabase: ReturnType<typeof createServiceClient>,
  r: ResolvedMailRecipient,
  request: MailUnsubRequest,
  reason: string,
  now: string,
): Promise<void> {
  const { error } = await supabase.from("lifecycle_events").insert({
    brokerage_id: r.brokerageId,
    entity_type: "direct_mail_recipient",
    entity_id: r.recipientId,
    event_type: "MAIL_OPT_OUT_UNBOUND",
    source: "system",
    metadata: {
      campaign_id: r.campaignId,
      request,
      reason,
      binding_gap: "recipient row names neither a lead nor a contact",
    },
    created_at: now,
  })
  if (error) {
    console.error("[mail-unsubscribe] unbound opt-out audit row refused:", error.message)
  }
}
