// lib/support/ticket-triage.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT TICKET AI TRIAGE (wave 142, lane 142G; owner: "ai by your side … support tickets … TICKET → AI
// TRIAGE → ACTUAL REGISTERED OWNER/SERVICE → SAFE REPAIR OR ANSWER → HUMAN ESCALATION WHERE REQUIRED →
// VERIFICATION → RESOLUTION").
//
// AUDITED FIRST (LAW 1) — what existed at HEAD fec8b6a95 and is REUSED here, never re-spelled:
//   · app/actions/support.ts createSupportTicket        — THE door (two lanes, m468); it calls triageSupportTicket
//                                                         right after its insert and its lane bells (in-request —
//                                                         nobody waits for a tick to learn the ticket was read)
//   · lib/ai/models.ts generateObjectRouted              — THE routed model lane (feature support_ticket_triage →
//                                                         Haiku class; cost booked to ai_tool_usage by the lane)
//   · lib/billing/billing-access.ts mayUseAndAfford      — the tenant lane's entitlement + budget gate ("ai.generate")
//   · lib/kernel/emit.ts emitKernelEvent                 — THE evidence row (support.ticket_triaged, audit-only)
//   · lib/kernel/action-ledger.ts withActionLedger       — LAW 5: who/why/which tool/what happened, idempotent per ticket
//   · lib/kernel/immediate-operations.ts reportOperationOutcome + handleOperationFailureEscalated
//                                                       — THE safe-repair path: a ticket that describes one of the ten
//                                                         immediate operations is reported as that operation's failed
//                                                         post-condition, so the REGISTERED owner re-verifies it with
//                                                         repair through the self-healing engine or hands it to a human
//   · lib/kernel/manager-signals.ts publishManagerSignal — THE bus: every other ticket reaches its registered owner
//                                                         (TRIAGE_OWNER_BY_CATEGORY) as an open signal the owner's
//                                                         inbox VERIFIES on the tick (handleSupportTicketTriaged)
//   · lib/support/support-sla.ts evaluateTicketSla       — the clock the verification step reads (breach → the SLA
//                                                         sweep owns the escalation; never a second escalator)
//   · knowledge_articles / help_topics_kb                 — the help base app/actions/support.ts searchHelp already
//                                                         serves; the AI's ANSWER is grounded in those rows or withheld
// What was MISSING (SURVIVORS142.md §1): no model call anywhere in the support code — a ticket got SLA timing and a
// bell, nothing read it. This module is that seam: ONE classifier (model with a deterministic fallback), ONE apply
// rule (category only when the submitter left the default; priority only ever RAISED), ONE evidence row, ONE route.
//
// TENANT-FACING TEXT (owner, wave 141/142): the signal message, the bell and the answer carry the tenant-facing
// sentence only — never "platform-covered", a credential, a price or a provider's internal error (tenantFacingGate
// refuses an answer that would). The raw model output lives in the evidence row, secrets redacted by the emitter.
//
// ISOLATION (lane A owns app/actions/support.ts callerReadsAllBrokerages + the ticket RLS): this module reads and
// writes ONLY the ticket it was handed, pinned to the brokerage the door resolved from the SESSION, and the bus
// routes within that tenant. Nothing here widens who may read a queue.
//
// Not server-only (the proof drives it end-to-end over scripts/in-memory-supabase.ts); every survivor is resolved by
// dynamic import so this module's own graph stays a leaf (it is imported statically by manager-signals.ts).

import { z } from "zod"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { ManagerSignal } from "@/lib/kernel/manager-signals"
import {
  IMMEDIATE_OPERATIONS, OPERATION_LABEL, OPERATION_OWNER, OPERATION_REPORTER, isImmediateOperation, type ImmediateOperation,
} from "@/lib/kernel/immediate-operations"
import {
  TICKET_CATEGORIES, TICKET_PRIORITIES, ticketPriorityRank, ticketAnsweredBy,
  type TicketCategory, type TicketLane, type TicketPriority,
} from "@/lib/support/ticket-constants"

type Svc = any

// ── 1. The vocabulary ─────────────────────────────────────────────────────────────────────────

/** AI_TASK_ROUTING key (lib/ai/models.ts) — short structured JSON, Haiku class. */
/** @proofSeam the proof asserts the key is a routing row */
export const SUPPORT_TRIAGE_FEATURE = "support_ticket_triage"
/** The bus vocabulary: ONE signal type, published FROM the operations reporter TO the ticket's registered owner. */
export const SUPPORT_TRIAGE_SIGNAL_TYPE = "support_ticket_triaged"
/** The lifecycle_events evidence row (audit-only; the bus routes, the reactor never fans it out). */
/** @proofSeam the proof reads the evidence rows by this type */
export const SUPPORT_TRIAGE_EVENT = "support.ticket_triaged"
/** The notification type the submitter receives when the AI's answer is grounded in the help base. */
/** @proofSeam the proof counts the submitter's bells by this type */
export const SUPPORT_AI_ANSWER_NOTIFICATION = "support_ai_answer"
/** The subject suffix every operation-opened ticket carries (the dedupe key beside the operation label). */
const OPERATION_TICKET_SUBJECT_SUFFIX = "needs attention"

/** The REGISTERED manager accountable for a ticket category when no immediate operation is named
 *  (TABLE_MANAGER support_tickets = data_steward; money → Finance; compliance → the Compliance Officer). */
/** @proofSeam the proof asserts each owner is a registered manager, never the reporter, with a SIGNAL_HANDLERS inbox */
export const TRIAGE_OWNER_BY_CATEGORY: Readonly<Record<TicketCategory, ManagerKey>> = Object.freeze({
  general:         "data_steward",
  technical:       "data_steward",
  billing:         "finance_manager",
  onboarding:      "data_steward",
  compliance:      "compliance_officer",
  feature_request: "data_steward",
})

/** Every registered consumer of SUPPORT_TRIAGE_SIGNAL_TYPE — derived from the owner map (§6: one vocabulary). */
export const SUPPORT_TRIAGE_CONSUMERS: readonly ManagerKey[] = Object.freeze([...new Set<ManagerKey>(Object.values(TRIAGE_OWNER_BY_CATEGORY))])

/** Deterministic hints: a ticket that describes one of the ten immediate operations names it, so the SAFE-REPAIR
 *  path (reportOperationOutcome → the owner re-verifies with repair) can run without a model. First match wins. */
const OPERATION_HINTS: ReadonlyArray<{ operation: ImmediateOperation; keywords: readonly string[] }> = [
  { operation: "invitation",                      keywords: ["invite", "invitation", "never arrived", "didn't get the email", "did not get the email", "resend"] },
  { operation: "phone_a2p",                       keywords: ["a2p", "10dlc", "phone number", "texting", "sms registration", "carrier registration"] },
  { operation: "website_creation",                keywords: ["website", "my site", "landing page is down", "domain"] },
  { operation: "billing_activation",              keywords: ["billing", "invoice", "charged", "subscription", "payment failed", "card declined"] },
  { operation: "seat_provisioning",               keywords: ["seat", "add a user", "add user", "new agent can't log in", "cannot log in", "can't log in"] },
  { operation: "transaction_provider_connection", keywords: ["dotloop", "docusign", "skyslope", "formsimplicity", "forms provider", "e-sign provider", "esign provider"] },
  { operation: "provider_connection",             keywords: ["mls", "integration", "connect", "connection", "api key", "oauth", "disconnected"] },
  { operation: "user_creation",                   keywords: ["user setup", "account setup", "my account", "profile missing"] },
  { operation: "brokerage_transfer",              keywords: ["transfer", "move my brokerage", "moving brokerage"] },
  { operation: "tenant_creation",                 keywords: ["workspace setup", "onboarding stuck", "setup incomplete"] },
]

const CATEGORY_HINTS: ReadonlyArray<{ category: TicketCategory; keywords: readonly string[] }> = [
  { category: "billing",         keywords: ["billing", "invoice", "charged", "charge", "subscription", "payment", "refund", "price", "seat"] },
  { category: "compliance",      keywords: ["compliance", "fair housing", "disclosure", "license", "audit", "violation", "tcpa", "can-spam", "respa"] },
  { category: "onboarding",      keywords: ["onboarding", "setup", "set up", "getting started", "invite", "invitation", "new agent", "first login"] },
  { category: "feature_request", keywords: ["feature request", "would be nice", "can you add", "please add", "suggestion", "wish"] },
  { category: "technical",       keywords: ["error", "bug", "broken", "crash", "not working", "doesn't work", "does not work", "fails", "failed", "can't", "cannot", "won't", "sync", "integration", "mls", "login", "log in", "website", "upload", "e-sign", "esign", "video", "render"] },
]

const URGENT_HINTS = ["closing today", "closing tomorrow", "wire", "cannot log in", "can't log in", "locked out", "down for everyone", "outage", "data loss", "deleted", "breach", "hacked"] as const
const HIGH_HINTS = ["urgent", "asap", "blocked", "stuck", "not working", "broken", "failed", "deadline", "closing", "client waiting", "today"] as const

// ── 2. Pure classification (the fallback when the model is dark, refused or late; the positive control) ──

interface HeuristicTriage {
  category: TicketCategory
  priority: TicketPriority
  operation: ImmediateOperation | null
}

/** PURE: category / priority / immediate operation from the ticket's own words. Deterministic, no model. */
/** @proofSeam the proof drives the fallback classifier directly (the positive control for every model-dark path) */
export function classifyTicketHeuristically(subject: string, description: string | null | undefined): HeuristicTriage {
  const text = `${subject ?? ""} ${description ?? ""}`.toLowerCase()
  const operation = OPERATION_HINTS.find((h) => h.keywords.some((k) => text.includes(k)))?.operation ?? null
  let category: TicketCategory = CATEGORY_HINTS.find((h) => h.keywords.some((k) => text.includes(k)))?.category ?? "general"
  if (operation === "billing_activation") category = "billing"
  else if (operation && category === "general") category = operation === "invitation" || operation === "seat_provisioning" || operation === "user_creation" || operation === "tenant_creation" ? "onboarding" : "technical"
  const priority: TicketPriority = URGENT_HINTS.some((k) => text.includes(k)) ? "urgent" : HIGH_HINTS.some((k) => text.includes(k)) ? "high" : "medium"
  return { category, priority, operation }
}

/** PURE: the apply rule — category only when the submitter left the default, priority only ever RAISED. */
/** @proofSeam the proof asserts the rule's four cells directly */
export function applyTriageRule(
  submitted: { category: string | null | undefined; priority: string | null | undefined },
  suggested: { category: TicketCategory; priority: TicketPriority },
): { category: TicketCategory | null; priority: TicketPriority | null } {
  const category = (!submitted.category || submitted.category === "general") && suggested.category !== "general" ? suggested.category : null
  const priority = ticketPriorityRank(suggested.priority) > ticketPriorityRank(submitted.priority) ? suggested.priority : null
  return { category, priority }
}

/** The phrases a TENANT may never read from the AI (owner: never "platform-covered"; never a credential, price
 *  or provider internals). Returns the first offending phrase, or null when the text is clean. */
const TENANT_FACING_FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/platform[- ]?covered/i, "the platform-pays phrase"],
  [/\b(api[_ -]?key|secret|password|token|bearer)\b/i, "credential vocabulary"],
  [/\b(sk_live|sk_test|whsec|pk_live)[a-z0-9_]*/i, "a key-shaped string"],
  [/\$\s?\d[\d,]*(\.\d+)?/, "a price"],
  [/\b(stack ?trace|exception|null pointer|ECONNREFUSED|PGRST\d{3}|42P01|42501)\b/i, "a provider / database internal"],
]
/** @proofSeam the proof forges each forbidden shape and a clean sentence */
export function tenantFacingGate(text: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  const t = (text ?? "").trim()
  if (!t) return { ok: false, reason: "empty" }
  for (const [re, why] of TENANT_FACING_FORBIDDEN) if (re.test(t)) return { ok: false, reason: `contains ${why}` }
  return { ok: true }
}

// ── 3. The help base: candidates the ANSWER must be grounded in ───────────────────────────────

interface HelpCandidate { id: string; source: "article" | "kb"; title: string; excerpt: string; score: number }

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "what", "when", "where", "does", "doesn", "into", "your", "about", "there", "their", "they", "them", "then", "than", "will", "would", "could", "should", "cant", "cannot", "wont", "dont", "didnt", "isnt", "please", "help", "need", "want", "trying", "tried", "still", "just", "very", "some", "more", "also"])
function tokens(text: string): string[] {
  return [...new Set((text ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).map((w) => w.replace(/^-+|-+$/g, "")).filter((w) => w.length >= 4 && !STOP.has(w)))]
}

/** PURE: rank help rows by keyword overlap with the ticket text (title ×2, body ×1); only positive scores. */
/** @proofSeam the proof ranks a fixture directly (an overlapping row kept, an unrelated row dropped) */
export function rankHelpCandidates(text: string, rows: Array<{ id: string; source: "article" | "kb"; title: string; body: string }>, limit = 5): HelpCandidate[] {
  const q = tokens(text)
  if (q.length === 0) return []
  const out: HelpCandidate[] = []
  for (const r of rows) {
    const title = (r.title ?? "").toLowerCase(), body = (r.body ?? "").toLowerCase()
    let score = 0
    for (const w of q) { if (title.includes(w)) score += 2; else if (body.includes(w)) score += 1 }
    if (score > 0) out.push({ id: r.id, source: r.source, title: r.title, excerpt: (r.body ?? "").slice(0, 240), score })
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit)
}

/** The help rows this tenant may read (platform-wide OR its own) — the same visibility rule as searchHelp. */
async function findHelpCandidates(svc: Svc, brokerageId: string, text: string, limit = 5): Promise<HelpCandidate[]> {
  const scope = `brokerage_id.is.null,brokerage_id.eq.${brokerageId}`
  const [{ data: articles, error: aErr }, { data: topics, error: tErr }] = await Promise.all([
    svc.from("knowledge_articles").select("id, title, excerpt, content, brokerage_id").eq("status", "published").or(scope).limit(200),
    svc.from("help_topics_kb").select("id, title, content, brokerage_id").eq("is_active", true).or(scope).limit(200),
  ])
  if (aErr) console.error("[ticket-triage] knowledge_articles read refused:", aErr.message)
  if (tErr) console.error("[ticket-triage] help_topics_kb read refused:", tErr.message)
  const rows = [
    ...((articles ?? []) as Array<Record<string, unknown>>).map((a) => ({ id: String(a.id), source: "article" as const, title: String(a.title ?? ""), body: String(a.excerpt ?? a.content ?? "") })),
    ...((topics ?? []) as Array<Record<string, unknown>>).map((t) => ({ id: String(t.id), source: "kb" as const, title: String(t.title ?? ""), body: String(t.content ?? "") })),
  ]
  return rankHelpCandidates(text, rows, limit)
}

// ── 4. The model contract ─────────────────────────────────────────────────────────────────────

const TriageSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  /** One of the ten immediate operations when the ticket describes one, else null. */
  operation: z.enum(IMMEDIATE_OPERATIONS).nullable(),
  /** One sentence for the answering human — what is wrong, in plain words. */
  summary: z.string().max(300),
  /** A short answer for the SUBMITTER grounded ONLY in the help candidates; null when none applies. */
  answer: z.string().max(900).nullable(),
  /** Candidate ids the answer relies on (must be a subset of the offered candidates). */
  groundedIn: z.array(z.string()).max(5),
  /** true when a human must act (account, money, legal, data, or nothing in the help base answers it). */
  needsHuman: z.boolean(),
  confidence: z.number().min(0).max(1),
})
export type TriageModelOutput = z.infer<typeof TriageSchema>

interface TriageInput {
  ticketId: string
  brokerageId: string
  lane: TicketLane
  subject: string
  description: string | null
  category: string | null
  priority: string | null
  submitterUserId: string | null
  /** The caller's user_type / platform_role (the entitlement actor) — never a tenant from the body. */
  actor?: { userType?: string | null; platformRole?: string | null } | null
}

interface TriageDeps {
  /** The routed model lane (default generateObjectRouted, feature support_ticket_triage). */
  model?: (p: { system: string; prompt: string; brokerageId: string; userId: string | null; platformPaid: boolean; manager: ManagerKey }) => Promise<TriageModelOutput>
  /** The tenant lane's entitlement + budget gate (default mayUseAndAfford "ai.generate"). */
  afford?: (p: { brokerageId: string; actor: TriageInput["actor"] }) => Promise<{ allowed: boolean; reason: string }>
  /** Milliseconds the request waits for the model before falling back to the heuristic (default 8000). */
  timeoutMs?: number
  now?: Date
}

interface TriageResult {
  ok: boolean
  /** How the verdict was reached: the routed model, the heuristic (and why), or a ledger replay. */
  model: "routed" | "heuristic" | "replayed"
  modelNote: string | null
  category: TicketCategory
  priority: TicketPriority
  applied: { category: TicketCategory | null; priority: TicketPriority | null }
  operation: ImmediateOperation | null
  owner: ManagerKey
  needsHuman: boolean
  summary: string
  answerDelivered: boolean
  answerWithheldReason: string | null
  helpCandidateIds: string[]
  evented: boolean
  lifecycleEventId: string | null
  signalId: string | null
  routedTo: ManagerKey | null
  error: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function priorityWord(p: TicketPriority): string { return p === "urgent" ? "urgent" : p === "high" ? "high priority" : p === "low" ? "low priority" : "normal priority" }

/** PURE: the tenant-facing feed sentence — the ticket's own subject, the verdict, who owes the reply. */
/** @proofSeam the proof asserts the sentence names the verdict and never a provider */
export function triageSentence(subject: string, category: TicketCategory, priority: TicketPriority, needsHuman: boolean, answered: boolean): string {
  const who = needsHuman ? "a person on the answering side owes the reply" : answered ? "the AI pointed to help articles; a person verifies" : "the AI read it; a person owes the reply"
  return `Support ticket “${subject.slice(0, 80)}” read as ${category.replace("_", " ")}, ${priorityWord(priority)} — ${who}.`.slice(0, 480)
}

const defaultModel: NonNullable<TriageDeps["model"]> = async (p) => {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const { object } = await generateObjectRouted({
    feature: SUPPORT_TRIAGE_FEATURE, schema: TriageSchema, system: p.system, prompt: p.prompt, maxTokens: 700, temperature: 0.1,
    brokerageId: p.brokerageId, userId: p.userId, platformPaid: p.platformPaid, manager: p.manager,
  } as any)
  return object as TriageModelOutput
}

const defaultAfford: NonNullable<TriageDeps["afford"]> = async (p) => {
  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const d = await mayUseAndAfford({ capability: "ai.generate", brokerageId: p.brokerageId, actor: p.actor ?? null })
  return { allowed: d.allowed, reason: d.reason }
}

function buildPrompt(input: TriageInput, candidates: HelpCandidate[]): { system: string; prompt: string } {
  const system = [
    "You are the support triage assistant inside a multi-tenant real-estate operating system.",
    "Classify ONE support ticket. Output JSON matching the schema and nothing else.",
    `category ∈ ${TICKET_CATEGORIES.join(" | ")}; priority ∈ ${TICKET_PRIORITIES.join(" | ")} (urgent = money moving today, a closing at risk, an outage or a security concern).`,
    `operation ∈ ${IMMEDIATE_OPERATIONS.join(" | ")} ONLY when the ticket describes that exact setup step failing (an invite that never arrived, a phone number not registering, a provider that will not connect, billing that did not activate, a website that was not created, a seat that cannot log in); otherwise null.`,
    "answer: write 2–4 sentences for the submitter ONLY from the help candidates offered (cite them in groundedIn). If no candidate answers the question, answer = null and groundedIn = [].",
    "needsHuman = true for anything about money, an account, legal or compliance, deleted data, a security concern, or when no candidate answers it.",
    "NEVER mention internal providers, credentials, prices, what the platform pays for, or stack traces. Never invent a feature or a setting that is not in a candidate. Plain, kind, specific.",
  ].join("\n")
  const cands = candidates.length
    ? candidates.map((c) => `- [${c.id}] ${c.title}: ${c.excerpt.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")
    : "- (none — the help base has nothing matching; answer must be null)"
  const prompt = [
    `Lane: ${input.lane === "tenant_to_platform" ? "the brokerage is asking the platform" : "a user is asking their own brokerage office"}`,
    `Submitted category: ${input.category ?? "general"} · submitted priority: ${input.priority ?? "medium"}`,
    `Subject: ${input.subject.slice(0, 200)}`,
    `Description: ${(input.description ?? "").slice(0, 1500) || "(none)"}`,
    "", "Help candidates:", cands,
  ].join("\n")
  return { system, prompt }
}

// ── 5. THE TRIAGE (called by the door, in-request) ───────────────────────────────────────────

/**
 * Read the ticket, decide category / priority / owner / operation, apply the safe half, leave evidence, route to
 * the registered owner (safe repair through the operations consumer when an operation is named), and answer the
 * submitter from the help base when the answer is grounded and tenant-safe. Never throws — the door already holds
 * its ticket id; a triage that could not run says so in the result and the evidence row.
 */
export async function triageSupportTicket(svc: Svc, input: TriageInput, deps: TriageDeps = {}): Promise<TriageResult> {
  const heuristic = classifyTicketHeuristically(input.subject, input.description)
  const out: TriageResult = {
    ok: false, model: "heuristic", modelNote: null, category: heuristic.category, priority: heuristic.priority,
    applied: { category: null, priority: null }, operation: heuristic.operation, owner: TRIAGE_OWNER_BY_CATEGORY[heuristic.category],
    needsHuman: true, summary: input.subject.slice(0, 200), answerDelivered: false, answerWithheldReason: null, helpCandidateIds: [],
    evented: false, lifecycleEventId: null, signalId: null, routedTo: null, error: null,
  }
  if (!UUID_RE.test(String(input.brokerageId ?? ""))) { out.error = "no tenant id — refused"; return out }
  if (!input.ticketId) { out.error = "no ticket id — refused"; return out }
  const platformLane = ticketAnsweredBy(input.lane) === "platform_support"

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<TriageResult>(
    {
      brokerageId: input.brokerageId, action: "support.ticket.triage",
      actor: { type: "manager", managerKey: OPERATION_REPORTER, userId: input.submitterUserId ?? null },
      subject: { type: "support_ticket", id: input.ticketId },
      reasonCode: "CONVERSATION_RESPONSE", reasonDetail: `AI triage of a ${input.lane} support ticket`,
      idempotencyKey: `support_triage:${input.ticketId}`, riskClass: "LOW_RISK_WRITE", channel: "support",
      detail: { lane: input.lane, feature: SUPPORT_TRIAGE_FEATURE },
    },
    async () => {
      // 1. The help base, then the model (tenant lane gated; platform lane on the platform's own ledger).
      const text = `${input.subject} ${input.description ?? ""}`
      const candidates = await findHelpCandidates(svc, input.brokerageId, text)
      out.helpCandidateIds = candidates.map((c) => c.id)
      let verdict: TriageModelOutput | null = null
      let gateNote: string | null = null
      if (!platformLane) {
        try {
          const g = await (deps.afford ?? defaultAfford)({ brokerageId: input.brokerageId, actor: input.actor ?? null })
          if (!g.allowed) gateNote = `tenant AI lane refused: ${g.reason}`
        } catch (e) { gateNote = `tenant AI gate threw: ${e instanceof Error ? e.message : String(e)}` }
      }
      if (!gateNote) {
        const { system, prompt } = buildPrompt(input, candidates)
        const timeoutMs = deps.timeoutMs ?? 8000
        try {
          const run = (deps.model ?? defaultModel)({ system, prompt, brokerageId: input.brokerageId, userId: input.submitterUserId ?? null, platformPaid: platformLane, manager: out.owner })
          const raced = await Promise.race<TriageModelOutput | "timeout">([run, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs))])
          if (raced === "timeout") out.modelNote = `model did not answer within ${timeoutMs}ms — heuristic used`
          else { verdict = TriageSchema.parse(raced); out.model = "routed" }
        } catch (e) { out.modelNote = `model unavailable (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}) — heuristic used` }
      } else out.modelNote = `${gateNote} — heuristic used (no model call)`

      // 2. Merge: the model's verdict, sanity-checked against the vocabulary; the heuristic otherwise.
      if (verdict) {
        out.category = verdict.category; out.priority = verdict.priority
        out.operation = verdict.operation && isImmediateOperation(verdict.operation) ? verdict.operation : null
        out.needsHuman = verdict.needsHuman; out.summary = verdict.summary.trim().slice(0, 300) || out.summary
      }
      out.owner = TRIAGE_OWNER_BY_CATEGORY[out.category] ?? "data_steward"

      // 3. Apply the SAFE half (counted — a zero-row update is a refusal, not a success; CLAUDE.md §3).
      out.applied = applyTriageRule({ category: input.category, priority: input.priority }, { category: out.category, priority: out.priority })
      if (out.applied.category || out.applied.priority) {
        const patch: Record<string, unknown> = { updated_at: (deps.now ?? new Date()).toISOString() }
        if (out.applied.category) patch.category = out.applied.category
        if (out.applied.priority) patch.priority = out.applied.priority
        const { data: upd, error } = await svc.from("support_tickets").update(patch).eq("id", input.ticketId).eq("brokerage_id", input.brokerageId).select("id")
        if (error) { out.error = `apply refused: ${error.message}`; out.applied = { category: null, priority: null } }
        else if (((upd ?? []) as unknown[]).length === 0) { out.error = "apply matched no row on this tenant"; out.applied = { category: null, priority: null } }
      }

      // 4. The ANSWER — grounded in the help base, tenant-safe, or withheld with the reason recorded.
      const answer = verdict?.answer?.trim() || null
      if (!answer) out.answerWithheldReason = verdict ? "the model found nothing in the help base that answers it" : "no model verdict"
      else if (candidates.length === 0 || !verdict!.groundedIn.some((id) => out.helpCandidateIds.includes(id))) out.answerWithheldReason = "answer not grounded in an offered help candidate"
      else {
        const gate = tenantFacingGate(answer)
        if (!gate.ok) out.answerWithheldReason = `answer withheld: ${gate.reason}`
        else if (!input.submitterUserId) out.answerWithheldReason = "no submitter to deliver to"
        else {
          const cited = candidates.filter((c) => verdict!.groundedIn.includes(c.id)).map((c) => c.title)
          const { error } = await svc.from("notifications").insert({
            user_id: input.submitterUserId, brokerage_id: input.brokerageId, type: SUPPORT_AI_ANSWER_NOTIFICATION,
            title: `Suggested help for “${input.subject.slice(0, 60)}”`,
            body: `${answer}${cited.length ? `\n\nSee: ${cited.join(" · ")}` : ""}`.slice(0, 900),
            entity_type: "support_ticket", entity_id: input.ticketId, priority: "medium", is_read: false,
          })
          if (error) out.answerWithheldReason = `delivery refused: ${error.message}`
          else out.answerDelivered = true
        }
      }

      // 5. Evidence — ONE audit row (the raw verdict, the gate notes, what was applied / withheld).
      try {
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        const ev = await emitKernelEvent({
          event: SUPPORT_TRIAGE_EVENT, brokerageId: input.brokerageId, entityType: "support_ticket", entityId: input.ticketId,
          actorUserId: input.submitterUserId ?? null, source: "system", auditOnly: true, client: svc,
          metadata: {
            lane: input.lane, model: out.model, model_note: out.modelNote, confidence: verdict?.confidence ?? null,
            category_suggested: out.category, priority_suggested: out.priority, category_applied: out.applied.category, priority_applied: out.applied.priority,
            operation: out.operation, owner: out.owner, needs_human: out.needsHuman, summary: out.summary,
            help_candidate_ids: out.helpCandidateIds, answer_delivered: out.answerDelivered, answer_withheld_reason: out.answerWithheldReason,
            answer: answer, grounded_in: verdict?.groundedIn ?? [], apply_error: out.error,
          },
        })
        out.evented = ev.inserted; out.lifecycleEventId = ev.lifecycleEventId
        if (ev.error) out.error = [out.error, `evidence row refused: ${ev.error}`].filter(Boolean).join("; ")
      } catch (e) { out.error = [out.error, `evidence row failed: ${e instanceof Error ? e.message : String(e)}`].filter(Boolean).join("; ") }

      // 6. Route — SAFE REPAIR through the operations consumer when an operation is named, else the owner's inbox.
      const sentence = triageSentence(input.subject, out.category, out.priority, out.needsHuman, out.answerDelivered)
      try {
        if (out.operation) {
          const { reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
          const r = await reportOperationOutcome(svc, {
            operation: out.operation, brokerageId: input.brokerageId, ok: false, subjectType: "support_ticket", subjectId: input.ticketId,
            evidence: { ticket_id: input.ticketId, lane: input.lane, category: out.category, priority: out.priority, triage_event_id: out.lifecycleEventId },
            error: `support ticket reports ${OPERATION_LABEL[out.operation]} did not hold: ${out.summary}`.slice(0, 400),
            actorUserId: input.submitterUserId ?? null, source: "ui",
            tenantFacing: `a support ticket reports it (“${input.subject.slice(0, 60)}”); the OS is re-checking and repairing it`,
            platformVisible: platformLane,
          })
          out.signalId = r.signalId; out.routedTo = r.routedTo
          if (r.routedTo) out.owner = r.routedTo
          if (r.error) out.error = [out.error, `operation route: ${r.error}`].filter(Boolean).join("; ")
        } else {
          const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
          const r = await publishManagerSignal({
            brokerageId: input.brokerageId, fromManager: OPERATION_REPORTER, toManager: out.owner,
            signalType: SUPPORT_TRIAGE_SIGNAL_TYPE, message: sentence, entityType: "support_ticket", entityId: input.ticketId,
            payload: {
              lane: input.lane, category: out.category, priority: out.priority, needs_human: out.needsHuman, summary: out.summary,
              answer_delivered: out.answerDelivered, help_candidate_ids: out.helpCandidateIds, lifecycle_event_id: out.lifecycleEventId, model: out.model,
            },
          }, svc)
          if (r.ok) { out.signalId = r.signalId ?? null; out.routedTo = out.owner }
          else out.error = [out.error, `route refused: ${r.reason}`].filter(Boolean).join("; ")
        }
      } catch (e) { out.error = [out.error, `route failed: ${e instanceof Error ? e.message : String(e)}`].filter(Boolean).join("; ") }

      out.ok = out.evented && out.routedTo !== null
      return out
    },
    {
      settle: (r) => ({ status: r.ok ? "executed" : "failed", outcome: r.ok ? `routed:${r.routedTo}${r.operation ? `:${r.operation}` : ""}:${r.model}` : "triage_incomplete", error: r.error }),
      replay: (claim) => ({ ...out, model: "replayed", modelNote: `ledger ${claim.kind} — this ticket was already triaged`, error: null }),
    },
    { client: svc },
  )
}

// ── 6. THE CONSUMER — VERIFICATION → RESOLUTION on the owner's tick (SIGNAL_HANDLERS `<owner>:support_ticket_triaged`) ──

/**
 * The owner manager's inbox re-reads the ticket (pinned to the tenant). A ticket a person has answered, or that is
 * resolved / closed, closes the AI's watch WITH the verification; a breached SLA is the sweep's to escalate (never a
 * second escalator); an open ticket nobody has answered yet stays OPEN on the feed as the owner's item (null).
 */
export async function handleSupportTicketTriaged(
  signal: Pick<ManagerSignal, "id" | "payload" | "entityId" | "createdAt">,
  ctx: { brokerageId: string; supabase: Svc },
  deps: { now?: Date } = {},
): Promise<string | null> {
  const svc = ctx.supabase
  const ticketId = signal.entityId
  if (!ticketId) return `no ticket on the signal — nothing to verify (watch closed)`
  const { data, error } = await svc.from("support_tickets")
    .select("id, status, first_response_at, resolved_at, created_at, priority, brokerage_id")
    .eq("id", ticketId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  if (error) { console.error("[ticket-triage] verification read refused:", error.message); return null }
  const t = data as { id: string; status: string | null; first_response_at: string | null; resolved_at: string | null; created_at: string; priority: string | null } | null
  if (!t) return `ticket ${ticketId} is not on this tenant — nothing to verify (watch closed)`
  if (t.status === "resolved" || t.status === "closed") return `verified: ticket is ${t.status}${t.resolved_at ? ` (${t.resolved_at})` : ""} — AI triage watch closed`
  if (t.first_response_at) return `verified: a person on the answering side replied at ${t.first_response_at} — AI triage watch closed`
  const { evaluateTicketSla } = await import("@/lib/support/support-sla")
  const sla = evaluateTicketSla({ created_at: t.created_at, priority: t.priority, status: t.status, first_response_at: t.first_response_at, resolved_at: t.resolved_at }, deps.now ?? new Date())
  if (sla.breaches.length > 0) return `SLA breached (${sla.breaches.join(", ")}) with no reply — the support SLA sweep owns that escalation; AI triage watch closed`
  return null
}

// ── 7. Read-back for the thread renderers (the answering humans see what the AI decided) ───────

export interface TicketTriageSummary {
  category: string | null
  priority: string | null
  owner: string | null
  operation: string | null
  summary: string | null
  needsHuman: boolean
  answerDelivered: boolean
  model: string | null
  createdAt: string
}

/** The latest triage evidence row for a ticket, or null when it was never triaged (older tickets, a refused row). */
export async function loadTicketTriage(svc: Svc, ticketId: string): Promise<TicketTriageSummary | null> {
  const { data, error } = await svc.from("lifecycle_events")
    .select("id, metadata, created_at")
    .eq("event_type", SUPPORT_TRIAGE_EVENT).eq("entity_type", "support_ticket").eq("entity_id", ticketId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) { console.error("[ticket-triage] evidence read refused:", error.message); return null }
  const row = data as { metadata?: Record<string, unknown> | null; created_at: string } | null
  if (!row) return null
  const m = row.metadata ?? {}
  return {
    category: (m.category_suggested as string | null) ?? null, priority: (m.priority_suggested as string | null) ?? null,
    owner: (m.owner as string | null) ?? null, operation: (m.operation as string | null) ?? null,
    summary: (m.summary as string | null) ?? null, needsHuman: m.needs_human !== false, answerDelivered: m.answer_delivered === true,
    model: (m.model as string | null) ?? null, createdAt: row.created_at,
  }
}

// ── 8. An operation escalation lands IN the ticket flow (owner: errors surface immediately; cron is fallback) ──

const OPERATION_TICKET_CATEGORY: Readonly<Record<ImmediateOperation, TicketCategory>> = Object.freeze({
  tenant_creation: "onboarding", user_creation: "onboarding", invitation: "onboarding", seat_provisioning: "onboarding",
  brokerage_transfer: "general", website_creation: "onboarding", provider_connection: "technical", billing_activation: "billing",
  phone_a2p: "technical", transaction_provider_connection: "technical",
})

/**
 * Open (or reuse) the ONE support ticket that tracks an escalated operation failure, so a human sees it in the
 * queue with its SLA clock and thread — not only a bell. Lane: platform-visible subjects go to platform support,
 * the rest to the brokerage's own office. Idempotent: an open ticket with the same subject on the tenant is reused.
 */
export async function ensureOperationTicket(svc: Svc, p: {
  brokerageId: string; operation: string; tenantFacing: string; platformVisible: boolean; actorUserId?: string | null; lifecycleEventId?: string | null
}): Promise<{ ticketId: string | null; created: boolean; error: string | null }> {
  if (!isImmediateOperation(p.operation)) return { ticketId: null, created: false, error: `unknown operation "${String(p.operation).slice(0, 40)}"` }
  const subject = `${OPERATION_LABEL[p.operation]} ${OPERATION_TICKET_SUBJECT_SUFFIX}`
  const lane: TicketLane = p.platformVisible ? "tenant_to_platform" : "user_to_brokerage"
  // One tracked ticket per (operation, lane) while open — pinned to the lane, never a lane-blind list (m468).
  const { data: open, error: readErr } = await svc.from("support_tickets").select("id")
    .eq("brokerage_id", p.brokerageId).eq("lane", lane).eq("subject", subject).in("status", ["open", "in_progress"]).limit(1)
  if (readErr) return { ticketId: null, created: false, error: `dedupe read refused: ${readErr.message}` }
  const existing = ((open ?? []) as Array<{ id: string }>)[0]
  if (existing) return { ticketId: existing.id, created: false, error: null }
  const gate = tenantFacingGate(p.tenantFacing)
  const body = gate.ok ? p.tenantFacing : `${OPERATION_LABEL[p.operation]} did not verify; the OS is checking and repairing it.`
  const { data, error } = await svc.from("support_tickets").insert({
    brokerage_id: p.brokerageId, agent_id: null, submitted_by_user_id: p.actorUserId ?? null, lane, subject,
    description: `${body}\n\nOpened automatically by the OS from an operation that did not verify (owner: ${OPERATION_OWNER[p.operation]}${p.lifecycleEventId ? `; evidence ${p.lifecycleEventId}` : ""}).`.slice(0, 2000),
    category: OPERATION_TICKET_CATEGORY[p.operation], priority: "high", status: "open",
  }).select("id").single()
  if (error || !data) return { ticketId: null, created: false, error: error?.message ?? "insert returned no row" }
  return { ticketId: (data as { id: string }).id, created: true, error: null }
}
