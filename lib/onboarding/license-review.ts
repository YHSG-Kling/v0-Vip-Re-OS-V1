// lib/onboarding/license-review.ts
//
// PURE helpers for the manual license-review queue — the human end of the License Verifier's
// escalation. Kept free of "use server" / DB so both the server action and the simulator share the
// exact same decision logic (what the admin sees == what the action does).

/**
 * A license needs a human decision when it was actually submitted (has a number) but the
 * auto-verifier couldn't clear it — status sits at "pending" or "failed". "verified" / "unverified"
 * (never attempted) are NOT in the review queue.
 */
export function licenseNeedsManualReview(
  verificationStatus: string | null | undefined,
  hasLicenseNumber: boolean,
): boolean {
  return hasLicenseNumber && (verificationStatus === "pending" || verificationStatus === "failed")
}

export interface ManualReviewOutcome {
  /** canonical agent_licenses.verification_status (CHECK: unverified|pending|verified|failed). */
  verificationStatus: "verified" | "failed"
  /** canonical license_verifications.verification_result. */
  verificationResult: "passed" | "failed"
  verified: boolean
}

/** Map an admin's approve/reject decision to the canonical status + audit result. PURE. */
export function manualReviewOutcome(decision: "approve" | "reject"): ManualReviewOutcome {
  const passed = decision === "approve"
  return {
    verificationStatus: passed ? "verified" : "failed",
    verificationResult: passed ? "passed" : "failed",
    verified: passed,
  }
}
