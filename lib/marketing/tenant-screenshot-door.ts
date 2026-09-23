// lib/marketing/tenant-screenshot-door.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT DOOR onto the screenshot seam (wave 80, lane 80D — owner
// verbatim: "tenant can pick zestimate & co. I believe we have already coded
// for a screenshot of a zestimate as a campaign. screenshots can be used by
// tenants.").
//
// ALREADY EXISTED — REUSED, never rebuilt:
//   · lib/assets/screenshot-capture.ts — THE seam: captureScreenshot /
//     capturePublicPropertyPage (robots.txt, host allowlist, per-host rate
//     ceiling, URL+day cache, source + captured_at on the row), SCREENSHOT_USES
//     (`use:<x>` tags), listScreenshotStillsForUse, setScreenshotUses. This
//     lane taught it an OWNER (a tenant's brokerage) so the SAME entry writes
//     a brokerage-scoped row instead of a platform one; nothing here launches
//     a browser, hosts a file or writes a second row shape.
//   · lib/marketing/creative-playbooks.ts zestimate_challenge — the campaign
//     the still is FOR (its own whyItWorks line: "their online estimate
//     framing the background"); app/actions/creative-playbooks.ts installs it
//     and now (this lane) ensures a still exists and consumes the approved one.
//   · app/actions/marketing-studio.ts approveAsset / rejectAsset — the
//     tenant's EXISTING marketing_assets approval rail (brand compliance +
//     tenant predicate). A still lands `pending` and a human flips it there.
//   · app/actions/marketing/image-library.ts listImageLibraryAction — the
//     union picker every tenant creative surface already reads: an APPROVED
//     brokerage image row is already in it, so an approved still joins the
//     tenant's pickers with no second list.
//   · lib/auth/require-caller.ts requireTenantAdminOrSoloOwner — the tenant
//     gate (the SAME door marketing-ai-approvals uses). The PLATFORM door,
//     lib/auth/platform-guard.ts requireMarketing, is never imported here.
//
// RULES CARRIED, NOT RESTATED: ToS-aware (the seam's robots/allowlist/rate
// gates run unchanged; the search is narrowed to the ONE host of the chosen
// source), PENDING APPROVAL always, and NEVER A CUSTOMER-FACING VALUE — no
// customer-facing module imports this file (the proof's specimen-controlled
// scan), nothing reads text off the page, every pick carries
// customerFacingValue: false, and the number on the still is the portal's
// own, shown whole, with ESTIMATE_STILL_DISCLAIMER beside it.
//
// Every DB-touching dependency is imported lazily so the pure parts load
// under tsx for the proof; nothing here makes a model call.

import {
  capturePublicPropertyPage, listScreenshotStillsForUse, SCREENSHOT_USES,
  type CaptureDeps, type CaptureResult, type ScreenshotRefusal, type ScreenshotStillPick, type ScreenshotUse,
} from "@/lib/assets/screenshot-capture"
import { estimateSource, DEFAULT_ESTIMATE_SOURCE, ESTIMATE_STILL_DISCLAIMER, type EstimateSourceKey } from "@/lib/marketing/estimate-sources"

export interface TenantStillRequest {
  /** From the SESSION gate — never a request body. */
  brokerageId: string
  userId: string | null
  source: EstimateSourceKey | string
  address: string
  listingId?: string | null
  /** marketing_campaign is always on; product_video is the tenant's choice. */
  alsoForVideo?: boolean
}

export interface TenantStillResult {
  ok: true
  assetId: string
  url: string
  cached: boolean
  source: EstimateSourceKey
  sourceUrl: string
  capturedAt: string
  /** ALWAYS "pending" on a fresh capture — a human approves on the rail. */
  approvalStatus: "pending"
  uses: ScreenshotUse[]
  disclaimer: string
  customerFacingValue: false
}

/** PURE: validate a tenant request before anything runs. */
export function planTenantStill(req: TenantStillRequest): { ok: true; source: NonNullable<ReturnType<typeof estimateSource>>; address: string; uses: ScreenshotUse[]; query: string; label: string } | ScreenshotRefusal {
  if (!req.brokerageId) return { ok: false, reason: "REFUSED: tenant still capture needs the session's brokerage id" }
  const src = estimateSource(req.source)
  if (!src) return { ok: false, reason: `estimate source "${String(req.source)}" is not one of the sources a tenant may pick (zillow_zestimate | realtor_estimate | redfin_estimate | homes_estimate)` }
  const address = (req.address ?? "").trim().replace(/\s+/g, " ")
  if (address.length < 6) return { ok: false, reason: "an estimate still needs a street address (6+ characters)" }
  const uses: ScreenshotUse[] = SCREENSHOT_USES.filter((u) => u === "marketing_campaign" || (u === "product_video" && req.alsoForVideo === true))
  return { ok: true, source: src, address, uses, query: `${address} ${src.searchHint}`.trim(), label: `${src.estimateName} — ${address}`.slice(0, 160) }
}

/**
 * Capture (or return today's cached) estimate still for the tenant. Rides the
 * ONE seam with the ONE search tool restricted to the chosen source's host.
 * The row lands in the tenant's marketing assets, pending approval.
 */
export async function captureTenantEstimateStill(req: TenantStillRequest, deps: Parameters<typeof capturePublicPropertyPage>[1] = {}): Promise<TenantStillResult | ScreenshotRefusal> {
  const plan = planTenantStill(req)
  if (!plan.ok) return plan
  const r = await capturePublicPropertyPage(plan.query, deps, {
    domains: [plan.source.host],
    request: {
      label: plan.label,
      owner: {
        brokerageId: req.brokerageId,
        createdBy: req.userId ?? null,
        uses: plan.uses,
        provenance: { estimate_source: plan.source.key, address: plan.address, listing_id: req.listingId ?? null, disclaimer: ESTIMATE_STILL_DISCLAIMER },
      },
    },
  })
  if (!r.ok) return r
  return {
    ok: true, assetId: r.assetId, url: r.url, cached: r.cached, source: plan.source.key, sourceUrl: r.sourceUrl, capturedAt: r.capturedAt,
    approvalStatus: "pending", uses: plan.uses, disclaimer: ESTIMATE_STILL_DISCLAIMER, customerFacingValue: false,
  }
}

/** The tenant's own stills for a use (every approval state — the picker's
 *  view, so a human can see what is pending). */
export async function listTenantScreenshotStills(svc: any, brokerageId: string, use: ScreenshotUse, opts: { approvedOnly?: boolean; limit?: number } = {}): Promise<ScreenshotStillPick[]> {
  if (!brokerageId) return []
  return listScreenshotStillsForUse(svc, use, { brokerageId, approvedOnly: opts.approvedOnly === true, limit: opts.limit })
}

/** PURE: the still a campaign may consume — APPROVED only, matching the
 *  source (and the address when one is given), newest first. */
export function pickApprovedStill(stills: readonly ScreenshotStillPick[], want: { source?: string | null; address?: string | null } = {}): ScreenshotStillPick | null {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  return stills.find((s) =>
    s.approvalStatus === "approved" && s.kind === "public_page"
    && (!want.source || s.estimateSource === want.source)
    && (!want.address || norm(s.address) === norm(want.address)),
  ) ?? null
}

/**
 * DB: the approved still a zestimate_challenge install may use for the
 * tenant — null when none is approved yet (never a pending one, never a
 * fabricated URL).
 */
export async function approvedTenantStill(svc: any, brokerageId: string, want: { source?: string | null; address?: string | null } = {}): Promise<ScreenshotStillPick | null> {
  return pickApprovedStill(await listTenantScreenshotStills(svc, brokerageId, "marketing_campaign", { approvedOnly: true, limit: 50 }), want)
}

/** DB: the approved tenant stills a video producer stages as
 *  input_props.screenshotUrls for the `screenshot` body treatment. */
export async function tenantScreenshotUrlsForVideo(svc: any, brokerageId: string, limit = 6): Promise<string[]> {
  return (await listTenantScreenshotStills(svc, brokerageId, "product_video", { approvedOnly: true, limit })).map((s) => s.url)
}

export interface EnsureStillOutcome {
  /** "approved" — an approved still exists (url set); "pending" — one exists
   *  or was just captured and awaits a human; "captured" — captured this call
   *  (pending); "refused" — the seam refused (reason set); "no_address" —
   *  nothing to capture for. */
  state: "approved" | "pending" | "captured" | "refused" | "no_address"
  assetId: string | null
  url: string | null
  reason: string | null
  source: EstimateSourceKey
}

/**
 * AUTONOMOUS (owner: "when a zestimate_challenge campaign is generated … and
 * no still exists, the OS captures one and queues approval"). Idempotent per
 * tenant × source × address: an approved still is used, a pending one is
 * left for the human, and only when NEITHER exists is a capture made — into
 * the pending queue, never straight into the campaign.
 */
export async function ensureZestimateChallengeStill(
  args: { svc: any; brokerageId: string; userId: string | null; address: string | null | undefined; listingId?: string | null; source?: EstimateSourceKey | string | null },
  deps: Parameters<typeof capturePublicPropertyPage>[1] = {},
): Promise<EnsureStillOutcome> {
  const src = estimateSource(args.source) ?? estimateSource(DEFAULT_ESTIMATE_SOURCE)!
  const address = (args.address ?? "").trim()
  if (address.length < 6) return { state: "no_address", assetId: null, url: null, reason: "no listing address to capture an estimate still for", source: src.key }
  const have = await listTenantScreenshotStills(args.svc, args.brokerageId, "marketing_campaign", { limit: 50 })
  const approved = pickApprovedStill(have, { source: src.key, address })
  if (approved) return { state: "approved", assetId: approved.id, url: approved.url, reason: null, source: src.key }
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  const pending = have.find((s) => s.approvalStatus === "pending" && s.estimateSource === src.key && norm(s.address) === norm(address))
  if (pending) return { state: "pending", assetId: pending.id, url: null, reason: "a still is already awaiting approval", source: src.key }
  const r = await captureTenantEstimateStill({ brokerageId: args.brokerageId, userId: args.userId, source: src.key, address, listingId: args.listingId ?? null, alsoForVideo: true }, { ...deps, svc: args.svc })
  if (!r.ok) return { state: "refused", assetId: null, url: null, reason: r.reason, source: src.key }
  return { state: "captured", assetId: r.assetId, url: null, reason: null, source: src.key }
}

export type { CaptureResult, CaptureDeps }
