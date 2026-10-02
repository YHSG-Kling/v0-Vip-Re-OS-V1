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
  ACTION_LEDGER_TABLE,
  assembleCausalChain,
  type ChainAction,
  type ChainEvent,
  type ChainLink,
} from "@/lib/kernel/action-ledger"

export type CausalChainResult =
  | { ok: true; chain: ChainLink[]; ledgerAvailable: boolean; causationAvailable: boolean }
  | { ok: false; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENTITY_TYPE_RE = /^[a-z][a-z_]{1,39}$/
const LIMIT = 200
const EVENT_BASE = "id, event_type, entity_type, entity_id, created_at"
const EVENT_LINEAGE = `${EVENT_BASE}, causation_id, correlation_id`
const ACTION_COLS =
  "id, action, status, reason_code, reason_detail, outcome, subject_type, subject_id, actor_type, actor_manager_key, created_at, causation_id, correlation_id"

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
  const own = await svc.from(ACTION_LEDGER_TABLE).select(ACTION_COLS)
    .eq("brokerage_id", brokerageId).eq("subject_type", entityType).eq("subject_id", entityId)
    .order("created_at", { ascending: true }).limit(LIMIT)
  if (own.error) {
    if (!schemaAbsent(own.error.code)) return { ok: false, error: `Action ledger could not be read: ${own.error.message}` }
    ledgerAvailable = false
  } else {
    for (const a of (own.data ?? []) as ChainAction[]) actions.set(a.id, a)
    const eventIds = [...events.keys()].slice(0, LIMIT)
    if (eventIds.length > 0) {
      const caused = await svc.from(ACTION_LEDGER_TABLE).select(ACTION_COLS)
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

  return { ok: true, chain: assembleCausalChain([...events.values()], [...actions.values()]), ledgerAvailable, causationAvailable }
}
