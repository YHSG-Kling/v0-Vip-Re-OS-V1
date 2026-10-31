"use server"

// app/actions/superadmin/os-sentinel.ts
// ─────────────────────────────────────────────────────────────────────────────
// Read action for the OS Sentinel board — ONE "state of the whole agentic OS"
// for platform staff. Read-only aggregate over the existing roll-ups; staff-gated.

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { loadOsHealth, type OsHealth } from "@/lib/platform/os-sentinel"

/**
 * Platform staff only — through THE ONE capability gate the board page already uses
 * (app/dashboard/superadmin/sentinel/page.tsx: requirePlatformCapability("sentinel")).
 *
 * TOMBSTONE (lane 140O, CLAUDE.md §4/§6): this used to re-spell a two-role roster,
 * `["superadmin", "support"]`, matched against BOTH identity columns. That admitted a
 * TENANT user stored as user_type='support' (a legal tenant seat with no platform
 * employment) to the whole-OS health board, and refused the platform 'admin' the page
 * had just let in — a gate disagreeing with itself. Platform staff live in
 * platform_role (lib/platform/platform-staff-roster.ts); the capability map + superadmin
 * overrides decide who holds 'sentinel'.
 */
async function requireStaff(): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("sentinel")
  // FAIL CLOSED (§4): a gate that did not admit, or admitted nobody, is a refusal.
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden — platform staff only" }
  return { ok: true }
}

export async function getOsHealthAction(): Promise<{ ok: true; data: OsHealth } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  return { ok: true, data: await loadOsHealth(createServiceClient()) }
}
