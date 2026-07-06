"use server"

// app/actions/superadmin/os-sentinel.ts
// ─────────────────────────────────────────────────────────────────────────────
// Read action for the OS Sentinel board — ONE "state of the whole agentic OS"
// for platform staff. Read-only aggregate over the existing roll-ups; staff-gated.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadOsHealth, type OsHealth } from "@/lib/platform/os-sentinel"

async function requireStaff(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isStaff = ["superadmin", "support"].includes((data as any)?.user_type) || ["superadmin", "support"].includes((data as any)?.platform_role)
  if (!isStaff) return { ok: false, error: "Forbidden — platform staff only" }
  return { ok: true }
}

export async function getOsHealthAction(): Promise<{ ok: true; data: OsHealth } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  return { ok: true, data: await loadOsHealth(createServiceClient()) }
}
