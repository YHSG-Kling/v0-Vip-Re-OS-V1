// lib/lead-pipeline/unknown-sender-identification.ts
//
// UNKNOWN INBOUND SENDER IDENTIFICATION + ROUTING — lane 74A, wave 74 ruling
// (owner verbatim, correcting wave 73A's lane 73A build):
//
//   "you got the inbound email unknown process incorrect. if this email is coming
//   into a tenant or user account, that email needs to be processed to their crm
//   so if it is a brokerage account, comes in as a lead not a raw lead and if it
//   is an agent or team lead, then a new contact but only if they have real
//   estate intent or could be a transactional email like an offer for an
//   in-house listing, etc."
//
// THE CORRECTION. Wave 73A treated every unknown sender the same way regardless
// of WHICH mailbox the email landed in — real-estate intent always minted a raw
// scraped lead (ingestRawSourceBatch → processRawRecord), even when the mailbox
// receiving the mail was an INDIVIDUAL agent's or team lead's own inbox. That is
// wrong on two counts: (1) an agent/team-lead mailbox should never produce a raw
// LEAD at all — CLAUDE.md §5 draws leads as BROKERAGE property; someone emailing
// an agent directly is that agent's own contact, full stop; (2) even a brokerage
// mailbox should never go through the RAW SCRAPED pipeline — that pipeline exists
// for scraped/unconsented ACQUISITION (lead_scraping_markets territory, dedup
// against scraped duplicates, batch cadence); an inbound email the tenant already
// received, from a sender who wrote to THEM, is a DIRECT capture, the same
// posture every other direct-capture door in this repo takes (captureContact for
// a contact; the direct-insert door below for a lead).
//
// THE FIX, three parts:
//
//   1. MAILBOX-OWNER RESOLUTION (resolveInboundMailboxOwner, below) — from the
//      route's own VERIFIED binding, NEVER the email body (CLAUDE.md §4). Two
//      binding shapes exist and both are honored (§6, no second resolver):
//        - a PER-USER credential (lib/inbound-mail/resolve-user-provider.ts's
//          platform_credentials cascade: user → team → brokerage scope) — what
//          app/api/webhooks/inbound-mail/route.ts already resolves per message.
//        - a SHARED brokerage webhook (app/api/providers/inbound/route.ts's
//          email door): that route's own inbound-router.ts normalizers
//          (normalizeSendGrid/normalizePostmark/normalizeMailgun) carry NO
//          per-agent recipient identity — the webhook URL is configured ONE PER
//          BROKERAGE (brokerage_id query param / signed body field). There is no
//          agent signal reachable at that door, so 'brokerage' is the honest
//          answer for it, not a guess.
//      No migration was needed — CLAUDE.md §1's "genuinely absent" bar was not
//      met: platform_credentials already IS the mailbox/user binding table.
//   2. TRANSACTIONAL DETECTION — an offer / showing-or-appointment request /
//      inspection-escrow-contract correspondence QUALIFIES even with no
//      buyer/seller intent language, the same as real-estate intent does. Two
//      arms, either one qualifies: the AI classifier's own isTransactional read,
//      and a DETERMINISTIC address match against the brokerage's OWN listings
//      (matchEmailToOwnListing, below) via lib/external/permit-signals.ts's
//      normalizeStreetAddress — the SAME normalizer this repo already uses for a
//      bounded, single-tenant address-key comparison (lib/kernel/
//      listings-batchdata-feed.ts::findLeadOrContactByAddress is the precedent
//      this mirrors). normalizeAddressKey (street+zip) was deliberately NOT used
//      — that key exists because lib/direct-mail/address-suppression.ts compares
//      across the WHOLE country and a bare street collides; here the comparison
//      is already scoped to one brokerage's own listings, the same bounded scope
//      normalizeStreetAddress is street-only FOR.
//   3. ROUTING BY MAILBOX OWNER — a BROKERAGE mailbox creates a LEAD directly
//      (createLeadDirectlyForBrokerage, via lib/kernel/crm.ts's
//      createLeadOnlyRecordForAcquisitionSource — the governed direct `leads`
//      insert every other scraped/direct-acquisition door uses, NEVER
//      raw_scraped_leads/ingestRawSourceBatch for this source any more). An
//      AGENT or TEAM-LEAD mailbox creates a CONTACT assigned to that person
//      (createContactForAgentMailbox, via lib/contact-pipeline/
//      contact-capture.ts::captureContact — the ONE contact-intake door every
//      other direct-capture source already uses). Dedup against BOTH contacts
//      and leads by email runs FIRST (findExistingLeadOrContact) — an email
//      already belonging to either never mints a second row.
//
// TOMBSTONE (CLAUDE.md §1): the wave-73A raw-lead path this file used to run
// (ingestRawSourceBatch + lib/lead-pipeline/pipeline-processor.ts::
// processRawRecord) is REMOVED for this source. Survivors:
//   - brokerage mailbox → lib/kernel/crm.ts::createLeadOnlyRecordForAcquisitionSource
//   - agent/team-lead mailbox → lib/contact-pipeline/contact-capture.ts::captureContact
// SourceKey 'inbound_email_unknown' STAYS REGISTERED in
// lib/lead-pipeline/source-intent-map.ts — it is still the intelligence/
// cost-tracking identity for this channel (SOURCE_VENDOR 'internal', $0), it is
// simply no longer routed through the RAW pipeline that registry entry was
// originally written to serve. m648 (raw_scraped_leads.market_id nullable) stays
// applied and harmless — it cost nothing and other non-territory sources may
// still use that column.
//
// ── WAVE 85 CORRECTION (lane 85B) — owner verbatim, 2026-09-26: ──────────────
//   "an unknown sender needs to go through enrichment before lead gate."
//   "change in what is needed to become a lead it should be email required so email
//    and/or phone."
// The wave-74 brokerage branch minted a LEAD DIRECTLY (createLeadDirectlyForBrokerage →
// crm.ts::createLeadOnlyRecordForAcquisitionSource, exempt from the name half of the gate by
// lane 84C's `origin: "person_initiated_inbound"`). That skipped enrichment and the gate. Now a
// qualifying sender to a BROKERAGE mailbox lands RAW and takes the one raw path every other source
// takes: landUnknownSenderRaw → lib/kernel/scraping.ts::ingestRawSourceBatch → lib/lead-pipeline/
// pipeline-processor.ts::processRawRecord = pre-dedup → enrich (PeopleData by the sender's EMAIL,
// which returns the person's name; the email-seek hook) → post-dedup → THE gate
// (canonical-lead-eligibility.ts::isLeadEligibleIdentity). The sender's own address satisfies the
// gate's email requirement (unless it is invalid / disposable / an automated mailbox); the NAME must
// still be found — from the signature (the classifier's extractedName), the From display name, a
// "first.last@" local part, or PeopleData. A sender whose name is not found stays raw
// ('insufficient_identity_for_promotion') and the lead-scraping cron's stranded sweep re-runs it —
// processRawRecord now resolves a market-less brokerage-origin row's owner from its own
// brokerage_id, stamped here from the VERIFIED mailbox binding (§4).
//   · The 74A reasons for going direct are answered, not ignored: no territory gate applies
//     (market_id NULL, m648 — a person who wrote to us is not territory-bound) and no batch
//     cadence (processRawRecord runs INLINE, in this webhook call; a sender whose name is already
//     known becomes a lead in the same request and the route's Step 8b hands the ORIGINAL email to
//     the ISA exactly as before).
//   · LEAD INTELLIGENCE HISTORY — the conversation is preserved on the raw row (raw_data: subject,
//     body, message id, the classification, the listing match, where the name came from) and the
//     row carries source 'inbound_email_unknown' + cost_per_record = the classifier's own model
//     cost (already booked to ai_tool_usage; stamped here as the per-record ACQUISITION cost, not a
//     second booking). lib/lead-intelligence/person-timeline.ts reads it by lead_id once promoted.
//   · The AGENT / TEAM-LEAD mailbox branch was left creating a CONTACT here — SUPERSEDED in wave 86
//     (below).
// TOMBSTONE (CLAUDE.md §1): createLeadDirectlyForBrokerage is DELETED — survivor
// landUnknownSenderRaw (this file). The wave-74 "never raw_scraped_leads for this source" rule
// below is SUPERSEDED for the brokerage branch. AUTOMATED_LOCAL_PARTS moved to
// lib/external/email-verifier.ts (the gate reads it too — one vocabulary, §6).
//
// ── WAVE 86 CORRECTION (lane 86A) — owner verbatim, 2026-09-27: ──────────────────────────────────
//   "yes all mailboxes should be configured the same."
// An unknown sender to an AGENT or TEAM-LEAD mailbox now takes EXACTLY the brokerage mailbox's path:
// RAW → dedup → enrich → dedup → THE gate (landUnknownSenderRaw → ingestRawSourceBatch →
// processRawRecord). The mailbox owner no longer changes the ROUTE; it is recorded as PROVENANCE on
// the raw row (raw_data.mailbox_owner_kind / mailbox_owner_agent_id — read back by
// lib/lead-intelligence/person-timeline.ts as "Emailed <whose> mailbox") and on the
// UNKNOWN_SENDER_IDENTIFIED_AS_LEAD event's metadata (owner_kind). The lead belongs to the BROKERAGE
// (CLAUDE.md §5) whichever mailbox received the mail; it reaches an agent the way every lead does —
// qualified by the ISA, then assigned.
// TOMBSTONE (CLAUDE.md §1): createContactForAgentMailbox (the contact-direct branch — captureContact,
// a TCPA stamp, a fill-if-empty contact_persona) is DELETED, with its `opts.createContact` seam, the
// "contact_created" outcome, mapIntentTypeToContactType / mapIntentTypeToPersona (contact-only
// vocabulary mappers) and KernelEvent.UNKNOWN_SENDER_IDENTIFIED_AS_CONTACT (lib/kernel/events.ts —
// zero live rows). Survivor: landUnknownSenderRaw (this file), the brokerage branch's own path. What
// the survivor was missing, merged onto it first: the mailbox owner (now on the raw row and the
// event). The classifier's intent and persona-relevant reading already ride the raw row
// (raw_data.classification / motivation_type). The two routes' contact_created branches carry their
// own tombstones.
//
// THE ISA HANDOFF IS NOT DUPLICATED HERE (unchanged from wave 73A). For the
// brokerage/lead branch, app/api/providers/inbound/route.ts's existing Step 8b
// already calls app/actions/ai-isa/handle-inbound-email.ts::processInboundEmail
// for ANY entityType==="lead" with an email — once this module hands the route a
// fresh leadId, that EXISTING call fires on the ORIGINAL email content and
// qualification starts through the canonical lane. Since wave 86 that is true of every mailbox (there
// is no agent/contact branch any more) — no second ISA invocation is built here.

import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { guardedGenerateText } from "@/lib/data-guard/guarded-generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { logAIUsage } from "@/lib/ai/cost-tracking"
import { KernelEvent } from "@/lib/kernel/events"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { normalizeStreetAddress } from "@/lib/external/permit-signals"
import { isAutomatedLocalPart, ROLE_LOCAL_PARTS } from "@/lib/external/email-verifier"
// Lane 90B — the prefilter applies THE lead gate's email rule (canonical-lead-eligibility.ts) up front.
import { leadEmailProblem } from "@/lib/lead-pipeline/canonical-lead-eligibility"
import { calculateCost } from "@/lib/ai/cost-tracking"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import type { ResolvedInboundProvider } from "@/lib/inbound-mail/resolve-user-provider"

type Svc = SupabaseClient<any, any, any>

// ─────────────────────────────────────────────────────────────────────────────
// 0. MAILBOX-OWNER RESOLUTION — from the route's own VERIFIED binding
// ─────────────────────────────────────────────────────────────────────────────

export type MailboxOwnerKind = "brokerage" | "agent" | "team_lead"

export interface ResolvedMailboxOwner {
  brokerageId: string
  ownerKind: MailboxOwnerKind
  /** agents.id, when a live agents row exists for the owning user. Null for a
   *  shared brokerage mailbox, or when the owning user has no agents row yet —
   *  captureContact's own legacy agentUserId fallback still resolves that case. */
  agentId: string | null
  /** users.id of the owning agent/team lead. Null for a shared brokerage mailbox. */
  userId: string | null
}

/**
 * resolveInboundMailboxOwner — see the file header. Never reads the email body —
 * both input shapes come from a channel the calling route already verified
 * (provider signature + tenant-scoped credential lookup / brokerage-scoped
 * webhook URL), CLAUDE.md §4.
 */
export async function resolveInboundMailboxOwner(
  svc: Svc,
  input:
    | {
        doorKind: "shared_brokerage_webhook"
        brokerageId: string
        /** Blind-spot burn-down (lane 75D) — the raw "To"/envelope-recipient
         *  address (lib/providers/inbound-router.ts's InboundMessage.toEmail)
         *  and the provider it arrived on. Several distinct recipient
         *  addresses can deliver to this SAME per-brokerage webhook URL;
         *  when BOTH are supplied, this door now tries the SAME per-user
         *  mailbox binding the `resolved_credential` door already resolves
         *  through (platform_credentials.account_id) BEFORE falling back to
         *  the brokerage-wide shared mailbox. Omitted → the prior honest
         *  'brokerage' answer, unchanged (no per-agent signal reachable). */
        toEmail?: string | null
        emailPlatform?: ResolvedInboundProvider["platform"] | null
      }
    | { doorKind: "resolved_credential"; credential: ResolvedInboundProvider },
): Promise<ResolvedMailboxOwner> {
  if (input.doorKind === "shared_brokerage_webhook") {
    if (input.toEmail && input.emailPlatform) {
      const { resolveUserByInboundIdentifier } = await import("@/lib/inbound-mail/resolve-user-provider")
      const credential = await resolveUserByInboundIdentifier({
        platform: input.emailPlatform,
        toAddress: input.toEmail,
        svc: svc as any,
      })
      // Tenant safety (CLAUDE.md §4): a matching credential from a DIFFERENT
      // brokerage never claims ownership of THIS webhook's brokerage-scoped
      // mail — that would be an IDOR-shaped cross-tenant leak, not a routing
      // convenience. Only a same-brokerage match is honored; anything else
      // (no match, or a foreign-brokerage match) falls through to the
      // brokerage-wide shared mailbox, exactly as before this lane.
      if (credential && credential.brokerage_id === input.brokerageId) {
        return resolveInboundMailboxOwner(svc, { doorKind: "resolved_credential", credential })
      }
    }
    return { brokerageId: input.brokerageId, ownerKind: "brokerage", agentId: null, userId: null }
  }

  const c = input.credential
  const brokerageId = c.brokerage_id

  const resolveAgentId = async (userId: string): Promise<string | null> => {
    const { data } = await svc
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }

  if (c.scope === "agent" && c.agent_user_id) {
    return { brokerageId, ownerKind: "agent", agentId: await resolveAgentId(c.agent_user_id), userId: c.agent_user_id }
  }

  if (c.scope === "team") {
    // The credential's own owning user (an agent's personal inbox shared at team
    // scope) is the sharpest signal when present; otherwise fall back to the
    // team's team_lead_id (teams.team_lead_id IS users.id — the SAME fact
    // lib/lead-assignment/contact-assignment.ts already resolves this way, reused
    // here rather than re-derived, CLAUDE.md §6).
    if (c.agent_user_id) {
      return { brokerageId, ownerKind: "team_lead", agentId: await resolveAgentId(c.agent_user_id), userId: c.agent_user_id }
    }
    const teamId = (c.config?.["team_id"] as string | undefined) ?? null
    if (teamId) {
      const { data: team } = await svc
        .from("teams")
        .select("team_lead_id")
        .eq("id", teamId)
        .is("deleted_at", null)
        .maybeSingle()
      const leadUserId = (team as { team_lead_id: string | null } | null)?.team_lead_id ?? null
      if (leadUserId) {
        return { brokerageId, ownerKind: "team_lead", agentId: await resolveAgentId(leadUserId), userId: leadUserId }
      }
    }
    // No resolvable owner for a team-shared mailbox — fail to the WIDER scope
    // (brokerage), never guess an agent (CLAUDE.md §4, fail closed).
    return { brokerageId, ownerKind: "brokerage", agentId: null, userId: null }
  }

  return { brokerageId, ownerKind: "brokerage", agentId: null, userId: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRE-FILTER — pure, deterministic, no I/O, no model call
// ─────────────────────────────────────────────────────────────────────────────

// TOMBSTONE (lane 85B) — AUTOMATED_LOCAL_PARTS lived here as a file-local set; it MOVED to
// lib/external/email-verifier.ts (imported above) so the lead identity gate reads the same
// vocabulary (canonical-lead-eligibility.ts::leadEmailProblem). Unchanged members.

/** PURE — splits a From header value ("Jane Doe <jane@x.com>", "<jane@x.com>", "jane@x.com") into the
 *  bare address and the display name. Providers hand the header through in any of those shapes. */
export function parseFromHeader(from: string | null | undefined): { address: string; displayName: string | null } {
  const raw = (from ?? "").trim()
  const angled = raw.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/)
  if (angled) {
    const name = angled[1].trim().replace(/^["']|["']$/g, "").trim()
    return { address: angled[2].trim().toLowerCase(), displayName: name || null }
  }
  return { address: raw.toLowerCase(), displayName: null }
}

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
  /** Lane 90B — a self-expiring mailbox (leadEmailProblem's disposable_domain): the gate would refuse
   *  it after the classifier + PeopleData spent on it. */
  | "disposable_domain"
  | "known_vendor_or_newsletter_domain"
  | "own_domain_loop"
  | "list_unsubscribe_header"
  | "auto_submitted_header"

export interface PrefilterVerdict {
  isAutomated: boolean
  reason: PrefilterDropReason | null
}

// TOMBSTONE (lane 90B) — the file-local EMAIL_RE syntax test and the exact `AUTOMATED_LOCAL_PARTS.has(local)`
// test are DELETED from the prefilter; both live in the ONE rule the lead gate applies,
// lib/lead-pipeline/canonical-lead-eligibility.ts::leadEmailProblem (syntax → disposable → automated
// mailbox via email-verifier.ts::isAutomatedLocalPart). The prefilter used to pass `esignature-noreply@`
// (exact match only), so the classifier ran and PeopleData was billed before the gate refused it.
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
  // Lane 90B — THE gate's own email rule, applied BEFORE the classifier and before enrichment (it
  // used to be applied only at the lead gate, after both had spent): invalid / disposable /
  // automated (any `noreply` token, not just the exact local part) never reach a model or PeopleData.
  const problem = leadEmailProblem(email)
  if (problem === "missing" || problem === "invalid_syntax") return { isAutomated: true, reason: "invalid_syntax" }
  if (problem === "automated_mailbox") return { isAutomated: true, reason: "automated_local_part" }
  if (problem === "disposable_domain") return { isAutomated: true, reason: "disposable_domain" }

  const domain = email.split("@")[1] ?? ""
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
// 2. AI REAL-ESTATE-INTENT + TRANSACTIONAL CLASSIFICATION — the cheapest routed lane
// ─────────────────────────────────────────────────────────────────────────────

type UnknownSenderIntentType =
  | "buyer" | "seller" | "investor" | "renter" | "relocation" | "agent_seeking" | "unknown"

type TransactionalType = "offer" | "showing" | "inspection" | "escrow" | "contract" | "other" | "none"

const UnknownSenderClassificationSchema = z.object({
  isSpamOrVendor: z.boolean(),
  hasRealEstateIntent: z.boolean(),
  intentType: z.enum(["buyer", "seller", "investor", "renter", "relocation", "agent_seeking", "unknown"]),
  // WAVE 74 ADDITION — owner ruling: "...or could be a transactional email like an
  // offer for an in-house listing, etc." A transactional email QUALIFIES the sender
  // even with zero buyer/seller intent language (a lender's escrow update, a title
  // company's closing document, an inspector confirming a walkthrough time).
  isTransactional: z.boolean(),
  transactionalType: z.enum(["offer", "showing", "inspection", "escrow", "contract", "other", "none"]),
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
  /** Lane 85B — the model cost of THIS call in USD (the same calculateCost figure logAIUsage books
   *  to ai_tool_usage). Carried onto the raw row as its per-record acquisition cost. */
  costUsd?: number
}

const CLASSIFIER_MODEL = "openai/gpt-4o-mini" as const // AI_TASK_ROUTING's own doc: "Cheapest option"
const CLASSIFIER_BILLING_MODEL = "gpt-4o-mini" as const // the ai_tool_usage-admitted billing identity

/**
 * classifyUnknownSenderIntent — LIVE. One small, cheap model call: real-estate intent,
 * transactional content, or neither? FAIL CLOSED: any model error or an
 * unparseable/invalid response returns available=false — the caller must HOLD, never
 * guess a spam verdict OR a lead/contact from a broken response.
 */
export async function classifyUnknownSenderIntent(params: {
  brokerageId: string
  fromEmail: string
  subject: string | null
  body: string
}): Promise<ClassifierResult> {
  const system = `You triage an UNKNOWN inbound email to a real-estate brokerage's mailbox — the
sender matches no existing contact or lead. Decide THREE things:
1. isSpamOrVendor — true if this is spam, a sales pitch FROM a vendor/SaaS/marketing company
   TO the brokerage, a newsletter, a job application, or any non-real-estate-customer message.
2. hasRealEstateIntent — true ONLY if a real person is expressing genuine interest in buying,
   selling, renting, investing in, or relocating for real estate, OR is looking for a real
   estate agent. A vague/ambiguous message with no real estate content is FALSE.
3. isTransactional — true if this is an OFFER, a SHOWING/APPOINTMENT request, or
   INSPECTION/ESCROW/CONTRACT correspondence about a SPECIFIC property — even with NO
   buyer/seller intent language (e.g. "Please see attached offer for 123 Main St" or "Confirming
   the inspection Thursday at 2pm" is transactional even though hasRealEstateIntent may be
   false — this is a business-process email, not a prospect expressing interest).
   transactionalType: one of offer, showing, inspection, escrow, contract, other (when
   isTransactional is true), or "none" (when isTransactional is false).
A message can have isSpamOrVendor=false and BOTH hasRealEstateIntent=false and
isTransactional=false (e.g. a personal note unrelated to real estate) — never force one field
to imply another.
intentType: one of buyer, seller, investor, renter, relocation, agent_seeking, unknown.
extractedName / extractedPhone / extractedAddress: pull these ONLY if explicitly present in the
message text or signature (never invent one); extractedAddress is the SPECIFIC property address
this email is about, if any (critical for transactional emails); null when absent.
confidence: 0 to 1, your honest confidence in hasRealEstateIntent (or intentType, if that is
what is actually known).
Respond with ONLY a compact JSON object, no prose, no markdown fences:
{"isSpamOrVendor":bool,"hasRealEstateIntent":bool,"intentType":"...","isTransactional":bool,"transactionalType":"...","extractedName":string|null,"extractedPhone":string|null,"extractedAddress":string|null,"confidence":number}`

  const userContent = `From: ${params.fromEmail}\nSubject: ${params.subject ?? ""}\n\n${params.body}`.slice(0, 6000)

  let raw: string
  let costUsd = 0
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
    costUsd = calculateCost(CLASSIFIER_BILLING_MODEL, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0) / 100
  } catch (err) {
    console.error("[unknown-sender-identification] model unavailable:", err instanceof Error ? err.message : err)
    return { available: false, classification: null, unavailableReason: "model_error" }
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    const classification = UnknownSenderClassificationSchema.parse(parsed)
    return { available: true, classification, costUsd }
  } catch (err) {
    console.warn("[unknown-sender-identification] model returned an unparseable response — held, not guessed:", err instanceof Error ? err.message : err)
    return { available: false, classification: null, unavailableReason: "unparseable_response", costUsd }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TRANSACTIONAL — deterministic match against the brokerage's OWN listings
// ─────────────────────────────────────────────────────────────────────────────

interface OwnListingMatch {
  listingId: string
  matchedAddress: string
}

/**
 * matchEmailToOwnListing — deterministic, no model cost. Compares the classifier's
 * OWN extractedAddress against every one of the brokerage's listings via
 * normalizeStreetAddress (see file header for why this normalizer, not
 * normalizeAddressKey). Never fabricates a match from a bare mention in free text —
 * requires the classifier to have actually extracted an address first, and an empty
 * normalized key (no house number) never matches anything, by that function's own
 * contract.
 */
async function matchEmailToOwnListing(
  svc: Svc,
  brokerageId: string,
  extractedAddress: string | null,
): Promise<OwnListingMatch | null> {
  const key = normalizeStreetAddress(extractedAddress)
  if (!key) return null

  const { data } = await svc
    .from("listings")
    .select("id, address")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .limit(500)

  for (const l of (data ?? []) as Array<{ id: string; address: string | null }>) {
    if (normalizeStreetAddress(l.address) === key) {
      return { listingId: l.id, matchedAddress: l.address ?? "" }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ORCHESTRATION — prefilter → classify → dedup → route by mailbox owner
// ─────────────────────────────────────────────────────────────────────────────

function mapIntentTypeToLeadSide(t: UnknownSenderIntentType): "buyer" | "seller" | "unknown" {
  switch (t) {
    case "seller": return "seller"
    case "buyer": case "investor": case "renter": case "relocation": return "buyer"
    case "agent_seeking": case "unknown": default: return "unknown"
  }
}

// TOMBSTONE (wave 86, lane 86A): mapIntentTypeToContactType / mapIntentTypeToPersona are DELETED with
// the contact-direct branch they served (see the wave-86 header). Survivor for the intent reading:
// mapIntentTypeToLeadSide (above) on the raw row, plus raw_data.classification / motivation_type.

/** Splits a free-text extracted name into first/last, honestly — a single-word name has no
 *  last name (never fabricated from nothing). */
function splitExtractedName(name: string | null): { firstName: string | null; lastName: string | null } {
  const trimmed = (name ?? "").trim()
  if (!trimmed) return { firstName: null, lastName: null }
  const parts = trimmed.split(/\s+/)
  return { firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(" ") : null }
}

/** Where the sender's name was found (recorded on the raw row — lead intelligence provenance). */
export type SenderNameSource = "signature" | "display_name" | "email_local_part" | null

/**
 * deriveSenderName — PURE (lane 85B). The owner's "name from email/signature/PDL": the cheap, free
 * sources are tried here in order of reliability, and a SINGLE-word find is never promoted to a full
 * name (no last name is fabricated). PeopleData (by the sender's email) runs later inside
 * processRawRecord and fills whatever this leaves empty. THE gate still judges the result.
 *   1. signature — the classifier's extractedName ("never invent one" is in its prompt);
 *   2. display name — the From header's "Jane Doe <…>" part;
 *   3. email local part — ONLY the unambiguous "first.last@" / "first_last@" / "first-last@" shape,
 *      two alphabetic tokens of ≥2 letters, never a role or automated mailbox ("info.sales@" is not
 *      a person). "jsmith@" / "jane123@" yield nothing.
 * The first source that yields BOTH parts wins; otherwise the best single first name is kept.
 */
export function deriveSenderName(input: {
  extractedName: string | null
  displayName: string | null
  fromEmail: string
}): { firstName: string | null; lastName: string | null; nameSource: SenderNameSource } {
  const candidates: Array<{ src: Exclude<SenderNameSource, null>; name: string | null }> = [
    { src: "signature", name: input.extractedName },
    { src: "display_name", name: input.displayName && !input.displayName.includes("@") ? input.displayName : null },
  ]
  const local = (input.fromEmail.split("@")[0] ?? "").toLowerCase()
  const tokens = local.split(/[._-]/)
  if (
    tokens.length === 2 && tokens.every((t) => /^[a-z]{2,}$/.test(t)) &&
    !isAutomatedLocalPart(local) && !tokens.some((t) => ROLE_LOCAL_PARTS.has(t))
  ) {
    candidates.push({ src: "email_local_part", name: tokens.map((t) => t[0].toUpperCase() + t.slice(1)).join(" ") })
  }
  let firstOnly: { firstName: string; nameSource: Exclude<SenderNameSource, null> } | null = null
  for (const c of candidates) {
    const { firstName, lastName } = splitExtractedName(c.name)
    if (firstName && lastName) return { firstName, lastName, nameSource: c.src }
    if (firstName && !firstOnly) firstOnly = { firstName, nameSource: c.src }
  }
  return firstOnly ? { firstName: firstOnly.firstName, lastName: null, nameSource: firstOnly.nameSource } : { firstName: null, lastName: null, nameSource: null }
}

/** COUNTED drop — lifecycle_events, entity_type 'system' (the same pattern
 *  lib/kernel/scraping.ts's SCRAPE_SOURCE_RUN_STARTED already uses for a run with no single
 *  entity owner). Never a swallowed console.log — a run of these must be visible (CLAUDE.md
 *  §2: "a count that moves is the finding"). Service-role client → sentinelWrite (CLAUDE.md
 *  §3): a failed audit write is ledgered to self_heal_events rather than only console.error'd,
 *  and the caller's best-effort contract (never throws, never blocks ingress) is unchanged. */
async function recordDrop(
  svc: Svc,
  brokerageId: string,
  reason: string,
  detail: string | null,
  fromEmail: string,
  messageId: string | null,
): Promise<void> {
  // THE ONE EMITTER (wave 101C): emitKernelEvent's client seam — the injected client, audit-only
  // (no fan-out, as before; a null-entity event never fans out anyway), with causation lineage.
  const kernelEmit = await import("@/lib/kernel/emit")
  await sentinelWrite(
    svc,
    kernelEmit.emitKernelEvent({
      client: svc, auditOnly: true,
      brokerageId,
      entityType: "system",
      entityId: null,
      event: KernelEvent.UNKNOWN_SENDER_DROPPED,
      metadata: { reason, detail, from_email: fromEmail, message_id: messageId },
      createdAt: new Date().toISOString(),
    }).then(kernelEmit.asWriteResult),
    { table: "lifecycle_events", flow: "unknown_sender_dropped", brokerageId, reason: "counted drop audit — best effort" },
  )
}

/** Dedup FIRST (task requirement) — an email already belonging to a contact or an
 *  existing lead in this brokerage never mints a second row, whichever mailbox it
 *  landed in. Contacts checked first (a converted relationship is the survivor,
 *  same precedence lib/kernel/listings-batchdata-feed.ts::findLeadOrContactByAddress
 *  already uses for the analogous address-keyed lookup). */
async function findExistingLeadOrContact(
  svc: Svc,
  brokerageId: string,
  email: string,
): Promise<{ kind: "lead" | "contact"; id: string } | null> {
  const emailNorm = email.trim().toLowerCase()
  const { data: contact } = await svc
    .from("contacts")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("email", emailNorm)
    .maybeSingle()
  if (contact) return { kind: "contact", id: (contact as { id: string }).id }

  const { data: lead } = await svc
    .from("leads")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("email", emailNorm)
    .maybeSingle()
  if (lead) return { kind: "lead", id: (lead as { id: string }).id }

  return null
}

interface RawLanding {
  /** A lead id ONLY when processRawRecord CREATED one in this call (name + usable email found). */
  leadId: string | null
  /** The raw_scraped_leads row the sender now lives on (null when ingest inserted nothing). */
  rawId: string | null
  /** processRawRecord's own stage/reason (or the ingest skip reason). */
  pipelineReason: string
}

/**
 * BROKERAGE mailbox → RAW, then the ONE raw path (lane 85B; see the wave-85 header section).
 * ingestRawSourceBatch writes the row (brokerage-origin, market NULL, cost_per_record = the
 * classifier's model cost); processRawRecord runs INLINE: pre-dedup → PeopleData by email (+ the
 * email-seek hook) → post-dedup → THE gate. Returns a leadId only when a lead was CREATED — a dedup
 * merge or a gate refusal leaves the sender raw, where the stranded sweep keeps working it.
 */
async function landUnknownSenderRaw(
  mailboxOwner: ResolvedMailboxOwner,
  sender: { fromEmail: string; displayName: string | null; subject: string | null; body: string; messageId: string | null },
  c: UnknownSenderClassification,
  listingMatch: OwnListingMatch | null,
  costUsd: number,
): Promise<RawLanding> {
  // Wave 86 — every mailbox lands here. The tenant is the VERIFIED mailbox binding's (never a body).
  const brokerageId = mailboxOwner.brokerageId
  const { firstName, lastName, nameSource } = deriveSenderName({
    extractedName: c.extractedName, displayName: sender.displayName, fromEmail: sender.fromEmail,
  })
  const record: NormalizedScrapedRecord = {
    sourceRecordId: sender.messageId ?? `inbound_email_unknown-${sender.fromEmail}-${Date.now()}`,
    source: "inbound_email_unknown",
    behaviorType: "inbound_email_unknown",
    intentType: mapIntentTypeToLeadSide(c.intentType),
    intentSignals: [listingMatch ? `transactional_${c.transactionalType}` : c.intentType],
    firstName,
    lastName,
    email: sender.fromEmail,
    phone: c.extractedPhone,
    propertyAddress: listingMatch?.matchedAddress ?? c.extractedAddress,
    sourceUrl: null,
    motivationScore: null,
    // LEAD INTELLIGENCE HISTORY — the conversation itself, where the name came from, and what it cost.
    rawPayload: {
      channel: "inbound_email",
      subject: sender.subject,
      body: sender.body.slice(0, 10000),
      message_id: sender.messageId,
      from_display_name: sender.displayName,
      name_source: nameSource,
      classification: c,
      listing_match: listingMatch,
      motivation_type: listingMatch ? `transactional_${c.transactionalType}` : (c.intentType !== "unknown" ? c.intentType : null),
      classifier_cost_usd: costUsd,
      // Wave 86 — WHOSE mailbox received it (provenance, not routing: the lead is the brokerage's).
      mailbox_owner_kind: mailboxOwner.ownerKind,
      mailbox_owner_agent_id: mailboxOwner.agentId,
    },
  }

  const { ingestRawSourceBatch } = await import("@/lib/kernel/scraping")
  const ingest = await ingestRawSourceBatch({
    brokerageId, // the VERIFIED mailbox binding's tenant (resolveInboundMailboxOwner) — never a body (§4)
    marketId: null, // m648 — first-party, not territory-bound
    source: "inbound_email_unknown",
    sourceFamily: "inbound_intake", // scrape_category (m647)
    sourceChannel: "inbound_email_unknown",
    records: [record],
    executionId: null,
    marketGeo: null,
    batchCostUsd: costUsd > 0 ? costUsd : null,
  })
  if (ingest.inserted !== 1 || ingest.rawIds.length !== 1) {
    return {
      leadId: null, rawId: null,
      pipelineReason: ingest.skipped_not_viable > 0 ? "not_viable"
        : ingest.skipped_duplicate > 0 ? "duplicate_at_ingest"
        : "not_inserted",
    }
  }
  const rawId = ingest.rawIds[0]
  const { processRawRecord } = await import("@/lib/lead-pipeline/pipeline-processor")
  const result = await processRawRecord(rawId, brokerageId)
  return {
    leadId: result.success && result.action === "created" && result.leadId ? result.leadId : null,
    rawId,
    pipelineReason: `${result.stage}: ${result.reason}`,
  }
}

// TOMBSTONE (wave 86, lane 86A — owner: "yes all mailboxes should be configured the same."):
// createContactForAgentMailbox is DELETED. An agent / team-lead mailbox's unknown sender lands RAW
// through the survivor, landUnknownSenderRaw (above), exactly like the brokerage mailbox's.

export interface UnknownSenderIdentificationResult {
  /** "raw_held" (lane 85B) — the sender landed RAW and did not (yet) pass THE gate (no name found,
   *  or a dedup verdict); the stranded sweep keeps working it. Not a lead. Since wave 86 this is true
   *  of EVERY mailbox — "contact_created" is retired (no mailbox mints a contact directly). */
  outcome: "lead_created" | "raw_held" | "dropped" | "held"
  leadId?: string
  rawId?: string
  reason: string
}

export type UnknownSenderClassifierFn = (params: {
  brokerageId: string
  fromEmail: string
  subject: string | null
  body: string
}) => Promise<ClassifierResult>

/**
 * identifyAndRouteUnknownSender — the entry point BOTH inbound-email doors
 * (app/api/providers/inbound/route.ts and app/api/webhooks/inbound-mail/route.ts)
 * call for a sender that matched no contact and no active lead. `mailboxOwner`
 * (resolveInboundMailboxOwner, above) supplies the TENANT and the provenance; since
 * wave 86 it no longer picks a route (every mailbox lands raw) — never
 * throws, a caller-side failure here must never break inbound ingress (mirrors
 * every other best-effort door these routes already have).
 *
 * `opts.classifier` — test-only injection seam, the SAME idiom
 * lib/ai-isa/inbound-intent-classifier.ts::classifyAndRouteInbound already uses
 * (its own `InboundClassifier` override). Production callers never pass it —
 * classifyUnknownSenderIntent (the real gpt-4o-mini lane) is the default. This
 * lets scripts/lead-email-conversion-simulator.ts prove the FULL routing
 * decision (dedup, transactional listing match, the raw landing for every
 * mailbox) with a fixed classification and ZERO network calls —
 * never a second classifier, the same model call, just not invoked live in CI.
 *
 * `opts.svc`/`opts.landRaw` (lane 75D's `createLead`/`createContact`; `landRaw` replaced
 * `createLead` in lane 85B and `createContact` was retired in wave 86) — blind-spot burn-down
 * (lane 75D): the SAME injection idiom as `opts.classifier`, closing the gap
 * that this whole function previously called `createServiceClient()`
 * internally with NO seam, so scripts/lead-email-conversion-simulator.ts's
 * routing proof (§5) could only run with a real SUPABASE_SERVICE_ROLE_KEY —
 * every environment without one (most CI/sandbox runs) silently skipped the
 * lead/contact BRANCH-SELECTION logic entirely. Production callers pass
 * none of these (defaults: real createServiceClient() + landUnknownSenderRaw).
 * A fixture run supplies a minimal in-memory `svc` (covers the read/dedup/
 * transactional-match/drop-audit calls THIS function makes directly) plus a
 * fake landRaw that stands in for the deep ingestRawSourceBatch/processRawRecord
 * machinery it normally delegates to — proving WHICH branch fires and
 * WITH WHAT arguments, never a claim that the full downstream CRM side
 * effects (assignment, welcome, kernel events) themselves ran without a key;
 * that remains the LIVE section's job.
 */
export async function identifyAndRouteUnknownSender(
  params: {
    mailboxOwner: ResolvedMailboxOwner
    fromEmail: string
    subject: string | null
    body: string
    messageId: string | null
    raw?: unknown
  },
  opts?: {
    classifier?: UnknownSenderClassifierFn
    svc?: Svc
    /** Lane 85B — replaces the retired `createLead` seam: stands in for landUnknownSenderRaw.
     *  (The `createContact` seam is retired with the contact-direct branch, wave 86.) */
    landRaw?: typeof landUnknownSenderRaw
  },
): Promise<UnknownSenderIdentificationResult> {
  const svc = opts?.svc ?? createServiceClient()
  const brokerageId = params.mailboxOwner.brokerageId
  // Lane 85B — providers hand the From header through as "Jane Doe <jane@x.com>" as often as a bare
  // address; the display name is a free name source and the bare address is what every read keys on.
  const from = parseFromHeader(params.fromEmail)
  params = { ...params, fromEmail: from.address }

  // ── Step 1: cheap deterministic pre-filter — NO model call ────────────────
  const pre = preFilterAutomatedSender({ fromEmail: params.fromEmail, raw: params.raw })
  if (pre.isAutomated) {
    await recordDrop(svc, brokerageId, `prefilter:${pre.reason}`, null, params.fromEmail, params.messageId)
    return { outcome: "dropped", reason: `prefilter:${pre.reason}` }
  }

  // ── Step 2: AI real-estate-intent + transactional classification ──────────
  const classify = opts?.classifier ?? classifyUnknownSenderIntent
  const verdict = await classify({
    brokerageId,
    fromEmail: params.fromEmail,
    subject: params.subject,
    body: params.body,
  })

  if (!verdict.available || !verdict.classification) {
    // FAIL CLOSED — never a lead, never a contact, never a guessed drop.
    await recordDrop(svc, brokerageId, "classifier_unavailable", verdict.unavailableReason ?? null, params.fromEmail, params.messageId)
    return { outcome: "held", reason: "classifier_unavailable" }
  }

  const c = verdict.classification
  if (c.isSpamOrVendor) {
    await recordDrop(svc, brokerageId, "classified_spam_or_vendor", `intentType=${c.intentType} confidence=${c.confidence}`, params.fromEmail, params.messageId)
    return { outcome: "dropped", reason: "classified_spam_or_vendor" }
  }

  // ── Step 3: TRANSACTIONAL — the classifier's own read OR a deterministic
  // address match against the brokerage's OWN listings; either one qualifies
  // even with no real-estate intent language (owner ruling, wave 74). ───────
  const listingMatch = await matchEmailToOwnListing(svc, brokerageId, c.extractedAddress)
  const isTransactional = c.isTransactional || listingMatch !== null

  if (!c.hasRealEstateIntent && !isTransactional) {
    await recordDrop(svc, brokerageId, "classified_no_real_estate_intent", `intentType=${c.intentType} confidence=${c.confidence}`, params.fromEmail, params.messageId)
    return { outcome: "dropped", reason: "classified_no_real_estate_intent" }
  }

  // ── Step 4: dedup FIRST — an email already belonging to a contact or lead
  // never mints a second row. ────────────────────────────────────────────────
  const existing = await findExistingLeadOrContact(svc, brokerageId, params.fromEmail)
  if (existing?.kind === "contact") {
    // Should already have been matched at the route's own contact-match step —
    // reaching here means a race (created between that check and this one).
    // Never a duplicate contact, never a stray lead for someone who is already
    // a contact.
    await recordDrop(svc, brokerageId, "already_a_contact", existing.id, params.fromEmail, params.messageId)
    return { outcome: "dropped", reason: "already_a_contact" }
  }

  const routeReason = isTransactional ? `transactional:${c.transactionalType}` : `intent:${c.intentType}`

  // ── Step 5: ONE ROUTE FOR EVERY MAILBOX (wave 85 brokerage path; wave 86: "yes all mailboxes
  // should be configured the same.") — "an unknown sender needs to go through enrichment before lead
  // gate": RAW first, then dedup → enrich → dedup → THE gate (landUnknownSenderRaw). An email already
  // on an existing lead is that lead (dedup above), never a second raw row. The mailbox owner is
  // provenance (raw row + event metadata), never a branch.
  let leadId: string | null = existing?.kind === "lead" ? existing.id : null
  if (!leadId) {
    const landing = await (opts?.landRaw ?? landUnknownSenderRaw)(
      params.mailboxOwner,
      { fromEmail: params.fromEmail, displayName: from.displayName, subject: params.subject, body: params.body, messageId: params.messageId },
      c, listingMatch, verdict.costUsd ?? 0,
    )
    if (!landing.rawId && !landing.leadId) {
      await recordDrop(svc, brokerageId, "raw_landing_failed", landing.pipelineReason, params.fromEmail, params.messageId)
      return { outcome: "dropped", reason: `raw_landing_failed:${landing.pipelineReason}` }
    }
    if (!landing.leadId) {
      // Landed RAW and did not pass THE gate (yet) — not a drop, not a lead. Counted by the raw
      // row itself (RAW_RECORD_CREATED + its processing_status); the sweep keeps working it.
      return { outcome: "raw_held", rawId: landing.rawId ?? undefined, reason: `${routeReason} → raw (${landing.pipelineReason})` }
    }
    leadId = landing.leadId
  }

  const kernelEmit = await import("@/lib/kernel/emit")
  await sentinelWrite(
    svc,
    kernelEmit.emitKernelEvent({
      client: svc, auditOnly: true,
      brokerageId,
      entityType: "lead",
      entityId: leadId ?? null,
      event: KernelEvent.UNKNOWN_SENDER_IDENTIFIED_AS_LEAD,
      metadata: {
        from_email: params.fromEmail, message_id: params.messageId,
        owner_kind: params.mailboxOwner.ownerKind, owner_agent_id: params.mailboxOwner.agentId,
        intent_type: c.intentType, confidence: c.confidence,
        transactional: listingMatch ? { listing_id: listingMatch.listingId, matched_address: listingMatch.matchedAddress, type: c.transactionalType } : null,
      },
    }).then(kernelEmit.asWriteResult),
    { table: "lifecycle_events", flow: "unknown_sender_identified_as_lead", brokerageId },
  )

  return { outcome: "lead_created", leadId, reason: routeReason }
}
