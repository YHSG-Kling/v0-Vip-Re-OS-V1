/**
 * scripts/owner-resolution-guard.ts — `npm run test:owner-resolution` (wave 155, lane 155R7).
 *
 * WHAT IT HOLDS. An owner the arbitration census credits must be a manager the code really resolves AT RUN TIME, for
 * that call, and records — never a name written into a table to move a number (CLAUDE.md §1, directive B4).
 *   A. THE REGISTRY'S PER-CALL RESOLVER (lib/voice/tool-registry.ts voiceToolOwnerForCall) returns a registered manager
 *      for THAT call and fails closed on an invented manager, an unknown form mode and an unlisted tool.
 *   B. THE REAL DISPATCHER (lib/voice/team-commands.ts dispatchTeamCommand, in-memory client, SIMULATED) puts the call's
 *      owner on the result the route stores on the per-call audit row (agent_assistant_tool_calls.tool_output):
 *      a fixed-owner command → its owner; a per-call command → the fact its case resolved; a bench read → none;
 *      a refused per-call command that resolved nothing → none.
 *   C. THE CENSUS (scripts/os-coverage-ledger.ts, run once with a planted fixture): every row this lane repaired names a
 *      manager in MANAGERS (a per-call owner: EVERY candidate in MANAGERS); every tool classified READ has an OWN path that
 *      writes, sends and spends nothing; the rows left open stay open with their link; and the POSITIVE CONTROLS — a planted
 *      log-only write and a planted resolver token in a server action stay unowned (a token is not a resolution).
 *   D. (lane 155R18) G09: the disposition of every log-only row — an owner DERIVED from TABLE_MANAGER (the steward of what the
 *      row's own span reads, or of the stewarded log it writes), a per-call resolver, a held owner question, or a security
 *      lane's file — plus the REFERENCE rule handed to 155R16 (an audited read is owned by the steward of what it read) with
 *      positive and negative specimens. It credits nothing in the census itself (the census rule is 155R16's); the planted
 *      log-only path stays unowned. Not red at 81cdddae by construction: no app/ or lib/ file changed for G09.
 * RED AT ce4200fa: A cannot import voiceToolOwnerForCall; B's results carry no ownerManager; C's repaired rows read
 * `unresolved` (measured: 19 rows partial at the base — see $S/lane155R7-notes.md).
 */
import { census } from "./os-coverage-ledger" // registers the `server-only` / service-client stubs before the imports below run
import { memSupabase } from "./in-memory-supabase"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n═══ ${t} ═══`)

// The rows this lane closed (before: partial at ce4200fa, `owner` missing or a READ tool held at IRREVERSIBLE).
const REPAIRED_OWNED = [
  "assistant_tool:run_skill", "assistant_tool:broker_objective", "assistant_tool:run_team_command",
  "kernel_event:behavioral_pattern_detected", "kernel_event:client_portal_message_sent", "kernel_event:portal_accessed",
  "kernel_event:portal_education_viewed", "kernel_event:portal_module_viewed", "kernel_event:prediction_created",
  "kernel_event:video_generation_requested",
  // WAVE 155 (lane 155S1) — the three links 155R7 left open, now landed: standup_action's case supplies the ACTED item's
  // manager (lib/kernel/standup-action.ts → lib/voice/team-commands.ts `ownerManager:`); fill_form_field's handler calls
  // voiceToolOwnerForCall with the document's mode (app/api/agent-assistant/tool-call/route.ts fillFormField); ask_guidance
  // has its one fixed VOICE_TOOL_MANAGER row (data_steward — the owner TABLE_MANAGER already gives its only writes).
  "assistant_tool:standup_action", "assistant_tool:fill_form_field", "assistant_tool:ask_guidance",
]
const READ_TOOLS = ["team_query", "area_query", "morning_standup", "manager_status", "read_form_status", "next_unfilled_field", "whos_slipping", "explain_touches"]
// Still open, each with its exact missing link (notes): they must NOT read owned until that link lands. Empty since 155S1.
const STILL_OPEN: Record<string, string> = {}

async function main(): Promise<void> {
  const reg = await import("../lib/kernel/manager-registry")
  const toolReg = await import("../lib/voice/tool-registry")
  const MANAGER_KEYS = new Set(Object.keys(reg.MANAGERS))

  section("A — the registry's per-call resolver")
  const own = (t: string, r: { manager?: string | null; formMode?: string | null }) => toolReg.voiceToolOwnerForCall(t, r, reg.MANAGERS)
  check("POSITIVE: run_skill / broker_objective / run_team_command take the manager their handler resolved for THIS call",
    own("run_skill", { manager: "ads_manager" }) === "ads_manager" && own("broker_objective", { manager: "listing_concierge" }) === "listing_concierge" && own("run_team_command", { manager: "deal_coordinator" }) === "deal_coordinator")
  check("POSITIVE: fill_form_field takes the form's packet owner (offer → stage_offer_packet → shopping_agent; listing → stage_listing_packet → listing_concierge)",
    own("fill_form_field", { formMode: "offer" }) === "shopping_agent" && own("fill_form_field", { formMode: "listing" }) === "listing_concierge")
  check("NEGATIVE: an invented manager, an unknown form mode, a missing fact and an unlisted (bench) tool resolve to null — never a guess",
    own("run_skill", { manager: "invented_manager" }) === null && own("fill_form_field", { formMode: "deed" }) === null && own("broker_objective", {}) === null && own("team_query", { manager: "ads_manager" }) === null)
  check("the per-call table and the fixed table stay disjoint (one tool, one answer — CLAUDE.md §6)",
    Object.keys(toolReg.VOICE_TOOL_PER_CALL_OWNER).every((t) => !(t in toolReg.VOICE_TOOL_MANAGER)))
  check("every packet tool a form mode names has a fixed owner in MANAGERS",
    Object.values(toolReg.FORM_MODE_PACKET_TOOL).every((t) => MANAGER_KEYS.has((toolReg.VOICE_TOOL_MANAGER as Record<string, string>)[t])))

  section("B — the real dispatcher records the call's owner (SIMULATED: in-memory client, no provider, no model)")
  const { dispatchTeamCommand } = await import("../lib/voice/team-commands")
  const B = "00000000-0000-4000-8000-0000000000b1", ADMIN = "00000000-0000-4000-8000-0000000000a1", AGENT = "00000000-0000-4000-8000-0000000000a2"
  const svc = () => memSupabase({
    users: [{ id: ADMIN, user_type: "broker", brokerage_id: B }, { id: AGENT, user_type: "agent", brokerage_id: B }],
    tenant_ai_teammates: [], user_role_assignments: [],
  }) as never
  const run = async (name: string, params: Record<string, unknown>, user: string) => {
    try { return await dispatchTeamCommand(name, params, { brokerageId: B, agentUserId: user }, svc()) } catch (e) { return { ok: false, spoken: `THREW: ${e instanceof Error ? e.message : String(e)}`, ownerManager: "threw" as never } }
  }
  const proposals = await run("kernel_proposals", {}, ADMIN)
  check("POSITIVE: a fixed-owner command (kernel_proposals) records its owner on the result", proposals.ownerManager === "deal_coordinator", JSON.stringify(proposals).slice(0, 200))
  const bench = await run("team_query", { query: "Hendersons" }, ADMIN)
  check("NEGATIVE: a bench read (team_query) records NO owner — attributing a bench answer to one manager would be dishonest", "ownerManager" in bench && bench.ownerManager === null, JSON.stringify(bench).slice(0, 200))
  const { MANAGER_SKILLS } = await import("../lib/kernel/skill-registry")
  const { assistantSkillRefusal } = await import("../lib/voice-admin/assistant-reach")
  const skill = MANAGER_SKILLS.find((s) => !assistantSkillRefusal(s))
  const ran = skill ? await run("run_skill", { skill: skill.name }, ADMIN) : null
  check(`POSITIVE: a per-call command (run_skill ${skill?.name ?? "—"}) records the manager its case resolved — the skill's declared manager_owner (${skill?.manager_owner ?? "—"}) — whether the request was accepted or refused downstream`,
    !!skill && !!ran && ran.ownerManager === skill.manager_owner && MANAGER_KEYS.has(String(ran.ownerManager)), JSON.stringify(ran).slice(0, 240))
  const refused = await run("broker_objective", { text: "grow listings ten percent in the north territory" }, AGENT)
  check("NEGATIVE: a per-call command refused before it resolves anything (broker_objective by a non-admin seat) records no owner",
    refused.ok === false && refused.ownerManager === null, JSON.stringify(refused).slice(0, 200))

  section("C — the census credits only real, per-call resolutions (one run, with a planted fixture)")
  const FX = "app/actions/__owner_resolution_fixture__.ts"
  const raw = [
    `"use server"`,
    `import { createServiceClient } from "@/lib/supabase/service"`,
    `export async function plantedLogOnly(id: string) { const svc = createServiceClient(); await svc.from("self_heal_events").insert({ subject: id }); await svc.from("notifications").insert({ title: "x" }) }`,
    `export async function plantedResolverToken(id: string) { const owner = voiceToolOwnerForCall("run_skill", { manager: "ads_manager" }, {}); const svc = createServiceClient(); await svc.from("self_heal_events").insert({ subject: id, detail: { owner } }) }`,
  ].join("\n")
  const c = await census([], [{ file: FX, raw }])
  const byId = new Map(c.rows.map((r) => [r.id, r]))
  const candidatesOf = (m: string) => /\{([^}]*)\}/.exec(m)?.[1].split("|").map((s) => s.trim()).filter(Boolean) ?? []
  const repairedBad = REPAIRED_OWNED.filter((id) => { const r = byId.get(id); return !r || r.missing.includes("owner") || r.registered_manager.startsWith("unresolved") })
  check(`every repaired row is owned (${REPAIRED_OWNED.length - repairedBad.length}/${REPAIRED_OWNED.length})`, repairedBad.length === 0, repairedBad.join(", "))
  const perCall = c.rows.filter((r) => r.registered_manager.startsWith("per-call: toManager"))
  const badCand = perCall.filter((r) => { const k = candidatesOf(r.registered_manager); return !k.length || !k.every((x) => MANAGER_KEYS.has(x)) })
  check(`every per-call reactor owner lists ONLY managers in MANAGERS (${perCall.length} rows)`, perCall.length >= 7 && badCand.length === 0, badCand.map((r) => r.id).join(", "))
  const toolPerCall = c.rows.filter((r) => r.registered_manager.startsWith("per-call: voiceToolOwnerForCall"))
  check(`every per-call tool owner is a tool listed in VOICE_TOOL_PER_CALL_OWNER (${toolPerCall.length} rows)`,
    toolPerCall.length >= 3 && toolPerCall.every((r) => r.id.replace("assistant_tool:", "") in toolReg.VOICE_TOOL_PER_CALL_OWNER))
  const readBad = READ_TOOLS.filter((t) => { const r = byId.get(`assistant_tool:${t}`); return !r || r.path_effects.writes.length || r.path_effects.egress.length || r.path_effects.spend || !r.typed_action.includes(", READ)") })
  check(`every tool classified READ has an OWN path that writes, sends and spends nothing (${READ_TOOLS.length - readBad.length}/${READ_TOOLS.length})`, readBad.length === 0, readBad.join(", "))
  const openBad = Object.keys(STILL_OPEN).filter((id) => { const r = byId.get(id); return !r || !r.missing.includes("owner") })
  check("the tools whose per-call fact is not yet recorded stay OPEN on `owner` (no credit before the link lands)", openBad.length === 0, openBad.map((id) => `${id}: ${STILL_OPEN[id]}`).join(" | "))
  const logOnly = byId.get(`server_action:${FX}#plantedLogOnly`), token = byId.get(`server_action:${FX}#plantedResolverToken`)
  check("POSITIVE CONTROL: a planted log-only write (self_heal_events + notifications) stays unowned", !!logOnly && logOnly.missing.includes("owner"), logOnly?.registered_manager)
  check("POSITIVE CONTROL: a planted resolver TOKEN in a server action is not a resolution — it stays unowned", !!token && token.missing.includes("owner"), token?.registered_manager)
  const fakeOwner = c.rows.filter((r) => { const m = r.registered_manager; return !(m.startsWith("unresolved") || m.startsWith("feed") || m.startsWith("per-call") || MANAGER_KEYS.has(m)) })
  check("no row names a manager outside MANAGERS", fakeOwner.length === 0, fakeOwner.slice(0, 5).map((r) => r.id).join(", "))

  section("D — G09 (lane 155R18): every log-only path has a NAMED owner, and the audited-read rule is the registry's, never a guess")
  // REFERENCE RULE (lane 155R18 → 155R16, the way scripts/event-claims-guard.ts classify() was for 155R6): a path whose only
  // writes are carriers / evidence is owned by the TABLE_MANAGER steward of the tables its OWN span reads — lane 155R7's own-path
  // rule (never the gate / ledger helpers it calls: their reads are WHO acts and WHICH policy version, not the subject). Tables a
  // gate reads to know the actor are excluded; carriers are excluded; a tie resolves nothing. A stewarded log READ is the subject
  // (getExceptionCenter reads self_heal_events → cron_manager). Measured on the live tree: $S/lane155R18-notes.md.
  const TM = reg.TABLE_MANAGER as Record<string, string>
  const CARRIERS = new Set(["manager_signals", "notifications", "kernel_events", "lifecycle_events", "agent_action_ledger"])
  const IDENTITY = new Set(["users", "agents", "brokerages", "user_role_assignments", "teams", "team_members", "platform_staff", "platform_role_capability_overrides", "platform_impersonation_sessions"])
  const LOGLIKE = /(?:ledger|audit|_log$|_logs$|_events$|_receipts?$|invocations?$|_calls$|_history$|_outcomes?$|dead_letters$)/
  const TELEMETRY = new Set(["self_heal_events", "api_response_logs", "audit_log", "superadmin_audit_log", "automation_errors"])
  const ownerOfAuditedRead = (ownReads: string[], pathWrites: string[]): string | null => {
    if (!pathWrites.length || pathWrites.some((t) => !CARRIERS.has(t) && !LOGLIKE.test(t))) return null
    // 1. a STEWARDED log the path writes (the registry's own answer for what it records); generic telemetry confers nothing.
    const logs = new Map<string, number>()
    for (const t of pathWrites) { if (CARRIERS.has(t) || TELEMETRY.has(t)) continue; const m = TM[t]; if (m) logs.set(m, (logs.get(m) ?? 0) + 1) }
    const lb = [...logs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (lb.length) return lb.length === 1 || lb[0][1] > lb[1][1] ? lb[0][0] : null
    // 2. else the steward of what its OWN span reads.
    const n = new Map<string, number>()
    for (const t of ownReads) { if (IDENTITY.has(t) || CARRIERS.has(t)) continue; const m = TM[t]; if (m) n.set(m, (n.get(m) ?? 0) + 1) }
    const best = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    return !best.length || (best.length > 1 && best[0][1] === best[1][1]) ? null : best[0][0]
  }
  check("POSITIVE: a log-only path's owner is the steward of what its own span reads (tour_stops → its steward; subscriptions → its steward; a READ of self_heal_events → its steward)",
    ownerOfAuditedRead(["tour_stops", "users"], ["notifications", "self_heal_events"]) === TM.tour_stops && ownerOfAuditedRead(["subscriptions", "users"], ["superadmin_audit_log"]) === TM.subscriptions
    && ownerOfAuditedRead(["self_heal_events", "brokerages"], ["self_heal_events"]) === TM.self_heal_events && MANAGER_KEYS.has(TM.tour_stops) && MANAGER_KEYS.has(TM.subscriptions))
  check("NEGATIVE: a path that writes a DOMAIN table is not this rule's; identity-only reads, carrier-only reads, a tie and an unstewarded read resolve NOTHING",
    ownerOfAuditedRead(["tour_stops"], ["transactions"]) === null && ownerOfAuditedRead(["users", "agents", "platform_role_capability_overrides"], ["superadmin_audit_log"]) === null
    && ownerOfAuditedRead(["notifications"], ["notifications"]) === null && ownerOfAuditedRead(["tour_stops", "transactions"], ["audit_log"]) === null
    && ownerOfAuditedRead(["__no_such_table__"], ["audit_log"]) === null)
  check("POSITIVE: a STEWARDED log the path writes outranks what it reads (assignment_log written, contacts read → assignment_log's steward); generic telemetry (self_heal_events) written confers NOTHING",
    ownerOfAuditedRead(["contacts"], ["assignment_log", "self_heal_events"]) === TM.assignment_log && TM.assignment_log !== TM.contacts
    && ownerOfAuditedRead(["__no_such_table__"], ["self_heal_events", "api_response_logs"]) === null)

  // THE DISPOSITION of all 70 G09 rows at 81cdddae. owner = a key of MANAGERS, or null with the reason. `via` says how the owner is
  // derived: "read:<table>" (the rule above; the table's steward IS the owner — derived here, never typed twice), "log:<table>" (a
  // STEWARDED log the path writes; the census skips it as evidence), "domain" (the action's subject has no table on its own path —
  // MANAGERS domain text), "per-call", "held:<question>", "lane:<lane>" (a security lane's file).
  type Disp = { via: string; owner?: string }
  const G09: Record<string, Disp> = {
    "http:/api/admin/system/providers/test": { via: "read:platform_credentials" },
    "http:/api/external-portal/actions/complete": { via: "read:transactions" },
    "server_action:app/actions/billing.ts#startSubscriptionCheckout": { via: "read:subscription_tiers" },
    "server_action:app/actions/commission-policy/closing-verification.ts#recordClosingAttestationAction": { via: "log:transaction_compliance_log" },
    "server_action:app/actions/custom-domains.ts#getCustomDomainsPanel": { via: "read:tenant_custom_domains" },
    "server_action:app/actions/dispatch-showing.ts#dispatchStopScheduling": { via: "read:tour_stops" },
    "server_action:app/actions/dotloop-integration.ts#accessSharedDocument": { via: "log:document_access_log" },
    "server_action:app/actions/dotloop-integration.ts#logDocumentAccess": { via: "log:document_access_log" },
    "server_action:app/actions/financial-kernel.ts#exportFinancialReportAction": { via: "read:financial_reports" },
    "server_action:app/actions/onboarding/tech-stack.ts#getIntegrationStatus": { via: "read:integration_credentials" },
    "server_action:app/actions/onboarding/tech-stack.ts#getMaskedCredentials": { via: "read:integration_credentials" },
    "server_action:app/actions/superadmin/ai-ops.ts#runCredentialRefreshAction": { via: "read:integration_credentials" },
    "server_action:app/actions/superadmin/brokerage-management.ts#issueRefundAction": { via: "read:subscriptions" },
    "server_action:app/actions/superadmin/financial-halts.ts#listHaltedFinancialWritersAction": { via: "read:brokerage_settings" },
    "server_action:app/actions/superadmin/go-live-readiness.ts#getGoLiveReadinessAction": { via: "read:platform_credentials" },
    "server_action:app/actions/superadmin/platform-reception.ts#bindPlatformReceptionAction": { via: "read:tenant_phone_numbers" },
    "server_action:app/actions/superadmin/secret-migration.ts#resealLegacyPlaintextSecretsAction": { via: "read:integration_credentials" },
    "server_action:app/actions/superadmin/stripe-webhook-events.ts#registerStripeWebhookEventsAction": { via: "read:platform_credentials" },
    "server_action:app/actions/transactions/cda-coach.ts#explainCdaArithmeticAction": { via: "read:agent_commission_profiles" },
    "server_action:app/actions/ai-content-generation.tsx#logGenerationCost": { via: "lane:155S3" },
    "server_action:app/actions/buyer-lifecycle-core.ts#executeBuyerStateTransition": { via: "lane:155S1" },
    "server_action:app/actions/buyer-offers.ts#startOfferDraft": { via: "domain", owner: "shopping_agent" },
    "server_action:app/actions/compliance/closing-review.ts#getClosingReadinessAction": { via: "read:transaction_documents" },
    "server_action:app/actions/contact-persona.ts#readContactResearchAttributes": { via: "read:contacts" },
    "server_action:app/actions/content-prediction.ts#logActualPerformanceAction": { via: "log:prediction_accuracy_log" },
    "server_action:app/actions/conversation-analytics.ts#logConversationMetadata": { via: "log:conversation_logs" },
    "server_action:app/actions/conversation-analytics.ts#reviewAuditFlag": { via: "log:conversation_audit_flags" },
    "server_action:app/actions/conversation-analytics.ts#runWeeklyAIAudit": { via: "read:conversation_logs" },
    "server_action:app/actions/idx-search.ts#searchProperties": { via: "lane:155S3" },
    "server_action:app/actions/lead-assignment/assign-lead.ts#acknowledgeLeadHandoffAction": { via: "log:assignment_log" },
    "server_action:app/actions/lead-intelligence.ts#deliverIntelligentValue": { via: "log:intelligent_outreach_log" },
    "server_action:app/actions/listing-lifecycle.ts#setMilestonePortalVisibility": { via: "read:listings" },
    "server_action:app/actions/marketing/image-library.ts#searchStockImagesAction": { via: "read:platform_credentials" },
    "server_action:app/actions/newsletter/fetch-local-news.ts#fetchLocalNews": { via: "read:newsletter_local_content" },
    "server_action:app/actions/open-house-kernel.ts#attachOpenHouseSourceAttributionAction": { via: "read:open_house_events" },
    "server_action:app/actions/portal-education.ts#notifyPortalEducationCompleted": { via: "read:contacts" },
    "server_action:app/actions/self-book-showing.ts#getBookableSlotsAction": { via: "read:showings" },
    "server_action:app/actions/superadmin/platform-social.ts#startPlatformSocialConnectAction": { via: "read:platform_social_accounts" },
    "server_action:app/actions/superadmin/tenant-message.ts#draftTenantAdminMessageAction": { via: "read:support_tickets" },
    "server_action:app/actions/admin/create-subscriber.ts#retrySubscriberInvite": { via: "held:platform-staff act — R7 owner decision 1 (does a PLATFORM manager own it? only platform_sentinel is registered)" },
    "server_action:app/actions/admin/manager-evals.ts#completeRegionalConventionReview": { via: "held:platform-staff act — R7 owner decision 1" },
    "server_action:app/actions/admin/manager-evals.ts#overrideDeliberationWinner": { via: "per-call", owner: undefined },
    "server_action:app/actions/ai-agent-capabilities.ts#getCapabilitiesSettings": { via: "read:brokerage_settings" },
    "server_action:app/actions/ai-training-coaching.ts#evaluatePracticeSession": { via: "lane:155S2" },
    "server_action:app/actions/assistant.ts#handleAutomationTriggered": { via: "log:automation_logs" },
    "server_action:app/actions/calculators.ts#saveCalculatorResult": { via: "log:calculator_history" },
    "server_action:app/actions/call-review-actions.ts#shareCallWithCoach": { via: "held:coaching share — no table on its path names the coach's domain; R7 owner decision 2" },
    "server_action:app/actions/communications.ts#notifyBrokerageAgentsAction": { via: "read:teams" },
    "server_action:app/actions/cron-kernel.ts#recordCronProgressAction": { via: "log:cron_execution_logs" },
    "server_action:app/actions/cron-kernel.ts#recordCronStartAction": { via: "log:cron_execution_logs" },
    "server_action:app/actions/exception-center.ts#dismissException": { via: "read:self_heal_events" },
    "server_action:app/actions/exception-center.ts#flagRepairWrong": { via: "read:self_heal_events" },
    "server_action:app/actions/exception-center.ts#getExceptionCenter": { via: "read:self_heal_events" },
    "server_action:app/actions/exception-center.ts#resolveException": { via: "read:self_heal_events" },
    "server_action:app/actions/fair-housing-older-persons.ts#recordOlderPersonsVerificationAction": { via: "domain", owner: "compliance_officer" },
    "server_action:app/actions/notifications.ts#markAllRead": { via: "held:the seat's own record — R7 owner decision 2" },
    "server_action:app/actions/notifications.ts#markNotificationRead": { via: "held:the seat's own record — R7 owner decision 2" },
    "server_action:app/actions/onboarding/onboarding-ops.ts#nudgeOnboardingAgentsAction": { via: "read:agent_onboarding" },
    "server_action:app/actions/onboarding/progress.ts#sendOnboardingReminder": { via: "read:agent_onboarding" },
    "server_action:app/actions/phone-provisioning.ts#getPhoneAllowanceStatusAction": { via: "read:tenant_phone_numbers" },
    "server_action:app/actions/phone-provisioning.ts#getTenantPhoneMeterAction": { via: "read:tenant_phone_numbers" },
    "server_action:app/actions/reporting-kernel.ts#exportReportCsvAction": { via: "read:financial_reports" },
    "server_action:app/actions/superadmin/ai-ops.ts#replaySignalAction": { via: "per-call", owner: undefined },
    "server_action:app/actions/superadmin/platform-announcements.ts#postPlatformAnnouncementAction": { via: "held:platform-staff act — R7 owner decision 1" },
    "server_action:app/actions/superadmin/provider-posture.ts#getFullProviderPostureAction": { via: "read:platform_credentials" },
    "server_action:app/actions/superadmin/provider-posture.ts#getSendgridPostureAction": { via: "read:platform_credentials" },
    "server_action:app/actions/superadmin/provider-posture.ts#getTwilioFleetPostureAction": { via: "read:platform_credentials" },
    "server_action:app/actions/vendor-portfolio.ts#addVendorPortfolioItem": { via: "read:vendor_portfolio_items" },
    "server_action:app/actions/vendor-portfolio.ts#removeVendorPortfolioItem": { via: "read:vendor_portfolio_items" },
    "server_action:app/actions/workflows.ts#logUserActivity": { via: "lane:155S3" },
    // WAVE 155 (lane 155R20) — the 7 log-only rows lane 155R16's census correction newly exposed (compliance_events became GENERIC
    // telemetry for ownership, so the evaluation actions lost their borrowed owner). "retired:<survivor>" = the door no longer exists.
    "server_action:app/actions/content-compliance.ts#evaluateCompliance": { via: "domain", owner: "compliance_officer" },
    "server_action:app/actions/content-compliance.ts#batchEvaluate": { via: "domain", owner: "compliance_officer" },
    "server_action:app/actions/communications.ts#draftTeamAnnouncementAction": { via: "domain", owner: "recruiting_manager" },
    "server_action:app/actions/twin-scenario.ts#simulateTwinScenario": { via: "read:brokerage_twin_snapshots" },
    "server_action:app/actions/notification-actions.ts#markOneRead": { via: "retired:app/actions/notifications.ts:84" },
    "server_action:app/actions/notification-actions.ts#markAllRead": { via: "retired:app/actions/notifications.ts:115" },
    "server_action:lib/kernel/communications.ts#evaluateOutboundEligibility": { via: "retired:server-only (app/actions/inbox.ts resolves the actor from the session)" },
    // …and three FROZEN G09 rows the same census change exposed (not lane 155R20's rows; named so the check below stays a rule):
    "server_action:app/actions/channel-presets.ts#upsertChannelPreset": { via: "per-call", owner: undefined }, // CHANNEL_TABLE[channel]: each preset table has its own steward
    "server_action:app/actions/podcast-generation.ts#generatePodcastScriptDraft": { via: "domain", owner: "campaign_orchestrator" }, // podcast_episodes' steward
    "server_action:app/actions/social/generate-social-post.ts#generateContextualDraft": { via: "domain", owner: "campaign_orchestrator" }, // social_posts' steward
  }
  // A RETIRED door stays retired: it is no longer a census row, and its file no longer exports it as a public endpoint.
  const retired = Object.entries(G09).filter(([, d]) => d.via.startsWith("retired:"))
  const stillRows = retired.filter(([id]) => byId.has(id)).map(([id]) => id)
  check(`every G09 door this wave RETIRED is no longer a census row (${retired.length - stillRows.length}/${retired.length})`, stillRows.length === 0, stillRows.join(", "))
  const exportsAsDoor = (src: string, fn: string) => { const s = stripComments(src); return /^\s*["']use server["']\s*;?\s*$/m.test(s) && new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`).test(blankStrings(s)) }
  const retiredStillDoors = retired.filter(([id]) => { const m = /^server_action:(.+)#(\w+)$/.exec(id); if (!m) return false; try { return exportsAsDoor(readFileSync(join(process.cwd(), m[1]), "utf8"), m[2]) } catch { return false } }).map(([id]) => id)
  check("…and no retired door's file still publishes it as a \"use server\" export", retiredStillDoors.length === 0, retiredStillDoors.join(", "))
  check("POSITIVE CONTROL: a \"use server\" file that still exports the name IS caught", exportsAsDoor(`"use server"\nexport async function markAllRead() {}\n`, "markAllRead") && !exportsAsDoor(`import "server-only"\nexport async function markAllRead() {}\n`, "markAllRead") && !exportsAsDoor(`// "use server" was here\nexport {}\n`, "markAllRead"))
  const ownerOf = (d: Disp): string | null => d.owner ?? (/^(read|log):/.test(d.via) ? TM[d.via.split(":")[1]] ?? null : null)
  const named = Object.entries(G09).filter(([, d]) => /^(read|log|domain)/.test(d.via) || (d.via === "per-call" && d.owner))
  const badOwner = named.filter(([, d]) => !ownerOf(d) || !MANAGER_KEYS.has(ownerOf(d)!)).map(([id, d]) => `${id} (${d.via})`)
  check(`every G09 owner this lane names is a registered manager DERIVED from TABLE_MANAGER (or MANAGERS' domain) — ${named.length - badOwner.length}/${named.length}`, badOwner.length === 0, badOwner.join(", "))
  const g09Now = c.rows.filter((r) => r.root_cause_group === "G09-log-only-owner").map((r) => r.id)
  const unclassified = g09Now.filter((id) => !(id in G09) && !id.startsWith(`server_action:${FX}`))
  check(`every row the census groups as G09 today has a disposition (${g09Now.length} rows; a NEW log-only path must be classified)`, unclassified.length === 0, unclassified.join(", "))
  const logWrites = Object.entries(G09).filter(([id, d]) => d.via.startsWith("log:") && byId.has(id)).filter(([id, d]) => !byId.get(id)!.path_effects.writes.includes(d.via.slice(4)))
  check("every \"log:<table>\" owner names a table the row's path REALLY writes (the census's own write list)", logWrites.length === 0, logWrites.map(([id]) => id).join(", "))
  // RESTATED TO THE RULE (wave 155, lane 155R20; CLAUDE.md §2): the derivation applies only while the path is LOG-ONLY (the rule's
  // own precondition). A row whose census path now writes a DOMAIN table (explainCdaArithmeticAction → compliance_flags, seen once
  // lane 155R16 followed barrels) is owned by that write's steward and has left this rule — it is printed, not compared.
  const logOnlyPath = (r: { path_effects: { writes: string[] } }) => r.path_effects.writes.every((t) => CARRIERS.has(t) || LOGLIKE.test(t))
  const leftRule = Object.keys(G09).filter((id) => byId.has(id) && !logOnlyPath(byId.get(id)!))
  if (leftRule.length) console.log(`  · left the audited-read rule (now writes a domain table; owned by that write): ${leftRule.join(", ")}`)
  const disagree = Object.entries(G09).filter(([id, d]) => { const r = byId.get(id); const o = ownerOf(d); return !!r && logOnlyPath(r) && !!o && !r.registered_manager.startsWith("unresolved") && r.registered_manager !== o })
  check("the census never credits a LOG-ONLY G09 row to a DIFFERENT manager than the one derived here (unresolved, or exactly this owner)", disagree.length === 0, disagree.map(([id]) => `${id}: census ${byId.get(id)!.registered_manager}`).join(" | "))
  check("CONTROL: the log-only precondition is the rule's (a carrier/log-only path is in it; a domain write is not)", logOnlyPath({ path_effects: { writes: ["notifications", "audit_log"] } }) && !logOnlyPath({ path_effects: { writes: ["compliance_flags", "agent_action_ledger"] } }))
  check("POSITIVE CONTROL: a planted log-only path still has NO census owner (the derivation is named here, not credited behind the census's back)", !!logOnly && logOnly.missing.includes("owner"))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
  console.log("✅ OWNER_RESOLUTION_PASS — every credited owner is a registered manager resolved for that call and recorded; a log write or a resolver token alone owns nothing")
}
main().catch((e) => { console.error(e); process.exit(1) })
