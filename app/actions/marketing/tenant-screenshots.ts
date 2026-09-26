"use server"

// app/actions/marketing/tenant-screenshots.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT'S HUMAN DOOR onto the screenshot seam (wave 80, lane 80D — owner:
// "tenant can pick zestimate & co. … screenshots can be used by tenants").
// The platform door (app/actions/superadmin/screenshot-capture.ts, gated by
// requireMarketing) captures for the PLATFORM library; this one captures for
// the caller's OWN brokerage. Gate first — requireTenantAdminOrSoloOwner, the
// SAME tenant door app/actions/marketing-ai-approvals.ts uses, tenant from the
// SESSION (CLAUDE.md §4) — then the service client. Every export is a public
// endpoint and is async.
//
// Approval never happens here: a still lands `pending` and the tenant's
// EXISTING marketing_assets rail (app/actions/marketing-studio.ts approveAsset
// / rejectAsset) is the human stop — the UI card calls those directly.
// Nothing here reads a value off a captured page.

import { createServiceClient } from "@/lib/supabase/service"
import { requireTenantAdminOrSoloOwner } from "@/lib/auth/require-caller"
import { SCREENSHOT_USES, setScreenshotUses, type ScreenshotStillPick, type ScreenshotUse } from "@/lib/assets/screenshot-capture"
import { captureTenantEstimateStill, listTenantScreenshotStills } from "@/lib/marketing/tenant-screenshot-door"
import { ESTIMATE_SOURCES, ESTIMATE_STILL_DISCLAIMER, type EstimateSourceKey } from "@/lib/marketing/estimate-sources"

type CaptureActionResult =
  | { ok: true; assetId: string; url: string; cached: boolean; source: EstimateSourceKey; approvalStatus: "pending"; disclaimer: string }
  | { ok: false; error: string }

/** The closed source vocabulary with its ToS notes — what the picker shows. */
export async function listEstimateSourcesAction(): Promise<{ ok: true; sources: Array<{ key: EstimateSourceKey; label: string; host: string; tosNote: string }>; disclaimer: string } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  return { ok: true, sources: ESTIMATE_SOURCES.map((s) => ({ key: s.key, label: s.label, host: s.host, tosNote: s.tosNote })), disclaimer: ESTIMATE_STILL_DISCLAIMER }
}

/** Capture (or return today's cached) estimate still for the caller's
 *  brokerage — source + address picked by the tenant; the tenant itself is
 *  the session's. Lands pending. */
export async function captureEstimateStillAction(input: { source: string; address: string; listingId?: string | null }): Promise<CaptureActionResult> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const r = await captureTenantEstimateStill(
    { brokerageId: auth.brokerageId, userId: auth.userId, source: input.source, address: input.address, listingId: input.listingId ?? null },
    { svc: createServiceClient() },
  )
  return r.ok
    ? { ok: true, assetId: r.assetId, url: r.url, cached: r.cached, source: r.source, approvalStatus: r.approvalStatus, disclaimer: r.disclaimer }
    : { ok: false, error: r.reason }
}

/** The caller's brokerage's own stills for a use, every approval state. */
export async function listTenantScreenshotStillsAction(input: { use: ScreenshotUse }): Promise<{ ok: true; stills: ScreenshotStillPick[] } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!(SCREENSHOT_USES as readonly string[]).includes(input.use)) return { ok: false, error: `screenshot use "${String(input.use)}" is not one of ${SCREENSHOT_USES.join("/")}` }
  return { ok: true, stills: await listTenantScreenshotStills(createServiceClient(), auth.brokerageId, input.use) }
}

// ── THE ESTIMATE COMPARISON PIECE (wave 82D; 83C web search) ─────────────────
// Same gate, same session tenant, same approval rail. Gather (the Zillow still
// + an AI web search for realtor.com / redfin / homes.com — no screenshot of
// those sites) → approve each on the existing approveAsset → (Zillow: confirm
// the figure the still shows; a search that found nothing: type the figure) →
// compose. Nothing here states a value to a customer.

type ComparisonEvidenceView = { assetId: string; source: string; label: string; url: string | null; approvalStatus: string | null; capturedAt: string | null; confirmedFigureUsd: number | null; posture: string; via: string; tosNote: string }

/** Gather every comparison source for an address (pending, per-source outcome;
 *  `fallback` marks a site the search could not read — type its figure). */
export async function captureEstimateComparisonAction(input: { address: string; listingId?: string | null }): Promise<{ ok: true; outcomes: Array<{ source: string; ok: boolean; via: string; note?: string; reason?: string; fallback?: boolean }> } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const { gatherEstimateComparisonEvidence } = await import("@/lib/marketing/estimate-comparison")
  const r = await gatherEstimateComparisonEvidence({ svc: createServiceClient(), brokerageId: auth.brokerageId, userId: auth.userId, address: input.address, listingId: input.listingId ?? null })
  if (!r.ok) return { ok: false, error: r.reason }
  return { ok: true, outcomes: r.outcomes.map((o) => (o.ok ? { source: o.source, ok: true, via: o.via, note: o.note } : { source: o.source, ok: false, via: o.via, reason: o.reason, fallback: o.fallback })) }
}

/** THE FALLBACK (83C): the web search found nothing for a site, so a person
 *  types the figure it shows (optionally its page link). Territory-gated,
 *  lands pending on the same rail. */
export async function typeComparisonFigureAction(input: { address: string; source: string; figure: string | number; sourceUrl?: string | null }): Promise<{ ok: true; assetId: string; figureUsd: number } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (typeof input.source !== "string" || !input.source) return { ok: false, error: "source required" }
  const { recordTypedComparisonFigure } = await import("@/lib/marketing/estimate-web-search")
  const r = await recordTypedComparisonFigure({ svc: createServiceClient(), brokerageId: auth.brokerageId, userId: auth.userId, address: input.address, source: input.source, figure: input.figure, sourceUrl: input.sourceUrl ?? null })
  return r.ok ? r : { ok: false, error: r.reason }
}

/** The caller's comparison evidence for an address, every approval state: the
 *  Zillow still (shown to the approving human) and the staged web / typed
 *  figures with their source links — never pixels of the other portals. */
export async function listEstimateComparisonAction(input: { address: string }): Promise<{ ok: true; evidence: ComparisonEvidenceView[] } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const { listComparisonEvidence } = await import("@/lib/marketing/estimate-comparison")
  const { comparisonEstimateSource } = await import("@/lib/marketing/estimate-sources")
  const rows = await listComparisonEvidence(createServiceClient(), auth.brokerageId, input.address)
  return {
    ok: true,
    evidence: rows.map((r) => {
      const src = comparisonEstimateSource(r.source)
      return { assetId: r.assetId, source: r.source, label: src?.cardLabel ?? r.source, url: r.url, approvalStatus: r.approvalStatus, capturedAt: r.capturedAt, confirmedFigureUsd: r.confirmedFigureUsd, posture: src?.posture ?? "figure_only", via: r.via ?? "still", tosNote: src?.tosNote ?? "" }
    }),
  }
}

/** A human confirms the figure an APPROVED capture shows (counted, tenant-predicated). */
export async function confirmComparisonFigureAction(input: { assetId: string; figure: string | number }): Promise<{ ok: true; figureUsd: number } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (typeof input.assetId !== "string" || !input.assetId) return { ok: false, error: "assetId required" }
  const { confirmComparisonFigure } = await import("@/lib/marketing/estimate-comparison")
  const r = await confirmComparisonFigure(createServiceClient(), { brokerageId: auth.brokerageId, userId: auth.userId, assetId: input.assetId, figure: input.figure })
  return r.ok ? r : { ok: false, error: r.reason }
}

/** Compose the piece (postcard 6x9, social square, story) from approved +
 *  confirmed evidence, with the brand cascade and a TRACKED QR (the ONE
 *  minter) on print. Lands pending on the approval rail. */
export async function composeEstimateComparisonAction(input: { address: string; hookKey?: string }): Promise<
  | { ok: true; urls: Record<string, string>; headline: string; socialCaption: string; emailSubject: string; videoBeats: string[] }
  | { ok: false; error: string; omitted?: Array<{ source: string; reason: string }> }
> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const svc = createServiceClient()
  const { buildEstimateComparisonCreative, COMPARISON_HOOKS } = await import("@/lib/marketing/estimate-comparison")
  const hookKey = COMPARISON_HOOKS.find((h) => h.key === input.hookKey)?.key
  let brand = { name: "", primaryColor: null as string | null, fairHousingLine: null as string | null }
  try {
    const { resolveBrandContext } = await import("@/lib/branding/resolve-brand-context")
    const b = await resolveBrandContext({ brokerageId: auth.brokerageId, agentUserId: auth.userId })
    brand = { name: b.displayName, primaryColor: b.visual.primaryColor, fairHousingLine: b.fairHousing.shortDisclosure }
  } catch { /* brand is best-effort; the piece still carries the disclaimer */ }
  let qrDataUrl: string | null = null
  try {
    const { mintTrackedQr } = await import("@/lib/marketing/tracked-qr")
    const slugAddr = input.address.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)
    const qr = await mintTrackedQr({ brokerageId: auth.brokerageId, label: `estimate_comparison:${slugAddr}`, purpose: "lead_capture", destinationType: "landing_page" }, svc)
    qrDataUrl = qr?.qrCodeDataUrl ?? null
  } catch { /* a piece without a QR still prints its CTA; the refusal is logged by the minter */ }
  const r = await buildEstimateComparisonCreative({ svc, brokerageId: auth.brokerageId, userId: auth.userId, address: input.address, hookKey, brand, qrDataUrl })
  if (r.state === "composed") {
    return { ok: true, urls: r.urls as Record<string, string>, headline: r.copy.headline, socialCaption: r.copy.socialCaption, emailSubject: r.copy.emailSubject, videoBeats: r.copy.videoBeats }
  }
  return r.state === "needs_evidence" ? { ok: false, error: r.reason, omitted: r.omitted } : { ok: false, error: r.reason }
}

/** Narrow or widen a tenant still's uses — tenant-predicated, counted update. */
export async function setTenantScreenshotUsesAction(input: { assetId: string; uses: ScreenshotUse[] }): Promise<{ ok: true; uses: ScreenshotUse[] } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (typeof input.assetId !== "string" || !input.assetId) return { ok: false, error: "assetId required" }
  const r = await setScreenshotUses(createServiceClient(), input.assetId, Array.isArray(input.uses) ? input.uses : [], { brokerageId: auth.brokerageId })
  return r.ok ? { ok: true, uses: r.uses } : { ok: false, error: r.reason }
}
