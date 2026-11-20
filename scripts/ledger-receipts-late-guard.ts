#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-late-guard.ts   (npm run test:ledger-receipts-late)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 155, LANE 155R15 — group G12 "receipts, part 1": every open G12 P0 row, plus the G12 P1 rows of the modules held back
 * for feature lanes (marketing studio, listing tiers, direct mail, newsletters, content-intel sources, vendor marketplace,
 * ads, campaign registry, QR asset links, vendor tracking, generation logger). A signed-in user's write leaves ONE receipt
 * on agent_action_ledger through the ONE session helper, lib/kernel/action-ledger.ts ledgerSessionAction (never re-implemented).
 *
 * PART A — STATIC (comment-stripped source, CLAUDE.md §2):
 *   · every WRAPPED row reaches `ledgerSessionAction(` inside its own top-level span, names its three-segment action, and
 *     passes NO `cycle` / `idempotencyKey` (none of these acts is once-only: a second save must run);
 *   · every CLOSED-DOOR row (an internal writer that was a public "use server" endpoint taking actor / tenant from the
 *     request) lives in a module that no longer carries a "use server" directive;
 *   · every READ-ONLY row (the census credits it with a write that is not on its path — listed for lane 155R16) carries
 *     NO receipt: a receipt added to move a number is a failure here.
 *   Positive controls: a span with no helper call, a span with a `cycle`, a module that still says "use server", and a
 *   read-only span that gained a receipt are each caught.
 * PART B — DRIVEN (in-memory, SIMULATED; scripts/canaries/_harness.ts stubs the service + session clients, no network):
 *   per driven module the real export is called TWICE by a signed-in user → exactly TWO receipts naming actor (users.id),
 *   tenant, action, subject and risk class, both settled `executed` (the no-key canary: the second call RAN); then once with
 *   the domain write refused (a missing column, 42703) → that receipt settles `failed`. Feature-gated modules run the REAL
 *   gate (mayUseAndAfford: an active subscription row + the feature_flags row it reads) — nothing in the decision is stubbed.
 *   Plus the gate FIXES of this lane, each with its negative: another tenant's direct-mail campaign is not deleted, another
 *   tenant's tax category is not changed, a body brokerageId naming another tenant is refused.
 *   Red at 81cdddae: none of these exports wrote a receipt and both closed doors were "use server" modules.
 * BLIND SPOTS (printed): RLS is not modelled; the live table's CHECKs are not modelled (test:action-ledger §14 scans the names);
 *   the carrier doors (number search / portability) are proven STATICALLY only — their creds path can reach the carrier SDK,
 *   which this guard never calls.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import { stubModule, setSvc, canaryClient, setSessionUser } from "./canaries/_harness"

const ROOT = process.cwd()
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── the rows (scope: $S/155R15-rows.json — 72 rows: 24 P0 + 48 P1) ─────────────────────────────────
const WRAPPED: Record<string, string> = {
  // P0
  "app/api/admin/billing/entitlements/[brokerageId]/route.ts#POST": "billing.feature_override.apply",
  "app/api/admin/billing/subscriptions/[brokerageId]/route.ts#POST": "billing.subscription.update_state",
  "app/actions/accounting-sync.ts#updateTaxCategory": "finance.tax_category.update",
  "app/actions/accounting-sync.ts#createTaxCategory": "finance.tax_category.create",
  "app/actions/accounting-sync.ts#clearResolvedErrors": "finance.sync_error.clear",
  "app/actions/portal-lifetime.ts#submitPropertyFeedback": "portal.property_feedback.submit",
  "lib/ads/ad-creator.ts#updateCampaignStatus": "marketing.ad_campaign.update_status",
  "lib/ads/facebook-audience-sync.ts#createAudience": "marketing.ad_audience.create",
  "lib/ads/facebook-audience-sync.ts#deleteAudience": "marketing.ad_audience.delete",
  "app/actions/phone-port-in.ts#checkPortabilityAction": "telephony.number.check_portability",
  "app/actions/phone-provisioning.ts#searchBrokerageNumbersAction": "telephony.number_inventory.search",
  "app/actions/superadmin/number-provisioning.ts#searchNumbersForTenant": "telephony.number_inventory.search",
  // P1
  "app/actions/marketing-studio.ts#updateCampaign": "marketing.campaign.update",
  "app/actions/marketing-studio.ts#rejectAsset": "marketing.asset.reject",
  "app/actions/marketing-studio.ts#createCalendarEvent": "marketing.calendar_event.create",
  "app/actions/marketing-studio.ts#updateCalendarEventStatus": "marketing.calendar_event.update_status",
  "app/actions/marketing-studio.ts#addCampaignComment": "marketing.campaign_comment.add",
  "app/actions/marketing-studio.ts#createCampaignTask": "marketing.campaign_task.create",
  "app/actions/marketing-studio.ts#updateTaskStatus": "marketing.campaign_task.update_status",
  "app/actions/marketing-studio.ts#generateCampaignContent": "marketing.campaign_content.generate",
  "lib/listings/tier-assigner.ts#createTier": "listing.marketing_tier.create",
  "lib/listings/tier-assigner.ts#updateTier": "listing.marketing_tier.update",
  "lib/listings/tier-assigner.ts#createTierBudget": "listing.tier_budget.create",
  "lib/listings/tier-assigner.ts#createTierDistribution": "listing.tier_distribution.create",
  "lib/listings/tier-assigner.ts#deleteTierBudget": "listing.tier_budget.delete",
  "lib/listings/tier-assigner.ts#deleteTierDistribution": "listing.tier_distribution.delete",
  "app/actions/direct-mail.ts#updateMailCampaign": "marketing.direct_mail_campaign.update",
  "app/actions/direct-mail.ts#deleteMailCampaign": "marketing.direct_mail_campaign.delete",
  "app/actions/direct-mail.ts#addRecipients": "marketing.direct_mail_recipient.add",
  "app/actions/direct-mail.ts#removeRecipient": "marketing.direct_mail_recipient.remove",
  "app/actions/ai-newsletter.ts#manageSubscribers": "marketing.newsletter_subscriber.manage",
  "app/actions/ai-newsletter.ts#manageSubscriberBatch": "marketing.newsletter_subscriber.manage_batch",
  "app/actions/ai-newsletter.ts#deleteNewsletterCampaign": "marketing.newsletter_campaign.delete",
  "app/actions/content-intel/sources.ts#createContentSource": "marketing.content_source.create",
  "app/actions/content-intel/sources.ts#toggleContentSource": "marketing.content_source.toggle",
  "app/actions/content-intel/sources.ts#deleteContentSource": "marketing.content_source.delete",
  "app/actions/newsletter/approve-template.ts#submitTemplateForApproval": "marketing.newsletter_template.submit_for_approval",
  "app/actions/newsletter/approve-template.ts#approveTemplate": "marketing.newsletter_template.approve",
  "app/actions/newsletter/approve-template.ts#rejectTemplate": "marketing.newsletter_template.reject",
  "app/actions/newsletter/create-template.ts#createTemplate": "marketing.newsletter_template.create",
  "app/actions/newsletter/delete-template.ts#deleteTemplate": "marketing.newsletter_template.delete",
  "app/actions/newsletter/update-template.ts#updateTemplate": "marketing.newsletter_template.update",
  "app/actions/newsletter/fetch-local-news.ts#recordNewsletterLocalContent": "marketing.newsletter_local_content.record",
  "app/actions/newsletter/fetch-local-news.ts#setupLocalNewsSource": "marketing.local_news_source.setup",
  "app/actions/newsletter/get-seo-score.ts#getSEOScore": "marketing.newsletter_seo_score.record",
  "app/actions/newsletter/schedule-newsletter.ts#scheduleNewsletter": "marketing.newsletter.schedule",
  "app/actions/newsletter/schedule-newsletter.ts#scheduleExistingNewsletter": "marketing.newsletter.reschedule",
  "app/actions/vendor-marketplace.ts#createVendorBooking": "vendor.booking.create",
  "app/actions/vendor-marketplace.ts#respondToVendorReview": "vendor.review.respond",
  "app/actions/vendor-marketplace.ts#flagVendorReview": "vendor.review.flag",
  "lib/ads/ad-monitor.ts#ingestCompetitorAd": "marketing.competitor_ad.ingest",
  "lib/ads/ad-monitor.ts#ingestCompetitorPost": "marketing.competitor_post.ingest",
  "lib/ads/ad-monitor.ts#resolveAlert": "marketing.trend_alert.resolve",
  "lib/marketing/campaign-registry.ts#registerCampaignSource": "marketing.campaign_source.register",
  "lib/marketing/campaign-registry.ts#unregisterCampaignSource": "marketing.campaign_source.unregister",
  "lib/marketing/qr-asset-linker.ts#linkQrToAsset": "marketing.qr_asset_link.create",
  "lib/marketing/qr-asset-linker.ts#unlinkQrFromAsset": "marketing.qr_asset_link.remove",
}
/** Internal writers that were PUBLIC endpoints (actor / tenant from the request): the door is closed, not receipted. */
const CLOSED_DOOR: Record<string, string> = {
  "lib/vendor-tracking.ts#trackVendorUsage": "a meter writer; only caller app/actions/scrape-social-media.ts (server)",
  "lib/content-generation/generation-logger.ts#logContentGeneration": "activity-log writer; callers: app/actions/content-generation-engine.ts (server)",
  "lib/content-generation/generation-logger.ts#logBatchContentGeneration": "activity-log writer; same callers",
  "lib/content-generation/generation-logger.ts#logOmnipresentGeneration": "activity-log writer; same callers",
}
/** Reads the census credits with a write OFF their path (the statement it credits → lane notes "Read-only rows"). */
const READ_ONLY: Record<string, string> = {
  "app/actions/buyer-financial.ts#getBrokerageLenders": "lib/kernel/lender-linkage.ts:225 (whole-file fallback)",
  "app/actions/portal-buyer-financial.ts#getBrokerageLendersFromPortalAction": "lib/kernel/lender-linkage.ts:225 (via getBrokerageLenders)",
  "app/actions/buyer-offer/outside-offer-loop.ts#listOutsideOffers": "lib/offers/outside-offer-loop.ts:477 / :507",
  "app/actions/commission-policy/agreements.ts#proposeAgreementTermsAction": "lib/commission/cap-resolver.ts:616 / :1097",
  "app/actions/connections/connection-center.ts#getConnectionCenter": "lib/connections/accounting-scopes.ts:319",
  "app/actions/dotloop-integration.ts#getDocumentAccessLog": "lib/video/script-compliance.ts:1050",
  "app/actions/listing-lifecycle-core.ts#validateListingTransition": "lib/listings/listing-agreement-terms.ts:279 / :307",
  "app/actions/superadmin/subscription-contracts.ts#listSubscriptionContractTemplatesAction": "lib/legal/subscription-agreement.ts:373 / :452",
  "app/actions/transactions/tax-proration.ts#getTaxProrationAction": "lib/transactions/tax-proration.ts:117 (persistTaxProration)",
  "app/actions/twin-studio.ts#listTwinVoiceOptions": "lib/video/multilingual-reel.ts:496",
}
const SKIPPED: Record<string, string> = {
  "app/actions/push-listing-to-seller-portal.ts#pushListingToSellerPortal": "on lane 155S2's FILES line",
}
const ROW_COUNT = 72

const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/** The export's top-level span in a comment-blanked text (positions preserved): from its declaration to the next top-level export. */
function spanOf(text: string, name: string): string | null {
  const m = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/\nexport\s/)
  return text.slice(m.index, m.index + m[0].length + (next < 0 ? rest.length : next))
}
function judge(src: string, name: string, action: string): string[] {
  const noComments = blankComments(src)
  const code = blankStrings(noComments)
  const codeSpan = spanOf(code, name), litSpan = spanOf(noComments, name)
  if (!codeSpan || !litSpan) return [`export ${name} not found`]
  const out: string[] = []
  if (!/\bledgerSessionAction\s*\(/.test(codeSpan)) out.push("does not reach ledgerSessionAction(")
  if (!litSpan.includes(`"${action}"`) && !litSpan.includes(`'${action}'`)) out.push(`does not name ${action}`)
  if (/\b(?:cycle|idempotencyKey)\s*:/.test(codeSpan)) out.push("passes cycle / idempotencyKey (a second save would be a silent no-op)")
  return out
}
/** A "use server" DIRECTIVE: the first statement of the comment-blanked module. */
function hasUseServer(src: string): boolean {
  return /^\s*(["'])use server\1/.test(blankComments(src))
}
function readOnlyHasReceipt(src: string, name: string): boolean | null {
  const span = spanOf(blankStrings(blankComments(src)), name)
  return span === null ? null : /\bledgerSessionAction\s*\(/.test(span)
}

async function main(): Promise<void> {
  console.log("\nPART A — static (stripped source)")
  check("control: a span with no helper call is caught (a tombstone naming it is not a call)", judge(`export async function f() {\n  // ledgerSessionAction("x.y.z")\n  return 1\n}\n`, "f", "x.y.z").includes("does not reach ledgerSessionAction("))
  check("control: a span passing a cycle is caught", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z", cycle: "c" }, run)\n}\n`, "f", "x.y.z").some((s) => s.startsWith("passes cycle")))
  check("control: a clean span passes", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z" }, run)\n}\n`, "f", "x.y.z").length === 0)
  check("control: a module that still says \"use server\" is caught (and a comment saying it is not)", hasUseServer(`'use server'\nexport async function f() {}\n`) && !hasUseServer(`// "use server" was here\nexport async function f() {}\n`))
  check("control: a read-only span that gained a receipt is caught", readOnlyHasReceipt(`export async function r() {\n  return ledgerSessionAction({ action: "a.b.c" }, run)\n}\n`, "r") === true)

  const all = [WRAPPED, CLOSED_DOOR, READ_ONLY, SKIPPED].map((o) => Object.keys(o))
  const covered = all.reduce((n, k) => n + k.length, 0)
  check(`every row is WRAPPED / CLOSED_DOOR / READ_ONLY / SKIPPED (${all.map((k) => k.length).join(" + ")} = ${covered} of ${ROW_COUNT})`, covered === ROW_COUNT)
  check("no row is on two lists", new Set(all.flat()).size === covered)

  for (const [row, action] of Object.entries(WRAPPED)) {
    const [file, name] = row.split("#")
    check(`${action} names three lowercase segments`, NAME_RE.test(action))
    const problems = judge(readFileSync(join(ROOT, file), "utf8"), name, action)
    check(`${file}#${name} → ledgerSessionAction("${action}"), no key`, problems.length === 0, problems.join("; "))
  }
  for (const [row, why] of Object.entries(CLOSED_DOOR)) {
    const [file, name] = row.split("#")
    const src = readFileSync(join(ROOT, file), "utf8")
    check(`${row} — the module is no longer a "use server" endpoint (${why})`, !hasUseServer(src) && spanOf(blankComments(src), name) !== null)
  }
  for (const [row, where] of Object.entries(READ_ONLY)) {
    const [file, name] = row.split("#")
    const r = readOnlyHasReceipt(readFileSync(join(ROOT, file), "utf8"), name)
    check(`${row} — read-only, carries NO receipt (census credits ${where})`, r === false, r === null ? "export not found" : "a receipt was added to a read")
  }
  for (const [row, why] of Object.entries(SKIPPED)) console.log(`  ◌ SKIPPED ${row} — ${why}`)

  console.log("\nPART B — driven (in-memory, SIMULATED)")
  await driven()

  console.log("\nBLIND SPOTS")
  for (const b of BLIND) console.log(`  · ${b}`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); console.log("❌ LEDGER_RECEIPTS_LATE_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_LATE_PASS — every wrapped row reaches the one session helper with no key; the driven exports write one receipt per call and settle a refused write as failed; the closed doors are closed and the reads carry no receipt")
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — the seams are installed before any action module is imported.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
stubModule("next/headers", "export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }); export const headers = async () => new Headers()")

const B = "b1550000-0000-4000-8000-0000000000f5"
const B2 = "b2550000-0000-4000-8000-0000000000f5" // another tenant, for the negatives
const U = "a1550000-0000-4000-8000-0000000000f5"
const A = "a2550000-0000-4000-8000-0000000000f5"
const C = "c1550000-0000-4000-8000-0000000000f5"
const L = "11550000-0000-4000-8000-0000000000f5"
const X = "e1550000-0000-4000-8000-0000000000f5" // the subject row each driver acts on
const Y = "e2550000-0000-4000-8000-0000000000f5" // a second row (another tenant's, or a child)
const FEATURES = ["marketing_studio", "listing_marketing_tiers", "ads_audiences", "competitor_monitor"]
function baseSeed(): Record<string, Record<string, unknown>[]> {
  return {
    brokerages: [{ id: B, name: "R15 Realty", plan_tier: "brokerage" }, { id: B2, name: "Other Realty", plan_tier: "brokerage" }],
    users: [{ id: U, brokerage_id: B, user_type: "broker_owner", platform_role: null, email: "owner@wave140-canary.test", first_name: "Rae", last_name: "Lane" }],
    agents: [{ id: A, user_id: U, brokerage_id: B }],
    contacts: [{ id: C, brokerage_id: B, agent_id: A, email: "client@wave140-canary.test", first_name: "Cleo", last_name: "Client" }],
    listings: [{ id: L, brokerage_id: B, agent_id: A, address: "1 Receipt Row" }],
    // THE REAL FEATURE GATE (mayUseAndAfford): a current subscription, then the plan-feature row it reads.
    subscriptions: [{ id: "sub-r15", brokerage_id: B, status: "active", trial_end: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
    feature_flags: FEATURES.map((k) => ({ feature_key: k, enabled: true, superadmin_only: false, solo_agent_access: true, team_access: true, brokerage_access: true, multi_location_access: true,
      solo_agent_limit: null, team_limit: null, brokerage_limit: null, multi_location_limit: null, beta: false, deprecated: false, sunset_date: null, rollout_percentage: null })),
    feature_access_overrides: [], feature_usage_tracking: [], usage_counters: [],
    agent_action_ledger: [],
  }
}
interface Driver {
  module: string; label: string; action: string; risk: string; subject: string
  seed: Record<string, Record<string, unknown>[]>
  call: (m: Record<string, any>) => Promise<unknown>
  /** The domain write refused for the failed-settle case: a column the write names or FILTERS on, made absent (42703) — a delete names
   *  no column of its own, so its `id` filter is the one refused. */
  failCol: Record<string, string[]>
  /** A row an export consumes (a delete, an idempotent-by-state act) is restored between the two calls — the canary is that
   *  the SECOND ACT runs and is recorded (no ledger key), not that a finished row is re-finished. */
  between?: (tables: Record<string, Record<string, unknown>[]>) => void
}
const tplRow = (extra: Record<string, unknown> = {}) => ({ id: X, brokerage_id: B, template_name: "Monthly", approval_status: "draft", version_number: 1, brand_colors: null, logo_url: null, ...extra })
const DRIVERS: Driver[] = [
  { module: "app/actions/marketing-studio.ts", label: "updateTaskStatus", action: "marketing.campaign_task.update_status", risk: "LOW_RISK_WRITE", subject: X,
    seed: { marketing_campaign_tasks: [{ id: X, brokerage_id: B, campaign_id: Y, status: "pending" }] }, call: (m) => m.updateTaskStatus(X, "completed"), failCol: { marketing_campaign_tasks: ["status"] } },
  { module: "lib/listings/tier-assigner.ts", label: "createTier", action: "listing.marketing_tier.create", risk: "LOW_RISK_WRITE", subject: "",
    seed: { listing_marketing_tiers: [] }, call: (m) => m.createTier({ brokerageId: B, actorUserId: U, tierName: "Luxury" }), failCol: { listing_marketing_tiers: ["tier_name"] } },
  { module: "app/actions/direct-mail.ts", label: "updateMailCampaign", action: "marketing.direct_mail_campaign.update", risk: "LOW_RISK_WRITE", subject: X,
    seed: { direct_mail_campaigns: [{ id: X, brokerage_id: B, status: "planning", approval_status: "pending", campaign_name: "Farm" }] }, call: (m) => m.updateMailCampaign(X, { campaignName: "Farm 2" }), failCol: { direct_mail_campaigns: ["campaign_name"] } },
  { module: "app/actions/ai-newsletter.ts", label: "manageSubscribers(unsubscribe)", action: "marketing.newsletter_subscriber.manage", risk: "LOW_RISK_WRITE", subject: "",
    seed: { users: [{ id: U, brokerage_id: B, user_type: "agent", platform_role: null, email: "agent@wave140-canary.test" }], newsletter_subscribers: [{ id: X, brokerage_id: B, agent_id: A, email: "reader@wave140-canary.test", status: "subscribed" }] }, call: (m) => m.manageSubscribers({ action: "unsubscribe", email: "reader@wave140-canary.test" }), failCol: { newsletter_subscribers: ["unsubscribed_at"] } },
  { module: "app/actions/content-intel/sources.ts", label: "toggleContentSource", action: "marketing.content_source.toggle", risk: "LOW_RISK_WRITE", subject: X,
    seed: { content_topic_sources: [{ id: X, brokerage_id: B, source_type: "rss", is_active: true }] }, call: (m) => m.toggleContentSource(X, false), failCol: { content_topic_sources: ["is_active"] } },
  { module: "app/actions/newsletter/approve-template.ts", label: "submitTemplateForApproval", action: "marketing.newsletter_template.submit_for_approval", risk: "LOW_RISK_WRITE", subject: X,
    seed: { newsletter_brokers_templates: [tplRow()] }, call: (m) => m.submitTemplateForApproval(X), failCol: { newsletter_brokers_templates: ["approval_status"] } },
  { module: "app/actions/newsletter/update-template.ts", label: "updateTemplate", action: "marketing.newsletter_template.update", risk: "LOW_RISK_WRITE", subject: X,
    seed: { newsletter_brokers_templates: [tplRow()] }, call: (m) => m.updateTemplate({ templateId: X, templateName: "Monthly 2" }), failCol: { newsletter_brokers_templates: ["template_tags"] } },
  { module: "app/actions/newsletter/delete-template.ts", label: "deleteTemplate", action: "marketing.newsletter_template.delete", risk: "IRREVERSIBLE", subject: X,
    seed: { newsletter_brokers_templates: [tplRow()] }, call: (m) => m.deleteTemplate(X), failCol: { newsletter_brokers_templates: ["id"] },
    between: (t) => { t.newsletter_brokers_templates = [tplRow()] } },
  { module: "app/actions/newsletter/create-template.ts", label: "createTemplate", action: "marketing.newsletter_template.create", risk: "LOW_RISK_WRITE", subject: "",
    seed: { newsletter_brokers_templates: [] }, call: (m) => m.createTemplate({ templateName: "Quarterly", sections: [] }), failCol: { newsletter_brokers_templates: ["template_tags"] },
    between: (t) => { t.newsletter_brokers_templates = [] } },
  { module: "app/actions/newsletter/fetch-local-news.ts", label: "setupLocalNewsSource", action: "marketing.local_news_source.setup", risk: "LOW_RISK_WRITE", subject: "",
    seed: { local_news_sources: [] }, call: (m) => m.setupLocalNewsSource(["32561"], "Gulf Breeze"), failCol: { local_news_sources: ["market_zip_codes"] } },
  { module: "app/actions/newsletter/get-seo-score.ts", label: "getSEOScore", action: "marketing.newsletter_seo_score.record", risk: "LOW_RISK_WRITE", subject: X,
    seed: { newsletter_scheduled_sends: [{ id: X, brokerage_id: B }], newsletter_seo_scores: [] }, call: (m) => m.getSEOScore({ scheduledSendId: X, subjectLine: "Market update", previewText: "", htmlContent: "<h1>Market update</h1><p>Prices held steady.</p>", primaryKeyword: "market" }), failCol: { newsletter_seo_scores: ["overall_seo_score"] } },
  { module: "app/actions/newsletter/schedule-newsletter.ts", label: "scheduleExistingNewsletter", action: "marketing.newsletter.reschedule", risk: "COMMUNICATION", subject: X,
    seed: { newsletter_campaigns: [{ id: X, brokerage_id: B, agent_id: A, status: "draft", approval_status: "approved", campaign_name: "Nov", subject_line: "Nov" }], newsletter_scheduled_sends: [] },
    call: (m) => m.scheduleExistingNewsletter({ newsletterId: X, scheduledSendTime: new Date(Date.now() + 3 * 86_400_000).toISOString() }), failCol: { newsletter_campaigns: ["send_date"] },
    between: (t) => { for (const r of t.newsletter_campaigns ?? []) r.status = "draft" } },
  { module: "app/actions/vendor-marketplace.ts", label: "createVendorBooking", action: "vendor.booking.create", risk: "FINANCIAL", subject: Y,
    seed: { vendors: [{ id: Y, brokerage_id: B, name: "Inspect Co", category: "inspector", status: "active" }], transactions: [{ id: L, brokerage_id: B }], vendor_bookings: [], transaction_timeline: [] },
    call: (m) => m.createVendorBooking({ vendorId: Y, listingId: L, serviceType: "inspection", scheduledDate: "2027-01-15" }), failCol: { vendor_bookings: ["service_type"] } },
  { module: "lib/ads/ad-monitor.ts", label: "resolveAlert", action: "marketing.trend_alert.resolve", risk: "LOW_RISK_WRITE", subject: X,
    seed: { trend_alerts: [{ id: X, brokerage_id: B, is_resolved: false }] }, call: (m) => m.resolveAlert(X), failCol: { trend_alerts: ["resolved_at"] } },
  { module: "lib/marketing/campaign-registry.ts", label: "unregisterCampaignSource", action: "marketing.campaign_source.unregister", risk: "LOW_RISK_WRITE", subject: X,
    seed: { marketing_assets: [{ id: X, brokerage_id: B, source_table: "social_posts", source_id: Y }] }, call: (m) => m.unregisterCampaignSource(X), failCol: { marketing_assets: ["id"] },
    between: (t) => { t.marketing_assets = [{ id: X, brokerage_id: B, source_table: "social_posts", source_id: Y }] } },
  { module: "lib/marketing/qr-asset-linker.ts", label: "unlinkQrFromAsset", action: "marketing.qr_asset_link.remove", risk: "LOW_RISK_WRITE", subject: X,
    seed: { marketing_asset_qr_links: [{ id: X, brokerage_id: B, marketing_asset_id: Y, qr_code_id: L, placement_type: "flyer" }] }, call: (m) => m.unlinkQrFromAsset(X), failCol: { marketing_asset_qr_links: ["id"] },
    between: (t) => { t.marketing_asset_qr_links = [{ id: X, brokerage_id: B, marketing_asset_id: Y, qr_code_id: L, placement_type: "flyer" }] } },
  { module: "app/actions/accounting-sync.ts", label: "updateTaxCategory", action: "finance.tax_category.update", risk: "FINANCIAL", subject: X,
    seed: { tax_categories: [{ id: X, brokerage_id: B, category_name: "Commission", tax_code: "T0", is_active: true }] }, call: (m) => m.updateTaxCategory({ categoryId: X, brokerageId: B, taxCode: "T1" }), failCol: { tax_categories: ["tax_code"] } },
  { module: "app/actions/portal-lifetime.ts", label: "submitPropertyFeedback", action: "portal.property_feedback.submit", risk: "LOW_RISK_WRITE", subject: C,
    seed: { property_feedback: [] }, call: (m) => m.submitPropertyFeedback({ contactId: C, propertyId: L, vote: "love" }), failCol: { property_feedback: ["feedback_type"] } },
  { module: "lib/ads/ad-creator.ts", label: "updateCampaignStatus", action: "marketing.ad_campaign.update_status", risk: "FINANCIAL", subject: X,
    seed: { ad_campaigns: [{ id: X, brokerage_id: B, status: "pending_review" }] }, call: (m) => m.updateCampaignStatus(U, X, B, "approved"), failCol: { ad_campaigns: ["status"] } },
  { module: "lib/ads/facebook-audience-sync.ts", label: "deleteAudience", action: "marketing.ad_audience.delete", risk: "LOW_RISK_WRITE", subject: X,
    seed: { facebook_custom_audiences: [{ id: X, brokerage_id: B, status: "draft", ad_campaign_id: null }], ad_campaigns: [] }, call: (m) => m.deleteAudience(U, X, B), failCol: { facebook_custom_audiences: ["updated_at"] },
    between: (t) => { for (const r of t.facebook_custom_audiences ?? []) r.status = "draft" } },
]
const BLIND: string[] = [
  "RLS is not modelled: the tenant predicates the code writes are what scope the in-memory reads.",
  "The live table's CHECKs (action pattern, reason_code list, FKs) are not modelled here — Part A checks the action names; test:action-ledger §14 scans them too.",
  "The carrier doors (checkPortabilityAction, searchBrokerageNumbersAction, searchNumbersForTenant) are proven STATICALLY only: their creds path can provision a carrier subaccount through the provider SDK, which no guard may call.",
  "The two admin billing routes (platform-staff, tenant = the URL's brokerage after requireSuperadminAuth) are proven STATICALLY only.",
]

async function driven(): Promise<void> {
  const ledger = (svc: { tables: Record<string, Record<string, unknown>[]> }, action: string) => (svc.tables.agent_action_ledger ?? []).filter((r) => r.action === action)
  const drivenModules = new Set<string>()
  for (const d of DRIVERS) {
    let m: Record<string, any>
    try { m = await import(join(ROOT, d.module)) } catch (e) { check(`${d.label}: module loads`, false, (e as Error).message.slice(0, 200)); continue }
    // (1) two calls by a signed-in user → two receipts, both executed (no key: the second call RAN).
    const svc = canaryClient({ ...baseSeed(), ...d.seed })
    setSvc(svc); setSessionUser(svc, U)
    let first: unknown
    try { first = await d.call(m); d.between?.(svc.tables); await d.call(m) } catch (e) { check(`${d.label}: runs`, false, (e as Error).message.slice(0, 200)); continue }
    const rows = ledger(svc, d.action)
    const shape = rows.every((r) => r.actor_type === "user" && r.actor_user_id === U && r.brokerage_id === B && r.risk_class === d.risk && r.reason_code === "HUMAN_REQUESTED" && !r.idempotency_key && (!d.subject || r.subject_id === d.subject))
    check(`${d.label}: two calls → two receipts '${d.action}' (actor, tenant, subject, ${d.risk}, no key)`, rows.length === 2 && shape,
      `rows=${rows.length} first=${JSON.stringify(first ?? null).slice(0, 160)} ${JSON.stringify(rows[0] ?? {}).slice(0, 200)}`)
    check(`${d.label}: both settled executed`, rows.length === 2 && rows.every((r) => r.status === "executed"), rows.map((r) => `${r.status}/${r.error ?? ""}`).join(", "))
    // (2) the domain write refused → the receipt settles failed (never executed).
    const bad = canaryClient({ ...baseSeed(), ...d.seed }, { missingColumns: d.failCol })
    setSvc(bad); setSessionUser(bad, U)
    try { await d.call(m) } catch { /* a throwing export is settled by the helper and rethrown — the row is what is judged */ }
    const failed = ledger(bad, d.action)
    check(`${d.label}: a refused write settles failed`, failed.length === 1 && failed[0].status === "failed", failed.map((r) => `${r.status}/${r.outcome}`).join(", ") || "no receipt")
    drivenModules.add(d.module)
  }

  // ── the gate FIXES, each with its negative (another tenant's row / a body tenant that is not the session's) ──
  {
    const m = await import(join(ROOT, "app/actions/direct-mail.ts"))
    const svc = canaryClient({ ...baseSeed(), direct_mail_campaigns: [{ id: Y, brokerage_id: B2, status: "planning" }], direct_mail_recipients: [] })
    setSvc(svc); setSessionUser(svc, U)
    const r = await m.deleteMailCampaign(Y)
    check("FIX deleteMailCampaign: another tenant's campaign is NOT deleted and the caller is told", r?.success === false && (svc.tables.direct_mail_campaigns ?? []).some((x) => x.id === Y), JSON.stringify(r))
    setSessionUser(svc, null)
    const anon = await m.removeRecipient(Y)
    check("FIX removeRecipient: no session → refused before any write", anon?.success === false && (svc.tables.agent_action_ledger ?? []).every((x) => x.action !== "marketing.direct_mail_recipient.remove"), JSON.stringify(anon))
  }
  {
    const m = await import(join(ROOT, "app/actions/accounting-sync.ts"))
    const svc = canaryClient({ ...baseSeed(), tax_categories: [{ id: Y, brokerage_id: B2, category_name: "Other", tax_code: "Z", is_active: true }] })
    setSvc(svc); setSessionUser(svc, U)
    let refused = false
    try { await m.updateTaxCategory({ categoryId: Y, brokerageId: B2, taxCode: "HACK" }) } catch { refused = true }
    check("FIX updateTaxCategory: a body brokerageId naming another tenant is refused; that tenant's row is unchanged", refused && (svc.tables.tax_categories ?? []).find((x) => x.id === Y)?.tax_code === "Z")
  }
  {
    const m = await import(join(ROOT, "lib/listings/tier-assigner.ts"))
    const svc = canaryClient({ ...baseSeed(), tier_budgets: [] })
    setSvc(svc); setSessionUser(svc, U)
    const r = await m.createTierBudget({ tierId: X, brokerageId: B2, actorUserId: U, channelType: "social", defaultBudget: 100 })
    check("FIX createTierBudget: a body brokerageId naming another tenant is refused; nothing is written", r?.success === false && (svc.tables.tier_budgets ?? []).length === 0, JSON.stringify(r))
  }
  const staticOnly = [...new Set(Object.keys(WRAPPED).map((r) => r.split("#")[0]))].filter((f) => !drivenModules.has(f))
  BLIND.push(`Driven: ${drivenModules.size} modules. Proven STATICALLY only (${staticOnly.length}): ${staticOnly.join(", ")}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
