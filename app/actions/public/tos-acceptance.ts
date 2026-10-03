"use server"

// ToS ACCEPTANCE TRACKING — a durable record of WHO accepted WHICH terms version
// WHEN (with IP/UA), captured at signup. Current version lives on
// platform_settings.tos_version; acceptance is idempotent per (email, version).

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { headers } from "next/headers"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"

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

/**
 * READER — the re-prompt gate. Renders as `<TosReacceptanceBanner>` on every
 * dashboard page (app/components/layout/app-shell.tsx, same slot as
 * ImpersonationBanner). platform_tos_acceptances.tos_version /.email were
 * written on every signup and never read anywhere (readerless-write-census)
 * — a version bump on platform_settings.tos_version never reached anyone who
 * had already accepted an older version.
 *
 * TENANT/IDENTITY: the email checked is the SIGNED-IN user's own session
 * email (§4) — never a request body. Non-authenticated callers get
 * needsAcceptance:false so the banner stays silent rather than erroring.
 */
export async function checkCurrentUserTosStatusAction(): Promise<
  { ok: true; needsAcceptance: boolean; currentVersion: string } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { ok: true, needsAcceptance: false, currentVersion: "" }

  const svc = createServiceClient()
  const { data: settings } = await svc.from("platform_settings").select("tos_version").limit(1).maybeSingle()
  const currentVersion = (settings as any)?.tos_version ?? "2026-07-01"

  const email = user.email.trim().toLowerCase()
  const { data: accepted, error } = await svc
    .from("platform_tos_acceptances")
    .select("id")
    .eq("email", email)
    .eq("tos_version", currentVersion)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }

  return { ok: true, needsAcceptance: !accepted, currentVersion }
}

/** Accept the CURRENT terms version as the signed-in user (session email — §4). */
export async function acceptCurrentTosAsCurrentUserAction(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { ok: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: settings } = await svc.from("platform_settings").select("tos_version").limit(1).maybeSingle()
  const currentVersion = (settings as any)?.tos_version ?? "2026-07-01"

  const hdrs = await headers()
  const { error } = await svc.from("platform_tos_acceptances").upsert({
    email: user.email.trim().toLowerCase(),
    tos_version: currentVersion,
    ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
    user_agent: hdrs.get("user-agent"),
  }, { onConflict: "email,tos_version" })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * READER — compliance/legal export. platform_tos_acceptances carries no
 * brokerage_id (it records pre-account, platform-wide consent at signup —
 * schema-snapshot.ts confirms no tenant column), so there is no tenant subset
 * for a tenant compliance_officer to see; this is gated to PLATFORM staff
 * (requirePlatformStaff — superadmin/admin/marketing/support), the only
 * roster with legitimate reach over a table with no tenant boundary.
 * Explicit columns, newest first, capped.
 */
export async function listTosAcceptancesAction(limit = 200): Promise<
  { ok: true; rows: Array<{ id: string; email: string; tos_version: string; ip_address: string | null; user_agent: string | null; accepted_at: string }> }
  | { ok: false; error: string }
> {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return { ok: false, error: guard.error }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("platform_tos_acceptances")
    .select("id, email, tos_version, ip_address, user_agent, accepted_at")
    .order("accepted_at", { ascending: false })
    .limit(Math.min(limit, 1000))
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: data ?? [] }
}
