// lib/kernel/referral-radar.ts
//
// SPHERE REFERRAL RADAR — the perfectly-timed repeat/referral moment.
//
// Anniversaries (idle-hands) catch the calendar; the Radar catches LIFE. A past client's
// world keeps moving after the deal closes — a new job, a new baby, a marriage, kids
// outgrowing the home, an equity milestone — and each is a window where repeat business
// or a referral is natural, not pushy. The Data Steward derives those signals onto the
// contact row (last_life_event_detected, life_events jsonb, marital_status,
// home_owner_status, equity_estimate, referral_score) — best-effort via the
// peopledata/osint enrichment seam — and the Sphere Manager surfaces the moment.
//
// The OWNER'S CONTRACT — BOTH outputs, per detected event, both GATED:
//   (a) NUDGE      — an internal `notifications` row to the RESPONSIBLE AGENT: "reach out
//                    to <client> — <life event>, here's the angle." Tells the human who +
//                    why; nothing client-facing.
//   (b) TOUCHPOINT — a persona-aware client message PROPOSED into the gate via
//                    proposeClientMessage (agentKind 'sphere_of_influence'); the human
//                    approves+sends. NEVER auto-sends. Copy is GENERATED per the contact's
//                    persona via generatePersonaCopy (deterministic fallback below).
//
// RULES: past clients only (contact_type client/lifetime_customer/sphere — the canonical
// roster at lib/contact-types.ts:LIFETIME_CONTACT_TYPES — or nurture_status closed).
// WITHDRAWN excluded. One radar touch per (contact, event-type)
// per 90 days (idempotent). Does NOT duplicate the closing-anniversary play.
// NOT server-only (simulator-driven; scraper + copyGenerator are injectable seams).

import { createServiceClient } from "@/lib/supabase/service"
import { LIFETIME_CONTACT_TYPES, isLifetimeRelationshipType } from "@/lib/contact-types"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

/** One radar touch per (contact, event-type) per this window. */
export const RADAR_DEDUPE_DAYS = 90

/** A life event is "fresh" when detected within this window (Data Steward stamp). */
export const LIFE_EVENT_FRESH_DAYS = 60

/** Equity at/above this is a milestone worth a sell/upgrade conversation. */
export const EQUITY_MILESTONE = 250_000

/** referral_score at/above this marks a contact primed to refer. */
export const REFERRAL_PRIMED_SCORE = 70

// TOMBSTONE (CLAUDE.md §1, §6). `PAST_CLIENT_TYPES` was this module's own spelling of
// the post-close contact_type roster — a third copy alongside
// lib/campaigns/contact-sources.ts and lib/kernel/returning-customer.ts, all three of
// which named `past_client` and `lifetime`. m539 retired both, so the `.or(
// "contact_type.eq.past_client,…")` built below would have carried two clauses the
// column can never satisfy. Survivor: lib/contact-types.ts:LIFETIME_CONTACT_TYPES,
// imported above.

/**
 * contacts.nurture_status values that mark a PAST client. A DIFFERENT column and a
 * DIFFERENT vocabulary from contact_type — `nurture_status` has NO CHECK constraint, so
 * m539 does not reach it and its spellings are pinned to their writers, not to a
 * constraint. `past_client` and `lifetime` stay here for exactly that reason.
 */
export const PAST_CLIENT_NURTURE = ["past_client", "closed", "lifetime"] as const

export type LifeEventType =
  | "job_change"
  | "new_baby"
  | "marriage"
  | "outgrowing_home"
  | "equity_milestone"
  | "referral_primed"

export interface RadarContact {
  id: string
  first_name?: string | null
  last_name?: string | null
  contact_type?: string | null
  nurture_status?: string | null
  buyer_stage?: string | null
  agent_id?: string | null
  last_life_event_detected?: string | null
  life_events?: unknown
  marital_status?: string | null
  home_owner_status?: string | null
  equity_estimate?: number | null
  referral_score?: number | null
  referral_potential?: string | null
}

export interface DetectedLifeEvent {
  type: LifeEventType
  /** Short human label for the nudge ("a new baby"). */
  label: string
  /** WHY this is the moment — the referral/repeat angle for the agent. */
  angle: string
  /** A safe, fact-only sentence for the client touchpoint. */
  clientHook: string
}

/** Pure: is this contact a PAST (lifetime) client the Radar may touch? */
export function isPastClient(c: Pick<RadarContact, "contact_type" | "nurture_status">): boolean {
  const n = (c.nurture_status ?? "").toLowerCase()
  return isLifetimeRelationshipType(c.contact_type)
    || (PAST_CLIENT_NURTURE as readonly string[]).includes(n)
}

/** Pure: WITHDRAWN contacts are never touched. */
export function isWithdrawn(c: Pick<RadarContact, "nurture_status">): boolean {
  return (c.nurture_status ?? "").toLowerCase() === "withdrawn"
}

/** Normalize the life_events jsonb (array of {type,...} or a loose object) into a type list. */
function lifeEventTypes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((e) => (typeof e === "string" ? e : (e && typeof e === "object" ? String((e as any).type ?? "") : "")))
      .filter(Boolean).map((s) => s.toLowerCase())
  }
  return []
}

/** Map a raw life-event tag (from the enrichment jsonb) → a radar type. */
function mapRawEvent(tag: string): LifeEventType | null {
  const t = tag.toLowerCase()
  if (/job|career|employ|promotion|new_company/.test(t)) return "job_change"
  if (/baby|child_born|newborn|new_child|birth/.test(t)) return "new_baby"
  if (/marri|wedding|engaged|spouse/.test(t)) return "marriage"
  if (/outgrow|more_space|growing_family|upsize/.test(t)) return "outgrowing_home"
  return null
}

/**
 * Pure: detect the single highest-signal life event on a contact row, with the referral
 * angle + a safe client hook. Returns null when no REAL signal is present (no fabrication).
 * Priority: explicit fresh life-event signals first, then derived milestones.
 */
export function detectLifeEvent(c: RadarContact, now: Date): DetectedLifeEvent | null {
  const fresh =
    !!c.last_life_event_detected &&
    (now.getTime() - new Date(c.last_life_event_detected).getTime()) <= LIFE_EVENT_FRESH_DAYS * 86_400_000 &&
    (now.getTime() - new Date(c.last_life_event_detected).getTime()) >= 0

  // 1) An explicit, FRESH life-event signal from the Data Steward's enrichment (jsonb).
  if (fresh) {
    const tags = lifeEventTypes(c.life_events)
    for (const tag of tags) {
      const mapped = mapRawEvent(tag)
      if (mapped) return buildEvent(mapped)
    }
    // Marital status flipped to married + fresh stamp → marriage signal.
    if ((c.marital_status ?? "").toLowerCase() === "married") return buildEvent("marriage")
  }

  // 2) DERIVED milestones — real numbers on the row, not scraped events.
  if (typeof c.equity_estimate === "number" && c.equity_estimate >= EQUITY_MILESTONE) {
    return buildEvent("equity_milestone")
  }
  if (typeof c.referral_score === "number" && c.referral_score >= REFERRAL_PRIMED_SCORE) {
    return buildEvent("referral_primed")
  }
  if ((c.referral_potential ?? "").toLowerCase() === "high") {
    return buildEvent("referral_primed")
  }

  return null
}

/**
 * TOMBSTONE — this took a second parameter, `name`, and read NOTHING out of it. Every
 * string it returns is a TEMPLATE about the event, not about the person; the name is
 * applied where the copy is addressed, by `composeReferralTouch` (this file, below)
 * and `composeReferralNudge` (this file, below), both of which already take it and
 * both of which already use it. Deleted rather than wired: a second place that
 * personalises the same copy is how two greetings for one client start (§6).
 */
function buildEvent(type: LifeEventType): DetectedLifeEvent {
  switch (type) {
    case "job_change":
      return { type, label: "a job/career change",
        angle: "A new role often means a relocation, a shorter commute, or more buying power — a natural moment to ask if their home still fits.",
        clientHook: "Congratulations on the new chapter at work" }
    case "new_baby":
      return { type, label: "a new baby",
        angle: "A growing family is the #1 trigger for a move to more space — and for an enthusiastic referral to friends starting the same journey.",
        clientHook: "Congratulations on the newest member of your family" }
    case "marriage":
      return { type, label: "a marriage",
        angle: "Merging two households or planning a first home together is a classic repeat-or-referral window.",
        clientHook: "Congratulations on your marriage" }
    case "outgrowing_home":
      return { type, label: "the family outgrowing the home",
        angle: "When the kids need more room, the upgrade conversation is welcome rather than pushy — and they know neighbors in the same spot.",
        clientHook: "It sounds like the household may be ready for a little more room" }
    case "equity_milestone":
      return { type, label: "an equity milestone",
        angle: "They've crossed a meaningful equity threshold — enough to fund an upgrade, an investment property, or a cash-out conversation.",
        clientHook: "Your home has built up real equity since you bought it" }
    case "referral_primed":
      return { type, label: "high referral readiness",
        angle: "This relationship scores as primed to refer — a warm, low-ask check-in is likely to surface a friend who's ready to buy or sell.",
        clientHook: "It's been a while — I'd love to hear how the home is treating you" }
  }
}

/** Pure: the deterministic FALLBACK touchpoint copy (persona generator may override). */
export function composeReferralTouch(name: string, ev: DetectedLifeEvent): { subject: string; body: string } {
  const first = name && name !== "there" ? ` ${name}` : ""
  return {
    subject: `Thinking of you${first}`,
    body: `Hi${first} — ${ev.clientHook}. I love staying in touch with the people I've worked with, and if there's ever anything I can do for you — or for a friend or family member thinking about a move — I'm only a call away. No agenda, just glad to be your agent for life.`,
  }
}

/** Pure: the NUDGE body — who to reach out to, and the timed angle, for the agent. */
export function composeReferralNudge(fullName: string, ev: DetectedLifeEvent): { title: string; body: string } {
  const who = fullName.trim() || "a past client"
  return {
    title: `Reach out to ${who} — ${ev.label}`,
    body: `Sphere Radar caught ${ev.label} for your past client ${who}. ${ev.angle} A ready-to-send touchpoint is waiting in your approval queue — review, tweak if you like, and send.`,
  }
}

export interface ReferralRadarResult {
  scanned: number
  detected: number
  nudges: number
  touchpoints: number
  skippedWithdrawn: number
  skippedDuplicate: number
  portalCardsPushed: number
}

/** Injectable scraper seam — derive/refresh a life-event hint for a contact. Default
 *  wraps the peopledata/osint enrichment; tests inject a fake (NO real scraper spend). */
export type LifeEventScraper = (
  contact: RadarContact,
) => Promise<{ types?: string[]; detectedAt?: string } | null>

/**
 * One Radar pass for a brokerage. For each PAST client with a REAL life-event signal,
 * propose BOTH a nudge (notifications → responsible agent) AND a touchpoint
 * (proposeClientMessage, gated). Withdrawn excluded; idempotent per (contact, event) /90d.
 */
export async function runReferralRadar(
  brokerageId: string,
  opts: { now?: Date; scraper?: LifeEventScraper; copyGenerator?: CopyGenerator } = {},
  client?: Svc,
): Promise<ReferralRadarResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: ReferralRadarResult = {
    scanned: 0, detected: 0, nudges: 0, touchpoints: 0, skippedWithdrawn: 0, skippedDuplicate: 0,
    portalCardsPushed: 0,
  }

  // Pull past clients (by contact_type OR nurture_status). Cast a wide net, filter in code
  // so a single column rename never silently drops the whole feature.
  const orClause = [
    ...LIFETIME_CONTACT_TYPES.map((t) => `contact_type.eq.${t}`),
    ...PAST_CLIENT_NURTURE.map((n) => `nurture_status.eq.${n}`),
  ].join(",")
  const { data: rows } = await supabase.from("contacts")
    .select("id, first_name, last_name, contact_type, nurture_status, buyer_stage, agent_id, last_life_event_detected, life_events, marital_status, home_owner_status, equity_estimate, referral_score, referral_potential")
    .eq("brokerage_id", brokerageId).or(orClause).limit(500)

  const contacts = (rows ?? []) as RadarContact[]
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
  const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
  const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")

  for (const c of contacts) {
    result.scanned += 1
    if (!isPastClient(c)) continue
    if (isWithdrawn(c)) { result.skippedWithdrawn += 1; continue }

    // Optional scraper refresh — default wraps peopledata/osint; merge any new signal onto
    // the row before detection (no fabrication: detect() still requires a real signal).
    if (opts.scraper) {
      try {
        const hit = await opts.scraper(c)
        if (hit) {
          if (hit.detectedAt) c.last_life_event_detected = hit.detectedAt
          if (hit.types?.length) {
            const existing = Array.isArray(c.life_events) ? c.life_events : []
            c.life_events = [...existing, ...hit.types.map((t) => ({ type: t }))]
          }
        }
      } catch { /* scraper best-effort; never fail the pass */ }
    }

    const ev = detectLifeEvent(c, now)
    if (!ev) continue
    result.detected += 1

    // IDEMPOTENCY — one radar touch per (contact, event-type) per 90 days. The touchpoint's
    // rationale carries the tag we check against.
    const tag = `SPHERE RADAR [${ev.type}]`
    const since = new Date(now.getTime() - RADAR_DEDUPE_DAYS * 86_400_000).toISOString()
    const { data: dup } = await supabase.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("recipient_contact_id", c.id)
      .ilike("rationale", `${tag}%`).gte("proposed_at", since).limit(1).maybeSingle()
    if (dup) { result.skippedDuplicate += 1; continue }

    const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ").trim()
    const audience: "buyer" | "seller" = (c.contact_type ?? "").toLowerCase() === "seller" ? "seller" : "buyer"

    // ── (b) TOUCHPOINT — persona-aware copy, PROPOSED into the gate (never auto-sent). ──
    const fallback = composeReferralTouch(c.first_name ?? "there", ev)
    const draft = await generatePersonaCopy(
      {
        goal: "a warm, no-pressure past-client check-in that opens the door to repeat business or a referral",
        facts: [ev.clientHook, "I stay in touch with the people I've worked with", "I'm glad to help them or anyone they refer"],
        channel: "portal",
        persona: {
          name: fullName || null,
          audience: "past_client",
          situation: c.buyer_stage ?? ev.label,
        },
        words: 70,
      },
      fallback,
      { generator: opts.copyGenerator },
    )

    const proposed = await proposeClientMessage({
      brokerageId, agentKind: "sphere_of_influence", entityType: "contact",
      entityId: c.id, recipientContactId: c.id, audience,
      subject: draft.subject ?? fallback.subject,
      body: draft.body,
      rationale: `${tag} — Sphere Manager: ${ev.label} detected on a past client; the perfectly-timed referral/repeat moment, drafted for approval. ${ev.angle}`,
      channel: "portal",
    }, supabase)
    if (proposed.ok) result.touchpoints += 1

    // ── PORTAL VALUE CARD — leave the SAME warm, real touchpoint on the past client's portal
    // so it always has something fresh worth returning to. ADDITIVE: the gated touchpoint above
    // is unchanged; this surfaces only the REAL detected-event copy (no fabricated dates/numbers —
    // detectLifeEvent already guarantees a real signal). Reuses the persona-generated client-facing
    // body (Fair-Housing-safe by construction). Idempotent per (contact, "referral_radar", day). ──
    const card = await pushPortalValueCard({
      brokerageId, contactId: c.id, listingId: null,
      title: draft.subject ?? fallback.subject,
      summary: draft.body,
      updateType: "referral_radar",
      metadata: { audience, event_type: ev.type, event_label: ev.label, source: "referral_radar" },
      now,
    }, supabase)
    if (card.pushed) result.portalCardsPushed += 1

    // ── (a) NUDGE — internal notification to the RESPONSIBLE agent: who + why. ──
    const agentUserId = await resolveResponsibleAgentUserId(supabase, {
      recipient_contact_id: c.id, entity_type: "contact", entity_id: c.id,
    })
    if (agentUserId) {
      // Idempotent on the nudge side too — don't re-nudge for the same contact+event in 90d.
      const { data: nDup } = await supabase.from("notifications").select("id")
        .eq("user_id", agentUserId).eq("contact_id", c.id).eq("type", "referral_radar")
        .ilike("title", `%${ev.label}%`)
        .gte("created_at", since).limit(1).maybeSingle()
      if (!nDup) {
        const nudge = composeReferralNudge(fullName, ev)
        const { error } = await supabase.from("notifications").insert({
          user_id: agentUserId, brokerage_id: brokerageId, contact_id: c.id,
          type: "referral_radar", title: nudge.title, body: nudge.body,
          entity_type: "contact", entity_id: c.id,
          priority: "medium", is_read: false,
        })
        if (!error) result.nudges += 1
      }
    }
  }

  return result
}
