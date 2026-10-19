/**
 * lib/esign/packet-state-writer.ts — THE ONE WRITER of the e-sign packet state (wave 142, lane 142B).
 *
 * Every hop of the owner's lifecycle (lib/esign/packet-states.ts) lands through this function:
 * the provider webhooks (all-signed, declined/voided/expired — lib/forms/esign-execution-loop.ts),
 * the offer and listing compliance loops (compliance_pending → correction_required |
 * compliance_approved → fully_executed), and nothing else writes a compliance state. It
 *
 *   1. reads the record INSIDE THE TENANT (`.eq("brokerage_id", …)`; a refused read is a refusal,
 *      never "no such record" — CLAUDE.md §3),
 *   2. asks the PURE rule (canAdvancePacketState) — only up the ladder; equal is an idempotent
 *      no-op; a terminal provider outcome is never overwritten,
 *   3. UPDATES `esign_status` (+ the caller's companion columns) with the tenant on the write and
 *      COUNTS the rows back (an update matching nothing resolves too — §3),
 *   4. leaves EVIDENCE: one lifecycle_events row per (record, state) through the same server-only
 *      core the webhooks already use (dedupe_key, no window — a hop happens once),
 *   5. rings THE HOP BELL for the responsible agent — and, on the compliance hops, the brokerage's
 *      TC + compliance_officer bench — through notifyEsignPacketHop, which dedupes per (record,
 *      state) so a redelivered webhook or a re-entered loop never pages twice.
 *
 * It takes the client the caller already holds (service client from a webhook / loop; the in-memory
 * client in the proof) so the evidence lands on the same client as the write it records.
 * `provider`, `envelopeId` and `actorUserId` are evidence only — the tenant is never read from them.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { recordLifecycleEvent } from "@/lib/events/lifecycle-event-core"
import { notifyEsignPacketHop } from "@/lib/notifications/notify-helpers"
import {
  canAdvancePacketState,
  isTerminalFailureState,
  PACKET_HOP_NOTICE,
  type EsignPacketState,
} from "./packet-states"

type AnySupabase = SupabaseClient<any, any, any>

/** Which signed-packet record: an offer, or a listing agreement (by its id, or the newest one on a listing). */
export type PacketRecordRef =
  | { table: "offers"; id: string }
  | { table: "listing_agreements"; id: string }
  | { table: "listing_agreements"; listingId: string }

export interface AdvancePacketStateInput {
  brokerageId: string
  record:      PacketRecordRef
  to:          EsignPacketState
  /** lifecycle_events.source — the live CHECK admits ui | webhook | system | cron. */
  source:      "ui" | "webhook" | "system" | "cron"
  provider?:   string | null
  envelopeId?: string | null
  /** users.id of the human who caused the hop; null for an autonomous one. Evidence only. */
  actorUserId?: string | null
  /** Companion columns stamped in the SAME update (fully_executed_at, esign_completed_at, …). */
  also?:       Record<string, unknown>
  /** Default true. False records the hop (state + evidence) without a bell — e.g. compliance_approved
   *  immediately followed by fully_executed, where one bell names both. */
  notify?:     boolean
  /** Appended to the notice body (the transaction created, the blocker count, the provider's reason). */
  detail?:     string | null
}

export type AdvancePacketStateResult =
  | { ok: true; noop: boolean; recordId: string; from: string | null; to: EsignPacketState; notified: number }
  | { ok: false; reason: string }

const COMPLIANCE_BELL_STATES: ReadonlySet<EsignPacketState> = new Set(["fully_signed", "compliance_pending", "compliance_approved", "fully_executed"])

interface LoadedRecord {
  id: string
  esign_status: string | null
  /** users.id of the responsible agent, resolved; null when none could be. */
  agentUserId: string | null
  entityType: "offer" | "listing"
  entityId: string
  contactId: string | null
}

async function loadRecord(svc: AnySupabase, brokerageId: string, ref: PacketRecordRef): Promise<{ ok: true; row: LoadedRecord } | { ok: false; reason: string }> {
  if (ref.table === "offers") {
    const { data, error } = await svc
      .from("offers")
      .select("id, brokerage_id, agent_id, contact_id, esign_status")
      .eq("id", ref.id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (error) return { ok: false, reason: `offer read refused: ${error.message}` }
    if (!data) return { ok: false, reason: "no such offer in this brokerage" }
    const o = data as { id: string; agent_id: string | null; contact_id: string | null; esign_status: string | null }
    // offers.agent_id is an AGENTS id; the bell wants users.id — DISJOINT spaces (CLAUDE.md §3), resolved, never substituted.
    let agentUserId: string | null = null
    if (o.agent_id) {
      const { data: a, error: aErr } = await svc.from("agents").select("user_id").eq("id", o.agent_id).maybeSingle()
      if (aErr) console.error(`[packet-state-writer] agent ${o.agent_id} user_id read refused (${aErr.message}); the agent will not be on this bell`)
      agentUserId = (a as { user_id?: string | null } | null)?.user_id ?? null
    }
    return { ok: true, row: { id: o.id, esign_status: o.esign_status, agentUserId, entityType: "offer", entityId: o.id, contactId: o.contact_id } }
  }

  const q = svc
    .from("listing_agreements")
    .select("id, brokerage_id, listing_id, agent_user_id, seller_contact_id, esign_status, created_at")
    .eq("brokerage_id", brokerageId)
  const { data, error } = "id" in ref
    ? await q.eq("id", ref.id).maybeSingle()
    : await q.eq("listing_id", ref.listingId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) return { ok: false, reason: `listing agreement read refused: ${error.message}` }
  if (!data) return { ok: false, reason: "no such listing agreement in this brokerage" }
  const a = data as { id: string; listing_id: string; agent_user_id: string | null; seller_contact_id: string | null; esign_status: string | null }
  return { ok: true, row: { id: a.id, esign_status: a.esign_status, agentUserId: a.agent_user_id ?? null, entityType: "listing", entityId: a.listing_id, contactId: a.seller_contact_id } }
}

/** The evidence row + the bell for a hop (steps 4–5), shared by the writer and by the two survivors
 *  whose all-signed STAMP already exists and is pinned by proofs (lib/forms/esign-execution-loop.ts
 *  applyReadyWrites, lib/esign-webhooks/finalize-packet.ts) — they keep their write and record the hop here. */
async function evidenceAndBell(svc: AnySupabase, input: AdvancePacketStateInput, row: LoadedRecord): Promise<number> {
  const evt = await recordLifecycleEvent(svc, input.brokerageId, {
    event_type: "esign.packet.state_changed",
    payload: {
      table: input.record.table, recordId: row.id, from: row.esign_status, to: input.to,
      provider: input.provider ?? null, envelopeId: input.envelopeId ?? null,
      ...(row.contactId ? { contact_id: row.contactId } : {}),
      ...(input.actorUserId ? { actor_user_id: input.actorUserId } : {}),
    },
    source: input.source,
    dedupe_key: `esign-packet-${input.record.table}-${row.id}-${input.to}`,
  }, { dedupeWindowHours: null })
  if (!evt.ok) console.error(`[packet-state-writer] ${input.record.table} ${row.id} → ${input.to}: evidence row not recorded: ${evt.error}`)

  if (input.notify === false) return 0
  const notice = PACKET_HOP_NOTICE[input.to]
  const sent = await notifyEsignPacketHop(svc, {
    brokerageId: input.brokerageId,
    state: input.to,
    entityType: row.entityType,
    entityId: row.entityId,
    agentUserId: row.agentUserId,
    includeComplianceRoles: COMPLIANCE_BELL_STATES.has(input.to),
    title: notice.title,
    body: input.detail ? `${notice.body} ${input.detail}` : notice.body,
    priority: isTerminalFailureState(input.to) || input.to === "correction_required" ? "high" : "medium",
  })
  return sent.notified_count
}

/**
 * Advance one packet record to `to`. Never throws into a webhook or a loop: every failure is a
 * returned reason. A no-op (already there) returns ok with `noop: true` and rings nothing.
 */
export async function advanceEsignPacketState(svc: AnySupabase, input: AdvancePacketStateInput): Promise<AdvancePacketStateResult> {
  const loaded = await loadRecord(svc, input.brokerageId, input.record)
  if (!loaded.ok) return loaded
  const { row } = loaded

  const verdict = canAdvancePacketState(row.esign_status, input.to)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  if (verdict.noop) return { ok: true, noop: true, recordId: row.id, from: row.esign_status, to: input.to, notified: 0 }

  // THE WRITE — tenant on the predicate, rows counted (an update matching nothing resolves, §3).
  const { data: updated, error: updateErr } = await svc
    .from(input.record.table)
    .update({ esign_status: input.to, ...(input.also ?? {}) })
    .eq("id", row.id)
    .eq("brokerage_id", input.brokerageId)
    .select("id")
  if (updateErr) return { ok: false, reason: `${input.record.table} esign_status write refused: ${updateErr.message}` }
  if (!updated || updated.length === 0) return { ok: false, reason: `${input.record.table} esign_status write matched no row (wrong tenant?)` }

  const notified = await evidenceAndBell(svc, input, row)
  return { ok: true, noop: false, recordId: row.id, from: row.esign_status, to: input.to, notified }
}

/**
 * Record a hop whose STATUS WRITE an existing survivor already made (the all-signed stamps the
 * provider webhooks apply with their companion columns): the evidence row + the deduped bell, no
 * second write. `state` must be what the record now holds; a mismatch is reported, not papered over.
 */
export async function recordEsignPacketHop(svc: AnySupabase, input: Omit<AdvancePacketStateInput, "also" | "to"> & { state: EsignPacketState }): Promise<AdvancePacketStateResult> {
  const loaded = await loadRecord(svc, input.brokerageId, input.record)
  if (!loaded.ok) return loaded
  const { row } = loaded
  if (row.esign_status !== input.state) {
    return { ok: false, reason: `${input.record.table} ${row.id} holds esign_status '${row.esign_status ?? "null"}', not '${input.state}' — the hop was not recorded` }
  }
  const notified = await evidenceAndBell(svc, { ...input, to: input.state }, { ...row, esign_status: null })
  return { ok: true, noop: false, recordId: row.id, from: null, to: input.state, notified }
}
