// lib/property-alerts/first-look-consent.ts
// PURE consent gate for the agent "first-look text" (immediate SMS preview of a
// listing to a buyer). sendFirstLookText is a `gated-inline` egress sender
// (egress-send-guard allowlist) — this is the inline gate, extracted so the
// consent decision is unit-testable and identical between the action and tests.

export interface FirstLookContact {
  phone?: string | null
  dnc_status?: boolean | string | null
  sms_opt_out?: boolean | null
}

export type FirstLookBlock = "no_phone_on_file" | "consent_blocked" | null

/**
 * Returns a block reason, or null if the SMS may proceed. Order matters:
 * a missing phone is reported before consent so the agent gets the actionable error.
 * `dnc_status` is treated as blocking when truthy (boolean true or any non-empty
 * status string other than an explicit clear value).
 */
export function firstLookConsentBlock(contact: FirstLookContact): FirstLookBlock {
  if (!contact.phone) return "no_phone_on_file"
  if (isDnc(contact.dnc_status) || contact.sms_opt_out === true) return "consent_blocked"
  return null
}

function isDnc(status: boolean | string | null | undefined): boolean {
  if (status === true) return true
  if (typeof status === "string") {
    const s = status.trim().toLowerCase()
    return s !== "" && s !== "clear" && s !== "none" && s !== "false" && s !== "ok"
  }
  return false
}
