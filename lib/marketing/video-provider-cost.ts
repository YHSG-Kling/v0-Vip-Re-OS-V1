/**
 * lib/marketing/video-provider-cost.ts
 *
 * Wave 60 — cost-aware avatar-video provider choice. D-ID + ElevenLabs (cloned voice)
 * is the platform DEFAULT and the product differentiator. But avatar pricing moves: if
 * D-ID ever becomes more expensive per minute than HeyGen, a brokerage should be able to
 * let the system fall back to HeyGen on COST — HeyGen stays a possible path, never the
 * default. This module is the governed decision:
 *   • Default → the configured provider (D-ID) — behavior is UNCHANGED unless a superadmin
 *     turns on cost-fallback.
 *   • When cost-fallback is enabled AND the alternative is cheaper per minute → switch.
 *
 * The chooser is PURE (unit-tested); resolveVideoProviderCostConfig reads the governed
 * flag + current per-minute prices from global_settings (service-client, brokerage-scoped).
 */
import { createServiceClient } from "@/lib/supabase/service"

export type VideoProvider = "did" | "heygen"

// Conservative industry list prices (per minute of finished avatar video). These are the
// DEFAULTS; a superadmin overrides them in settings as real pricing changes. With these
// defaults HeyGen is pricier than D-ID, so cost-fallback never fires by default.
export const DEFAULT_DID_COST_PER_MIN = 0.30
export const DEFAULT_HEYGEN_COST_PER_MIN = 0.50

export interface VideoCostConfig {
  allowCostFallback:  boolean
  didCostPerMin:      number
  heygenCostPerMin:   number
}

export interface ChooseVideoProviderInput extends VideoCostConfig {
  /** The platform-configured provider (default "did"). */
  configured:        VideoProvider
  estimatedSeconds?: number
}

export interface VideoProviderChoice {
  provider:      VideoProvider
  reason:        "configured" | "cost_fallback_cheaper" | "configured_already_cheapest"
  estimatedCost: number
}

export function estimateVideoCost(perMin: number, seconds: number): number {
  return Math.max(0, perMin) * (Math.max(0, seconds) / 60)
}

/**
 * Pure decision: keep the configured provider unless cost-fallback is enabled and the OTHER
 * provider is strictly cheaper per minute. Never returns the dearer provider when a cheaper
 * one is allowed; never switches when fallback is off.
 */
export function chooseVideoProvider(input: ChooseVideoProviderInput): VideoProviderChoice {
  const seconds = input.estimatedSeconds ?? 30
  const cost = (p: VideoProvider) => estimateVideoCost(p === "did" ? input.didCostPerMin : input.heygenCostPerMin, seconds)

  if (!input.allowCostFallback) {
    return { provider: input.configured, reason: "configured", estimatedCost: cost(input.configured) }
  }
  const other: VideoProvider = input.configured === "did" ? "heygen" : "did"
  if (cost(other) < cost(input.configured)) {
    return { provider: other, reason: "cost_fallback_cheaper", estimatedCost: cost(other) }
  }
  return { provider: input.configured, reason: "configured_already_cheapest", estimatedCost: cost(input.configured) }
}

/** Read the governed cost-fallback config for a brokerage (service-client, no cookie dependency). */
export async function resolveVideoProviderCostConfig(brokerageId: string): Promise<VideoCostConfig> {
  const fallback: VideoCostConfig = {
    allowCostFallback: false,
    didCostPerMin: DEFAULT_DID_COST_PER_MIN,
    heygenCostPerMin: DEFAULT_HEYGEN_COST_PER_MIN,
  }
  if (!brokerageId) return fallback
  try {
    const svc = createServiceClient()
    const { data } = await svc.from("global_settings").select("additional_settings").eq("brokerage_id", brokerageId).maybeSingle()
    const a = (data?.additional_settings ?? {}) as Record<string, unknown>
    return {
      allowCostFallback: a.video_cost_fallback_enabled === true,
      didCostPerMin:     typeof a.did_cost_per_min === "number" ? (a.did_cost_per_min as number) : DEFAULT_DID_COST_PER_MIN,
      heygenCostPerMin:  typeof a.heygen_cost_per_min === "number" ? (a.heygen_cost_per_min as number) : DEFAULT_HEYGEN_COST_PER_MIN,
    }
  } catch {
    return fallback
  }
}
