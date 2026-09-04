/**
 * lib/listing-presentation/section-drip.ts
 *
 * Wave 39 — the seller-facing pre-listing drip. Splits the full listing
 * presentation (CMA mixed in) into ordered SECTIONS and schedules them to drip
 * to the seller via email + portal across the window between now and the
 * listing appointment — selling the relationship + the market before the
 * meeting.
 *
 * HARD RULE: every section is seller-safe (price_withheld). The CMA section
 * presents MARKET context only and defers the home's valuation to the in-person
 * meeting (scrubbed via lib/cma/customer-facing-guard).
 *
 * DELIVERY SHAPE (the owner's ruling): ONE reel per email, each embedding a
 * clickable thumbnail, spaced across a timetable that finishes before the
 * listing appointment. planPresentationSections IS that timetable — there is
 * exactly one scheduler; deliverDueSections IS the delivery path — there is
 * exactly one sender, and it is the canonical dispatchEmail gate.
 *
 * The pure planner (planPresentationSections), the pure reel→section map
 * (planChapterReelSections) and the pure composer (composeSectionEmail) are
 * unit-tested; materialize/attach/deliver use the service client. Not
 * server-only — never import from a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import {
  redactPriceAmounts, scrubSuggestedPriceKeys, containsPriceAmount, buildSellerSafeCma,
  type PresentationLike,
} from "@/lib/cma/customer-facing-guard"
import { videoThumbnailEmbed } from "@/lib/video/video-thumbnail-embed"
// THE resolver — one definition of "what is the playable URL + thumbnail for
// this finished video?", across BOTH engines (D-ID ai_video_projects and
// Remotion remotion_composition_renders). Type-only here so the drip cron's
// module graph is unchanged; the implementation is imported at the call site.
import type { PlayableVideo } from "@/lib/video/playable-video"
// The two receipts materialize used to compute and DISCARD (§1.2 — the reader
// half is built below). Type-only, for the same module-graph reason: the
// implementations are still reached by dynamic import inside materialize.
import type { RenderSectionsResult } from "./section-render"
import type { NarrateResult } from "./section-narration-orchestrator"

export interface SectionSpec { key: string; title: string; body: Record<string, unknown> }

/** Canonical seller-facing section sequence (relationship + market sell; the
 *  home's value is deferred to the meeting). */
export const SECTION_SEQUENCE: SectionSpec[] = [
  { key: "intro",       title: "Meet Your Listing Team",   body: { kind: "intro" } },
  { key: "market",      title: "Your Market Right Now",    body: { kind: "market", shows: ["price_trend", "comparable_sales", "days_on_market"] } },
  { key: "credibility", title: "Why Sellers Choose Us",    body: { kind: "credibility" } },
  { key: "marketing",   title: "How We Sell Your Home",    body: { kind: "marketing" } },
  { key: "process",     title: "What To Expect",           body: { kind: "process" } },
  { key: "cma",         title: "Your Home's Analysis",     body: { kind: "cma", market_only: true, note: "Your home's value will be presented at our meeting." } },
  { key: "closing",     title: "Let's Talk Strategy",      body: { kind: "closing" } },
]

/**
 * The drip window used when a presentation carries NO appointment_at.
 *
 * Matched to the minimum lead time a listing appointment is booked with, so the
 * fallback schedule looks like a real one rather than compressing the seller's
 * whole sequence into a few days. planPresentationSections spreads across
 * whatever window it is given, so this is a default, never an assumption: a
 * presentation whose appointment is known always uses the real date.
 */
const DEFAULT_DRIP_WINDOW_DAYS = 7

export interface PlanInput {
  presentationId: string
  brokerageId:    string
  contactId?:     string | null
  appointmentAt:  string | Date
  now?:           Date
  sections?:      SectionSpec[]
  bufferHoursBeforeAppt?: number
  channel?:       "email" | "portal" | "both"
  /** Market narrative (price-free) merged into the CMA section. */
  marketNarrative?: string | null
}

export interface PlannedSection {
  presentation_id: string
  brokerage_id:    string
  contact_id:      string | null
  section_key:     string
  section_order:   number
  title:           string
  body:            Record<string, unknown>
  channel:         "email" | "portal" | "both"
  price_withheld:  true
  status:          "scheduled"
  scheduled_for:   string
}

/**
 * Pure: plan the seller-safe sections + their drip schedule. Sections are
 * spread evenly between `now` and `appointmentAt - buffer` so the last lands
 * comfortably before the meeting. If the appointment is too soon (or past),
 * everything is scheduled immediately. Every body is scrubbed of price keys.
 */
export function planPresentationSections(input: PlanInput): PlannedSection[] {
  const sections = input.sections ?? SECTION_SEQUENCE
  const now = input.now ?? new Date()
  const appt = new Date(input.appointmentAt)
  const bufferMs = (input.bufferHoursBeforeAppt ?? 12) * 3_600_000
  const channel = input.channel ?? "both"
  const N = sections.length

  const endMs = (Number.isFinite(appt.getTime()) ? appt.getTime() : now.getTime()) - bufferMs
  const windowMs = endMs - now.getTime()

  return sections.map((s, i) => {
    const fraction = (i + 1) / N
    const at = windowMs > 0 ? now.getTime() + fraction * windowMs : now.getTime()
    // Merge the market narrative into the CMA section, then scrub any price keys.
    // The narrative is FREE TEXT (often AI-written) — the key scrub cannot see a
    // number inside it, so it goes through the text redactor first (wired
    // 2026-09-03; it used to land verbatim).
    const narrative = input.marketNarrative ? redactPriceAmounts(input.marketNarrative) : null
    const rawBody = s.key === "cma" && narrative
      ? { ...s.body, market_narrative: narrative }
      : s.body
    return {
      presentation_id: input.presentationId,
      brokerage_id:    input.brokerageId,
      contact_id:      input.contactId ?? null,
      section_key:     s.key,
      section_order:   i,
      title:           s.title,
      body:            scrubSuggestedPriceKeys(rawBody) as Record<string, unknown>,
      channel,
      price_withheld:  true as const,
      status:          "scheduled" as const,
      scheduled_for:   new Date(at).toISOString(),
    }
  })
}

// ── Chapter reels ↔ sections (pure) ─────────────────────────────────────────
//
// STORAGE DECISION. presentation_sections.render_id is an FK to
// remotion_composition_renders(id) (m179, verified against the live database) —
// it holds the section's Remotion slide/CMA reel and CANNOT hold an
// ai_video_projects.id without a 23503 FK violation. Chapter reels are D-ID
// avatar renders recorded in ai_video_projects, a different table and a
// different id space, so the link lives on the section's `body` jsonb under
// `chapter_video`. Never substitute one id space for the other.

/** The reel link carried on presentation_sections.body.chapter_video. */
export interface ChapterVideoLink {
  ai_video_project_id: string
  chapter_index:       number
  chapter_title:       string
}

export interface ChapterReelInput {
  /** ai_video_projects.id — resolved to a playable URL at DELIVERY time, not now. */
  videoId:      string
  title:        string
  focus?:       string | null
  chapterIndex: number
}

export interface ChapterReelAssignment {
  videoId:      string
  chapterIndex: number
  chapterTitle: string
  sectionKey:   string
  /** true when no canonical section was free and the reel needs its own section. */
  isNewSection: boolean
}

/**
 * The chapter focuses lib/workflow-orchestrator/chains/listing-appt-prep
 * DEFAULT_CHAPTERS emits, mapped onto the canonical seller-facing sections they
 * are the on-camera version of. 'pricing_strategy' lands on the CMA section —
 * that section is market-only and defers the home's number to the meeting, and
 * so is the chapter script (steered + postchecked by lib/video/script-compliance).
 */
const CHAPTER_FOCUS_TO_SECTION_KEY: Record<string, string> = {
  intro:            "intro",
  credibility:      "credibility",
  pricing_strategy: "cma",
  pricing:          "cma",
  market:           "market",
  marketing:        "marketing",
  expectations:     "process",
  process:          "process",
  closing:          "closing",
}

/**
 * PURE: decide which section each chapter reel is delivered on. Chapters are
 * free-form ({title, focus?}) and are NOT keyed to SECTION_SEQUENCE, so this is
 * a resolve, not a lookup:
 *   1. a known focus claims its matching section, if that section exists and is free;
 *   2. anything left takes the next free section in drip order;
 *   3. only if there are more reels than sections does a reel get its own new
 *      section — scheduled by the SAME planner, so there is still one timetable.
 * Order-stable and idempotent: a reel already linked to a section keeps it.
 */
export function planChapterReelSections(
  reels: ChapterReelInput[],
  existingSections: Array<{ section_key: string; alreadyLinkedVideoId?: string | null }>,
): ChapterReelAssignment[] {
  const taken = new Set<string>()
  const out: ChapterReelAssignment[] = new Array(reels.length)

  // Sections that already carry a reel are claimed by it — re-running must not
  // move a reel that the seller may already have received.
  for (const s of existingSections) if (s.alreadyLinkedVideoId) taken.add(s.section_key)
  reels.forEach((r, i) => {
    const held = existingSections.find((s) => s.alreadyLinkedVideoId === r.videoId)
    if (held) out[i] = { videoId: r.videoId, chapterIndex: r.chapterIndex, chapterTitle: r.title, sectionKey: held.section_key, isNewSection: false }
  })

  // Pass 1 — focus claims its own section.
  reels.forEach((r, i) => {
    if (out[i]) return
    const want = r.focus ? CHAPTER_FOCUS_TO_SECTION_KEY[r.focus] : undefined
    if (!want || taken.has(want)) return
    if (!existingSections.some((s) => s.section_key === want)) return
    taken.add(want)
    out[i] = { videoId: r.videoId, chapterIndex: r.chapterIndex, chapterTitle: r.title, sectionKey: want, isNewSection: false }
  })

  // Pass 2 — everything else takes the next free section, then overflows.
  reels.forEach((r, i) => {
    if (out[i]) return
    const free = existingSections.find((s) => !taken.has(s.section_key))
    if (free) {
      taken.add(free.section_key)
      out[i] = { videoId: r.videoId, chapterIndex: r.chapterIndex, chapterTitle: r.title, sectionKey: free.section_key, isNewSection: false }
    } else {
      const key = `chapter_${r.chapterIndex}`
      taken.add(key)
      out[i] = { videoId: r.videoId, chapterIndex: r.chapterIndex, chapterTitle: r.title, sectionKey: key, isNewSection: true }
    }
  })
  return out
}

// ── The seller-facing section email (pure) ──────────────────────────────────

export interface ComposedSectionEmail { subject: string; previewText: string; html: string; text: string }

export interface SectionEmailInput {
  agentName:       string
  brokerageName:   string
  propertyAddress: string
  sectionTitle:    string
  /** 1-based position in the drip, so the seller can see the arc. */
  step:            number
  totalSteps:      number
  portalUrl:       string
  /**
   * The reel this email exists to carry. Null when no finished reel is attached.
   *
   * `reviewPending` decides how the reel travels, never WHETHER it travels — the
   * owner's ruling is that "the videos must go out with the channel", closed
   * autonomously with no human gate. See the embed decision in composeSectionEmail.
   */
  reel:            { videoUrl: string; thumbnailUrl: string | null; reviewPending?: boolean } | null
  /** Seller-safe note from the section body (e.g. the CMA valuation deferral). */
  note?:           string | null
  /**
   * listing_presentations.presentation_type — 'buyer_consultation' switches the
   * framing copy to the buyer's home-buying plan ahead of their consultation
   * (a buyer deck has no property address and no listing appointment, so the
   * seller copy would make wrong claims to a client). Absent/anything else ⇒
   * the seller copy, unchanged.
   */
  presentationType?: string | null
}

/**
 * PURE: compose ONE section's email — a single reel embedded as a clickable
 * thumbnail, framed against the upcoming appointment.
 *
 * SELLER-SAFE BY CONSTRUCTION. The title and note are free text (a chapter title
 * can be AI-written), so both go through redactPriceAmounts before they reach a
 * subject line or a body: the key-based scrub that protects `body` cannot see a
 * number living inside a string. No price, estimated value or suggested list
 * price is ever composed in — the number is the agent's to give at the meeting.
 */
export function composeSectionEmail(input: SectionEmailInput): ComposedSectionEmail {
  const buyer = input.presentationType === "buyer_consultation"
  // A buyer deck has no subject property — "about" their plan, never an address.
  const addr = buyer
    ? "your home-buying plan"
    : redactPriceAmounts(input.propertyAddress || "your home")
  const fallbackTitle = buyer ? "Your home-buying plan" : "Your listing plan"
  const title = redactPriceAmounts(input.sectionTitle || fallbackTitle).trim() || fallbackTitle
  const note = input.note ? redactPriceAmounts(input.note) : null
  const meeting = buyer ? "our consultation" : "our listing appointment"

  const subject = buyer ? `${title} — your home-buying plan` : `${title} — ${addr}`
  const previewText = input.reel
    ? `A short video from ${input.agentName} before ${meeting}.`
    : `${input.agentName} on ${title.toLowerCase()}, before ${meeting}.`

  // HOW THE REEL TRAVELS — the owner's ruling, in two parts.
  //
  //   "the videos must go out with the channel so close the loop on this
  //    autonomously"  → the video ALWAYS accompanies the send. Nothing here
  //    waits for a human, and a reel is never dropped for being unreviewed.
  //   "Thumbnail - c" → where the reel's script postcheck has not returned a
  //    clean 'passed', the section still goes and the video still goes, but as a
  //    PLAIN LINK rather than an embedded thumbnail image.
  //
  // The reason the thumbnail is the part that gives: a rendered frame is the one
  // artifact nothing in this system can inspect. redactPriceAmounts protects the
  // subject and the body, and the compositions are built price-free, but no check
  // can read a number burned into an image. A link carries the same video without
  // putting an unverifiable picture in front of a seller pre-appointment. An
  // outright 'failed' postcheck is refused earlier, in resolvePlayableVideo.
  const reviewPending = input.reel?.reviewPending === true
  const embed = input.reel
    ? reviewPending
      ? `<p style="margin:16px 0"><a href="${escapeAttr(input.reel.videoUrl)}" style="color:#0F172A;font-weight:600">▶ Watch the short video on ${escapeHtml(title.toLowerCase())}</a></p>`
      : videoThumbnailEmbed(input.reel.videoUrl, input.reel.thumbnailUrl)
    : ""
  const approach = buyer ? "your home search" : addr
  const lede = input.reel
    ? `I recorded a short video on <strong>${escapeHtml(title.toLowerCase())}</strong> so you can see how I'll approach ${escapeHtml(approach)} before we ever sit down together.`
    : `Here's the next piece of ${buyer ? "your plan" : `the plan for ${escapeHtml(addr)}`}: <strong>${escapeHtml(title.toLowerCase())}</strong>.`

  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#0F172A;line-height:1.5">
  <p style="color:#64748B;font-size:13px;margin:0 0 12px">Part ${input.step} of ${input.totalSteps} · before ${meeting}</p>
  <p>Hi,</p>
  <p>${lede}</p>${embed}
  ${note ? `<p style="background:#F8FAFC;border-left:3px solid #F59E0B;padding:10px 14px;margin:16px 0">${escapeHtml(note)}</p>` : ""}
  <p><a href="${escapeAttr(input.portalUrl)}" style="display:inline-block;background:#F59E0B;color:#0F172A;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${buyer ? "See your plan" : "See the full plan"}</a></p>
  <p>More on the way before we meet.</p>
  <p>— ${escapeHtml(input.agentName)}<br/>${escapeHtml(input.brokerageName)}</p>
  </body></html>`

  const text =
    `Part ${input.step} of ${input.totalSteps} — before ${meeting}\n\n` +
    `Hi,\n\n` +
    (input.reel
      ? `I recorded a short video on ${title.toLowerCase()} so you can see how I'll approach ${approach} before we ever sit down together.\n\nWatch it: ${input.reel.videoUrl}\n`
      : `Here's the next piece of ${buyer ? "your plan" : `the plan for ${addr}`}: ${title.toLowerCase()}.\n`) +
    (note ? `\n${note}\n` : "") +
    `\n${buyer ? "See your plan" : "See the full plan"}: ${input.portalUrl}\n\nMore on the way before we meet.\n\n— ${input.agentName}\n${input.brokerageName}`

  // FAIL CLOSED (wired 2026-09-03). Everything above REDACTS; nothing asserted.
  // A redactor whose regex stops matching would ship the number silently, and
  // "0 leaks" from a broken finder is byte-identical to a clean email (CLAUDE.md
  // §2). So the finished pieces are checked with the guard's own detector, URLs
  // set aside (a portal or video path can legitimately carry digit+letter runs),
  // and a hit REFUSES the email rather than sending it. sendSectionEmail turns
  // the throw into a recorded failure on the section row.
  const withoutUrls = (t: string) => t.replace(/https?:\/\/\S+/g, "")
  const leaked = [["subject", subject], ["previewText", previewText], ["text", withoutUrls(text)], ["html", withoutUrls(html)]]
    .find(([, v]) => containsPriceAmount(v))
  if (leaked) {
    throw new Error(`section-drip: a currency amount reached the seller-facing ${leaked[0]} after redaction — email refused (price is presented in person, never dripped)`)
  }

  return { subject, previewText, html, text }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}
function escapeAttr(s: string): string { return escapeHtml(s) }

export interface MaterializeResult {
  ok: boolean
  inserted: number
  error?: string
  /**
   * THE RECEIPT for the best-effort production pass that runs after the rows are
   * inserted. Both halves used to be computed and dropped on the floor:
   * `renderSectionsForPresentation` returns its refusals and
   * `narratePresentationSections` returns four deliberately DISTINCT counters —
   * `avatarNarrated` is the PLAN, `avatarSubmitted` / `avatarSkipped` are the
   * OUTCOME (section-narration-orchestrator.ts adjudicates the difference) — and
   * materialize `await`ed each and read neither. So a run that planned six
   * talking heads and submitted none was indistinguishable from one that
   * submitted six. They are carried here VERBATIM (the orchestrator's own type,
   * not a re-spelling — §6) so that difference is a fact on the receipt.
   *
   * Absent when the pass did not run (a buyer deck renders through its own
   * producer) or threw before producing one — see `productionError`.
   */
  render?: RenderSectionsResult
  narration?: NarrateResult
  /**
   * Why the production pass stopped, when it threw. The rows are still inserted
   * and `ok` is still true — a render failure must not fail materialization —
   * but "best-effort" is no longer a `catch {}` that erases what went wrong.
   */
  productionError?: string
}

/**
 * ONE LINE a human can read off the receipt. PURE, module-private (its only
 * reader is the log line materialize writes; the structured counters travel on
 * MaterializeResult.narration for any caller that wants them).
 *
 * Leads with the plan-versus-outcome gap because that is the number nobody could
 * see: a lane that has never produced a talking head reported `avatarNarrated`
 * for every section, and the gap between that and `avatarSubmitted` is the
 * finding. Every skip reason rides along, so "0 of 6 submitted" is never left
 * without its why.
 */
function describeNarrationReceipt(n: NarrateResult): string {
  const gap = n.avatarNarrated - n.avatarSubmitted
  const skips = n.avatarSkipped.length
    ? ` — skipped: ${n.avatarSkipped.map((s) => `${s.renderId}: ${s.reason}`).join("; ")}`
    : ""
  // Refused reads/writes (§3) ride on the same line: a refused presentation or
  // queue read is what "0 section(s)" used to hide, and a refused voiceover
  // write-back is a paid mp3 the row does not point at.
  const refusals = n.refusals.length
    ? ` — REFUSED: ${n.refusals.map((f) => `${f.step}${f.renderId ? ` ${f.renderId}` : ""}: ${f.reason}`).join("; ")}`
    : ""
  return (
    `${n.sections} section(s); planned ${n.avatarNarrated} avatar / ${n.voiceOnly} voice-only / ${n.onScreenOnly} on-screen; ` +
    `avatar submitted ${n.avatarSubmitted} of ${n.avatarNarrated} planned` +
    (gap > 0 ? ` (${gap} planned and NOT submitted)` : "") +
    `; voice clone ${n.hasVoiceClone ? "yes" : "no"}, avatar source ${n.hasAvatarSource ? "yes" : "no"}` +
    skips +
    refusals
  )
}

/**
 * Which deck a materialization is building. EXTENDED, NOT FORKED (§6): the
 * buyer-consultation lane rides the same planner, the same
 * presentation_sections table, the same Gate 2, and the same deliverer — it
 * differs only in WHICH section sequence is planned and WHICH producer renders
 * the sections, so those two facts are parameters rather than a second
 * materializer.
 */
export interface MaterializeOpts {
  /** Section sequence to plan. Defaults to the seller-facing SECTION_SEQUENCE. */
  sections?: SectionSpec[]
  /** 'buyer_consultation' routes rendering to the BuyerConsultationSlide
   *  producer (lib/buyer-consultation/consultation-render); anything else (or
   *  absent) keeps the listing lane's CMAReel + ListingSectionReel path. */
  presentationType?: string | null
}

/**
 * Read a listing_presentations row, plan its sections, and insert them.
 * Idempotent on (presentation_id, section_key). Schedules against the
 * presentation's appointment_at (falls back to a 5-day window from now).
 */
export async function materializePresentationSections(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
  opts: MaterializeOpts = {},
): Promise<MaterializeResult> {
  const supabase = client ?? createServiceClient()

  const { data: presRow, error } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, contact_id, appointment_at, cma_narrative, cma_low_value, cma_mid_value, cma_high_value, slide_deck")
    .eq("id", presentationId)
    .maybeSingle()
  if (error || !presRow) return { ok: false, inserted: 0, error: error?.message ?? "presentation not found" }
  if (!presRow.brokerage_id) return { ok: false, inserted: 0, error: "presentation has no brokerage_id" }

  // THE SELLER-SAFE COPY, FIRST (wired 2026-09-03). Everything a section body
  // is derived from below is read off `pres`, and `pres` is the presentation
  // with its valuation fields nulled, any pricing slides dropped from
  // slide_deck and residual price keys scrubbed (lib/cma/customer-facing-guard
  // buildSellerSafeCma). The agent-facing row is untouched; only this rail's
  // view of it is seller-safe by construction, so a future section that
  // embeds the deck cannot carry the suggested price.
  const pres = buildSellerSafeCma(presRow as PresentationLike & { brokerage_id: string | null; contact_id: string | null; appointment_at: string | null; cma_narrative: string | null })

  const brokerageId = presRow.brokerage_id as string

  const appointmentAt = pres.appointment_at ?? new Date(Date.now() + DEFAULT_DRIP_WINDOW_DAYS * 86_400_000).toISOString()
  const planned = planPresentationSections({
    presentationId,
    brokerageId,
    contactId:       pres.contact_id ?? null,
    appointmentAt,
    sections:        opts.sections,
    marketNarrative: pres.cma_narrative ?? null,
  })

  const { data: inserted, error: insErr } = await supabase
    .from("presentation_sections")
    .upsert(planned, { onConflict: "presentation_id,section_key", ignoreDuplicates: true })
    .select("id")
  if (insErr) return { ok: false, inserted: 0, error: insErr.message }

  // Best-effort: render EVERY section as an animated video. Which producer
  // depends on the deck (see MaterializeOpts) — buyer decks render each section
  // as a BuyerConsultationSlide; listing decks keep the CMA section as a
  // seller-safe CMAReel and the rest as branded ListingSectionReel slides. A
  // render failure must not fail section materialization — the section still
  // drips (as a card until rendered).
  //
  // BEST-EFFORT IS NOT THE SAME AS UNRECORDED. Each producer's own receipt is
  // kept and returned (MaterializeResult.render / .narration), and a throw is
  // named rather than swallowed — the sections still drip either way.
  let render: RenderSectionsResult | undefined
  let narration: NarrateResult | undefined
  let productionError: string | undefined
  try {
    if (opts.presentationType === "buyer_consultation") {
      // The buyer producer handles its own narration (script + avatar request
      // per slide) — the listing narration orchestrator would size scripts and
      // spend TTS against a composition these renders don't play.
      const { renderBuyerConsultationSlides } = await import("@/lib/buyer-consultation/consultation-render")
      await renderBuyerConsultationSlides(presentationId, supabase)
    } else {
      const { renderSectionsForPresentation } = await import("./section-render")
      render = await renderSectionsForPresentation(presentationId, supabase)
      // Then narrate: the agent's cloned voice (+ avatar when available) over each
      // section. Degrades gracefully — no clone → on-screen copy only; the video
      // still renders. Best-effort; never blocks materialization.
      const { narratePresentationSections } = await import("./section-narration-orchestrator")
      narration = await narratePresentationSections(presentationId, supabase)
      // THE READER (§1.2). The orchestrator has reported plan and outcome as two
      // numbers since the avatar lane was lit, and this was the only caller —
      // it awaited the result and dropped it, so the two could disagree by six
      // and nothing anywhere would say so. Logged as one line here, and carried
      // out on the receipt for whoever holds it.
      const line = describeNarrationReceipt(narration)
      if (narration.avatarNarrated > narration.avatarSubmitted || narration.refusals.length > 0) {
        console.warn(`[section-drip] presentation ${presentationId} narration — ${line}`)
      } else {
        console.log(`[section-drip] presentation ${presentationId} narration — ${line}`)
      }
      if (render.refused > 0) {
        console.warn(`[section-drip] presentation ${presentationId} render — ${render.rendered} rendered, ${render.skipped} skipped, ${render.refused} refused by contract: ${render.refusals.join("; ")}`)
      }
    }
  } catch (e) {
    productionError = e instanceof Error ? e.message : String(e)
    console.error(`[section-drip] presentation ${presentationId} — section render/narration pass threw (${productionError}); sections are inserted and will drip as cards`)
  }

  return {
    ok: true,
    inserted: inserted?.length ?? 0,
    ...(render ? { render } : {}),
    ...(narration ? { narration } : {}),
    ...(productionError ? { productionError } : {}),
  }
}


// ── Attach the chapter reels to the drip ────────────────────────────────────

export interface AttachChapterReelsResult {
  ok:            boolean
  attached:      number
  newSections:   number
  /** videoIds that could not be placed, with the reason. Never silently dropped. */
  unattached:    Array<{ videoId: string; reason: string }>
  error?:        string
}

/**
 * Route the presentation's chapter reels INTO the section drip: each reel is
 * linked to exactly one section, so the timetable that already exists delivers
 * it as its own email. Replaces the `activities` /
 * activity_type='scheduled_video_touchpoint' rows nothing ever consumed.
 *
 * The link stores the ai_video_projects.id, NOT a URL: at attach time the D-ID
 * render is usually still in flight, and the playable bucket URL only exists
 * once poll-did-videos completes the row — days before the appointment, which
 * is exactly when the drip reads it back.
 *
 * Idempotent: a section that already carries this reel keeps it, and re-running
 * neither duplicates nor reshuffles a reel the seller may already have received.
 */
export async function attachChapterReelsToSections(
  presentationId: string,
  reels: ChapterReelInput[],
  client?: ReturnType<typeof createServiceClient>,
): Promise<AttachChapterReelsResult> {
  const supabase = client ?? createServiceClient()
  const empty: AttachChapterReelsResult = { ok: true, attached: 0, newSections: 0, unattached: [] }
  if (reels.length === 0) return empty

  const { data: pres, error: presErr } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, contact_id, appointment_at")
    .eq("id", presentationId)
    .maybeSingle()
  if (presErr) return { ...empty, ok: false, error: presErr.message }
  if (!pres) return { ...empty, ok: false, error: "presentation not found" }
  if (!pres.brokerage_id) return { ...empty, ok: false, error: "presentation has no brokerage_id" }

  const { data: sectionRows, error: secErr } = await supabase
    .from("presentation_sections")
    .select("id, section_key, section_order, body")
    .eq("presentation_id", presentationId)
    .order("section_order")
  if (secErr) return { ...empty, ok: false, error: secErr.message }

  const sections = (sectionRows ?? []) as Array<{ id: string; section_key: string; section_order: number; body: Record<string, unknown> | null }>
  if (sections.length === 0) return { ...empty, ok: false, error: "presentation has no materialized sections" }

  const byKey = new Map(sections.map((s) => [s.section_key, s]))
  const plan = planChapterReelSections(
    reels,
    sections.map((s) => ({
      section_key:          s.section_key,
      alreadyLinkedVideoId: readChapterVideoLink(s.body)?.ai_video_project_id ?? null,
    })),
  )

  let attached = 0
  let newSections = 0
  const unattached: Array<{ videoId: string; reason: string }> = []

  // Overflow reels (more chapters than canonical sections) get their own
  // sections — planned by planPresentationSections, the SAME scheduler, across
  // the SAME now→appointment window. One timetable, no second scheduler.
  const overflow = plan.filter((a) => a.isNewSection)
  if (overflow.length) {
    const appointmentAt = pres.appointment_at ?? new Date(Date.now() + DEFAULT_DRIP_WINDOW_DAYS * 86_400_000).toISOString()
    const planned = planPresentationSections({
      presentationId,
      brokerageId: pres.brokerage_id,
      contactId:   pres.contact_id ?? null,
      appointmentAt,
      sections: overflow.map((a) => ({
        key: a.sectionKey,
        // A chapter title is free text (often AI-written) and becomes this
        // section's email subject — redact any amount before it is persisted.
        title: redactPriceAmounts(a.chapterTitle).trim() || `Chapter ${a.chapterIndex + 1}`,
        body:  { kind: "chapter_reel", chapter_index: a.chapterIndex },
      })),
    })
    const startOrder = sections.length
    const { data: ins, error: insErr } = await supabase
      .from("presentation_sections")
      .upsert(
        planned.map((p, i) => ({ ...p, section_order: startOrder + i })),
        { onConflict: "presentation_id,section_key", ignoreDuplicates: true },
      )
      .select("id, section_key, section_order, body")
    if (insErr) {
      for (const a of overflow) unattached.push({ videoId: a.videoId, reason: `overflow section insert failed: ${insErr.message}` })
    } else {
      newSections = ins?.length ?? 0
      for (const r of (ins ?? []) as Array<{ id: string; section_key: string; section_order: number; body: Record<string, unknown> | null }>) {
        byKey.set(r.section_key, r)
      }
    }
  }

  for (const a of plan) {
    const target = byKey.get(a.sectionKey)
    if (!target) {
      if (!unattached.some((u) => u.videoId === a.videoId)) {
        unattached.push({ videoId: a.videoId, reason: `section '${a.sectionKey}' does not exist` })
      }
      continue
    }
    const existing = readChapterVideoLink(target.body)
    if (existing?.ai_video_project_id === a.videoId) { attached++; continue }

    const link: ChapterVideoLink = {
      ai_video_project_id: a.videoId,
      chapter_index:       a.chapterIndex,
      chapter_title:       a.chapterTitle,
    }
    // Only the LINK is written. The canonical section title (SECTION_SEQUENCE)
    // is curated seller-facing copy and stays as it is — the chapter's own
    // title is kept on the link for attribution, and the redacted form is what
    // titles an overflow section above.
    const nextBody = {
      ...(target.body ?? {}),
      chapter_video: { ...link, chapter_title: redactPriceAmounts(link.chapter_title) },
    }
    const { error: updErr } = await supabase
      .from("presentation_sections")
      .update({ body: nextBody })
      .eq("id", target.id)
    if (updErr) { unattached.push({ videoId: a.videoId, reason: updErr.message }); continue }
    attached++
  }

  return { ok: true, attached, newSections, unattached }
}

/** Read the chapter-reel link off a section body, tolerating a malformed jsonb. */
function readChapterVideoLink(body: unknown): ChapterVideoLink | null {
  if (!body || typeof body !== "object") return null
  const cv = (body as Record<string, unknown>).chapter_video
  if (!cv || typeof cv !== "object") return null
  const id = (cv as Record<string, unknown>).ai_video_project_id
  if (typeof id !== "string" || !id) return null
  return {
    ai_video_project_id: id,
    chapter_index:       Number((cv as Record<string, unknown>).chapter_index ?? 0),
    chapter_title:       String((cv as Record<string, unknown>).chapter_title ?? ""),
  }
}

// ── Resolving a section's reel at delivery time ─────────────────────────────

/**
 * A section's reel is just a playable video, resolved by the ONE resolver every
 * sender in the OS uses (lib/video/playable-video). This module used to carry
 * its own copy of that lookup; the copy is gone rather than left to drift, and
 * the type is an alias so callers still read in the drip's own vocabulary.
 */
export type SectionReel = PlayableVideo

/**
 * Resolve the reel a section's email should embed. A section can carry BOTH a
 * D-ID chapter reel (on body.chapter_video — the agent on camera) and its own
 * Remotion slide/CMA render (render_id). Both are handed to the shared
 * resolver, which returns the first READY one: the point is to deliver a video,
 * so a finished Remotion section reel goes out rather than stalling behind a
 * D-ID avatar that is still rendering.
 *
 * Returns the honest state, never a fabricated URL: when nothing is ready but
 * something is genuinely still coming the state is 'in_progress' so the caller
 * can wait rather than send an email whose whole point is missing.
 */
export async function resolveSectionReel(
  section: { render_id: string | null; body: Record<string, unknown> | null },
  client?: ReturnType<typeof createServiceClient>,
): Promise<SectionReel> {
  const { resolvePlayableVideo } = await import("@/lib/video/playable-video")
  return resolvePlayableVideo(
    {
      videoProjectId: readChapterVideoLink(section.body)?.ai_video_project_id ?? null,
      renderId:       section.render_id,
    },
    client ?? createServiceClient(),
  )
}

// ── Delivery ────────────────────────────────────────────────────────────────

export interface DeliverResult {
  delivered:     number
  considered:    number
  portalPosted:  number
  emailsSent:    number
  emailsFailed:  number
  /** Due sections held back because their reel is still rendering. */
  waitingOnReel: number
  /**
   * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF (no duplicate existed).
   *
   * `presentation_sections.delivered_at` was stamped by the claim below (:866)
   * and read by NOBODY — none of the four other readers of this table selects
   * it. So the drip could stamp a delivery and then stop dead, and every
   * subsequent tick returned `considered: 0, delivered: 0`, which is
   * byte-identical to "there was nothing due". A seller's pre-appointment
   * timetable could stall silently between part 2 and part 7 with the
   * appointment coming, and the cron log said the run was clean.
   */
  lastDeliveredAt: string | null
  /** Presentations with an OVERDUE section whose last delivery is > 3 days old. */
  stalledPresentations: number
  error?:        string
}

/**
 * How long a due section will wait for its reel to finish rendering before it
 * is delivered WITHOUT the embed. Matches VIDEO_STALE_HOURS.generating in
 * lib/video/video-pipeline-reaper-policy: past that the reaper considers the
 * render stalled, and a seller's touch must not be held hostage to it — the
 * whole timetable exists to land before the appointment.
 */
const REEL_WAIT_HOURS = 3

interface DueSectionRow {
  id:              string
  presentation_id: string
  brokerage_id:    string
  contact_id:      string | null
  title:           string | null
  section_key:     string
  section_order:   number
  channel:         string | null
  render_id:       string | null
  body:            Record<string, unknown> | null
  scheduled_for:   string | null
}

interface PresentationContext {
  propertyAddress: string
  agentName:       string
  fromEmail:       string | null
  brokerageName:   string
  sectionCount:    number
  /** listing_presentations.presentation_type — 'buyer_consultation' switches
   *  the email framing + portal link to the buyer's journey. */
  presentationType: string | null
}

/**
 * Deliver every section whose scheduled_for has arrived, on the channel the row
 * asks for. `channel` is written by the planner and until now was read by
 * nothing: a section marked 'email' or 'both' posted a portal card and no email
 * ever left. It now does both.
 *
 *   · portal | both → seller-facing portal card (writePortalUpdate).
 *   · email  | both → ONE email carrying THIS section's reel as a clickable
 *     thumbnail, sent through the canonical dispatchEmail gate (suppression +
 *     consent + compliance + de-conflict). There is no second sender.
 *
 * GATE 2 is unchanged: the inner join on listing_presentations keeps sections
 * out of the drip until a human stamped delivery_approved_at.
 *
 * ORDER OF OPERATIONS. A due section whose reel is still rendering is left
 * 'scheduled' and retried next tick (bounded by REEL_WAIT_HOURS) — an email
 * whose entire point is the video should not go out without it. Once past that
 * check the row is CLAIMED (scheduled → delivered, atomic status guard) before
 * any channel work, so overlapping cron ticks cannot double-send.
 *
 * A FAILED EMAIL LEAVES THE ROW 'delivered'. Three reasons, all deliberate:
 * (1) the claim is the only thing making a double-send impossible, and a
 * dispatch that failed AFTER the provider accepted is indistinguishable from
 * one that never left — re-opening the row would risk sending twice;
 * (2) the portal card may well have landed, and flipping the row to 'failed'
 * would erase that; (3) each section owns a slot on a timetable that ends
 * before the appointment, so a retry would arrive out of order or after the
 * meeting. It is never silent: the outcome is written onto the row
 * (body.email_delivery) and logged, so a failed touch is a fact a human can
 * query, not an absence.
 */
export async function deliverDueSections(
  opts: { now?: Date; limit?: number } = {},
  client?: ReturnType<typeof createServiceClient>,
): Promise<DeliverResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const result: DeliverResult = {
    delivered: 0, considered: 0, portalPosted: 0, emailsSent: 0, emailsFailed: 0,
    waitingOnReel: 0, lastDeliveredAt: null, stalledPresentations: 0,
  }

  // GATE 2: a section is delivered only after a human RELEASED its presentation
  // (listing_presentations.delivery_approved_at). An inner join + not-null filter
  // keeps held (un-reviewed) presentations out of the drip entirely.
  const { data: due, error: dueErr } = await supabase
    .from("presentation_sections")
    .select("id, presentation_id, brokerage_id, contact_id, title, section_key, section_order, channel, render_id, body, scheduled_for, listing_presentations!inner(delivery_approved_at)")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .not("listing_presentations.delivery_approved_at", "is", null)
    .order("scheduled_for", { ascending: true })
    .limit(opts.limit ?? 25)
  if (dueErr) return { ...result, error: dueErr.message }

  const rows = (due ?? []) as unknown as DueSectionRow[]
  result.considered = rows.length

  // §1.2 — THE READER for delivered_at. Computed BEFORE this tick's own claims
  // so it describes the state the tick INHERITED, which is what a stall is.
  const stall = await readDripStall(supabase, now)
  result.lastDeliveredAt = stall.lastDeliveredAt
  result.stalledPresentations = stall.stalledPresentations

  const presCache = new Map<string, PresentationContext | null>()

  for (const s of rows) {
    const channel = s.channel ?? "both"
    const wantsEmail = channel === "email" || channel === "both"
    const wantsPortal = channel === "portal" || channel === "both"

    // Resolve the reel BEFORE claiming: a section still rendering is not ready
    // to send, and a claim we then abandon would burn the row.
    let reel: SectionReel = { state: "none", reason: "email channel not requested" }
    if (wantsEmail) {
      reel = await resolveSectionReel({ render_id: s.render_id, body: s.body }, supabase)
      if (reel.state === "in_progress") {
        const dueSinceMs = s.scheduled_for ? now.getTime() - new Date(s.scheduled_for).getTime() : 0
        if (dueSinceMs < REEL_WAIT_HOURS * 3_600_000) { result.waitingOnReel++; continue }
        // Past the wait budget the render is stalled (the video reaper's own
        // threshold). Send the section rather than strand the seller's touch.
        console.warn(`[section-drip] section ${s.id} reel still rendering after ${REEL_WAIT_HOURS}h — delivering without the embed`)
        reel = { state: "none", reason: `reel still rendering after ${REEL_WAIT_HOURS}h` }
      }
    }

    // Claim the row (scheduled → delivered) so an overlapping tick can't double-send.
    const { data: claimed, error: claimErr } = await supabase
      .from("presentation_sections")
      .update({ status: "delivered", delivered_at: new Date().toISOString() })
      .eq("id", s.id)
      .eq("status", "scheduled")
      .select("id")
      .maybeSingle()
    if (claimErr) { console.error(`[section-drip] could not claim section ${s.id}: ${claimErr.message}`); continue }
    if (!claimed) continue
    result.delivered++

    if (wantsPortal && s.contact_id) {
      try {
        const { writePortalUpdate } = await import("@/lib/kernel/event-fanout")
        const { KernelEvent } = await import("@/lib/kernel/events")
        await writePortalUpdate(
          {
            event:       KernelEvent.PRESENTATION_SECTION_DELIVERED,
            brokerageId: s.brokerage_id,
            entityType:  "listing_presentation",
            entityId:    s.presentation_id,
            metadata:    { section_title: s.title ?? "Your listing plan" },
          } as Parameters<typeof writePortalUpdate>[0],
          [s.contact_id],
        )
        result.portalPosted++
      } catch (e) {
        console.error(`[section-drip] portal card failed for section ${s.id}: ${(e as Error).message}`)
      }
    }

    if (!wantsEmail) continue

    // ── EMAIL ───────────────────────────────────────────────────────────────
    let outcome: { ok: boolean; to?: string | null; messageId?: string | null; error?: string; reel?: string }
    if (!s.contact_id) {
      outcome = { ok: false, error: "section has no contact_id — nobody to email" }
    } else {
      if (!presCache.has(s.presentation_id)) {
        presCache.set(s.presentation_id, await loadPresentationContext(s.presentation_id, supabase))
      }
      const ctx = presCache.get(s.presentation_id) ?? null
      outcome = ctx
        ? await sendSectionEmail(s, ctx, reel, supabase)
        : { ok: false, error: "presentation context unresolvable — no send" }
    }

    if (outcome.ok) result.emailsSent++
    else {
      result.emailsFailed++
      console.error(`[section-drip] section ${s.id} (${s.section_key}) email NOT sent: ${outcome.error ?? "unknown"}`)
    }

    // Record the outcome ON THE ROW. The row is already 'delivered' (see the
    // header) — without this, a failed touch would be indistinguishable from a
    // successful one forever.
    const { error: stampErr } = await supabase
      .from("presentation_sections")
      .update({
        body: {
          ...(s.body ?? {}),
          email_delivery: {
            attempted_at: new Date().toISOString(),
            ok:           outcome.ok,
            to:           outcome.to ?? null,
            message_id:   outcome.messageId ?? null,
            error:        outcome.ok ? null : (outcome.error ?? "unknown"),
            reel:         outcome.reel ?? (reel.state === "ready" ? reel.source : "none"),
          },
        },
      })
      .eq("id", s.id)
    if (stampErr) console.error(`[section-drip] could not record email outcome on section ${s.id}: ${stampErr.message}`)
  }

  return result
}

/**
 * ORPHAN DOCTRINE §1.2 — the reader `presentation_sections.delivered_at` never
 * had. Answers two questions the drip could not previously answer about itself:
 *
 *   · when did this rail last deliver ANYTHING (its pulse), and
 *   · how many presentations have a section that came due more than a day ago
 *     while their last delivery is older than STALL_DAYS — a timetable that
 *     started and then stopped, which is the failure a seller notices and the
 *     cron log could not show.
 *
 * §3: both reads destructure `{ data, error }`. A refused read reports zero
 * stalls AND a null pulse, and the null pulse is what marks the answer unknown
 * rather than clean.
 */
const STALL_DAYS = 3

async function readDripStall(
  supabase: ReturnType<typeof createServiceClient>,
  now: Date,
): Promise<{ lastDeliveredAt: string | null; stalledPresentations: number }> {
  const staleBefore = new Date(now.getTime() - STALL_DAYS * 86_400_000).toISOString()
  const overdueBefore = new Date(now.getTime() - 86_400_000).toISOString()

  const [deliveredRes, overdueRes] = await Promise.all([
    supabase
      .from("presentation_sections")
      .select("presentation_id, delivered_at")
      .not("delivered_at", "is", null)
      .order("delivered_at", { ascending: false })
      .limit(2000),
    supabase
      .from("presentation_sections")
      .select("presentation_id")
      .eq("status", "scheduled")
      .lte("scheduled_for", overdueBefore)
      .limit(2000),
  ])
  if (deliveredRes.error) {
    console.error(`[section-drip] delivered_at sweep unreadable: ${deliveredRes.error.message}`)
    return { lastDeliveredAt: null, stalledPresentations: 0 }
  }
  if (overdueRes.error) {
    console.error(`[section-drip] overdue sweep unreadable: ${overdueRes.error.message}`)
    return { lastDeliveredAt: null, stalledPresentations: 0 }
  }

  const deliveredRows = (deliveredRes.data ?? []) as Array<{ presentation_id: string; delivered_at: string }>
  // Rows arrive newest-first, so the FIRST stamp seen per presentation is its latest.
  const latestByPresentation = new Map<string, string>()
  for (const r of deliveredRows) {
    if (!latestByPresentation.has(r.presentation_id)) latestByPresentation.set(r.presentation_id, r.delivered_at)
  }
  const lastDeliveredAt = deliveredRows[0]?.delivered_at ?? null

  const overduePresentations = new Set(
    ((overdueRes.data ?? []) as Array<{ presentation_id: string }>).map((r) => r.presentation_id),
  )
  let stalledPresentations = 0
  for (const pid of overduePresentations) {
    const last = latestByPresentation.get(pid)
    // A drip that has delivered NOTHING is not stalled — it has not started;
    // gate 2 holds it, and calling that a stall would cry wolf every tick.
    if (last && last < staleBefore) stalledPresentations++
  }
  return { lastDeliveredAt, stalledPresentations }
}

/** Resolve everything a section email needs from its presentation, once per presentation. */
async function loadPresentationContext(
  presentationId: string,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<PresentationContext | null> {
  const { data: pres, error } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, agent_user_id, property_address, presentation_type")
    .eq("id", presentationId)
    .maybeSingle()
  if (error) { console.error(`[section-drip] presentation ${presentationId} unreadable: ${error.message}`); return null }
  if (!pres?.brokerage_id) return null

  // agent_user_id is the USERS class (listing_presentations FKs users.id) —
  // resolve the sender from it, never substitute an agents.id or contacts.id.
  let agentName = "Your Agent"
  let fromEmail: string | null = null
  if (pres.agent_user_id) {
    const { data: u, error: uErr } = await supabase
      .from("users").select("first_name, last_name, email").eq("id", pres.agent_user_id).maybeSingle()
    if (uErr) console.error(`[section-drip] agent user ${pres.agent_user_id} unreadable: ${uErr.message}`)
    const uu = u as { first_name?: string | null; last_name?: string | null; email?: string | null } | null
    const full = [uu?.first_name, uu?.last_name].filter(Boolean).join(" ").trim()
    if (full) agentName = full
    fromEmail = uu?.email ?? null
  }

  const { data: brk, error: brkErr } = await supabase
    .from("brokerages").select("name").eq("id", pres.brokerage_id).maybeSingle()
  if (brkErr) console.error(`[section-drip] brokerage ${pres.brokerage_id} unreadable: ${brkErr.message}`)

  const { count, error: cntErr } = await supabase
    .from("presentation_sections")
    .select("id", { count: "exact", head: true })
    .eq("presentation_id", presentationId)
  if (cntErr) console.error(`[section-drip] section count unreadable for ${presentationId}: ${cntErr.message}`)

  return {
    propertyAddress: pres.property_address ?? "your home",
    agentName,
    fromEmail,
    brokerageName:   (brk as { name?: string | null } | null)?.name ?? "Your Brokerage",
    sectionCount:    count ?? 0,
    presentationType: (pres as { presentation_type?: string | null }).presentation_type ?? null,
  }
}

/** Compose + send ONE section's email through the canonical dispatch gate. */
async function sendSectionEmail(
  s: DueSectionRow,
  ctx: PresentationContext,
  reel: SectionReel,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<{ ok: boolean; to?: string | null; messageId?: string | null; error?: string; reel?: string }> {
  if (!s.contact_id) return { ok: false, error: "section has no contact_id" }

  const { data: contact, error: cErr } = await supabase
    .from("contacts").select("email").eq("id", s.contact_id).maybeSingle()
  if (cErr) return { ok: false, error: `contact unreadable: ${cErr.message}` }
  const to = (contact as { email?: string | null } | null)?.email ?? null
  if (!to) return { ok: false, error: "contact has no email address" }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    return { ok: false, to, error: "NEXT_PUBLIC_APP_URL is not configured — refusing to email a portal link that resolves nowhere" }
  }
  const isBuyerDeck = ctx.presentationType === "buyer_consultation"
  // A buyer deck's "plan" lives on the buyer's own journey portal, not the
  // seller's listing-plan page.
  const portalUrl = isBuyerDeck
    ? `${appUrl.replace(/\/$/, "")}/portal/${s.contact_id}/journey`
    : `${appUrl.replace(/\/$/, "")}/portal/listing-plan/${s.presentation_id}`

  const bodyNote = typeof (s.body ?? {})["note"] === "string" ? String((s.body as Record<string, unknown>).note) : null
  let email: ComposedSectionEmail
  try {
    email = composeSectionEmail({
      agentName:       ctx.agentName,
      brokerageName:   ctx.brokerageName,
      propertyAddress: ctx.propertyAddress,
      sectionTitle:    s.title ?? s.section_key,
      step:            s.section_order + 1,
      totalSteps:      Math.max(ctx.sectionCount, s.section_order + 1),
      portalUrl,
      reel:            reel.state === "ready"
        ? { videoUrl: reel.videoUrl, thumbnailUrl: reel.thumbnailUrl, reviewPending: reel.reviewPending }
        : null,
      note:            bodyNote,
      presentationType: ctx.presentationType,
    })
  } catch (e) {
    // The composer REFUSED (a price amount survived redaction). Recorded on the
    // row by the caller as a failed send — never retried into the seller's inbox.
    return { ok: false, to, error: e instanceof Error ? e.message : String(e) }
  }

  try {
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const res = await dispatchEmail({
      brokerageId:    s.brokerage_id,
      contactId:      s.contact_id,
      // undefined (not a placeholder) when the agent has no mailbox: sendEmail
      // then walks the tenant credential cascade and REFUSES if nothing real
      // resolves. A guess here would beat the brokerage's verified sender.
      from:           ctx.fromEmail ?? undefined,
      to,
      subject:        email.subject,
      html:           email.html,
      text:           email.text,
      channelPurpose: "update",
      systemSource:   "prelisting_drip",
      metadata: {
        presentation_id: s.presentation_id,
        section_key:     s.section_key,
        reel_source:     reel.state === "ready" ? reel.source : null,
      },
    })
    return {
      ok:        !!res.success,
      to,
      messageId: res.messageId ?? null,
      error:     res.success ? undefined : (res.error ?? `refused by ${res.providerKey}`),
      reel:      reel.state === "ready" ? reel.source : "none",
    }
  } catch (e) {
    return { ok: false, to, error: (e as Error).message, reel: reel.state === "ready" ? reel.source : "none" }
  }
}
