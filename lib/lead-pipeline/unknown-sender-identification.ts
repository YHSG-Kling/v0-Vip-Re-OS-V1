// lib/lead-pipeline/unknown-sender-identification.ts
//
// UNKNOWN INBOUND SENDER IDENTIFICATION — lane 73A, wave 73 ruling (owner verbatim):
//
//   "unknown inbound senders first need to be identified before adding a spam or non real
//   estate business email records into the os. if there is intent to or interest in real
//   estate then we should add them in as a lead so the ai isa can qualify before converting
//   to contact. if spam, then that gets dropped."
//
// THE GAP. app/api/providers/inbound/route.ts matched CONTACT-first, then ACTIVE LEAD, and
// silently dropped everything else (`return NextResponse.json({ linked: false })`, no count,
// no row, no trace) — recorded by wave 72A. A sender who matches nobody is either spam/a vendor
// (drop, correctly) or a real person with real intent (dropped WRONGLY — this was the bug).
//
// THE FIX — two cheap gates before anything is written:
//
//   1. PRE-FILTER (pure, no model call): bounce/mailer-daemon/no-reply/auto-reply local parts
//      (extends lib/external/email-verifier.ts's ROLE_LOCAL_PARTS — CLAUDE.md §6, one
//      vocabulary), known vendor/newsletter/ESP domains, the platform's OWN sending domains
//      (a mail loop), and provider headers carrying List-Unsubscribe / Auto-Submitted markers
//      when the inbound payload exposes them. Automated → dropped, counted, ZERO model spend.
//   2. AI REAL-ESTATE-INTENT CLASSIFICATION (the cheapest routed lane —
//      AI_TASK_ROUTING's own doc for gpt-4o-mini: "Simple yes/no decisions... quick filters...
//      Cheapest option"): guardedGenerateText (the data-guard chokepoint every new model call
//      outside lib/ai/models.ts must use) + resolveModel("openai/gpt-4o-mini"), booked to
//      ai_tool_usage with manager: "ai_isa" (mirrors lib/ai-isa/inbound-intent-classifier.ts's
//      own aiClassifier — the SAME billing identity/ledger idiom, not a second one).
//      FAIL CLOSED (CLAUDE.md §4): a classifier that cannot run does NOT create a lead and
//      does NOT guess spam — it HOLDS. No dedicated hold/queue table exists yet (grepped
//      needs_review / inbound_review / unmatched_inbound — none fit an inbound-message hold),
//      so per the task's own fallback this is a COUNTED drop with reason
//      "classifier_unavailable" and creates NO row (no migration for a queue this wave).
//
// SPAM / no real-estate intent → dropped, counted (lifecycle_events, entity_type 'system'),
// never a row anywhere. REAL-ESTATE INTENT → a LEAD through the SAME linear pipeline every
// other source uses (dedup → enrich → dedup → territory/identity gate →
// lib/kernel/scraping.ts::ingestRawSourceBatch + lib/lead-pipeline/pipeline-processor.ts::
// processRawRecord, SourceKey 'inbound_email_unknown', $0 vendor cost). The brokerage comes
// from the inbound route's already-resolved, signature-verified tenant — NEVER a body value
// (CLAUDE.md §4). Leads created here are platform+brokerage visible only, same as every lead;
// no agent sees them until qualified/converted (CLAUDE.md §5).
//
// THE ISA HANDOFF IS NOT DUPLICATED HERE. app/api/providers/inbound/route.ts's Step 8b
// already calls app/actions/ai-isa/handle-inbound-email.ts::processInboundEmail for ANY
// entityType==="lead" with an email — once this module hands the route a fresh leadId, the
// EXISTING call fires on the ORIGINAL email content and qualification starts through the
// canonical lane (classifyAndRouteInbound), exactly the mechanism a matched lead already used.
// Building a second invocation here would be the orphan doctrine's forbidden second vocabulary.

import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { guardedGenerateText } from "@/lib/data-guard/guarded-generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { logAIUsage } from "@/lib/ai/cost-tracking"
import { KernelEvent } from "@/lib/kernel/events"
import { ingestRawSourceBatch } from "@/lib/kernel/scraping"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import { ROLE_LOCAL_PARTS } from "@/lib/external/email-verifier"

type Svc = SupabaseClient<any, any, any>

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRE-FILTER — pure, deterministic, no I/O, no model call
// ─────────────────────────────────────────────────────────────────────────────

/** Extends (never redefines) lib/external/email-verifier.ts's ROLE_LOCAL_PARTS with local
 *  parts that are ALWAYS machine-generated (a human never sends FROM one of these), never
 *  merely role-based ("info@", "sales@" stay verifier-only — those can be a real vendor
 *  human replying, not this list's business). */
const AUTOMATED_LOCAL_PARTS = new Set<string>([
  ...["noreply", "no-reply", "postmaster", "webmaster"].filter((p) => ROLE_LOCAL_PARTS.has(p)),
  "mailer-daemon", "mailerdaemon", "bounce", "bounces", "bounced",
  "autoreply", "auto-reply", "auto_reply", "donotreply", "do-not-reply", "do_not_reply",
  "notifications", "notification", "digest", "newsletter", "alerts", "updates",
  "unsubscribe", "opt-out", "optout",
])

/** Starter list, expandable — common ESP / SaaS-notification / newsletter sending domains
 *  that are never a real-estate customer replying. Not exhaustive by design (a bogus domain
 *  here is caught by the AI classifier next, at low cost); this gate exists to catch the
 *  bulk of high-volume automated senders before any model spend. */
const KNOWN_VENDOR_NEWSLETTER_DOMAINS = new Set<string>([
  "sendgrid.net", "sendgrid.com", "mailgun.org", "mailgun.net", "postmarkapp.com",
  "mailchimp.com", "mailchimpapp.net", "list-manage.com", "constantcontact.com",
  "hubspotemail.net", "hs-sales-engage.com", "salesforce.com", "exacttarget.com",
  "klaviyomail.com", "substack.com", "substackcdn.com", "intercom-mail.com",
  "intercom.io", "zendesk.com", "atlassian.net", "github.com", "notifications.github.com",
  "slack.com", "slackbot.com", "docusign.net", "calendly.com", "amazonses.com",
  "mandrillapp.com", "sparkpostmail.com", "campaign-archive.com",
])

/** The platform's own outbound sending domains — a reply landing back on one of these is a
 *  mail loop (our own automated send bouncing/auto-replying to itself), never a customer.
 *  Env-derived so a tenant's real configured sender domain is honored without a hardcoded
 *  literal; the RFC 2606-style placeholders below are the same ones
 *  lib/kernel/manager-registry.ts's outbound_sender entry documents this repo has shipped
 *  from historically (example.com/yourdomain.com/vip-re.com/platform.com family). */
function platformOwnDomains(): string[] {
  const domains = new Set<string>(["vip-re.com", "vipre.io", "platform.com", "yourdomain.com", "example.com"])
  for (const envVar of [process.env.SENDGRID_FROM_EMAIL, process.env.OUTBOUND_EMAIL_FROM]) {
    const at = envVar?.split("@")[1]?.trim().toLowerCase()
    if (at) domains.add(at)
  }
  return [...domains]
}

/** Opportunistically pulls raw header text out of whatever shape the provider's payload
 *  carries (SendGrid Inbound Parse's `headers` string; Postmark's `Headers` array of
 *  {Name,Value}; Mailgun's `message-headers` array of [name,value]) so List-Unsubscribe /
 *  Auto-Submitted markers can be read when the provider exposes them, without requiring
 *  lib/providers/inbound-router.ts's normalizers to carry a new field. Falls back to a
 *  bounded JSON stringify so an unrecognized shape still gets SOME scan rather than none. */
export function extractInboundHeaderText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return ""
  const r = raw as Record<string, unknown>
  const first = Array.isArray(r) ? (r[0] as Record<string, unknown> | undefined) : r
  if (!first) return ""
  if (typeof first["headers"] === "string") return first["headers"]
  if (Array.isArray(first["Headers"])) {
    return (first["Headers"] as Array<{ Name?: string; Value?: string }>)
      .map((h) => `${h.Name ?? ""}: ${h.Value ?? ""}`)
      .join("\n")
  }
  const eventData = (first["event-data"] as Record<string, unknown> | undefined) ?? first
  const mgHeaders = (eventData?.["message"] as Record<string, unknown> | undefined)?.["headers"]
    ?? eventData?.["message-headers"]
  if (Array.isArray(mgHeaders)) {
    return (mgHeaders as unknown[])
      .map((h) => (Array.isArray(h) ? `${h[0] ?? ""}: ${h[1] ?? ""}` : ""))
      .join("\n")
  }
  try {
    return JSON.stringify(first).slice(0, 4000)
  } catch {
    return ""
  }
}

export type PrefilterDropReason =
  | "invalid_syntax"
  | "automated_local_part"
  | "known_vendor_or_newsletter_domain"
  | "own_domain_loop"
  | "list_unsubscribe_header"
  | "auto_submitted_header"

export interface PrefilterVerdict {
  isAutomated: boolean
  reason: PrefilterDropReason | null
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
const LIST_UNSUBSCRIBE_RE = /^list-unsubscribe\s*:/im
const AUTO_SUBMITTED_RE = /^(auto-submitted)\s*:\s*auto-(replied|generated)/im
const PRECEDENCE_BULK_RE = /^precedence\s*:\s*(bulk|auto_reply|junk)/im

/** PURE. Runs before any model call — the cheap deterministic gate the task asks for. */
export function preFilterAutomatedSender(input: {
  fromEmail: string
  raw?: unknown
  ownDomains?: string[]
}): PrefilterVerdict {
  const email = (input.fromEmail ?? "").trim().toLowerCase()
  if (!EMAIL_RE.test(email)) return { isAutomated: true, reason: "invalid_syntax" }

  const [local, domain] = email.split("@")
  if (AUTOMATED_LOCAL_PARTS.has(local)) return { isAutomated: true, reason: "automated_local_part" }
  if (KNOWN_VENDOR_NEWSLETTER_DOMAINS.has(domain)) return { isAutomated: true, reason: "known_vendor_or_newsletter_domain" }

  const ownDomains = input.ownDomains ?? platformOwnDomains()
  if (ownDomains.includes(domain)) return { isAutomated: true, reason: "own_domain_loop" }

  const headerText = extractInboundHeaderText(input.raw)
  if (headerText) {
    if (LIST_UNSUBSCRIBE_RE.test(headerText) || PRECEDENCE_BULK_RE.test(headerText)) {
      return { isAutomated: true, reason: "list_unsubscribe_header" }
    }
    if (AUTO_SUBMITTED_RE.test(headerText)) {
      return { isAutomated: true, reason: "auto_submitted_header" }
    }
  }

  return { isAutomated: false, reason: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AI REAL-ESTATE-INTENT CLASSIFICATION — the cheapest routed lane
// ─────────────────────────────────────────────────────────────────────────────

type UnknownSenderIntentType =
  | "buyer" | "seller" | "investor" | "renter" | "relocation" | "agent_seeking" | "unknown"

const UnknownSenderClassificationSchema = z.object({
  isSpamOrVendor: z.boolean(),
  hasRealEstateIntent: z.boolean(),
  intentType: z.enum(["buyer", "seller", "investor", "renter", "relocation", "agent_seeking", "unknown"]),
  extractedName: z.string().trim().min(1).nullable(),
  extractedPhone: z.string().trim().min(1).nullable(),
  extractedAddress: z.string().trim().min(1).nullable(),
  confidence: z.number().min(0).max(1),
})
export type UnknownSenderClassification = z.infer<typeof UnknownSenderClassificationSchema>

export interface ClassifierResult {
  available: boolean
  classification: UnknownSenderClassification | null
  /** Why the classifier could not answer — set only when available=false. */
  unavailableReason?: "model_error" | "unparseable_response"
}

const CLASSIFIER_MODEL = "openai/gpt-4o-mini" as const // AI_TASK_ROUTING's own doc: "Cheapest option"
const CLASSIFIER_BILLING_MODEL = "gpt-4o-mini" as const // the ai_tool_usage-admitted billing identity

/**
 * classifyUnknownSenderIntent — LIVE. One small, cheap model call: real-estate intent or not?
 * FAIL CLOSED: any model error or an unparseable/invalid response returns available=false —
 * the caller must HOLD, never guess a spam verdict OR a lead from a broken response.
 */
export async function classifyUnknownSenderIntent(params: {
  brokerageId: string
  fromEmail: string
  subject: string | null
  body: string
}): Promise<ClassifierResult> {
  const system = `You triage an UNKNOWN inbound email to a real-estate brokerage's mailbox — the
sender matches no existing contact or lead. Decide two things:
1. isSpamOrVendor — true if this is spam, a sales pitch FROM a vendor/SaaS/marketing company
   TO the brokerage, a newsletter, a job application, or any non-real-estate-customer message.
2. hasRealEstateIntent — true ONLY if a real person is expressing genuine interest in buying,
   selling, renting, investing in, or relocating for real estate, OR is looking for a real
   estate agent. A vague/ambiguous message with no real estate content is FALSE.
A message can have isSpamOrVendor=false and hasRealEstateIntent=false (e.g. a personal note
unrelated to real estate) — do not force one to imply the other.
intentType: one of buyer, seller, investor, renter, relocation, agent_seeking, unknown.
extractedName / extractedPhone / extractedAddress: pull these ONLY if explicitly present in the
message text or signature (never invent one); null when absent.
confidence: 0 to 1, your honest confidence in hasRealEstateIntent.
Respond with ONLY a compact JSON object, no prose, no markdown fences:
{"isSpamOrVendor":bool,"hasRealEstateIntent":bool,"intentType":"...","extractedName":string|null,"extractedPhone":string|null,"extractedAddress":string|null,"confidence":number}`

  const userContent = `From: ${params.fromEmail}\nSubject: ${params.subject ?? ""}\n\n${params.body}`.slice(0, 6000)

  let raw: string
  try {
    const result = await guardedGenerateText({
      model: resolveModel(CLASSIFIER_MODEL),
      system,
      messages: [{ role: "user", content: userContent }],
      maxOutputTokens: 300,
      temperature: 0,
    })
    // BOOK IT (CLAUDE.md §5) — manager 'ai_isa' owns this domain (the same manager
    // lib/ai-isa/inbound-intent-classifier.ts books its own gpt-4o-mini call under).
    if (params.brokerageId) {
      await logAIUsage({
        userId: null,
        brokerageId: params.brokerageId,
        model: CLASSIFIER_BILLING_MODEL,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        feature: "unknown_sender_intent_classification",
        manager: "ai_isa",
      })
    }
    raw = result.text
  } catch (err) {
    console.error("[unknown-sender-identification] model unavailable:", err instanceof Error ? err.message : err)
    return { available: false, classification: null, unavailableReason: "model_error" }
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    const classification = UnknownSenderClassificationSchema.parse(parsed)
    return { available: true, classification }
  } catch (err) {
    console.warn("[unknown-sender-identification] model returned an unparseable response — held, not guessed:", err instanceof Error ? err.message : err)
    return { available: false, classification: null, unavailableReason: "unparseable_response" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ORCHESTRATION — prefilter → classify → drop | hold | lead-through-the-pipeline
// ─────────────────────────────────────────────────────────────────────────────

function mapIntentTypeToLeadSide(t: UnknownSenderIntentType): "buyer" | "seller" | "unknown" {
  switch (t) {
    case "seller": return "seller"
    case "buyer": case "investor": case "renter": case "relocation": return "buyer"
    case "agent_seeking": case "unknown": default: return "unknown"
  }
}

/** Splits a free-text extracted name into first/last, honestly — a single-word name has no
 *  last name (never fabricated from nothing). */
function splitExtractedName(name: string | null): { firstName: string | null; lastName: string | null } {
  const trimmed = (name ?? "").trim()
  if (!trimmed) return { firstName: null, lastName: null }
  const parts = trimmed.split(/\s+/)
  return { firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(" ") : null }
}

/** COUNTED drop — lifecycle_events, entity_type 'system' (the same pattern
 *  lib/kernel/scraping.ts's SCRAPE_SOURCE_RUN_STARTED already uses for a run with no single
 *  entity owner). Never a swallowed console.log — a run of these must be visible (CLAUDE.md
 *  §2: "a count that moves is the finding"). Best-effort: a failed audit write must not be
 *  reported to the caller as though the drop itself failed. */
async function recordDrop(
  svc: Svc,
  brokerageId: string,
  reason: string,
  detail: string | null,
  fromEmail: string,
  messageId: string | null,
): Promise<void> {
  await svc.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "system",
    entity_id: null,
    event_type: KernelEvent.UNKNOWN_SENDER_DROPPED,
    metadata: { reason, detail, from_email: fromEmail, message_id: messageId },
    created_at: new Date().toISOString(),
  }).then(() => undefined, (err) => {
    console.error("[unknown-sender-identification] drop audit write failed (non-blocking):", err?.message ?? err)
  })
}

/** Resolves ONE market row for the brokerage to attach the raw record to (prefers active,
 *  highest priority) — never invents one. A brokerage with no lead_scraping_markets row at all
 *  (never turned on scraping) still gets this capability: market_id is nullable (m648) and
 *  ingestRawSourceBatch skips the territory gate honestly when there is no geography to check
 *  against, the same no-op posture recordMatchesTerritory takes for any record with no
 *  geography. */
async function resolveMarketForBrokerage(
  svc: Svc,
  brokerageId: string,
): Promise<{ id: string; city: string | null; state: string | null; zip_codes: string[] | null } | null> {
  const { data } = await svc
    .from("lead_scraping_markets")
    .select("id, city, state, zip_codes, is_active, priority")
    .eq("brokerage_id", brokerageId)
    .order("is_active", { ascending: false })
    .order("priority", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string; city: string | null; state: string | null; zip_codes: string[] | null } | null) ?? null
}

/** Ingests the classified record through the SAME linear pipeline every other source uses and
 *  attempts promotion in the same call (real-time — a webhook, not a cron sweep). Returns the
 *  new lead id ONLY when a fresh lead was actually CREATED — a dedup MERGE onto an existing
 *  lead/contact is left to the pipeline's own record (it already carried the fresh info onto
 *  the matching row); this function does not guess which entity a merge landed on, so the
 *  caller is not handed an entityType/entityId pair the route cannot honestly stand behind. */
async function createLeadFromUnknownSender(
  svc: Svc,
  params: { brokerageId: string; fromEmail: string; subject: string | null; body: string; messageId: string | null },
  classification: UnknownSenderClassification,
): Promise<{ leadId: string | null; pipelineReason: string }> {
  const market = await resolveMarketForBrokerage(svc, params.brokerageId)
  const { firstName, lastName } = splitExtractedName(classification.extractedName)

  const record: NormalizedScrapedRecord = {
    sourceRecordId: params.messageId ?? `inbound_email_unknown-${params.fromEmail}-${Date.now()}`,
    source: "inbound_email_unknown",
    behaviorType: "inbound_email_unknown",
    intentType: mapIntentTypeToLeadSide(classification.intentType),
    intentSignals: [classification.intentType],
    firstName,
    lastName,
    email: params.fromEmail,
    phone: classification.extractedPhone,
    propertyAddress: classification.extractedAddress,
    sourceUrl: null,
    motivationScore: null,
    rawPayload: {
      subject: params.subject,
      body: params.body,
      classification,
      message_id: params.messageId,
    },
  }

  const ingest = await ingestRawSourceBatch({
    brokerageId: params.brokerageId, // explicit tenant, session-resolved by the route — never platform-pooled
    marketId: market?.id ?? null,
    source: "inbound_email_unknown",
    sourceFamily: "inbound_intake", // scrape_category (m647) — free text, governed by source-intent-map.ts's SourceKey union
    sourceChannel: "inbound_email_unknown",
    records: [record],
    executionId: null,
    marketGeo: market ? { city: market.city, state: market.state, zip_codes: market.zip_codes } : null,
  })

  if (ingest.inserted !== 1 || ingest.rawIds.length !== 1) {
    return {
      leadId: null,
      pipelineReason: ingest.skipped_not_viable > 0 ? "not_viable"
        : ingest.skipped_territory > 0 ? "territory_mismatch"
        : ingest.skipped_duplicate > 0 ? "duplicate_at_ingest"
        : "not_inserted",
    }
  }

  const { processRawRecord } = await import("@/lib/lead-pipeline/pipeline-processor")
  const result = await processRawRecord(ingest.rawIds[0], params.brokerageId)
  if (result.success && result.action === "created" && result.leadId) {
    return { leadId: result.leadId, pipelineReason: result.reason }
  }
  return { leadId: null, pipelineReason: result.reason }
}

export interface UnknownSenderIdentificationResult {
  outcome: "lead_created" | "dropped" | "held"
  leadId?: string
  reason: string
}

/**
 * identifyAndRouteUnknownSender — the entry point app/api/providers/inbound/route.ts calls for
 * an EMAIL sender that matched no contact and no active lead. Returns a leadId ONLY on
 * "lead_created" — the route sets entityType="lead" from it and falls through its existing
 * Step 8b (processInboundEmail), which is where ISA qualification actually starts. Never
 * throws — a caller-side failure here must never break inbound ingress (mirrors every other
 * best-effort door this route already has).
 */
export async function identifyAndRouteUnknownSender(params: {
  brokerageId: string
  fromEmail: string
  subject: string | null
  body: string
  messageId: string | null
  raw?: unknown
}): Promise<UnknownSenderIdentificationResult> {
  const svc = createServiceClient()

  // ── Step 1: cheap deterministic pre-filter — NO model call ────────────────
  const pre = preFilterAutomatedSender({ fromEmail: params.fromEmail, raw: params.raw })
  if (pre.isAutomated) {
    await recordDrop(svc, params.brokerageId, `prefilter:${pre.reason}`, null, params.fromEmail, params.messageId)
    return { outcome: "dropped", reason: `prefilter:${pre.reason}` }
  }

  // ── Step 2: AI real-estate-intent classification — the cheapest routed lane ──
  const verdict = await classifyUnknownSenderIntent({
    brokerageId: params.brokerageId,
    fromEmail: params.fromEmail,
    subject: params.subject,
    body: params.body,
  })

  if (!verdict.available || !verdict.classification) {
    // FAIL CLOSED — never a lead, never a guessed drop. No hold/queue table exists for this
    // yet (task's own fallback): a counted drop, no row anywhere.
    await recordDrop(svc, params.brokerageId, "classifier_unavailable", verdict.unavailableReason ?? null, params.fromEmail, params.messageId)
    return { outcome: "held", reason: "classifier_unavailable" }
  }

  const c = verdict.classification
  if (c.isSpamOrVendor || !c.hasRealEstateIntent) {
    const reason = c.isSpamOrVendor ? "classified_spam_or_vendor" : "classified_no_real_estate_intent"
    await recordDrop(svc, params.brokerageId, reason, `intentType=${c.intentType} confidence=${c.confidence}`, params.fromEmail, params.messageId)
    return { outcome: "dropped", reason }
  }

  // ── Step 3: real-estate intent → LEAD through the linear pipeline ─────────
  const { leadId, pipelineReason } = await createLeadFromUnknownSender(svc, params, c)
  if (!leadId) {
    await recordDrop(svc, params.brokerageId, "pipeline_did_not_promote", pipelineReason, params.fromEmail, params.messageId)
    return { outcome: "dropped", reason: `pipeline_did_not_promote:${pipelineReason}` }
  }

  await svc.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type: "lead",
    entity_id: leadId,
    event_type: KernelEvent.UNKNOWN_SENDER_IDENTIFIED_AS_LEAD,
    metadata: { from_email: params.fromEmail, message_id: params.messageId, intent_type: c.intentType, confidence: c.confidence },
    created_at: new Date().toISOString(),
  }).then(() => undefined, (err) => {
    console.error("[unknown-sender-identification] identified-as-lead audit write failed (non-blocking):", err?.message ?? err)
  })

  return { outcome: "lead_created", leadId, reason: `intent:${c.intentType}` }
}
