/**
 * lib/kernel/vendor-request.ts
 *
 * VENDOR REQUEST RAIL (owner rule: "any vendor that is part of the transaction
 * should be able to make edits/update to their owned area") — the lender got a
 * structured "request documents" loop; this is the same loop for EVERY other
 * vendor on the deal. An inspector needs the gate code and utilities on; a
 * stager needs an access window; a photographer needs the listing cleared —
 * today those asks live in phone tag. Now a vendor assigned to a transaction
 * files ONE structured request and the OS routes it: a ledger event, the
 * agent's task (due-dated), and — when the ask is really for the client — a
 * GATED portal draft through the agent's governed rail (a vendor can never
 * message a client directly; the agent approves every word).
 *
 * Pure composers here (testable, no I/O); the server action owns auth
 * (requireVendorActor + assignment-on-THIS-deal) and persistence.
 * deal_coordinator owns transactions + the vendor bench.
 */
import { VENDOR_CATEGORY_LABELS, type VendorCategory } from "@/lib/kernel/vendor-categories"

/** PURE — the human label for a stored category token, falling back to a
 *  title-cased form so an unrecognised legacy value still reads as a word. */
export function vendorCategoryLabel(raw: string): string {
  const known = VENDOR_CATEGORY_LABELS[raw as VendorCategory]
  if (known) return known
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export const VENDOR_REQUEST_TYPES = {
  document: "Documents needed",
  access: "Property access",
  information: "Information needed",
  scheduling: "Scheduling",
} as const

export type VendorRequestType = keyof typeof VENDOR_REQUEST_TYPES

export interface VendorRequestInput {
  requestType: string
  details: string
  neededBy?: string | null
}

/** PURE: validate a request — honest, specific refusals (never a silent drop). */
export function validateVendorRequest(input: VendorRequestInput): { ok: true; requestType: VendorRequestType } | { ok: false; error: string } {
  if (!(input.requestType in VENDOR_REQUEST_TYPES)) {
    return { ok: false, error: `Unknown request type — expected one of: ${Object.keys(VENDOR_REQUEST_TYPES).join(", ")}` }
  }
  const details = (input.details ?? "").trim()
  if (details.length < 10) {
    return { ok: false, error: "Tell the deal team specifically what you need (at least a sentence) so they can act without a call back." }
  }
  if (details.length > 2000) {
    return { ok: false, error: "Keep the request under 2000 characters — attach documents through the deal file instead." }
  }
  return { ok: true, requestType: input.requestType as VendorRequestType }
}

export interface VendorRequestTaskParams {
  vendorName: string
  vendorCategory: string | null
  requestType: VendorRequestType
  details: string
  propertyAddress: string | null
  neededBy: string | null
}

/** PURE: the agent's task for a vendor request — who asked, for what, by when. */
export function composeVendorRequestTask(p: VendorRequestTaskParams): { title: string; description: string } {
  // Render the LABEL, not the stored token. vendors.category is lowercase_snake
  // since m304 ("pest_control", "title"), which is right for a vocabulary and
  // wrong for a sentence an agent reads — this line would have produced
  // "Apex Inspections (inspector)" and "(pest_control)".
  const who = p.vendorCategory
    ? `${p.vendorName} (${vendorCategoryLabel(p.vendorCategory)})`
    : p.vendorName
  const where = p.propertyAddress ? ` on ${p.propertyAddress}` : ""
  const by = p.neededBy ? ` Needed by ${p.neededBy}.` : ""
  return {
    title: `${VENDOR_REQUEST_TYPES[p.requestType]} — ${p.vendorName}`,
    description: `${who} filed a request${where}: ${p.details.trim()}${by} Resolve it or loop in the client so the vendor isn't blocked.`,
  }
}

/**
 * PURE: which deal party a CLIENT-FACING ask belongs to. Property-side asks
 * (access, scheduling a visit) go to the occupant — the primary/listing
 * contact; paperwork/information asks go to the buyer first. The draft is
 * GATED either way, so the agent corrects any mis-route before it sends.
 */
export function clientPartyForRequest(requestType: VendorRequestType, tx: { contact_id: string | null; buyer_contact_id: string | null }): string | null {
  if (requestType === "access" || requestType === "scheduling") {
    return tx.contact_id ?? tx.buyer_contact_id ?? null
  }
  return tx.buyer_contact_id ?? tx.contact_id ?? null
}

/** PURE: the gated client draft body — warm, specific, never vendor-jargon. */
export function composeClientRequestBody(p: { vendorName: string; vendorCategory: string | null; requestType: VendorRequestType; details: string; neededBy: string | null }): { subject: string; body: string } {
  // "your inspector" / "your title company" — the label lowercased reads
  // naturally in a sentence; the raw token ("pest_control") does not.
  const role = p.vendorCategory ? vendorCategoryLabel(p.vendorCategory).toLowerCase() : "vendor"
  const by = p.neededBy ? ` They're hoping to have this by ${p.neededBy}.` : ""
  return {
    subject: `Quick request from your ${role}`,
    body: `${p.vendorName} — the ${role} working on your deal — needs one thing from you: ${p.details.trim()}${by} Reply here or let me know if anything about this is tricky and I'll sort it out with them.`,
  }
}
