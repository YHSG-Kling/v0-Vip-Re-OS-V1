// lib/kernel/voice-delegation.ts
//
// VOICE DELEGATION — the bullpen answers, then takes the handoff. The agent hangs up
// from a call, says "team, send Jordan a follow-up — and get marketing going," and the
// team executes ON THE EXISTING RAILS, never around them:
//
//   · FOLLOW-UP — the spoken instruction IS the human decision: the message is
//     proposed into the gate and approved AS THE AGENT (approved_by = the speaking
//     user — a real human, never forged). The gate still re-checks consent at
//     approval, so a dictated email to an opted-out address hard-blocks exactly like
//     any other send. Channel picked by consent state (clean email → email, else
//     portal). Full audit: proposed → approved(by human) → sent, same as a click.
//
//   · START MARKETING — enrolls the contact in the best ACTIVE campaign sequence
//     (sequence_enrollments, enrolled_by = the agent). Nothing is sent by this call:
//     the campaign-sequence-steps worker executes each step behind its own
//     compliance gate. Idempotent — an active enrollment is never doubled.
//
// A WITHDRAWN relationship refuses both — the consent chain's promise holds even
// against a voice command. NOT server-only (simulator-driven); pure helpers exported.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Pure: the post-call follow-up note (dictation wins; default is warm, short, no pressure). */
export function composeFollowUp(contactFirstName: string | null, dictation?: string | null): { subject: string; body: string } {
  const body = dictation?.trim()
    ? dictation.trim()
    : `Hi${contactFirstName ? ` ${contactFirstName}` : ""} — great talking with you just now. I'll get everything we discussed moving and follow up with specifics shortly. Reply here any time with questions.`
  return { subject: "Great talking with you", body }
}

/** Pure: pick the listing a spoken address means — every digit group must appear and
 *  street tokens must match prefixes ("44 Birch" → "44 Birch Lane", never "144 Birch"). */
export function matchListingByAddress<T extends { id: string; address: string | null }>(
  listings: T[], spokenAddress: string,
): T | null {
  const tokens = spokenAddress.toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return null
  const scored = listings.map((l) => {
    const addrTokens = (l.address ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean)
    const every = tokens.every((t) =>
      /^\d+$/.test(t) ? addrTokens.includes(t) : addrTokens.some((a) => a.startsWith(t)))
    return { l, score: every ? tokens.length : 0 }
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
  return scored[0]?.l ?? null
}

/** Pure: the promo moment for a listing's current status (the reactor's 7-moment set). */
export function promoEventForStatus(status: string | null): "just_listed" | "under_contract" | "just_sold" {
  const s = (status ?? "").toLowerCase()
  if (s.includes("sold") || s.includes("closed")) return "just_sold"
  if (s.includes("pending") || s.includes("under_contract") || s.includes("contract")) return "under_contract"
  return "just_listed"
}

/** Pure: pick the campaign sequence to start — active first, nurture types preferred. */
export function pickSequence<T extends { id: string; name: string | null; is_active: boolean | null; sequence_type: string | null }>(
  sequences: T[],
): T | null {
  const active = sequences.filter((s) => s.is_active)
  if (active.length === 0) return null
  return active.find((s) => /nurture|follow|drip/i.test(s.sequence_type ?? "")) ?? active[0]
}

export interface DelegationResult {
  ok: boolean
  spoken: string
  messageId?: string
  enrollmentId?: string
}

/** "Send them a follow-up" — propose into the gate + approve AS the speaking agent. */
export async function voiceFollowUp(
  input: { brokerageId: string; agentUserId: string; contactId: string; dictation?: string | null },
  client?: Svc,
): Promise<DelegationResult> {
  const supabase = client ?? createServiceClient()
  const { data: c } = await supabase.from("contacts")
    .select("first_name, last_name, contact_type, nurture_status, email, email_opt_out, email_unsubscribed")
    .eq("id", input.contactId).maybeSingle()
  if (!c) return { ok: false, spoken: "I couldn't find that contact anymore." }
  if ((c as any).nurture_status === "withdrawn") {
    return { ok: false, spoken: "That relationship is withdrawn — every channel was revoked, so the team is holding all outreach unless they come to us." }
  }
  const name = [(c as any).first_name, (c as any).last_name].filter(Boolean).join(" ").trim() || "them"
  const note = composeFollowUp((c as any).first_name ?? null, input.dictation)
  const emailClean = !!(c as any).email && !(c as any).email_opt_out && !(c as any).email_unsubscribed

  const { proposeClientMessage, approveClientMessage } = await import("@/lib/agents/agent-client-messages")
  const proposed = await proposeClientMessage({
    brokerageId: input.brokerageId, agentKind: "campaign_orchestrator", entityType: "contact",
    entityId: input.contactId, recipientContactId: input.contactId,
    audience: (c as any).contact_type === "seller" ? "seller" : "buyer",
    subject: note.subject, body: note.body,
    rationale: `VOICE DELEGATION — the agent dictated this follow-up after a call; the spoken instruction is the human approval.`,
    channel: emailClean ? "email" : "portal",
  }, supabase)
  if (!proposed.ok || !proposed.id) return { ok: false, spoken: "I couldn't draft that follow-up — try again in a moment." }

  // The spoken command IS the human decision — approve as the speaking agent.
  // The gate re-checks consent at approval; a blocked channel fails loudly here.
  const approved = await approveClientMessage(proposed.id, input.agentUserId, undefined, supabase)
  if (approved.status === "skipped") {
    return { ok: false, spoken: `I drafted the follow-up for ${name} but couldn't finalize it — it's in your approval queue.`, messageId: proposed.id }
  }
  return {
    ok: true, messageId: proposed.id,
    spoken: `Done — your follow-up to ${name} is approved and on its way via ${emailClean ? "email" : "their portal"}.`,
  }
}

/** Seam: how a promo dispatch happens (tests inject; prod uses the canonical reactor). */
export type PromoDispatcher = (input: {
  brokerageId: string; listingId: string; agentUserId: string;
  eventType: "just_listed" | "under_contract" | "just_sold"; bypassPolicy: boolean;
}) => Promise<{ ok: boolean; status: string; reason?: string }>

/** "Cut a promo reel for 44 Birch" — rides the CANONICAL Remotion + D-ID rail
 *  (dispatchListingPromoVideo): AI script → compliance pre-flight (Fair Housing +
 *  brand voice, one redraft) → Remotion render → D-ID intro/outro in the agent's
 *  voice → social drafts that still wait for human approval. A voice command is a
 *  manual trigger (bypassPolicy=true; the 24h cooldown still debounces). */
export async function voiceCutPromo(
  input: { brokerageId: string; agentUserId: string; addressQuery: string; dispatcher?: PromoDispatcher },
  client?: Svc,
): Promise<DelegationResult> {
  const supabase = client ?? createServiceClient()
  const { data: rows } = await supabase.from("listings")
    .select("id, address, status, agent_id").eq("brokerage_id", input.brokerageId).limit(200)
  const listing = matchListingByAddress(((rows ?? []) as Array<{ id: string; address: string | null; status: string | null; agent_id: string | null }>), input.addressQuery)
  if (!listing) {
    return { ok: false, spoken: `I couldn't find a listing matching "${input.addressQuery}" — give me the street number and name as it appears on the listing.` }
  }
  const eventType = promoEventForStatus((listing as any).status)
  const dispatcher: PromoDispatcher = input.dispatcher ?? (async (d) => {
    const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
    const r = await dispatchListingPromoVideo({ ...d, eventType: d.eventType })
    return { ok: r.ok, status: r.status, reason: r.reason }
  })
  const r = await dispatcher({
    brokerageId: input.brokerageId, listingId: listing.id,
    agentUserId: (listing as any).agent_id ?? input.agentUserId,
    eventType, bypassPolicy: true,
  })
  if (!r.ok) return { ok: false, spoken: `The promo for ${listing.address ?? "that listing"} didn't queue — ${r.reason ?? "try again in a moment"}.` }
  if (r.status === "already_queued" || (r.reason ?? "").startsWith("cooldown")) {
    return { ok: true, spoken: `A promo for ${listing.address ?? "that listing"} is already in the pipeline — no duplicate render.` }
  }
  return {
    ok: true,
    spoken: `Cutting the ${eventType.replace(/_/g, " ")} reel for ${listing.address ?? "that listing"} now — script drafts, clears Fair Housing and brand compliance, renders with your voice on the intro and outro, and the social posts land in your approval queue.`,
  }
}

/** "Get marketing going" — enroll in the best active sequence; the worker's compliance
 *  gate governs every step. Idempotent per active enrollment. */
export async function voiceStartMarketing(
  input: { brokerageId: string; agentUserId: string; contactId: string },
  client?: Svc,
): Promise<DelegationResult> {
  const supabase = client ?? createServiceClient()
  const { data: c } = await supabase.from("contacts")
    .select("first_name, last_name, nurture_status").eq("id", input.contactId).maybeSingle()
  if (!c) return { ok: false, spoken: "I couldn't find that contact anymore." }
  if ((c as any).nurture_status === "withdrawn") {
    return { ok: false, spoken: "That relationship is withdrawn — the team won't market to them unless they come back to us." }
  }
  const name = [(c as any).first_name, (c as any).last_name].filter(Boolean).join(" ").trim() || "them"

  const { data: seqs } = await supabase.from("campaign_sequences")
    .select("id, name, is_active, sequence_type").eq("brokerage_id", input.brokerageId).limit(50)
  const seq = pickSequence(((seqs ?? []) as any[]))
  if (!seq) return { ok: false, spoken: "There's no active campaign sequence to enroll them in — build one in Campaigns and I'll take it from there." }

  const { data: existing } = await supabase.from("sequence_enrollments").select("id")
    .eq("sequence_id", seq.id).eq("contact_id", input.contactId).eq("status", "active").maybeSingle()
  if (existing) {
    return { ok: true, enrollmentId: (existing as any).id, spoken: `${name} is already running in "${seq.name ?? "that sequence"}" — no double-enroll.` }
  }
  const { data: enr, error } = await supabase.from("sequence_enrollments").insert({
    sequence_id: seq.id, contact_id: input.contactId, brokerage_id: input.brokerageId,
    enrolled_by: input.agentUserId, current_step: 0, status: "active",
    enrolled_at: new Date().toISOString(), next_step_at: new Date().toISOString(),
  }).select("id").single()
  if (error || !enr) return { ok: false, spoken: "Enrollment didn't take — try again in a moment." }
  return {
    ok: true, enrollmentId: (enr as any).id,
    spoken: `Marketing is rolling — ${name} is enrolled in "${seq.name ?? "your campaign"}". Every step still clears the compliance gate before it touches them.`,
  }
}
