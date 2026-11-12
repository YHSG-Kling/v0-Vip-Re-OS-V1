// lib/referrals/referral-reciprocity.ts
//
// REFERRAL-RECIPROCITY TRACKER — the pure engine.
//
// THE GAP (verified white space, with an honesty constraint): the agent's referral
// relationships are a two-way street, but the stack only tracked ONE way. Inbound referrals
// a partner SENT the agent are counted (referral_partners.total_referrals_received); outbound
// referrals/business the agent sends TO a partner lived in a separate identity space
// (vendor_bookings keyed by vendors.id) with no link back to referral_partners. So a partner
// who's sent the agent 5 clients while getting nothing back went unnoticed — and the agent
// looked ungrateful to their best referrers.
//
// THE HONESTY CONSTRAINT (why this wasn't trivial): without the vendor link (m1103), outbound
// is UNKNOWN, not zero. Claiming "you've sent them 0" when we simply don't track it is
// fabrication. So this engine NEVER asserts a one-sided relationship from absent data: a
// partner with no measurable outbound is `outbound_untracked` (suggest linking), never
// `one_sided_inbound`. Only a LINKED partner (outbound is a real count from vendor_bookings)
// can be flagged as one-sided.
//
// PURE (no I/O): given each partner's received + (nullable) sent counts, classify the
// balance and surface the relationships worth acting on. The runner does the I/O.

export type ReciprocityStatus =
  | "balanced"
  | "one_sided_inbound" // they send us business, we don't reciprocate (the relationship to protect)
  | "one_sided_outbound" // we feed them, they never reciprocate (worth a direct ask)
  | "outbound_untracked" // a valued inbound partner whose outbound we can't measure (link them)
  | "insufficient" // not enough signal either way

export interface PartnerReciprocityInput {
  partnerId: string
  partnerName: string | null
  partnerType: string | null
  /** referrals the partner SENT the agent (reliable: referral_partners.total_referrals_received) */
  received: number
  /** referrals/business the agent sent the partner — null when UNTRACKED (no vendor link) */
  sent: number | null
}

export interface PartnerReciprocity {
  partnerId: string
  partnerName: string | null
  partnerType: string | null
  received: number
  sent: number | null
  status: ReciprocityStatus
  /** received − (sent ?? 0); null when outbound untracked */
  imbalance: number | null
  /** worth a gated nurture/ask (one-sided, measurable) */
  flagged: boolean
  message: string
}

// A relationship has to clear this many referrals on the strong side before we call it
// one-sided (one stray referral isn't a pattern).
export const MIN_RECEIVED = 2
const MIN_SENT = 2

function name(p: PartnerReciprocityInput): string {
  return p.partnerName ?? "this partner"
}

/** Classify one partner's reciprocity. Pure, honest on untracked outbound. */
export function classifyReciprocity(p: PartnerReciprocityInput): PartnerReciprocity {
  const base = { partnerId: p.partnerId, partnerName: p.partnerName, partnerType: p.partnerType, received: p.received, sent: p.sent }

  // Outbound UNKNOWN — we can measure what they gave us, not what we gave them.
  if (p.sent === null) {
    if (p.received >= MIN_RECEIVED) {
      return {
        ...base, status: "outbound_untracked", imbalance: null, flagged: false,
        message: `${name(p)} has sent you ${p.received} referral${p.received === 1 ? "" : "s"}. Link them to a vendor record to track whether you're reciprocating — right now their outbound side isn't measured.`,
      }
    }
    return { ...base, status: "insufficient", imbalance: null, flagged: false, message: `Not enough referral history with ${name(p)} yet.` }
  }

  const imbalance = p.received - p.sent

  if (p.received >= MIN_RECEIVED && p.sent === 0) {
    return {
      ...base, status: "one_sided_inbound", imbalance, flagged: true,
      message: `${name(p)} has sent you ${p.received} referral${p.received === 1 ? "" : "s"} and you've sent them 0. Reciprocate or thank them — this is a relationship worth protecting.`,
    }
  }
  if (p.sent >= MIN_SENT && p.received === 0) {
    return {
      ...base, status: "one_sided_outbound", imbalance, flagged: true,
      message: `You've sent ${name(p)} ${p.sent} referral${p.sent === 1 ? "" : "s"} and received 0 back. Worth a direct conversation about two-way referrals.`,
    }
  }
  if (p.received < MIN_RECEIVED && p.sent < MIN_SENT) {
    return { ...base, status: "insufficient", imbalance, flagged: false, message: `Not enough referral history with ${name(p)} yet.` }
  }
  return { ...base, status: "balanced", imbalance, flagged: false, message: `Your referral relationship with ${name(p)} is roughly balanced (${p.received} in / ${p.sent} out).` }
}

export interface ReciprocityReport {
  partners: PartnerReciprocity[]
  /** the one-sided relationships worth acting on, most imbalanced first */
  flagged: PartnerReciprocity[]
  /** valued inbound partners we can't measure reciprocation for (suggest linking) */
  untracked: PartnerReciprocity[]
}

/** Classify a whole book of partners and surface what's actionable. Pure. */
export function buildReciprocityReport(inputs: PartnerReciprocityInput[]): ReciprocityReport {
  const partners = inputs.map(classifyReciprocity)
  const flagged = partners
    .filter((p) => p.flagged)
    .sort((a, b) => Math.abs(b.imbalance ?? 0) - Math.abs(a.imbalance ?? 0))
  const untracked = partners.filter((p) => p.status === "outbound_untracked")
  return { partners, flagged, untracked }
}

/** Normalize a name for high-confidence exact matching (partner ↔ vendor bootstrap link). */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}
