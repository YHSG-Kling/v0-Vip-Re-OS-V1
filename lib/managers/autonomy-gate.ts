// lib/managers/autonomy-gate.ts
//
// AUTONOMY-GATED DISPATCH — the enforcement link the Trust Scorecard was missing.
// eval-scoring.ts grades every manager and recommends an autonomy posture; the broker can
// override it (managed_agents.config.autonomy_tier). Until now that posture was DISPLAYED
// but never ENFORCED. This is the gate dispatch.ts consults before an AUTONOMOUS manager
// send: a manager on `approval_required` (broker policy, or eval-derived probation/
// insufficient-data) may NOT send unattended — it must route to the approval queue instead.
//
// Design guarantees (so turning this on never breaks a working flow):
//   1. Only governed MANAGER actors are gated — a send with no managerKey (transactional /
//      B2B / system) is never touched.
//   2. HUMAN-APPROVED sends are never blocked — the human already exercised judgment (the
//      approval queue dispatches with systemSource 'agent_client_message').
//   3. ABSENCE of data ⇒ ALLOW. We only HOLD on an explicit approval_required signal
//      (broker override or a persisted eval-derived posture), never by missing config — so
//      an unconfigured manager keeps working.
//
// NOT server-only (simulator-driven, like the rest of the managers layer).

import { createServiceClient } from "@/lib/supabase/service"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import { isAutonomyPosture, type AutonomyPosture } from "@/lib/managers/eval-scoring"

/** The approval-queue dispatcher stamps this systemSource — a human already approved it. */
export const HUMAN_APPROVED_SYSTEM_SOURCE = "agent_client_message"

/**
 * Map a dispatch `systemSource` to the governed manager that owns that AUTONOMOUS outreach,
 * so the gate goes live across existing senders without rewiring 20 call sites. ONLY
 * unambiguous discretionary client-outreach sources are mapped; transactional / B2B / system
 * sources (transaction_notification, review_request, vendor_*, credit_copilot, voice_tts, …)
 * are intentionally absent ⇒ never gated. An explicit params.managerKey always wins over this.
 */
export const SYSTEM_SOURCE_TO_MANAGER: Readonly<Record<string, ManagerKey>> = {
  sequence: "campaign_orchestrator",
  newsletter: "campaign_orchestrator",
  ai_isa: "ai_isa",
  ghost_recovery: "ai_isa",
}

/** Resolve the acting manager for a send: explicit key wins, else infer from systemSource. */
export function managerForDispatch(managerKey?: ManagerKey | null, systemSource?: string): ManagerKey | null {
  if (managerKey) return managerKey
  if (systemSource && systemSource in SYSTEM_SOURCE_TO_MANAGER) return SYSTEM_SOURCE_TO_MANAGER[systemSource]
  return null
}

export interface AutonomyDecisionInput {
  /** The governed manager doing the send. Absent ⇒ not a manager action ⇒ never gated. */
  managerKey?: ManagerKey | null
  /** The manager's effective posture (override ?? eval-derived). null ⇒ no signal ⇒ allow. */
  effective: AutonomyPosture | null
  /** A human approved this send (approval queue). Never gated. */
  humanApproved?: boolean
  /** PLATFORM CIRCUIT-BREAKER — when the superadmin's god switch is halted (emergency mode / AI engine off),
   *  every autonomous manager action is held platform-wide, overriding per-tenant posture. */
  platformHalt?: { halted: boolean; reason: string | null }
}

export interface AutonomyDecision {
  allow: boolean
  held: boolean
  posture: AutonomyPosture | null
  reason: string | null
}

/**
 * PURE decision (no I/O) — the action, the gate, and the simulator all decide through this so
 * the posture the broker sets is exactly what dispatch enforces.
 */
export function autonomyDecision(input: AutonomyDecisionInput): AutonomyDecision {
  // Not a governed manager action (transactional/B2B/system) → out of scope for autonomy.
  if (!input.managerKey) return { allow: true, held: false, posture: null, reason: null }
  // Human exercised judgment via the approval queue → never block.
  if (input.humanApproved) return { allow: true, held: false, posture: input.effective ?? null, reason: null }

  // PLATFORM CIRCUIT-BREAKER — the god switch overrides per-tenant posture: hold every autonomous manager
  // action across all tenants while the platform is halted (emergency mode / AI engine off).
  if (input.platformHalt?.halted) {
    return {
      allow: false,
      held: true,
      posture: "approval_required",
      reason: input.platformHalt.reason ?? `${input.managerKey} held — platform is halted (emergency mode).`,
    }
  }

  if (input.effective === "approval_required") {
    return {
      allow: false,
      held: true,
      posture: "approval_required",
      reason: `${input.managerKey} is approval_required — autonomous send held; route to the approval queue for human review`,
    }
  }
  // autonomous / review_recommended (advisory only) / no-signal → allow.
  return { allow: true, held: false, posture: input.effective ?? null, reason: null }
}

// ── DB-backed posture resolver (managed_agents.config is policy reference data) ──────────
// Short TTL cache keeps the send-time gate O(1) on a hot path; policy changes propagate
// within the window. effective = broker override ?? persisted eval-derived recommendation.
type Svc = ReturnType<typeof createServiceClient>
const cache = new Map<string, { posture: AutonomyPosture | null; expiresAt: number }>()
const TTL_MS = 60_000

/** Resolve a manager's effective autonomy posture for a brokerage. null ⇒ no signal ⇒ allow. */
export async function resolveManagerAutonomy(
  brokerageId: string,
  managerKey: ManagerKey,
  client?: Svc,
): Promise<AutonomyPosture | null> {
  // PLATFORM CIRCUIT-BREAKER first — the god switch. When the platform is halted (emergency mode / AI
  // engine off), every manager reads as approval_required so autonomyDecision holds all autonomous sends
  // across every tenant, with ZERO changes at the ~20 existing call sites. Own short-TTL cache; fails open.
  try {
    const { loadPlatformHalt } = await import("@/lib/platform/platform-controls")
    const halt = await loadPlatformHalt(client)
    if (halt.halted) return "approval_required"
  } catch { /* fail open — never freeze the platform on an infra hiccup */ }

  const cacheKey = `${brokerageId}:${managerKey}`
  const hit = cache.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) return hit.posture

  let posture: AutonomyPosture | null = null
  try {
    const svc = client ?? createServiceClient()
    const { data } = await svc
      .from("managed_agents")
      .select("config")
      .eq("brokerage_id", brokerageId)
      .eq("agent_kind", managerKey)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const cfg = (data?.config ?? {}) as Record<string, unknown>
    const override = isAutonomyPosture(cfg.autonomy_tier) ? cfg.autonomy_tier : null
    const recommended = isAutonomyPosture(cfg.autonomy_recommended) ? cfg.autonomy_recommended : null
    posture = override ?? recommended ?? null // override wins; absence ⇒ null ⇒ allow
  } catch {
    posture = null // fail OPEN for autonomy (never block a send on an infra hiccup; consent/FH gates already ran)
  }
  cache.set(cacheKey, { posture, expiresAt: Date.now() + TTL_MS })
  return posture
}

/** Test seam — clear the in-process posture cache. */
export function __clearAutonomyCache(): void {
  cache.clear()
}
