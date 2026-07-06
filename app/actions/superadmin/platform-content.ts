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
import { buildWeeklyProductCalendar, canTransitionDraft } from "@/lib/platform/product-content"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"

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
  let calendar
  try { calendar = buildWeeklyProductCalendar(startDateIso) } catch (e: any) { return { ok: false, error: e?.message ?? "bad date" } }

  const svc = createServiceClient()
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
  await audit(auth.userId, auth.email, "platform_content.calendar_generated", startDateIso, { created })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true, created }
}

export async function listProductDraftsAction(): Promise<{ ok: true; drafts: any[] } | { ok: false; error: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_social_drafts")
    .select("id, channel, angle, content, hashtags, status, scheduled_for, permalink, created_at")
    .neq("status", "discarded").order("scheduled_for", { ascending: true }).limit(100)
  if (error) return { ok: false, error: error.message }
  return { ok: true, drafts: data ?? [] }
}

export async function transitionProductDraftAction(input: { id: string; to: string; permalink?: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketing()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: draft } = await svc.from("platform_social_drafts").select("id, status").eq("id", input.id).maybeSingle()
  if (!draft) return { ok: false, error: "Draft not found" }
  const check = canTransitionDraft((draft as any).status, input.to, input.permalink)
  if (!check.ok) return { ok: false, error: check.reason }
  const patch: Record<string, unknown> = { status: input.to, updated_at: new Date().toISOString() }
  if (input.to === "posted") patch.permalink = (input.permalink ?? "").trim()
  const { error } = await svc.from("platform_social_drafts").update(patch).eq("id", input.id)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, `platform_content.${input.to}`, input.id, { permalink: input.permalink ?? null })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}
