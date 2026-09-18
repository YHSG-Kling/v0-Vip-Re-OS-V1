/**
 * lib/platform/product-content-autopilot.ts
 *
 * THE PLATFORM'S OWN ACQUISITION VIDEOS RUN ON A LOOP (owner, 2026-09-07:
 * "videos for pulling in new customers to the platform itself … each capability
 * should be used autonomously as much as you can"). Until this wave the product
 * lane was manual at both ends: a superadmin pressed "generate calendar" and
 * "generate video draft", then rendered ProductPromoReel by CLI
 * (`npx remotion render …`) and pasted the file URL back
 * (app/actions/superadmin/platform-content.ts). The reel, the angles and the
 * gated draft lifecycle (draft → approved → posted with a permalink) were real;
 * nothing DROVE them.
 *
 * Three pieces, no new tables (§1.2 BUILD, §6 one vocabulary):
 *   • writeWeeklyProductCalendar — the calendar writer the superadmin action
 *     and the cron SHARE (the action used to own this body; it now delegates).
 *   • queueProductVideoRender — a video draft's ProductPromoReel render goes
 *     through THE render registry (lib/remotion/registry.ts recordRenderQueued),
 *     entity_type `platform_social_draft`; the render worker's post-render hook
 *     (app/api/internal/remotion/render-composition/route.ts) attaches
 *     `video_url` to the draft when the file lands. Renders need a tenant row:
 *     the platform's house brokerage (DEMO_CONFIG.BROKERAGE_ID — the row every
 *     platform seed keys on) is that tenant.
 *   • runWeeklyProductAutopilot — the Monday cron: write the week's posts,
 *     draft ONE product video on the week's lead angle and queue its render.
 *     Everything stays GATED: a draft posts only after a human approves it.
 *
 * Skills consulted: ads-video (hook → proof beats → CTA, 15s), market-launch
 * (one story across text + video), remotion-best-practices (the render is the
 * registered composition with typed props — never a second renderer).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { DEMO_CONFIG } from "@/app/constants/auth"
import { loadProductBrand } from "./product-brand"
import { buildWeeklyProductCalendar, composeProductVideoSpec, PRODUCT_ANGLES, type ProductVideoFormat } from "./product-content"
import { recordRenderQueued } from "@/lib/remotion/registry"

type Svc = ReturnType<typeof createServiceClient>

/** The entity_type a product-video render row carries; the post-render hook keys on it. */
export const PLATFORM_SOCIAL_DRAFT_ENTITY = "platform_social_draft"
/** The platform's house tenant — the one row platform renders are filed under. */
const PLATFORM_HOUSE_BROKERAGE_ID = DEMO_CONFIG.BROKERAGE_ID

export interface CalendarWriteResult { created: number; topicsUsed: number; error?: string }

/**
 * Write the week's product posts as gated drafts (idempotent per channel +
 * scheduled_for). `createdBy` is null for the cron — the column is nullable and
 * a system-written draft has no human author until someone approves it.
 */
export async function writeWeeklyProductCalendar(
  svc: Svc, input: { startDateIso: string; createdBy: string | null },
): Promise<CalendarWriteResult> {
  const brand = await loadProductBrand(svc)
  const { data: topicRows, error: topicsError } = await svc.from("platform_content_topics")
    .select("id, topic").eq("status", "new").order("created_at", { ascending: false }).limit(3)
  if (topicsError) console.error("[product-autopilot] topics read refused:", topicsError.message)
  const topics = ((topicRows ?? []) as Array<{ id: string; topic: string }>).map((t) => t.topic)
  let calendar
  try { calendar = buildWeeklyProductCalendar(input.startDateIso, brand, topics) } catch (e) { return { created: 0, topicsUsed: 0, error: (e as Error).message } }
  let created = 0
  for (const post of calendar) {
    const { count, error: countError } = await svc.from("platform_social_drafts").select("id", { count: "exact", head: true })
      .eq("channel", post.channel).eq("scheduled_for", post.scheduledFor).neq("status", "discarded")
    if (countError) { console.error("[product-autopilot] draft count refused:", countError.message); continue }
    if ((count ?? 0) > 0) continue
    const { error } = await svc.from("platform_social_drafts").insert({
      channel: post.channel, angle: post.angle, content: post.content, hashtags: post.hashtags,
      scheduled_for: post.scheduledFor, status: "draft", created_by: input.createdBy,
    })
    if (error) console.error("[product-autopilot] draft insert refused:", error.message)
    else created++
  }
  if (created > 0 && (topicRows ?? []).length > 0) {
    const { error } = await svc.from("platform_content_topics").update({ status: "used", used_at: new Date().toISOString() })
      .in("id", ((topicRows ?? []) as Array<{ id: string }>).map((t) => t.id))
    if (error) console.error("[product-autopilot] topic mark-used refused:", error.message)
  }
  return { created, topicsUsed: topics.length }
}

export interface QueueRenderResult { queued: boolean; renderId?: string; reason?: string; alreadyQueued?: boolean }

/** Queue the ProductPromoReel render for a video draft through the one registry. Idempotent per draft. */
export async function queueProductVideoRender(
  svc: Svc, input: { draftId: string; requestedVia: "manual" | "cron" },
): Promise<QueueRenderResult> {
  const { data: d, error } = await svc.from("platform_social_drafts")
    .select("id, angle, format, media_type, video_url, status").eq("id", input.draftId).maybeSingle()
  if (error) return { queued: false, reason: `draft read refused: ${error.message}` }
  const draft = d as { id: string; angle: string; format: string | null; media_type: string; video_url: string | null; status: string } | null
  if (!draft) return { queued: false, reason: "draft not found" }
  if (draft.media_type !== "video") return { queued: false, reason: "not a video draft" }
  if (draft.video_url) return { queued: false, reason: "video already attached", alreadyQueued: true }
  if (draft.status === "discarded") return { queued: false, reason: "draft discarded" }

  const { data: existing, error: exErr } = await svc.from("remotion_composition_renders").select("id, render_status")
    .eq("entity_type", PLATFORM_SOCIAL_DRAFT_ENTITY).eq("entity_id", draft.id)
    // render_status CHECK vocabulary: cancelled | failed | queued | rendering | succeeded
    // (scripts/check-vocabularies.ts) — "completed" is not in it and would match nothing.
    .in("render_status", ["queued", "rendering", "succeeded"]).limit(1).maybeSingle()
  if (exErr) return { queued: false, reason: `render read refused: ${exErr.message}` }
  if (existing) return { queued: false, alreadyQueued: true, renderId: (existing as { id: string }).id, reason: "render already queued" }

  const brand = await loadProductBrand(svc)
  const format: ProductVideoFormat = draft.format === "square" ? "square" : "vertical"
  const spec = composeProductVideoSpec(draft.angle, format, brand, null)
  const r = await recordRenderQueued({
    brokerageId: PLATFORM_HOUSE_BROKERAGE_ID,
    compositionId: spec.compositionId,
    entityType: PLATFORM_SOCIAL_DRAFT_ENTITY,
    entityId: draft.id,
    inputProps: spec.inputProps as unknown as Record<string, unknown>,
    scopeType: "brokerage",
    scopeId: PLATFORM_HOUSE_BROKERAGE_ID,
    requestedVia: input.requestedVia,
  })
  if (!r.ok) return { queued: false, reason: ("error" in r && typeof r.error === "string" ? r.error : null) ?? "render row insert refused" }
  return { queued: true, renderId: (r as { renderId?: string }).renderId }
}

/** The Monday loop: posts for the week + one product video, rendered, all gated. */
export async function runWeeklyProductAutopilot(client?: Svc, now: Date = new Date()): Promise<{
  calendar: CalendarWriteResult; videoDraftId: string | null; render: QueueRenderResult | null
}> {
  const svc = client ?? createServiceClient()
  const startDateIso = now.toISOString().slice(0, 10)
  const calendar = await writeWeeklyProductCalendar(svc, { startDateIso, createdBy: null })

  // One video per week, on a rotating angle, unless this week's already has one.
  const weekStart = new Date(now); weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay()); weekStart.setUTCHours(0, 0, 0, 0)
  const { data: existing, error: exErr } = await svc.from("platform_social_drafts").select("id")
    .eq("media_type", "video").gte("created_at", weekStart.toISOString()).neq("status", "discarded").limit(1).maybeSingle()
  if (exErr) { console.error("[product-autopilot] weekly video read refused:", exErr.message); return { calendar, videoDraftId: null, render: null } }
  if (existing) return { calendar, videoDraftId: (existing as { id: string }).id, render: await queueProductVideoRender(svc, { draftId: (existing as { id: string }).id, requestedVia: "cron" }) }

  const angles = Object.keys(PRODUCT_ANGLES)
  const angle = angles[Math.floor(now.getTime() / (7 * 86_400_000)) % angles.length]
  const brand = await loadProductBrand(svc)
  const spec = composeProductVideoSpec(angle, "vertical", brand, null)
  const { data: inserted, error } = await svc.from("platform_social_drafts").insert({
    channel: spec.channel, angle: spec.angle, content: spec.caption, hashtags: null, status: "draft",
    created_by: null, media_type: "video", format: spec.format, script: spec.script,
  }).select("id").single()
  if (error || !inserted) { console.error("[product-autopilot] video draft insert refused:", error?.message); return { calendar, videoDraftId: null, render: null } }
  const draftId = (inserted as { id: string }).id
  const render = await queueProductVideoRender(svc, { draftId, requestedVia: "cron" })
  return { calendar, videoDraftId: draftId, render }
}
