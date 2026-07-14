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

  console.log("\n[21 · pure + wiring — THE GIFT STUDIO (the AI knows the customer AND the deal)]")
  {
    const { composeGiftSelections, mineGiftInterests, mineLifeEvents } = await import("../lib/gifting/gift-studio")
    const rich = composeGiftSelections({
      occasion: "closing", familyName: "Henderson", firstNames: "Dana & Sam",
      homeAddress: "12 Birch Lane", closeYear: 2026, persona: "first_time_buyer",
      budgetMax: null, pastGiftKeys: [], interests: [], lifeEvents: [],
    })
    check("deal-grounded picks: the engraving line is ALREADY WRITTEN from the closed home's address + family + year; every pick carries evidence + a pre-scoped buy link",
      rich.length >= 3 && rich.some((s) => s.personalization === "The Henderson Family · 12 Birch Lane · Est. 2026")
      && rich.every((s) => s.personalization !== null)
      && rich.every((s) => s.whyThisFits.length > 10) && rich.every((s) => s.etsyUrl.includes("etsy.com/search")))
    const noAddress = composeGiftSelections({
      occasion: "closing", familyName: null, firstNames: "Dana",
      homeAddress: null, closeYear: null, persona: null, budgetMax: null, pastGiftKeys: [], interests: [], lifeEvents: [],
    })
    check("no address = HONEST degradation — address-personalized archetypes drop out, the universal basket stands; past gifts never repeat",
      noAddress.every((s) => !s.title.includes("address") || s.personalization === null)
      && noAddress.some((s) => s.key === "local_gourmet_basket")
      && composeGiftSelections({ occasion: "closing", familyName: "H", firstNames: "D", homeAddress: "1 Elm", closeYear: 2026, persona: null, budgetMax: null, pastGiftKeys: ["home_portrait_cutting_board"], interests: [], lifeEvents: [] })
        .every((s) => s.key !== "home_portrait_cutting_board"))
    check("the in-window flow is complete: queue of ungifted closings → selections → order row (personalization_note) + purchase task, all inside the OS",
      src("app/actions/gift-studio.ts").includes("personalization_note")
      && src("app/actions/gift-studio.ts").includes('source: "gift_studio"')
      && src("app/dashboard/gifts/page.tsx").includes("GiftStudioClient")
      && src("app/dashboard/gifts/gift-studio-client.tsx").includes("Create the order"))
    // MEMORY EXPANSION (owner: "the gifts don't need to be limited to house
    // painting or cutting boards" + service manifesto's deep-memory principle)
    const mined = mineGiftInterests({
      tags: ["past_client"], notes: "Two golden retrievers; she loves her garden. Just joined the leadership team.",
      occupation: null, aiInsights: null, contactType: null,
    })
    check("MEMORY MINING is word-boundary honest — 'golden retrievers' + 'garden' mine to pet/garden; 'joined the team' NEVER becomes 'tea'; life_events jsonb normalizes to actionable keys",
      mined.includes("pet") && mined.includes("garden") && !mined.includes("tea")
      && mineLifeEvents([{ type: "marriage_detected", detail: "wedding announcement" }]).includes("marriage")
      && mineLifeEvents(null).length === 0)
    const dogOwner = composeGiftSelections({
      occasion: "closing", familyName: "Ortiz", firstNames: "Maya",
      homeAddress: "9 Cedar Ct", closeYear: 2026, persona: null,
      budgetMax: null, pastGiftKeys: [], interests: ["pet"], lifeEvents: [],
    }, 4)
    check("beyond the house category: a remembered pet EARNS the pet-portrait pick, carries its memoryHook ('from their story'), and OUTRANKS the category defaults",
      dogOwner[0]?.key === "custom_pet_portrait" && dogOwner[0]?.memoryHook === "pet"
      && dogOwner.some((s) => s.key === "home_portrait_cutting_board")
      && rich.every((s) => s.key !== "custom_pet_portrait"))
    const birthdayNoHouse = composeGiftSelections({
      occasion: "birthday", familyName: "Lee", firstNames: "Ana",
      homeAddress: null, closeYear: null, persona: null,
      budgetMax: null, pastGiftKeys: [], interests: ["coffee"], lifeEvents: [],
    }, 4)
    const newlywed = composeGiftSelections({
      occasion: "congratulations", familyName: "Nguyen", firstNames: "Bao & Linh",
      homeAddress: null, closeYear: 2026, persona: null,
      budgetMax: null, pastGiftKeys: [], interests: [], lifeEvents: ["marriage"],
    }, 4)
    check("occasion breadth without the house: a birthday pick rides the coffee ritual (memory-hooked), a detected wedding earns the newlywed keepsake with the celebration line",
      birthdayNoHouse[0]?.key === "morning_ritual_set" && birthdayNoHouse[0]?.etsyUrl.includes("coffee")
      && newlywed[0]?.key === "newlywed_keepsake" && newlywed[0]?.personalization === "The Nguyen Family · Est. 2026")
    check("the action feeds the miners from the file's REAL memory columns (tags/notes/occupation/ai_insights/life_events) and the UI shows the hook",
      src("app/actions/gift-studio.ts").includes("mineGiftInterests") && src("app/actions/gift-studio.ts").includes("life_events")
      && src("app/dashboard/gifts/gift-studio-client.tsx").includes("from their story")
      && src("app/dashboard/gifts/gift-studio-client.tsx").includes("referral_thank_you"))
  }

  console.log("\n[22 · pure + wiring — LUXURY DETAILS (addressing memory + end-of-day recognition)]")
  {
    const { resolveAddressing } = await import("../lib/kernel/addressing")
    const bill = resolveAddressing({
      firstName: "William", lastName: "Chen", preferredName: "Bill",
      namePronunciation: null, salutationStyle: "casual",
    })
    const siobhan = resolveAddressing({
      firstName: "Siobhan", lastName: "Kelly", preferredName: null,
      namePronunciation: "SHIV-on", salutationStyle: "formal",
    })
    const empty = resolveAddressing({
      firstName: null, lastName: null, preferredName: null,
      namePronunciation: null, salutationStyle: null,
    })
    check("ADDRESSING MEMORY ('call me Bill') — the preferred name WINS with a never-'William' rule; pronunciation rides formal greetings; nothing captured = plain fallback with NO prompt rule",
      bill.addressAs === "Bill" && bill.greeting === "Hi Bill," && Boolean(bill.promptLine?.includes('never "William"'))
      && siobhan.greeting === "Dear Siobhan Kelly," && siobhan.pronunciationNote === 'Pronounced "SHIV-on".'
      && empty.addressAs === "there" && empty.promptLine === null)
    check("addressing is ENFORCED at the copy seams — outreach drafts prefer preferred_name, the shared team note leads with the addressing rule, the contact card captures it (l48-s01 live)",
      src("lib/ai-isa/personalize-outreach.ts").includes("input.preferred_name ?? input.first_name")
      && src("lib/kernel/conversation-memory.ts").includes("prefers to be called")
      && src("app/crm/contacts/[contactId]/page.tsx").includes("AddressingCard")
      && src("app/actions/contacts/update-addressing.ts").includes("assertCanActOnContact")
      && src("scripts/l48-s01-contacts-addressing.sql").includes("preferred_name"))
    const { composeISawYouActions, humanizePortalActivity, I_SAW_YOU_MIN_SIGNALS } = await import("../lib/intelligence/i-saw-you")
    const heavy = composeISawYouActions([
      { contactId: "c-1", addressAs: "Bill", portalActions: 3, homesViewed: 4, highlight: humanizePortalActivity("affordability_checked") },
      { contactId: "c-2", addressAs: "Ana", portalActions: 1, homesViewed: 1, highlight: null },
      { contactId: "c-3", addressAs: "Maya", portalActions: 9, homesViewed: 2, highlight: null },
    ])
    check("END-OF-DAY 'I SAW YOU' — a heavy client evening earns a recognition draft (non-salesy, addressed by preferred name, busiest first); a drive-by NEVER triggers it",
      heavy.length === 2 && heavy[0]?.entity_id === "c-3" && heavy[1]?.entity_id === "c-1"
      && Boolean(heavy[1]?.context.includes("Bill, I saw how much ground you covered"))
      && Boolean(heavy[1]?.context.includes("checking what you can afford"))
      && heavy.every((a) => a.action_type === "draft_followup" && !a.context.toLowerCase().includes("listing"))
      && I_SAW_YOU_MIN_SIGNALS >= 3)
    check("the recognition rides the MORNING BRIEFING deterministically (real client_portal_activity + property_views; ownership resolved through contacts, never trusted from the activity row)",
      src("lib/intelligence/daily-briefing-generator.ts").includes("composeISawYouActions")
      && src("lib/intelligence/daily-briefing-generator.ts").includes('from("client_portal_activity")')
      && src("lib/intelligence/daily-briefing-generator.ts").includes("...iSawYouActions")
      && src("lib/intelligence/daily-briefing-generator.ts").includes('.eq("agent_id", owningAgentId)'))
    const { inferStrategyMoment, composeStrategySession } = await import("../lib/kernel/strategy-session")
    check("STRATEGY MOMENTS resolve by real state priority — offers on the table beat a stale listing beat a fresh launch beat the buyer kickoff; nothing to plan = honest null",
      inferStrategyMoment({ buyerStage: null, hasActiveListing: true, daysOnMarket: 40, offersAwaitingResponse: 2 }) === "offer_decision"
      && inferStrategyMoment({ buyerStage: null, hasActiveListing: true, daysOnMarket: 28, offersAwaitingResponse: 0 }) === "price_change"
      && inferStrategyMoment({ buyerStage: null, hasActiveListing: true, daysOnMarket: 5, offersAwaitingResponse: 0 }) === "listing_launch"
      && inferStrategyMoment({ buyerStage: "searching", hasActiveListing: false, daysOnMarket: null, offersAwaitingResponse: 0 }) === "buyer_kickoff"
      && inferStrategyMoment({ buyerStage: null, hasActiveListing: false, daysOnMarket: null, offersAwaitingResponse: 0 }) === null)
    const priceTalk = composeStrategySession({
      moment: "price_change", clientName: "Bill", listingAddress: "12 Birch Lane",
      listPrice: 500_000, daysOnMarket: 28, showingCount: 3, offersAwaitingResponse: 0,
      topOfferPrice: null, sellerNetEstimate: null, responseDeadline: null,
      budgetMin: null, budgetMax: null, buyerStage: null, sellerWalkawayPrice: null,
    })
    const kickoff = composeStrategySession({
      moment: "buyer_kickoff", clientName: "Ana", listingAddress: null,
      listPrice: null, daysOnMarket: null, showingCount: null, offersAwaitingResponse: 0,
      topOfferPrice: null, sellerNetEstimate: null, responseDeadline: null,
      budgetMin: 400_000, budgetMax: 550_000, buyerStage: "searching", sellerWalkawayPrice: null,
    })
    check("the AGENDA IS AUTO-PREPARED from the real numbers — the price talk carries the honest 3%/5% dollar options and the DOM/showings read; the kickoff carries the budget range; every session ships a warm invite draft",
      priceTalk.agenda.some((a) => a.includes("$485,000") && a.includes("$475,000"))
      && priceTalk.agenda.some((a) => a.includes("28 days") && a.includes("3 showings"))
      && Boolean(priceTalk.inviteLine.startsWith("Bill,"))
      && kickoff.agenda.some((a) => a.includes("$400,000") && a.includes("$550,000"))
      && kickoff.durationMin === 45)
    const floorSession = composeStrategySession({
      moment: "offer_decision", clientName: "Bill", listingAddress: "12 Birch Lane",
      listPrice: 500_000, daysOnMarket: 10, showingCount: 6, offersAwaitingResponse: 2,
      topOfferPrice: 495_000, sellerNetEstimate: null, responseDeadline: null,
      budgetMin: null, budgetMax: null, buyerStage: null, sellerWalkawayPrice: 480_000,
    })
    check("SELLER WALK-AWAY FLOOR (owner-corrected #35: SELLER-side only, never a buyer gate; l52-s01) — a set floor anchors the offer session ('decided calmly then, not under pressure now'), an unset floor makes SETTING it the agenda item; loader reads it, setter is tenant-gated",
      floorSession.agenda.some((a) => a.includes("$480,000") && a.includes("not under pressure now"))
      && priceTalk.agenda.some((a) => a.includes("presentation refresh"))
      && src("app/actions/strategy-session.ts").includes("seller_walkaway_price")
      && src("app/actions/strategy-session.ts").includes("setSellerFloorAction")
      && src("scripts/l52-s01-seller-floor-coverage.sql").includes("seller_walkaway_price"))
    const { coverageRedirect } = await import("../lib/agents/coverage-mode")
    const now2 = new Date("2026-07-13T12:00:00Z")
    check("COVERAGE MODE (forgotten #12; l52-s01) — active coverage redirects NEW work (pure, one hop, never chained), expired/unset coverage does NOT; enforcement at the assignment engine's single terminal with *_coverage attribution; principal-gated card with 'they're back'; both rails REGISTERED",
      coverageRedirect({ coveringAgentId: "a-2", coverageUntil: "2026-07-20T00:00:00Z" }, now2) === "a-2"
      && coverageRedirect({ coveringAgentId: "a-2", coverageUntil: "2026-07-10T00:00:00Z" }, now2) === null
      && coverageRedirect({ coveringAgentId: null, coverageUntil: "2026-07-20T00:00:00Z" }, now2) === null
      && src("lib/lead-assignment/assignment-engine.ts").includes("redirectForCoverage")
      && src("lib/lead-assignment/assignment-engine.ts").includes("_coverage")
      && src("app/actions/coverage-mode.ts").includes("cannot cover themselves")
      && src("app/dashboard/admin/command-center/coverage-card.tsx").includes("They're back")
      && src("app/components/contact/StrategySessionCard.tsx").includes("Set the floor")
      && src("lib/kernel/manager-registry.ts").includes("seller_walkaway_floor:")
      && src("lib/kernel/manager-registry.ts").includes("coverage_mode:"))
    const { inferOutreachReason, describeOutreachReason, OUTREACH_REASONS } = await import("../lib/kernel/outreach-reasons")
    check("OUTREACH REASON (concierge A.9; l53-s01) — every touch self-justifies: specific families beat generic (a congrats is celebration, not milestone_update), unmatched stays HONESTLY null, flagships pass explicit reasons, the queue shows 'Why now:', and the propose rail back-fills",
      inferOutreachReason({ rationale: "congratulations — their offer was accepted", subject: null }) === "celebration"
      && inferOutreachReason({ rationale: "a warm, brief, no-pressure message to regroup after the rejected offer", subject: null }) === "recovery"
      && inferOutreachReason({ rationale: "quarterly zoning ordinance xyz", subject: null }) === null
      && describeOutreachReason("expectation_reset") === "Expectation reset"
      && OUTREACH_REASONS.length === 8
      && src("lib/agents/agent-client-messages.ts").includes("inferOutreachReason")
      && src("lib/kernel/client-welcome.ts").includes('outreachReason: "welcome"')
      && src("lib/lead-pipeline/offer-rejection-recovery-runner.ts").includes('outreachReason: "recovery"')
      && src("lib/kernel/command-center.ts").includes("Why now:")
      && src("lib/kernel/manager-registry.ts").includes("outreach_reason_tags:"))
    check("COVERAGE-AWARE BRIEFING — while covering, the away agent's aging promises surface in MY briefing at HIGH, labeled '(Covering for X)' with honest options; capped; registered",
      src("lib/intelligence/daily-briefing-generator.ts").includes("(Covering for ")
      && src("lib/intelligence/daily-briefing-generator.ts").includes('.eq("covering_agent_id", myAgentsId)')
      && src("lib/intelligence/daily-briefing-generator.ts").includes("...coverageActions,")
      && src("lib/kernel/manager-registry.ts").includes("coverage_aware_briefing:"))
    const { lintSpamRisk } = await import("../lib/kernel/email-deliverability")
    const spammy = lintSpamRisk("ACT NOW FREE HOMES!!!", "CLICK here now!! 100% free guaranteed returns $$$ http://a http://b http://c http://d")
    check("EMAIL DELIVERABILITY (owner rule, the honest guarantee) — the lint catches ALL-CAPS/trigger-phrases/link-stuffing/$$$ (high risk), passes clean copy (low), rides the approval queue as an advisory, and the go-live board probes REAL SendGrid domain auth (SPF/DKIM)",
      spammy.risk === "high" && spammy.reasons.length >= 4
      && lintSpamRisk("Quick update on your closing", "Hi Bill, the appraisal came back and we are in good shape. I will call you at 3pm with the details. — Dana").risk === "low"
      && src("lib/kernel/command-center.ts").includes("Spam-filter risk")
      && src("lib/platform/go-live-readiness.ts").includes("probeSendgridDomainAuth")
      && src("lib/kernel/manager-registry.ts").includes("email_deliverability_guard:"))
    check("INBOX AI/HUMAN LABELING (§4.1 audit fix) + ISA CALL RUNG (owner directive) — sequence sends stamp sender_type='ai' and the unified inbox badges them; the reactivation ladder ends with the consent-gated AI reconnect call (upgrade path covers existing tenants); DOCUMENTS file by scan-written classification (verdict: labeled+filed)",
      src("lib/workflow/adapters/index.ts").includes('sender_type: "ai"')
      && src("app/components/contact/UnifiedInboxTab.tsx").includes("aiAuthored")
      && src("lib/lead-pipeline/reactivation-sequence-installer.ts").includes('channel: "ai_call"')
      && src("lib/lead-pipeline/reactivation-sequence-installer.ts").includes("listen more than pitch")
      && src("lib/documents/scan-uploaded-document.ts").includes("classification")
      && src("lib/kernel/manager-registry.ts").includes("inbox_ai_labeling:")
      && src("lib/kernel/manager-registry.ts").includes("isa_call_rung:"))
    const { composeSiteInsights } = await import("../lib/kernel/site-traffic-insights")
    const siteRows = [
      ...Array.from({ length: 8 }, () => ({ page: "/home", seconds: 20, source: "google" })),
      ...Array.from({ length: 6 }, () => ({ page: "/neighborhood-guide", seconds: 180, source: "google" })),
    ]
    const si = composeSiteInsights(siteRows)
    check("SITE TRAFFIC LEARNING (owner rule) — the write-only visitor tables now READ BACK: stickiest page found by time-on-page (5+ visit sample gate), ONE concrete adjustment composed ('feature it before they bounce'), weekly GATED notification (nothing auto-mutates), riding proactive-intelligence",
      si.stickiest?.page === "/neighborhood-guide" && si.bounciest?.page === "/home"
      && Boolean(si.adjustment?.includes("/neighborhood-guide")) && Boolean(si.adjustment?.includes("before they bounce"))
      && composeSiteInsights([]).adjustment === null
      && src("app/api/cron/proactive-intelligence/route.ts").includes("runSiteTrafficInsights")
      && src("lib/kernel/site-traffic-insights.ts").includes("rows.length < 10")
      && src("lib/kernel/manager-registry.ts").includes("site_traffic_learning:"))
    const { partyMatchesContact, splitLegalName } = await import("../lib/documents/contact-legal-writeback")
    check("SCAN → CONTACT (owner rule) — verified contract parties fill EMPTY legal names under doc-kernel discipline: the party must plausibly BE the contact ('Bill Chen' never fills from 'Robert Smith'), the legal split preserves middle names, hook 4 rides the scan, and filing (names/linkage/classification) verified by construction",
      partyMatchesContact("William Robert Chen", { firstName: "William", lastName: "Chen" })
      && !partyMatchesContact("Robert Smith Jr", { firstName: "William", lastName: "Chen" })
      && splitLegalName("William Robert Chen", "Chen")?.legalFirst === "William Robert"
      && splitLegalName("William Robert Chen", "Chen")?.legalLast === "Chen"
      && splitLegalName("Chen", "Chen") === null
      && src("lib/documents/scan-uploaded-document.ts").includes("writebackLegalNames")
      && src("lib/documents/contact-legal-writeback.ts").includes("never overwrite")
      && src("lib/documents/upload-document.ts").includes("file_name")
      && src("lib/kernel/manager-registry.ts").includes("scan_contact_writeback:"))
    check("UNIFIED INBOX COMPLETENESS (owner rule) — Meta DMs land messages rows (the ONE timeline table, linked threads surface on the contact), the SendGrid event webhook is secret-gated (unset=404) with exact-id-then-recipient correlation and read-never-downgrades, spam complaints suppress with the EXACT vocabulary reason, sends return providerMessageId, and the chips render read/delivered",
      src("app/api/webhooks/meta-dm/route.ts").includes('type: "social_dm"')
      && src("app/api/webhooks/meta-dm/route.ts").includes('from("messages")')
      && src("app/api/webhooks/sendgrid-events/route.ts").includes("SENDGRID_WEBHOOK_SECRET")
      && src("app/api/webhooks/sendgrid-events/route.ts").includes("sg_message_id")
      && src("app/api/webhooks/sendgrid-events/route.ts").includes('reason: "spam_complaint"')
      && src("lib/providers/messaging/index.ts").includes("providerMessageId")
      && src("app/components/contact/UnifiedInboxTab.tsx").includes('"social_dm"')
      && src("app/components/contact/UnifiedInboxTab.tsx").includes('status === "read"')
      && src("lib/kernel/manager-registry.ts").includes("inbox_social_email_status:"))
    check("SIGNING-ORDER GATE (approved #1) — no e-sign leaves without the confirmed order; the refusal is ACTIONABLE (suggested signers lead with the scan-filled LEGAL name); the wizard prompts inline and one entry point means one gate; inbox/CRM double-check verdicts recorded (Twilio completed SMS/voice — email+social COMPLEMENT; no inbound CRM sync, setup-only rule holds)",
      src("app/actions/buyer-offers.ts").includes("needsSigningOrder")
      && src("app/actions/buyer-offers.ts").includes("legal_first_name")
      && src("app/actions/buyer-offers.ts").includes("confirmSigningOrderAction")
      && src("app/crm/contacts/[contactId]/offers/components/offer-form-wizard.tsx").includes("Confirm signing order & send")
      && src("lib/kernel/manager-registry.ts").includes("signing_order_check:"))
    const { BOOK_TOPICS, BOOK_PROGRAM_TAG } = await import("../lib/education/book-authority-program")
    check("SITE CONVERSION BLOCKS + BUYER NL SEARCH + BOOK PROGRAM (owner directives) — the tenant site gains open-houses/guides/home-evaluation grounded in live tables (empty tenant = clean site, no dead buttons); the buyer's portal gets the SAME NL search engine (keep-one: one engine, three front-ends) logging to the engagement ledger; the four-module book program rides the canonical education rail with the HONEST launch rule (never fake reviews)",
      src("app/site/[slug]/page.tsx").includes("Upcoming open houses")
      && src("app/site/[slug]/page.tsx").includes("Get my home evaluation")
      && src("app/site/[slug]/page.tsx").includes('from("lead_capture_forms")')
      && src("app/actions/portal-nl-search.ts").includes("searchPropertiesCore")
      && src("app/actions/portal-nl-search.ts").includes("nl_property_search")
      && src("app/portal/[contactId]/search/page.tsx").includes("PortalNlSearch")
      && BOOK_TOPICS.length === 4
      && BOOK_PROGRAM_TAG("publish_on_kdp") === "program:book_authority:publish_on_kdp"
      && BOOK_TOPICS.some((t) => t.brief.includes("NEVER purchased or fake reviews"))
      && src("app/api/cron/recruit-outreach/route.ts").includes("runBookAuthorityProgramAll")
      && src("lib/kernel/manager-registry.ts").includes("site_conversion_blocks:")
      && src("lib/kernel/manager-registry.ts").includes("buyer_nl_search:")
      && src("lib/kernel/manager-registry.ts").includes("book_authority_program:"))
    check("EDUCATION DEPTH MANDATE (owner rule: in-depth for every experience level, never summaries) — the schema REQUIRES a full per-lesson WALKTHROUGH (define every term, forms section by section, verbatim scripts, advanced notes for veterans), both authors demand depth with 6000-token budgets, the body renders walkthrough + takeaways, and the owner-named CORE topics exist (contract section-by-section + running the business); ACADEMY IS NOT PARALLEL (verdict: one learning_modules rail — academy = agent surface, portal /learn = client surface)",
      src("lib/education/curriculum-author.ts").includes("walkthrough: z.string()")
      && src("lib/education/curriculum-author.ts").includes("SECTION BY SECTION")
      && src("lib/education/curriculum-author.ts").includes("maxTokens: 6000")
      && src("lib/education/onboarding-authoring.ts").includes("maxTokens: 6000")
      && src("lib/education/curriculum-author.ts").includes("l.walkthrough")
      && src("lib/education/onboarding-curriculum.ts").includes('key: "contract_walkthrough"')
      && src("lib/education/onboarding-curriculum.ts").includes('key: "business_operating_rhythm"')
      && src("app/actions/academy-learning.ts").includes('from("learning_modules")'))
    check("BOOK PROGRAM CORRECTIONS (owner) — per-brokerage = the COURSE (each agent's book is their own, in their voice); the writing module is voice-preservation technique ('restructure, never rewrite', the read-aloud test, stripping AI tells); niche-driven, no market-data framing",
      src("lib/education/book-authority-program.ts").includes("what authors ONCE PER BROKERAGE")
      && src("lib/education/book-authority-program.ts").includes("restructure, never rewrite")
      && src("lib/education/book-authority-program.ts").includes("read-aloud test")
      && src("lib/education/book-authority-program.ts").includes("no market-data dump required")
      && !src("lib/education/book-authority-program.ts").includes("market updates, and blog posts"))
    check("VENDOR TRANSACTION EDITS (owner rule: 'any vendor that is part of the transaction should be able to make edits/update to their owned area') — clear-to-close/loan-status/title-status/earnest+survey checklist all ride vendor-authorized rails, and the ONE dead end is closed: submitLoanConditions now AUTHORIZES via requireLenderVendorActor and closes the loop on fresh conditions (ledger event + the agent's collection task + a GATED buyer draft, never lender→buyer raw); registered to deal_coordinator",
      src("app/actions/lender-portal-actions.ts").includes("requireLenderVendorActor")
      && src("app/actions/title-portal.ts").includes("requireTitleActor")
      && src("app/actions/title-portal.ts").includes("updateClosingPrepItem")
      && src("app/actions/multi-persona.ts").includes("requireLenderVendorActor")
      && src("app/actions/multi-persona.ts").includes('"lender_document_request"')
      && src("app/actions/multi-persona.ts").includes('source: "lender_condition"')
      && src("app/actions/multi-persona.ts").includes('outreachReason: "decision_required"')
      && src("lib/kernel/manager-registry.ts").includes("lender_condition_loop:"))
    const { validateVendorRequest, composeVendorRequestTask, clientPartyForRequest, composeClientRequestBody } = await import("../lib/kernel/vendor-request")
    const vrBad = validateVendorRequest({ requestType: "demand", details: "utilities on please and the gate code" })
    const vrThin = validateVendorRequest({ requestType: "access", details: "keys" })
    const vrOk = validateVendorRequest({ requestType: "access", details: "Need utilities on and the lockbox code for Thursday inspection" })
    const vrTask = composeVendorRequestTask({ vendorName: "Apex Inspections", vendorCategory: "Inspector", requestType: "access", details: "Need utilities on and the lockbox code", propertyAddress: "12 Oak Ln", neededBy: "2026-07-16" })
    const vrBody = composeClientRequestBody({ vendorName: "Apex Inspections", vendorCategory: "Inspector", requestType: "access", details: "utilities on for Thursday", neededBy: null })
    check("VENDOR REQUEST RAIL (owner rule generalized) — typed vocabulary with honest refusals (unknown type + too-thin details both refused with the WHY), the agent's task names who/what/where/by-when, property-side asks route to the OCCUPANT while paperwork asks route to the buyer (gated either way), and the client draft is warm + vendor-attributed; auth mirrors the lender gate and the jobs surface carries the dialog; registered to deal_coordinator",
      vrBad.ok === false && Boolean(!vrBad.ok && vrBad.error.includes("document"))
      && vrThin.ok === false
      && vrOk.ok === true
      && vrTask.title === "Property access — Apex Inspections"
      && vrTask.description.includes("Apex Inspections (Inspector)") && vrTask.description.includes("on 12 Oak Ln") && vrTask.description.includes("Needed by 2026-07-16")
      && clientPartyForRequest("access", { contact_id: "seller-1", buyer_contact_id: "buyer-1" }) === "seller-1"
      && clientPartyForRequest("document", { contact_id: "seller-1", buyer_contact_id: "buyer-1" }) === "buyer-1"
      && clientPartyForRequest("access", { contact_id: null, buyer_contact_id: "buyer-1" }) === "buyer-1"
      && vrBody.subject === "Quick request from your inspector" && vrBody.body.includes("Apex Inspections")
      && src("app/actions/vendor-requests.ts").includes("requireVendorActor")
      && src("app/actions/vendor-requests.ts").includes('"vendor_request"')
      && src("app/actions/vendor-requests.ts").includes("proposeClientMessage")
      && src("app/vendor/jobs/jobs-client.tsx").includes("VendorRequestDialog")
      && src("lib/kernel/manager-registry.ts").includes("vendor_request_rail:"))
    check("BUYER LOAN-CONDITION VISIBILITY — the buyer's read-only checklist is PARTY-ANCHORED, grounded in the SAME transaction_lenders row the lender writes (one rail), honest-null when nothing real to show, and rides the portal deal view; registered to deal_coordinator",
      src("app/actions/portal-loan-checklist.ts").includes("buyer_contact_id")
      && src("app/actions/portal-loan-checklist.ts").includes('from("transaction_lenders")')
      && src("app/actions/portal-loan-checklist.ts").includes("return null")
      && src("app/portal/[contactId]/transaction/[transactionId]/page.tsx").includes("LoanChecklistCard")
      && src("app/portal/[contactId]/transaction/[transactionId]/loan-checklist-card.tsx").includes("Clear to close")
      && src("lib/kernel/manager-registry.ts").includes("buyer_loan_visibility:"))
    check("PRODUCTION AUDIT — DEAD BUTTONS WIRED, FABRICATION KILLED: the portal's offer Accept/Counter/Decline record a party-anchored DECISION SIGNAL for the agent to execute (never a legal act), the document viewer's Sign requests the real envelope, lender queues route to the AUTHORIZED loan file, and the onboarding e-sign mock now REFUSES honestly (no fake envelope id, no false 'sent') — both registered",
      src("app/actions/portal-offer-decision.ts").includes('source: "client_offer_decision"')
      && src("app/actions/portal-offer-decision.ts").includes("not a party to this offer")
      && src("app/components/portal/offer-decision-buttons.tsx").includes("nothing is final until the paperwork is signed")
      && src("app/portal/[contactId]/offers/page.tsx").includes("OfferDecisionButtons")
      && src("app/portal/[contactId]/my-offer/page.tsx").includes("OfferDecisionButtons")
      && src("app/actions/portal-document-requests.ts").includes("loadActiveSignaturePacket")
      && src("app/portal/[contactId]/documents/[documentId]/page.tsx").includes("loadActiveSignaturePacket")
      && src("app/lender/approvals/page.tsx").includes("/portal/lender/")
      && src("app/lender/underwriting/page.tsx").includes("/portal/lender/")
      && src("app/vendor/portfolio/page.tsx").includes("/vendor/portfolio/upload")
      && !src("app/actions/onboarding/license.ts").includes("mock_${provider.providerKey}")
      && src("app/actions/onboarding/license.ts").includes("refuse to simulate")
      && src("lib/kernel/manager-registry.ts").includes("client_offer_decision:")
      && src("lib/kernel/manager-registry.ts").includes("esign_honest_refusal:"))
    check("PACKET-GATED SIGNING (owner rule) — the Sign button renders ONLY on an ACTIVE packet and routes to the invite: l54-s01 gives signing_url a home on both packet tables, the portal loader filters completed/expired and party-anchors, the onboarding ICA card links 'Sign Contract Now' off the contract packet's URL, the esign adapter RECORDS the packet on every send with the client_documents FK guarded, and the users→agents key mismatch (contract_signatures.agent_id FKs AGENTS) is resolved — both registered; the interim ready-to-sign signal is fully retired",
      src("app/actions/portal-document-requests.ts").includes('.is("completed_at", null)')
      && src("app/actions/portal-document-requests.ts").includes("document_id.is.null")
      && src("app/actions/portal-document-requests.ts").includes("anchored.length === 1")
      && !src("app/actions/portal-document-requests.ts").includes("requestSignatureSend")
      && src("app/portal/[contactId]/documents/[documentId]/page.tsx").includes("signaturePacket.signingUrl")
      && src("app/dashboard/onboarding/license/license-intake-client.tsx").includes("Sign Contract Now")
      && src("app/dashboard/onboarding/license/license-intake-client.tsx").includes("signing_url")
      && src("app/actions/onboarding/license.ts").includes('.eq("user_id", agentId)')
      && src("app/actions/onboarding/license.ts").includes("signing_url")
      && src("lib/workflow/adapters/send-for-esign.ts").includes("recordSignaturePacket")
      && src("lib/workflow/adapters/send-for-esign.ts").includes('from("client_documents")')
      && src("scripts/l54-s01-signing-url-on-packets.sql").includes("signing_url")
      && src("lib/kernel/manager-registry.ts").includes("packet_gated_signing:"))
    const { CLIENT_DECISION_SOURCES } = await import("../lib/kernel/command-center")
    check("CLIENT-DECISIONS TILE + VENDOR BOOKING VOCABULARY (pilot-simulation catches) — the decision-signal tasks lead the Command Center (typed source registry, oldest first, egress-scoped) and the vendor accept/decline flow now speaks the LIVE CHECK vocabulary (gate 'booked' → write 'confirmed'; the old 'pending'→'scheduled' pair could never exist/always threw); both registered",
      CLIENT_DECISION_SOURCES.length === 3
      && (CLIENT_DECISION_SOURCES as readonly string[]).includes("client_offer_decision")
      && src("lib/kernel/command-center.ts").includes("clientDecisions")
      && src("lib/kernel/command-center.ts").includes('.order("created_at", { ascending: true })')
      && src("app/dashboard/admin/command-center/command-center-client.tsx").includes("Client decisions awaiting you")
      && src("app/actions/vendor-portal.ts").includes('booking.status !== "booked"')
      && src("app/actions/vendor-portal.ts").includes('status: "confirmed"')
      && !src("app/actions/vendor-portal.ts").includes('status: "scheduled"')
      && src("app/vendor/jobs/jobs-client.tsx").includes('b.status === "booked"')
      && src("lib/kernel/manager-registry.ts").includes("client_decisions_tile:")
      && src("lib/kernel/manager-registry.ts").includes("vendor_booking_vocabulary:"))
    const { isDecisionBreach, isStuckBooking, auditTag, DECISION_BREACH_HOURS } = await import("../lib/kernel/os-self-audit")
    const nowT = new Date("2026-07-14T12:00:00Z")
    check("E-SIGN PACKET COMPLETION + OS SELF-AUDIT + DEMO HARD GATE (production week) — the universal webhook rail now COMPLETES both packet tables on envelope-signed (l54-s02 linkage, both writers stamp the ref, dotloop also completes by document linkage, is-null idempotent); the self-audit watches decision-latency breaches (48h pure gate, undated never counts) + pre-accept booking limbo with one-tag-forever dedupe on the deal-health cron; demo login can NEVER enable on production; all three registered",
      isDecisionBreach({ status: "pending", created_at: "2026-07-11T12:00:00Z" }, nowT) === true
      && isDecisionBreach({ status: "pending", created_at: "2026-07-14T02:00:00Z" }, nowT) === false
      && isDecisionBreach({ status: "completed", created_at: "2026-07-01T00:00:00Z" }, nowT) === false
      && isDecisionBreach({ status: "pending", created_at: null }, nowT) === false
      && isStuckBooking({ status: "booked", created_at: "2026-07-01T00:00:00Z" }, nowT) === true
      && isStuckBooking({ status: "confirmed", created_at: "2026-07-01T00:00:00Z" }, nowT) === false
      && auditTag("decision_breach", "t-1") === "[OS_AUDIT:decision_breach] [t-1]"
      && DECISION_BREACH_HOURS === 48
      && src("lib/esign-webhooks/finalize-packet.ts").includes('request_status: "completed"')
      && src("lib/esign-webhooks/finalize-packet.ts").includes('esign_status: "fully_signed"')
      && !src("lib/esign-webhooks/finalize-packet.ts").includes('esign_status: "signed"')
      && src("app/dashboard/onboarding/license/license-intake-client.tsx").includes('"fully_signed"')
      && !src("app/dashboard/onboarding/license/license-intake-client.tsx").includes('=== "signed"')
      && src("lib/esign-webhooks/finalize-packet.ts").includes('.eq("provider_envelope_id", envelopeId)')
      && src("lib/esign-webhooks/finalize-packet.ts").includes('.is("completed_at", null)')
      && src("app/api/webhooks/dotloop/route.ts").includes('request_status: "completed"')
      && src("app/actions/dotloop-integration.ts").includes("provider_envelope_id: data.loopId")
      && src("lib/workflow/adapters/send-for-esign.ts").includes("provider_envelope_id: p.envelopeId")
      && src("scripts/l54-s02-packet-envelope-ref.sql").includes("provider_envelope_id")
      && src("app/api/cron/deal-health-scan/route.ts").includes("runOsSelfAudit")
      && src("app/constants/auth.ts").includes("VERCEL_ENV !== 'production'")
      && src("lib/kernel/manager-registry.ts").includes("esign_packet_completion:")
      && src("lib/kernel/manager-registry.ts").includes("os_self_audit:")
      && src("lib/kernel/manager-registry.ts").includes("demo_login_hard_gate:"))
    const { isShallowBody, recoverTopicForModule, DEPTH_MARKER } = await import("../lib/education/depth-reauthor")
    const reOnb = await recoverTopicForModule({ id: "m1", title: "old", summary: null, gap_tags: ["onboarding:solo_agent:contract_walkthrough"], audience_roles: ["agent"] }, "team")
    const reBook = await recoverTopicForModule({ id: "m2", title: "old", summary: null, gap_tags: ["program:book_authority:write_with_ai_team"], audience_roles: ["agent"] }, "solo_agent")
    const reGap = await recoverTopicForModule({ id: "m3", title: "Handling the zestimate objection", summary: "Sellers anchor on the Zestimate.", gap_tags: ["objection:zestimate"], audience_roles: ["agent"] }, "brokerage")
    const reNone = await recoverTopicForModule({ id: "m4", title: "  ", summary: null, gap_tags: [], audience_roles: null }, "solo_agent")
    check("DEPTH RE-AUTHOR SWEEP (owner rule extends BACKWARD) — a pre-upgrade module is recognized STRUCTURALLY (no '**Key takeaways**' walkthrough marker); topic recovery is honest+pure (onboarding tag → canonical syllabus entry, book tag → BOOK_TOPICS, gap tag → the module's OWN title/summary, nothing real → skip); the rewrite is gated pending_review, marker-terminated, and rides the weekly cron; registered to recruiting_manager",
      isShallowBody("Just a two-line summary.") === true
      && isShallowBody(`## Lesson\n\nfull walkthrough…\n\n${DEPTH_MARKER}\n- point`) === false
      && reOnb?.topic.key === "contract_walkthrough" && reOnb?.tier === "solo_agent"
      && reBook?.topic.key === "write_with_ai_team"
      && reGap?.topic.label === "Handling the zestimate objection"
      && Boolean(reGap?.topic.brief.includes("Sellers anchor on the Zestimate"))
      && Boolean(reGap?.topic.brief.includes("SECTION BY SECTION"))
      && reNone === null
      && src("lib/education/depth-reauthor.ts").includes('status: "pending_review"')
      && src("app/api/cron/recruit-outreach/route.ts").includes("runDepthReauthorAll")
      && src("lib/kernel/manager-registry.ts").includes("education_depth_reauthor:"))
    check("the session flow is complete IN-WINDOW — access-gated action grounds facts in listings/offers (responded_at-null = on the table), the card rides the contact page, confirm creates the agenda-carrying task; the PRE-CALL BRIEF now leads with the addressing memory",
      src("app/actions/strategy-session.ts").includes("assertCanActOnContact")
      && src("app/actions/strategy-session.ts").includes('.is("responded_at", null)')
      && src("app/actions/strategy-session.ts").includes('source: "strategy_session"')
      && src("app/crm/contacts/[contactId]/page.tsx").includes("StrategySessionCard")
      && src("lib/contacts/contact-brief.ts").includes("resolveAddressing")
      && src("lib/contacts/contact-brief.ts").includes("Call them"))
    check("NOT-NULL assignee contract (live catch): both task-creating concierge actions resolve the contact's agent → caller's agents row → HONEST refusal, never a broken insert",
      src("app/actions/strategy-session.ts").includes("No agent to assign")
      && src("app/actions/gift-studio.ts").includes("No agent to assign"))
    const { composeSmallWinActions, CELEBRATIONS_OWNED_ELSEWHERE } = await import("../lib/intelligence/small-wins")
    const winActions = composeSmallWinActions([
      { contactId: "c-1", addressAs: "Bill", eventType: "offer.accepted" },
      { contactId: "c-1", addressAs: "Bill", eventType: "transaction.under_contract" },
      { contactId: "c-2", addressAs: "Ana", eventType: "transaction.closed" },
      { contactId: "c-3", addressAs: "Maya", eventType: "financing.cleared" },
    ])
    check("SMALL-WINS CELEBRATION (concierge #20) — mid-deal wins earn a drafted congrats + Gift Studio pointer; ONE win per contact; closing/anniversary are OWNED ELSEWHERE (Gift Studio queue / anniversary rail) so nothing double-nudges",
      winActions.length === 2 && winActions[0]?.entity_id === "c-1"
      && Boolean(winActions[0]?.context.includes("their offer just got accepted")) && Boolean(winActions[0]?.context.includes("Gift Studio"))
      && winActions.every((a) => a.entity_id !== "c-2")
      && CELEBRATIONS_OWNED_ELSEWHERE.has("transaction.closed") && CELEBRATIONS_OWNED_ELSEWHERE.has("lifetime.anniversary")
      && winActions[0]?.manager === "shopping_agent" && winActions[1]?.manager === "deal_coordinator")
    check("small wins ride the SAME deterministic briefing rail (projector's portal_event_stream, severity 'celebration', tolerant users.id/agents.id resolution) and EVERY session-built concierge rail is REGISTERED to its manager in MAINTENANCE_DOMAINS",
      src("lib/intelligence/daily-briefing-generator.ts").includes('from("portal_event_stream")')
      && src("lib/intelligence/daily-briefing-generator.ts").includes('.eq("severity", "celebration")')
      && src("lib/intelligence/daily-briefing-generator.ts").includes("...smallWinActions")
      && src("lib/kernel/manager-registry.ts").includes("gift_studio:")
      && src("lib/kernel/manager-registry.ts").includes("addressing_memory:")
      && src("lib/kernel/manager-registry.ts").includes("i_saw_you_recognition:")
      && src("lib/kernel/manager-registry.ts").includes("strategy_sessions:"))
  }

  console.log("\n[23 · pure + wiring — TENANT CONCIERGE (QBR, pulse, expansion, check-ins) + client welcome & social proof]")
  {
    const { composeQuarterlyReview } = await import("../lib/intelligence/quarterly-review")
    const { decideExpansionSuggestion } = await import("../lib/platform/expansion-advisor")
    const richQ = composeQuarterlyReview({
      windowLabel: "Apr 14 – Jul 13", planTier: "solo_agent",
      closedDeals: 3, closedVolume: 1_450_000, activeDeals: 4, newContacts: 22,
      approvals: 31, autonomousActs: 6, grantsHeld: 2, conflictsCaught: 1,
      giftsOrdered: 2, briefingsOpened: 40, unusedRails: [], trustIncidents: 0,
      expansion: decideExpansionSuggestion({ planTier: "solo_agent", activeAgents: 3, locations: 1 }),
    })
    const emptyQ = composeQuarterlyReview({
      windowLabel: "Apr 14 – Jul 13", planTier: "team",
      closedDeals: 0, closedVolume: 0, activeDeals: 1, newContacts: 0,
      approvals: 0, autonomousActs: 0, grantsHeld: 0, conflictsCaught: 0,
      giftsOrdered: 0, briefingsOpened: 0,
      unusedRails: ["Social publishing isn't connected — the cadence engine is idle."],
      trustIncidents: 5,
      expansion: null,
    })
    check("QBR (tenant #32) — outcomes carry the real volume, trust carries grants+acts+conflicts, and the EXPANSION ADVISOR (#35) lands INSIDE the review grounded in agent count (3 actives on solo → team), never as upsell spam",
      richQ.outcomes.some((o) => o.includes("$1,450,000")) && richQ.trust.some((t) => t.includes("2 standing autonomy grant"))
      && richQ.nextMoves.some((n) => n.includes("team plan") && n.includes("3 active agents"))
      && decideExpansionSuggestion({ planTier: "team", activeAgents: 4, locations: 1 }) === null)
    check("QBR honest degradation — a zero quarter SHOWS its zeros with the unblocking step (approval queue named, unread briefing named), never dressed up",
      emptyQ.outcomes.some((o) => o.includes("No closings")) && emptyQ.trust.some((t) => t.includes("approval queue"))
      && emptyQ.gaps.some((g) => g.includes("briefing went unread")) && emptyQ.gaps.some((g) => g.includes("cadence engine")))
    check("TRUST-INCIDENT LEDGER READ + DRIFT REVIEW (forgotten #47 + #50) — incidents are READ from ledgers other rails already write (failed sends, shaky flags, major walkthroughs, automation errors); zero = 'the standard held', >3 triggers the service-standard drift review as a QBR next move",
      richQ.trust.some((t) => t.includes("Zero trust incidents"))
      && emptyQ.trust.some((t) => t.includes("5 trust incidents"))
      && emptyQ.nextMoves.some((n) => n.includes("service-standard drift review") && n.includes("still feel like concierge"))
      && src("lib/intelligence/quarterly-review-loader.ts").includes('eq("event_type", "deal_marked_shaky")')
      && src("lib/intelligence/quarterly-review-loader.ts").includes('eq("metadata->>outcome", "major_issues")')
      && src("lib/kernel/manager-registry.ts").includes("trust_incident_drift_review:"))
    const { rankNeedsHelp, PULSE_MIN_SCORE } = await import("../lib/intelligence/adoption-pulse")
    const pulse = rankNeedsHelp([
      { agentId: "a1", name: "Sam", overdueTasks: 4, staleContacts: 3, activities14d: 0, briefingOpened14d: false },
      { agentId: "a2", name: "Lee", overdueTasks: 0, staleContacts: 0, activities14d: 9, briefingOpened14d: true },
      { agentId: "a3", name: "Kim", overdueTasks: 1, staleContacts: 1, activities14d: 5, briefingOpened14d: true },
    ])
    check("ADOPTION PULSE (tenant #23/#31) — the struggling agent ranks with COACHABLE REASONS, the healthy agent NEVER appears (care, not surveillance), the borderline stays under threshold",
      pulse.length === 1 && pulse[0]?.agentId === "a1"
      && pulse[0]!.reasons.some((r) => r.includes("no logged activity"))
      && PULSE_MIN_SCORE >= 3
      && src("app/dashboard/admin/command-center/page.tsx").includes("QuarterlyReviewCard"))
    const { checkInWindow, composeCheckIn } = await import("../lib/onboarding/checkin-cadence")
    const now = new Date("2026-07-13T12:00:00Z")
    check("TENANT CHECK-INS (tenant #8) — day 7 → week_one, day 30 → month_one, day 90 → quarter_one, day 50 → honest null; copy is honest about live vs stalled; rides the EXISTING onboarding-reminders cron",
      checkInWindow(new Date(now.getTime() - 7 * 86_400_000).toISOString(), now) === "week_one"
      && checkInWindow(new Date(now.getTime() - 30 * 86_400_000).toISOString(), now) === "month_one"
      && checkInWindow(new Date(now.getTime() - 90 * 86_400_000).toISOString(), now) === "quarter_one"
      && checkInWindow(new Date(now.getTime() - 50 * 86_400_000).toISOString(), now) === null
      && composeCheckIn("week_one", { live: [], stalled: ["no contacts imported yet"] }).body.includes("one approval away")
      && src("app/api/cron/onboarding-reminders/route.ts").includes("runTenantCheckIns")
      && src("lib/onboarding/checkin-cadence.ts").includes('priority: "medium"'))
    const { composeClientWelcome } = await import("../lib/kernel/client-welcome")
    const welcome = composeClientWelcome({ side: "buyer", addressAs: "Bill", agentName: "Dana Reed" })
    check("CLIENT WELCOME (client #1–2) — the warm intro + numbered journey map + the here's-what's-next promise, addressed by preferred name; proposed as ONE gated draft on the canonical rail from BOTH capture paths",
      welcome.body.startsWith("Bill, welcome") && welcome.body.includes("1. ") && welcome.body.includes("here's what's next")
      && src("lib/kernel/client-welcome.ts").includes("proposeClientMessage")
      && (src("lib/contact-pipeline/contact-capture.ts").match(/ensureClientWelcome/g) ?? []).length >= 2)
    const { mineClientConcern, pickSocialProof } = await import("../lib/kernel/social-proof")
    check("SOCIAL PROOF (client #25) — the concern is mined word-boundary honest, only a PUBLISHED high-rated review that GENUINELY speaks to it qualifies, and zero matches = honest null (a fabricated quote is impossible)",
      mineClientConcern("I'm nervous, this is our first home") === "first_time"
      && mineClientConcern("what's on tv tonight") === null
      && pickSocialProof("first_time", [{ reviewText: "She walked us through every step of our first purchase — so patient.", rating: 5, reviewerName: "The Ortiz Family" }])
        === `The Ortiz Family (verified review): "She walked us through every step of our first purchase — so patient."`
      && pickSocialProof("first_time", [{ reviewText: "Great!", rating: 5, reviewerName: "A" }]) === null
      && src("app/api/portal/ai-chat/route.ts").includes("pickSocialProof")
      && src("app/api/portal/ai-chat/route.ts").includes("quote VERBATIM only"))
    check("ALL SIX new rails are REGISTERED to their managers (finance: QBR+expansion; recruiting: pulse+check-ins; shopping: welcome; marketing: social proof)",
      src("lib/kernel/manager-registry.ts").includes("quarterly_business_review:")
      && src("lib/kernel/manager-registry.ts").includes("leader_adoption_pulse:")
      && src("lib/kernel/manager-registry.ts").includes("tenant_checkin_cadence:")
      && src("lib/kernel/manager-registry.ts").includes("client_welcome_sequence:")
      && src("lib/kernel/manager-registry.ts").includes("concern_matched_social_proof:"))
    check("WELCOME CONTENT IS NEVER HARDCODED (owner rule) — production routes through generatePersonaCopy with the deterministic journey map as the FACT SET and the guaranteed fallback",
      src("lib/kernel/client-welcome.ts").includes("generatePersonaCopy")
      && src("lib/kernel/client-welcome.ts").includes("{ body: fallback.body }")
      && src("lib/kernel/client-welcome.ts").includes("Journey step"))
    const { classifyCardTarget } = await import("../lib/contacts/card-classifier")
    check("BUSINESS CARD → VENDOR (owner directive) — an inspector's card routes to the VENDOR book with the live CHECK category, a blank card defaults to the human-reviewed contact path; the action creates a PENDING vendors row and keeps company/title (previously dropped)",
      classifyCardTarget({ title: "Senior Home Inspector", company: "Acme Inspections LLC" }).target === "vendor"
      && classifyCardTarget({ title: "Senior Home Inspector", company: "Acme Inspections LLC" }).category === "Inspector"
      && classifyCardTarget({ title: "Loan Officer NMLS 12345", company: null }).category === "Lender"
      && classifyCardTarget({ title: null, company: null }).target === "contact"
      && src("app/actions/business-card/business-card-actions.ts").includes('status: "pending"')
      && src("app/actions/business-card/business-card-actions.ts").includes("classifyCardTarget")
      && src("app/actions/business-card/business-card-actions.ts").includes("From their card:"))
    const { composeLocalLifestyle } = await import("../lib/kernel/local-lifestyle")
    const nearby = composeLocalLifestyle([
      { name: "Maple Park", category: "leisure.park", distanceMeters: 600 },
      { name: "Franklin Elementary", category: "education.school", distanceMeters: 2200 },
      { name: "Blue Door Cafe", category: "catering.cafe", distanceMeters: 900 },
    ])
    check("LOCAL LIFESTYLE (client #30, Geoapify/OSM) — REAL places group closest-first with walkability notes, zero places = honest null; provider-gated with a hard timeout; the chat rule forbids inventing amenities or characterizing school QUALITY",
      Boolean(nearby?.includes("Maple Park (walkable)")) && Boolean(nearby?.includes("Franklin Elementary (~1.4 mi)"))
      && composeLocalLifestyle([]) === null
      && src("lib/external/geoapify-client.ts").includes("GEOAPIFY_API_KEY")
      && src("app/api/portal/ai-chat/route.ts").includes("never characterize school QUALITY")
      && src("lib/kernel/manager-registry.ts").includes("card_vendor_routing:")
      && src("lib/kernel/manager-registry.ts").includes("local_lifestyle_poi:"))
    check("CARD TRIAGE IS THREE-WAY (owner rule: 'other agents are users') — a realtor's card routes to the RECRUITING pipeline (status 'prospect', live CHECK), never the client CRM; the QBR has a SPOKEN TWIN on the same loader (keep-one), principal-gated by voice too",
      classifyCardTarget({ title: "Realtor", company: "Sunrise Realty" }).target === "recruit"
      && src("app/actions/business-card/business-card-actions.ts").includes('from("recruits")')
      && src("app/actions/business-card/business-card-actions.ts").includes('status: "prospect"')
      && src("lib/voice/team-command-names.ts").includes('"quarterly_review"')
      && src("lib/voice/team-commands.ts").includes("loadQuarterlyReview")
      && src("lib/voice/team-commands.ts").includes("isTenancyPrincipal")
      && src("app/actions/quarterly-review.ts").includes("quarterly-review-loader"))
    const { composeServiceRecovery, composeRecoveryActions } = await import("../lib/kernel/service-recovery")
    const rec = composeRecoveryActions([
      { contactId: "c-1", addressAs: "Bill", subject: "Your update", sendError: "bounce" },
      { contactId: "c-1", addressAs: "Bill", subject: "dup", sendError: "bounce" },
    ])
    check("SERVICE RECOVERY — distinct apology per failure type (vendor no-show ≠ system hiccup), failed sends LEAD the briefing at HIGH priority with the recovery drafted, one per contact",
      composeServiceRecovery("vendor_no_show", "Ana").draft.includes("didn't show")
      && composeServiceRecovery("system_outage", "Ana").draft.includes("hiccuped")
      && rec.length === 1 && rec[0]?.priority === "high" && Boolean(rec[0]?.context.includes("Bill, A message we meant to send"))
      && src("lib/intelligence/daily-briefing-generator.ts").includes("...recoveryActions,")
      && src("lib/intelligence/daily-briefing-generator.ts").includes('.not("send_error", "is", null)'))
    check("DEAL-SHAKY + ACTING-AS + VENDOR EXPIRY are enforced, ledgered, and manager-owned — shaky suspends grants IN the deriver, assumed views land on the ledger, whole-vendor expiry gates the vendor read; all five registered",
      src("lib/documents/deadline-derivation.ts").includes("deal_shaky") && src("lib/documents/deadline-derivation.ts").includes("grants = new Set()")
      && src("app/transactions/[transactionId]/page.tsx").includes("DealShakyToggle")
      && src("app/actions/deal-shaky.ts").includes("deal_marked_shaky")
      && src("app/dashboard/admin/command-center/page.tsx").includes("acting_as_view")
      && src("app/actions/vendor-contact-access.ts").includes("access_expires_at")
      && src("lib/kernel/manager-registry.ts").includes("deal_shaky_flag:")
      && src("lib/kernel/manager-registry.ts").includes("service_recovery:")
      && src("lib/kernel/manager-registry.ts").includes("card_recruit_routing:")
      && src("lib/kernel/manager-registry.ts").includes("acting_as_audit:")
      && src("lib/kernel/manager-registry.ts").includes("vendor_access_expiry:"))
    check("LAST PROMISE MADE (concierge A.3; l50-s01) — one first-class field, tracked on the contact card, PREFERRED by the shared team note over the legacy metadata cue, and the briefing's aging guard surfaces a 3d+ open promise HIGH ('the OS will not let it silently age out')",
      src("app/actions/contacts/last-promise.ts").includes("last_promise_at")
      && src("app/crm/contacts/[contactId]/page.tsx").includes("LastPromiseCard")
      && src("lib/kernel/conversation-memory.ts").includes("last_promise")
      && src("lib/intelligence/daily-briefing-generator.ts").includes("Keep your promise to")
      && src("lib/intelligence/daily-briefing-generator.ts").includes("...promiseActions,")
      && src("scripts/l50-s01-last-promise.sql").includes("last_promise"))
    check("ACTING-AS is VISIBLE governance — the Command Center renders the assumed-view log (honest empty state), and card-scanned agent prospects surface in the recruiting hub BY CONSTRUCTION (it reads the recruits table the scanner writes)",
      src("app/dashboard/admin/command-center/acting-as-log.tsx").includes("Assumed views")
      && src("app/dashboard/admin/command-center/page.tsx").includes("ActingAsLog")
      && src("app/admin/recruiting-hub/page.tsx").includes('from("recruits")'))
    const { composeWalkthroughFollowUp } = await import("../lib/transactions/walkthrough-outcome")
    const wtGood = composeWalkthroughFollowUp("all_good", "Bill")
    const wtMajor = composeWalkthroughFollowUp("major_issues", "Bill")
    check("WALKTHROUGH OUTCOME (forgotten #38) — three DIFFERENT processes: all-good confirms logistics (no shaky), major issues acknowledge-first + same-day huddle + the deal AUTO-FLAGS SHAKY (autonomy suspends); buttons ride the deal file; registered to deal_coordinator",
      !wtGood.flagShaky && wtGood.agentTasks[0]!.title.includes("closing logistics")
      && wtMajor.flagShaky && wtMajor.clientLine.includes("own that with you")
      && wtMajor.agentTasks.some((t) => t.title.includes("TODAY"))
      && composeWalkthroughFollowUp("minor_issues", "Ana").clientLine.includes("normal at this stage")
      && src("app/transactions/[transactionId]/page.tsx").includes("WalkthroughOutcomeButtons")
      && src("lib/transactions/walkthrough-outcome.ts").includes('update({ deal_shaky: true })')
      && src("lib/kernel/manager-registry.ts").includes("walkthrough_outcome:"))
  }

  console.log("\n[24 · live — the full derivation against the real database]")
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
