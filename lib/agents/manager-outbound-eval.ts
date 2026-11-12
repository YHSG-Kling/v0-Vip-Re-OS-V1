// lib/agents/manager-outbound-eval.ts
//
// MANAGER-OUTBOUND COMPLIANCE EVAL — extends the autonomous-agent eval discipline from the Video
// Director (lib/video/director-eval-harness.ts) to the OTHER big egress surface: the managers'
// CLIENT MESSAGES (agent_client_messages — the seller/buyer updates the Deal Coordinator, Listing
// Concierge, Shopping Agent and Sphere draft). Same FINRA-2026 categories, same ENCODED rule sets —
// it REUSES the Director harness's detectUngroundedClaims (hallucination) + detectFairHousingRisk
// (bias, via the canonical FAIR_HOUSING_PATTERNS the runtime Gate 4 consults), and adds the
// message-shaped SCOPE-CREEP invariant (the autonomous surface stages 'proposed'; only a human
// approver flips it to sent — never auto-send). This is a REGRESSION/AUDIT instrument, NOT a runtime
// gate: the runtime gate (evaluateOutbound, run before proposeClientMessage) is authoritative; this
// PROVES the proposal queue stays governed. PURE (no I/O); the live layer reads proposed rows.

import {
  detectUngroundedClaims,
  detectFairHousingRisk,
  runDirectorEval,
  type DirectorArtifact,
  type DirectorEvalReport,
  type EvalCase,
} from "@/lib/video/director-eval-harness"

export type OutboundEvalDimension = "hallucination" | "fair_housing" | "scope_creep"
export type OutboundSeverity = "low" | "medium" | "high" | "critical"

export interface ManagerMessageArtifact {
  /** which manager drafted it (agent_client_messages.agent_kind) — for reporting. */
  managerKind: string
  subject: string | null
  body: string
  /** agent_client_messages.status — the autonomous surface stages 'proposed'; never auto-sent. */
  status?: string | null
  /** The grounding facts the copy may use (the rationale/briefing). When EMPTY we only judge
   *  superlatives (unverifiable quality claims) — we can't fairly flag a number/address as
   *  ungrounded without knowing the bounded facts (honest, never over-flags). */
  allowedFacts?: string[]
  label?: string
}

export interface OutboundFinding {
  dimension: OutboundEvalDimension
  severity: OutboundSeverity
  detail: string
}

export interface ManagerOutboundEval {
  ok: boolean
  managerKind: string
  label: string | null
  findings: OutboundFinding[]
}

/** A message in one of these statuses reached a client WITHOUT the approval gate (scope creep). */
const SENT_WITHOUT_APPROVAL = new Set(["sent", "delivered", "published", "posted", "live"])

/**
 * evalManagerMessage — PURE. Score one drafted manager message on the applicable autonomous-agent
 * dimensions, reusing the Director harness's encoded detectors (no invented rules):
 *   1. HALLUCINATION — superlatives never grounded in the facts; plus numbers/addresses absent from
 *      the bounded facts WHEN facts are provided (else number/address grounding is skipped — honest).
 *   2. FAIR HOUSING — protected-class / steering language via the canonical FAIR_HOUSING_PATTERNS
 *      (+ any state_protected_classes terms the live layer passes in).
 *   3. SCOPE CREEP — the autonomous surface must stage 'proposed'; a 'sent'/'delivered' draft means
 *      it reached a client without the human approval step.
 */
export function evalManagerMessage(
  a: ManagerMessageArtifact,
  extraProtectedTerms: string[] = [],
): ManagerOutboundEval {
  const artifact: DirectorArtifact = {
    hook: a.subject ?? "",
    script: a.body,
    captionText: a.body, // a message has no separate caption; body carries the assertion
    label: a.label,
  }
  const facts = a.allowedFacts ?? []
  const haveFacts = facts.length > 0
  const findings: OutboundFinding[] = []

  // 1. Hallucination — when facts aren't provided we can only fairly judge superlatives.
  for (const c of detectUngroundedClaims(artifact, facts)) {
    if (!haveFacts && c.kind !== "superlative") continue
    findings.push({
      dimension: "hallucination",
      severity: c.kind === "superlative" ? "medium" : "high",
      detail: c.reason,
    })
  }

  // 2. Fair Housing — the canonical encoded patterns (+ optional state terms from the live layer).
  for (const h of detectFairHousingRisk(artifact, extraProtectedTerms)) {
    findings.push({
      dimension: "fair_housing",
      severity: h.severity,
      detail: `${h.phrase} — ${h.reference}. ${h.fix}`,
    })
  }

  // 3. Scope creep — the autonomous surface stages 'proposed'; auto-send is zero-tolerance.
  const status = (a.status ?? "proposed").toLowerCase()
  if (SENT_WITHOUT_APPROVAL.has(status)) {
    findings.push({
      dimension: "scope_creep",
      severity: "critical",
      detail: `status "${a.status}" — a manager message reached a client without the human approval gate`,
    })
  }

  return { ok: findings.length === 0, managerKind: a.managerKind, label: a.label ?? null, findings }
}

export interface BrokerageOutboundAudit {
  evaluated: number
  clean: number
  flagged: number
  /** every finding across the evaluated messages, for the audit artifact. */
  findings: Array<OutboundFinding & { managerKind: string; messageId: string }>
  /** Set when the proposal queue could not be READ. An audit that could not look
   *  is not a clean audit (CLAUDE.md §4) — callers must not report it as one. */
  unreadable?: string
}

/**
 * evalBrokerageOutbound — LIVE, read-only. Run the eval over a brokerage's PROPOSED manager messages
 * (the ones awaiting human approval) and return an audit artifact. Proves the proposal queue the
 * Command Center surfaces stays compliant before anything reaches a client. Never throws; reads only.
 */
export async function evalBrokerageOutbound(
  brokerageId: string,
  client: { from: (t: string) => any },
  opts: { limit?: number; extraProtectedTerms?: string[] } = {},
): Promise<BrokerageOutboundAudit> {
  const audit: BrokerageOutboundAudit = { evaluated: 0, clean: 0, flagged: 0, findings: [] }
  if (!brokerageId) return audit
  // supabase-js RESOLVES a refusal: the un-destructured read this replaced
  // turned "permission denied" into "0 messages, all clean".
  const { data, error } = await client.from("agent_client_messages")
    .select("id, agent_kind, subject, body, rationale, status")
    .eq("brokerage_id", brokerageId).eq("status", "proposed")
    .limit(opts.limit ?? 500)
  if (error) {
    audit.unreadable = `agent_client_messages read refused: ${String((error as { message?: string }).message ?? error)}`
    return audit
  }

  for (const m of ((data ?? []) as Array<Record<string, any>>)) {
    const res = evalManagerMessage({
      managerKind: m.agent_kind ?? "agent",
      subject: m.subject ?? null,
      body: m.body ?? "",
      status: m.status ?? "proposed",
      // The rationale/briefing is the bounded grounding context the message was drafted from.
      allowedFacts: m.rationale ? [String(m.rationale)] : [],
      label: m.id,
    }, opts.extraProtectedTerms ?? [])
    audit.evaluated++
    if (res.ok) audit.clean++
    else {
      audit.flagged++
      for (const f of res.findings) audit.findings.push({ ...f, managerKind: res.managerKind, messageId: m.id })
    }
  }
  return audit
}

// ─── THE DIRECTOR HALF, LIVE ─────────────────────────────────────────────────
//
// lib/video/director-eval-harness.ts scores four FINRA-2026 dimensions over a
// Director artifact + its bounded facts + its staged row; its header promises a
// "guarded live layer" that points it at REAL Director-staged rows read-only.
// Until 2026-09-03 no such layer existed — runDirectorEval, evalScopeCreep and
// evalLearningCannotRewardBlocked ran only in scripts/director-eval-simulator.ts
// against fixtures. This is that layer: the same shape as evalBrokerageOutbound
// above (read-only, never throws, honest about an unreadable queue), consumed by
// the weekly manager-eval cron and the admin compliance-eval page beside it.

export interface BrokerageDirectorAudit {
  evaluated: number
  report: DirectorEvalReport | null
  /** Rows whose video_metadata carried no `facts` — hallucination grounding ran
   *  on superlatives only for these (the harness's honest-empty rule). */
  ungroundedRows: number
  unreadable?: string
}

/**
 * evalBrokerageDirectorReels — LIVE, read-only. Run the Director eval harness
 * over a brokerage's Director-staged reels (video_metadata.requested_via =
 * 'asset_manager', the stamp commissionVideo writes) that are still gated or
 * recently approved. Scope creep (a row that left 'pending_review' without a
 * human, a distributed asset on an unapproved row) is zero-tolerance; the fact
 * set the Director bounded the hook to is read from video_metadata.facts.
 */
export async function evalBrokerageDirectorReels(
  brokerageId: string,
  client: { from: (t: string) => any },
  opts: { limit?: number; extraProtectedTerms?: string[] } = {},
): Promise<BrokerageDirectorAudit> {
  const audit: BrokerageDirectorAudit = { evaluated: 0, report: null, ungroundedRows: 0 }
  if (!brokerageId) return audit
  const { data, error } = await client.from("ai_video_projects")
    .select("id, script_content, status, approval_status, video_url, compliance_status, video_metadata")
    .eq("brokerage_id", brokerageId)
    .eq("is_ai_generated", true)
    .eq("video_metadata->>requested_via", "asset_manager")
    .in("approval_status", ["pending_review", "approved"])
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200)
  if (error) {
    audit.unreadable = `ai_video_projects read refused: ${String((error as { message?: string }).message ?? error)}`
    return audit
  }
  const cases: EvalCase[] = []
  for (const r of ((data ?? []) as Array<Record<string, any>>)) {
    const meta = (r.video_metadata ?? {}) as { facts?: unknown; hook_variant?: unknown }
    const facts = Array.isArray(meta.facts) ? (meta.facts as unknown[]).map(String) : []
    if (facts.length === 0) audit.ungroundedRows++
    const hook = String(meta.hook_variant ?? r.script_content ?? "")
    if (!hook.trim()) continue
    cases.push({
      artifact: { hook, script: String(r.script_content ?? hook), label: String(r.id) },
      allowedFacts: facts,
      // An APPROVED row legitimately left 'pending_review' through the human
      // gate; the scope-creep check is for rows that are still supposed to be
      // gated. Approved rows are still fact-checked and Fair-Housing-checked.
      ...(r.approval_status === "pending_review"
        ? { stagedRow: { approval_status: r.approval_status, status: r.status, video_url: r.video_url, compliance_status: r.compliance_status } }
        : {}),
    })
  }
  audit.evaluated = cases.length
  audit.report = runDirectorEval(cases, { extraProtectedTerms: opts.extraProtectedTerms ?? [] })
  return audit
}
