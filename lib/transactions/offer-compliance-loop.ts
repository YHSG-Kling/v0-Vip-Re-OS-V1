/**
 * lib/transactions/offer-compliance-loop.ts
 *
 * THE OFFER SIDE OF THE COMPLIANCE LOOP — fully executed offer → gate → transaction.
 *
 * Owner's ruling, verbatim (2026-09-06):
 *
 *   "make sure this compliance gate is autonomously also looped for offers
 *    turning into active transactions after pass and if fail, same as the
 *    listing autonomous loop."
 *
 * …on top of the 2026-09-04 ruling the gate itself rests on: "compliance is
 * involved when an offer gates to create a transaction ONCE THE OFFER IS FULLY
 * EXECUTED BY BOTH BUYER AND SELLER … then the executed offer becomes a
 * transaction, whether we represent the seller, or/and the buyer."
 *
 *      fully executed offer  (both signed, contract on file)  — the loop STARTS
 *                │
 *                ▼
 *      submitOfferToCompliance  (the ONE gate: brokerage checklist audit +
 *                │               packet signature/initial scan + createTransactionFromOffer)
 *        ┌───────┴────────┐
 *      FAIL              PASS
 *        │                │
 *   name what is       transaction row exists, stage UNDER_CONTRACT,
 *   missing to tc +    milestones seeded (the gate does all of this itself)
 *   compliance officer
 *   + both agents
 *        │
 *   they upload  →  scanUploadedDocument (doc.metadata.linked_offer_id)  →  RE-ENTER HERE ─┘
 *
 * ── WHAT EXISTED, AND WHY THIS IS A WIRE RATHER THAN A SECOND GATE (§1, §6) ──
 *
 *   · the gate + pass arm: app/actions/buyer-offer/submit-to-compliance.ts is
 *     the comprehensive chokepoint and already CREATES the transaction on a pass;
 *   · the execute predicate: lib/transactions/offer-execution-state.ts is the one
 *     definition of "fully executed by both";
 *   · the fail-arm audience: notifyComplianceFlag fans to tc + compliance_officer
 *     + the offer agent + the listing agent (submit-to-compliance resolves both);
 *   · the autonomous driver: lib/transactions/auto-execute-offer.ts joins the
 *     predicate to the gate and posts the Deal Coordinator bus signal.
 *   What was missing was the LOOP around them: only record-seller-response called
 *   the driver. The two e-sign webhooks stamped an offer fully_signed and stopped;
 *   a remediation upload linked to an offer never re-ran the gate; and the fail arm
 *   paged the audience on EVERY run with no memory of what it had already said.
 *
 * So this module spells no predicate and no gate. It is the re-entrant turn:
 * decide whether the offer is inside the window (executed, not yet converted),
 * call the ONE driver, and record the verdict on offers.metadata.compliance_gate
 * so the surfaces a human opens show the live state. The dedupe of the fail-arm
 * page lives INSIDE submitOfferToCompliance's block arm — that is the one place
 * every caller (this loop, the manual button, the assistant tool) passes through,
 * and putting it there is what makes the manual click idempotent too.
 *
 * ── FAIL CLOSED, UNKNOWN IS NOT FAILURE (§3, §4) ─────────────────────────────
 *
 * A refused offer read is `unknown`, not "no offer". The driver never throws
 * into a webhook, and an offer outside the window is left exactly where it is.
 * The loop NEVER regresses an offer and never touches a transaction that exists.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { shouldAutoExecuteOffer } from "./offer-execution-state"

type OfferComplianceTrigger =
  | "agreement_executed"   // both sides signed — the loop's first run
  | "document_uploaded"    // a remediation upload linked to the offer — the re-entry

type OfferComplianceOutcome =
  | "advanced"        // gate passed; the transaction exists and is under contract
  | "blocked"         // gate refused; blockers recorded on the offer, audience told if the set changed
  | "outside_window"  // not fully executed by both, or already converted; untouched
  | "unknown"         // the offer could not be read, or the driver could not run; nothing claimed

interface OfferComplianceLoopResult {
  outcome:       OfferComplianceOutcome
  transactionId: string | null
  reason:        string | null
}

/**
 * Run one turn of the offer loop. Safe to call from any trigger, as often as
 * uploads arrive; it decides for itself whether anything should happen.
 */
export async function runOfferComplianceLoop(
  supabase: SupabaseClient,
  params: {
    brokerageId: string
    offerId:     string
    trigger:     OfferComplianceTrigger
    /** users.id of the human who caused this run, or null for an autonomous one. */
    actorUserId?: string | null
  },
): Promise<OfferComplianceLoopResult> {
  const { brokerageId, offerId, trigger } = params

  // ── 1 · The offer, inside the tenant. A refused read is UNKNOWN, not "no offer". ──
  const { data: row, error: rowErr } = await supabase
    .from("offers")
    .select("id, transaction_id, buyer_signed_at, seller_response_type, seller_signed_at, fully_signed_contract_received_at, metadata")
    .eq("id", offerId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (rowErr) {
    console.error(`[offer-compliance-loop] offer ${offerId} could not be read (${rowErr.message}); nothing changed`)
    return { outcome: "unknown", transactionId: null, reason: `offer read refused: ${rowErr.message}` }
  }
  if (!row) return { outcome: "unknown", transactionId: null, reason: "no such offer in this brokerage" }

  const o = row as {
    transaction_id: string | null; buyer_signed_at: string | null; seller_response_type: string | null
    seller_signed_at: string | null; fully_signed_contract_received_at: string | null
    metadata: Record<string, unknown> | null
  }

  // ── 2 · The window: executed by both, not yet a transaction. The predicate is imported, not re-spelled. ──
  if (o.transaction_id) {
    return { outcome: "outside_window", transactionId: o.transaction_id, reason: "already converted to a transaction" }
  }
  if (!shouldAutoExecuteOffer(o)) {
    return { outcome: "outside_window", transactionId: null, reason: "offer is not fully executed by both buyer and seller" }
  }

  // ── 3 · THE driver → THE gate. Dynamic import: it reaches `server-only` modules the tsx guards cannot load. ──
  let attempted = false, created = false, transactionId: string | undefined, reason: string | undefined
  try {
    const { autoExecuteFullySignedOffer } = await import("./auto-execute-offer")
    const r = await autoExecuteFullySignedOffer(offerId, supabase as any)
    attempted = r.attempted; created = r.created; transactionId = r.transactionId; reason = r.reason
  } catch (err) {
    reason = (err as Error).message
  }

  if (!attempted && !created) {
    // The driver declined before running the gate (no attributable agent, or the
    // predicate disagreed with ours on a fresh read). Say so; claim nothing.
    console.error(`[offer-compliance-loop] offer ${offerId}: the gate could NOT run (${reason ?? "no reason"}). This is not "compliance failed"`)
    await writeGateState(supabase, offerId, brokerageId, o.metadata ?? {}, { state: "unknown", checked_at: new Date().toISOString(), trigger, reason: reason ?? null })
    return { outcome: "unknown", transactionId: null, reason: reason ?? null }
  }

  // ── 4 · Record the verdict. The block arm inside submitOfferToCompliance already
  //        wrote the blockers + their hash; re-read so that write is merged, not clobbered. ──
  const { data: fresh } = await supabase.from("offers").select("metadata").eq("id", offerId).eq("brokerage_id", brokerageId).maybeSingle()
  const meta = ((fresh as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? o.metadata ?? {}) as Record<string, unknown>
  const prior = (meta.compliance_gate ?? {}) as Record<string, unknown>

  if (created) {
    await writeGateState(supabase, offerId, brokerageId, meta, {
      ...prior, state: "passed", blockers: [], checked_at: new Date().toISOString(), trigger, transaction_id: transactionId ?? null,
    })
    return { outcome: "advanced", transactionId: transactionId ?? null, reason: null }
  }

  await writeGateState(supabase, offerId, brokerageId, meta, {
    ...prior, state: "blocked", checked_at: new Date().toISOString(), trigger, reason: reason ?? null,
  })
  return { outcome: "blocked", transactionId: null, reason: reason ?? null }
}

async function writeGateState(
  supabase: SupabaseClient,
  offerId: string,
  brokerageId: string,
  meta: Record<string, unknown>,
  gateState: Record<string, unknown>,
): Promise<void> {
  // An UPDATE matching nothing also resolves (§3) — the tenant filter is on the write,
  // and the returned rows are counted so a refused or unmatched write is not silence.
  const { data, error } = await supabase
    .from("offers")
    .update({ metadata: { ...meta, compliance_gate: gateState }, updated_at: new Date().toISOString() })
    .eq("id", offerId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (error) console.error(`[offer-compliance-loop] gate state for offer ${offerId} not recorded: ${error.message}`)
  else if (!data || data.length === 0) console.error(`[offer-compliance-loop] gate state for offer ${offerId} matched no row (wrong tenant?)`)
}
