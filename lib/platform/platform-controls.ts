// lib/platform/platform-controls.ts
//
// PLATFORM CONTROLS — the "god switch" for the whole agentic OS. platform_settings is a SINGLETON row
// (ai_enabled / emergency_mode / global_rate_limit_per_minute / show_brokerage_budget_warning) that already
// existed in the DB and is honored at the AI GATEWAY (lib/ai/cost-tracking.ts blocks generation on
// emergency_mode / !ai_enabled). But the AUTONOMY GATE — the thing that decides whether an AI manager may
// ACT unattended across every tenant — never read it and failed open, so a superadmin flipping the switch
// did NOT stop the autonomous managers, and there was no working UI to flip it at all (the only panel was a
// hardcoded stub). This module makes the switch REAL and ENFORCED: one place reads/writes the singleton, one
// PURE predicate decides "is the platform halted?", and the autonomy gate consults it as a global
// circuit-breaker. Superadmin-only writes, audited.

import { createServiceClient } from "@/lib/supabase/service"

export interface PlatformControls {
  /** Master AI engine switch. OFF ⇒ no autonomous AI anywhere. */
  aiEnabled: boolean
  /** The red button. ON ⇒ freeze all autonomous AI manager actions platform-wide. */
  emergencyMode: boolean
  /** Platform-wide soft rate ceiling (advisory; surfaced to operators). */
  globalRateLimitPerMinute: number
  /** Whether brokerages see the vendor-spend budget warning banner. */
  showBrokerageBudgetWarning: boolean
}

export interface PlatformHalt { halted: boolean; reason: string | null }

const DEFAULTS: PlatformControls = {
  aiEnabled: true, emergencyMode: false, globalRateLimitPerMinute: 1000, showBrokerageBudgetWarning: false,
}

/**
 * PURE: is the entire platform halted? emergency_mode ON, or the AI engine switched OFF, freezes every
 * autonomous AI manager action across all tenants. Deterministic + unit-testable.
 */
export function resolvePlatformHalt(c: Pick<PlatformControls, "aiEnabled" | "emergencyMode">): PlatformHalt {
  if (c.emergencyMode) {
    return { halted: true, reason: "Platform emergency mode is ON — all autonomous AI manager actions are held platform-wide until it is cleared." }
  }
  if (!c.aiEnabled) {
    return { halted: true, reason: "The platform AI engine is switched OFF — autonomous AI manager actions are held platform-wide." }
  }
  return { halted: false, reason: null }
}

type Svc = ReturnType<typeof createServiceClient>

/** Read the platform_settings SINGLETON (oldest row). Returns safe defaults when the row is absent. */
export async function getPlatformControls(client?: Svc): Promise<PlatformControls> {
  const svc = client ?? createServiceClient()
  const { data } = await svc
    .from("platform_settings")
    .select("ai_enabled, emergency_mode, global_rate_limit_per_minute, show_brokerage_budget_warning")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!data) return { ...DEFAULTS }
  const d = data as Record<string, unknown>
  return {
    aiEnabled: d.ai_enabled !== false, // default ON
    emergencyMode: d.emergency_mode === true,
    globalRateLimitPerMinute: Number(d.global_rate_limit_per_minute) || DEFAULTS.globalRateLimitPerMinute,
    showBrokerageBudgetWarning: d.show_brokerage_budget_warning === true,
  }
}

// ── Cached halt for the hot autonomy-gate path ───────────────────────────────
// Short TTL so a flip of the red button propagates fast without a DB read on every gate call.
let haltCache: { value: PlatformHalt; expiresAt: number } | null = null
const HALT_TTL_MS = 20_000

/** The circuit-breaker read the autonomy gate consults. FAILS OPEN (not halted) on any infra error —
 *  an emergency freeze is a deliberate switch, never a side-effect of a transient DB hiccup. */
export async function loadPlatformHalt(client?: Svc): Promise<PlatformHalt> {
  if (haltCache && haltCache.expiresAt > Date.now()) return haltCache.value
  let value: PlatformHalt = { halted: false, reason: null }
  try {
    value = resolvePlatformHalt(await getPlatformControls(client))
  } catch {
    value = { halted: false, reason: null } // fail open
  }
  haltCache = { value, expiresAt: Date.now() + HALT_TTL_MS }
  return value
}

/** Test seam / post-write invalidation — clear the cached halt so the next read hits the DB. */
export function __clearPlatformHaltCache(): void { haltCache = null }

/** Write the singleton (partial patch) and invalidate the halt cache. Returns the new controls. */
export async function setPlatformControls(svc: Svc, patch: Partial<PlatformControls>): Promise<PlatformControls> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.aiEnabled !== undefined) row.ai_enabled = patch.aiEnabled
  if (patch.emergencyMode !== undefined) row.emergency_mode = patch.emergencyMode
  if (patch.globalRateLimitPerMinute !== undefined) row.global_rate_limit_per_minute = Math.max(1, Math.floor(patch.globalRateLimitPerMinute))
  if (patch.showBrokerageBudgetWarning !== undefined) row.show_brokerage_budget_warning = patch.showBrokerageBudgetWarning

  const { data: existing } = await svc.from("platform_settings").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle()
  if (existing) await svc.from("platform_settings").update(row).eq("id", (existing as any).id)
  else await svc.from("platform_settings").insert(row)

  __clearPlatformHaltCache()
  return getPlatformControls(svc)
}
