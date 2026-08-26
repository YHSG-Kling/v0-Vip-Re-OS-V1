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
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
// The ONE correct scanner (CLAUDE.md §2 — never hand-roll a comment stripper).
// Needed because an absence assertion below hunts for a code pattern that this
// file's own explanatory comment necessarily QUOTES; scanning raw source would
// match the prose describing the defect and report the defect as still present.
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
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

// TOMBSTONE (orphan doctrine §1.1) — this file carried SEVEN private readdirSync
// walkers (walkDemo, walkSecret, walk, walk13, walk9, walk3, walk2), one per pass, each a
// copy of the same recursion. The survivor is scripts/runtime-roots.ts:61
// (`walkTs`), imported above; they are replaced by the single corpus below.
//
// Seven copies meant seven chances to be wrong in the same way, and they all were:
// each enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` — the Next 16 edge middleware, which gates auth and queries four
// tables with a SERVICE client on EVERY request — was in none of their corpora.
// Every pass that swept "app/ and lib/" for a forbidden shape reported green over
// a file it had never opened, and the demo-roster and public-bearer sweeps below
// are precisely the kind that should be reading the auth gate.
const REPO_TS_FILES: string[] = [
  ...walkTs(join(ROOT, "app")),
  ...walkTs(join(ROOT, "lib")),
  ...rootRuntimeFiles(ROOT),
].map((f) => f.slice(ROOT.length + 1))
/** Text of each `.from("<table>")` chain, cut at the next `.from(` — so an
 *  assertion about one table cannot be tripped by a sibling table's query in the
 *  same file. */
function fromWindows(text: string, table: string): string[] {
  const out: string[] = []
  const needle = `.from("${table}")`
  let i = text.indexOf(needle)
  while (i !== -1) {
    const rest = text.slice(i + needle.length)
    const next = rest.search(/\.from\(/)
    out.push(next >= 0 ? rest.slice(0, next) : rest.slice(0, 1500))
    i = text.indexOf(needle, i + 1)
  }
  return out
}

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
      && netSheetConfidence({ commissionRate: "template", mortgagePayoff: "confirmed", countyCityTaxes: "public_record", hoaDuesProration: "confirmed", otherProratedFees: "default", transactionFee: "template" }) === "high")
    const cs = counterScenario({ offerPrice: 500_000, buyerClosingCredit: 5_000 }, 515_000,
      { commissionRate: 0.06, mortgagePayoff: 200_000, countyCityTaxes: 2_500, hoaDuesProration: 300, otherProratedFees: 5_000, transactionFee: 0 })
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
      // THE SINGLE TERMINAL MOVED, and "single" is the half worth asserting. The tier-aware
      // pick now lives in lib/lead-assignment/tier-routing.ts and assignment-engine.ts
      // delegates to it, so pointing these two greps at the new file is not enough: the
      // property this check is named for is that coverage is enforced in ONE place. Hence
      // the negative clause — the delegating engine must not carry a second copy.
      && src("lib/lead-assignment/tier-routing.ts").includes("redirectForCoverage")
      && src("lib/lead-assignment/tier-routing.ts").includes("_coverage")
      && !src("lib/lead-assignment/assignment-engine.ts").includes("redirectForCoverage")
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
    const vrTask = composeVendorRequestTask({ vendorName: "Apex Inspections", vendorCategory: "inspector", requestType: "access", details: "Need utilities on and the lockbox code", propertyAddress: "12 Oak Ln", neededBy: "2026-07-16" })
    const vrBody = composeClientRequestBody({ vendorName: "Apex Inspections", vendorCategory: "inspector", requestType: "access", details: "utilities on for Thursday", neededBy: null })
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

    // ── The hard gate is only hard if there is ONE demo-auth surface ─────────
    //
    // demo_login_hard_gate claims demo sign-in is hardened "at the single
    // source (DEMO_CONFIG.ENABLED)". That claim was FALSE: three more surfaces
    // existed and none of them consulted DEMO_CONFIG.
    //   · app/api/auth/login/route.ts       — POST an email, no password, and it
    //     minted a base64 (UNSIGNED) {userId, email, role} blob into an
    //     `auth-token` cookie. `/api/auth` is a PUBLIC_ROUTES prefix, so it was
    //     internet-reachable. Nothing read the cookie, so it was not yet an
    //     escalation — it was one `cookies().get("auth-token")` away from one.
    //   · app/api/auth/demo-users/route.ts  — unauthenticated GET returning the
    //     whole 20-user roster with roles and brokerages.
    //   · app/actions/demo-login.ts         — a second demoSignIn.
    // All four deleted (the ungated logout too). Asserting the CONSTRUCT rather
    // than the filenames: the demo roster lives in exactly one gated place, and
    // nothing anywhere mints a self-signed role cookie.
    {
      const ROSTER_HOME = new Set(["app/constants/auth.ts", "app/actions/demo-auth.ts"])
      const rosterCopies: string[] = []
      const cookieMinters: string[] = []
      for (const rel of REPO_TS_FILES) {
        {
          const text = readFileSync(join(ROOT, rel), "utf-8")
          // A roster copy is what lets a surface answer "who are the demo
          // users" without ever asking DEMO_CONFIG whether demo mode is on.
          // Count, don't merely detect: the deleted routes carried twenty
          // addresses each, while a doc comment naming the domain once is not
          // a roster and must not read as one.
          if (!ROSTER_HOME.has(rel) && (text.match(/@vipos\.com/g) ?? []).length >= 3) rosterCopies.push(rel)
          // The role-bearing cookie the deleted route invented. Real sessions
          // are Supabase's `sb-<ref>-auth-token`; anything hand-setting a
          // cookie literally named auth-token is minting its own authority.
          if (/name:\s*["']auth-token["']/.test(text)) cookieMinters.push(rel)
        }
      }
      check(`DEMO-AUTH SINGLE SURFACE (the hard gate is only hard if nothing routes around it) — the demo roster exists ONLY in the DEMO_CONFIG-gated source, no surface mints a self-signed \`auth-token\` role cookie, and the four ungated auth routes are gone. Roster copies: [${rosterCopies.join(", ") || "none"}] · cookie minters: [${cookieMinters.join(", ") || "none"}]`,
        rosterCopies.length === 0
        && cookieMinters.length === 0
        && !existsSync(join(ROOT, "app/api/auth/login/route.ts"))
        && !existsSync(join(ROOT, "app/api/auth/demo-users/route.ts"))
        && !existsSync(join(ROOT, "app/api/auth/logout/route.ts"))
        && !existsSync(join(ROOT, "app/actions/demo-login.ts"))
        && src("app/actions/demo-auth.ts").includes("DEMO_CONFIG.ENABLED"))
    }

    // ── "Log Out" has to end the session, not clear two unrelated cookies ────
    //
    // Both logout controls in the product were inert in the way that matters.
    // The dashboard one POSTed /api/auth/logout, which expired cookies named
    // `auth-token` and `supabase-auth-token` — neither is the session, which
    // Supabase SSR keeps in `sb-<ref>-auth-token`. The portal one cleared
    // localStorage and redirected to "/". In both cases the user was told they
    // were signed out while the session cookie survived, so navigating back in
    // still worked — on a shared computer that is the entire point of the
    // button. Both now call the one real signOut() and report a failure
    // instead of redirecting on a lie.
    check("LOGOUT ACTUALLY SIGNS OUT (dashboard + portal) — both menus call the canonical signOut() server action, read its outcome, and only navigate on success; neither pretends by clearing a cookie that was never the session",
      src("app/components/layout/user-menu.tsx").includes("await signOut()")
      && src("app/components/layout/user-menu.tsx").includes("if (!res.success)")
      && !/fetch\(\s*['"]\/api\/auth\/logout/.test(src("app/components/layout/user-menu.tsx"))
      && src("app/components/features/portal/base/PortalUserMenu.tsx").includes("await signOut()")
      && src("app/components/features/portal/base/PortalUserMenu.tsx").includes("if (!res.success)")
      && src("app/actions/auth.ts").includes("supabase.auth.signOut()"))

    // ── Password reset was a capability with no way in and no way out ────────
    //
    // /api/auth/reset-password worked and sent a real Supabase recovery email,
    // but NOTHING called it — no login page offered "Forgot password" — and the
    // redirectTo it has always used, /auth/reset-password-confirm, was a route
    // that did not exist, so every reset link in the product landed on a 404.
    // Both halves are wired, and the landing route is PUBLIC because the
    // recovery session arrives in the URL fragment the edge never sees.
    check("PASSWORD RESET IS REACHABLE END TO END — the login page can request the reset, the route the email points at exists, it sets the password through updateUser, and the landing path is public so the edge cannot bounce a valid link",
      src("app/login/page.tsx").includes("/api/auth/reset-password")
      && src("app/login/page.tsx").includes("Forgot password?")
      && existsSync(join(ROOT, "app/auth/reset-password-confirm/page.tsx"))
      && src("app/auth/reset-password-confirm/page.tsx").includes("updateUser({ password })")
      && src("app/api/auth/reset-password/route.ts").includes("/auth/reset-password-confirm")
      && src("app/constants/auth.ts").includes("'/auth/reset-password-confirm'"))

    // ── The KB admin wrote from the browser with a secret that never matched ──
    //
    // The knowledge-base admin inserted/updated/deleted help_topics_kb straight
    // from the client, then POSTed /api/intelligence/kb/embed with
    // `Bearer ${NEXT_PUBLIC_INTERNAL_API_SECRET}`. That route validates
    // INTERNAL_API_SECRET — a DIFFERENT, server-only variable — so the header
    // could not match and every embed 401'd. The client only checked
    // `response.ok` on the way UP, so the admin read "Article created
    // successfully" while the article stayed unembedded and therefore invisible
    // to the brand-voice brain that is the entire reason for uploading it.
    // Meanwhile a complete, tenant-scoped, synchronously-embedding CRUD sat in
    // app/actions/knowledge/search.ts with no callers.
    //
    // Repointed at the actions. Asserting the CONSTRUCT: no NEXT_PUBLIC_ secret
    // is used as a bearer token anywhere, and the admin reports whether the
    // embedding actually landed instead of only its own success.
    {
      const bearerPublic: string[] = []
      for (const rel of REPO_TS_FILES) {
        const text = readFileSync(join(ROOT, rel), "utf-8")
        if (/Bearer \$\{\s*process\.env\.NEXT_PUBLIC_/.test(text)) bearerPublic.push(rel)
      }
      const kb = src("app/dashboard/settings/knowledge-base/knowledge-base-client.tsx")
      check(`KB ADMIN GOES THROUGH THE SERVER ACTIONS (a secret shipped to the browser is not a secret, and an embed that 401s is not a save) — no NEXT_PUBLIC_ value is used as a bearer token, the admin calls createHelpTopic/updateHelpTopic/deleteHelpTopic, and it tells the admin when the embedding did NOT land. Public-secret bearers: [${bearerPublic.join(", ") || "none"}]`,
        bearerPublic.length === 0
        && kb.includes("await createHelpTopic(")
        && kb.includes("await updateHelpTopic(")
        && kb.includes("await deleteHelpTopic(")
        && !/fetch\(\s*['"]\/api\/intelligence\/kb\/embed/.test(kb)
        && kb.includes("res.embedded")
        // ONE embed path: the actions go through embedAndStore, which is what
        // emits KB_ARTICLE_EMBEDDED. Calling updateHelpTopicEmbedding directly
        // embedded the row but skipped the kernel event.
        && src("app/actions/knowledge/search.ts").includes("await embedAndStore(id)")
        // Platform scope is a platform-staff decision, refused rather than
        // silently downgraded to the caller's own tenant.
        && src("app/actions/knowledge/search.ts").includes("Only platform staff can publish a platform-wide article"))
    }

    // ── The portal's own message could never be sent by the portal's user ────
    //
    // sendPortalMessage resolved the caller with resolveAgentId and returned
    // "Agent profile not found" when that came back null. A buyer signed into
    // the consumer portal has no agents row, so client_to_agent — the one
    // direction the portal exists for — refused every time, while the UI showed
    // a fully wired Contact Agent button. The client lane resolves the thread's
    // agent from contacts.agent_id (already an agents.id — a RESOLVE, never a
    // substitution of the caller's user id) and pins the direction so a client
    // cannot post as their agent.
    check("PORTAL MESSAGE HAS A CLIENT LANE (the audience it was built for could not use it) — a caller with no agents row is authorised as the contact themselves via requireContactAccess, the thread agent is resolved from contacts.agent_id, and the direction is forced to client_to_agent",
      src("app/actions/portal-messages.ts").includes("await requireContactAccess(contactId)")
      && src("app/actions/portal-messages.ts").includes("agentId = contact.agent_id")
      && src("app/actions/portal-messages.ts").includes('direction = "client_to_agent"')
      && src("app/actions/portal-messages.ts").includes("access.isContactSelf")
      && !src("app/actions/portal-messages.ts").includes('return { success: false, error: "Agent profile not found" }'))
    const { computeDecisionVelocity, composeVelocityLine, MIN_SAMPLES } = await import("../lib/intelligence/decision-velocity")
    const velT = new Date("2026-07-14T12:00:00Z")
    const vel = computeDecisionVelocity([
      { assigned_to_agent_id: "a1", status: "completed", created_at: "2026-07-10T00:00:00Z", completed_at: "2026-07-10T04:00:00Z" },
      { assigned_to_agent_id: "a1", status: "completed", created_at: "2026-07-11T00:00:00Z", completed_at: "2026-07-11T08:00:00Z" },
      { assigned_to_agent_id: "a1", status: "completed", created_at: "2026-07-12T00:00:00Z", completed_at: "2026-07-12T06:00:00Z" },
      { assigned_to_agent_id: "a2", status: "pending", created_at: "2026-07-10T00:00:00Z", completed_at: null },
      { assigned_to_agent_id: null, status: "pending", created_at: null, completed_at: null },
    ], velT)
    const thinVel = computeDecisionVelocity([
      { assigned_to_agent_id: "a1", status: "completed", created_at: "2026-07-10T00:00:00Z", completed_at: "2026-07-10T01:00:00Z" },
    ], velT)
    const { parseFindingKind } = await import("../lib/platform/self-audit-rollup")
    const { lintScriptQuality, SCRIPT_QUALITY_CHARTER } = await import("../lib/ai/script-standards")
    check("DEAL-VELOCITY + TELEMETRY + SCRIPT CHARTER (approved recs + owner standard) — the velocity median is honest (3 samples → 6h median; 1 sample → NULL never fabricated; undated excluded; open-over-48h counted), the QBR line renders only on a real median, telemetry recovers finding kinds from the dedupe tags, and the charter (them-first + value-led + never salesy/basic + consumer-calibrated depth) rides the canonical copy rail + BOTH education authors + video scripts with the pure lint as deterministic backstop; all three registered",
      vel.medianHours === 6 && vel.executed === 3 && vel.open === 1 && vel.openOver48h === 1
      && vel.perAgent[0]?.agentId === "a1" && vel.perAgent[0]?.medianHours === 6
      && thinVel.medianHours === null && MIN_SAMPLES === 3
      && composeVelocityLine(vel)?.includes("median 6 hours") === true
      && composeVelocityLine(thinVel) === null
      && parseFindingKind("os_self_audit", "x [OS_AUDIT:decision_breach] [t-1]") === "decision_breach"
      && parseFindingKind("signature_chase", "y [SIG_CHASE:escalate] [c:1]") === "signature_escalate"
      && parseFindingKind("os_self_audit", null) === "os_self_audit"
      && JSON.stringify(lintScriptQuality("Act now! Don't miss out!! Once in a lifetime!!!")) === JSON.stringify(["salesy_pressure", "exclamation_stacking"])
      && lintScriptQuality("Just checking in — hope this finds you well.").includes("basic_filler")
      && lintScriptQuality("Your kitchen photographed beautifully — three buyers asked about it this week.").length === 0
      && SCRIPT_QUALITY_CHARTER.includes("THEM-FIRST") && SCRIPT_QUALITY_CHARTER.includes("LEAD WITH VALUE")
      && src("lib/kernel/ai-copy.ts").includes("SCRIPT_QUALITY_CHARTER")
      && src("lib/education/curriculum-author.ts").includes("withScriptStandards")
      && src("lib/education/onboarding-authoring.ts").includes("withScriptStandards")
      && src("app/actions/video/generate-script.ts").includes("SCRIPT_QUALITY_CHARTER")
      && src("lib/intelligence/quarterly-review-loader.ts").includes("composeVelocityLine")
      && src("lib/kernel/command-center.ts").includes("decisionVelocity")
      && src("app/dashboard/admin/command-center/command-center-client.tsx").includes("execute speed")
      && src("app/dashboard/admin/data-health/page.tsx").includes("What the OS caught itself")
      && src("lib/kernel/manager-registry.ts").includes("deal_velocity_scoreboard:")
      && src("lib/kernel/manager-registry.ts").includes("self_audit_telemetry:")
      && src("lib/kernel/manager-registry.ts").includes("script_quality_charter:"))
    const { computeNegotiationBand, zipFromAddress, composeSellerBandLine, MIN_BAND_SAMPLES } = await import("../lib/intelligence/negotiation-bands")
    const bandRows = Array.from({ length: 6 }, (_, i) => ({
      purchase_price: 490_000 + i * 1000, list_price: 500_000,
      property_address: `${i} Oak Ln, Austin, TX 78701`,
      created_at: "2026-05-01T00:00:00Z", close_date: "2026-06-05T00:00:00Z",
    }))
    const band = computeNegotiationBand(bandRows, "zip", "78701")
    const junkBand = computeNegotiationBand([
      ...bandRows.slice(0, 3),
      { purchase_price: 1, list_price: 500_000, property_address: "x 78701", created_at: null, close_date: null },
    ], "zip", "78701")
    check("NEGOTIATION BANDS + CLIENT-DECISION VOICE SOURCE + CLIENT TONE (recs 1/3 + owner refinement) — the band is honest (6 closed deals → ~98.5% median with range + 35d close; junk ratio excluded so 4 rows < MIN_BAND_SAMPLES → null; ZIP parsed with honest null), the seller line names its own-data source and hands off to the agent, the voice cockpit's action queue gains the decision-signal source (7th, critical past 48h), and the charter's client rule is 'never dumbed-down, never intimidating'",
      zipFromAddress("12 Oak Ln, Austin, TX 78701") === "78701"
      && zipFromAddress("12 Oak Ln") === null
      && band !== null && band!.sample === 6 && band!.medianSaleToListPct > 98 && band!.medianSaleToListPct < 99
      && band!.medianContractToCloseDays === 35
      && junkBand === null && MIN_BAND_SAMPLES === 5
      && Boolean(composeSellerBandLine(band)?.includes("of our own closed sales"))
      && Boolean(composeSellerBandLine(band)?.includes("Your agent will walk you through"))
      && composeSellerBandLine(null) === null
      && src("lib/agent-action-queue/composer.ts").includes('"client_decision"')
      && src("lib/agent-action-queue/composer.ts").includes("fetchClientDecisionActions")
      && src("lib/agent-action-queue/composer.ts").includes("client_decision:      decisions.length")
      && src("app/portal/[contactId]/offers/page.tsx").includes("composeSellerBandLine")
      && src("lib/ai/script-standards.ts").includes("never dumbed-down, never intimidating")
      && src("lib/kernel/manager-registry.ts").includes("client_decision_voice_source:")
      && src("lib/kernel/manager-registry.ts").includes("negotiation_bands:"))
    const { composePlaybookCandidates, MIN_COHORT } = await import("../lib/intelligence/playbook-engine")
    const mkStat = (id: string, vol: number, dec: number | null, ot: number | null, ap: number) =>
      ({ agentId: id, closings: vol > 0 ? 3 : 0, volume: vol, decisionMedianHours: dec, onTimeRate: ot, approvals: ap })
    const pbTop = [mkStat("t1", 9e6, 4, 0.95, 30), mkStat("t2", 8e6, 5, 0.9, 25), mkStat("t3", 7e6, 6, 0.92, 28)]
    const pbRest = Array.from({ length: 9 }, (_, i) => mkStat(`r${i}`, 1e6, 20, 0.6, 4))
    const playbooks = composePlaybookCandidates([...pbTop, ...pbRest])
    const thinPlaybooks = composePlaybookCandidates([mkStat("a", 1e6, 5, 0.9, 10), mkStat("b", 5e5, 8, 0.8, 5)])
    const { composeRenovationScenarios, RENOVATION_DISCLAIMER } = await import("../lib/intelligence/renovation-simulator")
    const renos = composeRenovationScenarios(500_000)
    const { composeCareerSuggestions, MIN_CLOSINGS } = await import("../lib/intelligence/career-architect")
    const career = composeCareerSuggestions({ agentId: "a1", closings: 5, volume: 2_500_000, topZip: { zip: "78701", count: 3 }, decisionMedianHours: 6 })
    const thinCareer = composeCareerSuggestions({ agentId: "a2", closings: 2, volume: 900_000, topZip: null, decisionMedianHours: 2 })
    const { computeZipMomentum, composeMomentumLine } = await import("../lib/intelligence/negotiation-bands")
    const momRows = Array.from({ length: 12 }, (_, i) => ({
      purchase_price: i < 6 ? 480_000 : 495_000, list_price: 500_000, property_address: "x 78701",
      created_at: `2026-0${(i % 6) + 1}-01T00:00:00Z`, close_date: `2026-0${(i % 6) + 1}-2${i < 6 ? 0 : 5}T00:00:00Z`,
    })).map((r, i) => ({ ...r, close_date: i < 6 ? `2026-02-0${(i % 6) + 1}T00:00:00Z` : `2026-06-0${(i % 6) + 1}T00:00:00Z` }))
    const momentum = computeZipMomentum(momRows)
    const { classifyTwinFields, composeProvenanceNote } = await import("../lib/contacts/twin-provenance")
    const twin = classifyTwinFields({ legal_first_name: "William", legal_last_name: "Reyes", legal_name_source: "document_scan", preferred_name: "Bill", contact_persona: "first_time_buyer", buyer_stage: null })
    const twinNote = composeProvenanceNote(twin)
    check("FUTURE-PROOF FIVE (approved 1-5) — the playbook engine claims a behavior ONLY with cohorts (3 candidates on a real 12-agent split; 2 agents → none), renovation scenarios scale to the home with the MANDATORY disclaimer, career suggestions cite their numbers and refuse thin data, ZIP momentum reports our own data's direction (buyers→sellers shift detected), and the twin labels document-verified vs stated vs INFERRED with the confirm-live warning; all five registered + cron-ridden",
      playbooks.length === 3 && playbooks.some((c) => c.key === "decision_speed") && playbooks.some((c) => c.key === "gate_adoption")
      && thinPlaybooks.length === 0 && MIN_COHORT === 3
      && renos.length === 5 && renos[0].costRange[0] >= 500 && renos.every((r) => r.effectRange[1] > r.effectRange[0])
      && composeRenovationScenarios(10_000).length === 0
      && RENOVATION_DISCLAIMER.includes("not a promise")
      && career.length === 3 && career.some((s) => s.key === "geographic_farm") && Boolean(career.find((s) => s.key === "speed_brand")?.line.includes("6 hours"))
      && thinCareer.length === 0 && MIN_CLOSINGS === 3
      && momentum !== null && momentum!.saleToListDelta === 3 && Boolean(composeMomentumLine(momentum)?.includes("keeping a little more"))
      && computeZipMomentum(momRows.slice(0, 8)) === null
      && twin.length === 3 && twin[0].provenance === "document_verified" && twin[1].provenance === "stated" && twin[2].provenance === "inferred"
      && Boolean(twinNote?.includes("confirm live, don't assert")) && Boolean(twinNote?.includes("signed documents"))
      && src("app/api/cron/recruit-outreach/route.ts").includes("runPlaybookEngineAll")
      && src("app/api/cron/recruit-outreach/route.ts").includes("runCareerArchitectAll")
      && src("app/portal/[contactId]/listing/page.tsx").includes("RENOVATION_DISCLAIMER")
      && src("app/portal/[contactId]/offers/page.tsx").includes("composeMomentumLine")
      && src("lib/contacts/contact-brief.ts").includes("composeProvenanceNote")
      && src("lib/kernel/manager-registry.ts").includes("dynamic_playbook_engine:")
      && src("lib/kernel/manager-registry.ts").includes("renovation_simulator:")
      && src("lib/kernel/manager-registry.ts").includes("career_brand_architect:")
      && src("lib/kernel/manager-registry.ts").includes("neighborhood_momentum:")
      && src("lib/kernel/manager-registry.ts").includes("twin_provenance:"))
    const { composeFutureLens, composeColdStartBandLine, PERMIT_HOT_COUNT } = await import("../lib/intelligence/neighborhood-future-lens")
    const appr = { zip: "78701", oldYear: 2018, newYear: 2022, oldValue: 400_000, newValue: 520_000, totalPct: 30, annualPct: 6.8 }
    const lensHot = composeFutureLens({ zip: "78701", appreciation: appr, permitCount: 10 })
    const lensNone = composeFutureLens({ zip: "78701", appreciation: null, permitCount: 0 })
    // THE PLACE NAME HAS A READER NOW. `loadFutureLensSignals` took `city` and
    // `state` from the offers page and read neither — two inert parameters on a
    // call that already had the values in hand (opposite-missing census cat. 4).
    // The composer names the place instead of saying "nearby", so these three
    // assert the wire in all three states rather than the happy one only.
    const lensPlaced = composeFutureLens({ zip: "78701", appreciation: null, permitCount: 10, city: "Austin", state: "TX" })
    const lensCityOnly = composeFutureLens({ zip: "78701", appreciation: null, permitCount: 10, city: "Austin", state: null })
    const { composeColdStartCareer } = await import("../lib/intelligence/career-architect")
    const coldCareer = composeColdStartCareer({ topTouchedZip: { zip: "78701", count: 6 }, contactCount: 6 })
    check("FUTURE LENS + NEW-AGENT COLD START (owner corrections: free public records + new solos hold no history) — Census two-vintage appreciation + OSINT permit density compose honest source-cited signals (30% up + 10 permits = 2 signals, each labeled forecast-not-fact; no data = no signal, never invented), the cold-start seller line fills the null band with clearly-labeled AREA data, and a new agent gets the touched-ZIP farm instead of silence; registered",
      lensHot.hasSignal === true && lensHot.signals.length === 2
      && Boolean(lensHot.signals[0].includes("U.S. Census")) && Boolean(lensHot.signals.some((s) => s.includes("building permits")))
      && lensNone.hasSignal === false && lensNone.signals.length === 0
      && Boolean(lensPlaced.signals[0].includes("pulled in Austin, TX in the last year"))
      && Boolean(lensCityOnly.signals[0].includes("pulled in Austin in the last year"))
      && Boolean(lensHot.signals[1].includes("pulled nearby in the last year"))
      && PERMIT_HOT_COUNT === 8
      && Boolean(composeColdStartBandLine(appr as any)?.includes("area data, not a specific-home valuation"))
      && composeColdStartBandLine(null) === null
      && coldCareer.length === 1 && coldCareer[0].key === "cold_start_farm" && Boolean(coldCareer[0].line.includes("farm forming"))
      && composeColdStartCareer({ topTouchedZip: { zip: "x", count: 2 }, contactCount: 2 }).length === 0
      && src("lib/external/census-appreciation.ts").includes("B25077_001E")
      && src("app/portal/[contactId]/offers/page.tsx").includes("composeColdStartBandLine")
      && src("lib/intelligence/career-architect.ts").includes("loadTopTouchedZip")
      && src("lib/kernel/manager-registry.ts").includes("neighborhood_future_lens:"))
    const { computeTimeToValue, composeTimeToValueLine, MINUTES_PER, BENCHMARK_HOURS_30D } = await import("../lib/intelligence/time-to-value-radar")
    const ttvBig = computeTimeToValue({ draftsSent: 220, callsAnswered: 40, tasksAutocreated: 60, docsExtracted: 20 })
    const ttvZero = computeTimeToValue({ draftsSent: 0, callsAnswered: 0, tasksAutocreated: 0, docsExtracted: 0 })
    const { extractPrices, checkPriceConsistency, composeConsistencyFlag, PRICE_TOLERANCE_PCT } = await import("../lib/kernel/consistency-guardian")
    const priceMatch = checkPriceConsistency("m1", "Great news — offers near $500,000 are coming in!", 485_000)
    const priceOk = checkPriceConsistency("m2", "Listed at $486,000, right on target.", 485_000)
    const priceNone = checkPriceConsistency("m3", "Your open house is Saturday at 2pm.", 485_000)
    check("TIME-TO-VALUE RADAR (#8) + CONSISTENCY GUARDIAN (#12) — hours-saved is honest (conservative constants, benchmarked ahead/behind, a real zero nudges not fabricates) and the guardian flags a MATERIAL price mismatch before release (>2% off live list flags, within-2% and no-price are clean); both registered",
      ttvBig.minutesSaved === (220 * MINUTES_PER.draft_sent + 40 * MINUTES_PER.call_answered + 60 * MINUTES_PER.task_autocreated + 20 * MINUTES_PER.doc_extracted)
      && ttvBig.hoursSaved > 0 && ttvBig.standing === "ahead" && ttvBig.benchmarkHours === BENCHMARK_HOURS_30D
      && ttvZero.hoursSaved === 0 && ttvZero.standing === "behind"
      && Boolean(composeTimeToValueLine(ttvZero).includes("hasn't saved you measurable time"))
      && Boolean(composeTimeToValueLine(ttvBig).includes("saved you about"))
      && extractPrices("from $250k to $1.2M and $485,000").length === 3
      && priceMatch !== null && priceMatch!.offendingPrice === 500_000 && priceMatch!.deltaPct > 2
      && priceOk === null && priceNone === null && PRICE_TOLERANCE_PCT === 2
      && Boolean(composeConsistencyFlag(priceMatch!).includes("live price"))
      && src("lib/kernel/consistency-guardian.ts").includes('violation_type: "price_inconsistency"')
      && src("lib/kernel/consistency-guardian.ts").includes('status: "flagged"')
      && !src("lib/kernel/consistency-guardian.ts").includes('status: "open"')
      && !src("app/actions/call-review-actions.ts").includes('status: "open"')
      && src("app/api/cron/compliance-monitoring/route.ts").includes("runConsistencyGuardianAll")
      && src("app/dashboard/agent/page.tsx").includes("TimeToValueCard")
      && src("app/actions/time-to-value.ts").includes("getMyTimeToValue")
      && src("lib/kernel/manager-registry.ts").includes("time_to_value_radar:")
      && src("lib/kernel/manager-registry.ts").includes("consistency_guardian:"))
    const { aggregateContactBook, composeStrategyMoves, composeRiskOpportunities, MIN_ZIP_CONTACTS } = await import("../lib/intelligence/portfolio-intelligence")
    // Owner correction: portfolio is the MANAGED CONTACT BOOK, not paid-lead territory.
    const bookContacts = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, zip: "78701" })), // hot unfarmed: 20 contacts, 3 closed
      ...Array.from({ length: 15 }, (_, i) => ({ id: `c${i}`, zip: "78702" })), // cold farmed: 15 contacts, 0 closed
      ...Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, zip: "78703" })),  // thin — must be ignored
    ]
    const closedIds = new Set(["h0", "h1", "h2"]) // 3 of the 20 in 78701 closed = 15%
    const books = aggregateContactBook(bookContacts, closedIds, new Set(["78702"]))
    const moves = composeStrategyMoves(books)
    const riskOps = composeRiskOpportunities(books)
    const { composeConnectionImpact, composeConnectionHeadline, PROVIDER_IMPACT } = await import("../lib/agentic-os/connection-impact")
    const impact = composeConnectionImpact({ connectors: [
      { provider: "instagram", status: "expired", expiresAt: "2026-07-01", actionRequired: true },
      { provider: "dotloop", status: "expiring_soon", expiresAt: "2026-07-20", actionRequired: true },
      { provider: "gmail", status: "connected", expiresAt: null, actionRequired: false },
    ] as any })
    const impactHealthy = composeConnectionImpact({ connectors: [{ provider: "gmail", status: "connected", expiresAt: null, actionRequired: false }] as any })
    const { nudgeTag } = await import("../lib/agentic-os/connection-nudge")
    const { detectPacketCompletionGaps, FLOW_LOOKBACK_DAYS } = await import("../lib/kernel/flow-integrity")
    const flowBreaks = detectPacketCompletionGaps(
      [{ envelopeId: "ENV-1", fullySignedAt: "2026-07-10" }, { envelopeId: "ENV-2", fullySignedAt: "2026-07-11" }],
      [{ envelopeId: "ENV-1", requestStatus: "pending", completedAt: null }, { envelopeId: "ENV-2", requestStatus: "completed", completedAt: "2026-07-11" }],
    )
    const flowClean = detectPacketCompletionGaps(
      [{ envelopeId: "ENV-3", fullySignedAt: "2026-07-10" }],
      [{ envelopeId: "ENV-3", requestStatus: "completed", completedAt: "2026-07-10" }],
    )
    check("CONNECTION SCOPE + NUDGE + FLOW INTEGRITY (owner fixes: per-seat connections, catch-before-fail, prove internal wiring) — the connectivity scan is agent-scopeable and the nudge dedupes per attention-signature (order-independent), and flow-integrity asserts a REAL cross-surface break (fully-signed ENV-1 with a still-pending packet flags; ENV-2 completed is clean) with zero false positives; all registered",
      src("lib/agentic-os/resolve-connectivity.ts").includes("ctx.agentId")
      && src("app/actions/connection-health.ts").includes("getBrokerageConnectionHealth")
      && src("app/dashboard/brokerage/page.tsx").includes('ConnectionHealthCard scope="brokerage"')
      && nudgeTag("b1", { broken: [{ provider: "meta" } as any], expiring: [{ provider: "dotloop" } as any], needsAttention: true }) === nudgeTag("b1", { broken: [{ provider: "meta" } as any], expiring: [{ provider: "dotloop" } as any], needsAttention: true })
      && src("app/api/cron/connector-health/route.ts").includes("runConnectionNudgeAll")
      && flowBreaks.length === 1 && flowBreaks[0].key === "ENV-1" && flowBreaks[0].flow === "packet_completion"
      && flowClean.length === 0 && FLOW_LOOKBACK_DAYS === 14
      && src("app/api/cron/deal-health-scan/route.ts").includes("runFlowIntegrityAll")
      && src("lib/kernel/manager-registry.ts").includes("connection_scope_and_nudge:")
      && src("lib/kernel/manager-registry.ts").includes("flow_integrity:"))
    const { classifyFlowRemediation } = await import("../lib/kernel/self-heal-ledger")
    const remSafe = classifyFlowRemediation("packet_completion")
    const remUnsafe = classifyFlowRemediation("some_unknown_flow")
    check("SELF-HEALING OS (owner: data flows self-heal like connectors) — a packet_completion break is classified deterministically SAFE (auto re-run the idempotent completion), an unknown flow is NOT safe (escalate not blind-fix); flow-integrity now auto-remediates + records to the unified self_heal_events ledger, the connector auto-applier writes the SAME ledger, and the broker 'repaired itself' panel reads the rollup; registered",
      remSafe.safe === true && remSafe.action === "complete_packet" && Boolean(remSafe.reason.includes("idempotent"))
      && remUnsafe.safe === false && remUnsafe.action === null && Boolean(remUnsafe.reason.includes("escalate"))
      && src("lib/kernel/flow-integrity.ts").includes("classifyFlowRemediation")
      && src("lib/kernel/flow-integrity.ts").includes('request_status: "completed"')
      && src("lib/kernel/flow-integrity.ts").includes("out.healed++")
      && src("lib/agentic-os/connector-auto-applier.ts").includes("recordSelfHeal")
      && src("lib/agentic-os/connector-auto-applier.ts").includes('domain: "connector"')
      && src("scripts/l56-s01-self-heal-events.sql").includes("self_heal_events")
      && src("app/dashboard/brokerage/page.tsx").includes("BrokerSelfHealPanel")
      && src("lib/kernel/manager-registry.ts").includes("self_healing_os:")
      && src("lib/kernel/manager-registry.ts").includes('self_heal_events: "cron_manager"'))
    // ── THE FLOW-CONTRACT LIBRARY + CONFIDENCE RATCHET (owner: "keep growing 1 with at least 10 more and complete 2") ──
    const shl = await import("../lib/kernel/self-heal-ledger")
    const fiLib = await import("../lib/kernel/flow-integrity")
    const probFresh  = shl.classifyFlowRemediation("decision_task_missing")                              // no ledger evidence → heals but reports
    const probMid    = shl.classifyFlowRemediation("decision_task_missing", { healed: 4, failed: 0 })    // 4/5 → still supervised
    const probEarned = shl.classifyFlowRemediation("decision_task_missing", { healed: 5, failed: 0 })    // ratchet promotes → silent
    const probDirty  = shl.classifyFlowRemediation("decision_task_missing", { healed: 9, failed: 1 })    // ONE failure blocks autonomy, forever-evidence
    const seedStamp  = shl.classifyFlowRemediation("offer_esign_stamp")                                  // seed-safe: silent from day one
    const escStage   = shl.classifyFlowRemediation("listing_agreement_stage_gap")                        // escalate-only tier
    check("SELF-HEAL CONFIDENCE RATCHET (earned autonomy applied to self-repair, computed from the append-only ledger — no extra state): a probation repair heals-but-REPORTS with no evidence (0/5) and at 4/5, EARNS silence at 5 clean heals with zero failures, and a single recorded failure holds it supervised forever; seed-safe finalizer re-runs are silent from day one; the escalate tier never auto-runs; the governance view (composeRepairAutonomy) + broker panel expose each repair's standing",
      probFresh.safe === true && probFresh.notify === true && probFresh.earned === false && probFresh.tier === "probation"
      && probMid.notify === true && probMid.earned === false
      && probEarned.notify === false && probEarned.earned === true && Boolean(probEarned.reason.includes("EARNED"))
      && probDirty.notify === true && probDirty.earned === false
      && seedStamp.safe === true && seedStamp.notify === false && seedStamp.tier === "seed_safe" && seedStamp.action === "stamp_offer_esign"
      && escStage.safe === false && escStage.action === null && escStage.tier === "escalate"
      && shl.EARNED_AUTONOMY_HEALS === 5
      && Object.keys(shl.FLOW_CONTRACTS).length === 17
      && shl.composeRepairAutonomy({ complete_packet: { healed: 6, failed: 0 }, recreate_decision_task: { healed: 2, failed: 0 } })
           .some((r) => r.flow === "packet_completion" && r.earned === true)
      && shl.composeRepairAutonomy({ recreate_decision_task: { healed: 2, failed: 0 } })
           .some((r) => r.flow === "decision_task_missing" && r.earned === false && r.healed === 2)
      && src("lib/kernel/flow-integrity.ts").includes("loadFlowActionStats")
      && src("lib/kernel/flow-integrity.ts").includes("SELF_HEAL_PROBATION")
      && src("app/actions/self-heal-rollup.ts").includes("getRepairAutonomy")
      && src("app/dashboard/brokerage/components/command-center/broker-self-heal-panel.tsx").includes("getRepairAutonomy")
      && src("lib/kernel/manager-registry.ts").includes("flow_contract_ratchet:"))
    const nowFlow = new Date("2026-07-15T12:00:00Z")
    const oldEvt = "2026-07-15T11:00:00Z"   // 60 min old — past the grace window, asserted
    const freshEvt = "2026-07-15T11:55:00Z" // 5 min old — the rail may still be in flight, silent
    const stampBreaks = fiLib.detectOfferEsignStampGaps([
      { id: "o1", esignStatus: "fully_signed", esignCompletedAt: null },
      { id: "o2", esignStatus: "fully_signed", esignCompletedAt: "2026-07-14" },
      { id: "o3", esignStatus: "partially_signed", esignCompletedAt: null },
    ])
    const docBreaks = fiLib.detectDocumentSignedGaps(
      [{ id: "d1", status: "uploaded", envelopeId: "ENV-9" }, { id: "d2", status: "signed", envelopeId: "ENV-9" }, { id: "d3", status: "uploaded", envelopeId: "ENV-X" }],
      new Set(["ENV-9"]),
    )
    const railBreaks = fiLib.detectMissingRailTasks([
      { id: "e1", eventType: "client_offer_decision", entityId: "of1", createdAt: oldEvt, metadata: { contact_id: "c1", decision: "accept" } },
      { id: "e2", eventType: "vendor_request", entityId: "tx1", createdAt: oldEvt, metadata: {} },
      { id: "e3", eventType: "lender_document_request", entityId: "tx2", createdAt: freshEvt, metadata: {} },
    ], [
      { source: "vendor_request", transactionId: "tx1", contactId: null, createdAt: "2026-07-15T11:00:30Z" },
    ], nowFlow)
    const shakyBreaks = fiLib.detectWalkthroughShakyGaps(
      [{ id: "w1", eventType: "walkthrough_outcome", entityId: "tx3", createdAt: oldEvt, metadata: { outcome: "major_issues" } },
       { id: "w2", eventType: "walkthrough_outcome", entityId: "tx4", createdAt: oldEvt, metadata: { outcome: "major_issues" } },
       { id: "w3", eventType: "walkthrough_outcome", entityId: "tx5", createdAt: oldEvt, metadata: { outcome: "minor_issues" } }],
      [{ entityId: "tx4", createdAt: "2026-07-15T11:30:00Z" }],
      new Map([["tx3", false], ["tx4", false], ["tx5", false]]),
      nowFlow,
    )
    const ctcBreaks = fiLib.detectCtcMilestoneGaps(
      [{ transactionId: "tx6", clearToCloseDate: "2026-07-14" }, { transactionId: "tx7", clearToCloseDate: "2026-07-14" }],
      [{ id: "m1", transactionId: "tx6", name: "clear_to_close_received", type: null, status: "pending" },
       { id: "m2", transactionId: "tx7", name: "clear_to_close_received", type: null, status: "completed" },
       { id: "m3", transactionId: "tx6", name: "inspection_completed", type: null, status: "pending" }],
    )
    const stageBreaks = fiLib.detectListingAgreementStageGaps(
      [{ id: "la1", listingId: "L1" }, { id: "la2", listingId: "L2" }],
      new Map([["L1", "LISTING_AGREEMENT_INITIATED"], ["L2", "LISTING_AGREEMENT_SIGNED"]]),
    )
    const { partyMatchesContact: pmc } = await import("../lib/documents/contact-legal-writeback")
    const legalBreaks = fiLib.detectLegalNameGaps([
      { documentId: "doc1", transactionId: "tx8", parties: ["William Robert Chen"], contacts: [{ id: "c9", firstName: "William", lastName: "Chen", legalFirst: null, legalLast: null }] },
      { documentId: "doc2", transactionId: "tx9", parties: ["Maria Ann Lopez"], contacts: [{ id: "c10", firstName: "Maria", lastName: "Lopez", legalFirst: "Maria Ann", legalLast: "Lopez" }] },
      { documentId: "doc3", transactionId: "tx10", parties: ["Robert Smith Jr"], contacts: [{ id: "c11", firstName: "Anna", lastName: "Lee", legalFirst: null, legalLast: null }] },
    ], pmc)
    check("FLOW-CONTRACT LIBRARY grown to 11 (10 new, each verified against the LIVE schema + the actual emitting rail, both ends concrete, zero false positives): offer stamp flags only fully_signed-without-timestamp; doc stamp flags only completed-envelope unsigned docs; the four ledger-event→task rails flag only graced events with NO matching task (a matched task or an in-grace event is silent); shaky-gap respects a later human deal_shaky_cleared (never fights a person); CTC flags only a PRESENT pending milestone under a recorded clear-to-close; stage-gap flags only agreement-initiated listings; legal-name flags only a MATCHING party against EMPTY legal names",
      stampBreaks.length === 1 && stampBreaks[0].key === "o1" && stampBreaks[0].flow === "offer_esign_stamp"
      && docBreaks.length === 1 && docBreaks[0].key === "d1" && docBreaks[0].flow === "document_signed_stamp"
      && railBreaks.length === 1 && railBreaks[0].flow === "decision_task_missing" && railBreaks[0].key === "e1"
      && shakyBreaks.length === 1 && shakyBreaks[0].key === "tx3" && shakyBreaks[0].flow === "walkthrough_shaky_gap"
      && ctcBreaks.length === 1 && ctcBreaks[0].key === "m1" && ctcBreaks[0].flow === "ctc_milestone_gap"
      && stageBreaks.length === 1 && stageBreaks[0].key === "la1" && stageBreaks[0].flow === "listing_agreement_stage_gap"
      && legalBreaks.length === 1 && legalBreaks[0].key === "doc1:c9" && legalBreaks[0].flow === "legal_name_writeback"
      && fiLib.FLOW_GRACE_MINUTES === 15 && fiLib.RAIL_TASK_CONTRACTS.length === 4
      && src("lib/kernel/flow-integrity.ts").includes("stamp_offer_esign")
      && src("lib/kernel/flow-integrity.ts").includes("recreate_decision_task")
      && src("lib/kernel/flow-integrity.ts").includes('.eq("deal_shaky", false)')
      && src("lib/kernel/flow-integrity.ts").includes('.eq("status", "pending")'))
    // ── INGRESS CONTINUITY (owner's Continuity Engine vision: "data gets stuck between one webhook and where it belongs") ──
    const ic = await import("../lib/kernel/ingress-continuity")
    check("INGRESS DEAD-LETTER + RECONCILIATION — a completion webhook that matches NO artifact (dispatch race / transient failure) is PARKED, never lost behind the 200: decideIngressAction replays the moment the artifact appears, waits while attempts remain, abandons + escalates at the cap (30 daily ticks); all four e-sign routes park unmatched envelopes; the reconciler rides deal-health-scan and ledgers every replay; the re-enrich sweep ledgers recovered stranded scraped leads onto the SAME self_heal_events spine; both new flows are registered contracts (13 total) so the autonomy panel shows their standing",
      ic.decideIngressAction({ matched: true, attempts: 0 }) === "replay"
      && ic.decideIngressAction({ matched: true, attempts: 29 }) === "replay"      // a match always replays, even at the cap
      && ic.decideIngressAction({ matched: false, attempts: 0 }) === "wait"
      && ic.decideIngressAction({ matched: false, attempts: 28 }) === "wait"
      && ic.decideIngressAction({ matched: false, attempts: 29 }) === "abandon"
      && ic.INGRESS_MAX_ATTEMPTS === 30
      && shl.FLOW_CONTRACTS["esign_ingress_orphan"].tier === "seed_safe"
      && shl.FLOW_CONTRACTS["esign_ingress_orphan"].action === "reconcile_esign_ingress"
      && shl.FLOW_CONTRACTS["scraped_lead_stranded"].tier === "probation"
      && shl.FLOW_CONTRACTS["scraped_lead_stranded"].action === "reenrich_promote"
      && src("app/api/webhooks/docusign/route.ts").includes("ensureEsignIngressContinuity")
      && src("app/api/webhooks/dotloop/route.ts").includes("ensureEsignIngressContinuity")
      && src("app/api/webhooks/skyslope/route.ts").includes("ensureEsignIngressContinuity")
      && src("app/api/webhooks/authentisign/route.ts").includes("ensureEsignIngressContinuity")
      && src("app/api/cron/deal-health-scan/route.ts").includes("runIngressReconciliation")
      && src("app/api/cron/lead-scraping/route.ts").includes("reenrich_promote")
      && src("lib/kernel/ingress-continuity.ts").includes("finalizeVoiceCockpitPacket")
      && src("lib/kernel/ingress-continuity.ts").includes("notifyPlatformStaff")
      && src("scripts/l58-s01-ingress-dead-letters.sql").includes("ingress_dead_letters")
      && src("lib/kernel/manager-registry.ts").includes("ingress_continuity:")
      && src("lib/kernel/manager-registry.ts").includes('ingress_dead_letters: "cron_manager"'))
    // ── EXCEPTION CENTER + CONTINUITY RECEIPTS (Continuity Engine components 5 + 7) ──
    const ec = await import("../lib/kernel/exception-center")
    const ecRead = ec.composeExceptionCenter([
      { id: "x1", subject: "S1", action: "none", outcome: "escalated", detail: { flow: "listing_agreement_stage_gap", reason: "stage machine fires automations" }, createdAt: "2026-07-10T10:00:00Z" },
      { id: "x2", subject: "S2", action: "none", outcome: "escalated", detail: { flow: "walkthrough_shaky_gap" }, createdAt: "2026-07-11T10:00:00Z" },
      { id: "x3", subject: "S2", action: "none", outcome: "resolved", detail: { flow: "walkthrough_shaky_gap", original_event_id: "x2" }, createdAt: "2026-07-12T10:00:00Z" },          // append-only closure
      { id: "x4", subject: "T1", action: "recreate_decision_task", outcome: "healed", detail: { flow: "decision_task_missing" }, createdAt: "2026-07-12T11:00:00Z" },                   // probation → supervised list
      { id: "x5", subject: "T2", action: "complete_packet", outcome: "healed", detail: { flow: "packet_completion" }, createdAt: "2026-07-12T12:00:00Z" },                              // seed_safe → NOT listed
      { id: "x6", subject: "T3", action: "reflag_shaky", outcome: "healed", detail: { flow: "walkthrough_shaky_gap" }, createdAt: "2026-07-12T13:00:00Z" },
      { id: "x7", subject: "T3", action: "reflag_shaky", outcome: "failed", detail: { flow: "walkthrough_shaky_gap", human_flagged: true }, createdAt: "2026-07-12T14:00:00Z" },        // already vetoed → gone
    ])
    const vetoDemotes = shl.classifyFlowRemediation("walkthrough_shaky_gap", { healed: 6, failed: 1 })  // one human veto = supervised again
    const cr = await import("../lib/kernel/continuity-receipt")
    const rVerified  = cr.composeContinuityReceipt({ openBreaks: 0, repairedLast30d: 0, checkedAtIso: "2026-07-15T12:00:00Z" })
    const rRepaired  = cr.composeContinuityReceipt({ openBreaks: 0, repairedLast30d: 2, checkedAtIso: "2026-07-15T12:00:00Z" })
    const rAttention = cr.composeContinuityReceipt({ openBreaks: 1, repairedLast30d: 5, checkedAtIso: "2026-07-15T12:00:00Z" })
    const receiptCopy = [rVerified, rRepaired, rAttention].map((r) => `${r.line} ${r.subline}`).join(" ")
    check("EXCEPTION CENTER (append-only closure + the ratchet's feedback loop) + DEAL CONTINUITY RECEIPTS (client trust, charter tone) — an escalation stays OPEN until a LATER resolved/dismissed/healed row closes it (S1 open, S2 closed); only PROBATION heals are veto-able (seed_safe complete_packet not listed; an already-vetoed repair disappears); ONE human veto (failed row) demotes an earned action back to supervised; the receipt runs real per-deal checks — attention wins over repaired wins over verified, and the client copy never says webhook/database/error/sync failure; wired on the brokerage command center + portal transaction page",
      ecRead.open.length === 1 && ecRead.open[0].subject === "S1" && ecRead.open[0].flow === "listing_agreement_stage_gap"
      && Boolean(ecRead.open[0].describes.length > 0) && Boolean(ecRead.open[0].reason.includes("stage machine"))
      && ecRead.supervised.length === 1 && ecRead.supervised[0].subject === "T1" && ecRead.supervised[0].action === "recreate_decision_task"
      && vetoDemotes.notify === true && vetoDemotes.earned === false
      && rVerified.status === "verified" && rRepaired.status === "repaired" && rAttention.status === "attention"
      && rRepaired.repairedLast30d === 2 && rAttention.openItems === 1
      && !receiptCopy.toLowerCase().includes("webhook") && !receiptCopy.toLowerCase().includes("database") && !receiptCopy.toLowerCase().includes("error")
      && src("app/actions/exception-center.ts").includes("flagRepairWrong")
      && src("app/actions/exception-center.ts").includes('outcome: "failed"')
      && src("app/actions/exception-center.ts").includes("human_flagged: true")
      && src("app/actions/exception-center.ts").includes("runFlowIntegrity")
      && src("app/dashboard/brokerage/page.tsx").includes("BrokerExceptionCenter")
      && src("app/portal/[contactId]/transaction/[transactionId]/page.tsx").includes("ContinuityReceiptCard")
      && src("app/actions/continuity-receipt.ts").includes("isParty")
      && src("scripts/l59-s01-self-heal-outcome-resolution-vocab.sql").includes("'dismissed'")
      && src("lib/kernel/manager-registry.ts").includes("exception_center:")
      && src("lib/kernel/manager-registry.ts").includes("continuity_receipts:"))
    // ── PAID-LEAD INGRESS CONTINUITY (owner: ingress expansion — "pulling scraped data to where it is sent" applied to PAID leads) ──
    const ali = await import("../lib/ads/ad-lead-intake")
    check("META-LEADGEN DEAD-LETTER (a paid lead is ALWAYS real money — the old route dropped it behind a 200 on an unmapped page, a transient Graph failure, or missing fields, and Meta never retries): the route + reconciler share ONE ingest path (ingestMetaLeadByRef — the two can never drift) whose stage says exactly where it stopped; recoverable stages PARK (rejected = terminal fact, not parked); the kind-aware replay registry replays a parked lead the moment the page connection catches up (idempotent on email/phone); meta_lead_orphan is a PROBATION contract (14 total) so replays report until earned; pickMetaField maps full_name fallbacks",
      typeof ali.ingestMetaLeadByRef === "function"
      && ali.pickMetaField([{ name: "full_name", values: ["Ada Lovelace"] }], "first_name", "full_name", "name") === "Ada Lovelace"
      && ali.pickMetaField([{ name: "email", values: [] }], "email") === null
      && shl.FLOW_CONTRACTS["meta_lead_orphan"].tier === "probation"
      && shl.FLOW_CONTRACTS["meta_lead_orphan"].action === "replay_meta_lead"
      && src("app/api/webhooks/meta-leadgen/route.ts").includes("ingestMetaLeadByRef")
      && src("app/api/webhooks/meta-leadgen/route.ts").includes("parkIngressEvent")
      && src("app/api/webhooks/meta-leadgen/route.ts").includes('res.stage !== "rejected"')
      && src("lib/kernel/ingress-continuity.ts").includes('event_kind === "meta_lead_received"')
      && src("lib/kernel/ingress-continuity.ts").includes("attemptReplay")
      && src("lib/ads/ad-lead-intake.ts").includes('"no_credential"')
      && src("lib/ads/ad-lead-intake.ts").includes('"graph_error"'))
    // ── SHOWINGTIME INGRESS DOOR (a buyer-agent showing request on OUR listing was acked 200 ignored when the listing hadn't carried its mls_number yet) ──
    const sti = await import("../lib/showings/showingtime-ingest")
    const stWin = sti.showingTimeWindow("2026-07-15T14:30:00Z", 45)
    const stWinDefault = sti.showingTimeWindow("2026-07-15T23:45:00Z") // default 30m, crosses midnight
    check("SHOWINGTIME DEAD-LETTER — route + reconciler share ONE ingest (resolveShowingTimeListing + ingestShowingTimeRequest, idempotent on listing+date+start+agent so ShowingTime redeliveries AND replays never double-book); only appointment.requested with an mls_number parks (other kinds have nothing to replay); the replay registry delivers the request + notifications the moment the listing resolves; contract showingtime_request_orphan is PROBATION (15 total); pure time-window math is exact incl. midnight wrap; honest rejections recorded: zapier already returns 4xx/5xx (sender retries), GHL is sync-out only, social-DM unknown senders violate zero-false-positives",
      stWin.date === "2026-07-15" && stWin.start === "14:30:00" && stWin.end === "15:15:00"
      && stWinDefault.start === "23:45:00" && stWinDefault.end === "00:15:00"
      && shl.FLOW_CONTRACTS["showingtime_request_orphan"].tier === "probation"
      && shl.FLOW_CONTRACTS["showingtime_request_orphan"].action === "replay_showingtime_request"
      && src("app/api/showings/showingtime-webhook/route.ts").includes("ingestShowingTimeRequest")
      && src("app/api/showings/showingtime-webhook/route.ts").includes("parkIngressEvent")
      && src("app/api/showings/showingtime-webhook/route.ts").includes('payload.event_type === "appointment.requested"')
      && src("lib/kernel/ingress-continuity.ts").includes('event_kind === "showingtime_appointment_requested"')
      && src("lib/showings/showingtime-ingest.ts").includes("deduped: true")
      && src("lib/kernel/manager-registry.ts").includes("showingtime"))
    // ── SCHEMA ADAPTATION LAYER (owner doc: self-heal when a provider sends a different data structure) ──
    const sa = await import("../lib/kernel/schema-adaptation")
    const driftedPayload = {
      appointmentId: "A-1",                       // rename of id
      requestedAt: "2026-07-20T15:00:00Z",        // camelCase rename
      duration: "45",                             // renamed + string where number expected → alias + coercion
      property: { mlsNumber: "MLS-9" },           // nested rename
      buyerAgent: { name: "Jo Chen", phoneNumber: "555-1" }, // nested renames
      brand_new_field: { x: 1 },                  // unknown → extension, never dropped
    }
    const adapted = sa.adaptPayload(sa.SHOWINGTIME_APPOINTMENT_CONTRACT, driftedPayload)
    const clean = sa.adaptPayload(sa.SHOWINGTIME_APPOINTMENT_CONTRACT, {
      id: "A-2", requested_at: "2026-07-20T15:00:00Z", duration_minutes: 30,
      property: { mls_number: "MLS-9" }, buyer_agent: { name: "Jo" },
    })
    const quarantined = sa.adaptPayload(sa.SHOWINGTIME_APPOINTMENT_CONTRACT, { property: { mls_number: "MLS-9" } }) // no id, no requested_at
    check("SCHEMA ADAPTATION LAYER (deterministic-core-first: direct → alias → SAFE coercion → default → extension → quarantine; ambiguity is NEVER guessed): a drifted provider payload (renames, nesting changes, '45' where 45 expected) adapts to the canonical shape with a per-field repair receipt; a clean payload adapts with ZERO drift repairs (no false healing claims); a payload missing REQUIRED facts quarantines instead of corrupting downstream; unknown fields are CAPTURED as extensions, never dropped; coercion never guesses ('abc' → number is refused); wired into the ShowingTime webhook + quarantine replays re-adapt against the CURRENT contract (immunization: teach the contract a new alias and the quarantine drains itself); contract schema_drift is PROBATION (16 total)",
      adapted.ok === true && adapted.canonical.id === "A-1" && adapted.canonical.requested_at === "2026-07-20T15:00:00Z"
      && adapted.canonical.duration_minutes === 45 && adapted.canonical.mls_number === "MLS-9"
      && adapted.canonical.agent_name === "Jo Chen" && adapted.canonical.agent_phone === "555-1"
      && adapted.driftRepairs > 0
      && adapted.repairs.some((r) => r.key === "id" && r.kind === "alias")
      && adapted.repairs.some((r) => r.key === "duration_minutes" && r.kind === "coerced")
      && Object.keys(adapted.extensions).includes("brand_new_field")
      && clean.ok === true && clean.driftRepairs === 0
      && quarantined.ok === false && quarantined.missingRequired.includes("id") && quarantined.missingRequired.includes("requested_at")
      && sa.coerceValue("450,000", "number") === 450000
      && sa.coerceValue("abc", "number") === undefined
      && sa.coerceValue("true", "boolean") === true
      && shl.FLOW_CONTRACTS["schema_drift"].tier === "probation" && shl.FLOW_CONTRACTS["schema_drift"].action === "adapt_payload"
      && src("app/api/showings/showingtime-webhook/route.ts").includes("adaptPayload")
      && src("lib/kernel/ingress-continuity.ts").includes("quarantineDriftedPayload") // ONE shared quarantine writer (routes consolidated onto it)
      && src("lib/kernel/ingress-continuity.ts").includes('event_kind === "schema_drift_quarantine"')
      && src("lib/kernel/manager-registry.ts").includes("schema_adaptation:"))
    // ── ADAPTATION ACROSS ALL E-SIGN + DOTLOOP INGRESS (owner: "add all from this OS to be considered complete") ──
    const dsSecondForm = sa.adaptPayload(sa.ESIGN_COMPLETION_CONTRACTS.docusign, { event: "envelope-completed", envelopeId: "ENV-DS-2" })          // documented 2nd form
    const dsThirdForm  = sa.adaptPayload(sa.ESIGN_COMPLETION_CONTRACTS.docusign, { data: { envelopeSummary: { envelopeId: "ENV-DS-3", status: "Completed" } } }) // documented 3rd form
    const dsUnreadable = sa.adaptPayload(sa.ESIGN_COMPLETION_CONTRACTS.docusign, { event: "envelope-completed", envelope: { ref: "X" } })          // unknown shape → quarantine
    const ssForm  = sa.adaptPayload(sa.ESIGN_COMPLETION_CONTRACTS.skyslope, { eventType: "transaction.completed", data: { transactionId: "ENV-SS-1" } })
    const asForm  = sa.adaptPayload(sa.ESIGN_COMPLETION_CONTRACTS.authentisign, { event: "signing.completed", signingId: "ENV-AS-1" })
    const dlForm  = sa.adaptPayload(sa.DOTLOOP_EVENT_CONTRACT, { event: "document.signed", data: { document_id: "D1", loop_id: 12345 } })          // numeric loop id → safe coercion
    const dlNoEvt = sa.adaptPayload(sa.DOTLOOP_EVENT_CONTRACT, { data: { loop_id: "L1" } })                                                        // no event name → quarantine
    const dpcProbe = sa.adaptPayload({ connector: "t", entity: "t", fields: [{ key: "x", type: "string", required: true, paths: ["a", "b", "c"], directPathCount: 2 }] }, { c: "via-alias" })
    const dpcDirect = sa.adaptPayload({ connector: "t", entity: "t", fields: [{ key: "x", type: "string", required: true, paths: ["a", "b", "c"], directPathCount: 2 }] }, { b: "second-doc-form" })
    check("ADAPTATION ACROSS THE WHOLE E-SIGN INGRESS (docusign/skyslope/authentisign/dotloop hand-parsed fallback chains REPLACED by declared contracts): a provider's SECOND or THIRD documented form is NOT drift (directPathCount — no false healing claims), only a later-taught alias counts; every provider's real shapes adapt (incl. dotloop's numeric loop id via safe coercion); an unreadable completion QUARANTINES via the ONE shared quarantineDriftedPayload (content-hash ref dedupes exact redeliveries — showingtime consolidated onto it, keep-one); the reconciler re-adapts esign/dotloop quarantines and chains readable envelopes into the SAME finalizer + orphan rail; consolidation verdicts recorded: normalizeInbound IS the email/SMS adaptation layer (no second layer), Meta's batch envelope is stable + its fields already alias through pickMetaField",
      dsSecondForm.ok === true && dsSecondForm.canonical.envelope_id === "ENV-DS-2" && dsSecondForm.driftRepairs === 0
      && dsThirdForm.ok === true && dsThirdForm.canonical.envelope_id === "ENV-DS-3" && String(dsThirdForm.canonical.status).toLowerCase() === "completed" && dsThirdForm.driftRepairs === 0
      && dsUnreadable.ok === false && dsUnreadable.missingRequired.includes("envelope_id")
      && ssForm.ok === true && ssForm.canonical.envelope_id === "ENV-SS-1" && ssForm.driftRepairs === 0
      && asForm.ok === true && asForm.canonical.envelope_id === "ENV-AS-1"
      && dlForm.ok === true && dlForm.canonical.loop_id === "12345" && dlForm.canonical.document_id === "D1"
      && dlNoEvt.ok === false && dlNoEvt.missingRequired.includes("event")
      && dpcDirect.repairs[0].kind === "direct" && dpcProbe.repairs[0].kind === "alias" && dpcProbe.driftRepairs === 1
      && ic.payloadHash({ a: 1 }) === ic.payloadHash({ a: 1 }) && ic.payloadHash({ a: 1 }) !== ic.payloadHash({ a: 2 })
      && src("app/api/webhooks/docusign/route.ts").includes("ESIGN_COMPLETION_CONTRACTS")
      && src("app/api/webhooks/skyslope/route.ts").includes("ESIGN_COMPLETION_CONTRACTS")
      && src("app/api/webhooks/authentisign/route.ts").includes("ESIGN_COMPLETION_CONTRACTS")
      && src("app/api/webhooks/dotloop/route.ts").includes("DOTLOOP_EVENT_CONTRACT")
      && src("app/api/webhooks/docusign/route.ts").includes("quarantineDriftedPayload")
      && src("app/api/webhooks/dotloop/route.ts").includes("quarantineDriftedPayload")
      && src("app/api/showings/showingtime-webhook/route.ts").includes("quarantineDriftedPayload")
      && src("lib/kernel/ingress-continuity.ts").includes('p.source === "esign_completion"')
      && src("lib/kernel/ingress-continuity.ts").includes('p.source === "dotloop_event"'))
    // ── PULL-DRIFT SENTINELS + EGRESS GATE (owner: scrapers/enrichment/rentcast pulls + good data pushing out) ──
    const driftHit   = sa.detectPullDrift({ received: 12, kept: 0 })   // provider drifted — every row silently dropped
    const driftClean = sa.detectPullDrift({ received: 12, kept: 9 })   // normal quality attrition, not drift
    const driftEmpty = sa.detectPullDrift({ received: 0, kept: 0 })    // a genuine no-results market is NOT drift
    const egressGood = sa.validateEgress(sa.CRM_CONTACT_EGRESS_CONTRACT, { firstName: "Ada", lastName: "Lovelace", email: "ada@x.test" }, [["email", "phone"]])
    const egressNoId = sa.validateEgress(sa.CRM_CONTACT_EGRESS_CONTRACT, { firstName: "Ada", lastName: "Lovelace" }, [["email", "phone"]])       // no reachable identifier → refused
    const egressNoName = sa.validateEgress(sa.CRM_CONTACT_EGRESS_CONTRACT, { email: "x@x.test", phone: "555" }, [["email", "phone"]])            // no name → refused
    check("PULL-DRIFT SENTINELS (RentCast comps + BatchData property search — the tolerant normalizers could silently empty a CMA or a scrape when the provider renames a field, with NO alarm) + CRM EGRESS GATE (good data OUT): detectPullDrift fires ONLY on non-empty-in/zero-out (attrition and no-results markets are never drift); reportPullDrift quarantines ONE content-hashed sample as engineer evidence; the egress gate REFUSES an outbound CRM push missing a name or any reachable identifier (email OR phone) and ledgers egress_rejected (escalate tier, 17 contracts — the fix is source data, never an invented field); consolidation verdicts: normalizeBatchDataProperty + rentcast-normalize + zenrows-normalizer ARE their pull adaptation layers (keep-one; zenrows is regex-over-HTML, no schema to drift), PDL no-match is normal (no sentinel), manager-to-manager flows are the canonical model + flow-integrity (adaptation belongs at TRUST BOUNDARIES, not internal calls)",
      driftHit.drifted === true && Boolean(driftHit.reason.includes("drifted"))
      && driftClean.drifted === false && driftEmpty.drifted === false
      && egressGood.ok === true
      && egressNoId.ok === false && egressNoId.missing.includes("any_of:email|phone")
      && egressNoName.ok === false && egressNoName.missing.includes("first_name") && egressNoName.missing.includes("last_name")
      && shl.FLOW_CONTRACTS["egress_rejected"].tier === "escalate" && shl.FLOW_CONTRACTS["egress_rejected"].action === null
      && src("lib/property/rentcast.ts").includes("reportPullDrift")
      && src("lib/external/batchdata-client.ts").includes("reportPullDrift")
      && src("lib/crm/sync.ts").includes("validateEgress")
      && src("lib/crm/sync.ts").includes("egress_rejected")
      && src("lib/kernel/ingress-continuity.ts").includes("reportPullDrift"))
    // ── SCHEMA MEMORY (drift detected AHEAD of drift damage) + MAIL EGRESS LEDGER ──
    const sm = await import("../lib/kernel/schema-memory")
    const shapeA = { event: "envelope-completed", data: { envelopeId: "E1", envelopeSummary: { status: "completed" } } }
    const shapeAOtherValues = { event: "recipient-completed", data: { envelopeId: "E999", envelopeSummary: { status: "sent" } } }
    const shapeB = { eventType: "envelope-completed", payload: { id: "E1" } }
    const smKeys = sm.extractShapeKeys(shapeA)
    check("SCHEMA MEMORY (the drift doc's last tier — the OS remembers every payload shape a connector ever sent): the fingerprint is SHAPE identity (same keys + different VALUES = same fingerprint; different keys = different fingerprint) over sorted key PATHS to depth 3 with values NEVER stored (no PII); arrays fingerprint by their first element's shape; a new fingerprint on a connector WITH history is a shape change the weekly digest announces before anything quarantines, alongside the pending-quarantine backlog; wired at all five webhook adapt sites; the direct-mail drain's verified-address refusal now ALSO ledgers egress_rejected on the tenant (a half-address mail piece is money burned — the refusal reaches the Exception Center)",
      sm.shapeFingerprint(shapeA) === sm.shapeFingerprint(shapeAOtherValues)
      && sm.shapeFingerprint(shapeA) !== sm.shapeFingerprint(shapeB)
      && smKeys.includes("data.envelopeId") && smKeys.includes("data.envelopeSummary.status")
      && !JSON.stringify(smKeys).includes("E1") // values never leak into the shape
      && sm.extractShapeKeys([{ a: 1 }, { b: 2 }]).includes("[].a") // array shape = first element
      && src("app/api/webhooks/docusign/route.ts").includes("rememberShape")
      && src("app/api/webhooks/skyslope/route.ts").includes("rememberShape")
      && src("app/api/webhooks/authentisign/route.ts").includes("rememberShape")
      && src("app/api/webhooks/dotloop/route.ts").includes("rememberShape")
      && src("app/api/showings/showingtime-webhook/route.ts").includes("rememberShape")
      && src("lib/kernel/repair-digest.ts").includes("loadRecentShapeChanges")
      && src("lib/kernel/repair-digest.ts").includes("waiting in quarantine")
      && src("lib/direct-mail/campaign-drain.ts").includes("egress_rejected")
      && src("scripts/l60-s01-connector-shape-memory.sql").includes("connector_shape_memory")
      && src("lib/kernel/manager-registry.ts").includes("schema_memory:")
      && src("lib/kernel/manager-registry.ts").includes('connector_shape_memory: "cron_manager"'))
    // ── PRINCIPAL-SCOPED CONTROLS + PLATFORM CONTINUITY BOARD (owner: not every subscription is a brokerage; superadmin oversees every subscriber) ──
    check("PRINCIPAL SCOPING (owner: solo/team subscriptions have no broker above them — the SEAT THAT OWNS the subscription gets the OS-maintenance surfaces): the exception-center + self-heal + autonomy actions gate on PRINCIPAL_TYPES (brokers AND solo_agent AND team_lead; team members and brokerage staff agents stay OVERSEEN by their principal); the panels mount on the agent dashboard and self-hide for overseen seats (server-side gate, not UI trust); the PLATFORM CONTINUITY BOARD (superadmin 'sentinel' capability) reads the whole fleet — per-subscriber heal/escalation activity, the quarantine queue, connector shape changes, and repair autonomy standings — read-only by design (repairs run themselves; this seat watches the watchers); linked from the platform-owner command strip",
      src("app/actions/exception-center.ts").includes("PRINCIPAL_TYPES")
      && src("app/actions/exception-center.ts").includes('"solo_agent"')
      && src("app/actions/exception-center.ts").includes('"team_lead"')
      && !src("app/actions/exception-center.ts").includes('"team_member"')
      && src("app/actions/self-heal-rollup.ts").includes("PRINCIPAL_TYPES")
      && src("app/dashboard/agent/page.tsx").includes("BrokerExceptionCenter")
      && src("app/dashboard/agent/page.tsx").includes("BrokerSelfHealPanel")
      && src("app/dashboard/brokerage/components/command-center/index.ts").includes("BrokerExceptionCenter")
      && src("app/dashboard/superadmin/continuity/page.tsx").includes('requirePlatformCapability("sentinel")')
      && src("app/dashboard/superadmin/continuity/page.tsx").includes("composeRepairAutonomy")
      && src("app/dashboard/superadmin/continuity/page.tsx").includes("loadRecentShapeChanges")
      && src("app/dashboard/superadmin/continuity/page.tsx").includes("ingress_dead_letters")
      // legacy /admin command strip retired (keep-one consolidation) — the canonical superadmin platform console now carries the continuity-board link
      && src("app/dashboard/superadmin/platform/page.tsx").includes("/dashboard/superadmin/continuity")
      && src("lib/kernel/manager-registry.ts").includes("principal_scoping_and_continuity_board:"))
    // ── THE THREE JOBS-COMPLETION DRAFTS (owner: NO hardcoded content — pure BRIEFS authored by the charter-governed model) ──
    const csd = await import("../lib/kernel/client-story-drafts")
    const busyBrief = csd.sellerUpdateBrief({ sellerFirstName: "Dana", address: "12 Elm St", showingCount: 4, feedbackNotes: ["loved the kitchen", "worried about the busy road"], daysOnMarket: 21 })
    const quietBrief = csd.sellerUpdateBrief({ sellerFirstName: null, address: "12 Elm St", showingCount: 0, feedbackNotes: [], daysOnMarket: 35 })
    const recapBrief = csd.tourRecapBrief({ buyerFirstName: "Sam", stops: [
      { address: "1 Oak Ct", rating: 5, feedback: "this is the one" },
      { address: "2 Pine Rd", rating: 3, feedback: null },
      { address: "3 Ash Ln", rating: null, feedback: null },
    ] })
    const recapNoStandout = csd.tourRecapBrief({ buyerFirstName: "Sam", stops: [{ address: "1 Oak Ct", rating: 2, feedback: "too dark" }] })
    const recapUnknownDay = csd.tourRecapBrief({ buyerFirstName: "Sam", stops: [{ address: "1 Oak Ct", rating: null, feedback: null }] })
    const noteBrief = csd.dealNoteBrief({ clientFirstName: "Lee", address: "9 Birch Way", loanStatus: "in_underwriting", clearToCloseDate: null, upcoming: [{ name: "appraisal_deadline", date: "2026-07-20" }], openTaskCount: 2 })
    const noteCtc = csd.dealNoteBrief({ clientFirstName: "Lee", address: null, loanStatus: "clear_to_close", clearToCloseDate: "2026-07-18", upcoming: [], openTaskCount: 0 })
    const noteEmpty = csd.dealNoteBrief({ clientFirstName: "Lee", address: null, loanStatus: null, clearToCloseDate: null, upcoming: [], openTaskCount: 3 })
    const busyFacts = busyBrief.facts.join(" ")
    const quietFacts = quietBrief.facts.join(" ")
    const recapFacts = recapBrief!.facts.join(" ")
    check("THE THREE JOBS-COMPLETION DRAFTS, NO HARDCODED CONTENT (owner rule): the PURE layer builds a BRIEF — grounded facts + the honesty instructions the writer must follow — and the BODY is AUTHORED by the ONE charter-governed copy path (realCopyGenerator: gateway-routed, facts-only, Fair-Housing-ruled); model failure = the draft is SKIPPED (an honest absence, never canned fallback prose). Briefs carry the honesty rules: a ZERO-showing week instructs 'say this plainly… never dress it up' + the concrete plan; the recap brief marks the STANDOUT (rating ≥4) with the no-pressure offer-readiness instruction, instructs 'useful information, not a setback' when nothing stood out, and returns NULL for a day with no recorded reactions; the deal-note brief pins the EXACT client-language loan framing ('normal at this stage' / CLEAR TO CLOSE) and returns NULL when the OS holds nothing to report; tags dedupe per listing/tour/deal per period; rides deal-health-scan; on-demand seller button + existing feedback-CHASE rail (showing-lifecycle) KEPT — consolidation verdicts recorded",
      Boolean(busyFacts.includes("Showings this week: 4")) && Boolean(busyFacts.includes("loved the kitchen"))
      && Boolean(quietFacts.includes("ZERO showings")) && Boolean(quietFacts.includes("never dress it up")) && Boolean(quietFacts.includes("concrete plan"))
      && recapBrief !== null && Boolean(recapFacts.includes("STANDOUT: 1 Oak Ct")) && Boolean(recapFacts.includes("offer-readiness"))
      && recapNoStandout !== null && Boolean(recapNoStandout.facts.join(" ").includes("useful information, not a setback"))
      && recapUnknownDay === null
      && noteBrief !== null && Boolean(noteBrief.facts.join(" ").includes("normal at this stage")) && Boolean(noteBrief.facts.join(" ").includes("appraisal deadline"))
      && noteCtc !== null && Boolean(noteCtc.facts.join(" ").includes("CLEAR TO CLOSE"))
      && noteEmpty === null
      && csd.sellerWeeklyTag("L1", "2026-W29") === "[SELLER_WEEKLY] [L1] [2026-W29]"
      && csd.tourRecapTag("T1") === "[TOUR_RECAP] [T1]"
      && csd.dealWeeklyTag("X1", "2026-W29") === "[TC_WEEKLY] [X1] [2026-W29]"
      && src("lib/kernel/client-story-drafts.ts").includes("realCopyGenerator")           // ONE authoring path
      && src("lib/kernel/client-story-drafts.ts").includes("skippedNoCopy")                // honest skip, never canned copy
      && !src("lib/kernel/client-story-drafts.ts").includes("felt like the standout")      // the old hardcoded prose is GONE
      && !src("lib/kernel/client-story-drafts.ts").includes("quieter week at")             // ditto
      && src("app/api/cron/deal-health-scan/route.ts").includes("runClientStoryDraftsAll")
      && src("lib/kernel/client-story-drafts.ts").includes("proposeClientMessage")
      && src("app/actions/seller-updates.ts").includes("generateSellerUpdateDraft")
      && src("lib/kernel/showing-lifecycle.ts").includes("feedbackRequested")              // the CHASE already exists — kept
      && src("lib/kernel/manager-registry.ts").includes("client_story_drafts:"))
    // ── BUYER WEEKLY SEARCH STORY (the RealScout counter) + FRONTIER SWEEP VERDICTS ──
    const activeBuyer = csd.buyerStoryBrief({ buyerFirstName: "Kim", portalActivityCount: 6,
      matches: [{ address: "4 Cedar Ave", confidence: "high" }, { address: "8 Maple Dr", confidence: "medium" }],
      movedListings: [{ address: "4 Cedar Ave", status: "pending" }] })
    const tightWeek = csd.buyerStoryBrief({ buyerFirstName: "Kim", portalActivityCount: 3, matches: [], movedListings: [] })
    const silentBuyer = csd.buyerStoryBrief({ buyerFirstName: "Kim", portalActivityCount: 0, matches: [], movedListings: [] })
    const buyerFacts = activeBuyer!.facts.join(" ")
    check("BUYER WEEKLY SEARCH STORY (completes the client-communication triangle; RealScout blasts listings — this AUTHORS the week from the buyer's OWN activity): the brief carries real matches (strong-match flagged), MARKET PACE facts (a matched home going pending is useful pace information, no pressure), the tight-inventory honesty rule when zero matches (never padded with near-misses), the never-surveil-y instruction on activity counts, and returns NULL for a buyer with nothing happening (silence, not filler); dedupe [BUYER_WEEKLY] per buyer per ISO week; authored via the SAME one charter path with honest skip; rides runClientStoryDraftsAll. FRONTIER SWEEP VERDICTS (investigate-before-build): pre-approval expiry EXISTS (stale-preapproval-reengage), review-ask EXISTS (ai-review-automation), price advisory EXISTS (listing-health + predictive-pricing), open-house follow-through COVERED (instant-greeting + invitations + routing), anniversary EXISTS (gift/anniversary rails); genuine gaps NAMED for next: post-close move-in concierge, renter/lease-to-buy nurture",
      activeBuyer !== null && Boolean(buyerFacts.includes("4 Cedar Ave (strong match)"))
      && Boolean(buyerFacts.includes("went pending")) && Boolean(buyerFacts.includes("no pressure"))
      && Boolean(buyerFacts.includes("never surveil-y"))
      && tightWeek !== null && Boolean(tightWeek.facts.join(" ").includes("inventory at their criteria is tight")) && Boolean(tightWeek.facts.join(" ").includes("never pad"))
      && silentBuyer === null
      && csd.buyerWeeklyTag("C1", "2026-W29") === "[BUYER_WEEKLY] [C1] [2026-W29]"
      && src("lib/kernel/client-story-drafts.ts").includes("runBuyerSearchStories")
      && src("lib/kernel/client-story-drafts.ts").includes('activity_type", "buyer_search_match')
      && src("lib/lead-pipeline/stale-preapproval-reengage.ts").length > 0
      && src("app/actions/ai-review-automation.ts").length > 0
      && src("lib/open-house/instant-greeting.ts").length > 0)
    // ── POST-CLOSE MOVE-IN CONCIERGE (Journey #6's opening frontiers, owner's journey/frontier spec) ──
    const pcc = await import("../lib/kernel/postclose-concierge")
    const day3 = pcc.dueFrontiers(3)     // move-in guide window only
    const day10 = pcc.dueFrontiers(10)   // move-in + settle-in overlap (tags keep each once-per-tx)
    const day35 = pcc.dueFrontiers(35)   // 30-day care only
    const day90 = pcc.dueFrontiers(90)   // journey window closed — silence
    const moveIn = pcc.postCloseBrief("move_in_guide", { buyerFirstName: "Ana", address: "5 Fir Ct", daysSinceClose: 3, hasVendorBench: true })
    const care = pcc.postCloseBrief("care_30d", { buyerFirstName: "Ana", address: "5 Fir Ct", daysSinceClose: 35, hasVendorBench: false })
    check("POST-CLOSE MOVE-IN CONCIERGE (the lifetime-customer on-ramp — the stretch AFTER the closing gift where loyalty is won): pure day-window decisioning (day 3 → move-in guide; day 10 → move-in+settle-in overlap deduped by once-per-tx tags; day 35 → 30-day care; day 90 → silence, the journey window closed); briefs carry the practical first-week items + the PURE-CARE honesty rules ('no upsell, no market talk', 'NO referral ask and NO listing pitch — the relationship IS the point') and the vendor-bench fact only when the tenant actually has vendors; authored via the SAME one charter path with honest skip; BUYER-side only by design (seller post-sale care is the gift/anniversary rails' job — consolidation, no overlap); gated proposals ride runClientStoryDraftsAll",
      day3.length === 1 && day3[0] === "move_in_guide"
      && day10.length === 2 && day10.includes("move_in_guide") && day10.includes("settle_in_check")
      && day35.length === 1 && day35[0] === "care_30d"
      && day90.length === 0
      && Boolean(moveIn.facts.join(" ").includes("utilities")) && Boolean(moveIn.facts.join(" ").includes("no upsell, no market talk"))
      && Boolean(care.facts.join(" ").includes("NO referral ask")) && !care.facts.join(" ").includes("vendor bench remains")
      && pcc.postCloseTag("X1", "care_30d") === "[POSTCLOSE] [X1] [care_30d]"
      && src("lib/kernel/postclose-concierge.ts").includes("authorStory")
      && src("lib/kernel/postclose-concierge.ts").includes("proposeClientMessage")
      && src("lib/kernel/client-story-drafts.ts").includes("runPostCloseConcierge")
      && src("lib/kernel/manager-registry.ts").includes("postclose_concierge:"))
    // ── JOURNEY SNAPSHOT + RECAP→OFFER BRIDGE + CRON SWEEP + RENTER DEFERRAL (approved 2+3; expert verdict on 1) ──
    const js = await import("../lib/kernel/journey-snapshot")
    const inTx = js.composeJourneySnapshot({ contactType: "buyer", buyerStage: "touring", activeDealStage: "under_contract", closedDaysAgo: null, lastFrontier: { kind: "weekly deal note", at: "2026-07-13T10:00:00Z" } }, new Date("2026-07-15T10:00:00Z"))
    const postClose = js.composeJourneySnapshot({ contactType: "buyer", buyerStage: null, activeDealStage: null, closedDaysAgo: 10, lastFrontier: null }, new Date("2026-07-15T10:00:00Z"))
    const buyerJ = js.composeJourneySnapshot({ contactType: "buyer", buyerStage: "touring", activeDealStage: null, closedDaysAgo: null, lastFrontier: { kind: "tour recap", at: "2026-07-15T02:00:00Z" } }, new Date("2026-07-15T10:00:00Z"))
    const leadJ = js.composeJourneySnapshot({ contactType: null, buyerStage: null, activeDealStage: null, closedDaysAgo: null, lastFrontier: null }, new Date("2026-07-15T10:00:00Z"))
    check("JOURNEY SNAPSHOT (the spec's 'expose visible status' rule — the journey-first architecture made VISIBLE from state the OS already writes, the tags ARE the memory) + RECAP→OFFER BRIDGE + PRE-LAUNCH CRON SWEEP + RENTER/RESIDENT DEFERRAL: precedence mirrors the business (active deal outranks everything → post-close windows moving-in/settling-in/care → seller → buyer → lead); the one line carries journey · stage · last frontier · next; parseFrontierKind maps every story tag; the bridge turns a standout reaction into the agent's same-evening offer-prep task (comps/band/net-sheet, users.id→agents.id resolved, once per tour); the SWEEP verdict: vercel.json runs ONE minutely dispatcher and the cron-dispatch registry covers 160+ routes (nothing unscheduled); RENTER/RESIDENT journeys DEFERRED by expert verdict (the platform does not serve rentals; renter LEADS are already future buyers in the lead journey — building leasing ops would be scope drift)",
      inTx.journey === "transaction" && Boolean(inTx.line.includes("under contract")) && Boolean(inTx.line.includes("last touch: weekly deal note 2d ago")) && Boolean(inTx.line.includes("next: weekly deal note"))
      && postClose.journey === "post_close" && postClose.stage === "settling in"
      && buyerJ.journey === "buyer" && Boolean(buyerJ.line.includes("tour recap today"))
      && leadJ.journey === "lead" && Boolean(leadJ.line.includes("speed-to-lead"))
      && js.parseFrontierKind("x [BUYER_WEEKLY] y") === "weekly search story"
      && js.parseFrontierKind("x [POSTCLOSE] y") === "post-close check-in"
      && js.parseFrontierKind("unrelated") === null
      && src("lib/contacts/contact-brief.ts").includes("composeJourneySnapshot")
      && src("lib/kernel/client-story-drafts.ts").includes("TOUR_STANDOUT")
      && src("lib/kernel/client-story-drafts.ts").includes('source: "tour_standout"')
      && src("lib/kernel/client-story-drafts.ts").includes("assigned_to_agent_id: t.agent_id") // LIVE-FK: tours.agent_id → agents(id), tasks' exact target
      && src("app/actions/tour-planner.ts").includes("agentRowId") // LIVE CATCH fixed: createTour inserted users.id into two agents(id) FKs — tour creation failed for EVERY caller
      && src("app/actions/tour-planner.ts").includes("no agent profile")
      && src("vercel.json").includes('"/api/cron/dispatch"')
      && ((src("lib/kernel/cron-dispatch.ts").match(/\/api\/cron\//g) ?? []).length >= 160)
      && src("lib/kernel/manager-registry.ts").includes("journey_visibility_and_bridge:"))
    // ── BUYER CLOSING-COST BREAKDOWN + THE RIGOROUS FK PASS (owner: "buyer gets a closing cost breakdown" + "go ahead with the rigorous pass test") ──
    const bcc = await import("../lib/offers/buyer-closing-costs")
    const financed = bcc.estimateBuyerClosingCosts({ purchasePrice: 500_000, loanAmount: 400_000, sellerCredit: 5_000 })
    const cash = bcc.estimateBuyerClosingCosts({ purchasePrice: 500_000, loanAmount: 0, sellerCredit: 0 })
    check("BUYER CLOSING-COST BREAKDOWN (the buyer-side companion to the seller net sheet — keep-one, different audience) + THE RIGOROUS FK PASS: every cost line is a LOW–HIGH RANGE with its assumption stated (never false precision), cash drops all lender lines, the negotiated seller credit nets against the total, the disclaimer names the BINDING documents (Loan Estimate / Closing Disclosure), party-anchored action refuses a deal with no price (honest absence); THE FK PASS found the createTour bug class SYSTEMIC — 60+ writes of users.id into agents(id)-FK columns (the entire activity trail on leads/offers/listing flows silently FK-rejected; buyer_behavior_log, showings, contract_signatures, chat_sessions, call_analyses all broken) — ALL fixed via the documented resolveAgentId rule the code itself prescribed; call-intelligence reader+writer BOTH corrected (they were consistent-but-broken: writes rejected, reads empty)",
      financed.isCash === false && financed.lines.length >= 9
      && financed.lines.every((l) => l.high >= l.low && l.low >= 0)
      && financed.netLow === financed.totalLow - 5000 && financed.netHigh === financed.totalHigh - 5000
      && financed.pctLow > 0 && financed.pctHigh >= financed.pctLow
      && Boolean(financed.lines.find((l) => l.label.includes("Lender fees"))!.note!.includes("0.5%"))
      && Boolean(financed.disclaimer.includes("Loan Estimate")) && Boolean(financed.disclaimer.includes("Closing Disclosure"))
      && cash.isCash === true && cash.lines.every((l) => !l.label.includes("lender") || l.label.includes("Lender's title") === false)
      && cash.lines.length < financed.lines.length
      && src("app/actions/buyer-closing-costs.ts").includes("isParty")
      && src("app/actions/buyer-closing-costs.ts").includes("No purchase price")
      && src("app/portal/[contactId]/transaction/[transactionId]/page.tsx").includes("BuyerClosingCostsCard")
      && src("app/actions/leads.ts").includes("resolveAgentId")
      && src("app/actions/buyer-offer/respond-to-counter.ts").includes("resolveAgentId")
      && src("app/actions/seller-listing/execution-engine.ts").includes("resolveAgentId")
      && src("app/actions/seller-showings.ts").includes("resolveAgentId")
      && src("app/actions/tour-planner.ts").includes("actorAgentId")
      && src("lib/voice/call-analysis.ts").includes("agent_id: call.agent_id")
      && src("lib/kernel/call-intelligence.ts").includes('.eq("user_id", agentUserId)')
      && src("lib/kernel/manager-registry.ts").includes("buyer_closing_costs_and_fk_pass:"))
    // ── PASS 2 (owner: "continue doing these passes until we are all clean"): the three sibling id-class bugs ──
    check("ID-CLASS PASS 2 — three sibling classes hunted + fixed: (a) REVERSE direction: agents(id) written into users(id)-FK columns — referral + neighborhood-report lifecycle actors, campaign-calendar, the stuck-in-limbo + video-compliance + deal-autopsy notifications (payload refs resolve-or-keep so either class lands); (b) ZERO-UUID FK fallbacks: the showings sync/approve paths faked NOT-NULL contact/agent refs with a zero uuid that FK-failed EVERY row — replaced with the LISTING's own parties (the honest deal-context fallback) + explicit refusals ('add the seller before approving showings'), never a fake ref; (c) CONTACT/LEAD family: leads are NOT contacts — the lead activity trail + ISA outbox messages wrote lead ids into contacts(id)-FK columns (all FK-rejected); now entity_type/entity_id carry the lead and contact_id is honestly null; query-side zero-uuid no-match sentinels adjudicated LEGITIMATE (reads, not writes)",
      src("app/actions/leads.ts").includes("leads are NOT contacts")
      && src("app/actions/ai-isa/initiate-engagement.ts").includes("DEAD-WRITE REMOVED")            // the 4 unified-inbox inserts could NEVER succeed (conversation_id NOT NULL, contact FK) — removed, isa_outreach_log is the record
      && !src("app/actions/ai-isa/initiate-engagement.ts").includes("from('messages').insert")      // no dead writes remain
      && src("app/actions/ai-isa/initiate-engagement.ts").includes("isa_outreach_log")              // the status read now hits the real ledger
      && src("lib/ai-isa/email-generator.ts").includes("entity_id: leadId")
      && src("app/actions/referrals/referral-actions.ts").includes("actor_user_id: userId")
      && src("app/actions/neighborhood-reports.ts").includes("actor_user_id: userId")
      && src("app/actions/content-studio.ts").includes("agent_user_id: userId")
      && src("lib/kernel/stalled-deferrals-runner.ts").includes('select("user_id")')
      && src("lib/kernel/manager-signals.ts").includes("resolve-or-keep")
      && src("lib/kernel/manager-signals.ts").includes("agentNotifyUserId")
      && !src("app/actions/seller-showings.ts").includes("00000000-0000-0000-0000-000000000000")
      && src("app/actions/seller-showings.ts").includes("add the seller before approving showings")
      && src("app/actions/seller-showings.ts").includes("skippedNoParty"))
    // ── ISA LEAD LANE IN THE UNIFIED INBOX + LEAD CALL-IN DOOR + PASS 3 (CHECK vocabularies) ──
    check("ISA LEAD LANE (owner: 'the unified inbox includes lead conversations that the ai isa has been sending… emails/direct mail and leads can call in which the ai isa can then convert to a contact if there is positive direction'): the kernel inbox grows a LEAD lane — isa_outreach_log sends + lead-keyed voice_calls surface as lead:<id> threads (leads are NOT contacts; converted leads leave the lane because the contact thread owns the story; contact-keyed voice lane now excludes lead rows); the inbox UI renders 'Lead · AI ISA' threads read-only with the nurture explainer and a CONVERT TO CONTACT affordance riding the ONE canonical handoff (representation-guarded); the CALL-IN DOOR: an unknown caller who IS a nurtured lead records on voice_calls.lead_id (never a duplicate 'Caller ####' contact), the closed call's transcript routes through the SAME inbound intent classifier the email lane uses (positive → convert via canonical handoff; negative → halt; ambiguous → keep nurturing), lead opt-outs land on the LEAD entity class, and the status callback fires the hook only when IT closed the row (no double-fire)",
      src("lib/kernel/communications.ts").includes("AI-ISA LEAD LANE")
      && src("lib/kernel/communications.ts").includes('"isa_outreach_log"')
      && src("lib/kernel/communications.ts").includes("`lead:${m.lead_id}`")
      && src("lib/kernel/communications.ts").includes('q.not("contact_id", "is", null)')          // contact voice lane excludes lead rows
      && src("lib/kernel/communications.ts").includes('.is("contact_id", null)')                   // converted leads leave the lane
      && src("app/actions/inbox.ts").includes("getLeadInboxThreads")
      && src("app/actions/inbox.ts").includes("convertLeadFromInbox")
      && src("app/actions/inbox.ts").includes("under representation — cannot convert")             // same honest guard as the automated path
      && src("app/dashboard/communications/inbox/page.tsx").includes("getLeadInboxThreads")
      && src("app/dashboard/communications/inbox/InboxClient.tsx").includes("Convert to contact")
      && src("app/dashboard/communications/inbox/InboxClient.tsx").includes('id.startsWith("lead:")')
      && src("app/dashboard/communications/inbox/components/ConversationList.tsx").includes("Lead · AI ISA")
      && src("app/api/voice/twilio/inbound/route.ts").includes('.is("contact_id", null)')          // lead match precedes new-contact capture
      && src("app/api/voice/twilio/inbound/route.ts").includes("lead_id: leadId")
      && src("app/api/voice/twilio/turn/route.ts").includes("maybeRoutePostCall")
      && src("app/api/voice/twilio/turn/route.ts").includes('entityType: (call as any).contact_id ? "contact" : "lead"')
      && src("app/api/voice/twilio/status/route.ts").includes("routeLeadCallIntent")
      && src("app/api/voice/twilio/status/route.ts").includes('.select("id, lead_id")')            // transition-gated, no double-fire
      && src("lib/ai-isa/lead-call-intent.ts").includes("classifyAndRouteInbound"))
    check("PASS 3 — CHECK-VOCABULARY SWEEP (the DB's enum CHECKs are live vocabularies; drifted literals FAIL SILENTLY behind best-effort inserts): isa_outreach_log.channel rejected 'phone'/'social' — the logger normalizes phone→voice + per-network socials→social and the CHECK gained 'social' (l72-s01); ai_isa_activities.activity_type rejected the whole drifted synonym family — outbound_email/outbound_sms/outbound_call/outbound_direct_mail/outbound_voicedrop and seller_intent_prioritized were ALL silently lost — writers normalized to the canonical values (email/text/call/direct_mail) and the CHECK gained the genuinely-new semantics social/voicedrop/seller_intent_prioritized (l72-s02); checkMaxTouches now counts EVERY outreach type on the contact side (text/call/voicedrop/social were invisible to the cap — parity with the lead side); vendor_bookings/compliance_flags/contract_signatures/notifications.priority literals audited CLEAN (prior passes hold)",
      src("lib/ai-isa/isa-outreach-logger.ts").includes("LOG_CHANNEL")
      && src("lib/ai-isa/isa-outreach-logger.ts").includes("phone: 'voice'")
      && src("lib/ai-isa/isa-outreach-logger.ts").includes("ACTIVITY_TYPE")
      && src("lib/ai-isa/isa-outreach-logger.ts").includes("sms: 'text', phone: 'call'")
      && src("lib/ai-isa/isa-outreach-logger.ts").includes("'voicedrop', 'social'")
      && src("app/actions/ai-isa/engage-contact.ts").includes("activity_type: 'email'")
      && src("app/actions/ai-isa/engage-contact.ts").includes("activity_type: 'text'")
      && src("app/actions/ai-isa/engage-contact.ts").includes("activity_type: 'call'")
      && src("app/actions/ai-isa/engage-contact.ts").includes("activity_type: 'voicedrop'")
      && !src("app/actions/ai-isa/engage-contact.ts").includes("outbound_email")
      && !src("app/actions/ai-isa/engage-contact.ts").includes("outbound_voicedrop")
      // the inbound-lead-email handler's THREE lead-id-into-contacts-FK dead writes replaced with lead-class ledgers
      && src("app/actions/ai-isa/handle-inbound-email.ts").includes("DEAD-WRITE REPLACED")
      && !src("app/actions/ai-isa/handle-inbound-email.ts").includes("contact_id: params.leadId")
      && src("app/actions/ai-isa/handle-inbound-email.ts").includes("logISAOutreach")
      && src("app/actions/ai-isa/handle-inbound-email.ts").includes("outcome: 'replied'")
      && src("lib/kernel/communications.ts").includes('.eq("outcome", "replied")')        // the lead's replies surface as inbound turns in the lane
      // engage-contact's unified-inbox email mirror resolves the NOT NULL thread first (same class as sendInboxReply)
      && src("app/actions/ai-isa/engage-contact.ts").includes("ensureConversationForContact"))
    // ── PASS 4: THE WRITE SENTINEL (the silencer class becomes self-reporting) ──
    {
      const silencerRe = /\.then\((undefined|\(\) *=> *(null|\{\})), *\(\) *=> *(null|\{\}|undefined)\)/g
      let silencerCount = 0
      for (const rel of REPO_TS_FILES) {
        silencerCount += (readFileSync(join(ROOT, rel), "utf-8").match(silencerRe) ?? []).length
      }
      // RATCHET: 195 is the frozen baseline. New best-effort writes must use
      // sentinelWrite (which ledgers every loss) — this check FAILS if the
      // silencer population GROWS. Converting old sites only shrinks it.
      const SILENCER_BASELINE = 191
      check(`PASS 4 — WRITE SENTINEL + SILENCER RATCHET (the bug class that hid passes 1–3's defects becomes SELF-REPORTING): supabase-js resolves with { error } instead of throwing, so '.then(()=>{},()=>{})' silencers and unchecked awaits hid FK/CHECK/NOT-NULL row loss for months; sentinelWrite keeps the best-effort contract (never throws, never 500s a webhook) but ledgers every loss to self_heal_events (action 'best_effort_write', outcome 'failed') — the repair digest ranks the losses and the Exception Center sees them; converted first: the ISA outreach logger's four record writes (the EXACT writes pass 3 found silently failing) + the voice call ledger (open + close); the ISA's inbound-email reply now carries REAL conversation memory (the old context read messages by contact_id=leadId — always empty; it now merges isa_outreach_log sends + replied activities chronologically); the silencer population is FROZEN at ${SILENCER_BASELINE} (currently ${silencerCount}) — growth fails this check`,
        silencerCount <= SILENCER_BASELINE
        && src("lib/kernel/write-sentinel.ts").includes("best_effort_write")
        && src("lib/kernel/write-sentinel.ts").includes("recordSelfHeal")
        && src("lib/ai-isa/isa-outreach-logger.ts").includes("sentinelWrite")
        && src("lib/ai-isa/isa-outreach-logger.ts").includes("flow: 'isa_outreach_record'")
        && src("app/api/voice/twilio/inbound/route.ts").includes('flow: "voice_call_ledger"')
        && src("app/api/voice/twilio/turn/route.ts").includes('flow: "voice_call_ledger"')
        && src("app/actions/ai-isa/handle-inbound-email.ts").includes("DEAD READ REPLACED")
        && !src("app/actions/ai-isa/handle-inbound-email.ts").includes(".eq('contact_id', params.leadId)"))
      // ── SENTINEL OBSERVATION SURFACE + high-traffic conversions (the sentinel made watchable) ──
      const { composeSentinelLossReport } = await import("../lib/kernel/write-sentinel")
      const lossRpt = composeSentinelLossReport([
        { brokerage_id: "b1", detail: { flow: "deal_transparency_card", table: "transparency_updates", code: "23503", message: "fk" } },
        { brokerage_id: "b2", detail: { flow: "deal_transparency_card", table: "transparency_updates", code: "23503", message: "fk" } },
        { brokerage_id: "b1", detail: { flow: "isa_outreach_record", table: "isa_outreach_log", code: "23514", message: "check" } },
      ])
      check("SENTINEL OBSERVATION SURFACE (the write sentinel made watchable — a raw 'N failed' count is useless; the point is naming WHICH write rail loses rows and WHY): composeSentinelLossReport folds best_effort_write failures into ranked (flow, table, code) groups with a plain-language cause hint from the pg error code (23502 NOT NULL / 23503 FK / 23505 unique / 23514 CHECK), distinct-tenant counts, and a one-line headline; loadSentinelLosses reads the window; the weekly repair digest now speaks the top 3 write losses by rail+cause (not an anonymous veto count) and the superadmin Continuity Board renders a 'Silent write losses (7d)' card; the highest-traffic deal-VISIBILITY writes were converted to the sentinel so the observation is meaningful the moment traffic flows — the transparency card, portal chat and bell (whose own comments admit prior silent losses) plus the auto-enroll — and the silencer ratchet dropped 195→191",
        lossRpt.totalLosses === 3
        && lossRpt.distinctPaths === 2
        && lossRpt.groups[0].flow === "deal_transparency_card" && lossRpt.groups[0].count === 2 && lossRpt.groups[0].tenants === 2
        && lossRpt.groups[0].hint.includes("foreign key")
        && lossRpt.groups[1].hint.includes("CHECK")
        && lossRpt.headline.includes("worst: deal_transparency_card")
        && src("lib/kernel/repair-digest.ts").includes("loadSentinelLosses")
        && src("app/dashboard/superadmin/continuity/page.tsx").includes("Silent write losses")
        && src("lib/kernel/event-fanout.ts").includes('flow: "deal_transparency_card"')
        && src("lib/kernel/event-fanout.ts").includes('flow: "deal_transparency_bell"'))
      // ── PASS 10: UPSERT onConflict INTEGRITY + rpc EXISTENCE + phantom table ──
      check("PASS 10 — UPSERT onConflict INTEGRITY (every .upsert onConflict target must match a UNIQUE index or the write ERRORS on EVERY call — 'no unique or exclusion constraint matching the ON CONFLICT specification'): the live pg_index map cross-checked against every onConflict target found 21 broken upserts across the codebase, each erroring on 100% of calls. TWO fix classes: onConflict CORRECTED to an existing unique (agent_goals dropped the redundant brokerage_id; buyer_fatigue_scores → contact_id (now on the surviving fatigue-calculator); calendar_provider_accounts added brokerage_id; vendor_ratings → vendor_id; social_media_accounts both callers + platform_credentials idx-broker → their real owner/account-scoped uniques; open_house_invitations → event_id,contact_id,channel; agent_step_completions → agent_id,step_id) and UNIQUE INDEX CREATED where the onConflict cols ARE the business identity but the index was never migrated (call_analyses/call_transcriptions on voice_call_id, fatigue_alerts, market_data, neighborhood_reports, property_interests, timeline_transparency, transaction_milestones, website_visitors — l72-s07, zero live dupes). PHANTOM TABLE: the team-heatmap cron upserted to team_activity_snapshots — a table the code AND the schema-readiness route reference but that was never created (team_heatmap_snapshots is a different per-agent-per-zip shape) — created with its real (brokerage_id, snapshot_date) rollup shape + unique + RLS. user_invitations' only unique is a PARTIAL EXPRESSION index that a plain onConflict can't target → converted to an explicit find-pending→update-or-insert. RPC EXISTENCE: 22/23 rpc() names verified live; increment_knowledge_article_view was missing → created (SECURITY DEFINER, bumps knowledge_articles.view_count)",
        src("app/actions/ai-agent-goals.ts").includes('onConflict: "agent_id,year,goal_type"')
        // fatigue-scorer.ts was retired (a duplicate scorer whose risk vocabulary the
        // buyer_fatigue_scores CHECK rejected); the surviving calculator carries the
        // same corrected onConflict target.
        && src("lib/fatigue/fatigue-calculator.ts").includes('onConflict: "contact_id"')
        && src("app/actions/vendor-marketplace.ts").includes('onConflict: "vendor_id"')
        && src("app/actions/social-publishing.ts").includes('onConflict: "brokerage_id,platform,account_id"')
        && src("app/api/social/oauth/[platform]/route.ts").includes('onConflict: "brokerage_id,platform,account_id"')
        && src("app/dashboard/settings/integrations/idx-broker/page.tsx").includes('onConflict: "owner_id,owner_type,platform"')
        && src("app/actions/open-house.ts").includes('onConflict: "event_id,contact_id,channel"')
        && src("lib/kernel/calendar-sync.ts").includes('onConflict: "brokerage_id,provider_type,provider_account_id,user_id"')
        && src("lib/kernel/users.ts").includes("find-pending")
        && !src("lib/kernel/users.ts").includes('onConflict: "brokerage_id,email"'))
      // ── PASS 11: READ-FILTER id-CLASS (agents-FK column filtered by a users.id → silent EMPTY) ──
      check("PASS 11 — READ-FILTER id-CLASS (the silent-WRONG-RESULT class: a .eq('agent_id', userId) on a column that FKs agents(id) returns EMPTY, never errors — the query 'succeeds' with nothing). Live data settled the split-brain empirically: 100% of contacts.agent_id values are agents.id, 0% users.id (a stale code comment claimed the opposite). SEVEN flagship agent-facing surfaces were filtering agent-FK tables by the raw user.id and showing every agent ZERO of their own data: the AI chat context loader (contacts/transactions/leads/tasks) + its today's-appointments tool (showings/activities), the whole analytics dashboard (6 filters), the voice-admin command router (showings/contacts/transactions/tasks — the flagship 'what's on my plate' voice feature found nothing), the morning-standup 'what's my day' (contacts), the expenses page, and the chat-stream session access check (which 403'd users out of their OWN chat). All resolve users.id→agents.id via the canonical resolveAgentId with an honest fallback. VERDICT on the ~20 split-brain tables whose agent_id FKs users(id): those modules WRITE and READ the same class (e.g. the NPV scorer stores contact.agent_id and filters by it) — internally consistent, NOT read-filter bugs; the canonical .from('agents').eq('user_id', x) resolves are correct despite misleading param names",
        src("app/api/internal/ai-chat/route.ts").includes("resolveAgentId") && src("app/api/internal/ai-chat/route.ts").includes('.eq("agent_id", agentId)')
        && !src("app/api/internal/ai-chat/route.ts").includes('.eq("agent_id", userId)')
        && src("app/dashboard/analytics/page.tsx").includes('.eq("agent_id", agentId)')
        && !src("app/dashboard/analytics/page.tsx").includes('.eq("agent_id", user.id)')
        && src("app/api/internal/voice-command/route.ts").includes("voiceAgentId")
        && !src("app/api/internal/voice-command/route.ts").includes('.eq("agent_id", user.id)')
        && src("lib/kernel/morning-standup.ts").includes("standupAgentId")
        && src("app/dashboard/financials/expenses/page.tsx").includes("expenseAgentId")
        // #178 SUPERSEDED pass 11's fix here, so this clause pins the construct
        // rather than the local name pass 11 introduced. The chat-stream route
        // no longer takes a `userId` from the POST body at all: it resolves the
        // tenant from the SESSION (getAgentContext) and anchors the conversation
        // to it, which fixes the same "403'd out of your own chat" symptom by a
        // strictly stronger means — the body's id was also an IDOR. Asserting
        // `streamAgentId` would have gone red on that better code.
        && src("app/api/chat/stream/route.ts").includes("getAgentContext")
        && !src("app/api/chat/stream/route.ts").includes('.eq("agent_id", userId)'))

      // ── PASS 12: OWNER-CHALLENGED FINANCE + MARKETING IDENTITY DOUBLE-CHECK ──
      check("PASS 12 — FINANCE + MARKETING identity double-check (owner challenged pass 11: 'the user logs in by users.id and user_type routes the dashboard — are you sure?'). The login model was CONFIRMED (getAgentContext: auth.uid()=users.id → user_type routes → agents.id resolved via agents.user_id) and the double-check found NINE more genuine class bugs, all live-FK-verified. FINANCE: aiCalculateCommission looked up agents by user_id with an agents.id in hand (profile null → cap tracking NEVER engaged, cap_progress frozen) — now .eq('id', …); BOTH QuickBooks syncs resolved brokerage via users-by-agents.id (always null → sync permanently dead) — now via agents, and the commission sync was handed the kernel's camelCase result so every column read was undefined — now a real payload; the expenses page passed raw user.id into AddExpenseDialog + ExportCSVButton (kernel write gate ctx.agentId!==agentId REJECTED every agent's own expense; CSV exported empty) — now expenseAgentId; the brokerage P&L panel got users.id (financial_reports.agent_id FKs agents → insert FK-THREW) — now resolved+conditional. MARKETING: getMarketingStudioDashboard filtered marketing_campaigns/assets.agent_user_id (a USERS-class column, every insert stamps userId) with agents.id → 'yours' KPIs always empty — now userId; section-narration-orchestrator queried agent_voice_profiles/agent_avatar_assets (agents-FK) by pres.agent_user_id → every presentation lost its voice clone + avatar — now resolves like intro-video-reactor; video-identity loadHumanIdentity same class miss → resolves agents.id first; book-seller-appointment stamped calendar_events.agent_user_id (USERS-class: coaching + no-show autopilot key it on users) with agents.id — resolves before scheduling, and voice-assistant's get_schedule read the same column with agents.id → 'no appointments' every time — now caller.userId. CROSS: generateDailyBriefing receives MIXED classes from its 3 callers (agents.id from dashboard+cron, users.id from user-type-briefs) while writing ai_daily_briefings.user_id (users FK) and reading tasks/deals/leads/listings (agents FKs) — one tolerant resolve at the top now feeds each column its own class (the agents.id save path FK-THREW before: briefings regenerated + re-billed AI on every view); generateDailyGameplan filtered contacts + video_scripts_library (agents FKs) by users.id — now agentIdForUser; loadMortgageBrokers filtered referral_partners.agent_id (agents FK) by ctx.userId — now ctx.agentId",
        src("app/actions/ai-financial-management.ts").includes('.eq("id", params.agentId)')
        && !src("app/actions/ai-financial-management.ts").includes('.eq("user_id", params.agentId)')
        && src("app/actions/ai-financial-management.ts").includes('agent_id: params.agentId')
        && !src("app/actions/ai-financial-management.ts").includes('brokerage_id: expense.brokerage_id')
        && !src("app/actions/ai-financial-management.ts").includes('brokerage_id: commission.brokerage_id')
        && src("app/dashboard/financials/expenses/page.tsx").includes("<AddExpenseDialog agentId={expenseAgentId}")
        && src("app/dashboard/financials/expenses/page.tsx").includes("<ExportCSVButton agentId={expenseAgentId}")
        && src("app/dashboard/financials/brokerage/page.tsx").includes("brokerAgentId && <ProfitLossReportPanel")
        && src("app/actions/marketing-studio.ts").includes('.eq("agent_user_id", userId)')
        && !src("app/actions/marketing-studio.ts").includes('.eq("agent_user_id", agentId)')
        // WAS PINNED TO THE LITERAL `eq("user_id", pres.agent_user_id)` INLINE IN
        // THE ORCHESTRATOR, and went red when that line moved into the named
        // resolver `resolveAgentNarrationAssets` — i.e. it failed BECAUSE the
        // work finished, which is §2's waypoint trap. The two hand-rolled copies
        // of this lookup were merged onto one exported survivor (§1.1), and the
        // merged version is STRONGER than the line this used to match: it reads
        // the error on the agents lookup rather than treating a refused read as
        // "this agent has no voice clone" (§3 — supabase-js resolves refusals).
        //
        // So assert the RULE the clause was always about: the presentation
        // crosses users -> agents FIRST, and then keys the two agents-FK asset
        // tables by that agents id — never by the users-class agent_user_id,
        // which is the miss that cost every presentation its voice and avatar.
        && /\.from\("agents"\)\s*\.select\("id"\)\.eq\("user_id",\s*agentUserId\)/.test(
             stripComments(src("lib/listing-presentation/section-narration-orchestrator.ts")).replace(/\s*\n\s*/g, ""))
        && /from\("agent_voice_profiles"\)[\s\S]{0,120}\.eq\("agent_id", agentId\)/.test(
             stripComments(src("lib/listing-presentation/section-narration-orchestrator.ts")))
        && /from\("agent_avatar_assets"\)[\s\S]{0,160}\.eq\("agent_id", agentId\)/.test(
             stripComments(src("lib/listing-presentation/section-narration-orchestrator.ts")))
        && !/agent_voice_profiles[\s\S]{0,120}\.eq\("agent_id",\s*\w*[aA]gent_?[uU]ser_?[iI]d\)/.test(
             stripComments(src("lib/listing-presentation/section-narration-orchestrator.ts")))
        && src("lib/video/video-identity.ts").includes("agentRecordId")
        // m362: this froze `agentId: agentUserId ?? params.agentId` — a resolved
        // USERS id falling back to the AGENTS id it was resolved FROM, on the
        // column pass 12 itself identified as users-class. Assert the resolve
        // and the refusal, not the expression that undid them.
        && src("lib/ai-isa/book-seller-appointment.ts").includes("agentId: agentUserId,")
        && src("lib/ai-isa/book-seller-appointment.ts").includes("the appointment was not scheduled")
        && src("app/actions/voice-assistant.ts").includes("getTodayAppointments(caller.userId)")
        && src("lib/intelligence/daily-briefing-generator.ts").includes("const briefingUserId = identityRow?.user_id ?? agentId")
        && src("lib/intelligence/daily-briefing-generator.ts").includes("user_id: briefingUserId")
        && src("app/actions/copilot.ts").includes("gameplanAgentId")
        // m361: this assertion used to encode `.eq("agent_id", ctx.agentId ?? ctx.userId)`
        // as the FIXED state. Pass 12's own note says the fix was "now ctx.agentId" —
        // but the code it froze kept the `?? ctx.userId` fallback, so the guard
        // protected the anti-pattern it was written to remove. referral_partners
        // .agent_id FKs agents; a users id there matches nothing. Same shape as the
        // `.or(id.eq,user_id.eq)` assertion m346 had to unwind.
        //
        // ...and then m361's replacement froze the next spelling, `?? ""`, which is
        // the SAME class of mistake one step down: WriteContext.agentId is null for
        // broker/admin/TC sessions, and `?? ""` turns "I have no agent" into a filter
        // that matches nothing, so those roles read "this brokerage has no lenders".
        // A silent zero is not better than a wrong row. So assert the CONSTRUCT this
        // has always been about — the filter is agents-class with NO users fallback,
        // and the absent case is REFUSED rather than coerced — never the spelling.
        && src("app/actions/buyer-financial.ts").includes('.eq("agent_id", ctx.agentId)')
        && !/\.eq\("agent_id", ctx\.agentId \?\?/.test(src("app/actions/buyer-financial.ts"))
        && !src("app/actions/buyer-financial.ts").includes('.eq("agent_id", ctx.userId')
        && /if \(!ctx\.agentId\)[\s\S]{0,400}success: false/.test(src("app/actions/buyer-financial.ts")))

      // ── PASS 13: GLOBAL agent_user_id CLASS AUDIT + CAP-LEDGER CONSOLIDATION + E2E-IN-GUARD ──
      {
        // The class-crossing shape: an agents-FK row field stamped straight into a
        // users-class agent_user_id column. Live DB proof: ALL 36 agent_user_id
        // columns are users-class. Zero of these may exist anywhere in app/ or lib/.
        const crossers: string[] = []
        const scan13 = (rel: string) => {
          const text = readFileSync(join(ROOT, rel), "utf-8")
          for (const m of text.matchAll(/agent_user_id:\s*(listing|contact|lead|txn|transaction)(\??)\.agent_id/g)) {
            crossers.push(`${rel}: agent_user_id ← ${m[1]}.agent_id`)
          }
        }
        for (const rel of REPO_TS_FILES) scan13(rel)
        check(`PASS 13 — GLOBAL agent_user_id CLASS AUDIT (items 1-3 approved after pass 12). Live census: ALL 36 agent_user_id columns are USERS-class (30 FK users, 6 no-FK same convention) — so the global rule is simple: agent_user_id never meets an agents.id. The sweep found the filters CLEAN (50/50 users-class) and SIX class-crossing STAMPS, each FK-throwing in production: the 'offer received' activity (listing.agent_id), EVERY buyer fatigue alert (contact.agent_id), promote-to-asset in the campaign registry (getAgentContext agents.id), the CMA presentation + net-sheet events AND the net-sheet's users-table brokerage lookup (presentation tab passes listing.agent_id — net sheets errored outright), the auto-on-live listing packet job, and the brand-voice agent profile read (agents-FK filtered by users.id). BONUS CATCH: aiGenerateClosingChecklist wrote FIVE PHANTOM COLUMNS (agent_user_id/phase/item_label/owner/due_date don't exist on closing_checklist_items) — every checklist generate THREW and the tab rendered the same phantom fields; both now speak the live schema (item_name/category/notes with owner+due embedded). CONSOLIDATION (item 2): agent_cap_tracking is the ONE cap ledger (CapProgressBar, CDA portal, waterfall, kernel) — aiCalculateCommission now reads it and its parallel agents.cap_progress ratchet is REMOVED (the kernel owns the ratchet). E2E-IN-GUARD (item 3): the lifecycle harness rides the guard chain, credential-gated. MANAGER COVERAGE: all 14 managers own ≥1 maintenance domain, zero domains point at unknown managers. SINCE-THEN: the 'offer received' fix's host function (ai-offer-creation.ts:submitCompleteOffer) was deleted as a duplicate offer writer — survivor app/actions/buyer-offers.ts:createOffer — so this pass now asserts the class through the global sweep plus the surviving listing-side notification, not through the vanished line. In-code sweep offenders now: [${crossers.join("; ") || "none"}]`,
          crossers.length === 0
          // The 'offer received' stamp this pass fixed lived inside
          // ai-offer-creation.ts:submitCompleteOffer, which has since been
          // DELETED as a duplicate offer writer (survivor:
          // app/actions/buyer-offers.ts:createOffer). The clause used to freeze
          // that function's resolve line, so the deletion read as a regression.
          // What the pass is actually about survives in two places and both are
          // asserted instead of the vanished spelling: the global `crossers`
          // sweep above still forbids `agent_user_id ← listing.agent_id`
          // ANYWHERE in app/ or lib/, and the surviving listing-side
          // notification (offer-form-wizard.tsx:notifyListingSide) writes the
          // agents-class column with the agents-class id AND supplies the
          // NOT NULL tenant the deleted copy omitted.
          && !src("app/actions/ai-offer-creation.ts").includes("export async function submitCompleteOffer")
          && src("app/actions/ai-offer-creation.ts").includes("app/actions/buyer-offers.ts:createOffer")
          && src("app/crm/contacts/[contactId]/offers/components/offer-form-wizard.tsx").includes("agent_id:      listingRow.agent_id")
          && src("app/crm/contacts/[contactId]/offers/components/offer-form-wizard.tsx").includes("brokerage_id:  brokerageId")
          && src("lib/fatigue/fatigue-calculator.ts").includes("fatigueAgentUserId")
          && src("lib/marketing/campaign-registry.ts").includes("agent_user_id: userId")
          && src("app/actions/cma-presentation/presentation-assembler.ts").includes("presAgentUserId")
          && !src("app/actions/cma-presentation/presentation-assembler.ts").includes("agent_user_id: input.agentId")
          && src("app/actions/cma-presentation/net-sheet-calculator.ts").includes("nsAgentUserId")
          && !src("app/actions/cma-presentation/net-sheet-calculator.ts").includes("agent_user_id: input.agentId")
          && src("app/actions/ai-listing-packet.ts").includes("packetAgentUserId")
          && src("app/actions/ai-closing-workflow.ts").includes("item_name:")
          && !src("app/actions/ai-closing-workflow.ts").includes("agent_user_id:")
          && !src("app/actions/ai-closing-workflow.ts").includes("item_label")
          && src("app/crm/components/closing-workflow-tab.tsx").includes("ownerFromNotes")
          && src("app/actions/social/generate-social-post.ts").includes("bvpAgentRow")
          && src("app/actions/ai-financial-management.ts").includes("agent_cap_tracking")
          && !src("app/actions/ai-financial-management.ts").includes("cap_progress")
          && src("package.json").includes("npm run test:e2e-lifecycle"))
      }

      // ── PASS 14: PHANTOM-COLUMN + PHANTOM-TABLE ZERO-ZERO (approved item 4) ──
      check("PASS 14 — PHANTOM-COLUMN SWEEP TO ZERO-ZERO. The closing-checklist escape route was the schema-drift guard's blind spot: `.insert(rows)` where rows is a VARIABLE (const rows = items.map(item => ({…}))) and `.insert([{…}])` array literals were never key-checked. The guard now resolves BOTH shapes (resolveVariableInsertKeys: const-object / const-array / .map+.flatMap arrow-object / .push — nearest same-named definition wins so cross-function bleed can't false-positive) and the FIRST run caught 18 real violations in 8 files: assistant.ts suggestions wrote user_id/context_id/action_payload (live: agent_id/metadata/action_payload_json — every smart suggestion insert errored); blog drafts wrote compliance_approved (live: approval_status); the knowledge-base client wrote+rendered topic_category (live: category); ai-contract-review wrote transaction_tasks.agent_id/source (live: assigned_user_id/category — critical-issue tasks never landed); ai-voice-transcription wrote tasks.agent_id/source_id with NO brokerage_id (live: assigned_to_agent_id, NOT-NULL brokerage — call-analysis tasks never landed); the podcast preset publisher wrote episode_id/status (live: podcast_episode_id/channel_name/distribution_status — every preset publish errored); and the daily briefing wrote overnight_ai_work which NEVER EXISTED — the pass-12 save fix was still dead; l72_s08 adds the column the feature was written for. PHANTOM TABLES: 13 of 14 acknowledged-unguarded tables DON'T EXIST in the live schema — every consumer repointed to its canonical home or deleted after dependency investigation: compliance audits page → audit_log (real ledger, same fields); partner referral panel → referrals+referral_partners; guardContent → approval_items; voice property-share + referral-ask drafts → activities; journey task submissions → client_portal_activity (its own former 'fallback' was the only path that ever worked — promoted, keep-one); market-shift predictions → trend_alerts; education downloads metric → document_downloads; suggestion outcomes fold onto smart_assistant_suggestions; market_reports/neighborhood_guides dead writes/reads removed; deprecated _legacyGenerateAICMA + orphan logCreditConversation deleted. RATCHET AT ZERO-ZERO: schema-drift baseline = 0 violations AND unguarded baseline = 0 tables — every table the code touches is column-guarded against the live snapshot, and any new phantom column OR unguarded table fails CI",
        src("scripts/schema-drift-guard.ts").includes("resolveVariableInsertKeys")
        && src("scripts/schema-drift-guard.ts").includes("flatMap")
        && src("scripts/schema-drift-guard.ts").includes("NEAREST same-named definition wins")
        && readFileSync(join(ROOT, "scripts/schema-drift-baseline.json"), "utf-8").trim() === "[]"
        && readFileSync(join(ROOT, "scripts/schema-drift-unguarded-baseline.json"), "utf-8").trim() === "[]"
        && src("app/compliance/audits/page.tsx").includes("from('audit_log')")
        && src("app/dashboard/partners/components/os/referral-tracking-panel.tsx").includes('from("referrals")')
        && src("lib/content-guardian/index.ts").includes('from("approval_items")')
        && src("app/actions/journey-tasks.ts").includes("client_portal_activity")
        && !src("app/actions/journey-tasks.ts").includes('from("task_submissions")')
        && src("app/actions/assistant.ts").includes("action_payload_json")
        && src("app/actions/ai-voice-transcription.ts").includes("assigned_to_agent_id")
        && src("lib/podcast/orchestrate-podcast-preset-publish.ts").includes("podcast_episode_id:")
        && src("lib/intelligence/daily-briefing-generator.ts").includes("overnight_ai_work"))

      // ── THE SPOKEN ACTION RECEIPT (approved item 2) ──
      {
        const { composeSpokenAiReceipt } = await import("../lib/intelligence/spoken-ai-receipt")
        const spoken = composeSpokenAiReceipt({
          overnight: { noshows_to_rebook: 1, reels_awaiting_approval: 2, sentinel_escalations: 0, summary_line: "" },
          isaHandoffs: 2, isaOutreach: 5, draftsStaged: 3, windowLabel: "the last 24 hours",
        })
        const empty = composeSpokenAiReceipt({ overnight: null, isaHandoffs: 0, isaOutreach: 0, draftsStaged: 0, windowLabel: "the last 24 hours" })
        check("SPOKEN ACTION RECEIPT (item 2) — the voice admin answers 'what did you do?' from the REAL ledgers (overnight autonomous systems + ISA handoffs + outreach + staged drafts — the same rows the morning briefing reads), composed by a PURE fold the sim exercises directly: a busy day speaks handoffs-first with drafts and re-books in one natural sentence; a quiet day is an HONEST 'nothing to report', never invented work. Wired as a first-class voice intent ('what did you do' / 'daily receipt' / 'while I was out' / 'AI report') in the voice admin's command router",
          spoken.includes("2 leads") && spoken.includes("3 message drafts") && spoken.includes("1 missed appointment")
          && empty.startsWith("Nothing to report")
          && src("app/actions/voice-assistant.ts").includes('"ai_work_receipt"')
          && src("app/actions/voice-assistant.ts").includes("composeSpokenAiReceipt"))
      }

      // ── THE LIFETIME VALUE RECEIPT (approved item 1) + RUNTIME DRIFT TWIN (approved item 3) ──
      {
        const { composeLifetimeValueReceipt } = await import("../lib/contacts/provenance-receipt")
        const rich = composeLifetimeValueReceipt({
          originSource: "expired_listing_scrape", originAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
          loggedTouches: 42, isaOutreach: 11, frontierStories: 9, closedDeals: 2, earnedGci: 21400,
        })
        const empty = composeLifetimeValueReceipt({
          originSource: null, originAt: null, loggedTouches: 0, isaOutreach: 0, frontierStories: 0, closedDeals: 0, earnedGci: null,
        })
        const { composeSentinelLossReport, isRuntimeDriftLoss } = await import("../lib/kernel/write-sentinel")
        const driftReport = composeSentinelLossReport([
          { brokerage_id: "b1", detail: { flow: "hotfix_flow", table: "some_table", code: "42703", message: "column x does not exist" } },
          { brokerage_id: "b1", detail: { flow: "hotfix_flow", table: "some_table", code: "42703", message: "column x does not exist" } },
          { brokerage_id: "b2", detail: { flow: "other_flow", table: "other_table", code: "23505", message: "duplicate" } },
        ] as any)
        check("LIFETIME VALUE RECEIPT (item 1) + RUNTIME DRIFT TWIN (item 3) — scrape-to-lifetime provenance every point-solution CRM structurally lacks: one honest sentence per contact ('Found via expired listing scrape 13 months ago — the OS has logged 42 touches… producing 2 closed deals and $21,400 GCI') composed by a PURE fold over the REAL ledgers (contacts/leads origin, activities, isa_outreach_log, frontier-story rationale tags, agent_commissions on closed deals — never transactions math, never invented dollars: unknown origin stays 'Origin unrecorded', zero history stays 'no AI touch history recorded yet'). WIRED end-to-end: loadContactProvenanceFacts → getContactBrief.provenanceLine → the /api/contacts/[id]/brief route → PreCallBriefCard renders it before every call. THE RUNTIME DRIFT TWIN closes the last unwatched drift direction: CI holds CODE at the zero-zero baseline, but a hotfix migration can drift the DATABASE — those failures land on the write-sentinel ledger as 42703/42P01/PGRST204/205, which composeSentinelLossReport now classifies as RUNTIME SCHEMA DRIFT (isRuntimeDriftLoss), leads the repair digest with a regenerate-the-snapshot instruction, and flags the headline",
          rich.line.includes("Found via expired listing scrape") && rich.line.includes("42 logged touches")
          && rich.line.includes("$21,400 GCI") && rich.line.includes("2 closed deals")
          && empty.line.startsWith("Origin unrecorded") && empty.line.includes("no AI touch history")
          && isRuntimeDriftLoss("42703") && isRuntimeDriftLoss("PGRST204") && !isRuntimeDriftLoss("23505")
          && driftReport.runtimeDriftLosses === 2 && driftReport.runtimeDriftGroups.length === 1
          && driftReport.headline.includes("RUNTIME SCHEMA DRIFT")
          && src("lib/contacts/contact-brief.ts").includes("provenanceLine")
          && src("app/components/dashboard/voice/PreCallBriefCard.tsx").includes("provenanceLine")
          && src("lib/kernel/repair-digest.ts").includes("RUNTIME SCHEMA DRIFT"))
      }

      // ── PROVENANCE ROLLUP → QBR + RECRUITING PITCH (approved item 2) + GOLDEN-PATH DRILL (item 3) ──
      {
        const { composeAgentValueRollup } = await import("../lib/contacts/provenance-receipt")
        const selling = composeAgentValueRollup({ osFoundRelationships: 14, closedDeals: 3, aiSourcedGci: 42500 }, "this quarter")
        const honest = composeAgentValueRollup({ osFoundRelationships: 0, closedDeals: 0, aiSourcedGci: null }, "this quarter")
        check("PROVENANCE ROLLUP → QBR + RECRUITING PITCH (item 2) + COLD-TENANT GOLDEN-PATH DRILL (item 3). The per-contact Lifetime Value Receipt folds brokerage-wide into THE selling stat: 'The AI pipeline sourced 14 relationships that closed 3 deals worth $42,500 GCI this quarter — measured on the operating ledger, not estimated' (PURE composeAgentValueRollup, exercised here; honest NULL when the pipeline hasn't produced — a sales document never fabricates). WIRED on both sell surfaces: the QBR (QuarterFacts.aiSourcedLine → outcomes; and a keep-one CATCH — velocityLine was computed by the loader but NEVER PASSED to the composer, so the deal-velocity stat silently never reached a QBR; both now threaded) and the recruiting pitch kit ('What the AI pipeline has already produced' section, 12-month window, best-effort). THE DRILL (item 3) ran the whole platform→subscriber→user chain on a COLD tenant live: fresh brokerage → users row (user_type routes 'agent') → agents row; identity chain resolved (getAgentContext predicates); full journey lead(scrape-sourced)→contact→closed deal→commission→cross-domain ledgers (activities/lifecycle/calendar-by-users.id); read-backs proved id-classes (agents.id finds the book, users.id finds nothing); and the item-2 rollup live-fired on the drill tenant (1 relationship → 1 deal → $15,000 GCI); ten-table teardown to residue 0",
          selling !== null && selling.includes("14 relationships") && selling.includes("3 deals") && selling.includes("$42,500 GCI")
          && honest === null
          && src("lib/intelligence/quarterly-review.ts").includes("aiSourcedLine")
          && src("lib/intelligence/quarterly-review-loader.ts").includes("loadBrokerageProvenanceRollup")
          && src("lib/intelligence/quarterly-review-loader.ts").includes("velocityLine,")
          && src("lib/recruiting/recruiting-pitch-kit.ts").includes("aiSourcedLine")
          && src("lib/recruiting/recruiting-pitch-kit.ts").includes("What the AI pipeline has already produced"))
      }

      // ── PASS 15: ASSET + RECRUITING + ACADEMY DOMAIN DRILL (owner-directed) ──
      {
        const { toLibraryScriptType } = await import("../app/types/video-generation")
        check("PASS 15 — ASSET / RECRUITING / ACADEMY DOMAIN DRILL (owner: 'identities and data flow correctly; academy on-demand works'). METHOD: manager table inventory (34 asset + 61 recruiting tables from TABLE_MANAGER) → live FK census → code sweep → seeded live-fire of each COMPLETE flow → residue 0. FK census: academy (agent_courses/quiz_attempts/step_completions/ce_completions → agents; learning_assignments.agent_user_id → users) · recruiting (mentor/mentee/recruited_agent_id/leaderboard/points → agents) · assets (video_assets/content/scripts/completion_tracking → agents; studio_sessions + created_by → users). CODE SWEEP verdicts: recruiting CLEAN (zero class-crossings); assets + academy writers use getAgentContext/resolveAgentId correctly — THREE genuine bugs found and fixed: (1) the onboarding PERFORMANCE REPORT route filtered agent_onboarding + video_completion_tracking + agent_quiz_attempts (all agents-FK) with raw user.id — every agent's report read zeros → resolveAgentId; (2) skill-freshness radar AND board read the coursework signal from the write-dead agent_courses (never written by any runtime code → the signal was empty forever) → RE-POINTED onto the canonical learning_assignments rail (agent-side completed modules, status='completed' + quiz_score) so a completed Academy module is a real freshness signal; the legacy agent_courses/training_courses/training_course_steps spine was then physically retired (see legacy_tables_retired); (3) video_scripts_library.script_type CHECK admits ONLY five canonical types but THREE writers bypassed the one mapper — generateVideoFromScript wrote literal 'video' (every script record silently unpersisted, error only console.warned), generate-script wrote raw videoType ('listing_tour'/'custom' → 23514, saveToLibrary silently dead), and the mapper itself was file-local in video-content — KEEP-ONE: toLibraryScriptType exported from the types module, all three writers ride it. LIVE-FIRE (residue 0): academy on-demand (course→module→assignment-by-users.id→PASSED completion; fixed read=1, phantom 'completed' read=0), recruiting (recruit→hired analytics; pitch-kit ROI predicate found 1 agent/$18,500), assets (training video→canonical script→asset→100% completion; /api/videos agents.id predicate=1; fixed report read=1, old users.id read=0)",
          toLibraryScriptType("listing_tour") === "property_tour"
          && toLibraryScriptType("custom") === "property_tour"
          && toLibraryScriptType("presentation_chapter") === "listing_presentation"
          && src("app/api/onboarding/performance-report/route.ts").includes("resolveAgentId")
          && src("lib/education/skill-freshness-radar.ts").includes('from("learning_assignments")')
          && src("lib/education/skill-freshness-radar.ts").includes('.eq("status", "completed")')
          && src("lib/intelligence/skill-freshness-board.ts").includes('.eq("status", "completed")')
          && !src("lib/education/skill-freshness-radar.ts").includes('from("agent_courses")')
          && src("app/actions/video-generation.ts").includes('toLibraryScriptType("custom")')
          && src("app/actions/video/generate-script.ts").includes("toLibraryScriptType(params.videoType)")
          && src("app/actions/video-content.ts").includes("toLibraryScriptType(params.video_type)")
          && !src("app/actions/video-generation.ts").includes('script_type: "video"'))
      }

      // ── INTEGRATION GUARDIAN COVERAGE (owner's spec) + PASS 16 + ACADEMY→BRIEFING LOOP ──
      {
        const { PLATFORM_PROVIDER_KEYS, PROBE_SPECS } = await import("../lib/agentic-os/connector-probe")
        check("INTEGRATION GUARDIAN COVERAGE AUDIT (owner's Integration-Guardian/Provider-Specialist spec) + PASS 16 + ACADEMY→BRIEFING. AUDIT VERDICT: the spec's architecture ALREADY EXISTS — connector_health_log (DriftIncident), connector_healing_proposals (RepairProposal, AI healer w/ doc search = the Provider Specialist), connector_shape_memory (schema history), ingress_dead_letters (replay), probeConnector (canary probes), pending-proposal dedup + starvation-fair healing. Stripe AND QuickBooks were already probed (PROBE_SPECS). THE GAPS, NOW CLOSED: (1) platform-keyed providers (Lob, ElevenLabs, D-ID, RentCast — env keys serving EVERY tenant) had no probe and an expired platform key was invisible until a tenant's send/render failed → four new probes + four auth styles (basic_key_only/basic_raw_key/xi-api-key/X-Api-Key) + PLATFORM_PROVIDER_KEYS probed once per guardian run, failures ledgered platform-scoped on self_heal_events (the digest's rail); BatchData intentionally exempt (POST-only, pull-drift sentinel covers it). (2) quickbooks_sync_log rows stuck 'in_progress' >24h were an UNWATCHED silent-gap (the spec's headline failure class) → the guardian cron now sweeps them per tenant onto the health log as 'silent_gap' (added to the ATTENTION set → feeds the AI healer + superadmin board); predicate live-proven on a seeded 30h-stuck row, residue 0. PASS 16 (approved item 1): the writer-less read sweep — RIGHT queries over data that can NEVER exist (the skill-freshness/neighborhood_guides class) — ships as scripts/writerless-read-sweep.ts on the guard chain: 642 read tables, 632 with runtime writers, 66 writer-less reads baselined as a burn-down; NEW ones fail CI. ACADEMY→BRIEFING (approved item 3): a stale skill (same signals as the radar — objection drills, quizzes, PASSED courses via loadAgentSkillFreshness) surfaces as a low-priority 'sharpen' action in the morning briefing pointing at the on-demand academy; honest-quiet when sharp or unproven",
          // (round 9 added newsapi_ai — the news/semantics platform key gets a canary.
          //  round 12 added web_push — VAPID keys registered, no GET probe: like
          //  Exa/BatchData it has no probeable endpoint, covered by delivery telemetry.)
          Object.keys(PLATFORM_PROVIDER_KEYS).sort().join(",") === "did,elevenlabs,lob,newsapi_ai,rentcast,web_push"
          && !!PROBE_SPECS.lob && !!PROBE_SPECS.elevenlabs && !!PROBE_SPECS.did && !!PROBE_SPECS.rentcast
          && !!PROBE_SPECS.stripe && !!PROBE_SPECS.quickbooks
          && src("app/api/cron/connector-health/route.ts").includes("PLATFORM_PROVIDER_KEYS")
          && src("app/api/cron/connector-health/route.ts").includes('"silent_gap"')
          // (round 3 evolved the watch: quickbooks_sync_log was retired as a
          // fake-writer twin — the SAME silent-gap class now sweeps the ONE
          // ledger, accounting_sync_log.)
          && src("app/api/cron/connector-health/route.ts").includes("SILENT-GAP WATCH")
          && src("scripts/writerless-read-sweep.ts").includes("GUARD_WRITE_BASELINE")
          && src("package.json").includes("test:writerless-reads")
          && src("lib/education/skill-freshness-radar.ts").includes("loadAgentSkillFreshness")
          && src("lib/intelligence/daily-briefing-generator.ts").includes("Sharpen a stale skill"))
      }

      // ── WRITER-LESS BURN-DOWN, ROUND 1 (66 → 54) ──
      check("WRITER-LESS BURN-DOWN ROUND 1 (owner: 'if the feature isn't built, finish the build'). Deep writer-hunt across app+lib+supabase confirmed 65 of 66 truly writer-less; live classification split them honestly: SIX are DB VIEWS (written through base tables — new DB_VIEWS exempt category), TWO are live-seeded config (plan_limits 68 rows, state_compliance_requirements 76 — added to SEEDED_REFERENCE), and ONE was a pass-14-class phantom: video_branding_presets was DROPPED live in l38-s01 (HeyGen purge) yet the video-create client still queried it (erroring on every page load) AND the schema snapshot still listed it — dead read removed (resolveReelBrand is the one brand source per the registry), snapshot entry dropped. THREE FEATURES FINISHED (the builds): (1) listing_price_changes — the seller portal's price-history read had NO writer; updateListing now ledgers every price change (old/new/reason/effective date, best-effort, listing_id NOT-NULL respected); (2)+(3) the DEAL-HEALTH PAGE charted nothing forever — deal_health_factors + deal_health_snapshots were read-only; the health scorer now persists per-component factor rows (live-fire caught that the factor_type CHECK speaks a DIFFERENT vocabulary than the scorer's categories — canonical FACTOR_TYPE map added BEFORE the write ever shipped, original category kept in detail, which live-fire also proved is a TEXT column needing explicit stringify) and snapshots the time-series point when the score moves or the last point is >20h stale. Baseline 66 → 54; every remaining entry is a recorded burn-down item",
        src("scripts/writerless-read-sweep.ts").includes("DB_VIEWS")
        && src("scripts/writerless-read-sweep.ts").includes('"plan_limits"')
        && !src("app/dashboard/videos/create/video-create-client.tsx").includes('from("video_branding_presets")')
        && !src("scripts/schema-snapshot.ts").includes("video_branding_presets")
        && src("app/actions/listings.ts").includes('from("listing_price_changes")')
        && src("lib/deal-health/health-scorer.ts").includes("deal_health_factors")
        && src("lib/deal-health/health-scorer.ts").includes("deal_health_snapshots")
        && src("lib/deal-health/health-scorer.ts").includes("FACTOR_TYPE")
        && src("lib/deal-health/health-scorer.ts").includes("JSON.stringify({ issues: c.issues, category: c.category })")
        // Monotone burn-down: later rounds only ever shrink the baseline.
        && JSON.parse(readFileSync(join(ROOT, "scripts/writerless-read-baseline.json"), "utf-8")).length <= 45)

      // ── WRITER-LESS BURN-DOWN, ROUND 2 (54 → 45): FINANCIALS + PRESETS ──
      check("WRITER-LESS BURN-DOWN ROUND 2 (approved campaigns 1+2). FINANCIALS: the BROKER'S MONEY PAGE read brokerage_earnings (mtd/ytd KPIs, 12-month trend, forecast proxy) and brokerage_p_l — writer-less, so every broker's P&L dashboard rendered zeros forever. runBrokerageEarningsRollup now rides the nightly brokerage-pl-rollup cron, folding the SAME canonical agent_commissions source as the per-agent and team snapshots so all three altitudes reconcile exactly; operating-expense lines stay honest-NULL (no ledger source — never fabricated) and net_profit is the provable brokerage-side number. LIVE-FIRE CAUGHT A DOUBLE-SIDED VOCABULARY BUG: brokerage_earnings.period_type CHECK admits monthly/quarterly/annual, but the PAGE read 'mtd'/'ytd' — values that can never exist (the reader itself was phantom-vocabulary). Writer writes monthly/annual; all three reader files fixed to match. Delete-then-insert per tenant (pass-10 rule: no onConflict without a real unique). PRESETS: seven campaign-bundle preset shelves (email/sms/voicedrop/social/portal-push/podcast/ad-retarget) were READ by the bundle dispatcher with NO writer — upsertCampaignPreset is the ONE canonical writer for all seven channels, mirroring the direct-mail preset discipline exactly (tenant-guarded, scope-anchored — scope_id NOT-NULL live-caught, compliance-GATED at save time on every content-carrying channel via evaluateOutbound, field whitelist so caller input never spreads into rows). Sweep learns VARIABLE_TABLE_WRITERS (auditable exemptions naming the writer module). Baseline 54 → 45; remaining campaigns: legacy twins + ingress-expected",
        src("lib/finance/brokerage-earnings-writer.ts").includes("runBrokerageEarningsRollup")
        && src("lib/finance/brokerage-earnings-writer.ts").includes('period_type: "monthly"')
        // Scoped to the brokerage_earnings CHAINS, not the whole file: the same
        // page also reads team_earnings, whose vocabulary really is
        // (mtd|ytd|all_time). A blanket !includes('"mtd"') here forbade a value
        // that is correct for the sibling table — and it fired the moment
        // team_earnings was fixed off its own phantom 'monthly'.
        && !fromWindows(src("app/dashboard/financials/brokerage/page.tsx"), "brokerage_earnings")
             .some((w) => w.includes('"mtd"') || w.includes('"ytd"'))
        && src("app/dashboard/financials/brokerage/page.tsx").includes('.eq("period_type", "monthly")')
        && src("app/api/cron/brokerage-pl-rollup/route.ts").includes("runBrokerageEarningsRollup")
        && src("app/actions/campaign-presets.ts").includes("CHANNEL_TABLE")
        && src("app/actions/campaign-presets.ts").includes("evaluateOutbound")
        && src("app/actions/campaign-presets.ts").includes("input.scopeId ?? ctx.brokerageId")
        && src("scripts/writerless-read-sweep.ts").includes("VARIABLE_TABLE_WRITERS"))
    }
    // ── SCOPED EXPENSES + PRESET EXPANSION (owner directive) ──
    {
      check("ALL-SCOPE EXPENSE ENTRY + CAMPAIGN PRESET EXPANSION (owner directive). EXPENSES: business_expenses gains team_id (l72_s10) with scope semantics agent_id=agent / team_id=team / neither=brokerage; logScopedExpense is the ONE writer for all three scopes (tenant-anchored, team verified against the brokerage, brokerage scope admin-gated) and the broker money page gains the entry section + recent-operating-expenses list. The monthly P&L rollup now FOLDS the month's non-agent expenses into brokerage_p_l buckets by category (marketing/office/technology→tech, rest→operating) and subtracts from net_profit — a tenant with zero logged rows keeps honest-NULL buckets (untracked ≠ $0), so the Margin Breakdown expense lines are finally real without ever being fabricated. PRESETS: the canonical preset writer gains blog_post + facebook_audience channels writing their CANONICAL homes (blog_posts / facebook_custom_audiences — keep-one, never parallel preset tables), podcast presets carry tts_script + voice_id_override (gated like voicedrop), ads carry ad_video_url, email + sms carry video_url — all five columns live-fired and snapshot-guarded. LIVE-FIRE CAUGHT: email_presets.body_html is NOT NULL — plain-text callers (the quick-preset UI) now get a derived HTML twin instead of a day-1 insert failure",
        src("app/actions/financials.ts").includes("logScopedExpense")
        && src("app/actions/financials.ts").includes("forbidden_brokerage_scope")
        && src("app/actions/financials.ts").includes("team_not_in_brokerage")
        && src("app/dashboard/financials/brokerage/page.tsx").includes("ScopedExpenseEntry")
        && src("app/dashboard/financials/brokerage/scoped-expense-entry.tsx").includes("logScopedExpense")
        && src("lib/finance/brokerage-earnings-writer.ts").includes('.is("agent_id", null)')
        && src("lib/finance/brokerage-earnings-writer.ts").includes("tracked ? bucket.marketing : null")
        && src("app/actions/campaign-presets.ts").includes('"blog_post" | "facebook_audience"')
        && src("app/actions/campaign-presets.ts").includes("facebook_custom_audiences")
        && src("app/actions/campaign-presets.ts").includes("tts_script")
        && src("app/actions/campaign-presets.ts").includes("ad_video_url")
        && src("app/actions/campaign-presets.ts").includes("content.body_html")
        && src("app/settings/campaign-bundles/client.tsx").includes("QP_MEDIA_FIELD")
        && src("app/settings/campaign-bundles/client.tsx").includes("facebook_audience")
        && src("scripts/schema-snapshot.ts").includes('"receipt_url", "team_id"'))
    }
    // ── BURN-DOWN ROUND 3 + BOOK-BOUNDARY CORRECTIONS + THE ONE ACCOUNTING EGRESS ──
    {
      const baseline3 = JSON.parse(src("scripts/writerless-read-baseline.json")) as string[]
      check("BURN-DOWN ROUND 3 (45 → 32) + OWNER CORRECTIONS + ACCOUNTING EGRESS KEEP-ONE. BOOK BOUNDARY: team financials do NOT roll up to brokerage — the P&L expense fold now requires agent_id NULL AND team_id NULL (team expenses stay on the team's book; UI copy says so). NEWSLETTER became a preset channel writing its CANONICAL home newsletter_campaigns (live CHECKs: status draft, approval_status draft, agent_id AGENTS-class). ACCOUNTING: quickbooks_sync_log was a fake-writer twin — ai-financial-management logged 'in_progress' rows and returned synced:true WITHOUT calling Intuit (the permanent silent-gap source). lib/finance/accounting-egress.ts is now the ONE egress (buildQuickBooksForBrokerage moved from the action, QBO Purchase entity for expenses, tax_categories.provider_account_id is the ONLY account mapping — unmapped fails honestly, never a fabricated ledger account); commissions push real invoices; brokerage-scope logScopedExpense rides it best-effort; the silent-gap watch repointed to accounting_sync_log (whose CHECK rejected sync_type 'journal' — pushAccountingEntry's log write failed silently until l72_s11 widened it); quickbooks_sync_log retired everywhere. EIGHT LEGACY-TWIN REPOINTS: social_accounts→social_media_accounts, video_content→video_assets, ai_content_outputs→ai_generated_content, lead_motivated_seller_signals→motivated_seller_signals, closing_disclosure→transaction_documents(doc_type), newsletters→dead segment branch removed, earnings_history→agent_monthly_earnings, brand_asset_library→marketing_assets (which exposed TWO live 42703s: marketing_assets and ai_video_projects have NO is_active — deprecate now uses approval_status/is_published). CADENCE WRITERS: newsletter_cadence_policy + social_cadence_policy finally have their settings writer (upsertMarketingCadencePolicy, unique (scope_type,scope_id) live-verified) wired into the blog-cadence settings page — the two ticker crons no longer read always-empty tables. SENDGRID ENGAGEMENT: the events webhook now writes email_tracking open/click rows (lead-nurture scoring + bundle attribution finally have their event stream). Four seeded catalogs exempted with verdicts. All shapes live-fired, residue 0",
        src("lib/finance/brokerage-earnings-writer.ts").includes('.is("team_id", null)')
        && src("app/dashboard/financials/brokerage/scoped-expense-entry.tsx").includes("neither rolls up")
        && src("app/actions/campaign-presets.ts").includes('"newsletter"')
        && src("app/actions/campaign-presets.ts").includes("newsletter_campaigns")
        && src("lib/finance/accounting-egress.ts").includes("pushExpenseToAccounting")
        && src("lib/finance/accounting-egress.ts").includes("provider_account_id")
        && src("lib/providers/accounting/quickbooks.ts").includes("createPurchase")
        && src("app/api/cron/connector-health/route.ts").includes('from("accounting_sync_log")')
        && !src("app/actions/ai-financial-management.ts").includes('from("quickbooks_sync_log")')
        && src("app/actions/financials.ts").includes("pushExpenseToAccounting")
        && src("app/actions/copilot.ts").includes('from("video_assets")')
        && src("app/actions/video-repurposing.ts").includes('from("social_media_accounts")')
        && src("app/dashboard/admin/ai-audit/page.tsx").includes("ai_generated_content")
        && src("app/actions/ai-predictions.ts").includes('from("motivated_seller_signals")')
        && src("lib/listing-lifecycle/readiness-checker.ts").includes('.eq("doc_type", "closing_disclosure")')
        && src("app/actions/financials.ts").includes("agent_monthly_earnings")
        && src("lib/agents/asset-manager.ts").includes('from("marketing_assets")')
        && src("lib/agents/asset-manager-actions.ts").includes('approval_status: "rejected"')
        && src("app/actions/marketing-cadence-policy.ts").includes("upsertMarketingCadencePolicy")
        && src("app/settings/blog-cadence/client.tsx").includes("ChannelCadenceCard")
        && src("app/api/webhooks/sendgrid-events/route.ts").includes('from("email_tracking")')
        // Monotone burn-down: later rounds only ever shrink the baseline.
        && baseline3.length <= 32)
    }
    // ── BURN-DOWN ROUND 4: MONEY-TRUTH SPINE + VOICE-ADMIN WRITERS + HEAVY REPOINTS ──
    {
      const baseline4 = JSON.parse(src("scripts/writerless-read-baseline.json")) as string[]
      check("BURN-DOWN ROUND 4 (32 → 18) — approved items 1, 3, 4. MONEY-TRUTH SPINE (item 1): commission_splits finally has its writer — the kernel commission creation persists one split row per commission with the SAME waterfall numbers (fees + cap credit in metadata) and the approve/pay/dispute/resolve transitions MIRROR onto the ledger by commission_id (live CHECK pending/approved/paid/disputed/cancelled), so the agent money page and brokerage-P&L intelligence read real rows; addAgentCommission writes the twin row too. transaction_cost_breakdown persists at the offer→deal bridge (UNIQUE(transaction_id) live-verified → upsert): buyer side carries CONTRACT facts, seller side rides the SAME net-sheet math as the offer comparison with every line marked default_estimate (provenance discipline — never an estimate dressed as a fact). runUsageMeteringRollup folds the raw usage streams (usage_events/usage_logs/ai_tool_usage) into meter_readings + cost_allocation per brokerage per month on the nightly finance cron (no unique indexes — pass-10 delete-then-insert; agent and team allocations are SEPARATE rows, books never cross-roll). VOICE-ADMIN WRITERS (item 3): four 'tell the admin and it's done' tables get their ONE writer (app/actions/intent-writers.ts) dispatched by voice — request_document (document_requests, the assistant's overdue alert can finally fire), assign_vendor (contact_vendors — the vendor-messaging gate can finally pass; NULL-transaction dedupe via check-then-update because Postgres unique treats NULLs as distinct), log_upgrade (property_upgrades → seller CMA valuation), set_portal_milestones (contact_portal_preferences UNIQUE(contact_id) upsert). LIVE-FIRE CAUGHT: vendors.name is the live column (NOT business_name) and vendors.category is CHECK'd (Lender/Inspector/Title Company/Contractor/Stager/Other). All shapes live-fired, residue 0",
        src("lib/kernel/financial.ts").includes('from("commission_splits")')
        && src("lib/kernel/financial.ts").includes('.eq("commission_id", commissionId)')
        && src("app/actions/agents.ts").includes("commission_splits")
        && src("lib/transactions/offer-bridge.ts").includes("transaction_cost_breakdown")
        && src("lib/transactions/offer-bridge.ts").includes('{ onConflict: "transaction_id" }')
        && src("lib/finance/usage-metering.ts").includes("runUsageMeteringRollup")
        && src("app/api/cron/brokerage-pl-rollup/route.ts").includes("runUsageMeteringRollup")
        && src("app/actions/intent-writers.ts").includes("requestDocument")
        && src("app/actions/intent-writers.ts").includes("assignVendorToContact")
        && src("app/actions/intent-writers.ts").includes("logPropertyUpgrade")
        && src("app/actions/intent-writers.ts").includes("setPortalMilestonePreferences")
        && src("app/actions/intent-writers.ts").includes('.is("transaction_id", null)')
        && src("app/actions/voice-assistant.ts").includes('"request_document"')
        && src("app/actions/voice-assistant.ts").includes('"assign_vendor"')
        && src("app/actions/voice-assistant.ts").includes('"log_upgrade"')
        && src("app/actions/voice-assistant.ts").includes('"set_portal_milestones"')
        && src("app/actions/voice-assistant.ts").includes('ilike("name"')
        // HEAVY REPOINTS (item 4, delegated + reviewed): appointments→calendar_events
        // (event_type 'listing_appointment' is what the real writer inserts; the
        // listing's address resolves via entity_id), vendor_directory→vendors across
        // every reader incl. TWO PostgREST embeds whose FK targets vendors(id) — the
        // old embeds could never resolve (live 400s), ai_isa_settings→
        // ai_identity_profiles + global_settings JSONB (vapiConfigured could never be
        // true), user_brokerage_roles→user_role_assignments + permission-matrix
        // capabilities + the agents roster (also fixed an id-class mismatch).
        && src("app/api/cron/listing-presentation-prep/route.ts").includes('from("calendar_events")')
        && src("app/api/cron/listing-presentation-prep/route.ts").includes('"listing_appointment"')
        && src("app/dashboard/vendors/page.tsx").includes('from("vendors")')
        // The marketing-package embed now NAMES its vendor columns. A starred
        // embed resolves against the right table but hides WHICH columns the
        // consumer reads, so a column the bench does not have stays undefined
        // forever instead of failing — assert the named shape, and that the
        // star has not crept back. (test:phantom-embed proves the ranking.)
        && /vendor:vendors\(\s*id\s*,/.test(src("app/actions/marketing-package-automation.ts"))
        && !src("app/actions/marketing-package-automation.ts").includes("vendor:vendors(*)")
        // vendor-communications.tsx now names its embedded columns too. This
        // line used to assert the STAR was present, which recorded the state of
        // the file rather than a property worth keeping — and it contradicted
        // the rule stated two comments up. Both of its embeds were checked
        // against the live schema (one FK each: vendor_id→vendors,
        // transaction_id→transactions, listing_id→listings, so no PGRST200/201)
        // and narrowed to exactly the columns the two emails read. Asserted as
        // the claim — named, and no starred embed left anywhere in the file.
        && src("lib/communications/vendor-communications.tsx").includes("vendors(id, name, email)")
        && !/\w+\(\*\)/.test(src("lib/communications/vendor-communications.tsx"))
        && src("app/dashboard/isa/calling/page.tsx").includes("ai_identity_profiles")
        && src("lib/auth/permissions-client.ts").includes("user_role_assignments")
        && src("lib/data/brokerKPIs.ts").includes('from("agents")')
        && baseline4.length <= 20)
    }
    // ── BURN-DOWN ROUND 5: INTELLIGENCE INGRESS + REVENUE-SHARE TREE + PERSONA-AT-ENRICHMENT ──
    {
      const baseline5 = JSON.parse(src("scripts/writerless-read-baseline.json")) as string[]
      check("BURN-DOWN ROUND 5 (18 → 10) — approved 1 (with owner semantics), 2, 3. INTELLIGENCE INGRESS: runContentIntelScan (daily cron, EXA_API_KEY-gated) walks the competitor_brokerages watchlist and writes competitor_content — ORGANIC facebook/instagram posts AND Facebook Ad Library rows (content_type 'ad') per the owner's 'what content is getting the most interaction' (Exa citation ranking IS the interaction proxy; hard like counts stay honest-NULL — no platform auth, never invented); each watchlist entry ensures its competitor_profiles twin (ALSO writer-less — the reader INNER-joins it, so content rows without profiles were silently dropped). keyword_intelligence = 'popular content search for a niche': per content-category niche + brokerage market, Exa's popular-now results land as 'rising' keywords (the reader's filter) with 7-day TTL; search_volume_monthly honest-NULL (no SEO provider). newsletter_local_content: fetchLocalNews now LIVE-fetches NewsAPI through the connector gateway when the pool runs thin; rows persist ONLY attached to the campaign that used them (newsletter_id NOT NULL, live FK → newsletter_campaigns) via recordNewsletterLocalContent at wizard submit. lender_applications = THE LENDER'S APPLICATION LINK (l72_s12 application_url) recorded from the lender portal with the live 11-status lifecycle; title_orders = THE TITLE SEARCH RESULTS (l72_s12 search_result jsonb; clear/issue statuses) — and the /title/orders/new page was a setTimeout STUB pretending to save, now a real writer. subscriber_service_areas = ACTIVE SUBSCRIBER TERRITORIES FEEDING THE SCRAPERS: every lead_scraping_markets create/update syncs a per-zip territory claim (delete deactivates, history kept) — the platform lead-distribution rotation and the scraper work-list share one enrollment. REVENUE-SHARE TREE (2): provisioning a 'joined' recruit with a recruiter_agent_id plants the agent_relationships sponsor edge (UNIQUE(agent,brokerage,type) upsert, depth = sponsor's depth + 1, brokerage-funded 5%) — the waterfall's residual step and the revenue-share board finally have a tree. PERSONA-AT-ENRICHMENT (3): the enrichment orchestrator's post-enrichment hook builds client_detailed_personas from VERIFIED PeopleData facts only (demographics/psychographics/triggers/pains + a routed-AI summary grounded in those facts with a deterministic fallback; check-then-update, one persona per contact) — lead scoring, open-house follow-up and persona-aware content stop reading empty. All shapes live-fired (jsonb trigger arrays, sponsor chain depth, reader predicates), residue 0",
        src("lib/competitive-intel/content-intel-scan.ts").includes("runContentIntelScan")
        && src("lib/competitive-intel/content-intel-scan.ts").includes("ensureCompetitorProfile")
        // (round 6 evolved the keyword lane: trend now DERIVES from two-window
        // publish-rate acceleration and volume carries the documented platform
        // interest index — the round-6 lock asserts the new shape.)
        && src("lib/competitive-intel/content-intel-scan.ts").includes("trend_direction: direction")
        && src("lib/competitive-intel/content-intel-scan.ts").includes("search_volume_monthly: interestIndex")
        && src("app/api/cron/content-intel-scan/route.ts").includes("runContentIntelScan")
        && src("app/actions/newsletter/fetch-local-news.ts").includes("recordNewsletterLocalContent")
        // (round 7: the gateway egress moved into the newsapi-ai adapter.)
        && src("lib/content-intel/newsapi-ai.ts").includes("callConnector")
        && src("app/newsletters/newsletters-client.tsx").includes("recordNewsletterLocalContent")
        && src("app/actions/partner-orders.ts").includes("createLenderApplication")
        && src("app/actions/partner-orders.ts").includes("application_url")
        && src("app/actions/partner-orders.ts").includes("createTitleOrder")
        && src("app/actions/partner-orders.ts").includes("search_result")
        && !src("app/title/orders/new/page.tsx").includes("setTimeout")
        && src("app/title/orders/new/page.tsx").includes("createTitleOrder")
        && src("app/portal/lender/[transactionId]/lender-actions.tsx").includes("createLenderApplication")
        && src("app/actions/lead-scraping-config.ts").includes("syncServiceAreasForMarket")
        && src("app/api/recruiting/provision-agent/route.ts").includes("agent_relationships")
        && src("app/api/recruiting/provision-agent/route.ts").includes("recruiter_agent_id")
        && src("lib/contacts/persona-builder.ts").includes("buildContactPersona")
        && src("lib/lead-pipeline/enrichment-orchestrator.ts").includes("buildContactPersona")
        && baseline5.length <= 10)
    }
    // ── BURN-DOWN ROUND 6 (10 → 0): THE BURN IS FINISHED + DAY-ONE INTELLIGENCE + CREATIVE PLAYBOOKS ──
    {
      const baseline6 = JSON.parse(src("scripts/writerless-read-baseline.json")) as string[]
      check("BURN-DOWN COMPLETE (10 → 0) + OWNER DIRECTIVES. Every table the app reads now has a runtime writer or a recorded keep-one verdict — the drift class that started this campaign is EXTINCT and the sweep guards it at zero forever. DAY-ONE KEYWORD INTELLIGENCE (owner: 'use a search provider we already have'): no new SEO vendor — the SAME Exa key runs each niche query over TWO windows (30d vs 180d); publish-rate acceleration derives trend_direction/trend_change_pct honestly, distinct publishing domains derive competition_score, and search_volume_monthly carries a documented PLATFORM INTEREST INDEX (0-100 from citation scores) — real provider data, never claimed to be Google volume. LOCAL NEWS KEY CASCADE (owner: user-connected unless platform-licensed): tenant integration_credentials 'newsapi' key wins; the platform env key is the fallback and the code documents it must hold a SaaS-licensed (Business-tier) key; no key at all degrades honestly to the pool. CREATIVE CAMPAIGN PLAYBOOKS (owner's Zestimate flagship): a CODE-VERSIONED catalog (lib/marketing/creative-playbooks — reviewed like code, no parallel table to drift) of SIX strategic plays that ride popular consumer surfaces — THE ZESTIMATE CHALLENGE ('Do you agree with what Zillow gave you?' postcard + tracked QR → the agent's home-value capture page with the video slot for the 'why you can't trust the online number' presentation), Neighbor Brag, Rate-Drop Wake-Up, Anniversary Equity Reveal, Neighbor-First Open House, Expired Second Opinion; ONE CLICK instantiates through the EXISTING governed rails (createLeadMagnet → /lm/slug, createQrCodeAction, upsertCampaignPreset + upsertDirectMailPreset — both compliance-gated at save — upsertCampaignBundle) and NOTHING sends without the existing dispatch gates; installed from a Strategy Playbooks section on the bundle builder. FINAL BURN BUILDS: api_response_logs writes from THE gateway itself (the single egress choke measures every call's latency/status; query strings never logged), ai_subscription_tier syncs on tier change (the admin AI entitlement gate could never pass before), property_smart_insights + team_heatmap_snapshots derive nightly from tables we already write (TWO more live CHECK vocabularies caught by fire: market_position speaks hot/…/slow from DOM pace; heatmap activity_type speaks listing/buyer/closed/lead), document_checklist recomputes at the auto-filer choke, video_streaming_status reads consolidated onto ai_video_projects.provider_status (keep-one), and the four last repoints landed (communications→messages+isa_outreach_log+transaction_communications, lead_conversation_history→messages, listing_engagement→the four written engagement primitives, organization_members→team_members+users). All new shapes live-fired, residue 0",
        baseline6.length === 0
        && src("lib/competitive-intel/content-intel-scan.ts").includes("interestIndex")
        && src("lib/competitive-intel/content-intel-scan.ts").includes("withinDays: 180")
        && src("lib/competitive-intel/content-intel-scan.ts").includes("distinctDomains")
        // (round 7 evolved these: news moved to newsapi.ai and ALL playbook copy
        // became AI-authored — the literal copy assertion died with the copy.)
        && src("app/actions/newsletter/fetch-local-news.ts").includes("resolveNewsApiAiKey")
        && src("lib/content-intel/newsapi-ai.ts").includes("newsapi_ai")
        && src("lib/marketing/creative-playbooks.ts").includes("zestimate_challenge")
        && src("lib/marketing/creative-playbooks.ts").includes("NO HARDCODED CONTENT")
        && src("app/actions/creative-playbooks.ts").includes("installCreativePlaybook")
        && src("app/actions/creative-playbooks.ts").includes("createLeadMagnet")
        && src("app/actions/creative-playbooks.ts").includes("createQrCodeAction")
        && src("app/actions/creative-playbooks.ts").includes("upsertDirectMailPreset")
        && src("app/settings/campaign-bundles/client.tsx").includes("Strategy playbooks")
        && src("lib/agentic-os/connector-gateway.ts").includes("logApiResponse")
        && src("lib/agentic-os/connector-gateway.ts").includes('from("api_response_logs")')
        && src("app/actions/superadmin/brokerage-management.ts").includes("ai_subscription_tier")
        && src("lib/intelligence/derived-snapshots.ts").includes("runDerivedSnapshots")
        && src("lib/intelligence/derived-snapshots.ts").includes('"hot"')
        && src("lib/intelligence/derived-snapshots.ts").includes('"closed"')
        && src("app/api/cron/brokerage-pl-rollup/route.ts").includes("runDerivedSnapshots")
        && src("lib/documents/auto-filer.ts").includes("recomputeDocumentChecklist")
        && !src("app/dashboard/videos/board/page.tsx").includes('from("video_streaming_status")')
        && src("app/actions/ai-chat.ts").includes('from("messages")')
        && src("app/actions/link-to-video.ts").includes("team_members"))
    }
    // ── ROUND 7: ZERO HARDCODED CONTENT + AUTO-RENDERED PLAYBOOK VIDEO + NEWSAPI.AI ──
    {
      check("ROUND 7 — OWNER DIRECTIVES: NO HARDCODED CONTENT + THE VIDEO RENDERS ITSELF + NEWSAPI.AI. PLAYBOOKS DE-HARDCODED: the catalog now carries ONLY strategy briefs (what the copy must accomplish); EVERY consumer-facing word — postcard, letter, email, SMS, voicedrop, social caption, capture-page landing copy, and the VIDEO SCRIPT — is AI-authored at install through the charter path (resolveBrandContext brand grounding + withScriptStandards + generateTextRouted), still compliance-gated by the preset writers at save; authoring failure = the step is SKIPPED with a note (client-story-drafts honest-absence rule — never fallback prose). THE AUTO-RENDERED VIDEO (the differentiator): the playbook's video brief becomes an AI-written 60-90s avatar script, gated by evaluateOutbound BEFORE any render dollars (the intro-reactor discipline), pre-flight checks the agent's voice clone + avatar exist (actionable note instead of a dead project), inserts the ai_video_projects row (education / public_marketing / customer_facing), submits through the platform-locked D-ID + ElevenLabs dispatch, then LINKS provider_job_id + provider_metadata{provider:'did', mode, lead_magnet_id} so poll-did-videos completes it — and the poll cron's completion block now ATTACHES the finished render to the capture page (landing_content.videoUrl; the /lm page renders the <video> block), so the Zestimate-challenge visitor scans the postcard and watches the agent's own cloned voice explain why the online number can't be trusted, end to end with ZERO human production steps. NEWSAPI.AI (owner-selected provider): lib/content-intel/newsapi-ai.ts is the one Event Registry adapter (gateway egress, tenant-key cascade with the SaaS-license rule on the platform env key) — local newsletter blocks now carry REAL social scores/sentiment/semantic concepts (relevance_score = actual share-based popularity, not positional guessing), and keyword_intelligence gains the newsapi_ai_social lane (socialScore-ranked = what people actually shared) beside the Exa citation lane. All new shapes live-fired, residue 0",
        src("lib/marketing/creative-playbooks.ts").includes("brief:")
        && !src("lib/marketing/creative-playbooks.ts").includes("tts_script:")
        && src("app/actions/creative-playbooks.ts").includes("authorPlaybookCopy")
        && src("app/actions/creative-playbooks.ts").includes("resolveBrandContext")
        && src("app/actions/creative-playbooks.ts").includes("withScriptStandards")
        && src("app/actions/creative-playbooks.ts").includes("createPlaybookVideo")
        && src("app/actions/creative-playbooks.ts").includes("dispatchVideo")
        && src("app/actions/creative-playbooks.ts").includes("evaluateOutbound")
        && src("app/actions/creative-playbooks.ts").includes("agent_voice_profiles")
        && src("app/actions/creative-playbooks.ts").includes("saveMagnetLandingContentAction")
        && src("app/api/cron/poll-did-videos/route.ts").includes("lead_magnet_id")
        && src("app/api/cron/poll-did-videos/route.ts").includes("videoUrl: finalVideoUrl")
        && src("app/lm/[slug]/page.tsx").includes("landing.videoUrl")
        && src("lib/marketing/lead-magnet-copy.ts").includes("videoUrl?")
        && src("lib/content-intel/newsapi-ai.ts").includes("searchNewsApiAiArticles")
        && src("lib/content-intel/newsapi-ai.ts").includes("socialScore")
        && src("app/actions/newsletter/fetch-local-news.ts").includes("searchNewsApiAiArticles")
        && src("lib/competitive-intel/content-intel-scan.ts").includes("newsapi_ai_social"))
    }
    // ── ROUND 8: PLAYBOOK SCOREBOARD + ZIP PLACEHOLDER + TENANT-SCOPE BURN (64 → 14) ──
    {
      const tenantBaseline = JSON.parse(src("scripts/tenant-scope-baseline.json")) as Record<string, number>
      check("ROUND 8 — PLAYBOOK OUTCOME LEARNING + NO HARDCODED ZIP + TENANT-SCOPE BURN. SCOREBOARD: every playbook install tags its capture page with the playbook key + the ids of the assets whose LEDGERS score it; loadPlaybookScoreboard reads straight off qr_codes.scan_count/lead_count, lead_capture_forms.submission_count and ai_video_projects.status — the Strategy Playbooks cards show a live-results row, nothing modeled. ZIP PLACEHOLDER (owner catch): the RentCast probe URL's literal zipCode=78701 became {{zip}} (resolveProbeUrl + probeConnector params); the Integration Guardian resolves a REAL enrolled subscriber territory so the canary tests the exact market the platform serves, and the go-live BatchData probe resolves city/state/zip from an active territory the same way — the neutral default exists ONLY pre-enrollment. TENANT-SCOPE BURN: 50 of the 64 frozen unscoped-query sites got REAL anchors (webhooks resolve the receiving business number → brokerage before identity matching; platform cron sweeps carry each row's brokerage and exclude orphans; actions resolve caller context the way their siblings do); the 14 survivors are VERIFIED platform-global reads (platform-admin gated verification routes) — never fake-scoped. The surface can only shrink from 14",
        src("lib/agentic-os/connector-probe.ts").includes("{{zip}}")
        && src("lib/agentic-os/connector-probe.ts").includes("resolveProbeUrl")
        && src("app/api/cron/connector-health/route.ts").includes("probeParams")
        && src("lib/platform/go-live-readiness.ts").includes("subscriber_service_areas")
        && src("app/actions/creative-playbooks.ts").includes("loadPlaybookScoreboard")
        && src("app/actions/creative-playbooks.ts").includes("playbookKey: playbook.key")
        && src("app/settings/campaign-bundles/client.tsx").includes("Live results:")
        && Object.keys(tenantBaseline).length <= 14)
    }
    // ── ROUND 9: OPEN-LOOP CLOSURE + PLATFORM TOOLING COMPLETENESS ──
    {
      const writeBaseline = JSON.parse(src("scripts/orphan-write-baseline.json")) as string[]
      check("ROUND 9 — CLOSE THE LOOPS + GIVE THE PLATFORM ITS MISSING TOOLS. NEW GUARD (pass 17): the write-only-ledger sweep is the mirror of the burned-to-zero writer-less-read sweep — tables the code WRITES but nothing READS are compute nobody sees; report-only with a committed burn-down baseline (63, can only shrink), NEW write-only tables fail CI, and audit ledgers stay exempt ONLY by naming their out-of-band consumer. TWO KEEP-ONE REPOINTS from that ledger: fair-housing violations now land in canonical compliance_flags (the table the compliance UI actually reads — fair_housing_logs informed nobody) and the newsletter API writes ai_generated_content (the audited AI-output ledger) instead of the orphan generated_content twin. DORMANT CRON CLOSED: content-intel-scan was built but never registered — it now rides the ONE dispatcher at 10:00 daily, and test:cron-dispatch guards the registry. GUARDIAN GROWS A LANE: newsapi_ai probe (query-param apiKey auth style) so the platform news/trends provider is canaried like did/elevenlabs/lob/rentcast. PLATFORM TOOLING (the god console's missing verbs): REFUND — the one billing op that moves money back — refunds the latest PAID invoice via Stripe (full or partial), reason REQUIRED, audit-logged, wired into the tenant god console; AUDIT VIEWER — superadmin_audit_log finally has its reader page (which is what keeps its orphan-write exemption honest), superadmin-gated to match the action layer; SUPPRESSION MANAGER — the cross-tenant do-not-contact wall gets its human half (staff honoring 'stop contacting me' requests): sentinel-capability list/add, but REMOVE is superadmin-only because deletion re-exposes the person to every tenant's outreach, and both directions write the audit ledger",
        src("lib/kernel/cron-dispatch.ts").includes("/api/cron/content-intel-scan")
        && src("lib/agentic-os/connector-probe.ts").includes("newsapi_ai")
        && src("lib/agentic-os/connector-probe.ts").includes("query_api_key")
        && writeBaseline.length <= 63
        && src("scripts/orphan-write-sweep.ts").includes("AUDIT_EXEMPT")
        && src("lib/application/compliance-monitoring.ts").includes('"fair_housing_violation"')
        && src("app/api/generate/newsletter/route.ts").includes('from("ai_generated_content")')
        && src("lib/billing/stripe-subscription-ops.ts").includes("stripeRefundLatestInvoice")
        && src("app/actions/superadmin/brokerage-management.ts").includes("issueRefundAction")
        && src("app/dashboard/superadmin/brokerages/[id]/brokerage-actions.tsx").includes("issueRefundAction")
        && src("app/dashboard/superadmin/audit/page.tsx").includes("listSuperadminAuditLogAction")
        && src("app/actions/superadmin/suppression.ts").includes("removeSuppressionEntryAction")
        && src("app/actions/superadmin/suppression.ts").includes('gate.role !== "superadmin"')
        && src("app/dashboard/superadmin/suppression/suppression-manager.tsx").includes("addSuppressionEntryAction")
        && src("app/dashboard/superadmin/platform/page.tsx").includes("/dashboard/superadmin/suppression")
        && src("app/dashboard/superadmin/platform/page.tsx").includes("/dashboard/superadmin/audit"))
    }
    // ── ROUND 10: STUB BURN + WRITE-ONLY READERS + CONSOLE CONSOLIDATION ──
    {
      const writeBaseline10 = JSON.parse(src("scripts/orphan-write-baseline.json")) as string[]
      check("ROUND 10 — THE STUB BURN + READER BATCH + ONE GOD CONSOLE. STUBS: the send_for_esign adapter's createTransaction→attachForms→sendForSignature flow is provider-AGNOSTIC via the registry — DocuSign/SkySlope/FormSimplicity/Authentisign auto-send exactly like Dotloop (all five classes implement ITransactionProvider); Brokermint (no native e-sign API) takes the manual-task path which now reports 'skipped', never a false 'sent'. Live-avatar MINUTES are metered: the portal widget tracks LIVE-mode elapsed time and beacons it to /api/did/agents/session/end (same portal-access gate as session-start, server-side clamp; the per-session counter stays the abuse hard-cap). DEAD CODE DELETED after zero-caller verification: the lib/ai-isa-contact module (its 'AI' response was a hardcoded '[Brokerage Name]' template), the never-called enhanced-readiness evaluator (default case silently failed 5 of 13 checks), the buyer-preferences stub, and sendOfferToDotloop (returned success without calling Dotloop). READERS: 8 write-only ledgers got their consumers — meeting briefs + weekly plans are cache-first (stored row serves before the LLM respends), calendar_blocks is the 8th unified-calendar source, offer comparisons + P&L snapshots + health-factor breakdowns survive refresh, actor health + pattern adoptions render on their admin pages; cma_packages' dead job-stub write deleted (cma_reports is canonical). Baseline 63 → 53, monotone. CONSOLE: the legacy app/admin mega-console is RETIRED — duplicates redirect into the capability-gated superadmin subtree, the UNGATED /admin/audit-trail hole is closed behind requirePlatformCapability('staff'), env-provider status moved behind 'providers', and tenant-facing /admin/integrations prompts point at /settings/integrations",
        src("lib/workflow/adapters/send-for-esign.ts").includes("getTransactionProviderByName")
        && src("lib/workflow/adapters/send-for-esign.ts").includes('status: "skipped"')
        && src("app/api/did/agents/session/end/route.ts").includes("live_avatar_minutes")
        && src("app/components/features/ai-avatar-chat/AgentsWidget.tsx").includes("sendBeacon")
        && src("lib/ai-isa-contact/response-generator.ts") === ""
        && src("lib/listing-lifecycle/readiness-evaluation-enhanced.ts") === ""
        && src("app/actions/ai-calendar-management.ts").includes("forceRegenerate")
        && src("app/dashboard/calendar/components/os/calendar-shell.tsx").includes("calendar_blocks")
        && src("app/actions/seller-offers.ts").includes("loadLatestOfferComparison")
        && writeBaseline10.length <= 53
        && src("app/dashboard/superadmin/audit-trail/page.tsx").includes('requirePlatformCapability("staff")')
        && src("app/dashboard/superadmin/env-providers/page.tsx").includes('requirePlatformCapability("providers")')
        && src("app/admin/page.tsx").includes("redirect(")
        && src("lib/notifications/route-resolver.ts").includes("/settings/integrations"))
    }
    // ── ROUND 11: THE SECOND BURN TO ZERO + LAUNCH CAPTURE + LEDGER RECEIPTS ──
    {
      const writeBaseline11 = JSON.parse(src("scripts/orphan-write-baseline.json")) as string[]
      check("ROUND 11 — WRITE-ONLY LEDGER BURNED TO ZERO (the mirror of the writer-less-read burn, 63 → 0 in three rounds; every entry got a verdict — reader built, write repointed to the canonical twin, dead write deleted, or forensic ledger exempted WITH its named out-of-band consumer). THE FOUR QUEUE BUGS: email_queue (six writers, nothing ever sent), push_notification_queue (no provider exists — honest in-app fallback, never fake 'sent'), orchestrator_tasks (the service's own publish path was a SIMULATION — the drain reconciles against the real publish-social-posts rail instead of double-posting), drip_campaigns (no content on the rows — serviced ONLY through compliance-gated canonical sequence enrollment) — all drained by ONE queue-drain cron on the ONE dispatcher heartbeat. READERS THAT CHANGED BEHAVIOR: budgets finally hydrates the planner that could save but never load; generated listing landing pages are SERVED on the public slug route (view-tracked) instead of rotting unread; campaign audience resolution consumes contact_segments so the workflow segment step stopped being inert. LAUNCH CAPTURE LANE: every Launch War Room now also stages a QR-coded 'be first to see it' capture page through the canonical lead-magnet kernel, tagged playbookKey listing_launch so launches score on the SAME outcome scoreboard as the strategy playbooks. VOICE LEDGER RECEIPTS: the four intent writers read their row back FRESH after every write and the voice admin speaks the receipt from THAT row — 'done' always means verified on the ledger, and a write that can't be read back reports failure. AVM: the appreciation fallback applies real zip-level price_trend_pct_1yr (clamped ±25%/yr, ≤3y) instead of returning the stale value unchanged",
        writeBaseline11.length === 0
        && src("app/api/cron/queue-drain/route.ts").includes("email_queue")
        && src("app/api/cron/queue-drain/route.ts").includes("no_push_provider_configured")
        && src("lib/kernel/cron-dispatch.ts").includes("/api/cron/queue-drain")
        && src("lib/kernel/manager-registry.ts").includes('"/api/cron/queue-drain"')
        && src("lib/kernel/launch-war-room.ts").includes("capturePagesStaged")
        && src("lib/kernel/launch-war-room.ts").includes('"listing_launch"')
        && src("app/actions/intent-writers.ts").includes("LedgerReceipt")
        && src("app/actions/intent-writers.ts").includes("write_not_verifiable")
        && src("app/actions/voice-assistant.ts").includes("speakReceipt")
        && src("lib/avm/provider-chain.ts").includes("price_trend_pct_1yr")
        && src("app/actions/listing-landing.ts").includes("getLandingPageBySlug")
        && src("lib/marketing/email-campaign-sender.ts").includes("contact_segments")
        && src("lib/communications/vendor-communications.tsx").includes("dispatchEmail"))
    }
    // ── ROUND 12: ALL LOOPS CLOSED — PUSH CONNECTOR + QR VOCAB CATCH + LAST STUBS ──
    {
      check("ROUND 12 — THE OPEN-LOOP LEDGER CLOSES. WAR-ROOM DRILL CATCH (the round's headline): live-firing all seven Launch War Room lanes against production constraints exposed that qr_codes.purpose's CHECK admitted NONE of the values the writers use (lead_magnet / lead_capture / campaign / listing_inquiry) — production qr_codes was EMPTY because every QR the platform ever tried to mint silently failed; migration l72_s13 widened the vocabulary, and the playbook installer's brief-as-purpose bug died with it. PUSH CONNECTOR: the drain's honest no_push_provider_configured gap is now REAL egress — push_subscriptions registry (l72_s12, RLS own-rows, data_steward owner) + VAPID web-push adapter that soft-disables gone endpoints, service worker + permission toggle on the notification settings, and the drain marks real deliveries 'delivered' (the live CHECK vocabulary — 'sent' would have violated it). STALENESS RULE: pending emails older than 7 days expire at drain time, so a drain outage can never end in a backlog blast of weeks-late mail. LAST STUBS: appointment scheduling writes REAL calendar_events (ai-isa/meeting-recap) and document requests write REAL document_requests rows (intent-writers) — no stubs (the vestigial Engine A's inline steps that once did this were retired in the workflow-engine consolidation); neighborhood data rides the AI rail labeled ai_estimated (never mock); open-house weather is a REAL Open-Meteo forecast scored + stored; certificates render actual PDFs through the board-packet rail into storage (null + honest copy when rendering fails — never a dead link); the SkySlope webhook comment was stale (provider fully implemented) and now says so",
        src("lib/providers/web-push.ts").includes("endpoint_gone")
        && src("app/actions/push-subscriptions.ts").includes("subscribePush")
        && src("app/components/shared/push-permission-toggle.tsx").includes("urlBase64ToUint8Array")
        && src("app/api/cron/queue-drain/route.ts").includes("expired_in_queue")
        && src("app/api/cron/queue-drain/route.ts").includes("isWebPushConfigured")
        && src("lib/agentic-os/connector-probe.ts").includes("web_push")
        && src("lib/kernel/manager-registry.ts").includes("push_subscriptions")
        && src("app/actions/creative-playbooks.ts").includes('purpose: "lead_capture"')
        && src("lib/ai-isa/meeting-recap.ts").includes('from("calendar_events")')
        && src("app/actions/intent-writers.ts").includes('from("document_requests")')
        && src("lib/onboarding/certificate-pdf.ts").includes("renderCertificatePdf")
        && src("app/actions/open-house-automation.ts").includes("open-meteo")
        && !src("app/actions/ai-content-generation.tsx").includes("returning structured mock data"))
    }
    // ── ROUND 13: LICENSE LADDER + B-ROLL + ONE CONSOLE (PHASE 2) + PLATFORM BOARDS ──
    {
      check("ROUND 13 — THE BACKLOG THE OWNER NAMED, CLOSED. RE-LICENSE LADDER (NIPR was insurance — wrong vendor; no free national RE-license API exists): verification now rides what the platform already owns — a PURE per-state registry of regulator lookup portals, ZenRows scrape (platform key) + AI extraction (feature license_verification, extract-only prompt), confidence-mapped verdicts where verified requires found+active+conf≥0.8, and EVERYTHING else routes to the EXISTING human-review queue with a one-click state-portal link — scrapes never auto-reject an agent; only humans do. B-ROLL: cutaways are real on the same ffmpeg rail as the attribution band (planBrollCutaways is pure and drill-proven: protected open/close, ≤4 non-overlapping ≤4s windows, short mains get none); pipeline order is compliance-first (b-roll → BRAND band on top → bookends) and visualOverlayApplied means the band, never b-roll alone; intro/outro concat was ALREADY live — only its note was stale. ONE CONSOLE, PHASE 2: every tenant-facing /admin surface moved under /dashboard/admin (usage, ai-audit — the only compliance-officer-admitting ai_generated_content viewer, error-handler, brokerage-scoped users directory with the unscoped superadmin branch REMOVED — the god console owns cross-tenant) and app/admin is now NOTHING but thin redirects; retiring the hub orphaned the recruits pipeline manager, so it was RECOVERED from git onto the canonical recruiting surface as a Pipeline tab (stage-advance + provision APIs have their UI again). PLATFORM BOARDS: A2P posture across every tenant (real twilio_a2p state machine, messaging-ready derived exactly as describeA2pState does) and rollout cohorts recomputed with the SAME FNV-1a bucket the entitlement resolver uses, wiring only the existing audited override action",
        src("lib/onboarding/state-license-registry.ts").includes("manual_portal")
        && src("lib/onboarding/license-lookup.ts").includes("verifyRealEstateLicense")
        && src("lib/onboarding/license-verifier.ts").includes("verifyRealEstateLicense")
        && !src("lib/onboarding/license-verifier.ts").includes("NIPR integration not yet configured")
        && src("lib/video/composite-attribution.ts").includes("planBrollCutaways")
        && src("lib/video/composite-attribution.ts").includes("compositeBrollCutaways")
        && src("app/api/cron/poll-did-videos/route.ts").includes("b_roll_urls")
        && src("app/api/cron/poll-did-videos/route.ts").includes("brandOverlayApplied")
        && src("app/dashboard/superadmin/a2p/page.tsx").includes('requirePlatformCapability("providers")')
        && src("app/dashboard/superadmin/rollout/page.tsx").includes("rolloutBucket")
        && src("app/dashboard/admin/usage/page.tsx").length > 0
        && src("app/dashboard/admin/ai-audit/page.tsx").includes("ai_generated_content")
        && src("app/admin/usage/page.tsx").includes("redirect(")
        && src("app/dashboard/recruiting-roi/page.tsx").includes("RecruitingPipelineClient"))
    }
    // ── ROUND 14: EVERY ROLE ITS COCKPIT + ALL STATES + CTV LANE + MLS B-ROLL RULE ──
    {
      check("ROUND 14 — EVERY ROLE GETS ITS COCKPIT, EVERY STATE ITS REGULATOR, AND TV. LICENSE REGISTRY: full 50-state + DC coverage (51), every entry the REAL regulator (LARA/DBPR/IDFPR/PALS/DIAL/DELPROS/DPOR/DSPS…) — no invented scrape patterns; unconfident portals are manual_portal landing links feeding the reviewer's one-click. PLATFORM STAFF COMMAND HOME: one role-aware hub driven from the SAME platformStaffCan map the page gates use (home and gates cannot disagree), staff land there after login (fixing brokerage-less staff mis-routed to onboarding); create-user-in-any-tenant carded (the audited rail already existed); SUBSCRIBER REFERRAL FEES ride the growth-funnel rail (platform_prospects source 'referral:<who>' + the previously-dormant converted_brokerage_id link; mark-paid writes AND reads the append-only superadmin audit ledger — the audit table IS the payment ledger); staff ANNOUNCEMENTS ride the existing notifyPlatformStaff fan-out behind a new 'announcements' capability. TENANT STAFF COMPLETENESS: admins/brokers grant admin/broker (superadmin-only list narrowed to superadmin itself), the unanchored-caller scope hole is closed, and THE CATCH — users.status='suspended' had two writers and zero readers, deactivation was a NO-OP until rejectIfSuspended gated both login paths; tenant admins get ticket threads + replies on the existing support rail; the admin hub links Users/Support/Reports/P&L/Usage/Recruiting. MLS RULE: b-roll never rides a walkthrough (cutaways would cover the very footage being toured) — explicit video_type guard atop the structural usage_intent gate. CTV (vibe.co): the streaming-TV lane stages REAL launch packages (spec-checked creative, targeting, budget, checklist, deep link) as ad_campaigns platform 'vibe_ctv' (CHECK widened by m271 — live-fired; its constraint sweep matches ONLY the platform column, sparing visibility_scope whose array contains the word 'platform'); dispatch is now a REAL OAuth2 Vibe API integration (lib/providers/vibe.ts — token → advertiser → upload creative → campaign → strategy → PUBLISH), dispatched:true ONLY on a Vibe-confirmed publish, honest error otherwise — still never a simulated launch",
        src("lib/onboarding/state-license-registry.ts").split("state:").length > 51
        && src("app/dashboard/superadmin/home/page.tsx").includes("platformStaffCan")
        && src("lib/kernel/role-routes.ts").includes("/dashboard/superadmin/home")
        && src("lib/platform/subscriber-referrals.ts").includes("REFERRAL_FEE_PERCENT")
        && src("app/actions/superadmin/platform-announcements.ts").includes("platform_announcement")
        && src("lib/platform/platform-staff-roster.ts").includes("announcements")
        && src("app/actions/auth.ts").includes("rejectIfSuspended")
        && src("app/actions/support.ts").includes("replyToBrokerageTicket")
        && src("app/api/cron/poll-did-videos/route.ts").includes("isWalkthrough")
        && src("lib/ads/ctv-campaign.ts").includes('"vibe_ctv"')
        && src("lib/providers/vibe.ts").includes("/oauth2/token") && src("lib/providers/vibe.ts").includes("Published on Vibe")
        && src("app/dashboard/campaigns/ads/ctv-lane.tsx").length > 0
        && src("supabase/migrations/m271-ad-campaigns-vibe-ctv-platform.sql").includes("platform = ANY"))
    }
    // ── ROUND 15: THE ROLE MODEL, ALIGNED TO SPEC (owner audit — 'fix this') ──
    {
      // (Round 16 owner correction: roles are OPEN on every tier — solo just has
      //  no broker — and SEATS are the constraint (2/5/unlimited); lender is a
      //  vendor CATEGORY, not a partner role. Assertions updated to that model.)
      const { TIER_INVITABLE_ROLES, tierAllowsRole, TIER_SEAT_LIMITS, PARTNER_ROLES } = await import("../lib/kernel/tier-role-matrix")
      check("ROUND 15 — THE OWNER'S CANONICAL ROLE MODEL, AUDITED THEN ALIGNED. The audit proved four spec items ALREADY TRUE (solo owner = admin wearing an agents row at 100% split; contact-portal view-as via the Portal button + same-brokerage staff preview rule; vendor invites open to every tier; platform social self-marketing) — untouched. THE FIVE DRIFTS, FIXED: (1) tier→role matrix EXISTED NOWHERE — now a pure kernel module enforced at BOTH tenant grant surfaces AND the god console (target-tenant tier, audited superadminOverride). ROUND 17 SUPERSEDED ITS ROLE HALF: the owner seated a BROKER on TEAM tier ('takes up 3 of 5 seats'), so a tier restricts HOW MANY seats, never WHICH user types fill them — all four tiers now share ONE menu and the tier's only say is the seat cap (2/5/50/unlimited, brokerage moved to 50 per 'a brokerage should be changed to 50 seats'). m518's team_lead lead desk SURVIVES that: is_lead_visible_role() is per-user with no tier clause, so seating a broker only adds someone who passes. The fail-closed duty moved off the role menu onto the seat axis, where an unreadable tier floors to the smallest cap and seatGate refuses outright on an unreadable tenant/count/catalogue; and the menu is intersected with the live users_user_type_check vocabulary so a user type the column cannot store is never offered (broker_admin, pending m530); (2) vendors are now CHARGEABLE for premium placement — the two unconnected halves (vendor_directory.preferred/display_priority flags, vendor_invoices billing ledger) wired keep-one: offer → 'submitted' invoice (the LIVE vocabulary — 'pending' does not exist in the CHECK) → mark-paid flips featured + records placement_until on the line item → daily expiry rider on the EXISTING vendor-orchestration cron; full flow live-fired (including the category vocabulary catch: lowercase 'stager'), residue 0; payment marking is documented as the tenant's assertion of off-platform collection — never simulated; (3) the platform phone reception surfaced first-class at /communications (mounting the SAME panel — keep-one); (4) per-subscriber usage reports across ALL tiers in one table (seats, book size, monthly metered media) — the spec's oversight view; (5) the marketing staff role got its dashboard route. Platform website builder: the one spec item deliberately DEFERRED as a real feature, reported not faked",
        // ── SUPERSEDED IN FULL (lane A, 2026-08-22) ──────────────────────────
        //
        // Both halves above are gone. This used to assert that solo AND team
        // withheld broker/broker_owner. OWNER, seating a broker on TEAM tier and
        // counting it as one of the five:
        //
        //   "a team is a team tier subscription with 5 seats so can have a team
        //    lead user type given permission roles, then an agent as a user type
        //    with permission roles, then a broker as a user type with different
        //    permisson roles which that takes up 3 of 5 seats"
        //
        // A TIER RESTRICTS HOW MANY SEATS, NEVER WHICH USER TYPES FILL THEM. The
        // earlier "team tier … don't have a broker in the subscription" sentence
        // described the PACKAGE; m518's team_lead lead-desk grant does not depend
        // on it (is_lead_visible_role() is per-user with no tier clause), so both
        // rulings hold and m518 is untouched.
        tierAllowsRole("solo_agent", "broker") && tierAllowsRole("solo_agent", "broker_owner")
        && tierAllowsRole("solo_agent", "agent") && tierAllowsRole("solo_agent", "admin")
        && tierAllowsRole("team", "broker") && tierAllowsRole("team", "team_lead")
        && tierAllowsRole("brokerage", "broker_admin") && tierAllowsRole("brokerage", "agent")
        // …and it is ONE menu, identical across all four tiers.
        && (["solo_agent", "team", "brokerage", "multi_location"] as const).every((t) =>
          TIER_INVITABLE_ROLES[t].slice().sort().join(",") ===
          TIER_INVITABLE_ROLES.brokerage.slice().sort().join(","))
        // SEATS are the whole of the tier's say — 2 / 5 / 50 / unlimited.
        // brokerage moved null → 50 (owner: "a brokerage should be changed to 50
        // seats"), matching the live catalogue m529 already set.
        && TIER_SEAT_LIMITS.solo_agent === 2 && TIER_SEAT_LIMITS.team === 5
        && TIER_SEAT_LIMITS.brokerage === 50 && TIER_SEAT_LIMITS.multi_location === null
        && PARTNER_ROLES.join(",") === "vendor"
        && src("app/actions/admin/invite-user.ts").includes("tierAllowsRole")
        && src("app/actions/superadmin/tenant-users.ts").includes("tier_matrix_override")
        && src("lib/kernel/role-routes.ts").includes("marketing:")
        && src("lib/vendors/premium-placement.ts").includes('"submitted"')
        && src("lib/vendors/premium-placement.ts").includes("placement_until")
        && src("app/api/cron/vendor-orchestration/route.ts").includes("expirePlacements")
        && src("app/dashboard/superadmin/communications/page.tsx").includes("PlatformReceptionPanel")
        // round 33 moved the usage_counters read into the keep-one loader shared by the page + CSV export
        && src("app/dashboard/superadmin/usage-reports/usage-report-data.ts").includes("usage_counters")
        && src("app/dashboard/superadmin/home/page.tsx").includes("/dashboard/superadmin/usage-reports"))
    }
    // ── ROUND 17: LOST WORK MADE STRUCTURALLY IMPOSSIBLE (PASS 18) + LOOPS CLOSED ──
    {
      const routeBaseline = JSON.parse(src("scripts/orphan-route-baseline.json")) as string[]
      check("ROUND 17 — 'DID ANYTHING ELSE GET LOST?' ANSWERED STRUCTURALLY. PASS 18, the ORPHAN-ROUTE SWEEP: the tenant-website system was fully built yet undiscoverable — the generalized defect class is a route with a page and no inbound link. The sweep walks all 521 routes against 635 reference sources (nav configs, hrefs, router pushes, redirects, revalidates, minted absolute URLs), exempts ONLY externally-reachable surfaces with the reachability source NAMED (the 7 sitemap slug routes, the embed iframe, the gated seed page — candidates like /login that are referenced in-app were deliberately NOT exempted so the guard stays sharp), baselines 42 legacy orphans as a shrink-only burn-down, and FAILS CI on any NEW unlinked page — building something and not wiring it is now a build break. EIGHT REAL SURFACES RESCUED with nav links on day one: Gift Studio, agent referral network, contract review, fees, challenges, calculators, onboarding steps, vendor approvals. LOOPS CLOSED: the tenant users page carries the seat meter (same matrix math the invite gate enforces, red at capacity), and onboarding opens with the day-one 'Your live website' card — every new subscriber sees their zero-hosting site in their first session",
        src("scripts/orphan-route-sweep.ts").includes("GUARD_ROUTE_BASELINE")
        && src("scripts/orphan-route-sweep.ts").includes("EXEMPT")
        && routeBaseline.length <= 42
        && src("package.json").includes("test:orphan-routes")
        && src("app/config/navigation-config.ts").includes("/dashboard/gifts")
        // ROUND 31 asserted this page names `effectiveSeatLimit` directly. The
        // CLAIM was never about that identifier — it was ONE MATH shared by the
        // meter and the invite gate. The page has since stopped re-deriving and
        // now calls `seatCheck`, which computes through `seatDecision` (which is
        // what resolves effectiveSeatLimit). So the claim is MORE true and the
        // old spelling is gone; asserting the identifier would now fail on an
        // improvement, which is a proof measuring the wrong thing.
        //
        // Assert the SHARED CALL, not the inner identifier — and assert the
        // absence of the hand-rolled comparison that used to sit here, because
        // that inline copy was a THIRD spelling of at-capacity and the reason a
        // tenant's meter could report room after the gate began refusing.
        && src("app/dashboard/admin/users/page.tsx").includes("seatCheck(")
        && !/seatCount\s*>=\s*seatLimit/.test(stripComments(src("app/dashboard/admin/users/page.tsx")))
        && src("app/dashboard/onboarding/OnboardingDashboardClient.tsx").includes("YourWebsiteCard")
        && src("app/components/settings/YourWebsiteCard.tsx").includes("getMyPublicSiteLinks"))
    }
    // ── ROUND 18: THREE ZEROS + THE NIGHTLY TRUTH LANE ──
    {
      const routeBaseline18 = JSON.parse(src("scripts/orphan-route-baseline.json")) as string[]
      check("ROUND 18 — THE THIRD ZERO, AND THE DATABASE WATCHES ITSELF NIGHTLY. ROUTE BURN 42 → 0: the honest branch mattered — ROUTE_ALIASES turned out to be runtime-DEAD (no middleware consumes it), so the 14 legacy redirect stubs ARE the bookmark-compatibility layer and were kept + exempted with named targets instead of aliased-and-deleted into 404s; the 14 hardcoded journey mock pages and 4 superseded surfaces were deleted after zero-ref verification; 9 more real surfaces got their links — including the client portal's Full Deal Dashboard (the buyer loan-condition rail) and the FIRST public privacy-request footer on the tenant sites. TWO of the three rot classes sit at ZERO with shrink-only guards (writes nothing reads, reads nothing writes); THE THIRD ZERO WAS A GUARD ARTEFACT AND IS WITHDRAWN — the 'pages nothing links' sweep carried three false passes (revalidatePath counted as a reference, a page counted as a reference to itself, and a bare ${…} segment satisfied a literal route segment), and with those closed the honest count is 32 unlinked pages, now the shrink-only baseline. NIGHTLY TRUTH LANE: the per-push drift guard proves code vs the committed snapshot; the new creds-gated check proves the snapshot vs the LIVE database (service-role-only live_schema_json RPC, l72_s14) — DDL applied between deploys is caught within a day, with the diff shown and the committed snapshot restored so regens are always deliberate; the nightly workflow now also runs the FULL guard chain against main. FLEET DRILL ran live: all four tiers provisioned with real shapes, the seat gate's exact predicate proven (solo at its 2-seat cap, vendor partner not counting, suspension freeing the seat), residue 0",
        // ── THE THIRD ZERO WAS NOT REAL, and this assertion is corrected rather
        //    than restored. `routeBaseline18.length === 0` held only because the
        //    sweep that produced it had THREE false passes, each measured and
        //    each now fixed in scripts/orphan-route-sweep.ts:
        //      · `revalidatePath("/x")` counted as a reference — a cache
        //        invalidation is not a way for a human to reach a page;
        //      · a page.tsx counted as a reference to ITSELF, so a breadcrumb or
        //        a self-referencing tab made a route "linked";
        //      · a pure `${…}` reference segment satisfied a LITERAL route
        //        segment, so `/portal/${id}/listings` "linked"
        //        /portal/[contactId]/assistant.
        //    With those closed the honest count is 32 unlinked pages, which is
        //    what the baseline now holds. The claim in the narrative above —
        //    "pages nothing links" at zero — was a guard artefact, so the ratchet
        //    below asserts the SHRINK-ONLY property that is actually true and no
        //    longer asserts a zero the product never had. The other two zeros
        //    (orphan-write-baseline, writerless reads) are untouched and still
        //    asserted at zero below.
        // TIGHTENED 32 → 30 in the same pass that burned two of them down:
        // /settings/direct-mail and /settings/services now have tiles on the
        // settings hub, which is the only way into /settings/* (the sidebar
        // carries one "Settings" link). Both had been reachable ONLY by typing
        // the URL — their sole references in the whole tree were revalidatePath
        // calls, which is precisely the false pass removed above. A ratchet that
        // is not lowered when the number drops is not a ratchet.
        routeBaseline18.length <= 30
        && src("scripts/orphan-route-sweep.ts").includes("legacy redirect stub")
        // The two identifiers the false-pass fixes introduced: selfDirOf (a page
        // no longer counts as a reference to itself) and resolveLocalBasePaths
        // (a `${basePath}/x` template resolves instead of being read as a host).
        && src("scripts/orphan-route-sweep.ts").includes("selfDirOf")
        && src("scripts/orphan-route-sweep.ts").includes("resolveLocalBasePaths")
        && src("scripts/check-live-schema-drift.ts").includes("live_schema_json")
        && src("scripts/check-live-schema-drift.ts").includes("skipped (no Supabase credentials")
        && src(".github/workflows/e2e.yml").includes("check-live-schema-drift")
        && src(".github/workflows/e2e.yml").includes("npm run guard")
        && src("app/site/[slug]/page.tsx").includes("/privacy/request")
        && JSON.parse(src("scripts/orphan-write-baseline.json")).length === 0
        && src("scripts/writerless-read-sweep.ts").length > 0)
    }
    // ── ROUND 19: GHL PARITY — THE PLATFORM RUNS ITS TENANTS LIKE GHL RUNS GHL ──
    {
      check("ROUND 19 — FULL PLATFORM CONTROL, AUDITED THEN CLOSED (the owner's GHL mandate). THE TOP FINDING WAS A LOCKOUT: the capability map documents four staff roles but the subtree gate recognized only two — platform admin and marketing were bounced from the god console BEFORE any capability check ran; fixed identity-class-safely (the roster matches ONLY platform_role; 'admin' as a tenant user_type can never become staff), applied across the gate, the impersonation resolver + act-as seam (both identity columns), contact access, and manual-subscriber (hard superadmin → the 'tenants' capability). WHITE-GLOVE IMPORT: the inbound half of migration finally exists — CSV contacts parsed by a pure RFC-4180-tolerant parser with per-line errors, deduped, batch-inserted tenant-anchored with source 'import' (shape live-fired, residue 0), audited, with dry-run preview on the tenant console. CROSS-TENANT VENDOR OVERSIGHT + ENGAGEMENT RADAR: every vendor across every tenant with placement/invoice truth (no-FK nominal matching LABELED, never hidden), and the churn signal money views miss — real sign-ins (auth.users, the only honest source, alternatives rejected by name), velocity halving, pure engaged/cooling/at_risk classifier. ASSISTED SALE: user-granular impersonation UI (Enter-as / View-as read_only per tenant user — the backend always supported it, now the buttons exist, banner names the target user), public DB-driven /pricing (same tiers as signup, JSON-LD), /demo booking into the EXISTING prospect rail (source demo_request, m272 details column — no fake calendar), and the per-prospect AI-authored proposal generator persisted on the prospect row",
        src("lib/auth/platform-guard.ts").includes("isPlatformStaffRole")
        && src("lib/identity/get-agent-context.ts").includes("isPlatformStaffIdentity")
        && src("lib/platform/tenant-import.ts").includes("importContacts")
        && src("lib/platform/tenant-import-parser.ts").length > 0
        && src("app/actions/superadmin/tenant-import.ts").includes("tenants")
        && src("app/dashboard/superadmin/vendors/page.tsx").includes('requirePlatformCapability("sentinel")')
        && src("app/dashboard/superadmin/engagement/page.tsx").includes("classifyEngagement")
        && src("lib/platform/engagement-risk.ts").includes("at_risk")
        && src("app/dashboard/superadmin/brokerages/[id]/tenant-users-panel.tsx").includes("read_only")
        && src("app/pricing/page.tsx").includes("subscription_tiers")
        && src("app/demo/page.tsx").length > 0
        && src("app/actions/superadmin/platform-growth.ts").includes("proposal")
        && src("supabase/migrations/m272-platform-prospects-details.sql").includes("details"))
    }
    // ── ROUND 43: THE DEAL ROOM, THE UNSTACKED NOON, THE W-9 ON FILE ──
    {
      check("ROUND 43 — THE LAUNCH TRIAD. (1) THE DEAL ROOM DEMO: seven beats staged ONLY on the sanctioned is_demo tenant — the lead born through the production processRawRecord, qualification + Engine-2 conversion through the real chain, the deliberation GENUINELY argued (a real referral on listing_demand_bridge consumed through the production runDeliberation; no gateway key → honest 'unavailable', never canned), the Zoom + recap beats honest-staged with provenance headers; the runbook deep-links the REAL surfaces with presenter notes; hard is_demo refusal, the never-clobber guard over 14 human-data tables, markers everywhere, idempotent seed, 27-step FK-safe teardown with residue sweep. (2) THE UNSTACKED NOON: 70 of 72 per-tenant multiplier crons re-minuted (minutes only, periods identical — daily dispatch totals unchanged before/after), worst minute 2,643 → 246 jobs, jobs(N) 43+26N → 47+2N, the first shard boundary 18 → 227 TENANTS; the post-deploy smoke workflow runs test:production-smoke on every successful deployment with the stated-skip posture when secrets are absent. (3) THE W-9 ON FILE: the certified PDF on the round-28 doc rail, TIN TYPE ONLY — the TIN never stored in any column, never accepted as input; derived name-change expiry; SOFT gates on payouts + invoices (money never hard-blocked) with the badge both sides; the claim-then-send governed reminder once per period; the vendor invite-accept W-9 step + the critical-setup vendor item (m275 live, finance_manager stewarded)",
        src("lib/platform/deal-room-demo.ts").includes("assertDealRoomDemoTenant")
        && src("lib/platform/deal-room-demo.ts").includes("DEAL_ROOM_TEARDOWN_ORDER")
        && src("app/dashboard/superadmin/demo-room/page.tsx").length > 0
        && src("lib/kernel/cron-dispatch.ts").includes("(staggered r43)")
        && src(".github/workflows/post-deploy-smoke.yml").includes("test:production-smoke")
        && src("lib/vendors/w9-vocab.ts").length > 0
        && src("supabase/migrations/m275-vendor-tax-documents.sql").includes("tin_type")
        && src("lib/kernel/manager-registry.ts").includes("vendor_tax_documents")
        && src("scripts/schema-snapshot.ts").includes("vendor_tax_documents")
        && src("package.json").includes("test:deal-room-demo")
        && src("package.json").includes("test:vendor-w9"))
    }
    // ── ROUND 42: THE FRONT-LOADED ONBOARDING, THE LIVE CHECKLIST, THE MEASURED LOAD, THE DRILLED PATH ──
    {
      check("ROUND 42 — PRODUCTION READINESS AS CODE. (1) ONBOARDING FRONT-LOADS WHAT THE OS DEPENDS ON: the critical-setup registry (28 items, 6 roles, 8 categories — every checker a derived DB predicate, no aspirational rows, dismissal never enters the math) with the setup meter mounted on the Command Center + onboarding step 1 + the agent strip; THE CRITICAL FINDING fixed — lead_scraping_markets had create actions but NO page anywhere called them (every self-serve tenant's scrape pipeline would have silently no-oped forever) and inserted WITHOUT brokerage_id: the Lead Markets surface now exists driving the existing actions keep-one, brokerage_id stamped, prefilled from the pricing zip carry. (2) THE LAUNCH CHECKLIST LIVE: 31 grep-verified env-gate rows (10 blocking / 13 degraded / 8 optional), presence-only with a runtime canary so values are never echoed, on the go-live board keep-one; rate limits on the four worst public surfaces (one dependency-free per-instance limiter, documented honestly); monitoring + backup VERDICTS written not vendored; zero secrets findings; PRODUCTION-READINESS.md with the 11-step ops activation list. (3) THE SMOKE DRILL: the fresh-tenant golden path through the REAL code paths with dispatch-gate probes that refuse before any provider call and a residue sweep where any leftover row FAILS — live-fired end to end via the MCP handle to residue 0. (4) THE MEASURED LOAD: schedule math over the real 188-schedule registry — 72 per-tenant multipliers, worst minute Monday 12:00 UTC, jobs(N) = 43 + 26N, the 500-jobs/min budget crossed at 18 TENANTS — the first shard boundary is a documented number in LOAD-POSTURE.md, honestly labeled schedule-math not a network test",
        src("lib/onboarding/critical-setup.ts").includes("composeSetupReadiness")
        && src("app/dashboard/admin/markets/page.tsx").length > 0
        && src("app/actions/lead-scraping-config.ts").includes("brokerage_id")
        && src("lib/platform/launch-checklist.ts").includes("buildLaunchChecklist")
        && src("lib/security/public-rate-limit.ts").includes("checkPublicRateLimit")
        && src("PRODUCTION-READINESS.md").length > 0
        && src("LOAD-POSTURE.md").length > 0
        && src("scripts/production-smoke-drill.ts").includes("PRODUCTION_SMOKE_PASS")
        && src("scripts/dispatcher-load-simulator.ts").includes("DISPATCHER_LOAD_PASS")
        && src("package.json").includes("test:onboarding-readiness")
        && src("package.json").includes("test:launch-checklist")
        && src("package.json").includes("test:production-smoke")
        && src("package.json").includes("test:dispatcher-load"))
    }
    // ── ROUND 41: THE CLIENT RECAP, THE WHOLE TEAM ARGUES, THE OS IN THE POCKET ──
    {
      check("ROUND 41 — THREE OWNER DIRECTIVES. (1) THE CLIENT MEETING RECAP: 'what we discussed' grounded point-by-point in verbatim transcript lines (no line, no point; zero points, no recap), 'what happens next' EXCLUSIVELY from the followthrough proposals actually created + follow-ups actually scheduled (client-facing kinds only — the agent coaching note never surfaces; zero artifacts → an honest nothing-needed line), brand-voice authored through the Fair-Housing gate with the deterministic floor, the author brief NEVER receives the transcript, PROPOSED via proposeClientMessage so a human approves, rendered as the distinct portal card where the transcript never reaches the client; one recap per call across all statuses; conservative triggers (zoom always, phone only ±3h of a consultation event). (2) THE WHOLE TEAM ARGUES, WITHOUT NOISE: every rounds-37-40 capability named in its steward's charter; TWO genuine edges added with live emitters (referral_fee_economics raised at the moment a fee is agreed, sequence_touch_cadence raised at the exact cap-exhausted drop); THREE candidates REJECTED with verdicts the sim itself locks (a non-deliberating manager without its documented verdict FAILS); 12/14 managers hold deliberative seats across 9 domains, and the manager-trust surface renders the registry-derived Team Argument Map with the honest never-deliberated line. (3) THE OS IN THE POCKET: the honest audit found the role-driven bottom nav already rendering for all 12 roles and the portal phone-workable — but PWA installability was ZERO (an orphaned manifest pointing at icons that did not exist); now a real manifest route (brand-driven with a hard valid fallback, standalone, verified 192/512 any+maskable icons), viewport-fit=cover + appleWebApp metadata, safe-area bottom nav, and the DELIBERATE documented no-caching-SW verdict (push-sw keeps push only — no fetch handler); MOBILE.md carries the sellable story",
        src("lib/ai-isa/meeting-recap.ts").includes("composeMeetingRecap")
        && src("lib/ai-isa/meeting-recap.ts").includes("MEETING_RECAP")
        && src("app/portal/[contactId]/components/RecentUpdatesFeed.tsx").includes("meeting_recap")
        && src("lib/kernel/manager-registry.ts").includes("referral_fee_economics")
        && src("lib/kernel/manager-registry.ts").includes("sequence_touch_cadence")
        && src("lib/managers/team-argument-map.ts").includes("composeTeamArgumentMap")
        && src("app/manifest.ts").includes("standalone")
        && src("app/components/layout/app-shell.tsx").includes("MobileBottomNav")
        && src("MOBILE.md").length > 0
        && src("package.json").includes("test:meeting-recap")
        && src("package.json").includes("test:mobile-readiness"))
    }
    // ── ROUND 40: THE MEETING THAT ACTS, THE NATIVE ROOM, THE OPEN TERRITORY, THE DIGNIFIED RETIREMENT ──
    {
      check("ROUND 40 — FOUR APPROVED RECS. (1) MEETING-TO-ACTION: one consumer, two sources (zoom transcripts at webhook time, phone calls on the hourly sweep) mapping intents to GOVERNED proposals — sell-first → the listing-side proposal, financing → pre-qual education, stated timelines → a follow-up at the parsed horizon on the schedule-followup columns (never clobbering), objections → agent coaching; the GROUNDING INVARIANT: no verbatim transcript line, nothing derives; dedupe-tagged per call; ZERO direct sends sim-locked. (2) THE NATIVE MEETING ROOM: pure HS256 SDK-JWT minting (appKey===sdkKey, clamped lifetime, General-app credential fallback where half-pairs never sign), role 1 only for the event's owning agent, ONLY @zoom/meetingsdk/embedded ever loads (the React-18-pinned entries are locked out — the repo runs React 19, .npmrc legacy-peer-deps keeps npm ci resolving like the lockfile), the round-39 iframe tier EXTRACTED as the keep-one fallback. (3) THE TERRITORY MARKETPLACE: a pure projection of the coverage board — {zip, city, state, leadCount, periodLabel} and NOTHING else (no tenant identities, no PII, no claimed-territory volume, platform-origin counts only, ≥5 floor, N+ on capped reads); three honest public states (available / served-no-numbers / no-recorded-volume); the zip carries through signup into billing_metadata.signup_intent and SUGGESTS the first market — nothing auto-created. (4) PARKED RETENTION: fresh/aging/stale tiers (unprovable age = fresh, never purged on a guess), superadmin-proposed archival with exact preview that anonymizes IN PLACE (PII nulled, zip/source/timestamps retained so coverage counts survive — rows never deleted), pii_purged_at marker on enrichment_profile, full audit receipt",
        src("lib/ai-isa/meeting-followthrough.ts").includes("MEETING_FOLLOWTHROUGH")
        && src("lib/connections/zoom-transcripts.ts").includes("runMeetingFollowthroughForCall")
        && src("lib/connections/zoom.ts").includes("mintZoomSdkSignature")
        && src("app/dashboard/meetings/[eventId]/join-fallback.tsx").includes("ZoomJoinFallback")
        && src(".npmrc").includes("legacy-peer-deps")
        && src("lib/platform/territory-marketplace.ts").includes("MARKETPLACE_MIN_LEADS")
        && src("app/pricing/territory-availability.tsx").length > 0
        && src("lib/lead-pipeline/parked-retention.ts").includes("pii_purged_at")
        && src("app/actions/superadmin/parked-retention.ts").includes("requireSuperadmin")
        && src("package.json").includes("test:zoom-embed")
        && src("package.json").includes("test:territory-marketplace")
        && src("package.json").includes("test:meeting-followthrough"))
    }
    // ── ROUND 39: THE NAMED LEAD, THE PARKED LEAD, THE MAPPED TERRITORY, THE MEETING THAT REMEMBERS ──
    {
      check("ROUND 39 — TWO CORRECTIONS + THREE BUILDS. (1) ELIGIBILITY NEEDS THE NAME: promotion = (first AND last name) AND (email AND/OR mailing address) — per-dimension failing keys ('name' retryable by enrichment vs 'contact_anchor'), phone still not an anchor; collateral honesty in lead-promoter (columns it never selected, the blanket verified-mailing stamp) fixed. (2) PARKED, NEVER DISCARDED: platform leads are BORN parked (brokerage_id NULL until Engine 1 assigns a subscriber) — every ISA sweep is structurally unable to select them plus the hard stop:parked_awaiting_distribution refusal; the 2-hour sweep retries forever, un-park stamps distributed_at and speed-to-lead opens its window on it. No migration — parked is existing vocabulary. (3) THE COVERAGE BOARD: claims via the SAME active-tenant predicate the scrapers use (stale claims never shown live), per-zip volume incl. the awaiting-subscriber set, superadmin state→zip table + the tenant 'Your coverage' card with hints limited to unclaimed zips carrying REAL platform-lead volume. (4) SCRAPE ROI PER MARKET: raw→promoted→converted→first-appointment with honest denominators; cost RECORDED-ONLY ('cost not recorded', never estimated); 2x cost-per-promoted divergence (both sides ≥5 promoted with recorded cost) raises the referral on the EXISTING lead_quality_spend deliberative edge. (5) THE ZOOM LANE at every tier: the scope idiom (platform_zoom distinct key, exact-owner cascade, vendor honest not-offered), REAL meetings only on API acceptance, the in-OS meeting room with the Component-SDK upgrade stated not faked, webhook-validated transcripts (x-zm-signature, reject-all without the secret) attached to the CONTACT for tenant meetings and the TENANT for platform meetings, insights through the SAME extractVoiceIntel core as every voice call with provenance zoom_transcript",
        src("lib/lead-pipeline/canonical-lead-eligibility.ts").includes("failing: 'name'")
        && src("app/actions/ai-isa/initiate-engagement.ts").includes("parked_awaiting_distribution")
        && src("lib/analytics/territory-coverage.ts").includes("composeCoverageBoard")
        && src("lib/analytics/territory-roi.ts").includes("publishTerritoryRoiReferrals")
        && src("lib/connections/zoom.ts").includes("platform_zoom")
        && src("lib/voice/call-analysis.ts").includes("extractVoiceIntel")
        && src("lib/connections/zoom-transcripts.ts").includes("extractVoiceIntel")
        && src("app/api/webhooks/zoom/route.ts").includes("x-zm-signature")
        && src("package.json").includes("test:territory-coverage")
        && src("package.json").includes("test:zoom-lane"))
    }
    // ── ROUND 38: SCRAPE ONLY WHERE WE SERVE, GRADE THE ROUTING, SWEEP THE UNPLACED ──
    {
      check("ROUND 38 — THE CANONICAL SCRAPING PRE-PIPELINE + TWO APPROVED RECS. (1) TERRITORY-GATED SCRAPING: ONE shared pre-scrape resolver (resolveActiveScrapeTerritories — the union of ACTIVE/trialing tenants' lead_scraping_markets) consumed by the master lead-scraping cron, the kernel orchestrator, and the sourcers; no subscribers or no territories → an honest stated no-op (no_active_subscribers), NEVER a global scrape; deviations killed: LinkedIn's geo-empty global scrape, the intent campaign running for churned tenants, the ungated kernel orchestrator. (2) DEDUP AGAINST ALL THREE TABLES (raw_scraped_leads + leads + contacts) in BOTH the pre-enrich and post-enrich passes, deterministic older-wins. (3) ELIGIBILITY = the owner's exact rule: at least an email AND/OR a mailing address (contact_anchor failing key) — phone no longer counts, the blanket mailing_address_verified stamp is gone. (4) BROKERAGE PICKUP deterministic: each raw row bound to the ONE market it was scraped for; platform leads round-robin the per-zip subscriber roster. (5) ASSIGNMENT POLICIES GRADED — the 13th accuracy rail: assignment_log rule attribution → first booked appointment within the declared horizon, open windows never graded early, Track-B attribution starts now with honest not-yet; AND ARGUED — the assignment_policy_outcomes deliberative edge (ai_isa + data_steward) with a live divergence emitter (≥20 pts, ≥8 graded each, weekly-deduped). (6) THE DISTRIBUTION SWEEP: platform-lead-distribution cron every 2h (data_steward) finally calls distributePendingPlatformLeads — honest outcome counts, idempotent on the engine's own optimistic lock",
        src("lib/lead-pipeline/scrape-territories.ts").includes("resolveActiveScrapeTerritories")
        && src("lib/lead-pipeline/scrape-territories.ts").includes("no_active_subscribers")
        && src("app/api/cron/lead-scraping/route.ts").includes("resolveActiveScrapeTerritories")
        && src("lib/lead-pipeline/canonical-lead-eligibility.ts").includes("contact_anchor")
        && src("lib/analytics/assignment-outcomes.ts").includes("assignment_policy_outcomes")
        && src("lib/kernel/manager-registry.ts").includes("assignment_policy_outcomes")
        && src("lib/kernel/cron-dispatch.ts").includes("/api/cron/platform-lead-distribution")
        && src("lib/kernel/manager-registry.ts").includes('"/api/cron/platform-lead-distribution": "data_steward"')
        && src("app/api/cron/platform-lead-distribution/route.ts").includes("distributePendingPlatformLeads"))
    }
    // ── ROUND 37: THE ONE DOOR, VENDORS FOR EVERY TIER, THE THROTTLE MADE VISIBLE, BOOKS RECONCILED ──
    {
      check("ROUND 37 — FOUR OWNER DIRECTIVES. (1) THE CANONICAL LEAD PROCESS ENFORCED: four manual raw→lead doors REMOVED (the promoteLead action + its voice overload, the bench Promote button — now the read-only pipeline bench whose pipelineRetryEligible describes the AUTOMATIC pipeline's retry posture and is never a manual affordance, the on-demand POST); the lead-scraping cron's processRawRecord is the ONLY door, and killing the manual lane exposed + fixed the gap it hid — platform-origin promotions fire distributePlatformLead INLINE with source_origin riding along; conversion is QUALIFIED-ONLY server-side at every entrance (the kernel refuses lead_stage !== 'qualified', eligibility Rule 0, the ISA appointment lane stamps its genuine qualification outcome first); voice re-scoped to convert_lead — broker/admin, riding Engine 2 whose gate refuses unqualified and consumes the admin's assignment_rules policy (verified pre-existing: round-robin/load-balance/geo/specialization with the honest capacity-aware default). (2) AGENTS AND TEAMS INVITE + CHARGE VENDORS: attribution on the vendor row (invited_by_user_id first-inviter-wins + the inviter's LED team, l81 with honest backfill — team attribution NOT fabricated retroactively); agents charge only THEIR vendors through the ONE createVendorInvoice lane, attribution as a zero-amount typed line item, premium placement stays brokerage-level as a documented verdict. (3) THE THROTTLE MADE VISIBLE: every accuracy-gate hold ledgered on self_heal_events (burst-collapse per domain+brokerage, verbatim measured reason, same-verdict-no-drift, fail-open) with the 'Autonomy throttled' card on manager-trust. (4) BOOKS RECONCILED: pure read-side QB reconciliation per scope — every surface states it reconciles OS ledgers vs OS-recorded exports NOT a live QuickBooks pull; coverage/amounts/named unexported rows, honest requires_migration and no-export-lane states; one keep-one card on all five accounting surfaces + the omit-when-empty board-packet section",
        src("lib/lead-promotion/review-status.ts").includes("pipelineRetryEligible")
        && src("lib/lead-pipeline/pipeline-processor.ts").includes("distributePlatformLead")
        && src("lib/kernel/crm.ts").includes('lead_stage !== "qualified"')
        && src("lib/voice/broker-commands.ts").includes("voiceConvertLead")
        && !src("app/actions/lead-promotion/promote-lead.ts").includes("export async function promoteLead(")
        && src("app/actions/vendor-invite.ts").includes("invited_by_user_id")
        && src("lib/vendors/vendor-scope.ts").includes("PREMIUM_PLACEMENT_SCOPE")
        && src("scripts/schema-snapshot.ts").includes("invited_by_user_id")
        && src("lib/managers/accuracy-gate.ts").includes("recordAccuracyGateHold")
        && src("lib/finance/qb-reconciliation.ts").includes("QB_RECONCILIATION_HEADER")
        && src("app/settings/accounting/qb-reconciliation-card.tsx").length > 0
        && src("package.json").includes("test:vendor-scope-charging")
        && src("package.json").includes("test:accuracy-gate-telemetry"))
    }
    // ── ROUND 36: BOTH SIDES OF THE TABLE, MONEY BOOKS EVERYWHERE, THE FULL ARGUMENT, THE FALLEN SESSION WALL ──
    {
      check("ROUND 36 — SEVEN OWNER DIRECTIVES. (1) SELLER CLOSING COSTS: sellerShareFactor complements the buyer shares across all 51 regions; commission NEVER assumed (the deal's records or absent), payoff honest-pending; KEEP-ONE with the canonical net sheet (its closing-cost section derives from the regional model, manual override preserved); ONE accuracy ledger two sides — l79 side discriminator, UNIQUE per transaction+document+side, seller lines graded off settlement statements. (2) SIX-RAIL AUDIT: ai_predictions gets its real outcome writer, win_probability gets FROZEN snapshots (captureWinProbabilitySnapshot — no more hindsight), content outcomes measured on the weekly cron; the rest keep documented verdicts. (3) ACCURACY-DRIVEN AUTONOMY: the ONE dispatch gate consults loadAccuracyHoldForManager before honoring an explicit 'autonomous' posture — held to the approval queue with the measured reason, halts never overridden, fail-open on infra. (4) BOOKS AT EVERY LEVEL: one scope-aware accounting layer (platform | brokerage | team | agent | vendor) — the platform's own books use a DISTINCT storage key tenant aliases can never resolve; team P&L + agent commission exports push to the CONNECTED scope's QuickBooks with honest sync markers; Stripe-for-teams/agents recorded as honest not-offered verdicts. (5) DELIBERATION COMPLETELY BUILT OUT: the arguable-overlap roster (price-reduction timing, appraisal-gap response, budget shifts, recruiting terms, vendor selection, channel allocation + the original three) each with a live emitter + grounded loaders; ONE bounded rebuttal round; THE PRINCIPAL'S CALL override recorded on the same ledger and counted in teamwork. (6) VOICE PHASE 2: client-param overloads with the cookie default preserved — reject/counter/withdraw offers, promote lead (round-33 scope policy holds), reassign, in-app broadcast, BBA-gated showing requests all speakable through the same transitions. (7) ZERO PHANTOM TOOLS: registry↔dispatcher parity both directions",
        src("lib/offers/seller-closing-costs.ts").includes("sellerShareFactor")
        && src("lib/offers/closing-cost-accuracy.ts").includes('side: "seller"')
        && src("scripts/schema-snapshot.ts").includes('"side"')
        && src("lib/analytics/ai-prediction-outcomes.ts").includes("captureWinProbabilitySnapshot")
        && src("lib/providers/dispatch.ts").includes("loadAccuracyHoldForManager")
        && src("lib/managers/accuracy-gate.ts").includes("loadAccuracyHoldForManager")
        && src("lib/connections/accounting-scopes.ts").includes("PLATFORM_BOOKS_STORAGE_KEY")
        && src("lib/finance/scoped-accounting-export.ts").includes("pushTeamPnlToQuickBooks")
        && src("lib/managers/deliberation.ts").includes("rebuttal")
        && src("lib/managers/deliberation.ts").includes("principal")
        && src("lib/kernel/offers.ts").includes("client ?? await createClient()")
        && src("lib/voice/deal-decision.ts").includes("voiceRejectOffer")
        && src("package.json").includes("test:seller-closing-costs")
        && src("package.json").includes("test:accounting-scopes"))
    }
    // ── ROUND 35: THE SPOKEN CLICK, THE ARGUED SOLUTION, THE SELF-GRADING OS ──
    {
      check("ROUND 35 — THREE APPROVED RECS + THE MISSED-WORK SWEEP (baseline-0 sweeps green; the round-34 vendor money surface got its first-class nav entry). (1) VOICE-ADMIN COVERAGE: lib/voice/command-coverage.ts is the honest typed map — 50 commands / 13 domains, 40 speakable, 10 speakable:false each carrying the concrete RLS-or-dispatcher reason (verified against LIVE RLS that cookie-client kernel commands can never run from the sessionless ElevenLabs webhook); ACCEPT OFFER BY VOICE rides acceptOfferConditionally — the ONE compliance-gated service-client path that creates a transaction — behind a guard mirrored check-for-check from the approvals queue, reachable by webhook tool + free speech + Command-Center bar (one transition, three doors), receipts on the existing agent_assistant_tool_calls + voice_action rails; reject/counter stay honestly not-yet rather than forked; the 'What can I say?' panel derives from the registry. (2) MANAGERS ARGUE THE SOLUTION (owner: 'argue a solution and work through the reason why that solution is the best'): three deliberative collaboration domains (pricing dispute, compliance-vs-speed, budget rebalance); each co-manager argues proposal/reasoning/risks/evidence via the gateway GROUNDED in its own stewarded tables with filterEvidenceToCitations discarding any evidence not verbatim from the loader — no argument stands on an invented fact; resolution states why-the-winner-beats-the-others, dissent recorded only on merit, unreachable gateway → honest 'unavailable' never canned arguments; persisted on the referral row itself (no new table), teamwork rollup (handed-off/resolved/median-pickup/deliberations/dissents) on the QBR + manager-trust. (3) THE SELF-GRADING OS: lib/analytics/prediction-accuracy.ts unifies EIGHT rails where prediction AND outcome genuinely exist (closing costs, net-sheet, pre-sale listing price vs sold — no hindsight grading, DOM, open-house attendance, offer strategy, human-graded patterns, content performance), six candidates excluded with documented reasons, withinRate only where the source defines the tolerance, one keep-one panel mounted superadmin + broker (the round-34 closing-cost card MERGED in), trust chip with explicit computed thresholds consumed by pitch kit + QBR and OMITTED below threshold",
        src("lib/voice/command-coverage.ts").includes("speakable")
        && src("lib/voice/deal-decision.ts").includes("acceptOfferConditionally")
        && src("app/api/agent-assistant/tool-call/route.ts").includes("accept_offer")
        && src("app/dashboard/voice/page.tsx").includes("VoiceCoveragePanel")
        && src("lib/managers/deliberation.ts").includes("filterEvidenceToCitations")
        && src("lib/kernel/manager-registry.ts").includes("deliberate")
        && src("lib/managers/teamwork-metrics.ts").includes("rollupTeamwork")
        && src("lib/intelligence/quarterly-review.ts").includes("teamwork")
        && src("lib/analytics/prediction-accuracy.ts").includes("getPredictionAccuracyReport")
        && src("lib/analytics/prediction-accuracy.ts").includes("composePredictionTrustChip")
        && src("lib/recruiting/recruiting-pitch-kit.ts").includes("accuracyTrustLine")
        && src("app/config/navigation-config.ts").includes("/vendor/invoices")
        && src("package.json").includes("test:voice-command-coverage")
        && src("package.json").includes("test:manager-deliberation")
        && src("package.json").includes("test:prediction-accuracy"))
    }
    // ── ROUND 34: DEAL DECISIONS, THE TEAMMATE VIDEO, TWO-WAY VENDOR MONEY, CROSS-MANAGEMENT, THE FLYWHEEL ──
    {
      check("ROUND 34 — FIVE OWNER DIRECTIVES. (1) OFFERS ARE DEAL DECISIONS, NOT MARKETING: the unified queue renders them in their own section, only INBOUND offers awaiting OUR side's response appear (outbound buyer offers on outside properties are the other side's call), and the response set is complete — acceptOffer / rejectOffer / COUNTER via the kernel's issueCounterOffer (offer_type='counter', parent_offer_id, current_round) through /api/approvals/counter with the same tenant guard. (2) THE TEAMMATE VIDEO (deferred ~15 rounds, unblocked; NO HeyGen): avatar explainers — AI-authored compliance-gated script in the tenant's voice, ElevenLabs speech (clone when configured, labeled stock otherwise), D-ID avatar render, TeammateExplainerReel Remotion composition carrying its OWN brand frames (supports_bookends=false) — riding the EXISTING Director rail into ai_video_projects video_type='avatar_explainer' (m274) and the unified queue; no DID_API_KEY → the commission parks honestly at 'awaiting_provider' with the reason stated. (3) TWO-WAY VENDOR MONEY: vendors invoice buyers/sellers from accepted transaction jobs (billed_to='contact', governed TRANSACTIONAL dispatchEmail, pay-online via the vendor's Stripe Connect else documented off-platform assertion); tenants charge vendors beside premium placement; vendor-scope QuickBooks markers quickbooks_invoice_id/synced_at (l78) stay null until a REAL sync. (4) CROSS-MANAGEMENT: MANAGER_COLLABORATIONS declares the real stewardship overlaps; cross_manager_referral rides the governed bus (SIGNAL_REGISTRY, zero orphans) with the shared handler REFUSING any from→to pair outside a declared edge; first live emitter is the approval-SLA sweep referring >48h-aging kinds to their owning managers; voice-expansion grants/revokes are audited. (5) THE CLOSING-COST FLYWHEEL: closed transactions with a scanned Closing Disclosure record ONE observation (l77, UNIQUE per transaction+document, provenance-checked extractions only, cash-to-close as context NEVER compared) grading the regional bands per state — the rollup ARMS finance_manager's yearly convention review, auto-adjusting NOTHING",
        src("lib/kernel/approval-queue-aggregator.ts").includes("issueCounterOffer")
        && src("app/api/approvals/counter/route.ts").includes("issueCounterOffer")
        && src("lib/video/avatar-explainer.ts").includes("avatar_explainer")
        && src("lib/video/avatar-explainer.ts").includes("awaiting_provider")
        && src("remotion/TeammateExplainerReel.tsx").includes("TeammateExplainerReel")
        && src("lib/video/avatar-explainer.ts").includes("no HeyGen") // the exclusion is stated policy in the module doc
        && src("lib/connections/vendor-quickbooks.ts").includes("quickbooks_invoice_id")
        && src("app/actions/vendor-payments.ts").includes('channelPurpose: "transactional"')
        && src("lib/kernel/manager-registry.ts").includes("MANAGER_COLLABORATIONS")
        && src("lib/kernel/signal-registry.ts").includes("cross_manager_referral")
        && src("lib/kernel/approval-sla.ts").includes("loadApprovalSla")
        && src("lib/offers/closing-cost-accuracy.ts").includes("closing_cost_accuracy_observations")
        && src("lib/transactions/stage-progression.ts").includes("recordClosingCostAccuracy")
        && src("scripts/schema-snapshot.ts").includes("closing_cost_accuracy_observations")
        && src("scripts/schema-snapshot.ts").includes("quickbooks_invoice_id"))
    }
    // ── ROUND 33: SIX POLICY CORRECTIONS + THE FLAGGED-LOOP BURN ──
    {
      check("ROUND 33 — SIX OWNER POLICIES + every agent-flagged deferred loop closed (teammate video excluded). (1) APPROVALS SPAN EVERYTHING: the unified queue gains blog_posts (publish_status ladder), podcast_episodes (pending_review → distribution channels), ai_video_projects (commissioned renders awaiting release), and offers — approve IS the acceptOffer kernel command /offers uses, reject IS rejectOffer, zero forked transitions. (2) NOTIFICATIONS = ALL USERS: /notifications nav parity for every tenant role block (ISA, vendor, compliance officer joined); portal contacts keep the portal bell. (3) ADVERTISING INCL. NEWSLETTER = ALL TIERS. (4) LEADS = BROKERAGE + PLATFORM ONLY (nav entries removed from agent/ISA blocks AND server-enforced on pages, routes, actions), RAW LEADS = PLATFORM ONLY (/api/leads/raw flipped from any-authenticated-tenant to requirePlatformStaffAuth — tenants first see data as promoted leads). (5) EXCEPTION CENTER for brokerage + per-location multi_location scoping. (6) VOICE EXPANSION: management opt-in (voice_assistant_expanded_roles) extends the assistant to staff roles; platform staff by platform_role. (7) CLOSING COSTS BY REGION: pure 50-state+DC convention table — every figure labeled 'regional estimate — {state} conventions', lender's Loan Estimate the named authority, AI refinement clamped within the regional band (lender-fact + pending lines untouchable, reason required); RefinanceIndicatorCard + wealth scan re-source real loans from transaction_lenders. Round-32 deferreds landed: broker→agents broadcast (in-app only, team scoping server-forced), per-contact reassignment (the bulk move-set reused), merge extended 2→18 child pairs abort-before-delete. Plus: weekly stripe-drift cron (finance_manager, never auto-fixes, same comparePlanPriceToStripe rule as manual sync) + affiliate ?ref capture through the ONE cookie-setter",
        src("lib/kernel/approval-queue-aggregator.ts").includes("blog_posts")
        && src("lib/kernel/approval-queue-aggregator.ts").includes("podcast_episodes")
        && src("lib/kernel/approval-queue-aggregator.ts").includes("ai_video_projects")
        && src("lib/kernel/approval-queue-aggregator.ts").includes("acceptOffer")
        && src("lib/kernel/approval-queue-aggregator.ts").includes("rejectOffer")
        && src("app/config/navigation-config.ts").includes("LEADS = BROKERAGE + PLATFORM ONLY")
        && src("app/api/leads/raw/route.ts").includes("requirePlatformStaffAuth")
        && src("lib/kernel/exception-center.ts").includes("multi_location")
        && src("app/actions/voice-access.ts").includes("setVoiceAssistantExpandedRoles")
        && src("lib/brokerage/get-brokerage-settings.ts").includes("voice_assistant_expanded_roles")
        && src("lib/offers/regional-closing-costs.ts").includes("applyAiRefinements")
        && src("lib/offers/regional-closing-costs.ts").includes("regional estimate")
        && src("app/components/portal/lifetime/RefinanceIndicatorCard.tsx").includes("transaction_lenders")
        && src("app/actions/communications.ts").includes("notifyBrokerageAgentsAction")
        && src("lib/billing/plan-catalog.ts").includes("comparePlanPriceToStripe")
        && src("lib/kernel/cron-dispatch.ts").includes("/api/cron/stripe-drift")
        && src("lib/platform/affiliate-ref-capture.ts").includes("refCaptureRedirect")
        && src("package.json").includes("test:regional-closing-costs"))
    }
    // ── ROUND 32: THE TENANT MIRROR — SUB-ACCOUNT PARITY, LOAN TRUTH, LETTER EDUCATION ──
    {
      check("ROUND 32 — THREE OWNER DIRECTIVES. (1) TENANT SUB-ACCOUNT DRILL (A-E × four tiers): 12 real fixes — four tenant nav links pointed at FORBIDDEN superadmin consoles, the Command Center had ZERO nav entries (QBR-email-deep-link only), /settings/users bypassed the tier matrix with raw client-side updates (now rides the guarded updateUser + audited deactivation), solo principals were refused from bulk campaigns (now the same solo-tier allowance the voice rail had), the autonomy-halt banner reached the landing dashboards, synced social metrics became tenant-visible, the staff portal-clients roster got its TENANT mirror via a keep-one read extraction (/crm/portal-clients; the superadmin action delegates), dead /crm/{id} links fixed, advertising/voice/notifications nav parity for every principal role. Verdict ALMOST — held on broker→agents broadcast, per-contact reassignment, merge/dedupe UI. (2) LOAN-TERMS DE-ASSUMPTION (owner: never assume conventional): the hierarchy lender → transaction → offer terms → pre-approval → GENUINELY UNKNOWN (no assumption tier) coded across the appraisal copilot (20%-down path REMOVED), closing costs (silent price×0.8 gone; pending-not-zero lines), the offer budget ceiling (fabricated 110%-of-list gone), four display sites, and TWO clobber bugs where upserts overwrote real finance facts; provenance labels wherever a letter exists; l76 makes letter_type + issued_date first-class and drops the NOT-NULL that forced the placeholder. (3) LETTER EDUCATION THROUGH THE KERNEL: the agent curriculum gains financing_letter_strength (authored via the existing idiom, both coaching angles); the buyer lesson is stage-tagged so determinePortalView + buyer_stage + the pending pre-approval milestone decide when it surfaces and when it stops; the pure letter-strength assessment keys ONLY off real fields (verified / unverified-letter / absence / expiry — never a fabricated type) and drives the checklist upgrade line + the offer brief's honest weakness note",
        src("app/config/navigation-config.ts").includes("/dashboard/admin/command-center")
        && src("app/components/shell/autonomy-halt-notice.tsx").length > 0
        && src("lib/portal/portal-clients-read.ts").length > 0
        && src("app/crm/portal-clients/page.tsx").length > 0
        && src("lib/kernel/appraisal-negotiation.ts").includes("resolveLoanTermsForTransaction")
        && src("lib/kernel/appraisal-negotiation.ts").includes("loanTermsProvenanceLabel")
        && !/0\.8|0\.2|20% down|conventional/.test(src("lib/kernel/appraisal-negotiation.ts"))
        && src("lib/offers/buyer-closing-costs.ts").includes("pending")
        && src("scripts/schema-snapshot.ts").includes("letter_type")
        && src("lib/financing/letter-strength.ts").includes("assessFinancingLetterStrength")
        && src("lib/education/onboarding-curriculum.ts").includes("financing_letter_strength")
        && src("lib/education/client-education-curriculum.ts").includes("buyer_letter_strength")
        && src("package.json").includes("test:letter-strength"))
    }
    // ── ROUND 31: THE CERTIFICATION FLIPS — EVERY PERSON A SUBSCRIBER ADDS, SUPPORTABLE ──
    {
      check("ROUND 31 — THE FOUR BLOCKERS CLOSED; the round-30 'NEARLY' becomes YES. (1) PORTAL CLIENTS ARE FIRST-CLASS USERS (the owner's identity correction, verified: user_type='contact' was in the users CHECK from day one; portal invites mint real auth users via OTP): ensureContactPortalUser creates the missing public.users row on the contact's own first authenticated portal entry (checked insert via sentinelWrite, link-back stamped, portal access NEVER fails on it), a backfill action covers existing clients with honest DB-confirmed counters, the staff roster badges them 'Portal client', and enterTenantAction returns a server-resolved landing route so staff entering a contact-type user land on THEIR portal — with a defence-in-depth rule granting the live impersonation session portal access. (2) THE STAFF→TENANT-ADMIN COMPOSER: suppression-checked canonical sendEmail (B2B-transactional, allowlist-reviewed), success only on provider acceptance, in-app notifications mirror, subject audited NEVER the body, distinct refusals, AI-draft grounded in real facts in the PLATFORM's voice with a stated fallback source — two mounts, one composer. (3) PER-TENANT AUTONOMY HALT in feature_access_overrides — the ONE home with no tenant-side write path (managed_agents.config is broker-writable; brokerages jsonb is under the tenant admin's row-level RLS) — enforced at the exact god-switch hook with sim-proven precedence (god switch > tenant halt > broker posture; human/transactional sends untouched), reason required, audited, the tenant told VERBATIM why on their Command Center. (4) PER-TENANT SEAT OVERRIDE in billing_metadata (the overrides table has no numeric column — smuggling a number would be dishonest): ONE effectiveSeatLimit resolution used by the invite gate, the god-console create, and the seat meter's honest '(custom limit)'",
        src("lib/portal/portal-invite-core.ts").includes("ensureContactPortalUser")
        && src("app/actions/superadmin/portal-clients.ts").includes("backfillPortalClientUsersAction")
        && src("app/actions/superadmin/impersonation.ts").includes("redirectTo")
        && src("app/dashboard/superadmin/brokerages/[id]/tenant-users-panel.tsx").includes("Portal client")
        && src("app/actions/superadmin/tenant-message.ts").includes("sendTenantAdminMessageAction")
        && src("app/actions/superadmin/tenant-message.ts").includes("isEmailOnSuppressionList")
        && src("lib/managers/autonomy-gate.ts").includes("loadTenantAutonomyHalt")
        && src("app/dashboard/admin/command-center/autonomy-halt-banner.tsx").length > 0
        && src("lib/kernel/tier-role-matrix.ts").includes("effectiveSeatLimit")
        // seat-cap lane: the invite gate reaches effectiveSeatLimit through
        // seatGate now — the ONE gate every add path shares (lib/kernel/seat-usage.ts),
        // which is where the override resolution moved. Same single resolution,
        // one caller instead of five.
        && src("app/actions/admin/invite-user.ts").includes("seatGate")
        && src("lib/kernel/seat-usage.ts").includes("parseSeatOverride"))
    }
    // ── ROUND 30: THE PLATFORM CERTIFICATION — COVERAGE, CLOSED LOOPS, AND THE HONEST 'NEARLY' ──
    {
      check("ROUND 30 — CERTIFICATION ROUND, THREE PILLARS. (1) MANAGER COVERAGE: 73/73 tables stewarded; the five platform revenue ledgers moved to finance_manager (the writer/steward split was real drift); THE PLATFORM SENTINEL — previously an unregistered ghost invoked as hand-kept prose — is now a REGISTRY-OWNED platform-scope manager (PLATFORM_MANAGERS + resolvePlatformManager, deliberately NOT a 15th tenant seat: it governs the fleet, not a tenancy), and the staff queue renders the registry persona; four proof-ledger entries added pointing only at real sims. (2) OPEN LOOPS 20-29: eight flagged items verdicted in CODE — five already closed (incl. all five mock light-up paths arriving live with zero code changes), two closed now (inspection-completed both-party portal template; changelog current through the round-29 tenant capability), one correctly still deferred (webhook events with no emitter — the catalog forbids aspiration); plus the dead fake-success social publish stub converted to an honest failure. (3) STAFF DRILL A-F: real Stripe repricing with prorations, agent-level audited impersonation, god switch at dispatch + entitlement precedence #1, sentinel learning closing on verdicts, 5/5 audit spot-check; FIVE fixes (three orphaned surfaces carded incl. Fleet Numbers linked from nowhere, plan-catalog + support-console + connector-healing mutations now centrally audited, the DECORATIVE observability filter made real — staff could only ever see tenant #1's errors). HONEST VERDICT: NEARLY — ranked blockers recorded: portal-client support (contacts are invisible/un-impersonable), staff→tenant-admin proactive composer, per-tenant autonomy halt lever, seat override, affiliate motion for marketing role",
        src("lib/kernel/manager-registry.ts").includes("PLATFORM_MANAGERS")
        && src("lib/kernel/manager-registry.ts").includes("resolvePlatformManager")
        && src("lib/kernel/manager-registry.ts").includes("platform_coupons: \"finance_manager\"")
        && src("app/dashboard/superadmin/sentinel/sentinel-action-queue.tsx").includes("PLATFORM_MANAGERS.platform_sentinel")
        && src("lib/kernel/event-fanout.ts").includes("MILESTONE_COMPLETED")
        && src("lib/platform/changelog.ts").includes("2026-07-19")
        && !src("lib/services/social-publishing.service.ts").includes("Math.random")
        && src("app/actions/superadmin/plan-catalog.ts").includes("superadmin_audit_log")
        && src("app/actions/superadmin/support-console.ts").includes("superadmin_audit_log")
        && src("app/dashboard/superadmin/home/page.tsx").includes("/dashboard/superadmin/numbers"))
    }
    // ── ROUND 29: EARNEST TRUTH + THE APPRAISAL PLAYBOOK (PREVENT + NEGOTIATE) + MEASURED SHARE ──
    {
      check("ROUND 29 — OWNER CORRECTIONS + THE APPRAISAL PLAYBOOK. (1) EARNEST DEPOSIT is a DOLLAR AMOUNT, kept typed apart from the DUE date: offer-bridge writes offers.earnest_money → transactions.earnest_money and derives the due date via deriveEarnestDueDate which REFUSES a non-date fallback; the offer card labels 'Earnest Deposit' as currency; the root-cause conflation in the compliance auto-create chain (amount fed into the due slot) is removed. (2) NO HARDCODED RESPONSES verdict: every client-facing round-27/28 composer already AI-authors with a deterministic fallback FLOOR — the rest are transparency/lifecycle cards or internal notifications (chrome). (3) SELLER-SHARE MEASURED: seller-share visits are now tenant-scoped (brokerage_id stamped on the landing session) and surface as a 'Seller-driven reach' intelligence-report section, omit-when-empty. (4) APPRAISER PACKET (prevention): on APPRAISAL_ORDERED for a seller-side deal, assemble the packet PDF (contract+counters+addendums, comps 1mi/6mo expanding-ladder w/ 1 pending + 1 active, seller upgrades w/ cost, order details, survey/floorplan; honest 'agent to obtain' for GIS/tax which have no provider rail) via the shared PDF engine + an agent coaching task ('be present + bring the packet'), idempotent, seller-gated. (5) APPRAISAL-GAP NEGOTIATION COPILOT (reaction): when the gap fires, an agent-facing transaction_tasks briefing with the THREE priced options (seller reduces / buyer brings cash / meet-in-middle-or-dispute — real lender-lends-against-the-lower math) backed by RentCast comps ranked at/above contract price, AI-authored framing w/ deterministic floor, idempotent per (transaction, appraisal value). Prevention + reaction now bracket the appraisal — a playbook no competitor ships",
        src("lib/transactions/earnest-terms.ts").includes("deriveEarnestDueDate")
        && src("lib/transactions/offer-bridge.ts").includes("earnest_money:        (offer as any).earnest_money ?? null")
        && !src("lib/workflow-orchestrator/chains/compliance-transaction-auto-create.ts").includes("earnestMoneyDue: extracted.earnestMoneyAmount")
        && src("lib/kernel/intelligence-report.ts").includes("composeSellerReachSection")
        && src("app/actions/listing-landing.ts").includes("brokerage_id")
        && src("lib/kernel/appraiser-packet.ts").includes("composeAppraiserPacket")
        && src("app/actions/transaction-milestones.ts").includes("markAppraisalOrderedAction")
        && src("lib/kernel/appraisal-negotiation.ts").includes("composeAppraisalGapOptions")
        && src("app/actions/transaction-milestones.ts").includes("runAppraisalNegotiationCopilot"))
    }
    // ── ROUND 28: THE PUNCH LIST + SELLER SHARES + THE INSIDE/OUTSIDE OFFER TRUTH ──
    {
      check("ROUND 28 — THE READINESS PUNCH LIST CLEARED + TWO OWNER ADDITIONS. (1) QBR INVITATIONS (was pull-only): a quarterly cron (registered, finance_manager) self-gates to the Q window, composes a brand-voiced invitation from REAL headline facts (omitted when none), notifies principals deduped per (user, quarter) via the notifications ledger, deep-links Command Center. (2) BROKER TRUST RECEIPTS (was client-only): the SAME continuity-receipt computation aggregated onto the intelligence-report page for principals. (3) APPRAISAL-CAME-IN-LOW (was silent): the value is now COMPARED to purchase_price and any shortfall emits APPRAISAL_GAP_DETECTED (calm buyer + seller-on-inside cards, deal-save huddle) — fully null-guarded, idempotent per (transaction, value), non-blocking. (4) DUAL-SIDE WEEKLY DEAL NOTE: one composer, two audiences — the seller on a dual-represented deal now gets the buyer's financing reframed in THIRD person ('the buyer's loan is in underwriting, a normal step toward your closing'), de-conflicted against the listing-side update. (5) PROACTIVE CLOSING-COST PUSH on entering CLOSING_PREP. (6) SELLER SHARES TO THEIR OWN CHANNELS (owner add): a no-OAUTH portal rail — Web Share API + Facebook/X/LinkedIn intent links + copy/download, PUBLISHED posts only, shares link to the tenant's own site with seller-share attribution; our tokens never touched. (7) INSIDE vs OUTSIDE OFFERS (owner add): representation-aware party resolution — an OUTSIDE buyer offering on OUR listing never receives buyer-side client rails and the SELLER only gets fanout when we represent them; outside-property deals with no listings row resolve an honest address from the transaction's own fields; every informing rail null-safe across both shapes",
        src("lib/intelligence/qbr-invitation.ts").includes("composeQbrInvitation")
        && src("app/api/cron/qbr-invitations/route.ts").includes("verifyCronAuth")
        && src("lib/kernel/cron-dispatch.ts").includes("qbr-invitations")
        && src("app/dashboard/intelligence-report/trust-receipts-card.tsx").length > 0
        && src("app/dashboard/intelligence-report/page.tsx").includes("TrustReceiptsCard")
        && src("lib/kernel/events.ts").includes("APPRAISAL_GAP_DETECTED")
        && src("lib/kernel/event-fanout.ts").includes("APPRAISAL_GAP_DETECTED")
        && src("app/actions/transaction-milestones.ts").includes("runAppraisalGapDetection")
        && src("lib/kernel/client-story-drafts.ts").includes('audience: "buyer" | "seller"')
        && src("lib/transactions/stage-progression.ts").includes("CLOSING_COSTS_READY")
        && src("app/portal/[contactId]/components/seller-mode/SellerSharePostsRail.tsx").includes("navigator.share")
        && src("app/portal/[contactId]/components/seller-mode/SellerSharePostsRail.tsx").includes("ref=seller-share")
        && src("lib/kernel/event-fanout.ts").includes("Your transaction")
        && src("lib/kernel/resolve-event-contacts.ts").includes("buyer_stage")
        && src("lib/transactions/offer-bridge.ts").includes("representsBuyer"))
    }
    // ── ROUND 27: EVERYONE STAYS INFORMED — THE SELLER HEARS, THE LOOPS CLOSE ──
    {
      check("ROUND 27 — THE READINESS AUDIT'S FINDINGS BECOME RAILS. (1) THE SELLER HEARS: runLaunchWarRoom fills a staged-artifacts struct from THIS RUN'S OWN results and pushes the seller an autonomous launch portal card (zero artifacts → no card) + a brand-voice proposed launch message on the approval rail; the weekly seller-updates cron gains the consolidated marketing receipt counting only REAL published posts + finished videos (no activity → no card; batch, never per-post). (2) BUYER LOOPS: feedback submission earns a warm ack in the SAME portal thread (token-validated ids, deduped per submission, honest fallback floor); first-touch inbox visibility VERDICTED RESOLVED with evidence (the round-94 ISA lane already merges the outreach ledger read-side). (3) THE GATE'S TRANSACTIONAL CONTRACT: showing reminders moved onto dispatchSms — DispatchSmsParams.transactional waives ONLY the express-consent rule for recipient-initiated sends while suppression/DNC/quiet-hours/opt-out/de-conflict/budget all still apply, and contactId/brokerageId/transactional forward to the inner TCPA gate; showing-lifecycle fell OFF the raw-sender allowlist — the reviewed surface shrank. (4) SWEEP FIXES: inspection scheduling now emits through emitTransactionEvent so the existing portal template actually reaches both parties; the intelligence report is nav-linked for principals. Move-in concierge verdicted INFORMED (rides the deal-health sweep by design). Deferred, ranked: QBR scheduled invitations, appraisal-low detector, dual-side weekly deal note, proactive closing-cost push, broker trust-receipt surface",
        src("lib/kernel/launch-war-room.ts").includes("composeSellerLaunch")
        && src("lib/kernel/listing-marketing-week.ts").includes("listing_marketing_week")
        && src("app/api/cron/seller-updates/route.ts").includes("pushWeeklyMarketingCard")
        && src("app/api/showings/feedback/[token]/route.ts").includes("showing_feedback_ack")
        && src("lib/kernel/showing-lifecycle.ts").includes("transactional: true")
        && !src("lib/kernel/showing-lifecycle.ts").includes("@/lib/providers/messaging")
        && src("lib/providers/dispatch.ts").includes("transactional?: boolean")
        && src("lib/providers/dispatch.ts").includes("no_tcpa_consent")
        && src("app/actions/transaction-inspections.ts").includes("emitTransactionEvent")
        && src("app/config/navigation-config.ts").includes("/dashboard/intelligence-report"))
    }
    // ── ROUND 26: TENANT READINESS — THE ID-CLASS PURGE, HONEST SENDS, AND THE LAST PLATFORM RAILS ──
    {
      check("ROUND 26 — THE CUSTOMER-FACING MIRROR OF THE PLATFORM AUDIT. (1) THE team_lead_id ID-CLASS PURGE: teams.team_lead_id is users.id (FK auth.users) — FIVE sites compared it against agents.id, silently locking team leads out of tenancy-principal status, their own Command Center, the Team policy tab, and their recruiting-pitch notifications; all fixed to compare userId directly, with the rule written into the code. (2) HONEST SENDS (informed-audit fixes): the anniversary email now routes through THE gate (dispatchEmail w/ contactId — it used to bypass consent/DNC/suppression via the raw comms service); birthday + referral touchpoints now DISPATCH before stamping 'sent' (they used to record 'sent' with NO send behind them); the review-request cron now actually dispatches the composed email and stamps review_requests 'sent' only on provider acceptance — refused drafts stay honestly 'pending' and the run reports drafted separately from processed. (3) SSO/SAML (l76 table live-fired): complete flow — server lib w/ Admin-API registration that goes 'active' ONLY on a returned provider id + honest not-enabled-on-plan state, tenant admin card, and domain-aware 'Sign in with SSO' on login that never enumerates domains. (4) STAFF NUMBER PROVISIONING: one shared search/purchase/bind pipeline (tenant action + staff fleet console, egress-reviewed as admin-API), providers+write gated, type-the-number release confirm, audited. (5) REGISTRY CORRECTIONS: vapi decommissioned on the board, osint/did/elevenlabs verified as rows, AI-transport row honest about how AI calls actually flow. (6) The Developers link shows for solo principals — the server gate stays the authority",
        src("lib/kernel/tenancy-principal.ts").includes("team_lead_id\", input.userId")
        && src("app/dashboard/admin/command-center/page.tsx").includes("team_lead_id\", user.id")
        && src("app/actions/lifetime-customer-touchpoints.ts").includes("dispatchEmail")
        && src("app/actions/lifetime-customer-touchpoints.ts").includes("dispatchSms")
        && !src("app/actions/lifetime-customer-touchpoints.ts").includes("sendAnniversaryComm")
        && src("app/api/cron/review-request-on-close/route.ts").includes("dispatchEmail")
        && src("app/api/cron/review-request-on-close/route.ts").includes("drafted")
        && src("lib/platform/tenant-sso.ts").includes("sso/providers")
        && src("app/actions/tenant-sso.ts").includes("checkSsoDomainAction")
        && src("app/login/page.tsx").includes("signInWithSSO")
        && src("lib/voice/number-provisioning.ts").length > 0
        && src("app/actions/superadmin/number-provisioning.ts").includes("requireWrite")
        && src("app/components/settings/SettingsSidebar.tsx").includes("/settings/developers'"))
    }
    // ── ROUND 25: THE MANAGERS GOVERN EVERYTHING + THE FULL PROVIDER TRUTH ──
    {
      check("ROUND 25 — GOVERNANCE CLOSES OVER THE NEW RAILS + THE OWNER'S CORRECTIONS. (1) MANAGERS TOGETHER: the round-24 rails publish onto the governed bus — webhook_endpoint_dead / affiliate_commission_accrued / custom_domain_verified / custom_domain_error, every type catalogued in SIGNAL_REGISTRY with an HONEST disposition (feed-only with stated reasons — a handled consumer would be a dead promise where the fix lives on the subscriber's server or their DNS registrar), failures self-heal-ledgered on ranked flows; signal-integrity zero-orphans green. (2) FULL-REGISTRY PROVIDER POSTURE (owner correction: ALL providers, not a trio): 60+ providers DERIVED from seven code sources — connector registry, tenancy matrix (scrapers fleet expanded), vendor ownership, guardian probes, cost rates, connected capabilities, geoapify config — spanning enrichment/scrapers/ai/esign/leadgen/social/payments; zero vendor calls on the board (deep-dives keep those), 'no traffic recorded' honesty, self-heal attention flags via the REAL composeSentinelLossReport and pull-drift quarantines as 'contract needs teaching'. (3) INCIDENT LOOP: 2+ consecutive critical downs PROPOSE a prefilled capability-named tenant notice — never auto-published, auto-withdrawn only while unpublished; staff own the all-clear. (4) BUDGET PRE-FLIGHT inside THE gate after every consumer-protection check, fail-open twice-enforced (a broken budget system never silences a consented message), refusals as collapsed Exception Center escalations with no dollar/vendor leakage; allowlisted direct senders deliberately un-gated because they never meter spend. (5) PROMOTER QUOTES join the intelligence report under the never-zero-padded rule. (6) CNAM/SHAKEN on the A2P machine — same TrustHub profile, same jsonb store, real policy SIDs, mock stops BEFORE submission persisting Twilio's real draft status; voice_integrity_error kept separate so a caller-ID hiccup never trips the stall assessor; stalls reach the sentinel as connection_expiry with :a2p: dedupe and internal-only notes. (7) The Developers nav admits solo principals — the server gate stays the authority",
        src("lib/kernel/signal-registry.ts").includes("webhook_endpoint_dead")
        && src("lib/kernel/signal-registry.ts").includes("affiliate_commission_accrued")
        && src("lib/kernel/signal-registry.ts").includes("custom_domain_verified")
        && src("lib/platform/provider-posture.ts").includes("getPlatformProviderRegistry")
        && src("lib/platform/provider-posture.ts").includes("getFullProviderPosture")
        && src("lib/platform/status-notice.ts").includes("composeProviderDownNotice")
        && src("app/api/cron/health-check/route.ts").includes("withdrawProposedStatusNotice")
        && src("lib/providers/dispatch.ts").includes("vendorBudgetPreflight")
        && src("lib/kernel/intelligence-report.ts").includes("composePromoterQuotesSection")
        && src("lib/voice/a2p-registration.ts").includes("runVoiceIntegrityRegistration")
        && src("lib/platform/platform-sentinel.ts").includes(":a2p:")
        && src("app/settings/layout.tsx").includes("developers"))
    }
    // ── ROUND 24: THE OS BECOMES A REAL PLATFORM — WEBHOOKS OUT, DOMAINS, NPS, AFFILIATES, PROVIDER TRUTH ──
    {
      check("ROUND 24 — FIVE PLATFORM RAILS (l74 applied, 7 tables live-fired residue 0). (1) OUTBOUND WEBHOOKS: nine events fan out from the ONE canonical lifecycle_events ledger (zero new emit sites; call.completed/price_reduced DROPPED — no writer exists, events are never faked), Stripe-style HMAC signing with constant-time verify, cursor+row-id-deduped enqueue, real POSTs with honest response capture, 1m/5m/30m/2h backoff → dead on the 5th; tenant Developers page with once-shown whsec_ secrets, delivery log, and self-serve API tokens on the exact agent_credentials idiom (real scope allowlist, never *), tier-gated Brokerage+. (2) WHITE-LABEL DOMAINS: host routing in proxy.ts (the consolidated middleware — a new middleware.ts would break the Next 16 build) as a branch-0 that only returns when it acts; active vanity hosts rewrite to /site/[slug] via a 60s TTL cache and can NEVER serve another tenant's slug; unknown hosts fall through untouched (no tenant rewrite, auth gate still runs, no platform-killing 404); Vercel Domains API mock-safe with rows honestly pending_dns and DNS records always shown. (3) NPS: once per quarter after 30 days tenancy, dismiss stores NOTHING, UNIQUE(user_id,period) is the idempotency; engagement board rollup; detractors ≤6 propose sentinel check-ins quoting their verbatim with an :nps: dedupe segment disjoint from the silence radar. (4) MRR AFFILIATES — NOT THE REV-SHARE TREE (owner directive in the code header): external partners only, ONE MRR definition (v_platform_margin, paying subscriptions only — trials never accrue), no-oracle cookie attribution, first-wins UNIQUE(brokerage_id), monthly accrual idempotent per (referral, period) never overwriting paid rows. (5) PROVIDER TRUTH: bounded Twilio fleet sweep (subaccount status, DB-vs-Twilio number inventory, MTD spend, per-number webhook drift), pure assessA2pStall surfacing STALLED registrations (the invisible #1 SMS blocker), SendGrid domain-auth + UNSYNCED-spam-report detection. Both new crons in the ONE dispatch registry with owning managers",
        src("lib/platform/tenant-webhooks-core.ts").includes("lead.captured")
        && src("lib/platform/tenant-webhooks.ts").includes("lifecycle_events")
        && src("lib/kernel/cron-dispatch.ts").includes("webhook-deliveries")
        && src("lib/kernel/cron-dispatch.ts").includes("affiliate-commissions")
        && src("lib/kernel/manager-registry.ts").includes('"/api/cron/webhook-deliveries"')
        && src("proxy.ts").includes("tenant_custom_domains")
        && src("lib/platform/custom-domains.ts").includes("VERCEL_TOKEN")
        && src("lib/platform/nps.ts").includes("quarterPeriods")
        && src("lib/platform/platform-sentinel.ts").includes(":nps:")
        && src("lib/platform/affiliates.ts").includes("NOT the rev-share tree")
        && src("lib/platform/affiliates.ts").includes("v_platform_margin")
        && src("lib/platform/provider-posture.ts").includes("assessA2pStall")
        && src("app/settings/developers/page.tsx").length > 0
        && src("scripts/schema-snapshot.ts").includes("affiliate_commission_events"))
    }
    // ── ROUND 23: THE OS PROVES ITSELF, LISTENS EVERYWHERE, SELLS ITSELF, KEEPS ITS CUSTOMERS ──
    {
      check("ROUND 23 — FOUR RAILS. (1) MONTHLY INTELLIGENCE REPORT: ONE pure composer fuses the three closed learning loops + attribution into the owner's monthly proof (draft quality via the EXISTING rollupDraftQuality, autonomy grants from the exact policy_decisions rows the ratchet writes incl. declines, attributed closed volume with the board packet's counting rules, team activity from the Command Center's own ledgers, write-sentinel loss trends where 4→0 renders because the trend IS data) — empty sections OMITTED never zero-padded; owner page principal-gated + the board packet's AI Team Intelligence section fed by the SAME composer. (2) FAIR-HOUSING CAPTURE CORRECTED (owner directive): buyer-STATED school districts and 55+/age-restricted communities ARE captured as criteria with literal evidence quotes — the line is STEERING, not honoring; quality adjectives ('good schools') and familial inference ('good for kids') stay out, and the NO-STEERING sentence lives in the code. The listener also READS: ISA inbound email + unified Twilio SMS ingress propose the same inactive alerts (source 'text_conversation', [TEXT_PROPOSAL] evidence, msg-id/hash dedupe) through the same pa: approval cascade pinned to inactive rows. (3) SELF-SERVE TRIAL FUNNEL: tier cards with live catalog pricing, newest-snapshot-per-recommendedTier resolution (payload ids only ever ship {id,name} to the public page), live coupon validation through the ONE pure layer, snapshot+coupon applied best-effort AFTER provisioning so neither can fail a signup, coupon parked in billing_metadata for the checkout rail. (4) SAAS LOOP-CLOSERS (l61 applied): cancellation SAVE-OFFER re-derived server-side from the coupon engine's own eligibility rules (client never picks the coupon; redemption-ledger-first; honest straight-to-confirm when unconfigured), tenant-facing STATUS NOTICE broadcast + What's-New page (in-repo changelog that ships WITH the release so notes can never describe features a tenant lacks; god-switch freezes stated to tenants), and the public /trust page whose every claim was verified against code — explicitly NO SOC-2 claims: honesty as the posture. Verdicts recorded: NPS, webhooks-out, SSO, white-label domains, external affiliates deferred (each needs real tables/infra — never stubbed)",
        src("lib/kernel/intelligence-report.ts").includes("composeIntelligenceReport")
        && src("lib/kernel/board-packet.ts").includes("intelligence")
        && src("lib/buyer-search/conversation-criteria.ts").includes("detectStatedSchoolDistrict")
        && src("lib/buyer-search/conversation-criteria.ts").includes("age-restricted")
        && src("lib/buyer-search/written-criteria-alert.ts").includes("text_conversation")
        && src("lib/kernel/approval-queue-aggregator.ts").includes("TEXT_PROPOSAL")
        && src("lib/platform/trial-funnel.ts").includes("resolveNewestPerTier")
        && src("app/actions/auth/signup-brokerage.ts").includes("couponCode")
        && src("lib/platform/save-offer.ts").includes("resolveSaveOffer")
        && src("app/actions/billing.ts").includes("acceptCancellationSaveOfferAction")
        && src("lib/platform/status-notice.ts").length > 0
        && src("lib/platform/changelog.ts").includes("PRODUCT_CHANGELOG")
        && src("app/trust/page.tsx").length > 0
        && src("scripts/schema-snapshot.ts").includes("retention_offer"))
    }
    // ── ROUND 22 VERDICT: TEAMMATES ARE A PERSONA LAYER, NEVER A SECOND AGENT SYSTEM ──
    {
      // Owner challenge answered ("doesn't the OS already do what teammates do?
      // I don't want 2 similar systems battle each other"): VERDICT — KEEP, because
      // tenant_ai_teammates is NOT an agent system. It spawns nothing, queues
      // nothing, sends nothing; it decorates the ONE manager system (charter →
      // the single draft-context builder; name → dispatcher attribution; autonomy
      // CLAMPED to the earned ledger). This lock makes that verdict structural:
      // the teammates lib/actions must stay free of every execution primitive —
      // if a future round tries to give teammates their own send/cron/queue rail,
      // this check fails and forces the work back onto the managers.
      const teammatesLib = src("lib/kernel/ai-teammates.ts")
      const teammatesActions = src("app/actions/ai-teammates.ts")
      const executionPrimitives = ["sendEmail", "sendSMS", "sendSms", "twilio", "from(\"activities\")", "cron", "publishManagerSignal", "dispatchTeamCommand("]
      check("TEAMMATES = PERSONA-ONLY (round-22 owner verdict codified): the teammate layer decorates the ONE manager system and can NEVER become a rival executor — lib + actions contain zero execution primitives (no send/cron/queue/signal calls), the ONLY table the actions write is tenant_ai_teammates, charters flow through the single central draft-context builder, and autonomy stays clamped to the earned ledger",
        executionPrimitives.every((p) => !teammatesLib.includes(p) && !teammatesActions.includes(p))
        && (teammatesActions.match(/\.from\("(?!tenant_ai_teammates|brokerages|users|agents)/g) ?? []).length === 0
        && teammatesLib.includes("clampTeammateAutonomy")
        && src("lib/ai-isa/brand-voice-prompt.ts").includes("composeTeammateContext"))
    }
    // ── ROUND 22 BUILDS: FLYWHEEL + SPOKEN ALERTS + META PAGES ──
    {
      check("ROUND 22 — THREE APPROVED RAILS. (1) SENTINEL FLYWHEEL: the platform's own manager learns from staff verdicts — pure summarizeSentinelVerdicts (90d window, consecutive-dismissal streaks) + applySentinelLearning between compose and upsert (3-straight dismissals SUPPRESS a kind per tenant; ≥70% fleet dismissal over ≥10 decisions DOWNGRADES severity with an honest 'Learned:' note); the queue shows the learning strip and NO fake unsuppress button — approving clears the streak, honestly stated. (2) SPOKEN CRITERIA → LIVING ALERT: the call-analysis sweep runs the pure conversation-criteria extractor (REUSES the round-63 intent parser, Caller: lines only, refine-later-wins merge, fair-housing stance inherited — schools/family/age never become criteria) and proposes is_active=false property_alerts rows (source 'voice_conversation', evidence quotes in paused_reason, call-id dedupe in alert_name, sentinelWrite) that surface in the ONE unified approvals queue as pa: items — approve mirrors resumePropertyAlert + first search, reject deletes, both pinned to source+inactive so live alerts are untouchable. (3) META PAGES: the company-channel Meta connect completes the page-token leg (me/accounts; one page auto-selects, many park pending_pages behind an audited picker; PAGE token is the stored credential) and Instagram rides the page's business account; FB Page posts + IG image posts publish through the UNCHANGED tenant publisher with real permalinks — IG without an image stays honestly manual (text-only IG posts are impossible via the API and are never faked)",
        src("lib/platform/platform-sentinel.ts").includes("applySentinelLearning")
        && src("lib/platform/platform-sentinel.ts").includes("summarizeSentinelVerdicts")
        && src("app/api/cron/platform-sentinel/route.ts").includes("applySentinelLearning")
        && src("lib/buyer-search/conversation-criteria.ts").includes("extractCriteriaFromTranscript")
        && src("lib/voice/call-analysis.ts").includes("proposeSpokenCriteriaAlert")
        && src("lib/kernel/approval-queue-aggregator.ts").includes("pa:")
        && src("lib/kernel/approval-queue-aggregator.ts").includes("voice_conversation")
        && src("lib/platform/platform-social.ts").includes("instagram_business_account")
        && src("app/actions/superadmin/platform-social.ts").includes("selectPlatformFacebookPageAction"))
    }
    // ── ROUND 21: THE OS SELLS + RUNS ITSELF — SNAPSHOT PROVISIONING, SENTINEL, OWNERSHIP ──
    {
      check("ROUND 21 — SIX RAILS THAT MAKE THE OS A SELLABLE, SELF-RUNNING COMPANY. (1) SNAPSHOT-AT-CREATION: snapshots gain a SITE layer (the fields that drive the day-one /site/[slug] website) with apply-side re-sanitization so a payload can never smuggle identity/tier/status; manualProvisionSubscriberAction takes snapshotId through the ONE apply path — a new tenant is born branded (audited tenant.provisioned_from_snapshot; recommendedTier preselects the tier). (2) COUPONS: platform_coupons + redemption ledger (UNIQUE constraint is the concurrency guard, count recomputed from ledger), tier-validated, Stripe-published mock-safe; redeemed coupons are billing records — deactivate, never delete. (3) PLATFORM SENTINEL: the staff-side AI manager — daily cron (in the ONE dispatch registry) reads engagement/credential-expiry/dunning≥3/SLA/expiring-trials and proposes severity-ranked actions WITH drafted outreach, weekly-bucketed dedupe keys, ignoreDuplicates never resurrects a dismissal; Approve&send only when SendGrid truly configured, 'sent' only on provider acceptance. (4) COMPANY CHANNELS: platform-scope OAuth on the SAME tenant route, tokens under owner_type='platform' with DISTINCT platform_social_<channel> keys because scopeCascade falls back to platform — reusing tenant ids would let a brokerage post through the company account; LinkedIn/X drafts auto-publish with real permalinks, others honestly manual. (5) DEMO SHOWCASE: is_demo tenant provisioned via the CANONICAL signup path (no fork), deterministic believable seed across contacts/leads/listings/transactions/conversations/messages/activities, reset re-queries is_demo=true before ANY delete, subscription paused so it never bills. (6) AI TEAMMATES: tenants name+charter their own teammates over the registry; autonomy CLAMPED to the earned-autonomy grant ledgers (fail-closed), charters injected in the ONE draft-context builder, dispatcher attributes by teammate name. Every table live-fired residue 0",
        src("lib/platform/config-snapshots.ts").includes("SNAPSHOT_SITE_FIELDS")
        && src("app/actions/superadmin/manual-subscriber.ts").includes("provisioned_from_snapshot")
        && src("lib/platform/coupons.ts").includes("validateCouponForRedemption")
        && src("app/actions/superadmin/coupons.ts").includes("platform_coupon_redemptions")
        && src("lib/platform/platform-sentinel.ts").includes("composeSentinelActions")
        && src("lib/kernel/cron-dispatch.ts").includes("platform-sentinel")
        && src("app/actions/superadmin/platform-sentinel.ts").includes("emailRailReady")
        && src("lib/platform/platform-social.ts").includes("platform_social_accounts")
        && src("app/actions/superadmin/platform-social.ts").includes("publishProductDraftAction")
        && src("lib/platform/demo-tenant.ts").includes("is_demo")
        && src("app/actions/superadmin/demo-tenant.ts").includes("requireWrite")
        && src("lib/kernel/ai-teammates.ts").includes("clampTeammateAutonomy")
        && src("lib/ai-isa/brand-voice-prompt.ts").includes("composeTeammateContext")
        && src("lib/voice/team-commands.ts").includes("teammate")
        && src("scripts/schema-snapshot.ts").includes("tenant_ai_teammates"))
    }
    // ── ROUND 20: THE PLATFORM RUNS ITS OWN COMPANY — HR, EDITABLE MATRIX, OVERSIGHT ──
    {
      check("ROUND 20 — THE OS BECOMES A REAL COMPANY THE SUPERADMIN RUNS. STAFF HR: platform_staff_profiles (l72_s15) carries each staffer's title, start date, employment agreement + acknowledgment, notes — the superadmin enters them per staff member; a CHANGED agreement text nulls the acknowledgment so staff must re-acknowledge what they were actually shown, and the home banner makes them do it. EDITABLE CAPABILITY MATRIX (the owner's 'check off what each role can see + read/write'): platform_role_capability_overrides is the superadmin's tri-state editor over the pure code-map default — GRANT a capability the map withholds, REVOKE one it grants, or downgrade write→read — merged at the ONE gate (mergeCapability); superadmin is NEVER overridable (short-circuited before the override layer, rejected by the setter, excluded by the table CHECK), so the OS can't be locked out of itself; gate.access surfaces read-only honestly (banner) with requireWrite opt-in for mutating pages. CALL-TRANSCRIPT OVERSIGHT: the platform's own line (platform_reception_calls, turn-by-turn transcript) AND every tenant's calls (voice_calls: summary/notes/transcription) are readable by staff — the tenant board writes an oversight.tenant_calls_viewed audit row BEFORE the query and refuses to render if that insert fails (no unaudited access path), numbers masked to last-4. ALL-TENANT CONNECTION HEALTH: the three credential stores read platform-globally with the SAME pure derivation the tenant panels use, attention-first. Every new table owned (data_steward), shapes live-fired residue 0. HONEST GAP reported: connecting the OS's OWN social ACCOUNTS (vs composing for them) stays manual until the platform-scope OAuth lands — brand settings + the social calendar already exist",
        src("scripts/schema-snapshot.ts").includes("platform_staff_profiles")
        && src("scripts/schema-snapshot.ts").includes("platform_role_capability_overrides")
        && src("lib/platform/capability-overrides.ts").includes("mergeCapability")
        && src("lib/platform/require-capability.ts").includes("requireWrite")
        && src("lib/platform/require-capability.ts").includes('role === "superadmin"')
        && src("app/actions/superadmin/platform-staff.ts").includes("upsertStaffProfileAction")
        && src("app/actions/superadmin/platform-staff.ts").includes("setCapabilityOverrideAction")
        && src("app/actions/superadmin/platform-staff.ts").includes("agreement_acknowledged_at")
        && src("app/dashboard/superadmin/staff/capability-matrix.tsx").length > 0
        && src("app/dashboard/superadmin/tenant-calls/page.tsx").includes("tenant_calls_viewed")
        && src("app/dashboard/superadmin/connection-health/page.tsx").length > 0
        && src("app/dashboard/superadmin/communications/page.tsx").includes("platform_reception_calls")
        && src("lib/kernel/manager-registry.ts").includes("platform_staff_profiles"))
    }
    // ── PASS 9: NON-STATUS ENUM CHECK VOCABULARY (direction / priority / call_type / …) ──
    {
      const NS_VOCAB: Record<string, string[]> = {
        "client_portal_messages.direction": ["agent_to_client","client_to_agent"],
        "message_provider_logs.direction": ["inbound","outbound"],
        "voice_calls.direction": ["inbound","outbound"],
        "voice_calls.call_type": ["agent_call","ai_isa_call","ai_inbound","warm_transfer"],
        "notifications.priority": ["low","medium","high","critical"],
        "smart_assistant_suggestions.priority": ["low","medium","high"],
        "vendor_messages.sender_type": ["vendor","contact","agent"],
        // DERIVED, NOT TYPED (CLAUDE.md §2 — do not pin an assertion to a waypoint).
        // This entry was a hand-kept 12-value copy and m563 made it a 11-value one
        // by removing 'client'; a stale copy here would have gone on ADMITTING a
        // literal the database now refuses, which is a sweep reporting "none" while
        // blind to the exact defect it exists to catch. scripts/check-vocabularies.ts
        // is GENERATED from pg_get_constraintdef, so reading it makes this arm move
        // with the CHECK instead of with an editor.
        "contacts.contact_type": CHECK_VOCABULARIES.contacts?.contact_type ?? [],
      }
      const nsOffenders: string[] = []
      const scanNs = (rel: string) => {
        const text = readFileSync(join(ROOT, rel), "utf-8")
        for (const m of text.matchAll(/from\(['"](\w+)['"]\)\s*(?:\.\w+\([^)]*\)\s*)*\.(?:update|insert)\(\{([\s\S]{0,900}?)\}\)/g)) {
          const tbl = m[1]
          for (const cm of m[2].matchAll(/(direction|priority|call_type|sender_type|contact_type)\s*:\s*['"]([\w./-]+)['"]/g)) {
            const allowed = NS_VOCAB[`${tbl}.${cm[1]}`]
            if (allowed && !allowed.includes(cm[2])) nsOffenders.push(`${rel}:${tbl}.${cm[1]}='${cm[2]}'`)
          }
        }
      }
      for (const rel of REPO_TS_FILES) scanNs(rel)
      check(`PASS 9 — NON-STATUS ENUM CHECK SWEEP (the columns passes 3/6 didn't cover: direction / priority / call_type / sender_type / contact_type; live pg_constraint map × every write literal): the headline catch — client_portal_messages.direction admits ONLY 'agent_to_client'/'client_to_agent', but TEN portal-message writes across the seller-update, listing-lifecycle, tour, title, lender, vendor, ISA and video-distribution rails wrote 'outbound'/'inbound' — every client-facing portal message was SILENTLY REJECTED and never reached the client's portal thread; all ten mapped to the real vocabulary (outbound→agent_to_client, inbound→client_to_agent) WITH the one reader that filtered the old value; notifications.priority rejected 'normal' (widget intake) → 'medium'. Re-runs the sweep in-code — offenders now: [${nsOffenders.join(", ") || "none"}]`,
        nsOffenders.length === 0
        && src("app/actions/seller-updates.ts").includes('direction: "agent_to_client"')
        && src("app/actions/vendor-portal.ts").includes('direction: "client_to_agent"')
        && src("app/actions/ai-isa/engage-contact.ts").includes(".eq('direction', 'agent_to_client')")
        && !src("app/api/widget/intake/route.ts").includes("priority: 'normal'"))
    }
    // ── PASS 5: NOT-NULL-WITHOUT-DEFAULT CONTRACTS (live information_schema dump cross-checked against inserts) ──
    {
      // Re-run the exact sweep predicates in-code so regressions fail the sim:
      // every lifecycle_events / tasks insert literal must carry its required columns.
      const offenders: string[] = []
      const checkFile = (rel: string) => {
        const text = readFileSync(join(ROOT, rel), "utf-8")
        for (const m of text.matchAll(/from\(['"]lifecycle_events['"]\)\s*\.insert\(\{([\s\S]{0,600}?)\}\)/g)) {
          if (!m[1].includes("brokerage_id")) offenders.push(`${rel}:lifecycle_events`)
        }
        for (const m of text.matchAll(/from\(['"]tasks['"]\)\s*\.insert\(\{([\s\S]{0,900}?)\}\)/g)) {
          // spread-based helpers carry the stamped fields — only flag literal shapes missing brokerage_id
          if (!m[1].includes("brokerage_id") && !m[1].includes("...fields")) offenders.push(`${rel}:tasks`)
        }
      }
      for (const rel of REPO_TS_FILES) checkFile(rel)
      // ── PASS 8: PORTAL-IDENTITY RLS (the family-collaboration surface) ──
      check("PASS 8 — PORTAL-IDENTITY RLS (the pass-7 deferral, closed): investigation found portal visitors are AUTHENTICATED Supabase users identified by EMAIL (the portal layout matches auth email → contacts.email; family members are invited by email and may not be contacts at all) — so the scoping identity is the JWT email, not a token scheme. THE HOLE WAS WORSE THAN A READ LEAK: collaborative_search_members/properties, property_family_ratings and property_consensus had USING(true) on SELECT *and UPDATE and INSERT* — any authenticated user of ANY tenant could read AND MODIFY any family's members, shortlist, ratings and consensus; meanwhile the tenant-scoped parent DENIED portal clients their own search (they have no brokerage membership). RESOLUTION (migration l72-s06): ONE SECURITY DEFINER helper portal_member_searches() (owner-contact by email ∪ invited-member by email) + a portal read lane on the parent beside the tenant policies + every child verb scoped to (portal member of the search OR tenant member of its brokerage), with family ratings tightened to OWN-ROW writes (member_email must equal the JWT email — a member can never rewrite another member's vote; tenant staff may moderate). Live four-persona proof: the invited family member sees the whole search and updated their OWN rating (4→3) while the other member's stayed untouched; the stranger saw ZERO rows and their attack update hit ZERO rows; the tenant agent sees everything via the brokerage lane; service-role rails unchanged",
        src("lib/kernel/manager-registry.ts").includes("portal_member_searches")
        && src("lib/kernel/manager-registry.ts").includes("portal_identity_rls:"))
      // ── PASS 7: RLS TENANT-SCOPE AUDIT + PLATFORM PROSPECT FOLLOW-UP ──
      check("PASS 7 — RLS AUDIT (the last unswept contract family; all 754 tables have RLS ON, so the two failure classes are POLICY-LESS deny-all and USING(true) tenant leaks) + PLATFORM SPEED-TO-LEAD: the audit classified every finding by REAL client access — 10 tenant-scoped tables had USING(true) reads exposing data to ANY authenticated user of ANY tenant (chat templates, newsletter content/sends/sections/SEO scores, CMA comparables + price adjustments via their report join, sequence steps via their campaign join, template feedback) → replaced with membership scoping through ONE SECURITY DEFINER helper (user_brokerage_ids — no RLS recursion); 18 deny-all tables the USER-scoped UI actually reads (the gated-proposal table behind the journey line, manager signals behind the managers-talking feed, buyer move cases, challenges, mentor sessions, tax profiles, deal autopsies, investor matches, brand assets, audience members, vendor review flags, locations, call batches, self-heal events, support ticket messages via their ticket join) → tenant read policies added; platform_* tables and service-only kernel ledgers intentionally KEEP zero policies (deny-all to users IS the correct posture behind platformStaffCan + the service role); live behavioral proof ran as an impersonated authenticated user: foreign tenant's template INVISIBLE, own-tenant proposal + signal VISIBLE, foreign signals INVISIBLE. PLATFORM FOLLOW-UP (owner: 'sending followup to potential leads… we look like a big team'): the growth funnel captured hand-raises but nothing followed up — runProspectFollowupSweep now sends the canonical intro pitch to ≥1h-old 'new' prospects (a human window to intercept first) and ONE respectful day-3 nudge to quiet contacted ones, then silence; trial/converted/lost never touched, the platform's own suppression list is a hard boundary, a FAILED send changes nothing (retried next run — never a fake 'contacted' stamp), every send audited with actor system:prospect_followup; rides the ONE cron dispatcher at 15:00 daily",
        src("lib/platform/prospect-followup.ts").includes("runProspectFollowupSweep")
        && src("lib/platform/prospect-followup.ts").includes("isEmailOnSuppressionList")
        && src("lib/platform/prospect-followup.ts").includes("never a fake")
        && src("lib/platform/prospect-followup.ts").includes('.eq("followup_count", 1)')          // exactly ONE nudge, then silence
        && src("lib/platform/growth-funnel.ts").includes("composeProspectNudge")
        && src("lib/platform/growth-funnel.ts").includes("we won't keep nudging")
        && src("app/api/cron/platform-prospect-followup/route.ts").includes("verifyCronAuth")
        && src("lib/kernel/cron-dispatch.ts").includes("/api/cron/platform-prospect-followup"))
      // ── PASS 6: UPDATE/INSERT STATUS-VOCABULARY SWEEP (live CHECKs × every literal) ──
      {
        const VOCAB: Record<string, string[]> = {
          "accounting_sync_log.status": ["pending","running","completed","failed"],
          "agent_onboarding.status": ["in_progress","completed","paused"],
          "agent_voice_profiles.training_status": ["not_started","collecting_samples","training","ready","failed"],
          "ai_message_drafts.status": ["pending","accepted","edited","dismissed","sent"],
          "automation_errors.status": ["open","investigating","resolved","dismissed"],
          "brokerage_integrations.status": ["connected","error","not_configured"],
          "calendar_sync_logs.status": ["success","partial","failed"],
          "copilot_plans.status": ["active","paused","completed","superseded"],
          "cron_execution_logs.status": ["started","completed","failed","timeout"],
          "direct_mail_campaigns.status": ["planning","approved","printed","mailed","cancelled","failed"],
          "facebook_custom_audiences.status": ["draft","pending_review","approved","synced","failed","deleted"],
          "leads.reengagement_status": ["none","active","completed","paused","opted_out","stopped","handed_to_sphere","long_horizon"],
          "manager_signals.status": ["open","consumed","expired"],
          "marketing_campaigns.status": ["draft","pending_review","approved","scheduled","live","paused","ended","archived","failed"],
          "newsletter_campaigns.approval_status": ["draft","pending_review","approved","rejected"],
          "newsletter_sends.status": ["queued","sent","failed","bounced","opened","clicked","suppressed"],
          "newsletter_subscribers.status": ["subscribed","unsubscribed","bounced","complained"],
          "offers.ai_extraction_status": ["pending","extracting","completed","failed","manual"],
          // "draft" added by m543, which consolidated the retired `open_houses` onto
          // this table. The war room stages an open house with NO DATE on purpose, and
          // the survivor's vocabulary had no word for that; m543 also pins the dateless
          // state to this one value with a CHECK. This is the THIRD-COPY case the note
          // above warns about — the live CHECK and scripts/check-vocabularies.ts (a
          // GENERATED cache, regeneration owed to the integrator) are the other two.
          "open_house_events.status": ["draft","scheduled","marketing","active","completed","cancelled"],
          "repurposed_content_log.approval_status": ["draft","pending_review","approved","rejected"],
          "repurposed_content_log.status": ["generated","scheduled","published","failed"],
          "scheduled_touchpoints.status": ["scheduled","sent","completed","skipped","failed"],
          "sequence_enrollments.status": ["active","completed","paused","unsubscribed","converted","authority_blocked","cancelled","unenrolled"],
          "social_publish_log.publish_status": ["queued","published","failed","cancelled"],
          "transaction_compliance_log.status": ["pending","pass","fail","waived","needs_review"],
          "transaction_documents.status": ["missing","requested","uploaded","under_review","approved","rejected","pending_signature"],
          // "bound" added by m385 — the buyer's hazard policy is IN FORCE, which is
          // not the same as "approved" (the client accepted a quote). A lender will
          // not fund on the latter. NOTE: this inline table is a THIRD copy of a
          // vocabulary that also lives in the live CHECK and in
          // scripts/check-vocabularies.ts. Three copies drift by construction —
          // when you widen a CHECK, all three have to move together.
          "transaction_vendor_services.status": ["ordered","scheduled","in_progress","completed","cancelled","quote_requested","pending_approval","approved","bound"],
          "transactions.status": ["lead","qualifying","active","under_contract","closing","closed","lost","archived"],
          "vendor_assignments.status": ["pending","confirmed","in_progress","completed","cancelled"],
          "wealth_advisor_recommendations.status": ["open","reviewed","presented","converted","dismissed","stale"],
        }
        const vocabOffenders: string[] = []
        const scanVocab = (rel: string) => {
          const text = readFileSync(join(ROOT, rel), "utf-8")
          for (const m of text.matchAll(/from\(['"](\w+)['"]\)\s*(?:\.\w+\([^)]*\)\s*)*\.(?:update|insert)\(\{([\s\S]{0,900}?)\}\)/g)) {
            const tbl = m[1]
            for (const cm of m[2].matchAll(/(\w*status)\s*:\s*['"]([\w./-]+)['"]/g)) {
              const allowed = VOCAB[`${tbl}.${cm[1]}`]
              if (allowed && !allowed.includes(cm[2])) vocabOffenders.push(`${rel}:${tbl}.${cm[1]}='${cm[2]}'`)
            }
          }
        }
        for (const rel of REPO_TS_FILES) scanVocab(rel)
        check(`PASS 6 — STATUS-VOCABULARY SWEEP over UPDATE + INSERT paths (the sibling passes 3 promised; live pg_constraint dump of ~180 status CHECKs cross-checked against every write literal): SIXTY-THREE drifted sites found — every one silently rejected: the ghost-recovery ladder's reengagement states, the sequence engine's cancel/unenroll, the direct-mail drain's failure terminals, the e-sign doc state, the vendor procurement ladder, manager-signal consumption, compliance pass/fail stamps, ISA draft approvals, newsletter suppression refusals, audience sync states, onboarding progress and more. RESOLUTION: 39 write literals normalized to the canonical vocabulary + 9 CHECKs widened where the code's vocabulary is a REAL business state (l72-s03: reengagement ladder, procurement ladder, pending_signature, suppressed, superseded, archived, deleted, cancel/unenroll, mail failure terminals) + 13 READERS aligned (including the two manager-signal outcome resolvers whose skip-filter watched a status that could never exist, and the newsletter subscriber counts filtering a value never written). This block re-runs the sweep with the post-migration vocabulary — offenders now: [${vocabOffenders.join(", ") || "none"}]`,
          vocabOffenders.length === 0
          && src("lib/kernel/transactions.ts").includes('.eq("status", "fail")')
          && src("lib/intelligence/predictor-outcome-resolver.ts").includes('.neq("status", "consumed")')
          && src("lib/kernel/consult-outcome-resolver.ts").includes('.neq("status", "consumed")')
          && src("lib/ads/facebook-audience-sync.ts").includes('status: "synced"')
          && src("lib/audiences/audience-sync.ts").includes('.eq("status", "synced")')
          && src("app/actions/admin/get-admin-stats.ts").includes("['requested', 'uploaded']"))
      }
      check(`PASS 5 — NOT-NULL CONTRACT SWEEP (the sibling of the CHECK sweep; live information_schema dump of required-no-default columns cross-checked against every insert literal): lifecycle_events.brokerage_id was missing from FIFTEEN writers — the ISA's outreach/max-touch/pause events, appointment scheduling, ALL commission lifecycle (approved/paid/disputed/resolved), expenses, report exports, listing launch, auto-disputes, review recovery — every one ALWAYS failed NOT NULL silently; tasks.brokerage_id+assigned_to_agent_id were missing from SEVENTEEN writers including createTask itself (the inbox 'T' verb) and all seven listing-lifecycle handlers (no listing task ever landed) — all fixed with honest context resolution (the listing's own agent, the contact's own agent, the caller's agent row) and honest refusals when no agent exists; offenders now: [${offenders.join(", ") || "none"}]`,
        offenders.length === 0
        && src("app/actions/tasks.ts").includes("cannot create the task")
        && src("lib/application/listing-lifecycle.ts").includes("listingTaskContext")
        && src("lib/kernel/financial.ts").includes("brokerage_id: brokerageId, // NOT NULL (pass 5)")
        && src("lib/ai-isa/isa-outreach-logger.ts").includes("brokerage_id: params.brokerageId,")
        && src("app/actions/credit-copilot.ts").includes("insertCreditTask"))
    }
    // ── REPAIR-PATTERN DIGEST + VOICE SELF-HEAL BRIEF + DEAL TWIN (approved 1/2/3) ──
    const rd = await import("../lib/kernel/repair-digest")
    const digest = rd.composeRepairDigest([
      { action: "complete_packet", outcome: "healed", brokerageId: "b1", flow: "packet_completion" },
      { action: "complete_packet", outcome: "healed", brokerageId: "b1", flow: "packet_completion" },
      { action: "replay_meta_lead", outcome: "healed", brokerageId: "b2", flow: "meta_lead_orphan" },
      { action: "none", outcome: "escalated", brokerageId: "b1", flow: "listing_agreement_stage_gap" },
      { action: "reflag_shaky", outcome: "failed", brokerageId: "b1", flow: "walkthrough_shaky_gap" },
    ], { replay_meta_lead: { healed: 4, failed: 0 }, reflag_shaky: { healed: 9, failed: 1 } })
    const briefBoth = rd.composeSelfHealBrief({ healed: 3, openExceptions: 2, isBrokerVoice: true })
    const briefAgent = rd.composeSelfHealBrief({ healed: 3, openExceptions: 2, isBrokerVoice: false })
    const briefQuiet = rd.composeSelfHealBrief({ healed: 0, openExceptions: 0, isBrokerVoice: true })
    const crt = await import("../lib/kernel/continuity-receipt")
    const twinSteps = crt.composeDealTwin([
      { key: "signing", label: "Signing paperwork", expected: "stamped complete", breaks: 0, checked: 3 },
      { key: "loan", label: "Loan milestones", expected: "lender matches progress", breaks: 1, checked: 2 },
      { key: "followthrough", label: "Team follow-through", expected: "requests reach tasks", breaks: 0, checked: 0 }, // nothing to verify → omitted
    ])
    const twinReceipt = crt.composeContinuityReceipt({ openBreaks: 1, repairedLast30d: 0, checkedAtIso: "2026-07-15T12:00:00Z", twin: twinSteps })
    check("REPAIR DIGEST (the ledger as an engineering compass) + VOICE SELF-HEAL BRIEF (the admin reports its own maintenance) + DEAL TWIN (expected-vs-actual per contract, same detectors as the healer so twin and healer can NEVER disagree): the digest ranks packet_completion top (2×), flags replay_meta_lead at 4/5 near-earned while a VETOED action (failed>0) never appears near-earned, and names the noisiest tenant; the spoken brief tells everyone about repairs but ONLY broker voices about open exceptions, silent on a quiet week; the twin keeps only steps with rows to verify (loan diverges, signing ok, empty follow-through omitted) and rides the continuity receipt; the digest rides deal-health-scan ISO-week-deduped and the brief slots into the week-in-review",
      digest.topFlows[0].flow === "packet_completion" && digest.topFlows[0].healed === 2
      && digest.nearEarned.some((n) => n.action === "replay_meta_lead" && n.remaining === 1)
      && !digest.nearEarned.some((n) => n.action === "reflag_shaky")
      && digest.noisiestTenants[0].brokerageId === "b1" && digest.totalVetoed === 1
      && Boolean(briefBoth.includes("Exception Center")) && Boolean(briefAgent.includes("repaired")) && !briefAgent.includes("Exception Center")
      && briefQuiet === ""
      && twinSteps.length === 2 && twinSteps.find((s) => s.key === "signing")!.ok === true && twinSteps.find((s) => s.key === "loan")!.ok === false
      && twinReceipt.twin.length === 2 && twinReceipt.status === "attention"
      && src("app/api/cron/deal-health-scan/route.ts").includes("runRepairPatternDigest")
      && src("lib/kernel/week-in-review.ts").includes("selfHealBrief")
      && src("lib/kernel/week-in-review.ts").includes("composeSelfHealBrief")
      && src("app/components/portal/continuity-receipt-card.tsx").includes("See what was checked")
      && src("lib/kernel/manager-registry.ts").includes("repair_digest_and_twin:"))
    check("PORTFOLIO INTELLIGENCE #7/#9 (owner correction: MANAGED CONTACT BOOK, not paid-lead territory) + TENANT CONNECTION HEALTH (owner's real #3: connectivity fabric, not RPA) — the book drives lean-in to a proven-converting unfarmed ZIP + farm-the-book + pull-back (thin ZIP ignored below MIN_CONTACTS), and the connection impact translates a dead connector into the business flow it broke (broken before expiring; healthy = silence); the redundant campaign composer + RPA ops rail were REMOVED",
      books.length === 3 && books.find((b) => b.zip === "78701")!.closeRate === 0.15
      && moves.some((m) => m.key === "lean_in" && m.zip === "78701")
      && moves.some((m) => m.key === "pull_back" && m.zip === "78702")
      && !JSON.stringify(moves).includes("78703") && MIN_ZIP_CONTACTS === 8
      && riskOps.some((r) => r.kind === "opportunity" && r.zip === "78701")
      && riskOps.some((r) => r.kind === "risk" && r.zip === "78702")
      && impact.needsAttention === true && impact.broken.length === 1 && impact.broken[0].provider === "instagram"
      && Boolean(impact.broken[0].line.includes("Instagram listing posts")) && impact.expiring.length === 1 && impact.expiring[0].provider === "dotloop"
      && Boolean(impact.expiring[0].line.includes("signature")) && Boolean(composeConnectionHeadline(impact).includes("Instagram"))
      && impactHealthy.needsAttention === false && composeConnectionHeadline(impactHealthy) === ""
      && PROVIDER_IMPACT["meta"].includes("Instagram")
      && src("app/dashboard/brokerage/page.tsx").includes("BrokerPortfolioPanel")
      && src("app/dashboard/agent/page.tsx").includes("ConnectionHealthCard")
      && src("app/api/cron/recruit-outreach/route.ts").includes("runPortfolioAdvisorAll")
      && src("lib/kernel/manager-registry.ts").includes("portfolio_intelligence:")
      && src("lib/kernel/manager-registry.ts").includes("connection_health_impact:")
      && !src("lib/kernel/manager-registry.ts").includes("campaign_composer:")
      && !src("lib/kernel/manager-registry.ts").includes("ops_task_rail:"))
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
    const welcome = composeClientWelcome({ journey: "buyer", addressAs: "Bill", agentName: "Dana Reed" })
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
      && classifyCardTarget({ title: "Senior Home Inspector", company: "Acme Inspections LLC" }).category === "inspector"
      && classifyCardTarget({ title: "Loan Officer NMLS 12345", company: null }).category === "lender"
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
      && src("app/dashboard/recruiting-roi/page.tsx").includes('from("recruits")'))
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
