"use server"

/**
 * app/actions/buyer-closing-costs.ts — the buyer's closing-cost breakdown,
 * grounded in THIS deal's real numbers (purchase price, loan amount, the
 * seller credit actually negotiated). Party-anchored like every portal read.
 *
 * LOAN SOURCING HIERARCHY (owner correction — loan terms are never assumed):
 *   1. transaction_lenders — the lender's own record (loan_amount, rate, name)
 *   2. transactions.loan_amount — the loan recorded on the deal
 *   3. the accepted offer's OWN terms (down_payment_amount / percent)
 *   4. buyer_financial_profiles — the buyer's pre-approval (cash flag, down
 *      payment, lender) → labeled "per your pre-approval from {lender}"
 *   5. genuinely unknown → the estimator marks lender-dependent lines PENDING.
 * Every resolved figure carries its provenance into the estimate.
 *
 * REGION SOURCING (owner: "closing costs are derived by REGION estimates"):
 *   transactions.property_state → fallback brokerages.state. The estimator
 *   labels every regionally-derived line "regional estimate — {state}
 *   conventions"; the lender's Loan Estimate stays the named authority.
 *
 * OPTIONAL AI EXPLANATION (owner: "or if there is a better way AI can determine
 * the most accurate buyer closing costs"; wave 144 ruling 9: "AI explains,
 * deterministic engine calculates — remove any LLM-computed money"):
 * refineWithAi runs ONE routed model call grounded ONLY in the deterministic
 * regional model + this deal's real facts. The model EXPLAINS lines in a
 * buyer's words (a reason each); applyAiRefinements (pure) attaches the reason
 * to the deterministic line and applies NO figure — it used to clamp and apply
 * the model's own low/high. Lender-fact and pending lines are not annotated.
 * Any AI failure returns the deterministic estimate untouched.
 */

import { createServiceClient } from "@/lib/supabase/service"
import {
  estimateBuyerClosingCosts,
  retotalEstimate,
  type BuyerClosingEstimate,
} from "@/lib/offers/buyer-closing-costs"
import {
  getRegionalConventions,
  applyAiRefinements,
  type AiLineAdjustment,
} from "@/lib/offers/regional-closing-costs"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getBuyerClosingCosts(input: {
  contactId: string
  transactionId: string
  /** opt-in: one bounded AI pass over the regional estimate (user-initiated —
   *  never burned on every page load). Deterministic estimate is the floor. */
  refineWithAi?: boolean
}): Promise<{ success: true; estimate: BuyerClosingEstimate; purchasePrice: number } | { success: false; error: string }> {
  if (!UUID_RE.test(input.contactId) || !UUID_RE.test(input.transactionId)) {
    return { success: false, error: "Invalid ids" }
  }
  const svc = createServiceClient()
  const { data: tx } = await svc.from("transactions")
    .select("id, brokerage_id, purchase_price, loan_amount, contact_id, buyer_contact_id, seller_contact_id, property_state, property_city")
    .eq("id", input.transactionId).maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found" }
  const isParty = [(tx as any).contact_id, (tx as any).buyer_contact_id, (tx as any).seller_contact_id]
    .filter(Boolean).includes(input.contactId)
  if (!isParty) return { success: false, error: "Not a party to this transaction" }

  const [{ data: offer }, { data: lender }, { data: fin }, { data: brokerage }] = await Promise.all([
    svc.from("offers")
      .select("offer_price, closing_cost_contribution, financing_type, down_payment_amount, down_payment_percent")
      .eq("transaction_id", input.transactionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("transaction_lenders")
      .select("loan_amount, interest_rate, lender_name")
      .eq("transaction_id", input.transactionId).limit(1).maybeSingle(),
    svc.from("buyer_financial_profiles")
      .select("is_cash_buyer, down_payment_amount, down_payment_percent, pre_approval_lender")
      .eq("contact_id", input.contactId).maybeSingle(),
    svc.from("brokerages")
      .select("state")
      .eq("id", (tx as any).brokerage_id).maybeSingle(),
  ])

  const purchasePrice = Number((tx as any).purchase_price ?? (offer as any)?.offer_price ?? 0)
  if (!purchasePrice || purchasePrice <= 0) {
    return { success: false, error: "No purchase price on this deal yet" } // honest absence — never estimate against nothing
  }

  // ── Resolve the REGION: the property's state, else the brokerage's home
  //    state. Unknown → the estimator falls back to generic industry bands
  //    (and says so) rather than guessing a state. ──
  const state: string | null = (tx as any).property_state ?? (brokerage as any)?.state ?? null

  // ── Resolve the REAL loan amount + its provenance. NO assumption tier: when no
  //    record carries the terms, loanAmount stays null and the estimator presents
  //    the lender-dependent lines as pending — an invented 80% LTV is still an
  //    invention. ──
  const sane = (n: unknown): number | null => {
    const v = Number(n)
    return Number.isFinite(v) && v > 0 && v < purchasePrice ? Math.round(v) : null
  }
  const financing = String((offer as any)?.financing_type ?? "").toLowerCase()
  let loanAmount: number | null = null
  let loanSourceNote: string | null = null
  let interestRatePct: number | null = null

  const lenderLoan = sane((lender as any)?.loan_amount)
  const lenderRate = Number((lender as any)?.interest_rate)
  if (Number.isFinite(lenderRate) && lenderRate > 0) interestRatePct = lenderRate

  if (financing === "cash" || (fin as any)?.is_cash_buyer === true) {
    loanAmount = 0
    loanSourceNote = financing === "cash" ? "cash purchase per your offer" : "cash purchase per your financial profile"
  } else if (lenderLoan != null) {
    loanAmount = lenderLoan
    const name = (lender as any)?.lender_name
    loanSourceNote = `per your lender's loan terms on file${name ? ` (${name})` : ""}`
  } else if (sane((tx as any).loan_amount) != null) {
    loanAmount = sane((tx as any).loan_amount)
    loanSourceNote = "per the loan amount on your transaction record"
  } else {
    // The offer's own terms, then the buyer's pre-approval record.
    const offerDownAmt = sane((offer as any)?.down_payment_amount)
    const offerDownPct = Number((offer as any)?.down_payment_percent)
    const finDownAmt = sane((fin as any)?.down_payment_amount)
    const finDownPct = Number((fin as any)?.down_payment_percent)
    const preLender = (fin as any)?.pre_approval_lender
    if (offerDownAmt != null) {
      loanAmount = purchasePrice - offerDownAmt
      loanSourceNote = "per the down payment on your offer"
    } else if (Number.isFinite(offerDownPct) && offerDownPct > 0 && offerDownPct < 100) {
      loanAmount = Math.round(purchasePrice * (1 - offerDownPct / 100))
      loanSourceNote = `per the ${offerDownPct}% down payment on your offer`
    } else if (finDownAmt != null) {
      loanAmount = purchasePrice - finDownAmt
      loanSourceNote = `per your pre-approval${preLender ? ` from ${preLender}` : ""}`
    } else if (Number.isFinite(finDownPct) && finDownPct > 0 && finDownPct < 100) {
      loanAmount = Math.round(purchasePrice * (1 - finDownPct / 100))
      loanSourceNote = `per your pre-approval${preLender ? ` from ${preLender}` : ""}`
    }
    // else: genuinely unknown — loanAmount stays null, lines go pending.
  }

  let estimate = estimateBuyerClosingCosts({
    purchasePrice,
    loanAmount,
    sellerCredit: Number((offer as any)?.closing_cost_contribution ?? 0),
    interestRatePct,
    loanSourceNote,
    state,
  })

  // ── Optional AI accuracy pass — regional model is the floor, bounds enforced
  //    by the pure clamp, lender facts untouchable, every adjustment explained. ──
  if (input.refineWithAi && estimate.regionState) {
    try {
      estimate = await refineClosingCostsWithAI({
        estimate,
        purchasePrice,
        state: estimate.regionState,
        city: (tx as any).property_city ?? null,
        brokerageId: (tx as any).brokerage_id ?? null,
        lenderName: (lender as any)?.lender_name ?? null,
        interestRatePct,
        loanAmount,
      })
    } catch {
      // deterministic floor holds — return the regional estimate unchanged
    }
  }

  return { success: true, estimate, purchasePrice }
}

// ─── The AI refinement step (gateway idiom: generateObjectRouted) ───────────

async function refineClosingCostsWithAI(args: {
  estimate: BuyerClosingEstimate
  purchasePrice: number
  state: string
  city: string | null
  brokerageId: string | null
  lenderName: string | null
  interestRatePct: number | null
  loanAmount: number | null
}): Promise<BuyerClosingEstimate> {
  const conv = getRegionalConventions(args.state)
  if (!conv) return args.estimate

  const { z } = await import("zod")
  const { generateObjectRouted } = await import("@/lib/ai/models")

  const adjustable = args.estimate.lines.filter((l) => !l.pending && l.source !== "lender_fact")
  if (adjustable.length === 0) return args.estimate

  // WAVE 144 (ruling 9 — AI explains, the deterministic engine calculates): the model EXPLAINS the regional model's lines in a
  // buyer's words; it proposes no figures and none it returns is applied (lib/offers/regional-closing-costs.ts applyAiRefinements).
  const schema = z.object({
    explanations: z.array(z.object({
      label: z.string(),
      reason: z.string(),
    })),
    summary: z.string(),
  })

  const prompt = `You are explaining a buyer closing-cost estimate in plain language. The FIGURES are calculated by a deterministic regional model and are final for this estimate — you do NOT change, propose or restate any dollar amount. You are grounded ONLY in the regional model and the deal facts below — do not invent market data.

DEAL FACTS (real):
- Purchase price: $${args.purchasePrice.toLocaleString()}
- State: ${conv.stateName} (${conv.state})${args.city ? `\n- City: ${args.city}` : ""}
- Loan amount: ${args.loanAmount != null ? (args.loanAmount === 0 ? "cash purchase" : `$${args.loanAmount.toLocaleString()}`) : "unknown (pending lender)"}${args.interestRatePct ? `\n- Locked rate on file: ${args.interestRatePct}%` : ""}${args.lenderName ? `\n- Lender: ${args.lenderName}` : ""}

REGIONAL MODEL (${conv.stateName} published conventions — what the figures come from):
${JSON.stringify(conv, null, 2)}

ESTIMATE LINES you may explain (label · range · source):
${adjustable.map((l) => `- ${l.label} · $${l.low}–$${l.high} · ${l.source}${l.note ? ` · ${l.note}` : ""}`).join("\n")}

Rules (violations are discarded):
1. Explain a line only when a stated DEAL FACT or a stated regional-model detail (who customarily pays, a city-level tax the model names, a graduated tier) explains its range.
2. Each explanation is ONE sentence a buyer can read, with NO dollar figures and NO new numbers.
3. Never explain lender-fact or pending lines (they are not listed above).
4. Your Loan Estimate from the lender remains the authority — say so in the summary.
5. If nothing needs explaining, return an empty explanations array and say so in the summary.

Return: { explanations: [{ label, reason }], summary }`

  const { object } = await generateObjectRouted({
    feature: "smart_suggestions",
    prompt,
    temperature: 0.2,
    maxTokens: 900,
    brokerageId: args.brokerageId,
    schema,
  })

  const explanations = (object?.explanations ?? []) as AiLineAdjustment[]
  if (explanations.length === 0) {
    return { ...args.estimate, aiRefined: false, aiRefineSummary: object?.summary ?? null }
  }
  const outcome = applyAiRefinements(args.estimate.lines, explanations, conv)
  if (outcome.applied.length === 0) {
    return { ...args.estimate, aiRefined: false, aiRefineSummary: object?.summary ?? null }
  }
  // The totals are RE-SUMMED from the unchanged deterministic lines (retotalEstimate is arithmetic only): the figures cannot move.
  return retotalEstimate(args.estimate, outcome.lines, args.purchasePrice, object?.summary ?? null)
}
