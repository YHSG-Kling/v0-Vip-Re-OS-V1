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
import { resolveUnambiguousTenant } from "@/lib/kernel/unambiguous-tenant"
import { addSuppression, type SuppressionChannel } from "@/lib/kernel/compliance/check-suppression"

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
 * Body: { source, contactId, leadId, message, ... }
 * 
 * Detects intent → Finds contact → Applies suppression → Syncs to lead
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

    if (!contactId && payload.leadId) {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("contact_id")
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
    }

    // The identity columns, tried in order. limit(2) — not limit(1) — is what
    // makes ambiguity VISIBLE at all; with one row the rule below cannot tell an
    // unambiguous match from a truncated ambiguous one.
    const fuzzyIdentity: Array<{ column: "phone" | "email"; value: string }> = []
    if (payload.phoneNumber) fuzzyIdentity.push({ column: "phone", value: payload.phoneNumber })
    if (payload.emailAddress) fuzzyIdentity.push({ column: "email", value: payload.emailAddress })

    for (const identity of fuzzyIdentity) {
      if (contactId) break
      const { data: candidates, error: candidateError } = await supabase
        .from("contacts")
        .select("id, brokerage_id")
        .eq(identity.column, identity.value)
        .limit(2)
      if (candidateError) {
        console.error(`[inbound-suppression] ${identity.column} lookup failed:`, candidateError.message)
        return NextResponse.json({ success: false, reason: "contact_lookup_failed" }, { status: 500 })
      }
      const match = resolveUnambiguousTenant(
        (candidates ?? []) as Array<{ id: string; brokerage_id: string | null }>,
      )
      if (match.ok) {
        contactId = match.rows[0].id
        break
      }
      if (match.reason === "ambiguous_tenant") {
        // REFUSE rather than guess. The same person really can be a contact at
        // two brokerages (the case app/api/webhooks/inbound-mail/route.ts:155
        // documents), and applying one tenant's "stop" to the other's contact is
        // a cross-tenant write plus a denial of communication. 409, so the feed
        // can escalate to a human instead of believing it succeeded.
        console.warn(
          `[inbound-suppression] ${identity.column} is claimed by ${match.tenantCount} brokerages — ` +
          "refusing to guess a tenant",
        )
        return NextResponse.json(
          { success: false, reason: "tenant_ambiguous", identity: identity.column },
          { status: 409 },
        )
      }
    }

    if (!contactId) {
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

    // ─── APPLY SUPPRESSION BASED ON INTENT ─────────────────────────────────
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
    if (payload.leadId) {
      await syncSuppressionState({
        sourceType: "contact",
        sourceId: contactId,
        suppressionFields: suppressionFields as any,
      })
    }

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
