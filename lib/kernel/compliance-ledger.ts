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
import { applyTenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"

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

// ── The on-demand ledger view (the regulatory artifact a broker hands an auditor) ──

export interface LedgerRowView {
  id: string
  when: string | null
  /** The Command Center queue the decision acted on (client_message / social / …). */
  queue: string
  channel: string
  severity: "clear" | "advisory" | "blocked" | string
  /** Did it ship (approved) vs held (rejected)? */
  released: boolean
  /** Released over an OPEN Compliance Officer objection — the line a broker defends. */
  releasedOverObjection: boolean
  findings: string[]
  actorUserId: string | null
}

/** PURE: a raw compliance_events row → the display view. */
export function mapLedgerRow(e: Record<string, unknown>): LedgerRowView {
  return {
    id: String(e.id ?? ""),
    when: (e.created_at as string | null) ?? null,
    queue: String(e.entity_type ?? "—"),
    channel: String(e.message_type ?? "—"),
    severity: (e.severity as string) ?? "clear",
    released: !!e.allowed,
    releasedOverObjection: (e.details as any)?.approved_despite_advisory === true,
    findings: Array.isArray(e.violations) ? (e.violations as string[]) : [],
    actorUserId: (e.actor_user_id as string | null) ?? null,
  }
}

export interface ComplianceLedgerView {
  rows: LedgerRowView[]
  summary: ComplianceLedgerSummary
  sinceDays: number
  severity: string | null
}

/**
 * Load the compliance ledger for a window — the Compliance Officer's on-demand audit report.
 * The summary always reflects the FULL window (so the disposition totals are honest regardless of
 * the row-level severity filter); `rows` honor the filter.
 *
 * ── SCOPE IS ASKED FOR, NEVER INFERRED FROM AN ABSENT ID ─────────────────────
 * This function used to take `brokerageId: string | null` and read
 *
 *     if (brokerageId) q = q.eq("brokerage_id", brokerageId)
 *
 * on a SERVICE-ROLE client, so a null meant "no predicate at all" and the query
 * returned every brokerage's Fair Housing and consent audit trail. Its caller
 * computed that null as `isSuperadmin ? null : (userData?.brokerage_id ?? null)`,
 * so the value also arrived for a NON-superadmin broker/admin whose
 * users.brokerage_id happened to be NULL — the two cases were byte-identical.
 * Not exploitable on today's data (0 of 23 live users rows have a NULL
 * brokerage_id) and structurally reachable regardless, because the column is
 * nullable.
 *
 * It now takes a TenantScope: `tenantScope(id, …)` refuses a null, and
 * `platformScope(reason)` has to be written out. See lib/kernel/tenant-scope.ts.
 */
export async function loadComplianceLedger(
  scope: TenantScope,
  opts: { sinceDays?: number; severity?: string; limit?: number } = {},
  client?: Svc,
): Promise<ComplianceLedgerView> {
  const svc = client ?? createServiceClient()
  const sinceDays = Math.min(365, Math.max(1, Math.round(opts.sinceDays ?? 30)))
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const severity = opts.severity && ["clear", "advisory", "blocked"].includes(opts.severity) ? opts.severity : null

  const q = applyTenantScope(
    svc.from("compliance_events")
      .select("id, created_at, entity_type, message_type, severity, allowed, violations, details, actor_user_id")
      .eq("gate_name", PREFLIGHT_GATE).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(Math.min(2000, opts.limit ?? 1000)),
    scope,
  )
  const { data } = await q
  const all = (data ?? []) as Array<Record<string, unknown>>

  const summary = summarizeComplianceLedger(all.map((r) => ({ severity: r.severity as any, allowed: !!r.allowed, details: r.details as any })))
  const filtered = severity ? all.filter((r) => r.severity === severity) : all
  return { rows: filtered.map(mapLedgerRow), summary, sinceDays, severity }
}
