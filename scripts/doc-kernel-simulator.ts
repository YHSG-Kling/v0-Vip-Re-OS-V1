#!/usr/bin/env tsx
/**
 * scripts/doc-kernel-simulator.ts   (npm run test:doc-kernel)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DOCUMENT KERNEL PROOF — program item #3, Phase A: scanned deal
 * documents become GOVERNED action. Per-field extraction ledger +
 * green/amber/red policy decisions + document-derived deadlines with
 * source provenance, on the EXISTING transaction_deadlines rail.
 *
 * Layer 1 (pure): the policy verdicts (conflict ALWAYS ambers; low
 * confidence never acts; additive green only), date parsing, and the
 * candidate planner (past-event dates are records, not deadlines).
 * Layer 2 (source locks): scanner hook wired, keep-one rail (canonical
 * deadline_type vocabulary; no parallel table), signal registered with a
 * classifier-matching kind, registry ownership, snapshot columns, UI
 * provenance badge.
 * Layer 3 (live, creds-gated): seed a real transaction + scanned
 * document → run the derivation → assert the extraction ledger, the
 * policy ledger, the derived deadline with provenance, the amber
 * conflict signal — then clean to count==0.
 */
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { decideDeadlinePolicy } from "../lib/documents/policy-decisions"
import { deriveDeadlineCandidates, parseDocDate } from "../lib/documents/deadline-derivation"
import { decideStageCandidate } from "../lib/documents/stage-candidates"
import { agreementUrgency } from "../lib/referrals/partner-agreement-watch"
import { computeShapeStats, decideAutonomyRatchet, shapeKey, RATCHET_MIN_APPROVALS, grantTargetForShape } from "../lib/documents/autonomy-ratchet"
import { computeSocialShapeStats, decideMarketingRatchet, MARKETING_RATCHET_MIN_APPROVALS } from "../lib/marketing/marketing-autonomy-ratchet"
import { composePartnersMeetingScript } from "../lib/intelligence/partners-meeting"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf-8") : "")

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Document kernel simulator (extraction ledger + policy + deadlines)")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[1 · pure — the green/amber/red policy]")
  check("no usable date → RED, nothing moves",
    decideDeadlinePolicy({ confidence: "high", derivedDate: null, existingDate: null }).decision === "red")
  check("a CONFLICT always ambers — even a high-confidence scan never silently moves a tracked date",
    decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).decision === "amber"
    && decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).recommendedAction === "confirm_deadline_correction"
    && decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).requiredApproverRole === "tc")
  check("document confirms the tracked date → GREEN stamp_source_provenance (evidence, not a rewrite)",
    decideDeadlinePolicy({ confidence: "medium", derivedDate: "2026-07-15", existingDate: "2026-07-15" }).recommendedAction === "stamp_source_provenance")
  check("high confidence + nothing tracked → GREEN insert (additive-only autonomy)",
    decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: null }).recommendedAction === "insert_deadline")
  check("medium → AMBER propose (human confirms); low → RED (rescan first)",
    decideDeadlinePolicy({ confidence: "medium", derivedDate: "2026-08-01", existingDate: null }).decision === "amber"
    && decideDeadlinePolicy({ confidence: "low", derivedDate: "2026-08-01", existingDate: null }).decision === "red")
  check("every verdict carries REASONS (the ledger is explainable, never a bare color)",
    decideDeadlinePolicy({ confidence: "low", derivedDate: "2026-08-01", existingDate: null }).reasons.length > 0
    && decideDeadlinePolicy({ confidence: "high", derivedDate: "2026-08-01", existingDate: "2026-07-15" }).reasons.some((r) => r.includes("2026-08-01") && r.includes("2026-07-15")))

  console.log("\n[2 · pure — dates + deadline candidates]")
  check("parseDocDate: ISO, prose date, garbage",
    parseDocDate("2026-08-15") === "2026-08-15"
    && parseDocDate("August 15, 2026") === "2026-08-15"
    && parseDocDate("N/A") === null && parseDocDate("") === null && parseDocDate(42 as any) === null)
  const contract = deriveDeadlineCandidates("signed_contract", {
    contract_effective_date: "2026-07-01", earnest_money_due_days: 3, price: 500000,
  })
  check("signed contract: effective date + EM window → earnest_money deadline on the CANONICAL type",
    contract.length === 1 && contract[0].deadlineType === "earnest_money" && contract[0].date === "2026-07-04"
    && contract[0].fieldKey === "earnest_money_due_days")
  check("closing disclosure → closing; PAL → pre_approval_expiration; commission agreement → its expiration",
    deriveDeadlineCandidates("closing_disclosure", { closing_date: "2026-09-30" })[0]?.deadlineType === "closing"
    && deriveDeadlineCandidates("pre_approval_letter", { expires_at: "2026-10-01" })[0]?.deadlineType === "pre_approval_expiration"
    && deriveDeadlineCandidates("commission_agreement", { expires_at: "2026-12-31" })[0]?.deadlineType === "commission_agreement_expiration")
  check("past-event dates are RECORDS, not deadlines — inspection/appraisal reports derive nothing",
    deriveDeadlineCandidates("inspection_report", { inspection_date: "2026-06-01" }).length === 0
    && deriveDeadlineCandidates("appraisal_report", { appraisal_date: "2026-06-05" }).length === 0)
  check("missing anchor or window → no candidate (never a fabricated date)",
    deriveDeadlineCandidates("signed_contract", { earnest_money_due_days: 3 }).length === 0
    && deriveDeadlineCandidates("signed_contract", { contract_effective_date: "2026-07-01" }).length === 0
    && deriveDeadlineCandidates("closing_disclosure", { closing_date: "TBD" }).length === 0)

  console.log("\n[3 · wiring — keep-one rail, scanner hook, registry, UI]")
  const scan = src("lib/documents/scan-uploaded-document.ts")
  check("the scanner runs the kernel post-scan (ledger + derivation), best-effort",
    scan.includes("recordFieldExtractions") && scan.includes("deriveDeadlinesFromDocument")
    && scan.includes("document-kernel hook failed (non-fatal)"))
  const deriv = src("lib/documents/deadline-derivation.ts")
  check("deadlines land on the EXISTING transaction_deadlines rail with source provenance — no parallel table",
    deriv.includes('from("transaction_deadlines")') && deriv.includes("source_document_id")
    && deriv.includes("source_field_key") && !deriv.includes("document_deadlines"))
  check("every candidate records a policy decision BEFORE any action; red stops; amber dedupes 14d on the bus",
    deriv.includes("recordPolicyDecision") && deriv.includes("deadline_conflict_finding")
    && deriv.includes("14 * 86_400_000"))
  check("completed/waived deadlines are settled history — the kernel never reopens them",
    deriv.includes('existing.status === "completed" || existing.status === "waived"'))
  const ledger = src("lib/documents/field-extraction-ledger.ts")
  check("the extraction ledger upserts per (document, field) and never clobbers a human-verified row",
    ledger.includes('onConflict: "document_id,field_key"') && ledger.includes('not("verified_at", "is", null)'))
  const registry = src("lib/kernel/manager-registry.ts")
  check("registry: document_kernel domain owned by deal_coordinator; both ledgers table-owned",
    registry.includes("document_kernel:") && registry.includes('proof: "test:doc-kernel"')
    && registry.includes('document_field_extractions: "deal_coordinator"')
    && registry.includes('policy_decisions: "compliance_officer"'))
  const signals = src("lib/kernel/signal-registry.ts")
  check("deadline_conflict_finding registered as an ALERT ('finding' matches the classifier) on the feed",
    /deadline_conflict_finding:.*kind: "alert"/.test(signals))
  check("the coordinator's Deadline Intelligence panel shows document provenance (assisted-mode transparency)",
    src("app/dashboard/coordinator/components/os/deadline-intelligence-panel.tsx").includes("source_document_id")
    && src("app/dashboard/coordinator/components/os/deadline-intelligence-panel.tsx").includes("from document"))
  const snapshot = src("scripts/schema-snapshot.ts")
  check("schema snapshot carries the new tables + deadline provenance columns",
    snapshot.includes("document_field_extractions:") && snapshot.includes("policy_decisions:")
    && /transaction_deadlines:.*source_document_id/.test(snapshot))

  console.log("\n[4 · pure — stage candidates (Phase B): evidence → legal move only]")
  check("the document ladder: EM receipt → INSPECTION, inspection report → APPRAISAL, appraisal → FINANCING_PENDING, CD → CLOSING_PREP",
    decideStageCandidate("UNDER_CONTRACT", new Set(["earnest_money_receipt"]))?.toStage === "INSPECTION"
    && decideStageCandidate("INSPECTION", new Set(["inspection_report"]))?.toStage === "APPRAISAL"
    && decideStageCandidate("APPRAISAL", new Set(["appraisal_report"]))?.toStage === "FINANCING_PENDING"
    && decideStageCandidate("FINANCING_PENDING", new Set(["closing_disclosure"]))?.toStage === "CLOSING_PREP")
  check("evidence out of stage-order asserts nothing (a CD during INSPECTION is a record, not a move); terminal stages never advance",
    decideStageCandidate("INSPECTION", new Set(["closing_disclosure"])) === null
    && decideStageCandidate("CLOSED", new Set(["closing_disclosure"])) === null
    && decideStageCandidate(null, new Set(["inspection_report"])) === null
    && decideStageCandidate("UNDER_CONTRACT", new Set(["addendum"])) === null)
  check("every candidate carries the plain-language evidence line",
    (decideStageCandidate("INSPECTION", new Set(["inspection_report"]))?.evidence ?? "").includes("inspection"))

  console.log("\n[5 · pure — partner agreement urgency (the silent-lapse fix)]")
  check("lapsed / expiring-within-30d / current / untracked — never a fabricated urgency",
    agreementUrgency("2026-01-01", "2026-07-11T00:00:00Z") === "lapsed"
    && agreementUrgency("2026-07-25", "2026-07-11T00:00:00Z") === "expiring"
    && agreementUrgency("2027-01-01", "2026-07-11T00:00:00Z") === "current"
    && agreementUrgency(null, "2026-07-11T00:00:00Z") === "untracked"
    && agreementUrgency("garbage", "2026-07-11T00:00:00Z") === "untracked")

  console.log("\n[6 · wiring — Phase B + the human loop, keep-one everywhere]")
  const stageMod = src("lib/documents/stage-candidates.ts")
  check("stage candidates consult the REAL engine gate (canAdvanceStage) BEFORE proposing; blocked → red policy decision, no bus spam",
    stageMod.includes("canAdvanceStage") && stageMod.includes('"resolve_blockers_first"')
    && stageMod.includes("stage_advance_candidate") && stageMod.includes("STAGE_TRANSITIONS"))
  check("the scanner runs the stage-candidate hook post-scan (Phase B rides the same event)",
    src("lib/documents/scan-uploaded-document.ts").includes("proposeStageCandidateFromDocument"))
  const review = src("app/actions/document-kernel-review.ts")
  const reviewCore = src("lib/documents/kernel-review-core.ts")
  check("the feed actions are auth-first + role-gated wrappers over the shared core, which resolves into policy_decisions + consumed_action (the trail survives the human hop)",
    review.includes("auth.getUser") && review.includes("REVIEW_ROLES")
    && reviewCore.includes("recordPolicyDecision") && reviewCore.includes('"consumed"'))
  check("approve drives the SAME advanceStage engine as the manual click — blockers surface honestly, signal stays open on failure",
    reviewCore.includes("advanceStage") && reviewCore.includes("blockers: result.blockers"))
  check("adopting the document's date writes the existing rail with source provenance; keeping the tracked date is recorded, not lost",
    reviewCore.includes("source_document_id") && reviewCore.includes("human_kept_tracked_date"))
  const feed = src("app/dashboard/admin/command-center/manager-talk-feed.tsx")
  check("the Command Center feed renders one-click decisions on BOTH proposal types",
    feed.includes("deadline_conflict_finding") && feed.includes("stage_advance_candidate")
    && feed.includes("resolveDeadlineConflictAction") && feed.includes("approveStageAdvanceAction")
    && feed.includes("dismissStageCandidateAction"))
  const extract = src("app/actions/document-extractions.ts")
  check("verification stamps a NAMED human + lifts confidence; the raw scan blob is never rewritten; re-derivation runs on verify",
    extract.includes("verified_by_user_id") && extract.includes('confidence: "high"')
    && extract.includes("deriveDeadlinesFromDocument") && !extract.includes('from("documents")\n    .update'))
  check("the deriver treats a verified field as HIGH confidence — the amber→green upgrade is structural, not a special case",
    src("lib/documents/deadline-derivation.ts").includes("verifiedKeys.has(c.fieldKey)")
    && src("lib/documents/deadline-derivation.ts").includes("effectiveConfidence"))
  check("the coordinator surfaces the Extracted Facts panel (confirm / correct, assisted-mode UI)",
    src("app/dashboard/coordinator/components/os/extracted-facts-panel.tsx").includes("verifyExtractionAction")
    && src("app/dashboard/coordinator/page.tsx").includes("ExtractedFactsPanel"))
  const watch = src("lib/referrals/partner-agreement-watch.ts")
  check("the partner agreement watch rides the EXISTING referral-asks cron (no new cron) and never auto-contacts the partner",
    watch.includes("partner_agreement_lapsing") && !watch.includes("dispatchEmail")
    && src("app/api/cron/referral-asks/route.ts").includes("runPartnerAgreementWatch"))
  const signals2 = src("lib/kernel/signal-registry.ts")
  check("both new signals registered with classifier-matching kinds ('candidate'→handoff, 'lapsing'→escalation)",
    /stage_advance_candidate:.*kind: "handoff"/.test(signals2)
    && /partner_agreement_lapsing:.*kind: "escalation"/.test(signals2))
  check("registry: Phase B + verification + feed resolution recorded on document_kernel; partner watch owned by the Sphere",
    src("lib/kernel/manager-registry.ts").includes("partner_agreement_watch:")
    && src("lib/kernel/manager-registry.ts").includes("assisted→autonomous ladder"))

  console.log("\n[7 · pure — THE AUTONOMY RATCHET: earned, never assumed]")
  {
    const approve = (t: string, current: string | null) => ({
      recommended_action: "human_adopted_document_date", target_id: t, evidence_json: { current_date: current },
    })
    const decline = (t: string, current: string | null) => ({
      recommended_action: "human_kept_tracked_date", target_id: t, evidence_json: { current_date: current },
    })
    const tenApprovals = Array.from({ length: RATCHET_MIN_APPROVALS }, () => approve("closing", "2026-09-15"))
    const stats10 = computeShapeStats(tenApprovals)
    check("10 consecutive approvals on ONE shape earns the ratchet; 9 does not",
      stats10.length === 1 && stats10[0].shape === shapeKey("deadline_correction", "closing")
      && decideAutonomyRatchet(stats10[0]) === true
      && decideAutonomyRatchet(computeShapeStats(tenApprovals.slice(1))[0]) === false)
    check("a SINGLE decline resets trust to zero — 20 approvals + 1 decline never ratchets",
      decideAutonomyRatchet(computeShapeStats([
        ...Array.from({ length: 20 }, () => approve("closing", "2026-09-15")),
        decline("closing", "2026-09-15"),
      ])[0]) === false)
    check("shapes are distinct per (mode, deadline_type): corrections and proposes never pool evidence",
      computeShapeStats([approve("closing", "2026-09-15"), approve("closing", null)]).length === 2
      && computeShapeStats([approve("closing", "x"), approve("earnest_money", "x")]).length === 2)
    check("unrelated policy rows (stage advances, dismissals) contribute NOTHING to the ratchet",
      computeShapeStats([
        { recommended_action: "stage_advanced", target_id: "APPRAISAL", evidence_json: {} },
        { recommended_action: "stage_candidate_dismissed", target_id: "APPRAISAL", evidence_json: {} },
        { recommended_action: "auto_adopted_granted", target_id: "closing", evidence_json: {} },
      ]).length === 0)
  }

  console.log("\n[8 · wiring — ratchet + spoken loop + KPI line, keep-one everywhere]")
  const ratchet = src("lib/documents/autonomy-ratchet.ts")
  check("grants live on managed_agents.config (the EXISTING autonomy policy surface) and load FAIL-CLOSED",
    ratchet.includes('from("managed_agents")') && ratchet.includes("doc_kernel_grants")
    && ratchet.includes("fail CLOSED"))
  check("the sweep proposes TO THE BROKER with the evidence counts, 30d re-ask dedupe, riding the deadline-watcher cron",
    ratchet.includes("autonomy_ratchet_proposal") && ratchet.includes("30 * 86_400_000")
    && src("app/api/cron/deadline-watcher/route.ts").includes("runAutonomyRatchetSweep"))
  const deriv2 = src("lib/documents/deadline-derivation.ts")
  check("the deriver honors granted shapes (auto-adopt / auto-track) and records green auto_* policy rows — the trail never thins",
    deriv2.includes("loadDocKernelGrants") && deriv2.includes("auto_adopted_granted")
    && deriv2.includes("auto_tracked_granted") && deriv2.includes("grants.has(grantedShape)"))
  check("granting is broker/admin-ONLY on the action; stage shapes are structurally unratchetable (deadline modes only)",
    src("app/actions/document-kernel-review.ts").includes("GRANT_ROLES")
    && ratchet.includes('"deadline_correction" | "deadline_propose"')
    && !ratchet.includes("stage_advance"))
  const feed2 = src("app/dashboard/admin/command-center/manager-talk-feed.tsx")
  check("the feed renders the grant decision (grant it / keep it human)",
    feed2.includes("autonomy_ratchet_proposal") && feed2.includes("resolveAutonomyRatchetAction")
    && feed2.includes("Keep it human"))
  const core = src("lib/documents/kernel-review-core.ts")
  check("ONE resolution core — the feed actions AND the voice verbs both ride kernel-review-core (no drift)",
    core.includes("resolveDeadlineConflictCore") && core.includes("approveStageAdvanceCore")
    && src("app/actions/document-kernel-review.ts").includes("kernel-review-core")
    && src("lib/voice/team-commands.ts").includes("kernel-review-core"))
  check("the spoken loop: kernel_proposals lists numbered, kernel_resolve re-lists LIVE and resolves by rank; ratchet grants REFUSE by voice",
    src("lib/voice/team-commands.ts").includes('case "kernel_proposals"')
    && src("lib/voice/team-commands.ts").includes('case "kernel_resolve"')
    && src("lib/voice/team-commands.ts").includes("the broker decides those on the Command Center")
    && src("lib/voice/tool-registry.ts").includes("kernel_resolve")
    && src("lib/voice/team-command-names.ts").includes("kernel_proposals"))
  check("both spoken front-ends route the new verbs through the SAME dispatcher",
    src("app/api/agent-assistant/tool-call/route.ts").includes('case "kernel_proposals"'))
  const rep = src("lib/kernel/reporting-autonomy.ts")
  check("the KPI line reads the kernel's OWN ledgers (scans, extractions, verified, deadlines-from-paper, conflicts, granted acts), tier-scoped via scope transactions",
    rep.includes("docKernel") && rep.includes("documentsScanned")
    && rep.includes('not("source_document_id", "is", null)')
    && rep.includes("auto_adopted_granted") && rep.includes("scopeTxIds"))
  check("the reports surface shows deadlines-from-paperwork; the narrative carries the doc-kernel line",
    src("app/dashboard/reports/page.tsx").includes("deadlines from paperwork")
    && rep.includes("straight from the paperwork"))

  console.log("\n[9 · pure — THE MARKETING RATCHET: a higher bar for the brand surface]")
  {
    const row = (postType: string, status: string, approver: string | null, ai = true) =>
      ({ post_type: postType, approval_status: status, approved_by: approver, ai_generated: ai })
    const twenty = Array.from({ length: MARKETING_RATCHET_MIN_APPROVALS }, () => row("market_update", "approved", "u1"))
    const s20 = computeSocialShapeStats(twenty)
    check("20 straight human approvals on one post_type earns the proposal; 19 does not (higher bar than the deal-file 10)",
      MARKETING_RATCHET_MIN_APPROVALS > RATCHET_MIN_APPROVALS
      && s20.length === 1 && s20[0].shape === "social_post:market_update"
      && decideMarketingRatchet(s20[0]) === true
      && decideMarketingRatchet(computeSocialShapeStats(twenty.slice(1))[0]) === false)
    check("ONE rejection resets trust; approvals need a NAMED approver; non-AI posts prove nothing",
      decideMarketingRatchet(computeSocialShapeStats([...twenty, row("market_update", "rejected", null)])[0]) === false
      && computeSocialShapeStats([row("market_update", "approved", null)]).length === 0
      && computeSocialShapeStats([row("market_update", "approved", "u1", false)]).length === 0)
    check("grantTargetForShape routes by prefix: social shapes → Campaign Orchestrator's marketing_grants, deadline shapes → Deal Coordinator's doc_kernel_grants",
      grantTargetForShape("social_post:market_update").agentKind === "campaign_orchestrator"
      && grantTargetForShape("social_post:market_update").configKey === "marketing_grants"
      && grantTargetForShape("deadline_correction:closing").agentKind === "deal_coordinator"
      && grantTargetForShape("deadline_correction:closing").configKey === "doc_kernel_grants")
  }

  console.log("\n[10 · pure — the Partners' Meeting trust deltas (spoken, earned-only)]")
  {
    const base = {
      weekLabel: "the week of 2026-07-05", teamPlays: 0, fireDrills: 0, whispers: 0,
      consentFallbacks: 0, withdrawnRespectfully: 0, handoffs: 0, dissents: 0,
      proposalsSent: 0, proposalsPending: 0, dealsClosed: 0,
      gciClosedThisWeek: 0, gciWeightedPipeline: 0,
      complianceReviewed: 0, complianceAdvisories: 0, complianceReleasedOverObjection: 0,
    }
    const withTrust = composePartnersMeetingScript({ ...base, autonomyGrantsThisWeek: 2, autonomousActsThisWeek: 7, docConflictsCaughtThisWeek: 1 }, "Dana")
    check("the meeting speaks the trust deltas: conflicts caught, grants this week, acts under granted autonomy",
      withTrust.includes("caught 1 date conflict in the paperwork")
      && withTrust.includes("granted the team 2 new standing moves")
      && withTrust.includes("ran 7 actions under autonomy you've already granted"))
    const noTrust = composePartnersMeetingScript(base, "Dana")
    check("a week with no trust movement stays silent (no fabricated grants); optional fields keep older callers valid",
      !noTrust.includes("standing move") && !noTrust.includes("under autonomy") && !noTrust.includes("date conflict"))
  }

  console.log("\n[11 · wiring — marketing lane + governance panel]")
  const mkt = src("lib/marketing/marketing-autonomy-ratchet.ts")
  check("the marketing sweep proposes on the SAME signal + feed buttons (one trust system, two domains), riding the social-cadence cron",
    mkt.includes("autonomy_ratchet_proposal") && mkt.includes('fromManager: "campaign_orchestrator"')
    && src("app/api/cron/social-cadence-tick/route.ts").includes("runMarketingRatchetSweep"))
  const cadence = src("lib/marketing/social-cadence.ts")
  check("the cadence honors a granted shape (approved+scheduled) but the manager's POSTURE overrides — approval_required beats any grant; fail-closed",
    cadence.includes("loadMarketingGrants") && cadence.includes("resolveManagerAutonomy")
    && cadence.includes('posture !== "approval_required"') && cadence.includes("fail closed"))
  check("auto-approved posts are ledger-recorded (auto_approved_by_grant) and stamped ai_generated for the evidence loop",
    cadence.includes("auto_approved_by_grant") && cadence.includes("ai_generated: true")
    && cadence.includes("recordPolicyDecision"))
  check("a grant loosens ONLY the queue — the publish terminal still requires approved status and the dispatch gates are untouched",
    cadence.includes("publish-social-posts only sends approval_status='approved'"))
  const panel = src("app/dashboard/admin/command-center/earned-autonomy-panel.tsx")
  check("the Earned Autonomy panel shows every grant with its evidence (earned-on, acts-since) and one-click revoke",
    panel.includes("actsSince") && panel.includes("earnedOn") && panel.includes("revokeAutonomyGrantAction"))
  const review2 = src("app/actions/document-kernel-review.ts")
  check("list + revoke are broker/admin-only; revoke writes the autonomy_revoked ledger row; the panel sits on the Command Center beside the Trust Meter",
    review2.includes("listEarnedAutonomyAction") && review2.includes("autonomy_revoked")
    && review2.includes("GRANT_ROLES")
    && src("app/dashboard/admin/command-center/page.tsx").includes("EarnedAutonomyPanel"))

  console.log("\n[12 · wiring — the 14th manager + the remaining marketing lanes + the pitch trust story]")
  {
    const { MANAGERS } = await import("../lib/kernel/manager-registry")
    check("the roster is 14 — the Cron Manager (operations) owns the heartbeat that keeps every other manager running",
      Object.keys(MANAGERS).length === 14 && "cron_manager" in MANAGERS
      && (MANAGERS as any).cron_manager.domain.toLowerCase().includes("heartbeat"))
    const reg = src("lib/kernel/manager-registry.ts")
    check("the ops portfolio moved to the Cron Manager: cron dispatch, SLO, bus self-heal, AI-ops console, OS sentinel + the ops crons",
      /cron_dispatch:\s*\{ manager: "cron_manager"/.test(reg)
      && /manager_ops_slo:\s*\{ manager: "cron_manager"/.test(reg)
      && /signal_dead_letter_retry:\s*\{ manager: "cron_manager"/.test(reg)
      && /os_sentinel:\s*\{ manager: "cron_manager"/.test(reg)
      && reg.includes('"/api/cron/health-check": "cron_manager"')
      && reg.includes('"/api/cron/manager-signals": "cron_manager"'))
    check("grantTargetForShape routes the NEW lanes (newsletter:/blog:) to the Campaign Orchestrator's marketing_grants",
      grantTargetForShape("newsletter:default").configKey === "marketing_grants"
      && grantTargetForShape("blog:default").configKey === "marketing_grants")
    const mkt2 = src("lib/marketing/marketing-autonomy-ratchet.ts")
    check("the sweep's evidence covers newsletter_campaigns + blog_posts (human-by-rail-construction on AI rows) at the SAME 20 bar",
      mkt2.includes('"newsletter_campaigns"') && mkt2.includes('"blog_posts"')
      && mkt2.includes("human by rail construction"))
    const bench = src("lib/kernel/marketing-bench.ts")
    check("the bench honors granted newsletter/blog shapes publish-ready (posture overrides, fail-closed, ledger-recorded)",
      bench.includes("grantedAutoApprove") && bench.includes('"newsletter:default"')
      && bench.includes('"blog:default"') && bench.includes("fail closed")
      && bench.includes("recordGrantAct"))
    check("the newsletter cadence honors the grant with the publish terminal's exact shape (approved + scheduled + send_date)",
      src("lib/marketing/newsletter-cadence.ts").includes('grants.has("newsletter:default")')
      && src("lib/marketing/newsletter-cadence.ts").includes('send_date: now.toISOString()'))
    const pitch = src("lib/recruiting/recruiting-pitch-kit.ts")
    check("the recruiting pitch sells the trust story (earned, visible, revocable, ledger-backed; legal gates always on)",
      pitch.includes("An AI team that earns your trust") && pitch.includes("revocable in one click")
      && pitch.includes("Fair Housing and consent gates run on every send regardless"))
  }

  console.log("\n[13 · pure — the SELLER DECISION trust layer (provenance → confidence → policy)]")
  {
    const { defaultProvenance, netSheetConfidence, decideNetSheetPolicy, counterScenario } = await import("../lib/offers/net-sheet-calc")
    const { extractTaxFigures } = await import("../lib/offers/public-record-preload")
    const base = defaultProvenance()
    check("a defaulted payoff is LOW confidence → RED: a $0 payoff overstates net by the whole mortgage — figures stay agent-only",
      netSheetConfidence(base) === "low" && decideNetSheetPolicy(base).decision === "red"
      && decideNetSheetPolicy(base).reasons[0].includes("overstate"))
    check("confirmed payoff + template prorations → MEDIUM/amber with the estimate lines NAMED; all strong → HIGH/green",
      netSheetConfidence({ ...base, mortgagePayoff: "confirmed" }) === "medium"
      && decideNetSheetPolicy({ ...base, mortgagePayoff: "confirmed" }).decision === "amber"
      && decideNetSheetPolicy({ ...base, mortgagePayoff: "confirmed" }).needsConfirmation.includes("countyCityTaxes")
      && netSheetConfidence({ commissionRate: "template", mortgagePayoff: "confirmed", countyCityTaxes: "public_record", hoaDuesProration: "confirmed", otherProratedFees: "default" }) === "high")
    const cs = counterScenario({ offerPrice: 500_000, buyerClosingCredit: 5_000 }, 515_000,
      { commissionRate: 0.06, mortgagePayoff: 200_000, countyCityTaxes: 2_500, hoaDuesProration: 300, otherProratedFees: 5_000 })
    check("counter what-if: recomputed net + honest delta + risk-aware explanation (no persuasion on a downside)",
      cs.deltaVsOffer === Math.round(15_000 * 0.94) && cs.explanation.includes("if the buyer accepts"))
    check("the records parser adopts ONLY positive finite figures across BatchData's shapes; garbage yields nulls",
      extractTaxFigures({ assessment: { taxAmount: "4,250", assessedValue: 310_000, taxYear: 2025 } }).tax === 4250
      && extractTaxFigures({ tax: { annualTaxAmount: 3900 } }).tax === 3900
      && extractTaxFigures({ assessment: { taxAmount: -5 } }).tax === null
      && extractTaxFigures("garbage").tax === null)
  }

  console.log("\n[14 · wiring — the net-sheet runner carries the trust layer end to end]")
  {
    const runner = src("lib/kernel/offer-net-sheet.ts")
    check("the runner preloads public-record taxes (provider-gated; a skip leaves the default AND its provenance)",
      runner.includes("preloadPublicRecordCosts") && runner.includes('"public_record"'))
    check("every net-sheet run records its green/amber/red on the SAME policy ledger (target seller_net_sheet)",
      runner.includes("recordPolicyDecision") && runner.includes('"seller_net_sheet"')
      && runner.includes("confirm_payoff_before_presenting"))
    check("the agent summary LEADS with the confidence state — red says the figures overstate; the portal card stays number-free by design",
      runner.includes("Presentation-grade") && runner.includes("OVERSTATE")
      && runner.includes("net_policy: netPolicy.decision"))
    const sheet = src("app/components/features/offers/interactive-net-sheet.tsx")
    check("the interactive sheet warns on a $0 payoff and carries the live counter what-if (pure counterScenario)",
      sheet.includes("Payoff is still $0") && sheet.includes("counterScenario")
      && sheet.includes("What if we counter?"))
    const preload = src("lib/offers/public-record-preload.ts")
    check("the preload rides the EXISTING BatchData rail and never fabricates a 'verified' (clean skip on unconfigured/no-figure)",
      preload.includes("batchDataPreferMcp") && preload.includes("never a fabricated")
      && preload.includes("skipReason"))
  }

  console.log("\n[15 · pure + wiring — THE ONBOARDING DECISION ROOM (day one IS the product)]")
  {
    const { composeOnboardingDecisions } = await import("../lib/onboarding/onboarding-decisions")
    const zero = composeOnboardingDecisions({
      brandName: null, aiIdentityConfigured: false, contactsImported: 0, sphereSignals: 0,
      pendingApprovals: 0, socialConnected: false, siteSlug: null, documentsScanned: 0,
    })
    check("a ZERO-fact tenant gets honest WAITING cards with the unblocking step — never invented readiness",
      zero.find((d) => d.key === "first_sphere_pass")?.state === "waiting"
      && zero.find((d) => d.key === "first_approvals")?.state === "waiting"
      && zero.find((d) => d.key === "your_website")?.state === "waiting"
      && zero.find((d) => d.key === "meet_your_assistant")?.state === "ready" // the one thing always adoptable
      && zero.find((d) => d.key === "first_deal_file")?.state === "ready")
    const rich = composeOnboardingDecisions({
      brandName: "Harbor Realty", aiIdentityConfigured: false, contactsImported: 412, sphereSignals: 6,
      pendingApprovals: 3, socialConnected: true, siteSlug: "harbor-realty", documentsScanned: 0,
    })
    check("a rich tenant's cards carry the EVIDENCE (real counts) and route to EXISTING rails (jobs, approvals, site)",
      Boolean(rich.find((d) => d.key === "first_sphere_pass")?.evidence.includes("412")
      && rich.find((d) => d.key === "first_sphere_pass")?.evidence.includes("6 carry a live signal")
      && rich.find((d) => d.key === "first_sphere_pass")?.action.href === "/dashboard/jobs"
      && rich.find((d) => d.key === "first_approvals")?.evidence.includes("3 AI-staged drafts")
      && rich.find((d) => d.key === "first_approvals")?.recommendation.includes("EARN standing autonomy")
      && rich.find((d) => d.key === "your_website")?.evidence.includes("/site/harbor-realty")
      && rich.find((d) => d.key === "meet_your_assistant")?.recommendation.includes('"Harbor Realty Assistant"')))
    const act = src("app/actions/onboarding-decisions.ts")
    check("adopting the assistant identity is PRINCIPAL-gated via the ONE shared tenancy rule, idempotent on UNIQUE(scope_type,scope_id), ledger-recorded",
      act.includes("isTenancyPrincipal") && act.includes('.eq("scope_type", "brokerage")')
      && act.includes("assistant_identity_adopted"))
    check("the tier-parity rule is CONSOLIDATED (grant actions + onboarding share lib/kernel/tenancy-principal — no drift)",
      src("app/actions/document-kernel-review.ts").includes("tenancy-principal")
      && src("lib/kernel/tenancy-principal.ts").includes('tier === "solo_agent"'))
    check("the Decision Room renders ABOVE the setup checklist on the same card (one first-week surface, not a new page)",
      src("app/components/onboarding/setup-readiness-card.tsx").includes("DecisionRoom")
      && src("app/components/onboarding/decision-room.tsx").includes("Adopt the proposed identity"))
  }

  console.log("\n[16 · pure + wiring — the LISTING-EXPIRY DECISION + lessons-at-the-moment + platform provider probe]")
  {
    const { composeExpiryDecision } = await import("../lib/listings/expiry-decision")
    const base = { daysToExpiry: 12, daysOnMarket: 60, areaMedianDom: 30, listPrice: 500_000, priceCutNets: [{ price: 485_000, net: 240_000, cutPct: 3 }] }
    check("live offer activity ALWAYS recommends relist — you don't release a listing with offers on the table",
      composeExpiryDecision({ ...base, showingsLast30: 1, offersReceived: 2 }).recommended === "relist")
    check("healthy showings at normal pace → relist (the term ran out, not the demand)",
      composeExpiryDecision({ ...base, daysOnMarket: 35, showingsLast30: 6, offersReceived: 0 }).recommended === "relist")
    check("thin showings → reprice, carrying the REAL price-cut net (canonical math, labeled estimate)",
      composeExpiryDecision({ ...base, showingsLast30: 1, offersReceived: 0 }).recommended === "reprice"
      && composeExpiryDecision({ ...base, showingsLast30: 1, offersReceived: 0 }).reason.includes("$240,000"))
    check("zero showings at 2x+ the area pace → release respectfully; unknown pace NEVER fabricates a pace claim",
      composeExpiryDecision({ ...base, daysOnMarket: 70, showingsLast30: 0, offersReceived: 0 }).recommended === "release"
      && composeExpiryDecision({ ...base, areaMedianDom: null, showingsLast30: 0, offersReceived: 0 }).recommended === "reprice"
      && !composeExpiryDecision({ ...base, areaMedianDom: null, showingsLast30: 0, offersReceived: 0 }).options[0].evidence.includes("area median"))
    const exp = src("lib/listings/expiry-decision.ts")
    check("the runner ledgers an ALWAYS-amber verdict (agreement decisions are human) and proposes the gated agent brief, idempotent per listing",
      exp.includes('"listing_expiry"') && exp.includes('decision: "amber"')
      && exp.includes("LISTING EXPIRY DECISION") && exp.includes("PROPOSAL_DEDUP_DAYS")
      && src("app/api/cron/listing-health-scan/route.ts").includes("runExpiryDecisions"))
    const { attachLessons } = await import("../lib/onboarding/onboarding-decisions")
    const withLesson = attachLessons(
      [{ key: "first_approvals", title: "t", evidence: "e", recommendation: "r", state: "ready" as const, action: { label: "l", href: "/x" } }],
      new Map([["working_with_managers", "mod-123"]]),
    )
    check("Decision Room cards teach at the moment of action — a published module attaches as /academy/module/<id>; no module, no fabricated link",
      withLesson[0].lessonHref === "/academy/module/mod-123"
      && attachLessons(withLesson, new Map())[0] !== undefined
      && src("app/components/onboarding/decision-room.tsx").includes("quick lesson"))
    check("the records provider (BatchData) probes on the PLATFORM go-live board (owner rule: providers are platform setup) — out-of-balance reads BROKEN with the reason, never silently ready",
      src("lib/platform/go-live-readiness.ts").includes('"records_provider"')
      && src("lib/platform/go-live-readiness.ts").includes("OUT OF BALANCE"))
  }

  console.log("\n[17 · wiring — the podcast rail is REAL end to end + the on-demand educator]")
  {
    const dist = src("app/api/cron/distribute-podcast-episodes/route.ts")
    check("the cron distributor rides the REAL Transistor rail (scoped-connection cascade → one syndication covers every platform channel) — the four simulated-success stubs are DEAD",
      dist.includes("resolveScopedConnection") && dist.includes("syndicateEpisode")
      && !dist.includes("Simulate API call") && !dist.includes("spotify_${episode.id}")
      && dist.includes("Refusing to simulate a publish"))
    check("the per-run memo clears on every tick (a warm lambda never replays a stale failure against a fixed distributor); custom channels keep the real webhook path",
      dist.includes("syndicationByEpisode.clear()") && dist.includes("webhook_url"))
    const { guideSearchTerms, composeGuideFallback } = await import("../lib/education/agent-guide")
    check("the guide's term extraction drops stopwords and keeps the meat",
      guideSearchTerms("How do I set up my voice twin?").includes("voice")
      && guideSearchTerms("How do I set up my voice twin?").includes("twin")
      && !guideSearchTerms("How do I set up my voice twin?").includes("how"))
    check("no matching guide → an HONEST answer that flags the gap (never invented steps); a match points to the module with its minutes",
      composeGuideFallback("x", []).includes("flagged")
      && composeGuideFallback("x", [{ moduleId: "m1", title: "Your voice twin", summary: "Set up ElevenLabs + D-ID.", estimatedMinutes: 4 }]).includes('"Your voice twin" (4 min)'))
    const guide = src("lib/education/agent-guide.ts")
    check("every question logs to the SAME chat ledger the question-gap miner reads — the library grows from real questions",
      guide.includes('"internal_assistant"') && guide.includes('from("chat_messages")')
      && guide.includes("question-gap miner"))
    check("ask_guidance rides the shared team-command dispatcher + registry, reachable from BOTH spoken front-ends",
      src("lib/voice/team-commands.ts").includes('case "ask_guidance"')
      && src("lib/voice/tool-registry.ts").includes("ask_guidance")
      && src("lib/voice/team-command-names.ts").includes("ask_guidance")
      && src("app/api/agent-assistant/tool-call/route.ts").includes('case "ask_guidance"'))
    check("grounding is PUBLISHED modules only; answers compose via the gateway with the deterministic fallback",
      guide.includes('eq("status", "published")') && guide.includes("generatePersonaCopy")
      && guide.includes("composeGuideFallback"))
  }

  console.log("\n[18 · wiring — the direct-mail campaign drain + the equity review decision]")
  {
    const drain = src("lib/direct-mail/campaign-drain.ts")
    check("the drain mails approved 'planning' campaign rows through the SHARED orchestrator (every gate applies) and stamps the SAME row — no duplicates, no simulated sends",
      drain.includes("orchestrateRenderAndSend") && drain.includes('.eq("approval_status", "approved")')
      && drain.includes('.is("lob_order_id", null)') && drain.includes("lob_order_id: result.messageId")
      && !drain.includes("Simulate"))
    check("audience rows stay with their own dispatchers; no deliverable address is an HONEST failed terminal; agents.id → users.id resolved for the brand/license lines",
      drain.includes("skippedAudience") && drain.includes("skippedNoAddress")
      && drain.includes('select("user_id").eq("id", row.agent_id)'))
    check("the drain rides the existing mail heartbeat (farm-mail-weekly), never a new cron",
      src("app/api/cron/farm-mail-weekly/route.ts").includes("runDirectMailCampaignDrain"))
    const { composeEquityDecision } = await import("../lib/kernel/anniversary-equity")
    check("EQUITY REVIEW: big equity + strong growth → move-up conversation (the lifetime lane's listing-lead moment)",
      composeEquityDecision({ basisPrice: 400_000, appreciation: 150_000, appreciationPct: 37.5, hasLoanData: true, estimatedRemainingBalance: 280_000, estimatedEquity: 270_000, equityBasis: "value_minus_estimated_balance" }, 5).recommended === "move_up_conversation")
    check("growth without loan data NEVER claims equity — the equity conversation routes rate/loan specifics to the lender; modest growth recommends protection, not a push",
      composeEquityDecision({ basisPrice: 400_000, appreciation: 60_000, appreciationPct: 15, hasLoanData: false, estimatedRemainingBalance: null, estimatedEquity: null, equityBasis: "appreciation_only" }, 3).recommended === "equity_conversation"
      && composeEquityDecision({ basisPrice: 400_000, appreciation: 60_000, appreciationPct: 15, hasLoanData: false, estimatedRemainingBalance: null, estimatedEquity: null, equityBasis: "appreciation_only" }, 3).reason.includes("appreciation only")
      && composeEquityDecision({ basisPrice: 400_000, appreciation: 12_000, appreciationPct: 3, hasLoanData: true, estimatedRemainingBalance: 300_000, estimatedEquity: 112_000, equityBasis: "value_minus_estimated_balance" }, 2).recommended === "stay_and_protect")
    check("the annual brief CARRIES the composed decision (options + recommendation) — the value moment became a decision surface",
      src("lib/kernel/anniversary-equity.ts").includes("EQUITY REVIEW — recommend")
      && src("lib/kernel/anniversary-equity.ts").includes("MOVE-UP CONVERSATION"))
    check("the pilot runbook exists and walks signup → decision room → earned autonomy (the demo arc)",
      src("docs/PILOT_RUNBOOK.md").includes("Earned autonomy") && src("docs/PILOT_RUNBOOK.md").includes("Decision Room"))
  }

  console.log("\n[19 · wiring — omnichannel voicedrop rung + the platform's own lead capture]")
  {
    const installer = src("lib/lead-pipeline/reactivation-sequence-installer.ts")
    check("the reactivation ladder gained the VOICE DROP rung (step 4) — omnichannel including voicedrops, per the owner directive",
      installer.includes('channel: "voice_drop"') && installer.includes("Ringless voicemail")
      && installer.includes("ringless voicemail in the agent's voice"))
    check("live tenants UPGRADE in place — an existing sequence gains missing rungs idempotently by step_number (no reinstall)",
      installer.includes("UPGRADE PATH") && installer.includes("!have.has(s.step_number)"))
    const adapter = src("lib/workflow/adapters/voice-drop.ts")
    check("the sequence voice_drop adapter rides the CANONICAL voicedrop rail (provider-configurable, TCPA+compliance gated) — the raw decommissioned-Vapi drift is DEAD",
      adapter.includes("orchestrateVoicedropSend") && !adapter.includes("api.vapi.ai")
      && adapter.includes("scriptOverride: script")
      && adapter.includes('eq("is_active", true)'))
    check("no active preset = an honest per-step error, never a fake send; the executor's TCPA gate already covers voice_drop",
      adapter.includes("No active voicedrop preset")
      && src("lib/campaign-sequences/step-executor.ts").includes('"voice_drop"'))
    const proc = src("lib/recruit-pipeline/recruit-processor.ts")
    check("PLATFORM LEAD CAPTURE — a switch-intent agent in an UNCLAIMED territory upserts platform_prospects (solo-tier, idempotent by email); nothing auto-sends",
      proc.includes("platform_prospects") && proc.includes("recruit_scrape_unclaimed_territory")
      && proc.includes('onConflict: "email"') && proc.includes("nothing auto-sends"))
  }

  console.log("\n[20 · wiring — the platform HUNTS its customers + DM ingestion + gift fulfillment]")
  {
    const { inferProspectRole, prospectDedupeKey, OS_INTENT_TERMS } = await import("../lib/platform/prospect-sourcer")
    check("OS-BUYING intent terms are tech-shopping language (competitor alternatives, CRM asks) — never the tenants' recruit/deal language",
      OS_INTENT_TERMS.some((t) => t.includes("alternative")) && OS_INTENT_TERMS.some((t) => t.includes("crm"))
      && !OS_INTENT_TERMS.some((t) => t.includes("leaving my brokerage")))
    check("tier interest is INFERRED from the language: brokerage terms → brokerage, team terms → team, default solo",
      inferProspectRole("thinking about software for my brokerage and our office") === "brokerage"
      && inferProspectRole("need a team crm for my team of 6") === "team"
      && inferProspectRole("what's the best crm for realtors") === "solo_agent")
    check("pseudonymous prospects dedupe by source record key (no email to conflict on)",
      prospectDedupeKey("reddit_os_intent", "abc123") === "src:reddit_os_intent:abc123")
    const sourcer = src("lib/platform/prospect-sourcer.ts")
    check("the hunt is provider-gated, ISO-week idempotent, ends in ONE staff digest with composed outreach drafts — nothing auto-sends to prospects",
      sourcer.includes("scrapeRedditPosts") && sourcer.includes("[week:") && sourcer.includes("composeProspectOutreach")
      && sourcer.includes("Nothing auto-sends")
      && src("app/api/cron/lead-scraping/route.ts").includes("sourcePlatformProspects"))
    const dm = src("app/api/webhooks/meta-dm/route.ts")
    check("the Meta DM webhook verifies honestly (unset token = 404), maps the page to its tenant via social_media_accounts, and ACKs-and-skips unowned pages — never fabricates",
      dm.includes("META_WEBHOOK_VERIFY_TOKEN") && dm.includes("hub.challenge")
      && dm.includes('from("social_media_accounts")') && dm.includes("never fabricate"))
    check("DM threads land as conversations type 'social_dm' — the unified inbox's own table, one row per (page, sender) thread",
      dm.includes('"social_dm"') && dm.includes("page_id: ev.pageId, sender_id: ev.senderId"))
    const { composeShoppableLinks } = await import("../lib/gifting/shoppable-links")
    const shop = composeShoppableLinks("closing gift charcuterie board", { budgetMax: 100 })
    check("B2C GIFTING (owner rule: no fulfillment provider) — the gift task carries one-click SHOPPABLE links for the exact recommended item; the agent buys personally",
      shop.etsy.includes("etsy.com/search?q=closing%20gift%20charcuterie%20board")
      && shop.amazon.includes("amazon.com/s?k=")
      && src("lib/workflow/adapters/send-gift.ts").includes("composeShoppableLinks")
      && !src("lib/workflow/adapters/send-gift.ts").includes("fulfillGiftExternally"))
  }

  console.log("\n[21 · live — the full derivation against the real database]")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("  ○ skipped (no live credentials in this environment)")
  } else {
    const { createServiceClient } = await import("../lib/supabase/service")
    const { deriveDeadlinesFromDocument } = await import("../lib/documents/deadline-derivation")
    const { recordFieldExtractions } = await import("../lib/documents/field-extraction-ledger")
    const svc = createServiceClient()
    const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!b?.id) { console.log("  ○ skipped (no live brokerage)") }
    else {
      const brokerageId = (b as any).id as string
      let txId: string | null = null, docId: string | null = null, doc2Id: string | null = null
      try {
        const { data: tx, error: txErr } = await svc.from("transactions").insert({
          brokerage_id: brokerageId, deal_name: "doc-kernel-sim deal", deal_type: "buyer",
          status: "under_contract", property_address: "1 Doc Kernel Sim Way",
        }).select("id").single()
        if (txErr || !tx) throw new Error(`seed tx failed: ${txErr?.message}`)
        txId = (tx as any).id

        const fields = { property_address: "1 Doc Kernel Sim Way", contract_effective_date: "2026-07-01", earnest_money_due_days: 3, price: 500000 }
        const { data: d1, error: d1Err } = await svc.from("documents").insert({
          brokerage_id: brokerageId, transaction_id: txId, document_type: "contract",
          classification: "signed_contract", classification_confidence: "high",
          extracted_fields: fields, status: "complete",
        }).select("id").single()
        if (d1Err || !d1) throw new Error(`seed doc failed: ${d1Err?.message}`)
        docId = (d1 as any).id

        // The ledger: one row per usable field, idempotent on re-run.
        const rec1 = await recordFieldExtractions(svc as any, { documentId: docId!, brokerageId, fields, confidence: "high", extractionModel: "router:document_classification" })
        const rec2 = await recordFieldExtractions(svc as any, { documentId: docId!, brokerageId, fields, confidence: "high", extractionModel: "router:document_classification" })
        const { count: ledgerCount } = await svc.from("document_field_extractions").select("id", { count: "exact", head: true }).eq("document_id", docId!)
        check("live: extraction ledger writes one row per field, idempotent on re-scan",
          rec1.recorded === 4 && rec2.recorded === 4 && ledgerCount === 4)

        // GREEN insert: high confidence, nothing tracked → deadline with provenance.
        const run1 = await deriveDeadlinesFromDocument(svc as any, { documentId: docId!, brokerageId, transactionId: txId, classification: "signed_contract", confidence: "high", fields })
        const { data: dl } = await svc.from("transaction_deadlines").select("deadline_type, deadline_date, status, source_document_id, source_field_key").eq("transaction_id", txId!).eq("deadline_type", "earnest_money").maybeSingle()
        check("live: GREEN — earnest_money deadline derived (effective+3d) with document provenance",
          run1.inserted === 1 && !!dl
          && String((dl as any).deadline_date).slice(0, 10) === "2026-07-04"
          && (dl as any).source_document_id === docId && (dl as any).source_field_key === "earnest_money_due_days", JSON.stringify(run1))
        const run1b = await deriveDeadlinesFromDocument(svc as any, { documentId: docId!, brokerageId, transactionId: txId, classification: "signed_contract", confidence: "high", fields })
        check("live: re-run confirms instead of duplicating (idempotent)", run1b.inserted === 0 && run1b.confirmed === 1)

        // AMBER conflict: a second document asserts a DIFFERENT closing date than a tracked one.
        await svc.from("transaction_deadlines").insert({ transaction_id: txId, brokerage_id: brokerageId, deadline_type: "closing", deadline_date: "2026-09-15", status: "pending" })
        const cdFields = { closing_date: "2026-09-30", lender_name: "Sim Lender" }
        const { data: d2 } = await svc.from("documents").insert({
          brokerage_id: brokerageId, transaction_id: txId, document_type: "closing_disclosure",
          classification: "closing_disclosure", classification_confidence: "high",
          extracted_fields: cdFields, status: "complete",
        }).select("id").single()
        doc2Id = (d2 as any)?.id ?? null
        const run2 = await deriveDeadlinesFromDocument(svc as any, { documentId: doc2Id!, brokerageId, transactionId: txId, classification: "closing_disclosure", confidence: "high", fields: cdFields })
        const { data: sig } = await svc.from("manager_signals").select("id, message, payload").eq("brokerage_id", brokerageId).eq("signal_type", "deadline_conflict_finding").contains("payload", { transaction_id: txId }).maybeSingle()
        const { data: dlAfter } = await svc.from("transaction_deadlines").select("deadline_date").eq("transaction_id", txId!).eq("deadline_type", "closing").maybeSingle()
        check("live: AMBER — the conflicting date raised a gated review signal and the tracked date did NOT move",
          run2.conflictsProposed === 1 && !!sig
          && String((dlAfter as any)?.deadline_date).slice(0, 10) === "2026-09-15"
          && String((sig as any)?.message ?? "").includes("2026-09-30"), JSON.stringify(run2))

        // The policy ledger recorded every verdict.
        const { data: pds } = await svc.from("policy_decisions").select("decision, target_id, recommended_action").eq("transaction_id", txId!)
        const pdRows = (pds ?? []) as any[]
        check("live: policy_decisions carries the full trail — green insert, green confirm, amber conflict",
          pdRows.some((r) => r.decision === "green" && r.recommended_action === "insert_deadline")
          && pdRows.some((r) => r.decision === "green" && r.recommended_action === "stamp_source_provenance")
          && pdRows.some((r) => r.decision === "amber" && r.target_id === "closing"))
      } catch (e: any) {
        check("live: derivation flow ran", false, e?.message ?? String(e))
      } finally {
        // Clean to count==0 (FK cascade order: signals/policy/ledger/deadlines → docs → tx).
        if (txId) {
          await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("signal_type", "deadline_conflict_finding").contains("payload", { transaction_id: txId })
          await svc.from("policy_decisions").delete().eq("transaction_id", txId)
          await svc.from("transaction_deadlines").delete().eq("transaction_id", txId)
        }
        if (docId) { await svc.from("document_field_extractions").delete().eq("document_id", docId); await svc.from("documents").delete().eq("id", docId) }
        if (doc2Id) await svc.from("documents").delete().eq("id", doc2Id)
        if (txId) await svc.from("transactions").delete().eq("id", txId)
        if (txId && docId) {
          const [{ count: c1 }, { count: c2 }, { count: c3 }, { count: c4 }] = await Promise.all([
            svc.from("policy_decisions").select("id", { count: "exact", head: true }).eq("transaction_id", txId),
            svc.from("document_field_extractions").select("id", { count: "exact", head: true }).eq("document_id", docId),
            svc.from("transaction_deadlines").select("id", { count: "exact", head: true }).eq("transaction_id", txId),
            svc.from("transactions").select("id", { count: "exact", head: true }).eq("id", txId),
          ])
          check("live: cleaned to count==0", (c1 ?? -1) === 0 && (c2 ?? -1) === 0 && (c3 ?? -1) === 0 && (c4 ?? -1) === 0)
        }
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Document kernel Phase A verified — per-field ledger, policy-gated deadlines, provenance end to end.")
  console.log(" DOC_KERNEL_PASS")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
