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

/** Facts the pure composer needs. Loan/earnest are optional — when the loan amount
 *  is unknown we assume a conventional 20%-down structure and flag it. */
export interface AppraisalGapFacts {
  contractPrice: number
  appraisalValue: number
  /** Original loan on the transaction (transactions.loan_amount). Null → assume 80% LTV. */
  loanAmount?: number | null
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
  ltv: number
  originalDownPayment: number
  originalLoanAmount: number
  /** false → loan terms were absent and a conventional 20%-down structure was assumed. */
  loanTermsKnown: boolean
}

export interface AppraisalGapCopilot {
  context: AppraisalGapContext
  options: AppraisalGapOption[]
}

const DEFAULT_LTV = 0.8

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

  // Derive the buyer's original structure. If the loan amount is on file and sane,
  // use its real LTV; otherwise assume a conventional 20%-down (80% LTV) purchase.
  const rawLoan = Number(facts.loanAmount ?? 0)
  const loanTermsKnown = Number.isFinite(rawLoan) && rawLoan > 0 && rawLoan < contractPrice
  const originalLoanAmount = loanTermsKnown ? Math.round(rawLoan) : Math.round(contractPrice * DEFAULT_LTV)
  const originalDownPayment = contractPrice - originalLoanAmount
  const ltv = contractPrice > 0 ? originalLoanAmount / contractPrice : DEFAULT_LTV

  // ── Option 1: SELLER REDUCES to the appraised value ──────────────────────────
  // Price is re-cut to the appraisal. The lender re-bases the loan on the new
  // (lower) price at the same LTV, so the buyer's down payment and cash-to-close
  // both DROP. The seller absorbs the full gap.
  const o1NewPrice = appraisalValue
  const o1NewLoan  = Math.round(appraisalValue * ltv)
  const o1NewDown  = o1NewPrice - o1NewLoan
  const o1BuyerCashDelta = o1NewDown - originalDownPayment // negative → buyer needs LESS cash
  const sellerReduces: AppraisalGapOption = {
    key: "seller_reduces",
    title: "Seller reduces to the appraised value",
    favors: "buyer",
    numbers: [
      num("New purchase price", o1NewPrice),
      num("Revised loan", o1NewLoan),
      num("Revised down payment", o1NewDown),
      num("Buyer cash change", o1BuyerCashDelta),
      num("Seller gives up", gapAmount),
    ],
    pros: [
      "Deal closes with no new cash from the buyer — often the fastest path to the table.",
      "Loan re-bases cleanly on the appraised value; no appraisal-contingency exposure remains.",
      `Buyer's cash-to-close drops by about ${usd(Math.abs(o1BuyerCashDelta))}.`,
    ],
    cons: [
      `Seller nets ${usd(gapAmount)} less than the contract.`,
      "Hardest sell in a hot market or when the seller has other backup offers.",
    ],
    fallbackFraming:
      `Ask the seller to meet the appraisal at ${usd(o1NewPrice)}. The buyer keeps their financing, their down payment falls to about ${usd(o1NewDown)}, and the appraisal contingency clears itself. The trade is ${usd(gapAmount)} off the seller's net.`,
  }

  // ── Option 2: BUYER BRINGS CASH to cover the gap ─────────────────────────────
  // Price holds at contract. The lender caps the loan against the appraised value,
  // so the buyer commits to bring the gap in cash ABOVE the appraised value — the
  // "appraisal-gap coverage" clause. Their original down PLUS the gap is the new
  // cash-to-close; the loan drops by the gap and stays comfortably financeable.
  const o2GapCoverage       = gapAmount
  const o2RevisedCashToClose = originalDownPayment + gapAmount
  const o2NewLoan           = contractPrice - o2RevisedCashToClose // = originalLoan - gap
  const buyerCovers: AppraisalGapOption = {
    key: "buyer_covers",
    title: "Buyer brings cash to cover the gap",
    favors: "seller",
    numbers: [
      num("Purchase price (unchanged)", contractPrice),
      num("Appraisal-gap coverage", o2GapCoverage),
      num("Revised cash to close", o2RevisedCashToClose),
      num("Revised loan", o2NewLoan),
    ],
    pros: [
      "Seller keeps the full contract price — strongest option to hold the deal exactly as written.",
      "Backs an appraisal-gap coverage clause the buyer likely already anticipated in a competitive offer.",
    ],
    cons: [
      `Buyer needs about ${usd(o2GapCoverage)} more cash at closing (revised cash-to-close ~${usd(o2RevisedCashToClose)}).`,
      "Only works if the buyer has the reserves — confirm proof of funds before proposing it.",
      "Buyer is paying over the appraised value, which they may resist.",
    ],
    fallbackFraming:
      `Hold the price at ${usd(contractPrice)} and have the buyer cover the ${usd(o2GapCoverage)} gap in cash above the appraisal. Their cash-to-close rises to about ${usd(o2RevisedCashToClose)} and the loan settles near ${usd(o2NewLoan)}. Confirm the buyer's reserves before you float it.`,
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
      ltv: Math.round(ltv * 1000) / 1000,
      originalDownPayment,
      originalLoanAmount,
      loanTermsKnown,
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

  if (!context.loanTermsKnown) {
    lines.push("Note: no loan amount on file — figures assume a conventional 20%-down purchase. Confirm the buyer's actual financing.")
    lines.push("")
  }
  lines.push(`Bottom line: ${bottomLine}`)
  return lines.join("\n")
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

  // Pure math → the three priced options.
  const copilot = composeAppraisalGapOptions({
    contractPrice: args.contractPrice,
    appraisalValue: args.appraisalValue,
    loanAmount: args.loanAmount ?? null,
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
