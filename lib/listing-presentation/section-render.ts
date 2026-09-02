/**
 * lib/listing-presentation/section-render.ts
 *
 * Wave 39 — turns the CMA section of the pre-listing drip into an ANIMATED,
 * seller-safe CMAReel video (graphics/animation that sells the market + the
 * team before the appointment). Pulls the real comparables from the CMA report
 * linked to the presentation's contact, builds SELLER-SAFE CMAReel inputProps
 * (default 'customer' audience — the home's value is NEVER shown), enqueues the
 * render on the validated queue, and attaches the render to the CMA section.
 *
 * Not server-only: uses the service client + the pure builder. Never import
 * from a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { enqueueCmaReelRender } from "@/lib/video/cma-reel-orchestrator"
import {
  generateSectionNarration,
  sectionNarrationBudget,
  SECTION_NARRATION_COMPOSITION,
} from "@/lib/listing-presentation/section-narration"
import { resolveMarketingSystem } from "@/lib/listing-presentation/marketing-system-resolver"
import { missingContentProps, describeMissingContent } from "@/lib/remotion/content-contract"
import type { CmaComp } from "@/lib/charts/cma-reel-data"

export type SectionRenderResult =
  | { ok: true; renderId: string }
  | { ok: false; skipped: string }

export async function renderCmaSectionForPresentation(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<SectionRenderResult> {
  const supabase = client ?? createServiceClient()

  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, agent_user_id, contact_id, property_address")
    .eq("id", presentationId)
    .maybeSingle()
  if (!pres || !pres.brokerage_id) return { ok: false, skipped: "presentation not found" }
  if (!pres.contact_id) return { ok: false, skipped: "presentation has no contact" }

  // Latest CMA report for this seller → its comparables.
  const { data: cma } = await supabase
    .from("cma_reports")
    .select("id")
    .eq("contact_id", pres.contact_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!cma?.id) return { ok: false, skipped: "no CMA report for this contact" }

  const { data: rows } = await supabase
    .from("cma_comparables")
    .select("address, sale_price, list_price, adjusted_price, days_on_market")
    .eq("cma_id", cma.id)
    .limit(8)
  const comparables: CmaComp[] = (rows ?? []).map((r: any) => ({
    address:        r.address,
    sale_price:     r.sale_price,
    list_price:     r.list_price,
    adjusted_price: r.adjusted_price,
    days_on_market: r.days_on_market,
  }))
  if (comparables.length === 0) return { ok: false, skipped: "no comparables to render" }

  // Market median from comparable SALE prices (public market fact — never the
  // subject's valuation). Drives the seller-safe affordability donut.
  const saleish = comparables
    .map((c) => Number(c.adjusted_price ?? c.sale_price ?? c.list_price ?? 0))
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  const marketMedian = saleish.length ? saleish[Math.floor(saleish.length / 2)] : 0
  if (marketMedian <= 0) return { ok: false, skipped: "no usable comparable prices" }

  // enqueueCmaReelRender builds with the DEFAULT 'customer' audience → the
  // subject value is omitted and affordability uses the market median, so this
  // render is seller-safe by construction.
  const enq = await enqueueCmaReelRender(
    {
      brokerageId:       pres.brokerage_id,
      agentUserId:       pres.agent_user_id ?? null,
      subject:           { address: pres.property_address ?? "Your Home", areaName: "", estimatedPrice: marketMedian },
      comparables,
      marketMedianPrice: marketMedian,
      entityType:        "listing_presentation",
      entityId:          presentationId,
      requestedVia:      "cron",
    },
    supabase,
  )
  if (!enq.ok) return { ok: false, skipped: enq.error }

  // Attach the render to the CMA section so the drip delivers a video.
  await supabase
    .from("presentation_sections")
    .update({ render_id: enq.renderId })
    .eq("presentation_id", presentationId)
    .eq("section_key", "cma")

  return { ok: true, renderId: enq.renderId }
}

export interface RenderSectionsResult {
  rendered: number
  /** Sections that did not get a render: CMA-section skips, insert refusals, AND the contract refusals below. */
  skipped: number
  /** The subset of `skipped` refused by the content contract BEFORE any row was staged. */
  refused: number
  /** One line per refusal — `<section_key>: <describeMissingContent>` — so the count is never silent. */
  refusals: string[]
}

/**
 * Render EVERY section of a presentation: the CMA section as a CMAReel data
 * video (seller-safe), and the others (intro/credibility/marketing/process/
 * closing/market) as branded ListingSectionReel slides. Each render's id is
 * attached to its section so the drip delivers an animated video, not text.
 * Idempotent-ish: a section that already has a render_id is left alone.
 */
export async function renderSectionsForPresentation(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<RenderSectionsResult> {
  const supabase = client ?? createServiceClient()

  // CMA section → data-chart reel (handles its own comps fetch + seller-safety).
  const cmaRes = await renderCmaSectionForPresentation(presentationId, supabase)
  let rendered = cmaRes.ok ? 1 : 0
  let skipped = cmaRes.ok ? 0 : 1
  let refused = 0
  const refusals: string[] = []
  // enqueueCmaReelRender now refuses by contract (comps / daysOnMarket) and
  // reports the sentence as `error`; carry it here so the CMA section's
  // refusal is as visible as any other section's.
  if (!cmaRes.ok && /was not given .* content prop/.test(cmaRes.skipped)) {
    refused += 1
    refusals.push(`cma: ${cmaRes.skipped}`)
  }

  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("brokerage_id, agent_user_id, property_address")
    .eq("id", presentationId)
    .maybeSingle()
  if (!pres?.brokerage_id) return { rendered, skipped, refused, refusals }

  // Resolve the agent's display name + their own "take" (for the narration).
  let agentName = "Your Agent"
  let agentTake: string | null = null
  if (pres.agent_user_id) {
    const { data: u } = await supabase.from("users").select("first_name, last_name, presentation_take").eq("id", pres.agent_user_id).maybeSingle()
    const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
    if (full) agentName = full
    agentTake = (u as any)?.presentation_take ?? null
  }
  const areaName = (pres.property_address ?? "").split(",").slice(1).join(",").trim() || null

  const { data: brk } = await supabase
    .from("brokerages")
    .select("name, logo_url, license_number, license_state")
    .eq("id", pres.brokerage_id)
    .maybeSingle()
  const brand = {
    primaryColor:  "#0F172A",
    accentColor:   "#F59E0B",
    brokerageName: (brk as any)?.name ?? "Your Brokerage",
    logoUrl:       (brk as any)?.logo_url ?? undefined,
    licenseLine:   [(brk as any)?.license_number, (brk as any)?.license_state].filter(Boolean).join(" · ") || undefined,
    showEhoMark:   true,
  }

  // WHAT THIS BROKERAGE CAN ACTUALLY CLAIM, resolved ONCE for the whole
  // presentation (it is a property of the tenant + agent, not of the section).
  //
  // This is the writer that never existed. `AINarrationInput.marketingSystem`
  // has been an input nothing set since it was declared, so its hardcoded
  // fallback — six capability claims — was spoken to every seller of every
  // tenant regardless of plan or account state. The owner ruled the marketing
  // system is part of the listing presentation and part of ADVERTISEMENT and so
  // must be an active function; this call is that function reaching the prompt.
  // See lib/listing-presentation/marketing-system.ts for the claim catalogue and
  // the tombstone in section-narration.ts for what was retired.
  //
  // The budget is derived from the composition these sections actually render on
  // (ListingSectionReel), so the claim list is packed to what the video can
  // speak — a claim that would be trimmed mid-sentence is withheld from the
  // prompt instead.
  const narrationBudgetForSections = sectionNarrationBudget(SECTION_NARRATION_COMPOSITION)
  const marketing = await resolveMarketingSystem(supabase, {
    brokerageId: pres.brokerage_id,
    agentUserId: pres.agent_user_id ?? null,
    budget:      narrationBudgetForSections,
  })

  const { data: sections } = await supabase
    .from("presentation_sections")
    .select("section_key, title, render_id")
    .eq("presentation_id", presentationId)
    .order("section_order")
  const list = (sections ?? []) as Array<{ section_key: string; title: string | null; render_id: string | null }>
  const total = list.length

  for (const s of list) {
    if (s.section_key === "cma") continue           // already handled above
    if (s.render_id) { continue }                   // already rendered
    // The narration script drives the on-screen bullets AND the avatar/voice
    // clone's words (TTS reads narration.script). AI-generated (weaving the
    // marketing system + the agent's own take), seller-safe, with a
    // deterministic fallback if the AI is unavailable.
    const narration = await generateSectionNarration({
      sectionKey:    s.section_key,
      brokerageName: brand.brokerageName,
      agentName,
      areaName,
      agentTake,
      marketingSystem: marketing.text,
      // ── WHO IS ON THE HOOK, AND WHAT THE ESCALATION FILES UNDER ───────────
      // §5's other half. A HARD fair-housing hit in a script destined for the
      // agent's CLONED VOICE withholds the model's text (correct) and must put
      // a person on it. It could not: this call supplied no actor, so every
      // hard hit took section-narration.ts's "NO HUMAN WAS SUMMONED" branch,
      // and even with an actor the escalation opened the SESSION client while
      // this whole lane runs cron → section-drip → section-render under the
      // SERVICE client, where video_scripts_library's
      // `brokerage_id = current_user_brokerage_id()` policy refuses the insert.
      //
      // BOTH HALVES COME OFF THE ROW THE CRON ALREADY LOADED, so neither is a
      // free parameter (§4): `listing_presentations.brokerage_id` (FK
      // brokerages(id)) is the tenant, and `listing_presentations.agent_user_id`
      // is the actor — USERS-class by its FK `agent_user_id → users(id)`, which
      // is the class ScriptComplianceActor.userId wants. `agents.id` is a
      // DISJOINT space (§3) and is never substituted here; the escalation does
      // the users→agents cross itself, inside the tenancy proof.
      //
      // Null when the presentation names no agent — reported LOUDLY by the
      // narration's own branch rather than silently treated as "nothing to
      // file". `escalationClient` turns on proveActorTenancy in the escalation,
      // because a service client bypasses the RLS that was the tenancy check.
      escalationActor: pres.agent_user_id
        ? { userId: pres.agent_user_id as string, brokerageId: pres.brokerage_id as string }
        : null,
      escalationClient: supabase,
    })
    const inputProps: Record<string, unknown> = {
      sectionKey:      s.section_key,
      title:           s.title ?? "Your Listing Plan",
      bullets:         narration.bullets,
      narrationScript: narration.script,
      agentName,
      avatarVideoUrl: null,
      voiceoverUrl:   null,
      totalSlides: total,
      brand,
      // ── THE HOLD TRAVELS WITH THE RENDER, NOT ONLY INTO A LOG ─────────────
      // §1: `SectionNarration.notes / heldForReview / reviewId` had a producer
      // and no reader — the disposition died in a local variable while the row
      // went to the queue looking like any other section. Staged here so the
      // narration orchestrator, the drip and anyone reading
      // remotion_composition_renders.input_props can all see that this
      // section's model script was WITHHELD and which video_scripts_library row
      // a human now owns. Only written when there is something to say, so an
      // ordinary section's props are byte-identical to before.
      ...(narration.notes?.length ? { narrationNotes: narration.notes } : {}),
      ...(narration.heldForReview ? { narrationHeldForReview: true } : {}),
      ...(narration.reviewId ? { narrationReviewId: narration.reviewId } : {}),
    }
    // THE CONTENT GATE, before the insert. `bullets` is the pitch and the
    // contract requires it; a narration whose bullets came back empty (a held
    // script, a thin fallback) used to be staged anyway, the backstop cancelled
    // the row, and this function counted it as `rendered` and attached the
    // cancelled render_id to the section — so the drip delivered nothing and
    // the section looked handled. Refused by NAME and counted instead; the
    // section keeps render_id null and drips as a card, which is honest.
    const missing = missingContentProps("ListingSectionReel", inputProps)
    if (missing.length > 0) {
      const reason = describeMissingContent("ListingSectionReel", missing)
      console.warn(`[section-render] ${presentationId} section ${s.section_key} skipped — ${reason}`)
      skipped++; refused++; refusals.push(`${s.section_key}: ${reason}`)
      continue
    }
    const { data: render, error } = await supabase
      .from("remotion_composition_renders")
      .insert({
        brokerage_id:    pres.brokerage_id,
        composition_id:  "ListingSectionReel",
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
    if (error || !render) { skipped++; continue }
    await supabase.from("presentation_sections")
      .update({ render_id: (render as { id: string }).id })
      .eq("presentation_id", presentationId).eq("section_key", s.section_key)
    rendered++
  }

  return { rendered, skipped, refused, refusals }
}
