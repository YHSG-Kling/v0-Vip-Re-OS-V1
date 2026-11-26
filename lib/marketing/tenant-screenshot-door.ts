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
  capturePublicPropertyPage, captureScreenshot, listScreenshotStillsForUse, ZESTIMATE_SCREENSHOT_USES, screenshotUseAllowed, screenshotUsesFor,
  type CaptureDeps, type CaptureResult, type ScreenshotRefusal, type ScreenshotStillPick, type ScreenshotSubject, type ScreenshotUse,
} from "@/lib/assets/screenshot-capture"
import { classifyPublicPage, estimateSource, DEFAULT_ESTIMATE_SOURCE, ESTIMATE_SOURCE_KEYS, ESTIMATE_STILL_DISCLAIMER, type EstimateSourceKey, type EstimateStillMustShow } from "@/lib/marketing/estimate-sources"

export interface TenantStillRequest {
  /** From the SESSION gate — never a request body. */
  brokerageId: string
  userId: string | null
  source: EstimateSourceKey | string
  address: string
  listingId?: string | null
  // TOMBSTONE (wave 83C, re-read 84B): `alsoForVideo` (80D — tag the still
  // product_video too) stays RETIRED — a Zestimate is never product-video
  // stock. Wave 84B (owner: "only the zillow zestimate screenshot can be used
  // for marketing campaigns including video") gives EVERY tenant Zestimate
  // still marketing_campaign + campaign_video by default
  // (lib/assets/screenshot-uses.ts ZESTIMATE_SCREENSHOT_USES), so no opt-in is
  // needed for the campaign's own video.
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
export function planTenantStill(req: TenantStillRequest): { ok: true; source: NonNullable<ReturnType<typeof estimateSource>>; address: string; uses: ScreenshotUse[]; query: string; label: string; mustShow: readonly EstimateStillMustShow[] } | ScreenshotRefusal {
  if (!req.brokerageId) return { ok: false, reason: "REFUSED: tenant still capture needs the session's brokerage id" }
  const src = estimateSource(req.source)
  // The vocabulary is ONE source (wave 81D — the Zestimate is the only property-page still); the
  // refusal names whatever the vocabulary holds rather than restating it.
  if (!src) return { ok: false, reason: `estimate source "${String(req.source)}" is not one of the sources a tenant may pick (${ESTIMATE_SOURCE_KEYS.join(" | ")})` }
  const address = (req.address ?? "").trim().replace(/\s+/g, " ")
  if (address.length < 6) return { ok: false, reason: "an estimate still needs a street address (6+ characters)" }
  // Marketing campaigns including their video (84B) — the ONE rule's list, never restated.
  const uses: ScreenshotUse[] = [...ZESTIMATE_SCREENSHOT_USES]
  return { ok: true, source: src, address, uses, query: `${address} ${src.searchHint}`.trim(), label: `${src.estimateName} — ${address}`.slice(0, 160), mustShow: src.mustShow }
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
 *  view, so a human can see what is pending). `subject` (85A) narrows to one
 *  kind of still — the Zestimate card asks for "zillow_zestimate", the
 *  public-page card for "general". */
export async function listTenantScreenshotStills(svc: any, brokerageId: string, use: ScreenshotUse | null, opts: { approvedOnly?: boolean; limit?: number; subject?: ScreenshotSubject } = {}): Promise<ScreenshotStillPick[]> {
  if (!brokerageId) return []
  return listScreenshotStillsForUse(svc, use, { brokerageId, approvedOnly: opts.approvedOnly === true, limit: opts.limit, subject: opts.subject })
}

// ── GENERAL PUBLIC-PAGE STILLS (wave 85, lane 85A) ───────────────────────────
// Owner verbatim (2026-09-26): "a public page screenshhot can be more than
// just zillow zestimate page." A tenant may capture ANY public page that is
// not an estimate page — a listing page, its own site or landing page, a
// market / community / news / HOA / school / city / review page — into its
// own marketing assets, PENDING, as general material that serves every use
// once a human approves it on the existing rail. THE ONE classifier
// (lib/marketing/estimate-sources.ts classifyPublicPage) decides first: a
// Zillow page belongs to the Zestimate card above (its readiness rule, its
// address), and another portal's estimate page is refused (its figure stays
// web-searched text). Everything else rides the ONE seam unchanged — robots,
// the per-host rate ceiling, the tenant-scoped URL+day cache, the counted
// insert — plus its public-network guard.

interface TenantPublicPageRequest {
  /** From the SESSION gate — never a request body. */
  brokerageId: string
  userId: string | null
  url: string
  /** What the tenant calls it in its library (optional). */
  label?: string | null
}

/** PURE: validate a tenant's general public-page request before anything runs. */
export function planTenantPublicPageStill(req: TenantPublicPageRequest): { ok: true; url: string; label: string; uses: ScreenshotUse[]; why: string } | ScreenshotRefusal {
  if (!req.brokerageId) return { ok: false, reason: "REFUSED: a public-page capture needs the session's brokerage id" }
  const raw = (req.url ?? "").trim()
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: "a public page capture needs a full web address (https://…)" } }
  const page = classifyPublicPage(u.toString())
  if (page.subject === "zillow_zestimate") return { ok: false, reason: "that is a Zillow page — capture it on the Zestimate card (the property photo and the Zestimate must both show), not as a general public page" }
  if (page.subject !== "general") return { ok: false, reason: `REFUSED: ${page.why}` }
  const uses = screenshotUsesFor("general")
  const label = ((req.label ?? "").trim() || `Public page — ${u.hostname}${u.pathname === "/" ? "" : u.pathname}`).slice(0, 160)
  return { ok: true, url: u.toString(), label, uses, why: page.why }
}

interface TenantPublicPageResult {
  ok: true
  assetId: string
  url: string
  cached: boolean
  sourceUrl: string
  capturedAt: string
  /** ALWAYS "pending" on a fresh capture — a human approves on the rail. */
  approvalStatus: "pending"
  uses: ScreenshotUse[]
}

/** Capture (or return today's cached) general public-page still for the
 *  tenant through the ONE seam. Lands pending in the tenant's own assets. */
export async function captureTenantPublicPageStill(req: TenantPublicPageRequest, deps: CaptureDeps = {}): Promise<TenantPublicPageResult | ScreenshotRefusal> {
  const plan = planTenantPublicPageStill(req)
  if (!plan.ok) return plan
  const r = await captureScreenshot({
    kind: "public_page", url: plan.url, label: plan.label,
    owner: { brokerageId: req.brokerageId, createdBy: req.userId ?? null, uses: plan.uses },
  }, deps)
  if (!r.ok) return r
  return { ok: true, assetId: r.assetId, url: r.url, cached: r.cached, sourceUrl: r.sourceUrl, capturedAt: r.capturedAt, approvalStatus: "pending", uses: plan.uses }
}

/** PURE: the still a campaign may consume — APPROVED only, the ZESTIMATE only
 *  (85A: a general public-page still is never taken for the Zestimate),
 *  matching the source (and the address when one is given), newest first. */
export function pickApprovedStill(stills: readonly ScreenshotStillPick[], want: { source?: string | null; address?: string | null } = {}): ScreenshotStillPick | null {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  return stills.find((s) =>
    s.approvalStatus === "approved" && s.kind === "public_page" && s.subject === "zillow_zestimate"
    && (!want.source || s.estimateSource === want.source)
    && (!want.address || norm(s.address) === norm(want.address)),
  ) ?? null
}

/**
 * DB: the approved still a zestimate_challenge install may use for the
 * tenant — null when none is approved yet (never a pending one, never a
 * fabricated URL). WAVE 84B: `use` picks the campaign surface — the default
 * "marketing_campaign" (postcard / social art) or "campaign_video" (the
 * campaign's own video: lane 84A's video director stages it from here). A use
 * THE ONE RULE refuses for the Zestimate (product_video, demo, training,
 * image_library) returns null without a read.
 */
export async function approvedTenantStill(svc: any, brokerageId: string, want: { source?: string | null; address?: string | null } = {}, use: ScreenshotUse = "marketing_campaign"): Promise<ScreenshotStillPick | null> {
  if (!screenshotUseAllowed("zillow_zestimate", use)) return null
  return pickApprovedStill(await listTenantScreenshotStills(svc, brokerageId, use, { approvedOnly: true, limit: 50, subject: "zillow_zestimate" }), want)
}

// TOMBSTONE (§1.3, wave 83C — owner verbatim: "zestimate is marketing campaigns
// strictly"; wave 84B note below): `tenantScreenshotUrlsForVideo` (80D) staged a tenant's approved
// `use:product_video` stills into ANY video the director commissioned with a
// `screenshot`-treatment composition. Every tenant still is a Zillow/Zestimate
// page (the seam admits no other tenant capture), and a Zestimate still no
// longer carries product_video, so that path could only ever put a Zestimate
// into a non-campaign video — the exact use the ruling forbids. It is deleted
// together with its one caller (lib/video/video-director.ts step 6d). The
// capability that remains lives at app/actions/creative-playbooks.ts
// installCreativePlaybook → createPlaybookVideo({ screenshotUrls }): the
// Zestimate Challenge's OWN campaign video gets its approved still there.
// WAVE 84B: the owner re-ruled ("…marketing campaigns including video"), so a
// CAMPAIGN video may carry the Zestimate — but still never an arbitrary
// screenshot-treatment video. The door for it is approvedTenantStill(…, want,
// "campaign_video") above; the video director's staging is lane 84A's.

export interface EnsureStillOutcome {
  /** "approved" — an approved still exists (url set); "pending" — one exists
   *  or was just captured and awaits a human; "captured" — captured this call
   *  (pending); "refused" — the seam refused (reason set); "no_address" —
   *  nothing to capture for. */
  state: "approved" | "pending" | "captured" | "refused" | "no_address"
  assetId: string | null
  url: string | null
  /** 84B — the approved still's uses (∩ THE ONE RULE); [] unless approved. The
   *  campaign's video takes the still only when this includes campaign_video. */
  uses: ScreenshotUse[]
  /** 84B — the Zestimate a human confirmed off the approved still (whole USD),
   *  with its capture time; null when unconfirmed. Zestimate Challenge copy
   *  may quote it as ZILLOW's figure (creative-playbooks.ts zestimateFigureBrief). */
  figureUsd: number | null
  capturedAt: string | null
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
  if (address.length < 6) return { state: "no_address", assetId: null, url: null, uses: [], figureUsd: null, capturedAt: null, reason: "no listing address to capture an estimate still for", source: src.key }
  const have = await listTenantScreenshotStills(args.svc, args.brokerageId, "marketing_campaign", { limit: 50, subject: "zillow_zestimate" })
  const approved = pickApprovedStill(have, { source: src.key, address })
  if (approved) return { state: "approved", assetId: approved.id, url: approved.url, uses: approved.uses, figureUsd: approved.confirmedFigureUsd ?? null, capturedAt: approved.capturedAt, reason: null, source: src.key }
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  const pending = have.find((s) => s.approvalStatus === "pending" && s.estimateSource === src.key && norm(s.address) === norm(address))
  if (pending) return { state: "pending", assetId: pending.id, url: null, uses: [], figureUsd: null, capturedAt: null, reason: "a still is already awaiting approval", source: src.key }
  const r = await captureTenantEstimateStill({ brokerageId: args.brokerageId, userId: args.userId, source: src.key, address, listingId: args.listingId ?? null }, { ...deps, svc: args.svc })
  if (!r.ok) return { state: "refused", assetId: null, url: null, uses: [], figureUsd: null, capturedAt: null, reason: r.reason, source: src.key }
  return { state: "captured", assetId: r.assetId, url: null, uses: [], figureUsd: null, capturedAt: null, reason: null, source: src.key }
}

export type { CaptureResult, CaptureDeps }
