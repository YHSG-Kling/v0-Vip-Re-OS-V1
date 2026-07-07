"use server"

// app/actions/superadmin/platform-content.ts
// ─────────────────────────────────────────────────────────────────────────────
// The platform's OWN social content pipeline (market VIP Agents on the company
// channels). Marketing-staff-gated (capability map), audited; drafts move
// draft → approved → posted (permalink recorded when it actually goes out).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { buildWeeklyProductCalendar, canTransitionDraft, composeProductVideoSpec, type ProductVideoFormat } from "@/lib/platform/product-content"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { loadProductBrand } from "@/lib/platform/product-brand"

async function requireMarketing(): Promise<{ ok: true; userId: string; email: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "marketing")) return { ok: false, error: "Forbidden — platform marketing access required" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "" }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient(); const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_social_draft", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-content audit] failed:", err) }
}

/** Generate a week of product-marketing drafts starting at a date (idempotent per channel+date). */
export async function generateProductCalendarAction(startDateIso: string): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  // Brand-driven (the app name lives in platform settings) + topic-infused: odd
  // days pull from the watched-topic pool (competitor buzz / trends), then those
  // topics are marked used so the pool rotates.
  const brand = await loadProductBrand(svc)
  const { data: topicRows } = await svc.from("platform_content_topics")
    .select("id, topic").eq("status", "new").order("created_at", { ascending: false }).limit(3)
  const topics = ((topicRows ?? []) as any[]).map((t) => t.topic as string)
  let calendar
  try { calendar = buildWeeklyProductCalendar(startDateIso, brand, topics) } catch (e: any) { return { ok: false, error: e?.message ?? "bad date" } }
  let created = 0
  for (const post of calendar) {
    const { count } = await svc.from("platform_social_drafts").select("id", { count: "exact", head: true })
      .eq("channel", post.channel).eq("scheduled_for", post.scheduledFor).neq("status", "discarded")
    if ((count ?? 0) > 0) continue
    const { error } = await svc.from("platform_social_drafts").insert({
      channel: post.channel, angle: post.angle, content: post.content, hashtags: post.hashtags,
      scheduled_for: post.scheduledFor, status: "draft", created_by: auth.userId,
    })
    if (!error) created++
  }
  if (created > 0 && (topicRows ?? []).length > 0) {
    await svc.from("platform_content_topics").update({ status: "used", used_at: new Date().toISOString() })
      .in("id", ((topicRows ?? []) as any[]).map((t) => t.id))
  }
  await audit(auth.userId, auth.email, "platform_content.calendar_generated", startDateIso, { created, topicsUsed: topics.length })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true, created }
}

export async function listProductDraftsAction(): Promise<{ ok: true; drafts: any[] } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_social_drafts")
    .select("id, channel, angle, content, hashtags, status, scheduled_for, permalink, media_type, format, script, video_url, created_at")
    .neq("status", "discarded").order("scheduled_for", { ascending: true }).limit(100)
  if (error) return { ok: false, error: error.message }
  return { ok: true, drafts: data ?? [] }
}

export async function transitionProductDraftAction(input: { id: string; to: string; permalink?: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: draft } = await svc.from("platform_social_drafts").select("id, status, media_type, video_url").eq("id", input.id).maybeSingle()
  if (!draft) return { ok: false, error: "Draft not found" }
  const check = canTransitionDraft((draft as any).status, input.to, input.permalink)
  if (!check.ok) return { ok: false, error: check.reason }
  // A VIDEO draft can only be posted once the rendered file is attached.
  if (input.to === "posted" && (draft as any).media_type === "video" && !((draft as any).video_url ?? "").trim()) {
    return { ok: false, error: "Attach the rendered video (video_url) before marking a video posted" }
  }
  const patch: Record<string, unknown> = { status: input.to, updated_at: new Date().toISOString() }
  if (input.to === "posted") patch.permalink = (input.permalink ?? "").trim()
  const { error } = await svc.from("platform_social_drafts").update(patch).eq("id", input.id)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, `platform_content.${input.to}`, input.id, { permalink: input.permalink ?? null })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

/** Create a product VIDEO draft — the same angle story, video-shaped. The spec
 *  targets the real ProductPromoReel composition; render with the Remotion CLI
 *  and attach the file URL before posting. */
export async function generateProductVideoDraftAction(input: { angle: string; format?: ProductVideoFormat; topicId?: string }): Promise<{ ok: true; id: string; script: string } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const brand = await loadProductBrand(svc)
  let topicText: string | null = null
  if (input.topicId) {
    const { data: t } = await svc.from("platform_content_topics").select("id, topic").eq("id", input.topicId).maybeSingle()
    topicText = (t as any)?.topic ?? null
    if (topicText) await svc.from("platform_content_topics").update({ status: "used", used_at: new Date().toISOString() }).eq("id", input.topicId)
  }
  const spec = composeProductVideoSpec(input.angle, input.format ?? "vertical", brand, topicText)
  const { data, error } = await svc.from("platform_social_drafts").insert({
    channel: spec.channel, angle: spec.angle, content: spec.caption,
    hashtags: null, status: "draft", created_by: auth.userId,
    media_type: "video", format: spec.format, script: spec.script,
  }).select("id").single()
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "platform_content.video_draft", (data as any).id, { angle: spec.angle, format: spec.format, compositionId: spec.compositionId })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true, id: (data as any).id, script: spec.script }
}

/** Attach the rendered video file URL to a video draft (from the Remotion render). */
export async function attachProductVideoAction(input: { id: string; videoUrl: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const url = (input.videoUrl ?? "").trim()
  if (!url) return { ok: false, error: "videoUrl required" }
  const svc = createServiceClient()
  const { error } = await svc.from("platform_social_drafts").update({ video_url: url, updated_at: new Date().toISOString() })
    .eq("id", input.id).eq("media_type", "video")
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "platform_content.video_attached", input.id, { videoUrl: url })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}
