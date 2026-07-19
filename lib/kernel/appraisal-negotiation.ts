// lib/kernel/appraisal-negotiation.ts
//
// THE APPRAISAL-GAP NEGOTIATION COPILOT — the agent-facing companion to the
// appraisal-came-in-low DETECTOR (runAppraisalGapDetection in
// app/actions/transaction-milestones.ts).
//
// The detector already tells the HUMANS a gap exists (the APPRAISAL_GAP_DETECTED
// kernel event → staff notify + the calm buyer/seller portal cards) and convenes
// the deal-save huddle. What it did NOT do is hand the AGENT the actual plays. A
// seasoned agent walks into that call with three canonical paths already priced:
//
//   1. SELLER REDUCES to the appraised value        (favors the buyer)
//   2. BUYER BRINGS CASH to cover the gap           (favors the seller)
//   3. MEET IN THE MIDDLE / RE-APPRAISE with comps  (balanced — split or dispute)
//
// This module is the composer for exactly that. Two layers, mirroring the
// deal-save-huddle split (PURE routing is unit-tested; the runner does the I/O):
//
//   • composeAppraisalGapOptions(facts) — PURE. The three options with the math
//     for each (pure arithmetic off purchase_price, appraisal_value, and the loan
//     amount on file), deterministic pros/cons, who each favors, and a
//     deterministic fallback framing floor. No AI, no network → unit-testable.
//   • runAppraisalNegotiationCopilot(...) — the runner. Pulls 3-5 supporting
//     comps from the platform comps provider (RentCast, reused — NOT a new
//     scraper), asks the model to author brand-voice framing on top of the pure
//     math (deterministic fallback if unavailable — nothing canned is the SHIPPED
//     copy), and delivers the whole briefing as an AGENT-facing transaction task
//     (the deal-save-huddle agent-action idiom — a tagged, deduped transaction_tasks
//     row assigned to the deal's agent). Idempotent per (transaction, appraisal
//     value): a re-mark of the same value never re-briefs; a CORRECTED value fires
//     fresh (the appraisal value is baked into the dedupe title).
//
// No new tables, no client egress (the briefing is an internal agent task, never a
// raw send). Best-effort throughout — the copilot never breaks the detector.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ── Pure math layer ──────────────────────────────────────────────────────────

export type AppraisalOptionKey = "seller_reduces" | "buyer_covers" | "split_or_reappraise"
export type OptionFavors = "buyer" | "seller" | "balanced"

/** Where the buyer's loan figure actually came from — the sourcing hierarchy the
 *  runner walks (lender record → transaction record → the buyer's pre-approval).
 *  There is NO assumption tier: when none of these exist, terms are UNKNOWN and
 *  the math that needs them is presented as pending — never invented. */
export type LoanTermsSource = "transaction_lenders" | "transaction" | "pre_approval"

export interface KnownLoanTerms {
  /** The real loan amount (0 = a cash purchase per the record). */
  loanAmount: number
  source: LoanTermsSource
  lenderName?: string | null
  loanType?: string | null
  /** Extra provenance detail (e.g. a pre-approval expiry) rendered in the label. */
  detail?: string | null
}

/** The provenance line downstream math carries ("per the buyer's pre-approval from …"). */
export function loanTermsProvenanceLabel(t: KnownLoanTerms): string {
  switch (t.source) {
    case "transaction_lenders":
      return `per the lender's loan terms on file${t.lenderName ? ` (${t.lenderName}${t.loanType ? `, ${t.loanType}` : ""})` : t.loanType ? ` (${t.loanType})` : ""}`
    case "transaction":
      return "per the loan amount on the transaction record"
    case "pre_approval":
      return `per the buyer's pre-approval${t.lenderName ? ` from ${t.lenderName}` : ""}${t.detail ? ` (${t.detail})` : ""}`
  }
}

/** Facts the pure composer needs. `loanTerms` is the REAL, sourced loan structure —
 *  null means genuinely unknown, and the composer then presents only the price/gap
 *  math (which needs no loan terms) with the loan-dependent figures marked pending.
 *  Nothing is ever assumed. */
export interface AppraisalGapFacts {
  contractPrice: number
  appraisalValue: number
  /** Sourced loan terms (lender row → transaction → pre-approval), or null = unknown. */
  loanTerms?: KnownLoanTerms | null
  earnestMoney?: number | null
}

/** A single labeled figure for an option (rendering + the briefing text). */
export interface OptionNumber { label: string; value: number; fmt: string }

export interface AppraisalGapOption {
  key: AppraisalOptionKey
  title: string
  favors: OptionFavors
  numbers: OptionNumber[]
  pros: string[]
  cons: string[]
  /** Deterministic one-line framing — the FALLBACK FLOOR if AI copy is unavailable. */
  fallbackFraming: string
  /** AI-authored brand-voice framing, filled by the runner (defaults to fallbackFraming). */
  framing?: string
}

export interface AppraisalGapContext {
  contractPrice: number
  appraisalValue: number
  gapAmount: number
  gapPct: number
  /** null when loan terms are unknown — no LTV is ever assumed. */
  ltv: number | null
  originalDownPayment: number | null
  originalLoanAmount: number | null
  /** false → no lender record, transaction loan, or pre-approval on file. The
   *  loan-dependent figures are then PENDING (never an invented structure). */
  loanTermsKnown: boolean
  loanTermsSource: LoanTermsSource | null
  /** Provenance line for the briefing ("per the buyer's pre-approval from …"). */
  loanTermsProvenance: string | null
}

export interface AppraisalGapCopilot {
  context: AppraisalGapContext
  options: AppraisalGapOption[]
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`
}

function num(label: string, value: number): OptionNumber {
  return { label, value: Math.round(value), fmt: usd(value) }
}

/**
 * PURE: the three canonical paths forward with the math for each. Deterministic —
 * no AI, no I/O. The arithmetic is the "lender lends against the LOWER of price or
 * appraisal" rule that governs every one of these conversations.
 */
export function composeAppraisalGapOptions(facts: AppraisalGapFacts): AppraisalGapCopilot {
  const contractPrice  = Math.max(0, Math.round(facts.contractPrice))
  const appraisalValue = Math.max(0, Math.round(facts.appraisalValue))
  const gapAmount = Math.max(0, contractPrice - appraisalValue)
  const gapPct = contractPrice > 0 ? Math.round((gapAmount / contractPrice) * 1000) / 10 : 0

  // The buyer's REAL structure — only from a sourced record (lender row, the
  // transaction's own loan amount, or the buyer's pre-approval). When none is on
  // file the terms are UNKNOWN: the options below present the price/gap math
  // (which needs no loan terms) and the loan-dependent figures are pending the
  // lender's terms. An invented 20%-down is still an invention — we never assume.
  const t = facts.loanTerms ?? null
  const loanTermsKnown =
    t != null && Number.isFinite(t.loanAmount) && t.loanAmount >= 0 && t.loanAmount < contractPrice
  const originalLoanAmount = loanTermsKnown ? Math.round(t!.loanAmount) : null
  const originalDownPayment = loanTermsKnown ? contractPrice - (originalLoanAmount as number) : null
  const ltv = loanTermsKnown && contractPrice > 0 ? (originalLoanAmount as number) / contractPrice : null
  const provenance = loanTermsKnown ? loanTermsProvenanceLabel(t!) : null
  const PENDING_LINE =
    "loan figures pending the lender's terms — attach the pre-approval or lender details to complete this"

  // ── Option 1: SELLER REDUCES to the appraised value ──────────────────────────
  // Price is re-cut to the appraisal. The lender re-bases the loan on the new
  // (lower) price at the same LTV, so the buyer's down payment and cash-to-close
  // both DROP. The seller absorbs the full gap. The loan/down figures exist ONLY
  // when the buyer's real structure is on file — otherwise they are pending.
  const o1NewPrice = appraisalValue
  const o1NewLoan  = loanTermsKnown ? Math.round(appraisalValue * (ltv as number)) : null
  const o1NewDown  = o1NewLoan != null ? o1NewPrice - o1NewLoan : null
  const o1BuyerCashDelta =
    o1NewDown != null && originalDownPayment != null ? o1NewDown - originalDownPayment : null // negative → buyer needs LESS cash
  const sellerReduces: AppraisalGapOption = {
    key: "seller_reduces",
    title: "Seller reduces to the appraised value",
    favors: "buyer",
    numbers: [
      num("New purchase price", o1NewPrice),
      ...(o1NewLoan != null ? [num("Revised loan", o1NewLoan)] : []),
      ...(o1NewDown != null ? [num("Revised down payment", o1NewDown)] : []),
      ...(o1BuyerCashDelta != null ? [num("Buyer cash change", o1BuyerCashDelta)] : []),
      num("Seller gives up", gapAmount),
    ],
    pros: [
      "Deal closes with no new cash from the buyer — often the fastest path to the table.",
      "Loan re-bases cleanly on the appraised value; no appraisal-contingency exposure remains.",
      ...(o1BuyerCashDelta != null
        ? [`Buyer's cash-to-close drops by about ${usd(Math.abs(o1BuyerCashDelta))} (${provenance}).`]
        : []),
    ],
    cons: [
      `Seller nets ${usd(gapAmount)} less than the contract.`,
      "Hardest sell in a hot market or when the seller has other backup offers.",
    ],
    fallbackFraming: loanTermsKnown
      ? `Ask the seller to meet the appraisal at ${usd(o1NewPrice)}. The buyer keeps their financing, their down payment falls to about ${usd(o1NewDown as number)} (${provenance}), and the appraisal contingency clears itself. The trade is ${usd(gapAmount)} off the seller's net.`
      : `Ask the seller to meet the appraisal at ${usd(o1NewPrice)}. The appraisal contingency clears itself and the trade is ${usd(gapAmount)} off the seller's net; the buyer's revised ${PENDING_LINE}.`,
  }

  // ── Option 2: BUYER BRINGS CASH to cover the gap ─────────────────────────────
  // Price holds at contract. The lender caps the loan against the appraised value,
  // so the buyer commits to bring the gap in cash ABOVE the appraised value — the
  // "appraisal-gap coverage" clause. The gap-coverage figure itself needs NO loan
  // terms (it is pure price − appraisal); the revised cash-to-close/loan figures
  // exist only when the buyer's real structure is on file.
  const o2GapCoverage        = gapAmount
  const o2RevisedCashToClose = originalDownPayment != null ? originalDownPayment + gapAmount : null
  const o2NewLoan            = o2RevisedCashToClose != null ? contractPrice - o2RevisedCashToClose : null // = originalLoan - gap
  const buyerCovers: AppraisalGapOption = {
    key: "buyer_covers",
    title: "Buyer brings cash to cover the gap",
    favors: "seller",
    numbers: [
      num("Purchase price (unchanged)", contractPrice),
      num("Appraisal-gap coverage", o2GapCoverage),
      ...(o2RevisedCashToClose != null ? [num("Revised cash to close", o2RevisedCashToClose)] : []),
      ...(o2NewLoan != null ? [num("Revised loan", o2NewLoan)] : []),
    ],
    pros: [
      "Seller keeps the full contract price — strongest option to hold the deal exactly as written.",
      "Backs an appraisal-gap coverage clause the buyer likely already anticipated in a competitive offer.",
    ],
    cons: [
      o2RevisedCashToClose != null
        ? `Buyer needs about ${usd(o2GapCoverage)} more cash at closing (revised cash-to-close ~${usd(o2RevisedCashToClose)}, ${provenance}).`
        : `Buyer needs about ${usd(o2GapCoverage)} more cash at closing; their full revised ${PENDING_LINE}.`,
      "Only works if the buyer has the reserves — confirm proof of funds before proposing it.",
      "Buyer is paying over the appraised value, which they may resist.",
    ],
    fallbackFraming: loanTermsKnown
      ? `Hold the price at ${usd(contractPrice)} and have the buyer cover the ${usd(o2GapCoverage)} gap in cash above the appraisal. Their cash-to-close rises to about ${usd(o2RevisedCashToClose as number)} (${provenance}) and the loan settles near ${usd(o2NewLoan as number)}. Confirm the buyer's reserves before you float it.`
      : `Hold the price at ${usd(contractPrice)} and have the buyer cover the ${usd(o2GapCoverage)} gap in cash above the appraisal. Their exact cash-to-close and revised ${PENDING_LINE}. Confirm the buyer's reserves before you float it.`,
  }

  // ── Option 3: MEET IN THE MIDDLE / RE-APPRAISE with comps ────────────────────
  // Split the gap down the middle (seller drops half, buyer covers half in cash),
  // OR challenge the number: file a Reconsideration of Value with the comps below.
  const o3SplitPrice     = Math.round((contractPrice + appraisalValue) / 2)
  const o3SellerConcession = contractPrice - o3SplitPrice
  const o3BuyerExtraCash   = Math.round(gapAmount / 2)
  const splitOrReappraise: AppraisalGapOption = {
    key: "split_or_reappraise",
    title: "Meet in the middle / re-appraise with comps",
    favors: "balanced",
    numbers: [
      num("Split price", o3SplitPrice),
      num("Seller concession (half)", o3SellerConcession),
      num("Buyer extra cash (half)", o3BuyerExtraCash),
      num("Gap in dispute (full)", gapAmount),
    ],
    pros: [
      "Both sides give a little — the classic face-saving compromise that keeps everyone at the table.",
      "The Reconsideration-of-Value path can erase the gap entirely at no cost to either party if the comps land.",
      "The supporting comps below double as the ROV / ARV argument.",
    ],
    cons: [
      "A split still asks the buyer for cash and the seller for a price cut — neither may love it.",
      "A reconsideration takes days and isn't guaranteed; watch the appraisal-contingency clock.",
    ],
    fallbackFraming:
      `Offer to split the difference at ${usd(o3SplitPrice)} — seller gives ${usd(o3SellerConcession)}, buyer brings ${usd(o3BuyerExtraCash)} — or challenge the ${usd(gapAmount)} outright with a Reconsideration of Value using the comps below. Move on whichever the clock and the comps favor.`,
  }

  return {
    context: {
      contractPrice,
      appraisalValue,
      gapAmount,
      gapPct,
      ltv: ltv != null ? Math.round(ltv * 1000) / 1000 : null,
      originalDownPayment,
      originalLoanAmount,
      loanTermsKnown,
      loanTermsSource: loanTermsKnown ? t!.source : null,
      loanTermsProvenance: provenance,
    },
    options: [sellerReduces, buyerCovers, splitOrReappraise],
  }
}

// ── Supporting comps (reuse the platform comps provider — NOT a new scraper) ──

export interface SupportingComp {
  address: string
  salePrice: number
  pricePerSqft: number | null
  daysOnMarket: number | null
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  distanceMiles: number | null
}

/**
 * Pull 3-5 recent comparable sales that support the CONTRACT price via the
 * brokerage's chosen comps provider (RentCast, through getRentcastComps — the same
 * engine the CMA/negotiation-copilot use). Prefers comps at/above the contract
 * price (the strongest ROV/ARV backing), then nearest, then most recent. Never
 * throws; returns [] when comps aren't available or the provider isn't configured.
 */
export async function loadSupportingComps(args: {
  brokerageId: string
  address: string | null
  contractPrice: number
}): Promise<SupportingComp[]> {
  if (!args.address) return []
  try {
    const { getRentcastComps } = await import("@/lib/property/rentcast")
    const raw = await getRentcastComps({ brokerageId: args.brokerageId, address: args.address, limit: 12 }).catch(() => null)
    if (!raw || !Array.isArray(raw) || raw.length === 0) return []

    const mapped: SupportingComp[] = raw
      .filter((c) => Number(c.sale_price ?? 0) > 0)
      .map((c) => ({
        address: c.address ?? "Unknown",
        salePrice: Math.round(Number(c.sale_price ?? 0)),
        pricePerSqft: c.price_per_sqft ? Math.round(Number(c.price_per_sqft)) : null,
        daysOnMarket: c.days_on_market != null ? Math.round(Number(c.days_on_market)) : null,
        bedrooms: c.bedrooms != null ? Number(c.bedrooms) : null,
        bathrooms: c.bathrooms != null ? Number(c.bathrooms) : null,
        squareFeet: c.square_feet ? Math.round(Number(c.square_feet)) : null,
        distanceMiles: c.distance_miles != null ? Number(c.distance_miles) : null,
      }))

    // Rank: comps that SUPPORT the contract price (>= contract) first, then nearest,
    // then most recent (lowest DOM). This surfaces the strongest reconsideration set.
    const ranked = mapped.sort((a, b) => {
      const aSupports = a.salePrice >= args.contractPrice ? 0 : 1
      const bSupports = b.salePrice >= args.contractPrice ? 0 : 1
      if (aSupports !== bSupports) return aSupports - bSupports
      const aDist = a.distanceMiles ?? 99
      const bDist = b.distanceMiles ?? 99
      if (Math.abs(aDist - bDist) > 0.05) return aDist - bDist
      return (a.daysOnMarket ?? 999) - (b.daysOnMarket ?? 999)
    })
    return ranked.slice(0, 5)
  } catch {
    return []
  }
}

// ── AI framing (brand voice, deterministic fallback floor) ────────────────────

/**
 * Author brand-voice framing on top of the pure math — one model round for all
 * three options plus a bottom-line. This is INTERNAL agent guidance (not client
 * egress), so it may state the figures; it follows the app's AI-first idiom
 * (generateClientMessage-style: model primary, deterministic fallback floor —
 * nothing canned is the shipped copy). Never throws; on any failure every option
 * keeps its deterministic fallbackFraming.
 */
async function authorAgentFraming(
  copilot: AppraisalGapCopilot,
  brokerageId: string,
): Promise<{ options: AppraisalGapOption[]; bottomLine: string }> {
  const { context, options } = copilot
  const deterministicBottomLine =
    `Appraisal is ${usd(context.gapAmount)} (${context.gapPct}%) short. Lead with the path that fits your client and the market: seller-reduces if they'll move, buyer-covers if they have the cash and want the house, split-or-reappraise when neither will budge alone.`

  try {
    const { generateObjectRouted } = await import("@/lib/ai/models")
    const { z } = await import("zod")

    const optionLines = options
      .map((o) => {
        const nums = o.numbers.map((n) => `${n.label} ${n.fmt}`).join(", ")
        return `- ${o.key} ("${o.title}", favors ${o.favors}): ${nums}`
      })
      .join("\n")

    const prompt = `You are coaching a real estate agent walking into an appraisal-gap negotiation. The appraisal came in ${usd(context.gapAmount)} (${context.gapPct}%) below the ${usd(context.contractPrice)} contract price (appraised at ${usd(context.appraisalValue)}).

Here are the three priced paths (numbers are already computed — do not change them):
${optionLines}

For EACH option write ONE tight, confident sentence (max 40 words) the agent can say to frame that path — plain, specific, no jargon, no fair-housing language, no guarantees of outcome. Then write a 1-2 sentence bottomLine on how to sequence the three.

Return ONLY JSON: {"seller_reduces":"...","buyer_covers":"...","split_or_reappraise":"...","bottomLine":"..."}`

    const { object } = await generateObjectRouted({
      feature: "appraisal_negotiation",
      brokerageId,
      prompt,
      maxTokens: 500,
      schema: z.object({
        seller_reduces: z.string(),
        buyer_covers: z.string(),
        split_or_reappraise: z.string(),
        bottomLine: z.string(),
      }),
    })

    const framed = options.map((o) => {
      const ai = (object as Record<string, string>)[o.key]
      return { ...o, framing: ai && ai.trim().length > 0 ? ai.trim() : o.fallbackFraming }
    })
    const bottomLine = object.bottomLine?.trim() || deterministicBottomLine
    return { options: framed, bottomLine }
  } catch {
    // Deterministic floor — every option falls back to its own pure framing.
    return {
      options: options.map((o) => ({ ...o, framing: o.fallbackFraming })),
      bottomLine: deterministicBottomLine,
    }
  }
}

// ── Briefing assembly + the agent-facing delivery (deal-save-huddle idiom) ────

const CIRCLED = ["①", "②", "③", "④", "⑤"]

/** PURE: assemble the full agent briefing text from the framed options + comps. */
export function buildAgentBriefing(
  copilot: AppraisalGapCopilot,
  comps: SupportingComp[],
  bottomLine: string,
): string {
  const { context, options } = copilot
  const lines: string[] = []
  lines.push(
    `Appraisal came in at ${usd(context.appraisalValue)} vs ${usd(context.contractPrice)} contract — a gap of ${usd(context.gapAmount)} (${context.gapPct}%). Three paths forward:`,
  )
  lines.push("")

  options.forEach((o, i) => {
    const favors =
      o.favors === "buyer" ? "favors buyer" : o.favors === "seller" ? "favors seller" : "balanced"
    lines.push(`${CIRCLED[i]} ${o.title.toUpperCase()} (${favors})`)
    lines.push(`   ${o.numbers.map((n) => `${n.label}: ${n.fmt}`).join(" · ")}`)
    lines.push(`   ${o.framing ?? o.fallbackFraming}`)
    for (const p of o.pros) lines.push(`   + ${p}`)
    for (const c of o.cons) lines.push(`   − ${c}`)
    lines.push("")
  })

  if (comps.length > 0) {
    lines.push("SUPPORTING COMPS (back the contract price / a Reconsideration of Value):")
    for (const c of comps) {
      const bits = [
        usd(c.salePrice),
        c.pricePerSqft ? `$${c.pricePerSqft}/sqft` : null,
        c.daysOnMarket != null ? `${c.daysOnMarket} DOM` : null,
        c.distanceMiles != null ? `${c.distanceMiles}mi` : null,
      ].filter(Boolean)
      lines.push(`   • ${c.address} — ${bits.join(" · ")}`)
    }
    lines.push("")
  } else {
    lines.push("SUPPORTING COMPS: none returned by the comps provider — pull the CMA set for a Reconsideration of Value.")
    lines.push("")
  }

  if (context.loanTermsKnown && context.loanTermsProvenance) {
    lines.push(`Loan figures are ${context.loanTermsProvenance}.`)
    lines.push("")
  } else {
    lines.push(
      "Loan-dependent figures (revised loan, down payment, cash-to-close) are PENDING the lender's terms — no lender record or pre-approval is on file, and nothing was assumed. Attach the buyer's pre-approval or the lender details to complete this; the price/gap math above stands on its own.",
    )
    lines.push("")
  }
  lines.push(`Bottom line: ${bottomLine}`)
  return lines.join("\n")
}

/**
 * Resolve the buyer's REAL loan terms for a transaction — the sourcing hierarchy:
 *   1. transaction_lenders — the lender's own record (loan_amount, loan_type, lender_name)
 *   2. transactions.loan_amount — the loan recorded on the deal itself
 *   3. buyer_financial_profiles — the buyer's pre-approval (cash flag, down payment
 *      amount/percent, lender, expiry) → the planned structure at THIS contract price
 *   4. null — genuinely unknown. NO assumption tier exists.
 * Best-effort; never throws.
 */
export async function resolveLoanTermsForTransaction(
  supabase: Svc,
  transactionId: string,
  contractPrice: number,
  transactionLoanAmount?: number | null,
): Promise<KnownLoanTerms | null> {
  const sane = (n: unknown): number | null => {
    const v = Number(n)
    return Number.isFinite(v) && v > 0 && v < contractPrice ? Math.round(v) : null
  }
  try {
    // 1. The lender record on the deal.
    const { data: lender } = await supabase
      .from("transaction_lenders")
      .select("loan_amount, loan_type, lender_name")
      .eq("transaction_id", transactionId)
      .limit(1)
      .maybeSingle()
    const lenderLoan = sane((lender as any)?.loan_amount)
    if (lenderLoan != null) {
      return {
        loanAmount: lenderLoan,
        source: "transaction_lenders",
        lenderName: (lender as any)?.lender_name ?? null,
        loanType: (lender as any)?.loan_type ?? null,
      }
    }

    // 2. The loan amount recorded on the transaction itself.
    const txLoan = sane(transactionLoanAmount)
    if (txLoan != null) return { loanAmount: txLoan, source: "transaction" }

    // 3. The buyer's pre-approval record (buyer_financial_profiles).
    const { data: tx } = await supabase
      .from("transactions")
      .select("buyer_contact_id, contact_id")
      .eq("id", transactionId)
      .maybeSingle()
    const buyerContactId = (tx as any)?.buyer_contact_id ?? (tx as any)?.contact_id ?? null
    if (buyerContactId) {
      const { data: fin } = await supabase
        .from("buyer_financial_profiles")
        .select("is_cash_buyer, down_payment_amount, down_payment_percent, pre_approval_lender, pre_approval_expires_at, finance_type")
        .eq("contact_id", buyerContactId)
        .maybeSingle()
      if (fin) {
        const f = fin as any
        const expiry = f.pre_approval_expires_at
          ? `expires ${String(f.pre_approval_expires_at).slice(0, 10)}`
          : null
        if (f.is_cash_buyer === true) {
          return {
            loanAmount: 0,
            source: "pre_approval",
            lenderName: f.pre_approval_lender ?? null,
            detail: "cash purchase per the buyer's financial profile",
          }
        }
        const downAmt = sane(f.down_payment_amount)
        if (downAmt != null) {
          return {
            loanAmount: contractPrice - downAmt,
            source: "pre_approval",
            lenderName: f.pre_approval_lender ?? null,
            loanType: f.finance_type ?? null,
            detail: expiry,
          }
        }
        const downPct = Number(f.down_payment_percent)
        if (Number.isFinite(downPct) && downPct > 0 && downPct < 100) {
          return {
            loanAmount: Math.round(contractPrice * (1 - downPct / 100)),
            source: "pre_approval",
            lenderName: f.pre_approval_lender ?? null,
            loanType: f.finance_type ?? null,
            detail: expiry,
          }
        }
      }
    }
  } catch { /* best-effort — unknown is an honest answer */ }
  // 4. Genuinely unknown — the copilot presents the price/gap math and says so.
  return null
}

export interface AppraisalNegotiationResult {
  ran: boolean
  taskCreated: boolean
  compsFound: number
  reason?: string
}

/**
 * The runner. Composes the three priced options, pulls supporting comps, authors
 * brand-voice framing (deterministic fallback), and delivers the whole briefing as
 * an AGENT-facing transaction task assigned to the deal's agent (the deal-save-huddle
 * agent-action idiom). Idempotent per (transaction, appraisal value) — the appraisal
 * value is baked into the dedupe title, so a re-mark of the same value never
 * re-briefs but a corrected value fires fresh. Best-effort; never throws.
 */
export async function runAppraisalNegotiationCopilot(
  args: {
    transactionId: string
    brokerageId: string
    appraisalValue: number
    contractPrice: number
    loanAmount?: number | null
    earnestMoney?: number | null
    dealName?: string | null
    propertyAddress?: string | null
    propertyCity?: string | null
    propertyState?: string | null
    propertyZip?: string | null
  },
  client?: Svc,
): Promise<AppraisalNegotiationResult> {
  const supabase: Svc = client ?? createServiceClient()

  // Nothing to do if there's no real gap.
  if (!(args.appraisalValue > 0) || !(args.contractPrice > 0) || args.appraisalValue >= args.contractPrice) {
    return { ran: false, taskCreated: false, compsFound: 0, reason: "no gap" }
  }

  const deal = args.dealName?.trim() || args.propertyAddress?.trim() || "this deal"
  // The appraisal value in the title is the (transaction, appraisal value) dedupe key:
  // a CORRECTED value → new title → briefs fresh; a re-mark of the same value → skip.
  const title = `[Appraisal-Gap Copilot · ${usd(args.appraisalValue)}] ${deal}: 3 paths forward`

  const { data: dup } = await supabase
    .from("transaction_tasks")
    .select("id")
    .eq("transaction_id", args.transactionId)
    .eq("title", title)
    .in("status", ["pending", "in_progress"])
    .limit(1)
    .maybeSingle()
  if (dup) return { ran: true, taskCreated: false, compsFound: 0, reason: "already briefed for this appraisal value" }

  // Source the buyer's REAL loan terms (lender record → transaction → pre-approval;
  // null = genuinely unknown, nothing assumed), then pure math → the three options.
  const loanTerms = await resolveLoanTermsForTransaction(
    supabase, args.transactionId, args.contractPrice, args.loanAmount ?? null,
  )
  const copilot = composeAppraisalGapOptions({
    contractPrice: args.contractPrice,
    appraisalValue: args.appraisalValue,
    loanTerms,
    earnestMoney: args.earnestMoney ?? null,
  })

  // Supporting comps (best-effort) + brand-voice framing (deterministic fallback).
  const address = [args.propertyAddress, args.propertyCity, args.propertyState, args.propertyZip]
    .filter(Boolean)
    .join(", ") || null
  const [comps, framed] = await Promise.all([
    loadSupportingComps({ brokerageId: args.brokerageId, address, contractPrice: args.contractPrice }),
    authorAgentFraming(copilot, args.brokerageId),
  ])

  const briefing = buildAgentBriefing(
    { context: copilot.context, options: framed.options },
    comps,
    framed.bottomLine,
  )

  // Resolve the deal's agent (fall back to the coordinator) — reuse the deal-save-huddle
  // team resolver so the briefing lands with whoever runs the negotiation.
  let assignedUserId: string | null = null
  try {
    const { resolveTransactionTeamUsers } = await import("@/lib/kernel/deal-save-huddle")
    const team = await resolveTransactionTeamUsers(supabase, args.transactionId)
    assignedUserId = team.agentUserId ?? team.coordinatorUserId ?? null
  } catch { /* best-effort — task still lands unassigned for the queue to pick up */ }

  const priority = copilot.context.gapPct >= 5 ? "high" : "medium"
  const { error } = await supabase.from("transaction_tasks").insert({
    transaction_id: args.transactionId,
    brokerage_id: args.brokerageId,
    title,
    description: briefing,
    priority,
    category: "appraisal_negotiation",
    ai_generated: true,
    status: "pending",
    assigned_user_id: assignedUserId,
  })

  return { ran: true, taskCreated: !error, compsFound: comps.length, reason: error ? error.message : undefined }
}
