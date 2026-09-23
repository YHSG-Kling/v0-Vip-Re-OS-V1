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
export async function captureEstimateStillAction(input: { source: string; address: string; listingId?: string | null; alsoForVideo?: boolean }): Promise<CaptureActionResult> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  const r = await captureTenantEstimateStill(
    { brokerageId: auth.brokerageId, userId: auth.userId, source: input.source, address: input.address, listingId: input.listingId ?? null, alsoForVideo: input.alsoForVideo === true },
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

/** Narrow or widen a tenant still's uses — tenant-predicated, counted update. */
export async function setTenantScreenshotUsesAction(input: { assetId: string; uses: ScreenshotUse[] }): Promise<{ ok: true; uses: ScreenshotUse[] } | { ok: false; error: string }> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (typeof input.assetId !== "string" || !input.assetId) return { ok: false, error: "assetId required" }
  const r = await setScreenshotUses(createServiceClient(), input.assetId, Array.isArray(input.uses) ? input.uses : [], { brokerageId: auth.brokerageId })
  return r.ok ? { ok: true, uses: r.uses } : { ok: false, error: r.reason }
}
