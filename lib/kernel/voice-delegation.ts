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
import {
  buildDateChain,
  computeCriticalPath,
  fmtChainDate,
  type ChainSeverity,
  type CriticalPath,
} from "@/lib/kernel/title-closing-watchtower"
import type { SituationKind as VideoSituationKind, TargetChannel as VideoTargetChannel } from "@/lib/video/video-director"

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
  eventType: "just_listed" | "coming_soon" | "under_contract" | "just_sold"; bypassPolicy: boolean;
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

// ─── VERB: "make a market-update reel for Instagram" — the Video Director takes the command ──
//
// The voice admin doesn't just cut listing promos (voiceCutPromo) — it commissions the
// ON-DEMAND video kinds the Director uniquely enables (market update, CMA, explainer,
// neighborhood spotlight, testimonial, anniversary equity). The spoken command IS the manual
// trigger: the Director picks the best Remotion format for the situation+channel, assembles
// intro (brand+photo+hook) → main → outro (brand+contact+tracked QR), and stages a
// COMPLIANCE-GATED ai_video_projects row. Nothing auto-publishes — social drafts still wait in
// the approval queue. Listing-promo kinds stay on voiceCutPromo (no drift).

/** PURE: map a spoken phrase to the Director SituationKind, or null when it's not an on-demand
 *  kind this commissioner handles (listing promos route through voiceCutPromo). */
export function normalizeVideoKind(text: string): VideoSituationKind | null {
  const t = (text ?? "").toLowerCase()
  if (/home ?value|what('?s| is) (it|my home|the home) worth|\bcma\b|comparable/.test(t)) return "cma"
  if (/market\s*(update|report|beat|this month)|\bmarket\b/.test(t)) return "market_update"
  if (/explain|explainer|educational|how[- ]?to|teach/.test(t)) return "explainer"
  if (/neighborhood|community|area spotlight|lifestyle/.test(t)) return "neighborhood"
  if (/testimonial|review|five[- ]?star|client (says|love)/.test(t)) return "testimonial"
  if (/anniversary|equity report|year in your home/.test(t)) return "anniversary"
  if (/presentation|listing strategy|section reel/.test(t)) return "presentation"
  return null
}

/** PURE: map a spoken phrase to a target channel; default Instagram (square feed). */
export function normalizeVideoChannel(text: string): VideoTargetChannel {
  const t = (text ?? "").toLowerCase()
  if (/tik ?tok/.test(t)) return "tiktok"
  if (/you ?tube/.test(t)) return "youtube"
  if (/facebook|\bfb\b/.test(t)) return "facebook"
  if (/\bemail\b|newsletter/.test(t)) return "email"
  if (/portal/.test(t)) return "portal"
  return "instagram"
}

/** PURE: the spoken confirmation describing the directed build. */
export function composeCommissionSpoken(
  kind: VideoSituationKind, channel: VideoTargetChannel, compositionId: string, status: string,
): string {
  const kindLabel = kind.replace(/_/g, " ")
  if (status === "already_staged") return `A ${kindLabel} video is already in the pipeline — no duplicate render.`
  if (status === "blocked") return `I couldn't clear that ${kindLabel} video through compliance — nothing was staged.`
  if (status === "failed") return `The ${kindLabel} video didn't queue — try again in a moment.`
  return `On it — directing a ${kindLabel} reel for ${channel}: I pick the best format (${compositionId}), open with your brand, photo and a hook, then the ${kindLabel}, and close with your contact and a scannable QR. It clears Fair Housing and brand compliance, then the social drafts land in your approval queue.`
}

/** Seam: how the directed commission happens (tests inject; prod uses the Director). */
export type CommissionDispatcher = (
  situation: { kind: VideoSituationKind; tier: "solo_agent"; targetChannel: VideoTargetChannel; facts?: Record<string, unknown> },
  opts: { brokerageId: string; agentUserId: string; listingId?: string | null; contactId?: string | null },
) => Promise<{ ok: boolean; status: string; compositionId?: string; reason?: string }>

/** "Make a market-update reel for Instagram" — the Director commissions an on-demand video. */
export async function voiceCommissionVideo(
  input: {
    brokerageId: string; agentUserId: string;
    kind: VideoSituationKind; targetChannel: VideoTargetChannel;
    listingId?: string | null; contactId?: string | null; dispatcher?: CommissionDispatcher;
  },
  _client?: Svc,
): Promise<DelegationResult> {
  const dispatcher: CommissionDispatcher = input.dispatcher ?? (async (situation, opts) => {
    const { commissionVideo } = await import("@/lib/video/video-director")
    const r = await commissionVideo(situation, opts)
    return { ok: r.ok, status: r.status, compositionId: r.compositionId, reason: r.reason }
  })
  const r = await dispatcher(
    { kind: input.kind, tier: "solo_agent", targetChannel: input.targetChannel, facts: {} },
    { brokerageId: input.brokerageId, agentUserId: input.agentUserId, listingId: input.listingId ?? null, contactId: input.contactId ?? null },
  )
  return {
    ok: r.ok && (r.status === "staged" || r.status === "already_staged"),
    spoken: composeCommissionSpoken(input.kind, input.targetChannel, r.compositionId ?? "the right reel", r.ok ? r.status : (r.status || "failed")),
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

// ─── VERB: "optimize the Henderson tour" — drive the REAL tour optimizer ──────────
//
// Resolve the buyer contact by name → find their LATEST planned, not-yet-optimized
// tour → run the canonical optimizeTourRoute (the real Shopping Agent play; never a
// reimplementation) → speak back the new stop order, total estimated drive time, and
// an HONEST note for any stop that couldn't be geocoded. Read+write on the buyer's own
// tour rows only; nothing client-facing is sent.

/** Pure: a stop's place in the spoken running order — address + whether it was sequenced. */
export interface SpokenTourStop {
  address: string
  /** true when real coordinates placed it; false = kept in entered order, no drive. */
  sequenced: boolean
}

/** Pure: compose the spoken optimize-tour confirmation. Drive time is ALWAYS labeled an
 *  ESTIMATE (never a traffic claim); un-geocoded stops are called out honestly by name so
 *  the agent knows exactly which addresses the router couldn't place. */
export function composeOptimizeTourSpoken(args: {
  buyerName: string
  stops: SpokenTourStop[]
  totalDriveMinutes: number
  stopsSequenced: number
  stopsTotal: number
}): string {
  const { buyerName, stops, totalDriveMinutes, stopsSequenced, stopsTotal } = args
  const order = stops.map((s) => s.address).join(", then ")
  const driveSentence =
    stopsSequenced >= 2
      ? ` That's about ${totalDriveMinutes} minute${totalDriveMinutes === 1 ? "" : "s"} of estimated drive time between stops — a straight-line estimate for planning, not live traffic.`
      : ""
  const unplaced = stops.filter((s) => !s.sequenced).map((s) => s.address)
  const honest =
    unplaced.length > 0
      ? ` I couldn't map ${unplaced.length === 1 ? "one stop" : `${unplaced.length} stops`} — ${unplaced.join(", ")} — so ${unplaced.length === 1 ? "it stayed" : "they stayed"} in the entered order with no drive estimate.`
      : ""
  return `${buyerName}'s tour is reordered for the shortest drive: ${order}.${driveSentence}${honest}`
}

export interface OptimizeTourSpokenResult extends DelegationResult {
  tourId?: string
  totalDriveMinutes?: number
  stopsSequenced?: number
  stopsTotal?: number
}

/** "Optimize the Henderson tour" — resolve the buyer, find their latest planned tour,
 *  run the REAL optimizer, speak the new order + honest geocoding note. */
export async function voiceOptimizeTour(
  input: {
    brokerageId: string
    agentUserId: string
    contactId: string
    /** Injected ONLY by the simulator (fixed coords, no network). Prod uses the real geocoder. */
    resolveCoords?: import("@/lib/kernel/tour-optimizer").ResolveCoords
    now?: Date
  },
  client?: Svc,
): Promise<OptimizeTourSpokenResult> {
  const supabase = client ?? createServiceClient()
  const { data: c } = await supabase.from("contacts")
    .select("first_name, last_name").eq("id", input.contactId).maybeSingle()
  const buyerName = [(c as any)?.first_name, (c as any)?.last_name].filter(Boolean).join(" ").trim() || "your buyer"

  // The buyer's LATEST planned tour that hasn't been optimized yet (the designed window:
  // the optimizer stamps total_drive_time_minutes, so a re-run on an optimized tour is a
  // no-op). Tenant-scoped by brokerage_id.
  const { data: tours } = await supabase.from("tours")
    .select("id, tour_date, total_drive_time_minutes")
    .eq("contact_id", input.contactId)
    .eq("brokerage_id", input.brokerageId)
    .eq("status", "planned")
    .order("tour_date", { ascending: false })
    .limit(5)
  const tourRows = (tours ?? []) as any[]
  const pending = tourRows.find((t) => t.total_drive_time_minutes == null)
  if (tourRows.length === 0) {
    return { ok: false, spoken: `I don't see a planned tour for ${buyerName} right now — build one in the tour planner and I'll optimize the route.` }
  }
  if (!pending) {
    return { ok: true, tourId: tourRows[0].id, spoken: `${buyerName}'s tour is already optimized — the route and times are set. Want me to re-plan it from scratch instead?` }
  }

  const { optimizeTourRoute } = await import("@/lib/kernel/tour-optimizer")
  const r = await optimizeTourRoute(pending.id, supabase, { now: input.now, resolveCoords: input.resolveCoords })
  if (!r.ok) {
    return { ok: false, tourId: pending.id, spoken: `I couldn't optimize ${buyerName}'s tour — ${r.reason === "no_stops" ? "there are no stops on it yet" : "try again in a moment"}.` }
  }

  // Read the freshly-written order back to speak it (the optimizer is the source of truth).
  const { data: stops } = await supabase.from("tour_stops")
    .select("property_address, order_index, drive_time_from_prev_minutes")
    .eq("tour_id", pending.id)
    .order("order_index", { ascending: true })
  const spokenStops: SpokenTourStop[] = ((stops ?? []) as any[]).map((s, i) => ({
    address: (s.property_address ?? "a home on the tour") as string,
    // A stop is "sequenced" when it carries a real drive estimate, OR it's the first
    // sequenced stop (whose drive from origin may be null but it WAS placed). The runner
    // marks un-geocoded stops with a null drive AND appends them last, so a null-drive
    // stop after a non-null one is the honest un-geocoded tail.
    sequenced: i < r.stopsSequenced,
  }))

  const spoken = composeOptimizeTourSpoken({
    buyerName,
    stops: spokenStops,
    totalDriveMinutes: r.totalDriveMinutes,
    stopsSequenced: r.stopsSequenced,
    stopsTotal: r.stopsTotal,
  })
  return {
    ok: true, tourId: pending.id, totalDriveMinutes: r.totalDriveMinutes,
    stopsSequenced: r.stopsSequenced, stopsTotal: r.stopsTotal, spoken,
  }
}

// ─── VERB: "what closings are at risk this week?" — READ-ONLY watchtower scan ─────
//
// Read the brokerage's live under-contract deals' date chains and speak the at_risk /
// tight ones with the binding constraint + days of slack. Reuses the watchtower's PURE
// buildDateChain + computeCriticalPath over the SAME transaction_milestones read path the
// runner uses — no recompute, no new math, no writes.

const LIVE_TXN_STATUSES_FOR_RISK = ["active", "under_contract", "closing"]

export interface AtRiskDeal {
  transactionId: string
  dealName: string
  severity: ChainSeverity
  bindingLabel: string | null
  slackDays: number | null
  daysToClosing: number
  closingDate: string
}

/** Pure: rank at-risk before tight, then by least slack (the most binding first). */
export function rankAtRiskDeals(deals: AtRiskDeal[]): AtRiskDeal[] {
  const sevRank: Record<ChainSeverity, number> = { at_risk: 0, tight: 1, ok: 2 }
  return [...deals].sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity]
    const as = a.slackDays ?? Number.POSITIVE_INFINITY
    const bs = b.slackDays ?? Number.POSITIVE_INFINITY
    return as - bs
  })
}

/** Pure: compose the spoken at-risk closings rundown. Plain-language, process-only
 *  (Fair-Housing-safe: dates and constraints, never people). Honest when the week is clear. */
export function composeClosingsAtRiskSpoken(deals: AtRiskDeal[], skippedNoChain: number): string {
  const flagged = deals.filter((d) => d.severity !== "ok")
  if (flagged.length === 0) {
    const tail = skippedNoChain > 0
      ? ` ${skippedNoChain} deal${skippedNoChain === 1 ? " has" : "s have"} no closing date on file yet, so I can't read a timeline there.`
      : ""
    return `Good news — none of your under-contract deals are at risk right now; every date chain still fits before closing.${tail}`
  }
  const lines = flagged.slice(0, 5).map((d) => {
    const slack = d.slackDays
    const slackPhrase =
      slack === null
        ? ""
        : slack < 0
          ? ` — ${Math.abs(slack)} day${Math.abs(slack) === 1 ? "" : "s"} short of the room it needs`
          : ` — only ${slack} day${slack === 1 ? "" : "s"} of slack`
    const constraint = d.bindingLabel ? `${d.bindingLabel} is the binding constraint${slackPhrase}` : `the closing date itself is the constraint`
    const head = d.severity === "at_risk" ? "at risk" : "tight"
    return `${d.dealName}: ${head}, closing ${fmtChainDate(d.closingDate)} — ${constraint}.`
  })
  const atRiskCount = flagged.filter((d) => d.severity === "at_risk").length
  const tightCount = flagged.filter((d) => d.severity === "tight").length
  const lead =
    `You have ${flagged.length} closing${flagged.length === 1 ? "" : "s"} that need${flagged.length === 1 ? "s" : ""} attention` +
    ` — ${atRiskCount} at risk, ${tightCount} tight.`
  return `${lead} ${lines.join(" ")}`
}

export interface ClosingsAtRiskResult {
  ok: boolean
  spoken: string
  deals: AtRiskDeal[]
  scanned: number
  skippedNoChain: number
}

/** "What closings are at risk this week?" — read-only scan of live deals' critical paths. */
export async function voiceClosingsAtRisk(
  input: { brokerageId: string; now?: Date },
  client?: Svc,
): Promise<ClosingsAtRiskResult> {
  const supabase = client ?? createServiceClient()
  const now = input.now ?? new Date()

  const { data: txns } = await supabase.from("transactions")
    .select("id, deal_name, property_address, status, deleted_at")
    .eq("brokerage_id", input.brokerageId)
    .in("status", LIVE_TXN_STATUSES_FOR_RISK)
    .is("deleted_at", null)
    .limit(200)
  const txnRows = (txns ?? []) as any[]

  const deals: AtRiskDeal[] = []
  let skippedNoChain = 0
  for (const t of txnRows) {
    // SAME read path the runner uses: the chain milestone rows for this deal.
    const { data: msRows } = await supabase.from("transaction_milestones")
      .select("milestone_name, target_date, status")
      .eq("transaction_id", t.id)
      .eq("brokerage_id", input.brokerageId)
    const chain = buildDateChain((msRows ?? []) as any[])
    const path: CriticalPath | null = computeCriticalPath(chain, now)
    if (!path) { skippedNoChain += 1; continue } // no closing date → no honest path
    deals.push({
      transactionId: t.id,
      dealName: t.deal_name ?? t.property_address ?? "an under-contract deal",
      severity: path.severity,
      bindingLabel: path.bindingLabel,
      slackDays: path.slackDays,
      daysToClosing: path.daysToClosing,
      closingDate: path.closingDate,
    })
  }
  const ranked = rankAtRiskDeals(deals)
  return {
    ok: true,
    spoken: composeClosingsAtRiskSpoken(ranked, skippedNoChain),
    deals: ranked,
    scanned: txnRows.length,
    skippedNoChain,
  }
}

// ─── VERB: "send the Garcias their anniversary equity report" — GATED proposal ────
//
// Resolve the contact → run the anniversary-equity play SCOPED to that ONE contact (the
// REAL runner, valuation fetcher and all — never a reimplementation) → the client-facing
// note lands in the GATE (approval queue) exactly like voiceFollowUp. Speak that it's
// queued for approval; NEVER an autonomous client send. No real valuation → honest skip.

export interface EquityReportSpokenResult extends DelegationResult {
  proposed?: boolean
  skipReason?: string
}

/** Pure: compose the spoken equity-report confirmation / honest skip. */
export function composeEquityReportSpoken(args: {
  contactName: string
  proposed: number
  skippedNoValuation: number
  skippedDuplicate: number
  skippedWithdrawn: number
  anniversariesDetected: number
}): { ok: boolean; spoken: string; skipReason?: string } {
  const { contactName, proposed, skippedNoValuation, skippedDuplicate, skippedWithdrawn, anniversariesDetected } = args
  if (proposed > 0) {
    return { ok: true, spoken: `Done — ${contactName}'s anniversary equity report is drafted with real numbers and waiting in your approval queue. Nothing goes to them until you approve it.` }
  }
  if (skippedWithdrawn > 0) {
    return { ok: false, skipReason: "withdrawn", spoken: `That relationship is withdrawn — the team won't send ${contactName} an equity report unless they come back to us.` }
  }
  if (skippedDuplicate > 0) {
    return { ok: true, spoken: `${contactName} already has this year's anniversary equity report in the queue — I didn't draft a duplicate.` }
  }
  if (anniversariesDetected === 0) {
    return { ok: false, skipReason: "no_anniversary", spoken: `${contactName} doesn't have a closing anniversary near today, so there's no equity report to send right now.` }
  }
  if (skippedNoValuation > 0) {
    return { ok: false, skipReason: "no_valuation", spoken: `I couldn't get a real valuation for ${contactName}'s home, so I'm not sending an estimate I can't stand behind. We can pull a fresh value and try again.` }
  }
  return { ok: false, skipReason: "no_report", spoken: `I couldn't put together an equity report for ${contactName} right now — there may be no purchase price or address on file.` }
}

/** "Send the Garcias their anniversary equity report" — run the REAL play for ONE
 *  contact; the note lands in the gate. Never autonomous. */
export async function voiceSendEquityReport(
  input: {
    brokerageId: string
    contactId: string
    /** Injected ONLY by the simulator (fixed value, no vendor spend). Prod uses RentCast. */
    valuationFetcher?: import("@/lib/kernel/anniversary-equity").ValuationFetcher
    copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator
    now?: Date
  },
  client?: Svc,
): Promise<EquityReportSpokenResult> {
  const supabase = client ?? createServiceClient()
  const { data: c } = await supabase.from("contacts")
    .select("first_name, last_name").eq("id", input.contactId).maybeSingle()
  const contactName = [(c as any)?.first_name, (c as any)?.last_name].filter(Boolean).join(" ").trim() || "your client"

  const { runAnniversaryEquity } = await import("@/lib/kernel/anniversary-equity")
  // Scope the REAL play to this one contact by filtering at the source: the runner scans
  // closed transactions for the brokerage, so we run it and read the per-contact outcome.
  // To scope to ONE contact we wrap the runner with a contact-scoped query is not exposed;
  // instead we run the play and rely on its idempotency — but to avoid touching OTHER
  // contacts we run a contact-scoped pass via the dedicated entry below.
  const r = await runAnniversaryEquityForContact(
    input.brokerageId, input.contactId,
    { now: input.now, valuationFetcher: input.valuationFetcher, copyGenerator: input.copyGenerator },
    supabase,
  )

  const spoken = composeEquityReportSpoken({
    contactName,
    proposed: r.reportsProposed,
    skippedNoValuation: r.skippedNoValuation,
    skippedDuplicate: r.skippedDuplicate,
    skippedWithdrawn: r.skippedWithdrawn,
    anniversariesDetected: r.anniversariesDetected,
  })
  return { ok: spoken.ok, spoken: spoken.spoken, proposed: r.reportsProposed > 0, skipReason: spoken.skipReason }
}

/** Run the anniversary-equity play for ONE contact's closed transactions only — the same
 *  REAL runner logic, just scoped. Implemented in anniversary-equity.ts (no duplication). */
async function runAnniversaryEquityForContact(
  brokerageId: string,
  contactId: string,
  opts: {
    now?: Date
    valuationFetcher?: import("@/lib/kernel/anniversary-equity").ValuationFetcher
    copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator
  },
  client?: Svc,
): Promise<import("@/lib/kernel/anniversary-equity").AnniversaryEquityResult> {
  const { runAnniversaryEquity } = await import("@/lib/kernel/anniversary-equity")
  return runAnniversaryEquity(brokerageId, { ...opts, contactId }, client)
}
