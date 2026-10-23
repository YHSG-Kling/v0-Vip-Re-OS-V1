/**
 * scripts/canaries/ai-by-your-side.ts — AI / SUPPORT / EDUCATION canary (wave 142, lane 142J):
 *   a live-avatar session is a METERED row (never a static preview sold as live) · recurring questions become a
 *   knowledge gap with evidence, a one-off never does · the assistant's tool calls leave an audit row · tenant copy
 *   never says "platform-covered" · support triage + education intelligence measured
 * through the survivors at HEAD: lib/did/live-session-metering.ts (startLiveAgentSession / endLiveAgentSession —
 * live_agent_sessions, provider did | simli), lib/education/question-gap.ts (classifyQuestion / buildQuestionSignals,
 * ≥ 5 askers) → lib/education/knowledge-gap-detector.ts detectKnowledgeGaps (pure) → curriculum-author.ts (the
 * gated learning_modules draft), app/api/agent-assistant/tool-call/route.ts (agent_assistant_tool_calls audit) and
 * app/actions/support.ts createSupportTicket. Owner (wave 142): "AI is the MAIN function … real chat / voice /
 * live-avatar (no static preview sold as live); tenant-isolated support TICKET → AI TRIAGE → registered owner …;
 * recurring questions → proposed education assets".
 *
 * MEASURED AT HEAD (the 142G hooks): no model call anywhere in the support code (SLA timing only); the gap loop reads
 * chat_messages / compliance_flags / objection drills but not support_tickets, and runs from the recruit-outreach
 * cron; no test:ai-by-your-side. In-memory only (live_agent_sessions / support_tickets: 0 live rows).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, listFiles, readRepo, strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"

export async function run() {
  const c = canary("AI by your side: metered live avatar · recurring questions → gap with evidence · audited tool calls · no 'platform-covered' in tenant copy · triage + education measured")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — a live-agent session books a vendor; live_agent_sessions holds 0 rows")
  const B = uuid(), AG_U = uuid(), AG = uuid()
  // WIRED 142K (lane 142G): two tenants' tickets (the triage must never touch B2's), a platform-wide help article the
  // answer is grounded in, and two published AI lessons whose repeat windows have elapsed (the measure).
  const B2 = uuid(), AG2_U = uuid(), T1 = uuid(), T2 = uuid(), T3 = uuid(), KA = uuid(), M1 = uuid(), M2 = uuid()
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-ai` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-ai2` }],
    users: [
      { id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null },
      { id: AG2_U, email: `agent2@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B2, platform_role: null },
    ],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true, created_at: nowIso() }],
    support_tickets: [
      { id: T1, brokerage_id: B, lane: "user_to_brokerage", status: "open", priority: "medium", category: "general", subject: `${CANARY_TAG} my listing will not sync to the MLS`, description: "The listing shows an error and never reaches the MLS.", submitted_by_user_id: AG_U, agent_id: AG, first_response_at: null, resolved_at: null, created_at: nowIso(), updated_at: nowIso() },
      { id: T2, brokerage_id: B2, lane: "user_to_brokerage", status: "open", priority: "medium", category: "general", subject: `${CANARY_TAG} other tenant's MLS sync question`, description: "Same words, another brokerage.", submitted_by_user_id: AG2_U, agent_id: null, first_response_at: null, resolved_at: null, created_at: nowIso(), updated_at: nowIso() },
      { id: T3, brokerage_id: B, lane: "user_to_brokerage", status: "open", priority: "medium", category: "general", subject: `${CANARY_TAG} where do I find the CDA?`, description: "I cannot find the commission disbursement form.", submitted_by_user_id: AG_U, agent_id: AG, first_response_at: null, resolved_at: null, created_at: nowIso(), updated_at: nowIso() },
    ],
    knowledge_articles: [{ id: KA, brokerage_id: null, status: "published", title: "Why a listing does not sync to the MLS", excerpt: "Check the MLS connection under Settings, Connections and run the sync again.", content: "Check the MLS connection under Settings, Connections and run the sync again." }],
    learning_modules: [
      { id: M1, brokerage_id: B, is_ai_generated: true, status: "published", gap_tags: ["support:forms_esign"], published_at: daysAgo(100), title: `${CANARY_TAG} e-sign lesson` },
      { id: M2, brokerage_id: B, is_ai_generated: true, status: "published", gap_tags: ["support:cda"], published_at: daysAgo(100), title: `${CANARY_TAG} CDA lesson` },
    ],
  })
  setSvc(svc)

  // ── 1 · a live session is a metered row ──
  const { startLiveAgentSession, endLiveAgentSession } = await import("../../lib/did/live-session-metering")
  const started = await startLiveAgentSession({ brokerageId: B, agentId: AG, surface: "widget", provider: "did" }, svc as never)
  const open = (svc.tables.live_agent_sessions ?? []).find((r) => started.ok && r.id === started.id)
  c.step("LIVE AVATAR IS METERED: a session that minted a provider key opens a live_agent_sessions row under the tenant (provider did, surface widget, status active) — the row the vendor ledger and the tenant's usage read; nothing static is counted as live", started.ok && !!open && open.provider === "did" && open.surface === "widget" && open.status === "active" && open.brokerage_id === B, started.ok ? open?.status : started.error)
  const ended = started.ok ? await endLiveAgentSession(started.id, 42, svc as never) : null
  const closed = (svc.tables.live_agent_sessions ?? []).find((r) => started.ok && r.id === started.id)
  c.step("THE SESSION ENDS with its seconds: the row leaves 'active' (the metered duration is what is booked); ending it is a result, not a throw", !!ended && closed?.status !== "active", `status ${String(closed?.status)}; ${JSON.stringify(ended).slice(0, 80)}`)

  // ── 2 · recurring questions → a gap with evidence (pure) ──
  const { classifyQuestion, buildQuestionSignals, QUESTION_MIN_ASKERS } = await import("../../lib/education/question-gap")
  void daysAgo
  const { detectKnowledgeGaps } = await import("../../lib/education/knowledge-gap-detector")
  const escrow = Array.from({ length: QUESTION_MIN_ASKERS }, (_, i) => ({ text: `How does escrow work for my deal number ${i + 1}?` }))
  const signals = buildQuestionSignals([...escrow, { text: "What does the appraisal process involve?" }, { text: "hi" }])
  const gaps = detectKnowledgeGaps(signals)
  c.step(`EDUCATION INTELLIGENCE: ${QUESTION_MIN_ASKERS} askers of the same escrow question become ONE signal with de-identified evidence; the single appraisal question and a greeting never do (a one-off is not a gap); the detector turns the signal into a gap with a broker-readable rationale, highest priority first`, classifyQuestion("How does escrow work?")?.topic === "escrow" && classifyQuestion("hi") === null && signals.length === 1 && signals[0].topicKey.includes("escrow") && signals[0].evidence.length === QUESTION_MIN_ASKERS && gaps.length === 1 && gaps[0].rationale.length > 20, gaps[0]?.topicLabel ?? "no gap")

  // ── 3 · the assistant's tool calls are audited; tenant copy never says "platform-covered" ──
  const toolRoute = strippedRepo("app/api/agent-assistant/tool-call/route.ts") ?? ""
  c.step("AUDITED TOOL PATH: the assistant's tool-call route writes agent_assistant_tool_calls (what the AI did, for the broker) through the sentinel writer — a real action path, not a chat transcript", /agent_assistant_tool_calls/.test(toolRoute) && /sentinelWrite\(/.test(toolRoute), "")
  const rawHits = [...listFiles("app", (f) => /\.tsx?$/.test(f))].filter((f) => /platform-covered/.test(readRepo(f) ?? ""))
  const tenantFacing = rawHits.filter((f) => !/\/superadmin\//.test(f)).filter((f) => /platform-covered/.test(stripComments(readRepo(f) ?? "")))
  c.step(`TENANT COPY NEVER SAYS "platform-covered" (wave 140 ruling): 0 tenant-facing app files carry it in code or JSX text (${rawHits.length} raw mentions in app/, ${rawHits.length - tenantFacing.length} of them comments or platform-staff pages — internal ledgers may)`, tenantFacing.length === 0, tenantFacing.join(",") || "0 tenant-facing")

  // ── 4 · support triage + the education cron host (measured) ──
  const support = strippedRepo("app/actions/support.ts") ?? ""
  const supportLib = listFiles("lib/support", (f) => /\.ts$/.test(f)).map((f) => strippedRepo(f) ?? "").join("\n")
  const modelInSupport = /generateText|generateObject|gatewayChat|Routed\(|triage/i.test(support + supportLib)
  const author = strippedRepo("lib/education/curriculum-author.ts") ?? ""
  const host = strippedRepo("app/api/cron/recruit-outreach/route.ts") ?? ""
  c.step("THE GAP LOOP IS WIRED at HEAD: curriculum-author reads objection drills, compliance flags and chat questions and writes a GATED learning_modules draft (never auto-published); the ticket → bell flow exists (createSupportTicket → notifyPlatformStaff / brokerage admins)", /objection_training_sessions/.test(author) && /compliance_flags/.test(author) && /chat_messages/.test(author) && /\.from\(\s*["']learning_modules["']\s*\)\s*\.insert/.test(author) && /createSupportTicket/.test(support) && /notifyPlatformStaff|notifyBrokerageAdmins/.test(support), "")
  console.log(`    measured: model call / triage in support code = ${modelInSupport ? "yes (lib/support/ticket-triage.ts — lane 142G)" : "NO (SLA timing only)"}; curriculum-author reads support_tickets = ${/support_tickets/.test(author) ? "yes" : "no"}; runs from recruit-outreach cron = ${/runCurriculumAuthorAll\s*\(/.test(host) ? "yes (odd host)" : "no (tombstoned; education-delivery hosts it)"}`)

  // ── WAVE142 HOOK (integrator): 142G — wired 142K: support AI triage in memory; support subjects into the gap loop + the repeat measure; the registered proof. ──
  for (const h of hooksFor("ai-by-your-side")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /TRIAGE/.test(h.contract) ? "measured above: no model call in app/actions/support.ts or lib/support/*; SLA timing is the only automation" : /EDUCATION/.test(h.contract) ? "measured above: the gap loop reads chat / compliance / drills, not support_tickets, from the recruit-outreach cron" : "measured: test:ai-by-your-side is not registered"); continue }
    if (/TRIAGE/.test(h.contract)) {
      const T = await import("../../lib/support/ticket-triage")
      const modelCalls: Array<{ brokerageId: string; platformPaid: boolean }> = []
      const model = async (p: { brokerageId: string; platformPaid: boolean }) => { modelCalls.push({ brokerageId: p.brokerageId, platformPaid: p.platformPaid }); return { category: "technical" as const, priority: "high" as const, operation: null, summary: "The MLS sync fails for one listing.", answer: "Check the MLS connection under Settings, Connections and run the sync again.", groundedIn: [KA], needsHuman: true, confidence: 0.8 } }
      const input = { ticketId: T1, brokerageId: B, lane: "user_to_brokerage" as const, subject: `${CANARY_TAG} my listing will not sync to the MLS`, description: "The listing shows an error and never reaches the MLS.", category: "general", priority: "medium", submitterUserId: AG_U, actor: { userType: "agent" } }
      const t = await T.triageSupportTicket(svc as never, input, { model, afford: async () => ({ allowed: true, reason: "canary" }) })
      const ticket = (id: string) => (svc.tables.support_tickets ?? []).find((x) => x.id === id)
      const evidence = () => (svc.tables.lifecycle_events ?? []).filter((e) => e.event_type === T.SUPPORT_TRIAGE_EVENT && e.entity_id === T1)
      const signals = () => (svc.tables.manager_signals ?? []).filter((s) => s.signal_type === T.SUPPORT_TRIAGE_SIGNAL_TYPE && s.entity_id === T1)
      const answerBells = (svc.tables.notifications ?? []).filter((n) => n.type === T.SUPPORT_AI_ANSWER_NOTIFICATION && n.entity_id === T1)
      const replay = await T.triageSupportTicket(svc as never, input, { model, afford: async () => ({ allowed: true, reason: "canary" }) })
      const refusedLane = await T.triageSupportTicket(svc as never, { ...input, ticketId: T3, subject: `${CANARY_TAG} where do I find the CDA?`, description: "I cannot find the commission disbursement form." }, { model, afford: async () => ({ allowed: false, reason: "over budget" }) })
      const summary = await T.loadTicketTriage(svc as never, T1)
      const sig = signals()[0]
      const consumer = await T.handleSupportTicketTriaged({ id: String(sig?.id ?? ""), payload: (sig?.payload ?? {}) as Record<string, unknown>, entityId: T1, createdAt: nowIso() } as never, { brokerageId: B, supabase: svc as never })
      const crossTenant = await T.handleSupportTicketTriaged({ id: String(sig?.id ?? ""), payload: {}, entityId: T1, createdAt: nowIso() } as never, { brokerageId: B2, supabase: svc as never })
      const door = strippedRepo("app/actions/support.ts") ?? ""
      const createBody = door.slice(door.indexOf("export async function createSupportTicket"), door.indexOf("export async function", door.indexOf("export async function createSupportTicket") + 10))
      c.step(`${h.lane} landed (${at}) — SUPPORT AI TRIAGE at the ticket: the routed lane (model seam) suggests category / priority / owner, the SAFE half is applied (category only when the submitter left the default → technical; priority only RAISED → high; counted on the ticket's tenant), ONE evidence row (${T.SUPPORT_TRIAGE_EVENT}, under the tenant), ONE bus signal to the REGISTERED owner (TRIAGE_OWNER_BY_CATEGORY.technical = data_steward, from the operational reporter), the help-grounded answer delivered to the submitter (${T.SUPPORT_AI_ANSWER_NOTIFICATION}) — nothing lands under the other tenant; a second triage REPLAYS (ledger idempotency: no second signal, no second evidence row); a REFUSED tenant AI lane makes NO model call and still routes by the heuristic (the CDA question → data_steward); the consumer verifies on the tick (an open unanswered ticket stays the owner's item; a ticket on another tenant is never verified); the thread read-back names the verdict; the door calls it in-request AFTER its insert, best-effort`, t.ok && t.model === "routed" && t.category === "technical" && t.priority === "high" && t.applied.category === "technical" && t.applied.priority === "high" && ticket(T1)?.category === "technical" && ticket(T1)?.priority === "high" && ticket(T2)?.category === "general" && ticket(T2)?.priority === "medium" && t.owner === "data_steward" && t.routedTo === "data_steward" && t.answerDelivered && answerBells.length === 1 && answerBells[0].user_id === AG_U && answerBells[0].brokerage_id === B && evidence().length === 1 && evidence()[0].brokerage_id === B && signals().length === 1 && sig?.to_manager === "data_steward" && sig?.brokerage_id === B && modelCalls.length === 1 && modelCalls[0].brokerageId === B && modelCalls[0].platformPaid === false && replay.model === "replayed" && signals().length === 1 && evidence().length === 1 && refusedLane.ok && refusedLane.model === "heuristic" && /refused/.test(refusedLane.modelNote ?? "") && modelCalls.length === 1 && refusedLane.routedTo === "data_steward" && summary?.category === "technical" && summary?.model === "routed" && consumer === null && /not on this tenant/.test(String(crossTenant)) && (svc.tables.manager_signals ?? []).every((s) => s.brokerage_id !== B2) && /triageSupportTicket\(/.test(createBody) && createBody.indexOf(".insert(") >= 0 && createBody.indexOf(".insert(") < createBody.indexOf("triageSupportTicket("), `${t.model}/${t.category}/${t.priority} → ${t.routedTo}; replay ${replay.model}; refused lane ${refusedLane.model}; ${t.error ?? "no error"}`)
      continue
    }
    if (/EDUCATION/.test(h.contract)) {
      const { buildSupportSignals, classifySupportQuestion } = await import("../../lib/education/question-gap")
      const { detectKnowledgeGaps } = await import("../../lib/education/knowledge-gap-detector")
      const R = await import("../../lib/education/repeat-measure")
      const { EDUCATION_PROPOSED_EVENT } = await import("../../lib/education/curriculum-author")
      const five = Array.from({ length: QUESTION_MIN_ASKERS }, (_, i) => ({ subject: `How do I send the listing forms for e-sign? (${i + 1})`, description: "The FormWizard e-sign step" }))
      const supportSignals = buildSupportSignals([...five, { subject: "Where is the CDA form?" }, { subject: "hello there, friend" }])
      const supportGaps = detectKnowledgeGaps(supportSignals)
      // The proposal's own counter for M1 (the author stamps repeats_before on education.gap_proposed); M2 is re-gathered.
      ;(svc.tables.lifecycle_events ??= []).push({ id: uuid(), brokerage_id: B, event_type: EDUCATION_PROPOSED_EVENT, entity_type: "learning_module", entity_id: M1, metadata: { repeats_before: 5, topic_key: "support:forms_esign" }, created_at: daysAgo(100) })
      const gather = async (_svc: unknown, _b: string, _until: Date, opts: { window: { since: Date; until: Date } }) => {
        const afterPublish = opts.window.since.getTime() >= Date.parse(daysAgo(101))
        return [{ topicKey: "support:forms_esign", weakCount: afterPublish ? 1 : 5 }, { topicKey: "support:cda", weakCount: afterPublish ? 6 : 3 }]
      }
      const measured = await R.measureEducationRepeats(svc as never, { brokerageId: B }, { gather, now: new Date() })
      const again = await R.measureEducationRepeats(svc as never, { brokerageId: B }, { gather, now: new Date() })
      const repeatRows = (svc.tables.lifecycle_events ?? []).filter((e) => e.event_type === R.EDUCATION_REPEAT_EVENT)
      const trendOf = (id: string) => (repeatRows.find((e) => e.entity_id === id)?.metadata as Record<string, unknown> | undefined)
      const findings = (svc.tables.manager_signals ?? []).filter((s) => s.signal_type === R.EDUCATION_REPEAT_SIGNAL_TYPE)
      const authorSrc = strippedRepo("lib/education/curriculum-author.ts") ?? "", eduCron = strippedRepo("app/api/cron/education-delivery/route.ts") ?? "", recruitCron = strippedRepo("app/api/cron/recruit-outreach/route.ts") ?? ""
      c.step(`${h.lane} landed (${at}) — EDUCATION INTELLIGENCE: ${QUESTION_MIN_ASKERS} support tickets on the same PRODUCT subject (sending forms for e-sign) cluster into ONE support:forms_esign gap signal with de-identified evidence, a single CDA question and a greeting never do; the detector turns it into a gap the author answers with a help article; the gatherer READS support_tickets (its refusal read, never a thrown sweep) under the EDUCATION cron (education-delivery hosts the author + the repeat measure; recruit-outreach no longer calls the author); the REPEAT MEASURE re-counts each published AI lesson's topic before / after publication — the e-sign lesson DECREASED (5 → 1, baseline from the proposal row: evidence, no finding) and the CDA lesson INCREASED (3 → 6, re-gathered: evidence + ONE education_repeat_finding to the education owner ${R.EDUCATION_REPEAT_OWNER}); the second measure skips both (once per asset); the pure trend: decreased / unchanged / increased / no_baseline`, supportSignals.length === 1 && supportSignals[0].topicKey === "support:forms_esign" && supportSignals[0].source === "support" && supportSignals[0].weakCount === QUESTION_MIN_ASKERS && supportSignals[0].evidence.length === 5 && supportGaps.length === 1 && classifySupportQuestion("where is the CDA form")?.topic === "cda" && classifySupportQuestion("hi") === null && measured.modules === 2 && measured.measured === 2 && measured.decreased === 1 && measured.findings === 1 && measured.errors.length === 0 && trendOf(M1)?.trend === "decreased" && trendOf(M1)?.baseline_source === "proposal_row" && trendOf(M1)?.before === 5 && trendOf(M1)?.after === 1 && trendOf(M2)?.trend === "increased" && trendOf(M2)?.baseline_source === "regathered" && findings.length === 1 && findings[0].entity_id === M2 && findings[0].to_manager === R.EDUCATION_REPEAT_OWNER && again.measured === 0 && again.skipped === 2 && R.repeatTrend(null, 3) === "no_baseline" && R.repeatTrend(5, 1) === "decreased" && R.repeatTrend(3, 3) === "unchanged" && R.repeatTrend(3, 6) === "increased" && /\.from\(\s*["']support_tickets["']\s*\)/.test(authorSrc) && /tickets\.error/.test(authorSrc) && /buildSupportSignals/.test(authorSrc) && /runCurriculumAuthorAll\s*\(/.test(eduCron) && /runEducationRepeatMeasureAll\s*\(/.test(eduCron) && !/runCurriculumAuthorAll\s*\(/.test(recruitCron), `measured ${JSON.stringify(measured)}; again ${JSON.stringify({ measured: again.measured, skipped: again.skipped })}`)
      continue
    }
    // The registered proof + the tenant-facing gate.
    const { tenantFacingGate } = await import("../../lib/support/ticket-triage")
    const pkg = readRepo("package.json") ?? "", guardSrc = strippedRepo(at) ?? "", registry = strippedRepo("lib/kernel/manager-registry.ts") ?? ""
    c.step(`${h.lane} landed (${at}) — test:ai-by-your-side is REGISTERED and on the guard chain, owned in MAINTENANCE_DOMAINS (ai_by_your_side → data_steward, the proof named, co-owners named), and the proof drives the triage module, the education loop and the per-audience surfaces; the live-avatar session is metered (asserted above); the tenant-facing gate refuses 'platform-covered', a price and a provider internal, and admits a plain sentence — a platform-paid provider reads as a sanitized status`, /"test:ai-by-your-side":/.test(pkg) && /npm run test:ai-by-your-side\b/.test(pkg) && /ai_by_your_side:\s*\{\s*manager:\s*["']data_steward["'],\s*proof:\s*["']test:ai-by-your-side["']/.test(registry) && /ticket-triage/.test(guardSrc) && /repeat-measure|curriculum-author/.test(guardSrc) && !tenantFacingGate("This feature is platform-covered for you.").ok && !tenantFacingGate("It costs $49 a month.").ok && !tenantFacingGate("PGRST204 on the insert").ok && tenantFacingGate("Check the MLS connection under Settings and run the sync again.").ok, "")
  }
  c.blind("No provider is reached: the live session is the metering row (D-ID / Simli / ElevenLabs are not called; test:did-live-agent / platform-live-agent hold them); the triage's model lane is a seam (the routed call is test:ai-by-your-side's), the help base is one in-memory article, the repeat measure's gatherer is injected (the live gatherer's chat embed is PGRST grammar the fake does not speak — its support_tickets read is asserted on stripped source). The chat routes need a session and are asserted on stripped source. The 'platform-covered' census is a text finder on app/ (JSX text kept, comments stripped).")
  const cl = await cleanupCanary(svc, B), cl2 = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length + cl2.mismatches.length === 0 && cl.residual + cl2.residual === 0, [...cl.cleanup, ...cl2.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...cl.cleanup, ...cl2.cleanup], cl.residual + cl2.residual)
}
