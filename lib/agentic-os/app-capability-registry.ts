// lib/agentic-os/app-capability-registry.ts
// Expands the Agentic API beyond external CONNECTORS to the app's own KERNEL
// operations (leads, CRM, CMA, calendar, transactions, listings, ISA). Same
// agenticapi.com model — AGIS intent verb + granular scope + business context — but
// gated by SCOPE/role (not vendor budget). `mutates` marks write ops, which (like
// side-effecting verbs) require confirmation before an agent executes them.
//
// Pure — no I/O — so the registry + the unified manifest are unit-tested.

import { buildActionManifest, type AgisVerb } from "./vendor-capability-registry"
import { type VendorOwnership } from "./vendor-ownership"
import { CONNECTOR_PROVIDERS } from "@/lib/connections/scope"
import {
  CONNECTED_CAPABILITY_REGISTRY,
  connectedIntentWeight,
  type ConnectedCapability,
} from "./connected-vendor-registry"

export type AppCapability =
  | "lead_search"          // find leads in a brokerage by criteria
  | "contact_get"          // fetch a contact record
  | "cma_generate"         // generate a CMA report (writes + may spend)
  | "appointment_schedule" // book an appointment on the calendar
  | "transaction_advance"  // advance a transaction to the next stage
  | "listing_publish"      // publish a listing (coming-soon → active)
  | "isa_qualify"          // run AI-ISA qualification on a lead
  | "lead_create"          // create a lead/contact record
  // ── Expansive domains (marketing / social / reporting / education / portal / etc.) ──
  | "newsletter_send"      // send/schedule a newsletter campaign
  | "blog_publish"         // publish a blog post
  | "marketing_campaign_create" // create a multi-channel marketing campaign
  | "content_repurpose"    // repurpose a content asset across channels
  | "social_post_publish"  // publish/distribute a social post
  | "report_generate"      // generate a reporting workspace report
  | "report_export"        // export a report (csv/pdf)
  | "education_path_get"    // fetch a contact's personalized learning path
  | "education_assign"     // assign an educational resource to a contact
  | "portal_milestones_get" // fetch a client-portal milestone timeline
  | "review_request_send"  // send a reputation review request
  | "inbox_reply_send"     // send a reply in the universal inbox
  | "podcast_publish"      // publish a podcast episode
  | "direct_mail_send"     // submit a direct-mail campaign (print/Lob)
  | "video_distribute"     // distribute a marketing video across channels
  | "gift_send"            // trigger a closing/nurture gift order
  | "handwritten_note_send" // send a handwritten thank-you note
  | "connectivity_scan"    // report live api/oauth/mcp connector health (Connectivity Agent)
  | "payment_transfer"     // platform-operated Stripe payout/transfer (offered to all subscribers)
  | "accounting_sync"      // platform-operated QuickBooks invoice/journal sync

export type AppDomain =
  | "lead_generation" | "crm" | "valuation" | "scheduling" | "transactions" | "listings"
  | "marketing" | "social" | "reporting" | "education" | "portal" | "reputation" | "communications" | "gifting"
  | "connectivity" | "finance"

/**
 * WHAT A CAPABILITY NEEDS IN ORDER TO ACTUALLY RUN — its contract.
 *
 * The manifest already says who is AUTHORIZED (scope). It said nothing about
 * whether the capability is OPERABLE, and those are different questions: a
 * caller can hold `finance:write` while the tenant has no QuickBooks connected
 * at all. Since buildFullActionManifest powers /api/agentic-os/actions AND the
 * MCP `tools/list`, every connected agent was advertised all 27 capabilities as
 * available and could only discover otherwise BY CALLING ONE AND FAILING.
 *
 * Two kinds of dependency, because the codebase already distinguishes them
 * (lib/providers/tenancy-matrix.ts, platform_credentials):
 *
 *   connections  a TENANT connection from the Connection OS
 *                (lib/connections/scope.ts CONNECTOR_PROVIDERS). ANY-of: one
 *                live connection satisfies it.
 *   platform     a PLATFORM-owned credential the tenant does not connect —
 *                system-managed lanes. CONNECTOR_PROVIDERS deliberately leaves
 *                `marketing: []` for exactly this reason.
 *
 * ANY-of ACROSS BOTH, not connections-then-stop. A capability may be reachable
 * either way and several are: distributing a video rides a connected social
 * account OR the platform email lane. Phase 1 returned as soon as `connections`
 * was present and never looked at `platform`, so a tenant with no social
 * account read dark on a capability the platform email lane could serve.
 *
 * EVERY declaration below is grounded in the gate the code ACTUALLY hits — the
 * `if (!process.env.X) return unconfigured` in the dispatcher, not a guess at
 * which vendor sounds right. Phase 1 guessed twice and got both wrong:
 * `video_distribute` was filed against the D-ID render key (D-ID renders video;
 * it has nothing to do with distributing one) and every platform lane was
 * checked against platform_credentials ROWS while the dispatchers gate on ENV
 * KEYS — so Lob read dark with LOB_API_KEY set and direct mail sending fine.
 *
 * Undeclared means "no external dependency known" — see UNDECLARED_REQUIREMENTS
 * below, which keeps the not-yet-modelled ones VISIBLE rather than letting an
 * absent contract read as a satisfied one.
 */
export interface CapabilityRequirement {
  /** Tenant connections, any-of. Names must be Connection OS providers. */
  connections?: readonly string[]
  /** Platform-owned credentials, any-of. Not tenant-connectable. */
  platform?: readonly string[]
}

export interface AppCapabilityDef {
  capability: AppCapability
  verb: AgisVerb
  scope: string
  domain: AppDomain
  purpose: string
  inputs: string[]
  /** True for write/side-effecting operations — require confirmation before invoke. */
  mutates: boolean
  /** What must be in place for this to run. Absent = no known external dependency. */
  requires?: CapabilityRequirement
}

export const APP_CAPABILITY_REGISTRY: Record<AppCapability, AppCapabilityDef> = {
  lead_search:          { capability: "lead_search",          verb: "FIND",    scope: "lead:read",         domain: "lead_generation", mutates: false, purpose: "Search the brokerage's leads by status, source, score, or territory.", inputs: ["brokerageId", "filters?"] },
  contact_get:          { capability: "contact_get",          verb: "GET",     scope: "contact:read",      domain: "crm",             mutates: false, purpose: "Fetch a single contact record (CRM) with its lead lineage.", inputs: ["contactId"] },
  // GROUNDED: BOTH CMA paths gate on the same RentCast credential —
  // app/actions/ai-cma.ts fetchComparableProperties() and lib/cma/comp-provider.ts
  // (the sourcing behind runAiCma) call getRentcastComps, which resolves a tenant
  // integration_credentials row for rentcast, else the platform RENTCAST_API_KEY.
  // With neither it returns [] and the CMA renders with zero comparables, which is
  // not a CMA. A connected IDX Broker feed does NOT satisfy this: IDX can serve the
  // ACTIVE side of the comp mix but cannot serve SOLD comparables at all, and a CMA
  // with no closed sales has no value range. Declared platform-scope: the readiness
  // resolver already lets a tenant's own key satisfy a platform lane.
  cma_generate:         { capability: "cma_generate",         verb: "ANALYZE", scope: "cma:write",         domain: "valuation",       mutates: true,  purpose: "Generate a comparative market analysis report for a property.", inputs: ["agentId", "propertyAddress", "propertyCity", "propertyState", "propertyZip"], requires: { platform: ["rentcast"] } },
  appointment_schedule: { capability: "appointment_schedule", verb: "BOOK",    scope: "calendar:write",    domain: "scheduling",      mutates: true,  purpose: "Book an appointment on an agent's calendar with a contact.", inputs: ["agentId", "contactId", "startsAt", "durationMin?"] },
  transaction_advance:  { capability: "transaction_advance",  verb: "ADVANCE", scope: "transaction:write", domain: "transactions",    mutates: true,  purpose: "Advance a transaction to its next valid lifecycle stage.", inputs: ["transactionId", "toStatus"] },
  listing_publish:      { capability: "listing_publish",      verb: "PUBLISH", scope: "listing:write",     domain: "listings",        mutates: true,  purpose: "Publish a listing (signed agreement → coming-soon / active).", inputs: ["listingId"] },
  isa_qualify:          { capability: "isa_qualify",          verb: "ANALYZE", scope: "lead:qualify",      domain: "lead_generation", mutates: true,  purpose: "Run AI-ISA qualification on a lead and record the outcome.", inputs: ["leadId"] },
  lead_create:          { capability: "lead_create",          verb: "CREATE",  scope: "lead:write",        domain: "lead_generation", mutates: true,  purpose: "Create a new lead/contact record from supplied identity.", inputs: ["brokerageId", "firstName", "lastName", "email?", "phone?"] },

  // GROUNDED: the publish-newsletters cron dispatches through dispatchEmail, which
  // ends at messagingSendEmail for EVERY providerKey — SENDGRID_API_KEY absent is a
  // clean "SendGrid not configured" refusal, so the platform email lane IS the gate.
  newsletter_send:          { capability: "newsletter_send",          verb: "NOTIFY",  scope: "marketing:send",   domain: "marketing",      mutates: true,  purpose: "Send or schedule a newsletter campaign to a contact segment.", inputs: ["brokerageId", "campaignId", "scheduledAt?"], requires: { platform: ["sendgrid"] } },
  blog_publish:             { capability: "blog_publish",             verb: "PUBLISH", scope: "marketing:write",  domain: "marketing",      mutates: true,  purpose: "Publish a drafted blog post to the brokerage's site/SEO engine.", inputs: ["brokerageId", "postId"] },
  marketing_campaign_create:{ capability: "marketing_campaign_create",verb: "CREATE",  scope: "marketing:write",  domain: "marketing",      mutates: true,  purpose: "Create a multi-channel marketing campaign.", inputs: ["brokerageId", "name", "channels"] },
  content_repurpose:        { capability: "content_repurpose",        verb: "CREATE",  scope: "content:write",    domain: "marketing",      mutates: true,  purpose: "Repurpose an existing content asset into another channel format.", inputs: ["brokerageId", "assetId", "targetChannel"] },
  social_post_publish:      { capability: "social_post_publish",      verb: "PUBLISH", scope: "social:write",     domain: "social",         mutates: true,  purpose: "Publish/distribute a post to connected social channels.", inputs: ["brokerageId", "assetId", "channels"], requires: { connections: CONNECTOR_PROVIDERS.social } },
  report_generate:          { capability: "report_generate",          verb: "ANALYZE", scope: "reporting:read",   domain: "reporting",      mutates: false, purpose: "Generate a reporting-workspace report (source/ROI/pipeline/team/financial).", inputs: ["brokerageId", "reportType", "range?"] },
  report_export:            { capability: "report_export",            verb: "GET",     scope: "reporting:read",   domain: "reporting",      mutates: false, purpose: "Export a generated report as CSV or PDF.", inputs: ["brokerageId", "reportId", "format"] },
  education_path_get:       { capability: "education_path_get",        verb: "GET",     scope: "education:read",   domain: "education",      mutates: false, purpose: "Fetch a contact's personalized learning path.", inputs: ["contactId"] },
  education_assign:         { capability: "education_assign",          verb: "CREATE",  scope: "education:write",  domain: "education",      mutates: true,  purpose: "Assign an educational resource to a contact.", inputs: ["contactId", "resourceId"] },
  portal_milestones_get:    { capability: "portal_milestones_get",     verb: "GET",     scope: "portal:read",      domain: "portal",         mutates: false, purpose: "Fetch the client-portal milestone timeline for a contact/transaction.", inputs: ["contactId"] },
  // GROUNDED: app/api/cron/review-request-on-close composes then dispatchEmail's —
  // same platform email lane. Refused sends stay 'pending', never stamped sent.
  review_request_send:      { capability: "review_request_send",       verb: "NOTIFY",  scope: "reputation:write", domain: "reputation",     mutates: true,  purpose: "Send a review request to a past client (reputation engine).", inputs: ["brokerageId", "contactId"], requires: { platform: ["sendgrid"] } },
  // GROUNDED: sendInboxReply tries the agent's OWN connected mailbox first
  // (sendPersonalEmail → gmail/outlook), then the platform email lane, and sms
  // through dispatchSms (per-actor Twilio credential, else the platform key).
  // portal/chat is in-app and needs no provider. ANY-of across both kinds,
  // because which lane a reply needs depends on the thread's channel — and
  // because an agent with their own mailbox connected does not need SendGrid.
  inbox_reply_send:         { capability: "inbox_reply_send",          verb: "NOTIFY",  scope: "comms:write",      domain: "communications", mutates: true,  purpose: "Send a reply in the universal inbox (compliance-gated).", inputs: ["brokerageId", "threadId", "body"], requires: { connections: [...CONNECTOR_PROVIDERS.email, ...CONNECTOR_PROVIDERS.phone], platform: ["sendgrid", "twilio"] } },
  podcast_publish:          { capability: "podcast_publish",           verb: "PUBLISH", scope: "marketing:write",  domain: "marketing",      mutates: true,  purpose: "Publish a podcast episode to the brokerage's distribution channels.", inputs: ["brokerageId", "episodeId"], requires: { connections: CONNECTOR_PROVIDERS.podcast } },
  // GROUNDED: dispatchDirectMail reads process.env.LOB_API_KEY and returns
  // "Direct mail provider (Lob) not configured" without it. PLATFORM_PROVIDER_KEYS
  // already maps lob → LOB_API_KEY for the Integration Guardian's probe.
  direct_mail_send:         { capability: "direct_mail_send",          verb: "NOTIFY",  scope: "marketing:send",   domain: "marketing",      mutates: true,  purpose: "Submit a direct-mail campaign for print + delivery (Lob).", inputs: ["brokerageId", "campaignId"], requires: { platform: ["lob"] } },
  // GROUNDED in distributeVideo's real branches: post_now/schedule write a
  // social_posts row against a connected social account; email_to_client enqueues
  // to email_queue, which the queue-drain cron sends via dispatchEmail (SendGrid).
  // So EITHER lane distributes a video — the any-of case that phase 1's
  // connections-then-stop resolution could not express.
  //
  // OWNER RULING honoured: video is not a channel. It is delivered IN an email or
  // an sms, so the contract names the DELIVERY lanes, not the render providers.
  // (D-ID + ElevenLabs render the video; a render key does not distribute one.)
  video_distribute:         { capability: "video_distribute",          verb: "PUBLISH", scope: "marketing:write",  domain: "marketing",      mutates: true,  purpose: "Distribute a marketing video asset across configured channels.", inputs: ["brokerageId", "videoProjectId", "channels"], requires: { connections: CONNECTOR_PROVIDERS.social, platform: ["sendgrid"] } },
  // GROUNDED, and the grounding is that it needs NO external provider. Per the
  // owner's ruling, a gift with no vendor row still produces a real outcome: the
  // Gift Studio's composer (lib/gifting/gift-studio composeGiftSelections) mines
  // the contact's own file for memory-grounded picks, personalizes from THEIR
  // closed address, dedupes against past gifts and hands the agent pre-scoped
  // ETSY vendor searches on the task. Deterministic, in-repo, always available —
  // so this is operable on the kernel alone, not held.
  gift_send:                { capability: "gift_send",                 verb: "NOTIFY",  scope: "gifting:write",    domain: "gifting",        mutates: true,  purpose: "Recommend and order a closing/nurture gift for a contact (AI picks + Etsy vendors when no gifting vendor is on file).", inputs: ["brokerageId", "contactId", "giftType?"] },
  // GROUNDED: per the owner's ruling a handwritten note "runs the same line as a
  // postcard or card" — it is the DIRECT MAIL lane, dispatchDirectMail → Lob,
  // gated by process.env.LOB_API_KEY exactly like direct_mail_send.
  handwritten_note_send:    { capability: "handwritten_note_send",     verb: "NOTIFY",  scope: "gifting:write",    domain: "gifting",        mutates: true,  purpose: "Mail a handwritten-style thank-you card to a contact (print + delivery via the direct-mail lane).", inputs: ["brokerageId", "contactId", "message?"], requires: { platform: ["lob"] } },

  connectivity_scan:        { capability: "connectivity_scan",         verb: "GET",     scope: "connectivity:read", domain: "connectivity",  mutates: false, purpose: "Report live connection health of every api/oauth/mcp connector for the brokerage (expiry-aware).", inputs: ["brokerageId?"] },

  // "PLATFORM Stripe" per its own purpose — a tenant does not connect this.
  payment_transfer:         { capability: "payment_transfer",          verb: "CREATE",  scope: "finance:write",    domain: "finance",        mutates: true,  purpose: "Move funds / commission payout via the PLATFORM Stripe account (offered to all subscribers).", inputs: ["amount", "destinationAccountId", "description?"], requires: { platform: ["stripe"] } },
  accounting_sync:          { capability: "accounting_sync",           verb: "UPDATE",  scope: "finance:write",    domain: "finance",        mutates: true,  purpose: "Sync an invoice or journal entry to the PLATFORM QuickBooks account (offered to all subscribers).", inputs: ["kind", "amount?", "customerRef?"], requires: { platform: ["quickbooks"] } },
}

/**
 * THE BACKLOG IS EMPTY — every capability now states what it needs.
 *
 * This list existed because two capabilities had a real dependency nobody had
 * asserted, and an absent contract must never read like a satisfied one. Both are
 * now declared, and the owner's rulings are why:
 *
 *   handwritten_note_send  "handwritten notes run the same line as a postcard or
 *                          card" — so it is the direct-mail lane (Lob), not a
 *                          human errand. Declared platform: ["lob"], same gate as
 *                          direct_mail_send, and the reputation kernel now
 *                          actually dispatches it there.
 *
 *   gift_send              "when the gift send has no gifting vendor row, ai makes
 *                          a suggestion of the gift and a selection of etsy
 *                          vendors within the task" — which the Gift Studio's
 *                          composer already did. That makes the capability
 *                          operable on the KERNEL ALONE: no vendor row, no API
 *                          key, no held state. The picks are deterministic and
 *                          in-repo, so there is nothing external to require.
 *
 * The array stays, at length zero, deliberately: the guard pins it empty, so the
 * next capability added without a contract has to come through here and justify
 * itself rather than slipping in as "no dependency known".
 */
export const UNDECLARED_REQUIREMENTS: readonly AppCapability[] = [] as const

export function getAppCapability(capability: AppCapability): AppCapabilityDef {
  return APP_CAPABILITY_REGISTRY[capability]
}

// Intent weight by verb — reads low, writes high (planning/confirmation hint).
const VERB_WEIGHT: Partial<Record<AgisVerb, number>> = {
  GET: 0.2, FIND: 0.4, ANALYZE: 0.6, ENRICH: 0.6,
  BOOK: 0.85, CREATE: 0.85, UPDATE: 0.85, ADVANCE: 0.9, PUBLISH: 0.95,
}

export interface UnifiedAction {
  action: string
  kind: "vendor" | "app" | "connected"
  verb: AgisVerb
  capability: string
  category: string
  scope: string
  purpose: string
  inputs: string[]
  intentWeight: number
  mutates: boolean
  /** Who owns the vendor key/cost — decides the gate: platform=budget, user_connected=connection. */
  ownership: VendorOwnership
  /** For user-connected actions: the canonical provider names that satisfy the connection gate. */
  connections?: string[]
}

/** Pure: app kernel operations as agentic actions (vendor-anonymous; scope-tagged). */
export function buildAppActionManifest(): UnifiedAction[] {
  return (Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]).map((cap) => {
    const def = APP_CAPABILITY_REGISTRY[cap]
    return {
      action: `${def.verb} ${cap}`,
      kind: "app" as const,
      verb: def.verb,
      capability: cap,
      category: def.domain,
      scope: def.scope,
      purpose: def.purpose,
      inputs: def.inputs,
      intentWeight: VERB_WEIGHT[def.verb] ?? (def.mutates ? 0.85 : 0.4),
      mutates: def.mutates,
      // Internal kernel operations run on platform infrastructure (platform-owned).
      ownership: "platform" as const,
    }
  })
}

/** Pure: user-CONNECTED vendor connectors as agentic actions. Gated by connection
 *  presence (not platform budget) — the brokerage owns the account. */
export function buildConnectedActionManifest(): UnifiedAction[] {
  return (Object.keys(CONNECTED_CAPABILITY_REGISTRY) as ConnectedCapability[]).map((cap) => {
    const def = CONNECTED_CAPABILITY_REGISTRY[cap]
    return {
      action: `${def.verb} ${cap}`,
      kind: "connected" as const,
      verb: def.verb,
      capability: cap,
      category: def.domain,
      scope: def.scope,
      purpose: def.purpose,
      inputs: def.inputs,
      intentWeight: connectedIntentWeight(def),
      mutates: def.mutates,
      ownership: "user_connected" as const,
      connections: def.connections,
    }
  })
}

/**
 * Pure: the UNIFIED Agentic API manifest — every external connector capability AND
 * every internal kernel operation, as one machine-readable, vendor-anonymous surface
 * an agent can DISCOVER. Sorted by intent weight (most consequential first).
 */
export function buildFullActionManifest(): UnifiedAction[] {
  const vendor: UnifiedAction[] = buildActionManifest().map((a) => ({
    action: a.action,
    kind: "vendor" as const,
    verb: a.verb,
    capability: a.capability,
    category: a.category,
    scope: a.scope,
    purpose: a.purpose,
    inputs: a.inputs,
    intentWeight: a.intentWeight,
    mutates: a.verb === "RENDER" || a.verb === "NOTIFY",
    // Every connector in the vendor registry is platform-owned (platform holds the key
    // and pays); usage is budget-gated. User-connected vendors live in the connected manifest.
    ownership: "platform" as const,
  }))
  return [...vendor, ...buildAppActionManifest(), ...buildConnectedActionManifest()]
    .sort((a, b) => b.intentWeight - a.intentWeight)
}
