// lib/agentic-os/connected-vendor-registry.ts
// The USER-CONNECTED half of the Agentic API surface. Where vendor-capability-registry.ts
// describes PLATFORM-owned connectors (budget-gated) and app-capability-registry.ts
// describes internal KERNEL operations (scope/role-gated), this registry describes the
// connectors a BROKERAGE wires up from its OWN account — financial (QuickBooks/Stripe),
// email, phone, IDX, social, calendar, podcast syndicator, ShowingTime, transaction,
// e-sign. The brokerage pays these vendors directly, so the platform budget never gates
// them; the gate is whether the account is CONNECTED (connection-manager resolves a live
// credential). `mutates` marks write ops (confirmation before an agent executes).
//
// Pure — no I/O — so the registry + manifest are unit-tested. The live connection gate
// lives in resolve-connected-capability.ts (server).

import type { AgisVerb } from "./vendor-capability-registry"

export type ConnectedCapability =
  | "idx_listing_search"        // search the brokerage's IDX/MLS listing feed
  | "crm_contact_sync"          // push/sync a contact to the connected CRM
  | "email_send"                // send a transactional/marketing email
  | "sms_send"                  // send an SMS (TCPA-gated)
  | "phone_call_place"          // place an outbound phone call (TCPA-gated)
  | "calendar_event_book"       // create a calendar event on the connected calendar
  | "calendar_availability_get" // read free/busy availability
  | "esign_send"                // send a document for e-signature
  | "transaction_forms_open"    // open/create a transaction in the forms provider
  | "showing_schedule"          // schedule a property showing
  | "social_account_publish"    // publish to a connected social account
  | "podcast_syndicate"         // syndicate an episode to the podcast distributor

// NOTE: payments + accounting (Stripe/QuickBooks) are PLATFORM-operated, not user-connected —
// they live in the app-capability registry (domain "finance"), available to all subscribers.
export type ConnectedDomain =
  | "listings" | "crm" | "communications" | "scheduling"
  | "transactions" | "showings" | "social" | "marketing"

export interface ConnectedCapabilityDef {
  capability: ConnectedCapability
  verb: AgisVerb
  scope: string
  domain: ConnectedDomain
  purpose: string
  inputs: string[]
  /** True for write/side-effecting operations — require confirmation before invoke. */
  mutates: boolean
  /** CANONICAL connection provider names (connection-manager). ANY connected satisfies
   *  the gate. Empty would mean "no provider wired" — every entry below has at least one. */
  connections: string[]
}

export const CONNECTED_CAPABILITY_REGISTRY: Record<ConnectedCapability, ConnectedCapabilityDef> = {
  idx_listing_search:        { capability: "idx_listing_search",        verb: "FIND",    scope: "listing:read",      domain: "listings",       mutates: false, purpose: "Search the brokerage's connected IDX/MLS listing feed by criteria.", inputs: ["query", "filters?"], connections: ["idxbroker"] },
  crm_contact_sync:          { capability: "crm_contact_sync",          verb: "UPDATE",  scope: "crm:write",         domain: "crm",            mutates: true,  purpose: "Sync OUT a contact's details to the brokerage's connected CRM (egress only — update contact/details).", inputs: ["contactId"], connections: ["gohighlevel", "lofty", "followupboss", "hubspot"] },
  email_send:                { capability: "email_send",                verb: "NOTIFY",  scope: "comms:email",       domain: "communications", mutates: true,  purpose: "Send an email through the brokerage's connected email provider.", inputs: ["to", "subject", "body"], connections: ["sendgrid", "gmail", "outlook", "resend", "postmark", "mailgun"] },
  sms_send:                  { capability: "sms_send",                  verb: "NOTIFY",  scope: "comms:sms",         domain: "communications", mutates: true,  purpose: "Send an SMS through the connected phone provider (TCPA-gated).", inputs: ["to", "body"], connections: ["twilio", "telnyx", "bandwidth", "plivo", "sinch"] },
  phone_call_place:          { capability: "phone_call_place",          verb: "NOTIFY",  scope: "comms:voice",       domain: "communications", mutates: true,  purpose: "Place an outbound phone call via the connected phone provider (TCPA-gated).", inputs: ["to"], connections: ["twilio", "telnyx", "bandwidth", "plivo", "sinch"] },
  calendar_event_book:       { capability: "calendar_event_book",       verb: "BOOK",    scope: "calendar:write",    domain: "scheduling",     mutates: true,  purpose: "Create an event on the brokerage's connected calendar.", inputs: ["title", "startsAt", "endsAt", "attendees?"], connections: ["nylas", "google_calendar", "outlook"] },
  calendar_availability_get: { capability: "calendar_availability_get", verb: "GET",     scope: "calendar:read",     domain: "scheduling",     mutates: false, purpose: "Read free/busy availability from the connected calendar.", inputs: ["from", "to"], connections: ["nylas", "google_calendar", "outlook"] },
  esign_send:                { capability: "esign_send",                verb: "NOTIFY",  scope: "transaction:esign", domain: "transactions",   mutates: true,  purpose: "Send a document for e-signature through the connected e-sign provider.", inputs: ["transactionId", "documentId", "signers"], connections: ["dotloop", "docusign", "skyslope", "authentisign", "formsimplicity"] },
  transaction_forms_open:    { capability: "transaction_forms_open",    verb: "CREATE",  scope: "transaction:write", domain: "transactions",   mutates: true,  purpose: "Open or create a transaction in the connected forms/transaction provider.", inputs: ["transactionId"], connections: ["dotloop", "skyslope", "brokermint", "formsimplicity"] },
  showing_schedule:          { capability: "showing_schedule",          verb: "BOOK",    scope: "showing:write",     domain: "showings",       mutates: true,  purpose: "Schedule a property showing through the connected showings provider.", inputs: ["listingId", "startsAt", "contactId?"], connections: ["showingtime"] },
  social_account_publish:    { capability: "social_account_publish",    verb: "PUBLISH", scope: "social:connected",  domain: "social",         mutates: true,  purpose: "Publish a post to a connected social account.", inputs: ["assetId", "channels"], connections: ["meta", "facebook", "instagram", "linkedin", "twitter", "tiktok", "youtube", "pinterest", "buffer"] },
  podcast_syndicate:         { capability: "podcast_syndicate",         verb: "PUBLISH", scope: "marketing:podcast", domain: "marketing",      mutates: true,  purpose: "Syndicate a podcast episode to the connected distribution service.", inputs: ["episodeId"], connections: ["podcast_syndicator"] },
}

export function getConnectedCapability(capability: ConnectedCapability): ConnectedCapabilityDef {
  return CONNECTED_CAPABILITY_REGISTRY[capability]
}

export function isConnectedCapability(value: string): value is ConnectedCapability {
  return value in CONNECTED_CAPABILITY_REGISTRY
}

// Intent weight by verb — reads low, writes high (planning/confirmation hint). Mirrors
// the app-capability registry's weighting so the unified manifest sorts consistently.
const VERB_WEIGHT: Partial<Record<AgisVerb, number>> = {
  GET: 0.2, FIND: 0.4, ANALYZE: 0.6, ENRICH: 0.6,
  BOOK: 0.85, CREATE: 0.85, UPDATE: 0.85, NOTIFY: 0.9, ADVANCE: 0.9, PUBLISH: 0.95,
}

export function connectedIntentWeight(def: ConnectedCapabilityDef): number {
  return VERB_WEIGHT[def.verb] ?? (def.mutates ? 0.85 : 0.4)
}
