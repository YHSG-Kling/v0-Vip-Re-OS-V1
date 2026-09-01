"use server"

/**
 * app/actions/deconflict-cockpit.ts
 *
 * The broker-cockpit read over deconflict_suppression_log — the reader half the
 * De-Conflict Engine has promised since m113 (lib/kernel/deconflict/index.ts:36
 * "every decision (allowed OR suppressed) writes one row to
 * deconflict_suppression_log, which the broker cockpit reads"). The writers were
 * live (evaluateDeconflict / evaluateBroadcastDeconflict, and every pre-dial
 * stack via lib/voice/outbound-call-gates.ts) and the only reader was
 * GET /api/admin/deconflict — a session-gated route with zero UI. Built per
 * CLAUDE.md §1.2: no duplicate reader existed, so the missing half is built.
 *
 * Gate first, then the service client (the pattern named at
 * lib/kernel/manager-registry.ts): deconflict_suppression_log is written on the
 * service client and has no tenant SELECT surface, so this read runs on the
 * service client ONLY after the session's role and brokerage are established,
 * and is always filtered to the session's brokerage (§4 — tenant from the
 * SESSION, never a parameter) — EXCEPT for platform staff, whose cross-tenant
 * view was the one capability of GET /api/admin/deconflict this action lacked:
 * merged here per §1.1 (2026-09-01) before that route's retirement, decided by
 * BOTH identity columns via isPlatformStaffIdentity (the discriminator's one
 * definition), the same treatment the manager-session detail got. Platform
 * rows carry brokerage_id so the cross-tenant view can say whose decision
 * each row was.
 *
 * Verdict shape mirrors app/actions/system-health.ts's HealthRead discipline:
 * a refused read renders as "unavailable", an empty window renders as "no
 * decisions recorded" (absence of traffic, not a clean bill), and only an ok
 * read renders numbers.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { isAdminOrBroker, isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"

/** One engine decision, exactly the columns the two writers populate
 *  (lib/kernel/deconflict/index.ts:276 broadcast, :362 per-contact). */
export interface DeconflictDecisionRow {
  id: string
  /** Present only on the platform-staff cross-tenant view, so the cockpit can
   *  say whose decision each row was. Tenant reads never need it — every row
   *  is theirs. */
  brokerage_id?: string | null
  contact_id: string | null
  recipient_email: string | null
  recipient_phone: string | null
  channel: string
  system_source: string | null
  outcome: string
  reason: string | null
  touches_in_window: number | null
  window_days: number | null
  policy_max: number | null
  created_at: string
}

export interface DeconflictChannelRollup {
  channel: string
  allowed: number
  suppressed: number
}

export interface DeconflictActivity {
  sinceIso: string
  windowDays: number
  total: number
  suppressed: number
  byChannel: DeconflictChannelRollup[]
  decisions: DeconflictDecisionRow[]
}

export type DeconflictActivityRead =
  | { status: "ok"; data: DeconflictActivity }
  | { status: "empty"; detail: string }
  | { status: "unavailable"; detail: string }

export async function getDeconflictActivity(
  windowDays = 7,
): Promise<DeconflictActivityRead> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { status: "unavailable", detail: "Not signed in." }
  }

  const svc = createServiceClient()

  // Platform staff read CROSS-TENANT (merged from GET /api/admin/deconflict
  // before its retirement, §1.1). AgentContext carries no platform_role, so the
  // identity row is read the way the route read it — BOTH columns through
  // isPlatformStaffIdentity. A refused identity read fails CLOSED to the
  // tenant path, never open to the platform view.
  const { data: identity, error: identityError } = await svc
    .from("users")
    .select("user_type, platform_role")
    .eq("id", ctx.userId)
    .maybeSingle()
  const isPlatform =
    !identityError &&
    isPlatformStaffIdentity(
      (identity as { user_type?: string | null } | null)?.user_type,
      (identity as { platform_role?: string | null } | null)?.platform_role,
    )

  // Same entry gate as the page that renders this (broker/admin ops surface) —
  // platform staff pass on their own column.
  if (!isPlatform && !isAdminOrBroker({ user_type: ctx.userType })) {
    return {
      status: "unavailable",
      detail: "The De-Conflict log is limited to brokerage admin roles.",
    }
  }
  // §4 fail closed: a session with no brokerage has no tenant to read under.
  // A missing tenant is NOT the platform — only the identity columns are.
  if (!isPlatform && !ctx.brokerageId) {
    return {
      status: "unavailable",
      detail:
        "This session has no brokerage, so the suppression log cannot be scoped. Nothing is shown rather than another tenant's decisions.",
    }
  }

  const days = Math.min(Math.max(Math.trunc(windowDays) || 7, 1), 90)
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()

  let q = svc
    .from("deconflict_suppression_log")
    .select(
      "id, brokerage_id, contact_id, recipient_email, recipient_phone, channel, system_source, outcome, reason, touches_in_window, window_days, policy_max, created_at",
    )
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(500)
  if (!isPlatform) q = q.eq("brokerage_id", ctx.brokerageId)
  const { data: rows, error } = await q

  if (error) {
    // A refused read must never render as "no outbound was suppressed".
    return {
      status: "unavailable",
      detail: `deconflict_suppression_log read was refused: ${error.message}`,
    }
  }

  const decisions = (rows ?? []) as DeconflictDecisionRow[]
  if (decisions.length === 0) {
    return {
      status: "empty",
      detail:
        `No de-conflict decision was recorded ${isPlatform ? "on any tenant" : "for this brokerage"} in the last ${days} days. ` +
        "The engine writes one row per evaluated outbound (allowed or suppressed) — an empty log means no evaluated outbound ran, not that every send passed.",
    }
  }

  const byChannelMap = new Map<string, { allowed: number; suppressed: number }>()
  let suppressed = 0
  for (const d of decisions) {
    const entry = byChannelMap.get(d.channel) ?? { allowed: 0, suppressed: 0 }
    if (d.outcome === "allowed") entry.allowed += 1
    else {
      entry.suppressed += 1
      suppressed += 1
    }
    byChannelMap.set(d.channel, entry)
  }
  const byChannel = Array.from(byChannelMap.entries())
    .map(([channel, counts]) => ({ channel, ...counts }))
    .sort((a, b) => b.suppressed - a.suppressed || b.allowed - a.allowed)

  return {
    status: "ok",
    data: {
      sinceIso,
      windowDays: days,
      total: decisions.length,
      suppressed,
      byChannel,
      decisions,
    },
  }
}
