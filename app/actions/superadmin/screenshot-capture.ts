"use server"

// app/actions/superadmin/screenshot-capture.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE HUMAN DOOR onto the screenshot seam (lane 78B) — platform marketing
// staff ask for a demo still or a public property-page capture on demand; the
// autonomous refresh (app/api/cron/marketing-image-regen) does the rest. Gate
// first (requireMarketing — the same door app/actions/superadmin/
// platform-content.ts uses), then the service client (CLAUDE.md §4). Every
// export is a public endpoint and is async.
//
// Nothing here reads a value off a captured page; a public-page still is
// demo / training / video material only (lib/assets/screenshot-capture.ts).

import { createServiceClient } from "@/lib/supabase/service"
import { requireMarketing } from "@/lib/auth/platform-guard"
import {
  captureScreenshot, capturePublicPropertyPage, DEMO_STILL_SURFACES,
  listScreenshotStillsForUse, setScreenshotUses, SCREENSHOT_USES, type ScreenshotStillPick, type ScreenshotUse,
} from "@/lib/assets/screenshot-capture"

type ActionResult = { ok: true; assetId: string; url: string; cached: boolean } | { ok: false; error: string }

// WAVE 155 (lane 155R23 — LAW 5, no tenant): a platform-library still belongs to NO brokerage (brokerageId "platform",
// visibility_scope 'platform'), so agent_action_ledger cannot hold its receipt and no tenant is invented. After the platform
// gate and the act, ONE row on the platform's evidence door (lib/platform/staff-action-gate.ts recordPlatformEvidence →
// superadmin_audit_log): who (the staff user), what, which asset, and what happened — a refusal is recorded too. NOT exported.
async function evidence(userId: string | null, action: string, assetId: string | null, details: Record<string, unknown>): Promise<void> {
  const { recordPlatformEvidence } = await import("@/lib/platform/staff-action-gate")
  await recordPlatformEvidence({ actorUserId: userId, actorEmail: null, action, targetType: "marketing_asset", targetId: assetId, details })
}

/** Capture (or return today's cached) demo still for a registered OS surface. */
export async function captureDemoStillAction(input: { surfaceId: string; redact?: string[] }): Promise<ActionResult> {
  const auth = await requireMarketing()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!DEMO_STILL_SURFACES.some((s) => s.id === input.surfaceId)) return { ok: false, error: `demo still surface "${input.surfaceId}" is not registered` }
  const r = await captureScreenshot({ kind: "os_surface", surfaceId: input.surfaceId, redact: input.redact, brokerageId: "platform" }, { svc: createServiceClient() })
  await evidence(auth.userId, "platform_screenshot.demo_still_captured", r.ok ? r.assetId : null, r.ok ? { surface_id: input.surfaceId, cached: r.cached } : { surface_id: input.surfaceId, refused: r.reason })
  return r.ok ? { ok: true, assetId: r.assetId, url: r.url, cached: r.cached } : { ok: false, error: r.reason }
}

/** Find a property's public page through the search tool and capture it (ToS-aware). */
export async function capturePublicPropertyStillAction(input: { query: string }): Promise<ActionResult> {
  const auth = await requireMarketing()
  if (!auth.ok) return { ok: false, error: auth.error }
  const r = await capturePublicPropertyPage(input.query, { svc: createServiceClient() })
  await evidence(auth.userId, "platform_screenshot.public_page_captured", r.ok ? r.assetId : null, r.ok ? { cached: r.cached } : { refused: r.reason })
  return r.ok ? { ok: true, assetId: r.assetId, url: r.url, cached: r.cached } : { ok: false, error: r.reason }
}

/** MULTI-USE (wave 79C): the stills a platform-marketing consumer may pick for
 *  a use — campaigns, product videos, demos, training. Public-page captures
 *  (Zestimate & co.) come back only on request and stay `pending`; they are
 *  material, never a value shown to a customer. */
export async function listScreenshotStillsForUseAction(input: { use: ScreenshotUse; includePublicPage?: boolean }): Promise<{ ok: true; stills: ScreenshotStillPick[] } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!(SCREENSHOT_USES as readonly string[]).includes(input.use)) return { ok: false, error: `screenshot use "${String(input.use)}" is not one of ${SCREENSHOT_USES.join("/")}` }
  return { ok: true, stills: await listScreenshotStillsForUse(createServiceClient(), input.use, { includePublicPage: input.includePublicPage === true }) }
}

/** MULTI-USE (wave 79C): narrow or widen which uses may select a still. */
export async function setScreenshotUsesAction(input: { assetId: string; uses: ScreenshotUse[] }): Promise<{ ok: true; uses: ScreenshotUse[] } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (typeof input.assetId !== "string" || !input.assetId) return { ok: false, error: "assetId required" }
  const r = await setScreenshotUses(createServiceClient(), input.assetId, Array.isArray(input.uses) ? input.uses : [])
  await evidence(auth.userId, "platform_screenshot.uses_set", input.assetId, r.ok ? { uses: r.uses } : { refused: r.reason })
  return r.ok ? { ok: true, uses: r.uses } : { ok: false, error: r.reason }
}

/** The registry, for a picker: id + label + route. */
export async function listDemoStillSurfacesAction(): Promise<{ ok: true; surfaces: Array<{ id: string; label: string; route: string }> } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return { ok: false, error: auth.error }
  return { ok: true, surfaces: DEMO_STILL_SURFACES.map((s) => ({ id: s.id, label: s.label, route: s.route })) }
}
