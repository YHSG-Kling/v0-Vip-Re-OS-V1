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
// ── WAVE 16: THE SIGNAL THE RULING WAS ACTUALLY ABOUT ───────────────────────────
// Wave 15 built the rail and gave it two inputs that are EMPTY IN THE DATABASE:
// live on 2026-08-22, zero contacts carry a `birthday` and zero carry an
// `age_range`. So every client fell to the unbanded default and the "channel by
// age group" capability had no age to route on — a wire with no current in it.
//
// The input the owner meant was already being sourced and read by nothing:
// lib/external/batchdata-seller-signals.ts writes
// `motivated_seller_signals.signal_details.observed.owner_age_band` (and
// `probate_deed_instrument`, `household_size`) plus the classifier's reason
// sentences in `protected_class_basis`, and its own header at line 734 names the
// missing consumer as this file. `lib/education/seller-signal-education-context.ts`
// is that consumer: it collapses the provider's band onto the ONE age vocabulary
// through the SAME `ageSegmentFromAgeRange` the enrichment vocabulary goes
// through (no second banding function), and maps the four protected-class-derived
// signal kinds onto four EXISTING `Persona` values the module scorer already
// matches. `resolveEducationContext` reads it; the band, the persona hints and the
// basis sentences ride out on the pick; this file turns the band into a RAIL and
// writes the basis onto the assignment.
//
// READER AND WRITER, BOTH PRESENT (CLAUDE.md §1). `contacts.age_range` is written
// by lib/lead-pipeline/enrichment-column-map.ts and app/actions/contact-enrichment.ts;
// `motivated_seller_signals.signal_details` is written by
// lib/external/batchdata-seller-signals.ts:1438; `learning_modules.channels` is
// written by app/actions/learning-modules.ts:132. All three are read on this path.
// No new column is needed and no migration is shipped with this lane.
//
// ── WAVE 145 (lane 145H): THE RAIL AND THE FORMAT FOLLOW THE PERSON, NEVER THEIR AGE ──
// Owner ruling 18 (2026-10-27): accessibility needs are "explicit, user-controllable fields … never inferred from
// age/demographics", and the lane brief names the band paths to remove. SUPERSEDES the wave-15 "channel by age group"
// reading for DELIVERY: `CHANNEL_ORDER_BY_BAND` is tombstoned below, the band→format adaptation in
// lib/education/delivery-format.ts is gone, and DELIVERY_MATRIX in lib/kernel/education.ts is tombstoned. The rail is
// the person's STATED channel, else the one default (the portal — what every LIVE client already got, since no live
// contact carries a measured band). The format is what the person STATED (their channel-preference word or their
// accessibility preference, read through lib/contacts/accessibility-preferences.ts readAccessibilityPreferences —
// contract C3), else the material's own. Captions / transcript requests ride on the assignment and are told to the
// human approver. The band is still RECORDED (the module scorer chose the lesson's TOPIC with it — wave 16's honesty
// record stands); it no longer chooses the envelope.
//
// FAIR HOUSING IS NOT ON THIS PATH BY DESIGN. Choosing which lesson and which rail
// an EXISTING client gets is not housing advertising; the refusal for that lives at
// lib/lead-governance/protected-class-signals.ts:521 and is enforced at
// lib/audiences/audience-sync.ts. The COPY produced below still goes through
// `sanitizeProperNoun` and the client-message gate, because copy is content.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"
import { getEducationDelivery, type AgeSegment } from "@/lib/kernel/education"
import type { EducationFormat } from "@/lib/kernel/types"
import { isVideoFormat, resolveContactDeliveryFormat } from "@/lib/education/delivery-format"
import {
  accessibilityAdaptations, readAccessibilityPreferences, type AccessibilityPreferences,
} from "@/lib/contacts/accessibility-preferences"
import type { ProtectedClassBasis } from "@/lib/lead-governance/protected-class-signals"
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

// TOMBSTONE (wave 145, lane 145H — owner ruling 18; the lane brief names it). `CHANNEL_ORDER_BY_BAND:
// Record<AgeSegment, readonly EducationChannel[]>` was DELETED here: 18-30 → push then SMS ("this band does not open
// email"), 30-50 / 50-65 → email first, 65+ → the portal. It chose a person's rail from their birth year. SURVIVOR:
// DEFAULT_EDUCATION_CHANNEL_ORDER below (the portal — byte-identical to the unbanded order every LIVE client already
// got, since no live contact carries a measured band) with the person's STATED rail first (statedEducationChannel).

/** THE default rail order when the person stated none: the portal — the client's own surface, which needs no
 *  marketing consent and assumes nothing about them. */
const DEFAULT_EDUCATION_CHANNEL_ORDER: readonly EducationChannel[] = ["portal"]

/** PURE (wave 144). The education RAIL a stated preference names (contacts.preferred_channel / the channel_preference memory
 *  fact), or null. Phone / voice / mail name no lesson rail (a lesson is a link) — they leave the default order alone. */
function statedEducationChannel(pref: string | null | undefined): EducationChannel | null {
  const p = String(pref ?? "").trim().toLowerCase()
  if (p === "email") return "email"
  if (p === "sms" || p === "text" || p === "texts") return "sms"
  if (p === "portal" || p === "in_app" || p === "app") return "portal"
  if (p === "portal_push" || p === "push") return "portal_push"
  return null
}

/** PURE (wave 144). The education FORMAT a stated preference names, or null. */
function statedEducationFormat(pref: string | null | undefined): EducationFormat | null {
  const p = String(pref ?? "").trim().toLowerCase()
  if (p === "video") return "video"
  if (p === "guide" || p === "article" || p === "reading") return "guide"
  if (p === "checklist") return "checklist"
  return null
}

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
  /** The band the module scorer used for the lesson's TOPIC, echoed for the record — it chose neither the rail nor
   *  the format (wave 145). null when no band was measured. */
  ageSegment: AgeSegment | null
  /** Every rail considered and why it lost — so "we sent to portal" is never
   *  indistinguishable from "nothing else was tried" (CLAUDE.md §2). */
  rejected: string[]
  /** The format this contact is DELIVERED when the PERSON stated one (their channel-preference word, else their
   *  accessibility preference) — lib/education/delivery-format.ts:resolveContactDeliveryFormat; null = nothing
   *  stated, so the material keeps its own format. Carried for the rationale line. */
  preferredFormat: string | null
  /** Where the rail came from: the person's stated channel, or the one default. Never an age band. */
  railSource: "stated" | "default"
  /** Whether the module is a video-format material (channels carry "video") — the explainer-render
   *  pipeline's own predicate (isVideoFormat), so the rationale can say "video kept" vs "adapted". */
  materialIsVideo: boolean
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
  /** RECORDED ONLY (echoed on the choice): the band the scorer used for the lesson's topic. It orders no rail. */
  ageSegment?: AgeSegment | null
  moduleChannels: readonly string[]
  consent: ContactConsentState
  preferredChannel: string | null
  /** What the person STATED (lib/contacts/accessibility-preferences.ts) — null / absent = nothing stated. */
  accessibility?: AccessibilityPreferences | null
}): EducationChannelChoice {
  // WAVE 144 (lane 144F) made the person's PREFERENCE lead; WAVE 145 (lane 145H, owner ruling 18) removes the band from
  // the decision entirely: the stated rail first, then the ONE default (the portal). Consent, the module's publication
  // and the preference gate still decide whether a rail is usable.
  const stated = statedEducationChannel(input.preferredChannel)
  const order: readonly EducationChannel[] = stated
    ? [stated, ...DEFAULT_EDUCATION_CHANNEL_ORDER.filter((c) => c !== stated)]
    : DEFAULT_EDUCATION_CHANNEL_ORDER
  const rejected: string[] = []
  const materialFormat: EducationFormat = (input.moduleChannels ?? []).includes("video") ? "video" : "guide"
  const materialIsVideo = isVideoFormat(materialFormat)
  // THE FORMAT THE PERSON STATED, in order: their channel-preference word ("I'd rather watch a video", a checklist …),
  // else their accessibility preference (the ONE mapping — lib/kernel/education.ts getEducationDelivery). Nothing
  // stated → null: the material keeps its own format. lib/education/delivery-format.ts:resolveContactDeliveryFormat is
  // the rule; no age is read.
  const accessibleDelivery = accessibilityAdaptations(input.accessibility).stated
    ? getEducationDelivery({ accessibility: input.accessibility })
    : null
  const statedFormat = statedEducationFormat(input.preferredChannel) ?? accessibleDelivery?.primaryFormat ?? null
  const preferredFormat = statedFormat ? resolveContactDeliveryFormat(statedFormat, materialFormat) : null
  const railSource: EducationChannelChoice["railSource"] = stated ? "stated" : "default"
  const ageSegment = input.ageSegment ?? null

  for (const channel of order) {
    if (!moduleAllowsChannel(input.moduleChannels, channel)) {
      rejected.push(`${channel}:module_not_published_there`); continue
    }
    const gate = canDispatchToContact(input.consent, channel)
    if (!gate.allowed) { rejected.push(`${channel}:${gate.reason ?? "no_consent"}`); continue }
    const pref = honorsChannelPreference(input.preferredChannel, channel)
    if (!pref.allowed) { rejected.push(`${channel}:${pref.reason ?? "against_preference"}`); continue }
    return { channel, ageSegment, rejected, preferredFormat, railSource, materialIsVideo }
  }
  rejected.push("fell_through_to_portal")
  return { channel: "portal", ageSegment, rejected, preferredFormat, railSource, materialIsVideo }
}

// TOMBSTONE (wave 16 — the seller-signal education wire). `resolveClientAgeBand`
// was DELETED here. It read `contacts.birthday` + `contacts.age_range` and banded
// them — a SECOND banding of the one idea, run against the same contact the
// matcher had just banded moments earlier, in a second round trip (CLAUDE.md §6).
//
// SURVIVOR: lib/portal/resolve-education-context.ts:resolveEducationContext,
// which the matcher already calls, and which now resolves the band from THREE
// sources (birthday → age_range → the seller-signal lane) instead of two. The
// band and its source ride out on the typed `LearningModulePick.ageSegment` /
// `.ageSegSource` fields declared at lib/learning-router/composer.ts:38, and
// `deliverChosenModule` below reads them off the pick.
//
// The merge was NOT a like-for-like move: the survivor gained the third source,
// so this deletion also fixed the reason the duplicate could never route by age
// — live on 2026-08-22, zero contacts carry a birthday and zero carry an
// age_range, so both of the deleted function's sources were empty for every row
// in the database.

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

/** PURE (wave 103, lane 103A): the client's side(s) from the open transactions they are a party to.
 *  A `dual` deal_type names the BROKERAGE's representation, not the client's side — the side comes
 *  from WHICH party column holds the contact. A client who is the seller on one deal and the buyer
 *  on another is a DUAL CLIENT: `side` leads with seller (the kernel's portal rule — a must-sell-to-
 *  buy move starts with the home they own, lib/kernel/portal.ts) and `dualClient` is published so
 *  the delivery record says both sides were in play.
 *  @proofSeam the side rule is asserted on fixtures by scripts/competency-guard.ts; its only product
 *  caller is resolveClientContext in this file. */
export function resolveClientSides(
  contactId: string,
  txns: Array<{ deal_type: string | null; contact_id: string | null; buyer_contact_id: string | null; seller_contact_id: string | null }>,
): { side: "buyer" | "seller" | null; dualClient: boolean } {
  let seller = false, buyer = false
  for (const t of txns) {
    if (t.seller_contact_id === contactId) seller = true
    if (t.buyer_contact_id === contactId) buyer = true
    if (t.contact_id === contactId && t.buyer_contact_id !== contactId && t.seller_contact_id !== contactId) {
      if (t.deal_type === "seller") seller = true
      else if (t.deal_type === "buyer") buyer = true
    }
  }
  return { side: seller ? "seller" : buyer ? "buyer" : null, dualClient: seller && buyer }
}

/** Resolve the client's deal side + agent name (best-effort). */
async function resolveClientContext(supabase: Svc, brokerageId: string, contactId: string): Promise<{ side: "buyer" | "seller" | null; dualClient: boolean; agentName: string }> {
  const { data: txns } = await supabase
    .from("transactions")
    .select("deal_type, contact_id, buyer_contact_id, seller_contact_id")
    .eq("brokerage_id", brokerageId)
    .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(lost,closed)")
    .order("created_at", { ascending: false })
    .limit(5)
  let { side, dualClient } = resolveClientSides(contactId, (txns ?? []) as any[])

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
  return { side, dualClient, agentName }
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
  chosen: {
    id: string; title: string; summary: string | null; estimatedMinutes: number | null
    signalSource: string; signalMetadata: unknown; priorityScore: number | null
    channels?: readonly string[]
    ageSegment?: AgeSegment | null
    ageSegSource?: "birthday" | "age_range" | "seller_signal" | "default"
    protectedClassBasis?: readonly ProtectedClassBasis[]
  },
): Promise<{ proposed: boolean; moduleId?: string; reason?: string; channel?: EducationChannel }> {
  const { side, dualClient, agentName } = await resolveClientContext(supabase, brokerageId, contactId)
  const manager = conciergeForSide(side)

  // ── THE BAND IS RECORDED, NOT ROUTED ON (wave 145, owner ruling 18) ─────────
  // The band is the one the MATCHER already resolved and scored `audience_age_segs`
  // against (the lesson's TOPIC) — read off the pick and written onto the
  // assignment so the topic choice stays auditable (wave 16's honesty record).
  // Until wave 145 it also chose the RAIL ("we determine the kind of education in
  // channels by the age group"); ruling 18 ends that: the rail and the format follow
  // what the person STATED, else the one default (pickEducationChannel above).
  //
  // FAIL SOFT, deliberately: `ageSegment: null` is the answer whenever nothing was
  // measured; the client still gets the lesson on the default rail.
  const band = {
    ageSegment: chosen.ageSegment ?? null,
    source: chosen.ageSegSource ?? "default",
  }
  const basis = chosen.protectedClassBasis ?? []
  const { data: consentRow } = await supabase
    .from("contacts")
    .select("tcpa_consent, dnc_status, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, phone_opt_out, opt_out_channels, preferred_channel")
    .eq("id", contactId)
    .maybeSingle()
  const cr = (consentRow ?? {}) as ContactConsentState & { preferred_channel?: string | null }
  // WHAT THE PERSON STATED they need (wave 145, owner ruling 18) — through THE reader (contract C3), tenant-pinned. A
  // refused read is recorded as such and the lesson still goes out on the default; it is never "nothing stated".
  const accessRead = await readAccessibilityPreferences(supabase, brokerageId, contactId)
  const accessibility = accessRead.ok ? accessRead.preferences : null
  const adapt = accessibilityAdaptations(accessibility)
  const accessibilitySource = !accessRead.ok ? "unavailable" : adapt.stated ? "stated" : "default"
  const choice = pickEducationChannel({
    ageSegment: band.ageSegment,
    moduleChannels: chosen.channels ?? [],
    consent: cr,
    preferredChannel: cr.preferred_channel ?? null,
    accessibility,
  })

  // Record the assignment (status='open') so the portal feed + completion tracking pick it up.
  // The band, its SOURCE and the chosen rail ride in signal_metadata so a routing
  // decision is a reported fact — "delivered on portal" must never be
  // indistinguishable from "nothing else was considered" (CLAUDE.md §2).
  //
  // `protected_class_basis` RIDES ALONG, verbatim, whenever a protected-class-
  // derived signal took part. This is what makes the owner's position auditable
  // rather than merely asserted: the ruling is that this data picks the right
  // EDUCATION and never the housing, and the stored row is where that claim is
  // either supported or exposed. An empty array means the classifier ran and
  // nothing protected-class-derived was involved — never that nobody checked.
  // The mirror of the row the sourcing lane writes at
  // lib/external/batchdata-seller-signals.ts:1438.
  const { error: assignError } = await supabase.from("learning_assignments").insert({
    brokerage_id: brokerageId, module_id: chosen.id, contact_id: contactId,
    signal_source: chosen.signalSource,
    signal_metadata: {
      ...(chosen.signalMetadata && typeof chosen.signalMetadata === "object" ? chosen.signalMetadata as Record<string, unknown> : { matched: chosen.signalMetadata }),
      age_band: band.ageSegment,
      age_band_source: band.source,
      delivery_channel: choice.channel,
      delivery_channel_source: choice.railSource,
      delivery_channels_rejected: choice.rejected,
      preferred_format: choice.preferredFormat,
      // Wave 145: what the person stated (never inferred) and what it asks of the lesson — so the reel / the portal
      // honour captions and a transcript, and a refused read is a recorded fact, not "nothing stated".
      accessibility_source: accessibilitySource,
      accessibility_captions: adapt.captions,
      accessibility_transcript: adapt.transcript,
      protected_class_basis: basis,
      // Wave 103 (103A): a dual client is taught BOTH sides (the router matched both layouts'
      // stages); the record says so, and which side this lesson's concierge spoke for.
      client_side: side,
      dual_client: dualClient,
    },
    priority_score: chosen.priorityScore, status: "open",
  })
  // supabase-js RESOLVES refusals (CLAUDE.md §3). A dropped error here would let
  // the nudge reach the gate with no assignment behind it, so the portal feed and
  // the completion tracker would never see the lesson the client was just told
  // about — and the idempotency check above would re-propose it forever.
  if (assignError) return { proposed: false, reason: `learning_assignments insert refused: ${assignError.message}` }

  // Propose the nudge into the gate (the side-appropriate concierge).
  const msg = buildEducationDelivery(chosen.title, chosen.summary, chosen.estimatedMinutes, agentName)
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  // The RAIL came from the client's stated channel or the one default — never their age (wave 145). The approver is
  // also told what the client asked for (captions / a transcript / a format), so the lesson and its reel honour it.
  const bandNote = choice.railSource === "stated"
    ? `${choice.channel} — the client's stated channel`
    : `${choice.channel} — the default rail (the client's own portal); the client stated no channel`
  const asks = [
    choice.preferredFormat ? `${choice.preferredFormat} format` : null,
    adapt.captions ? "captions" : null,
    adapt.transcript ? "a written transcript" : null,
  ].filter(Boolean)
  const accessNote = accessibilitySource === "unavailable"
    ? " — the client's accessibility preferences could not be read, so check with them before sending a video"
    : asks.length ? ` — the client asked for ${asks.join(", ")}; keep it on the lesson and its reel` : ""
  // THE HUMAN APPROVER IS TOLD when protected-class-derived data shaped this
  // proposal. The gate is a person; a person cannot exercise judgement about a
  // basis they were not shown. Sources only — the reason sentences are on the
  // assignment row for the auditor, and the rationale line is read at a glance.
  const basisNote = basis.length > 0
    ? ` — education selected using protected-class-derived signals (${basis.map((b) => b.source).join(", ")}); recorded on the assignment`
    : ""
  const res = await proposeClientMessage({
    brokerageId, agentKind: manager, entityType: "learning_module", entityId: chosen.id,
    recipientContactId: contactId, audience: side === "seller" ? "seller" : "buyer",
    subject: msg.subject, body: msg.body,
    rationale: `Stage-matched lesson "${sanitizeProperNoun(chosen.title, 80) ?? "lesson"}" (${chosen.signalSource}) — ${bandNote}${accessNote}${basisNote} — review/edit before it reaches the client.`,
    channel: choice.channel,
  }, supabase)
  if (!res.ok) return { proposed: false, reason: res.error }

  // THE LESSON AS A REEL (2026-09-07, owner: education videos "created correctly
  // … using the skills"). The same stage-matched lesson, fronted by the assigned
  // agent as an avatar-led explainer (Director kind 'explainer' → video_type
  // 'education', AgentExplainerReel), staged GATED through commissionVideo —
  // the one video door — idempotent per (contact, module). Best-effort: the
  // written lesson proposal above stands on its own if the reel cannot be staged.
  try {
    const { resolveContactPresenterUserId } = await import("@/lib/ai-isa/outreach-identity")
    const agentUserId = await resolveContactPresenterUserId(supabase, contactId, brokerageId)
    if (agentUserId) {
      const { buildInformationalReelSituation } = await import("@/lib/ai-isa/contact-reel-situation")
      const { commissionVideo } = await import("@/lib/video/video-director")
      const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")
      const persona = side === "seller" ? "seller" : side === "buyer" ? "buyer" : "both"
      const situation = buildInformationalReelSituation({
        contactId, persona, topicTitle: chosen.title, valueAngle: chosen.summary, categories: ["education"],
      })
      await commissionVideo(
        situation,
        { brokerageId, agentUserId, contactId, idempotencyDiscriminator: `education_module:${chosen.id}`, persona: { audience: persona }, copyGenerator: realCopyGenerator },
        supabase,
      )
    }
  } catch (e) {
    console.error("[education-delivery] lesson reel commission failed (lesson proposal stands):", (e as Error).message)
  }
  return { proposed: true, moduleId: chosen.id, channel: choice.channel }
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
