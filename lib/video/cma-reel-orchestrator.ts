/**
 * lib/video/cma-reel-orchestrator.ts
 *
 * Wave 39 — the "sell before the appointment" CMA-video trigger. Takes the
 * real comps/market data the app assembles, builds the CMAReel chart inputProps
 * (lib/charts/cma-reel-data), and enqueues a Remotion render on the validated
 * composition-render-queue. The drain cron renders it, the coordinator brands +
 * uploads it, and it's publishable to /v/[slug] — an animated, data-driven CMA
 * the agent shares ahead of the listing appointment.
 *
 * Not server-only: the builder is pure + tested; the enqueue uses the service
 * client. Never import from a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import {
  buildCmaReelInputProps,
  type CmaSubject, type CmaComp, type CmaPricePoint, type CmaBrand, type AffordabilityAssumptions,
} from "@/lib/charts/cma-reel-data"

export const CMA_REEL_COMPOSITION_ID = "CMAReel"

export interface EnqueueCmaReelParams {
  brokerageId:    string
  agentUserId?:   string | null
  subject:        CmaSubject
  comparables:    CmaComp[]
  priceHistory?:  CmaPricePoint[]
  brand?:         CmaBrand
  affordability?: AffordabilityAssumptions
  /** Seller-safe market median (drives customer-facing affordability). */
  marketMedianPrice?: number
  /** 'customer' (default, seller-safe) omits the subject value; 'agent' includes it. */
  audience?:      "agent" | "customer"
  /** Optional voiceover track (e.g. ElevenLabs narration of the CMA). */
  voiceoverUrl?:  string | null
  entityType?:    string | null
  entityId?:      string | null
  /** 'api' (default), 'manual', 'cron', 'asset_manager', 'ad_creator'. */
  requestedVia?:  "api" | "manual" | "cron" | "asset_manager" | "ad_creator"
}

export type EnqueueCmaReelResult =
  | { ok: true; renderId: string }
  | { ok: false; error: string }

export async function enqueueCmaReelRender(
  params: EnqueueCmaReelParams,
  client?: ReturnType<typeof createServiceClient>,
): Promise<EnqueueCmaReelResult> {
  if (!params.brokerageId) return { ok: false, error: "brokerageId required" }
  if (!params.subject?.estimatedPrice || params.subject.estimatedPrice <= 0) {
    return { ok: false, error: "subject.estimatedPrice required to render a CMA" }
  }

  const inputProps = buildCmaReelInputProps({
    subject:           params.subject,
    comparables:       params.comparables ?? [],
    priceHistory:      params.priceHistory,
    brand:             params.brand,
    affordability:     params.affordability,
    marketMedianPrice: params.marketMedianPrice,
    audience:          params.audience,
  })
  const voiceoverUrl = params.voiceoverUrl ?? null

  const supabase = client ?? createServiceClient()
  const { data, error } = await supabase
    .from("remotion_composition_renders")
    .insert({
      brokerage_id:    params.brokerageId,
      composition_id:  CMA_REEL_COMPOSITION_ID,
      agent_user_id:   params.agentUserId ?? null,
      entity_type:     params.entityType ?? null,
      entity_id:       params.entityId ?? null,
      used_did_avatar: false,
      used_voiceover:  !!voiceoverUrl,
      render_status:   "queued",
      input_props:     voiceoverUrl ? { ...inputProps, voiceoverUrl } : inputProps,
      scope_type:      "agent",
      scope_id:        params.agentUserId ?? null,
      requested_via:   params.requestedVia ?? "api",
      is_published:    false,
    })
    .select("id")
    .single()

  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  return { ok: true, renderId: (data as { id: string }).id }
}
