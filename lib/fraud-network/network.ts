// lib/fraud-network/network.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// REAL ESTATE TRUST & FRAUD INTELLIGENCE NETWORK — the domain service (wave 156, lane 156J; directive 156J; owner
// decision 10: "setup a community area that all tenants can share any known fraudsters in real estate").
//
// THE OWNER'S WORDS, MADE SAFE. A shared list of "known fraudsters" is a blacklist of people: it defames the wrongly
// named, it can become a consumer report (15 U.S.C. §1681a(d) — a communication bearing on a person's character or
// reputation used for eligibility), and it invites automatic denial of housing or service. So this network shares
// TACTICS, not people, and keeps two records that are never one accusation:
//   A. a PRIVATE incident case — the reporting tenant's (fraud_incident_cases, fraud_case_evidence), read only by the
//      reporter, the tenant's case reviewers and platform safety staff;
//   B. a SHARED bulletin about a TACTIC (fraud_bulletins) — written, classified and published ONLY by a human platform
//      safety moderator through publishBulletin. It carries no tenant column; a named entity is admitted only as a
//      faithful official warning with an authoritative citation and a legal-review stamp.
//
// SURVIVORS REUSED (LAW 1): the wire-fraud sentinel (lib/wire-fraud/wire-fraud-sentinel.ts, wire-fraud-runner.ts — the
// Deal Coordinator's; a bulletin match there PROPOSES a verification task through proposeWireVerificationTasks below);
// the deal desk (lib/transactions/role-guard.ts requireDealDesk — the ONE "may this seat see this deal" answer, asked
// before a case may name a deal); the platform-staff gate (lib/platform/require-capability.ts, capability `support`) and
// its notifier (lib/notifications/platform-staff.ts); the Support system (a named subject's correction arrives as a
// support ticket — the request row carries its id); the ONE topic producer (lib/content-intel/topic-intake.ts
// intakeTopicIdeas — called, never edited); the action ledger (lib/kernel/action-ledger.ts — LAW 5 receipts); the
// circle_tactic_shares posture (m973 — RLS on, no session policy, session-gated service doors).
//
// WHAT THIS MODULE NEVER DOES (each is held by scripts/wave156-j-guard.ts):
//   · call a model — no redaction, classification or publication is model-authored here (deterministic redaction draft);
//   · write transactions, vendors, vendor_assignments, contacts or users — no automatic denial, ban or score exists;
//   · search allegations by person, rank people, take a vote, or expose a home address;
//   · read a tenant from a request body — every function takes an actor its caller resolved from the SESSION.
//
// BLIND SPOTS (published): screenPublicText recognizes emails, phone numbers, long digit runs, web links and street
// addresses by pattern — a PERSON'S NAME written in free text is not machine-detectable, which is why publication also
// requires the moderator's explicit attestation (attestNoPersonIdentified) and records it on the receipt. Evidence FILES
// are not stored (no private bucket exists — owner SQL), so the "signed evidence view" is a fail-closed refusal today.
// Metrics read at most METRIC_ROW_CAP rows per table and say so.

import "server-only"
import { createHash } from "node:crypto"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { applyTenantScope, platformScope, tenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"
// The ONE tenant-lifecycle vocabulary (lib/billing/billing-access.ts — the paywall and the scraper roster read it too).
import { TENANT_LIFECYCLE_REFUSED } from "@/lib/billing/billing-access"

// ═══ 1. VOCABULARIES (one per function — CLAUDE.md §6; m1035 CHECKs carry the same values) ═══════════════════════════

export interface FraudTypology {
  kind: string
  label: string
  /** What a reporter should gather — the evidence checklist. */
  evidenceChecklist: readonly string[]
  /** The immediate protective action a seat takes the moment this tactic is suspected. */
  protectiveAction: string
  /** Generic red flags a bulletin of this kind starts from (never case text). */
  redFlags: readonly string[]
  /** The ONE consumer-education question this kind may feed into a tenant topic pool — no case or bulletin detail. */
  educationalTopic: string
}

const CALL_BACK = "Call back on a number you obtained independently (the signed settlement statement, the company's official website typed by hand, or a number already on file) — never a number, link or reply address from the message."

export const FRAUD_TYPOLOGY: readonly FraudTypology[] = Object.freeze([
  { kind: "wire_diversion_lookalike_domain", label: "Wire diversion through a look-alike email domain",
    evidenceChecklist: ["Full email headers of the suspicious message", "The legitimate domain on file for the deal", "Screenshot of the sender address", "Any wire instructions received"],
    protectiveAction: `Stop any wire. ${CALL_BACK} Tell the buyer in person or by phone that instructions never change by email.`,
    redFlags: ["Sender domain differs from the title or escrow company's real domain by a character, a hyphen or the ending", "Request arrives close to closing", "Reply-to address differs from the sender"],
    educationalTopic: "How can a home buyer confirm wire instructions are real before sending a down payment?" },
  { kind: "change_of_wire_instructions", label: "Fraudulent change of wire instructions",
    evidenceChecklist: ["The original and the changed instructions (last four digits of accounts only)", "How the change arrived (channel, time)", "Who on the deal confirmed or denied it"],
    protectiveAction: `Treat every changed instruction as fraudulent until verified. ${CALL_BACK}`,
    redFlags: ["Bank or account changes after instructions were already given", "Urgency or 'do not call' language", "New bank in a different state or country"],
    educationalTopic: "What should you do if your closing wire instructions suddenly change?" },
  { kind: "vacant_land_seller_impersonation", label: "Seller impersonation on vacant land or unoccupied property",
    evidenceChecklist: ["Listing request details and how the 'seller' made contact", "Identity documents offered (do not store government ID numbers)", "Public ownership record reference"],
    protectiveAction: `Verify the owner independently before listing: contact the owner at the address of record and confirm identity in person or through a remote online notary with identity proofing. ${CALL_BACK}`,
    redFlags: ["Owner insists on remote-only contact", "Price below market for a quick cash sale", "Owner is unavailable for any live video or in-person meeting"],
    educationalTopic: "How do sellers of vacant land protect themselves from impersonation scams?" },
  { kind: "deed_ownership_impersonation", label: "Deed or ownership impersonation",
    evidenceChecklist: ["Recorded document reference numbers", "The notary or recording details shown", "Correspondence with the purported owner"],
    protectiveAction: "Pause the transaction and alert title or the closing attorney; confirm ownership with the county recorder and the owner of record through independently obtained contact details.",
    redFlags: ["Recent unexpected deed transfer", "Notary details that cannot be verified", "Pressure to close before title review"],
    educationalTopic: "How can homeowners watch for fraudulent deed filings on their property?" },
  { kind: "fake_rental_deposit", label: "Fake rental listing deposit scam",
    evidenceChecklist: ["Screenshot of the fake rental ad", "Payment request and method", "Address of the real property (kept private)"],
    protectiveAction: "Tell the renter not to pay; report the ad to the listing site; confirm the property's real manager through the brokerage of record.",
    redFlags: ["Deposit requested before a showing", "Payment by gift card, wire or payment app only", "'Owner is out of the country'"],
    educationalTopic: "How can renters spot a fake rental listing before paying a deposit?" },
  { kind: "fake_listing_photo_reuse", label: "Fake listing using reused photos or marketing",
    evidenceChecklist: ["Screenshot of the copied listing or ad (including automated-valuation marketing that reuses a home's images)", "Link to the original listing", "Date first seen"],
    protectiveAction: "Report the copy to the hosting site; warn the seller and the listing brokerage; keep the original listing's photo rights evidence.",
    redFlags: ["Photos identical to an active or past listing", "Contact details not matching the listing brokerage", "Price far below the real listing"],
    educationalTopic: "How do you tell whether a home listing online is real?" },
  { kind: "cloned_title_escrow_attorney_identity", label: "Cloned title, escrow or attorney identity",
    evidenceChecklist: ["Screenshot of the cloned website, letterhead or email signature", "The real firm's verified contact details", "Messages received from the clone"],
    protectiveAction: `Contact the real firm through details on file to confirm; warn the parties on the deal. ${CALL_BACK}`,
    redFlags: ["Letterhead or site that copies a real firm with different contact details", "New phone number 'because of an office move'", "Requests for documents or money outside the usual portal"],
    educationalTopic: "How can buyers confirm they are dealing with their real title or escrow company?" },
  { kind: "fake_lender_insurance_communication", label: "Fake lender or insurance communication",
    evidenceChecklist: ["The message and its sender details", "The lender or insurer of record", "What was requested (documents, fees, credentials)"],
    protectiveAction: `Confirm with the lender or insurer of record through independently obtained details before sending any document or payment. ${CALL_BACK}`,
    redFlags: ["Unexpected fee before closing", "Request to re-enter bank sign-in details", "Sender not matching the lender of record"],
    educationalTopic: "What fees and requests from a mortgage lender should make a buyer stop and verify?" },
  { kind: "vendor_invoice_substitution", label: "Contractor or vendor invoice substitution",
    evidenceChecklist: ["The substituted invoice and the expected invoice (last four digits of accounts only)", "How it arrived", "The vendor's verified contact on file"],
    protectiveAction: `Hold payment; confirm the invoice and payment details with the vendor through contact details already on file. ${CALL_BACK}`,
    redFlags: ["New payment details on a familiar invoice", "Invoice sent from a new address", "Urgent payment request"],
    educationalTopic: "How can homeowners make sure a contractor invoice is genuine before paying?" },
  { kind: "credential_phishing", label: "Phishing for sign-in, e-sign or MLS access",
    evidenceChecklist: ["The phishing message and its headers", "The link's displayed text (do not open it)", "Which account was targeted"],
    protectiveAction: "Do not enter credentials; report to your administrator; reset the password and require multi-factor sign-in if anything was entered.",
    redFlags: ["Sign-in page reached from an email link", "Document 'shared' by someone unexpected", "Request to approve an unexpected sign-in prompt"],
    educationalTopic: "How can buyers and sellers recognize a fake e-signature request?" },
  { kind: "forged_power_of_attorney", label: "Forged power of attorney",
    evidenceChecklist: ["The power-of-attorney document reference (not the document's personal identifiers)", "Notary details shown", "Who presented it and how"],
    protectiveAction: "Have title or the closing attorney verify the power of attorney with the principal directly and with the notary before relying on it.",
    redFlags: ["Principal unavailable to confirm", "Recently executed document for a large transaction", "Notary details that cannot be verified"],
    educationalTopic: "What should a seller know before someone signs for them with a power of attorney?" },
  { kind: "fake_earnest_money_instructions", label: "Fake earnest-money instructions",
    evidenceChecklist: ["The earnest-money instructions received", "The escrow holder named in the contract", "How the instructions arrived"],
    protectiveAction: `Deliver earnest money only to the escrow holder named in the contract, confirmed by phone. ${CALL_BACK}`,
    redFlags: ["Instructions that differ from the contract's escrow holder", "Request to pay by payment app or cryptocurrency", "Urgency language"],
    educationalTopic: "How should buyers deliver earnest money safely?" },
  { kind: "altered_payoff_settlement_documents", label: "Altered payoff or settlement documents",
    evidenceChecklist: ["The altered statement and the expected one (last four digits of accounts only)", "The servicer or settlement agent of record", "How it arrived"],
    protectiveAction: `Confirm payoff and settlement figures directly with the servicer and the settlement agent of record before funding. ${CALL_BACK}`,
    redFlags: ["Payoff sent to a new account", "Statement formatting that differs from the servicer's", "Last-minute revised figures"],
    educationalTopic: "How can sellers confirm a mortgage payoff statement is genuine?" },
  { kind: "professional_recruitment_investment_scam", label: "Recruitment or investment scam targeting real estate professionals",
    evidenceChecklist: ["The offer or pitch", "Payment or fee requested", "Who contacted you and how"],
    protectiveAction: "Do not pay fees or share credentials; verify the company through your state's licensing and securities regulators.",
    redFlags: ["Guaranteed returns or referrals for an upfront fee", "Pressure to recruit others", "Requests for license or bank sign-in details"],
    educationalTopic: "What warning signs should real estate professionals know about investment pitches?" },
])

/** Module vocabulary (round 4: no outside importer, so not exported — FRAUD_TYPOLOGY is the shared one). */
const FRAUD_TYPOLOGY_KINDS: readonly string[] = FRAUD_TYPOLOGY.map((t) => t.kind)
export const FRAUD_CLAIM_CLASSES = ["unverified_report", "verified_operational_pattern", "official_public_warning"] as const
type FraudClaimClass = (typeof FRAUD_CLAIM_CLASSES)[number]
export const FRAUD_CHANNELS = ["email", "text_message", "phone_call", "video_call", "social_media", "listing_site", "e_sign_platform", "postal_mail", "in_person", "other"] as const
export const FRAUD_EVIDENCE_KINDS = ["screenshot", "email_headers", "document", "message_export", "audio_recording", "payment_record", "listing_capture", "other"] as const
const FRAUD_INDICATOR_KINDS = ["email", "phone", "domain", "name", "account_last4", "url", "other"] as const
const FRAUD_BULLETIN_INDICATOR_KINDS = ["lookalike_domain", "phrase", "document_trait", "channel_trait", "timing"] as const
export const FRAUD_REPORT_AGENCIES = ["police", "ic3", "ftc", "state_regulator", "other"] as const
const FRAUD_CONFIDENCE = ["low", "medium", "high"] as const
const FRAUD_CASE_STATUSES = ["submitted", "under_review", "used_for_bulletin", "closed_no_action", "withdrawn"] as const
const FRAUD_BULLETIN_STATUSES = ["draft", "published", "taken_down"] as const

/** Seats that may take part (read bulletins, report, subscribe): the operational admin roster plus the producing and
 *  coordinating seats — DERIVED from TENANT_ADMIN_USER_TYPES, never restated (CLAUDE.md §4). A contact or a vendor seat
 *  is not a participant: the network is for the businesses that protect clients. m1035's bulletin policy names exactly
 *  this set (held equal by the guard). */
export const FRAUD_NETWORK_PARTICIPANT_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES, "agent", "isa", "tc"])
/** Seats that read EVERY private case of their tenant: the admin roster minus `team_lead` (a team lead is not the tenant's
 *  compliance desk; incident cases can concern any team). Everyone else reads only the cases they reported. */
export const FRAUD_CASE_REVIEWER_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead"))

/** Default retention of a private case — a code default for counsel to confirm (report §7), not a legal conclusion. */
export const FRAUD_CASE_RETENTION_DAYS = 730
/** Abuse ceiling: incident reports per reporter per rolling 24 hours. */
export const FRAUD_REPORTS_PER_DAY = 10
const METRIC_ROW_CAP = 5000
const DAY_MS = 86_400_000
export const EVIDENCE_STORAGE_NOT_ENABLED = "Evidence storage is not enabled yet. Your case keeps the file fingerprints, descriptions and report numbers; keep the original files safely until platform safety staff ask for them."
export const VERIFICATION_TASK_SOURCE = "fraud_bulletin_match"

const typologyOf = (kind: string | null | undefined): FraudTypology | null => (FRAUD_TYPOLOGY_KINDS.includes(String(kind)) ? FRAUD_TYPOLOGY.find((t) => t.kind === kind) ?? null : null)
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FINGERPRINT = /^[0-9a-f]{64}$/
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "")

// ═══ 2. ACTORS (resolved by the caller from the SESSION — never from a body) ═══════════════════════════════════════

export interface TenantActor { kind: "tenant"; userId: string; brokerageId: string; userType: string; agentId: string | null }
export interface StaffActor { kind: "staff"; userId: string; role: string; canWrite: boolean }
export type FraudActor = TenantActor | StaffActor
export type Svc = { from: (table: string) => any }
type Ok<T> = { ok: true } & T
type Refusal = { ok: false; error: string }

export const isParticipant = (a: { userType?: string | null }): boolean => FRAUD_NETWORK_PARTICIPANT_USER_TYPES.has(String(a.userType ?? "").trim().toLowerCase())
export const isCaseReviewer = (a: { userType?: string | null }): boolean => FRAUD_CASE_REVIEWER_USER_TYPES.has(String(a.userType ?? "").trim().toLowerCase())

// ═══ 3. PURE SCREENS ═══════════════════════════════════════════════════════════════════════════════════════════════

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/
const LONG_DIGITS_RE = /\d{6,}/
const LINK_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/i
const STREET_RE = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway|Pkwy|Parkway)\b\.?/
/** A number long enough to be an account, routing, card or government id — refused in PRIVATE free text too. */
const SENSITIVE_NUMBER_RE = /\d(?:[\s-]?\d){8,}/

/** Why a PUBLIC (bulletin) text is refused, or null. Patterns only — names are attested by the moderator (header). */
function screenPublicText(text: string): string | null {
  if (!text) return null
  if (EMAIL_RE.test(text)) return "contains an email address"
  if (PHONE_RE.test(text)) return "contains a phone number"
  if (LONG_DIGITS_RE.test(text)) return "contains a long number (an account, routing, case or identity number)"
  if (LINK_RE.test(text)) return "contains a web link (put an official source in the source field)"
  if (STREET_RE.test(text)) return "contains a street address"
  return null
}

/** DETERMINISTIC redaction draft (no model): the moderator starts from this and edits; it is never published as-is. */
function redactForDraft(text: string): string {
  return String(text ?? "")
    .replace(new RegExp(EMAIL_RE.source, "gi"), "[email removed]")
    .replace(new RegExp(LINK_RE.source, "gi"), "[link removed]")
    .replace(new RegExp(PHONE_RE.source, "g"), "[phone removed]")
    .replace(new RegExp(STREET_RE.source, "g"), "[address removed]")
    .replace(/\d{6,}/g, "[number removed]")
}

/** An authoritative citation: https on a government host (federal .gov / .mil, a state .us domain). */
function isAuthoritativeCitation(url: string | null | undefined): boolean {
  try {
    const u = new URL(String(url ?? ""))
    if (u.protocol !== "https:") return false
    return /(\.gov|\.mil|\.[a-z]{2}\.us)$/i.test(u.hostname)
  } catch { return false }
}

/**
 * INDEPENDENT CORROBORATION — distinct reporting tenants with distinct evidence. A tenant counts once however many cases
 * it files; a fingerprint already counted (the same file forwarded to a second tenant) adds nothing; a source with no
 * evidence fingerprint is a report, not corroboration. Never a count of rows, clicks or reads.
 */
export function independentCorroboration(sources: ReadonlyArray<{ brokerage_id: string; evidence_fingerprint: string | null; created_at?: string | null }>): { independentTenants: number; evidencedSources: number; rawSources: number } {
  const ordered = [...sources].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
  const seen = new Set<string>(), tenants = new Set<string>()
  let evidenced = 0
  for (const s of ordered) {
    if (!s.evidence_fingerprint) continue
    evidenced++
    if (seen.has(s.evidence_fingerprint)) continue
    seen.add(s.evidence_fingerprint)
    tenants.add(s.brokerage_id)
  }
  return { independentTenants: tenants.size, evidencedSources: evidenced, rawSources: sources.length }
}

/** The wire-sentinel flag keys (lib/wire-fraud/wire-fraud-sentinel.ts) → the typologies a bulletin about them carries. */
export const WIRE_FLAG_TYPOLOGIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  lookalike_domain: ["wire_diversion_lookalike_domain", "cloned_title_escrow_attorney_identity"],
  domain_mismatch: ["wire_diversion_lookalike_domain", "cloned_title_escrow_attorney_identity"],
  freemail_sender: ["wire_diversion_lookalike_domain", "cloned_title_escrow_attorney_identity"],
  account_changed: ["change_of_wire_instructions", "fake_earnest_money_instructions", "altered_payoff_settlement_documents"],
  urgency_pressure: ["change_of_wire_instructions"],
})

// ═══ 4. LEDGER (LAW 5) — one helper, dynamic import keeps the action file's graph light ════════════════════════════

async function receipt<T extends { ok: boolean; error?: string }>(svc: Svc, ctx: { brokerageId: string; action: string; actorUserId: string; subject: { type: string; id?: string | null }; reason: string; detail?: Record<string, unknown>; riskClass?: string; idempotencyKey?: string | null }, run: () => Promise<T>): Promise<T | Refusal> {
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction<T>({
    brokerageId: ctx.brokerageId, action: ctx.action, actor: { type: "user", userId: ctx.actorUserId },
    subject: ctx.subject, reasonCode: ctx.action.startsWith("fraud.case") ? "HUMAN_REQUESTED" : "COMPLIANCE_NOTICE",
    reasonDetail: ctx.reason, riskClass: ctx.riskClass ?? "LOW_RISK_WRITE", idempotencyKey: ctx.idempotencyKey ?? null, detail: ctx.detail ?? null,
  }, async () => {
    const out = await run()
    // settleToolResult reads `success`; the network's results say `ok`.
    return Object.assign(out, { success: out.ok }) as T
  }, { client: svc })
  // A non-acting claim (replay / in flight / refused) never re-runs the write; it is said back as a refusal in words.
  if ((r as any).ok === undefined) return { ok: false, error: (r as any).success === true ? "This request was already recorded." : String((r as any).error ?? "not recorded") }
  return r as T
}

/** The ledger's tenant for a platform act with no tenant of its own (a bulletin): the platform row of the ledger is
 *  keyed to the first source tenant when there is one; otherwise the act is recorded under the staffer's own tenant. */
async function staffLedgerTenant(svc: Svc, staff: StaffActor, bulletinId: string | null): Promise<string | null> {
  if (bulletinId) {
    const { data } = await svc.from("fraud_bulletin_sources").select("brokerage_id, created_at").eq("bulletin_id", bulletinId).order("created_at", { ascending: true }).limit(1)
    const first = ((data ?? []) as Array<{ brokerage_id: string }>)[0]
    if (first?.brokerage_id) return first.brokerage_id
  }
  const { data: me } = await svc.from("users").select("brokerage_id").eq("id", staff.userId).maybeSingle()
  return ((me as { brokerage_id?: string | null } | null)?.brokerage_id) ?? null
}

// ═══ 5. PRIVATE INCIDENT CASES ════════════════════════════════════════════════════════════════════════════════════

export interface IncidentInput {
  incidentKind: string
  channel: string
  summary: string
  eventDate?: string | null
  transactionId?: string | null
  listingId?: string | null
  allegedIndicators?: Array<{ kind: string; value: string }>
  lossOccurred?: "yes" | "no" | "unknown"
  lossAmount?: number | null
  stepsTaken?: string | null
  externalReports?: Array<{ agency: string; reference: string }>
  evidence?: Array<{ kind: string; fingerprint: string; label?: string | null }>
  shareConsent?: boolean
  clientRequestId?: string | null
}

/** The deal-desk question, injected by the caller (the action passes lib/transactions/role-guard.ts requireDealDesk). */
export type DealDeskAsk = (transactionId: string) => Promise<{ ok: boolean; error?: string }>

/** PURE validation of a report. Returns the cleaned record or the first refusal. */
function validateIncident(input: IncidentInput, now = new Date()): { ok: true; value: Required<Pick<IncidentInput, "incidentKind" | "channel" | "summary">> & IncidentInput } | Refusal {
  if (!typologyOf(input?.incidentKind)) return { ok: false, error: "Choose an incident type from the list." }
  if (!inList(FRAUD_CHANNELS, input.channel)) return { ok: false, error: "Choose how the contact arrived." }
  const summary = str(input.summary, 4000)
  if (!summary) return { ok: false, error: "Describe what happened." }
  for (const [what, text] of [["description", summary], ["steps taken", str(input.stepsTaken, 4000)]] as const) {
    // A phone number is allowed in a PRIVATE case (it is how the impersonator called); it is removed before the test.
    // Only a FORMATTED phone (separators between the groups) is removed: a bare 10+ digit run stays an account number.
    if (SENSITIVE_NUMBER_RE.test(text.replace(/(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, " "))) return { ok: false, error: `Remove full account, routing, card or ID numbers from the ${what} — keep at most the last four digits.` }
  }
  let eventDate: string | null = null
  if (input.eventDate) {
    const t = Date.parse(input.eventDate)
    if (!Number.isFinite(t) || t > now.getTime() + DAY_MS) return { ok: false, error: "The event date is not a valid past date." }
    eventDate = new Date(t).toISOString().slice(0, 10)
  }
  const indicators = (input.allegedIndicators ?? []).slice(0, 21)
  if (indicators.length > 20) return { ok: false, error: "At most 20 contact indicators." }
  const cleanIndicators: Array<{ kind: string; value: string }> = []
  for (const i of indicators) {
    if (!inList(FRAUD_INDICATOR_KINDS, i?.kind)) return { ok: false, error: "Unknown indicator type." }
    const value = str(i.value, 200)
    if (!value) continue
    if (i.kind === "account_last4" && !/^\d{1,4}$/.test(value)) return { ok: false, error: "Store only the last four digits of an account." }
    if (i.kind !== "phone" && LONG_DIGITS_RE.test(value)) return { ok: false, error: "Remove long numbers from indicators — keep at most the last four digits." }
    cleanIndicators.push({ kind: i.kind, value })
  }
  const loss = input.lossOccurred ?? "unknown"
  if (!inList(["yes", "no", "unknown"] as const, loss)) return { ok: false, error: "Say whether a loss occurred." }
  const lossAmount = loss === "yes" && typeof input.lossAmount === "number" && Number.isFinite(input.lossAmount) && input.lossAmount >= 0 ? Math.round(input.lossAmount * 100) / 100 : null
  const reports: Array<{ agency: string; reference: string }> = []
  for (const r of (input.externalReports ?? []).slice(0, 10)) {
    if (!inList(FRAUD_REPORT_AGENCIES, r?.agency)) return { ok: false, error: "Unknown report agency." }
    const reference = str(r.reference, 80)
    if (reference) reports.push({ agency: r.agency, reference })
  }
  const evidence: Array<{ kind: string; fingerprint: string; label: string | null }> = []
  const seen = new Set<string>()
  for (const e of (input.evidence ?? []).slice(0, 20)) {
    if (!inList(FRAUD_EVIDENCE_KINDS, e?.kind)) return { ok: false, error: "Unknown evidence type." }
    const fp = String(e.fingerprint ?? "").trim().toLowerCase()
    if (!FINGERPRINT.test(fp)) return { ok: false, error: "An evidence fingerprint is not a SHA-256 value." }
    if (seen.has(fp)) continue
    seen.add(fp)
    evidence.push({ kind: e.kind, fingerprint: fp, label: str(e.label, 200) || null })
  }
  for (const id of [input.transactionId, input.listingId]) if (id && !UUID.test(id)) return { ok: false, error: "Invalid record link." }
  return { ok: true, value: { ...input, summary, eventDate, allegedIndicators: cleanIndicators, lossOccurred: loss, lossAmount, stepsTaken: str(input.stepsTaken, 4000) || null, externalReports: reports, evidence, shareConsent: input.shareConsent === true } }
}

/** A report may name a listing only when the seat may see it: a case reviewer of the tenant, or the listing's agent. */
async function mayLinkListing(svc: Svc, actor: TenantActor, listingId: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await svc.from("listings").select("id, brokerage_id, agent_id").eq("id", listingId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error) return { ok: false, error: "The listing could not be checked — nothing was saved." }
  if (!data) return { ok: false, error: "That listing is not one you can link." }
  if (isCaseReviewer(actor)) return { ok: true }
  return (data as { agent_id?: string | null }).agent_id && (data as { agent_id?: string | null }).agent_id === actor.agentId ? { ok: true } : { ok: false, error: "That listing is not one you can link." }
}

export async function submitIncidentCase(svc: Svc, actor: TenantActor, input: IncidentInput, deps: { askDealDesk: DealDeskAsk; now?: Date }): Promise<Ok<{ caseId: string; evidenceStorage: "not_enabled"; evidenceRecorded: number }> | Refusal> {
  if (!isParticipant(actor)) return { ok: false, error: "Your seat cannot report to the fraud network." }
  const now = deps.now ?? new Date()
  const v = validateIncident(input, now)
  if (!v.ok) return v
  const c = v.value
  if (c.transactionId) {
    const desk = await deps.askDealDesk(c.transactionId)
    if (!desk.ok) return { ok: false, error: "That deal is not one you can link to a report." }
  }
  if (c.listingId) {
    const l = await mayLinkListing(svc, actor, c.listingId)
    if (!l.ok) return { ok: false, error: l.error ?? "That listing is not one you can link." }
  }
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  const { data: recent, error: rlErr } = await svc.from("fraud_incident_cases").select("id").eq("reporter_user_id", actor.userId).gte("created_at", since).limit(FRAUD_REPORTS_PER_DAY + 1)
  if (rlErr) return { ok: false, error: "Your report could not be checked — nothing was saved. Try again in a moment." }
  if ((recent ?? []).length >= FRAUD_REPORTS_PER_DAY) return { ok: false, error: `You have filed ${FRAUD_REPORTS_PER_DAY} reports in the last day. Contact platform support for anything more.` }

  return receipt(svc, {
    brokerageId: actor.brokerageId, action: "fraud.case.submit", actorUserId: actor.userId, subject: { type: "fraud_incident_case" },
    reason: `incident report: ${c.incidentKind}`, idempotencyKey: c.clientRequestId ? `fraud_case:${actor.brokerageId}:${actor.userId}:${str(c.clientRequestId, 80)}` : null,
    detail: { incident_kind: c.incidentKind, evidence_count: c.evidence?.length ?? 0, linked_deal: !!c.transactionId, linked_listing: !!c.listingId },
  }, async () => {
    const { data: row, error } = await svc.from("fraud_incident_cases").insert({
      brokerage_id: actor.brokerageId, reporter_user_id: actor.userId, transaction_id: c.transactionId ?? null, listing_id: c.listingId ?? null,
      incident_kind: c.incidentKind, event_date: c.eventDate ?? null, channel: c.channel, summary: c.summary,
      alleged_indicators: c.allegedIndicators ?? [], loss_occurred: c.lossOccurred, loss_amount: c.lossAmount ?? null, steps_taken: c.stepsTaken ?? null,
      external_report_ids: c.externalReports ?? [], status: "submitted", moderation_notes: [], share_consent: c.shareConsent === true,
      retention_until: new Date(now.getTime() + FRAUD_CASE_RETENTION_DAYS * DAY_MS).toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(),
    }).select("id").single()
    if (error || !row) return { ok: false as const, error: "Your report was not saved. Try again in a moment." }
    const caseId = (row as { id: string }).id
    let evidenceRecorded = 0
    for (const e of c.evidence ?? []) {
      const { error: eErr } = await svc.from("fraud_case_evidence").insert({ brokerage_id: actor.brokerageId, case_id: caseId, evidence_kind: e.kind, fingerprint_sha256: e.fingerprint, label: e.label ?? null, storage_status: "not_stored", created_by: actor.userId })
      if (!eErr) evidenceRecorded++
    }
    // Real-time staff escalation (directive): every report reaches platform safety staff; a wire / payment tactic with a
    // loss or an unknown outcome is HIGH. The alert names the type only — never the tenant's evidence or indicators.
    const t = typologyOf(c.incidentKind)!
    const money = /wire|earnest|payoff|invoice/.test(c.incidentKind)
    try {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      await notifyPlatformStaff(svc as any, { type: "fraud_case_submitted", title: `Fraud report to review: ${t.label}`, body: "A tenant filed a private incident report. Open the fraud network moderation queue.", entityType: "fraud_incident_case", entityId: caseId, priority: money && c.lossOccurred !== "no" ? "high" : "medium" })
    } catch { /* the case is saved; the queue still lists it */ }
    if (evidenceRecorded < (c.evidence?.length ?? 0)) return { ok: false as const, error: `Your report was saved, but ${(c.evidence?.length ?? 0) - evidenceRecorded} evidence fingerprint(s) were not. Add them again from the case.`, caseId }
    return { ok: true as const, caseId, evidenceStorage: "not_enabled" as const, evidenceRecorded }
  }) as any
}

const CASE_COLS = "id, brokerage_id, reporter_user_id, transaction_id, listing_id, incident_kind, event_date, channel, summary, alleged_indicators, loss_occurred, loss_amount, steps_taken, external_report_ids, status, moderation_notes, dispute, share_consent, retention_until, created_at, updated_at"

/** May this actor read this case? Reporter, a case reviewer of the SAME tenant, or platform safety staff. Fail closed. */
function mayReadCase(actor: FraudActor, row: { brokerage_id: string; reporter_user_id: string } | null): boolean {
  if (!row) return false
  if (actor.kind === "staff") return true
  if (row.brokerage_id !== actor.brokerageId) return false
  return row.reporter_user_id === actor.userId || isCaseReviewer(actor)
}

export async function listCases(svc: Svc, actor: TenantActor): Promise<Ok<{ cases: any[] }> | Refusal> {
  if (!isParticipant(actor)) return { ok: false, error: "Your seat cannot use the fraud network." }
  let q = svc.from("fraud_incident_cases").select(CASE_COLS).eq("brokerage_id", actor.brokerageId)
  if (!isCaseReviewer(actor)) q = q.eq("reporter_user_id", actor.userId)
  const { data, error } = await q.order("created_at", { ascending: false }).limit(200)
  if (error) return { ok: false, error: "Your cases could not be read right now." }
  return { ok: true, cases: (data ?? []) as any[] }
}

export async function readCase(svc: Svc, actor: FraudActor, caseId: string): Promise<Ok<{ case: any; evidence: any[]; evidenceStorage: "not_enabled" }> | Refusal> {
  if (!UUID.test(String(caseId ?? ""))) return { ok: false, error: "Case not found." }
  const { data, error } = await svc.from("fraud_incident_cases").select(CASE_COLS).eq("id", caseId).maybeSingle()
  if (error) return { ok: false, error: "The case could not be read right now." }
  if (!mayReadCase(actor, data as any)) return { ok: false, error: "Case not found." }
  // DEPARTURE: a tenant that has left (cancelled / archived / deleted) has no readable private case — staff included.
  const standing = await tenantStandings(svc, [(data as any).brokerage_id])
  if (!standing) return { ok: false, error: "The case could not be read right now." }
  if (standing.get((data as any).brokerage_id) === "departed") return { ok: false, error: "Case not found." }
  const { data: ev, error: evErr } = await svc.from("fraud_case_evidence").select("id, evidence_kind, fingerprint_sha256, label, storage_status, created_at").eq("case_id", caseId).eq("brokerage_id", (data as any).brokerage_id)
  if (evErr) return { ok: false, error: "The case evidence could not be read right now." }
  return { ok: true, case: data, evidence: (ev ?? []) as any[], evidenceStorage: "not_enabled" }
}

/** The signed evidence view. FAILS CLOSED until the owner creates the private bucket (report §7) — after authorization,
 *  so an unauthorized seat learns nothing, and an authorized one is told the honest state. */
export async function evidenceFileView(svc: Svc, actor: FraudActor, caseId: string, deps: EvidenceStoreDeps = {}): Promise<Refusal | Ok<{ urls: Array<{ evidenceId: string; url: string }> }>> {
  const r = await readCase(svc, actor, caseId)
  if (!r.ok) return r
  if (!(deps.bucketEnabled ?? (await evidenceBucketEnabled()))) return { ok: false, error: EVIDENCE_STORAGE_NOT_ENABLED }
  // Once the bucket exists: a SHORT-LIVED signed URL per stored object, minted only after the case gate above.
  const urls: Array<{ evidenceId: string; url: string }> = []
  for (const e of r.evidence.filter((x: any) => x.storage_status === "stored")) {
    const path = evidenceObjectPath(r.case.brokerage_id, caseId, e.fingerprint_sha256)
    const signed = deps.sign ? await deps.sign(path) : await (svc as any).storage?.from(FRAUD_EVIDENCE_BUCKET).createSignedUrl(path, EVIDENCE_URL_SECONDS)
    const url = (signed as any)?.data?.signedUrl ?? (signed as any)?.url ?? null
    if (url) urls.push({ evidenceId: e.id, url })
  }
  return { ok: true, urls }
}

export async function withdrawCase(svc: Svc, actor: TenantActor, caseId: string): Promise<Ok<{}> | Refusal> {
  const r = await readCase(svc, actor, caseId)
  if (!r.ok) return r
  if (r.case.reporter_user_id !== actor.userId) return { ok: false, error: "Only the reporter can withdraw a report." }
  if (!["submitted", "under_review"].includes(r.case.status)) return { ok: false, error: "This report can no longer be withdrawn." }
  return receipt(svc, { brokerageId: actor.brokerageId, action: "fraud.case.withdraw", actorUserId: actor.userId, subject: { type: "fraud_incident_case", id: caseId }, reason: "reporter withdrew the report" }, async () => {
    const { data, error } = await svc.from("fraud_incident_cases").update({ status: "withdrawn", updated_at: new Date().toISOString() }).eq("id", caseId).eq("brokerage_id", actor.brokerageId).select("id")
    return error || !(data ?? []).length ? { ok: false as const, error: "The report was not withdrawn." } : { ok: true as const }
  }) as any
}

/** Dispute / appeal of a moderation outcome on the tenant's own case. */
export async function appealCase(svc: Svc, actor: TenantActor, caseId: string, statement: string): Promise<Ok<{}> | Refusal> {
  const r = await readCase(svc, actor, caseId)
  if (!r.ok) return r
  const text = str(statement, 2000)
  if (!text) return { ok: false, error: "Say what should be reconsidered." }
  if (!["closed_no_action", "used_for_bulletin"].includes(r.case.status)) return { ok: false, error: "Only a decided case can be appealed." }
  return receipt(svc, { brokerageId: actor.brokerageId, action: "fraud.case.appeal", actorUserId: actor.userId, subject: { type: "fraud_incident_case", id: caseId }, reason: "tenant appealed a moderation outcome" }, async () => {
    const dispute = { statement: text, by: actor.userId, at: new Date().toISOString(), previous_status: r.case.status }
    const { data, error } = await svc.from("fraud_incident_cases").update({ dispute, status: "under_review", updated_at: dispute.at }).eq("id", caseId).eq("brokerage_id", actor.brokerageId).select("id")
    if (error || !(data ?? []).length) return { ok: false as const, error: "The appeal was not recorded." }
    try { const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff"); await notifyPlatformStaff(svc as any, { type: "fraud_case_appeal", title: "Fraud case appeal to review", body: "A tenant appealed a moderation outcome.", entityType: "fraud_incident_case", entityId: caseId, priority: "medium" }) } catch { /* queue lists it */ }
    return { ok: true as const }
  }) as any
}

// ═══ 6. MODERATION (platform safety staff only — the caller gates with requirePlatformCapability("support")) ═══════

export async function moderationQueue(svc: Svc, staff: StaffActor): Promise<Ok<{ cases: any[]; bulletins: any[]; corrections: any[] }> | Refusal> {
  if (staff.kind !== "staff") return { ok: false, error: "Platform safety staff only." }
  const [cases, bulletins, corrections] = await Promise.all([
    svc.from("fraud_incident_cases").select("id, brokerage_id, incident_kind, channel, status, loss_occurred, event_date, created_at, dispute").in("status", ["submitted", "under_review"]).order("created_at", { ascending: true }).limit(200),
    svc.from("fraud_bulletins").select("id, typology, title, status, claim_class, confidence, version, published_at, updated_at").order("updated_at", { ascending: false }).limit(200),
    svc.from("fraud_correction_requests").select("id, bulletin_id, requester_kind, channel, status, statement, created_at").eq("status", "received").order("created_at", { ascending: true }).limit(200),
  ])
  if (cases.error || bulletins.error || corrections.error) return { ok: false, error: "The moderation queue could not be read." }
  const caseRows = (cases.data ?? []) as Array<{ brokerage_id: string }>
  const standing = await tenantStandings(svc, caseRows.map((c) => c.brokerage_id))
  if (!standing) return { ok: false, error: "The moderation queue could not be read." }
  return { ok: true, cases: caseRows.filter((c) => standing.get(c.brokerage_id) !== "departed"), bulletins: bulletins.data ?? [], corrections: corrections.data ?? [] }
}

export async function addModerationNote(svc: Svc, staff: StaffActor, caseId: string, note: string, status?: string | null): Promise<Ok<{}> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const r = await readCase(svc, staff, caseId)
  if (!r.ok) return r
  const text = str(note, 2000)
  if (!text) return { ok: false, error: "Write the note." }
  if (status && !inList(FRAUD_CASE_STATUSES.filter((x) => x === "under_review" || x === "closed_no_action"), status)) return { ok: false, error: "A note can move a case to under review or closed with no action only." }
  const notes = [...((r.case.moderation_notes ?? []) as unknown[]), { at: new Date().toISOString(), by: staff.userId, note: text, status: status ?? null }]
  return receipt(svc, { brokerageId: r.case.brokerage_id, action: "fraud.case.moderate", actorUserId: staff.userId, subject: { type: "fraud_incident_case", id: caseId }, reason: `moderation note${status ? ` → ${status}` : ""}` }, async () => {
    const { data, error } = await svc.from("fraud_incident_cases").update({ moderation_notes: notes, ...(status ? { status } : {}), updated_at: new Date().toISOString() }).eq("id", caseId).eq("brokerage_id", r.case.brokerage_id).select("id")
    return error || !(data ?? []).length ? { ok: false as const, error: "The note was not saved." } : { ok: true as const }
  }) as any
}

const BULLETIN_EDITABLE = ["title", "tactic_summary", "indicators", "red_flags", "how_to_verify", "source_url", "jurisdiction", "recency_date", "confidence", "claim_class", "named_entity", "named_entity_citation_url"] as const
type BulletinFields = Partial<Record<(typeof BULLETIN_EDITABLE)[number], unknown>>

/** PURE — clean the editable fields; the claim class is a value a HUMAN sets here, never a model. */
function cleanBulletinFields(f: BulletinFields): { ok: true; value: Record<string, unknown> } | Refusal {
  const out: Record<string, unknown> = {}
  if (f.title !== undefined) out.title = str(f.title, 200)
  if (f.tactic_summary !== undefined) out.tactic_summary = str(f.tactic_summary, 4000)
  if (f.how_to_verify !== undefined) out.how_to_verify = str(f.how_to_verify, 2000)
  if (f.jurisdiction !== undefined) out.jurisdiction = str(f.jurisdiction, 80) || null
  if (f.source_url !== undefined) out.source_url = str(f.source_url, 500) || null
  if (f.recency_date !== undefined) { const t = Date.parse(String(f.recency_date ?? "")); out.recency_date = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null }
  if (f.confidence !== undefined) { if (!inList(FRAUD_CONFIDENCE, f.confidence)) return { ok: false, error: "Unknown confidence." }; out.confidence = f.confidence }
  if (f.claim_class !== undefined) { if (!inList(FRAUD_CLAIM_CLASSES, f.claim_class)) return { ok: false, error: "Unknown claim class." }; out.claim_class = f.claim_class as FraudClaimClass }
  if (f.named_entity !== undefined) out.named_entity = str(f.named_entity, 200) || null
  if (f.named_entity_citation_url !== undefined) out.named_entity_citation_url = str(f.named_entity_citation_url, 500) || null
  if (f.red_flags !== undefined) out.red_flags = (Array.isArray(f.red_flags) ? f.red_flags : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 12)
  if (f.indicators !== undefined) {
    const list: Array<{ kind: string; value: string }> = []
    for (const i of (Array.isArray(f.indicators) ? f.indicators : []).slice(0, 12) as Array<{ kind?: unknown; value?: unknown }>) {
      if (!inList(FRAUD_BULLETIN_INDICATOR_KINDS, i?.kind)) return { ok: false, error: "Unknown bulletin indicator type." }
      const value = str(i.value, 300)
      if (i.kind === "lookalike_domain" && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) return { ok: false, error: "A look-alike domain indicator must be a bare domain." }
      if (value) list.push({ kind: i.kind as string, value: i.kind === "lookalike_domain" ? value.toLowerCase() : value })
    }
    out.indicators = list
  }
  return { ok: true, value: out }
}

/** PURE — the publication rules. Returns the first refusal or null. Held by the guard, mirrored by m1035's CHECK. */
function publicationRefusal(b: Record<string, any>, ctx: { attestNoPersonIdentified: boolean; legalReviewConfirmed: boolean; verificationNote: string; independentTenants: number }): string | null {
  if (b.status !== "draft") return "Only a draft can be published; correct a published bulletin instead."
  if (!ctx.attestNoPersonIdentified) return "Confirm that the bulletin identifies no private person, client, account or home address."
  if (!typologyOf(b.typology)) return "Unknown typology."
  if (!inList(FRAUD_CLAIM_CLASSES, b.claim_class)) return "Set a claim class."
  if (!str(b.title, 200) || !str(b.tactic_summary, 4000) || !str(b.how_to_verify, 2000)) return "A bulletin needs a title, the tactic and how to verify safely."
  for (const [field, text] of [["title", b.title], ["tactic", b.tactic_summary], ["how to verify", b.how_to_verify], ...((b.red_flags ?? []) as string[]).map((x) => ["red flag", x] as const), ...((b.indicators ?? []) as Array<{ kind: string; value: string }>).filter((i) => i.kind !== "lookalike_domain").map((i) => ["indicator", i.value] as const)] as Array<readonly [string, string]>) {
    const why = screenPublicText(String(text ?? ""))
    if (why) return `The ${field} ${why}.`
  }
  if (b.named_entity) {
    if (b.claim_class !== "official_public_warning") return "A bulletin may name an entity only as an official public warning — an unverified or operational report can never name anyone."
    if (!isAuthoritativeCitation(b.named_entity_citation_url)) return "A named entity needs an authoritative citation (an https government source)."
    if (!ctx.legalReviewConfirmed) return "A named entity needs the legal-review confirmation."
  }
  if (b.claim_class === "official_public_warning" && !isAuthoritativeCitation(b.source_url ?? b.named_entity_citation_url)) return "An official public warning needs its authoritative government source URL."
  if (b.claim_class === "verified_operational_pattern") {
    if (ctx.independentTenants < 1) return "A verified pattern needs at least one linked case with evidence."
    if (!str(ctx.verificationNote, 2000)) return "Record how the pattern was verified."
  }
  if (b.claim_class === "unverified_report" && b.confidence !== "low") return "An unverified report is published at low confidence only."
  if (((b.indicators ?? []) as Array<{ kind: string }>).some((i) => i.kind === "lookalike_domain") && b.claim_class === "unverified_report") return "A specific domain is shown only once the pattern is verified or officially warned."
  if (b.source_url && !/^https:\/\//i.test(String(b.source_url))) return "The source URL must be https."
  return null
}

/** Draft a bulletin FROM a case: typology defaults + a deterministic redaction of the case text, and link the case. */
export async function draftBulletinFromCase(svc: Svc, staff: StaffActor, caseId: string): Promise<Ok<{ bulletinId: string }> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const r = await readCase(svc, staff, caseId)
  if (!r.ok) return r
  const t = typologyOf(r.case.incident_kind)!
  const { data, error } = await svc.from("fraud_bulletins").insert({
    typology: t.kind, title: t.label, tactic_summary: redactForDraft(r.case.summary), indicators: [], red_flags: [...t.redFlags],
    how_to_verify: t.protectiveAction, confidence: "low", claim_class: "unverified_report", status: "draft", version: 1, created_by: staff.userId,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).select("id").single()
  if (error || !data) return { ok: false, error: "The draft was not created." }
  const bulletinId = (data as { id: string }).id
  const link = await linkCaseToBulletin(svc, staff, bulletinId, caseId)
  if (!link.ok) return link
  return { ok: true, bulletinId }
}

export async function linkCaseToBulletin(svc: Svc, staff: StaffActor, bulletinId: string, caseId: string): Promise<Ok<{ corroboration: ReturnType<typeof independentCorroboration> }> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const r = await readCase(svc, staff, caseId)
  if (!r.ok) return r
  const { data: b, error: bErr } = await svc.from("fraud_bulletins").select("id, status").eq("id", bulletinId).maybeSingle()
  if (bErr || !b) return { ok: false, error: "Bulletin not found." }
  if ((b as any).status === FRAUD_BULLETIN_STATUSES[2]) return { ok: false, error: "A taken-down bulletin takes no new sources." }
  const fp = (r.evidence[0]?.fingerprint_sha256 as string | undefined) ?? null
  const { error } = await svc.from("fraud_bulletin_sources").insert({ brokerage_id: r.case.brokerage_id, bulletin_id: bulletinId, case_id: caseId, evidence_fingerprint: fp, linked_by: staff.userId, created_at: new Date().toISOString() })
  if (error && error.code !== "23505") return { ok: false, error: "The case was not linked." }
  return { ok: true, corroboration: await corroborationOf(svc, bulletinId) }
}

async function corroborationOf(svc: Svc, bulletinId: string): Promise<ReturnType<typeof independentCorroboration>> {
  const { data } = await svc.from("fraud_bulletin_sources").select("brokerage_id, evidence_fingerprint, created_at").eq("bulletin_id", bulletinId).limit(500)
  const rows = (data ?? []) as Array<{ brokerage_id: string; evidence_fingerprint: string | null }>
  // A departed tenant's evidence no longer corroborates anything (its links are sealed by sealDepartedTenants).
  const standing = await tenantStandings(svc, rows.map((r) => r.brokerage_id))
  if (!standing) return { independentTenants: 0, evidencedSources: 0, rawSources: rows.length } // unreadable → nothing corroborates (fail closed)
  return independentCorroboration(rows.filter((r) => standing.get(r.brokerage_id) !== "departed") as any[])
}

export async function updateBulletinDraft(svc: Svc, staff: StaffActor, bulletinId: string, fields: BulletinFields): Promise<Ok<{}> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const c = cleanBulletinFields(fields)
  if (!c.ok) return c
  const { data, error } = await svc.from("fraud_bulletins").update({ ...c.value, updated_at: new Date().toISOString() }).eq("id", bulletinId).eq("status", "draft").select("id")
  if (error) return { ok: false, error: "The draft was not saved." }
  if (!(data ?? []).length) return { ok: false, error: "Only a draft can be edited this way; correct a published bulletin instead." }
  return { ok: true }
}

const SNAPSHOT_COLS = "id, typology, title, tactic_summary, indicators, red_flags, how_to_verify, source_url, jurisdiction, recency_date, confidence, claim_class, named_entity, named_entity_citation_url, legal_review_by, legal_review_at, status, version, published_at, taken_down_at, takedown_reason, name_review_hold, name_review_clearance"

/** THE ONE PUBLICATION DOOR — a human platform-safety act, gated, receipted, versioned. */
export async function publishBulletin(svc: Svc, staff: StaffActor, bulletinId: string, ctx: { attestNoPersonIdentified: boolean; legalReviewConfirmed: boolean; verificationNote: string }): Promise<Ok<{ notified: number }> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const { data: b, error } = await svc.from("fraud_bulletins").select(SNAPSHOT_COLS).eq("id", bulletinId).maybeSingle()
  if (error || !b) return { ok: false, error: "Bulletin not found." }
  const corroboration = await corroborationOf(svc, bulletinId)
  const why = publicationRefusal(b as any, { ...ctx, independentTenants: corroboration.independentTenants })
  if (why) return { ok: false, error: why }
  const held = await holdForNameReview(svc, staff, bulletinId, b as any)
  if (held) return held
  const tenant = await staffLedgerTenant(svc, staff, bulletinId)
  if (!tenant) return { ok: false, error: "No tenant to record the receipt under — not published." }
  const at = new Date().toISOString()
  return receipt(svc, {
    brokerageId: tenant, action: "fraud.bulletin.publish", actorUserId: staff.userId, subject: { type: "fraud_bulletin", id: bulletinId },
    reason: `published ${(b as any).claim_class} bulletin`, riskClass: "LEGAL", idempotencyKey: `fraud_bulletin_publish:${bulletinId}:v${(b as any).version}`,
    detail: { claim_class: (b as any).claim_class, named_entity: !!(b as any).named_entity, attest_no_person_identified: true, legal_review_confirmed: ctx.legalReviewConfirmed, verification_note: str(ctx.verificationNote, 500) || null, corroboration },
  }, async () => {
    const legal = (b as any).named_entity ? { legal_review_by: staff.userId, legal_review_at: at } : {}
    // ORDER IS THE AUDIT GUARANTEE (round 3): the revision row, then the source cases, then the published state. A refused
    // step stops the door BEFORE anything is public, and what was already written is undone and counted — a bulletin is
    // never reported (or left) published without its audit trail and its case links.
    const { data: srcs, error: srcErr } = await svc.from("fraud_bulletin_sources").select("case_id, brokerage_id").eq("bulletin_id", bulletinId)
    if (srcErr) return { ok: false as const, error: "The bulletin's source cases could not be read — nothing was published." }
    const sources = (srcs ?? []) as Array<{ case_id: string; brokerage_id: string }>
    const { data: rev, error: revErr } = await svc.from("fraud_bulletin_revisions").insert({ bulletin_id: bulletinId, version: (b as any).version, change_kind: "published", snapshot: { ...(b as any), status: "published", published_at: at, ...legal }, reason: str(ctx.verificationNote, 2000) || "published", actor_user_id: staff.userId, created_at: at }).select("id")
    if (revErr || !(rev ?? []).length) return { ok: false as const, error: "The publication record could not be written — nothing was published." }
    const revisionId = (rev as Array<{ id: string }>)[0].id
    const undo = async (marked: Array<{ case_id: string; brokerage_id: string; prior: string }>): Promise<string[]> => {
      const problems: string[] = []
      for (const m of marked) {
        const { data: r, error: e } = await svc.from("fraud_incident_cases").update({ status: m.prior, updated_at: at }).eq("id", m.case_id).eq("brokerage_id", m.brokerage_id).select("id")
        if (e || !(r ?? []).length) problems.push(`case ${m.case_id} not restored`)
      }
      const { data: d, error: de } = await svc.from("fraud_bulletin_revisions").delete().eq("id", revisionId).select("id")
      if (de || !(d ?? []).length) problems.push("the unused publication record was not removed")
      return problems
    }
    const marked: Array<{ case_id: string; brokerage_id: string; prior: string }> = []
    for (const s of sources) {
      const { data: c, error: cErr } = await svc.from("fraud_incident_cases").select("status").eq("id", s.case_id).eq("brokerage_id", s.brokerage_id).maybeSingle()
      if (cErr) { const p = await undo(marked); return { ok: false as const, error: `A source case could not be read — nothing was published.${p.length ? ` Also: ${p.join("; ")}.` : ""}` } }
      if (!c) continue // the case was purged by retention; its link no longer corroborates (the cascade removes it)
      const { data: m, error: mErr } = await svc.from("fraud_incident_cases").update({ status: "used_for_bulletin", updated_at: at }).eq("id", s.case_id).eq("brokerage_id", s.brokerage_id).select("id")
      if (mErr || !(m ?? []).length) { const p = await undo(marked); return { ok: false as const, error: `A source case could not be marked as used — nothing was published.${p.length ? ` Also: ${p.join("; ")}.` : ""}` } }
      marked.push({ ...s, prior: String((c as { status: string }).status) })
    }
    const { data: up, error: upErr } = await svc.from("fraud_bulletins").update({ status: "published", published_by: staff.userId, published_at: at, updated_at: at, ...legal }).eq("id", bulletinId).eq("status", "draft").select("id")
    if (upErr || !(up ?? []).length) { const p = await undo(marked); return { ok: false as const, error: `The bulletin was not published.${p.length ? ` Also: ${p.join("; ")}.` : ""}` } }
    const notified = await notifySubscribers(svc, { id: bulletinId, typology: (b as any).typology, jurisdiction: (b as any).jurisdiction, title: (b as any).title })
    return { ok: true as const, notified }
  }) as any
}

/** Tell the seats that subscribed to this type / place. The alert is generic — the bulletin is read in the network. */
async function notifySubscribers(svc: Svc, b: { id: string; typology: string; jurisdiction: string | null; title: string }): Promise<number> {
  const { data, error } = await svc.from("fraud_warning_subscriptions").select("user_id, brokerage_id, typology, jurisdiction").limit(METRIC_ROW_CAP)
  if (error) return 0
  const j = String(b.jurisdiction ?? "").trim().toLowerCase()
  const who = new Map<string, string>()
  for (const s of (data ?? []) as Array<{ user_id: string; brokerage_id: string; typology: string | null; jurisdiction: string | null }>) {
    if (s.typology && s.typology !== b.typology) continue
    if (s.jurisdiction && s.jurisdiction.trim().toLowerCase() !== j) continue
    who.set(s.user_id, s.brokerage_id)
  }
  let n = 0
  for (const [userId, brokerageId] of who) {
    const { error: nErr } = await svc.from("notifications").insert({ user_id: userId, brokerage_id: brokerageId, type: "fraud_warning", title: `Fraud warning: ${b.title}`.slice(0, 200), body: "A new verified-safety bulletin matches your subscription. Open the Fraud & Trust Network to read how to verify safely.", entity_type: "fraud_bulletin", entity_id: b.id, priority: "high" })
    if (!nErr) n++
  }
  return n
}

/** Correct a PUBLISHED bulletin: the previous text is kept as a revision, the version moves on. */
export async function correctBulletin(svc: Svc, staff: StaffActor, bulletinId: string, fields: BulletinFields, reason: string, correctionRequestId?: string | null): Promise<Ok<{ version: number }> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const why = str(reason, 2000)
  if (!why) return { ok: false, error: "State the reason for the correction." }
  const c = cleanBulletinFields(fields)
  if (!c.ok) return c
  const { data: b, error } = await svc.from("fraud_bulletins").select(SNAPSHOT_COLS).eq("id", bulletinId).maybeSingle()
  if (error || !b) return { ok: false, error: "Bulletin not found." }
  if ((b as any).status !== "published") return { ok: false, error: "Only a published bulletin is corrected; edit a draft directly." }
  const next = { ...(b as any), ...c.value, status: "draft" }
  // The corrected text must pass the SAME rules as a first publication (a correction cannot smuggle a name in).
  const refusal = publicationRefusal(next, { attestNoPersonIdentified: true, legalReviewConfirmed: !!(b as any).legal_review_by && next.named_entity === (b as any).named_entity, verificationNote: why, independentTenants: (await corroborationOf(svc, bulletinId)).independentTenants })
  if (refusal) return { ok: false, error: refusal }
  const held = await holdForNameReview(svc, staff, bulletinId, next)
  if (held) return held
  const tenant = await staffLedgerTenant(svc, staff, bulletinId)
  if (!tenant) return { ok: false, error: "No tenant to record the receipt under — not corrected." }
  const version = Number((b as any).version) + 1
  const at = new Date().toISOString()
  return receipt(svc, { brokerageId: tenant, action: "fraud.bulletin.correct", actorUserId: staff.userId, subject: { type: "fraud_bulletin", id: bulletinId }, reason: why, riskClass: "LEGAL", idempotencyKey: `fraud_bulletin_correct:${bulletinId}:v${version}`, detail: { fields: Object.keys(c.value), correction_request_id: correctionRequestId ?? null } }, async () => {
    const { error: revErr } = await svc.from("fraud_bulletin_revisions").insert({ bulletin_id: bulletinId, version: (b as any).version, change_kind: "corrected", snapshot: b, reason: why, correction_request_id: correctionRequestId ?? null, actor_user_id: staff.userId, created_at: at })
    if (revErr) return { ok: false as const, error: "The previous version could not be kept — nothing was changed." }
    const { data: up, error: upErr } = await svc.from("fraud_bulletins").update({ ...c.value, version, updated_at: at }).eq("id", bulletinId).eq("status", "published").select("id")
    return upErr || !(up ?? []).length ? { ok: false as const, error: "The correction was not saved." } : { ok: true as const, version }
  }) as any
}

/** TAKEDOWN — removes public access and withdraws every derived copy this network created (topic-pool rows). */
export async function takeDownBulletin(svc: Svc, staff: StaffActor, bulletinId: string, reason: string, correctionRequestId?: string | null): Promise<Ok<{ derivedWithdrawn: number }> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const why = str(reason, 2000)
  if (!why) return { ok: false, error: "State the reason for the takedown." }
  const { data: b, error } = await svc.from("fraud_bulletins").select(SNAPSHOT_COLS).eq("id", bulletinId).maybeSingle()
  if (error || !b) return { ok: false, error: "Bulletin not found." }
  const tenant = await staffLedgerTenant(svc, staff, bulletinId)
  if (!tenant) return { ok: false, error: "No tenant to record the receipt under — not taken down." }
  const at = new Date().toISOString()
  // No idempotency key: a takedown is idempotent by state, and a RETRY must be able to repair a missing record or a
  // derived copy that was not withdrawn (round 3). Public access is removed FIRST — the protective act — and the door
  // reports failure (never success) until the record and every derived copy are confirmed.
  return receipt(svc, { brokerageId: tenant, action: "fraud.bulletin.takedown", actorUserId: staff.userId, subject: { type: "fraud_bulletin", id: bulletinId }, reason: why, riskClass: "LEGAL", detail: { correction_request_id: correctionRequestId ?? null, repair: (b as any).status === "taken_down" } }, async () => {
    if ((b as any).status !== "taken_down") {
      const { data: up, error: upErr } = await svc.from("fraud_bulletins").update({ status: "taken_down", taken_down_at: at, takedown_reason: why, updated_at: at }).eq("id", bulletinId).select("id")
      if (upErr || !(up ?? []).length) return { ok: false as const, error: "The bulletin was not taken down." }
    }
    const problems: string[] = []
    const { data: prior, error: priorErr } = await svc.from("fraud_bulletin_revisions").select("id").eq("bulletin_id", bulletinId).eq("change_kind", "taken_down").limit(1)
    if (priorErr) problems.push("the takedown record could not be checked")
    else if (!(prior ?? []).length) {
      const { data: rev, error: revErr } = await svc.from("fraud_bulletin_revisions").insert({ bulletin_id: bulletinId, version: (b as any).version, change_kind: "taken_down", snapshot: b, reason: why, correction_request_id: correctionRequestId ?? null, actor_user_id: staff.userId, created_at: at }).select("id")
      if (revErr || !(rev ?? []).length) problems.push("the takedown record was not written")
    }
    let derivedWithdrawn = 0
    const { data: der, error: derErr } = await svc.from("fraud_bulletin_derivatives").select("brokerage_id, topic_id").eq("bulletin_id", bulletinId)
    if (derErr) problems.push("the derived topic copies could not be read")
    for (const d of (der ?? []) as Array<{ brokerage_id: string; topic_id: string }>) {
      const { data: t, error: tErr } = await svc.from("content_topic_bank").update({ status: "rejected" }).eq("id", d.topic_id).eq("brokerage_id", d.brokerage_id).select("id")
      if (tErr) problems.push(`a derived topic copy was not withdrawn (${tErr.message})`)
      else derivedWithdrawn += (t ?? []).length // 0 rows = the copy is already gone (deleted with its tenant): nothing to withdraw
    }
    if (problems.length) return { ok: false as const, error: `The bulletin is no longer public, but ${problems.join("; ")}. Take it down again to finish.`, derivedWithdrawn }
    return { ok: true as const, derivedWithdrawn }
  }) as any
}

// ═══ 7. CORRECTION / DISPUTE CHANNEL ═══════════════════════════════════════════════════════════════════════════════

/** A tenant asks for a correction in-app (a published bulletin only). */
export async function tenantCorrectionRequest(svc: Svc, actor: TenantActor, bulletinId: string, statement: string): Promise<Ok<{ requestId: string }> | Refusal> {
  if (!isParticipant(actor)) return { ok: false, error: "Your seat cannot use the fraud network." }
  const text = str(statement, 4000)
  if (!text) return { ok: false, error: "Say what is wrong." }
  const { data: b } = await svc.from("fraud_bulletins").select("id").eq("id", bulletinId).eq("status", "published").maybeSingle()
  if (!b) return { ok: false, error: "Bulletin not found." }
  return receipt(svc, { brokerageId: actor.brokerageId, action: "fraud.correction.request", actorUserId: actor.userId, subject: { type: "fraud_bulletin", id: bulletinId }, reason: "tenant correction request" }, async () => {
    const { data, error } = await svc.from("fraud_correction_requests").insert({ bulletin_id: bulletinId, requester_kind: "tenant", brokerage_id: actor.brokerageId, requester_user_id: actor.userId, channel: "in_app", statement: text, status: "received", created_at: new Date().toISOString() }).select("id").single()
    if (error || !data) return { ok: false as const, error: "The request was not recorded." }
    try { const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff"); await notifyPlatformStaff(svc as any, { type: "fraud_correction_request", title: "Fraud bulletin correction requested", body: "A tenant asked for a bulletin correction.", entityType: "fraud_bulletin", entityId: bulletinId, priority: "high" }) } catch { /* queue lists it */ }
    return { ok: true as const, requestId: (data as { id: string }).id }
  }) as any
}

/** A NAMED SUBJECT (or anyone outside the platform) reaches staff through Support, email, phone or mail; staff record it
 *  here, linked to the support ticket when there is one. Any bulletin status (a subject may dispute a taken-down one). */
export async function recordSubjectCorrection(svc: Svc, staff: StaffActor, input: { bulletinId: string; channel: string; statement: string; supportTicketId?: string | null }): Promise<Ok<{ requestId: string }> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  if (!inList(["support_ticket", "email", "phone", "postal_mail"] as const, input.channel)) return { ok: false, error: "Unknown channel." }
  const text = str(input.statement, 4000)
  if (!text) return { ok: false, error: "Record what the person said." }
  if (input.supportTicketId && !UUID.test(input.supportTicketId)) return { ok: false, error: "Invalid support ticket." }
  const tenant = await staffLedgerTenant(svc, staff, input.bulletinId)
  if (!tenant) return { ok: false, error: "No tenant to record the receipt under — not recorded." }
  return receipt(svc, { brokerageId: tenant, action: "fraud.correction.record", actorUserId: staff.userId, subject: { type: "fraud_bulletin", id: input.bulletinId }, reason: `named-subject correction request by ${input.channel}`, riskClass: "LEGAL" }, async () => {
    const { data, error } = await svc.from("fraud_correction_requests").insert({ bulletin_id: input.bulletinId, requester_kind: "named_subject", brokerage_id: null, channel: input.channel, support_ticket_id: input.supportTicketId ?? null, statement: text, status: "received", recorded_by: staff.userId, created_at: new Date().toISOString() }).select("id").single()
    if (error || !data) return { ok: false as const, error: "The request was not recorded." }
    return { ok: true as const, requestId: (data as { id: string }).id }
  }) as any
}

export async function resolveCorrection(svc: Svc, staff: StaffActor, input: { requestId: string; outcome: "corrected" | "taken_down" | "rejected"; resolution: string; changes?: BulletinFields }): Promise<Ok<{ version?: number; derivedWithdrawn?: number }> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const resolution = str(input.resolution, 2000)
  if (!resolution) return { ok: false, error: "Record the resolution." }
  const { data: req, error } = await svc.from("fraud_correction_requests").select("id, bulletin_id, status").eq("id", input.requestId).maybeSingle()
  if (error || !req) return { ok: false, error: "Request not found." }
  if ((req as any).status !== "received") return { ok: false, error: "This request is already resolved." }
  let extra: { version?: number; derivedWithdrawn?: number } = {}
  if (input.outcome === "corrected") {
    const r = await correctBulletin(svc, staff, (req as any).bulletin_id, input.changes ?? {}, resolution, input.requestId)
    if (!r.ok) return r
    extra = { version: r.version }
  } else if (input.outcome === "taken_down") {
    const r = await takeDownBulletin(svc, staff, (req as any).bulletin_id, resolution, input.requestId)
    if (!r.ok) return r
    extra = { derivedWithdrawn: r.derivedWithdrawn }
  } else if (input.outcome !== "rejected") return { ok: false, error: "Unknown outcome." }
  const { data: up, error: upErr } = await svc.from("fraud_correction_requests").update({ status: input.outcome, resolution, resolved_by: staff.userId, resolved_at: new Date().toISOString() }).eq("id", input.requestId).eq("status", "received").select("id")
  if (upErr || !(up ?? []).length) return { ok: false, error: "The resolution was not recorded." }
  return { ok: true, ...extra }
}

// ═══ 8. READERS (every authorized tenant shape) ══════════════════════════════════════════════════════════════════════

/** The ONLY projection a tenant seat ever receives: no tenant, no case, no evidence, no reviewer id. */
const PUBLIC_COLS = "id, typology, title, tactic_summary, indicators, red_flags, how_to_verify, source_url, jurisdiction, recency_date, confidence, claim_class, named_entity, named_entity_citation_url, version, published_at"

async function creditsFor(svc: Svc, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!ids.length) return out
  const { data: srcs } = await svc.from("fraud_bulletin_sources").select("bulletin_id, case_id, brokerage_id").in("bulletin_id", ids)
  const rows = (srcs ?? []) as Array<{ bulletin_id: string; case_id: string; brokerage_id: string }>
  if (!rows.length) return out
  const { data: cases } = await svc.from("fraud_incident_cases").select("id, share_consent").in("id", rows.map((r) => r.case_id))
  const consent = new Set(((cases ?? []) as Array<{ id: string; share_consent: boolean }>).filter((c) => c.share_consent === true).map((c) => c.id))
  const standing = (await tenantStandings(svc, rows.map((r) => r.brokerage_id))) ?? new Map<string, TenantStanding>()
  const tenants = [...new Set(rows.filter((r) => consent.has(r.case_id) && standing.get(r.brokerage_id) === "active").map((r) => r.brokerage_id))]
  if (!tenants.length) return out
  const { data: names } = await svc.from("brokerages").select("id, name").in("id", tenants)
  const nameOf = new Map(((names ?? []) as Array<{ id: string; name: string | null }>).map((n) => [n.id, n.name ?? ""]))
  for (const r of rows) {
    if (!consent.has(r.case_id) || !nameOf.get(r.brokerage_id)) continue
    const list = out.get(r.bulletin_id) ?? []
    if (!list.includes(nameOf.get(r.brokerage_id)!)) list.push(nameOf.get(r.brokerage_id)!)
    out.set(r.bulletin_id, list)
  }
  return out
}

export async function listBulletins(svc: Svc, actor: FraudActor, filter: { typology?: string | null; jurisdiction?: string | null } = {}): Promise<Ok<{ bulletins: any[] }> | Refusal> {
  if (actor.kind === "tenant" && !isParticipant(actor)) return { ok: false, error: "Your seat cannot use the fraud network." }
  let q = svc.from("fraud_bulletins").select(PUBLIC_COLS).eq("status", "published")
  if (filter.typology && typologyOf(filter.typology)) q = q.eq("typology", filter.typology)
  if (filter.jurisdiction) q = q.eq("jurisdiction", str(filter.jurisdiction, 80))
  const { data, error } = await q.order("published_at", { ascending: false }).limit(100)
  if (error) return { ok: false, error: "Bulletins could not be read right now." }
  const rows = (data ?? []) as any[]
  const credits = await creditsFor(svc, rows.map((r) => r.id))
  return { ok: true, bulletins: rows.map((r) => ({ ...r, credits: credits.get(r.id) ?? [], reportedBy: (credits.get(r.id) ?? []).length ? "credited" : "pseudonymous" })) }
}

/** Open one bulletin (records the measured read). A taken-down or draft bulletin is not found. */
export async function openBulletin(svc: Svc, actor: TenantActor, bulletinId: string): Promise<Ok<{ bulletin: any; protectiveAction: string; evidenceChecklist: readonly string[]; readRecorded: boolean }> | Refusal> {
  if (!isParticipant(actor)) return { ok: false, error: "Your seat cannot use the fraud network." }
  if (!UUID.test(String(bulletinId ?? ""))) return { ok: false, error: "Bulletin not found." }
  const { data, error } = await svc.from("fraud_bulletins").select(PUBLIC_COLS).eq("id", bulletinId).eq("status", "published").maybeSingle()
  if (error) return { ok: false, error: "The bulletin could not be read right now." }
  if (!data) return { ok: false, error: "Bulletin not found." }
  // The measured read (metric "bulletins read"). A repeat read is the unique key refusing (23505) — already counted. Any
  // other refusal is a counted, REPORTED degradation: the seat still gets the warning (safety first), the metric is short.
  const { error: readErr } = await svc.from("fraud_bulletin_reads").insert({ brokerage_id: actor.brokerageId, user_id: actor.userId, bulletin_id: bulletinId, first_read_at: new Date().toISOString() })
  const readRecorded = !readErr || readErr.code === "23505"
  if (!readRecorded) console.error("[fraud-network] bulletin read not recorded (metric under-counts):", readErr?.message)
  const t = typologyOf((data as any).typology)!
  const credits = await creditsFor(svc, [bulletinId])
  return { ok: true, bulletin: { ...(data as any), credits: credits.get(bulletinId) ?? [] }, protectiveAction: t.protectiveAction, evidenceChecklist: t.evidenceChecklist, readRecorded }
}

export async function setSubscription(svc: Svc, actor: TenantActor, input: { typology?: string | null; jurisdiction?: string | null; on: boolean }): Promise<Ok<{}> | Refusal> {
  if (!isParticipant(actor)) return { ok: false, error: "Your seat cannot use the fraud network." }
  const typology = input.typology ? (typologyOf(input.typology)?.kind ?? null) : null
  if (input.typology && !typology) return { ok: false, error: "Unknown incident type." }
  const jurisdiction = str(input.jurisdiction, 80) || null
  let q = svc.from("fraud_warning_subscriptions").select("id").eq("user_id", actor.userId)
  q = typology ? q.eq("typology", typology) : q.is("typology", null)
  q = jurisdiction ? q.eq("jurisdiction", jurisdiction) : q.is("jurisdiction", null)
  const { data: existing, error } = await q
  if (error) return { ok: false, error: "Your subscriptions could not be read." }
  if (input.on) {
    if ((existing ?? []).length) return { ok: true }
    const { error: insErr } = await svc.from("fraud_warning_subscriptions").insert({ brokerage_id: actor.brokerageId, user_id: actor.userId, typology, jurisdiction, created_at: new Date().toISOString() })
    return insErr ? { ok: false, error: "The subscription was not saved." } : { ok: true }
  }
  for (const r of (existing ?? []) as Array<{ id: string }>) {
    const { error: delErr } = await svc.from("fraud_warning_subscriptions").delete().eq("id", r.id).eq("user_id", actor.userId).select("id")
    if (delErr) return { ok: false, error: "The subscription was not removed — you may still receive these warnings." }
  }
  return { ok: true }
}

export async function listSubscriptions(svc: Svc, actor: TenantActor): Promise<any[]> {
  const { data } = await svc.from("fraud_warning_subscriptions").select("id, typology, jurisdiction").eq("user_id", actor.userId).eq("brokerage_id", actor.brokerageId)
  return (data ?? []) as any[]
}

/**
 * A published bulletin → the tenant's OWN topic pool as a generic protective education topic. The idea's words come ONLY
 * from the typology catalog's educational question and protective action — never from the bulletin's text, indicators or
 * any case — so no unverified actor can be identified. Filed through the ONE producer (intakeTopicIdeas), under the
 * tenant's own system source (its off switch holds), with unique provenance (dedup key fraud_bulletin:<id>), and recorded
 * as a derivative so a takedown withdraws it.
 */
export async function addBulletinToTopicPool(svc: Svc, actor: TenantActor, bulletinId: string, now = new Date()): Promise<Ok<{ topicIds: string[] }> | Refusal> {
  if (!isCaseReviewer(actor)) return { ok: false, error: "A tenant administrator adds safety topics to the topic pool." }
  const { data: b } = await svc.from("fraud_bulletins").select("id, typology, version").eq("id", bulletinId).eq("status", "published").maybeSingle()
  if (!b) return { ok: false, error: "Bulletin not found." }
  const t = typologyOf((b as any).typology)!
  const { intakeTopicIdeas } = await import("@/lib/content-intel/topic-intake")
  const res = await intakeTopicIdeas(svc as any, { brokerageId: actor.brokerageId, now, ideas: [{
    sourceKind: "fraud_safety_bulletin", title: t.educationalTopic, angle: "Protective education: verify every payment or identity request through a channel you obtained independently.",
    categories: ["fraud_prevention", "consumer_protection"], observedAt: now.toISOString(), evidence: { kind: "unknown" }, rights: "own_content",
    dedupKey: `fraud_bulletin:${bulletinId}`, brief: { provenance: "fraud_safety_bulletin", fraud_bulletin_id: bulletinId, fraud_bulletin_version: (b as any).version, typology: t.kind },
  }] })
  if (!res.ok || res.refused) return { ok: false, error: res.refused ?? res.errors[0] ?? (res.excluded[0] ? `Not stored: ${res.excluded[0].reason}` : "The topic was not stored.") }
  if (!res.rows.length) return { ok: false, error: res.excluded[0] ? `Not stored: ${res.excluded[0].reason}` : "The topic was not stored." }
  // The derivative row is what lets a takedown withdraw this copy. If it cannot be written the copy would outlive a
  // takedown — so the topic is withdrawn again at once and the door FAILS (round 3).
  for (const r of res.rows) {
    const { error: dErr } = await svc.from("fraud_bulletin_derivatives").insert({ brokerage_id: actor.brokerageId, bulletin_id: bulletinId, topic_id: r.id, created_at: now.toISOString() })
    if (dErr && dErr.code !== "23505") {
      const { data: w, error: wErr } = await svc.from("content_topic_bank").update({ status: "rejected" }).eq("id", r.id).eq("brokerage_id", actor.brokerageId).select("id")
      return { ok: false, error: wErr || !(w ?? []).length ? "The topic was stored but could not be linked for takedown, and it could not be withdrawn — contact platform support." : "The topic could not be linked for takedown, so it was withdrawn. Try again in a moment." }
    }
  }
  return { ok: true, topicIds: res.rows.map((r) => r.id) }
}

// ═══ 9. ACTIONABLE SAFETY — the wire sentinel's bulletin match proposes a verification task (never a denial) ═══════

export interface WireMatchInput {
  brokerageId: string
  flags: ReadonlyArray<{ key: string }>
  senderEmail?: string | null
  transactionId?: string | null
  contactId?: string | null
  /** agents.id of the agent on the deal (tasks.assigned_to_agent_id is an agents.id — CLAUDE.md §3). */
  agentId?: string | null
  /** The idempotency unit (the wire document's dedupe key). */
  subjectRef: string
}

/**
 * Compare a suspicious wire to PUBLISHED bulletins. On a match, PROPOSE one high-priority task: verify by calling back on
 * an independently obtained number. Nothing else — no deal, vendor, contact or person is changed, scored or denied.
 */
export async function proposeWireVerificationTasks(svc: Svc, input: WireMatchInput): Promise<{ matched: string[]; indicatorMatch: boolean; taskId: string | null; error: string | null }> {
  const out = { matched: [] as string[], indicatorMatch: false, taskId: null as string | null, error: null as string | null }
  const kinds = [...new Set(input.flags.flatMap((f) => WIRE_FLAG_TYPOLOGIES[f.key] ?? []))]
  if (!kinds.length || !UUID.test(String(input.brokerageId ?? ""))) return out
  const { data, error } = await svc.from("fraud_bulletins").select("id, typology, title, indicators, claim_class").eq("status", "published").in("typology", kinds).limit(50)
  if (error) { out.error = `bulletin read refused: ${error.message}`; return out }
  const domain = String(input.senderEmail ?? "").split("@")[1]?.trim().toLowerCase() ?? ""
  const rows = (data ?? []) as Array<{ id: string; typology: string; title: string; indicators: Array<{ kind: string; value: string }> | null; claim_class: string }>
  const exact = rows.filter((r) => domain && (r.indicators ?? []).some((i) => i.kind === "lookalike_domain" && i.value === domain))
  const ranked = [...exact, ...rows.filter((r) => !exact.includes(r))].slice(0, 3)
  out.matched = ranked.map((r) => r.id)
  out.indicatorMatch = exact.length > 0
  if (!ranked.length) return out
  const tag = `fraud_wire:${input.subjectRef}`
  const { data: prior, error: pErr } = await svc.from("tasks").select("id").eq("brokerage_id", input.brokerageId).eq("source", VERIFICATION_TASK_SOURCE).contains("tags", [tag]).limit(1)
  if (pErr) { out.error = `task dedupe read refused: ${pErr.message}`; return out }
  if ((prior ?? []).length) { out.taskId = (prior as Array<{ id: string }>)[0].id; return out }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const created = await withActionLedger<{ id: string | null; error: string | null }>({
    brokerageId: input.brokerageId, action: "fraud.verification_task.propose", actor: { type: "manager", managerKey: "deal_coordinator" },
    subject: { type: "wire_instructions", ref: input.subjectRef }, reasonCode: "TRANSACTION_MILESTONE",
    reasonDetail: `wire red flags match ${ranked.length} published fraud bulletin(s) — independent verification proposed`, riskClass: "LOW_RISK_WRITE",
    idempotencyKey: `fraud_wire_task:${input.brokerageId}:${input.subjectRef}`, detail: { bulletin_ids: out.matched, indicator_match: out.indicatorMatch },
  }, async () => {
    const { data: t, error: tErr } = await svc.from("tasks").insert({
      brokerage_id: input.brokerageId, transaction_id: input.transactionId ?? null, contact_id: input.contactId ?? null, assigned_to_agent_id: input.agentId ?? null,
      title: "Verify wire instructions by phone before any money moves",
      description: `These wire instructions match a published fraud tactic (${ranked.map((r) => r.title).join("; ")}). Call the title / escrow company or closing attorney back on a number you obtained independently — the signed settlement statement or a number already on file, never one from the message — and confirm the account before anyone wires. This is a verification step, not a finding about any person.`,
      priority: "high", status: "pending", assignee_type: "agent", source: VERIFICATION_TASK_SOURCE, auto_generated: true, tags: [tag, ...out.matched.map((id) => `fraud_bulletin:${id}`)],
      due_date: new Date().toISOString(), created_at: new Date().toISOString(),
    }).select("id").single()
    return { id: (t as { id?: string } | null)?.id ?? null, error: tErr ? tErr.message : null }
  }, { settle: (r) => ({ status: r.id ? "executed" : "failed", outcome: r.id ? "task_proposed" : "task_refused", providerRef: r.id, error: r.error }), replay: (claim) => ({ id: claim.kind === "replay" ? claim.entry.provider_ref : null, error: claim.kind === "replay" ? null : `not proposed: ${claim.kind}` }) }, { client: svc })
  out.taskId = created.id
  out.error = created.error
  return out
}

// ═══ 10. MEASURED METRICS (never imagined) ═════════════════════════════════════════════════════════════════════════

export interface FraudNetworkMetrics {
  scope: "platform" | "tenant"
  publishedBulletins: number
  bulletinsRead: number
  verificationTasksProposed: number
  verifiedSafetyTasksActed: number
  meanHoursToVerify: number | null
  falsePositiveCorrections: number
  lossesPrevented: null
  lossesPreventedNote: string
  rowCap: number
}

export async function fraudNetworkMetrics(svc: Svc, scope: { kind: "platform" } | { kind: "tenant"; brokerageId: string }): Promise<Ok<{ metrics: FraudNetworkMetrics }> | Refusal> {
  const held = fraudMetricsScope(scope)
  if (!held) return { ok: false, error: "The network metrics could not be read: no tenant is on this session." }
  // The scope is written AT each tenant-table query (test:tenant-scope reads it beside the query, never through a wrapper).
  const [bul, reads, tasks, corr] = await Promise.all([
    svc.from("fraud_bulletins").select("id").eq("status", "published").limit(METRIC_ROW_CAP),
    applyTenantScope(svc.from("fraud_bulletin_reads").select("id"), held).limit(METRIC_ROW_CAP),
    applyTenantScope(svc.from("tasks").select("id, status, created_at, completed_at").eq("source", VERIFICATION_TASK_SOURCE), held).limit(METRIC_ROW_CAP),
    applyTenantScope(svc.from("fraud_correction_requests").select("id, status").in("status", ["corrected", "taken_down"]), held).limit(METRIC_ROW_CAP),
  ])
  if (bul.error || reads.error || tasks.error || corr.error) return { ok: false, error: "The network metrics could not be read." }
  const done = ((tasks.data ?? []) as Array<{ status: string; created_at: string; completed_at: string | null }>).filter((t) => t.status === "completed" && t.completed_at)
  const hours = done.map((t) => (Date.parse(t.completed_at!) - Date.parse(t.created_at)) / 3_600_000).filter((h) => Number.isFinite(h) && h >= 0)
  return { ok: true, metrics: {
    scope: scope.kind, publishedBulletins: (bul.data ?? []).length, bulletinsRead: (reads.data ?? []).length,
    verificationTasksProposed: (tasks.data ?? []).length, verifiedSafetyTasksActed: done.length,
    meanHoursToVerify: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
    falsePositiveCorrections: (corr.data ?? []).length, lossesPrevented: null,
    lossesPreventedNote: "Not counted: a prevented loss is reported only when a verified outcome is recorded, and no such record exists yet.",
    rowCap: METRIC_ROW_CAP,
  } }
}

// ═══ 11. RETENTION ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Delete private cases past their retention timer (evidence and bulletin source links cascade). Counted. */
export async function purgeExpiredFraudCases(svc: Svc, now = new Date()): Promise<{ purged: number; error: string | null }> {
  const { data, error } = await svc.from("fraud_incident_cases").delete().lte("retention_until", now.toISOString()).select("id")
  if (error) return { purged: 0, error: error.message }
  return { purged: (data ?? []).length, error: null }
}

// ═══ 12. TENANT DEPARTURE (round 2) — read the tenant's status the way the rest of the product does ══════════════════

/** A tenant has LEFT when brokerages.status is a lifecycle-refused value other than the resumable `suspended` (named
 *  subtraction from lib/billing/billing-access.ts TENANT_LIFECYCLE_REFUSED — never restated), or its row is soft-deleted
 *  (brokerages.deleted_at), or the row is gone. A suspended tenant is PAUSED: its seats cannot take part, its data stays. */
const FRAUD_DEPARTED_TENANT_STATUSES: ReadonlySet<string> = new Set([...TENANT_LIFECYCLE_REFUSED].filter((s) => s !== "suspended"))
type TenantStanding = "active" | "paused" | "departed"

/** Standing per tenant id. null = the read was refused (callers fail closed). A missing row reads as departed. */
async function tenantStandings(svc: Svc, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, TenantStanding> | null> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))]
  const out = new Map<string, TenantStanding>()
  if (!uniq.length) return out
  const { data, error } = await svc.from("brokerages").select("id, status, deleted_at").in("id", uniq)
  if (error) return null
  for (const id of uniq) out.set(id, "departed")
  for (const b of (data ?? []) as Array<{ id: string; status: string | null; deleted_at: string | null }>) {
    const st = String(b.status ?? "active")
    out.set(b.id, b.deleted_at || FRAUD_DEPARTED_TENANT_STATUSES.has(st) ? "departed" : TENANT_LIFECYCLE_REFUSED.has(st) ? "paused" : "active")
  }
  return out
}

/** The seat's own tenant must be ACTIVE to take part (the session door asks this before anything else). */
export async function tenantMayParticipate(svc: Svc, brokerageId: string): Promise<{ ok: true } | Refusal> {
  const s = await tenantStandings(svc, [brokerageId])
  if (!s) return { ok: false, error: "Your account could not be checked right now." }
  return s.get(brokerageId) === "active" ? { ok: true } : { ok: false, error: "Your business's account is not active, so the fraud network is unavailable." }
}

/**
 * SEAL a departed tenant: its bulletin source links and its warning subscriptions are DELETED (counted), so no retained
 * bulletin leads back to its private cases and nothing is sent to it. Its cases stay unreadable (readCase) until the
 * retention purge deletes them. Runs on the sentinel cron beside the purge.
 */
export async function sealDepartedTenants(svc: Svc): Promise<{ sourcesRemoved: number; subscriptionsRemoved: number; error: string | null }> {
  const out = { sourcesRemoved: 0, subscriptionsRemoved: 0, error: null as string | null }
  const [src, subs] = await Promise.all([
    svc.from("fraud_bulletin_sources").select("brokerage_id").limit(METRIC_ROW_CAP),
    svc.from("fraud_warning_subscriptions").select("brokerage_id").limit(METRIC_ROW_CAP),
  ])
  if (src.error || subs.error) { out.error = `read refused: ${(src.error ?? subs.error).message}`; return out }
  const ids = [...((src.data ?? []) as Array<{ brokerage_id: string }>), ...((subs.data ?? []) as Array<{ brokerage_id: string }>)].map((r) => r.brokerage_id)
  const standing = await tenantStandings(svc, ids)
  if (!standing) { out.error = "tenant status read refused — nothing sealed"; return out }
  for (const [id, st] of standing) {
    if (st !== "departed") continue
    const a = await svc.from("fraud_bulletin_sources").delete().eq("brokerage_id", id).select("id")
    const b = await svc.from("fraud_warning_subscriptions").delete().eq("brokerage_id", id).select("id")
    if (a.error || b.error) { out.error = `seal refused for a tenant: ${(a.error ?? b.error).message}`; continue }
    out.sourcesRemoved += (a.data ?? []).length
    out.subscriptionsRemoved += (b.data ?? []).length
  }
  return out
}

// ═══ 13. NAME-REVIEW HOLD (round 2) — a second moderator reviews any personal-name or business-entity pattern ═════════

/** Capitalized words that open ordinary sentences or name places / institutions — never treated as a personal name. */
const NAME_STOP = new Set([
  "A", "An", "The", "This", "That", "These", "Those", "If", "When", "Do", "Call", "Contact", "Verify", "Never", "Always", "Stop", "Treat",
  "Tell", "Hold", "Report", "Confirm", "Pause", "Deliver", "Have", "Get", "Check", "Use", "Look", "Wire", "Title", "Escrow", "Bank", "Federal",
  "State", "County", "City", "United", "States", "Internal", "Revenue", "Service", "Real", "Estate", "New", "North", "South", "East", "West",
  "Island", "York", "Jersey", "Mexico", "Carolina", "Dakota", "Hampshire", "Virginia", "Sign", "Multiple", "Listing", "Closing", "Disclosure",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Reported", "Official", "Warning",
])
const PERSON_RE = /\b([A-Z][a-z]{1,20})(?:\s+[A-Z]\.)?\s+([A-Z][a-z]{1,24})\b/g
const ENTITY_RE = /\b(?:[A-Z][\w&'-]*\s+){1,4}(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|LLP|PLLC|P\.C\.|Co\.|Company|Holdings)(?=[\s.,;:!?)]|$)/g

/** PURE — the spans that hold publication for a second moderator. An official public warning is exempt (its named
 *  entity has its own citation + legal-review rule). Returns the matched text, never a judgment about it. */
export function nameReviewSpans(b: Record<string, any>): string[] {
  if (b.claim_class === "official_public_warning") return []
  const texts = [b.title, b.tactic_summary, b.how_to_verify, ...((b.red_flags ?? []) as string[]), ...((b.indicators ?? []) as Array<{ kind: string; value: string }>).filter((i) => i.kind !== "lookalike_domain").map((i) => i.value)]
  const spans = new Set<string>()
  for (const t of texts.map((x) => String(x ?? ""))) {
    for (const m of t.matchAll(ENTITY_RE)) spans.add(m[0].trim())
    for (const m of t.matchAll(PERSON_RE)) if (!NAME_STOP.has(m[1]) && !NAME_STOP.has(m[2])) spans.add(m[0].trim())
  }
  return [...spans].sort()
}
const spansFingerprint = (spans: string[]): string => createHash("sha256").update(spans.join("\u0000")).digest("hex")

/** Hold unless a DIFFERENT moderator cleared exactly these spans. Writes the hold (the first requester is kept). */
async function holdForNameReview(svc: Svc, staff: StaffActor, bulletinId: string, b: Record<string, any>): Promise<(Refusal & { held: true; spans: string[] }) | null> {
  const spans = nameReviewSpans(b)
  if (!spans.length) return null
  const fp = spansFingerprint(spans)
  const hold = b.name_review_hold as { spans_fingerprint?: string; requested_by?: string } | null
  const clr = b.name_review_clearance as { spans_fingerprint?: string; cleared_by?: string } | null
  if (clr && clr.spans_fingerprint === fp && hold?.spans_fingerprint === fp && clr.cleared_by && clr.cleared_by !== hold.requested_by) return null
  if (hold?.spans_fingerprint !== fp) {
    const { error } = await svc.from("fraud_bulletins").update({ name_review_hold: { spans, spans_fingerprint: fp, requested_by: staff.userId, at: new Date().toISOString() }, name_review_clearance: null }).eq("id", bulletinId)
    if (error) return { ok: false, held: true, spans, error: "The text needs a second moderator's review, and the hold could not be recorded — nothing was published." }
  }
  return { ok: false, held: true, spans, error: `Held for a second moderator: the text contains ${spans.map((x) => `“${x}”`).join(", ")}, which may identify a person or business. A different moderator must review it (remove it, or confirm it is not an identification) before this is published.` }
}

/** The SECOND moderator's review of a held text. The requester cannot clear their own hold; the text must be unchanged. */
export async function clearNameReview(svc: Svc, staff: StaffActor, bulletinId: string, note: string): Promise<Ok<{}> | Refusal> {
  if (staff.kind !== "staff" || !staff.canWrite) return { ok: false, error: "Platform safety staff with write access only." }
  const why = str(note, 1000)
  if (!why) return { ok: false, error: "Record why the matched text does not identify anyone (or remove it instead)." }
  const { data: b, error } = await svc.from("fraud_bulletins").select(SNAPSHOT_COLS).eq("id", bulletinId).maybeSingle()
  if (error || !b) return { ok: false, error: "Bulletin not found." }
  const hold = (b as any).name_review_hold as { spans_fingerprint?: string; requested_by?: string } | null
  if (!hold?.spans_fingerprint) return { ok: false, error: "This bulletin has no name-review hold." }
  if (hold.requested_by === staff.userId) return { ok: false, error: "A different moderator must review this hold." }
  const fp = spansFingerprint(nameReviewSpans(b as any))
  if (fp !== hold.spans_fingerprint) return { ok: false, error: "The text changed since the hold — publish again so the new text is held and reviewed." }
  const tenant = await staffLedgerTenant(svc, staff, bulletinId)
  if (!tenant) return { ok: false, error: "No tenant to record the receipt under — not cleared." }
  return receipt(svc, { brokerageId: tenant, action: "fraud.bulletin.clear_name_review", actorUserId: staff.userId, subject: { type: "fraud_bulletin", id: bulletinId }, reason: why, riskClass: "LEGAL", detail: { spans_fingerprint: fp, requested_by: hold.requested_by } }, async () => {
    const { data: up, error: upErr } = await svc.from("fraud_bulletins").update({ name_review_clearance: { spans_fingerprint: fp, cleared_by: staff.userId, at: new Date().toISOString(), note: why } }).eq("id", bulletinId).select("id")
    return upErr || !(up ?? []).length ? { ok: false as const, error: "The review was not recorded." } : { ok: true as const }
  }) as any
}

// ═══ 14. EVIDENCE FILES (round 2) — metadata is stripped BEFORE the storage check, so it is never forgotten ══════════

/** The private, SERVICE-ONLY bucket the owner creates (report: OWNER SQL). Its presence is read from the generated live
 *  bucket map (lib/storage/bucket-limits.ts), never assumed. */
export const FRAUD_EVIDENCE_BUCKET = "fraud-evidence"
const EVIDENCE_URL_SECONDS = 300
const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024
export interface EvidenceStoreDeps {
  bucketEnabled?: boolean
  upload?: (path: string, bytes: Uint8Array, contentType: string) => Promise<{ ok: boolean; error?: string }>
  sign?: (path: string) => Promise<{ url: string | null }>
}
const evidenceObjectPath = (brokerageId: string, caseId: string, fingerprint: string): string => `${brokerageId}/${caseId}/${fingerprint}`

async function evidenceBucketEnabled(): Promise<boolean> {
  try {
    const { LIVE_BUCKET_CONFIG } = await import("@/lib/storage/bucket-limits")
    return LIVE_BUCKET_CONFIG[FRAUD_EVIDENCE_BUCKET]?.isPublic === false
  } catch { return false }
}

/**
 * PURE — remove metadata from a JPEG or PNG. JPEG: every APP1–APP15 segment (EXIF incl. GPS / camera serial, XMP, ICC,
 * IPTC / Photoshop) and every COM comment segment are dropped; APP0 (JFIF) and the image data are kept. PNG: tEXt, zTXt,
 * iTXt, eXIf and tIME chunks are dropped. Any other type is REFUSED (it cannot be cleaned reliably here — keep the
 * original). A truncated or malformed file is refused rather than passed through.
 */
export function stripImageMetadata(input: Uint8Array): { ok: true; bytes: Uint8Array; type: "image/jpeg" | "image/png"; removed: string[] } | Refusal {
  const b = input
  const removed: string[] = []
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
    const out: number[] = [0xff, 0xd8]
    let i = 2
    while (i < b.length) {
      if (b[i] !== 0xff) return { ok: false, error: "The image is malformed (a JPEG segment did not start where expected)." }
      const m = b[i + 1]
      if (m === 0xda || m === 0xd9) { for (let k = i; k < b.length; k++) out.push(b[k]); break } // SOS (image data) / EOI: copy the rest
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(0xff, m); i += 2; continue }
      if (i + 3 >= b.length) return { ok: false, error: "The image is truncated." }
      const len = (b[i + 2] << 8) | b[i + 3]
      if (len < 2 || i + 2 + len > b.length) return { ok: false, error: "The image is truncated." }
      if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) removed.push(m === 0xe1 ? "APP1 (EXIF / XMP)" : m === 0xfe ? "COM (comment)" : m === 0xed ? "APP13 (IPTC)" : m === 0xe2 ? "APP2 (ICC)" : `APP${m - 0xe0}`)
      else for (let k = i; k < i + 2 + len; k++) out.push(b[k])
      i += 2 + len
    }
    return { ok: true, bytes: Uint8Array.from(out), type: "image/jpeg", removed }
  }
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length >= 8 && SIG.every((v, k) => b[k] === v)) {
    const out: number[] = [...SIG]
    let i = 8
    while (i < b.length) {
      if (i + 8 > b.length) return { ok: false, error: "The image is truncated." }
      const len = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
      const end = i + 12 + len
      if (end > b.length) return { ok: false, error: "The image is truncated." }
      if (["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) removed.push(`${type} chunk`)
      else for (let k = i; k < end; k++) out.push(b[k])
      i = end
      if (type === "IEND") break
    }
    return { ok: true, bytes: Uint8Array.from(out), type: "image/png", removed }
  }
  return { ok: false, error: "Only JPEG and PNG images can be cleaned of hidden metadata today. Keep the original file safely; its fingerprint is already on the case." }
}

/**
 * THE EVIDENCE UPLOAD DOOR. Gate (the reporter or the tenant's case reviewer) → type and size → metadata STRIPPED →
 * only then the storage check. Until the private bucket exists it refuses with the honest state AND reports what it
 * removed, so the cleaning step runs today. With the bucket: the CLEANED bytes are stored at
 * <tenant>/<case>/<original fingerprint> through the service client, and the evidence row is marked stored.
 */
export async function uploadEvidenceFile(svc: Svc, actor: TenantActor, input: { caseId: string; kind: string; label?: string | null; bytes: Uint8Array }, deps: EvidenceStoreDeps = {}): Promise<Ok<{ fingerprint: string; metadataRemoved: string[] }> | (Refusal & { metadataRemoved?: string[]; fingerprint?: string })> {
  const r = await readCase(svc, actor, input.caseId)
  if (!r.ok) return r
  if (actor.kind !== "tenant" || (r.case.reporter_user_id !== actor.userId && !isCaseReviewer(actor))) return { ok: false, error: "Only the reporter or your business's case reviewer adds evidence." }
  if (!inList(FRAUD_EVIDENCE_KINDS, input.kind)) return { ok: false, error: "Unknown evidence type." }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) return { ok: false, error: "Choose a file." }
  if (input.bytes.length > EVIDENCE_MAX_BYTES) return { ok: false, error: "The file is larger than 10 MB." }
  const fingerprint = createHash("sha256").update(input.bytes).digest("hex")
  const clean = stripImageMetadata(input.bytes)
  if (!clean.ok) return { ...clean, fingerprint }
  if (!(deps.bucketEnabled ?? (await evidenceBucketEnabled()))) return { ok: false, error: EVIDENCE_STORAGE_NOT_ENABLED, metadataRemoved: clean.removed, fingerprint }
  const path = evidenceObjectPath(r.case.brokerage_id, input.caseId, fingerprint)
  const up = deps.upload ? await deps.upload(path, clean.bytes, clean.type) : await (async () => {
    const res = await (svc as any).storage?.from(FRAUD_EVIDENCE_BUCKET).upload(path, clean.bytes, { contentType: clean.type, upsert: false })
    return { ok: !!res && !res.error, error: res?.error?.message as string | undefined }
  })()
  if (!up.ok) return { ok: false, error: "The file was not stored. Try again in a moment.", metadataRemoved: clean.removed, fingerprint }
  const existing = r.evidence.find((e: any) => e.fingerprint_sha256 === fingerprint)
  const write = existing
    ? await svc.from("fraud_case_evidence").update({ storage_status: "stored" }).eq("id", existing.id).eq("brokerage_id", r.case.brokerage_id).select("id")
    : await svc.from("fraud_case_evidence").insert({ brokerage_id: r.case.brokerage_id, case_id: input.caseId, evidence_kind: input.kind, fingerprint_sha256: fingerprint, label: str(input.label, 200) || null, storage_status: "stored", created_by: actor.userId }).select("id")
  if (write.error || !(write.data ?? []).length) return { ok: false, error: "The file was stored but the case was not updated — contact platform support.", metadataRemoved: clean.removed, fingerprint }
  return { ok: true, fingerprint, metadataRemoved: clean.removed }
}

/**
 * The scope the metrics read runs under, through the kernel's ONE discriminator (lib/kernel/tenant-scope.ts). A tenant
 * scope whose id is blank is REFUSED (null) — it must never decay into every tenant's counts; the platform scope is
 * something the staff door asked for by name, with its reason written down.
 */
function fraudMetricsScope(scope: { kind: "platform" } | { kind: "tenant"; brokerageId: string }): TenantScope | null {
  try {
    if (scope.kind === "platform") return platformScope("fraud network metrics — platform safety staff read every tenant's counts")
    return tenantScope(scope.brokerageId, "fraud network metrics")
  } catch {
    return null
  }
}

// ═══ 15. THE AUDIT TRAIL, READ BACK (round 4) — a record nobody can read is not an audit trail ═════════════════════

export interface BulletinHistory {
  bulletin: { id: string; title: string; status: string; version: number; publishedBy: string | null; publishedAt: string | null }
  revisions: Array<{ id: string; version: number; changeKind: string; reason: string; at: string; actorUserId: string | null; correctionRequestId: string | null; snapshot: unknown }>
  corrections: Array<{ id: string; requesterKind: string; requesterUserId: string | null; channel: string; status: string; statement: string; resolution: string | null; recordedBy: string | null; resolvedBy: string | null; resolvedAt: string | null; supportTicketId: string | null; at: string }>
  sources: Array<{ caseId: string; linkedBy: string | null; at: string }>
  /** Display names for every user id above (platform staff and the requesting tenant seat — never a reporter). */
  people: Record<string, string>
}

/**
 * PLATFORM SAFETY STAFF ONLY (the caller gates with requirePlatformCapability("support")): a bulletin's full history —
 * every revision (version, change kind, reason, when, who, the correction request it answered, the stored snapshot), every
 * correction request (who recorded it, the tenant requester, who resolved it and when, the support ticket), who published
 * it and who linked each source case. PACKET-7 §5.2: "every earlier version is kept in the correction history" — this is
 * where it is read. A refused read is REPORTED, never shown as "no history". None of it is in the tenant projection.
 */
export async function bulletinHistory(svc: Svc, staff: StaffActor, bulletinId: string): Promise<Ok<{ history: BulletinHistory }> | Refusal> {
  if (staff.kind !== "staff") return { ok: false, error: "Platform safety staff only." }
  if (!UUID.test(String(bulletinId ?? ""))) return { ok: false, error: "Bulletin not found." }
  const { data: b, error: bErr } = await svc.from("fraud_bulletins").select("id, title, status, version, published_by, published_at").eq("id", bulletinId).maybeSingle()
  if (bErr) return { ok: false, error: "The bulletin's history could not be read right now — this is not an empty history." }
  if (!b) return { ok: false, error: "Bulletin not found." }
  const [rev, corr, src] = await Promise.all([
    svc.from("fraud_bulletin_revisions").select("id, version, change_kind, reason, snapshot, correction_request_id, actor_user_id, created_at").eq("bulletin_id", bulletinId).order("created_at", { ascending: true }).limit(500),
    svc.from("fraud_correction_requests").select("id, requester_kind, requester_user_id, channel, status, statement, resolution, recorded_by, resolved_by, resolved_at, support_ticket_id, created_at").eq("bulletin_id", bulletinId).order("created_at", { ascending: true }).limit(500),
    svc.from("fraud_bulletin_sources").select("case_id, linked_by, created_at").eq("bulletin_id", bulletinId).order("created_at", { ascending: true }).limit(500),
  ])
  if (rev.error || corr.error || src.error) return { ok: false, error: "The bulletin's history could not be read right now — this is not an empty history." }
  const revisions = ((rev.data ?? []) as any[]).map((r) => ({ id: r.id, version: Number(r.version), changeKind: r.change_kind, reason: r.reason, at: r.created_at, actorUserId: r.actor_user_id ?? null, correctionRequestId: r.correction_request_id ?? null, snapshot: r.snapshot }))
  const corrections = ((corr.data ?? []) as any[]).map((c) => ({ id: c.id, requesterKind: c.requester_kind, requesterUserId: c.requester_kind === "tenant" ? (c.requester_user_id ?? null) : null, channel: c.channel, status: c.status, statement: c.statement, resolution: c.resolution ?? null, recordedBy: c.recorded_by ?? null, resolvedBy: c.resolved_by ?? null, resolvedAt: c.resolved_at ?? null, supportTicketId: c.support_ticket_id ?? null, at: c.created_at }))
  const sources = ((src.data ?? []) as any[]).map((s) => ({ caseId: s.case_id, linkedBy: s.linked_by ?? null, at: s.created_at }))
  const ids = [...new Set([(b as any).published_by, ...revisions.map((r) => r.actorUserId), ...corrections.flatMap((c) => [c.recordedBy, c.resolvedBy, c.requesterUserId]), ...sources.map((s) => s.linkedBy)].filter((x): x is string => !!x))]
  const people: Record<string, string> = {}
  if (ids.length) {
    const { data: us, error: uErr } = await svc.from("users").select("id, first_name, last_name, email").in("id", ids)
    if (uErr) return { ok: false, error: "The bulletin's history could not be read right now — this is not an empty history." }
    for (const u of (us ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) people[u.id] = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || u.id
  }
  return { ok: true, history: { bulletin: { id: (b as any).id, title: (b as any).title, status: (b as any).status, version: Number((b as any).version), publishedBy: (b as any).published_by ?? null, publishedAt: (b as any).published_at ?? null }, revisions, corrections, sources, people } }
}

/**
 * A TENANT SEAT'S OWN read state: which bulletins THIS seat opened and when — pinned to the session user AND the session
 * tenant, so it can never show another user's reads (and a read row carries nothing about any reporter).
 */
export async function myBulletinReads(svc: Svc, actor: TenantActor): Promise<Ok<{ reads: Array<{ bulletinId: string; firstReadAt: string }> }> | Refusal> {
  if (!isParticipant(actor)) return { ok: false, error: "Your seat cannot use the fraud network." }
  const { data, error } = await applyTenantScope(svc.from("fraud_bulletin_reads").select("bulletin_id, first_read_at").eq("user_id", actor.userId), tenantScope(actor.brokerageId, "a seat's own fraud bulletin read state")).limit(METRIC_ROW_CAP)
  if (error) return { ok: false, error: "Your read state could not be loaded — warnings are shown without read marks." }
  return { ok: true, reads: ((data ?? []) as Array<{ bulletin_id: string; first_read_at: string }>).map((r) => ({ bulletinId: r.bulletin_id, firstReadAt: r.first_read_at })) }
}
