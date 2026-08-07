/**
 * lib/transactions/hazard-insurance.ts
 *
 * THE BUYER'S HAZARD / HOMEOWNER'S POLICY, AS A READABLE POSTURE. Pure — no
 * I/O, no supabase client, no `server-only` in its import graph — so the cron
 * detector, the server actions, and a "use client" panel all read the same
 * verdict from the same code.
 *
 * ── WHY THIS IS NOT lib/kernel/vendor-doc-compliance.ts ─────────────────────
 * That module's `evaluateCredential` is a genuinely good expiry evaluator and it
 * is NOT reused here. Four reasons, each of which would have to be defeated for
 * reuse to be honest rather than forced:
 *
 *   1. ITS VERDICTS ARE VENDOR-LIFECYCLE EFFECTS. `suspend` flips
 *      vendors.status to inactive and pulls a vendor off the marketplace bench;
 *      `soft_flag` appends to vendors.verification_flags. Neither is a thing you
 *      can do to a buyer. There is no row to suspend and no bench to remove.
 *
 *   2. THE DECISIVE CLOCK IS A DIFFERENT CLOCK. A vendor's certificate is
 *      measured against TODAY, forever — that is the whole contract of
 *      `daysUntil(expiry, now)`. A buyer's policy is measured against THE
 *      CLOSING, because the lender wants evidence of coverage roughly 7-10 days
 *      before funding and the policy's own expiry is a year out and almost never
 *      the risk. Reuse would mean bolting a second time axis onto a function
 *      whose entire signature says there is one.
 *
 *   3. THE LOAD-BEARING STATE IS ABSENCE, AND evaluateCredential DELIBERATELY
 *      MUTES IT. A missing expiry there returns action:'none', "no expiry on
 *      file" — correct for a vendor (nothing to act on, never a fabricated
 *      lapse) and exactly backwards here, where "no policy on file, eight days
 *      to close" is the single most important thing the system can say.
 *
 *   4. ITS INPUT SHAPE IS PINNED TO A DIFFERENT TABLE BY A DATABASE CONSTRAINT.
 *      m376's `vendor_credential_bag_ok` fixes the credential vocabulary to
 *      license|insurance|certification|bond on vendors.compliance_credentials,
 *      precisely so that function and that column cannot drift apart.
 *      Generalising the evaluator would loosen a coupling that exists on purpose.
 *
 * WHAT *IS* SHARED, because it is genuinely the same thing: `daysUntil` (the
 * parse-or-null date arithmetic, where an unreadable date is never "fine") and
 * `REMINDER_WINDOWS` (the 60/30/7 cadence). Both are imported from
 * lib/vendors/insurance-posture.ts, so there is still exactly ONE definition of
 * each in the codebase.
 *
 * NOTHING HERE IS EVER ASSERTED. Every posture is derived from the stored
 * record; there is no "insured: true" field anywhere, because a field like that
 * can be set by someone who never saw a binder.
 */

import { daysUntil, REMINDER_WINDOWS } from "@/lib/vendors/insurance-posture"

// ─────────────────────────────────────────────────────────────────────────────
// Lead time

/**
 * How many days before closing the binder must be on file. Lenders typically
 * want evidence of coverage 7-10 days out; we take the WIDER end so the reminder
 * arrives while there is still time to shop a carrier, not on the day the
 * absence becomes fatal.
 */
export const HAZARD_EVIDENCE_LEAD_DAYS = 10

/** Inside this many days to close, an unbound policy stops being a nudge. */
export const HAZARD_EVIDENCE_URGENT_DAYS = 7

/** Widest expiry window at which a policy reads as "expiring soon" (60/30/7). */
export const HAZARD_EXPIRING_DAYS = Math.max(...REMINDER_WINDOWS)

// ─────────────────────────────────────────────────────────────────────────────
// The stored record

/**
 * One bound hazard / homeowner's policy, as stored in
 * transaction_vendor_services.policy. Shape is enforced by the database
 * (`hazard_policy_record_ok`, m385) — this interface MIRRORS that CHECK. A field
 * added here without the migration produces a value PostgREST refuses and
 * RESOLVES, i.e. a silent write failure.
 */
export interface HazardPolicyRecord {
  carrier?: string | null
  policy_number?: string | null
  coverage_amount?: number | null
  annual_premium?: number | null
  effective_date?: string | null
  expiry?: string | null
  /** transaction_documents.id of the binder / declarations page. NOT documents.id. */
  document_id?: string | null
  bound_at?: string | null
  /** users.id of whoever recorded it. NOT agents.id, NOT contacts.id. */
  bound_by?: string | null
}

/** The insurance engagement row this posture is read from. */
export interface HazardServiceRow {
  id: string
  service_type: string | null
  status: string | null
  vendor_name: string | null
  /** vendors.id when the carrier came off the marketplace, else null. */
  vendor_id: string | null
  quote_amount: number | null
  cost: number | null
  policy: HazardPolicyRecord | null
}

// ─────────────────────────────────────────────────────────────────────────────
// The posture

/**
 * How the deal's hazard coverage reads RIGHT NOW.
 *
 * `none` and `expiry_unknown` are first-class states, not fallbacks. A deal with
 * nothing on file and a deal with a binder whose expiry cannot be parsed are
 * different facts, and neither may ever be rounded up to "covered".
 */
export type HazardPosture =
  | "none"            // no insurance engagement on the deal at all
  | "quote_requested" // an engagement exists; no client decision yet
  | "quote_approved"  // client accepted a quote — NOT coverage in force
  | "bound"           // policy on file, expiry comfortably ahead
  | "expiring"        // policy on file, expiry inside the 60-day window
  | "lapsed"          // policy on file, expiry already past
  | "expiry_unknown"  // policy on file, but no readable expiry

export interface HazardInsuranceStatus {
  posture: HazardPosture
  /** Short badge text. */
  label: string
  /** One line an agent can act on. Always names the fact it is derived from. */
  detail: string

  /** True only when a policy record exists. False is the "not yet provided" state. */
  hasPolicyOnFile: boolean

  // Everything below is NULL when not on file — never a placeholder figure.
  carrier: string | null
  policyNumber: string | null
  coverageAmount: number | null
  annualPremium: number | null
  effectiveDate: string | null
  expiry: string | null
  /** transaction_documents.id of the binder, or null when no document was filed. */
  documentId: string | null
  boundAt: string | null
  daysToExpiry: number | null

  /** vendors.id when the carrier came off the marketplace; null for an outside provider. */
  vendorId: string | null
  vendorName: string | null
  serviceId: string | null

  // ── Closing pressure ──────────────────────────────────────────────────────
  /** Whole days from now to the close date. Null when there is no close date. */
  daysToClose: number | null
  /** ISO date the binder should be on file by (close date minus the lead time). */
  evidenceDueDate: string | null
  /** True when coverage is in force today (bound or expiring — both are covered). */
  coverageInForce: boolean
  /**
   * True when a policy IS on file but its expiry falls on or before the close
   * date — coverage would lapse before funding. Rare, and invisible unless
   * checked, which is why it is checked.
   */
  expiresBeforeClosing: boolean
  /**
   * True when coverage is in force but NO binder / declarations page has been
   * filed. The lender underwrites the DOCUMENT, not the typed numbers, so this
   * is still an open closing item — and it is the failure mode that hides best,
   * because the record looks complete.
   */
  missingEvidenceDocument: boolean
  /** True when the absence (or lapse) of coverage is now a closing problem. */
  blocksClosing: boolean
}

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** Whole days from `now` to an ISO date, or null when unreadable. */
function daysTo(target: string | null | undefined, now: Date): number | null {
  return daysUntil(target, now)
}

/**
 * PURE: read the deal's hazard-insurance posture.
 *
 * `service` is the transaction_vendor_services row with
 * service_type='insurance_quote', or null when the deal has no insurance
 * engagement at all. `closeDate` is transactions.close_date (ISO), or null.
 */
export function readHazardInsurance(input: {
  service: HazardServiceRow | null
  closeDate: string | null
  now: Date
}): HazardInsuranceStatus {
  const { service, closeDate, now } = input

  const daysToClose = daysTo(closeDate, now)
  const evidenceDueDate =
    closeDate && !Number.isNaN(Date.parse(closeDate))
      ? isoDay(new Date(Date.parse(closeDate) - HAZARD_EVIDENCE_LEAD_DAYS * 86_400_000))
      : null

  const base: HazardInsuranceStatus = {
    posture: "none",
    label: "Not yet provided",
    detail:
      "No homeowner's insurance has been recorded for this purchase. A lender will not fund without evidence of coverage.",
    hasPolicyOnFile: false,
    carrier: null,
    policyNumber: null,
    coverageAmount: null,
    annualPremium: null,
    effectiveDate: null,
    expiry: null,
    documentId: null,
    boundAt: null,
    daysToExpiry: null,
    vendorId: null,
    vendorName: null,
    serviceId: null,
    daysToClose,
    evidenceDueDate,
    coverageInForce: false,
    expiresBeforeClosing: false,
    missingEvidenceDocument: false,
    blocksClosing: false,
  }

  // ── No engagement at all ──────────────────────────────────────────────────
  if (!service) {
    return { ...base, blocksClosing: pressingNow(daysToClose) }
  }

  const withVendor: HazardInsuranceStatus = {
    ...base,
    serviceId: service.id,
    vendorId: service.vendor_id ?? null,
    vendorName: service.vendor_name ?? null,
  }

  const policy = service.policy ?? null
  const hasPolicy =
    !!policy &&
    typeof policy === "object" &&
    // An empty object is not a policy. Treat it as nothing on file rather than
    // letting `{}` render as a bound policy with every field blank.
    Object.values(policy).some((v) => v !== null && v !== undefined && v !== "")

  // ── Engagement exists, no policy record yet ───────────────────────────────
  if (!hasPolicy) {
    const status = service.status ?? ""
    const quoted = service.quote_amount ?? service.cost ?? null
    if (status === "approved") {
      return {
        ...withVendor,
        posture: "quote_approved",
        label: "Quote approved — not yet bound",
        detail:
          `The buyer approved ${service.vendor_name ?? "a carrier"}${quoted != null ? ` at ${money(quoted)}/yr` : ""}, ` +
          `but no policy has been bound and no binder is on file. An approved quote is not coverage.`,
        blocksClosing: pressingNow(daysToClose),
      }
    }
    return {
      ...withVendor,
      posture: "quote_requested",
      label: "Quote in progress",
      detail:
        `${service.vendor_name ?? "A carrier"} has been engaged (${status || "no status"}), ` +
        `but no policy has been bound and no binder is on file.`,
      blocksClosing: pressingNow(daysToClose),
    }
  }

  // ── A policy record exists ────────────────────────────────────────────────
  const p = policy as HazardPolicyRecord
  const daysToExpiry = daysTo(p.expiry, now)
  const filled: HazardInsuranceStatus = {
    ...withVendor,
    hasPolicyOnFile: true,
    carrier: p.carrier ?? null,
    policyNumber: p.policy_number ?? null,
    coverageAmount: typeof p.coverage_amount === "number" ? p.coverage_amount : null,
    annualPremium: typeof p.annual_premium === "number" ? p.annual_premium : null,
    effectiveDate: p.effective_date ?? null,
    expiry: p.expiry ?? null,
    documentId: p.document_id ?? null,
    boundAt: p.bound_at ?? null,
    daysToExpiry,
  }

  const carrierLabel = filled.carrier ?? service.vendor_name ?? "The carrier"
  const evidenceLine = filled.documentId
    ? "Binder / declarations page is on file."
    : "NO binder or declarations page has been filed — the lender needs the document, not just the numbers."

  // Unreadable expiry: we genuinely do not know. Saying "covered" or "lapsed"
  // would both be fabricated verdicts.
  if (daysToExpiry == null) {
    return {
      ...filled,
      posture: "expiry_unknown",
      label: "Expiry unknown",
      detail: `${carrierLabel} is recorded but the policy carries no readable expiry date, so coverage at closing cannot be confirmed either way. ${evidenceLine}`,
      blocksClosing: pressingNow(daysToClose),
    }
  }

  if (daysToExpiry < 0) {
    return {
      ...filled,
      posture: "lapsed",
      label: `Coverage lapsed ${Math.abs(daysToExpiry)}d ago`,
      detail: `${carrierLabel}'s policy expired on ${p.expiry}. There is no coverage in force. ${evidenceLine}`,
      blocksClosing: pressingNow(daysToClose),
    }
  }

  // Coverage IS in force from here down.
  const expiresBeforeClosing =
    closeDate != null && p.expiry != null && !Number.isNaN(Date.parse(p.expiry))
      ? Date.parse(p.expiry) <= Date.parse(closeDate)
      : false

  const missingEvidenceDocument = !filled.documentId

  const covered: HazardInsuranceStatus = {
    ...filled,
    coverageInForce: true,
    expiresBeforeClosing,
    missingEvidenceDocument,
    // Coverage in force STILL leaves a closing item open in two cases:
    //   · the policy will have lapsed by the closing — the only case where
    //     "insured today" and "insured at funding" disagree; and
    //   · no binder / declarations page has been filed, because the lender
    //     underwrites the document. Going quiet the moment somebody types a
    //     carrier name would be the worst possible behaviour here: the record
    //     looks complete and the funding still fails.
    blocksClosing: expiresBeforeClosing || (missingEvidenceDocument && pressingNow(daysToClose)),
  }

  if (expiresBeforeClosing) {
    return {
      ...covered,
      posture: "expiring",
      label: `Expires ${p.expiry} — before closing`,
      detail: `${carrierLabel}'s policy lapses on ${p.expiry}, on or before the ${closeDate} close date. Coverage must extend past funding. ${evidenceLine}`,
    }
  }

  if (daysToExpiry <= HAZARD_EXPIRING_DAYS) {
    return {
      ...covered,
      posture: "expiring",
      label: `Expires in ${daysToExpiry}d`,
      detail: `${carrierLabel}${filled.coverageAmount != null ? ` — ${money(filled.coverageAmount)} coverage` : ""}, in force until ${p.expiry}. ${evidenceLine}`,
    }
  }

  return {
    ...covered,
    posture: "bound",
    // The badge must not read green while the lender is still missing the
    // document it underwrites.
    label: missingEvidenceDocument ? "Bound — binder not filed" : "Coverage bound",
    detail: `${carrierLabel}${filled.policyNumber ? ` policy ${filled.policyNumber}` : ""}${filled.coverageAmount != null ? `, ${money(filled.coverageAmount)} coverage` : ""}, in force ${filled.effectiveDate ?? "—"} to ${p.expiry}. ${evidenceLine}`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel's view model
//
// These live HERE, not in the "use server" action module, so the client panel can
// import its own prop types without the action file (and everything it reaches:
// the service-role supabase client, the milestone service, the vendor resolver)
// being pulled toward the browser bundle. Types are erased at build time; the
// import graph is not, and `test:client-server-only` checks the graph.

/** One insurance vendor as it appears on the brokerage's marketplace. */
export interface InsuranceVendorRecommendation {
  vendorId: string
  name: string | null
  phone: string | null
  email: string | null
  website: string | null
  rating: number | null
  /** Broker-curated bench placement — the reason this one is at the top. */
  preferred: boolean
  /** Deep link to this vendor's existing spot on the buyer's portal marketplace,
   *  where the RESPA / AfBA disclosure gate already governs contact details. */
  marketplaceUrl: string | null
}

export interface HazardInsuranceView {
  ok: boolean
  /** Present only when a read failed — the UI states it instead of guessing. */
  error?: string
  status: HazardInsuranceStatus | null
  recommendations: InsuranceVendorRecommendation[]
  /** Why the recommendation list is empty, when it is. Never a silent blank. */
  recommendationNote: string | null
  buyerContactId: string | null
  closeDate: string | null
}

/** Inside the lead-time window (and not already past the close date). */
function pressingNow(daysToClose: number | null): boolean {
  return daysToClose != null && daysToClose >= 0 && daysToClose <= HAZARD_EVIDENCE_LEAD_DAYS
}

/**
 * PURE: severity for the pre-closing reminder. Shared by the closing-orchestration
 * detector and the UI so an agent never sees a calmer badge than the cron acted on.
 */
export function hazardSeverity(status: HazardInsuranceStatus): "medium" | "high" | "urgent" {
  if (status.daysToClose == null) return "medium"
  if (status.daysToClose <= HAZARD_EVIDENCE_URGENT_DAYS) return "urgent"
  return "high"
}

/**
 * PURE: the one line the pre-closing reminder leads with. Kept here rather than in
 * the cron so the headline and the posture cannot drift apart.
 */
export function hazardReminderHeadline(status: HazardInsuranceStatus): string {
  const d = status.daysToClose
  const when = d == null ? "before closing" : `${d} day${d === 1 ? "" : "s"} to close`
  switch (status.posture) {
    case "none":
      return `No homeowner's insurance on file — ${when}`
    case "quote_requested":
      return `Homeowner's insurance quoted but not bound — ${when}`
    case "quote_approved":
      return `Insurance quote approved but policy not bound — ${when}`
    case "lapsed":
      return `Homeowner's policy has lapsed — ${when}`
    case "expiry_unknown":
      return `Homeowner's policy on file with no readable expiry — ${when}`
    case "expiring":
      return status.expiresBeforeClosing
        ? `Homeowner's policy expires on or before the close date — ${when}`
        : status.missingEvidenceDocument
          ? `Homeowner's policy bound but no binder on file — ${when}`
          : `Homeowner's policy expiring — ${when}`
    case "bound":
      // Only ever a REMINDER headline when the evidence document is missing;
      // a fully evidenced bound policy never reaches the detector.
      return status.missingEvidenceDocument
        ? `Homeowner's policy bound but no binder on file — ${when}`
        : `Homeowner's insurance bound — ${when}`
  }
}
