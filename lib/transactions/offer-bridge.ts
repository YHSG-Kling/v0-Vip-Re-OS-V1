import {
  CONTRACT_TERM_COLUMNS,
  copyContractTerms,
} from "./contract-terms"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureRequiredMilestones, seedJourneyMilestones } from "./milestone-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { populateInitialParticipants } from "./participant-populator"
import { deriveEarnestDueDate, addDaysToDateString, isCalendarDate } from "./earnest-terms"

/**
 * PURE. Derive the three standard contingency DEADLINE DATES that the
 * transaction row carries as first-class columns (inspection_deadline,
 * appraisal_deadline, financing_deadline) plus the closing date.
 *
 * Precedence, per term:
 *   1. contract_date + the offer's contingency-DAY column — TZ-safe UTC day math
 *      off the EXECUTION date, which is what the contract actually says
 *      ("inspection within 10 days of execution").
 *   2. the caller-supplied term, but ONLY when it is a real calendar date.
 *
 * WHY THE ORDER: every caller (submit-to-compliance, seller-offers, the kernel
 * converter) computed these as `Date.now() + days`, i.e. days from the moment
 * the button was clicked. On any deal whose contract date is not today — a
 * backdated execution, an inbound offer processed days later — that silently
 * moved every deadline. Deriving here, from the contract date, fixes the class
 * once for all four accept flows instead of in three separate copies.
 */
export function deriveContractDeadlines(input: {
  contractDate:              string | null | undefined
  inspectionPeriodDays?:     number | null
  appraisalContingencyDays?: number | null
  financingContingencyDays?: number | null
  offerClosingDate?:         string | null
  fallback?: {
    inspectionDeadline?: string
    appraisalDeadline?:  string
    financingDeadline?:  string
    closingDate?:        string
  }
}): {
  inspectionDeadline: string | null
  appraisalDeadline:  string | null
  financingDeadline:  string | null
  closingDate:        string | null
} {
  const base = input.contractDate ? String(input.contractDate).slice(0, 10) : null
  const fromDays = (days: number | null | undefined, fallback: string | undefined): string | null => {
    if (base && isCalendarDate(base) && typeof days === "number" && Number.isFinite(days)) {
      return addDaysToDateString(base, days)
    }
    return isCalendarDate(fallback) ? fallback.slice(0, 10) : null
  }
  const closing = isCalendarDate(input.offerClosingDate)
    ? String(input.offerClosingDate).slice(0, 10)
    : isCalendarDate(input.fallback?.closingDate)
      ? input.fallback!.closingDate!.slice(0, 10)
      : null
  return {
    inspectionDeadline: fromDays(input.inspectionPeriodDays,     input.fallback?.inspectionDeadline),
    appraisalDeadline:  fromDays(input.appraisalContingencyDays, input.fallback?.appraisalDeadline),
    financingDeadline:  fromDays(input.financingContingencyDays, input.fallback?.financingDeadline),
    closingDate:        closing,
  }
}

/**
 * The offer columns the bridge reads. Hoisted OUT of the query chain on purpose:
 * scripts/tenant-scope-guard.ts examines the 500 characters that follow a
 * `.from("<table>")` looking for scoping evidence, and a select list long enough
 * to push `.eq("id", …)` past that window would read as an unscoped query.
 */
const OFFER_BRIDGE_COLUMNS = [
  "id", "agent_id", "contact_id", "listing_id", "offer_price", "closing_date",
  "property_address", "earnest_money", "earnest_money_due_at", "earnest_money_due_days",
  "esign_provider", "provider_envelope_id",
  ...CONTRACT_TERM_COLUMNS,
].join(", ")

/**
 * Canonical "is this offer eligible to become a transaction?" gate. Reads SOURCE-OF-TRUTH
 * fields on the offers row — callers can't fabricate compliance / signature state by
 * passing them as params; the gate refuses if the OFFER itself doesn't show them.
 *
 * Enforces, in order:
 *   1. Offer exists in the brokerage (and not orphaned).
 *   2. No prior transaction (no double-create).
 *   3. Buyer has signed (buyer_signed_at IS NOT NULL).
 *   4. Executed contract on file — either:
 *        (a) buyer-first original offer: seller_response_type='accepted' AND
 *            fully_signed_contract_received_at set, OR
 *        (b) seller-first counter: seller_signed_at AND
 *            fully_signed_contract_received_at set
 *   5. Compliance passed (compliance_passed_at IS NOT NULL).
 *
 * Same gate logic as app/actions/buyer-offer/submit-to-compliance.ts — pulled INTO the
 * bridge so every caller (the submit action, the e-sign webhook, the seller-accept path,
 * the kernel-level converter, and any future agentic caller) inherits identical
 * enforcement. Fail-closed: missing fields = refusal, no exceptions for "trust me" callers.
 */
export interface OfferGateRow {
  id:                                string
  brokerage_id:                      string
  transaction_id:                    string | null
  buyer_signed_at:                   string | null
  seller_signed_at:                  string | null
  seller_response_type:              string | null
  fully_signed_contract_received_at: string | null
  compliance_passed_at:              string | null
}

export interface OfferGateResult {
  allowed: boolean
  reason?: string
  offer?:  OfferGateRow
}

export async function assertOfferReadyForTransaction(params: {
  offerId:     string
  brokerageId: string
}): Promise<OfferGateResult> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("offers")
    .select("id, brokerage_id, transaction_id, buyer_signed_at, seller_signed_at, seller_response_type, fully_signed_contract_received_at, compliance_passed_at")
    .eq("id", params.offerId)
    .maybeSingle()
  if (error) return { allowed: false, reason: `offer load failed: ${error.message}` }
  if (!data) return { allowed: false, reason: "offer not found" }
  if (data.brokerage_id !== params.brokerageId) {
    return { allowed: false, reason: "offer brokerage mismatch" }
  }
  const o = data as OfferGateRow
  if (o.transaction_id)  return { allowed: false, reason: "transaction already exists for this offer", offer: o }
  if (!o.buyer_signed_at) return { allowed: false, reason: "buyer has not signed yet", offer: o }
  const executedViaResponse = o.seller_response_type === "accepted" && !!o.fully_signed_contract_received_at
  const executedViaCounter  = !!o.seller_signed_at && !!o.fully_signed_contract_received_at
  if (!executedViaResponse && !executedViaCounter) {
    return { allowed: false, reason: "executed contract not on file (seller_response_type or seller_signed_at + fully_signed_contract_received_at missing)", offer: o }
  }
  if (!o.compliance_passed_at) {
    return { allowed: false, reason: "compliance has not passed on this offer", offer: o }
  }
  return { allowed: true, offer: o }
}

/**
 * Create transaction from accepted offer
 * Enforces: contract_date + compliance_passed_at + signature-completeness gates
 */
export async function createTransactionFromOffer(params: {
  offerId: string
  brokerageId: string
  contractDate: string
  compliancePassedAt: string
  contractTerms: {
    earnestMoneyDue?: string
    inspectionDeadline?: string
    appraisalDeadline?: string
    financingDeadline?: string
    closingDate?: string
  }
  /** Set by callers that ARE the authoritative gate (submitOfferToCompliance — which
   *  did the brokerage-required-docs audit + packet-completeness scan + stamped
   *  compliance_passed_at all in one atomic call). Default false: re-verify the gate
   *  inside the bridge from the offer row's source-of-truth fields. */
  skipOfferGate?: boolean
  /** Which side WE represent — passed by the caller, which knows it (don't assume in-house/buyer):
   *  the seller accepting an offer ON OUR LISTING is 'seller'; the buyer-offer flows (incl. external/IDX
   *  targets) are 'buyer' (default). deal_type drives compliance REQUIRED-DOC seeding, client persona,
   *  and seller-close logic, so a seller deal mislabeled 'buyer' seeds the wrong docs. 'dual' (we hold
   *  both sides of one deal) needs an explicit signal and is left to the caller. */
  dealType?: "buyer" | "seller" | "dual"
}) {
  const supabase = createServiceClient()

  // Validate caller-supplied params first (no compute wasted on bad calls).
  if (!params.contractDate) {
    throw new Error("[offer-bridge] contract_date required to create transaction")
  }
  if (!params.compliancePassedAt) {
    throw new Error("[offer-bridge] compliance_passed_at required to create transaction")
  }

  // Canonical OFFER-side gate — read source-of-truth fields and refuse if buyer/seller
  // signatures, executed contract, or compliance aren't on the offer. Callers can't
  // fabricate this by passing fake params; the gate looks at the OFFER row.
  if (!params.skipOfferGate) {
    const gate = await assertOfferReadyForTransaction({
      offerId:     params.offerId,
      brokerageId: params.brokerageId,
    })
    if (!gate.allowed) {
      throw new Error(`[offer-bridge] Gate refused transaction creation: ${gate.reason}`)
    }
  }
  
  // Get offer details.
  // NOTE: buyer_agents table does NOT exist — use offer.agent_id directly.
  //       offer.buyer_id does NOT exist — live FK is offer.contact_id.
  // Also pull esign_provider + provider_envelope_id so we can stamp the transaction
  // with the canonical external-provider tracking columns (m106). Without this,
  // sync-from-provider can't pull documents for transactions whose provider isn't
  // Dotloop (which is the only one with a dedicated legacy column).
  // The column list is OFFER_BRIDGE_COLUMNS (above) — it carries every contract
  // TERM as well as the identity and date columns.
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select(OFFER_BRIDGE_COLUMNS)
    .eq("id", params.offerId)
    .maybeSingle()

  if (offerError || !offer) {
    throw new Error(`[offer-bridge] Offer not found: ${params.offerId}`)
  }

  // Resolve property address + seller_contact_id from the in-house listing if any. seller_contact_id
  // present == this offer is on OUR listing (the seller side is ours). See deal-type-resolver.ts.
  let resolvedAddress = (offer as any).property_address ?? null
  let sellerContactId: string | null = null
  if ((offer as any).listing_id) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state, seller_contact_id")
      .eq("id", (offer as any).listing_id)
      .maybeSingle()
    if (listing) {
      if (!resolvedAddress) {
        resolvedAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
      }
      sellerContactId = (listing as any).seller_contact_id ?? null
    }
  }

  // Who do WE represent? Ground truth: our-listing (seller side) + whether the BUYER is OUR client (in
  // our buyer pipeline → buyer_stage set; an outside buyer's mail/upload-intake offer has none). 'dual'
  // = our listing + our buyer (covers BOTH two-agent and single-agent dual). Caller dealType overrides.
  // Drives compliance required-doc seeding + persona. Only check the buyer when the listing is ours.
  let ourBuyer = false
  if (sellerContactId && (offer as any).contact_id) {
    const { data: buyerContact } = await supabase
      .from("contacts").select("buyer_stage").eq("id", (offer as any).contact_id).maybeSingle()
    ourBuyer = !!(buyerContact as { buyer_stage?: string | null } | null)?.buyer_stage
  }
  const { resolveDealType } = await import("./deal-type-resolver")
  const dealType = params.dealType ?? resolveDealType({ ourListing: !!sellerContactId, ourBuyer })

  // REPRESENTATION-AWARE client linkage. On a 'seller' deal the buyer is an OUTSIDE
  // party (another brokerage represents them) — offer.contact_id is just the intake
  // record we logged for the paperwork. Stamping them as buyer_contact_id/contact_id
  // made every informing rail (portal cards, sequence auto-enrollment, weekly deal
  // notes — all keyed off transactions.buyer_contact_id/contact_id via
  // resolveEventContacts) treat another agent's client as OUR represented buyer:
  // "your offer was accepted!" cards + drip enrollment to someone we don't represent.
  // The client FK on a seller deal is the SELLER; the outside buyer still appears on
  // the deal via transaction_participants (populated from the offer row below).
  const representsBuyer = dealType !== "seller"
  const clientContactId = representsBuyer
    ? ((offer as any).contact_id ?? null)
    : (sellerContactId ?? (offer as any).contact_id ?? null)

  // Create transaction — use contact_id (not buyer_id) and agent_id (not buyer_agents join)
  // deal_name is NOT NULL on transactions; default to property_address (or
  // a synthetic name from offer id if address is somehow missing) so the
  // chain never fails the insert.
  const dealName = resolvedAddress
    ?? `Transaction ${params.offerId.slice(0, 8)}`

  // CONTRACT DATES AS FIRST-CLASS TRANSACTION COLUMNS. Until now the bridge
  // persisted the closing date and the three contingency deadlines ONLY as
  // milestone target_dates — while transactions.close_date, .inspection_deadline,
  // .appraisal_deadline and .financing_deadline (all live columns) stayed NULL
  // forever on every offer-created deal. Six real readers key off those columns
  // (kernel/fire-drills, kernel/team-query, kernel/client-pulse ×2,
  // managers/deliberation, workflow/intelligence/proactive-checks), so the
  // deal-health, client-pulse and fire-drill rails saw a deal with no dates at
  // all. Derived from the CONTRACT date (not "now") — see deriveContractDeadlines.
  const contractDeadlines = deriveContractDeadlines({
    contractDate:              params.contractDate,
    inspectionPeriodDays:      (offer as any).inspection_period_days      as number | null,
    appraisalContingencyDays:  (offer as any).appraisal_contingency_days  as number | null,
    financingContingencyDays:  (offer as any).financing_contingency_days  as number | null,
    offerClosingDate:          (offer as any).closing_date                as string | null,
    fallback: {
      inspectionDeadline: params.contractTerms.inspectionDeadline,
      appraisalDeadline:  params.contractTerms.appraisalDeadline,
      financingDeadline:  params.contractTerms.financingDeadline,
      closingDate:        params.contractTerms.closingDate,
    },
  })
  // THE CONTRACT TERMS THEMSELVES (m387). Copied 1:1 off the offer — same column
  // names on both sides — and spread FIRST in the payload below so that the
  // explicitly named columns after it always win. A term and a deadline are
  // different facts (see CONTRACT_TERM_COLUMNS) and the two name sets are
  // disjoint, so nothing here can overwrite a date the derivation above produced.
  const contractTerms = copyContractTerms(offer as unknown as Record<string, unknown>)

  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .insert({
      ...contractTerms,
      brokerage_id:         params.brokerageId,
      agent_id:             (offer as any).agent_id,
      contact_id:           clientContactId,             // live FK — OUR client (seller on 'seller' deals)
      buyer_contact_id:     representsBuyer ? (offer as any).contact_id : null,  // only when the buyer is OURS
      seller_contact_id:    sellerContactId,             // resolved from listing → enables seller-side close logic
      listing_id:           (offer as any).listing_id ?? null,
      offer_id:             params.offerId,
      deal_name:            dealName,
      property_address:     resolvedAddress,
      // Schema CHECK: deal_type ∈ {buyer, seller, dual}. Auto-resolved from ground truth (above) so
      // seller-side and DUAL deals are labeled correctly — the old blanket 'buyer' seeded the wrong
      // compliance docs + persona for every non-buyer deal.
      deal_type:            dealType,
      purchase_price:       (offer as any).offer_price,
      // Earnest DEPOSIT AMOUNT (a dollar figure) carried onto the transaction as a first-class term,
      // distinct from the earnest DUE DATE (an EMD milestone, seeded below). Owner correction R28:
      // the amount is currency ("Earnest Deposit: $X"), never a date.
      earnest_money:        (offer as any).earnest_money ?? null,
      contract_date:        params.contractDate,
      // The dates the deal now lives by — persisted ON the transaction, not only
      // as milestones. close_date is the canonical closing date every finance /
      // commission / scorecard reader uses; the three deadlines feed the
      // contingency + deal-health rails.
      close_date:           contractDeadlines.closingDate,
      estimated_close_date: contractDeadlines.closingDate,
      inspection_deadline:  contractDeadlines.inspectionDeadline,
      appraisal_deadline:   contractDeadlines.appraisalDeadline,
      financing_deadline:   contractDeadlines.financingDeadline,
      compliance_passed_at: params.compliancePassedAt,
      stage:                "UNDER_CONTRACT",
      status:               "under_contract",
      // m106 — generic provider tracking inherited from the source offer's envelope so
      // sync-from-provider can pull documents for this transaction regardless of
      // which provider the brokerage uses. Dotloop transactions also keep their
      // legacy dotloop_loop_id via the back-link from ai-offer-creation, but the
      // generic columns are now the single source of truth.
      external_provider_source:         (offer as any).esign_provider       ?? null,
      external_provider_transaction_id: (offer as any).provider_envelope_id ?? null,
      created_at:           new Date().toISOString(),
    })
    .select()
    .single()
  
  if (txnError || !transaction) {
    throw new Error(`[offer-bridge] Failed to create transaction: ${txnError?.message}`)
  }
  
  // Log contract date set event via kernel
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType:  "transaction",
    entityId:    transaction.id,
    fromState:   "offer_accepted",
    toState:     "UNDER_CONTRACT",
    actorUserId: "",
    actorRole:   "tc",
    eventType:   "contract_date.set",
    metadata:    {
      contract_date:       params.contractDate,
      compliance_passed_at: params.compliancePassedAt,
      created_from_offer:  params.offerId,
    },
  })
  
  // Earnest-money due date + title company come from the compliance review gate's contract read:
  // offers.earnest_money_due_at is the scanner-resolved calendar date (contract_date +
  // earnest_money_due_days); the title/escrow company is extracted onto the scanned signed contract
  // (documents.extracted_fields.title_company). These feed both the EMD milestone date and the
  // proactive "under contract" portal card.
  // TZ-safe: derive the calendar due date from the execution (contract) date + "N days from
  // execution" via pure UTC date arithmetic — NOT new Date(timestamptz).toISOString(), which would
  // shift a money-sensitive deadline by a day for non-UTC stored times. Fall back to the stored
  // value's literal date portion, then to any caller-provided term.
  // DUE DATE only — never the amount. deriveEarnestDueDate refuses a non-date fallback (a mis-passed
  // dollar amount like "$5000"), so the earnest DEPOSIT AMOUNT can never leak into the DUE-date slot.
  const earnestDueDate: string | undefined = deriveEarnestDueDate({
    contractDate:        params.contractDate,
    earnestMoneyDueDays: (offer as any).earnest_money_due_days as number | null,
    earnestMoneyDueAt:   (offer as any).earnest_money_due_at as string | null,
    fallbackDue:         params.contractTerms.earnestMoneyDue ?? null,
  })
  let titleCompany: string | null = null
  try {
    const { data: doc } = await supabase
      .from("documents")
      .select("extracted_fields")
      .eq("contact_id", (offer as any).contact_id)
      .eq("classification", "signed_contract")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    titleCompany = ((doc?.extracted_fields as any)?.title_company as string) ?? null
  } catch { /* title company is best-effort enrichment */ }

  // ensureRequiredMilestones looks up dates by snake_case milestone_name key
  // e.g. contractTerms["closing_date"], contractTerms["inspection_deadline"]
  // Normalise camelCase keys from the offer bridge params before passing in
  // Milestone dates come from the SAME derivation the transaction columns above
  // used, so a deadline can never read one date on the deal row and a different
  // one on its milestone card.
  const normalisedTerms: Record<string, string> = {}
  const { closingDate, inspectionDeadline, appraisalDeadline, financingDeadline } = contractDeadlines
  if (closingDate)        normalisedTerms["closing_date"]        = closingDate
  if (inspectionDeadline) normalisedTerms["inspection_deadline"] = inspectionDeadline
  if (appraisalDeadline)  normalisedTerms["appraisal_deadline"]  = appraisalDeadline
  if (financingDeadline)  normalisedTerms["financing_deadline"]  = financingDeadline
  if (earnestDueDate)     normalisedTerms["earnest_money_due"]   = earnestDueDate

  // Seed the FULL buyer journey first (celebratory + deadline + compliance milestones
  // from the canonical catalog), then ensure the deadline-critical set — which dedupes
  // by identity, so it fills the deadline dates + mirrors them rather than duplicating.
  // An offer transaction now carries the same rich journey a directly-created one does.
  await seedJourneyMilestones(transaction.id, params.brokerageId, "purchase")
  await ensureRequiredMilestones(
    transaction.id,
    params.brokerageId,
    normalisedTerms
  )
  
  // Back-link the offer to the created transaction
  await supabase
    .from("offers")
    .update({ transaction_id: transaction.id, updated_at: new Date().toISOString() })
    .eq("id", params.offerId)

  // TRANSACTION COST BREAKDOWN (burn-down round 4): the client portal's
  // transaction detail reads transaction_cost_breakdown — writer-less until
  // now, so every client's cost panel rendered empty. Persist the accepted
  // offer's numbers at the moment the deal is born: seller side rides the SAME
  // net-sheet math the offer comparison used (defaultSellerCosts marks every
  // line an ESTIMATE — provenance discipline, agents refine later); buyer side
  // carries the contract facts we actually have (price, earnest money, credit).
  // UNIQUE(transaction_id) live-verified → upsert is pass-10 safe. Best-effort.
  try {
    const { computeNetProceeds, defaultSellerCosts } = await import("@/lib/offers/net-sheet-calc")
    const offerPrice = Number((offer as any).offer_price) || 0
    // The seller's closing-cost contribution IS a contract term and is now read
    // (CONTRACT_TERM_COLUMNS). It was hard-zeroed here only because the select
    // did not carry it, which understated the buyer's credit and overstated the
    // seller's net on every offer that negotiated one.
    const buyerCredit = Number((offer as any).closing_cost_contribution) || 0
    const costs = defaultSellerCosts({ listPrice: offerPrice, commissionRateDecimal: 0.06, hoaDuesMonthly: null })
    await supabase.from("transaction_cost_breakdown").upsert({
      transaction_id: transaction.id,
      brokerage_id: params.brokerageId,
      buyer_costs: {
        offer_price: offerPrice,
        earnest_money: Number((offer as any).earnest_money) || 0,
        seller_closing_credit: buyerCredit,
        provenance: "contract",
      },
      seller_costs: {
        commission_rate: costs.commissionRate,
        estimated_commission: Math.round(offerPrice * costs.commissionRate),
        county_city_taxes: costs.countyCityTaxes,
        hoa_dues_proration: costs.hoaDuesProration,
        other_prorated_fees: costs.otherProratedFees,
        mortgage_payoff: costs.mortgagePayoff,
        provenance: "default_estimate", // every line an estimate until confirmed
      },
      net_proceeds: computeNetProceeds({ offerPrice, buyerClosingCredit: buyerCredit }, costs),
      updated_at: new Date().toISOString(),
    }, { onConflict: "transaction_id" })
  } catch { /* best-effort — never blocks the offer→deal bridge */ }

  // CONTINGENCY DEADLINES — the offer's NON-STANDARD contingencies (home-sale, HOA, title, insurance,
  // survey, attorney review) become watched deadlines in transaction_deadlines so none passes silently
  // (the standard inspection/financing/appraisal ones are already milestone-tracked above). Reuses the
  // existing deadline table + watcher; idempotent + best-effort — never blocks the offer→deal bridge.
  try {
    const { ensureContingencyDeadlines } = await import("./contingency-deadlines")
    await ensureContingencyDeadlines(supabase, { transactionId: transaction.id, brokerageId: params.brokerageId })
  } catch { /* best-effort — the deadline-watcher + reapers are the safety net */ }

  // Create first activity — Agent task (correct location, no changes) — activity_type: transaction_started
  await supabase.from("activities").insert({
    transaction_id: transaction.id,
    brokerage_id:   params.brokerageId,
    agent_id:       (offer as any).agent_id,  // buyer_agents table does NOT exist
    activity_type:  "transaction_started",
    title:          "Transaction Created - Schedule Inspection",
    description:    "Transaction is now under contract. Next step: schedule home inspection.",
    priority:       "high",
    status:         "pending",
    created_at:     new Date().toISOString(),
  })
  
  // Client-facing "under contract" card now flows through the canonical kernel template path
  // (idempotent + buyer/seller-aware) instead of a one-off direct transparency_updates write — this
  // is the single chokepoint all four accept flows share, so emitting here gives every flow the same
  // notification + sequence-enrollment + portal card. For the seller-accept path (which also emits
  // OFFER_ACCEPTED) the portal writer's idempotency collapses the two into one card. Best-effort:
  // never break transaction creation on a fan-out failure. Contract dates surface as their own
  // milestone cards (earnest money, inspection, closing) as the deal progresses.
  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitTransactionEvent({
      event:       KernelEvent.OFFER_ACCEPTED,
      brokerageId: params.brokerageId,
      entityId:    transaction.id,
      actorUserId: "",
      metadata: {
        earnest_money_due:      earnestDueDate ?? null,
        earnest_money_due_days: (offer as any).earnest_money_due_days ?? null,
        title_company:          titleCompany,
        inspection_deadline:    contractDeadlines.inspectionDeadline,
        closing_date:           contractDeadlines.closingDate,
        created_from_offer:     params.offerId,
      },
    })
  } catch (err) {
    console.error("[offer-bridge] emitTransactionEvent(OFFER_ACCEPTED) failed", err)
  }

  // Auto-populate transaction_participants from offer + listing + brokerage
  // preferred-vendor directory. Never inserts placeholders — only rows for
  // which we can resolve real names/emails. Idempotent (skips when the
  // transaction already has any participants).
  try {
    await populateInitialParticipants(supabase as any, transaction.id, params.brokerageId)
  } catch (err: any) {
    // Failure here must not roll back the transaction. The agent can still
    // populate participants manually from the transaction UI.
    console.error("[offer-bridge] populateInitialParticipants failed (non-fatal):", err?.message ?? err)
  }

  // ── OBLIGATION 5, SECOND HALF: tell the parties. ──────────────────────────
  // Terms and dates are now saved (above); this is where every party learns
  // them. Runs AFTER populateInitialParticipants on purpose — the roster it
  // writes IS the recipient list and the contact-info block of the message.
  // Idempotent (marker on activities), audience-scoped (staff vs client vs
  // outside professional), and HONEST: a fan-out that reached nobody is logged
  // as not-sent, never swallowed. Never throws — a notification failure must
  // not roll back a created transaction, but it must not be invisible either.
  let partiesNotified: { sent: boolean; already_notified: boolean; errors: string[] } | null = null
  try {
    const { notifyTransactionParties } = await import("@/lib/notifications/notify-helpers")
    partiesNotified = await notifyTransactionParties(supabase as any, {
      transactionId: transaction.id,
      brokerageId:   params.brokerageId,
    })
    if (!partiesNotified.sent && !partiesNotified.already_notified) {
      console.error(
        `[offer-bridge] transaction ${transaction.id} created but NO party was notified:`,
        partiesNotified.errors.join(" | "),
      )
    } else if (partiesNotified.errors.length > 0) {
      console.warn(
        `[offer-bridge] party notification for ${transaction.id} completed with issues:`,
        partiesNotified.errors.join(" | "),
      )
    }
  } catch (err: any) {
    console.error("[offer-bridge] notifyTransactionParties threw (non-fatal):", err?.message ?? err)
  }

  return {
    success: true,
    transactionId: transaction.id,
    // Reported, not assumed: callers (and the e2e proof) can see whether the
    // parties were actually told.
    partiesNotified: partiesNotified?.sent ?? false,
  }
}
