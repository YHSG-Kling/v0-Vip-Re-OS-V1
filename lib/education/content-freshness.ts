// lib/education/content-freshness.ts
//
// CONTENT FRESHNESS / AUTO-REFRESH (recruiting_manager) — AI-authored education ages: license law, NAR
// policy, and market facts drift, and a two-year-old "commission structure post-NAR" lesson becomes wrong.
// Nothing flagged stale modules before. This scans the published AI-authored catalog and proposes ONE
// gated broker brief listing the modules due for a refresh, so a human re-reviews/re-authors through the
// EXISTING review workflow (never silently overwrites live content).
//
// HONEST scope: age-based staleness is computed from the module's own timestamps (no new column). The
// spec's "market-context drift > 20%" refresh is intentionally NOT faked — the app has no market_snapshots
// history to diff against, so claiming it would be fabrication; regulatory-change authoring is already
// handled by regulatory-curriculum (new modules on a rule change). This loop owns the AGE axis.
//
// Pure core (age/staleness) is testable; the runner proposes the gated brief.

import type { createServiceClient } from "@/lib/supabase/service"
type Svc = ReturnType<typeof createServiceClient>

/** Real-estate education is regulation- and market-sensitive; 180 days is the documented default max age. */
export const MODULE_MAX_AGE_DAYS = 180

export interface ModuleFreshnessRow {
  id: string
  title: string | null
  is_ai_generated: boolean | null
  status: string | null
  published_at: string | null
  updated_at: string | null
  created_at: string | null
}

/** PURE: the effective "content date" of a module — most recent of published/updated/created. */
export function moduleContentDate(m: ModuleFreshnessRow): string | null {
  return m.published_at ?? m.updated_at ?? m.created_at ?? null
}

/** PURE: days since the module's content date (null when undated). */
export function moduleAgeDays(m: ModuleFreshnessRow, now: Date): number | null {
  const d = moduleContentDate(m)
  if (!d) return null
  const t = Date.parse(d)
  if (Number.isNaN(t)) return null
  return Math.floor((now.getTime() - t) / 86_400_000)
}

/**
 * PURE: is this module stale? Only PUBLISHED, AI-AUTHORED modules are subject to age refresh (a
 * human-authored broker module isn't the OS's to flag; a draft isn't live yet). Undated → not stale
 * (honest — nothing to measure), never a fabricated flag.
 */
export function isModuleStale(m: ModuleFreshnessRow, now: Date, maxAgeDays = MODULE_MAX_AGE_DAYS): boolean {
  if (m.status !== "published" || m.is_ai_generated !== true) return false
  const age = moduleAgeDays(m, now)
  return age != null && age >= maxAgeDays
}

/** PURE: the stale modules, oldest-first, capped for the brief. */
export function staleModules(modules: ModuleFreshnessRow[], now: Date, opts: { maxAgeDays?: number; limit?: number } = {}): Array<ModuleFreshnessRow & { ageDays: number }> {
  const maxAge = opts.maxAgeDays ?? MODULE_MAX_AGE_DAYS
  const out = modules
    .filter((m) => isModuleStale(m, now, maxAge))
    .map((m) => ({ ...m, ageDays: moduleAgeDays(m, now)! }))
    .sort((a, b) => b.ageDays - a.ageDays)
  return typeof opts.limit === "number" ? out.slice(0, opts.limit) : out
}

export interface FreshnessResult { scanned: number; stale: number; briefProposed: boolean }

/**
 * Scan a brokerage's published AI modules for age staleness and propose ONE gated weekly refresh brief to
 * the broker (deduped per brokerage×ISO week). Governed: it names the modules to refresh; a human triggers
 * re-authoring through the existing review workflow. Best-effort.
 */
export async function runContentFreshness(svc: Svc, params: { brokerageId: string; now?: Date; maxAgeDays?: number }): Promise<FreshnessResult> {
  const out: FreshnessResult = { scanned: 0, stale: 0, briefProposed: false }
  const now = params.now ?? new Date()

  // Brokerage modules + platform-wide (null brokerage) AI modules.
  const { data: rows } = await svc.from("learning_modules")
    .select("id, title, is_ai_generated, status, published_at, updated_at, created_at")
    .or(`brokerage_id.eq.${params.brokerageId},brokerage_id.is.null`)
    .eq("status", "published").eq("is_ai_generated", true).limit(5000)
  const modules = (rows ?? []) as ModuleFreshnessRow[]
  out.scanned = modules.length
  const stale = staleModules(modules, now, { maxAgeDays: params.maxAgeDays, limit: 12 })
  out.stale = stale.length
  if (stale.length === 0) return out

  const { isoWeekKey } = await import("@/lib/recruiting/switch-propensity-scout")
  const dedupeTag = `EDU FRESHNESS — ${isoWeekKey(now)}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", params.brokerageId).eq("entity_type", "brokerage").eq("entity_id", params.brokerageId)
    .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
  if (prior) return out

  const lines = [
    `${stale.length} AI-authored lesson${stale.length === 1 ? "" : "s"} ${stale.length === 1 ? "is" : "are"} over ${params.maxAgeDays ?? MODULE_MAX_AGE_DAYS} days old — real-estate law and market facts drift, so these are due for a refresh before they mislead:`,
    ...stale.slice(0, 8).map((m) => `• "${m.title ?? "Untitled lesson"}" — ${m.ageDays} days old.`),
    `Refresh regenerates a fresh draft through the normal review queue; nothing live changes until you approve it.`,
  ]
  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "brokerage", entityId: params.brokerageId,
      recipientContactId: null, audience: "agent",
      subject: `${stale.length} lesson${stale.length === 1 ? "" : "s"} due for a content refresh`,
      body: lines.join("\n\n"),
      rationale: `${dedupeTag} — ${stale.length} stale; review before it reaches the broker.`,
      channel: "portal",
    }, svc)
    out.briefProposed = res.ok
  } catch { /* best-effort */ }
  return out
}

/** Autonomous: run the freshness scan for every brokerage (rides the weekly recruit-outreach cron). */
export async function runContentFreshnessAll(svc: Svc, now?: Date): Promise<{ brokerages: number; stale: number; briefs: number }> {
  const out = { brokerages: 0, stale: 0, briefs: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runContentFreshness(svc, { brokerageId: b.id, now }); out.stale += r.stale; if (r.briefProposed) out.briefs++ } catch { /* keep going */ }
  }
  return out
}
