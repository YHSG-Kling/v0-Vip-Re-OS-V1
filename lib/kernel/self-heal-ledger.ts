// lib/kernel/self-heal-ledger.ts
//
// THE SELF-HEALING LEDGER (cron_manager) — one append-only record every
// autonomous repair writes, across BOTH domains the owner named: DATA FLOWS
// (a stuck cross-surface handoff re-run) and CONNECTORS (a healing proposal
// auto-applied). This is the spine that makes "the OS heals itself" a visible,
// auditable fact rather than a claim. Pure classifier + a thin writer.
//
// THE CONFIDENCE RATCHET (earned autonomy applied to self-repair): every
// remediation belongs to a TIER —
//   • seed_safe  — proven idempotent finalizer re-runs (is-null / status-guarded
//                  writes that literally re-execute what the webhook rail does);
//                  auto-heal silently from day one.
//   • probation  — deterministic repairs that touch richer state (recreating a
//                  dropped task, re-flagging a deal). The OS heals them
//                  UNATTENDED but REPORTS every fix to the broker until the
//                  action EARNS silence: EARNED_AUTONOMY_HEALS clean heals with
//                  ZERO failures, computed from this very ledger (no extra
//                  state — the append-only record IS the trust score).
//   • escalate   — no proven-safe repair exists; a human is routed in.
// A single recorded failure holds a probation action in supervised mode —
// autonomy is earned by evidence, never assumed.

import { applyTenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"

export type SelfHealDomain = "data_flow" | "connector"
export type SelfHealOutcome = "healed" | "failed" | "escalated"

export type FlowTier = "seed_safe" | "probation" | "escalate"

/** Clean heals (with zero failures, ever) a probation action needs before it stops reporting. */
export const EARNED_AUTONOMY_HEALS = 5

export interface FlowContract {
  tier: FlowTier
  /** The remediation action key (null when the tier is escalate — no repair exists). */
  action: string | null
  /** Why this tier — for the ledger + honest escalation copy. */
  reason: string
  /** Plain-language description of the break, for the human who reads a report. */
  describes: string
}

/**
 * THE FLOW-CONTRACT LIBRARY — every cross-surface contract the OS asserts and
 * (where proven safe) repairs. Each entry was verified against the LIVE schema
 * and the actual emitting rail before it was admitted: both ends of the
 * contract are concrete rows, so a detection is a real break, never noise.
 */
export const FLOW_CONTRACTS: Record<string, FlowContract> = {
  // ── SEED-SAFE: idempotent finalizer re-runs (is-null / status-guarded) ──
  packet_completion: {
    tier: "seed_safe",
    action: "complete_packet",
    reason: "Re-running packet completion is idempotent (is-null guarded) — safe to auto-heal.",
    describes: "a signed envelope whose signature packet never closed (the portal Sign button lingers on a signed document)",
  },
  offer_esign_stamp: {
    tier: "seed_safe",
    action: "stamp_offer_esign",
    reason: "Stamping esign_completed_at on a fully_signed offer is idempotent (is-null guarded) and mirrors the finalizer's own write.",
    describes: "an offer marked fully signed whose completion timestamp never landed (downstream reads see it as still in signing)",
  },
  document_signed_stamp: {
    tier: "seed_safe",
    action: "stamp_document_signed",
    reason: "Flipping the deal-file document to signed re-runs the exact finalizer update, guarded to unsigned rows only.",
    describes: "a completed e-sign envelope whose deal-file document never flipped to signed",
  },

  esign_ingress_orphan: {
    tier: "seed_safe",
    action: "reconcile_esign_ingress",
    reason: "Replaying the dead-lettered envelope re-runs the exact idempotent finalizers the webhook runs — safe once the artifact of record exists.",
    describes: "a signed envelope that arrived before its paperwork was staged (parked, then replayed the moment the paperwork appeared)",
  },

  // ── PROBATION: deterministic, but heals report until autonomy is EARNED ──
  meta_lead_orphan: {
    tier: "probation",
    action: "replay_meta_lead",
    reason: "Replaying a parked paid lead re-runs the exact webhook ingest path (idempotent on email/phone) — heals under supervision until earned.",
    describes: "a paid ad lead that couldn't land when it arrived (page not mapped yet or a provider hiccup) — captured and delivered once the connection caught up",
  },
  schema_drift: {
    tier: "probation",
    action: "adapt_payload",
    reason: "Deterministic adaptation only — known aliases, safe type coercion, declared defaults; a payload missing required facts QUARANTINES instead of guessing. Heals under supervision until earned.",
    describes: "a provider sending data in a changed shape (renamed fields, type drift) — translated to the expected structure before anything downstream could break",
  },
  showingtime_request_orphan: {
    tier: "probation",
    action: "replay_showingtime_request",
    reason: "Replaying a parked showing request re-runs the exact webhook ingest (idempotent on listing+date+time+agent) once the listing resolves — heals under supervision until earned.",
    describes: "a buyer-agent showing request that arrived before its listing was matchable — captured and delivered once the listing caught up",
  },
  scraped_lead_stranded: {
    tier: "probation",
    action: "reenrich_promote",
    reason: "Re-enriching a stranded scraped record re-runs the full territory→identity→dedupe→eligibility gate — deterministic, capped at MAX_PROMOTION_ATTEMPTS.",
    describes: "a scraped lead that stalled before reaching the pipeline (re-enriched and promoted on a later pass)",
  },
  legal_name_writeback: {
    tier: "probation",
    action: "rerun_legal_name_writeback",
    reason: "Re-running the legal-name writeback is additive-only (fills EMPTY fields from a trusted extraction, never overwrites) — heals under supervision until earned.",
    describes: "a trusted signed-contract scan whose party legal names never reached the contact record",
  },
  decision_task_missing: {
    tier: "probation",
    action: "recreate_decision_task",
    reason: "The client's recorded decision is the source of truth; recreating the agent task is deterministic from the ledger event — heals under supervision until earned.",
    describes: "a client offer decision that was recorded but never reached the agent's task list",
  },
  lender_condition_task_missing: {
    tier: "probation",
    action: "recreate_lender_task",
    reason: "The lender's posted conditions are on the ledger; recreating the collection task is deterministic — heals under supervision until earned.",
    describes: "lender-posted loan conditions whose buyer-document collection task never landed",
  },
  vendor_request_task_missing: {
    tier: "probation",
    action: "recreate_vendor_task",
    reason: "The vendor's filed request is on the ledger; recreating the agent task is deterministic — heals under supervision until earned.",
    describes: "a vendor request that was filed but never reached the agent's task list",
  },
  walkthrough_task_missing: {
    tier: "probation",
    action: "recreate_walkthrough_tasks",
    reason: "The walkthrough outcome is on the ledger; the branch's follow-up tasks recompose deterministically — heals under supervision until earned.",
    describes: "a recorded walkthrough outcome whose follow-up tasks never landed",
  },
  walkthrough_shaky_gap: {
    tier: "probation",
    action: "reflag_shaky",
    reason: "Major walkthrough issues MUST suspend file autonomy; re-setting deal_shaky is guarded by 'no later deal_shaky_cleared event', so a human's deliberate clear is never fought — heals under supervision until earned.",
    describes: "a major-issues walkthrough whose deal never got its safety flag (autonomy stayed live on a wobbling file)",
  },
  ctc_milestone_gap: {
    tier: "probation",
    action: "complete_ctc_milestone",
    reason: "The lender recorded clear-to-close; completing the still-pending milestone mirrors that recorded fact (status-guarded) — heals under supervision until earned.",
    describes: "a lender-recorded clear-to-close whose client-facing milestone still shows pending",
  },

  // ── ESCALATE: detected with zero false positives, routed to a human ──
  egress_rejected: {
    tier: "escalate",
    action: null,
    reason: "An outbound push was refused because the payload lacked the identity a third-party map needs — fixing the SOURCE data is a human call, never an invented field.",
    describes: "an outbound CRM push the OS refused rather than map junk data into a third-party system",
  },
  listing_agreement_stage_gap: {
    tier: "escalate",
    action: null,
    reason: "Advancing the listing stage machine fires kernel events + automations (coming-soon marketing) — not a blind re-run; a human confirms.",
    describes: "a fully signed listing agreement whose listing never advanced past agreement-initiated",
  },
}

export interface ActionStats { healed: number; failed: number }

export interface FlowRemediation {
  /** True only for a deterministically SAFE, idempotent repair the OS may run unattended. */
  safe: boolean
  /** The remediation action to take when safe. */
  action: string | null
  /** The contract's tier. Unknown flows classify as escalate. */
  tier: FlowTier
  /** True when a probation heal must ALSO be reported to the broker (autonomy not yet earned). */
  notify: boolean
  /** True once the action runs silently (seed_safe, or probation past the ratchet). */
  earned: boolean
  /** Why it is (not) safe — for the ledger + honest escalation copy. */
  reason: string
}

/**
 * PURE: decide whether a detected flow break is safe to auto-remediate, and
 * whether the heal must still be REPORTED. The ratchet: a probation action
 * with ≥EARNED_AUTONOMY_HEALS ledger-recorded heals and ZERO failures has
 * EARNED silent autonomy — computed from the ledger itself, no extra state.
 * Without stats (or with any recorded failure) a probation heal reports.
 */
export function classifyFlowRemediation(flow: string, stats?: ActionStats): FlowRemediation {
  const contract = FLOW_CONTRACTS[flow]
  if (!contract || contract.tier === "escalate" || !contract.action) {
    return {
      safe: false, action: null, tier: "escalate", notify: true, earned: false,
      reason: contract?.reason ?? "No proven-safe idempotent repair for this flow — escalate to a human.",
    }
  }
  if (contract.tier === "seed_safe") {
    return { safe: true, action: contract.action, tier: "seed_safe", notify: false, earned: true, reason: contract.reason }
  }
  const earned = !!stats && stats.healed >= EARNED_AUTONOMY_HEALS && stats.failed === 0
  return {
    safe: true, action: contract.action, tier: "probation", notify: !earned, earned,
    reason: earned
      ? `${contract.reason} EARNED: ${stats!.healed} clean heals, zero failures — runs silently now.`
      : contract.reason,
  }
}

/**
 * The ratchet's evidence: per-action all-time heal/fail counts from the
 * append-only ledger (data_flow domain, platform-wide — confidence in a
 * repair is a property of the CODE PATH, not of any one tenant).
 */
export async function loadFlowActionStats(svc: any): Promise<Record<string, ActionStats>> {
  const { data } = await svc.from("self_heal_events")
    .select("action, outcome").eq("domain", "data_flow").limit(10000)
  const out: Record<string, ActionStats> = {}
  for (const r of ((data ?? []) as Array<{ action: string; outcome: SelfHealOutcome }>)) {
    if (!r.action || r.action === "none") continue
    const s = (out[r.action] ??= { healed: 0, failed: 0 })
    if (r.outcome === "healed") s.healed++
    else if (r.outcome === "failed") s.failed++
  }
  return out
}

/** Append one heal event to the ledger. Best-effort — a ledger write never fails a repair. */
export async function recordSelfHeal(svc: any, evt: {
  brokerageId: string | null
  domain: SelfHealDomain
  subject: string
  action: string
  outcome: SelfHealOutcome
  detail?: Record<string, unknown>
}): Promise<void> {
  // Best-effort and NEVER throws (its callers record a heal after the decision already ran),
  // but a refusal is READ and reported, never swallowed (CLAUDE.md §3) — a resolved { error }
  // and a thrown/rejected insert both land in the same log line.
  try {
    const { error: ledgerErr } = (await svc.from("self_heal_events").insert({
      brokerage_id: evt.brokerageId,
      domain: evt.domain,
      subject: evt.subject,
      action: evt.action,
      outcome: evt.outcome,
      detail: (evt.detail ?? {}) as any,
    })) ?? {}
    if (ledgerErr) console.error(`[self-heal-ledger] self_heal_events row refused: ${ledgerErr.message}`)
  } catch (e) {
    console.error(`[self-heal-ledger] self_heal_events insert threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export interface SelfHealRollup {
  windowDays: number
  healed: number
  failed: number
  escalated: number
  byDomain: Array<{ domain: SelfHealDomain; healed: number }>
}

/** Trailing-window rollup for the "the OS repaired N things" surface. */
export async function loadSelfHealRollup(svc: any, brokerageId: string | null, windowDays = 7): Promise<SelfHealRollup> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  let q = svc.from("self_heal_events").select("domain, outcome").gte("created_at", since).limit(5000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data } = await q
  const rows = ((data ?? []) as Array<{ domain: SelfHealDomain; outcome: SelfHealOutcome }>)
  const byDomainHealed = new Map<SelfHealDomain, number>()
  let healed = 0, failed = 0, escalated = 0
  for (const r of rows) {
    if (r.outcome === "healed") { healed++; byDomainHealed.set(r.domain, (byDomainHealed.get(r.domain) ?? 0) + 1) }
    else if (r.outcome === "failed") failed++
    else if (r.outcome === "escalated") escalated++
  }
  return {
    windowDays, healed, failed, escalated,
    byDomain: [...byDomainHealed.entries()].map(([domain, h]) => ({ domain, healed: h })),
  }
}

export interface RepairAutonomyRow {
  flow: string
  action: string
  tier: FlowTier
  healed: number
  failed: number
  earned: boolean
  describes: string
}

/** PURE: the governance view of the ratchet — each auto-repair with its earned/supervised standing. */
export function composeRepairAutonomy(stats: Record<string, ActionStats>): RepairAutonomyRow[] {
  const rows: RepairAutonomyRow[] = []
  for (const [flow, c] of Object.entries(FLOW_CONTRACTS)) {
    if (!c.action) continue
    const s = stats[c.action] ?? { healed: 0, failed: 0 }
    const cls = classifyFlowRemediation(flow, s)
    rows.push({ flow, action: c.action, tier: c.tier, healed: s.healed, failed: s.failed, earned: cls.earned, describes: c.describes })
  }
  // supervised-with-activity first (the ones a broker is actually hearing about), then earned, then idle
  return rows.sort((a, b) => Number(a.earned) - Number(b.earned) || (b.healed + b.failed) - (a.healed + a.failed))
}

// ── THE HEALING CONSOLE (wave 139, lane 139F) ─────────────────────────────────────────────────────
// Owner: "a platform-staff healing console listing per incident: classification, manager/domain,
// provider/capability, structured diagnosis (no hidden chain-of-thought — store only structured
// diagnosis/rationale/evidence), cited research evidence, chosen playbook, attempts, cost, action,
// verification result, escalation/proposal, final state — read from the existing ledger /
// self_heal_events / proposal rows; a tenant admin sees only their own incidents."
// NOT A NEW STORE: a read-only projection over the rows the healers already write —
//   agent_action_ledger  system_source os_health (lib/kernel/self-healing.ts troubleshootIncident steps),
//                        provider_self_heal (lib/agentic-os/connector-healer.ts healProviderFailure steps),
//                        law_rule_healing (lib/kernel/law-rule-healing.ts verify / enable / propose);
//   self_heal_events     os_health_playbook:* rows (the playbook's verified outcome);
//   connector_healing_proposals (by the ids the incident's own ledger rows name) and improvement_proposals
//                        (proposer law_rule_healing, by the incident's own subject keys).
// WHITELIST PROJECTION: every field is picked by name — a ledger `detail` is NEVER spread, so a key the
// projection does not name (a model's free-form reasoning, a chain-of-thought, raw web text) cannot reach
// the console. The model contract itself (self-healing.ts DiagnosisSchema) has no reasoning field.
// TENANCY: the scope is the explicit discriminator (lib/kernel/tenant-scope.ts) — a tenant scope pins
// EVERY read; proposal reads are keyed by ids / subject keys taken from the scope's own pinned rows.

const HEALING_LEDGER_SOURCES = ["os_health", "provider_self_heal", "law_rule_healing"] as const

interface HealingLedgerRow {
  brokerage_id: string | null; action: string; actor_manager_key: string | null; subject_ref: string | null
  status: string | null; outcome: string | null; reason_detail: string | null; provider: string | null
  cost_usd: number | string | null; system_source: string | null; detail: Record<string, unknown> | null
  policy_ref: string | null; created_at: string
}
interface HealingEventRow { brokerage_id: string | null; subject: string; action: string; outcome: string; created_at: string }

export interface HealingIncident {
  key: string
  brokerageId: string | null
  source: string
  subject: string
  /** The hard-gate class (money / tenant_boundary / security / data_deletion), else the incident class / law-rule route. */
  classification: string | null
  manager: string | null
  domain: string | null
  provider: string | null
  capability: string | null
  /** STRUCTURED diagnosis only: the schema's summary, root cause, confidence and the flags it raised. */
  diagnosis: { summary: string; rootCause: string | null; confidence: number | null; flags: string[] } | null
  /** Cited research evidence (URL + title only — never the fetched web text). */
  evidence: Array<{ url: string; title: string | null }>
  playbook: string | null
  attempts: number
  costUsd: number
  action: string | null
  verification: string | null
  escalation: { reason: string | null; proposalId: string | null; proposalStatus: string | null } | null
  finalState: "healed" | "failed" | "escalated" | "proposed" | "verified" | "in_progress"
  policyRef: string | null
  firstAt: string
  lastAt: string
}

const PROPOSAL_ID_RE = /proposal ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const pickStr = (v: unknown, n = 300): string | null => (typeof v === "string" && v.trim() ? v.slice(0, n) : null)
const pickObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

function citationsOf(detail: Record<string, unknown> | null): Array<{ url: string; title: string | null }> {
  const out: Array<{ url: string; title: string | null }> = []
  for (const list of [detail?.citations, pickObj(detail?.researched)?.citations]) {
    if (!Array.isArray(list)) continue
    for (const c of list) {
      const o = pickObj(c)
      const url = pickStr(o?.url, 500)
      if (url && /^https?:\/\//i.test(url) && !out.some((x) => x.url === url)) out.push({ url, title: pickStr(o?.title, 200) })
    }
  }
  return out.slice(0, 10)
}

function structuredDiagnosis(detail: Record<string, unknown> | null): HealingIncident["diagnosis"] {
  const d = pickObj(detail?.diagnosis)
  const summary = pickStr(d?.diagnosis, 800)
  if (!d || !summary) return null
  return {
    summary,
    rootCause: pickStr(d.rootCause, 40),
    confidence: typeof d.confidence === "number" && Number.isFinite(d.confidence) ? d.confidence : null,
    flags: Object.entries(pickObj(d.touches) ?? {}).filter(([, v]) => v === true).map(([k]) => k).slice(0, 4),
  }
}

/**
 * PURE — fold the healers' own rows into one line per incident (tenant + source + subject), newest first.
 * @proofSeam scripts/healing-policy-guard.ts drives the whitelist (a planted chain-of-thought key never
 * surfaces) and the per-incident fields directly.
 */
export function foldHealingIncidents(input: {
  ledger: HealingLedgerRow[]
  events: HealingEventRow[]
  connectorProposals: Array<{ id: string; status: string | null }>
  lawProposals: Array<{ id: string; brokerage_id: string | null; subject_key: string; status: string | null }>
}): HealingIncident[] {
  const groups = new Map<string, HealingLedgerRow[]>()
  for (const r of input.ledger) {
    if (!r.system_source || !(HEALING_LEDGER_SOURCES as readonly string[]).includes(r.system_source)) continue
    const k = `${r.brokerage_id ?? "platform"}|${r.system_source}|${r.subject_ref ?? r.action}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const cp = new Map(input.connectorProposals.map((p) => [p.id, p]))
  const out: HealingIncident[] = []
  for (const [key, group] of groups) {
    const rows = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const first = rows[0], last = rows[rows.length - 1]
    const source = String(first.system_source)
    const subject = String(first.subject_ref ?? first.action)
    const inc: HealingIncident = {
      key, brokerageId: first.brokerage_id, source, subject, classification: null, manager: first.actor_manager_key,
      domain: null, provider: null, capability: null, diagnosis: null, evidence: [], playbook: null, attempts: 0, costUsd: 0,
      action: null, verification: null, escalation: null, finalState: "in_progress", policyRef: null, firstAt: first.created_at, lastAt: last.created_at,
    }
    let proposed = false, escalated = false, failed = false
    let settled: "healed" | "verified" | "failed" | "escalated" | null = null
    for (const r of rows) {
      const d = pickObj(r.detail)
      const step = source === "os_health" ? r.action.split(".").slice(2).join(".") : (r.action.split(".").pop() ?? "")
      inc.costUsd += Number(r.cost_usd) || 0
      inc.policyRef = r.policy_ref ?? pickStr(d?.policy_ref, 80) ?? inc.policyRef
      inc.domain = pickStr(d?.domain, 40) ?? inc.domain
      inc.classification = pickStr(d?.gate, 40) ?? pickStr(d?.class, 40) ?? inc.classification
      inc.provider = r.provider ?? pickStr(d?.adapter, 60) ?? inc.provider
      inc.capability = pickStr(pickObj(d?.params)?.capability, 60) ?? pickStr(d?.capability, 60) ?? inc.capability
      inc.diagnosis = structuredDiagnosis(d) ?? inc.diagnosis
      for (const c of citationsOf(d)) if (!inc.evidence.some((x) => x.url === c.url)) inc.evidence.push(c)
      inc.action = step || inc.action
      // A troubleshooter playbook (playbook_<key>) or the supervisor's own recovery (decideRecovery's action).
      const recovery = step.startsWith("playbook_") && step !== "playbook_refused" ? step.slice("playbook_".length)
        : ["retry", "resume", "backoff", "failover", "route_data_steward", "route_compliance"].includes(step) ? step : null
      if (source === "os_health" && recovery) {
        inc.playbook = recovery
        inc.attempts++
        inc.verification = pickStr(r.outcome, 300)
        if (r.status !== "executed") failed = true
      }
      if (source === "provider_self_heal") {
        if (step === "retry") inc.verification = r.status === "executed" ? "retry succeeded" : "retry failed"
        if (step === "apply") { inc.playbook = "apply_declared_alternate"; inc.attempts++; if (r.status !== "executed") failed = true }
        if (step === "failover") inc.playbook = "failover"
      }
      if (source === "law_rule_healing") {
        inc.classification = pickStr(pickObj(d?.resolution)?.route, 40) ?? inc.classification
        if (step === "verify" && r.status === "executed") { inc.verification = "verified against cited primary sources"; settled = "verified" }
        if (step === "enable" && r.status === "executed") { inc.verification = "stricter-only rule enabled in WARN mode"; settled = "healed" }
      }
      if (step === "propose" || step.startsWith("escalate")) {
        const id = (pickStr(r.outcome, 300) ?? "").match(PROPOSAL_ID_RE)?.[1] ?? null
        if (step === "propose") proposed = proposed || r.status === "executed"
        else escalated = true
        inc.escalation = { reason: pickStr(r.reason_detail, 500), proposalId: id ?? inc.escalation?.proposalId ?? null, proposalStatus: id ? cp.get(id)?.status ?? null : inc.escalation?.proposalStatus ?? null }
      }
    }
    if (source === "law_rule_healing" && proposed) {
      const lp = input.lawProposals.find((p) => p.subject_key === `law_rule:${subject}` && p.brokerage_id === inc.brokerageId)
      if (lp) inc.escalation = { reason: inc.escalation?.reason ?? null, proposalId: lp.id, proposalStatus: lp.status }
    }
    // The playbook's VERIFIED outcome is the self_heal_events row the troubleshooter wrote for this subject.
    if (source === "os_health") {
      const ev = input.events
        .filter((e) => e.brokerage_id === inc.brokerageId && e.subject.endsWith(`:${subject}`) && e.action.startsWith("os_health_playbook:"))
        .sort((a, b) => a.created_at.localeCompare(b.created_at)).pop()
      if (ev) settled = ev.outcome === "healed" ? "healed" : ev.outcome === "failed" ? "failed" : "escalated"
    }
    if (source === "provider_self_heal" && inc.verification === "retry succeeded") settled = "healed"
    inc.finalState = settled === "healed" || settled === "verified" ? settled
      : proposed ? "proposed"
      : settled === "failed" || failed ? "failed"
      : escalated || settled === "escalated" ? "escalated" : "in_progress"
    out.push(inc)
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

/**
 * The healing console's read for one scope (a tenant's own incidents, or the platform's every-tenant view).
 * Every read reads its error (§3) — a refused read is a refusal, never "nothing healed".
 */
export async function loadHealingIncidents(svc: any, scope: TenantScope, windowDays = 14): Promise<{ ok: true; incidents: HealingIncident[]; windowDays: number } | { ok: false; error: string }> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const ledgerQ = applyTenantScope(
    svc.from("agent_action_ledger")
      .select("brokerage_id, action, actor_manager_key, subject_ref, status, outcome, reason_detail, provider, cost_usd, system_source, detail, policy_ref, created_at")
      .in("system_source", HEALING_LEDGER_SOURCES as unknown as string[]).gte("created_at", since),
    scope,
  ).order("created_at", { ascending: false }).limit(1000)
  const eventsQ = applyTenantScope(
    svc.from("self_heal_events").select("brokerage_id, subject, action, outcome, created_at").like("action", "os_health_playbook:%").gte("created_at", since),
    scope,
  ).order("created_at", { ascending: false }).limit(1000)
  const [l, e] = await Promise.all([ledgerQ, eventsQ])
  if (l.error) return { ok: false, error: `healing ledger unreadable: ${l.error.message}` }
  if (e.error) return { ok: false, error: `self-heal events unreadable: ${e.error.message}` }
  const ledger = (l.data ?? []) as HealingLedgerRow[]
  const ids = Array.from(new Set(ledger.map((r) => (r.outcome ?? "").match(PROPOSAL_ID_RE)?.[1]).filter((x): x is string => !!x))).slice(0, 200)
  const lawKeys = Array.from(new Set(ledger.filter((r) => r.system_source === "law_rule_healing" && r.subject_ref).map((r) => `law_rule:${r.subject_ref}`))).slice(0, 200)
  let connectorProposals: Array<{ id: string; status: string | null }> = []
  if (ids.length) {
    // Keyed ONLY by ids named in this scope's own (pinned) ledger rows — a tenant never lists another's proposal.
    const { data, error } = await svc.from("connector_healing_proposals").select("id, status").in("id", ids)
    if (error) return { ok: false, error: `healing proposals unreadable: ${error.message}` }
    connectorProposals = (data ?? []) as typeof connectorProposals
  }
  let lawProposals: Array<{ id: string; brokerage_id: string | null; subject_key: string; status: string | null }> = []
  if (lawKeys.length) {
    const { data, error } = await applyTenantScope(
      svc.from("improvement_proposals").select("id, brokerage_id, subject_key, status").eq("proposer", "law_rule_healing").in("subject_key", lawKeys),
      scope,
    ).limit(500)
    if (error) return { ok: false, error: `law-rule proposals unreadable: ${error.message}` }
    lawProposals = (data ?? []) as typeof lawProposals
  }
  return { ok: true, incidents: foldHealingIncidents({ ledger, events: (e.data ?? []) as HealingEventRow[], connectorProposals, lawProposals }), windowDays }
}
