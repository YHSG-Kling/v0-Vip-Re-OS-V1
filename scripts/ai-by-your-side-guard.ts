#!/usr/bin/env tsx
/**
 * scripts/ai-by-your-side-guard.ts   (npm run test:ai-by-your-side) — wave 142, lane 142G
 * ─────────────────────────────────────────────────────────────────────────────
 * AI BY YOUR SIDE (owner: "ai needs to be the main function of this app assisting both tenants and their customers
 * and platform staff … support tickets, ai chat/live avatar call/chat, education and new education pieces created
 * if subject keeps coming up").
 *
 *  A. AUDIENCES (stripped source) — every audience's assistant surface reaches a REAL backend that exists and runs a
 *     ROUTED model lane (a literal feature that is an AI_TASK_ROUTING row) or the ledgered tool-call route; the live
 *     avatar fails closed to text chat on a dark provider and is metered; no tenant-facing surface says
 *     "platform-covered" (positive control on a specimen)
 *  A2. THE DOOR MATRIX (wave 143G) — eight audiences (platform staff, tenant staff/teams, partners, buyers/sellers,
 *     lifetime customers, website visitors, setup, voice), each with its door, its real backend and WHAT MAKES IT ACT
 *     (governed seat/persona tools bounded by the resolved authority rung, or a recorded human escalation); the setup
 *     assistant's escalation reaches the tenant-admin ROSTER, not a retyped pair (positive control)
 *  B. THE TRIAGE REGISTRY — every category has a REGISTERED owner (never the reporter), a valid bus route and a
 *     SIGNAL_HANDLERS inbox; the catalogue mirrors the module's consumer list and the feed kind; the routed lane is a
 *     routing row; MAINTENANCE_DOMAINS + package.json membership (not position)
 *  C. THE TRIAGE, in memory (scripts/in-memory-supabase.ts) — pure classifier + apply rule + tenant-facing gate +
 *     help ranking (positive controls); the model path (applied, answered, evidenced, routed, ledgered); a dark
 *     model → heuristic, still routed; a refused tenant lane → NO model call; the platform lane → platformPaid, no
 *     tenant gate; an operation-shaped ticket → the SAFE-REPAIR route (operation.failed + the owner's inbox); an
 *     answer that is unsafe / ungrounded is WITHHELD with the reason; a late model → heuristic; a second triage of
 *     the same ticket REPLAYS (ledger idempotency); the consumer's four verdicts; the bus end to end; the door;
 *     the thread read-back
 *  D. OPERATION → TICKET — an escalated operation failure opens ONE tracked ticket in the right lane (idempotent);
 *     a subject that is itself a ticket is not re-ticketed
 *  E. EDUCATION — support tickets cluster into a `support:` gap (positive + negative control), the gatherer reads
 *     them inside the window only, the draft lands on the article channel with its COUNTER on the evidence row, the
 *     repeat measure's verdicts (decreased / finding / not yet / dedupe), the author rides the education owner's cron
 *     (stripped source; the tombstone on recruit-outreach is the positive control)
 * BLIND SPOTS (published): the model lane is a seam (the real lane is test:ai-routing-coverage's subject); the
 * consumer runs on the 30-minute tick, not in-request; the in-memory client does not enforce the live CHECKs
 * (support_tickets_lane_check etc. — test:support's live run does); the FormWizard coach's questions ride the
 * chat_messages source only once lane 142C logs them through chat_sessions; surface audits read source, not a browser.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  TRIAGE_OWNER_BY_CATEGORY, SUPPORT_TRIAGE_CONSUMERS, SUPPORT_TRIAGE_SIGNAL_TYPE, SUPPORT_TRIAGE_EVENT, SUPPORT_TRIAGE_FEATURE,
  SUPPORT_AI_ANSWER_NOTIFICATION, classifyTicketHeuristically, applyTriageRule, tenantFacingGate, rankHelpCandidates,
  triageSupportTicket, handleSupportTicketTriaged, loadTicketTriage, ensureOperationTicket, triageSentence, type TriageModelOutput,
} from "../lib/support/ticket-triage"
import { TICKET_CATEGORIES, ticketPriorityRank } from "../lib/support/ticket-constants"
import { MANAGERS, MAINTENANCE_DOMAINS, CRON_MANAGER } from "../lib/kernel/manager-registry"
import { SIGNAL_HANDLERS, validSignalRoute, consumeManagerSignals } from "../lib/kernel/manager-signals"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { OPERATION_REPORTER, OPERATION_SIGNAL_TYPE, OPERATION_EVENT, OPERATION_OWNER, handleOperationFailureEscalated } from "../lib/kernel/immediate-operations"
import { buildSupportSignals, classifySupportQuestion, QUESTION_MIN_ASKERS } from "../lib/education/question-gap"
import { detectKnowledgeGaps } from "../lib/education/knowledge-gap-detector"
import { repeatTrend, measureEducationRepeats, EDUCATION_REPEAT_EVENT, EDUCATION_REPEAT_SIGNAL_TYPE, EDUCATION_REPEAT_OWNER } from "../lib/education/repeat-measure"

let pass = 0, fail = 0
const ok = (c: unknown, m: string, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`) } }
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))

// ── fixtures ─────────────────────────────────────────────────────────────────
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const USER = "22222222-2222-4222-8222-222222222222", ADMIN = "11111111-1111-4111-8111-111111111111"
type Row = Record<string, any>
function client(seed: Record<string, Row[]> = {}) {
  const svc = memSupabase({
    support_tickets: [], knowledge_articles: [], help_topics_kb: [], lifecycle_events: [], manager_signals: [], notifications: [],
    agent_action_ledger: [], users: [], learning_modules: [], chat_messages: [], compliance_flags: [], objection_training_sessions: [], ...seed,
  }, { uuidIds: true, stampCreatedAt: true })
  ;(svc as any).rpc = async () => ({ data: null, error: null })
  const orig = svc.from.bind(svc)
  ;(svc as any).from = (table: string) => {
    const q: any = orig(table)
    // The live manager_signals.status DEFAULT 'open' — the bus's dedupe and the tick both filter on it.
    if (table === "manager_signals") { const ins = q.insert.bind(q); q.insert = (p: any) => ins(Array.isArray(p) ? p.map((r: any) => ({ status: "open", ...r })) : { status: "open", ...p }) }
    // The live agent_action_ledger UNIQUE (idempotency_key) — a second claim under the same key is 23505 (the replay path).
    if (table === "agent_action_ledger") {
      const ins = q.insert.bind(q)
      q.insert = (p: any) => {
        const key = p?.idempotency_key
        if (key && (svc.tables.agent_action_ledger ?? []).some((r) => r.idempotency_key === key)) {
          const refused = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
          return { select: () => ({ single: async () => refused, maybeSingle: async () => refused }), then: (res: any) => Promise.resolve(refused).then(res) }
        }
        return ins(p)
      }
    }
    return q
  }
  return svc
}
const open = (svc: ReturnType<typeof client>, type?: string) => (svc.tables.manager_signals ?? []).filter((s) => (s.status === "open" || s.status === undefined) && (!type || s.signal_type === type))
const events = (svc: ReturnType<typeof client>, type: string) => (svc.tables.lifecycle_events ?? []).filter((e) => e.event_type === type)
const ticket = (svc: ReturnType<typeof client>, over: Row = {}): Row => {
  const row = { brokerage_id: B, lane: "user_to_brokerage", subject: "Cannot find where to send my listing forms for e-sign", description: "I filled the forms but there is no send button", category: "general", priority: "medium", status: "open", submitted_by_user_id: USER, agent_id: null, first_response_at: null, resolved_at: null, created_at: new Date().toISOString(), ...over }
  svc.tables.support_tickets.push({ id: over.id ?? `t-${svc.tables.support_tickets.length + 1}`, ...row })
  return svc.tables.support_tickets[svc.tables.support_tickets.length - 1]
}
const ART = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const helpSeed = () => ({ knowledge_articles: [{ id: ART, brokerage_id: null, status: "published", title: "Sending forms for e-sign from the FormWizard", excerpt: "Open the wizard, reach the E-Sign step and choose your e-sign provider.", content: "…" }] })
const verdict = (o: Partial<TriageModelOutput> = {}): TriageModelOutput => ({ category: "technical", priority: "high", operation: null, summary: "The e-sign step is not visible to the user", answer: "Open the FormWizard, complete the Fill step and the E-Sign step appears with your provider.", groundedIn: [ART], needsHuman: false, confidence: 0.8, ...o })
const input = (t: Row, over: Partial<Parameters<typeof triageSupportTicket>[1]> = {}) => ({ ticketId: t.id, brokerageId: t.brokerage_id, lane: t.lane, subject: t.subject, description: t.description, category: t.category, priority: t.priority, submitterUserId: t.submitted_by_user_id, actor: { userType: "agent" }, ...over })
const allow = async () => ({ allowed: true, reason: "subscription_current" })

// ── the routing table (parsed like test:ai-routing-coverage does — never a hand list) ─────────
const modelsSrc = blankComments(read("lib/ai/models.ts"))
const ROUTES = new Set([...modelsSrc.matchAll(/^\s*([a-z0-9_]+):\s*\{\s*model:\s*"[a-z0-9.-]+",\s*fallback:\s*"[a-z0-9.-]+"/gm)].map((m) => m[1]))
const routedFeaturesIn = (src: string): string[] => [...src.matchAll(/\bfeature\s*:\s*["'`]([A-Za-z0-9_]+)["'`]/g)].map((m) => m[1])

console.log("\n━━━ A · every audience reaches a real, routed, evidenced assistant ━━━")
{
  ok(ROUTES.size >= 40 && ROUTES.has("unspecified"), `AI_TASK_ROUTING parsed (${ROUTES.size} rows)`)
  const surfaces: Array<[string, string, string, RegExp]> = [
    // audience, surface component, backend it calls, how the surface names it
    ["platform staff / tenant admins / agents", "app/components/shared/internal-ai-assistant.tsx", "app/api/internal/ai-chat/route.ts", /api:\s*["']\/api\/internal\/ai-chat["']/],
    ["buyers / sellers (portal)", "app/components/features/portal/ai/PortalAIAssistant.tsx", "app/api/portal/ai-chat/route.ts", /api:\s*['"]\/api\/portal\/ai-chat['"]/],
    ["tenant admins (setup)", "app/components/features/onboarding/AISetupAssistant.tsx", "app/api/onboarding/assistant/route.ts", /api:\s*['"]\/api\/onboarding\/assistant['"]/],
  ]
  for (const [aud, comp, route, re] of surfaces) {
    const c = code(comp)
    ok(re.test(c) && existsSync(join(ROOT, route)), `${aud}: ${comp} → ${route} (exists)`)
    const feats = routedFeaturesIn(code(route))
    ok(feats.length > 0 && feats.every((f) => ROUTES.has(f)), `${route} runs a ROUTED lane (features: ${[...new Set(feats)].join(", ") || "none"})`, feats.filter((f) => !ROUTES.has(f)).join(","))
  }
  const chat = code("app/api/internal/ai-chat/route.ts")
  ok(/platform_staff/.test(chat) && /loadSuperadminContext/.test(chat), "platform staff get the platform context on the same assistant (seat-aware, never a tenant's)")
  for (const [aud, file] of [["vendors", "app/portal/vendor/page.tsx"], ["lenders", "app/portal/lender/layout.tsx"], ["title", "app/portal/title/layout.tsx"]] as const) {
    ok(/<InternalAIAssistant\s+role=["'](vendor|lender|title)["']/.test(code(file)), `${aud}: the internal assistant is mounted on their portal (${file})`)
  }
  const voice = code("app/components/features/agent-assistant/voice-assistant-overlay.tsx"), session = code("app/api/agent-assistant/session/route.ts"), tool = code("app/api/agent-assistant/tool-call/route.ts")
  ok(/fetch\(["']\/api\/agent-assistant\/session["']/.test(voice) && /checkUsageCap\(/.test(session) && /from\("agent_assistant_tool_calls"\)/.test(tool), "voice assistant: session is cap-checked and every tool call lands on agent_assistant_tool_calls (evidence)")
  const widget = code("app/components/features/ai-avatar-chat/AgentsWidget.tsx"), launcher = code("app/components/features/portal/ai/PortalChatLauncher.tsx")
  ok(/fetch\(["']\/api\/did\/agents\/session["']/.test(widget) && /Live Agent unavailable — switching to chat/.test(widget) && /onFallbackToText/.test(launcher), "live avatar (D-ID): a real session door, and a dark provider FALLS BACK TO TEXT CHAT — never a dead bubble presented as live")
  ok(/logVendorUsage\(/.test(code("lib/did/live-session-metering.ts")) && /startLiveAgentSession\(/.test(code("app/api/did/agents/session/route.ts")), "live avatar minutes are metered (live_agent_sessions → vendor_usage_tracking)")
  const plat = code("lib/did/platform-live-agent.ts")
  ok(/operatorHint/.test(plat) && /is not configured/.test(plat) && !/platform[- ]?covered/i.test(plat), "the platform's own live agent FAILS CLOSED with an operator hint (no presenter → not available)")
  const tenantFacing = ["app/components/shared/internal-ai-assistant.tsx", "app/components/features/portal/ai/PortalAIAssistant.tsx", "app/components/features/ai-avatar-chat/AgentsWidget.tsx", "app/dashboard/help/help-client.tsx", "app/dashboard/help/ticket-thread.tsx", "lib/support/ticket-triage.ts"]
  const leaks = tenantFacing.filter((f) => /platform[- ]?covered/i.test(code(f).replace(/platform\[- \]\?covered|platform\[- \]\?covered/g, "")))
  ok(leaks.length === 0, `no tenant-facing assistant / support surface says "platform-covered" (${tenantFacing.length} files)`, leaks.join(", "))
  ok(/platform[- ]?covered/i.test("This is platform-covered"), "POSITIVE CONTROL: the finder sees the forbidden phrase")
}

console.log("\n━━━ A2 · the DOOR MATRIX — audience → door → real backend → what makes it ACT (wave 143G) ━━━")
{
  // Owner (wave 143): "audit authorized AI assistance (chat/voice/avatar) for platform staff, tenant admins, agents/teams,
  // buyers/sellers, lifetime customers, vendors — real manager/tool-backed actions, not detached generic answers; name the
  // door per audience and its proof." Each row below is a door that EXISTS and is wired to a backend that acts through
  // governed tools (the seat/persona tool mounts at the resolved authority) or through a recorded human escalation.
  const INTERNAL = "app/api/internal/ai-chat/route.ts", PORTAL = "app/api/portal/ai-chat/route.ts", WIDGET = "app/api/widget/message/route.ts"
  const DOORS: Array<{ audience: string; door: string; backend: string; acts: RegExp; why: string }> = [
    { audience: "platform staff", door: "InternalAIAssistant (platform context)", backend: INTERNAL, acts: /buildUserTypeSeatTools\(/, why: "seat tools" },
    { audience: "tenant admins / brokers / team leads / agents / TCs", door: "InternalAIAssistant (seat tools by user_type)", backend: INTERNAL, acts: /buildUserTypeSeatTools\(/, why: "seat tools" },
    { audience: "vendors / lenders / title partners", door: "InternalAIAssistant mounted on the partner portals", backend: INTERNAL, acts: /buildUserTypeSeatTools\([^)]*vendorId/, why: "vendor seat tools (own placements, invoices, documents)" },
    { audience: "buyers / sellers", door: "PortalAIAssistant", backend: PORTAL, acts: /selectToolsForPersona\(/, why: "persona tools at the resolved authority" },
    { audience: "lifetime customers", door: "PortalAIAssistant (portalView 'lifetime')", backend: PORTAL, acts: /BUYER_LIFETIME[\s\S]{0,40}lifetime/, why: "the lifetime persona view" },
    { audience: "website visitors / prospects", door: "SiteChatLauncher → /widget/<slug>", backend: WIDGET, acts: /selectToolsForPersona\(/, why: "persona tools at the resolved authority" },
    { audience: "tenant admins (setup)", door: "AISetupAssistant", backend: "app/api/onboarding/assistant/route.ts", acts: /SETUP_ASSISTANT_ESCALATED/, why: "a recorded human escalation (no tool — it answers from the KB and hands off)" },
    { audience: "every voice seat", door: "voice assistant overlay", backend: "app/api/agent-assistant/tool-call/route.ts", acts: /agent_assistant_tool_calls/, why: "every tool call executed and recorded" },
  ]
  for (const d of DOORS) ok(existsSync(join(ROOT, d.backend)) && d.acts.test(code(d.backend)), `${d.audience} → ${d.door} → ${d.backend} acts through: ${d.why}`)
  ok(DOORS.length >= 8 && new Set(DOORS.map((d) => d.audience)).size === DOORS.length, `the matrix names ${DOORS.length} audiences, each once`)
  ok(!DOORS[3].acts.test("const reply = await generateText({ model, prompt })"), "POSITIVE CONTROL: a detached model call (no governed tool mount) does not satisfy the door rule")
  for (const [aud, backend] of [["buyers / sellers", PORTAL], ["website visitors", WIDGET]] as const) ok(/resolveAgentAuthorityLevel\(/.test(code(backend)), `${aud}: the tool mount is bounded by the resolved authority rung (LAW 4), not a hard-coded level`)
  ok(/SiteChatLauncher/.test(code("app/site/[slug]/page.tsx")), "the tenant website mounts the visitor door (SiteChatLauncher)")
  const setup = code("app/api/onboarding/assistant/route.ts")
  const RETYPED_PAIR = /\.in\(\s*['"]user_type['"],\s*\[\s*['"]admin['"],\s*['"]broker['"]\s*\]\)/
  ok(!RETYPED_PAIR.test(setup) && /\.in\(\s*['"]user_type['"],\s*\[\.\.\.TENANT_ADMIN_USER_TYPES\]\)/.test(setup), "the setup assistant's escalation reaches the tenant-admin ROSTER (broker_owner / broker_admin / compliance_officer included), not a retyped ['admin','broker'] pair")
  ok(RETYPED_PAIR.test(`.in('user_type', ['admin', 'broker'])`), "POSITIVE CONTROL: the retyped-pair finder sees the retired spelling")
}

console.log("\n━━━ B · the triage registry ━━━")
{
  ok([...TICKET_CATEGORIES].every((c) => c in TRIAGE_OWNER_BY_CATEGORY) && Object.keys(TRIAGE_OWNER_BY_CATEGORY).length === TICKET_CATEGORIES.length, "every ticket category has an owner (one vocabulary with TICKET_CATEGORIES)")
  for (const [cat, owner] of Object.entries(TRIAGE_OWNER_BY_CATEGORY)) ok(owner in MANAGERS && owner !== OPERATION_REPORTER && validSignalRoute(OPERATION_REPORTER, owner), `${cat} → ${owner} is a registered manager and a valid route from the reporter`)
  for (const m of SUPPORT_TRIAGE_CONSUMERS) ok(typeof SIGNAL_HANDLERS[`${m}:${SUPPORT_TRIAGE_SIGNAL_TYPE}`] === "function", `SIGNAL_HANDLERS has ${m}:${SUPPORT_TRIAGE_SIGNAL_TYPE}`)
  const spec = SIGNAL_REGISTRY[SUPPORT_TRIAGE_SIGNAL_TYPE]
  ok(!!spec && spec.disposition === "handled" && [...spec.consumers].sort().join(",") === [...SUPPORT_TRIAGE_CONSUMERS].sort().join(","), "the catalogue's consumer list IS the module's consumer list", spec?.consumers.join(","))
  ok(!!spec && spec.kind === classifyCoordination(SUPPORT_TRIAGE_SIGNAL_TYPE), `the feed renders it as ${classifyCoordination(SUPPORT_TRIAGE_SIGNAL_TYPE)} (declared ${spec?.kind})`)
  const finding = SIGNAL_REGISTRY[EDUCATION_REPEAT_SIGNAL_TYPE]
  ok(!!finding && finding.disposition === "feed_only" && finding.consumers.includes(EDUCATION_REPEAT_OWNER) && finding.kind === classifyCoordination(EDUCATION_REPEAT_SIGNAL_TYPE), "education_repeat_finding is catalogued feed-only for the education owner with the live feed kind")
  ok(ROUTES.has(SUPPORT_TRIAGE_FEATURE), `the triage feature "${SUPPORT_TRIAGE_FEATURE}" is an AI_TASK_ROUTING row (never the silent Sonnet default)`)
  ok(MAINTENANCE_DOMAINS.ai_by_your_side?.proof === "test:ai-by-your-side" && (MAINTENANCE_DOMAINS.ai_by_your_side.coOwners ?? []).length === 2, "MAINTENANCE_DOMAINS.ai_by_your_side owned + co-owned")
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  ok(/ai-by-your-side-guard\.ts/.test(pkg.scripts["test:ai-by-your-side"] ?? ""), "package.json registers test:ai-by-your-side")
  ok(new RegExp("npm run test:ai-by-your-side(\\s|&|$)").test(pkg.scripts.guard ?? ""), "the guard chain runs it (membership, not position)")
}

console.log("\n━━━ C · the triage ━━━")
{
  // C0 — pure
  const h1 = classifyTicketHeuristically("Invite email never arrived for my new agent", null)
  ok(h1.operation === "invitation" && h1.category === "onboarding", "heuristic: an invite that never arrived → operation invitation / onboarding", JSON.stringify(h1))
  const h2 = classifyTicketHeuristically("Closing today and the DocuSign envelope won't send", "")
  ok(h2.priority === "urgent" && h2.operation === "transaction_provider_connection" && h2.category === "technical", "heuristic: a closing-day e-sign failure → urgent / the legal-forms provider connection", JSON.stringify(h2))
  const h3 = classifyTicketHeuristically("We were charged twice on the invoice", "")
  ok(h3.category === "billing" && h3.operation === "billing_activation", "heuristic: a double charge → billing", JSON.stringify(h3))
  ok(classifyTicketHeuristically("hello", "").category === "general", "heuristic: nothing recognisable stays general (never force-fit)")
  const a1 = applyTriageRule({ category: "general", priority: "medium" }, { category: "billing", priority: "high" })
  const a2 = applyTriageRule({ category: "billing", priority: "urgent" }, { category: "general", priority: "low" })
  const a3 = applyTriageRule({ category: "technical", priority: "low" }, { category: "billing", priority: "medium" })
  ok(a1.category === "billing" && a1.priority === "high" && a2.category === null && a2.priority === null && a3.category === null && a3.priority === "medium", "apply rule: category only over the default, priority only ever RAISED")
  ok(ticketPriorityRank("urgent") > ticketPriorityRank("high") && ticketPriorityRank("low") < ticketPriorityRank("medium") && ticketPriorityRank("bogus") === ticketPriorityRank("medium"), "the priority ladder ranks urgent > high > medium > low (unknown = medium)")
  ok(!tenantFacingGate("This is platform-covered, so no charge").ok && !tenantFacingGate("Your plan is $49/month").ok && !tenantFacingGate("Rotate the api key under settings").ok && !tenantFacingGate("PGRST204 on the insert").ok, "tenant-facing gate refuses platform-covered / a price / a credential word / a database internal")
  ok(tenantFacingGate("Open Settings → Integrations and reconnect the provider.").ok && !tenantFacingGate("").ok, "…and passes a plain sentence (empty refused)")
  const ranked = rankHelpCandidates("how do I send forms for e-sign", [{ id: "a", source: "article", title: "Sending forms for e-sign", body: "" }, { id: "b", source: "kb", title: "Billing", body: "seats and plans" }])
  ok(ranked.length === 1 && ranked[0].id === "a", "help ranking keeps only overlapping rows, best first")
  ok(/read as technical, high priority/.test(triageSentence("Forms", "technical", "high", true, false)) && !/platform/.test(triageSentence("x", "general", "medium", false, true)), "the feed sentence names category / priority / who owes the reply")

  // C1 — the model path
  const svc = client(helpSeed())
  const t1 = ticket(svc)
  const calls: Array<{ platformPaid: boolean; brokerageId: string }> = []
  const r1 = await triageSupportTicket(svc, input(t1), { afford: allow, model: async (p) => { calls.push({ platformPaid: p.platformPaid, brokerageId: p.brokerageId }); return verdict() } })
  const row1 = svc.tables.support_tickets.find((t) => t.id === t1.id)!
  ok(r1.ok && r1.model === "routed" && r1.category === "technical" && r1.priority === "high", "model verdict taken (technical / high)", JSON.stringify({ ok: r1.ok, model: r1.model, err: r1.error }))
  ok(row1.category === "technical" && row1.priority === "high" && r1.applied.category === "technical" && r1.applied.priority === "high", "…applied to the ticket (counted update on the tenant)")
  ok(calls.length === 1 && calls[0].platformPaid === false && calls[0].brokerageId === B, "the tenant lane books on the tenant (platformPaid false)")
  const ev1 = events(svc, SUPPORT_TRIAGE_EVENT)
  ok(ev1.length === 1 && ev1[0].entity_id === t1.id && ev1[0].brokerage_id === B && ev1[0].metadata?.model === "routed" && ev1[0].metadata?.answer_delivered === true && ev1[0].metadata?.owner === "data_steward", "ONE evidence row (support.ticket_triaged) carries the verdict", JSON.stringify(ev1[0]?.metadata))
  const bells = (svc.tables.notifications ?? []).filter((n) => n.type === SUPPORT_AI_ANSWER_NOTIFICATION)
  ok(r1.answerDelivered && bells.length === 1 && bells[0].user_id === USER && bells[0].brokerage_id === B && /E-Sign step/.test(bells[0].body) && /Sending forms/.test(bells[0].body), "the grounded answer reached the SUBMITTER with the article it cites")
  const sig1 = open(svc, SUPPORT_TRIAGE_SIGNAL_TYPE)
  ok(r1.signalId !== null && r1.routedTo === "data_steward" && sig1.length === 1 && sig1[0].from_manager === OPERATION_REPORTER && sig1[0].to_manager === "data_steward" && sig1[0].entity_id === t1.id && /read as technical/.test(sig1[0].message) && sig1[0].payload?.answer_delivered === true, "ONE open signal to the registered owner from the reporter, carrying the tenant-facing sentence")
  const led = (svc.tables.agent_action_ledger ?? []).filter((l) => l.action === "support.ticket.triage")
  ok(led.length === 1 && led[0].status === "executed" && led[0].subject_id === t1.id && led[0].actor_type === "manager" && led[0].reason_code === "CONVERSATION_RESPONSE" && /routed:data_steward/.test(String(led[0].outcome)), "the action ledger row: manager actor, the ticket as subject, executed with the route as outcome", JSON.stringify(led[0]))
  // C1b — the thread read-back
  const tri = await loadTicketTriage(svc, t1.id)
  ok(!!tri && tri.category === "technical" && tri.priority === "high" && tri.answerDelivered && tri.model === "routed", "loadTicketTriage returns the verdict for the thread renderers")
  ok((await loadTicketTriage(svc, "never-triaged")) === null, "…and null for a ticket that was never triaged")
  // C1c — a SECOND triage of the same ticket replays the ledger (idempotent — no second signal, no second evidence row)
  const r1b = await triageSupportTicket(svc, input(t1), { afford: allow, model: async () => { calls.push({ platformPaid: false, brokerageId: "again" }); return verdict() } })
  ok(r1b.model === "replayed" && calls.length === 1 && events(svc, SUPPORT_TRIAGE_EVENT).length === 1 && open(svc, SUPPORT_TRIAGE_SIGNAL_TYPE).length === 1, "a second triage of the same ticket REPLAYS (idempotency key) — no second model call, evidence row or signal", JSON.stringify({ model: r1b.model, note: r1b.modelNote, calls: calls.length }))

  // C2 — a dark model → heuristic, still evidenced and routed
  const t2 = ticket(svc, { subject: "Fair housing disclosure question on an ad", description: "is this wording a compliance violation?", category: "compliance" })
  const r2 = await triageSupportTicket(svc, input(t2), { afford: allow, model: async () => { throw new Error("gateway 503") } })
  ok(r2.ok && r2.model === "heuristic" && /model unavailable/.test(r2.modelNote ?? "") && r2.routedTo === "compliance_officer" && open(svc, SUPPORT_TRIAGE_SIGNAL_TYPE).some((s) => s.to_manager === "compliance_officer" && s.entity_id === t2.id), "a dark model → the deterministic classifier, evidenced (model_note) and routed to the category's owner (compliance_officer)", JSON.stringify({ ok: r2.ok, note: r2.modelNote, to: r2.routedTo, err: r2.error }))
  ok(!r2.answerDelivered && (svc.tables.notifications ?? []).filter((n) => n.type === SUPPORT_AI_ANSWER_NOTIFICATION && n.entity_id === t2.id).length === 0, "…with no answer (the heuristic never writes to the submitter)")

  // C3 — a refused tenant lane → NO model call
  const t3 = ticket(svc, { subject: "Where do I change my seat count?" })
  let modelCalled = false
  const r3 = await triageSupportTicket(svc, input(t3), { afford: async () => ({ allowed: false, reason: "past_due_blocked" }), model: async () => { modelCalled = true; return verdict() } })
  ok(!modelCalled && r3.model === "heuristic" && /refused: past_due_blocked/.test(r3.modelNote ?? "") && r3.routedTo !== null, "a refused tenant AI lane makes NO model call — heuristic, evidenced, still routed")

  // C4 — the platform lane: no tenant gate, platformPaid
  const t4 = ticket(svc, { lane: "tenant_to_platform", subject: "Our office cannot see the compliance queue", submitted_by_user_id: ADMIN })
  let affordCalled = false
  const r4 = await triageSupportTicket(svc, input(t4, { actor: { userType: "broker" } }), { afford: async () => { affordCalled = true; return { allowed: true, reason: "x" } }, model: async (p) => { calls.push({ platformPaid: p.platformPaid, brokerageId: p.brokerageId }); return verdict({ category: "technical", priority: "medium", answer: null, groundedIn: [], needsHuman: true }) } })
  ok(!affordCalled && calls[calls.length - 1].platformPaid === true && r4.model === "routed" && r4.needsHuman, "the platform lane rides the platform's own ledger (platformPaid) with no tenant budget gate")

  // C5 — an operation-shaped ticket → the SAFE-REPAIR route
  const t5 = ticket(svc, { subject: "Invitation email never arrived for our new agent", description: "sent twice, nothing in spam", category: "onboarding" })
  const r5 = await triageSupportTicket(svc, input(t5), { afford: allow, model: async () => verdict({ category: "onboarding", priority: "high", operation: "invitation", answer: null, groundedIn: [], needsHuman: true }) })
  const opEv = events(svc, OPERATION_EVENT.failed).filter((e) => e.entity_id === t5.id)
  const opSig = open(svc, OPERATION_SIGNAL_TYPE).filter((s) => s.entity_id === t5.id)
  ok(r5.operation === "invitation" && r5.routedTo === OPERATION_OWNER.invitation && opEv.length === 1 && opEv[0].metadata?.operation === "invitation" && opEv[0].metadata?.subject_type === "support_ticket", "an operation-shaped ticket is reported as that operation's failed post-condition (operation.failed on the ticket)", JSON.stringify({ op: r5.operation, to: r5.routedTo, err: r5.error }))
  ok(opSig.length === 1 && opSig[0].to_manager === OPERATION_OWNER.invitation && !open(svc, SUPPORT_TRIAGE_SIGNAL_TYPE).some((s) => s.entity_id === t5.id), "…routed on operation_failure_escalated to the operation's REGISTERED owner (not a second triage signal)")
  ok(events(svc, SUPPORT_TRIAGE_EVENT).some((e) => e.entity_id === t5.id && e.metadata?.operation === "invitation"), "…and the triage evidence row names the operation")

  // C6 — an unsafe answer is WITHHELD; C7 — an ungrounded answer is WITHHELD
  const t6 = ticket(svc, { subject: "Why does my e-sign send fail" })
  const r6 = await triageSupportTicket(svc, input(t6), { afford: allow, model: async () => verdict({ answer: "That part is platform-covered; rotate the api key.", groundedIn: [ART] }) })
  ok(!r6.answerDelivered && /withheld: contains/.test(r6.answerWithheldReason ?? "") && !(svc.tables.notifications ?? []).some((n) => n.entity_id === t6.id && n.type === SUPPORT_AI_ANSWER_NOTIFICATION), "an answer that would say platform-covered / credential is WITHHELD with the reason on the evidence", r6.answerWithheldReason ?? "")
  const t7 = ticket(svc, { subject: "How do I send forms for e-sign" })
  const r7 = await triageSupportTicket(svc, input(t7), { afford: allow, model: async () => verdict({ answer: "Just click send.", groundedIn: ["not-an-offered-id"] }) })
  ok(!r7.answerDelivered && /not grounded/.test(r7.answerWithheldReason ?? ""), "an answer not grounded in an offered help candidate is WITHHELD")
  ok(events(svc, SUPPORT_TRIAGE_EVENT).some((e) => e.entity_id === t6.id && /withheld/.test(String(e.metadata?.answer_withheld_reason))), "…the evidence row records why")

  // C8 — a late model → heuristic
  const t8 = ticket(svc, { subject: "Video render stuck for an hour" })
  const r8 = await triageSupportTicket(svc, input(t8), { afford: allow, timeoutMs: 15, model: () => new Promise(() => {}) })
  ok(r8.model === "heuristic" && /did not answer within 15ms/.test(r8.modelNote ?? "") && r8.routedTo !== null, "a model that does not answer in time → heuristic, still routed (the request never hangs)")

  // C9 — a non-uuid tenant / no ticket is refused (nothing written)
  const before = svc.tables.lifecycle_events.length
  const r9 = await triageSupportTicket(svc, { ...input(t1), brokerageId: "not-a-uuid" }, { afford: allow, model: async () => verdict() })
  ok(!r9.ok && /no tenant id/.test(r9.error ?? "") && svc.tables.lifecycle_events.length === before, "a non-uuid tenant is refused — nothing written")

  // C10 — the consumer's verdicts
  const ctx = { brokerageId: B, supabase: svc }
  const sigFor = (t: Row) => ({ id: `sig-${t.id}`, payload: {}, entityId: t.id, createdAt: new Date().toISOString() })
  const v1 = await handleSupportTicketTriaged(sigFor(t2), ctx)
  ok(v1 === null, "an open, unanswered, in-SLA ticket stays OPEN on the owner's feed (null)")
  svc.tables.support_tickets.find((t) => t.id === t2.id)!.first_response_at = "2026-10-18T10:00:00.000Z"
  const v2 = await handleSupportTicketTriaged(sigFor(t2), ctx)
  ok(!!v2 && /a person on the answering side replied/.test(v2), "a human reply closes the watch WITH the verification", v2 ?? "null")
  svc.tables.support_tickets.find((t) => t.id === t3.id)!.status = "resolved"
  const v3 = await handleSupportTicketTriaged(sigFor(t3), ctx)
  ok(!!v3 && /verified: ticket is resolved/.test(v3), "a resolved ticket closes the watch", v3 ?? "null")
  const t11 = ticket(svc, { subject: "Locked out", priority: "urgent", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() })
  const v4 = await handleSupportTicketTriaged(sigFor(t11), ctx)
  ok(!!v4 && /SLA breached/.test(v4) && /sweep owns/.test(v4), "a breached SLA with no reply → the SLA sweep owns the escalation (never a second escalator)", v4 ?? "null")
  const v5 = await handleSupportTicketTriaged(sigFor(t1), { brokerageId: OTHER, supabase: svc })
  ok(!!v5 && /not on this tenant/.test(v5), "a ticket on another tenant is never verified across the boundary")

  // C11 — the bus end to end
  const svc2 = client(helpSeed())
  const t12 = ticket(svc2, { subject: "Charged twice on this month's invoice", category: "billing" })
  const r12 = await triageSupportTicket(svc2, input(t12), { afford: allow, model: async () => verdict({ category: "billing", priority: "high", answer: null, groundedIn: [], needsHuman: true }) })
  const tick1 = await consumeManagerSignals({ brokerageId: B, toManager: "finance_manager" }, svc2 as never)
  const srow = () => (svc2.tables.manager_signals ?? []).find((s) => s.id === r12.signalId)
  ok(r12.routedTo === "finance_manager" && tick1.skipped === 1 && tick1.consumed === 0 && srow()?.status === "open", "publish → the Finance inbox reads it on the tick and leaves it OPEN while nobody has replied", JSON.stringify({ to: r12.routedTo, tick1, status: srow()?.status }))
  svc2.tables.support_tickets.find((t) => t.id === t12.id)!.first_response_at = new Date().toISOString()
  const tick2 = await consumeManagerSignals({ brokerageId: B, toManager: "finance_manager" }, svc2 as never)
  ok(tick2.consumed === 1 && srow()?.status === "consumed" && /replied/.test(String(srow()?.consumed_action)), "…and consumes it WITH the verification once a person replied")

  // C12 — the door (stripped source; positive control)
  const door = code("app/actions/support.ts")
  // A regex, not a string literal: test:support-lane's chain scanner reads scripts/ too and the quotation is its
  // signal — a literal `.from("…")` spelled here would be scanned as a lane-less insert of this proof's own.
  const insertAt = door.search(/\.from\(\s*"support_tickets"\s*\)\s*\.insert\(/)
  const triageAt = door.indexOf("triageSupportTicket(")
  ok(insertAt > 0 && triageAt > insertAt && /import\("@\/lib\/support\/ticket-triage"\)/.test(door), "createSupportTicket calls triageSupportTicket AFTER its insert (in-request)")
  ok(!/triageSupportTicket\(/.test(stripComments("// triageSupportTicket(svc, x)\nconst y = 1")), "POSITIVE CONTROL: a comment naming the triage is not a call")
  ok(/loadTicketTriage\(/.test(code("lib/support/support-thread.ts")) && /triage/.test(code("app/dashboard/superadmin/support/[id]/page.tsx")) && /thread\.triage/.test(code("app/dashboard/admin/support-tickets/support-queue-client.tsx")) && /triage\?\.answerDelivered/.test(code("app/dashboard/help/ticket-thread.tsx")), "the three thread renderers read the triage back (console, office queue, the submitter's thread)")
}

console.log("\n━━━ D · an operation escalation lands IN the ticket flow ━━━")
{
  const svc = client({ users: [{ id: ADMIN, brokerage_id: B, user_type: "admin", deleted_at: null }] })
  const spies = { notifyOrg: async () => 1, notifyStaff: async () => 1 }
  const sig = (operation: string, extra: Record<string, unknown> = {}) => ({ id: `sig-${operation}`, payload: { operation, readiness_keys: [], tenant_facing: "Invitation delivery did not verify — the email never left", platform_visible: false, actor_user_id: ADMIN, lifecycle_event_id: "le-9", ...extra }, entityType: "user_invitations", entityId: "inv-1" })
  const a1 = await handleOperationFailureEscalated(sig("invitation"), { brokerageId: B, supabase: svc }, spies)
  const tk = (svc.tables.support_tickets ?? [])
  ok(!!a1 && /opened support ticket/.test(a1) && tk.length === 1 && tk[0].brokerage_id === B && tk[0].lane === "user_to_brokerage" && tk[0].status === "open" && tk[0].priority === "high" && tk[0].category === "onboarding" && /Invitation delivery needs attention/.test(tk[0].subject) && tk[0].submitted_by_user_id === ADMIN, "an escalated invitation failure opens ONE tracked ticket in the brokerage lane (SLA clock + thread, not only a bell)", JSON.stringify({ a1, tk }))
  const a2 = await handleOperationFailureEscalated(sig("invitation"), { brokerageId: B, supabase: svc }, spies)
  ok(!!a2 && /already tracked on support ticket/.test(a2) && (svc.tables.support_tickets ?? []).length === 1, "a repeat escalation reuses the open ticket (idempotent)")
  const a3 = await handleOperationFailureEscalated(sig("billing_activation", { platform_visible: true, tenant_facing: "Billing activation did not verify" }), { brokerageId: B, supabase: svc, }, { ...spies, readiness: async () => ({ ready: false, blockers: ["billing"], checks: [{ key: "billing", status: "BLOCKED", required: true, reason: "no subscription", evidence: {}, owner: "finance_manager", lastChecked: "2026-10-18T00:00:00.000Z", remediation: null }] as never, repairs: [] }) })
  const bt = (svc.tables.support_tickets ?? []).find((t) => /Billing activation/.test(t.subject))
  ok(!!a3 && !!bt && bt.lane === "tenant_to_platform" && bt.category === "billing", "a platform-visible subject opens the ticket in the platform lane (platform support answers)")
  const a4 = await handleOperationFailureEscalated({ id: "sig-t", payload: { operation: "invitation", readiness_keys: [], platform_visible: false }, entityType: "support_ticket", entityId: "t-existing" }, { brokerageId: B, supabase: svc }, spies)
  ok(!!a4 && /tracked on support ticket t-existing/.test(a4) && (svc.tables.support_tickets ?? []).length === 2, "a subject that IS a support ticket (the triage's safe-repair path) is not re-ticketed")
  const e1 = await ensureOperationTicket(svc, { brokerageId: B, operation: "nonsense", tenantFacing: "x", platformVisible: false })
  ok(e1.ticketId === null && /unknown operation/.test(e1.error ?? ""), "an unknown operation never opens a ticket")
  const e2 = await ensureOperationTicket(svc, { brokerageId: B, operation: "phone_a2p", tenantFacing: "Phone number registration failed: api key sk_live_abc rejected", platformVisible: false })
  const pt = (svc.tables.support_tickets ?? []).find((t) => t.id === e2.ticketId)
  ok(!!pt && !/sk_live|api key/i.test(pt.description) && /did not verify/.test(pt.description), "a tenant-facing body that would leak a credential is replaced by the generic sentence (gate)")
  const imm = code("lib/kernel/immediate-operations.ts")
  ok(/ensureOperationTicket\(svc, p\)/.test(imm) && /openTicket\(svc, \{/.test(imm), "the consumer's escalate step calls the ticket survivor (default seam)")
}

console.log("\n━━━ E · education intelligence on the existing survivors ━━━")
{
  const tix = Array.from({ length: QUESTION_MIN_ASKERS }, (_, i) => ({ subject: `Can't find the e-sign send button #${i}`, description: "forms filled" }))
  const sigs = buildSupportSignals([...tix, { subject: "Random hello there", description: null }, { subject: "Seat count question", description: "" }])
  ok(sigs.length === 1 && sigs[0].topicKey === "support:forms_esign" && sigs[0].source === "support" && sigs[0].weakCount === QUESTION_MIN_ASKERS && sigs[0].evidence.length === 5, `${QUESTION_MIN_ASKERS} e-sign tickets cluster into support:forms_esign (an unclassifiable and a one-off do not)`, JSON.stringify(sigs))
  ok(buildSupportSignals(tix.slice(0, 2)).length === 0, "NEGATIVE CONTROL: two tickets are noise, not a gap")
  ok(classifySupportQuestion("how do I add a seat on my plan")?.topic === "billing_seats" && classifySupportQuestion("hi") === null, "the PRODUCT lexicon classifies a how-to and skips nothing recognisable")
  const gaps = detectKnowledgeGaps(sigs)
  ok(gaps.length === 1 && gaps[0].source === "support" && /help article/.test(gaps[0].rationale) && gaps[0].weaknessRatio === 1, "a support signal is a recurrence-only gap (like compliance) with a help-article rationale")

  // the gatherer reads support_tickets inside the window only
  const now = new Date("2026-10-18T12:00:00.000Z")
  const svc = client({ support_tickets: [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, brokerage_id: B, lane: "user_to_brokerage", subject: `e-sign send button missing ${i}`, description: "", created_at: new Date(now.getTime() - (i + 1) * 86_400_000).toISOString() })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, brokerage_id: OTHER, lane: "user_to_brokerage", subject: `e-sign send button missing ${i}`, description: "", created_at: now.toISOString() })),
  ] })
  const { gatherGapSignals, persistCurriculumDraft, audienceForGap, EDUCATION_PROPOSED_EVENT } = await import("../lib/education/curriculum-author")
  const g1 = await gatherGapSignals(svc as never, B, now)
  ok(g1.some((s) => s.topicKey === "support:forms_esign" && s.weakCount === 5), "gatherGapSignals mines this tenant's support tickets (the other tenant's five are not counted)", JSON.stringify(g1.map((s) => [s.topicKey, s.weakCount])))
  const g2 = await gatherGapSignals(svc as never, B, now, { window: { since: new Date(now.getTime() - 40 * 86_400_000), until: new Date(now.getTime() - 20 * 86_400_000) } })
  ok(!g2.some((s) => s.topicKey === "support:forms_esign"), "…and a window that excludes them counts nothing (the measure's before/after reads)")
  ok(audienceForGap({ source: "support" }).includes("broker") && audienceForGap({ source: "objection_drill" }).join() === "agent", "a support how-to is for the whole roster; a skill gap is for agents")
  const gap = detectKnowledgeGaps(g1).find((g) => g.topicKey === "support:forms_esign")!
  const persisted = await persistCurriculumDraft(svc as never, B, gap, { title: "Sending forms for e-sign", summary: "s", objectives: ["a", "b"], lessons: [{ title: "1", walkthrough: "w", keyPoints: ["k", "k2"] }, { title: "2", walkthrough: "w", keyPoints: ["k", "k2"] }, { title: "3", walkthrough: "w", keyPoints: ["k", "k2"] }], quiz: [{ question: "q", options: ["a", "b", "c"], correctIndex: 0 }, { question: "q2", options: ["a", "b", "c"], correctIndex: 1 }] })
  const mod = (svc.tables.learning_modules ?? [])[0]
  const prop = events(svc, EDUCATION_PROPOSED_EVENT)
  ok(persisted && !!mod && mod.status === "pending_review" && mod.is_ai_generated === true && mod.channels?.join() === "article" && mod.gap_tags?.join() === "support:forms_esign" && mod.audience_roles?.includes("broker"), "the draft lands GATED on learning_modules on the ARTICLE channel (the approval fans it out to the help center)", JSON.stringify(mod))
  ok(prop.length === 1 && prop[0].entity_id === mod.id && prop[0].metadata?.repeats_before === 5 && prop[0].metadata?.source === "support", "THE COUNTER THE PROPOSAL CARRIES: education.gap_proposed on the module with repeats_before")

  // the repeat measure
  ok(repeatTrend(7, 2) === "decreased" && repeatTrend(7, 7) === "unchanged" && repeatTrend(7, 9) === "increased" && repeatTrend(null, 3) === "no_baseline" && repeatTrend(3, 0) === "decreased", "repeatTrend: decreased / unchanged / increased / no_baseline (silence after is a decrease)")
  const pub40 = new Date(now.getTime() - 40 * 86_400_000).toISOString(), pub10 = new Date(now.getTime() - 10 * 86_400_000).toISOString()
  const svcM = client({
    learning_modules: [
      { id: "mA", brokerage_id: B, is_ai_generated: true, status: "published", published_at: pub40, gap_tags: ["support:forms_esign"] },
      { id: "mB", brokerage_id: B, is_ai_generated: true, status: "published", published_at: pub40, gap_tags: ["question:escrow"] },
      { id: "mC", brokerage_id: B, is_ai_generated: true, status: "published", published_at: pub10, gap_tags: ["support:cda"] },
      { id: "mD", brokerage_id: B, is_ai_generated: false, status: "published", published_at: pub40, gap_tags: ["support:cda"] },
      { id: "mE", brokerage_id: OTHER, is_ai_generated: true, status: "published", published_at: pub40, gap_tags: ["support:cda"] },
    ],
    lifecycle_events: [{ id: "le-prop", event_type: "education.gap_proposed", entity_type: "learning_module", entity_id: "mA", brokerage_id: B, metadata: { repeats_before: 7 }, created_at: pub40 }],
  })
  const gatherCalls: Array<{ since: string; until: string }> = []
  const gather = async (_s: unknown, _b: string, _u: Date, o: { window: { since: Date; until: Date } }) => {
    gatherCalls.push({ since: o.window.since.toISOString(), until: o.window.until.toISOString() })
    const afterPub = o.window.since.toISOString() === pub40
    return [{ topicKey: "support:forms_esign", weakCount: afterPub ? 2 : 7 }, { topicKey: "question:escrow", weakCount: afterPub ? 6 : 4 }]
  }
  const m1 = await measureEducationRepeats(svcM as never, { brokerageId: B }, { now, gather })
  const evA = events(svcM, EDUCATION_REPEAT_EVENT).find((e) => e.entity_id === "mA"), evB = events(svcM, EDUCATION_REPEAT_EVENT).find((e) => e.entity_id === "mB")
  ok(m1.modules === 2 && m1.measured === 2 && m1.decreased === 1 && m1.findings === 1 && m1.errors.length === 0, "two eligible modules measured (the 10-day-old, the human-authored and the other tenant's are not)", JSON.stringify(m1))
  ok(!!evA && evA.metadata?.before === 7 && evA.metadata?.after === 2 && evA.metadata?.trend === "decreased" && evA.metadata?.baseline_source === "proposal_row", "module A: baseline from the proposal's counter, after re-counted → DECREASED (evidence row)", JSON.stringify(evA?.metadata))
  ok(!!evB && evB.metadata?.before === 4 && evB.metadata?.after === 6 && evB.metadata?.trend === "increased" && evB.metadata?.baseline_source === "regathered", "module B: no proposal row → baseline re-gathered → INCREASED", JSON.stringify(evB?.metadata))
  const finding = open(svcM, EDUCATION_REPEAT_SIGNAL_TYPE)
  ok(finding.length === 1 && finding[0].entity_id === "mB" && finding[0].to_manager === EDUCATION_REPEAT_OWNER && finding[0].from_manager === "cron_manager" && /did not reduce/.test(finding[0].message), "…and ONE finding reaches the education owner's feed (none for the decrease)")
  ok(gatherCalls.length === 3 && gatherCalls.every((c) => new Date(c.until).getTime() - new Date(c.since).getTime() === 30 * 86_400_000), "the gatherer was asked for exact 30-day windows (A after; B before + after)")
  const m2 = await measureEducationRepeats(svcM as never, { brokerageId: B }, { now, gather })
  ok(m2.measured === 0 && m2.skipped === 2 && events(svcM, EDUCATION_REPEAT_EVENT).length === 2, "a second run measures nothing again (the evidence row is the dedupe)")

  // THE NEXT FORMAT (wave 143G): a written answer that did not reduce the repeats earns a VIDEO option on the finding.
  ok(finding[0].payload?.next_format === "video" && /video channel/.test(finding[0].message) && /Re-author, re-deliver or retire\?/.test(finding[0].message), "the finding for a not-decreased question/support lesson names the next format (a video walkthrough) and the executable route (its video channel) — beside the original three choices", JSON.stringify(finding[0].payload))
  const svcV = client({
    learning_modules: [
      { id: "vA", brokerage_id: B, is_ai_generated: true, status: "published", published_at: pub40, gap_tags: ["support:forms_esign"], channels: ["article"] },
      { id: "vB", brokerage_id: B, is_ai_generated: true, status: "published", published_at: pub40, gap_tags: ["support:cda"], channels: ["article", "video"] },
      { id: "vC", brokerage_id: B, is_ai_generated: true, status: "published", published_at: pub40, gap_tags: ["compliance:fair_housing"], channels: ["article"] },
    ],
  })
  const gatherV = async (_s: unknown, _b: string, _u: Date, o: { window: { since: Date; until: Date } }) => {
    const afterPub = o.window.since.toISOString() === pub40
    return ["support:forms_esign", "support:cda", "compliance:fair_housing"].map((topicKey) => ({ topicKey, weakCount: afterPub ? 9 : 3 }))
  }
  const mv = await measureEducationRepeats(svcV as never, { brokerageId: B }, { now, gather: gatherV })
  const sigV = open(svcV, EDUCATION_REPEAT_SIGNAL_TYPE)
  const byId = (id: string) => sigV.find((x) => x.entity_id === id)
  ok(mv.findings === 3 && byId("vA")?.payload?.next_format === "video" && /video channel/.test(byId("vA")?.message ?? ""), "a support lesson published on the ARTICLE channel only that did not reduce repeats → next format video", JSON.stringify(mv))
  ok(byId("vB")?.payload?.next_format === null && !/video channel/.test(byId("vB")?.message ?? ""), "CONTROL: a lesson already on the video channel is not told to try video again (the format already tried)")
  ok(byId("vC")?.payload?.next_format === null && !/video channel/.test(byId("vC")?.message ?? ""), "CONTROL: a compliance lesson is not offered a video (compliance renders its own required format — the option is for how-to / question recurrence only)")

  // the host
  const edu = code("app/api/cron/education-delivery/route.ts"), rec = code("app/api/cron/recruit-outreach/route.ts")
  ok(/runCurriculumAuthorAll\(/.test(edu) && /runEducationRepeatMeasureAll\(/.test(edu), "the education-delivery cron runs the author AND the repeat measure")
  ok(!/runCurriculumAuthorAll\(/.test(rec) && /runCurriculumAuthorAll/.test(read("app/api/cron/recruit-outreach/route.ts")), "the recruit-outreach cron no longer runs the author (stripped source; its tombstone names the survivor — the positive control)")
  ok(CRON_MANAGER["/api/cron/education-delivery"] === "recruiting_manager", "the host cron is owned by the education owner (recruiting_manager) in CRON_MANAGER")
  ok(/from\("support_tickets"\)[\s\S]*?buildSupportSignals/.test(code("lib/education/curriculum-author.ts")), "the author reads support_tickets into buildSupportSignals")
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ AI_BY_YOUR_SIDE_FAIL — an assistant that is static, a ticket nobody reads, or a lesson nobody measures"); process.exit(1) }
console.log(" ✅ AI_BY_YOUR_SIDE_PASS — every audience reaches a real assistant; every ticket is read, routed and verified; recurring issues become measured education")
