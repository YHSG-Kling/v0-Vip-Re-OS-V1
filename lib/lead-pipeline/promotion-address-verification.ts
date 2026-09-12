// lib/lead-pipeline/promotion-address-verification.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE WRITER BEHIND THE CONVERSION GATE'S "VERIFIED MAILING ADDRESS" ARM.
//
// The owner's wave-14 conversion ruling admits a mailing address as a reachable
// channel only when it is VERIFIED. That word makes `mailing_address_verified`
// load-bearing at promotion — and the flag, as written, could not carry the load:
//
//   · lib/lead-pipeline/enrichment-orchestrator.ts fell back to
//     `mailingVerified = hasMailingData` — i.e. "we found an address string"
//     was recorded as "the address is verified".
//   · lib/providers/mailing-cass-gate.ts was written for exactly this: it says,
//     in its own header, that the flag "is set true at promotion merely because
//     an address STRING exists … it is NEVER CASS/USPS-verified", and it
//     CASS-verifies late, at the direct-mail dispatch chokepoint, to stop the app
//     paying Lob for undeliverable pieces.
//
// So the column had writers, but not an HONEST one anywhere near the gate. A gate
// keyed on a flag that means "an address string exists" is the same gate the
// ruling replaced, wearing a new word. This module is the honest writer, placed
// at the gate.
//
// ── WHAT IT DOES, AND WHAT IT COSTS ──────────────────────────────────────────
// ONE Lob US-verification (~$0.0025, free in test mode) for a record that:
//   · has NO email and NO phone — the address is its ONLY possible anchor, so
//     without this call the record is refused outright; and
//   · has an address STRING that is not yet verified; and
//   · has not already been ruled on by Lob (`mailing_address_source='lob_cass'`),
//     so a known-undeliverable address is never re-bought.
// A record already reachable by email or phone is promoted without spending a
// cent here — the address arm never needs to be consulted.
//
// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
// mailing-cass-gate's `interpretLobForGate` DEFERS on a null Lob result (no
// LOB_API_KEY, timeout, 5xx) — correct there, because deferring means "don't
// block a send on a flaky verify". Here the same null means the opposite thing:
// nobody checked, so nothing is verified, so the gate refuses and the record
// stays raw and retryable. Never a fabricated `true`. That is why this file
// adapts the shared interpretation rather than re-implementing it: one Lob
// vocabulary, two dispositions for the one ambiguous case, both stated out loud.
//
// Reuses lib/external/lob-address-verify.ts (the Lob adapter),
// lib/providers/mailing-cass-gate.ts (CASS_SOURCE + the patch shape). No second
// verification lane was built.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { LobVerificationResult } from "@/lib/external/lob-address-verify"
import { CASS_SOURCE, interpretLobForGate } from "@/lib/providers/mailing-cass-gate"
import { hasUnverifiedMailingAddress } from "@/lib/lead-pipeline/canonical-lead-eligibility"

export interface PromotionAddressCandidate {
  email?:                    string | null
  phone?:                    string | null
  mailing_address?:          string | null
  mailing_city?:             string | null
  mailing_state?:            string | null
  mailing_zip?:              string | null
  mailing_address_verified?: boolean | null
  mailing_address_source?:   string | null
}

/**
 * PURE — is a Lob verification worth buying for this record at the gate?
 *
 * Only when the address is the record's ONLY possible anchor (no email, no
 * phone), the address exists but is unverified, and Lob has not already ruled on
 * it. Anything else is a refusal or a promotion that needs no spend.
 */
export function needsPromotionAddressVerification(c: PromotionAddressCandidate): boolean {
  if ((c.email ?? "").trim()) return false
  if ((c.phone ?? "").trim()) return false
  if (!hasUnverifiedMailingAddress(c)) return false
  // Already Lob-ruled. verified===true would have been caught above; reaching
  // here with the marker set means Lob said UNDELIVERABLE. Do not re-buy it.
  if (c.mailing_address_source === CASS_SOURCE) return false
  return true
}

export interface PromotionAddressVerdict {
  /** The gate's answer: may this address be counted as a verified anchor? */
  verified: boolean
  /** Columns to persist (mailing_address_verified, mailing_address_source, and
   *  Lob's standardized parts when deliverable). EMPTY when nothing was learned. */
  patch: Record<string, unknown>
  reason: string
}

/**
 * PURE — Lob's answer → the gate's answer.
 *
 * Deliberately narrower than `interpretLobForGate`'s three-way action: at a
 * SEND, "we could not check" means proceed on the existing flag; at the
 * CONVERSION GATE it means refuse. Everything else — the deliverable patch, the
 * standardized address write-back, the CASS_SOURCE marker — is the shared
 * interpretation, not a second opinion.
 */
export function interpretLobForPromotion(lob: LobVerificationResult | null): PromotionAddressVerdict {
  const decision = interpretLobForGate(lob)
  if (decision.action === "defer") {
    // Nobody checked. Nothing is written, nothing is claimed, the record stays
    // raw and is retried on a later sweep.
    return { verified: false, patch: {}, reason: decision.reason }
  }
  return {
    verified: decision.action === "proceed",
    patch:    decision.patch,
    reason:   decision.reason,
  }
}

/**
 * Verify the candidate's mailing address with Lob and PERSIST the verdict onto
 * the given row, so the next pass (and every downstream direct-mail decision)
 * reads a flag that means what it says.
 *
 * NEVER THROWS — a verification failure must refuse the promotion, not break the
 * pipeline. Returns `{ verified: false, ran: false }` when no call was warranted
 * or possible.
 */
export async function verifyMailingAddressForPromotion(params: {
  candidate: PromotionAddressCandidate
  supabase:  SupabaseClient<any, any, any>
  /** Which row carries the verdict: the raw record, or the promoted lead. */
  table:     "raw_scraped_leads" | "leads"
  id:        string
}): Promise<PromotionAddressVerdict & { ran: boolean; cost: number }> {
  const { candidate, supabase, table, id } = params

  if (!needsPromotionAddressVerification(candidate)) {
    return { verified: false, patch: {}, reason: "not_warranted", ran: false, cost: 0 }
  }

  try {
    const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
    const { data, cost } = await verifyAddressViaLob({
      primary_line: (candidate.mailing_address ?? "").trim(),
      city:         candidate.mailing_city  ?? undefined,
      state:        candidate.mailing_state ?? undefined,
      zip_code:     candidate.mailing_zip   ?? undefined,
    })

    const verdict = interpretLobForPromotion(data)

    // Nothing learned (no key / transient) → write NOTHING. A synthetic `false`
    // here would look like an authoritative Lob refusal on the next pass and
    // would poison the retry via the CASS_SOURCE marker.
    if (Object.keys(verdict.patch).length > 0) {
      const { error } = await supabase
        .from(table)
        .update({ ...verdict.patch, updated_at: new Date().toISOString() })
        .eq("id", id)
      // supabase-js RESOLVES refusals — a swallowed error here would mean the
      // gate promoted on a verdict that never landed.
      if (error) {
        console.error(`[promotion-address-verification] ${table} ${id} patch refused:`, error.message)
        return { verified: false, patch: {}, reason: `persist_failed:${error.message}`, ran: true, cost }
      }
    }

    return { ...verdict, ran: true, cost }
  } catch (err) {
    console.error("[promotion-address-verification] verify failed:", err)
    return { verified: false, patch: {}, reason: "verify_threw", ran: false, cost: 0 }
  }
}
