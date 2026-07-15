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
  await svc.from("self_heal_events").insert({
    brokerage_id: evt.brokerageId,
    domain: evt.domain,
    subject: evt.subject,
    action: evt.action,
    outcome: evt.outcome,
    detail: (evt.detail ?? {}) as any,
  }).then(() => {}, () => {})
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
