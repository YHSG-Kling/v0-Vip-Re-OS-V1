/**
 * lib/workflow/triggers.ts
 *
 * Curated trigger catalog for the Workflow OS — a UI-presentable subset of
 * the full KernelEvent enum (407 values), plus webhook-only sources that have
 * no kernel-side equivalent (email opens, QR scans, IDX matches, etc.).
 *
 * Why this layer (and not just KernelEvent directly):
 *   - 407 events is too noisy for an agent's trigger dropdown
 *   - We want grouping (Lead, Listing, Buyer, Transaction, etc.) and friendly labels
 *   - We want the same catalog to drive UI dropdowns AND webhook routing
 *
 * Type safety:
 *   - `lifecycle` and `scheduled` triggers MUST reference a real KernelEvent
 *     value — `kernelEvent: KernelEvent` is required and TypeScript catches
 *     renames in the kernel
 *   - `webhook` triggers use plain string literals because their source is
 *     external (no kernel emit), and the webhook handler creates enrollments
 *     directly via /api/workflow/trigger
 *   - `manual` is the empty string — no auto-fire path
 *
 * To add a trigger:
 *   1. lifecycle/scheduled — confirm a matching KernelEvent exists; add the
 *      entry referencing it
 *   2. webhook — add a free-form string entry; the webhook caller posts that
 *      string as `event` to /api/workflow/trigger
 */

import { KernelEvent } from "@/lib/kernel/events"

export type TriggerSource = "lifecycle" | "webhook" | "scheduled" | "manual"

export interface WorkflowTrigger {
  /** Stored on campaign_sequences.trigger_event; matched against KernelEvent or webhook payload.event */
  value:        string
  label:        string
  category:     string
  source:       TriggerSource
  description:  string
  /** When source === "lifecycle" or "scheduled", this MUST be the matching KernelEvent (type-checked). */
  kernelEvent?: KernelEvent
}

/** Helper: lifecycle trigger entry derived from a KernelEvent (value === enum value). */
function lifecycle(event: KernelEvent, label: string, category: string, description: string): WorkflowTrigger {
  return { value: event, label, category, source: "lifecycle", description, kernelEvent: event }
}

/** Helper: scheduled trigger entry derived from a KernelEvent. */
function scheduled(event: KernelEvent, label: string, category: string, description: string): WorkflowTrigger {
  return { value: event, label, category, source: "scheduled", description, kernelEvent: event }
}

/** Helper: webhook-only trigger (no kernel event — fires via /api/workflow/trigger only). */
function webhook(value: string, label: string, category: string, description: string): WorkflowTrigger {
  return { value, label, category, source: "webhook", description }
}

export const WORKFLOW_TRIGGERS: WorkflowTrigger[] = [
  // ─── Lead & Contact ───────────────────────────────────────────────────────
  lifecycle(KernelEvent.CONTACT_CREATED,      "Contact Created",        "Lead & Contact", "A new contact record is created (form, import, manual)."),
  lifecycle(KernelEvent.LEAD_CAPTURED,        "Lead Captured",          "Lead & Contact", "Raw lead captured from form, ad, or open-house sign-in."),
  // CONTACT_CAPTURED was missing from this catalog while being emitted from nine
  // places AND used by the default-sequence seeder — so the seeder's first and
  // most important seed (new-contact nurture) was refused by the column and
  // dropped in silence, and no agent could pick the trigger by hand either.
  lifecycle(KernelEvent.CONTACT_CAPTURED,     "Contact Captured",       "Lead & Contact", "A contact is captured from a form, portal, or inbound conversation."),
  lifecycle(KernelEvent.LEAD_SCORED,          "Lead Score Updated",     "Lead & Contact", "AI lead score changes (new data, behaviour signal, enrichment)."),
  lifecycle(KernelEvent.ISA_QUALIFIED_LEAD,   "ISA Qualified Lead",     "Lead & Contact", "AI ISA qualifies a raw lead and promotes it to a contact."),
  lifecycle(KernelEvent.GHOST_LEAD_DETECTED,  "Ghost Lead Detected",    "Lead & Contact", "Active contact has gone silent for a configurable period."),
  lifecycle(KernelEvent.REENGAGEMENT_STARTED, "Re-engagement Started",  "Lead & Contact", "Dormant contact shows activity again."),
  webhook("contact_email_opened",  "Email Opened",     "Lead & Contact", "Contact opened a campaign email (email-provider webhook)."),
  webhook("contact_link_clicked",  "Link Clicked",     "Lead & Contact", "Contact clicked a tracked link in an email or SMS."),

  // ─── Listing Lifecycle ────────────────────────────────────────────────────
  lifecycle(KernelEvent.LISTING_CREATED,             "Listing Created",                  "Listing", "A listing record is created after compliance approval."),
  lifecycle(KernelEvent.COMING_SOON_SENT,            "Coming Soon Campaign Sent",        "Listing", "Coming-soon marketing campaign dispatched."),
  lifecycle(KernelEvent.LISTING_PUBLISHED,           "Listing Goes Live (MLS)",          "Listing", "Listing status becomes active on the MLS."),
  lifecycle(KernelEvent.OPEN_HOUSE_SCHEDULED,        "Open House Scheduled",             "Listing", "An open house event is created."),
  lifecycle(KernelEvent.LISTING_UNDER_CONTRACT,      "Listing Under Contract",           "Listing", "Listing accepts an offer and moves to under-contract."),
  lifecycle(KernelEvent.LISTING_EXPIRED,             "Listing Expired",                  "Listing", "Listing reaches expiry without going under contract."),
  lifecycle(KernelEvent.LISTING_CANCELLED,           "Listing Cancelled / Withdrawn",    "Listing", "Agent or seller withdraws the listing."),
  lifecycle(KernelEvent.SHOWING_FEEDBACK_RECEIVED,   "Showing Feedback Received",        "Listing", "Buyer's agent submits feedback after a showing."),

  // ─── Buyer Journey ────────────────────────────────────────────────────────
  lifecycle(KernelEvent.BUYER_FINANCIALLY_VERIFIED,  "Buyer Financially Verified",       "Buyer", "Buyer uploads pre-approval or POF and agent confirms."),
  lifecycle(KernelEvent.TOUR_SCHEDULED,              "Tour / Showing Scheduled",         "Buyer", "A property tour or individual showing is booked."),
  lifecycle(KernelEvent.PROPERTY_MATCH_FOUND,        "New Property Match",               "Buyer", "AI identifies a new listing matching saved criteria."),
  lifecycle(KernelEvent.OFFER_SUBMITTED,             "Offer Submitted",                  "Buyer", "Agent submits a purchase offer."),
  lifecycle(KernelEvent.OFFER_ACCEPTED,              "Offer Accepted",                   "Buyer", "Seller accepts the offer — deal enters due-diligence."),
  lifecycle(KernelEvent.OFFER_REJECTED,              "Offer Rejected",                   "Buyer", "Seller does not accept the offer."),
  lifecycle(KernelEvent.OFFER_COUNTER_SENT,          "Counter Offer Received",           "Buyer", "Seller sends back a counter offer."),

  // ─── Transaction ──────────────────────────────────────────────────────────
  lifecycle(KernelEvent.CONTRACT_SIGNED,    "Contract Signed",                "Transaction", "Both parties execute the purchase agreement."),
  lifecycle(KernelEvent.APPRAISAL_ORDERED,  "Appraisal Ordered",              "Transaction", "Lender orders the property appraisal."),
  lifecycle(KernelEvent.CDA_APPROVED,       "CDA Approved",                   "Transaction", "Compliance manager approves the commission disbursement."),
  lifecycle(KernelEvent.DEAL_CLOSED,        "Deal Closed",                    "Transaction", "Transaction reaches a closed status."),
  lifecycle(KernelEvent.TRANSACTION_CLOSED, "Transaction Closed",             "Transaction", "Final transaction closure — fires post-close + lifetime sequences."),

  // ─── Lifetime Customer ────────────────────────────────────────────────────
  lifecycle(KernelEvent.LIFETIME_CUSTOMER,        "Promoted to Lifetime Customer", "Lifetime Customer", "Contact type set to lifetime_customer post-close."),
  scheduled(KernelEvent.ANNIVERSARY_TRIGGERED,    "Home Purchase Anniversary",     "Lifetime Customer", "Annual anniversary of contact's home purchase."),

  // ─── Reputation ───────────────────────────────────────────────────────────
  lifecycle(KernelEvent.REVIEW_RECEIVED,    "Review Received",                "Reputation", "A review is submitted on Google, Zillow, Realtor, etc."),

  // ─── External / Webhook ───────────────────────────────────────────────────
  webhook("ghl_contact_tag_added",  "GHL Tag Added",          "External / Webhook", "Tag added to a contact in Go High Level."),
  webhook("idx_saved_search_match", "IDX Saved Search Match", "External / Webhook", "IDX Broker reports a new matching listing."),
  webhook("qr_scan",                "QR Code Scanned",        "External / Webhook", "Tracked QR code on a marketing piece is scanned."),

  // ─── Manual ───────────────────────────────────────────────────────────────
  { value: "", label: "Manual Enrollment Only", category: "Manual", source: "manual",
    description: "Agent manually enrolls contacts — no automatic trigger." },
]

/** Group triggers by category for use in grouped Select dropdowns. */
export function groupedTriggers(): Record<string, WorkflowTrigger[]> {
  const groups: Record<string, WorkflowTrigger[]> = {}
  for (const t of WORKFLOW_TRIGGERS) {
    if (!groups[t.category]) groups[t.category] = []
    groups[t.category].push(t)
  }
  return groups
}

/** Find a trigger by its value string. */
export function findTrigger(value: string | null | undefined): WorkflowTrigger | undefined {
  if (!value) return WORKFLOW_TRIGGERS.find(t => t.value === "")
  return WORKFLOW_TRIGGERS.find(t => t.value === value)
}

/**
 * The Manual trigger's canonical stored value is the empty string ("" = no
 * auto-fire). Radix <Select.Item> THROWS on an empty-string value, so every
 * dropdown must render Manual with this sentinel and convert back before save.
 * (Legacy rows may store the literal "manual" — treat that as Manual too.)
 */
export const MANUAL_TRIGGER_VALUE = "__manual__"
export const toTriggerSelectValue = (v: string | null | undefined): string =>
  v && v.length > 0 && v !== "manual" ? v : MANUAL_TRIGGER_VALUE
export const fromTriggerSelectValue = (v: string): string =>
  v === MANUAL_TRIGGER_VALUE ? "" : v
