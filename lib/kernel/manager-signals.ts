// lib/kernel/manager-signals.ts
//
// THE INTER-MANAGER BUS — managers talking to one another, first-class. Until now the
// 11 Claude managers ran closed loops with point-to-point handoffs buried in code. This
// makes every manager-to-manager conversation explicit, auditable, and actionable:
//
//   publishManagerSignal()  — a manager announces an outcome addressed to another manager
//   consumeManagerSignals() — the addressed manager reads its open inbox and ACTS (usually
//                             by proposing a governed deliverable into the gate), then marks
//                             the signal consumed WITH what it did.
//   loadRecentManagerTalk() — the Command Center's "managers talking" feed.
//
// First wired conversation (the proof): AI ISA finishes a dial batch → publishes per-outcome
// signals — appointment_set → the side-appropriate concierge ("your client booked, prep the
// next step"); cold call result → back into propensity as a cooldown. More conversations
// join the same bus (deal closed → Sphere, recruit joined → Recruiting → Deal Coordinator…).
//
// NOT server-only (by convention, like command-center.ts) so simulators drive it end-to-end.
// Only ever writes through a caller-supplied/service client — never import client-side.

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export interface ManagerSignal {
  id: string
  fromManager: ManagerKey
  toManager: ManagerKey
  signalType: string
  message: string
  entityType: string | null
  entityId: string | null
  contactId: string | null
  payload: Record<string, unknown>
  status: "open" | "consumed" | "expired"
  createdAt: string
}

export interface PublishSignalInput {
  brokerageId: string
  fromManager: ManagerKey
  toManager: ManagerKey
  signalType: string
  message: string
  entityType?: string | null
  entityId?: string | null
  contactId?: string | null
  payload?: Record<string, unknown>
  /** Idempotency: when set, skip publishing if an OPEN signal with the same
   *  (to_manager, signal_type, entity_id) already exists. Default true. */
  dedupe?: boolean
}

/** Pure: both ends of a signal must be real registered managers. */
export function validSignalRoute(from: string, to: string): boolean {
  return from in MANAGERS && to in MANAGERS && from !== to
}

/** A manager announces an outcome to another manager. Idempotent per open (to, type, entity). */
export async function publishManagerSignal(
  input: PublishSignalInput, client?: Svc,
): Promise<{ ok: boolean; signalId?: string; reason?: string }> {
  const supabase = client ?? createServiceClient()
  if (!validSignalRoute(input.fromManager, input.toManager)) {
    return { ok: false, reason: `invalid route ${input.fromManager} → ${input.toManager}` }
  }
  if (input.dedupe !== false && input.entityId) {
    const { data: existing } = await supabase
      .from("manager_signals").select("id")
      .eq("brokerage_id", input.brokerageId).eq("to_manager", input.toManager)
      .eq("signal_type", input.signalType).eq("entity_id", input.entityId)
      .eq("status", "open").limit(1).maybeSingle()
    if (existing) return { ok: true, signalId: (existing as { id: string }).id, reason: "already open (deduped)" }
  }
  const { data, error } = await supabase.from("manager_signals").insert({
    brokerage_id: input.brokerageId,
    from_manager: input.fromManager,
    to_manager: input.toManager,
    signal_type: input.signalType,
    message: input.message,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    contact_id: input.contactId ?? null,
    payload: input.payload ?? {},
  }).select("id").single()
  if (error || !data) return { ok: false, reason: error?.message ?? "insert failed" }
  return { ok: true, signalId: (data as { id: string }).id }
}

/** A signal handler: acts on one signal, returns the action taken (or null to leave open). */
export type SignalHandler = (signal: ManagerSignal, ctx: { brokerageId: string; supabase: Svc }) => Promise<string | null>

/** The registered conversations — to_manager:signal_type → handler. Handlers act by
 *  proposing GOVERNED deliverables (the gate), never autonomous sends. */
export const SIGNAL_HANDLERS: Record<string, SignalHandler> = {
  // AI ISA → concierge: a dial-batch call booked an appointment. The concierge proposes
  // the prep follow-up to the client through the gate.
  "shopping_agent:isa_call_appointment": async (signal, ctx) => {
    if (!signal.contactId) return null
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "shopping_agent", entityType: "contact",
      entityId: signal.contactId, recipientContactId: signal.contactId, audience: "buyer",
      subject: "Looking forward to our appointment",
      body: "Great speaking with you! Ahead of our appointment I'll pull together homes matched to what you described — reply here with anything you'd like me to include.",
      rationale: `AI ISA booked an appointment on a dial-batch call — prep follow-up (signal ${signal.signalType}).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed buyer prep follow-up (gate message ${res.id})` : null
  },
  "listing_concierge:isa_call_appointment": async (signal, ctx) => {
    if (!signal.contactId) return null
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: ctx.brokerageId, agentKind: "listing_concierge", entityType: "contact",
      entityId: signal.contactId, recipientContactId: signal.contactId, audience: "seller",
      subject: "Looking forward to our appointment",
      body: "Great speaking with you! Ahead of our appointment I'll prepare a current market position for your home — reply here with anything you'd like me to cover.",
      rationale: `AI ISA booked an appointment on a dial-batch call — listing prep follow-up (signal ${signal.signalType}).`,
      channel: "portal",
    }, ctx.supabase)
    return res.ok ? `proposed seller prep follow-up (gate message ${res.id})` : null
  },
}

/**
 * The addressed manager reads its open inbox and acts. Each handled signal is marked
 * consumed WITH the action taken. Signals with no registered handler stay open (a human
 * sees them on the Command Center feed). Returns counts.
 */
export async function consumeManagerSignals(
  params: { brokerageId: string; toManager: ManagerKey; limit?: number },
  client?: Svc,
): Promise<{ consumed: number; skipped: number }> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase
    .from("manager_signals")
    .select("id, from_manager, to_manager, signal_type, message, entity_type, entity_id, contact_id, payload, status, created_at")
    .eq("brokerage_id", params.brokerageId).eq("to_manager", params.toManager).eq("status", "open")
    .order("created_at", { ascending: true }).limit(params.limit ?? 50)

  let consumed = 0, skipped = 0
  for (const row of (data ?? []) as any[]) {
    const signal: ManagerSignal = {
      id: row.id, fromManager: row.from_manager, toManager: row.to_manager,
      signalType: row.signal_type, message: row.message, entityType: row.entity_type,
      entityId: row.entity_id, contactId: row.contact_id, payload: row.payload ?? {},
      status: row.status, createdAt: row.created_at,
    }
    const handler = SIGNAL_HANDLERS[`${signal.toManager}:${signal.signalType}`]
    if (!handler) { skipped += 1; continue }
    let action: string | null = null
    try { action = await handler(signal, { brokerageId: params.brokerageId, supabase }) }
    catch (e) { console.error(`[manager-signals] handler failed for ${signal.id}:`, e); skipped += 1; continue }
    if (!action) { skipped += 1; continue }
    await supabase.from("manager_signals")
      .update({ status: "consumed", consumed_at: new Date().toISOString(), consumed_action: action })
      .eq("id", signal.id).eq("status", "open")
    consumed += 1
  }
  return { consumed, skipped }
}

export interface ManagerTalkLine {
  id: string
  fromLabel: string
  toLabel: string
  message: string
  status: string
  consumedAction: string | null
  createdAt: string
}

/** The Command Center's "managers talking" feed — recent inter-manager conversation. */
export async function loadRecentManagerTalk(
  brokerageId: string, limit = 20, client?: Svc,
): Promise<ManagerTalkLine[]> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase
    .from("manager_signals")
    .select("id, from_manager, to_manager, message, status, consumed_action, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false }).limit(limit)
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    fromLabel: (r.from_manager in MANAGERS ? MANAGERS[r.from_manager as ManagerKey].label : r.from_manager),
    toLabel: (r.to_manager in MANAGERS ? MANAGERS[r.to_manager as ManagerKey].label : r.to_manager),
    message: r.message,
    status: r.status,
    consumedAction: r.consumed_action ?? null,
    createdAt: r.created_at,
  }))
}
