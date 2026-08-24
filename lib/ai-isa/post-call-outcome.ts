// lib/ai-isa/post-call-outcome.ts
// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATIC POST-CALL OUTCOME — the Twilio-native lane's end-of-call brain. The
// CONTACT-side twin of routeLeadCallIntent, plus the scoring + rolling-
// qualification + follow-up rails that fire for EVERY completed AI call. Runs at
// call close from BOTH close paths (the turn route's spoken goodbye AND the
// status callback's hangup); idempotent, so the mutually-exclusive double-fire
// is safe and a re-posted callback never double-acts.
//
// All automatic, all built on EXISTING rails (no parallel systems):
//   1. Ensures the call is analyzed (call_analyses via analyzeVoiceCallRow) so
//      sentiment + urgency + intent exist — the one insight vocabulary the
//      hourly sweep and Zoom lane also use. Skips if already analyzed.
//   2. ROLLING QUALIFICATION (lead calls): voiceSignalFor → leads.lead_temperature
//      + lead_score (the intended-but-unwired voice hook), so a phone call feeds
//      the SAME readiness/Engine-2 inputs the email ISA writes. Conversion/halt
//      for leads stays with routeLeadCallIntent (which runs alongside this).
//   3. ai_isa_calls SCORING: lead_quality_score + appointment_set on the row.
//   4. CONTACT-side routing (the gap routeLeadCallIntent never covered):
//        EXPLICIT caller opt-out (detectOptOutIntent, high-confidence, caller-only)
//          → contacts DNC/call_stop_flag + activity + agent notify. DNC fires ONLY
//          here — never on a loose substring or a merely negative mood.
//        negative TONE (no opt-out) → notify the agent, NEVER auto-suppress.
//        positive → agent notify + an AUTO-DRAFTED follow-up that AUTO-SENDS via
//          dispatchSms/dispatchEmail (the live call is the engagement+consent
//          context); the dispatch rail still enforces TCPA/consent/DNC/quiet-hours
//          + Fair-Housing; a gate-blocked send degrades to a staged proposal.
//
// Never throws — the voice webhook must never 500 over post-call work.

import { voiceSignalFor, signalScore, signalTemperature } from "./qualification-core"
import { detectOptOutIntent } from "./opt-out-utils"
import { isAnalyzableCall, analyzeVoiceCallRow } from "@/lib/voice/call-analysis"

const POS_INTENT = /(appointment|schedul|book|ready to (buy|list|sell)|pre-?approv|tour|showing|see the (home|house|property)|make an offer)/i
const APPT_INTENT = /(appointment|schedul|book|tour|showing)/i

/** PURE: the CALLER's turns, ONE utterance per element. The running transcript
 *  interleaves "Caller:"/"AI:" lines (appendTranscript). We keep only the caller
 *  lines and NEVER join them — the opt-out detector runs PER TURN so a greedy
 *  channel regex (e.g. /no.*call/) can't span unrelated turns, and the AI's own
 *  spoken lines are excluded entirely. */
export function callerTurns(transcript: string | null | undefined): string[] {
  return (transcript ?? "")
    .split("\n")
    .filter((line) => /^\s*Caller:/i.test(line))
    .map((line) => line.replace(/^\s*Caller:\s*/i, "").trim())
    .filter(Boolean)
}

// Precise, word-boundaried opt-out phrases (NO greedy .*) for the irreversible
// DNC decision — complements detectOptOutIntent's channel-"all" branch
// (single-word + global phrases, also greedy-free). We deliberately do NOT trust
// detectOptOutIntent's greedy per-channel regexes (/no.*call/, /stop.*sms/ …)
// that a merely conversational turn ("no, call me tomorrow") could trip.
const EXPLICIT_OPTOUT = /\b(stop calling|quit calling|do ?n[o']?t call me|stop contacting me|take me off (your|the) list|remove me from (your|the) list|do ?n[o']?t contact me|leave me alone)\b/i

/** PURE: an EXPLICIT, high-confidence caller opt-out in ANY single turn. DNC is
 *  irreversible, so this favors precision over recall — greedy per-channel
 *  matches are ignored; only unambiguous global signals count. */
export function isCallerOptOut(turns: string[]): boolean {
  return turns.some((t) => {
    const o = detectOptOutIntent(t)
    if (o.isOptOut && o.confidence === "high" && o.channel === "all") return true
    return EXPLICIT_OPTOUT.test(t)
  })
}

export interface PostCallOutcome {
  ok: boolean
  processed: boolean
  branch?: "lead" | "contact" | "none"
  signal?: string
  negative?: boolean
  optOut?: boolean
  positive?: boolean
  followUpProposed?: boolean
  error?: string
}

export async function routePostCallOutcome(svc: any, voiceCallId: string): Promise<PostCallOutcome> {
  try {
    // `let`, not `const`: the conversion-finality step below re-keys a converted
    // lead's call onto the contact it became, and the contact branch reads
    // `call.contact_id`.
    let { data: call } = await svc.from("voice_calls")
      .select("id, brokerage_id, contact_id, lead_id, agent_id, direction, transcription, duration_seconds, status, call_type")
      .eq("id", voiceCallId).maybeSingle()
    if (!call) return { ok: false, processed: false, error: "call not found" }
    const transcription: string = (call as any).transcription ?? ""

    // 1. Ensure analysis exists (idempotent: reuse the row if the sweep/Zoom lane
    //    already wrote it; else analyze now so routing has sentiment + urgency).
    let sentiment = "neutral", urgencyScore = 0, intentPrimary = "", summary = ""
    let objections: string[] = []
    const { data: existing } = await svc.from("call_analyses")
      .select("sentiment, urgency_score, intent_primary, objections, summary")
      .eq("voice_call_id", call.id).maybeSingle()
    const readAnalysis = (a: any) => {
      sentiment = a?.sentiment ?? "neutral"
      urgencyScore = a?.urgency_score ?? 0
      intentPrimary = a?.intent_primary ?? ""
      objections = a?.objections ?? []
      summary = a?.summary ?? ""
    }
    if (existing) {
      readAnalysis(existing)
    } else if (isAnalyzableCall(call as any, false)) {
      const r = await analyzeVoiceCallRow(svc, call as any)
      if (r.ok) {
        const { data: fresh } = await svc.from("call_analyses")
          .select("sentiment, urgency_score, intent_primary, objections, summary")
          .eq("voice_call_id", call.id).maybeSingle()
        if (fresh) readAnalysis(fresh)
      }
    }

    // 2. Classify the outcome. DNC/call-stop is a STRONG, hard-to-reverse action,
    //    so it triggers ONLY on an EXPLICIT opt-out in a SINGLE caller turn (never
    //    the AI's lines, never spanning turns, never a greedy per-channel match —
    //    so "cancel my reservation" / "bus stop" / "no, call me tomorrow" are NOT
    //    opt-outs). A merely NEGATIVE-sentiment call (frustrated, bad news)
    //    notifies the agent but is NEVER auto-suppressed.
    void objections
    const isOptOut = isCallerOptOut(callerTurns(transcription))
    const isNegative = sentiment === "negative"
    const isPositive = !isOptOut && !isNegative && (sentiment === "positive" || POS_INTENT.test(intentPrimary))
    const appointmentIntent = APPT_INTENT.test(intentPrimary)
    const signal = voiceSignalFor({ urgencyScore, isPositiveOutcome: isPositive, isNegativeOutcome: isOptOut || isNegative })

    // 3. ai_isa_calls scoring (best-effort, isolated — the row exists for AI-ISA
    //    calls; a no-match update is a harmless no-op for non-ISA calls). A scoring
    //    failure must never skip the routing below.
    try {
      await svc.from("ai_isa_calls").update({
        lead_quality_score: signalScore(signal),
        appointment_set: appointmentIntent,
        ai_response_summary: summary ? summary.slice(0, 500) : null,
      }).eq("voice_call_id", call.id)
    } catch { /* best-effort scoring */ }

    // 4. CONVERSION FINALITY — decide WHICH branch owns this call before either
    //    runs. The lead branch below is entered on `call.lead_id`, and it is
    //    checked BEFORE the contact branch — so a call placed against a lead that
    //    has since converted took the lead branch and wrote rolling
    //    `lead_temperature` / `lead_score` onto a dead lead row, while the
    //    contact-side routing (opt-out → DNC, positive → agent notify +
    //    follow-up) never ran at all. That is the ruling inverted: the lead got
    //    the update and the contact got nothing.
    //
    //    RE-ROUTE, not refuse: the call really happened and its outcome is real
    //    work. A converted lead's call is handed to the CONTACT branch, keyed to
    //    the contact the lead became. Fails closed — an unreadable lead skips the
    //    lead-keyed write rather than performing it blind.
    let effectiveContactId: string | null = (call.contact_id as string | null) ?? null
    let leadBranchOwns = !!call.lead_id
    if (call.lead_id) {
      const { assertLeadNotConverted } = await import("@/lib/contact-promotion/conversion-finality")
      const verdict = await assertLeadNotConverted(svc, call.lead_id as string)
      if (!verdict.allowed) {
        leadBranchOwns = false
        if (verdict.contactId) effectiveContactId = verdict.contactId
        else console.error(`[post-call-outcome] ${verdict.reason}`)
      }
    }
    if (effectiveContactId && effectiveContactId !== call.contact_id) {
      call = { ...call, contact_id: effectiveContactId }
    }

    // 4a. LEAD call → rolling qualification (conversion/halt is routeLeadCallIntent's
    //     job, running alongside this). Additive + idempotent.
    if (leadBranchOwns) {
      try {
        await svc.from("leads").update({
          lead_temperature: signalTemperature(signal),
          lead_score: signalScore(signal),
          updated_at: new Date().toISOString(),
        }).eq("id", call.lead_id)
      } catch { /* best-effort rolling qualification */ }
      return { ok: true, processed: true, branch: "lead", signal, negative: isOptOut || isNegative, positive: isPositive }
    }

    // 4b. CONTACT call → the post-call routing routeLeadCallIntent never covered.
    if (call.contact_id) {
      if (isOptOut) {
        // The ONLY DNC trigger: an explicit, high-confidence caller opt-out.
        await haltEngagementForNegativeContact(svc, call, summary)
        return { ok: true, processed: true, branch: "contact", signal, optOut: true, negative: true }
      }
      if (isPositive) {
        await notifyAgentPositive(svc, call, summary, intentPrimary, urgencyScore)
        const followUpProposed = await sendPostCallFollowUp(svc, call, summary, intentPrimary)
        return { ok: true, processed: true, branch: "contact", signal, positive: true, followUpProposed }
      }
      if (isNegative) {
        // Negative tone, but NO opt-out → flag for a human, never auto-suppress.
        await notifyAgentCoolCall(svc, call, summary)
        return { ok: true, processed: true, branch: "contact", signal, negative: true }
      }
      return { ok: true, processed: true, branch: "contact", signal }
    }

    return { ok: true, processed: false, branch: "none" }
  } catch (e: any) {
    return { ok: false, processed: false, error: e?.message ?? "post-call outcome failed" }
  }
}

/** voice_calls.agent_id is agents.id; notifications.user_id needs users.id. */
async function resolveContactAgentUserId(svc: any, contactId: string | null, agentRowId: string | null): Promise<string | null> {
  let agid = agentRowId
  if (!agid && contactId) {
    const { data: c } = await svc.from("contacts").select("agent_id").eq("id", contactId).maybeSingle()
    agid = (c as any)?.agent_id ?? null
  }
  if (!agid) return null
  const { data: a } = await svc.from("agents").select("user_id").eq("id", agid).maybeSingle()
  return (a as any)?.user_id ?? null
}

/** The CONTACT twin of haltEngagementForNegativeReply — mirrors its column +
 *  notification shape (incl. notifications.body, not the phantom `message`).
 *  Idempotent: DNC flags are set-true; the activity/notify dedupe per call. */
async function haltEngagementForNegativeContact(svc: any, call: any, summary: string): Promise<void> {
  // The DNC write is the compliance-critical one — do it first, isolated so a
  // later activity/notify failure can never undo the opt-out.
  try {
    await svc.from("contacts").update({
      dnc_status: true, call_stop_flag: true, isa_reengage_allowed: false, updated_at: new Date().toISOString(),
    }).eq("id", call.contact_id)
  } catch { /* best-effort — the sweep re-attempts a lost DNC write */ }

  const tag = `[POST_CALL_OPTOUT] [${call.id}]`
  const { data: dup } = await svc.from("activities").select("id")
    .eq("contact_id", call.contact_id).eq("activity_type", "call_negative_outcome")
    .ilike("description", `${tag}%`).limit(1).maybeSingle()
  if (dup) return

  try {
    await svc.from("activities").insert({
      contact_id: call.contact_id, brokerage_id: call.brokerage_id, activity_type: "call_negative_outcome",
      title: "Contact requested no further phone/SMS contact",
      description: `${tag} Caller made an explicit opt-out request on a call — Do Not Contact + call-stop set. ${summary ?? ""}`.slice(0, 500),
      status: "completed",
    })
  } catch { /* best-effort */ }

  const notifUserId = await resolveContactAgentUserId(svc, call.contact_id, call.agent_id)
  if (notifUserId) {
    try {
      await svc.from("notifications").insert({
        user_id: notifUserId, brokerage_id: call.brokerage_id, type: "contact_opted_out",
        title: "A contact asked to stop being contacted",
        body: "The caller made an explicit opt-out request on a call — Do Not Contact was set. Tap to review.",
        entity_type: "contact", entity_id: call.contact_id, is_read: false,
      })
    } catch { /* best-effort */ }
  }
}

/** Negative TONE with NO opt-out → flag the assigned agent for a human touch.
 *  Deliberately NOT a suppression: a frustrated or bad-news call is not consent
 *  to stop contact. Deduped per call. */
async function notifyAgentCoolCall(svc: any, call: any, summary: string): Promise<void> {
  const notifUserId = await resolveContactAgentUserId(svc, call.contact_id, call.agent_id)
  if (!notifUserId) return
  const tag = `[POST_CALL_COOL] [${call.id}]`
  const { data: dup } = await svc.from("notifications").select("id")
    .eq("entity_id", call.contact_id).eq("type", "isa_call_attention").ilike("body", `%${tag}%`).limit(1).maybeSingle()
  if (dup) return
  try {
    await svc.from("notifications").insert({
      user_id: notifUserId, brokerage_id: call.brokerage_id, type: "isa_call_attention",
      title: "A call didn't go smoothly — you may want to reach out",
      body: `${tag} The AI heard a negative tone (no opt-out — the contact was NOT suppressed). ${(summary || "").slice(0, 160)}`,
      entity_type: "contact", entity_id: call.contact_id, is_read: false,
    })
  } catch { /* best-effort */ }
}

/** Positive call → tell the assigned agent (deduped per call). */
async function notifyAgentPositive(svc: any, call: any, summary: string, intentPrimary: string, urgencyScore: number): Promise<void> {
  const notifUserId = await resolveContactAgentUserId(svc, call.contact_id, call.agent_id)
  if (!notifUserId) return
  const tag = `[POST_CALL] [${call.id}]`
  const { data: dup } = await svc.from("notifications").select("id")
    .eq("entity_id", call.contact_id).eq("type", "isa_qualified_lead").ilike("body", `%${tag}%`).limit(1).maybeSingle()
  if (dup) return
  try {
    await svc.from("notifications").insert({
      user_id: notifUserId, brokerage_id: call.brokerage_id, type: "isa_qualified_lead",
      title: "AI call — a contact is ready for your follow-up",
      body: `${tag} ${intentPrimary || "Positive call"} (urgency ${urgencyScore}/100). ${(summary || "").slice(0, 160)}`,
      entity_type: "contact", entity_id: call.contact_id, is_read: false,
    })
  } catch { /* best-effort */ }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** AUTO-SEND the post-call follow-up (owner: 'yes auto on those since the
 *  conversation ended live'). The live call IS the engagement + consent context,
 *  so the AI both drafts AND sends — SMS first, email fallback. The send rides
 *  dispatchSms/dispatchEmail, which enforce TCPA/consent/DNC/quiet-hours + the
 *  Fair-Housing content backstop internally (autonomous ≠ ungated — an
 *  autonomous send ARMS the FH hard-block). A DNC contact is never followed up.
 *  If a gate BLOCKS the send (quiet hours / budget / FH), it degrades to a staged
 *  proposal so the touch is never dropped. Deduped per call. */
async function sendPostCallFollowUp(svc: any, call: any, summary: string, intentPrimary: string): Promise<boolean> {
  try {
    const sentTag = `[POST_CALL_SENT] [${call.id}]`
    const { data: dup } = await svc.from("activities").select("id")
      .eq("contact_id", call.contact_id).ilike("description", `${sentTag}%`).limit(1).maybeSingle()
    if (dup) return true

    const { data: contact } = await svc.from("contacts")
      .select("first_name, contact_type, phone, email, dnc_status").eq("id", call.contact_id).maybeSingle()
    if (!contact) return false
    if ((contact as any).dnc_status) return false // never follow up a Do-Not-Contact

    const ctype = (((contact as any).contact_type ?? "") as string).toLowerCase()
    const audience: "buyer" | "seller" = ctype.includes("seller") ? "seller" : "buyer"
    const agentUserId = await resolveContactAgentUserId(svc, call.contact_id, call.agent_id)

    const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
    const drafted = await generateClientMessage({
      brokerageId: call.brokerage_id,
      agentUserId,
      audience,
      recipientFirstName: (contact as any).first_name ?? null,
      purpose: `Follow up warmly after today's phone call.${intentPrimary ? ` They talked about: ${intentPrimary}.` : ""} Recap the next step you agreed on and make it easy to continue.`,
      facts: summary ? [{ label: "Call recap", value: summary.slice(0, 200) }] : [],
      ctas: ["Reply here or grab a time to keep things moving"],
      fallback: {
        subject: "Following up on our call",
        body: `Hi${(contact as any).first_name ? ` ${(contact as any).first_name}` : ""}, great talking with you today — I'll follow up on the next step we discussed. Reply any time and I'll take it from there.`,
      },
    })

    // AUTO-SEND — SMS first (dispatch enforces every consumer-protection gate),
    // email fallback. contactId is ALWAYS passed so the contact's consent/DNC is
    // honored; systemSource attributes the touch.
    let channel: "sms" | "email" | null = null
    if ((contact as any).phone) {
      const { dispatchSms } = await import("@/lib/providers/dispatch")
      const r = await dispatchSms({
        brokerageId: call.brokerage_id,
        to: (contact as any).phone,
        message: drafted.body.slice(0, 320),
        contactId: call.contact_id,
        agentId: call.agent_id ?? undefined,
        systemSource: "ai_isa",
        metadata: { voice_call_id: call.id, source: "ai_isa_post_call" },
      })
      if (r?.success) channel = "sms"
    }
    if (!channel && (contact as any).email) {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const r = await dispatchEmail({
        brokerageId: call.brokerage_id,
        from: "",
        to: (contact as any).email,
        subject: drafted.subject,
        html: `<p>${escapeHtml(drafted.body).replace(/\n/g, "<br>")}</p>`,
        text: drafted.body,
        contactId: call.contact_id,
        agentId: call.agent_id ?? undefined,
        systemSource: "ai_isa",
        channelPurpose: "conversation",
        metadata: { voice_call_id: call.id, source: "ai_isa_post_call" },
      })
      if (r?.success) channel = "email"
    }

    if (channel) {
      try {
        await svc.from("activities").insert({
          contact_id: call.contact_id, brokerage_id: call.brokerage_id, agent_id: call.agent_id ?? null,
          activity_type: channel === "sms" ? "sms_sent" : "email_sent",
          title: "AI post-call follow-up sent",
          description: `${sentTag} auto-sent after a positive AI call (${channel}). ${drafted.subject}`.slice(0, 500),
          status: "completed",
        })
      } catch { /* best-effort audit */ }
      return true
    }

    // A gate blocked the send (quiet hours / budget / FH / no consent) OR the
    // contact is unreachable → STAGE a proposal so the agent can send when it clears.
    return await proposePostCallFollowUp(svc, call, summary, intentPrimary, drafted)
  } catch {
    return false
  }
}

/** Fallback rail: STAGE the follow-up for one-tap approval (used when auto-send
 *  is blocked by a gate). Deduped per call. */
async function proposePostCallFollowUp(svc: any, call: any, summary: string, intentPrimary: string, pre?: { subject: string; body: string }): Promise<boolean> {
  try {
    const tag = `[POST_CALL_FOLLOWUP] [${call.id}]`
    const { data: dup } = await svc.from("agent_client_messages").select("id")
      .ilike("rationale", `${tag}%`).limit(1).maybeSingle()
    if (dup) return false

    const { data: contact } = await svc.from("contacts")
      .select("first_name, contact_type").eq("id", call.contact_id).maybeSingle()
    if (!contact) return false
    const ctype = (((contact as any).contact_type ?? "") as string).toLowerCase()
    const audience: "buyer" | "seller" = ctype.includes("seller") ? "seller" : "buyer"
    const agentUserId = await resolveContactAgentUserId(svc, call.contact_id, call.agent_id)

    // `pre` IS THE MESSAGE THAT WAS ALREADY WRITTEN. It was accepted here and read by
    // NOTHING until 2026-08-24: sendPostCallFollowUp above drafts the follow-up, a
    // gate (quiet hours / budget / Fair Housing / no consent) blocks the SEND, and it
    // hands the finished draft straight to this fallback — which threw it away and
    // paid the model to write the same message a second time, from a BYTE-IDENTICAL
    // copy of the same generateClientMessage call. `ai_tool_usage` is the platform's
    // AI cost ledger and it feeds the overage projection (CLAUDE.md §5), so a
    // duplicate generation on every gated call is a wrong invoice, not just latency.
    //
    // It was a CORRECTNESS defect too: the agent then one-tapped a message that was
    // NOT the one the send gate had examined.
    const reuse =
      pre && typeof pre.subject === "string" && typeof pre.body === "string" &&
      pre.subject.trim().length > 0 && pre.body.trim().length > 0
        ? { subject: pre.subject.trim(), body: pre.body.trim() }
        : null

    const drafted = reuse ?? await (async () => {
      const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
      return generateClientMessage({
        brokerageId: call.brokerage_id,
        agentUserId,
        audience,
        recipientFirstName: (contact as any).first_name ?? null,
        purpose: `Follow up warmly after today's phone call.${intentPrimary ? ` They talked about: ${intentPrimary}.` : ""} Recap the next step you agreed on and make it easy to continue.`,
        facts: summary ? [{ label: "Call recap", value: summary.slice(0, 200) }] : [],
        ctas: ["Reply here or grab a time to keep things moving"],
        fallback: {
          subject: "Following up on our call",
          body: `Hi${(contact as any).first_name ? ` ${(contact as any).first_name}` : ""}, great talking with you today — I'll follow up on the next step we discussed. Reply any time and I'll take it from there.`,
        },
      })
    })()

    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const p = await proposeClientMessage({
      brokerageId: call.brokerage_id,
      agentKind: "ai_isa",
      entityType: "contact",
      entityId: call.contact_id,
      recipientContactId: call.contact_id,
      audience,
      subject: drafted.subject,
      body: drafted.body,
      channel: "sms",
      rationale: `${tag} — ${reuse ? "the draft the send gate blocked, staged unchanged" : "auto-drafted after a positive AI call"} so the agent one-taps to send; TCPA/consent/Fair-Housing enforced at dispatch.`,
    }, svc)
    return (p as any)?.ok !== false
  } catch {
    return false
  }
}
