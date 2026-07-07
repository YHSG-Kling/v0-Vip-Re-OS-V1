"use server"

// ToS ACCEPTANCE TRACKING — a durable record of WHO accepted WHICH terms version
// WHEN (with IP/UA), captured at signup. Current version lives on
// platform_settings.tos_version; acceptance is idempotent per (email, version).

import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"

export async function getCurrentTosVersionAction(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const svc = createServiceClient()
    const { data } = await svc.from("platform_settings").select("tos_version").limit(1).maybeSingle()
    return { ok: true, version: (data as any)?.tos_version ?? "2026-07-01" }
  } catch (e: any) { return { ok: false, error: e?.message ?? "failed" } }
}

/** PUBLIC: record a ToS acceptance (idempotent per email+version). */
export async function recordTosAcceptanceAction(input: { email: string; version: string }): Promise<{ ok: boolean; error?: string }> {
  const email = (input.email ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Valid email required" }
  const version = (input.version ?? "").trim()
  if (!version) return { ok: false, error: "version required" }
  const svc = createServiceClient()
  const hdrs = await headers()
  const { error } = await svc.from("platform_tos_acceptances").upsert({
    email, tos_version: version,
    ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
    user_agent: hdrs.get("user-agent"),
  }, { onConflict: "email,tos_version" })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
