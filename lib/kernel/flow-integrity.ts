// lib/kernel/flow-integrity.ts
//
// FLOW-INTEGRITY ASSERTIONS (cron_manager, agenticapi model) — the OS proves
// its OWN surface-to-surface wiring: "data entered surface A; did it actually
// arrive at surface B?" The connectivity fabric watches EXTERNAL connectors;
// this watches INTERNAL data flow, so no cross-surface handoff breaks silently.
//
// DESIGN HONESTY (investigated, not assumed): lifecycle_events.processed is
// audit-only in this schema (event types never flip it), so a naive
// "unprocessed backlog" would flag legitimate audit rows — that's noise, not a
// signal. Instead this asserts CONCRETE, per-row cross-surface CONTRACTS where
// BOTH ends are verifiable, so a finding is a real break with zero false
// positives:
//
//   • PACKET COMPLETION: a contract_signatures marked fully_signed whose
//     signature_requests packet (matched by provider_envelope_id) is STILL
//     pending — the e-sign webhook completed one table but not the other, so
//     the portal Sign button lingers on a signed doc. A genuine silent break
//     in the finalizer rail (both updates are best-effort).
//
// Pure detectors (testable); the runner surfaces findings to ops, deduped,
// riding the deal-health-scan cron beside the OS self-audit.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const FLOW_LOOKBACK_DAYS = 14

export interface SignedContractRow { envelopeId: string | null; fullySignedAt: string | null }
export interface PacketRow { envelopeId: string | null; requestStatus: string | null; completedAt: string | null }

export interface FlowBreak {
  flow: "packet_completion"
  key: string
  detail: string
}

/**
 * PURE: a contract is fully signed (both tables share provider_envelope_id),
 * but its packet never completed → the completion handoff broke. Only a
 * signed contract WITH a still-open packet counts; missing/absent packets
 * (email-only providers, no packet recorded) are NOT a break.
 */
export function detectPacketCompletionGaps(contracts: SignedContractRow[], packets: PacketRow[]): FlowBreak[] {
  const openByEnvelope = new Map<string, PacketRow>()
  for (const p of packets) {
    if (!p.envelopeId) continue
    // "still open" = pending/sent and not completed.
    if ((p.requestStatus === "pending" || p.requestStatus === "sent") && !p.completedAt) {
      openByEnvelope.set(p.envelopeId, p)
    }
  }
  const out: FlowBreak[] = []
  for (const c of contracts) {
    if (!c.envelopeId || !c.fullySignedAt) continue // only fully-signed contracts assert
    if (openByEnvelope.has(c.envelopeId)) {
      out.push({
        flow: "packet_completion",
        key: c.envelopeId,
        detail: `Envelope ${c.envelopeId} is fully signed but its signature packet never completed — the portal Sign button will linger on a signed document. Re-run completion for this envelope.`,
      })
    }
  }
  return out
}

export interface FlowIntegrityResult { scanned: number; breaks: number; notified: number }

/** Assert the cross-surface contracts for one brokerage; surface real breaks to ops (deduped). */
export async function runFlowIntegrity(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<FlowIntegrityResult> {
  const out: FlowIntegrityResult = { scanned: 0, breaks: 0, notified: 0 }
  const since = new Date(now.getTime() - FLOW_LOOKBACK_DAYS * 86_400_000).toISOString()

  const [{ data: contracts }, { data: packets }] = await Promise.all([
    svc.from("contract_signatures")
      .select("provider_envelope_id, fully_signed_at")
      .eq("brokerage_id", brokerageId).not("fully_signed_at", "is", null).gte("created_at", since).limit(2000),
    svc.from("signature_requests")
      .select("provider_envelope_id, request_status, completed_at")
      .eq("brokerage_id", brokerageId).not("provider_envelope_id", "is", null).gte("created_at", since).limit(2000),
  ])

  const contractRows: SignedContractRow[] = ((contracts ?? []) as any[]).map((c) => ({ envelopeId: c.provider_envelope_id ?? null, fullySignedAt: c.fully_signed_at ?? null }))
  const packetRows: PacketRow[] = ((packets ?? []) as any[]).map((p) => ({ envelopeId: p.provider_envelope_id ?? null, requestStatus: p.request_status ?? null, completedAt: p.completed_at ?? null }))
  out.scanned = contractRows.length

  const breaks = detectPacketCompletionGaps(contractRows, packetRows)
  out.breaks = breaks.length
  if (breaks.length === 0) return out

  const tag = `[FLOW_INTEGRITY:${brokerageId}:packet]`
  const { data: dup } = await svc.from("notifications").select("id").ilike("body", `%${tag}%`).limit(1).maybeSingle()
  if (dup) return out

  const { data: owners } = await svc.from("users").select("id")
    .eq("brokerage_id", brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(3)
  for (const u of ((owners ?? []) as Array<{ id: string }>)) {
    const { error } = await svc.from("notifications").insert({
      brokerage_id: brokerageId, user_id: u.id, type: "flow_integrity",
      title: "A signed document didn't finish its handoff",
      body: `${breaks.length} signed envelope${breaks.length === 1 ? "" : "s"} completed signing but the packet never closed — clients may still see a Sign button on a signed doc. Support can re-run completion. ${tag}`.slice(0, 480),
      priority: "high", channel: "in_app", is_read: false,
    })
    if (!error) out.notified++
  }
  return out
}

/** Autonomous: every brokerage (rides the deal-health-scan cron). */
export async function runFlowIntegrityAll(svc: Svc): Promise<{ brokerages: number; breaks: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(1000)
  let breaks = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runFlowIntegrity(svc, b.id).catch(() => null)
    if (r) breaks += r.breaks
  }
  return { brokerages: (brokerages ?? []).length, breaks }
}
