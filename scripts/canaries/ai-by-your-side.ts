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
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-ai` }],
    users: [{ id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null }],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true, created_at: nowIso() }],
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
  console.log(`    measured: model call / triage in support code = ${modelInSupport ? "yes" : "NO (SLA timing only)"}; curriculum-author reads support_tickets = ${/support_tickets/.test(author) ? "yes" : "no"}; runs from recruit-outreach cron = ${/runCurriculumAuthorAll/.test(host) ? "yes (odd host)" : "no"}`)

  // ── WAVE142 HOOK (integrator): 142G — support AI triage; support subjects into the gap loop under the education cron; test:ai-by-your-side. ──
  for (const h of hooksFor("ai-by-your-side")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /TRIAGE/.test(h.contract) ? "measured above: no model call in app/actions/support.ts or lib/support/*; SLA timing is the only automation" : /EDUCATION/.test(h.contract) ? "measured above: the gap loop reads chat / compliance / drills, not support_tickets, from the recruit-outreach cron" : "measured: test:ai-by-your-side is not registered"); continue }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary (WAVE142 HOOK (integrator): ${h.lane}): ${/TRIAGE/.test(h.contract) ? "create a ticket with the model lane stubbed and assert category / priority / owner suggestion, the manager signal and the evidence row under the ticket's tenant only" : /EDUCATION/.test(h.contract) ? "feed 5 tickets with the same subject and assert the gap signal + the proposed asset with its 'repeats decreased?' measure" : "run the registered proof's seam"}`, false, h.contract.slice(0, 120))
  }
  c.blind("No provider is reached: the live session is the metering row (D-ID / Simli / ElevenLabs are not called; test:did-live-agent / platform-live-agent hold them). The chat routes need a session and are asserted on stripped source. The 'platform-covered' census is a text finder on app/ (JSX text kept, comments stripped).")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
