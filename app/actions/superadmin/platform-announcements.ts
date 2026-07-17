"use server"

// app/actions/superadmin/platform-announcements.ts
// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL STAFF ANNOUNCEMENTS — the lightweight platform-staff comms lane (not a
// chat system). Posting is gated on the "announcements" capability (superadmin +
// platform admin); delivery rides the EXISTING notifyPlatformStaff rail, which
// fans one notifications row (type "platform_announcement") out to every platform
// staffer — the staff command home reads each staffer's own rows back. No new
// table; posts are audited in superadmin_audit_log.

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { notifyPlatformStaff, PLATFORM_ANNOUNCEMENT_TYPE } from "@/lib/notifications/platform-staff"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

export async function postPlatformAnnouncementAction(input: {
  title: string
  body: string
  priority?: "low" | "medium" | "high"
}): Promise<{ ok: boolean; notified?: number; error?: string }> {
  const gate = await requirePlatformCapability("announcements")
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }

  const title = (input.title ?? "").trim()
  const body = (input.body ?? "").trim()
  if (!title) return { ok: false, error: "A title is required" }
  if (!body) return { ok: false, error: "A message is required" }
  const priority = input.priority === "high" || input.priority === "low" ? input.priority : "medium"

  const svc = createServiceClient()
  const { data: me } = await svc.from("users").select("email, first_name, last_name").eq("id", gate.userId).maybeSingle()
  const author = [(me as any)?.first_name, (me as any)?.last_name].filter(Boolean).join(" ") || (me as any)?.email || "Platform staff"

  const notified = await notifyPlatformStaff(svc, {
    type: PLATFORM_ANNOUNCEMENT_TYPE,
    title,
    body: `${body}\n— ${author}`,
    priority,
  })
  if (notified === 0) return { ok: false, error: "Announcement was not delivered — no platform staff resolved or the write failed" }

  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: gate.userId, actor_email: (me as any)?.email ?? "", action: "platform_announcement.posted",
      target_type: "platform_staff", target_id: null, details: { title, priority, notified },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-announcements audit] failed:", err) }

  revalidatePath("/dashboard/superadmin/home")
  return { ok: true, notified }
}
