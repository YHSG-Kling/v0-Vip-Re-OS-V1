"use server"

// app/actions/settings/brokerage-column-settings.ts
// ─────────────────────────────────────────────────────────────────────────────
// Lane 86H — the tenant-admin doors for two brokerage_settings COLUMNS that were read and
// never written (opposite-missing 1b, owner ruling: BUILD, not default-only):
//
//   · review_request_delay_days — days after closing before the review-request cron
//     (app/api/cron/review-request-on-close) asks the client for a review. Card: the review
//     requests section of /referrals (app/referrals/review-request-timing-card.tsx).
//   · live_agent_face_provider_order — the live avatar's face fail-over order
//     (lib/live-agent/face-render.ts resolveFaceRenderProvider). Card: Twin Studio
//     (app/dashboard/settings/twin-studio/live-face-backup-card.tsx).
//
// Every export is a public HTTP endpoint (CLAUDE.md §4) and async. The tenant comes from the
// SESSION through the act-as seam (lib/platform/acting-context.ts — a read_only support grant
// may SEE, never save), never from an argument. The gate runs FIRST — the full tenant-admin
// rule (users.user_type OR a tenant-pinned grant, resolveTenantAdmin), failing CLOSED when the
// permission read cannot run — THEN the service client, through the counted column writers in
// lib/settings/brokerage-settings-columns.ts (zero rows written is a refusal, never a save).

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { saveLiveFaceProviderOrder, saveReviewRequestDelayDays } from "@/lib/settings/brokerage-settings-columns"
import {
  normalizeReviewRequestDelay,
  REVIEW_REQUEST_DEFAULT_DELAY_DAYS,
  REVIEW_REQUEST_DELAY_MAX_DAYS,
  REVIEW_REQUEST_DELAY_MIN_DAYS,
  REVIEW_REQUEST_LOOKBACK_DAYS,
} from "@/lib/reputation/review-request-delay"
import {
  FACE_RENDER_PROVIDERS,
  FACE_RENDER_PROVIDER_LABELS,
  normalizeProviderOrder,
} from "@/lib/live-agent/face-render"

/** `forbidden` = signed in and read fine, just not a tenant admin — a page hides the card for
 *  that, and SHOWS every other refusal (a read that could not run is not "nothing to show"). */
type Gate = { ok: true; brokerageId: string; userId: string; canEdit: boolean } | { ok: false; error: string; forbidden?: true }

async function gate(mode: "read" | "write", noun: string): Promise<Gate> {
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage." }
  const admin = await resolveTenantAdmin(ctx.db, ctx.userId, { user_type: ctx.userType, brokerage_id: ctx.brokerageId })
  // Fail closed: a permission read that could not run refuses — it is never "not an admin"
  // and never "admin".
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions for ${noun}: ${admin.error}` }
  if (!admin.isTenantAdmin) return { ok: false, forbidden: true, error: `Only a broker, owner or admin can change ${noun}.` }
  const readOnly = "readOnly" in ctx ? Boolean((ctx as { readOnly?: boolean }).readOnly) : false
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, canEdit: mode === "write" || !readOnly }
}

/** A refused settings read refuses — it is never shown as "not set". */
function readRefusal(error: { message: string }) {
  return { ok: false as const, error: `Brokerage settings could not be read (${error.message}).` }
}

// ─── review_request_delay_days ──────────────────────────────────────────────

export async function getReviewRequestDelaySettingAction() {
  const g = await gate("read", "review request timing")
  if (!g.ok) return g
  const { data, error } = await createServiceClient()
    .from("brokerage_settings")
    .select("review_request_delay_days")
    .eq("brokerage_id", g.brokerageId)
    .maybeSingle()
  if (error) return readRefusal(error)
  const raw = (data as { review_request_delay_days?: unknown } | null)?.review_request_delay_days
  const stored = typeof raw === "number" ? raw : null
  return {
    ok: true as const,
    canEdit: g.canEdit,
    /** What the brokerage saved (null = never set). */
    storedDays: stored,
    /** What the cron actually uses — the SAME normalizer it calls. */
    effectiveDays: normalizeReviewRequestDelay(stored),
    defaultDays: REVIEW_REQUEST_DEFAULT_DELAY_DAYS,
    minDays: REVIEW_REQUEST_DELAY_MIN_DAYS,
    maxDays: REVIEW_REQUEST_DELAY_MAX_DAYS,
    /** How far back the cron looks — why the maximum is what it is. */
    lookbackDays: REVIEW_REQUEST_LOOKBACK_DAYS,
  }
}

/** `days: null` resets to the default (the column is nullable; the cron reads NULL as default). */
export async function saveReviewRequestDelayAction(days: number | null) {
  const g = await gate("write", "review request timing")
  if (!g.ok) return g
  const w = await saveReviewRequestDelayDays(createServiceClient(), g.brokerageId, days, { type: "user", userId: g.userId, reason: "review request delay set" })
  if (!w.ok) return w
  revalidatePath("/referrals")
  return { ok: true as const, storedDays: w.value, effectiveDays: normalizeReviewRequestDelay(w.value) }
}

// ─── live_agent_face_provider_order ─────────────────────────────────────────

export async function getLiveFaceProviderSettingAction() {
  const g = await gate("read", "the live avatar's backup face")
  if (!g.ok) return g
  const { data, error } = await createServiceClient()
    .from("brokerage_settings")
    .select("live_agent_face_provider_order")
    .eq("brokerage_id", g.brokerageId)
    .maybeSingle()
  if (error) return readRefusal(error)
  return {
    ok: true as const,
    canEdit: g.canEdit,
    /** The order the session doors use — the SAME normalizer resolveFaceRenderProvider calls. */
    order: normalizeProviderOrder((data as { live_agent_face_provider_order?: unknown } | null)?.live_agent_face_provider_order),
    /** The reader's vocabulary, in its default order (primary first), with neutral labels. */
    providers: FACE_RENDER_PROVIDERS.map((id) => ({ id, label: FACE_RENDER_PROVIDER_LABELS[id] })),
  }
}

export async function saveLiveFaceProviderOrderAction(order: string[]) {
  const g = await gate("write", "the live avatar's backup face")
  if (!g.ok) return g
  const w = await saveLiveFaceProviderOrder(createServiceClient(), g.brokerageId, order, { type: "user", userId: g.userId, reason: "live face provider order set" })
  if (!w.ok) return w
  revalidatePath("/dashboard/settings/twin-studio")
  return { ok: true as const, order: w.value }
}
