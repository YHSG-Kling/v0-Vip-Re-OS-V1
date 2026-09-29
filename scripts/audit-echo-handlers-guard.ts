#!/usr/bin/env tsx
/**
 * scripts/audit-echo-handlers-guard.ts   (npm run test:audit-echo-handlers)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 89E (wave 89) — census round 34, the event-flow "known gaps": two audit-echo events with a
 * stated downstream intent and NO handler are now dispatched and handled; the guard that listed
 * them was re-anchored (scripts/event-flow-guard.ts) so audit rows and switch-case handlers are
 * told apart from real gaps.
 *
 * Proven on the REAL code (no DB, no network; scripts/in-memory-supabase.ts at the client edge;
 * the model call is injected):
 *   A · onboarding.stalled → reactToOnboardingStalled: ONE bell to the stalled person; a REPEAT stall
 *       also bells the brokerage's admins (TENANT_ADMIN_USER_TYPES, in the tenant, never the person);
 *       no user → refused; a refused insert is RETURNED; the copy says day/percent and one next step.
 *   B · agent.delegated_to_ai → reactToAgentDelegatedToAi: reads the portal row and the contact IN
 *       the tenant, drafts from the card's facts with a compliance-first brief (fair housing in the
 *       WRITING prompt — CLAUDE.md §5), and PROPOSES through proposeClientMessage (status proposed,
 *       audience from contact_type, channel portal) — never a send; a wrong-tenant row, a card with no
 *       contact, an empty draft and a refused proposal are each refused by name.
 *   C · the wiring: EVENT_TYPES carries both; the orchestrator's switch routes both through
 *       dispatchRegistered and EVENT_HANDLERS names both; the tracker cron EMITS (emitEventFromCron)
 *       with the 7-day gate and a MERGED additional_data stamp; the disposition action records the
 *       delegation through recordLifecycleEvent (dispatching) and reads its refusal; the dotloop
 *       webhook's duplicate transaction.documents_complete emit is gone and its tombstone names the
 *       survivor. Each absence rule carries a POSITIVE CONTROL.
 * Run: npx tsx scripts/audit-echo-handlers-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('not used by this proof') }",
  "@/lib/ai/models": "export const generateTextRouted = async () => { throw new Error('the proof injects the draft; no model call') }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const STALLED = "u1000000-0000-4000-8000-000000000001"
const ADMIN1 = "u1000000-0000-4000-8000-000000000002"
const ADMIN2 = "u1000000-0000-4000-8000-000000000003"
const AGENT = "u1000000-0000-4000-8000-000000000004"
const ONB = "o1000000-0000-4000-8000-000000000001"
const CONTACT = "c1000000-0000-4000-8000-000000000001"
const CARD = "p1000000-0000-4000-8000-000000000001"

async function main() {
  console.log("\n[A · onboarding.stalled → the bell]")
  const O = await import("../lib/onboarding/stalled-onboarding-reaction")
  const users = [
    { id: STALLED, brokerage_id: BRK, user_type: "agent" },
    { id: ADMIN1, brokerage_id: BRK, user_type: "broker_owner" },
    { id: ADMIN2, brokerage_id: BRK, user_type: "admin" },
    { id: AGENT, brokerage_id: BRK, user_type: "agent" },
    { id: "u-other", brokerage_id: OTHER, user_type: "admin" },
  ]
  const first = memSupabase({ notifications: [], users })
  const r1 = await O.reactToOnboardingStalled(first, BRK, { onboarding_id: ONB, user_id: STALLED, current_day: 9, completion_pct: 35, repeat: false })
  ok("first stall: ONE bell to the stalled person (medium), entity agent_onboarding",
    r1.success && r1.written === 1 && first.tables.notifications.length === 1 && first.tables.notifications[0].user_id === STALLED
    && first.tables.notifications[0].priority === "medium" && first.tables.notifications[0].entity_type === "agent_onboarding" && first.tables.notifications[0].entity_id === ONB, JSON.stringify(r1))
  ok("…the copy says where they are (day 9, 35%) and ONE next step", /day 9, 35% complete/.test(first.tables.notifications[0].body) && /Onboarding page/.test(first.tables.notifications[0].body))
  const repeat = memSupabase({ notifications: [], users })
  const r2 = await O.reactToOnboardingStalled(repeat, BRK, { onboarding_id: ONB, user_id: STALLED, current_day: 16, completion_pct: 35, repeat: true })
  const recipients = repeat.tables.notifications.map((n) => n.user_id).sort()
  ok("REPEAT stall: the person (high) + the brokerage's admins (TENANT_ADMIN_USER_TYPES, in the tenant, never a producer, never the other tenant's admin)",
    r2.success && r2.written === 3 && JSON.stringify(recipients) === JSON.stringify([STALLED, ADMIN1, ADMIN2].sort())
    && repeat.tables.notifications.find((n) => n.user_id === STALLED)?.priority === "high"
    && repeat.tables.notifications.filter((n) => n.type === "onboarding_stalled_escalation").length === 2, JSON.stringify(r2) + " " + recipients.join(","))
  const noUser = await O.reactToOnboardingStalled(memSupabase({ notifications: [], users }), BRK, { onboarding_id: ONB, user_id: null })
  ok("no user_id → refused by name, nothing written", !noUser.success && /nobody to nudge/.test(noUser.error ?? ""))
  const refused = memSupabase({ notifications: [], users }, { refuse: { notifications: "permission denied for table notifications" } })
  const r3 = await O.reactToOnboardingStalled(refused, BRK, { onboarding_id: ONB, user_id: STALLED })
  ok("a REFUSED insert is returned, never swallowed", !r3.success && /refused/.test(r3.error ?? "") && /permission denied/.test(r3.error ?? ""), JSON.stringify(r3))
  ok("pure copy: repeat asks the broker to help; first does not", /broker will help/.test(O.stalledOnboardingCopy({ currentDay: 3, completionPct: 10, repeat: true }).body) && !/broker will help/.test(O.stalledOnboardingCopy({ currentDay: 3, completionPct: 10, repeat: false }).body))

  console.log("\n[B · agent.delegated_to_ai → the AI ISA drafts, the agent approves]")
  const A = await import("../lib/portal-stream/ai-delegation-reaction")
  const seed = () => ({
    portal_event_stream: [{ id: CARD, brokerage_id: BRK, contact_id: CONTACT, transaction_id: null, event_type: "showing_feedback", agent_copy: "Jane rated 12 Oak St 'love it' after the showing", customer_copy: "Thanks for your feedback on 12 Oak St", agent_action_label: "Reply to Jane about 12 Oak St" }],
    contacts: [{ id: CONTACT, brokerage_id: BRK, first_name: "Jane", last_name: "Doe", contact_type: "buyer" }],
    agent_client_messages: [],
    notifications: [],
  })
  const briefs: Array<{ system: string; prompt: string }> = []
  const draft = async (b: { system: string; prompt: string }) => { briefs.push(b); return "Hi Jane — so glad 12 Oak St felt like a fit. Want me to line up a second look this week?" }
  const svc = memSupabase(seed())
  const d1 = await A.reactToAgentDelegatedToAi(svc, BRK, { portal_event_stream_id: CARD, source_event_type: "showing_feedback", agent_action_label: "Reply to Jane about 12 Oak St" }, { draft })
  const msg = svc.tables.agent_client_messages[0]
  ok("a proposal lands (status proposed, audience buyer, channel portal, recipient the card's contact, agentKind ai_isa) — never sent",
    d1.success && !!d1.messageId && msg?.status === "proposed" && msg?.audience === "buyer" && msg?.channel === "portal" && msg?.recipient_contact_id === CONTACT && msg?.agent_kind === "ai_isa" && msg?.entity_type === "portal_event_stream" && msg?.entity_id === CARD, JSON.stringify(d1) + " " + JSON.stringify(msg))
  ok("the draft is the body; the rationale names the delegation and the gate", msg?.body?.startsWith("Hi Jane") && /delegated/.test(msg?.rationale ?? "") && /approves before/.test(msg?.rationale ?? ""))
  ok("COMPLIANCE-FIRST (§5): fair housing is in the WRITING prompt — protected classes, steering, no numbers, no promises",
    briefs.length === 1 && /FAIR HOUSING/.test(briefs[0].system) && /protected class/.test(briefs[0].system) && /steer/.test(briefs[0].system) && /Never quote a home value/.test(briefs[0].system) && /Never promise/.test(briefs[0].system))
  ok("the brief is grounded on the card's facts (label, agent copy, client copy, client name)",
    briefs.length === 1 && /Reply to Jane about 12 Oak St/.test(briefs[0].prompt) && /love it/.test(briefs[0].prompt) && /Thanks for your feedback/.test(briefs[0].prompt) && /Jane Doe \(buyer\)/.test(briefs[0].prompt))
  ok("audienceForContactType: seller → seller; buyer / both / null → buyer (the CHECK vocabulary agent|buyer|lead|seller)",
    A.audienceForContactType("seller") === "seller" && A.audienceForContactType("buyer") === "buyer" && A.audienceForContactType("both") === "buyer" && A.audienceForContactType(null) === "buyer")
  const wrong = await A.reactToAgentDelegatedToAi(memSupabase(seed()), OTHER, { portal_event_stream_id: CARD }, { draft })
  ok("a card outside the event's tenant is refused by name (nothing drafted, nothing proposed)", !wrong.success && /not in brokerage/.test(wrong.error ?? ""), JSON.stringify(wrong))
  const noContact = memSupabase(seed()); noContact.tables.portal_event_stream[0].contact_id = null
  const nc = await A.reactToAgentDelegatedToAi(noContact, BRK, { portal_event_stream_id: CARD }, { draft })
  ok("a card with no contact is refused (no client to write to)", !nc.success && /no contact/.test(nc.error ?? ""))
  const empty = await A.reactToAgentDelegatedToAi(memSupabase(seed()), BRK, { portal_event_stream_id: CARD }, { draft: async () => "   " })
  ok("an EMPTY draft proposes nothing and says so", !empty.success && /empty draft/.test(empty.error ?? ""))
  const refusedProposal = memSupabase(seed(), { refuse: { agent_client_messages: "permission denied for table agent_client_messages" } })
  const rp = await A.reactToAgentDelegatedToAi(refusedProposal, BRK, { portal_event_stream_id: CARD }, { draft })
  ok("a REFUSED proposal insert is returned, never swallowed", !rp.success && /proposal refused/.test(rp.error ?? "") && /permission denied/.test(rp.error ?? ""), JSON.stringify(rp))
  const modelDown = await A.reactToAgentDelegatedToAi(memSupabase(seed()), BRK, { portal_event_stream_id: CARD })
  ok("a refused model call is returned as 'draft refused' (the real generateTextRouted is stubbed to throw here)", !modelDown.success && /draft refused/.test(modelDown.error ?? ""))

  console.log("\n[C · the wiring — emitted through the dispatching helpers, routed, handled]")
  const types = code("lib/events/types.ts")
  const orch = code("lib/orchestrator/internal.ts")
  ok("EVENT_TYPES carries ONBOARDING_STALLED + AGENT_DELEGATED_TO_AI", /ONBOARDING_STALLED:\s*"onboarding\.stalled"/.test(types) && /AGENT_DELEGATED_TO_AI:\s*"agent\.delegated_to_ai"/.test(types))
  ok("the switch routes both through dispatchRegistered (the case labels the event-dispatch guard reads)",
    /case EVENT_TYPES\.ONBOARDING_STALLED:\s*case EVENT_TYPES\.AGENT_DELEGATED_TO_AI:\s*results\.push\(await dispatchRegistered\(event\)\)/.test(orch))
  ok("EVENT_HANDLERS names both and hands the cores the service client + the event row's tenant",
    /"onboarding\.stalled":\s*async \(e\) => mustSucceed\("stalled-onboarding nudge", reactToOnboardingStalled\(createServiceClient\(\), e\.brokerage_id, e\.payload \?\? \{\}\)\)/.test(orch)
    && /"agent\.delegated_to_ai":\s*async \(e\) => mustSucceed\("AI-delegated reply draft", reactToAgentDelegatedToAi\(createServiceClient\(\), e\.brokerage_id, e\.payload \?\? \{\}\)\)/.test(orch))
  const cron = code("app/api/cron/onboarding-progress-tracker/route.ts")
  ok("the tracker cron EMITS onboarding.stalled through emitEventFromCron (dispatching), never a bare lifecycle_events insert",
    /emitEventFromCron\(\{[\s\S]{0,400}event_type:\s*"onboarding\.stalled"/.test(cron) && !/from\("lifecycle_events"\)\.insert/.test(cron))
  ok("…gated on additional_data.last_nudge_sent_at within 7 days (the header's promise, now read)", /lastNudge && lastNudge >= sevenDaysAgo\) continue/.test(cron))
  ok("…stamps the nudge by MERGING additional_data (the old write replaced the whole jsonb)", /additional_data: \{ \.\.\.extra, last_nudge_sent_at/.test(cron))
  ok("…carries repeat (a second stall) and reads the emit + stamp refusals into errors", /repeat:\s*!!lastNudge/.test(cron) && /onboarding\.stalled not recorded/.test(cron) && /nudge stamp refused/.test(cron))
  ok("POSITIVE CONTROL: the retired audit-echo shape is recognised by the finder", /from\("lifecycle_events"\)\.insert/.test(`svc.from("lifecycle_events").insert({ event_type: "onboarding.stalled" })`))
  const portal = code("app/actions/portal-stream.ts")
  ok("the disposition action records agent.delegated_to_ai through recordLifecycleEvent (dispatching) with the row's tenant and the session actor",
    /recordLifecycleEvent\(svc, row\.brokerage_id, \{[\s\S]{0,200}event_type:\s*"agent\.delegated_to_ai"/.test(portal) && /user_id:\s*user\.id/.test(portal) && !/from\("lifecycle_events"\)\.insert/.test(portal))
  ok("…and a refused record is REPORTED to the agent (the card is already marked completed_ai)", /AI hand-off could not be recorded/.test(portal))
  const dotloop = code("app/api/webhooks/dotloop/route.ts")
  const dotloopRaw = readFileSync(join(ROOT, "app/api/webhooks/dotloop/route.ts"), "utf8")
  ok("the duplicate transaction.documents_complete emit is gone from the dotloop webhook (stripped source)", !/transaction\.documents_complete/.test(dotloop))
  ok("…and its tombstone names the survivor (provider.signatures.complete)", /TOMBSTONE[\s\S]{0,400}transaction\.documents_complete[\s\S]{0,600}provider\.signatures\.complete/.test(dotloopRaw))
  ok("the survivor is still recorded", /event_type:\s*"provider\.signatures\.complete"/.test(dotloop))
  const flow = code("scripts/event-flow-guard.ts")
  ok("the event-flow guard reads STRIPPED source, resolves switch-case handlers, and classifies audit rows apart from dispatched emits",
    /stripComments\(readFileSync/.test(flow) && /switchCaseEvents\(/.test(flow) && /classifyEmitSite\(/.test(flow) && /audit_row/.test(flow))

  console.log("\n[registration]")
  const dom = MAINTENANCE_DOMAINS["audit_echo_handlers"]
  ok("MAINTENANCE_DOMAINS.audit_echo_handlers is owned (data_steward) with recruiting_manager + ai_isa + cron_manager co-owners named in prose",
    dom?.manager === "data_steward" && ["recruiting_manager", "ai_isa", "cron_manager"].every((c) => (dom?.coOwners ?? []).includes(c as never))
    && /recruiting_manager/.test(dom?.what ?? "") && /ai_isa/.test(dom?.what ?? "") && /cron_manager/.test(dom?.what ?? ""))
  ok("its proof is this script's npm target", dom?.proof === "test:audit-echo-handlers")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(fail === 0 ? " ✅ AUDIT_ECHO_HANDLERS_PASS — two audit-only echoes now dispatch and react; the flow guard tells audit rows from gaps" : " ❌ AUDIT_ECHO_HANDLERS_FAIL")
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
