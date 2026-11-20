#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-customer2-guard.ts   (npm run test:ledger-receipts-customer2)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 155, REPAIR LANE 155R14 — group G12 list "customer2" (the long tail of customer-facing and marketing modules):
 * a signed-in user's write must leave ONE receipt on agent_action_ledger through the ONE session helper,
 * lib/kernel/action-ledger.ts ledgerSessionAction (lane 155B3's contract — this file never re-implements it).
 *
 * PART A — STATIC (comment-stripped source, CLAUDE.md §2): every WRAPPED row export reaches `ledgerSessionAction(` in its own
 *   top-level span, names its three-segment action, and passes NO `cycle` / `idempotencyKey` (none of these acts is
 *   once-only: a second save must run). Positive controls: a specimen with no call, and one with a `cycle`, are caught.
 *   The rows this lane left OPEN are printed with their reason (never counted as a pass).
 * PART B — DRIVEN (in-memory, SIMULATED; scripts/canaries/_harness.ts stubs the service + session clients): per driven
 *   module, the real export is called TWICE by a signed-in user → exactly TWO receipts, each naming actor (users.id),
 *   tenant, action, subject and risk class, both settled `executed` (the no-key regression canary: the second call RAN);
 *   then once more with the domain write refused (a missing column, 42703) → that receipt settles `failed`.
 *   Red at e88c1baa: none of these exports wrote a receipt.
 * BLIND SPOTS (printed): RLS is not modelled; modules whose gate needs a fixture the harness cannot build (embedded joins,
 *   the vendor portal actor, a paid provider, a model call) are proven STATICALLY only — they are listed by name.
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

// ── the rows (scope: $S/b2/g12/customer2-rows.json) ─────────────────────────────────────────────────
// WRAPPED: row → the action its receipt names.
const WRAPPED: Record<string, string> = {
  "app/actions/listing-lifecycle.ts#completeListingTask": "listing.task.complete",
  "app/actions/listing-lifecycle.ts#handlePriceReduction": "listing.price_reduction_task.create",
  "app/actions/listings-kernel.ts#generateListingDescriptionAction": "listing.description.draft",
  "app/actions/listings-kernel.ts#saveListingDraftAction": "listing.draft.save",
  "app/actions/privacy/data-subject-requests.ts#fulfillDeleteRequestAction": "privacy.data_subject_request.fulfill_delete",
  "app/actions/seller-cma.ts#resolvePriceTrendAlert": "listing.price_trend_alert.resolve",
  "app/actions/seller-cma.ts#saveNetSheet": "listing.net_sheet.save",
  "app/actions/seller-coaching.ts#dismissCoachingCard": "listing.coaching_card.dismiss",
  "app/actions/seller-open-house.ts#inviteFarmContacts": "open_house.invitation.stage",
  "app/actions/seller-open-house.ts#updateRsvp": "open_house.rsvp.update",
  "app/actions/seller-showings.ts#denyShowingRequest": "showing.request.deny",
  "app/actions/seller-showings.ts#suggestAlternativeTime": "showing.request.suggest_alternative",
  "app/actions/tour-planner.ts#stampTourStopPresence": "tour.stop.stamp_presence",
  "app/actions/tour-planner.ts#updateTourStopOrder": "tour.stop.reorder",
  "app/actions/vendor-messages.ts#markVendorMessagesRead": "vendor.message.mark_read",
  "app/actions/vendor-messages.ts#sendVendorMessage": "vendor.message.send",
  "app/actions/vendor-portal.ts#updateVendorJobCost": "vendor.job.update_cost",
  "app/actions/vendor-portal.ts#updateVendorJobStatus": "vendor.job.update_status",
  "app/actions/contact-quick-actions.ts#verifyContactAddressAction": "contact.mailing_address.verify",
  "app/actions/contacts.ts#addContactNote": "contact.note.add",
  "app/actions/contacts/last-promise.ts#setLastPromiseAction": "contact.last_promise.set",
  "app/actions/contacts/segment-membership.ts#removeContactFromSegmentAction": "contact.segment_membership.remove",
  "app/actions/contacts/update-addressing.ts#updateContactAddressingAction": "contact.addressing.update",
  "app/actions/inbox-quick-draft.ts#quickDraftForConversation": "inbox.reply_draft.generate",
  "app/actions/inbox.ts#markInboxRead": "inbox.thread.mark_read",
  "app/actions/instant-property-alerts.ts#ensureSmsFirstChannels": "property_alert.channels.sms_first",
  "app/actions/listing-appointment-copilot.ts#markListingApptPrepReady": "listing.appointment_prep.mark_ready",
  "app/actions/listing-health-actions.ts#resolveListingInterventionAction": "listing.health_intervention.resolve",
  "app/actions/portal-invites.ts#createPortalInviteForContact": "portal.invite.create",
  "app/actions/portal-nl-search.ts#portalNaturalSearchAction": "portal.property_search.run",
  "app/actions/portal-settings.ts#uploadProfilePhoto": "portal.profile_photo.upload",
  "app/api/contacts/[contactId]/voice-note/route.ts#POST": "contact.voice_note.capture",
  "app/api/recruiting/advance-stage/route.ts#POST": "recruiting.recruit.advance_stage",
  "app/api/workflow/buyer-intake/create/route.ts#POST": "buyer.intake_link.create",
  "app/dashboard/showings/prep/actions.ts#regenerateShowingBriefing": "showing.briefing.regenerate",
  "app/dashboard/stale/actions.ts#markContactTouched": "contact.touch.mark",
  "app/actions/stock-library.ts#deleteStockAsset": "marketing.stock_asset.delete",
  "app/actions/stock-library.ts#registerStockAsset": "marketing.stock_asset.register",
  "app/actions/stock-video-upload.ts#deleteStockClip": "marketing.stock_clip.delete",
  "app/actions/stock-video-upload.ts#uploadStockClip": "marketing.stock_clip.upload",
  "app/actions/video-landing.ts#publishRenderToWeb": "marketing.video_landing.publish",
  "app/actions/video-landing.ts#unpublishRenderFromWeb": "marketing.video_landing.unpublish",
  "app/actions/video.ts#updateVideoGenerationSettingsAction": "marketing.video_project.update_settings",
  "app/actions/video/memory-video.ts#renderMemoryVideoAction": "marketing.memory_video.render",
  "app/actions/video/memory-video.ts#saveMemoryVideoDictationAction": "marketing.memory_video.save_dictation",
  "app/actions/contact-vendor-booking.ts#rateVendorBookingAsClient": "vendor.booking.rate",
  "app/actions/direct-mail-presets.ts#deactivatePreset": "marketing.direct_mail_preset.deactivate",
  "app/actions/onboarding/training.ts#markVideoStarted": "training.video.start",
  "app/actions/seed-default-sequences.ts#seedDefaultSequences": "marketing.sequence_catalog.seed",
  "app/actions/video-generation.ts#saveVideoTemplate": "marketing.video_template.save",
  "app/actions/video-repurposing.ts#deleteSnippet": "marketing.video_snippet.delete",
  "app/api/agent/update-video-profile/route.ts#POST": "marketing.video_profile.update",
  "app/api/portal/client-action/route.ts#POST": "portal.client_action.dispatch",
  "app/api/video-scripts/route.ts#DELETE": "marketing.video_script.deactivate",
}
// OPEN: row → why no receipt was added (each is in the lane notes with file:line).
const OPEN: Record<string, string> = {
  "app/actions/privacy/data-subject-requests.ts#submitDataSubjectRequestAction": "anonymous public DSAR intake — no session actor; tenant from the form or an email match",
  "app/actions/seller-coaching.ts#getListingCoaching": "a read; its only write is a shared cache fill inside lib/seller-coaching (re-classify)",
  "app/actions/ai-client-portal.ts#markResourceCompleted": "FINDING: ungated export, tenant from the body",
  "app/actions/buyer-coaching.ts#getBuyerCoaching": "a read with an AI cache fill (spend already on ai_tool_usage) — re-classify",
  "app/actions/buyer-insights.ts#getBuyerInsights": "a pure read — writer attributed through an imported constant (whole-file fallback)",
  "app/actions/cma-presentation/cma-generator.ts#generateCMA": "FINDING: ungated export, identity + tenant from arguments",
  "app/actions/contact-details.ts#getContactCopilotSuggestions": "a read with a suggestion cache fill — re-classify",
  "app/actions/seller-equity.ts#setSellerMortgageBalance": "FINDING: ungated export (RLS only), no sibling gate to copy",
  "app/dashboard/marketing/video-staging/actions.ts#stageVideoAction": "SKIPPED: an approval action (155J's approval screens / actions)",
  "app/actions/superadmin/platform-brand.ts#addTopicAction": "platform staff, platform-level table — no tenant to record against",
  "app/actions/superadmin/platform-brand.ts#dismissTopicAction": "platform staff, platform-level table — no tenant to record against",
  "app/actions/video.ts#distributeVideoProjectAction": "SKIPPED: a social distribution door (155J)",
  "app/dashboard/marketing/review/actions.ts#cancelSocialPost": "SKIPPED: the marketing review (approval) screen (155J)",
  "app/dashboard/marketing/review/actions.ts#dismissDraft": "SKIPPED: the marketing review (approval) screen (155J)",
  "app/actions/content-final-versions.ts#getDistributionFinalsAction": "a pure read — whole-file writer attribution",
  "app/actions/marketing/publish-guide-to-gbp.ts#publishGuideToGbpAction": "SKIPPED: a publish door (155J)",
  "app/actions/movement-signals.ts#listMovementSignalsAction": "a pure read — whole-file writer attribution",
  "app/actions/revenue-protection.ts#getBrokerageRevenueProtection": "a pure read — whole-file writer attribution",
  "app/actions/social/generate-social-post.ts#generateWeeklyContentPlan": "FINDING: ungated export, tenant + agent from arguments",
  "app/actions/superadmin/platform-sentinel.ts#listSentinelActionsAction": "a pure read (platform) — whole-file writer attribution",
  "app/actions/superadmin/platform-social.ts#listPlatformSocialAccountsAction": "platform-level lazy seed — no tenant to record against",
  "app/actions/vendor-contact-access.ts#listVendorAssignmentsForBrokerageAction": "a pure read — whole-file writer attribution",
  "app/actions/video/distribute-video.ts#distributeVideo": "SKIPPED: a social distribution door (155J)",
  "app/actions/youtube-backfill.ts#queueApprovedVideosToYouTubeAction": "SKIPPED: a YouTube publish door (155J)",
  "app/api/did/agents/session/heartbeat/route.ts#POST": "a periodic metering ping — the meter row is the evidence (re-classify)",
  "app/api/onboarding/training/progress/route.ts#POST": "a 5-second playback ping; FINDING: never checks isAuthenticated",
  "app/dashboard/admin/content-studio/actions.ts#approveContentItemAction": "SKIPPED: an approval action (155J)",
  "app/dashboard/marketing/content-intel/topic-actions.ts#publishCommunityVideoAction": "SKIPPED: a content-intel screen (155H)",
}

const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/** The export's top-level span in a comment-blanked text (positions preserved): from its declaration to the next top-level export. */
function spanOf(text: string, name: string): string | null {
  const m = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/\nexport\s/)
  return text.slice(m.index, m.index + m[0].length + (next < 0 ? rest.length : next))
}
/** Judge one export: reaches the helper (code token, strings blanked), names its action (a literal), passes no key. */
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

async function main(): Promise<void> {
  console.log("\nPART A — static (stripped source)")
  // Positive controls: the finder recognises the defects it was written for, and a tombstone is not a call site.
  check("control: a span with no helper call is caught", judge(`export async function f() {\n  // ledgerSessionAction("x.y.z")\n  return 1\n}\n`, "f", "x.y.z").includes("does not reach ledgerSessionAction("))
  check("control: a span passing a cycle is caught", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z", cycle: "c" }, run)\n}\n`, "f", "x.y.z").some((s) => s.startsWith("passes cycle")))
  check("control: a clean span passes", judge(`export async function f() {\n  return ledgerSessionAction({ action: "x.y.z" }, run)\n}\n`, "f", "x.y.z").length === 0)
  // The list is 82 rows (os-arbitration-gap-groups.json G12 list "customer2"); none may be on both sides.
  const covered = Object.keys(WRAPPED).length + Object.keys(OPEN).length
  check(`every row is WRAPPED or OPEN with a reason (${Object.keys(WRAPPED).length} + ${Object.keys(OPEN).length} = ${covered} of 82)`, covered === 82)
  check("no row is both WRAPPED and OPEN", Object.keys(WRAPPED).every((r) => !(r in OPEN)))
  for (const [row, action] of Object.entries(WRAPPED)) {
    const [file, name] = row.split("#")
    check(`${action} names three lowercase segments`, NAME_RE.test(action))
    const problems = judge(readFileSync(join(ROOT, file), "utf8"), name, action)
    check(`${file}#${name} → ledgerSessionAction("${action}"), no key`, problems.length === 0, problems.join("; "))
  }
  for (const [row, why] of Object.entries(OPEN)) console.log(`  ◌ OPEN ${row} — ${why}`)

  console.log("\nPART B — driven (in-memory, SIMULATED)")
  await driven()

  console.log("\nBLIND SPOTS")
  for (const b of BLIND) console.log(`  · ${b}`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); console.log("❌ LEDGER_RECEIPTS_CUSTOMER2_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_CUSTOMER2_PASS — every wrapped row reaches the one session helper with no key; the driven exports write one receipt per call and settle a refused write as failed")
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — the seams are installed before any action module is imported.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
stubModule("next/headers", "export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }); export const headers = async () => new Headers()")

const B = "b1550000-0000-4000-8000-0000000000e1"
const U = "a1550000-0000-4000-8000-0000000000e1"
const A = "a2550000-0000-4000-8000-0000000000e1"
const C = "c1550000-0000-4000-8000-0000000000e1"
const L = "11550000-0000-4000-8000-0000000000e1"
const X = "e1550000-0000-4000-8000-0000000000e1" // the subject row each driver acts on
function baseSeed(): Record<string, Record<string, unknown>[]> {
  return {
    brokerages: [{ id: B, name: "R14 Realty", plan_tier: "brokerage" }],
    users: [{ id: U, brokerage_id: B, user_type: "broker_owner", email: "owner@wave140-canary.test", first_name: "Rae", last_name: "Lane" }],
    agents: [{ id: A, user_id: U, brokerage_id: B }],
    contacts: [{ id: C, brokerage_id: B, agent_id: A, email: "client@wave140-canary.test", first_name: "Cleo", last_name: "Client" }],
    listings: [{ id: L, brokerage_id: B, agent_id: A, address: "1 Receipt Row" }],
    agent_action_ledger: [],
  }
}
interface Driver {
  module: string; label: string; action: string; risk: string; subject: string
  seed: Record<string, Record<string, unknown>[]>
  call: (m: Record<string, any>) => Promise<unknown>
  /** The domain write refused for the failed-settle case: a column the write names, made absent (42703). */
  failCol: Record<string, string[]>
  /** An export that is idempotent BY STATE (an already-resolved row returns before writing) gets its row reset between the two
   *  calls — the canary is that the SECOND ACT runs and is recorded (no ledger key), not that a finished row is re-finished. */
  between?: (tables: Record<string, Record<string, unknown>[]>) => void
}
const DRIVERS: Driver[] = [
  { module: "app/actions/seller-cma.ts", label: "resolvePriceTrendAlert", action: "listing.price_trend_alert.resolve", risk: "LOW_RISK_WRITE", subject: X,
    seed: { price_trend_alerts: [{ id: X, brokerage_id: B, is_resolved: false }] }, call: (m) => m.resolvePriceTrendAlert(X), failCol: { price_trend_alerts: ["is_resolved"] } },
  { module: "app/actions/seller-coaching.ts", label: "dismissCoachingCard", action: "listing.coaching_card.dismiss", risk: "LOW_RISK_WRITE", subject: L,
    seed: { activities: [] }, call: (m) => m.dismissCoachingCard(L), failCol: { activities: ["activity_type"] } },
  { module: "app/actions/listing-health-actions.ts", label: "resolveListingInterventionAction", action: "listing.health_intervention.resolve", risk: "LOW_RISK_WRITE", subject: X,
    seed: { listing_health_interventions: [{ id: X, listing_id: L, brokerage_id: B, resolved: false }] }, call: (m) => m.resolveListingInterventionAction({ interventionId: X }), failCol: { listing_health_interventions: ["resolved_by"] },
    between: (t) => { for (const r of t.listing_health_interventions ?? []) r.resolved = false } },
  { module: "app/actions/listing-appointment-copilot.ts", label: "markListingApptPrepReady", action: "listing.appointment_prep.mark_ready", risk: "LOW_RISK_WRITE", subject: X,
    seed: { workflow_runs: [{ id: X, brokerage_id: B, chain_key: "listing-appt-prep", status: "running", agent_user_id: U, contact_id: C }] }, call: (m) => m.markListingApptPrepReady({ runId: X }), failCol: { workflow_runs: ["completed_at"] },
    between: (t) => { for (const r of t.workflow_runs ?? []) r.status = "running" } },
  { module: "app/dashboard/stale/actions.ts", label: "markContactTouched", action: "contact.touch.mark", risk: "LOW_RISK_WRITE", subject: C,
    seed: {}, call: (m) => m.markContactTouched(C), failCol: { contacts: ["last_contacted_at"] } },
  { module: "app/actions/stock-video-upload.ts", label: "uploadStockClip", action: "marketing.stock_clip.upload", risk: "LOW_RISK_WRITE", subject: "",
    seed: { video_assets: [] }, call: (m) => m.uploadStockClip({ category: "b_roll", fileUrl: "https://example.test/clip.mp4", title: "Clip", scope: "brokerage" }), failCol: { video_assets: ["category"] } },
  { module: "app/api/video-scripts/route.ts", label: "DELETE /api/video-scripts", action: "marketing.video_script.deactivate", risk: "LOW_RISK_WRITE", subject: X,
    seed: { video_scripts_library: [{ id: X, brokerage_id: B, is_active: true }] }, call: (m) => m.DELETE(new Request(`https://app.test/api/video-scripts?id=${X}`, { method: "DELETE" })), failCol: { video_scripts_library: ["is_active"] } },
  { module: "app/actions/tour-planner.ts", label: "updateTourStopOrder", action: "tour.stop.reorder", risk: "LOW_RISK_WRITE", subject: X,
    seed: { tours: [{ id: X, brokerage_id: B }], tour_stops: [{ id: "f1550000-0000-4000-8000-0000000000e1", tour_id: X, brokerage_id: B, order_index: 0 }] }, call: (m) => m.updateTourStopOrder(X, ["f1550000-0000-4000-8000-0000000000e1"]), failCol: { tour_stops: ["order_index"] } },
  { module: "app/actions/inbox.ts", label: "markInboxRead", action: "inbox.thread.mark_read", risk: "LOW_RISK_WRITE", subject: C,
    seed: { client_portal_messages: [{ id: X, contact_id: C, brokerage_id: B, read: false }], messages: [] }, call: (m) => m.markInboxRead({ contactId: C }), failCol: { client_portal_messages: ["read_at"] } },
  { module: "app/actions/contacts/last-promise.ts", label: "setLastPromiseAction", action: "contact.last_promise.set", risk: "LOW_RISK_WRITE", subject: C,
    seed: {}, call: (m) => m.setLastPromiseAction({ contactId: C, promise: "Call back Tuesday" }), failCol: { contacts: ["last_promise"] } },
]
const BLIND: string[] = [
  "RLS is not modelled: the tenant predicates the code writes are what scope the in-memory reads.",
  "The live table's CHECKs (action pattern, reason_code list, FKs) are not modelled here — Part A checks the action names; test:action-ledger §14 scans them too.",
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
    try { await d.call(m); d.between?.(svc.tables); await d.call(m) } catch (e) { check(`${d.label}: runs`, false, (e as Error).message.slice(0, 200)); continue }
    const rows = ledger(svc, d.action)
    const shape = rows.every((r) => r.actor_type === "user" && r.actor_user_id === U && r.brokerage_id === B && r.risk_class === d.risk && r.reason_code === "HUMAN_REQUESTED" && !r.idempotency_key && (!d.subject || r.subject_id === d.subject))
    check(`${d.label}: two calls → two receipts '${d.action}' (actor, tenant, subject, ${d.risk}, no key)`, rows.length === 2 && shape,
      `rows=${rows.length} ${JSON.stringify(rows[0] ?? {}).slice(0, 220)}`)
    check(`${d.label}: both settled executed`, rows.length === 2 && rows.every((r) => r.status === "executed"), rows.map((r) => `${r.status}/${r.error ?? ""}`).join(", "))
    // (2) the domain write refused → the receipt settles failed (never executed).
    const bad = canaryClient({ ...baseSeed(), ...d.seed }, { missingColumns: d.failCol })
    setSvc(bad); setSessionUser(bad, U)
    try { await d.call(m) } catch { /* a throwing export is settled by the helper and rethrown — the row is what is judged */ }
    const failed = ledger(bad, d.action)
    check(`${d.label}: a refused write settles failed`, failed.length === 1 && failed[0].status === "failed", failed.map((r) => `${r.status}/${r.outcome}`).join(", ") || "no receipt")
    drivenModules.add(d.module)
  }
  const staticOnly = [...new Set(Object.keys(WRAPPED).map((r) => r.split("#")[0]))].filter((f) => !drivenModules.has(f))
  BLIND.push(`Driven: ${drivenModules.size} modules. Proven STATICALLY only (${staticOnly.length}): ${staticOnly.join(", ")}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
