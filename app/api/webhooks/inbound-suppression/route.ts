// app/api/webhooks/inbound-suppression/route.ts
// WEBHOOK: Capture inbound suppression intents (stop/unsubscribe)
// Detects and applies suppression from SMS, email, phone responses
//
// ── AUTH: SHARED SECRET, UNSET = 404 ────────────────────────────────────────
// This handler had NO caller authentication. It runs on the service client
// (RLS bypassed), and when the payload omits `brokerageId` it matched contacts
// by bare phone/email across EVERY tenant (see the two identity lookups below).
// So an unauthenticated POST of {source:"sms", phoneNumber:"…", message:"stop"}
// set call_stop_flag / sms_opt_out / email_opt_out on somebody else's contact —
// a cross-tenant write and a denial-of-communication vector — while the
// 404 `contact_not_found` vs 200 `success` split answered "is this phone number
// in your CRM?" for anyone who asked.
//
// The gate is the idiom the other provider webhooks in this tree already use
// (app/api/webhooks/sendgrid-events/route.ts:43, app/api/webhooks/lob-events/
// route.ts:41, app/api/webhooks/twilio-sms-status/route.ts:46): the secret is
// read from the env, an UNSET secret is an honest 404 rather than a silently
// open endpoint, and a wrong secret is a 401. Nothing in this repo addresses
// this route and no provider integration in this repo is configured to call it,
// so the closed-by-default posture is the correct production state; set
// INBOUND_SUPPRESSION_WEBHOOK_SECRET and hand the URL its secret to enable it.
//
// The signature-verified path that actually carries real inbound opt-outs today
// is app/api/providers/inbound/route.ts (bound as SmsUrl at
// lib/voice/twilio-voice.ts:151) → lib/ai-isa/opt-out-utils.ts:12
// → app/actions/ai-isa/process-opt-out.ts. Prefer it for anything new.
//
// ── OWNER RULING (2026-08-24), verbatim ─────────────────────────────────────
//   "inbound suppression could come from an external feeds like emails/dms etc."
//
// That settles a question a previous lane recorded as UNRESOLVED rather than
// guessing (scripts/conditional-tenant-predicate-guard.ts, entry
// "app/api/webhooks/inbound-suppression/route.ts :: payload.brokerageId"): real
// external feeds post here, so this path is LIVE, not theoretical, and its
// tenant resolution had to be fixed rather than merely documented.
//
// ── WHAT WAS WRONG, AND IT WAS TWO THINGS ───────────────────────────────────
//
// (1) THE TENANT CAME FROM THE REQUEST BODY. `payload.brokerageId` was applied as
//     `if (payload.brokerageId) query = query.eq("brokerage_id", payload.brokerageId)`
//     on a SERVICE client. CLAUDE.md §4: "Tenant comes from the SESSION. Never
//     from a request body, never from a parameter." A webhook has no session, so
//     the tenant must be DERIVED from the feed's own verified content — the row
//     the identity resolves to — never asserted by the caller. A body field on a
//     service client is the IDOR shape this repo keeps paying for: anyone holding
//     the shared secret could name any brokerage and suppress its contacts.
//
// (2) WHEN THE TENANT WAS UNRESOLVED IT GUESSED. The falsy branch left
//     `.limit(1)` with NO ambiguity check on a bare phone/email match, so it
//     silenced whichever brokerage's contact happened to sort first. An email
//     address and a phone number are NOT unique across tenants.
//
// ── THE SHAPE NOW ───────────────────────────────────────────────────────────
// Identity first, tenant second, and the tenant is whatever the identity turned
// out to belong to:
//   · contactId / leadId — a named row. Read ITS brokerage_id. This is the
//     provider-id-equivalent of sendgrid's sg_message_id: an authoritative link.
//   · phone / email — the survivor rule, not re-spelled:
//     lib/kernel/unambiguous-tenant.ts:resolveUnambiguousTenant, read with
//     limit(2) so ambiguity is VISIBLE, refusing when two tenants claim the
//     identity (409 tenant_ambiguous). That module is the merge of the two
//     existing spellings at app/api/webhooks/sendgrid-events/route.ts and
//     app/api/webhooks/inbound-mail/route.ts (§6).
//
// ── OWNER RULING (2026-08-24), verbatim ─────────────────────────────────────
//   "inbound should be checked on contact id and leads are pulled from leads
//    (contactid) which should this should be checking on contacts and leads
//    since the inbound can be for leads that haven't converted yet."
//
// ── THE THIRD DEFECT: THE FUZZY PATH COULD ONLY SEE CONTACTS ────────────────
//
// (3) A BARE PHONE OR EMAIL — which is what an external email/DM feed actually
//     sends — was matched against `contacts` ONLY, and the `leadId` branch
//     resolved through `leads.contact_id`, which is NULL until the lead is
//     promoted. So for a LEAD THAT HAS NOT CONVERTED, both doors were shut:
//       · the named-leadId door read `contact_id` → null → fell through to the
//         fuzzy match and then to 404, having HAD an authoritative row in hand;
//       · the fuzzy door queried a table the person is not in → no candidates
//         → 404 `contact_not_found`.
//     The feed was answered "we do not know this person" and the do-not-contact
//     instruction was silently dropped. That is the same failure DIRECTION as
//     the `recordSuppressionEvent` defect above — the system accepts a consent
//     withdrawal and leaves the person contactable — so it is a CONSENT defect,
//     not a lookup bug.
//
//     Measured live on hrvaqgvukzxfskkcrwbt 2026-08-24 before writing anything:
//     `leads` carries `email` (text) and `phone` (varchar) under the SAME names
//     as `contacts`, plus `brokerage_id` uuid **NOT NULL** (contacts.brokerage_id
//     is nullable), `contact_id` uuid nullable, and its own opt-out flag family
//     (email_opt_out / sms_opt_out / phone_opt_out / direct_mail_opt_out /
//     call_stop_flag / dnc_status / opt_out_channels).
//
//     THE FIX IS ONE QUERY LOOP OVER TWO TABLES FEEDING **ONE** RULE. The
//     candidates from `contacts` and `leads` are unioned and handed to the SAME
//     resolveUnambiguousTenant. Widening the search makes ambiguity MORE likely,
//     not less — the same person can be a lead at one brokerage and a contact at
//     another — and a CROSS-TABLE ambiguity refuses with the identical 409 a
//     cross-tenant one does. Suppressing the wrong tenant's person leaves the
//     right one contactable, which is the whole defect again with extra steps.
//
//     A MATCH ON A LEAD SUPPRESSES THE LEAD. No conversion is invented: §5 rules
//     that a lead becomes a contact through the promotion path, never as a side
//     effect of an inbound webhook. The lead-side writer already exists and is
//     designated — lib/lead-intent/lead-opt-out.ts:applyLeadOptOut — and it is
//     the one this route calls, exactly as app/api/unsubscribe/route.ts:233
//     already does for a footer click that carries a lead id. It writes the lead
//     flags, the address-keyed `contact_suppression_list` bridge rows (the ONLY
//     arm of checkSuppression that can fire for a person with no contact row),
//     and the `lifecycle_events` audit line. Nothing new was built, because the
//     missing half was the WIRING, not the writer.

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
// TOMBSTONE (dead-import tranche): `evaluateOutboundCompliance`
// (lib/kernel/communication-compliance.ts) was imported here and never called —
// and it never should be. This handler is the INBOUND direction: it reads a
// stop/unsubscribe message and WRITES the suppression state. The outbound gate
// is what READS that state, and it has one live caller that every send goes
// through: lib/providers/dispatch.ts:40. Calling it here would have asked "may I
// send to this contact?" in a handler that sends nothing.
//
// The pairing is intact in both directions and is the reason this is a deletion
// rather than a build: this route's writers (`syncSuppressionState`,
// `recordSuppressionEvent`) feed exactly the columns
// `evaluateOutboundCompliance` reads — call_stop_flag / sms_opt_out /
// email_opt_out, see lib/lead-intent/lead-opt-out.ts:204 and :437.
import { syncSuppressionState } from "@/lib/kernel/suppression-sync"
import { resolveUnambiguousTenant, pickIdentitySubject } from "@/lib/kernel/unambiguous-tenant"
import { addSuppression, type SuppressionChannel } from "@/lib/kernel/compliance/check-suppression"
import {
  applyLeadOptOut,
  type LeadOptOutChannel,
  type LeadOptOutSource,
} from "@/lib/lead-intent/lead-opt-out"

export const runtime = "nodejs"

/**
 * This route's suppression TYPE → `contact_suppression_list.channel`.
 *
 * The CHECK admits exactly {email, sms, phone, mail} (verified live 2026-08-24),
 * and `channel` is NOT NULL with no default — which is why nothing this handler
 * wrote ever landed before. The table's own vocabulary is the survivor, so the
 * map is written against SuppressionChannel rather than a fifth spelling of
 * "which channel is this" (CLAUDE.md §6; the sibling maps are
 * lib/lead-intent/lead-opt-out.ts:122 and lib/kernel/communications.ts:791).
 *
 * `manual` lands on 'phone' because that is what the handler actually DOES for
 * the manual branch — it sets `call_stop_flag`. Naming a different channel in
 * the ledger than the flag the write set is how an audit trail stops matching
 * the data it is supposed to explain.
 */
const SUPPRESSION_CHANNEL: Record<
  "dnc" | "call_stop" | "email_opt_out" | "sms_opt_out" | "manual",
  SuppressionChannel
> = {
  dnc:            "phone",
  call_stop:      "phone",
  email_opt_out:  "email",
  sms_opt_out:    "sms",
  manual:         "phone",
}

/**
 * `contact_suppression_list.channel` → the LEAD row's own spelling of the same
 * channel. Not a new vocabulary: it is the exact map
 * app/api/unsubscribe/route.ts:112 (`LEAD_CHANNEL`) already uses, widened to all
 * four members because this route can produce `phone` and that one cannot.
 * The rename is real and lives in the database, not in style: the lead column is
 * `direct_mail_opt_out`, the suppression list's CHECK admits `mail`
 * (lib/lead-intent/lead-opt-out.ts:122 documents the same crossing).
 *
 * Deriving the lead channel FROM `SUPPRESSION_CHANNEL` rather than re-branching
 * on `intent.intentType` is deliberate (§6): one intent→channel decision, read
 * twice, so a lead and a contact carrying the same message can never be ledgered
 * under different channels.
 */
const LEAD_OPT_OUT_CHANNEL: Record<SuppressionChannel, LeadOptOutChannel> = {
  email: "email",
  sms:   "sms",
  phone: "phone",
  mail:  "direct_mail",
}

/**
 * This route's `source` → `LeadOptOutSource`, the four-member provenance union
 * `applyLeadOptOut` stamps onto `leads.opt_out_source` and
 * `contact_suppression_list.source`.
 *
 * `webhook` has no exact member, and INVENTING A FIFTH ONE WOULD BREAK THE
 * REOPEN. lib/lead-intent/lead-opt-out.ts:494 `LEAD_INBOUND_SOURCES` is the
 * closed set of four that `reopenLeadOnInboundConsent` is allowed to remove; a
 * row stamped with a spelling outside it could never be lifted when the person
 * comes back, which is the opposite asymmetry and just as wrong. So this takes
 * the closest honest member — the idiom app/api/unsubscribe/route.ts:238 already
 * established for the same problem.
 *
 * NOTHING IS LOST BY THE APPROXIMATION: the TRUE transport is written verbatim
 * into `rawMessage` below (`Inbound ${payload.source} …`), which lands in
 * `leads.opt_out_reason`, in `contact_suppression_list.suppression_reason` and in
 * the `lifecycle_events` metadata. The audit trail still says exactly which feed
 * carried the request.
 */
const LEAD_OPT_OUT_SOURCE: Record<InboundSuppressionPayload["source"], LeadOptOutSource> = {
  sms:     "inbound_sms",
  email:   "inbound_email",
  phone:   "inbound_call",
  webhook: "inbound_email",
}

/**
 * The two tables an identity can live in. `leads` is here because of the owner
 * ruling: an unconverted lead has NO `contacts` row, so a contacts-only lookup
 * answers "not found" for exactly the population that most needs the opt-out to
 * bind — people the OS is still cold-outreaching.
 *
 * ORDER IS NOT LOAD-BEARING and must not become so. The tenant rule sees the
 * UNION, and the subject rule (pickIdentitySubject) keys on the row's `table`
 * tag, not on its position — so reordering these two reads cannot change which
 * person gets suppressed.
 */
const IDENTITY_TABLES = ["contacts", "leads"] as const

interface InboundSuppressionPayload {
  source: "sms" | "email" | "phone" | "webhook"
  contactId?: string
  leadId?: string
  // TOMBSTONE — `brokerageId?: string` (owner ruling 2, 2026-08-24).
  // REMOVED. Its doc comment called it a "tenant hint", which is precisely the
  // problem: on a service client a hint IS the tenant, and it arrived in the
  // request body. CLAUDE.md §4 forbids that outright, and the ruling ("inbound
  // suppression could come from an external feeds like emails/dms etc.")
  // confirms the callers are external feeds, i.e. exactly the parties who must
  // not be trusted to name a brokerage.
  //
  // NOTHING IS LOST: the field's only job was to scope the phone/email identity
  // match, and the tenant it was scoping to is now DERIVED from whichever
  // contact the identity actually resolves to. A feed that used to send it gets
  // the same answer whenever it was telling the truth, and is refused instead of
  // obeyed when it was not. Survivor for the "which tenant?" question:
  // lib/kernel/unambiguous-tenant.ts:resolveUnambiguousTenant.
  phoneNumber?: string
  emailAddress?: string
  message: string
  timestamp?: string
  metadata?: Record<string, any>
}

interface DetectIntentOutput {
  hasIntent: boolean
  intentType?: "stop" | "unsubscribe" | "do_not_call" | "do_not_text" | "wrong_number" | "wrong_person"
  confidence: number
  recommendedAction: "apply_suppression" | "review" | "ignore"
}

/**
 * INTENT DETECTION: Analyze message for suppression keywords
 * Returns suppression intent with confidence score
 */
function detectSuppressionIntent(message: string): DetectIntentOutput {
  const lowerMessage = message.toLowerCase().trim()

  // Stop/Unsubscribe patterns
  const stopPatterns = [
    /\bstop\b/,
    /\bunsubscribe\b/,
    /\bdo not (call|text|call|contact)\b/,
    /\bremove (me|my number)\b/,
    /\bopt.?out\b/,
    /\bno more\b/,
  ]

  // Do Not Call patterns
  const dncPatterns = [
    /\bdo not call\b/,
    /\bdo not call list\b/,
    /\bdo not call registry\b/,
    /\ndnc\b/,
  ]

  // Wrong number patterns
  const wrongNumberPatterns = [
    /\bwrong number\b/,
    /\bwrong person\b/,
    /\bi don't know (who|this)\b/,
    /\byou have the wrong.*number\b/,
  ]

  // Score by pattern match
  if (dncPatterns.some(p => p.test(lowerMessage))) {
    return {
      hasIntent: true,
      intentType: "do_not_call",
      confidence: 0.95,
      recommendedAction: "apply_suppression",
    }
  }

  if (stopPatterns.some(p => p.test(lowerMessage))) {
    return {
      hasIntent: true,
      intentType: "stop",
      confidence: 0.9,
      recommendedAction: "apply_suppression",
    }
  }

  if (wrongNumberPatterns.some(p => p.test(lowerMessage))) {
    return {
      hasIntent: true,
      intentType: "wrong_number",
      confidence: 0.85,
      recommendedAction: "review",
    }
  }

  return {
    hasIntent: false,
    confidence: 0,
    recommendedAction: "ignore",
  }
}

/**
 * WEBHOOK HANDLER: Process inbound suppression intent
 * 
 * POST /api/webhooks/inbound-suppression
 * Body: { source, contactId, leadId, phoneNumber, emailAddress, message, ... }
 *
 * Detects intent → resolves the SUBJECT (a contact, or an UNCONVERTED LEAD) →
 * derives the tenant from that row → applies suppression through that subject's
 * designated writer → records the ledger row.
 *
 * Two subjects, two writers, never a conversion between them:
 *   contact → contacts flags + syncSuppressionState + addSuppression
 *   lead    → applyLeadOptOut (leads flags + suppression bridge rows + audit)
 */
export async function POST(request: NextRequest) {
  try {
    // ─── AUTH ──────────────────────────────────────────────────────────────
    // Unset secret = 404 (never a silently-open suppression writer);
    // wrong secret = 401. See the header for why this is not optional.
    const secret = process.env.INBOUND_SUPPRESSION_WEBHOOK_SECRET
    if (!secret) {
      return NextResponse.json({ error: "not found" }, { status: 404 })
    }
    const given =
      request.nextUrl.searchParams.get("secret") ??
      request.headers.get("x-webhook-secret")
    if (given !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    const payload: InboundSuppressionPayload = await request.json()
    const supabase = await createServiceClient()

    // ─── DETECT INTENT ─────────────────────────────────────────────────────
    const intent = detectSuppressionIntent(payload.message)

    if (!intent.hasIntent) {
      return NextResponse.json(
        { success: false, reason: "no_suppression_intent" },
        { status: 200 }
      )
    }

    // ─── RESOLVE IDENTITY, THEN DERIVE THE TENANT FROM IT ──────────────────
    // Order matters and is deliberate: a NAMED ROW (contactId, or a lead's
    // contact_id) is authoritative and carries its own brokerage_id, so it needs
    // no ambiguity rule. A bare phone number or email address is not an identity
    // at all until exactly one tenant claims it.
    let contactId: string | undefined = payload.contactId
    // The LEAD subject. Set only when the identity resolved to a lead that has
    // NOT been promoted — i.e. there is no contact row to suppress and inventing
    // one would be a conversion the webhook is forbidden to perform (§5).
    let leadSubjectId: string | undefined

    if (!contactId && payload.leadId) {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("id, contact_id")
        .eq("id", payload.leadId)
        .maybeSingle()
      // supabase-js RESOLVES a refusal (CLAUDE.md §3): an unread error here would
      // report a permission denial as "this lead has no contact" and fall through
      // to the fuzzy phone match, which is how a precise lookup silently becomes
      // a guess.
      if (leadError) {
        console.error("[inbound-suppression] lead lookup failed:", leadError.message)
        return NextResponse.json({ success: false, reason: "lead_lookup_failed" }, { status: 500 })
      }
      contactId = (lead?.contact_id as string | null) ?? undefined
      // `leads.contact_id` is NULL until the lead is promoted. A null here used
      // to mean "fall through to the fuzzy match, then 404" — throwing away an
      // AUTHORITATIVE named row because it had not converted yet. The lead IS the
      // subject; suppress the lead.
      if (!contactId && lead) leadSubjectId = lead.id as string
    }

    // The identity columns, tried in order. limit(2) — not limit(1) — is what
    // makes ambiguity VISIBLE at all; with one row the rule below cannot tell an
    // unambiguous match from a truncated ambiguous one.
    const fuzzyIdentity: Array<{ column: "phone" | "email"; value: string }> = []
    if (payload.phoneNumber) fuzzyIdentity.push({ column: "phone", value: payload.phoneNumber })
    if (payload.emailAddress) fuzzyIdentity.push({ column: "email", value: payload.emailAddress })

    for (const identity of fuzzyIdentity) {
      if (contactId || leadSubjectId) break

      // BOTH TABLES, ONE RULE. The candidate lists are UNIONED before the tenant
      // rule runs — never resolved per-table and then reconciled — because a
      // per-table resolution would call each table individually unambiguous and
      // never notice that the two disagree.
      const candidates: Array<{ id: string; brokerage_id: string | null; table: "contacts" | "leads" }> = []
      let lookupRefusedIn: string | null = null
      for (const table of IDENTITY_TABLES) {
        const { data: rows, error: candidateError } = await supabase
          .from(table)
          .select("id, brokerage_id")
          .eq(identity.column, identity.value)
          .limit(2)
        if (candidateError) {
          console.error(
            `[inbound-suppression] ${table}.${identity.column} lookup failed:`,
            candidateError.message,
          )
          lookupRefusedIn = table
          break
        }
        for (const row of (rows ?? []) as Array<{ id: string; brokerage_id: string | null }>) {
          candidates.push({ id: row.id, brokerage_id: row.brokerage_id ?? null, table })
        }
      }
      if (lookupRefusedIn) {
        // FAIL CLOSED across BOTH arms. A refused `leads` read with a clean
        // `contacts` read would otherwise resolve to "not a lead" and suppress
        // nobody — "we could not look" rendering as "there is nobody there".
        return NextResponse.json(
          { success: false, reason: "contact_lookup_failed", table: lookupRefusedIn },
          { status: 500 },
        )
      }

      const match = resolveUnambiguousTenant(candidates)
      if (match.ok) {
        // ONE tenant, possibly several rows. Which one is the subject is the
        // shared PURE rule (§6), not a re-spelling here:
        // lib/kernel/unambiguous-tenant.ts:pickIdentitySubject — contact when one
        // exists, lead otherwise. Falling to the lead is what makes an
        // UNCONVERTED lead suppressible at all.
        const subject = pickIdentitySubject(match.rows)
        if (subject?.kind === "contact") contactId = subject.id
        else if (subject?.kind === "lead") leadSubjectId = subject.id
        break
      }
      if (match.reason === "ambiguous_tenant") {
        // REFUSE rather than guess. The same person really can be a contact at
        // two brokerages (the case app/api/webhooks/inbound-mail/route.ts:155
        // documents), and applying one tenant's "stop" to the other's contact is
        // a cross-tenant write plus a denial of communication. 409, so the feed
        // can escalate to a human instead of believing it succeeded.
        //
        // CROSS-TABLE ambiguity lands here on the identical path and is refused
        // identically: a lead at brokerage A and a contact at brokerage B is two
        // distinct brokerage_ids, and there is no rule that makes one of them the
        // right person to silence.
        console.warn(
          `[inbound-suppression] ${identity.column} is claimed by ${match.tenantCount} brokerages ` +
          `across ${new Set(match.rows.map((r) => r.table)).size} table(s) — refusing to guess a tenant`,
        )
        return NextResponse.json(
          { success: false, reason: "tenant_ambiguous", identity: identity.column },
          { status: 409 },
        )
      }
    }

    if (!contactId && !leadSubjectId) {
      // Reason string kept verbatim: external feeds branch on it, and this is
      // still the "the identity matched nothing anywhere" answer. It now means
      // neither table claimed the person, not merely that `contacts` did not.
      return NextResponse.json(
        { success: false, reason: "contact_not_found" },
        { status: 404 }
      )
    }

    // ─── APPLY SUPPRESSION BASED ON INTENT ─────────────────────────────────
    // Computed BEFORE the subject branch, and read by both arms. One
    // intent→channel decision, so a lead and a contact carrying the identical
    // message can never be ledgered under different channels (§6).
    let suppressionType: "dnc" | "call_stop" | "email_opt_out" | "sms_opt_out" | "manual"
    const suppressionFields: Record<string, boolean> = {}

    if (intent.intentType === "do_not_call" || intent.intentType === "stop") {
      suppressionType = "call_stop"
      suppressionFields.call_stop_flag = true
    } else if (intent.intentType === "do_not_text") {
      suppressionType = "sms_opt_out"
      suppressionFields.sms_opt_out = true
    } else if (intent.intentType === "unsubscribe") {
      suppressionType = "email_opt_out"
      suppressionFields.email_opt_out = true
    } else {
      suppressionType = "manual"
      suppressionFields.call_stop_flag = true
    }

    // ─── SUBJECT: LEAD ─────────────────────────────────────────────────────
    // An unconverted lead. NOT promoted, NOT copied into `contacts`: §5 rules
    // that conversion happens on the promotion path, and a webhook that created
    // a contact as a side effect of someone asking to be LEFT ALONE would be
    // manufacturing the CRM record that the request is asking us not to use.
    if (leadSubjectId) {
      const { data: leadData, error: leadFetchError } = await supabase
        .from("leads")
        .select("id, brokerage_id, email, phone")
        .eq("id", leadSubjectId)
        .maybeSingle()

      if (leadFetchError || !leadData) {
        console.error(
          "[inbound-suppression] lead fetch failed:",
          leadFetchError?.message ?? "row vanished between resolution and fetch",
        )
        return NextResponse.json(
          { success: false, reason: "lead_fetch_failed" },
          { status: 500 },
        )
      }

      // Same discipline as the contact arm: the tenant is DERIVED from the row
      // the identity resolved to. `leads.brokerage_id` is NOT NULL live, so this
      // should never fire — which is exactly why it is checked rather than
      // assumed. Fail closed (§4): a suppression we cannot tenant is one we
      // cannot record.
      const resolvedLeadBrokerageId =
        (leadData as { brokerage_id?: string | null }).brokerage_id ?? null
      if (!resolvedLeadBrokerageId) {
        console.error(`[inbound-suppression] lead ${leadSubjectId} carries no brokerage_id — refusing`)
        return NextResponse.json(
          { success: false, reason: "tenant_unresolved", leadId: leadSubjectId },
          { status: 409 },
        )
      }

      // THE DESIGNATED LEAD-SIDE WRITER, not a fourth spelling of one. It writes
      // the lead flags (what evaluateOutboundCompliance reads for a lead), the
      // address-keyed contact_suppression_list bridge rows (the only arm of
      // checkSuppression that can fire for a person with no contact row), and the
      // lifecycle_events audit line — and it RETURNS whether the first of those
      // landed.
      const leadResult = await applyLeadOptOut({
        brokerageId: resolvedLeadBrokerageId,
        leadId: leadSubjectId,
        channel: LEAD_OPT_OUT_CHANNEL[SUPPRESSION_CHANNEL[suppressionType]],
        source: LEAD_OPT_OUT_SOURCE[payload.source] ?? "inbound_email",
        rawMessage: `Inbound ${payload.source} suppression intent: "${payload.message.substring(0, 100)}"`,
      })

      if (!leadResult.applied) {
        // A consent withdrawal that is not recorded is not a consent withdrawal —
        // the same rule the contact arm's ledger check enforces below.
        console.error("[inbound-suppression] lead opt-out REFUSED:", leadResult.error)
        return NextResponse.json(
          {
            success: false,
            reason: "lead_suppression_failed",
            leadId: leadSubjectId,
            detail: leadResult.error ?? null,
          },
          { status: 500 },
        )
      }

      return NextResponse.json(
        {
          success: true,
          leadId: leadSubjectId,
          brokerageId: resolvedLeadBrokerageId,
          intentType: intent.intentType,
          confidence: intent.confidence,
          suppressionApplied: suppressionType,
          // 0 is NOT a failure: writeSuppressionBridge skips rows that already
          // exist, and a lead holding neither email nor phone has no address to
          // key on. Reported so the caller can see which of those happened.
          suppressionRowsWritten: leadResult.suppressionRowsWritten,
          channelsSuppressed: leadResult.channelsSuppressed,
        },
        { status: 200 },
      )
    }

    // ─── SUBJECT: CONTACT ──────────────────────────────────────────────────
    if (!contactId) {
      // Unreachable: the 404 above proves one of the two subjects is set and the
      // lead arm returned. Kept as a floor rather than a `!` assertion — "nobody
      // checked" must never render as "checked and fine" (§4).
      return NextResponse.json(
        { success: false, reason: "contact_not_found" },
        { status: 404 }
      )
    }

    // ─── FETCH FULL CONTACT FOR COMPLIANCE ─────────────────────────────────
    const { data: contactData, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .maybeSingle()

    if (contactError || !contactData) {
      return NextResponse.json(
        { success: false, reason: "contact_fetch_failed" },
        { status: 500 }
      )
    }

    // The tenant this write lands in — DERIVED from the row the identity resolved
    // to, never asserted by the caller. Carried into the audit line below so the
    // suppression record says whose contact was silenced and on whose authority.
    const resolvedBrokerageId = (contactData as { brokerage_id?: string | null }).brokerage_id ?? null

    // ─── UPDATE CONTACT ────────────────────────────────────────────────────
    // .select() + COUNT, not just an error check. CLAUDE.md §3: an UPDATE that
    // matches NOTHING also resolves with error === null, which is byte-identical
    // to one that worked — so a row that vanished between the read above and this
    // write would have reported `success: true` to the feed while suppressing
    // nobody. On a suppression writer that is the worst possible lie: the feed
    // believes the person was silenced and stops re-sending the opt-out.
    const { data: updated, error: updateError } = await supabase
      .from("contacts")
      .update(suppressionFields)
      .eq("id", contactId)
      .select("id")

    if (updateError) {
      console.error("[Webhook] Failed to update contact suppression:", updateError)
      return NextResponse.json(
        { success: false, reason: "suppression_update_failed" },
        { status: 500 }
      )
    }
    if (!updated || updated.length === 0) {
      console.error(`[inbound-suppression] suppression update matched 0 rows for contact ${contactId}`)
      return NextResponse.json(
        { success: false, reason: "suppression_update_matched_nothing" },
        { status: 500 }
      )
    }

    // ─── SYNC TO LEAD ──────────────────────────────────────────────────────
    // UNCONDITIONAL. This was `if (payload.leadId)`, which gated the lead mirror
    // on the CALLER having named a lead — so the identity paths that do not carry
    // one (a bare phone number, a bare email address, a bare contactId, i.e. every
    // external feed) suppressed the contact and left the linked LEAD row's flags
    // clear. That is not cosmetic: lib/providers/dispatch.ts:315/533 pick the row
    // to evaluate as `params.contactId ? "contacts" : "leads"`, so any send
    // addressed by leadId reads the LEAD's flags and would have found no
    // objection. A stop accepted on one row and ignored on the other is the same
    // consent defect this route keeps paying for, one table over.
    //
    // syncSuppressionState resolves the target ITSELF from `leads.contact_id`, so
    // it needs no lead id from the payload; when there is no linked lead it warns
    // and returns `synced:false`, which is the correct no-op for an
    // unconverted-person contact.
    await syncSuppressionState({
      sourceType: "contact",
      sourceId: contactId,
      suppressionFields: suppressionFields as any,
    })

    // ─── RECORD SUPPRESSION EVENT ──────────────────────────────────────────
    // This used to call lib/kernel/suppression-sync.ts:recordSuppressionEvent,
    // which COULD NOT EVER HAVE WRITTEN A ROW. Measured on the live database
    // 2026-08-24: `contact_suppression_list` has FOUR NOT NULL columns with no
    // default — brokerage_id, channel, suppression_reason, source — and that
    // function supplied two of them. Every insert was refused 23502, the refusal
    // was swallowed into a console.error, its boolean return was ignored here,
    // and the endpoint answered `success: true`. The table holds 0 rows.
    //
    // The survivor is the writer this repo already designates as the only one:
    // lib/kernel/compliance/check-suppression.ts:addSuppression — the same
    // function the unsubscribe route, the SMS STOP handler and the direct-mail
    // opt-out applier use, and the one whose result distinguishes "landed" from
    // "we could not tell". recordSuppressionEvent is DELETED; see the tombstone
    // at lib/kernel/suppression-sync.ts:168.
    //
    // A ledger row NEEDS a tenant, and the tenant is the one derived above. When
    // the resolved contact carries no brokerage_id there is nothing honest to
    // write, so this REFUSES rather than reporting a suppression it did not
    // record — the flags are already set, so the person is suppressed; what is
    // being reported is that the audit trail is incomplete.
    if (!resolvedBrokerageId) {
      console.error(`[inbound-suppression] contact ${contactId} carries no brokerage_id — suppression ledger row cannot be written`)
      return NextResponse.json(
        { success: false, reason: "tenant_unresolved", contactId },
        { status: 409 },
      )
    }

    const ledger = await addSuppression({
      brokerageId: resolvedBrokerageId,
      contactId,
      email: (contactData as { email?: string | null }).email ?? null,
      phone: (contactData as { phone?: string | null }).phone ?? null,
      channel: SUPPRESSION_CHANNEL[suppressionType],
      reason: `Inbound ${payload.source} suppression intent: "${payload.message.substring(0, 100)}"`,
      source: "webhook",
    })
    if (!ledger.suppressed) {
      // A consent withdrawal that is not recorded is not a consent withdrawal.
      console.error("[inbound-suppression] suppression ledger row REFUSED:", ledger.errors.join("; "))
      return NextResponse.json(
        { success: false, reason: "suppression_ledger_failed", contactId, detail: ledger.error ?? null },
        { status: 500 },
      )
    }

    return NextResponse.json(
      {
        success: true,
        contactId,
        brokerageId: resolvedBrokerageId,
        intentType: intent.intentType,
        confidence: intent.confidence,
        suppressionApplied: suppressionType,
        suppressionId: ledger.suppressionId ?? null,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[Webhook] Error processing inbound suppression:", error)
    return NextResponse.json(
      { success: false, error: "internal_server_error" },
      { status: 500 }
    )
  }
}
