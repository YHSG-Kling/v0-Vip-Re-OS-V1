/**
 * lib/buyer-consultation/consultation-render.ts
 *
 * The BuyerConsultationSlide PRODUCER — near-mirror of the live
 * ListingSectionReel lane (lib/listing-presentation/section-render.ts:112-239).
 * BuyerConsultationSlide has been registered (remotion/Root.tsx, m168 registry)
 * with no producer since Wave 39; the owner ruled it gets one BUILT (§1.2).
 *
 * ENTITY: REUSES listing_presentations + presentation_sections — a row with
 * presentation_type='buyer_consultation' (the column carries NO CHECK; only
 * `status` is constrained — scripts/check-vocabularies.ts listing_presentations)
 * whose sections are keyed by the six BuyerSlideKind values rides render_id,
 * the section drip, Gate 2, and delivery UNCHANGED.
 *
 * REFUSAL, NOT DEFAULTS: Remotion merges inputProps over defaultProps, so an
 * unsupplied required prop ships a CONFIDENT WRONG render
 * (lib/remotion/content-contract.ts header). Every slide's props pass
 * missingContentProps before the insert; a slide whose required data cannot be
 * resolved is SKIPPED with a recorded reason, and the deck refuses outright if
 * the title or closing slide cannot resolve — a deck is never staged empty.
 *
 * Not server-only: service client + pure narration. Never import from a client
 * component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import {
  generateBuyerSlideNarration,
  BUYER_SLIDE_COMPOSITION,
  type BuyerSlideNarration,
} from "@/lib/buyer-consultation/consultation-narration"
import type { SectionSpec } from "@/lib/listing-presentation/section-drip"
import type { BuyerSlideKind, BuyerSearchExample } from "@/remotion/BuyerConsultationSlide"
import { missingContentProps, describeMissingContent } from "@/lib/remotion/content-contract"
import { geometryFor } from "@/lib/remotion/composition-geometry"

/**
 * The slide's registered length, DERIVED from the geometry table that
 * test:remotion-setup proves equal to remotion/Root.tsx — a literal here with a
 * comment asserting "≤ the composition's frames" is not a bound (wave-20 rule);
 * a re-registration would silently outgrow it. The `?? 180` arm is unreachable
 * while BuyerConsultationSlide stays registered (the guard proves the table);
 * it exists only so a deregistration degrades to today's window instead of NaN.
 */
const BUYER_SLIDE_DURATION_FRAMES = geometryFor(BUYER_SLIDE_COMPOSITION)?.duration_frames ?? 180

/**
 * The canonical buyer-facing slide sequence — the buyer twin of the drip's
 * SECTION_SEQUENCE, keyed by the six BuyerSlideKind values
 * (remotion/BuyerConsultationSlide.tsx:40-46). Passed into
 * materializePresentationSections so ONE materializer + ONE timetable serve
 * both presentation types (§6 — extended, not forked).
 */
export const BUYER_SECTION_SEQUENCE: SectionSpec[] = [
  { key: "title",          title: "Your Home-Buying Plan",       body: { kind: "title" } },
  { key: "loan",           title: "Your Financing Power",        body: { kind: "loan" } },
  { key: "search",         title: "What Your Search Looks Like", body: { kind: "search" } },
  { key: "offer_strategy", title: "How We Win Your Offer",       body: { kind: "offer_strategy" } },
  { key: "timeline",       title: "From Offer To Keys",          body: { kind: "timeline" } },
  { key: "closing",        title: "Your Next Step",              body: { kind: "closing" } },
]

const BUYER_SLIDE_KINDS = new Set<string>(BUYER_SECTION_SEQUENCE.map((s) => s.key))

export interface RenderBuyerSlidesResult {
  ok:       boolean
  rendered: number
  /** Slides not staged, each with the recorded reason — never silent. */
  skipped:  Array<{ kind: string; reason: string }>
  error?:   string
}

/** Format a list price for the search card. Public list price of an active
 *  listing — legitimately shown to the buyer it was saved for (see the
 *  no-findSuggestedPriceLeaks note in consultation-narration.ts). */
function formatListPrice(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null
  return `$${Math.round(n).toLocaleString("en-US")}`
}

interface SlideContext {
  agentName:      string
  agentTake:      string | null
  agentPhotoUrl:  string | null
  buyerFirstName: string | null
  areaName:       string | null
  brand:          Record<string, unknown>
  preApproved:    boolean
  hasLoanProfile: boolean
  loanBody:       string[] | null
  searchExamples: BuyerSearchExample[]
  timelineLabels: string[]
  qrCodeDataUrl:  string | null
}

/**
 * Render every un-rendered section of a buyer_consultation presentation as a
 * BuyerConsultationSlide, write each render_id back onto its section (counted
 * update — §3: an UPDATE that matches nothing also resolves), and request the
 * avatar track for each slide through the existing D-ID → Remotion handoff.
 */
export async function renderBuyerConsultationSlides(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<RenderBuyerSlidesResult> {
  const supabase = client ?? createServiceClient()
  const none: RenderBuyerSlidesResult = { ok: false, rendered: 0, skipped: [] }

  const { data: pres, error: presErr } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, agent_user_id, contact_id, presentation_type")
    .eq("id", presentationId)
    .maybeSingle()
  if (presErr) return { ...none, error: `presentation unreadable: ${presErr.message}` }
  if (!pres?.brokerage_id) return { ...none, error: "presentation not found" }
  if (pres.presentation_type !== "buyer_consultation") {
    return { ...none, error: `presentation_type is '${pres.presentation_type}' — not a buyer consultation` }
  }
  if (!pres.contact_id) return { ...none, error: "presentation has no contact" }

  // ── Agent name + take (lifted verbatim from section-render.ts:130-137) ────
  let agentName = "Your Agent"
  let agentTake: string | null = null
  if (pres.agent_user_id) {
    const { data: u, error: uErr } = await supabase.from("users").select("first_name, last_name, presentation_take").eq("id", pres.agent_user_id).maybeSingle()
    if (uErr) console.warn(`[consultation-render] agent user unreadable: ${uErr.message}`)
    const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
    if (full) agentName = full
    agentTake = (u as any)?.presentation_take ?? null
  }
  // Agent photo — the PIP fallback when no avatar video exists. agents is keyed
  // by user_id here (agents.id and users.id are DISJOINT — §3). Cosmetic. The
  // agents.id is kept for the avatar request below: ai_video_projects.agent_id
  // FKs agents(id) (scripts/schema-fk-map.ts), so the users-class id must never
  // be written there.
  let agentPhotoUrl: string | null = null
  let agentRecordId: string | null = null
  if (pres.agent_user_id) {
    const { data: a, error: aErr } = await supabase.from("agents").select("id, photo_url, profile_image_url").eq("user_id", pres.agent_user_id).maybeSingle()
    if (aErr) console.warn(`[consultation-render] agent photo unreadable: ${aErr.message}`)
    agentPhotoUrl = (a as any)?.photo_url ?? (a as any)?.profile_image_url ?? null
    agentRecordId = (a as any)?.id ?? null
  }

  // ── Brokerage brand (mirror of section-render.ts:141-153) ─────────────────
  const { data: brk, error: brkErr } = await supabase
    .from("brokerages")
    .select("name, logo_url, license_number, license_state")
    .eq("id", pres.brokerage_id)
    .maybeSingle()
  if (brkErr) console.warn(`[consultation-render] brokerage unreadable: ${brkErr.message}`)
  const brand = {
    primaryColor:  "#0F172A",
    accentColor:   "#F59E0B",
    brokerageName: (brk as any)?.name ?? "Your Brokerage",
    logoUrl:       (brk as any)?.logo_url ?? undefined,
    licenseLine:   [(brk as any)?.license_number, (brk as any)?.license_state].filter(Boolean).join(" · ") || undefined,
    showEhoMark:   true,
  }

  // ── The buyer ─────────────────────────────────────────────────────────────
  const { data: contact, error: cErr } = await supabase
    .from("contacts")
    .select("first_name, city, state, contact_persona")
    .eq("id", pres.contact_id)
    .eq("brokerage_id", pres.brokerage_id)
    .maybeSingle()
  if (cErr) return { ...none, error: `contact unreadable: ${cErr.message}` }
  const buyerFirstName = (contact as any)?.first_name ?? null
  const areaName = [(contact as any)?.city, (contact as any)?.state].filter(Boolean).join(", ") || null

  // ── loan slide: buyer_financial_profiles pre-approval state ───────────────
  // {error} read: a refused read is NOT "no profile" — it skips the slide with
  // the refusal as the reason rather than claiming the buyer has no financing.
  let hasLoanProfile = false
  let preApproved = false
  let loanBody: string[] | null = null
  let loanReadError: string | null = null
  {
    const { data: fin, error: finErr } = await supabase
      .from("buyer_financial_profiles")
      .select("pre_approval_amount, pre_approval_lender, pre_approval_expires_at, is_cash_buyer, finance_type, verified")
      .eq("contact_id", pres.contact_id)
      .eq("brokerage_id", pres.brokerage_id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (finErr) loanReadError = finErr.message
    else if (fin) {
      hasLoanProfile = true
      const f = fin as any
      preApproved = f.pre_approval_amount != null || f.is_cash_buyer === true
      // Qualitative on purpose: the profile's own facts, no invented terms. The
      // amount itself is the buyer's private number for the meeting, not a
      // 1920px headline.
      if (f.is_cash_buyer === true) {
        loanBody = ["You're positioned as a cash buyer — the strongest seat at the table.", "We'll plan how to use that leverage when we meet."]
      } else if (f.pre_approval_amount != null) {
        loanBody = [
          `A pre-approval is on file${f.pre_approval_lender ? ` with ${f.pre_approval_lender}` : ""}${f.verified ? " (verified)" : ""}.`,
          "We'll walk through exactly what it unlocks for your offers when we meet.",
        ]
      } else {
        loanBody = [
          `Your financing profile is started${f.finance_type ? ` (${String(f.finance_type).replace(/_/g, " ")})` : ""} — pre-approval is the next move.`,
          "It defines your search and strengthens every offer. We'll map it together.",
        ]
      }
    }
  }

  // ── search slide: saved_properties (the writer at
  //    app/crm/contacts/[contactId]/search/search-client.tsx:330-342 stamps the
  //    IDX snapshot columns read here). Requires ≥1 complete example — the
  //    composition's empty-state is a Studio placeholder that must never ship
  //    in a client video, so no examples ⇒ the slide is SKIPPED, not staged
  //    empty. property_preferences only ENRICHES the body copy (it holds
  //    inferred ranges/cities, which cannot make an example card). ───────────
  let searchExamples: BuyerSearchExample[] = []
  let searchBodyHint: string | null = null
  let searchReadError: string | null = null
  {
    const { data: saved, error: savedErr } = await supabase
      .from("saved_properties")
      .select("property_address, city, state, list_price, bedrooms, bathrooms, primary_photo_url, saved_at, dismissed")
      .eq("contact_id", pres.contact_id)
      .eq("brokerage_id", pres.brokerage_id)
      .eq("dismissed", false)
      .order("saved_at", { ascending: false })
      .limit(6)
    if (savedErr) searchReadError = savedErr.message
    else {
      searchExamples = (saved ?? [])
        .map((r: any): BuyerSearchExample | null => {
          const price = formatListPrice(r.list_price)
          if (!r.property_address || !price) return null
          return {
            address:   String(r.property_address),
            cityState: [r.city, r.state].filter(Boolean).join(", "),
            price,
            bedrooms:  r.bedrooms != null ? String(r.bedrooms) : "—",
            bathrooms: r.bathrooms != null ? String(r.bathrooms) : "—",
            photoUrl:  r.primary_photo_url ?? null,
          }
        })
        .filter((x): x is BuyerSearchExample => x !== null)
        .slice(0, 3)
    }
    const { data: prefs, error: prefsErr } = await supabase
      .from("property_preferences")
      .select("inferred_cities, preferred_price_min, preferred_price_max")
      .eq("contact_id", pres.contact_id)
      .eq("brokerage_id", pres.brokerage_id)
      .maybeSingle()
    if (prefsErr) console.warn(`[consultation-render] property_preferences unreadable: ${prefsErr.message}`)
    const cities = ((prefs as any)?.inferred_cities ?? []) as unknown
    if (Array.isArray(cities) && cities.length > 0) {
      searchBodyHint = `Focused on ${cities.slice(0, 3).map(String).join(", ")}.`
    }
  }

  // ── timeline slide: the buyer journey checklist source — the same
  //    PERSONA_CONFIGS[persona].journeyStages that
  //    app/portal/[contactId]/journey/journey-checklist.tsx renders as the
  //    buyer's own checklist. Stage NAMES only (3-5). ────────────────────────
  let timelineLabels: string[] = []
  {
    const { getPersonaConfig, PERSONA_CONFIGS } = await import("@/lib/portal/persona-config")
    let cfg = getPersonaConfig(String((contact as any)?.contact_persona ?? "first_time_buyer"))
    // A buyer deck must never carry a seller journey — a seller-persona contact
    // booking a buyer consultation gets the canonical buyer journey.
    if (!cfg.isBuyer) cfg = PERSONA_CONFIGS.first_time_buyer
    timelineLabels = (cfg.journeyStages ?? []).map((s) => s.name).filter(Boolean).slice(0, 5)
  }

  // ── closing slide: tracked outro QR → the brokerage booking page. Same
  //    consult-CTA kind + entity the buyer-match reel uses
  //    (lib/agents/buyer-match-reel-producer.ts:192). Cosmetic — a refused mint
  //    degrades the badge, never the slide. ──────────────────────────────────
  let qrCodeDataUrl: string | null = null
  if (pres.agent_user_id) {
    try {
      const { mintVideoQr } = await import("@/lib/video/video-qr")
      const minted = await mintVideoQr(
        { brokerageId: pres.brokerage_id, agentUserId: pres.agent_user_id, kind: "explainer", contactId: pres.contact_id },
        supabase,
      )
      qrCodeDataUrl = minted?.qrCodeDataUrl ?? null
    } catch { /* QR is cosmetic chrome */ }
  }

  const ctx: SlideContext = {
    agentName, agentTake, agentPhotoUrl, buyerFirstName, areaName, brand,
    preApproved, hasLoanProfile, loanBody, searchExamples, timelineLabels, qrCodeDataUrl,
  }

  // ── Sections ──────────────────────────────────────────────────────────────
  const { data: sections, error: secErr } = await supabase
    .from("presentation_sections")
    .select("section_key, title, render_id")
    .eq("presentation_id", presentationId)
    .order("section_order")
  if (secErr) return { ...none, error: `sections unreadable: ${secErr.message}` }
  const list = (sections ?? []) as Array<{ section_key: string; title: string | null; render_id: string | null }>
  const slides = list.filter((s) => BUYER_SLIDE_KINDS.has(s.section_key))
  if (slides.length === 0) return { ...none, error: "presentation has no buyer slide sections" }
  const total = slides.length

  // Resolve every slide BEFORE inserting anything: title/closing are the deck's
  // frame — if either cannot resolve, the deck REFUSES rather than shipping a
  // frameless middle.
  type Resolved = { section: (typeof slides)[number]; slideNumber: number; narration: BuyerSlideNarration; extra: Record<string, unknown> } | { section: (typeof slides)[number]; skip: string }
  const resolved: Resolved[] = []
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]
    const kind = s.section_key as BuyerSlideKind
    if (s.render_id) { resolved.push({ section: s, skip: "already rendered" }); continue }

    // Kind-specific required data — refusal reasons recorded, never staged empty.
    let extra: Record<string, unknown> = {}
    if (kind === "loan") {
      if (loanReadError) { resolved.push({ section: s, skip: `buyer_financial_profiles read refused: ${loanReadError}` }); continue }
      if (!ctx.hasLoanProfile) { resolved.push({ section: s, skip: "no buyer_financial_profiles row — nothing true to say about financing" }); continue }
    }
    if (kind === "search") {
      if (searchReadError) { resolved.push({ section: s, skip: `saved_properties read refused: ${searchReadError}` }); continue }
      if (ctx.searchExamples.length === 0) { resolved.push({ section: s, skip: "no saved properties to show — the slide is not staged empty" }); continue }
      extra.searchExamples = ctx.searchExamples
    }
    if (kind === "timeline") {
      if (ctx.timelineLabels.length < 3) { resolved.push({ section: s, skip: `only ${ctx.timelineLabels.length} journey stage labels resolved (need 3-5)` }); continue }
      extra.timelineLabels = ctx.timelineLabels
    }
    if (kind === "closing" && ctx.qrCodeDataUrl) {
      extra.qrCodeDataUrl = ctx.qrCodeDataUrl
      extra.qrCaption = "Scan to book your consultation"
    }

    const narration = await generateBuyerSlideNarration({
      kind,
      agentName:      ctx.agentName,
      brokerageName:  String((ctx.brand as any).brokerageName ?? "Your Brokerage"),
      buyerFirstName: ctx.buyerFirstName,
      areaName:       ctx.areaName,
      agentTake:      ctx.agentTake,
      preApproved:    ctx.preApproved,
    })
    // Kind-resolved body overrides the generic authored copy where real data exists.
    if (kind === "loan" && ctx.loanBody) narration.body = ctx.loanBody
    if (kind === "search" && searchBodyHint) narration.body = [...narration.body, searchBodyHint]

    resolved.push({ section: s, slideNumber: i + 1, narration, extra })
  }

  const unresolvable = (k: string) =>
    resolved.find((r) => r.section.section_key === k && "skip" in r && r.skip !== "already rendered") as { skip: string } | undefined
  const titleGap = unresolvable("title")
  const closingGap = unresolvable("closing")
  if (titleGap || closingGap) {
    return { ...none, error: `deck refused — ${titleGap ? `title: ${titleGap.skip}` : `closing: ${closingGap!.skip}`}` }
  }

  // ── Stage each slide (mirror of section-render.ts:200-235) ────────────────
  const result: RenderBuyerSlidesResult = { ok: true, rendered: 0, skipped: [] }
  for (const r of resolved) {
    if ("skip" in r) {
      if (r.skip !== "already rendered") {
        console.warn(`[consultation-render] ${presentationId} slide '${r.section.section_key}' skipped: ${r.skip}`)
        result.skipped.push({ kind: r.section.section_key, reason: r.skip })
      }
      continue
    }
    const inputProps: Record<string, unknown> = {
      kind:            r.section.section_key,
      slideNumber:     r.slideNumber,
      totalSlides:     total,
      title:           r.section.title ?? "Your Home-Buying Plan",
      body:            r.narration.body,
      narrationScript: r.narration.script,
      agentName:       ctx.agentName,
      agentPhotoUrl:   ctx.agentPhotoUrl,
      avatarVideoUrl:  null,
      avatarStartFrame: 0,
      // The PIP window is the whole slide — derived from the registered
      // duration_frames (BUYER_SLIDE_DURATION_FRAMES above), not a literal.
      avatarEndFrame:  BUYER_SLIDE_DURATION_FRAMES,
      heroImageUrl:    null,
      brand:           ctx.brand,
      ...r.extra,
    }
    // The SAME question the render backstop will ask, asked first — refusal by
    // name at staging, so no queue row or spend exists for an unrenderable slide.
    const missing = missingContentProps(BUYER_SLIDE_COMPOSITION, inputProps)
    if (missing.length > 0) {
      const why = describeMissingContent(BUYER_SLIDE_COMPOSITION, missing)
      console.warn(`[consultation-render] ${presentationId} slide '${r.section.section_key}' refused: ${why}`)
      result.skipped.push({ kind: r.section.section_key, reason: why })
      continue
    }
    const { data: render, error: insErr } = await supabase
      .from("remotion_composition_renders")
      .insert({
        brokerage_id:    pres.brokerage_id,
        composition_id:  BUYER_SLIDE_COMPOSITION,
        agent_user_id:   pres.agent_user_id ?? null,
        entity_type:     "listing_presentation",
        entity_id:       presentationId,
        used_did_avatar: false,
        used_voiceover:  false,
        render_status:   "queued",
        input_props:     inputProps,
        scope_type:      "agent",
        scope_id:        pres.agent_user_id ?? null,
        requested_via:   "cron",
        is_published:    false,
      })
      .select("id")
      .single()
    if (insErr || !render) {
      result.skipped.push({ kind: r.section.section_key, reason: `render insert refused: ${insErr?.message ?? "no row returned"}` })
      continue
    }
    const renderId = (render as { id: string }).id

    // COUNTED update (§3): an UPDATE that matches nothing also resolves with a
    // null error — .select() the update and count what came back, because a
    // render row pointing at no section is a video the drip can never deliver.
    const { data: updated, error: updErr } = await supabase
      .from("presentation_sections")
      .update({ render_id: renderId })
      .eq("presentation_id", presentationId)
      .eq("section_key", r.section.section_key)
      .select("id")
    if (updErr) {
      result.skipped.push({ kind: r.section.section_key, reason: `render_id write refused: ${updErr.message}` })
      continue
    }
    if (!updated || updated.length === 0) {
      result.skipped.push({ kind: r.section.section_key, reason: "render_id write matched no section row" })
      continue
    }
    result.rendered++

    // ── Avatar (finish-spec: AVATAR_LED circle_pip) — NOT hand-rolled: the
    //    request is stamped through the existing D-ID → Remotion handoff
    //    (avatar-render-orchestrator buildBuyerSlideCompositionRequest →
    //    enqueueAvatarCompositionForProject on completion, whose
    //    target_render_id READER merges the avatar into THIS staged row while
    //    it is still queued, or repoints this section at the avatar-led
    //    replacement once it is not). Best-effort; the photo-PIP render above
    //    is the guaranteed deliverable either way. ──────────────────────────
    try {
      const { resolveAgentNarrationAssets } = await import("@/lib/listing-presentation/section-narration-orchestrator")
      const assets = await resolveAgentNarrationAssets(supabase, pres.agent_user_id)
      if (assets.avatarSource && r.narration.script && agentRecordId) {
        const { buildBuyerSlideCompositionRequest } = await import("@/lib/video/avatar-render-orchestrator")
        const request = buildBuyerSlideCompositionRequest({ presentationId, inputProps })
        if (request) {
          const { error: reqErr } = await supabase.from("ai_video_projects").insert({
            // agents-class id (ai_video_projects.agent_id → agents.id) — the
            // presentation's agent_user_id is USERS class and must not cross.
            agent_id:     agentRecordId,
            brokerage_id: pres.brokerage_id,
            title:        `Buyer consultation slide ${r.section.section_key}`,
            status:       "draft",
            provider_metadata: {
              provider: "did",
              ...request,
              target_render_id: renderId,
              narration_script: r.narration.script,
              did_avatar_id:    assets.avatarSource,
              voice_id:         assets.voiceId,
            },
          })
          if (reqErr) console.warn(`[consultation-render] avatar request refused for '${r.section.section_key}': ${reqErr.message}`)
        }
      }
    } catch { /* avatar is additive — the slide already renders with the photo PIP */ }
  }

  return result
}
