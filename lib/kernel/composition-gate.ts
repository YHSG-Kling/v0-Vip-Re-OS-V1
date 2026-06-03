/**
 * lib/kernel/composition-gate.ts
 *
 * Wave 26 — generalize the Wave 21 newsletter composition gate into a
 * cross-channel asset-readiness check. Every channel publisher (newsletter,
 * listing-promo, podcast, direct-mail, landing-pages) needs the same gating
 * logic before fanout:
 *
 *   1. Is the render ledger row 'completed' AND has the artifact URL?
 *   2. Are we still inside a grace window past send_date?
 *
 * Newsletter Wave 21 hard-coded those checks against
 * newsletter_video_renders + newsletter_campaigns.send_date. This module
 * abstracts the same shape so new channels register their (ledger_table,
 * url_column, status_column) once and inherit the same defer-vs-skip
 * decision tree.
 *
 * Decisions returned by `checkAssetReadiness`:
 *
 *   "ready"     — proceed to publish, URL is set.
 *   "wait"      — render is in flight AND we're inside grace window; the
 *                 next cron tick should pick it up unchanged.
 *   "defer"     — render is past grace window or failed; the channel's
 *                 publish loop should mark the campaign deferred with the
 *                 returned reason string.
 *   "not_staged"— no ledger row exists yet AND past grace window; this is
 *                 a staging-cron failure the agent needs to see.
 *
 * The shape mirrors the existing newsletter behavior so the migration is
 * mechanical: replace the inline check at publish-newsletters with a single
 * call to checkAssetReadiness(...).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type AssetReadinessDecision =
  | { kind: "ready";       url: string }
  | { kind: "wait";        reason: string }
  | { kind: "defer";       reason: string }
  | { kind: "not_staged";  reason: string }

export interface AssetReadinessConfig {
  /** Render ledger table name (e.g. "newsletter_video_renders", "ai_video_projects"). */
  ledgerTable:      string
  /** FK column on the ledger that points to the campaign/asset id. */
  ledgerForeignKey: string
  /** Column on the ledger that stores the final artifact URL. */
  urlColumn:        string
  /** Column on the ledger that stores the lifecycle status. Must follow
   *  the enum: queued | rendering | completed | failed (mirrors the
   *  newsletter_video_renders / ai_video_projects shape). */
  statusColumn:     string
  /** Grace window in milliseconds. When the campaign's send_date is more
   *  than this much in the past AND the render isn't completed, defer
   *  instead of wait. Newsletter uses 2h; listing-promo can use 4h for
   *  the longer Remotion + D-ID hybrid render. */
  gracePeriodMs:    number
}

export interface CheckAssetReadinessInput {
  /** The campaign/asset row's id (e.g. newsletter_campaigns.id, listings.id). */
  assetId:        string
  /** When set, used for the grace-window calculation. NULL is treated as
   *  "no grace window expected" → never defers for grace-window reasons. */
  sendDate:       string | null
  config:         AssetReadinessConfig
}

export async function checkAssetReadiness(
  input: CheckAssetReadinessInput,
): Promise<AssetReadinessDecision> {
  const { assetId, sendDate, config } = input
  const svc = createServiceClient()

  const { data: ledger } = await svc
    .from(config.ledgerTable)
    .select(`${config.urlColumn}, ${config.statusColumn}`)
    .eq(config.ledgerForeignKey, assetId)
    .maybeSingle()

  // Code-review pass 2 — NULL send_date is treated as "no grace window
  // expected" → we never defer for grace-window reasons. The Wave 21
  // behavior was to compute Date.now() - NaN < N which evaluates to
  // false, causing immediate defer; this fix preserves the in-flight
  // path for rows without a date.
  const sendDateMs = sendDate ? Date.parse(sendDate) : null
  const inGraceWindow = sendDateMs === null
    || (Date.now() - sendDateMs < config.gracePeriodMs)

  const row = ledger as Record<string, unknown> | null
  if (!row) {
    if (!inGraceWindow) {
      return { kind: "not_staged", reason: "render:not_staged_past_grace_window" }
    }
    return { kind: "wait", reason: "render:awaiting_kickoff" }
  }

  const status = row[config.statusColumn] as string | null
  const url    = row[config.urlColumn] as string | null

  if (status === "failed") {
    return { kind: "defer", reason: "render:failed" }
  }
  if (status !== "completed" || !url) {
    if (!inGraceWindow) {
      return { kind: "defer", reason: `render:${status ?? "unknown"}_past_grace_window` }
    }
    return { kind: "wait", reason: `render:${status ?? "unknown"}` }
  }
  return { kind: "ready", url }
}

/** Pre-configured asset surfaces. Add a new entry when a channel onboards
 *  its render pipeline; consumers reference the constant instead of
 *  inlining the table shape. */
export const ASSET_READINESS_CONFIGS = {
  newsletter_video: {
    ledgerTable:      "newsletter_video_renders",
    ledgerForeignKey: "newsletter_campaign_id",
    urlColumn:        "video_url",
    statusColumn:     "status",
    gracePeriodMs:    2 * 60 * 60 * 1000,        // 2h
  } satisfies AssetReadinessConfig,

  listing_promo_video: {
    ledgerTable:      "ai_video_projects",
    ledgerForeignKey: "listing_id",
    urlColumn:        "video_url",
    statusColumn:     "status",
    gracePeriodMs:    4 * 60 * 60 * 1000,        // 4h — Remotion+D-ID hybrid
  } satisfies AssetReadinessConfig,
} as const
