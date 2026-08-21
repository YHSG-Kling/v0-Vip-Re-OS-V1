// lib/agents/education-delivery-producer.ts
//
// EDUCATION DELIVERY AS A GOVERNED DELIVERABLE — push the RIGHT explainer to the
// client at the RIGHT moment, human-approved. The portal already lets a client BROWSE
// stage-gated lessons; this is the proactive half: when a client reaches a lifecycle
// stage, the side-appropriate concierge (Shopping Agent for buyers, Listing Concierge
// for sellers) PROPOSES the best-matched lesson into the client-message gate AND records
// a learning_assignment, so the broker approves and it reaches the client as a timely,
// branded touch instead of a lesson they may never open.
//
// Reuses the existing module matcher (pickLearningModulesForActor) — no duplicate
// scoring logic. Idempotent: a given (contact, module) is proposed once. Pure side
// resolution + copy are unit-tested; the producer is live-probed.
//
// ── AGE-BAND CHANNEL SELECTION (owner ruling, wave 15) ──────────────────────────
// Verbatim: "we determine the kind of education in channels by the age group and
// other ways to use it without violating the rules." That is the reason the ruling
// took fair housing off the data lane at all, and until this wave the capability it
// was unlocked FOR did not exist. This file picked the lesson by LIFECYCLE STAGE
// only and then hard-coded `channel: "portal"` — every client, every age, one rail.
//
// WHAT WAS ALREADY THERE, AND IS THEREFORE REUSED RATHER THAN REBUILT:
//   · the band vocabulary — `AgeSegment` + `ageSegmentFrom*` at
//     lib/kernel/education.ts:13-65. Bands, never raw ages: a BAND is a segment,
//     a BIRTHDATE is a dossier (same discipline as timeline buckets, CLAUDE.md §5).
//   · the band→format matrix — `DELIVERY_MATRIX` / `getEducationDelivery` at
//     lib/kernel/education.ts. This file does NOT open a second age→format table.
//   · the module scorer — `pickLearningModulesForActor`, which ALREADY scores
//     `learning_modules.audience_age_segs` (+30) and `audience_generations` (+40).
//     There is no second scoring path here (CLAUDE.md §6).
//
// WHAT WAS MISSING, AND IS BUILT HERE:
//   · THE CHANNEL — meaning the RAIL, not the format. Read the distinction
//     carefully, because scripts/milestone-education-tie-simulator.ts already
//     prints "channel by age" and asserts something else: it proves the age band
//     picks the FORMAT (video / guide / checklist) through DELIVERY_MATRIX. The
//     RAIL a lesson travels on was hard-coded `"portal"` for every band, and
//     `LearningModulePick.channels` was carried all the way out of the matcher
//     and then dropped on the floor. `pickEducationChannel` below is the reader
//     for it, banded by age and narrowed by consent + stated preference.
//   · THE BAND ACTUALLY RESOLVING. `resolveEducationContext` read only
//     `contacts.birthday`, which is human-entered and null on most rows, so the
//     band silently defaulted to "30-50" for nearly everyone. It now also reads
//     `contacts.age_range` — the column the ENRICHMENT lane writes — and publishes
//     `ageSegSource` so a default is distinguishable from a measurement.
//
// READER AND WRITER, BOTH PRESENT (CLAUDE.md §1). `contacts.age_range` is written
// by lib/lead-pipeline/enrichment-column-map.ts and app/actions/contact-enrichment.ts
// and is read here; `learning_modules.channels` is written by
// app/actions/learning-modules.ts:132 and read here. No new column is needed and no
// migration is shipped with this lane.
//
// FAIR HOUSING IS NOT ON THIS PATH BY DESIGN. Choosing which lesson and which rail
// an EXISTING client gets is not housing advertising; the refusal for that lives at
// lib/lead-governance/protected-class-signals.ts:521 and is enforced at
// lib/audiences/audience-sync.ts. The COPY produced below still goes through
// `sanitizeProperNoun` and the client-message gate, because copy is content.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"
import {
  getEducationDelivery,
  ageFromBirthday,
  ageSegmentFromAge,
  ageSegmentFromAgeRange,
  type AgeSegment,
} from "@/lib/kernel/education"
import {
  canDispatchToContact,
  honorsChannelPreference,
  type ContactConsentState,
} from "@/lib/compliance/contact-channel-gate"

type Svc = ReturnType<typeof createServiceClient>

/** The rails a lesson nudge can ride. Subset of `proposeClientMessage`'s
 *  `channel` union (lib/agents/agent-client-messages.ts:27) — direct_mail and
 *  voice_drop are excluded because a lesson is a link, and a link does not
 *  survive either. */
export type EducationChannel = "portal" | "portal_push" | "email" | "sms"

/**
 * THE BAND → CHANNEL PREFERENCE ORDER. One table, keyed by the one band
 * vocabulary, ordered most- to least-preferred. The first entry the contact's
 * consent, stated preference and the module's own publication channels all
 * allow is the one used; `portal` is the terminal fallback because it is the
 * client's own surface and needs no marketing consent.
 *
 * The ordering follows the SAME reasoning as `DELIVERY_MATRIX` in
 * lib/kernel/education.ts rather than inventing a second opinion about age:
 *   · 18-30  — primaryFormat video, autoPlay, 5-minute ceiling. A push to the
 *              phone, then a text. This band does not open email.
 *   · 30-50  — primaryFormat guide, 10-minute ceiling, quiz-gated. Email is the
 *              rail that carries a guide; push second.
 *   · 50-65  — primaryFormat guide, DETAILED reading level, 15-minute ceiling.
 *              Email first and no SMS: the longest material on the calmest rail.
 *   · 65+    — primaryFormat checklist, simplified, progress indicators OFF.
 *              The portal, where the lesson sits beside everything else the
 *              client has, with email as the only nudge.
 *
 * NOT A PROTECTED-CLASS DECISION IN THE STATUTORY SENSE, and this is the
 * distinction the owner drew: nobody is shown or denied HOUSING here. The same
 * lesson catalogue is available to every band in the portal; the band chooses
 * the ENVELOPE.
 */
const CHANNEL_ORDER_BY_BAND: Record<AgeSegment, readonly EducationChannel[]> = {
  "18-30": ["portal_push", "sms", "portal"],
  "30-50": ["email", "portal_push", "portal"],
  "50-65": ["email", "portal"],
  "65+":   ["portal", "email"],
}

/** The band's ordering, or the unbanded default. A contact with NO measured band
 *  gets the portal — the surface that needs no consent and makes no assumption —
 *  rather than being routed as if they were 30-50. */
const CHANNEL_ORDER_UNBANDED: readonly EducationChannel[] = ["portal"]

/** `learning_modules.channels` (article|blog|video|podcast|newsletter|email|
 *  social|quiz|portal_lesson) is a PUBLICATION vocabulary; `EducationChannel` is
 *  a DELIVERY vocabulary. They are two different ideas with one word, so the
 *  crossing is written down once here instead of being guessed at each call
 *  site (CLAUDE.md §6). A module published to NO channel constrains nothing. */
function moduleAllowsChannel(moduleChannels: readonly string[], channel: EducationChannel): boolean {
  if (moduleChannels.length === 0) return true
  if (channel === "portal" || channel === "portal_push") {
    return moduleChannels.includes("portal_lesson") || moduleChannels.includes("article")
      || moduleChannels.includes("video") || moduleChannels.includes("quiz")
  }
  if (channel === "email") return moduleChannels.includes("email") || moduleChannels.includes("newsletter")
    || moduleChannels.includes("article") || moduleChannels.includes("portal_lesson")
  // sms carries a link to whatever the module is; any published form works.
  return true
}

export interface EducationChannelChoice {
  channel: EducationChannel
  /** The band that chose it, or null when no band was measured. */
  ageSegment: AgeSegment | null
  /** Every rail considered and why it lost — so "we sent to portal" is never
   *  indistinguishable from "nothing else was tried" (CLAUDE.md §2). */
  rejected: string[]
  /** The band's own format preference, carried for the rationale line. */
  preferredFormat: string | null
}

/**
 * PURE. Choose the delivery rail for one lesson to one client.
 *
 * FAILS TOWARDS THE PORTAL, never towards a regulated rail: if consent,
 * preference or publication constrain everything away, the answer is `portal`.
 * Portal is the client's own surface, so a wrong answer there is a lesson that
 * sits unread, not a text somebody did not consent to.
 */
export function pickEducationChannel(input: {
  ageSegment: AgeSegment | null
  moduleChannels: readonly string[]
  consent: ContactConsentState
  preferredChannel: string | null
}): EducationChannelChoice {
  const order = input.ageSegment ? CHANNEL_ORDER_BY_BAND[input.ageSegment] : CHANNEL_ORDER_UNBANDED
  const rejected: string[] = []
  const preferredFormat = input.ageSegment
    ? getEducationDelivery({ ageSegment: input.ageSegment }).primaryFormat
    : null

  for (const channel of order) {
    if (!moduleAllowsChannel(input.moduleChannels, channel)) {
      rejected.push(`${channel}:module_not_published_there`); continue
    }
    const gate = canDispatchToContact(input.consent, channel)
    if (!gate.allowed) { rejected.push(`${channel}:${gate.reason ?? "no_consent"}`); continue }
    const pref = honorsChannelPreference(input.preferredChannel, channel)
    if (!pref.allowed) { rejected.push(`${channel}:${pref.reason ?? "against_preference"}`); continue }
    return { channel, ageSegment: input.ageSegment, rejected, preferredFormat }
  }
  rejected.push("fell_through_to_portal")
  return { channel: "portal", ageSegment: input.ageSegment, rejected, preferredFormat }
}

/**
 * The DEMOGRAPHIC READ, in one place. Returns the client's age BAND and nothing
 * finer — no birthday, no raw age leaves this function.
 *
 * Two sources, in order of trust: `contacts.birthday` (human-entered, precise,
 * usually null) then `contacts.age_range` (the enrichment lane's own banding).
 * `source` is returned because a band nobody measured must not read as a band
 * somebody measured.
 */
export async function resolveClientAgeBand(
  supabase: Svc, contactId: string,
): Promise<{ ageSegment: AgeSegment | null; source: "birthday" | "age_range" | "unmeasured" }> {
  const { data, error } = await supabase
    .from("contacts")
    .select("birthday, age_range")
    .eq("id", contactId)
    .maybeSingle()
  // supabase-js RESOLVES refusals (CLAUDE.md §3) — an unread error here would
  // present as "this client has no age", which is a different fact.
  if (error) return { ageSegment: null, source: "unmeasured" }
  const row = data as { birthday?: string | null; age_range?: string | null } | null
  const fromBirthday = ageSegmentFromAge(ageFromBirthday(row?.birthday ?? null))
  if (fromBirthday) return { ageSegment: fromBirthday, source: "birthday" }
  const fromRange = ageSegmentFromAgeRange(row?.age_range ?? null)
  if (fromRange) return { ageSegment: fromRange, source: "age_range" }
  return { ageSegment: null, source: "unmeasured" }
}

/** Which concierge owns the delivery, by the client's side of the deal. */
export function conciergeForSide(side: "buyer" | "seller" | null): "shopping_agent" | "listing_concierge" {
  return side === "seller" ? "listing_concierge" : "shopping_agent"
}

/** Pure: the client-safe education nudge copy. */
export function buildEducationDelivery(
  moduleTitle: string, moduleSummary: string | null, estimatedMinutes: number | null, agentName: string,
): { subject: string; body: string } {
  const title = sanitizeProperNoun(moduleTitle, 100) ?? "a quick lesson"
  const who = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  const mins = estimatedMinutes && estimatedMinutes > 0 ? ` (about ${estimatedMinutes} min)` : ""
  const why = moduleSummary ? ` ${moduleSummary}` : ""
  return {
    subject: `For where you are now: ${title}`,
    body: [
      `Hi,`,
      `You're at the point where this helps most — I put together "${title}"${mins} for you.${why}`,
      `It's in your portal whenever you're ready. Happy to talk through any of it.`,
      `— ${who}`,
    ].join("\n\n"),
  }
}

/** Resolve the client's deal side + agent name (best-effort). */
async function resolveClientContext(supabase: Svc, brokerageId: string, contactId: string): Promise<{ side: "buyer" | "seller" | null; agentName: string }> {
  let side: "buyer" | "seller" | null = null
  const { data: txn } = await supabase
    .from("transactions")
    .select("deal_type")
    .eq("brokerage_id", brokerageId)
    .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(lost,closed)")
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle()
  const dt = (txn as { deal_type?: string | null } | null)?.deal_type ?? null
  if (dt === "seller") side = "seller"
  else if (dt === "buyer") side = "buyer"

  let agentName = "Your Agent"
  const { data: c } = await supabase.from("contacts").select("agent_id, contact_type").eq("id", contactId).maybeSingle()
  const cc = c as { agent_id?: string | null; contact_type?: string | null } | null
  if (!side && cc?.contact_type) side = cc.contact_type === "seller" ? "seller" : cc.contact_type === "buyer" ? "buyer" : null
  if (cc?.agent_id) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", cc.agent_id).maybeSingle()
    const uid = (a as { user_id?: string | null } | null)?.user_id ?? null
    if (uid) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }
  return { side, agentName }
}

/**
 * Propose the best-matched lesson for a client into the gate + record the assignment.
 * Idempotent: skips a module already assigned to (or proposed for) this contact.
 */
export async function produceEducationDelivery(
  brokerageId: string, contactId: string, client?: Svc,
): Promise<{ proposed: boolean; moduleId?: string; reason?: string; channel?: EducationChannel }> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !contactId) return { proposed: false, reason: "missing ids" }

  const { pickLearningModulesForActor } = await import("@/lib/learning-router/composer")
  const picks = await pickLearningModulesForActor({ supabase, actorKind: "customer", actorId: contactId, limit: 3 })
  if (picks.length === 0) return { proposed: false, reason: "no matching module" }

  // Take the highest-scored module the contact hasn't already been assigned.
  let chosen: typeof picks[number] | null = null
  for (const p of picks) {
    const { data: existingAssign } = await supabase
      .from("learning_assignments")
      .select("id").eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("module_id", p.id)
      .limit(1).maybeSingle()
    if (existingAssign) continue
    const { data: existingMsg } = await supabase
      .from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "learning_module").eq("entity_id", p.id)
      .eq("recipient_contact_id", contactId).limit(1).maybeSingle()
    if (existingMsg) continue
    chosen = p
    break
  }
  if (!chosen) return { proposed: false, reason: "all top modules already delivered" }

  return deliverChosenModule(supabase, brokerageId, contactId, chosen)
}

/** Extracted so both the poll path and the event path share one delivery body. */
async function deliverChosenModule(
  supabase: Svc, brokerageId: string, contactId: string,
  chosen: { id: string; title: string; summary: string | null; estimatedMinutes: number | null; signalSource: string; signalMetadata: unknown; priorityScore: number | null; channels?: readonly string[] },
): Promise<{ proposed: boolean; moduleId?: string; reason?: string; channel?: EducationChannel }> {
  const { side, agentName } = await resolveClientContext(supabase, brokerageId, contactId)
  const manager = conciergeForSide(side)

  // ── THE OWNER'S ACTUAL USE CASE: the RAIL is chosen by AGE BAND ──────────────
  // "we determine the kind of education in channels by the age group". The band
  // comes from the enrichment lane's own data, which the wave-15 ruling made
  // readable; the rail comes from the band, narrowed by the module's publication
  // channels and by consent + stated preference.
  const band = await resolveClientAgeBand(supabase, contactId)
  const { data: consentRow } = await supabase
    .from("contacts")
    .select("tcpa_consent, dnc_status, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, phone_opt_out, opt_out_channels, preferred_channel")
    .eq("id", contactId)
    .maybeSingle()
  const cr = (consentRow ?? {}) as ContactConsentState & { preferred_channel?: string | null }
  const choice = pickEducationChannel({
    ageSegment: band.ageSegment,
    moduleChannels: chosen.channels ?? [],
    consent: cr,
    preferredChannel: cr.preferred_channel ?? null,
  })

  // Record the assignment (status='open') so the portal feed + completion tracking pick it up.
  // The band, its SOURCE and the chosen rail ride in signal_metadata so a routing
  // decision is a reported fact — "delivered on portal" must never be
  // indistinguishable from "nothing else was considered" (CLAUDE.md §2).
  await supabase.from("learning_assignments").insert({
    brokerage_id: brokerageId, module_id: chosen.id, contact_id: contactId,
    signal_source: chosen.signalSource,
    signal_metadata: {
      ...(chosen.signalMetadata && typeof chosen.signalMetadata === "object" ? chosen.signalMetadata as Record<string, unknown> : { matched: chosen.signalMetadata }),
      age_band: band.ageSegment,
      age_band_source: band.source,
      delivery_channel: choice.channel,
      delivery_channels_rejected: choice.rejected,
      band_preferred_format: choice.preferredFormat,
    },
    priority_score: chosen.priorityScore, status: "open",
  })

  // Propose the nudge into the gate (the side-appropriate concierge).
  const msg = buildEducationDelivery(chosen.title, chosen.summary, chosen.estimatedMinutes, agentName)
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const bandNote = band.ageSegment
    ? `${choice.channel} chosen for age band ${band.ageSegment} (from ${band.source})`
    : `${choice.channel} — no age band measured, so the client's own portal`
  const res = await proposeClientMessage({
    brokerageId, agentKind: manager, entityType: "learning_module", entityId: chosen.id,
    recipientContactId: contactId, audience: side === "seller" ? "seller" : "buyer",
    subject: msg.subject, body: msg.body,
    rationale: `Stage-matched lesson "${sanitizeProperNoun(chosen.title, 80) ?? "lesson"}" (${chosen.signalSource}) — ${bandNote} — review/edit before it reaches the client.`,
    channel: choice.channel,
  }, supabase)
  return res.ok
    ? { proposed: true, moduleId: chosen.id, channel: choice.channel }
    : { proposed: false, reason: res.error }
}

/**
 * EVENT-FIRED just-in-time education — the spec's core thesis (education delivered at the moment of need,
 * not on a weekly poll). Resolves the client contact(s) touched by a kernel event and delivers the
 * stage-matched lesson IMMEDIATELY. Reuses produceEducationDelivery (idempotent per contact+module), so
 * the weekly education-delivery cron stays as a pure safety net that never double-delivers. Best-effort:
 * never throws into the reactor. Returns how many contacts got a fresh proposal.
 */
export async function produceEducationForEvent(
  input: { brokerageId: string; entityType: string; entityId: string },
  client?: Svc,
): Promise<{ delivered: number; contacts: string[] }> {
  const supabase = client ?? createServiceClient()
  const out = { delivered: 0, contacts: [] as string[] }
  if (!input.brokerageId || !input.entityId) return out

  // Resolve the client contact(s) the event touches.
  const contactIds = new Set<string>()
  try {
    if (input.entityType === "contact") {
      contactIds.add(input.entityId)
    } else if (input.entityType === "transaction") {
      const { data: t } = await supabase.from("transactions")
        .select("contact_id, buyer_contact_id, seller_contact_id").eq("id", input.entityId).maybeSingle()
      for (const k of ["contact_id", "buyer_contact_id", "seller_contact_id"] as const) {
        const v = (t as Record<string, string | null> | null)?.[k]
        if (v) contactIds.add(v)
      }
    } else if (input.entityType === "listing") {
      const { data: l } = await supabase.from("listings").select("seller_contact_id").eq("id", input.entityId).maybeSingle()
      const v = (l as { seller_contact_id?: string | null } | null)?.seller_contact_id
      if (v) contactIds.add(v)
    }
  } catch { /* best-effort */ }

  for (const cid of contactIds) {
    try {
      const r = await produceEducationDelivery(input.brokerageId, cid, supabase)
      if (r.proposed) { out.delivered += 1; out.contacts.push(cid) }
    } catch { /* keep going */ }
  }
  return out
}
