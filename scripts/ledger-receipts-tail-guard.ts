#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-tail-guard.ts   (npm run test:ledger-receipts-tail)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 155, LANE 155R17 — receipts, part 2: the rest of arbitration group G12 (a signed-in user's write with no receipt),
 * G14 (a write nothing reads) and G04 (a reactor reaction that writes with no gate and no receipt).
 *
 * PART A — STATIC (comment-stripped source, CLAUDE.md §2):
 *   A1 every WRAPPED G12 row reaches lib/kernel/action-ledger.ts ledgerSessionAction( in its own top-level span, names its
 *      three-segment action and passes NO cycle / idempotencyKey (none of these acts is once-only — a second save must run).
 *      Every one of the 72 rows is WRAPPED or OPEN with its reason (never counted as a pass).
 *   A2 the two lib/ files that were "use server" with no user act behind them carry no directive and import "server-only".
 *   A3 G14: the matcher (generatePropertyMatches) reads property_feedback; the scrape cron reads both lead_scraping_*_params
 *      tables through SCRAPE_TERRITORY_SELECT's embeds (the EXISTING reader the census cannot see).
 *   A4 G04: the Deal Coordinator spawn asks autonomyDecision (the decision) and leaves a receipt; the tour follow-up and the
 *      education delivery stamp each leave a receipt.
 *   Positive controls: a span with no call, a span with a cycle, a "use server" directive, a matcher with no feedback read
 *   are each caught; a tombstone that NAMES the directive is not one.
 * PART B — DRIVEN (in-memory, SIMULATED; scripts/canaries/_harness.ts stubs the service + session clients; fetch refused and
 *   counted). G12: per driven module, the real export called TWICE by a signed-in user → TWO receipts (actor, tenant, action,
 *   subject, risk class, no key), both executed; with the domain write refused (42703) → that receipt settles failed. Plus the
 *   NEGATIVE canaries of the two doors this lane closed: another tenant's draft is not dismissed (and is not a success), and a
 *   body tenant that is not the session's is refused before any row is written. G04: OFFER_ACCEPTED through the REAL
 *   dispatchKernelEvent → one spawn, one receipt; a tenant whose autonomy is paused → ZERO spawns and a `skipped` receipt;
 *   a refusing ledger → the spawn still runs once and nothing is receipted (today's behavior). TOUR_COMPLETED → one receipt.
 *   Red at 81cdddae: none of these exports or reactions wrote a receipt, and the two doors acted across tenants.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings, stripComments } from "./strip-comments"
import { stubModule, setSvc, canaryClient, setSessionUser } from "./canaries/_harness"

const ROOT = process.cwd()
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (f: string) => readFileSync(join(ROOT, f), "utf8")

// ── the rows (scope: $S/155R17-rows.json, the open G12 P1 / P2 rows outside lane 155R15's module list) ───────────────
const A = "app/actions/"
const WRAPPED: Record<string, string> = {
  [`${A}academy-learning.ts#dismissLearningAssignmentAction`]: "academy.learning_assignment.dismiss",
  [`${A}learning-modules-approvals.ts#approveLearningModuleAction`]: "academy.learning_module.approve",
  [`${A}learning-modules-approvals.ts#rejectLearningModuleAction`]: "academy.learning_module.reject",
  [`${A}learning-modules.ts#createLearningModuleAction`]: "academy.learning_module.create",
  [`${A}learning-modules.ts#updateLearningModuleAction`]: "academy.learning_module.update",
  [`${A}lender-portal-actions.ts#uploadLenderDocument`]: "transaction.lender_document.upload",
  [`${A}portal-lifetime.ts#requestValueUpdate`]: "portal.value_update.request",
  [`${A}video.ts#distributeVideoProjectAction`]: "marketing.video_project.distribute",
  [`${A}video/distribute-video.ts#distributeVideo`]: "marketing.video.distribute",
  [`${A}youtube-backfill.ts#queueApprovedVideosToYouTubeAction`]: "marketing.youtube_backfill.queue",
  ["app/dashboard/admin/content-studio/actions.ts#approveContentItemAction"]: "marketing.video_project.approve",
  ["app/dashboard/marketing/content-intel/topic-actions.ts#publishCommunityVideoAction"]: "marketing.community_video.publish",
  ["app/dashboard/marketing/review/actions.ts#cancelSocialPost"]: "marketing.social_post.cancel",
  ["app/dashboard/marketing/review/actions.ts#dismissDraft"]: "marketing.message_draft.dismiss",
  ["app/dashboard/marketing/video-staging/actions.ts#stageVideoAction"]: "marketing.video_project.stage",
  ["lib/repurpose/actions.ts#createRepurposePipeline"]: "marketing.repurpose_pipeline.create",
  ["lib/repurpose/actions.ts#deletePipeline"]: "marketing.repurpose_pipeline.delete",
  ["lib/repurpose/actions.ts#togglePipelineActive"]: "marketing.repurpose_pipeline.toggle",
}
const RO = "READ-ONLY (for 155R16)"
const OPEN: Record<string, string> = {
  // not a user endpoint any more: "use server" removed (A2)
  "lib/approval-workflow/approval-logger.ts#logApprovalDecision": "RETIRED AS A DOOR: server-only helper; the user act is content-approval-workflow.ts evaluateContentApproval",
  "lib/approval-workflow/approval-logger.ts#logBatchApprovalDecisions": "RETIRED AS A DOOR: server-only helper (batchEvaluateContentApproval)",
  "lib/auth/require-admin-maintenance-access.ts#requireAdminMaintenanceAccess": "RETIRED AS A DOOR: a route gate (seed/users, migrate/verify) — its activities row is access evidence",
  // seed / demo doors: findings, never receipted
  "http:/api/seed/users": "FINDING: a dev seed door; gated by requireAdminMaintenanceAccess (prod 404 unless ALLOW_PROD_MAINTENANCE_ROUTES) — retirement / env gate proposed",
  [`${A}demo-auth.ts#demoSignIn`]: "FINDING: a demo sign-in door; DEMO_CONFIG.ENABLED (flag && VERCEL_ENV !== production) — env gate proposed",
  // another lane's FILES line (155S3)
  [`${A}ai-client-portal.ts#markResourceCompleted`]: "SKIPPED: 155S3 FILES",
  [`${A}seller-equity.ts#setSellerMortgageBalance`]: "SKIPPED: 155S3 FILES",
  [`${A}social/generate-social-post.ts#generateWeeklyContentPlan`]: "SKIPPED: 155S3 FILES",
  "http:/api/onboarding/training/progress": "SKIPPED: 155S3 FILES (the training progress route)",
  // anonymous / pre-session / metering
  "http:/api/did/agents/session/heartbeat": "a periodic metering ping — the meter row is the evidence",
  [`${A}listing-landing.ts#logLandingSession`]: "anonymous visitor analytics (no session actor)",
  [`${A}listing-landing.ts#trackCtaClick`]: "anonymous visitor analytics (no session actor)",
  [`${A}privacy/data-subject-requests.ts#submitDataSubjectRequestAction`]: "anonymous public DSAR intake (no session actor)",
  [`${A}public/tos-acceptance.ts#recordTosAcceptanceAction`]: "pre-account signup consent (no session, no tenant)",
  [`${A}calculators.ts#calculateAffordability`]: "anonymous calculator telemetry (trackToolUsage)",
  [`${A}calculators.ts#calculateRentVsBuy`]: "anonymous calculator telemetry (trackToolUsage)",
  // platform staff, no tenant to record against
  [`${A}superadmin/platform-brand.ts#addTopicAction`]: "no tenant to record against (platform_content_topics)",
  [`${A}superadmin/platform-brand.ts#dismissTopicAction`]: "no tenant to record against (platform_content_topics)",
  [`${A}superadmin/platform-social.ts#listPlatformSocialAccountsAction`]: "no tenant to record against (platform-level lazy seed)",
  [`${A}superadmin/screenshot-capture.ts#captureDemoStillAction`]: "no tenant to record against (platform staff)",
  [`${A}superadmin/screenshot-capture.ts#capturePublicPropertyStillAction`]: "no tenant to record against (platform staff)",
  [`${A}superadmin/screenshot-capture.ts#setScreenshotUsesAction`]: "no tenant to record against (platform staff)",
  [`${A}tenant-safety-actions.ts#resolveTenantSafetyFindingAction`]: "no tenant to record against (platform-wide table)",
  // reads the census credits with a write that is not on their path
  [`${A}avatar-voice-catalog.ts#listElevenLabsVoices`]: `${RO}: free provider list; ai_video_projects is reached only through the imported CONSTANT DEFAULT_LANGUAGE (lib/video/multilingual-reel.ts:496)`,
  [`${A}buyer-coaching.ts#getBuyerCoaching`]: `${RO}: a read with an AI cache fill`,
  [`${A}buyer-insights.ts#getBuyerInsights`]: `${RO}: a pure read (imported constant)`,
  [`${A}campaign-bundles.ts#listCampaignBundles`]: `${RO}: selects only`,
  [`${A}career-tier.ts#getAgentCareerProgress`]: `${RO}: the analyzer attributes runCareerTierEvaluation's writes`,
  [`${A}compliance/dashboard.ts#getComplianceDashboard`]: `${RO}: constants + a type-only import`,
  [`${A}compliance/document-access-audit.ts#getDocumentAccessAudit`]: `${RO}: a type-only import`,
  [`${A}content-final-versions.ts#getDistributionFinalsAction`]: `${RO}: whole-file writer attribution`,
  [`${A}custom-video.ts#listVideoTopicPoolAction`]: `${RO}: pickTopics with markUsed: false`,
  [`${A}learning-modules.ts#getLearningAssignmentsForActorAction`]: `${RO}: pickLearningModulesForActor selects only; relationship_edges is written in lib/kernel/relationship-graph.ts, reached by import only`,
  [`${A}marketing/tenant-screenshots.ts#listEstimateComparisonAction`]: `${RO}: listComparisonEvidence selects`,
  [`${A}marketing/tenant-screenshots.ts#listTenantScreenshotStillsAction`]: `${RO}: listTenantScreenshotStills selects`,
  [`${A}movement-signals.ts#listMovementSignalsAction`]: `${RO}: whole-file writer attribution`,
  [`${A}network-intelligence.ts#getNetworkBenchmarksBeside`]: `${RO}: the analyzer attributes runNetworkBenchmarkAggregation's writes`,
  [`${A}photo-management.ts#getListingPhotoSet`]: `${RO}: selects only`,
  [`${A}photo-management.ts#getPhotoEnhancementHistory`]: `${RO}: selects only`,
  [`${A}photo-management.ts#getPhotoPerformanceStats`]: `${RO}: selects only`,
  [`${A}photo-management.ts#validatePhotoQuality`]: `${RO}: selects only`,
  [`${A}revenue-protection.ts#getBrokerageRevenueProtection`]: `${RO}: whole-file writer attribution`,
  [`${A}seller-coaching.ts#getListingCoaching`]: `${RO}: a read with a shared cache fill`,
  [`${A}superadmin/platform-controls.ts#getAcquisitionCapsAction`]: `${RO}: platform_settings select`,
  [`${A}superadmin/platform-controls.ts#getStatusNoticeStateAction`]: `${RO}: platform_settings select`,
  [`${A}superadmin/platform-providers.ts#getPlatformProvidersAction`]: `${RO}: superadmin read`,
  [`${A}superadmin/platform-sentinel.ts#listSentinelActionsAction`]: `${RO}: whole-file writer attribution`,
  [`${A}superadmin/screenshot-capture.ts#listDemoStillSurfacesAction`]: `${RO}: returns the static registry`,
  [`${A}superadmin/screenshot-capture.ts#listScreenshotStillsForUseAction`]: `${RO}: selects`,
  [`${A}transactions.ts#getClosingDates`]: `${RO}: selects; resolveClosingDates is pure`,
  [`${A}transactions/closing-proof.ts#getNoCdaClosingProofAction`]: `${RO}: an imported constant`,
  [`${A}vendor-contact-access.ts#listVendorAssignmentsForBrokerageAction`]: `${RO}: whole-file writer attribution`,
  [`${A}voice-assistant.ts#getVoiceConfig`]: `${RO}: a settings view with a lazy default-row insert on first view`,
  ["app/dashboard/sphere/actions.ts#loadSphereResonance"]: `${RO}: selects only`,
}
const ROW_COUNT = 72

const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
function spanOf(text: string, name: string): string | null {
  const m = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/\nexport\s/)
  return text.slice(m.index, m.index + m[0].length + (next < 0 ? rest.length : next))
}
function judge(source: string, name: string, action: string): string[] {
  const noComments = blankComments(source)
  const code = blankStrings(noComments)
  const codeSpan = spanOf(code, name), litSpan = spanOf(noComments, name)
  if (!codeSpan || !litSpan) return [`export ${name} not found`]
  const out: string[] = []
  if (!/\bledgerSessionAction\s*\(/.test(codeSpan)) out.push("does not reach ledgerSessionAction(")
  if (!litSpan.includes(`"${action}"`)) out.push(`does not name ${action}`)
  if (/\b(?:cycle|idempotencyKey)\s*:/.test(codeSpan)) out.push("passes cycle / idempotencyKey (a second save would be a silent no-op)")
  return out
}
/** The first statement is a "use server" directive (Next's rule), read on comment-stripped source. */
const hasUseServer = (source: string) => /^\s*["']use server["']/.test(stripComments(source))
const importsServerOnly = (source: string) => /^\s*import\s+["']server-only["']/m.test(stripComments(source))

function partA(): void {
  console.log("\nPART A — static (stripped source)")
  check("control: a span with no helper call is caught (a comment naming it is not a call)", judge(`export async function f() {\n  // ledgerSessionAction("x.y.z")\n  return 1\n}\n`, "f", "x.y.z").includes("does not reach ledgerSessionAction("))
  check("control: a span passing a cycle is caught", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z", cycle: "c" }, run)\n}\n`, "f", "x.y.z").some((s) => s.startsWith("passes cycle")))
  check("control: a clean span passes", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z" }, run)\n}\n`, "f", "x.y.z").length === 0)
  check("control: a \"use server\" directive is found, a tombstone naming it is not", hasUseServer(`"use server"\nexport async function a() {}`) && !hasUseServer(`// this file was "use server"\nimport "server-only"\n`))
  const covered = Object.keys(WRAPPED).length + Object.keys(OPEN).length
  check(`A1 every row is WRAPPED or OPEN with a reason (${Object.keys(WRAPPED).length} + ${Object.keys(OPEN).length} = ${covered} of ${ROW_COUNT})`, covered === ROW_COUNT)
  check("A1 no row is both WRAPPED and OPEN", Object.keys(WRAPPED).every((r) => !(r in OPEN)))
  for (const [row, action] of Object.entries(WRAPPED)) {
    const [file, name] = row.split("#")
    const problems = [...(NAME_RE.test(action) ? [] : ["action is not three lowercase segments"]), ...judge(src(file), name, action)]
    check(`A1 ${file}#${name} → ledgerSessionAction("${action}"), no key`, problems.length === 0, problems.join("; "))
  }
  for (const [row, why] of Object.entries(OPEN)) console.log(`  ◌ OPEN ${row} — ${why}`)
  for (const f of ["lib/approval-workflow/approval-logger.ts", "lib/auth/require-admin-maintenance-access.ts"]) {
    const s = src(f)
    check(`A2 ${f} is no longer a "use server" module and imports "server-only"`, !hasUseServer(s) && importsServerOnly(s))
  }
  // A3 — G14 readers. An embed is a string, so the read is judged on comment-blanked (not string-blanked) source.
  const feedsMatcher = (s: string) => /\.from\(\s*["']property_feedback["']\s*\)\s*\.select\(/.test(spanOf(blankComments(s), "generatePropertyMatches") ?? "")
  check("A3 control: a matcher with no feedback read is caught", !feedsMatcher(`export async function generatePropertyMatches() {\n  // .from("property_feedback").select("*")\n}\n`))
  check("A3 G14 learnFromBuyerFeedback — the matcher generatePropertyMatches reads property_feedback (NEWLY WIRED)", feedsMatcher(src(`${A}ai-property-matching.ts`)))
  const sel = blankComments(src("lib/lead-pipeline/scrape-territories.ts"))
  const cron = blankStrings(blankComments(src("app/api/cron/lead-scraping/route.ts")))
  check("A3 G14 lead_scraping_{property,motivated}_params — read by the scrape cron through SCRAPE_TERRITORY_SELECT's embeds (EXISTING reader)",
    /SCRAPE_TERRITORY_SELECT\s*=\s*`[^`]*lead_scraping_property_params\s*\([^`]*lead_scraping_motivated_params\s*\(/.test(sel)
      && /\.select\(\s*SCRAPE_TERRITORY_SELECT\s*\)/.test(blankStrings(sel)) && /\bresolveActivePullGate\s*\(/.test(cron)
      && /lead_scraping_property_params\?\.length/.test(cron) && /lead_scraping_motivated_params\?\.\[0\]/.test(cron))
  // A4 — G04 reactions
  const reactor = blankStrings(blankComments(src("lib/kernel/event-reactor.ts")))
  const reactorLit = blankComments(src("lib/kernel/event-reactor.ts"))
  const offerAt = reactor.indexOf("KernelEvent.OFFER_ACCEPTED || params.event === KernelEvent.TRANSACTION_STAGE_CHANGED")
  const offerBlock = offerAt < 0 ? "" : reactor.slice(offerAt, reactor.indexOf("else if", offerAt))
  check("A4 G04 offer_accepted — the Deal Coordinator spawn asks autonomyDecision (halts) BEFORE spawning, and is receipted", /\bautonomyDecision\s*\(/.test(offerBlock) && /\bwithActionLedger\s*</.test(offerBlock) && offerBlock.indexOf("autonomyDecision") < offerBlock.indexOf("spawnDealCoordinatorForTransaction") && reactorLit.includes(`"agent.deal_coordinator.spawn"`))
  check("A4 G04 tour_completed — the follow-up producer is receipted", reactorLit.includes(`"agent.tour_followup.propose"`))
  check("A4 G04 client_education_delivered — the delivery stamp is receipted", reactorLit.includes(`"education.delivery.stamp"`))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — seams installed before any module is imported.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
stubModule("next/headers", "export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }); export const headers = async () => new Headers()")
const g = globalThis as unknown as { __R17: { spawns: unknown[]; tours: unknown[] }; fetch: unknown }
g.__R17 = { spawns: [], tours: [] }
stubModule("@/lib/agents/deal-coordinator", "export const spawnDealCoordinatorForTransaction = async (p) => { globalThis.__R17.spawns.push(p); return { ok: true } }")
stubModule("@/lib/agents/tour-followup-producer", "export const buildTourFollowUpMessage = () => ({ subject: '', body: '' }); export const produceTourFollowUp = async (b, c) => { globalThis.__R17.tours.push(c); return { proposed: 1 } }")

const B = "b1550000-0000-4000-8000-0000000000f7", B2 = "b2550000-0000-4000-8000-0000000000f7", BH = "b3550000-0000-4000-8000-0000000000f7"
const U = "a1550000-0000-4000-8000-0000000000f7", UA = "a1550000-0000-4000-8000-0000000000f8", AG = "a2550000-0000-4000-8000-0000000000f7"
const C = "c1550000-0000-4000-8000-0000000000f7", X = "e1550000-0000-4000-8000-0000000000f7", X2 = "e2550000-0000-4000-8000-0000000000f7"
const T = "d1550000-0000-4000-8000-0000000000f7"
type Rows = Record<string, Record<string, unknown>[]>
function baseSeed(): Rows {
  return {
    brokerages: [{ id: B, name: "R17 Realty" }, { id: B2, name: "Other Realty" }],
    users: [{ id: U, brokerage_id: B, user_type: "broker_owner", email: "owner@wave140-canary.test" }, { id: UA, brokerage_id: B, user_type: "agent", email: "agent@wave140-canary.test" }],
    agents: [{ id: AG, user_id: UA, brokerage_id: B }],
    agent_action_ledger: [],
  }
}
interface Driver { module: string; label: string; action: string; risk: string; subject: string; user?: string; seed: Rows; call: (m: Record<string, any>) => Promise<unknown>; failCol: Record<string, string[]>; between?: (t: Rows) => void }
const DRIVERS: Driver[] = [
  { module: `${A}academy-learning.ts`, label: "dismissLearningAssignmentAction", action: "academy.learning_assignment.dismiss", risk: "LOW_RISK_WRITE", subject: X, user: UA,
    seed: { learning_modules: [{ id: X, brokerage_id: B, required: false }], learning_assignments: [{ id: X2, agent_user_id: UA, module_id: X, status: "open" }] },
    call: (m) => m.dismissLearningAssignmentAction(X), failCol: { learning_assignments: ["dismissed_at"] }, between: (t) => { for (const r of t.learning_assignments ?? []) r.status = "open" } },
  { module: `${A}learning-modules.ts`, label: "updateLearningModuleAction", action: "academy.learning_module.update", risk: "LOW_RISK_WRITE", subject: X,
    seed: { learning_modules: [{ id: X, brokerage_id: B, title: "Old", status: "draft" }] }, call: (m) => m.updateLearningModuleAction(X, { title: "New" }), failCol: { learning_modules: ["title"] } },
  { module: `${A}learning-modules-approvals.ts`, label: "approveLearningModuleAction", action: "academy.learning_module.approve", risk: "LOW_RISK_WRITE", subject: X,
    seed: { learning_modules: [{ id: X, brokerage_id: B, status: "pending_review", required: false, quiz_questions: null }] }, call: (m) => m.approveLearningModuleAction(X), failCol: { learning_modules: ["approved_by"] },
    between: (t) => { for (const r of t.learning_modules ?? []) r.status = "pending_review" } },
  { module: "app/dashboard/marketing/review/actions.ts", label: "dismissDraft", action: "marketing.message_draft.dismiss", risk: "LOW_RISK_WRITE", subject: X,
    seed: { ai_message_drafts: [{ id: X, brokerage_id: B, agent_user_id: UA, status: "pending" }] }, call: (m) => m.dismissDraft(X), failCol: { ai_message_drafts: ["acted_at"] },
    between: (t) => { for (const r of t.ai_message_drafts ?? []) r.status = "pending" } },
  { module: `${A}video/distribute-video.ts`, label: "distributeVideo (draft)", action: "marketing.video.distribute", risk: "LOW_RISK_WRITE", subject: X,
    seed: { ai_video_projects: [{ id: X, brokerage_id: B, status: "completed", video_url: "https://example.test/v.mp4", title: "Reel" }], social_posts: [] },
    call: (m) => m.distributeVideo({ videoProjectId: X, brokerageId: B, userId: U, action: "draft" }), failCol: { social_posts: ["post_brief"] } },
]
const ledgerOf = (svc: { tables: Rows }, action: string) => (svc.tables.agent_action_ledger ?? []).filter((r) => r.action === action)

async function partB(): Promise<void> {
  console.log("\nPART B — driven (in-memory, SIMULATED; fetch refused and counted)")
  delete process.env.ANTHROPIC_API_KEY
  let fetches = 0
  g.fetch = async () => { fetches++; return new Response("refused in test", { status: 503 }) }
  for (const d of DRIVERS) {
    let m: Record<string, any>
    try { m = await import(join(ROOT, d.module)) } catch (e) { check(`${d.label}: module loads`, false, (e as Error).message.slice(0, 200)); continue }
    const svc = canaryClient({ ...baseSeed(), ...structuredClone(d.seed) })
    setSvc(svc); setSessionUser(svc, d.user ?? U)
    try { await d.call(m); d.between?.(svc.tables); await d.call(m) } catch (e) { check(`${d.label}: runs`, false, (e as Error).message.slice(0, 200)); continue }
    const rows = ledgerOf(svc, d.action)
    const shape = rows.every((r) => r.actor_type === "user" && r.actor_user_id === (d.user ?? U) && r.brokerage_id === B && r.risk_class === d.risk && r.reason_code === "HUMAN_REQUESTED" && !r.idempotency_key && r.subject_id === d.subject)
    check(`${d.label}: two calls → two receipts '${d.action}' (actor, tenant, subject, ${d.risk}, no key)`, rows.length === 2 && shape, `rows=${rows.length} ${JSON.stringify(rows[0] ?? {}).slice(0, 240)}`)
    check(`${d.label}: both settled executed (the second call RAN)`, rows.length === 2 && rows.every((r) => r.status === "executed"), rows.map((r) => `${r.status}/${r.error ?? ""}`).join(", "))
    const bad = canaryClient({ ...baseSeed(), ...structuredClone(d.seed) }, { missingColumns: d.failCol })
    setSvc(bad); setSessionUser(bad, d.user ?? U)
    try { await d.call(m) } catch { /* settled by the helper and rethrown — the row is what is judged */ }
    const failed = ledgerOf(bad, d.action)
    check(`${d.label}: a refused write settles failed`, failed.length === 1 && failed[0].status === "failed", failed.map((r) => `${r.status}/${r.outcome}`).join(", ") || "no receipt")
  }
  // NEGATIVE canaries of the two doors this lane closed (red at 81cdddae: both acted across tenants).
  const review = await import(join(ROOT, "app/dashboard/marketing/review/actions.ts"))
  const n1 = canaryClient({ ...baseSeed(), ai_message_drafts: [{ id: X, brokerage_id: B2, agent_user_id: "a9550000-0000-4000-8000-0000000000f7", status: "pending" }] })
  setSvc(n1); setSessionUser(n1, U)
  const r1 = await review.dismissDraft(X) as { success: boolean }
  check("NEGATIVE dismissDraft: another tenant's draft is NOT dismissed, and the door does not report success", r1.success === false && n1.tables.ai_message_drafts[0].status === "pending", JSON.stringify(r1))
  const dv = await import(join(ROOT, `${A}video/distribute-video.ts`))
  const n2 = canaryClient({ ...baseSeed(), ai_video_projects: [{ id: X, brokerage_id: B2, status: "completed", video_url: "https://example.test/v.mp4" }], social_posts: [] })
  setSvc(n2); setSessionUser(n2, U)
  const r2 = await dv.distributeVideo({ videoProjectId: X, brokerageId: B2, userId: "a9550000-0000-4000-8000-0000000000f7", action: "draft" }) as { success: boolean }
  check("NEGATIVE distributeVideo: a body tenant that is not the session's is refused before any row is written", r2.success === false && (n2.tables.social_posts ?? []).length === 0 && ledgerOf(n2, "marketing.video.distribute").length === 0, JSON.stringify(r2))
  const n3 = canaryClient({ ...baseSeed(), ai_video_projects: [{ id: X, brokerage_id: B2, status: "completed", video_url: "https://example.test/v.mp4" }], social_posts: [] })
  setSvc(n3); setSessionUser(n3, U)
  const r3 = await dv.distributeVideo({ videoProjectId: X, action: "draft" } as never) as { success: boolean }
  check("NEGATIVE distributeVideo: another tenant's project is not found under the session tenant (no post written)", r3.success === false && (n3.tables.social_posts ?? []).length === 0, JSON.stringify(r3))

  // G04 canaries through the REAL dispatcher.
  const { dispatchKernelEvent } = await import("../lib/kernel/event-reactor")
  const fire = (event: string, brokerageId: string, entityType: string, entityId: string) =>
    dispatchKernelEvent({ event, brokerageId, entityType, entityId } as never).catch((e: unknown) => ({ threw: String(e) }))
  const dealSeed = (b: string): Rows => ({ ...baseSeed(), brokerages: [{ id: b, name: "R17" }], transactions: [{ id: T, brokerage_id: b, stage: "under_contract" }], feature_access_overrides: [] })
  g.__R17.spawns.length = 0
  const w1 = canaryClient(dealSeed(B)); setSvc(w1); setSessionUser(w1, null)
  await fire("offer_accepted", B, "transaction", T)
  const s1 = ledgerOf(w1, "agent.deal_coordinator.spawn")
  check("G04 offer_accepted: one Deal Coordinator spawn and ONE receipt (manager deal_coordinator, subject = the deal, executed)", g.__R17.spawns.length === 1 && s1.length === 1 && s1[0].status === "executed" && s1[0].actor_manager_key === "deal_coordinator" && s1[0].subject_id === T, JSON.stringify({ spawns: g.__R17.spawns.length, rows: s1.map((r) => [r.status, r.outcome]) }))
  g.__R17.spawns.length = 0
  const held = dealSeed(BH); held.feature_access_overrides = [{ brokerage_id: BH, feature_key: "autonomy", user_id: null, team_id: null, override_type: "disable", disabled_reason: "paused by staff", created_at: new Date().toISOString() }]
  const w2 = canaryClient(held); setSvc(w2); setSessionUser(w2, null)
  await fire("offer_accepted", BH, "transaction", T)
  const s2 = ledgerOf(w2, "agent.deal_coordinator.spawn")
  check("G04 offer_accepted DECISION: a tenant whose autonomy is paused gets ZERO spawns and a `skipped` receipt naming the hold", g.__R17.spawns.length === 0 && s2.length === 1 && s2[0].status === "skipped" && s2[0].outcome === "autonomy_held", JSON.stringify({ spawns: g.__R17.spawns.length, rows: s2.map((r) => [r.status, r.outcome]) }))
  g.__R17.spawns.length = 0
  const w3 = canaryClient(dealSeed(B), { refuse: { agent_action_ledger: "permission denied for table agent_action_ledger" } }); setSvc(w3); setSessionUser(w3, null)
  const t3 = await fire("offer_accepted", B, "transaction", T)
  check("G04 offer_accepted REFUSED LEDGER: the spawn still runs exactly once, nothing is receipted, nothing throws (today's behavior)", g.__R17.spawns.length === 1 && (w3.tables.agent_action_ledger ?? []).length === 0 && !(t3 as { threw?: string }).threw, JSON.stringify({ spawns: g.__R17.spawns.length, t3 }))
  g.__R17.tours.length = 0
  const w4 = canaryClient({ ...baseSeed(), contacts: [{ id: C, brokerage_id: B, agent_id: AG, contact_type: "buyer" }] }); setSvc(w4); setSessionUser(w4, null)
  await fire("tour_completed", B, "contact", C)
  await new Promise((r) => setTimeout(r, 50)) // the follow-up is fire-and-forget by design
  const s4 = ledgerOf(w4, "agent.tour_followup.propose")
  check("G04 tour_completed: the follow-up producer ran once and left ONE receipt (manager shopping_agent, executed)", g.__R17.tours.length === 1 && s4.length === 1 && s4[0].status === "executed" && s4[0].actor_manager_key === "shopping_agent", JSON.stringify({ tours: g.__R17.tours.length, rows: s4.map((r) => [r.status, r.outcome]) }))
  check("SCOPE · zero provider calls across every canary (global fetch counted)", fetches === 0, `fetch calls: ${fetches}`)
}

async function main(): Promise<void> {
  partA()
  await partB()
  console.log("\nBLIND SPOTS")
  console.log("  · RLS, triggers and the live CHECKs are not modelled (Part A checks the action names; test:action-ledger §14 scans them too).")
  console.log("  · Driven G12 modules: academy-learning, learning-modules, learning-modules-approvals, marketing/review, video/distribute-video. The other wrapped modules are proven STATICALLY (their gates need the vendor portal actor, the portal contact gate, the heavy repurpose graph or a model).")
  console.log("  · G04 client_education_delivered is proven statically (its producer module is imported by name across the graph and cannot be stubbed whole).")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); console.log("❌ LEDGER_RECEIPTS_TAIL_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_TAIL_PASS — every wrapped row reaches the one session helper with no key; the driven exports write one receipt per call and settle a refused write as failed; the reactor's reactions are decided and receipted")
}

main().catch((e) => { console.error(e); process.exit(1) })
