// lib/kernel/anniversary-equity.ts
//
// ANNIVERSARY EQUITY REPORT — the Sphere-of-Influence lifetime-customer flywheel.
//
// On (or near, ±windowDays) the yearly anniversary of a past client's closing, the
// Sphere Manager generates a personal home-equity update — estimated current value vs
// what they paid, and the equity story — and delivers it three ways:
//
//   (a) PORTAL VALUE CARD — pushPortalValueCard (updateType "equity_report"): the
//       client's portal always has something fresh and REAL worth returning to.
//   (b) ONE GATED PROPOSAL — proposeClientMessage (agentKind 'sphere_of_influence',
//       audience 'agent'): the agent-facing proposal whose BODY is the ready-to-send
//       anniversary note (approving delivers it to the client's portal via the
//       recipient contact) and whose RATIONALE carries the agent brief (the equity
//       numbers + honesty flags). NEVER auto-sends — gated only.
//   (c) OPTIONAL AVATAR VIDEO — the EXISTING D-ID + ElevenLabs pipeline
//       (lib/video/intro-video-reactor dispatchAnniversaryVideo — NEVER HeyGen),
//       only when the agent has a voice/avatar profile (agent_voice_profiles
//       elevenlabs_voice_id + did_photo_url/did_video_url). No profile → text-only,
//       counted as skippedNoAvatar. The reactor's own ledger (agent_intro_videos,
//       m121 unique index) keeps the video idempotent per calendar year.
//
// HONESTY RULES (non-negotiable):
//   · The current value comes from a REAL valuation source (RentCast AVM by default,
//     key resolved from integration_credentials or RENTCAST_API_KEY env — never
//     written to files or logged). No valuation available → the contact is SKIPPED
//     and counted as skippedNoValuation. NEVER a fabricated value.
//   · Equity math is honest about loan data: when the original loan amount is on
//     file (transaction_lenders.loan_amount), equity = est. value − est. remaining
//     balance (conservative ~1.5%/yr principal paydown approximation — the SAME
//     assumption lib/avm/provider-chain.ts computeEquityRatio documents). When NOT
//     on file, the report shows APPRECIATION ONLY and says so in plain words.
//   · Every number is labeled an ESTIMATE and the note says "this is not an
//     appraisal". No financial advice, Fair-Housing-safe, warm.
//
// IDEMPOTENT: one report per contact per YEAR — the gated proposal's rationale
// carries the tag `ANNIVERSARY EQUITY [<year>]` (year = the calendar year of the
// anniversary date, so a late-December run and an early-January re-run dedupe to
// the same report). Withdrawn contacts excluded.
//
// NOT server-only (simulator-driven). Pure helpers carry the math; the runner does
// I/O. Valuation fetcher, copy generator, and video dispatcher are injectable seams.

import { createServiceClient } from "@/lib/supabase/service"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Anniversary window: the close-date month/day within ±this many days of now. */
export const ANNIVERSARY_WINDOW_DAYS = 7

/** Conservative principal-paydown approximation (~1.5%/yr of the ORIGINAL loan) —
 *  the same documented assumption as lib/avm/provider-chain.ts computeEquityRatio.
 *  It deliberately UNDER-estimates paydown so the equity estimate stays honest. */
export const ANNUAL_PAYDOWN_PCT = 0.015

/** The rationale tag prefix that carries the per-(contact, year) idempotency key. */
export const ANNIVERSARY_EQUITY_TAG = "ANNIVERSARY EQUITY"

// ─── Pure core ──────────────────────────────────────────────────────────────────

export interface EquityLineInput {
  /** What the client paid (transactions.purchase_price). */
  purchasePrice: number
  /** Optional explicit close price when it differs from purchase_price. */
  closePrice?: number | null
  /** REAL estimated current value (from the valuation fetcher — never fabricated). */
  estimatedValue: number
  /** ORIGINAL loan amount when known (transaction_lenders.loan_amount); null/absent
   *  means we have NO payoff data — the line degrades to appreciation-only. */
  originalLoanAmount?: number | null
  /** Whole years since closing (the anniversary number). */
  yearsHeld: number
}

export interface EquityLine {
  /** The purchase basis used (closePrice when provided, else purchasePrice). */
  basisPrice: number
  /** est. value − basis. Can be negative — honesty over flattery. */
  appreciation: number
  /** appreciation / basis × 100, rounded to 1 decimal. */
  appreciationPct: number
  /** true only when the original loan amount was on file. */
  hasLoanData: boolean
  /** est. remaining balance (original loan − ~1.5%/yr paydown), null without loan data. */
  estimatedRemainingBalance: number | null
  /** est. value − est. remaining balance; NULL when no loan data (appreciation only). */
  estimatedEquity: number | null
  /** Which honest basis the numbers stand on. */
  equityBasis: "value_minus_estimated_balance" | "appreciation_only"
}

/**
 * Pure: the equity line for one past client. Honest about payoff data — when the
 * original loan amount is unknown, estimatedEquity is NULL and the basis flag says
 * "appreciation_only" so every caller (note, card, brief) tells the truth about it.
 */
export function computeEquityLine(input: EquityLineInput): EquityLine {
  const basisPrice = input.closePrice != null && input.closePrice > 0 ? input.closePrice : input.purchasePrice
  const appreciation = input.estimatedValue - basisPrice
  const appreciationPct = basisPrice > 0 ? Math.round((appreciation / basisPrice) * 1000) / 10 : 0

  const loan = input.originalLoanAmount
  if (loan != null && loan > 0) {
    const remainingPct = Math.max(0, 1 - ANNUAL_PAYDOWN_PCT * Math.max(0, input.yearsHeld))
    const estimatedRemainingBalance = Math.round(loan * remainingPct)
    return {
      basisPrice,
      appreciation,
      appreciationPct,
      hasLoanData: true,
      estimatedRemainingBalance,
      estimatedEquity: input.estimatedValue - estimatedRemainingBalance,
      equityBasis: "value_minus_estimated_balance",
    }
  }
  return {
    basisPrice,
    appreciation,
    appreciationPct,
    hasLoanData: false,
    estimatedRemainingBalance: null,
    estimatedEquity: null,
    equityBasis: "appreciation_only",
  }
}

export interface AnniversaryHit {
  /** true when an anniversary (≥1 year) of closeDate falls within ±windowDays of now. */
  isAnniversary: boolean
  /** Which anniversary (1 = first year). 0 when not an anniversary. */
  anniversaryNumber: number
  /** The calendar year of the anniversary date itself — the idempotency year
   *  (a Dec-28 anniversary checked on Jan 2 still keys to the December year). */
  anniversaryYear: number
  /** Signed days from now to the anniversary (negative = already passed). */
  daysToAnniversary: number
}

const DAY_MS = 86_400_000

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * Pure: does the close date's month/day land within ±windowDays of `now`, at least
 * one full year after closing? Handles the year rollover (a late-December closing
 * checked in early January matches the PREVIOUS calendar year's anniversary).
 * No fabrication: an invalid/missing close date is simply not an anniversary.
 */
export function anniversaryWindow(
  closeDate: string | Date,
  now: Date,
  windowDays: number = ANNIVERSARY_WINDOW_DAYS,
): AnniversaryHit {
  const none: AnniversaryHit = { isAnniversary: false, anniversaryNumber: 0, anniversaryYear: 0, daysToAnniversary: 0 }
  const close = closeDate instanceof Date ? closeDate : new Date(closeDate)
  if (Number.isNaN(close.getTime())) return none

  const nowDay = utcMidnight(now)
  // The anniversary near `now` lives in one of three candidate years (rollover-safe).
  for (const year of [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const n = year - close.getUTCFullYear()
    if (n < 1) continue // the closing year itself (or the future) is never an anniversary
    const anniv = Date.UTC(year, close.getUTCMonth(), close.getUTCDate())
    const diffDays = Math.round((anniv - nowDay) / DAY_MS)
    if (Math.abs(diffDays) <= windowDays) {
      return { isAnniversary: true, anniversaryNumber: n, anniversaryYear: year, daysToAnniversary: diffDays }
    }
  }
  return none
}

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

export interface EquityNoteArgs {
  firstName: string | null
  /** Real address when on file — never invented; the note degrades to "your home". */
  address: string | null
  anniversaryNumber: number
  estimatedValue: number
  line: EquityLine
}

/**
 * Pure: the deterministic FALLBACK anniversary note (persona generator may override).
 * Warm, Fair-Housing-safe, no financial-advice claims. Every number is labeled an
 * ESTIMATE and the note says this is NOT an appraisal. When loan data is missing it
 * reports appreciation only AND says so — honesty over noise.
 */
export function composeEquityNote(args: EquityNoteArgs): { subject: string; body: string } {
  const first = args.firstName?.trim() ? ` ${args.firstName.trim()}` : ""
  const home = args.address?.trim() ? args.address.trim() : "your home"
  const n = args.anniversaryNumber
  const { line } = args

  const valueSentence =
    `Today ${home} has an estimated value of about ${fmtUsd(args.estimatedValue)} — ` +
    (line.appreciation >= 0
      ? `roughly ${fmtUsd(line.appreciation)} (${line.appreciationPct}%) more than the ${fmtUsd(line.basisPrice)} you paid.`
      : `compared with the ${fmtUsd(line.basisPrice)} you paid. Markets move in both directions, and this estimate currently sits below your purchase price.`)

  const equitySentence = line.hasLoanData && line.estimatedEquity != null
    ? `Based on your original loan amount, your estimated equity is around ${fmtUsd(line.estimatedEquity)} (after an estimated remaining balance of about ${fmtUsd(line.estimatedRemainingBalance ?? 0)}).`
    : `We don't have your loan details on file, so this update looks at estimated value growth only — not your loan balance or true equity.`

  const body =
    `Hi${first} — happy ${ordinal(n)} home anniversary! ` +
    `${valueSentence} ${equitySentence} ` +
    `These figures are estimates, not an appraisal, and not financial advice — if you'd like a precise picture or just want to catch up, I'm always glad to walk through it with you.`

  return { subject: `Happy ${ordinal(n)} home anniversary — your annual equity update`, body }
}

/**
 * Pure: the agent brief that rides the proposal's rationale — who, which
 * anniversary, the honest numbers, and what the agent gets by approving.
 */
export function composeAgentBrief(args: {
  fullName: string
  address: string | null
  anniversaryNumber: number
  estimatedValue: number
  valuationSource: string
  line: EquityLine
}): string {
  const who = args.fullName.trim() || "a past client"
  const home = args.address?.trim() ? ` (${args.address.trim()})` : ""
  const equityLine = args.line.hasLoanData && args.line.estimatedEquity != null
    ? `est. equity ${fmtUsd(args.line.estimatedEquity)} (value − est. remaining balance ${fmtUsd(args.line.estimatedRemainingBalance ?? 0)})`
    : `equity not computed — no original loan amount on file, so the note honestly reports appreciation only`
  return (
    `${ordinal(args.anniversaryNumber)} closing anniversary for ${who}${home}. ` +
    `Est. current value ${fmtUsd(args.estimatedValue)} (source: ${args.valuationSource}) vs paid ${fmtUsd(args.line.basisPrice)} → ` +
    `appreciation ${fmtUsd(args.line.appreciation)} (${args.line.appreciationPct}%); ${equityLine}. ` +
    `All figures are estimates, not an appraisal. Approve to deliver the anniversary note to their portal — the lifetime relationship gets its yearly value moment.`
  )
}

// ─── Injectable seams ───────────────────────────────────────────────────────────

/** REAL valuation seam. Default is RentCast-backed (lib/property/rentcast
 *  getRentcastAVM — key from integration_credentials or RENTCAST_API_KEY env,
 *  never logged/persisted by this play). Returns null when no real estimate is
 *  available; the runner then SKIPS the contact (skippedNoValuation) — it NEVER
 *  invents a value. The simulator injects fixed numbers (no vendor spend). */
export type ValuationFetcher = (args: { brokerageId: string; address: string }) => Promise<{
  value: number
  rangeLow?: number | null
  rangeHigh?: number | null
  source: string
} | null>

/** Avatar-video seam. Default rides the EXISTING D-ID + ElevenLabs pipeline
 *  (dispatchAnniversaryVideo) — NEVER HeyGen. The simulator injects a recorder. */
export type AnniversaryVideoDispatcher = (args: {
  brokerageId: string
  contactId: string
  /** agents.id (transactions.agent_id) — the reactor resolves users.id itself. */
  agentId: string
  yearsAgo: number
}) => Promise<{ ok: boolean; status: string }>

// ─── Live runner ────────────────────────────────────────────────────────────────

export interface AnniversaryEquityResult {
  /** Closed transactions examined. */
  scanned: number
  /** Transactions whose close date is inside the anniversary window. */
  anniversariesDetected: number
  /** Gated proposals created (one per contact per year). */
  reportsProposed: number
  /** Portal value cards pushed (updateType "equity_report"). */
  portalCardsPushed: number
  /** Personalized D-ID + ElevenLabs anniversary videos dispatched. */
  videosDispatched: number
  /** Text-only deliveries — the agent has no voice/avatar profile configured. */
  skippedNoAvatar: number
  /** Honest skips — no REAL valuation was available (no key / no result / no address). */
  skippedNoValuation: number
  /** Skips — the transaction has no purchase price on file (no basis, no fabrication). */
  skippedNoPurchasePrice: number
  /** Withdrawn contacts are never touched. */
  skippedWithdrawn: number
  /** Same (contact, year) already reported — idempotent re-run. */
  skippedDuplicate: number
}

interface TxRow {
  id: string
  deal_name: string | null
  property_address: string | null
  purchase_price: number | string | null
  close_date: string | null
  buyer_contact_id: string | null
  contact_id: string | null
  listing_id: string | null
  agent_id: string | null
}

/**
 * One Anniversary Equity pass for a brokerage. For each CLOSED transaction whose
 * close date hits the yearly anniversary window, compute the honest equity line
 * from a REAL valuation, push the portal value card, propose ONE gated agent-facing
 * report (the ready-to-send note), and — when the agent's avatar/voice is
 * configured — dispatch the existing D-ID + ElevenLabs anniversary video.
 * Idempotent per (contact, anniversary-year). Withdrawn excluded. No fabrication.
 */
export async function runAnniversaryEquity(
  brokerageId: string,
  opts: {
    now?: Date
    windowDays?: number
    valuationFetcher?: ValuationFetcher
    copyGenerator?: CopyGenerator
    videoDispatcher?: AnniversaryVideoDispatcher
    /** Scope the pass to ONE contact's closed transactions (voice "send the Garcias
     *  their equity report"). Same logic, same gate, same idempotency — just the
     *  buyer/contact filter applied at the source so no other contact is touched. */
    contactId?: string
  } = {},
  client?: Svc,
): Promise<AnniversaryEquityResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const windowDays = opts.windowDays ?? ANNIVERSARY_WINDOW_DAYS
  const result: AnniversaryEquityResult = {
    scanned: 0, anniversariesDetected: 0, reportsProposed: 0, portalCardsPushed: 0,
    videosDispatched: 0, skippedNoAvatar: 0, skippedNoValuation: 0,
    skippedNoPurchasePrice: 0, skippedWithdrawn: 0, skippedDuplicate: 0,
  }

  // REAL RentCast-backed default — key resolved inside getRentcastAVM from
  // integration_credentials or RENTCAST_API_KEY env (never logged/persisted here).
  // No key or no result → null → honest skip. The simulator injects fixed numbers.
  const fetchValuation: ValuationFetcher = opts.valuationFetcher ?? (async ({ brokerageId: bid, address }) => {
    const { getRentcastAVM } = await import("@/lib/property/rentcast")
    const avm = await getRentcastAVM({ brokerageId: bid, address })
    if (!avm.value || avm.value <= 0) return null
    return { value: avm.value, rangeLow: avm.rangeLow, rangeHigh: avm.rangeHigh, source: "rentcast" }
  })

  // EXISTING D-ID + ElevenLabs render path (intro-video-reactor) — NEVER HeyGen.
  const dispatchVideo: AnniversaryVideoDispatcher = opts.videoDispatcher ?? (async (d) => {
    const { dispatchAnniversaryVideo } = await import("@/lib/video/intro-video-reactor")
    const r = await dispatchAnniversaryVideo({
      brokerageId: d.brokerageId, contactId: d.contactId, agentId: d.agentId,
      yearsAgo: d.yearsAgo, delivery: "portal",
    })
    return { ok: r.ok, status: r.status }
  })

  // Past clients = CLOSED transactions with a close date. The closed deal IS the
  // proof of the relationship (same source idle-hands' anniversary scan uses).
  const { data: rows } = await supabase
    .from("transactions")
    .select("id, deal_name, property_address, purchase_price, close_date, buyer_contact_id, contact_id, listing_id, agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "closed")
    .not("close_date", "is", null)
    .limit(500)

  const txns = (rows ?? []) as TxRow[]
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
  const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")

  // One report per CONTACT per year even when multiple closed rows exist this pass.
  const handledThisPass = new Set<string>()

  for (const t of txns) {
    result.scanned += 1
    const contactId = t.buyer_contact_id ?? t.contact_id
    if (!contactId || !t.close_date) continue

    const hit = anniversaryWindow(t.close_date, now, windowDays)
    if (!hit.isAnniversary) continue
    result.anniversariesDetected += 1

    const passKey = `${contactId}:${hit.anniversaryYear}`
    if (handledThisPass.has(passKey)) { result.skippedDuplicate += 1; continue }

    // Contact — withdrawn contacts are never touched.
    const { data: c } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, contact_type, nurture_status")
      .eq("id", contactId)
      .maybeSingle()
    if (!c) continue
    if (((c as { nurture_status?: string | null }).nurture_status ?? "").toLowerCase() === "withdrawn") {
      result.skippedWithdrawn += 1
      continue
    }

    // IDEMPOTENCY — one report per (contact, anniversary-year). The proposal's
    // rationale carries the year tag; no time window needed (the year IS the key).
    const tag = `${ANNIVERSARY_EQUITY_TAG} [${hit.anniversaryYear}]`
    const { data: dup } = await supabase
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("recipient_contact_id", contactId)
      .ilike("rationale", `${tag}%`)
      .limit(1)
      .maybeSingle()
    if (dup) { result.skippedDuplicate += 1; handledThisPass.add(passKey); continue }

    // Purchase basis — no purchase price means no honest comparison; skip.
    const purchasePrice = t.purchase_price != null ? Number(t.purchase_price) : null
    if (!purchasePrice || purchasePrice <= 0) { result.skippedNoPurchasePrice += 1; continue }

    // Address — the transaction's, else the linked listing's. No address → no
    // valuation is possible; honest skip.
    let address = t.property_address?.trim() || null
    if (!address && t.listing_id) {
      const { data: lst } = await supabase.from("listings").select("address").eq("id", t.listing_id).maybeSingle()
      address = (lst as { address?: string | null } | null)?.address?.trim() || null
    }
    if (!address) { result.skippedNoValuation += 1; continue }

    // REAL valuation — or an honest skip. NEVER a fabricated value.
    let valuation: Awaited<ReturnType<ValuationFetcher>> = null
    try { valuation = await fetchValuation({ brokerageId, address }) } catch { valuation = null }
    if (!valuation || !valuation.value || valuation.value <= 0) { result.skippedNoValuation += 1; continue }

    // Original loan amount when on file (transaction_lenders) — else the line
    // degrades honestly to appreciation-only.
    const { data: lender } = await supabase
      .from("transaction_lenders")
      .select("loan_amount")
      .eq("transaction_id", t.id)
      .maybeSingle()
    const loanAmount = (lender as { loan_amount?: number | string | null } | null)?.loan_amount
    const originalLoanAmount = loanAmount != null ? Number(loanAmount) : null

    const line = computeEquityLine({
      purchasePrice,
      estimatedValue: valuation.value,
      originalLoanAmount,
      yearsHeld: hit.anniversaryNumber,
    })

    const firstName = (c as { first_name?: string | null }).first_name ?? null
    const fullName = [
      (c as { first_name?: string | null }).first_name,
      (c as { last_name?: string | null }).last_name,
    ].filter(Boolean).join(" ").trim()

    // Persona-aware note with the deterministic fallback — facts are the REAL
    // computed numbers only; estimates labeled, "not an appraisal" preserved.
    const fallback = composeEquityNote({
      firstName, address, anniversaryNumber: hit.anniversaryNumber,
      estimatedValue: valuation.value, line,
    })
    const facts = [
      `It is the ${ordinal(hit.anniversaryNumber)} anniversary of their home closing`,
      `Estimated current value: ${fmtUsd(valuation.value)} (an estimate, not an appraisal)`,
      `They paid ${fmtUsd(line.basisPrice)}; estimated change since purchase: ${fmtUsd(line.appreciation)} (${line.appreciationPct}%)`,
      line.hasLoanData && line.estimatedEquity != null
        ? `Estimated equity: ${fmtUsd(line.estimatedEquity)} (estimated remaining balance ${fmtUsd(line.estimatedRemainingBalance ?? 0)})`
        : `No loan details on file — the update reports estimated value growth only, not loan balance or true equity, and must say so`,
      `These figures are estimates, not an appraisal, and not financial advice`,
    ]
    const draft = await generatePersonaCopy(
      {
        goal: "a warm yearly home-anniversary equity update for a past client (estimates clearly labeled; explicitly 'not an appraisal'; no financial advice; no pressure)",
        facts,
        channel: "portal",
        persona: {
          name: fullName || null,
          audience: "past_client",
          situation: `${ordinal(hit.anniversaryNumber)} home anniversary`,
        },
        words: 110,
      },
      fallback,
      { generator: opts.copyGenerator },
    )

    // (b) ONE GATED agent-facing proposal — the BODY is the ready-to-send note
    // (approving writes it to the client's portal via the recipient contact);
    // the RATIONALE carries the year tag + the agent brief. Never auto-sends.
    const brief = composeAgentBrief({
      fullName, address, anniversaryNumber: hit.anniversaryNumber,
      estimatedValue: valuation.value, valuationSource: valuation.source, line,
    })
    const proposed = await proposeClientMessage({
      brokerageId,
      agentKind: "sphere_of_influence",
      entityType: "contact",
      entityId: contactId,
      recipientContactId: contactId,
      audience: "agent",
      subject: draft.subject ?? fallback.subject,
      body: draft.body,
      rationale: `${tag} — Sphere Manager: ${brief}`,
      channel: "portal",
    }, supabase)
    if (!proposed.ok) continue // nothing real landed — don't push a card for a failed report
    result.reportsProposed += 1
    handledThisPass.add(passKey)

    // (a) PORTAL VALUE CARD — the same REAL equity story, always on the portal. CLIENT-FRAMING
    // DOCTRINE: the card always ends with a WARM, conversation-STARTING line that routes the
    // seller to their agent — never a bare number. Sensitive equity (low/negative) reads as
    // "worth a real conversation", positive as "great position — let's make the most of it".
    const { valueNewsTone, clientSafeCtaLine } = await import("@/lib/kernel/client-framing")
    const equityTone = valueNewsTone({ value: line.estimatedEquity ?? line.appreciation ?? null })
    const cardSummary = `${draft.body}\n\n${clientSafeCtaLine(equityTone, "your home's equity")}`
    const card = await pushPortalValueCard({
      brokerageId,
      contactId,
      listingId: t.listing_id ?? null,
      title: draft.subject ?? fallback.subject,
      summary: cardSummary,
      updateType: "equity_report",
      metadata: {
        source: "anniversary_equity",
        anniversary_number: hit.anniversaryNumber,
        anniversary_year: hit.anniversaryYear,
        transaction_id: t.id,
        purchase_price: line.basisPrice,
        estimated_value: valuation.value,
        valuation_source: valuation.source,
        appreciation: line.appreciation,
        appreciation_pct: line.appreciationPct,
        estimated_equity: line.estimatedEquity,
        estimated_remaining_balance: line.estimatedRemainingBalance,
        equity_basis: line.equityBasis,
        not_an_appraisal: true,
        agent_summary_id: proposed.id ?? null,
      },
      now,
    }, supabase)
    if (card.pushed) result.portalCardsPushed += 1

    // (c) OPTIONAL avatar video — EXISTING D-ID + ElevenLabs path only (NEVER
    // HeyGen), and ONLY when the agent's voice/avatar profile is configured.
    // agent_voice_profiles.agent_id FKs agents(id) = transactions.agent_id.
    if (t.agent_id) {
      const { data: profile } = await supabase
        .from("agent_voice_profiles")
        .select("elevenlabs_voice_id, did_photo_url, did_video_url")
        .eq("agent_id", t.agent_id)
        .maybeSingle()
      const p = profile as { elevenlabs_voice_id?: string | null; did_photo_url?: string | null; did_video_url?: string | null } | null
      if (p?.elevenlabs_voice_id && (p.did_photo_url || p.did_video_url)) {
        try {
          const v = await dispatchVideo({
            brokerageId, contactId, agentId: t.agent_id, yearsAgo: hit.anniversaryNumber,
          })
          if (v.ok && v.status !== "skipped" && v.status !== "suppressed") result.videosDispatched += 1
          else result.skippedNoAvatar += v.ok ? 0 : 1
        } catch { /* the video is a bonus — never fail the report */ }
      } else {
        result.skippedNoAvatar += 1 // text-only: no avatar/voice configured
      }
    } else {
      result.skippedNoAvatar += 1 // text-only: no agent on the transaction
    }
  }

  return result
}
