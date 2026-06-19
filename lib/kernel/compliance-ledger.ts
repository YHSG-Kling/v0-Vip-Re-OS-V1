// lib/kernel/compliance-ledger.ts
//
// THE COMPLIANCE AUDIT LEDGER — every outbound APPROVAL decision is recorded as a durable
// compliance event, so the Compliance Officer's inline pre-flight (lib/kernel/manager-dissent.ts)
// becomes a defensible regulatory RECORD: "show me every outbound message, its Fair Housing /
// consent disposition, and who released it" for any window. The verdict is recomputed SERVER-SIDE
// from the actual outbound copy (never trusted from the client) so the record can't be tampered.
//
// Writes to compliance_events (gate_name='compliance_preflight') — the generic gate-event ledger
// the Compliance Officer owns. NOT server-only (simulator-driven); the builder is pure.

import { createServiceClient } from "@/lib/supabase/service"
import { compliancePreflight, type ReviewContext } from "@/lib/kernel/manager-dissent"

type Svc = ReturnType<typeof createServiceClient>

export const PREFLIGHT_GATE = "compliance_preflight"

export interface EgressDecision {
  brokerageId: string
  actorUserId: string
  actorRole: string
  /** The Command Center queue (client_message / social / newsletter / …). */
  queue: string
  /** The proposal row id this decision acts on. */
  entityId: string
  /** Delivery channel (email/sms/portal/content) — drives the consent block. */
  channel: string
  /** The FINAL outbound copy (the human's edited body when edited) — what actually ships. */
  text: string
  /** Per-recipient consent state (client_message); broadcast content passes all-false. */
  consent: Pick<ReviewContext, "recipientWithdrawn" | "emailRevoked" | "smsRevoked">
  decision: "approved" | "rejected"
}

/** A compliance_events row (only live-schema columns). */
export interface ComplianceEventRow {
  brokerage_id: string
  gate_name: string
  entity_type: string
  entity_id: string
  actor_user_id: string
  actor_role: string
  message_type: string
  allowed: boolean
  severity: "clear" | "advisory" | "blocked"
  blocked_reason: string | null
  violations: string[]
  details: Record<string, unknown>
  created_at: string
}

/**
 * PURE: build the audit event for one egress decision. Recomputes the Compliance Officer pre-flight
 * on the FINAL copy so the record reflects exactly what shipped. `allowed` = did it go out (approved);
 * the critical flag `approved_despite_advisory` catches a human releasing over an open objection.
 */
export function buildComplianceEvent(d: EgressDecision, now: Date = new Date()): ComplianceEventRow {
  const verdict = compliancePreflight(
    { proposer: d.queue, channel: d.channel, subject: null, body: d.text },
    { ...d.consent, hoursSinceLastSend: null, openFireDrill: false },
  )
  const allowed = d.decision === "approved"
  const approvedDespiteObjection = allowed && verdict.status !== "clear"
  return {
    brokerage_id: d.brokerageId,
    gate_name: PREFLIGHT_GATE,
    entity_type: d.queue,
    entity_id: d.entityId,
    actor_user_id: d.actorUserId,
    actor_role: d.actorRole,
    message_type: d.channel,
    allowed,
    severity: verdict.status,
    blocked_reason: verdict.status === "blocked"
      ? (verdict.findings[0] ?? "consent hard-stop")
      : d.decision === "rejected" ? "rejected by approver" : null,
    violations: verdict.findings,
    details: {
      decision: d.decision,
      finding_count: verdict.findings.length,
      approved_despite_advisory: approvedDespiteObjection,
    },
    created_at: now.toISOString(),
  }
}

export interface ComplianceLedgerSummary {
  total: number
  cleared: number
  advisory: number
  blocked: number
  /** Released over an open Compliance Officer objection — the number a broker must defend. */
  approvedDespiteAdvisory: number
  rejected: number
}

/** PURE: roll a window of ledger rows into the disposition summary for the Compliance Officer report. */
export function summarizeComplianceLedger(rows: Array<Pick<ComplianceEventRow, "severity" | "allowed" | "details">>): ComplianceLedgerSummary {
  const s: ComplianceLedgerSummary = { total: 0, cleared: 0, advisory: 0, blocked: 0, approvedDespiteAdvisory: 0, rejected: 0 }
  for (const r of rows) {
    s.total += 1
    if (r.severity === "clear") s.cleared += 1
    else if (r.severity === "advisory") s.advisory += 1
    else if (r.severity === "blocked") s.blocked += 1
    if (!r.allowed) s.rejected += 1
    if ((r.details as any)?.approved_despite_advisory === true) s.approvedDespiteAdvisory += 1
  }
  return s
}

/**
 * Record one egress decision to the ledger. Best-effort: an audit write must NEVER block the
 * actual approve/reject (the decision already happened); a failed insert is swallowed. Idempotency
 * is per (entity, decision) — re-recording the same decision is harmless (the report dedups by entity).
 */
export async function recordEgressComplianceDecision(d: EgressDecision, client?: Svc): Promise<{ recorded: boolean }> {
  try {
    const svc = client ?? createServiceClient()
    const row = buildComplianceEvent(d)
    const { error } = await svc.from("compliance_events").insert(row)
    return { recorded: !error }
  } catch {
    return { recorded: false }
  }
}
