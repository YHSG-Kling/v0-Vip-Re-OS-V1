"use server"

/**
 * FLIGHT RECORDER — "why did the AI send this?" (wave 97, lane 97A; gap map rows 12 + 17).
 *
 * Returns one entity's causal chain: its lifecycle_events and the action-ledger rows about it,
 * plus the events that CAUSED those rows and the actions those events caused on other subjects,
 * merged in time order with reason codes (lib/kernel/action-ledger.ts assembleCausalChain).
 *
 * TENANT FROM THE SESSION, never from the arguments (CLAUDE.md §4): the caller names an entity,
 * and every read is pinned to the session's brokerage. Gate first (tenant admin — the ledger
 * carries brokerage-side cost and manager decisions), then the service client.
 *
 * DEGRADES until m687 is applied: no ledger table → events only (`ledgerAvailable: false`);
 * no causation columns → events without lineage (`causationAvailable: false`). Never throws.
 */
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import {
  assembleCausalChain,
  type ChainAction,
  type ChainEvent,
  type ChainLink,
} from "@/lib/kernel/action-ledger"
import { loadLedgerAttribution, type LedgerAttribution } from "@/lib/intelligence/roi-ledger"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { replayDecisions, type ReplayDecisionsResult } from "@/lib/kernel/decision-replay"
import { loadExperimentPolicy, type ExperimentPolicy } from "@/lib/kernel/experiments"
import { loadDirectMailExplorationPolicy, type DirectMailExplorationPolicy } from "@/lib/direct-mail/variant-bandit"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"

export type CausalChainResult =
  | { ok: true; chain: ChainLink[]; ledgerAvailable: boolean; causationAvailable: boolean; attribution: LedgerAttribution | null; attributionError: string | null }
  | { ok: false; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENTITY_TYPE_RE = /^[a-z][a-z_]{1,39}$/
const LIMIT = 200
const EVENT_BASE = "id, event_type, entity_type, entity_id, created_at"
const EVENT_LINEAGE = `${EVENT_BASE}, causation_id, correlation_id`
// 102D — which policy permitted (m700, APPLIED LIVE 2026-10-05): policy_ref is read with the rest.
// The pre-apply fallback (retry on the base columns when only policy_ref was absent) was retired at
// integration: a column-list VARIABLE hides every column from the readerless-write census, and the
// column is live. One literal list, one read shape.
const ACTION_COLS =
  "id, action, status, reason_code, reason_detail, outcome, subject_type, subject_id, actor_type, actor_manager_key, actor_user_id, actor_agent_id, subject_ref, risk_class, system_source, cost_usd, detail, created_at, settled_at, error, causation_id, correlation_id, policy_ref"

function schemaAbsent(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204"
}

export async function getEntityCausalChain(input: { entityType: string; entityId: string }): Promise<CausalChainResult> {
  const entityType = String(input?.entityType ?? "").trim()
  const entityId = String(input?.entityId ?? "").trim()
  if (!ENTITY_TYPE_RE.test(entityType) || !UUID_RE.test(entityId)) return { ok: false, error: "Invalid entity" }

  // ── GATE FIRST (fail closed) ──
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) return { ok: false, error: "Not authenticated" }
  const admin = await resolveTenantAdmin(await createClient(), ctx.userId, { user_type: ctx.userType, brokerage_id: ctx.brokerageId })
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin) return { ok: false, error: "Only a broker or a brokerage admin can open the flight recorder." }
  const brokerageId = ctx.brokerageId

  const svc = createServiceClient()

  // 1. The entity's own events (with lineage when m687 is live).
  let causationAvailable = true
  let ev: { data: unknown[] | null; error: { code?: string; message: string } | null } = await svc.from("lifecycle_events").select(EVENT_LINEAGE)
    .eq("brokerage_id", brokerageId).eq("entity_type", entityType).eq("entity_id", entityId)
    .order("created_at", { ascending: true }).limit(LIMIT)
  if (ev.error && schemaAbsent(ev.error.code)) {
    causationAvailable = false
    ev = await svc.from("lifecycle_events").select(EVENT_BASE)
      .eq("brokerage_id", brokerageId).eq("entity_type", entityType).eq("entity_id", entityId)
      .order("created_at", { ascending: true }).limit(LIMIT)
  }
  if (ev.error) return { ok: false, error: `Events could not be read: ${ev.error.message}` }
  const events = new Map<string, ChainEvent>()
  for (const e of (ev.data ?? []) as ChainEvent[]) events.set(e.id, e)

  // 2. Ledger rows about the entity, and rows its events caused elsewhere.
  let ledgerAvailable = true
  const actions = new Map<string, ChainAction>()
  const own = await svc.from("agent_action_ledger").select(ACTION_COLS)
    .eq("brokerage_id", brokerageId).eq("subject_type", entityType).eq("subject_id", entityId)
    .order("created_at", { ascending: true }).limit(LIMIT)
  if (own.error) {
    if (!schemaAbsent(own.error.code)) return { ok: false, error: `Action ledger could not be read: ${own.error.message}` }
    ledgerAvailable = false
  } else {
    for (const a of (own.data ?? []) as ChainAction[]) actions.set(a.id, a)
    // WAVE 104 (lane 104D): a MISSION's chain also carries the actions attached to it — ledger rows
    // whose detail names the mission (the chains, sends and tool calls that served the objective).
    if (entityType === "mission") {
      const served = await svc.from("agent_action_ledger").select(ACTION_COLS)
        .eq("brokerage_id", brokerageId).contains("detail", { mission_id: entityId })
        .order("created_at", { ascending: true }).limit(LIMIT)
      if (served.error) return { ok: false, error: `Action ledger could not be read: ${served.error.message}` }
      for (const a of (served.data ?? []) as ChainAction[]) actions.set(a.id, a)
    }
    const eventIds = [...events.keys()].slice(0, LIMIT)
    if (eventIds.length > 0) {
      const caused = await svc.from("agent_action_ledger").select(ACTION_COLS)
        .eq("brokerage_id", brokerageId).in("causation_id", eventIds).limit(LIMIT)
      if (caused.error) return { ok: false, error: `Action ledger could not be read: ${caused.error.message}` }
      for (const a of (caused.data ?? []) as ChainAction[]) actions.set(a.id, a)
    }
  }

  // 3. The parents: events that caused these rows but live on another entity (one hop per pass,
  //    three passes — enough for event → reactor → child → send without an unbounded walk).
  if (causationAvailable) {
    for (let pass = 0; pass < 3; pass++) {
      const missing = new Set<string>()
      for (const x of [...events.values(), ...actions.values()]) {
        if (x.causation_id && !events.has(x.causation_id)) missing.add(x.causation_id)
      }
      if (missing.size === 0) break
      const parents = await svc.from("lifecycle_events").select(EVENT_LINEAGE)
        .eq("brokerage_id", brokerageId).in("id", [...missing].slice(0, LIMIT))
      if (parents.error) return { ok: false, error: `Parent events could not be read: ${parents.error.message}` }
      const rows = (parents.data ?? []) as ChainEvent[]
      if (rows.length === 0) break
      for (const e of rows) events.set(e.id, e)
    }
  }

  // 4. Wave 100A — what these actions EARNED: the person's / deal's outcomes (reply, appointment,
  //    contract, closed GCI) credited back to the ledger rows that preceded them, last-touch and
  //    all-touch (lib/intelligence/roi-ledger.ts loadLedgerAttribution — the same rule as the
  //    command-center tile). Pinned to the session tenant. A failed read is SAID, never a silent "earned nothing".
  let attribution: LedgerAttribution | null = null
  let attributionError: string | null = null
  if (ledgerAvailable && (entityType === "contact" || entityType === "transaction")) {
    const attr = await loadLedgerAttribution(svc, brokerageId, entityType === "contact" ? { contactId: entityId } : { transactionId: entityId })
    if (attr.ok) attribution = attr.result
    else attributionError = attr.error
  }

  return { ok: true, chain: assembleCausalChain([...events.values()], [...actions.values()]), ledgerAvailable, causationAvailable, attribution, attributionError }
}

// ═════════════════════════════════════════════════════════════════════════════
// DECISION REPLAY + EXPERIMENT KILL SWITCH (wave 101, lane 101B; gap map row 20) — on the AI audit
// page beside the flight recorder. Same gate shape: tenant FROM THE SESSION (no export here takes a
// tenant argument, so a cross-tenant replay has no way in; requireCallerTenant refuses a session
// with no tenant), tenant admin, then the service client pinned to that tenant.
// ═════════════════════════════════════════════════════════════════════════════

async function gateTenantAdmin(): Promise<{ ok: true; brokerageId: string; userId: string } | { ok: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  const admin = await resolveTenantAdmin(caller.supabase, caller.userId, { user_type: caller.userType, brokerage_id: caller.brokerageId })
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin) return { ok: false, error: "Only a broker or a brokerage admin can replay AI decisions or change experiments." }
  return { ok: true, brokerageId: caller.brokerageId, userId: caller.userId }
}

/** Replay this tenant's recorded NBA decisions through the CURRENT planner (lib/kernel/decision-replay.ts). Deterministic, no model calls. */
export async function replayTenantDecisions(input: {
  since?: string | null
  until?: string | null
  subjectType?: string | null
  subjectId?: string | null
}): Promise<ReplayDecisionsResult> {
  // No tenant argument at all (test:action-ledger §5): the replay is ALWAYS the session's tenant.
  const gate = await gateTenantAdmin()
  if (!gate.ok) return gate
  const since = input?.since && Number.isFinite(Date.parse(input.since)) ? input.since : new Date(Date.now() - 30 * 86_400_000).toISOString()
  const subjectType: "lead" | "contact" | null = input?.subjectType === "lead" ? "lead" : input?.subjectType === "contact" ? "contact" : null
  const subject = input?.subjectId && subjectType ? { type: subjectType, id: String(input.subjectId).trim() } : null
  return replayDecisions({ brokerageId: gate.brokerageId, since, until: input?.until ?? null, subject }, { client: createServiceClient() })
}

/** The tenant's experiment policy exactly as the assigner reads it (brokerage_settings.settings.experiments). */
export async function getTenantExperimentPolicy(): Promise<({ ok: true } & ExperimentPolicy) | { ok: false; error: string }> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) return gate
  return { ok: true, ...(await loadExperimentPolicy(createServiceClient(), gate.brokerageId)) }
}

/**
 * The per-tenant experiment KILL SWITCH — on: every experiment assigns its control arm
 * (lib/kernel/experiments.ts assignExperimentArm). Written through the ONE brokerage_settings writer
 * (mergeBrokerageSettings — by key, compare-and-set, refusals read).
 * MERGE POINT (lane 101A versioned tenant policy): when the versioned policy writer lands, this
 * write moves onto it so the toggle gets a policy version + audit row; loadExperimentPolicy is the reader to swap.
 */
export async function setExperimentKillSwitch(input: { on: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) return gate
  const on = input?.on === true
  const write = await mergeBrokerageSettings(createServiceClient(), gate.brokerageId, (settings) => {
    const prev = (settings.experiments && typeof settings.experiments === "object" ? settings.experiments : {}) as Record<string, unknown>
    return { experiments: { ...prev, kill_switch: on, kill_switch_set_by: gate.userId, kill_switch_set_at: new Date().toISOString() } }
  }, { policy: { type: "user", userId: gate.userId, reason: `experiment kill switch ${on ? "on" : "off"}` } })
  return write.ok ? { ok: true } : { ok: false, error: write.error }
}

// ── Direct-mail bandit kill switch (wave 102, lane 102C — owner answer 4) ───────────────────────
// Same gate, same ONE writer, same versioning: `direct_mail_exploration` is a registered tenant
// policy key (lib/kernel/tenant-policy.ts), so mergeBrokerageSettings appends a version with this
// actor on every change (appendTenantPolicyVersion) — the toggle sits beside `experiments` on the
// Manager Trust page's Operating Constitution (app/dashboard/admin/manager-trust/tenant-constitution-panel.tsx).

/** The tenant's direct-mail exploration policy exactly as the bandit reads it (fail closed: unreadable = frozen). */
export async function getDirectMailExplorationPolicy(): Promise<({ ok: true } & DirectMailExplorationPolicy) | { ok: false; error: string }> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) return gate
  return { ok: true, ...(await loadDirectMailExplorationPolicy(createServiceClient(), gate.brokerageId)) }
}

/** Freeze (exploit the best arm only) or resume the direct-mail bandit's exploration for the session tenant. */
export async function setDirectMailExplorationFrozen(input: { frozen: boolean }): Promise<{ ok: true; version: number | null } | { ok: false; error: string }> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) return gate
  const frozen = input?.frozen === true
  const write = await mergeBrokerageSettings(createServiceClient(), gate.brokerageId, (settings) => {
    const prev = (settings.direct_mail_exploration && typeof settings.direct_mail_exploration === "object" ? settings.direct_mail_exploration : {}) as Record<string, unknown>
    return { direct_mail_exploration: { ...prev, frozen, frozen_set_by: gate.userId, frozen_set_at: new Date().toISOString() } }
  }, { policy: { type: "user", userId: gate.userId, reason: `direct-mail exploration ${frozen ? "frozen" : "resumed"}` } })
  if (!write.ok) return { ok: false, error: write.error }
  const v = write.policyVersions.find((p) => p.key === "direct_mail_exploration")
  return { ok: true, version: v?.version ?? null }
}
