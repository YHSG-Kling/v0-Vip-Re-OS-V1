/**
 * lib/managers/cross-referral.ts
 *
 * CROSS-MANAGER REFERRALS (round 34 — "managers should be working together and can
 * cross manage"). The raise side of the first-class governed referral:
 *
 *   raiseCrossManagerReferral() — a manager's sweep found something in a PEER's domain
 *     and raises it INTO that domain over the EXISTING bus (publishManagerSignal,
 *     signal_type 'cross_manager_referral'). Validation is the registry's DECLARED
 *     collaboration map (MANAGER_COLLABORATIONS): an edge no collaboration domain
 *     contains is refused HERE before it ever reaches the bus — and the shared
 *     receiving handler (lib/kernel/manager-signals.ts) re-checks on consumption, so
 *     neither end can free-lance an undeclared referral.
 *
 *   publishApprovalSlaReferrals() — the first live emitter: the Cron Manager
 *     (per-manager SLO owner) sweeps the approval-queue SLA telemetry
 *     (lib/kernel/approval-sla.ts, read-only over the canonical aggregator) and, for
 *     every kind whose oldest pending row is past the 48h breach line, refers the
 *     breach INTO the owning manager's domain (the approval_queue_slo collaboration).
 *     Recency-deduped per (to_manager, queue kind) over the bus ledger itself — a
 *     standing breach re-raises at most weekly, never every sweep. Runs from the
 *     manager-signals cron's publish phase (cron_manager-run, /api/cron/manager-signals).
 *
 * ROUND 36 — EVERY DELIBERATIVE DOMAIN HAS A LIVE RAISER (owner: the deliberation
 * protocol "completely built out"; the rule: no deliberative edge without a real
 * emitter). REFERRAL_EMITTERS is the registry of record — every emitter declares its
 * collaboration domain, its raising manager, and WHERE the raise lives:
 *
 *   · SWEEPS (run from the manager-signals cron via runReferralSweeps, registry-driven
 *     so a new sweep auto-joins):
 *       publishApprovalSlaReferrals    → approval_queue_slo          (cron_manager)
 *       publishLeadQualityReferrals    → lead_quality_spend          (ai_isa) — paid
 *         leads flowing while the ISA's qualification ledger disagrees with the CPL story
 *       publishRecruitOfferReferrals   → recruiting_offer_economics  (recruiting_manager)
 *         — a recruit at 'offer_extended' puts real terms on the table to argue
 *       publishAssignmentPolicyReferrals → assignment_policy_outcomes (ai_isa) — two
 *         active assignment rules' measured outcome rates diverge materially (round 38;
 *         lives beside its rail in lib/analytics/assignment-outcomes.ts)
 *       publishTerritoryRoiReferrals   → lead_quality_spend          (ai_isa) — one
 *         scraping market's recorded cost-per-promoted-lead diverges materially from
 *         the tenant's other markets (round 39; lives beside its funnel in
 *         lib/analytics/territory-roi.ts — the EXISTING acquisition edge, reused)
 *   · HOOKS (raised inline at the real decision point, additive, best-effort):
 *       listing-stall price play       → listing_demand_bridge       (manager-signals.ts)
 *       appraisal-gap detection        → closing_money_and_risk      (transaction-milestones.ts)
 *       organic-winner budget question → organic_paid_content        (marketing-agent-weekly-measure)
 *       vendor pick on a transaction   → transaction_vendor_selection (lib/kernel/vendors.ts)
 *       agent-referral fee agreed      → referral_fee_economics      (lib/referrals/agent-referral.ts, round 41)
 *       sequence touch dropped at cap  → sequence_touch_cadence      (lib/campaign-sequences/step-executor.ts, round 41)
 *
 * raiseReferralDeduped() is the shared raise-once idiom: recency-deduped over the bus
 * ledger itself by a payload dedupe key (no parallel state), then raiseCrossManagerReferral.
 *
 * Publishing goes through publishManagerSignal (its insert is error-checked and
 * returns { ok } — no silent .then loss); nothing here sends anything to a client.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { AD_CAMPAIGN_RUNNING_STATUSES } from "@/lib/integrations/credential-platforms"
import {
  BLOG_PENDING_PUBLISH_STATUS,
  NEWSLETTER_PENDING_APPROVAL_STATUSES,
  AD_CREATIVE_PENDING_APPROVAL_STATUSES,
  PODCAST_PENDING_APPROVAL_STATUS,
  VIDEO_SNIPPET_PENDING_APPROVAL_STATUS,
} from "@/lib/kernel/approval-pending"
import {
  MANAGERS, MANAGER_COLLABORATIONS, canRefer, type ManagerKey,
} from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** How long a consumed/expired referral for the same (to, queue-kind) suppresses a
 *  re-raise — a standing SLA breach nags weekly, not every 30-minute sweep. */
export const REFERRAL_RENAG_DAYS = 7

export interface CrossReferralInput {
  brokerageId: string
  fromManager: ManagerKey
  toManager: ManagerKey
  /** The declared collaboration domain this referral travels (MANAGER_COLLABORATIONS key). */
  collabDomain: string
  /** What the raising manager is asking the peer to do — plain language. */
  ask: string
  entityType?: string | null
  entityId?: string | null
  /** Extra payload facts (merged after the reserved collab_domain / ask keys). */
  payload?: Record<string, unknown>
}

/** PURE: is this referral allowed to travel? Both ends real + distinct, and the
 *  NAMED collaboration domain declares both managers. */
export function validateReferral(
  input: Pick<CrossReferralInput, "fromManager" | "toManager" | "collabDomain">,
): { ok: true } | { ok: false; reason: string } {
  const domain = MANAGER_COLLABORATIONS[input.collabDomain]
  if (!domain) return { ok: false, reason: `unknown collaboration domain '${input.collabDomain}'` }
  if (!canRefer(input.fromManager, input.toManager, input.collabDomain)) {
    return {
      ok: false,
      reason: `${input.fromManager} → ${input.toManager} is not a declared edge of '${input.collabDomain}' — cross-management only travels MANAGER_COLLABORATIONS`,
    }
  }
  return { ok: true }
}

/**
 * Raise a governed cross-manager referral on the bus. Refuses undeclared edges
 * before publishing. Returns the publish outcome (ok + signalId, or the refusal).
 */
export async function raiseCrossManagerReferral(
  input: CrossReferralInput, client?: Svc,
): Promise<{ ok: boolean; signalId?: string; reason?: string }> {
  const valid = validateReferral(input)
  if (!valid.ok) return { ok: false, reason: valid.reason }
  const supabase = client ?? createServiceClient()
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const fromLabel = MANAGERS[input.fromManager]?.label ?? input.fromManager
  return publishManagerSignal({
    brokerageId: input.brokerageId,
    fromManager: input.fromManager,
    toManager: input.toManager,
    signalType: "cross_manager_referral",
    message: `${fromLabel} referral (${MANAGER_COLLABORATIONS[input.collabDomain].label}): ${input.ask}`.slice(0, 500),
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payload: { ...(input.payload ?? {}), collab_domain: input.collabDomain, ask: input.ask },
  }, supabase)
}

/**
 * The shared raise-once idiom (round 36): a referral deduped over the bus ledger
 * itself — if a referral to the same manager whose payload contains the dedupe key
 * was raised within the renag window, skip (a standing situation nags weekly, never
 * every sweep/hook). The dedupe key is merged into the payload so the ledger IS the
 * dedupe state — no parallel table.
 */
export async function raiseReferralDeduped(
  input: CrossReferralInput & { dedupe: Record<string, unknown>; renagDays?: number },
  client?: Svc,
): Promise<{ ok: boolean; signalId?: string; skippedRecent?: boolean; reason?: string }> {
  const svc = client ?? createServiceClient()
  const cutoffIso = new Date(Date.now() - (input.renagDays ?? REFERRAL_RENAG_DAYS) * 86_400_000).toISOString()
  const { data: recent } = await svc
    .from("manager_signals")
    .select("id")
    .eq("brokerage_id", input.brokerageId)
    .eq("signal_type", "cross_manager_referral")
    .eq("to_manager", input.toManager)
    .contains("payload", input.dedupe)
    .gte("created_at", cutoffIso)
    .limit(1)
    .maybeSingle()
  if (recent) return { ok: true, skippedRecent: true }
  const { dedupe, renagDays: _renag, ...rest } = input
  return raiseCrossManagerReferral({ ...rest, payload: { ...(rest.payload ?? {}), ...dedupe } }, svc)
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRST LIVE EMITTER — the approval-queue SLA sweep.
// ─────────────────────────────────────────────────────────────────────────────

/** The probes that find CANDIDATE brokerages cheaply: any tenant carrying at least
 *  one pending approval row older than the breach line, per the aggregator's own
 *  source tables + filters (mirrored read-only — the aggregator stays untouched).
 *
 *  MIRRORED FROM THE SHARED CONSTANTS, NOT RETYPED. This list originally
 *  hardcoded its literals, which is exactly how it drifted: it asked
 *  video_snippets for approval_status='pending', a value that column's CHECK
 *  does not admit, so a snippet breaching its SLA could never make its tenant a
 *  candidate. Every pending value that lib/kernel/approval-pending.ts owns is
 *  now imported from there, so this mirror cannot diverge from the queue it
 *  mirrors. */
const BREACH_CANDIDATE_PROBES: Array<{
  table: string
  apply: (q: any, cutoffIso: string) => any
}> = [
  { table: "newsletter_campaigns",   apply: (q, c) => q.in("approval_status", [...NEWSLETTER_PENDING_APPROVAL_STATUSES]).lt("created_at", c) },
  { table: "email_campaigns",        apply: (q, c) => q.eq("approval_status", "pending").lt("created_at", c) },
  { table: "ad_creative_variations", apply: (q, c) => q.in("approval_status", [...AD_CREATIVE_PENDING_APPROVAL_STATUSES]).lt("created_at", c) },
  { table: "video_snippets",         apply: (q, c) => q.eq("approval_status", VIDEO_SNIPPET_PENDING_APPROVAL_STATUS).lt("created_at", c) },
  { table: "blog_posts",             apply: (q, c) => q.eq("publish_status", BLOG_PENDING_PUBLISH_STATUS).lt("created_at", c) },
  { table: "podcast_episodes",       apply: (q, c) => q.eq("approval_status", PODCAST_PENDING_APPROVAL_STATUS).lt("created_at", c) },
  { table: "ai_video_projects",      apply: (q, c) => q.eq("approval_status", "pending_review").lt("created_at", c) },
  { table: "offers",                 apply: (q, c) => q.eq("status", "pending").lt("created_at", c) },
  { table: "property_alerts",        apply: (q, c) => q.eq("is_active", false).in("source", ["voice_conversation", "text_conversation"]).lt("created_at", c) },
  { table: "approval_items",         apply: (q, c) => q.eq("status", "pending").lt("submitted_at", c) },
]

/** Bound per sweep — the cron runs every 30 min; a giant fleet drains over a few runs. */
const MAX_BROKERAGES_PER_SWEEP = 25

export interface SlaReferralSweepResult {
  candidates: number
  published: number
  skippedRecent: number
  errors: string[]
}

/**
 * The Cron Manager's SLA sweep: find tenants with >48h-old pending approvals, compute
 * the REAL per-kind telemetry through the canonical aggregator, and refer every
 * breached kind into its owning manager's domain (approval_queue_slo edge). One
 * referral per (owner, kind) per RENAG window, deduped against the bus ledger itself
 * (payload.queue_kind), so a standing breach never spams the inbox.
 */
export async function publishApprovalSlaReferrals(client?: Svc): Promise<SlaReferralSweepResult> {
  const svc = client ?? createServiceClient()
  const result: SlaReferralSweepResult = { candidates: 0, published: 0, skippedRecent: 0, errors: [] }
  const { APPROVAL_SLA_BREACH_HOURS, loadApprovalSla, slaBreaches } = await import("@/lib/kernel/approval-sla")
  const cutoffIso = new Date(Date.now() - APPROVAL_SLA_BREACH_HOURS * 3_600_000).toISOString()

  // 1) Candidate tenants — cheap per-table probes for stale pending rows.
  const candidateIds = new Set<string>()
  for (const probe of BREACH_CANDIDATE_PROBES) {
    try {
      const { data } = await probe.apply(svc.from(probe.table).select("brokerage_id"), cutoffIso).limit(500)
      for (const row of (data ?? []) as Array<{ brokerage_id: string | null }>) {
        if (row.brokerage_id) candidateIds.add(row.brokerage_id)
      }
    } catch (e) {
      result.errors.push(`${probe.table}: ${e instanceof Error ? e.message : "probe failed"}`)
    }
  }
  const candidates = Array.from(candidateIds).slice(0, MAX_BROKERAGES_PER_SWEEP)
  result.candidates = candidates.length
  if (candidates.length === 0) return result

  // 2) Per candidate: the REAL telemetry (canonical aggregator), then one governed
  //    referral per breached kind, recency-deduped over the bus ledger.
  for (const brokerageId of candidates) {
    try {
      const breaches = slaBreaches(await loadApprovalSla(brokerageId, null))
      for (const b of breaches) {
        if (b.owner === "cron_manager") continue // never self-refer (from === to is invalid anyway)
        const res = await raiseReferralDeduped({
          brokerageId,
          fromManager: "cron_manager",
          toManager: b.owner,
          collabDomain: "approval_queue_slo",
          ask: `${b.breached} ${b.label.toLowerCase()} approval${b.breached === 1 ? "" : "s"} pending past the ${APPROVAL_SLA_BREACH_HOURS}h SLA (oldest ${b.oldestHours}h, ${b.pending} pending total). Clear the queue or surface the blocker — the gate only works when a human actually reviews.`,
          payload: {
            pending: b.pending,
            breached: b.breached,
            oldest_hours: b.oldestHours,
            avg_hours: b.avgHours,
          },
          dedupe: { queue_kind: b.kind },
        }, svc)
        if (res.skippedRecent) result.skippedRecent += 1
        else if (res.ok) result.published += 1
        else if (res.reason) result.errors.push(`${brokerageId}/${b.kind}: ${res.reason}`)
      }
    } catch (e) {
      result.errors.push(`${brokerageId}: ${e instanceof Error ? e.message : "sweep failed"}`)
    }
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUND-36 SWEEP EMITTERS — the live raisers for the new deliberative domains.
// ─────────────────────────────────────────────────────────────────────────────

/** Paid leads must clear this floor in 30d before the quality dispute is worth arguing. */
export const LEAD_QUALITY_MIN_PAID_LEADS = 5
/** Below this qualified share (ISA ledger vs ad-reported leads) the sweep raises the dispute. */
export const LEAD_QUALITY_QUALIFIED_SHARE_FLOOR = 0.2

/**
 * THE LEAD-QUALITY SWEEP (lead_quality_spend, deliberative): tenants with LIVE ad
 * campaigns whose ad_performance reports leads flowing while the AI ISA's own
 * qualification ledger (ai_isa_qualifications) shows few or none of them qualifying —
 * the CPL story and the conversion story disagree about the same dollars. The AI ISA
 * raises the budget argument INTO the Ads Manager's domain; the deliberation (both
 * seats grounded in their own tables) argues shift-vs-scale. Deduped weekly per tenant
 * over the bus ledger itself.
 */
export async function publishLeadQualityReferrals(client?: Svc): Promise<SlaReferralSweepResult> {
  const svc = client ?? createServiceClient()
  const result: SlaReferralSweepResult = { candidates: 0, published: 0, skippedRecent: 0, errors: [] }
  const sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`
  try {
    const { data: camps } = await svc.from("ad_campaigns")
      .select("id, brokerage_id, campaign_name, status")
      .in("status", [...AD_CAMPAIGN_RUNNING_STATUSES]).limit(500)
    const byBrokerage = new Map<string, Array<{ id: string; campaign_name: string | null }>>()
    for (const c of (camps ?? []) as Array<{ id: string; brokerage_id: string | null; campaign_name: string | null }>) {
      if (!c.brokerage_id) continue
      const arr = byBrokerage.get(c.brokerage_id) ?? []
      arr.push({ id: c.id, campaign_name: c.campaign_name })
      byBrokerage.set(c.brokerage_id, arr)
    }
    const candidates = Array.from(byBrokerage.keys()).slice(0, MAX_BROKERAGES_PER_SWEEP)
    result.candidates = candidates.length
    for (const brokerageId of candidates) {
      try {
        let spend = 0, adLeads = 0
        for (const camp of (byBrokerage.get(brokerageId) ?? []).slice(0, 10)) {
          const { data: perf } = await svc.from("ad_performance")
            .select("spend, leads").eq("ad_campaign_id", camp.id).gte("captured_at", sinceIso).limit(200)
          for (const p of (perf ?? []) as Array<{ spend: number | null; leads: number | null }>) {
            spend += Number(p.spend) || 0
            adLeads += Number(p.leads) || 0
          }
        }
        if (spend <= 0 || adLeads < LEAD_QUALITY_MIN_PAID_LEADS) continue
        const { data: quals } = await svc.from("ai_isa_qualifications")
          .select("qualification_result").eq("brokerage_id", brokerageId).gte("qualified_at", sinceIso).limit(1000)
        const qualRows = (quals ?? []) as Array<{ qualification_result: string | null }>
        const qualified = qualRows.filter((q) => q.qualification_result === "qualified" || q.qualification_result === "appointment_set").length
        const qualifiedShare = qualified / adLeads
        // The dispute: paid leads are flowing but the ISA's own ledger can't confirm the
        // quality the CPL implies (no qualifications at all, or a qualified share under
        // the floor). No dispute → no referral — the sweep never manufactures an argument.
        if (qualRows.length > 0 && qualifiedShare >= LEAD_QUALITY_QUALIFIED_SHARE_FLOOR) continue
        const cpl = spend / adLeads
        const res = await raiseReferralDeduped({
          brokerageId,
          fromManager: "ai_isa",
          toManager: "ads_manager",
          collabDomain: "lead_quality_spend",
          ask: `Paid campaigns spent ${usd(spend)} for ${adLeads} reported leads in 30d (${usd(cpl)}/lead), but the qualification ledger shows ` +
            (qualRows.length === 0
              ? `NO ISA qualification passes in the window — the CPL math has no conversion evidence behind it.`
              : `only ${qualified} of ${qualRows.length} qualification passes qualifying (${Math.round(qualifiedShare * 100)}% of the reported paid leads).`) +
            ` Argue the budget: shift spend toward what converts, or defend the CPL with the campaign evidence.`,
          payload: {
            spend_30d: Math.round(spend), ad_leads_30d: adLeads,
            cpl_30d: Math.round(cpl), qualified_30d: qualified, qual_passes_30d: qualRows.length,
          },
          dedupe: { sweep: "lead_quality" },
        }, svc)
        if (res.skippedRecent) result.skippedRecent += 1
        else if (res.ok) result.published += 1
        else if (res.reason) result.errors.push(`${brokerageId}: ${res.reason}`)
      } catch (e) {
        result.errors.push(`${brokerageId}: ${e instanceof Error ? e.message : "sweep failed"}`)
      }
    }
  } catch (e) {
    result.errors.push(`lead-quality: ${e instanceof Error ? e.message : "sweep failed"}`)
  }
  return result
}

/**
 * THE RECRUIT-OFFER SWEEP (recruiting_offer_economics, deliberative): every recruit
 * sitting at recruits.status='offer_extended' has REAL terms on the table — the
 * Recruiting Manager raises the offer INTO Finance's domain so the split that wins
 * the candidate is argued against the margin the P&L can carry (both seats grounded:
 * the recruits pipeline vs agent_commission_profiles / agent_cap_tracking). Deduped
 * per recruit over the bus ledger.
 */
export async function publishRecruitOfferReferrals(client?: Svc): Promise<SlaReferralSweepResult> {
  const svc = client ?? createServiceClient()
  const result: SlaReferralSweepResult = { candidates: 0, published: 0, skippedRecent: 0, errors: [] }
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`
  try {
    const { data } = await svc.from("recruits")
      .select("id, brokerage_id, first_name, last_name, annual_volume, years_experience, current_brokerage")
      .eq("status", "offer_extended").limit(200)
    const rows = ((data ?? []) as Array<{
      id: string; brokerage_id: string | null; first_name: string | null; last_name: string | null
      annual_volume: number | null; years_experience: number | null; current_brokerage: string | null
    }>).filter((r) => r.brokerage_id)
    result.candidates = rows.length
    for (const r of rows.slice(0, MAX_BROKERAGES_PER_SWEEP * 2)) {
      try {
        const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "the candidate"
        const res = await raiseReferralDeduped({
          brokerageId: r.brokerage_id!,
          fromManager: "recruiting_manager",
          toManager: "finance_manager",
          collabDomain: "recruiting_offer_economics",
          entityType: "recruit",
          entityId: r.id,
          ask: `An offer is on the table for ${name}` +
            `${r.annual_volume != null ? ` (${usd(Number(r.annual_volume))} annual volume` + (r.years_experience != null ? `, ${r.years_experience} yrs experience` : "") + `${r.current_brokerage ? `, currently at ${r.current_brokerage}` : ""})` : ""}. ` +
            `Argue the terms: the split/cap that wins this candidate vs the margin the brokerage P&L can carry.`,
          payload: { recruit_status: "offer_extended" },
          dedupe: { recruit_id: r.id },
        }, svc)
        if (res.skippedRecent) result.skippedRecent += 1
        else if (res.ok) result.published += 1
        else if (res.reason) result.errors.push(`${r.brokerage_id}/${r.id}: ${res.reason}`)
      } catch (e) {
        result.errors.push(`${r.brokerage_id}: ${e instanceof Error ? e.message : "sweep failed"}`)
      }
    }
  } catch (e) {
    result.errors.push(`recruit-offer: ${e instanceof Error ? e.message : "sweep failed"}`)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// THE EMITTER REGISTRY (round 36) — every live raiser of cross_manager_referral,
// declared with its collaboration domain, raising manager, and WHERE the raise
// lives. The rule this registry enforces (simulator-checked, registry-driven, no
// hardcoded lists): NO DELIBERATIVE DOMAIN WITHOUT A LIVE RAISER. Sweeps run from
// the manager-signals cron via runReferralSweeps (a new sweep auto-joins); hooks
// are raised inline at their real decision points and are proven by source markers
// (the doc-kernel idiom).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReferralEmitterInfo {
  key: string
  /** MANAGER_COLLABORATIONS key this emitter raises on. */
  collabDomain: string
  /** The manager doing the raising (must be a member of the domain). */
  from: ManagerKey
  kind: "sweep" | "hook"
  /** The real decision point this emitter fires from — plain language. */
  what: string
  /** Where the raise lives; the simulator greps sourceFile for marker (doc-kernel idiom). */
  sourceFile: string
  marker: string
  /** Sweeps only: the cron-run entry point (runReferralSweeps iterates these). */
  run?: (client?: Svc) => Promise<SlaReferralSweepResult>
}

export const REFERRAL_EMITTERS: Record<string, ReferralEmitterInfo> = {
  approval_sla_sweep: {
    key: "approval_sla_sweep",
    collabDomain: "approval_queue_slo",
    from: "cron_manager",
    kind: "sweep",
    what: "Approval kinds aging past the 48h SLA referred to their owning managers",
    sourceFile: "lib/managers/cross-referral.ts",
    marker: "export async function publishApprovalSlaReferrals",
    run: publishApprovalSlaReferrals,
  },
  lead_quality_sweep: {
    key: "lead_quality_sweep",
    collabDomain: "lead_quality_spend",
    from: "ai_isa",
    kind: "sweep",
    what: "Paid leads flowing while the ISA qualification ledger disagrees with the CPL story",
    sourceFile: "lib/managers/cross-referral.ts",
    marker: "export async function publishLeadQualityReferrals",
    run: publishLeadQualityReferrals,
  },
  recruit_offer_sweep: {
    key: "recruit_offer_sweep",
    collabDomain: "recruiting_offer_economics",
    from: "recruiting_manager",
    kind: "sweep",
    what: "A recruit at 'offer_extended' — the offer terms argued against the margin",
    sourceFile: "lib/managers/cross-referral.ts",
    marker: "export async function publishRecruitOfferReferrals",
    run: publishRecruitOfferReferrals,
  },
  assignment_policy_sweep: {
    key: "assignment_policy_sweep",
    collabDomain: "assignment_policy_outcomes",
    from: "ai_isa",
    kind: "sweep",
    what: "Two active assignment rules' measured 30-day first-appointment outcomes diverge materially — the routing policy argued against the evidence",
    sourceFile: "lib/analytics/assignment-outcomes.ts",
    marker: "export async function publishAssignmentPolicyReferrals",
    // Lazy import — the sweep lives beside its rail (assignment-outcomes) which
    // imports raiseReferralDeduped from THIS module; a static import here would
    // be a cycle.
    run: (client?: Svc) =>
      import("@/lib/analytics/assignment-outcomes").then((m) => m.publishAssignmentPolicyReferrals(client as any)),
  },
  territory_roi_sweep: {
    key: "territory_roi_sweep",
    collabDomain: "lead_quality_spend",
    from: "ai_isa",
    kind: "sweep",
    what: "One scraping market's recorded cost-per-promoted-lead runs materially above the tenant's other markets — scrape budget argued against the funnel evidence (round 39; lives beside its funnel in lib/analytics/territory-roi.ts, EXISTING lead_quality_spend edge reused)",
    sourceFile: "lib/analytics/territory-roi.ts",
    marker: "export async function publishTerritoryRoiReferrals",
    // Lazy import — the sweep lives beside its funnel (territory-roi) which
    // imports raiseReferralDeduped from THIS module; a static import here would
    // be a cycle (the assignment_policy_sweep idiom).
    run: (client?: Svc) =>
      import("@/lib/analytics/territory-roi").then((m) => m.publishTerritoryRoiReferrals(client as any)),
  },
  listing_price_dispute_hook: {
    key: "listing_price_dispute_hook",
    collabDomain: "listing_demand_bridge",
    from: "listing_concierge",
    kind: "hook",
    what: "The stall predictor called a price-strategy conversation — seller price vs buyer demand, argued",
    sourceFile: "lib/kernel/manager-signals.ts",
    marker: 'collabDomain: "listing_demand_bridge"',
  },
  appraisal_gap_hook: {
    key: "appraisal_gap_hook",
    collabDomain: "closing_money_and_risk",
    from: "deal_coordinator",
    kind: "hook",
    what: "An appraisal came in low — seller-reduces vs buyer-covers vs split-or-reappraise, argued",
    sourceFile: "app/actions/transaction-milestones.ts",
    marker: 'collabDomain: "closing_money_and_risk"',
  },
  organic_winner_budget_hook: {
    key: "organic_winner_budget_hook",
    collabDomain: "organic_paid_content",
    from: "marketing_agent",
    kind: "hook",
    what: "A strong organic week — double down organic vs fund the paid push, argued",
    sourceFile: "app/api/cron/marketing-agent-weekly-measure/route.ts",
    marker: 'collabDomain: "organic_paid_content"',
  },
  vendor_selection_hook: {
    key: "vendor_selection_hook",
    collabDomain: "transaction_vendor_selection",
    from: "deal_coordinator",
    kind: "hook",
    what: "A vendor picked for a transaction job — deadline fit vs rated track record, argued",
    sourceFile: "lib/kernel/vendors.ts",
    marker: 'collabDomain: "transaction_vendor_selection"',
  },
  // ── Round 41 — the last genuinely-arguable seats (the no-noise audit): the Sphere's
  // referral-fee terms and the Orchestrator's dropped sequence touch. Managers still
  // without a deliberative seat (asset_manager, cron_manager) carry DOCUMENTED no-edge
  // verdicts in the registry beside MANAGER_COLLABORATIONS — simulator-locked. ──
  referral_fee_hook: {
    key: "referral_fee_hook",
    collabDomain: "referral_fee_economics",
    from: "sphere_of_influence",
    kind: "hook",
    what: "An agent-to-agent referral fee was agreed — relationship value vs the margin the receiving side's commission carries at close, argued",
    sourceFile: "lib/referrals/agent-referral.ts",
    marker: 'collabDomain: "referral_fee_economics"',
  },
  dropped_touch_hook: {
    key: "dropped_touch_hook",
    collabDomain: "sequence_touch_cadence",
    from: "campaign_orchestrator",
    kind: "hook",
    what: "The over-touch cap dropped a sequence touch after MAX_DEFERS — who owns the contact's attention window, argued at the exact drop moment",
    sourceFile: "lib/campaign-sequences/step-executor.ts",
    marker: 'collabDomain: "sequence_touch_cadence"',
  },
}

/** PURE: the emitters declared for a collaboration domain (simulator + governance surface). */
export function emittersForDomain(collabDomain: string): ReferralEmitterInfo[] {
  return Object.values(REFERRAL_EMITTERS).filter((e) => e.collabDomain === collabDomain)
}

/**
 * Run every registered SWEEP emitter (registry-driven — the manager-signals cron calls
 * this once; adding a sweep to REFERRAL_EMITTERS auto-joins it). Each sweep is
 * error-isolated: one failing sweep never starves the others.
 */
export async function runReferralSweeps(client?: Svc): Promise<{
  published: number
  skippedRecent: number
  errors: string[]
  perEmitter: Record<string, SlaReferralSweepResult>
}> {
  const svc = client ?? createServiceClient()
  const out = { published: 0, skippedRecent: 0, errors: [] as string[], perEmitter: {} as Record<string, SlaReferralSweepResult> }
  for (const emitter of Object.values(REFERRAL_EMITTERS)) {
    if (!emitter.run) continue
    try {
      const r = await emitter.run(svc)
      out.perEmitter[emitter.key] = r
      out.published += r.published
      out.skippedRecent += r.skippedRecent
      for (const err of r.errors.slice(0, 5)) out.errors.push(`${emitter.key}: ${err}`)
    } catch (e) {
      out.errors.push(`${emitter.key}: ${e instanceof Error ? e.message : "sweep failed"}`)
    }
  }
  return out
}
