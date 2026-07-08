"use server"

// app/actions/superadmin/go-live-readiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// "Are we ready for production?" — providers-gated, on-demand (every probe is
// a real vendor call; nothing runs on page load), audited.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"
import { runGoLiveReadiness, type GoLiveReadiness } from "@/lib/platform/go-live-readiness"

export async function getGoLiveReadinessAction(): Promise<{ ok: true; readiness: GoLiveReadiness } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "providers")) return { ok: false, error: "Forbidden — platform providers access required" }

  const svc = createServiceClient()
  const readiness = await runGoLiveReadiness(svc)

  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: user.id, actor_email: (data as any)?.email ?? user.email ?? "",
      action: "go_live_readiness.checked", target_type: "platform", target_id: "readiness",
      details: { requiredReady: readiness.requiredReady, requiredTotal: readiness.requiredTotal },
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[go-live-readiness audit] failed:", err) }

  return { ok: true, readiness }
}
