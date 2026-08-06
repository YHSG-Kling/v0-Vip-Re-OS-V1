/**
 * lib/vendors/insurance-posture.ts
 *
 * CLIENT-SAFE. The pure half of vendor insurance: the credential shape, the
 * reminder windows, and the calculator that turns a stored certificate into a
 * posture a human can act on. No I/O, no supabase client, no server-only
 * import — so a "use client" component may import this directly.
 *
 * WHY IT LIVES HERE AND NOT IN THE KERNEL. Both vendor surfaces
 * (vendor-directory-client, vendor-approvals/approval-client) need to render
 * this posture, and they pulled it from lib/kernel/vendor-doc-compliance.ts —
 * which reaches `server-only` transitively:
 *
 *     vendor-doc-compliance → agents/agent-client-messages
 *                           → direct-mail/orchestrate-preset-send  (server-only)
 *
 * tsc cannot see that, so it only surfaced in the client-server-only guard: it
 * would have broken `next build` and put service-role logic in a browser
 * bundle. The fix is not a dynamic import — it is to put the pure logic where
 * both sides may legitimately reach it. The KERNEL now imports FROM here, so
 * there is still exactly one definition of the vocabulary and the calculator.
 */

// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE: whole days from `now` until `expiry`. NULL when there is no expiry or
 * the value cannot be parsed — the callers treat NULL as "we do not know",
 * never as "fine", so an unreadable date can never read as compliant.
 */
export function daysUntil(expiry: string | null | undefined, now: Date): number | null {
  if (!expiry) return null
  const t = Date.parse(expiry)
  if (Number.isNaN(t)) return null
  return Math.floor((t - now.getTime()) / 86_400_000)
}

/** How a vendor's liability coverage reads to a human RIGHT NOW. */
export type InsurancePosture = "verified" | "expiring" | "expired" | "no_expiry" | "never"

/** One certificate of insurance as stored under compliance_credentials.insurance (m376 shape). */
export interface InsuranceRecord {
  carrier?: string | null
  policy_number?: string | null
  coverage_amount?: number | null
  effective_date?: string | null
  expiry?: string | null
  url?: string | null
  verified_at?: string | null
  verified_by?: string | null
}

export interface InsuranceStatus {
  posture: InsurancePosture
  /** Short badge text. */
  label: string
  /** One line a broker can act on — always states the DATE it is derived from. */
  detail: string
  expiry: string | null
  daysOut: number | null
  carrier: string | null
  policyNumber: string | null
  coverageAmount: number | null
  effectiveDate: string | null
  certificateUrl: string | null
  /** When a human last confirmed the certificate. NULL means nobody ever did. */
  verifiedAt: string | null
  /** users.id of that human (NOT agents.id / contacts.id). NULL when never confirmed. */
  verifiedBy: string | null
}

/** Days-out at or under which a certificate counts as "expiring soon" — the widest reminder window. */
/** Reminder windows, in days out, for an expiring credential. Lives here (not
 *  in the kernel) so this module stays free of server-only imports; the kernel
 *  re-exports it, keeping ONE definition. */
export const REMINDER_WINDOWS = [60, 30, 7] as const

export const INSURANCE_EXPIRING_DAYS = Math.max(...REMINDER_WINDOWS)

/**
 * PURE: read a vendor's insurance posture off the stored credential bag.
 *
 * COMPUTED, NEVER ASSERTED — every posture except "never" comes from parsing the
 * stored `expiry` against `now`. There is no field anywhere that says "this
 * vendor is compliant"; if there were, it could be set to true by someone who
 * never looked at a certificate. An unparseable or absent expiry yields
 * "no_expiry", NOT "verified" and NOT "expired": we genuinely do not know, and
 * saying either would be a fabricated verdict.
 */
export function readVendorInsurance(
  credentials: Record<string, InsuranceRecord | null | undefined> | null | undefined,
  now: Date,
): InsuranceStatus {
  const rec = (credentials && typeof credentials === "object" ? credentials.insurance : null) ?? null
  const base: InsuranceStatus = {
    posture: "never",
    label: "No insurance on file",
    detail: "No certificate of insurance has ever been recorded for this vendor.",
    expiry: null, daysOut: null, carrier: null, policyNumber: null, coverageAmount: null,
    effectiveDate: null, certificateUrl: null, verifiedAt: null, verifiedBy: null,
  }
  if (!rec || typeof rec !== "object") return base

  const filled: InsuranceStatus = {
    ...base,
    carrier: rec.carrier ?? null,
    policyNumber: rec.policy_number ?? null,
    coverageAmount: typeof rec.coverage_amount === "number" ? rec.coverage_amount : null,
    effectiveDate: rec.effective_date ?? null,
    certificateUrl: rec.url ?? null,
    verifiedAt: rec.verified_at ?? null,
    verifiedBy: rec.verified_by ?? null,
    expiry: rec.expiry ?? null,
  }

  const daysOut = daysUntil(rec.expiry, now)
  if (daysOut == null) {
    return {
      ...filled,
      posture: "no_expiry",
      label: "Expiry unknown",
      detail: "A certificate is on file but carries no readable expiry date — coverage cannot be confirmed either way.",
    }
  }

  // Confirmation provenance rides in the detail line rather than in the posture:
  // the posture must state what the DATE says, and who typed it is a separate
  // fact. Conflating them would let "an admin clicked save" read as "coverage
  // is current".
  const confirmed = filled.verifiedAt
    ? `Confirmed ${String(filled.verifiedAt).slice(0, 10)}.`
    : "Never confirmed by a person."

  if (daysOut < 0) {
    return {
      ...filled, daysOut, posture: "expired",
      label: `Insurance expired ${Math.abs(daysOut)}d ago`,
      detail: `Coverage lapsed on ${rec.expiry}. Do not refer this vendor until a renewed certificate is recorded. ${confirmed}`,
    }
  }
  if (daysOut <= INSURANCE_EXPIRING_DAYS) {
    return {
      ...filled, daysOut, posture: "expiring",
      label: `Expires in ${daysOut}d`,
      detail: `Coverage lapses on ${rec.expiry}. Ask the vendor for a renewed certificate now. ${confirmed}`,
    }
  }
  return {
    ...filled, daysOut, posture: "verified",
    label: "Insured",
    detail: `Coverage runs to ${rec.expiry} (${daysOut} days out). ${confirmed}`,
  }
}