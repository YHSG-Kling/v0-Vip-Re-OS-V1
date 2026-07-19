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
  /** PER-TENANT STAFF HALT — platform staff paused autonomy for THIS brokerage (feature_access_overrides
   *  'autonomy' kill). Sits BETWEEN the god switch and the tenant's own broker-set posture: the broker's
   *  'autonomous' setting cannot override it; human-approved sends are unaffected. */
  tenantHalt?: { halted: boolean; reason: string | null }
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

  // PER-TENANT STAFF HALT — below the god switch, above the tenant's own posture. A brokerage whose
  // autonomy was paused by platform staff holds every autonomous manager send regardless of the
  // broker-set posture; only the platform (not the tenant) can lift it.
  if (input.tenantHalt?.halted) {
    return {
      allow: false,
      held: true,
      posture: "approval_required",
      reason: input.tenantHalt.reason ?? `${input.managerKey} held — autonomous AI is paused for this brokerage by platform staff.`,
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

// ── PER-TENANT AUTONOMY HALT — the staff lever between the god switch and broker posture ──
// HOME: feature_access_overrides (brokerage-scoped 'disable' on the 'autonomy' feature key).
// Chosen because it is the ONE brokerage-anchored kill switch the tenant cannot silently clear:
//   · managed_agents.config is broker-WRITABLE by design (setBrokerAutonomyOverrideAction
//     rewrites config, and posture=null deletes autonomy_* keys) — a staff flag there could be
//     clobbered by an ordinary tenant settings save.
//   · brokerages.* (e.g. billing_metadata) is updatable by the tenant's own admin under the
//     row-level brokerages_update RLS policy (063-rpcs-and-rls-fixes.sql) — RLS is row-level,
//     not column-level, so a jsonb flag there is tenant-reachable.
//   · feature_access_overrides has NO tenant-side write path anywhere in the app: every writer
//     is a superadmin/platform-staff-gated action on the SERVICE client.
// The 'autonomy' feature key honestly names what is being killed: the autonomous dispatch path.

/** The feature_access_overrides.feature_key that carries the per-tenant autonomy halt. */
export const TENANT_AUTONOMY_FEATURE_KEY = "autonomy"

export interface TenantAutonomyHalt {
  halted: boolean
  /** The staff-entered reason (feature_access_overrides.disabled_reason) — shown to the tenant. */
  reason: string | null
  haltedAt: string | null
}

const NOT_HALTED: TenantAutonomyHalt = { halted: false, reason: null, haltedAt: null }
const tenantHaltCache = new Map<string, { value: TenantAutonomyHalt; expiresAt: number }>()
const TENANT_HALT_TTL_MS = 20_000

/** Read the per-tenant staff halt. FAILS OPEN (not halted) on any infra error — a halt is a
 *  deliberate staff switch, never a side-effect of a transient DB hiccup. Short-TTL cached. */
export async function loadTenantAutonomyHalt(brokerageId: string, client?: Svc): Promise<TenantAutonomyHalt> {
  const hit = tenantHaltCache.get(brokerageId)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  let value: TenantAutonomyHalt = NOT_HALTED
  try {
    const svc = client ?? createServiceClient()
    const { data } = await svc
      .from("feature_access_overrides")
      .select("override_type, disabled_reason, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("feature_key", TENANT_AUTONOMY_FEATURE_KEY)
      .is("user_id", null)
      .is("team_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (data && (data as any).override_type === "disable") {
      value = {
        halted: true,
        reason: (data as any).disabled_reason ?? "Autonomous AI is paused for this brokerage by platform staff.",
        haltedAt: (data as any).created_at ?? null,
      }
    }
  } catch { /* fail open */ }
  tenantHaltCache.set(brokerageId, { value, expiresAt: Date.now() + TENANT_HALT_TTL_MS })
  return value
}

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

  // PER-TENANT STAFF HALT second — same hook point, one tenant instead of all. When platform staff
  // paused THIS brokerage's autonomy, every manager reads as approval_required so autonomyDecision
  // holds all autonomous sends for the tenant (human-approved sends still bypass in the decision),
  // again with ZERO changes at the existing call sites. Fails open like the god switch.
  try {
    const tenantHalt = await loadTenantAutonomyHalt(brokerageId, client)
    if (tenantHalt.halted) return "approval_required"
  } catch { /* fail open */ }

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

/** Test seam / post-write invalidation — clear the in-process posture + tenant-halt caches. */
export function __clearAutonomyCache(): void {
  cache.clear()
  tenantHaltCache.clear()
}
