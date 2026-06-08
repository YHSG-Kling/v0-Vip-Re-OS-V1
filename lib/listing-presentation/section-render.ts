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
import { generateSectionNarration } from "@/lib/listing-presentation/section-narration"
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

export interface RenderSectionsResult { rendered: number; skipped: number }

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

  const { data: pres } = await supabase
    .from("listing_presentations")
    .select("brokerage_id, agent_user_id, property_address")
    .eq("id", presentationId)
    .maybeSingle()
  if (!pres?.brokerage_id) return { rendered, skipped }

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

  return { rendered, skipped }
}
