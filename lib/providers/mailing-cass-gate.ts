// lib/providers/mailing-cass-gate.ts
//
// MAILING-ADDRESS CASS GATE — makes leads.mailing_address_verified HONEST at the direct-mail
// chokepoint. The flag is set true at promotion merely because an address STRING exists
// ("canonical eligibility just confirmed it" in lead-promoter / pipeline-processor) or falls back to
// hasMailingData in enrichment — it is NEVER CASS/USPS-verified. But dispatchDirectMail (and every
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
