// lib/providers/mailing-cass-gate.ts
//
// MAILING-ADDRESS CASS GATE — makes leads.mailing_address_verified HONEST at the direct-mail
// chokepoint. The flag is set true at promotion merely because an address STRING exists
// ("canonical eligibility just confirmed it" in lead-promoter / pipeline-processor) or falls back to
// hasMailingData in enrichment — it is NEVER CASS/USPS-verified. [WAVE 14: no longer true upstream —
// that fallback is deleted and the promotion gate now CASS-verifies at the gate when a record has no
// other reachable channel. This gate remains the dispatch-time chokepoint and is still correct.] But dispatchDirectMail (and every
// caller it funnels: AI-ISA speed-to-lead, lead_nurture postcards, lead_intro_reel_play) trusts the
// flag "so we don't pay Lob for an undeliverable piece" — a guarantee the naive flag can't make. So a
// cold scraped lead gets mailed to an unstandardized/undeliverable address: Lob spend burned, and the
// lead stamped first_touched (never retried) — a silent money AND lead leak.
//
// This gate CASS-verifies ONCE at the moment a mail send is actually attempted (so the ~$0.0025 verify
// always gates a real ~$0.50+ mailpiece — never wasted on leads reached by email), then persists the
// result so subsequent sends skip re-verification. Deliverable → standardize + mark lob_cass, proceed.
// Undeliverable (authoritative) → BLOCK the send AND correct the flag to false, so the next
// speed-to-lead decision honestly finds "no permitted channel" instead of firing a doomed piece.
//
// Pure decision logic here (needsCassCheck + interpretLobForGate); the live Lob call + persistence live
// at the dispatch gate. mailing_address_source='lob_cass' is the idempotency marker (a free-text column,
// no migration): once set, a deliverable address is trusted and an undeliverable one is already blocked
// by the existing verified!==true check, so we never re-verify.

import type { LobVerificationResult } from "@/lib/external/lob-address-verify"

/** The CASS-verified marker written to leads.mailing_address_source once Lob has ruled. */
export const CASS_SOURCE = "lob_cass" as const

export interface MailingGateLead {
  mailing_address_verified: boolean | null
  mailing_address_source: string | null
  mailing_address: string | null
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
}

/**
 * PURE: does this lead's (already verified===true) address still need a real CASS check? Yes when it
 * was flag-verified but never Lob-ruled (source !== 'lob_cass'). A source already 'lob_cass' with
 * verified===true is a confirmed-deliverable address we trust; an undeliverable one carries
 * verified===false and is stopped by the existing gate before it ever reaches here. Also honest-skips
 * when there's no address string to verify (nothing to send to → the existing flow handles it).
 */
export function needsCassCheck(lead: MailingGateLead): boolean {
  if (lead.mailing_address_verified !== true) return false // existing gate already blocks
  if (lead.mailing_address_source === CASS_SOURCE) return false // already Lob-ruled deliverable
  if (!lead.mailing_address || !lead.mailing_address.trim()) return false // nothing to verify
  return true
}

export type GateAction = "proceed" | "block" | "defer"

export interface GateDecision {
  action: GateAction
  /** Column patch to persist on the lead (empty on defer). */
  patch: Record<string, unknown>
  reason: string
}

/**
 * PURE: turn a Lob verification result into a gate decision.
 *   • null (no LOB_API_KEY, or a transient timeout/5xx) → DEFER: proceed on the existing flag, write
 *     nothing. Provider-gated exactly like phone-scrub — never block a send on missing/flaky verify,
 *     never fabricate a false disposition.
 *   • deliverable (verified===true) → PROCEED: mark lob_cass + write back Lob's STANDARDIZED address
 *     parts (idempotent; the next send trusts it). Keeps verified===true.
 *   • undeliverable (verified===false, authoritative) → BLOCK: don't pay Lob for the piece; correct the
 *     naive flag to false + mark lob_cass so speed-to-lead stops choosing direct_mail for this lead and
 *     we don't re-verify a known-bad address.
 */
export function interpretLobForGate(lob: LobVerificationResult | null): GateDecision {
  if (!lob) {
    return { action: "defer", patch: {}, reason: "lob_unavailable_or_transient" }
  }
  if (lob.verified) {
    const s = lob.standardized ?? {}
    const patch: Record<string, unknown> = { mailing_address_source: CASS_SOURCE, mailing_address_verified: true }
    if (s.primary_line) patch.mailing_address = s.primary_line
    if (s.city) patch.mailing_city = s.city
    if (s.state) patch.mailing_state = s.state
    if (s.zip_code) patch.mailing_zip = s.zip_code
    return { action: "proceed", patch, reason: `deliverable:${lob.deliverability ?? "deliverable"}` }
  }
  return {
    action: "block",
    patch: { mailing_address_verified: false, mailing_address_source: CASS_SOURCE },
    reason: `undeliverable:${lob.deliverability ?? "undeliverable"}`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SENDER (RETURN) ADDRESS GATE — wave 151, lane 151H. Owner (verbatim): "direct mail, the rendered pieces
// should not use the platform return address". Directive 151H: "Use the tenant's configured return mailing
// address, or another address expressly approved for the actual sender. Check postal deliverability and source
// ownership. Refuse missing/invalid sender address rather than substituting the platform address."
//
// The recipient half of this file asks "may we PAY to mail to THIS mailbox?". This half asks "whose name and
// mailbox go on the OUTSIDE of the piece, and may that address stand as the sender?". The same CASS truth
// applies to both, with one asymmetry that is deliberate: a recipient's unavailable verification DEFERS (the
// existing flag stands in; never block a consented send on a flaky verifier), while a SENDER's missing
// verification REFUSES. The return address is one address per tenant, checked once at setup and reused on
// every piece; a wrong one misroutes every returned piece and prints a stranger's — or the platform's — name
// on the tenant's mail. Nothing is substituted: the refusal names what is missing.
//
// PURE. The async resolver that reads the tenant's configured / approved addresses lives in
// lib/direct-mail/piece-type.ts resolveTenantSenderAddress (folded there for the app/crm/page.tsx module budget);
// the dispatcher (lib/providers/dispatch.ts) and every mail door call THIS decision before Lob's `from` is set.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a sender address came from — THE one vocabulary (CLAUDE.md §6). `brokerage_of_record` is the tenant's
 *  business address from its own profile (configured by the tenant at onboarding); the three `*_address` sources
 *  are rows of direct_mail_sender_addresses (m980), approved by a tenant admin for a scope. */
export type SenderAddressSource = "sender_approved_address" | "team_approved_address" | "tenant_return_address" | "brokerage_of_record"

/** The mailing-address source stamped on a lead / contact whose piece came BACK (m985 outcome returned_to_sender):
 *  stronger than a CASS verdict — the carrier tried. Read by the CASS gate above as "not lob_cass" (so a corrected
 *  address is re-verified) and by needsCassCheck's callers through mailing_address_verified=false. */
const RETURNED_MAIL_SOURCE = "lob_returned_to_sender" as const

export interface SenderAddress {
  /** The sender's legal / business identity printed as the return name (the brokerage of record, a team's dba, or
   *  the approved row's name) — never the platform's. */
  name: string
  line1: string
  line2?: string | null
  city: string
  state: string
  zip: string
  source: SenderAddressSource
  /** CASS evidence. null = never verified (REFUSED as a sender). */
  verification: { method: "lob_cass"; deliverability: string | null; verifiedAt: string | null } | null
  /** direct_mail_sender_addresses.id when the address is an approved row (evidence on the piece). */
  addressId?: string | null
  approvedByUserId?: string | null
}

type SenderAddressRefusalCode = "missing" | "incomplete" | "platform_address" | "unverified" | "undeliverable"

/** Lob's inline `from` shape (postcards.create / letters.create). */
interface LobInlineFrom {
  name: string
  address_line1: string
  address_line2?: string
  address_city: string
  address_state: string
  address_zip: string
  address_country: "US"
}

type SenderAddressDecision =
  | { ok: true; from: LobInlineFrom; source: SenderAddressSource; evidence: { addressId: string | null; verifiedAt: string | null; deliverability: string | null } }
  | { ok: false; code: SenderAddressRefusalCode; reason: string; missing: string[] }

/** The platform's own name, as it must never appear as a sender. Derived from the product brand's name
 *  ("VIP Agents", lib/platform/product-brand.ts DEFAULT_PRODUCT_BRAND) — spelled here without the import so this
 *  module keeps its zero-edge footprint; scripts/direct-mail-rendering-guard.ts holds the two in agreement. */
const PLATFORM_SENDER_NAME_TOKENS = ["vip agents", "vipagents"] as const

/** Lob deliverability buckets a return address may stand with (help.lob.com US verification deliverability). */
const SENDER_DELIVERABLE = new Set(["deliverable", "deliverable_unnecessary_unit", "deliverable_incorrect_unit", "deliverable_missing_unit"])

const SETTINGS_HINT = "Settings → Direct mail → Return address"

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ")

/** PURE — is this candidate the PLATFORM's address? A string candidate is a saved Lob address id (the shape
 *  `LOB_RETURN_ADDRESS_ID` takes — the platform account's saved address; a tenant's address is always inline),
 *  and an inline candidate whose return name is the platform's. */
function isPlatformSenderAddress(candidate: SenderAddress | string | null | undefined, env: { platformLobAddressId?: string | null } = {}): boolean {
  if (candidate == null) return false
  if (typeof candidate === "string") {
    const id = candidate.trim()
    if (!id) return false
    return true // any saved Lob address id is the platform account's; tenants never hold one
  }
  const name = norm(candidate.name)
  if (PLATFORM_SENDER_NAME_TOKENS.some((t) => name.includes(t))) return true
  const pid = (env.platformLobAddressId ?? "").trim()
  return !!pid && candidate.addressId === pid
}

/**
 * PURE — the SHAPE half of the sender decision, with no verification demanded: used at SAVE time (Settings) so a
 * tenant admin is told what is wrong before a verification is bought. Returns null when the shape is acceptable.
 */
export function senderAddressShapeRefusal(candidate: Omit<SenderAddress, "source" | "verification"> | null | undefined, env: { platformLobAddressId?: string | null } = {}): { code: Extract<SenderAddressRefusalCode, "missing" | "incomplete" | "platform_address">; reason: string; missing: string[] } | null {
  if (!candidate) return { code: "missing", reason: `no sender return address — configure the tenant's return mailing address, or approve one for this sender, in ${SETTINGS_HINT}; the platform's address is never used`, missing: ["sender_address"] }
  const missing = (["name", "line1", "city", "state", "zip"] as const).filter((k) => !String(candidate[k] ?? "").trim())
  if (missing.length) return { code: "incomplete", reason: `the sender return address is incomplete (missing ${missing.join(", ")}) — complete it in ${SETTINGS_HINT}`, missing: [...missing] }
  if (!/^\d{5}(-\d{4})?$/.test(String(candidate.zip).trim())) return { code: "incomplete", reason: `the sender return address ZIP "${candidate.zip}" is not a US ZIP — correct it in ${SETTINGS_HINT}`, missing: ["zip"] }
  if (isPlatformSenderAddress({ ...candidate, source: "brokerage_of_record", verification: null }, env)) {
    return { code: "platform_address", reason: "the platform's own return address is never printed on a tenant mailing — the sender is the tenant (its brokerage of record, or an address expressly approved for the sending user)", missing: ["tenant_sender_address"] }
  }
  return null
}

/**
 * PURE — THE SENDER DECISION. REFUSES (nothing mailed, nothing charged), naming what is missing:
 *   · missing          no candidate at all;
 *   · platform_address a saved Lob address id, or the platform's name as the return name — the owner's rule;
 *   · incomplete       a field missing or a non-US ZIP;
 *   · unverified       no CASS evidence — a sender address is verified once (Settings) or at resolve time, never assumed;
 *   · undeliverable    CASS said the return address itself cannot receive mail (returned pieces would be lost).
 * Nothing in this function reads process.env: the platform id is passed in so the proof can plant one.
 */
export function decideSenderAddress(candidate: SenderAddress | string | null | undefined, env: { platformLobAddressId?: string | null } = {}): SenderAddressDecision {
  if (candidate == null) return { ok: false, ...(senderAddressShapeRefusal(null, env) as NonNullable<ReturnType<typeof senderAddressShapeRefusal>>) }
  if (typeof candidate === "string") {
    return { ok: false, code: "platform_address", reason: "a saved Lob address id is the platform account's return address — a tenant mailing prints the tenant's own inline sender address, never the platform's", missing: ["tenant_sender_address"] }
  }
  const shape = senderAddressShapeRefusal(candidate, env)
  if (shape) return { ok: false, ...shape }
  const v = candidate.verification
  if (!v || v.method !== "lob_cass") {
    return { ok: false, code: "unverified", reason: `the sender return address "${candidate.line1}, ${candidate.zip}" (${candidate.source}) has not been CASS-verified — verify it in ${SETTINGS_HINT} (or set LOB_API_KEY so it can be verified once at resolve time)`, missing: ["sender_address_verification"] }
  }
  if (v.deliverability && !SENDER_DELIVERABLE.has(v.deliverability)) {
    return { ok: false, code: "undeliverable", reason: `the sender return address "${candidate.line1}, ${candidate.zip}" is ${v.deliverability} per CASS — a return address that cannot receive mail loses every returned piece; correct it in ${SETTINGS_HINT}`, missing: ["deliverable_sender_address"] }
  }
  const from: LobInlineFrom = {
    name: candidate.name.trim(),
    address_line1: candidate.line1.trim(),
    ...(candidate.line2?.trim() ? { address_line2: candidate.line2.trim() } : {}),
    address_city: candidate.city.trim(),
    address_state: candidate.state.trim().toUpperCase(),
    address_zip: candidate.zip.trim(),
    address_country: "US",
  }
  return { ok: true, from, source: candidate.source, evidence: { addressId: candidate.addressId ?? null, verifiedAt: v.verifiedAt, deliverability: v.deliverability } }
}

// ─── RETURNED MAIL (wave 151, lane 151H — "returned-mail handling updates the address record and stops the sequence") ──

export interface ReturnedMailRecipient {
  id: string
  campaign_id: string | null
  lead_id?: string | null
  contact_id?: string | null
  address_line1: string | null
  zip: string | null
  delivery_status?: string | null
}

export interface ReturnedMailPlan {
  /** Patch for leads / contacts (the entity the piece names): the address is no longer verified, and the source says why. */
  entityPatch: { mailing_address_verified: false; mailing_address_source: typeof RETURNED_MAIL_SOURCE }
  /** Which entity rows take it. */
  leadId: string | null
  contactId: string | null
  /** Address-only recipients (no lead, no contact) have no record to correct: the mailbox key itself is suppressed for
   *  mail (contact_suppression_list.mailing_address_key, reason returned_to_sender) so the sequence stops there too. */
  suppressAddress: boolean
  /** Pending siblings in the SAME campaign to the SAME mailbox — stopped (delivery_status failed) before they are printed. */
  stopRecipientIds: string[]
  reason: string
}

/** The household key for sibling matching inside ONE campaign (street line + ZIP5, case/space-insensitive). The
 *  cross-campaign identity stays lib/direct-mail/address-suppression.ts mailingAddressSuppressionKey — not re-implemented. */
function sameMailbox(a: { address_line1: string | null; zip: string | null }, b: { address_line1: string | null; zip: string | null }): boolean {
  const key = (r: { address_line1: string | null; zip: string | null }) => `${norm(r.address_line1)}|${String(r.zip ?? "").trim().slice(0, 5)}`
  return !!a.address_line1 && !!a.zip && key(a) === key(b)
}

/** PURE — what a returned piece changes. The entity's address record is corrected (verified=false, source
 *  lob_returned_to_sender — the CASS gate then re-verifies a corrected address instead of trusting the old flag),
 *  pending siblings to the same mailbox in the same campaign are stopped, and an address-only recipient's mailbox is
 *  suppressed. Nothing here is a success: a returned piece is money spent on a wrong record. */
export function planReturnedMailHandling(returned: ReturnedMailRecipient, campaignRecipients: ReturnedMailRecipient[]): ReturnedMailPlan {
  const stopRecipientIds = campaignRecipients
    .filter((r) => r.id !== returned.id && (r.delivery_status ?? "pending") === "pending" && sameMailbox(returned, r))
    .map((r) => r.id)
  const leadId = returned.lead_id ?? null
  const contactId = returned.contact_id ?? null
  return {
    entityPatch: { mailing_address_verified: false, mailing_address_source: RETURNED_MAIL_SOURCE },
    leadId,
    contactId,
    suppressAddress: !leadId && !contactId,
    stopRecipientIds,
    reason: `returned to sender: ${leadId ? "lead" : contactId ? "contact" : "address-only recipient"} record corrected, ${stopRecipientIds.length} pending piece(s) to the same mailbox stopped`,
  }
}
