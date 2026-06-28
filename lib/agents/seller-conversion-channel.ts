// lib/agents/seller-conversion-channel.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE channel selection for the SELLER-CONVERSION nurture — the seller-side mirror of the buyer
// LEAD first-touch policy (lib/ai-isa/speed-to-lead-policy.ts). An un-converted seller lead (asked
// "what's my home worth?" / declared seller, no listing yet) is NOT a portal user — they have no
// reason to ever log into a client portal — so dropping a portal card on them is a dead drop, not a
// touch. This picks the rail the lead is actually reachable on, exactly like the buyer cold-lead
// nurture: EMAIL when we can email them (CAN-SPAM clean), DIRECT MAIL as the fallback when there's no
// usable email but a verified mailing address AND the brokerage has a hand-tuned seller preset, else
// an honest SKIP. No I/O — unit-testable; the runner feeds it the live consent/reachability facts.

import { canDispatchToContact, type ContactConsentState } from "@/lib/compliance/contact-channel-gate"

export type SellerNurtureChannel = "email" | "direct_mail"

export interface SellerChannelInput {
  /** Contact has a non-empty email on file. */
  hasEmail: boolean
  /** Email consent columns (opt-out / unsubscribe / opt_out_channels). */
  consent: ContactConsentState
  /** A verified, deliverable mailing address resolved for this contact. */
  hasMailableAddress: boolean
  /** Contact opted out of physical mail. */
  directMailOptOut: boolean | null
  /** The brokerage has an ACTIVE direct-mail preset suitable for a seller-value nudge.
   *  Direct mail uses locked, compliance-gated preset copy — never free text — so without a
   *  configured preset we simply don't offer the mail rail (no stub, no off-message piece). */
  hasSellerDirectMailPreset: boolean
}

export interface SellerChannelDecision {
  channel: SellerNurtureChannel | null
  reason: string
}

/**
 * PURE. Pick the best REACHABLE rail for a seller-conversion nurture, mirroring the buyer lead
 * first-touch cascade: EMAIL when emailable → DIRECT MAIL when mailable + a seller preset exists →
 * SKIP. Never returns "portal": an un-converted seller lead has no portal surface, so a portal card
 * would never be seen. An honest skip beats spamming a dead surface.
 */
export function selectSellerNurtureChannel(input: SellerChannelInput): SellerChannelDecision {
  if (input.hasEmail) {
    const gate = canDispatchToContact(input.consent, "email")
    if (gate.allowed) return { channel: "email", reason: "email_reachable" }
    // Emailable address exists but the lead opted out of email — try the mail rail instead.
    return decideMail(input, `email_blocked:${gate.reason ?? "opted_out"}`)
  }
  return decideMail(input, "no_email")
}

function decideMail(input: SellerChannelInput, why: string): SellerChannelDecision {
  if (input.hasMailableAddress && !input.directMailOptOut && input.hasSellerDirectMailPreset) {
    return { channel: "direct_mail", reason: `direct_mail_fallback (${why})` }
  }
  return { channel: null, reason: `skip_no_reachable_channel (${why})` }
}

/**
 * PURE. Does a direct-mail preset name read as a seller-value / "what's your home worth" piece?
 * Conservative on purpose — we only mail a seller-conversion nudge through a preset that is clearly
 * on-message (so we never fire a "Just Sold" postcard at a homeowner deciding whether to list).
 */
export function isSellerConversionPreset(name: string | null | undefined): boolean {
  const n = (name ?? "").toLowerCase()
  if (!n.trim()) return false
  return /home\s*value|what'?s?\s+your\s+home|thinking\s+of\s+selling|sell(er|ing)?\b|home\s*worth|equity|list(ing)?\s+consult|market\s+analysis|cma\b/.test(n)
}
