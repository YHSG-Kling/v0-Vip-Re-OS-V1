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
