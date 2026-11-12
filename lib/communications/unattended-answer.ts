// lib/communications/unattended-answer.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT C24 — THE UNATTENDED ANSWER (wave 148, lane 148I; owner ruling 16, 2026-11-01):
//   "if the human hasn't responded and too much time has elapsed, then AI can answer for them. Remember, the OS is supposed
//    to be autonomous as much as the OS can."
// WAVE 149 (lane 149C, owner ruling 8 — "the AI may answer when a human doesn't, through the arbiter"): after the locks below
// clear, the ARBITER (lib/ai-isa/followup-arbiter.ts arbitratePlannedTouch, brief ARBITER_UNATTENDED_SYSTEM) decides how the team
// answers: a written answer on the channel the client used — text, EMAIL or the PORTAL (no longer text only) — that answer plus a
// personal video update from their agent (the Asset Manager's reel rail), or a person after all. The written answer is the
// fallback, so an outage keeps C24's behaviour.
//
// WHERE IT SITS. A text the arbiter handed to a PERSON (the responder's reply-coach draft / an agent task — contract C13)
// opens an `awaiting_human` completion (C14). When that window passes with no human action, the owning manager's supervision
// loop (lib/kernel/completion-tracking.ts superviseCompletion → detection `incomplete_follow_up`) calls
// respondWhenHumanSilent — this module, HANDED IN by the composition roots (the durable timer, the cron net) exactly as the
// inbound redriver is, so the supervisor never imports the chain. The event + the durable timer drive it; the cron net only
// recovers what they missed.
//
// THE AUTHORITY (ruling 16: "within delegated authority"). The AI answers for the person ONLY:
//   · after the human window (the completion's due time — the person had their chance first);
//   · on a question it may answer: STATUS, VERIFIED INFORMATION, COMMON QUESTIONS, NEXT STEPS (classifyUnattendedQuestion —
//     a deterministic lock BEFORE any model call);
//   · NEVER approval, signature, money or a legal question — those wait for the person (and the admins are told);
//   · from VERIFIED facts only (the deal's status / stage / closing dates / the next client-visible milestone — each fact
//     carries its source; nothing is invented, no price, no commission, no money figure);
//   · under the tenant's delegated authority: the autonomy gate (platform + tenant halts, the authority ladder at
//     COMMUNICATION, an explicit approval_required posture holds it) and then the ONE SMS chokepoint (dispatchSms —
//     suppression, TCPA consent, quiet hours, de-confliction, content backstop, budget, at-most-once per inbound);
//   · never to a texter met in that very message, a contact on do-not-contact or with AI paused;
//   · the composed answer is screened (screenUnattendedDraft + the content-safety screen) — a draft that approves, commits
//     money or advises on law is refused, never sent.
// The outcome is EVIDENCE on the completion (decision → awaiting the provider's delivery report), one ledger row
// (inbound.unattended.answer — who, why, which facts, which policy, cost), and the person it was handed to is told what was
// said for them. Server-side only (route / workflow composition roots) — never imported by a page.

import type { CompletionRow, RecoverySource } from "@/lib/kernel/completion-tracking"

type Svc = { from: (t: string) => any }

// ── 1. The scope (pure) ─────────────────────────────────────────────────────────────────────────

/** @proofSeam the guard asserts the scope is exactly ruling 16's four topics; production reads it inside this module (the brief's schema). */
export const UNATTENDED_ANSWER_TOPICS = ["status", "verified_information", "common_question", "next_steps"] as const
type UnattendedTopic = (typeof UNATTENDED_ANSWER_TOPICS)[number]
/** What the AI never answers in a person's place (ruling 16).
 *  @proofSeam the guard proves every never-topic has a lock; production reads it inside classifyUnattendedQuestion. */
export const NEVER_UNATTENDED_TOPICS =["approval", "signature", "money", "legal"] as const
type NeverUnattendedTopic = (typeof NEVER_UNATTENDED_TOPICS)[number]

/** @proofSeam scripts/unattended-answer-guard.ts drives every lock with a specimen and a look-alike. */
export const NEVER_UNATTENDED_LOCKS: Readonly<Record<NeverUnattendedTopic, RegExp>> = Object.freeze({
  approval: /\b(approv\w*|accept\w*\b[^.?!]{0,40}\b(?:offer|counter|terms|price|deal|contract)|counter[- ]?offer|go\s+ahead\s+with|green[- ]?light|authori[sz]\w*|okay\s+to\s+(?:sign|accept|proceed)|ok\s+to\s+(?:sign|accept|proceed))\b/i,
  signature: /\b(sign(?:ed|ing|ature|atures)?|e-?sign\w*|docusign|dotloop|initial(?:s|ed)?\s+(?:the|here|this|page)|countersign\w*)\b/i,
  money: /(\$\s?\d|\b\d[\d,]*\s?(?:k|dollars?)\b|\b(price|pricing|offer\s+amount|commission|earnest|deposit|wire|wiring|payment|pay\s+(?:for|the|you)|refund|fees?|credit|concession|closing\s+costs?|cash\s+to\s+close|down\s+payment|interest\s+rate|appraised?\s+(?:value|at)|how\s+much|cost)\b)/i,
  legal: /\b(attorney|lawyer|legal\w*|lawsuit|sue|suing|liab\w*|breach\w*|terminat\w*\s+(?:the\s+)?contract|cancel\w*\s+(?:the\s+)?contract|back\s+out|contract\s+(?:terms?|clause)|contingenc\w+\s+(?:waive|remov)\w*|waive\w*|disclos\w*|fair\s+housing|discriminat\w*|cease\s+and\s+desist)\b/i,
})
/** A complaint / distress is a person's job too (same words the responder locks on). */
const RISK_LOCK = /\b(complain\w*|scam|fraud|harass\w*|report\s+(?:you|this)|angry|furious|upset\s+with)\b/i

const TOPIC_HINTS: ReadonlyArray<[UnattendedTopic, RegExp]> = [
  ["next_steps", /\b(what(?:'s| is)?\s+next|next\s+step|what\s+do\s+(?:i|we)\s+(?:need|do)|what\s+should\s+(?:i|we))\b/i],
  ["status", /\b(status|update|where\s+are\s+we|how(?:'s| is)\s+it\s+going|any\s+news|progress|still\s+on\s+track|when\s+(?:do|will|are)\s+we\s+close|closing\s+date|close\s+on)\b/i],
  ["verified_information", /\b(when\s+is|what\s+time|address|where\s+is|which\s+day|what\s+day|date\s+of)\b/i],
]

type UnattendedClassification = { allowed: true; topic: UnattendedTopic } | { allowed: false; topic: NeverUnattendedTopic | "risk" | "empty"; reason: string }

/** PURE — may the AI answer THIS message in a person's place? The deterministic lock runs before any model. */
function classifyUnattendedQuestion(body: string | null | undefined): UnattendedClassification {
  const text = String(body ?? "").trim()
  if (!text) return { allowed: false, topic: "empty", reason: "nothing was asked" }
  if (RISK_LOCK.test(text)) return { allowed: false, topic: "risk", reason: "a complaint or distress — a person answers it" }
  for (const t of NEVER_UNATTENDED_TOPICS) {
    if (NEVER_UNATTENDED_LOCKS[t].test(text)) return { allowed: false, topic: t, reason: `a question about ${t === "money" ? "money" : t === "legal" ? "a legal matter" : t} — never answered in a person's place; it waits for them` }
  }
  for (const [topic, re] of TOPIC_HINTS) if (re.test(text)) return { allowed: true, topic }
  return { allowed: true, topic: "common_question" }
}

/** PURE — a composed answer that approves, commits money, signs or advises on law is refused (never sent). */
function screenUnattendedDraft(text: string): string[] {
  const t = String(text ?? "")
  const out: string[] = []
  if (/(\$\s?\d|\b\d[\d,]*\s?(?:k|dollars?)\b|\bcommission\b|\bearnest\s+money\s+of\b)/i.test(t)) out.push("money: the answer names an amount or a commission")
  if (/\b(i|we)\s+(?:have\s+)?(?:approved|accepted|agree(?:d)?\s+to|authori[sz]ed|signed)\b|\byou(?:'re| are)\s+approved\b|\bit(?:'s| is)\s+approved\b/i.test(t)) out.push("approval: the answer approves, accepts or signs for someone")
  if (/\b(?:legally|the\s+law\s+(?:requires|says)|you\s+(?:can|should)\s+(?:sue|terminate|back\s+out)|your\s+legal\s+rights?)\b/i.test(t)) out.push("legal: the answer gives a legal opinion")
  if (/\bguarantee\w*\b/i.test(t)) out.push("promise: the answer guarantees an outcome")
  return out
}

/** PURE — the human window: after the completion's due time (the person had their chance first), and only once. */
function decideUnattendedAnswer(input: {
  completion: Pick<CompletionRow, "kind" | "stage" | "status" | "due_at" | "context">
  now: Date
  /** Optional tenant window in minutes since the hand-off; the completion's due time wins when later. */
  windowMinutes?: number | null
  handedOffAt?: string | null
}): { answer: true } | { answer: false; reason: string } {
  const c = input.completion
  if (c.stage !== "awaiting_human") return { answer: false, reason: `the obligation is at ${c.stage}, not waiting on a person` }
  if (c.kind !== "inbound_response") return { answer: false, reason: `a ${c.kind} completion has no inbound message to answer` }
  if (typeof c.context?.record_id !== "string") return { answer: false, reason: "no inbound message id on the completion" }
  const due = Date.parse(c.due_at)
  const handed = Date.parse(input.handedOffAt ?? "")
  const windowEnd = Number.isFinite(handed) && typeof input.windowMinutes === "number" && input.windowMinutes > 0 ? Math.max(due, handed + input.windowMinutes * 60_000) : due
  if (!Number.isFinite(windowEnd) || input.now.getTime() < windowEnd) return { answer: false, reason: "the person's window has not passed yet" }
  return { answer: true }
}

// ── 2. The verified facts (each with its source; no money) ────────────────────────────────────────

interface VerifiedFact { fact: string; source: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The facts the AI may rely on for THIS person — their own deal, its status, closing dates and next client-visible step. */
async function loadVerifiedFacts(svc: Svc, brokerageId: string, contactId: string): Promise<{ facts: VerifiedFact[]; blindSpots: string[] }> {
  const facts: VerifiedFact[] = []
  const blindSpots: string[] = []
  if (!UUID.test(contactId)) return { facts, blindSpots: ["the contact id is not a uuid — no facts read"] }
  const { data: txns, error } = await svc.from("transactions")
    // Wave 149Z (lane 149G Outside-lane 1, C33): the m927 contractual columns ride the read, so resolveClosingDates can say
    // "on or before" and use the confirmed actual day instead of guessing from the legacy close_date.
    .select("id, status, stage, property_address, close_date, estimated_close_date, contract_closing_date, contract_closing_terms, contract_closing_source, actual_close_date, property_state, financing_type")
    .eq("brokerage_id", brokerageId).is("deleted_at", null)
    .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
    .not("status", "in", "(lost,archived)").limit(3)
  if (error) { blindSpots.push(`the person's deal could not be read (${error.message})`); return { facts, blindSpots } }
  const { statusLabel } = await import("@/lib/kernel/status-override")
  const { resolveClosingDates } = await import("@/lib/transactions/closing-dates")
  for (const t of (txns ?? []) as Array<Record<string, string | null>>) {
    const where = t.property_address ? ` for ${t.property_address}` : ""
    facts.push({ fact: `Their transaction${where} is ${statusLabel("transaction", t.status)}${t.stage ? ` (stage: ${t.stage.replace(/_/g, " ").toLowerCase()})` : ""}.`, source: `transactions:${t.id}` })
    const dates = resolveClosingDates(t)
    if (dates.actual) facts.push({ fact: `It closed on ${dates.actual.date}.`, source: `transactions:${t.id}.actual` })
    else if (dates.anticipated) facts.push({ fact: `The expected closing day is ${dates.anticipated.date}${dates.contractual?.terms === "on_or_before" ? ` (the contract says on or before ${dates.contractual.date})` : ""}.`, source: `transactions:${t.id}.closing_dates` })
    // A permission the contract gives, never a promise of an earlier day (C33).
    if (!dates.actual && dates.earlierClosing?.allowed === true) facts.push({ fact: "The contract allows closing before that day if every party is ready; no earlier day has been set.", source: `transactions:${t.id}.contract_closing_terms` })
    const { data: ms, error: msErr } = await svc.from("transaction_milestones").select("milestone_name, title, target_date, status")
      .eq("brokerage_id", brokerageId).eq("transaction_id", t.id).eq("is_client_visible", true).neq("status", "completed").order("target_date", { ascending: true, nullsFirst: false }).limit(2)
    if (msErr) blindSpots.push(`the next steps could not be read (${msErr.message})`)
    for (const m of (ms ?? []) as Array<{ milestone_name: string | null; title: string | null; target_date: string | null }>) {
      facts.push({ fact: `Next step: ${(m.title ?? m.milestone_name ?? "a milestone").replace(/_/g, " ")}${m.target_date ? ` (target ${String(m.target_date).slice(0, 10)})` : ""}.`, source: `transaction_milestones:${t.id}` })
    }
  }
  if (facts.length === 0) blindSpots.push("no open deal is on file for this person — the answer can only acknowledge and say their agent will follow up")
  return { facts, blindSpots }
}

// ── 3. The expert brief ──────────────────────────────────────────────────────────────────────────

/** The system brief (owner standard 2026-11-01: an expert in every detailed area, kind and neighbourly).
 *  @proofSeam the guard asserts every section of the brief; production hands it to the model inside respondWhenHumanSilent. */
export const UNATTENDED_ANSWER_SYSTEM = [
  "ROLE — You are the AI assistant on a real-estate agent's team, answering ONE text from their client because the agent has not been able to reply in time. You speak for the agent's business: warm, neighbourly, specific, never salesy. You are the first line of defence and a reflection on the agent — it is about the client.",
  "BUSINESS CONTEXT — The client wrote in; the reply was handed to their agent first and the agent's window has passed. Your job is to keep them informed and at ease until the agent follows up: their deal's status, verified information, common questions, and the next steps.",
  "FACTS YOU MAY RELY ON — ONLY the numbered VERIFIED FACTS in the message (each carries its source) and the client's own words. If the facts do not answer the question, say so kindly and that their agent will follow up.",
  "WHAT YOU MUST NOT INVENT — dates, times, people, documents, outcomes, or anything not in the facts. Never state a price, an amount, a commission, a fee or any money figure. Never guess a lender's, title company's or attorney's decision.",
  "THE DECISION YOU OWN — the words of one short reply (at most 3 sentences, plain text, no links unless a fact carries one), and which listed facts it used. You do NOT approve anything, accept or counter an offer, sign or say anything was signed, move money, or give legal advice — if the message needs any of those, set refuse=true.",
  "OUTPUT CONTRACT — JSON: { topic: 'status'|'verified_information'|'common_question'|'next_steps', answer: string, facts_used: number[] (the numbers of the facts you used), hands_back_to_agent: boolean (true when the agent must still follow up), refuse: boolean, refuse_reason: string|null }.",
  "COMPLIANCE BOUNDARY — Plain service communication to the client about their own matter: no advertising claims, no steering, no characterisation of people or neighbourhoods, nothing about anyone else's deal. Mention that their agent will follow up when the agent still needs to.",
  "ESCALATION RULE — refuse=true (a person answers) for approval, signatures, money, legal questions, a complaint or distress, or anything the facts cannot support. A refusal is always better than a guess.",
  "VOICE — first person plural on behalf of the agent's team (\"we\"), the client's first name if given, kind and calm; acknowledge what they asked before answering.",
].join("\n")

/**
 * WAVE 149 (lane 149C, owner ruling 8 — "the AI may answer when a human doesn't, through the arbiter, which can use any prompt in
 * the OS"): THE ARBITER'S DECISION BRIEF for the moment the person's window has passed. The deterministic locks above (scope,
 * never-topics, risk, do-not-contact, AI paused, a texter met in that message, delegated authority) have ALREADY cleared — the
 * arbiter decides HOW the team answers in the person's place: a written answer on the channel the client used, the written
 * answer plus a personal video update from their agent (the Asset Manager's reel rail — its own expert prompts write the
 * script; gated, sent on completion), or a person after all. Validated by the same closed-menu validator as every decision.
 * @proofSeam the guard asserts every section; production hands it to arbitratePlannedTouch inside respondWhenHumanSilent.
 */
export const ARBITER_UNATTENDED_SYSTEM = [
  "ROLE. You are the response judgment of a licensed real-estate team's AI desk lead. A client wrote to their agent, the reply was handed to the agent first, and the agent's window has passed with no answer. You decide how the team answers in the agent's place so the client is never left waiting — kind, specific, never salesy.",
  "BUSINESS CONTEXT. The question is one the platform already cleared as answerable without a person: the deal's status, verified information, a common question or the next steps. Money, approvals, signatures, legal questions, complaints and distress never reach you. The client is often anxious mid-transaction; a fast, calm, accurate answer protects the agent's reputation.",
  "FACTS YOU MAY RELY ON — ONLY the JSON given: moment (the channel the client used and the topic it was read as), evidence.relationship (whether an agent owns them), evidence.history, evidence.blindSpots (each is UNKNOWN, never 'fine'), the options with their reasons, and tenant_guidance. Never invent a fact, a date or a promise.",
  "THE DECISION YOU OWN — exactly ONE option id: 'answer_written' (a short written answer on the channel they used — the default for most questions); 'answer_with_video' when offered (the same written answer now, plus a short personal video update from their agent for a moment that deserves a face: a milestone reached, a closing approaching, reassurance after a delay — never for a quick factual question); or 'hold_for_person' (the agent answers after all — when the evidence says this relationship needs the agent's own voice, e.g. a long personal history or a blind spot on the deal). You do NOT write the words: the answer's own expert brief does that from verified facts, and a screen refuses any draft that names money, approves, signs or advises on law.",
  "ESCALATION RULE. Choose 'hold_for_person' when you are unsure, when a blind spot hides the deal's state, or when a machine-written answer could embarrass the agent. A slow human answer beats a confident wrong one — but silence is never an option you may choose.",
  "COMPLIANCE BOUNDARY. Service communication to a client about their own matter: no advertising claims, no steering, nothing about anyone else's deal. Consent, quiet hours, suppression and the channel's own gates decide at the send and cannot be changed by you.",
  "OUTPUT CONTRACT. Reply with JSON only: {\"optionId\": one menu id, \"channel\": one of that option's channels or null, \"format\": null, \"waitHours\": null, \"rationale\": 1-3 plain sentences a broker would accept, \"evidence\": [the top-level evidence keys you relied on, e.g. \"moment\", \"relationship\"], \"confidence\": 0..1}.",
].join("\n")

/** The channels an unattended answer can travel on, and their send path (C24 × ruling 8). Anything else → the person is reminded. */
const UNATTENDED_CHANNEL_OF: Readonly<Record<string, "sms" | "email" | "in_app">> = Object.freeze({ sms: "sms", text: "sms", email: "email", in_app: "in_app", portal: "in_app" })

// ── 4. The runtime ───────────────────────────────────────────────────────────────────────────────

interface UnattendedComposeOutput { topic: UnattendedTopic; answer: string; facts_used: number[]; hands_back_to_agent: boolean; refuse: boolean; refuse_reason: string | null }

interface UnattendedDeps {
  now?: Date
  windowMinutes?: number | null
  /** The delegated-authority check (default: lib/managers/autonomy-gate.ts — halts, ladder ≥ COMMUNICATION, posture). */
  authority?: (brokerageId: string) => Promise<{ allowed: boolean; reason: string | null }>
  compose?: (p: { brokerageId: string; system: string; prompt: string }) => Promise<{ object: UnattendedComposeOutput; costUsd?: number }>
  safety?: (text: string) => string[]
  facts?: typeof loadVerifiedFacts
  sendSms?: (p: { brokerageId: string; contactId: string; conversationId: string; agentId: string | null; recordId: string; text: string }) => Promise<{ sent: boolean; providerRef?: string | null; messageId?: string | null; error?: string }>
  /** Wave 149 (ruling 8): the email + portal send paths (default lib/communications/inbound-reply-executors.ts). */
  sendEmail?: (p: { brokerageId: string; contactId: string; conversationId: string; agentId: string | null; recordId: string; text: string; subject?: string | null }) => Promise<{ sent: boolean; providerRef?: string | null; messageId?: string | null; error?: string }>
  postPortal?: (p: { brokerageId: string; contactId: string; agentId: string | null; recordId: string; text: string }) => Promise<{ sent: boolean; providerRef?: string | null; messageId?: string | null; error?: string }>
  /** Wave 149 (ruling 8): the arbiter's model call (default: followup-arbiter's routed decision). */
  decide?: import("@/lib/ai-isa/followup-arbiter").ArbiterDecide
  /** Wave 149 (ruling 8): the personal video hand-off (default: the `contact_reel_handoff` signal to the Asset Manager). */
  requestVideo?: (svc: Svc, p: { brokerageId: string; contactId: string; topic: string; answer: string }) => Promise<{ requested: boolean; reason?: string }>
  notify?: (svc: Svc, p: { brokerageId: string; userId: string; title: string; body: string; contactId: string }) => Promise<void>
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
}

interface UnattendedResult { answered: boolean; reason: string; topic?: UnattendedTopic | NeverUnattendedTopic | "risk" | "empty"; providerRef?: string | null; channel?: string; outboundMessageId?: string | null; deliveryDueAt?: string | null; answer?: string; factsUsed?: VerifiedFact[]; costUsd?: number }

/**
 * C24 — after the human window, answer within delegated authority (status, verified info, common questions, next steps),
 * never approval / signature / money / legal. At-most-once per completion (ledger cycle `unattended:<completion>`) and per
 * inbound (dispatchSms's `inbound-reply:<record>` cycle). Never throws.
 */
async function respondWhenHumanSilent(svc: Svc, c: CompletionRow, deps: UnattendedDeps = {}): Promise<UnattendedResult> {
  const now = deps.now ?? new Date()
  try {
    const window = decideUnattendedAnswer({ completion: c, now, windowMinutes: deps.windowMinutes ?? null, handedOffAt: c.updated_at })
    if (!window.answer) return { answered: false, reason: window.reason }
    const recordId = c.context.record_id as string
    const { data: m, error } = await svc.from("messages").select("id, conversation_id, contact_id, body, metadata, created_at")
      .eq("id", recordId).eq("brokerage_id", c.brokerage_id).eq("direction", "inbound").maybeSingle()
    if (error) return { answered: false, reason: `the message could not be read (${error.message})` }
    if (!m) return { answered: false, reason: "the inbound message is not in this brokerage" }
    const msg = m as { id: string; conversation_id: string | null; contact_id: string | null; body: string | null; metadata: Record<string, unknown> | null }
    const channel = typeof msg.metadata?.channel === "string" ? (msg.metadata.channel as string) : typeof c.context.channel === "string" ? (c.context.channel as string) : "sms"
    // Wave 149 (ruling 8): every channel the arbiter may answer on — text, email, the portal. Anything else (a DM, a public
    // comment, a voice call) has no unattended path here: the person is reminded instead (said, never silently dropped).
    const answerChannel = UNATTENDED_CHANNEL_OF[channel.toLowerCase()] ?? null
    if (!answerChannel) return { answered: false, reason: `no unattended send path for ${channel} — the person is reminded instead` }
    if (!msg.contact_id || !msg.conversation_id) return { answered: false, reason: "an unidentified sender — never answered unattended" }

    const cls = classifyUnattendedQuestion(msg.body)
    if (!cls.allowed) return { answered: false, reason: cls.reason, topic: cls.topic }

    const { data: contact, error: cErr } = await svc.from("contacts").select("id, first_name, agent_id, dnc_status, ai_outreach_paused, source, created_at").eq("id", msg.contact_id).eq("brokerage_id", c.brokerage_id).maybeSingle()
    if (cErr) return { answered: false, reason: `the person could not be read (${cErr.message})` }
    if (!contact) return { answered: false, reason: "the person is not a contact of this brokerage" }
    const person = contact as { id: string; first_name: string | null; agent_id: string | null; dnc_status: boolean | null; ai_outreach_paused: boolean | null; source: string | null; created_at: string | null }
    if (person.dnc_status) return { answered: false, reason: "the person is on do-not-contact — a person decides" }
    if (person.ai_outreach_paused) return { answered: false, reason: "AI outreach is paused for this person" }
    const met = Date.parse(String(person.created_at ?? "")), wrote = Date.parse(String((m as { created_at?: string | null }).created_at ?? ""))
    if (person.source === "inbound_sms" && Number.isFinite(met) && Number.isFinite(wrote) && wrote - met <= 30 * 60_000) return { answered: false, reason: "a texter met in this very message — identification first, never an unattended answer" }

    const authority = await (deps.authority ?? defaultAuthority(svc))(c.brokerage_id)
    if (!authority.allowed) return { answered: false, reason: authority.reason ?? "the tenant's delegated authority does not cover an unattended answer" }

    const { facts, blindSpots } = await (deps.facts ?? loadVerifiedFacts)(svc, c.brokerage_id, person.id)

    // ── WAVE 149 (ruling 8): THE ARBITER decides how the team answers in the person's place (contract C29 — one judgment door).
    // Locks above have cleared; the menu is closed: a written answer on the client's channel, that answer plus a personal video
    // update from their agent (only with an agent to front it, and only for a status / next-steps moment), or a person after all.
    // The written answer is the fallback (an outage keeps C24's behaviour). Never approval / signature / money / legal — those
    // never reach this point.
    const videoOffered = !!person.agent_id && (cls.topic === "status" || cls.topic === "next_steps")
    const { arbitratePlannedTouch } = await import("@/lib/ai-isa/followup-arbiter")
    const arb = await arbitratePlannedTouch(svc, {
      brokerageId: c.brokerage_id, planner: "unattended_answer", subject: { type: "contact", id: person.id }, now,
      options: [
        { id: "answer_written", kind: "communication", channels: [answerChannel], why: [`a short ${cls.topic.replace(/_/g, " ")} answer from verified facts on the channel they used (${answerChannel})`] },
        ...(videoOffered ? [{ id: "answer_with_video", kind: "video" as const, channels: [answerChannel], why: ["the same written answer now, plus a short personal video update from their agent (gated; sent when it is ready)"] }] : []),
        { id: "hold_for_person", kind: "agent_intervention", channels: ["human_task"], why: ["their agent answers after all — the AI does not speak for them this time"] },
      ],
      planned: "answer_written", offerWait: false, system: ARBITER_UNATTENDED_SYSTEM,
      moment: { key: `unattended_${cls.topic}`, intent: `The client wrote on ${answerChannel}; their agent's window passed with no reply. Decide how the team answers for them (topic: ${cls.topic.replace(/_/g, " ")}).` },
      relationship: { type: "contact", persona: null, hasAssignedAgent: !!person.agent_id },
      history: { lastChannel: answerChannel },
      blindSpots: facts.length === 0 ? ["no open deal is on file for this person", ...blindSpots] : blindSpots,
    }, { decide: deps.decide })
    if (arb.decision.kind === "agent_intervention") return { answered: false, reason: `the arbiter kept this for a person: ${arb.decision.rationale}`.slice(0, 400), topic: cls.topic }
    const withVideo = arb.decision.kind === "video" && videoOffered

    const prompt = [
      `CLIENT FIRST NAME: ${person.first_name ?? "(not on file)"}`,
      `THEIR MESSAGE (verbatim): """${String(msg.body ?? "").slice(0, 600)}"""`,
      `READ AS: ${cls.topic.replace(/_/g, " ")}`,
      "VERIFIED FACTS:",
      ...(facts.length ? facts.map((f, i) => `${i + 1}. ${f.fact} [${f.source}]`) : ["(none on file)"]),
      ...(blindSpots.length ? [`NOT KNOWN: ${blindSpots.join("; ")}`] : []),
    ].join("\n")
    const compose = deps.compose ?? defaultCompose
    const out = await compose({ brokerageId: c.brokerage_id, system: UNATTENDED_ANSWER_SYSTEM, prompt })
    const o = out.object
    if (o.refuse) return { answered: false, reason: `the assistant declined: ${o.refuse_reason ?? "outside what it may answer"}`, topic: cls.topic, costUsd: out.costUsd }
    const answer = String(o.answer ?? "").trim().slice(0, 480)
    if (!answer) return { answered: false, reason: "no answer was composed", costUsd: out.costUsd }
    let screen: (t: string) => string[] = deps.safety ?? (() => [])
    if (!deps.safety) {
      const { evaluateContentSafety } = await import("@/lib/compliance/content-safety-checks")
      screen = (t) => evaluateContentSafety(t).map((v) => `${v.category}: ${v.phrase}`)
    }
    const violations = [...screenUnattendedDraft(answer), ...screen(answer)]
    if (violations.length > 0) return { answered: false, reason: `the composed answer was refused by the screen (${violations.join("; ").slice(0, 200)})`, topic: cls.topic, costUsd: out.costUsd }
    const used = (Array.isArray(o.facts_used) ? o.facts_used : []).map((n) => facts[Number(n) - 1]).filter((f): f is VerifiedFact => !!f)

    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    let result: UnattendedResult = { answered: false, reason: "this unattended answer was already given — never twice" }
    await ledger<UnattendedResult>(
      {
        brokerageId: c.brokerage_id, action: "inbound.unattended.answer", actor: { type: "manager", managerKey: "ai_isa" },
        subject: { type: "contact", id: person.id }, reasonCode: "CONVERSATION_RESPONSE",
        reasonDetail: `the person's window passed with no reply (completion ${c.id}) — answered a ${cls.topic.replace(/_/g, " ")} question within delegated authority`.slice(0, 500),
        cycle: `unattended:${c.id}`, channel: answerChannel, riskClass: "COMMUNICATION", systemSource: "unattended_answer", policyKey: "autonomy_tier:ai_isa",
        detail: { contract: "C24", completion_id: c.id, record_id: recordId, topic: cls.topic, facts_used: used, blind_spots: blindSpots, hands_back_to_agent: !!o.hands_back_to_agent, arbiter: { option: arb.choice, source: arb.decision.source, rationale: arb.decision.rationale, recorded: arb.recorded } },
      },
      async () => {
        const executors = async () => await import("./inbound-reply-executors")
        const base = { brokerageId: c.brokerage_id, contactId: person.id, agentId: person.agent_id, recordId, text: answer }
        const s = answerChannel === "email"
          ? await (deps.sendEmail ?? (async (p) => (await executors()).sendInboundEmailReply(svc as never, p)))({ ...base, conversationId: msg.conversation_id!, subject: typeof msg.metadata?.subject === "string" ? (msg.metadata.subject as string) : null })
          : answerChannel === "in_app"
            ? await (deps.postPortal ?? (async (p) => (await executors()).postInboundPortalReply(svc as never, p)))(base)
            : await (deps.sendSms ?? (async (p) => (await executors()).sendInboundSmsReply(svc as never, p)))({ ...base, conversationId: msg.conversation_id! })
        const { OVERDUE_HOURS } = await import("@/lib/outcomes/reconciliation")
        const overdue = (OVERDUE_HOURS as Record<string, number>)[answerChannel === "in_app" ? "sms" : answerChannel] ?? 6
        result = s.sent
          ? { answered: true, reason: `answered for the person after their window (${cls.topic}, ${answerChannel}${withVideo ? " + a personal video update requested" : ""})`, topic: cls.topic, providerRef: s.providerRef ?? null, channel: answerChannel, outboundMessageId: s.messageId ?? null, deliveryDueAt: s.providerRef ? new Date(now.getTime() + overdue * 3_600_000).toISOString() : null, answer, factsUsed: used, costUsd: out.costUsd }
          : { answered: false, reason: `the ${answerChannel === "sms" ? "text" : answerChannel === "email" ? "email" : "portal reply"} did not go (${s.error ?? "refused"})`, topic: cls.topic, costUsd: out.costUsd }
        return result
      },
      {
        settle: (r) => ({ status: r.answered ? "executed" : "failed", outcome: r.answered ? `unattended:${r.topic}` : "not_sent", error: r.answered ? null : r.reason, providerRef: r.providerRef ?? null, costUsd: r.costUsd ?? 0 }),
        replay: (claim) => (claim.kind === "refused" ? { answered: false, reason: `the action ledger refused (${claim.error}) — nothing was sent` } : result),
      },
      { client: svc as never },
    )
    if (result.answered && withVideo) {
      // Ruling 8: the personal video update rides the EXISTING reel rail (the Asset Manager commissions a situational reel
      // fronted by the agent — gated, compliance-first — and the Campaign Orchestrator sends it on completion). A refusal is said.
      const v = await (deps.requestVideo ?? defaultRequestVideo)(svc, { brokerageId: c.brokerage_id, contactId: person.id, topic: cls.topic, answer })
      result = { ...result, reason: v.requested ? result.reason : `${result.reason}; the video update was not requested (${v.reason ?? "refused"})` }
    }
    if (result.answered) {
      // The person it was handed to hears what was said for them (and their draft is no longer needed).
      const agentUserId = typeof c.context.agent_user_id === "string" ? (c.context.agent_user_id as string) : null
      if (agentUserId) await (deps.notify ?? defaultNotify)(svc, { brokerageId: c.brokerage_id, userId: agentUserId, contactId: person.id, title: "We answered for you while you were away", body: `${person.first_name ?? "Your client"} asked a ${cls.topic.replace(/_/g, " ")} question and your window passed, so we replied: "${answer}"${o.hands_back_to_agent ? " — they are expecting you to follow up." : ""}` })
      const draftId = typeof c.context.draft_id === "string" ? (c.context.draft_id as string) : null
      if (draftId) {
        const { error: dErr } = await svc.from("ai_message_drafts").update({ status: "dismissed", acted_at: now.toISOString() }).eq("id", draftId).eq("brokerage_id", c.brokerage_id).eq("status", "pending").select("id")
        if (dErr) console.warn(`[unattended-answer] the superseded draft ${draftId} stayed pending (${dErr.message})`)
      }
    }
    return result
  } catch (e) {
    return { answered: false, reason: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The answerers the completion supervisor's COMPOSITION ROOTS hand in (the durable timer, the cron net). */
export function unattendedAnswerers(deps: UnattendedDeps = {}): Partial<Record<CompletionRow["kind"], (svc: Svc, c: CompletionRow, trigger: RecoverySource) => Promise<UnattendedResult>>> {
  return { inbound_response: (svc, c) => respondWhenHumanSilent(svc, c, deps) }
}

function defaultAuthority(svc: Svc) {
  return async (brokerageId: string): Promise<{ allowed: boolean; reason: string | null }> => {
    try {
      const g = await import("@/lib/managers/autonomy-gate")
      const posture = await g.resolveManagerAutonomy(brokerageId, "ai_isa", svc as never)
      const authorityLevel = await g.resolveAgentAuthorityLevel(brokerageId, "ai_isa", svc as never)
      // Ruling 16: after the person's window, delegated authority is the gate's own verdict — halts, the ladder at
      // COMMUNICATION and an explicit approval_required posture hold; no explicit "autonomous" grant is required here.
      const d = g.autonomyDecision({ managerKey: "ai_isa", effective: posture, authorityLevel })
      return d.allow ? { allowed: true, reason: null } : { allowed: false, reason: d.reason }
    } catch (e) {
      return { allowed: false, reason: `delegated authority could not be read (${e instanceof Error ? e.message : String(e)}) — a person answers` }
    }
  }
}

async function defaultCompose(p: { brokerageId: string; system: string; prompt: string }): Promise<{ object: UnattendedComposeOutput; costUsd?: number }> {
  const [{ generateObjectRouted }, { z }] = await Promise.all([import("@/lib/ai/models"), import("zod")])
  const schema = z.object({
    topic: z.enum(UNATTENDED_ANSWER_TOPICS), answer: z.string().max(600), facts_used: z.array(z.number().int()).max(10),
    hands_back_to_agent: z.boolean(), refuse: z.boolean(), refuse_reason: z.string().max(300).nullable(),
  })
  const r = await generateObjectRouted({ feature: "ai_isa_response", brokerageId: p.brokerageId, system: p.system, prompt: p.prompt, schema, maxTokens: 400, temperature: 0.3 })
  return { object: r.object as UnattendedComposeOutput }
}

/** The personal video hand-off: the ISA → Asset Manager `contact_reel_handoff` signal the engage path already publishes (the
 *  handler fronts a situational reel with the assigned agent's avatar; deduped per open signal; gated). */
async function defaultRequestVideo(svc: Svc, p: { brokerageId: string; contactId: string; topic: string; answer: string }): Promise<{ requested: boolean; reason?: string }> {
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: p.brokerageId, fromManager: "ai_isa", toManager: "asset_manager", signalType: "contact_reel_handoff",
      message: `Answered a client's ${p.topic.replace(/_/g, " ")} question while their agent was away — front a short personal video update with the assigned agent.`,
      entityType: "contact", entityId: p.contactId, contactId: p.contactId,
    }, svc as never)
    return r.ok ? { requested: true } : { requested: false, reason: r.reason ?? "the hand-off was refused" }
  } catch (e) {
    return { requested: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

async function defaultNotify(svc: Svc, p: { brokerageId: string; userId: string; title: string; body: string; contactId: string }): Promise<void> {
  const { error } = await svc.from("notifications").insert({ user_id: p.userId, brokerage_id: p.brokerageId, type: "unattended_answer_sent", title: p.title.slice(0, 200), body: p.body.slice(0, 1000), entity_type: "contact", entity_id: p.contactId, contact_id: p.contactId, priority: "medium", channel: "in_app", is_read: false })
  if (error) console.error(`[unattended-answer] the agent's notice was refused: ${error.message}`)
}
