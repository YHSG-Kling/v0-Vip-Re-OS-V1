#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-visible-guard.ts   (npm run test:ledger-receipts-visible)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 155, LANE 155R19 — the 57 NEWLY VISIBLE session writes (group G12). Lane 155R16 corrected the census
 * (scripts/os-coverage-ledger.ts): it now sees writes behind barrel re-exports and called default-dependency members, and it
 * withdrew credits borrowed from another export's receipt. 57 server actions / session routes in 37 modules turned out to
 * write (a row, a cost-booked model call, a storage object, a seeded settings row) with NO action-ledger receipt — and the
 * coverage baseline is prune-only, so each is closed by what the code does: ONE receipt through the ONE session helper,
 * lib/kernel/action-ledger.ts ledgerSessionAction (session user, the SESSION's tenant, a three-segment action, the subject,
 * the true risk class, reasonCode HUMAN_REQUESTED, no cycle / idempotencyKey). Model-only paths record the actor and tenant;
 * their spend is already booked by the AI cost ledger and is NOT booked again here.
 *
 * PART A — STATIC (comment-stripped source, CLAUDE.md §2):
 *   · every WRAPPED row reaches `ledgerSessionAction(` inside its own span, names its three-segment action, passes no key;
 *   · every DELEGATE row calls (in code, not a comment) an export / function whose own span reaches the helper;
 *   · the gate FIXES are in code: getNeighborhoodData and the four model-backed calculators refuse a sessionless caller before
 *     any model door, calculateSellerNet and assignTierToListing decide a claimed tenant through decideClaimedTenant.
 *   Positive controls: a tombstone naming the helper is not a call, a `cycle` is caught, a delegate that only MENTIONS its
 *   survivor in a comment is caught, a hand-written tenant comparison is caught.
 * PART B — DRIVEN (in-memory, SIMULATED; scripts/canaries/_harness.ts stubs the service + session clients; the two model doors
 *   and the kernel event fan-out are COUNTED seams — no provider, no model, no network): per driven export, two calls by a
 *   signed-in user → exactly TWO receipts (actor users.id, tenant, action, subject, risk class, no key), both `executed` (the
 *   no-key canary: the second call RAN); then one call with the domain write refused (an absent column, 42703) or the model
 *   seam refusing → that receipt settles `failed`. The settings seed is driven as ONE receipt for two reads (it seeds once).
 *   Negatives: a sessionless caller reaches no model door; a body tenant naming another brokerage is refused with no receipt.
 * RED AT 76fa3d53: no row reached the helper, getNeighborhoodData and the calculators ran a model for an anonymous caller,
 *   calculateSellerNet priced with the argument tenant, assignTierToListing compared tenants by hand.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { blankComments, blankStrings } from "./strip-comments"
import { stubModule, setSvc, canaryClient, setSessionUser } from "./canaries/_harness"

const ROOT = process.cwd()
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── the rows (scope: $S/b3/155R19-rows.json — 57 rows: 14 P0 · 31 P1 · 12 P2) ─────────────────────────
const WRAPPED: Record<string, string> = {
  // P0
  "app/actions/buyer-financial.ts#uploadFinancialVerificationDocument": "buyer.financial_document.upload",
  "app/actions/buyer-offer/request-addendum-signatures.ts#startAddendumSignatureHandoff": "transaction.addendum_signature.handoff",
  "app/actions/buyer-offer/request-addendum-signatures.ts#approveAddendumForSignature": "transaction.addendum_signature.approve",
  "app/actions/buyer-offer/request-addendum-signatures.ts#fileSignedAddendumCopy": "transaction.addendum_signature.file_signed",
  "app/actions/buyer-property-search.ts#searchPropertiesWithNaturalLanguage": "buyer.property_search.run",
  "app/actions/marketing-studio.ts#createCampaign": "marketing.campaign.create",
  "app/actions/podcast-generation.ts#generatePodcastAudio": "podcast.episode_audio.generate",
  "app/actions/portal-education.ts#markLessonRead": "portal.lesson.mark_read",
  "app/actions/portal-messages.ts#markMessagesRead": "portal.message.mark_read",
  "app/actions/portal-seller.ts#emitSellerPortalViewed": "portal.seller_module.view",
  "app/actions/referrals/referral-actions.ts#draftReferralThankYou": "referral.thank_you.draft",
  "lib/ads/ad-monitor.ts#generateInsights": "marketing.ad_insight.generate",
  "lib/listings/tier-assigner.ts#assignTierToListing": "listing.marketing_tier.assign",
  // P1
  "app/actions/ai-content-generation.tsx#generateHashtags": "content.hashtags.generate",
  "app/actions/ai-content-generation.tsx#getNeighborhoodData": "content.neighborhood_profile.generate",
  "app/actions/ai-newsletter.ts#createNewsletterCampaign": "marketing.newsletter_campaign.save",
  "app/actions/calculators.ts#calculateSellerNet": "calculator.seller_net.run",
  "app/actions/calculators.ts#compareMortgageScenarios": "calculator.mortgage_comparison.run",
  "app/actions/calculators.ts#compareNeighborhoods": "calculator.neighborhood_comparison.run",
  "app/actions/calculators.ts#analyzeInvestmentProperty": "calculator.investment_analysis.run",
  "app/actions/campaign-readiness.ts#evaluateContentReadiness": "marketing.readiness_evaluation.record",
  "app/actions/campaign-readiness.ts#batchEvaluateContentReadiness": "marketing.readiness_evaluation.record_batch",
  "app/actions/campaign-readiness.ts#checkSpecificChannelReadiness": "marketing.channel_readiness.record",
  "app/actions/content-approval-workflow.ts#evaluateContentApproval": "content.approval_signal.record",
  "app/actions/content-approval-workflow.ts#batchEvaluateContentApproval": "content.approval_signal.record_batch",
  "app/actions/content-generation-engine.ts#generateText": "content.text.generate",
  "app/actions/content-generation-engine.ts#generateAudio": "content.audio_script.generate",
  "app/actions/content-generation-engine.ts#generateOmnipresent": "content.omnipresent.generate",
  "app/actions/content-generation-engine.ts#generateVariations": "content.variations.generate",
  "app/actions/content-generation-engine.ts#generateFromURL": "content.url_repurpose.generate",
  "app/actions/direct-mail.ts#createMailCampaign": "marketing.direct_mail_campaign.create",
  "app/actions/open-house.ts#sendOpenHouseInvites": "open_house.invitation.send",
  "app/actions/property-buyer-matching.ts#matchBuyersForListing": "listing.buyer_match_signal.record_batch",
  "app/actions/property-buyer-matching.ts#scoreSingleBuyerForListing": "listing.buyer_match_signal.record",
  "app/actions/seller-open-house.ts#createQrCodeForEvent": "open_house.qr_code.create",
  "app/actions/sequence-step-ai.ts#composeSequenceStepCopy": "sequence.step_copy.compose",
  "app/actions/video-repurposing.ts#generateCaptionVariations": "marketing.caption_variation.generate",
  "app/actions/video-repurposing.ts#generateSnippetSuggestions": "marketing.video_snippet.suggest",
  "app/actions/video/memory-video.ts#offerMemoryVideoAction": "marketing.memory_video.offer",
  "app/api/ai/generate-module-content/route.ts#POST": "education.module_content.generate",
  "app/api/ai/generate-sequence/route.ts#POST": "sequence.steps.generate",
  "app/api/intelligence/coaching/route.ts#POST": "coaching.insight.generate",
  // P2
  "app/actions/calendar/calendar-sync-actions.ts#connectCalendarProvider": "calendar.provider_account.link",
  "app/actions/onboarding/onboarding-quiz-actions.ts#submitQuiz": "onboarding.quiz_attempt.submit",
  "app/actions/onboarding/onboarding-steps-admin-actions.ts#createBrokerageStep": "onboarding.brokerage_step.create",
  "app/actions/onboarding/onboarding-steps-admin-actions.ts#updateBrokerageStep": "onboarding.brokerage_step.update",
  "app/actions/onboarding/onboarding-steps-admin-actions.ts#deleteBrokerageStep": "onboarding.brokerage_step.delete",
  "app/actions/settings/manage-notification-rules.ts#createRule": "tenant.notification_rule.create",
  "app/actions/settings/manage-notification-rules.ts#editRule": "tenant.notification_rule.update",
  "app/actions/settings/manage-notification-rules.ts#removeRule": "tenant.notification_rule.delete",
  "app/actions/settings/update-global-settings.ts#updateGlobalSettings": "tenant.global_settings.update",
  "app/actions/settings/update-notification-rules.ts#updateNotificationRules": "tenant.notification_rule.toggle",
}
/** A row whose write is reached THROUGH another export / function that carries the receipt (row → [file#fn, its action]). */
const DELEGATE: Record<string, [string, string]> = {
  "app/actions/portal-buyer-financial.ts#uploadBuyerFinancialFromPortalAction": ["app/actions/buyer-financial.ts#uploadFinancialVerificationDocument", "buyer.financial_document.upload"],
  "app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts#runBatchReadinessCheck": ["app/actions/campaign-readiness.ts#batchEvaluateContentReadiness", "marketing.readiness_evaluation.record_batch"],
  "app/actions/content-approval-workflow.ts#evaluateContentWorkflow": ["app/actions/content-approval-workflow.ts#evaluateContentApproval", "content.approval_signal.record"],
  // The settings READS write only the once-per-brokerage seed — its receipt sits on the seed insert (getGlobalSettings → kernel).
  "app/actions/settings/get-global-settings.ts#getGlobalSettings": ["lib/kernel/global-settings.ts#ensureGlobalSettingsRow", "tenant.global_settings.seed"],
  "app/actions/settings/global-settings-actions.ts#fetchGlobalSettings": ["lib/kernel/global-settings.ts#ensureGlobalSettingsRow", "tenant.global_settings.seed"],
}
/** What the delegate row calls by name (the kernel barrel names the seed's caller `getGlobalSettings`). */
const DELEGATE_CALLS: Record<string, string> = {
  "app/actions/portal-buyer-financial.ts#uploadBuyerFinancialFromPortalAction": "uploadFinancialVerificationDocument",
  "app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts#runBatchReadinessCheck": "batchEvaluateContentReadiness",
  "app/actions/content-approval-workflow.ts#evaluateContentWorkflow": "evaluateContentApproval",
  "app/actions/settings/get-global-settings.ts#getGlobalSettings": "kernelGetGlobalSettings",
  "app/actions/settings/global-settings-actions.ts#fetchGlobalSettings": "getGlobalSettings",
}
const ROW_COUNT = 57
const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
/** A call of the helper, with or without an explicit type argument (`ledgerSessionAction<T>(`). */
const HELPER_CALL = /\bledgerSessionAction\s*(?:<[^()]*>)?\s*\(/

/** A function's top-level span (exported or not) in a comment-blanked text: from its declaration to the next top-level declaration. */
function spanOf(text: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/\n(?:export\s|async\s+function\s|function\s|const\s|interface\s|type\s)/)
  return text.slice(m.index, m.index + m[0].length + (next < 0 ? rest.length : next))
}
function judge(src: string, name: string, action: string): string[] {
  const noComments = blankComments(src)
  const code = blankStrings(noComments)
  const codeSpan = spanOf(code, name), litSpan = spanOf(noComments, name)
  if (!codeSpan || !litSpan) return [`function ${name} not found`]
  const out: string[] = []
  if (!HELPER_CALL.test(codeSpan)) out.push("does not reach ledgerSessionAction(")
  if (!litSpan.includes(`"${action}"`) && !litSpan.includes(`'${action}'`)) out.push(`does not name ${action}`)
  if (/\b(?:cycle|idempotencyKey)\s*:/.test(codeSpan)) out.push("passes cycle / idempotencyKey (a second save would be a silent no-op)")
  return out
}
function callsInCode(src: string, name: string, callee: string): boolean {
  const span = spanOf(blankStrings(blankComments(src)), name)
  return !!span && new RegExp(`\\b${callee}\\s*\\(`).test(span)
}
/** A claimed tenant compared by hand (`x.brokerageId !== brokerageId`) instead of the decision table (lesson 1). */
function handRolledTenantCompare(span: string): boolean {
  return /\bbrokerage_?[Ii]d\s*!==\s*\w*[Bb]rokerage_?[Ii]d\b/.test(span) && !/decideClaimedTenant\s*\(/.test(span)
}
const read = (f: string) => readFileSync(join(ROOT, f), "utf8")

async function main(): Promise<void> {
  console.log("\nPART A — static (stripped source)")
  check("control: a tombstone naming the helper is not a call", judge(`export async function f() {\n  // ledgerSessionAction("x.y.z")\n  return 1\n}\n`, "f", "x.y.z").includes("does not reach ledgerSessionAction("))
  check("control: a span passing a cycle is caught", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z", cycle: "c" }, run)\n}\n`, "f", "x.y.z").some((s) => s.startsWith("passes cycle")))
  check("control: a clean span passes, with or without a type argument", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z" }, run)\n}\n`, "f", "x.y.z").length === 0 && judge(`export async function f() {\n  return ledgerSessionAction<R>({ action: "x.y.z" }, run)\n}\n`, "f", "x.y.z").length === 0)
  check("control: a delegate that only MENTIONS its survivor in a comment is caught", !callsInCode(`export async function d() {\n  // survivor: g(x)\n  return 1\n}\n`, "d", "g"))
  check("control: a hand-written tenant comparison is caught; the decision table is not", handRolledTenantCompare("if (gate.actor.brokerageId !== brokerageId) {") && !handRolledTenantCompare("if (!decideClaimedTenant({ actingBrokerageId: a, claimedBrokerageId: b }).ok) {"))

  const covered = Object.keys(WRAPPED).length + Object.keys(DELEGATE).length
  check(`every row is WRAPPED or DELEGATE (${Object.keys(WRAPPED).length} + ${Object.keys(DELEGATE).length} = ${covered} of ${ROW_COUNT})`, covered === ROW_COUNT)
  check("no row is on both lists", Object.keys(DELEGATE).every((k) => !(k in WRAPPED)))
  for (const [row, action] of Object.entries(WRAPPED)) {
    const [file, name] = row.split("#")
    check(`${action} names three lowercase segments`, NAME_RE.test(action))
    const problems = judge(read(file), name, action)
    check(`${file}#${name} → ledgerSessionAction("${action}"), no key`, problems.length === 0, problems.join("; "))
  }
  for (const [row, [target, action]] of Object.entries(DELEGATE)) {
    const [file, name] = row.split("#")
    const [tFile, tName] = target.split("#")
    const problems = judge(read(tFile), tName, action)
    check(`${row} reaches the receipt through ${tName} ("${action}")`, callsInCode(read(file), name, DELEGATE_CALLS[row]) && problems.length === 0, problems.join("; ") || `does not call ${DELEGATE_CALLS[row]}( in code`)
  }
  // The gate FIXES, statically.
  const aiGen = blankStrings(blankComments(read("app/actions/ai-content-generation.tsx")))
  const nb = spanOf(aiGen, "getNeighborhoodData") ?? ""
  check("FIX getNeighborhoodData: the module's session gate runs before the model door", /requireContentActor\s*\(/.test(nb) && nb.search(/requireContentActor\s*\(/) < nb.search(/generateAIResponse\s*\(/))
  const calc = blankStrings(blankComments(read("app/actions/calculators.ts")))
  for (const fn of ["calculateSellerNet", "compareMortgageScenarios", "compareNeighborhoods", "analyzeInvestmentProperty"]) {
    const sp = spanOf(calc, fn) ?? ""
    check(`FIX ${fn}: the session gate runs before the model door`, /calcSessionActor\s*\(/.test(sp) && sp.search(/calcSessionActor\s*\(/) < sp.search(/generateAIJSON\s*\(/))
  }
  check("FIX calculateSellerNet: the claimed tenant goes through decideClaimedTenant and the SESSION's tenant prices the sheet", /decideClaimedTenant\s*\(/.test(spanOf(calc, "calculateSellerNet") ?? "") && /getDefaultCommissionStructure\s*\(\s*tenant\.brokerageId\s*\)/.test(spanOf(calc, "calculateSellerNet") ?? ""))
  const tier = blankStrings(blankComments(read("lib/listings/tier-assigner.ts")))
  check("FIX assignTierToListing: no hand-written tenant comparison; decideClaimedTenant decides", !handRolledTenantCompare(spanOf(tier, "assignTierToListing") ?? "x !== brokerageId") && /decideClaimedTenant\s*\(/.test(spanOf(tier, "assignTierToListing") ?? ""))

  // THE SIGNAL ROWS NAME THEIR TENANT. `activities.brokerage_id` is NOT NULL with no default (read from the live database
  // 2026-11-20). The two signal loggers the matching / approval actions call inserted without it, so every row was refused and
  // the in-memory client — which models no NOT NULL — could not see it. Held on the source: every activities insert in the two
  // loggers names brokerage_id, and the tenant is a REQUIRED parameter (an optional one is how it went missing).
  for (const f of ["lib/property-matching/match-logger.ts", "lib/approval-workflow/approval-logger.ts"]) {
    const n = activitiesInsertsMissingTenant(readFileSync(join(ROOT, f), "utf8"))
    check(`${f}: every activities insert names brokerage_id (${n.inserts} insert(s), ${n.missing} without)`, n.inserts > 0 && n.missing === 0)
  }
  check("the match logger's tenant is a required parameter", /logBuyerMatchSignal\(\s*listingId: string,\s*match: MatchScore,\s*tenant: MatchSignalTenant,?\s*\)/.test(blankComments(readFileSync(join(ROOT, "lib/property-matching/match-logger.ts"), "utf8"))))
  check("the approval logger's tenant is a required field", /logApprovalDecision\(params: \{[\s\S]{0,80}?\bbrokerage_id: string\b/.test(blankComments(readFileSync(join(ROOT, "lib/approval-workflow/approval-logger.ts"), "utf8")).replace(/\n\s*\n/g, "\n")))
  check("POSITIVE CONTROL: an activities insert with no brokerage_id is counted", activitiesInsertsMissingTenant(`await supabase.from('activities').insert({ entity_type: 'listing', entity_id: id, status: 'completed' })`).missing === 1)
  check("POSITIVE CONTROL: a records array built without brokerage_id is counted", activitiesInsertsMissingTenant(`const records = matches.map((m) => ({ entity_type: 'listing', title: m.t }))\nawait supabase.from('activities').insert(records)`).missing === 1)
  check("NEGATIVE CONTROL: a tenanted insert is not counted", activitiesInsertsMissingTenant(`await supabase.from("activities").insert({ brokerage_id: t.brokerageId, entity_type: "listing" })`).missing === 0)

  console.log("\nPART B — driven (in-memory, SIMULATED)")
  await driven()

  console.log("\nBLIND SPOTS")
  for (const b of BLIND) console.log(`  · ${b}`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); console.log("❌ LEDGER_RECEIPTS_VISIBLE_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_VISIBLE_PASS — every newly visible session write reaches the one session helper with no key; the driven exports write one receipt per call and settle a refused write as failed; sessionless callers reach no model door")
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — the seams are installed before any action module is imported.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Belt and braces, PROCESS-LOCAL: no provider key is visible to this process, so a door this guard failed to stub refuses instead of calling out.
for (const k of ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY", "RENTCAST_API_KEY"]) delete process.env[k]
const SEAM = globalThis as unknown as { __R19: { ai: number; event: number; fail: boolean; text: string; json: Record<string, unknown> } }
SEAM.__R19 = { ai: 0, event: 0, fail: false, text: "[]", json: {} }
const MODEL_DOORS = `
export async function generateAIResponse(req) { const s = globalThis.__R19; s.ai++; if (s.fail) throw new Error("seam: the model refused"); return { text: s.text, model: null, usage: { inputTokens: 0, outputTokens: 0 } } }
export async function generateAIJSON(prompt) { const s = globalThis.__R19; s.ai++; if (s.fail) return { data: null, error: "seam: the model refused" }; return { data: s.json } }
export async function generateTextRouted(req) { const s = globalThis.__R19; s.ai++; if (s.fail) throw new Error("seam: the model refused"); return { text: s.text } }
export async function runPipelineSimple(prompt, opts) { const s = globalThis.__R19; s.ai++; if (s.fail) throw new Error("seam: the model refused"); return s.text }`
stubModule("@/lib/ai", `export * from ${JSON.stringify(pathToFileURL(join(ROOT, "lib/ai/index.ts")).href)};${MODEL_DOORS}`)
stubModule("@/lib/kernel/notification-engine", `export * from ${JSON.stringify(pathToFileURL(join(ROOT, "lib/kernel/notification-engine.ts")).href)}; export async function processKernelEvent() { globalThis.__R19.event++; return { ok: true } }`)
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
stubModule("next/headers", "export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }); export const headers = async () => new Headers()")

const B = "b1550000-0000-4000-8000-0000000000f9"
const B2 = "b2550000-0000-4000-8000-0000000000f9" // another tenant, for the negatives
const U = "a1550000-0000-4000-8000-0000000000f9"
const A = "a2550000-0000-4000-8000-0000000000f9"
const C = "c1550000-0000-4000-8000-0000000000f9"
const L = "11550000-0000-4000-8000-0000000000f9"
const X = "e1550000-0000-4000-8000-0000000000f9" // the subject row each driver acts on
const FEATURES = ["marketing_studio", "listing_marketing_tiers", "direct_mail", "newsletter_engine"]
function baseSeed(): Record<string, Record<string, unknown>[]> {
  return {
    brokerages: [{ id: B, name: "R19 Realty", plan_tier: "brokerage" }, { id: B2, name: "Other Realty", plan_tier: "brokerage" }],
    users: [{ id: U, brokerage_id: B, user_type: "broker_owner", platform_role: null, email: "owner@wave140-canary.test", first_name: "Rae", last_name: "Lane" }],
    agents: [{ id: A, user_id: U, brokerage_id: B }],
    contacts: [{ id: C, brokerage_id: B, agent_id: A, contact_type: "buyer", status: "active", email: "client@wave140-canary.test", first_name: "Cleo", last_name: "Client", notes: null, created_at: "2026-01-01T00:00:00Z" }],
    listings: [{ id: L, brokerage_id: B, agent_id: A, address: "1 Receipt Row", list_price: 500000, status: "active", city: "Pensacola", state: "FL", bedrooms: 3, bathrooms: 2, sqft: 1800, property_type: "single_family" }],
    // THE REAL FEATURE GATE (mayUseAndAfford): a current subscription, then the plan-feature row it reads.
    subscriptions: [{ id: "sub-r19", brokerage_id: B, status: "active", trial_end: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
    feature_flags: FEATURES.map((k) => ({ feature_key: k, enabled: true, superadmin_only: false, solo_agent_access: true, team_access: true, brokerage_access: true, multi_location_access: true,
      solo_agent_limit: null, team_limit: null, brokerage_limit: null, multi_location_limit: null, beta: false, deprecated: false, sunset_date: null, rollout_percentage: null })),
    feature_access_overrides: [], feature_usage_tracking: [], usage_counters: [], portal_contact_invites: [], user_role_assignments: [],
    agent_action_ledger: [],
  }
}
interface Driver {
  module: string; label: string; action: string; risk: string; subject: string
  seed: Record<string, Record<string, unknown>[]>
  call: (m: Record<string, any>) => Promise<unknown>
  /** How the act is made to fail: a column the write names made absent (42703), or the model seam refusing. */
  failCol?: Record<string, string[]>
  failModel?: boolean
  /** Model text / JSON the seam answers with. */
  text?: string; json?: Record<string, unknown>
  /** The number of model-door calls ONE successful call makes (counted; 0 for a write-only export). */
  aiPerCall?: number
  between?: (tables: Record<string, Record<string, unknown>[]>) => void
  /** Patch the in-memory client (the storage door) before the call. */
  patch?: (svc: Record<string, any>) => void
}
const okStorage = (svc: Record<string, any>) => { svc.storage = { from: () => ({ upload: async (p: string) => ({ data: { path: p }, error: null }), remove: async () => ({ data: null, error: null }) }) } }
const readinessInput = () => ({
  content_type: "social_post", channel_intent: ["email"], audience_scope: "sphere", content_id: X,
  compliance_verdict: { compliance_status: "pass", summary: { highest_severity: "none", total_violations: 0 }, violations: [], warnings: [] },
  approval_decision: { approval_status: "approved", required_approvers: [], approval_notes: [], decided_at: "2026-01-01T00:00:00Z", metadata: { content_type: "social_post", channel_intent: "email" } },
  context: {},
})
const req = (body: unknown) => new Request("http://canary.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const DRIVERS: Driver[] = [
  { module: "app/actions/property-buyer-matching.ts", label: "scoreSingleBuyerForListing(logSignal)", action: "listing.buyer_match_signal.record", risk: "LOW_RISK_WRITE", subject: L,
    seed: { conversation_insights: [], activities: [] }, call: (m) => m.scoreSingleBuyerForListing({ listingId: L, contactId: C, logSignal: true }), failCol: { activities: ["entity_id"] } },
  { module: "app/actions/campaign-readiness.ts", label: "checkSpecificChannelReadiness(log)", action: "marketing.channel_readiness.record", risk: "LOW_RISK_WRITE", subject: X,
    seed: { users: [{ id: U, brokerage_id: B, user_type: "agent", platform_role: null, email: "agent@wave140-canary.test", first_name: "Rae", last_name: "Lane" }], activities: [] }, call: (m) => m.checkSpecificChannelReadiness(readinessInput(), "email", { log_to_activities: true }), failCol: { activities: ["entity_id"] } },
  { module: "app/actions/portal-seller.ts", label: "emitSellerPortalViewed", action: "portal.seller_module.view", risk: "LOW_RISK_WRITE", subject: C,
    seed: { client_portal_activity: [] }, call: (m) => m.emitSellerPortalViewed(C, "overview"), failCol: { client_portal_activity: ["activity_type"] } },
  { module: "app/actions/portal-messages.ts", label: "markMessagesRead", action: "portal.message.mark_read", risk: "LOW_RISK_WRITE", subject: C,
    seed: { client_portal_messages: [{ id: X, brokerage_id: B, contact_id: C, direction: "client_to_agent", read: false }] }, call: (m) => m.markMessagesRead({ contactId: C, direction: "client_to_agent" }), failCol: { client_portal_messages: ["read_at"] },
    between: (t) => { for (const r of t.client_portal_messages ?? []) r.read = false } },
  { module: "app/actions/portal-education.ts", label: "markLessonRead(module id)", action: "portal.lesson.mark_read", risk: "LOW_RISK_WRITE", subject: C,
    seed: { learning_assignments: [], learning_modules: [{ id: X, brokerage_id: B, title: "Offers 101" }] }, call: (m) => m.markLessonRead({ contactId: C, lessonKey: X }), failCol: { learning_assignments: ["signal_source"] } },
  { module: "app/actions/buyer-financial.ts", label: "uploadFinancialVerificationDocument", action: "buyer.financial_document.upload", risk: "LOW_RISK_WRITE", subject: C,
    seed: { client_documents: [] }, patch: okStorage, call: (m) => m.uploadFinancialVerificationDocument({ contactId: C, fileName: "preapproval.pdf", contentType: "application/pdf", base64: Buffer.from("%PDF-1.4 canary").toString("base64"), docCategory: "pre_approval_letter" }), failCol: { client_documents: ["doc_category"] } },
  { module: "app/actions/settings/manage-notification-rules.ts", label: "createRule", action: "tenant.notification_rule.create", risk: "LOW_RISK_WRITE", subject: "",
    seed: { notification_rules: [] }, call: (m) => m.createRule({ rule_name: "Hot lead", trigger_event: "lead_created", notification_type: "email", recipient_role: "agent", is_active: true }), failCol: { notification_rules: ["rule_name"] } },
  { module: "app/actions/settings/update-notification-rules.ts", label: "updateNotificationRules", action: "tenant.notification_rule.toggle", risk: "LOW_RISK_WRITE", subject: X,
    seed: { notification_rules: [{ id: X, brokerage_id: B, rule_name: "Hot lead", trigger_event: "lead_created", notification_type: "email", recipient_role: "agent", is_active: true }] }, call: (m) => m.updateNotificationRules(X, { is_active: false }), failCol: { notification_rules: ["is_active"] } },
  { module: "app/actions/onboarding/onboarding-steps-admin-actions.ts", label: "createBrokerageStep", action: "onboarding.brokerage_step.create", risk: "LOW_RISK_WRITE", subject: "",
    seed: { onboarding_steps: [] }, call: (m) => m.createBrokerageStep({ day_number: 1, step_order: 1, step_key: `k-${Math.random().toString(36).slice(2, 8)}`, step_name: "Read the handbook", category: "training", required: true }), failCol: { onboarding_steps: ["step_name"] } },
  { module: "app/actions/calendar/calendar-sync-actions.ts", label: "connectCalendarProvider", action: "calendar.provider_account.link", risk: "LOW_RISK_WRITE", subject: U,
    seed: { calendar_provider_accounts: [] }, call: (m) => m.connectCalendarProvider({ providerType: "google_calendar", providerAccountId: "cal@wave140-canary.test" }), failCol: { calendar_provider_accounts: ["provider_account_id"] } },
  { module: "app/actions/settings/update-global-settings.ts", label: "updateGlobalSettings", action: "tenant.global_settings.update", risk: "LOW_RISK_WRITE", subject: B,
    seed: { global_settings: [{ id: X, brokerage_id: B, app_name: "R19 Realty", timezone: "America/New_York" }] }, call: (m) => m.updateGlobalSettings({ timezone: "America/Chicago" }), failCol: { global_settings: ["timezone"] } },
  { module: "app/actions/open-house.ts", label: "sendOpenHouseInvites", action: "open_house.invitation.send", risk: "COMMUNICATION", subject: X,
    seed: { open_house_events: [{ id: X, brokerage_id: B, listing_id: L, event_date: "2027-03-01", status: "scheduled" }], open_house_invitations: [] }, call: (m) => m.sendOpenHouseInvites(X), failCol: { open_house_invitations: ["channel"] } },
  { module: "lib/listings/tier-assigner.ts", label: "assignTierToListing", action: "listing.marketing_tier.assign", risk: "FINANCIAL", subject: L,
    seed: { listing_marketing_tiers: [{ id: X, brokerage_id: B, tier_name: "Core", min_price: null, max_price: null, is_active: true, description: null }], tier_budgets: [{ id: "tb-1", tier_id: X, channel_type: "social", default_budget: 250 }] },
    call: (m) => m.assignTierToListing(L, B, U), failCol: { listings: ["marketing_budget"] } },
  { module: "app/actions/marketing-studio.ts", label: "createCampaign", action: "marketing.campaign.create", risk: "LOW_RISK_WRITE", subject: "",
    seed: { marketing_campaigns: [] }, call: (m) => m.createCampaign({ campaignName: "Spring", campaignType: "brand" }), failCol: { marketing_campaigns: ["campaign_name"] } },
  { module: "app/actions/portal-buyer-financial.ts", label: "uploadBuyerFinancialFromPortalAction (the buyer, through the shared door)", action: "buyer.financial_document.upload", risk: "LOW_RISK_WRITE", subject: C,
    seed: { users: [{ id: U, brokerage_id: null, user_type: "client", platform_role: null, email: "client@wave140-canary.test" }], contacts: [{ id: C, brokerage_id: B, agent_id: A, contact_user_id: U, email: "client@wave140-canary.test", first_name: "Cleo", last_name: "Client" }], client_documents: [] },
    patch: okStorage, call: (m) => m.uploadBuyerFinancialFromPortalAction({ contactId: C, fileName: "pof.pdf", contentType: "application/pdf", base64: Buffer.from("%PDF-1.4 canary").toString("base64"), docCategory: "proof_of_funds" }), failCol: { client_documents: ["doc_category"] } },
  { module: "app/actions/content-approval-workflow.ts", label: "evaluateContentApproval(log_signal)", action: "content.approval_signal.record", risk: "LOW_RISK_WRITE", subject: X,
    seed: { users: [{ id: U, brokerage_id: B, user_type: "agent", platform_role: null, email: "agent@wave140-canary.test", first_name: "Rae", last_name: "Lane" }], activities: [] }, call: (m) => m.evaluateContentApproval({ draft: { raw_content: "A sunny two-bedroom near the bay.", content_type: "social_post", channel_intent: "social", metadata: { content_type: "social_post", channel_intent: "social" } }, complianceVerdict: { compliance_status: "pass", summary: { highest_severity: "none", total_violations: 0 }, violations: [], warnings: [] }, context: { requester_role: "agent", audience_scope: "sphere" }, log_signal: true, content_id: X }),
    failCol: { activities: ["entity_id"] } },
  { module: "app/actions/seller-open-house.ts", label: "createQrCodeForEvent", action: "open_house.qr_code.create", risk: "LOW_RISK_WRITE", subject: X,
    seed: { open_house_events: [{ id: X, brokerage_id: B, listing_id: L, agent_id: A, event_date: "2027-03-01", status: "scheduled" }], qr_codes: [] }, call: (m) => m.createQrCodeForEvent({ eventId: X, listingId: L }), failCol: { open_house_events: ["qr_code_id"] } },
  { module: "app/actions/direct-mail.ts", label: "createMailCampaign", action: "marketing.direct_mail_campaign.create", risk: "LOW_RISK_WRITE", subject: "",
    seed: { direct_mail_campaigns: [], qr_codes: [] }, call: (m) => m.createMailCampaign({ brokerageId: B, createdBy: U, campaignName: "Farm", targetAudience: "farm_area", quantity: 10 }), failCol: { direct_mail_campaigns: ["campaign_name"] } },
  { module: "app/actions/ai-newsletter.ts", label: "createNewsletterCampaign", action: "marketing.newsletter_campaign.save", risk: "LOW_RISK_WRITE", subject: "",
    seed: { newsletter_campaigns: [], newsletter_sections: [] }, call: (m) => m.createNewsletterCampaign({ title: "November", subjectLine: "November", preheaderText: "", template: "classic", content: [], audienceSegment: "all" }), failCol: { newsletter_campaigns: ["subject_line"] } },
  // ── model-backed (the counted seam answers; the spend is the AI cost ledger's, never re-booked) ──
  { module: "app/actions/content-generation-engine.ts", label: "generateFromURL", action: "content.url_repurpose.generate", risk: "LOW_RISK_WRITE", subject: "", aiPerCall: 1, failModel: true,
    seed: { activities: [] }, text: "A bright, renovated bungalow two blocks from the bay.", call: (m) => m.generateFromURL({ source_url: "https://example.com/listing/1", content_type: "email" }) },
  { module: "app/actions/sequence-step-ai.ts", label: "composeSequenceStepCopy", action: "sequence.step_copy.compose", risk: "LOW_RISK_WRITE", subject: U, aiPerCall: 1, failModel: true,
    seed: {}, text: "Hi {{first_name}}, checking in on your search — anything new you would like to see?", call: (m) => m.composeSequenceStepCopy({ stepType: "sms", goal: "Check in on the buyer's search" }) },
  { module: "app/actions/calculators.ts", label: "compareMortgageScenarios", action: "calculator.mortgage_comparison.run", risk: "LOW_RISK_WRITE", subject: U, aiPerCall: 1,
    seed: {}, json: { recommendations: { first_time_buyers: "30-year" } }, call: (m) => m.compareMortgageScenarios({ loanAmount: 400000, scenarios: [{ name: "30y", term: 30, interestRate: 6.5, downPayment: 40000, loanType: "fixed" }] }) },
  { module: "app/actions/referrals/referral-actions.ts", label: "draftReferralThankYou", action: "referral.thank_you.draft", risk: "LOW_RISK_WRITE", subject: X, aiPerCall: 1, failModel: true,
    seed: { users: [{ id: U, brokerage_id: B, user_type: "agent", platform_role: null, email: "agent@wave140-canary.test", first_name: "Rae", last_name: "Lane" }], referrals: [{ id: X, brokerage_id: B, agent_id: A, referral_name: "Dana", referrer_contact_id: C }] }, text: "Thank you, Cleo.", call: (m) => m.draftReferralThankYou(X) },
  { module: "app/actions/video-repurposing.ts", label: "generateCaptionVariations", action: "marketing.caption_variation.generate", risk: "LOW_RISK_WRITE", subject: U, aiPerCall: 1, failModel: true,
    seed: {}, text: JSON.stringify([{ caption: "Sunny porch, quiet street.", hashtags: ["Home"], tone: "casual" }]), call: (m) => m.generateCaptionVariations({ originalCaption: "Nice home", platform: "instagram_reels" }) },
  { module: "app/actions/ai-content-generation.tsx", label: "getNeighborhoodData", action: "content.neighborhood_profile.generate", risk: "LOW_RISK_WRITE", subject: A, aiPerCall: 1, failModel: true,
    seed: { users: [{ id: U, brokerage_id: B, user_type: "agent", platform_role: null, email: "agent@wave140-canary.test", first_name: "Rae", last_name: "Lane" }] }, text: JSON.stringify({ neighborhood: "East Hill", schools: "unknown", walk_score: null }), call: (m) => m.getNeighborhoodData("Pensacola") },
  { module: "app/api/intelligence/coaching/route.ts", label: "POST /api/intelligence/coaching", action: "coaching.insight.generate", risk: "LOW_RISK_WRITE", subject: U, aiPerCall: 1, failModel: true,
    seed: {}, text: JSON.stringify([{ type: "strength", title: "Fast replies", detail: "Kept up the pace." }]),
    call: (m) => m.POST(req({ agentId: A, agentName: "Rae", insightData: { avgHealthScore: 70, avgSentimentScore: 60, topObjections: [], topBuyingSignals: [], avgResponseTime: 30, teamAvgResponseTime: 40, unansweredCount: 0 } })) },
  { module: "app/api/ai/generate-sequence/route.ts", label: "POST /api/ai/generate-sequence", action: "sequence.steps.generate", risk: "LOW_RISK_WRITE", subject: U, aiPerCall: 1, failModel: true,
    seed: {}, text: JSON.stringify([{ step_name: "Hello", channel: "email", delay_days: 0, delay_hours: 0, send_time: "09:00", subject: "Hi", body: "Hi", personalization_tokens: [] }]), call: (m) => m.POST(req({ prompt: "A gentle buyer nurture" })) },
  { module: "app/api/ai/generate-module-content/route.ts", label: "POST /api/ai/generate-module-content", action: "education.module_content.generate", risk: "LOW_RISK_WRITE", subject: B, aiPerCall: 1, failModel: true,
    seed: {}, text: JSON.stringify({ title: "Offers", description: "d", content: "c", questions: [] }), call: (m) => m.POST(req({ brokerageId: B, topic: "Writing a clean offer" })) },
]
const BLIND: string[] = [
  "SIMULATED: RLS and the live table's CHECKs / NOT NULLs / FKs are not modelled (test:action-ledger §14 scans the action names; a receipt with an empty tenant is refused live and the act runs unrecorded — the helper's documented degrade).",
  "The model doors and the kernel event fan-out are COUNTED seams: the receipt is what is proven, not the model's text or the event's reactions.",
  "The in-memory client models no NOT NULL: the two signal loggers' missing brokerage_id (refused live, every row) was invisible to PART B and is held on the source in PART A instead.",
]

/** activities inserts in a source, and how many do not name brokerage_id (inline object, or a `const <name> = …` records builder). */
function activitiesInsertsMissingTenant(src: string): { inserts: number; missing: number } {
  const code = blankComments(src)
  let inserts = 0, missing = 0
  for (const m of code.matchAll(/\.from\(\s*['"]activities['"]\s*\)\s*\.insert\(\s*(\{|[A-Za-z_$][\w$]*)/g)) {
    inserts++
    if (m[1] === "{") {
      const body = code.slice(m.index!, m.index! + 2500); const end = body.indexOf("})")
      if (!/\bbrokerage_id\s*:/.test(end < 0 ? body : body.slice(0, end))) missing++
    } else {
      const decl = new RegExp(`\\bconst\\s+${m[1]}\\s*=[\\s\\S]{0,2500}?\\}\\)\\)`).exec(code)
      if (!decl || !/\bbrokerage_id\s*:/.test(decl[0])) missing++
    }
  }
  return { inserts, missing }
}

async function driven(): Promise<void> {
  const ledger = (svc: { tables: Record<string, Record<string, unknown>[]> }, action: string) => (svc.tables.agent_action_ledger ?? []).filter((r) => r.action === action)
  const drivenModules = new Set<string>()
  const settle = async (p: () => Promise<unknown>): Promise<unknown> => { try { return await p() } catch (e) { return { thrown: (e as Error).message } } }
  for (const d of DRIVERS) {
    let m: Record<string, any>
    try { m = await import(join(ROOT, d.module)) } catch (e) { check(`${d.label}: module loads`, false, (e as Error).message.slice(0, 200)); continue }
    // (1) two calls by a signed-in user → two receipts, both executed (no key: the second call RAN).
    const svc = canaryClient({ ...baseSeed(), ...d.seed })
    d.patch?.(svc as unknown as Record<string, any>)
    setSvc(svc); setSessionUser(svc, U)
    SEAM.__R19.fail = false; SEAM.__R19.text = d.text ?? "[]"; SEAM.__R19.json = d.json ?? {}
    const ai0 = SEAM.__R19.ai
    const first = await settle(() => d.call(m)); d.between?.(svc.tables); const second = await settle(() => d.call(m))
    const rows = ledger(svc, d.action)
    const shape = rows.every((r) => r.actor_type === "user" && r.actor_user_id === U && r.brokerage_id === B && r.risk_class === d.risk && r.reason_code === "HUMAN_REQUESTED" && !r.idempotency_key && (!d.subject || r.subject_id === d.subject))
    check(`${d.label}: two calls → two receipts '${d.action}' (actor, tenant, subject, ${d.risk}, no key)`, rows.length === 2 && shape,
      `rows=${rows.length} first=${JSON.stringify(first ?? null).slice(0, 220)} second=${JSON.stringify(second ?? null).slice(0, 120)} ${JSON.stringify(rows[0] ?? {}).slice(0, 260)}`)
    check(`${d.label}: both settled executed`, rows.length === 2 && rows.every((r) => r.status === "executed"), rows.map((r) => `${r.status}/${r.error ?? r.outcome ?? ""}`).join(", "))
    if (d.aiPerCall !== undefined) check(`${d.label}: the model seam was reached ${2 * d.aiPerCall} time(s) — counted, never a provider`, SEAM.__R19.ai - ai0 === 2 * d.aiPerCall, `calls=${SEAM.__R19.ai - ai0}`)
    // (2) the act refused → the receipt settles failed (never executed).
    if (d.failCol || d.failModel) {
      const bad = canaryClient({ ...baseSeed(), ...d.seed }, d.failCol ? { missingColumns: d.failCol } : {})
      d.patch?.(bad as unknown as Record<string, any>)
      setSvc(bad); setSessionUser(bad, U)
      SEAM.__R19.fail = !!d.failModel
      await settle(() => d.call(m))
      SEAM.__R19.fail = false
      const failed = ledger(bad, d.action)
      check(`${d.label}: a refused ${d.failModel ? "model call" : "write"} settles failed`, failed.length === 1 && failed[0].status === "failed", failed.map((r) => `${r.status}/${r.outcome}`).join(", ") || "no receipt")
    }
    drivenModules.add(d.module)
  }

  // ── the settings seed: two READS of a fresh brokerage → ONE receipt (the seed happens once); a refused seed settles failed ──
  {
    const m = await import(join(ROOT, "app/actions/settings/get-global-settings.ts"))
    const svc = canaryClient({ ...baseSeed(), global_settings: [] })
    setSvc(svc); setSessionUser(svc, U)
    await settle(() => m.getGlobalSettings()); await settle(() => m.getGlobalSettings())
    const rows = ledger(svc, "tenant.global_settings.seed")
    check("getGlobalSettings ×2 on a fresh brokerage → ONE seed receipt (the second read writes nothing and records nothing)", rows.length === 1 && rows[0].status === "executed" && rows[0].brokerage_id === B && rows[0].actor_user_id === U && (svc.tables.global_settings ?? []).length === 1,
      `rows=${rows.length} settings=${(svc.tables.global_settings ?? []).length} ${JSON.stringify(rows[0] ?? {}).slice(0, 200)}`)
    const bad = canaryClient({ ...baseSeed(), global_settings: [] }, { missingColumns: { global_settings: ["created_by_user_id"] } })
    setSvc(bad); setSessionUser(bad, U)
    await settle(() => m.getGlobalSettings())
    const failed = ledger(bad, "tenant.global_settings.seed")
    check("a refused seed settles failed", failed.length === 1 && failed[0].status === "failed", failed.map((r) => `${r.status}/${r.outcome}`).join(", ") || "no receipt")
    const f = await import(join(ROOT, "app/actions/settings/global-settings-actions.ts"))
    const fresh = canaryClient({ ...baseSeed(), global_settings: [] })
    setSvc(fresh); setSessionUser(fresh, U)
    await settle(() => f.fetchGlobalSettings()); await settle(() => m.getGlobalSettings())
    const viaFetch = ledger(fresh, "tenant.global_settings.seed")
    check("fetchGlobalSettings then getGlobalSettings on a fresh brokerage → ONE seed receipt between them", viaFetch.length === 1 && viaFetch[0].status === "executed", `rows=${viaFetch.length}`)
    drivenModules.add("lib/kernel/global-settings.ts"); drivenModules.add("app/actions/settings/get-global-settings.ts"); drivenModules.add("app/actions/settings/global-settings-actions.ts")
  }

  // ── the gate FIXES, each with its negative ──
  {
    const m = await import(join(ROOT, "app/actions/ai-content-generation.tsx"))
    const svc = canaryClient(baseSeed()); setSvc(svc); setSessionUser(svc, null)
    const ai0 = SEAM.__R19.ai
    const r = await settle(() => m.getNeighborhoodData("Pensacola")) as { success?: boolean }
    check("FIX getNeighborhoodData: a sessionless caller is refused and reaches NO model door (was: a model call for anyone)", r?.success === false && SEAM.__R19.ai === ai0 && (svc.tables.agent_action_ledger ?? []).length === 0, JSON.stringify(r).slice(0, 200))
  }
  {
    const m = await import(join(ROOT, "app/actions/calculators.ts"))
    const svc = canaryClient(baseSeed()); setSvc(svc); setSessionUser(svc, null)
    const ai0 = SEAM.__R19.ai
    const outs = [
      await settle(() => m.compareMortgageScenarios({ loanAmount: 1, scenarios: [] })),
      await settle(() => m.compareNeighborhoods(["32501"], "Pensacola", "FL")),
      await settle(() => m.analyzeInvestmentProperty({ purchasePrice: 1, downPaymentPercent: 20, interestRate: 6, estimatedRent: 1, propertyTaxes: 0, insurance: 0, hoaFees: 0, maintenanceReserve: 0, vacancyRate: 0 })),
      await settle(() => m.calculateSellerNet({ homeValue: 1, mortgageBalance: 0, location: "x", state: "FL", brokerageId: B })),
    ] as Array<{ success?: boolean }>
    check("FIX calculators: a sessionless caller is refused by all four model-backed calculators and reaches NO model door", outs.every((o) => o?.success === false) && SEAM.__R19.ai === ai0, JSON.stringify(outs).slice(0, 240))
    setSessionUser(svc, U)
    const other = await settle(() => m.calculateSellerNet({ homeValue: 400000, mortgageBalance: 0, location: "x", state: "FL", brokerageId: B2 })) as { success?: boolean }
    check("FIX calculateSellerNet: a body brokerageId naming another tenant is refused — no receipt, no model call (was: that tenant's commission structure priced the sheet)", other?.success === false && SEAM.__R19.ai === ai0 && ledger(svc, "calculator.seller_net.run").length === 0, JSON.stringify(other).slice(0, 200))
    // The session's own tenant passes the gate and the receipt opens; this fixture seeds no commission structure, so the act
    // fails (the resolver refuses to price without one) and the receipt says so — failed, never executed.
    await settle(() => m.calculateSellerNet({ homeValue: 400000, mortgageBalance: 100000, location: "Pensacola", state: "FL", brokerageId: B }))
    const own = ledger(svc, "calculator.seller_net.run")
    check("calculateSellerNet: the session's own tenant opens ONE receipt; with no commission structure it settles failed", own.length === 1 && own[0].status === "failed" && own[0].brokerage_id === B, own.map((r) => `${r.status}/${r.error ?? ""}`).join(", ").slice(0, 200))
  }
  {
    const m = await import(join(ROOT, "lib/listings/tier-assigner.ts"))
    const svc = canaryClient({ ...baseSeed(), listing_marketing_tiers: [], tier_budgets: [] }); setSvc(svc); setSessionUser(svc, U)
    const r = await settle(() => m.assignTierToListing(L, B2, U)) as { success?: boolean; error?: string }
    check("FIX assignTierToListing: a claimed brokerage that is not the session's is refused through decideClaimedTenant — no receipt, the listing unchanged", r?.success === false && ledger(svc, "listing.marketing_tier.assign").length === 0 && (svc.tables.listings ?? [])[0]?.marketing_budget === undefined, JSON.stringify(r).slice(0, 200))
  }
  const modules = [...new Set([...Object.keys(WRAPPED), ...Object.keys(DELEGATE)].map((r) => r.split("#")[0]))]
  const staticOnly = modules.filter((f) => !drivenModules.has(f))
  BLIND.push(`Driven: ${drivenModules.size} modules. Proven STATICALLY only (${staticOnly.length}): ${staticOnly.join(", ")}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
