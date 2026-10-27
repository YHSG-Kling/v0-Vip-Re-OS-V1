// lib/ai-isa/lifetime-change-action.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE LIFETIME CHANGE ACTION (wave 145, lane 145F — owner ruling 14, verbatim: "lifetimechangeaction for a sphere signal recorded
// would be the signal joins signal reactivations and refinance/in-app checking of equity (playbook like glide and realscout)").
//
// WHAT WAS THERE (audited at b364eb4b, orphan doctrine §1.2 — the half that was missing):
//   · the ONE life-change responder (lib/ai-isa/followup-arbiter.ts respondToLifeChangeSignal) answers a LIFETIME client with
//     `sphere_signal_recorded`: the signal JOINS signal_reactivations (contact arm). That half is BUILT and is not touched here.
//   · the only consumer of that row was the returning-customer loop (lib/kernel/returning-customer.ts), whose router sends an
//     `equity_milestone` to the Listing Concierge ("curious what your home is worth now?") and a `refinance_opportunity` — which
//     matches none of its patterns — to the client's prior ROLE ("ready to look again?" for a past buyer). A refinance signal never
//     reached a refinance answer, and no lifetime signal ever produced the in-app equity check the portal renders.
//   · the in-app pieces exist and are reused, never re-built: the property_valuation CAPABILITY (lib/avm/provider-chain.ts
//     requestPropertyValuation — LAW 3, never a vendor), the ONE equity calculator (lib/kernel/anniversary-equity.ts
//     computeEquityLine — honest appreciation-only degrade without a recorded loan), the portal value card (lib/kernel/portal-value.ts
//     pushPortalValueCard → transparency_updates, which the lifetime portal home renders in its "What's new" feed), the client
//     framing line (lib/kernel/client-framing.ts), the post-close MOMENT conductor (lib/sphere/followup-moments.ts — the planner +
//     the arbiter with this person's life-change signals as its SIGNAL slice, which ranks professional_referral / education /
//     market_update / agent_intervention for a refinance or equity signal), and the professional_referral experience it executes
//     (lib/ai-isa/lead-action-plan.ts prepareProfessionalIntroduction — the agent offers a licensed lender the client CHOOSES).
//
// WHAT THIS DOES, per recorded lifetime signal whose kind puts the home's value in play (equity / refinance / home_sale / moving):
//   1. THE IN-APP EQUITY CHECK — an ESTIMATE from VERIFIED inputs only: the closed deal where this client BOUGHT the home they own
//      (price + close date, tenant-pinned), the loan amount recorded on that deal (transaction_lenders, else transactions), and
//      requestPropertyValuation for today's value. It lands in their portal as ONE card, labelled: an estimate, not an appraisal, not a
//      payoff figure, not an offer; equity only when a loan amount is on file (else "value only", said so). NO RATE IS EVER QUOTED OR
//      MODELLED HERE (mortgage skill: a rate is a lender's quote, subject to change until locked) — refinance is education + an
//      introduction to a licensed professional. A value check inside the tenant's value-check window is REUSED (no second purchase).
//   2. THE PLAYBOOK (Glide / RealScout's homeowner loop, on our survivors): equity estimate · refinance education (client education
//      module persona_lifetime_equity) · referral to a licensed mortgage professional (professional_referral — RESPA §8: no fee, the
//      client chooses) · market review · listing consultation. It is a MENU with evidence — the CHOICE among them is the arbiter's.
//   3. For equity / refinance (the kinds this action OWNS): ONE governed post-close MOMENT is opened for the person (a
//      lifetime_customer_touchpoints `custom` row the conductor arbitrates — never an isolated follow-up engine, never a fixed
//      timetable) and the reactivation row is CONSUMED, so the returning-customer loop does not answer a refinance with "ready to look
//      again?". home_sale / moving keep the returning-customer loop's Listing Concierge re-engagement (the listing-consultation step);
//      this action adds only the equity check and stamps the row.
// Ledgered once per signal row (withActionLedger, `sphere.lifetime_change.playbook`, Sphere of Influence) — a retry replays. Every
// read is tenant-pinned and read for its error; every conditional write is COUNTED. Never throws.
//
// Not server-only: scripts/lifetime-signals-guard.ts drives it in memory with injected seams.

import { computeEquityLine, type EquityLine } from "@/lib/kernel/anniversary-equity"
import { isReengageableLifetime, type ContactLite } from "@/lib/kernel/returning-customer"
import { LIFE_CHANGE_SIGNAL_KINDS, type LifeChangeKind } from "@/lib/ai-isa/followup-arbiter"
import { usd } from "@/lib/format/money"

type Svc = { from: (table: string) => any }

const DAY_MS = 86_400_000

/** The kinds whose lifetime action includes the in-app equity check (the home's value is the question). */
const EQUITY_CHECK_KINDS: ReadonlySet<LifeChangeKind> = new Set<LifeChangeKind>(["equity", "refinance", "home_sale", "moving"])
/** The kinds this action OWNS end to end (moment + consume). home_sale / moving stay with the Listing Concierge re-engagement. */
const PLAYBOOK_OWNED_KINDS: ReadonlySet<LifeChangeKind> = new Set<LifeChangeKind>(["equity", "refinance"])
/** The portal card's update_type — its own play tag (portal-value.ts idempotency half). */
const EQUITY_CHECK_UPDATE_TYPE = "equity_check"
/** A value check already on the portal from either play — reused inside the tenant's value-check window. */
const VALUE_CARD_TYPES = [EQUITY_CHECK_UPDATE_TYPE, "equity_trigger"] as const
/** The client-education module that teaches refinancing for a lifetime client (lib/education/client-education-curriculum.ts). */
const REFINANCE_EDUCATION_MODULE = "persona_lifetime_equity"

type LifetimePlaybookStep = "equity_estimate" | "refinance_education" | "professional_referral" | "market_review" | "listing_consultation"

interface LifetimePlaybookItem {
  step: LifetimePlaybookStep
  available: boolean
  why: string
  /** The survivor that delivers it. */
  via: string
}

interface LifetimeEquityEstimate {
  kind: "estimate"
  notAnAppraisal: true
  estimatedValue: number
  valueLow: number | null
  valueHigh: number | null
  valuationSource: string
  valuationConfidence: number | null
  valuedAt: string
  purchasePrice: number
  closeDate: string
  yearsHeld: number
  line: EquityLine
  inputs: { transactionId: string; address: string; loanAmountSource: "transaction_lenders.loan_amount" | "transactions.loan_amount" | null }
}

/** PURE. The kind a recorded signal bears: the responder's own stamp first (signal_data.kind), else the ONE vocabulary. */
function lifetimeSignalKind(signalType: string | null | undefined, signalData: Record<string, unknown> | null | undefined): LifeChangeKind | null {
  const stamped = typeof signalData?.kind === "string" ? (signalData.kind as string) : null
  const known: readonly LifeChangeKind[] = ["moving", "home_sale", "buying", "refinance", "equity", "life_event", "engagement"]
  if (stamped && (known as readonly string[]).includes(stamped)) return stamped as LifeChangeKind
  return LIFE_CHANGE_SIGNAL_KINDS[String(signalType ?? "").toLowerCase()] ?? null
}

/**
 * PURE. The homeowner playbook for a kind — a menu with its evidence, never a schedule. `available` is false when the inputs for a
 * step are missing (no estimate → no equity step; no agent of record → nobody to make the introduction), and the reason says so.
 */
function lifetimePlaybookFor(kind: LifeChangeKind, a: { hasEstimate: boolean; hasAgent: boolean }): LifetimePlaybookItem[] {
  if (!EQUITY_CHECK_KINDS.has(kind)) return []
  const out: LifetimePlaybookItem[] = []
  out.push({
    step: "equity_estimate", available: a.hasEstimate,
    why: a.hasEstimate
      ? "an ESTIMATE from verified inputs (the closed purchase, the recorded loan amount when on file, today's property-valuation answer) — not an appraisal, not a payoff figure, not an offer"
      : "no estimate: the inputs it needs are not all verified (see the reason) — nothing is guessed",
    via: "lib/avm/provider-chain.ts requestPropertyValuation + lib/kernel/anniversary-equity.ts computeEquityLine → the portal card",
  })
  if (kind === "refinance" || kind === "equity") {
    out.push({ step: "refinance_education", available: true, why: "how refinancing and borrowing against equity work — closing costs, break-even, rate locks; rates and eligibility come only from a licensed lender's Loan Estimate", via: `client education module ${REFINANCE_EDUCATION_MODULE}` })
    out.push({
      step: "professional_referral", available: a.hasAgent,
      why: a.hasAgent
        ? "an introduction to a licensed (NMLS) mortgage professional the client chooses — the agent offers it; no referral fee is paid or received (RESPA §8)"
        : "no agent of record to offer the introduction — a referral is a person's introduction, never automated",
      via: "the professional_referral experience (lib/ai-isa/lead-action-plan.ts prepareProfessionalIntroduction), chosen by the arbiter",
    })
  }
  out.push({ step: "market_review", available: a.hasAgent, why: "a market review of their home and neighbourhood with their agent", via: "the market_update experience, chosen by the arbiter" })
  if (kind !== "refinance") out.push({ step: "listing_consultation", available: a.hasAgent, why: "a no-pressure listing consultation if they are thinking about selling", via: "the Listing Concierge (returning-customer re-engagement / listing appointment)" })
  return out
}

/** PURE. The in-app card — the real computed figures, each labelled for what it is; never a rate, never a promise. */
function composeEquityCheckCard(a: { firstName: string | null; estimate: LifetimeEquityEstimate; playbook: readonly LifetimePlaybookItem[] }): { title: string; summary: string } {
  const e = a.estimate
  const range = e.valueLow && e.valueHigh ? ` (range ${usd(e.valueLow)}–${usd(e.valueHigh)})` : ""
  const lines: string[] = [
    `${a.firstName ? `${a.firstName}, here` : "Here"} is your home's estimated value: ${usd(e.estimatedValue)}${range}, from an automated valuation on ${e.valuedAt.slice(0, 10)}. It is an estimate — not an appraisal and not an offer.`,
  ]
  if (e.line.estimatedEquity !== null) {
    lines.push(`Estimated equity: about ${usd(e.line.estimatedEquity)} — the estimated value minus an ESTIMATED remaining loan balance (the loan amount recorded at your purchase, less typical paydown). Your lender's payoff statement is the only exact balance.`)
  } else {
    const dir = e.line.appreciation >= 0 ? "above" : "below"
    lines.push(`We don't have your loan details, so we have not estimated your equity. Compared with your ${usd(e.purchasePrice)} purchase price, the estimate is ${usd(Math.abs(e.line.appreciation))} ${dir} it.`)
  }
  const steps = new Set(a.playbook.filter((p) => p.available).map((p) => p.step))
  if (steps.has("refinance_education") || steps.has("professional_referral")) {
    lines.push("Thinking about refinancing or borrowing against your equity? A short guide in your learning center explains the costs and the break-even, and your agent can introduce you to a licensed mortgage professional of your choosing — only a lender can quote a rate or confirm what you qualify for, and rates change until they are locked.")
  }
  if (steps.has("market_review") || steps.has("listing_consultation")) {
    lines.push(steps.has("listing_consultation")
      ? "Your agent can walk you through a market review — or a no-pressure listing consultation if you are thinking about selling."
      : "Your agent can walk you through a market review of your home and neighbourhood.")
  }
  return { title: "Your home's estimated value", summary: lines.join("\n\n") }
}

interface HomeTxn { id: string; property_address: string | null; purchase_price: number | string | null; close_date: string | null; buyer_contact_id: string | null; contact_id: string | null; deal_type: string | null; loan_amount: number | string | null }

/** PURE. The deal for the home this client OWNS — the newest closed deal they BOUGHT on (a seller-only client owns none of ours). */
function ownedHomeTransaction<T extends { buyer_contact_id?: string | null; contact_id?: string | null; deal_type?: string | null }>(rows: readonly T[], contactId: string): T | null {
  return rows.find((r) => r.buyer_contact_id === contactId)
    ?? rows.find((r) => r.contact_id === contactId && /buy|purchase/i.test(r.deal_type ?? ""))
    ?? null
}

export interface ValuationAnswer { value: number; rangeLow: number | null; rangeHigh: number | null; source: string; confidence: number | null; fetchedAt: string }
export interface LifetimeChangeDeps {
  /** The property_valuation capability (default: requestPropertyValuation). */
  valuation?: (req: { brokerageId: string; address: string; contactId: string }) => Promise<ValuationAnswer | null>
  pushCard?: typeof import("@/lib/kernel/portal-value").pushPortalValueCard
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  /** The tenant's sphere windows (default: loadFollowupPolicy). */
  windows?: { lifeEventWindowDays: number; valueCheckWindowDays: number }
}

type EquityOutcome = { state: "estimated"; estimate: LifetimeEquityEstimate } | { state: "unavailable"; reason: string }

/**
 * The equity ESTIMATE for one lifetime client, from verified inputs only. Never throws; an absent input is a named reason.
 */
async function estimateLifetimeEquity(svc: Svc, a: { brokerageId: string; contactId: string; now: Date }, deps: LifetimeChangeDeps = {}): Promise<EquityOutcome> {
  try {
    const { data: rows, error } = await svc.from("transactions")
      .select("id, property_address, purchase_price, close_date, buyer_contact_id, contact_id, deal_type, loan_amount")
      .eq("brokerage_id", a.brokerageId).eq("status", "closed").is("deleted_at", null).not("close_date", "is", null)
      .or(`buyer_contact_id.eq.${a.contactId},contact_id.eq.${a.contactId}`)
      .order("close_date", { ascending: false }).limit(10)
    if (error) return { state: "unavailable", reason: `closed-deal read refused: ${error.message}` }
    const home = ownedHomeTransaction((rows ?? []) as HomeTxn[], a.contactId)
    if (!home) return { state: "unavailable", reason: "no closed purchase with us on record — we only estimate the home a client bought with us" }
    const purchasePrice = home.purchase_price != null ? Number(home.purchase_price) : NaN
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) return { state: "unavailable", reason: "the closed deal carries no purchase price — no honest basis" }
    const address = home.property_address?.trim() || null
    if (!address || !home.close_date) return { state: "unavailable", reason: "the closed deal carries no address / close date — nothing to value" }

    const { data: lenders, error: lErr } = await svc.from("transaction_lenders").select("loan_amount").eq("transaction_id", home.id).order("created_at", { ascending: false }).limit(1)
    if (lErr) return { state: "unavailable", reason: `loan read refused: ${lErr.message}` }
    const lenderLoan = Number(((lenders ?? [])[0] as { loan_amount?: number | string | null } | undefined)?.loan_amount ?? NaN)
    const dealLoan = Number(home.loan_amount ?? NaN)
    const loan = Number.isFinite(lenderLoan) && lenderLoan > 0 ? lenderLoan : Number.isFinite(dealLoan) && dealLoan > 0 ? dealLoan : null
    const loanAmountSource = loan === null ? null : loan === lenderLoan ? "transaction_lenders.loan_amount" as const : "transactions.loan_amount" as const

    const value = await (deps.valuation ?? (async (req) => {
      const { requestPropertyValuation } = await import("@/lib/avm/provider-chain")
      const out = await requestPropertyValuation({ brokerageId: req.brokerageId, address: req.address, contactId: req.contactId, systemSource: "lifetime_change_action" })
      const v = out.valuation
      return v && v.value > 0 ? { value: v.value, rangeLow: v.rangeLow ?? null, rangeHigh: v.rangeHigh ?? null, source: v.source, confidence: v.confidence ?? null, fetchedAt: v.fetchedAt } : null
    }))({ brokerageId: a.brokerageId, address, contactId: a.contactId })
    if (!value || !(value.value > 0)) return { state: "unavailable", reason: "the property-valuation capability returned no value (no provider answered, or the tenant's budget is closed) — nothing is guessed" }

    const closeMs = Date.parse(home.close_date)
    const yearsHeld = Number.isFinite(closeMs) ? Math.max(0, Math.floor((a.now.getTime() - closeMs) / (365.25 * DAY_MS))) : 0
    const line = computeEquityLine({ purchasePrice, estimatedValue: value.value, originalLoanAmount: loan, yearsHeld })
    return {
      state: "estimated",
      estimate: {
        kind: "estimate", notAnAppraisal: true, estimatedValue: value.value, valueLow: value.rangeLow, valueHigh: value.rangeHigh,
        valuationSource: value.source, valuationConfidence: value.confidence, valuedAt: value.fetchedAt || a.now.toISOString(),
        purchasePrice, closeDate: home.close_date, yearsHeld, line, inputs: { transactionId: home.id, address, loanAmountSource },
      },
    }
  } catch (e) {
    return { state: "unavailable", reason: `estimate threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

interface ReactivationRow { id: string; contact_id: string; signal_type: string | null; signal_strength?: number | null; signal_data: Record<string, unknown> | null; triggered_at?: string | null }

interface LifetimeChangeActionResult {
  action: "acted" | "replayed" | "skipped" | "refused"
  reason: string
  kind: LifeChangeKind | null
  equity: { state: "estimated" | "reused" | "unavailable"; detail: string; cardId: string | null } | null
  momentId: string | null
  consumed: boolean
  playbook: LifetimePlaybookItem[]
}

async function windowsFor(svc: Svc, brokerageId: string, deps: LifetimeChangeDeps): Promise<{ lifeEventWindowDays: number; valueCheckWindowDays: number }> {
  if (deps.windows) return deps.windows
  const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
  const s = (await loadFollowupPolicy(svc as never, brokerageId)).policy.sphere
  return { lifeEventWindowDays: s.lifeEventWindowDays, valueCheckWindowDays: s.valueCheckWindowDays }
}

/**
 * ONE recorded lifetime signal → its lifetime change action (see the header). Tenant-pinned throughout; the brokerage is the
 * caller's verified tenant (the cron's tenant loop), never the row's payload. Never throws.
 */
async function runLifetimeChangeAction(
  svc: Svc,
  a: { brokerageId: string; signal: ReactivationRow; now?: Date },
  deps: LifetimeChangeDeps = {},
): Promise<LifetimeChangeActionResult> {
  const now = a.now ?? new Date()
  const kind = lifetimeSignalKind(a.signal.signal_type, a.signal.signal_data)
  const base: LifetimeChangeActionResult = { action: "skipped", reason: "", kind, equity: null, momentId: null, consumed: false, playbook: [] }
  try {
    if (!a.brokerageId || !a.signal?.id || !a.signal.contact_id) return { ...base, action: "refused", reason: "missing brokerage, signal or contact" }
    if (!kind || !EQUITY_CHECK_KINDS.has(kind)) return { ...base, reason: `kind ${kind ?? "unknown"} does not put the home's value in play — the returning-customer loop keeps it` }

    const { data: contact, error: cErr } = await svc.from("contacts")
      .select("id, first_name, last_name, contact_type, lifecycle_state, buyer_stage, nurture_status, agent_id")
      .eq("id", a.signal.contact_id).eq("brokerage_id", a.brokerageId).maybeSingle()
    if (cErr) return { ...base, action: "refused", reason: `contact read refused: ${cErr.message}` }
    if (!contact) return { ...base, action: "refused", reason: "contact not in this brokerage" }
    if (!isReengageableLifetime(contact as ContactLite)) return { ...base, reason: "not a re-engageable lifetime client (or withdrawn) — the returning-customer loop decides" }
    const agentId = ((contact as { agent_id?: string | null }).agent_id ?? null) as string | null
    const firstName = ((contact as { first_name?: string | null }).first_name ?? null) as string | null

    const windows = await windowsFor(svc, a.brokerageId, deps)
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    let out: LifetimeChangeActionResult = { ...base, action: "replayed", reason: "this signal's lifetime change action already ran — not acted on twice" }
    await ledger<LifetimeChangeActionResult>(
      {
        brokerageId: a.brokerageId, action: "sphere.lifetime_change.playbook", actor: { type: "manager", managerKey: "sphere_of_influence" },
        subject: { type: "contact", id: a.signal.contact_id }, idempotencyKey: `lifetime_change:${a.brokerageId}:${a.signal.id}`,
        reasonCode: "LIFETIME_TOUCH", reasonDetail: `${a.signal.signal_type ?? "signal"} (${kind}) — in-app equity check + homeowner playbook`.slice(0, 500),
        systemSource: "lifetime_change_action", policyKey: "followup_policy",
        detail: { signal_id: a.signal.id, signal_type: a.signal.signal_type, kind, owned: PLAYBOOK_OWNED_KINDS.has(kind) },
      },
      async () => {
        // ── 1 · the in-app equity check (reuse a recent value card; else estimate from verified inputs) ──
        let equity: NonNullable<LifetimeChangeActionResult["equity"]>
        let estimate: LifetimeEquityEstimate | null = null
        const since = new Date(now.getTime() - windows.valueCheckWindowDays * DAY_MS).toISOString()
        const { data: recent, error: rErr } = await svc.from("transparency_updates").select("id, update_type, created_at")
          .eq("brokerage_id", a.brokerageId).eq("contact_id", a.signal.contact_id).in("update_type", [...VALUE_CARD_TYPES])
          .eq("is_visible_to_client", true).gte("created_at", since).order("created_at", { ascending: false }).limit(1)
        if (rErr) equity = { state: "unavailable", detail: `recent value-card read refused: ${rErr.message} — no purchase made blind`, cardId: null }
        else if ((recent ?? []).length > 0) {
          const r0 = (recent ?? [])[0] as { id: string; update_type: string }
          equity = { state: "reused", detail: `a ${r0.update_type} value card is already on their portal inside the ${windows.valueCheckWindowDays}-day value-check window`, cardId: r0.id }
        } else {
          const est = await estimateLifetimeEquity(svc, { brokerageId: a.brokerageId, contactId: a.signal.contact_id, now }, deps)
          if (est.state === "unavailable") equity = { state: "unavailable", detail: est.reason, cardId: null }
          else {
            estimate = est.estimate
            equity = { state: "estimated", detail: `estimate ${usd(est.estimate.estimatedValue)} from ${est.estimate.valuationSource}; equity ${est.estimate.line.estimatedEquity === null ? "not estimated (no recorded loan)" : usd(est.estimate.line.estimatedEquity)}`, cardId: null }
          }
        }
        const playbook = lifetimePlaybookFor(kind, { hasEstimate: equity.state !== "unavailable", hasAgent: !!agentId })
        if (estimate) {
          const card = composeEquityCheckCard({ firstName, estimate, playbook })
          const { clientSafeCtaLine, valueNewsTone } = await import("@/lib/kernel/client-framing")
          const tone = valueNewsTone({ value: estimate.line.estimatedEquity ?? estimate.line.appreciation })
          const push = deps.pushCard ?? (await import("@/lib/kernel/portal-value")).pushPortalValueCard
          const pushed = await push({
            brokerageId: a.brokerageId, contactId: a.signal.contact_id, title: card.title,
            summary: `${card.summary}\n\n${clientSafeCtaLine(tone, "your home's value")}`, updateType: EQUITY_CHECK_UPDATE_TYPE, now,
            dedupeWindowMs: windows.valueCheckWindowDays * DAY_MS,
            metadata: {
              source: "lifetime_change_action", signal_id: a.signal.id, signal_type: a.signal.signal_type, kind,
              estimated_value: estimate.estimatedValue, value_low: estimate.valueLow, value_high: estimate.valueHigh,
              valuation_source: estimate.valuationSource, valuation_confidence: estimate.valuationConfidence, valued_at: estimate.valuedAt,
              transaction_id: estimate.inputs.transactionId, purchase_price: estimate.purchasePrice, close_date: estimate.closeDate,
              estimated_equity: estimate.line.estimatedEquity, estimated_remaining_balance: estimate.line.estimatedRemainingBalance,
              equity_basis: estimate.line.equityBasis, loan_amount_source: estimate.inputs.loanAmountSource,
              not_an_appraisal: true, not_a_payoff_figure: true, not_an_offer: true, rate_quoted: false,
              playbook: playbook.map((p) => ({ step: p.step, available: p.available })),
            },
          }, svc as never)
          equity = { ...equity, cardId: pushed.pushed ? (pushed.id ?? null) : null, detail: pushed.pushed ? equity.detail : `${equity.detail}; the card was not written (${pushed.reason ?? "refused"})` }
        }

        // ── 2 · equity / refinance: ONE governed moment the conductor arbitrates, and the reactivation row is consumed ──
        let momentId: string | null = null
        let consumed = false
        const today = now.toISOString().slice(0, 10)
        const stamp = { at: now.toISOString(), kind, equity: equity.state, card_id: equity.cardId, playbook: playbook.map((p) => p.step) }
        if (PLAYBOOK_OWNED_KINDS.has(kind)) {
          if (!agentId) {
            // lifetime_customer_touchpoints.agent_id is NOT NULL: without an agent of record there is no moment to open — said, and
            // the row is LEFT for the returning-customer loop (its Sphere fallback still proposes a gated touch).
          } else {
            const { data: open, error: oErr } = await svc.from("lifetime_customer_touchpoints").select("id")
              .eq("brokerage_id", a.brokerageId).eq("contact_id", a.signal.contact_id).eq("status", "scheduled").eq("touchpoint_type", "custom")
              .contains("engagement_data", { opened_by: "lifetime_change_action" }).limit(1)
            if (oErr) return (out = { ...base, action: "refused", reason: `open-moment read refused: ${oErr.message}`, equity, playbook })
            if ((open ?? []).length > 0) momentId = ((open ?? [])[0] as { id: string }).id
            else {
              const { data: ins, error: iErr } = await svc.from("lifetime_customer_touchpoints").insert({
                brokerage_id: a.brokerageId, contact_id: a.signal.contact_id, agent_id: agentId, touchpoint_type: "custom",
                scheduled_date: today, status: "scheduled", related_transaction_id: estimate?.inputs.transactionId ?? null,
                // `opened_by` at the top level too: a shallow jsonb @> finds this action's open moment (the conductor's settle keeps
                // top-level keys — it rewrites only `followup`).
                engagement_data: { opened_by: "lifetime_change_action", followup: { opened_on: today, opened_by: "lifetime_change_action", signal_id: a.signal.id, signal_type: a.signal.signal_type, kind, playbook: playbook.map((p) => ({ step: p.step, available: p.available, why: p.why })) } },
              }).select("id")
              if (iErr) return (out = { ...base, action: "refused", reason: `moment not opened: ${iErr.message}`, equity, playbook })
              momentId = ((ins ?? [])[0] as { id?: string } | undefined)?.id ?? null
              if (!momentId) return (out = { ...base, action: "refused", reason: "moment insert returned no row", equity, playbook })
            }
            const { data: took, error: tErr } = await svc.from("signal_reactivations")
              .update({ isa_reactivated: true, isa_reactivated_at: now.toISOString(), signal_data: { ...(a.signal.signal_data ?? {}), lifetime_action: { ...stamp, moment_id: momentId } } })
              .eq("id", a.signal.id).eq("brokerage_id", a.brokerageId).eq("isa_reactivated", false).select("id")
            if (tErr) return (out = { ...base, action: "refused", reason: `signal not consumed: ${tErr.message}`, equity, momentId, playbook })
            consumed = (took ?? []).length === 1
          }
        }
        if (!consumed) {
          // Stamp only (home_sale / moving, or no agent): the returning-customer loop still consumes it; this run never re-acts on it.
          const { error: sErr } = await svc.from("signal_reactivations")
            .update({ signal_data: { ...(a.signal.signal_data ?? {}), lifetime_action: { ...stamp, moment_id: momentId } } })
            .eq("id", a.signal.id).eq("brokerage_id", a.brokerageId).select("id")
          if (sErr) console.warn(`[lifetime-change-action] signal ${a.signal.id} not stamped: ${sErr.message}`)
        }
        return (out = {
          action: "acted", kind, equity, momentId, consumed, playbook,
          reason: `${equity.state === "unavailable" ? `no equity card (${equity.detail})` : `equity ${equity.state}`}; ${momentId ? `moment ${momentId} opened for the arbiter` : PLAYBOOK_OWNED_KINDS.has(kind) ? "no moment (no agent of record)" : "the Listing Concierge re-engagement keeps the listing-consultation step"}`,
        })
      },
      {
        settle: (r) => ({ status: r.action === "acted" ? "executed" : r.action === "refused" ? "failed" : "skipped", outcome: r.momentId ? `moment:${r.momentId}` : r.equity?.state ?? r.action, error: r.action === "refused" ? r.reason : null }),
        replay: () => out,
      },
      { client: svc as never },
    )
    return out
  } catch (e) {
    return { ...base, action: "refused", reason: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface LifetimeChangeRunResult { scanned: number; acted: number; skipped: number; refused: number; replayed: number; estimates: number; cards: number; moments: number; consumed: number; errors: string[] }

/**
 * The tenant's pending lifetime signals (contact arm, not yet consumed, inside the tenant's life-event window, not yet actioned) →
 * runLifetimeChangeAction each. Wired on the manager-signals tick right after the Sphere drains its inbox (the responder records the
 * row there). Never throws.
 */
export async function runLifetimeChangeActions(svc: Svc, brokerageId: string, opts: { now?: Date; limit?: number } = {}, deps: LifetimeChangeDeps = {}): Promise<LifetimeChangeRunResult> {
  const res: LifetimeChangeRunResult = { scanned: 0, acted: 0, skipped: 0, refused: 0, replayed: 0, estimates: 0, cards: 0, moments: 0, consumed: 0, errors: [] }
  const now = opts.now ?? new Date()
  try {
    const windows = await windowsFor(svc, brokerageId, deps)
    const since = new Date(now.getTime() - windows.lifeEventWindowDays * DAY_MS).toISOString()
    const { data, error } = await svc.from("signal_reactivations")
      .select("id, contact_id, signal_type, signal_strength, signal_data, triggered_at")
      .eq("brokerage_id", brokerageId).eq("isa_reactivated", false).not("contact_id", "is", null).gte("triggered_at", since)
      .order("triggered_at", { ascending: true }).limit(opts.limit ?? 50)
    if (error) { res.errors.push(`signal read refused: ${error.message}`); return res }
    for (const row of (data ?? []) as ReactivationRow[]) {
      if (row.signal_data && typeof row.signal_data === "object" && "lifetime_action" in row.signal_data) continue
      const kind = lifetimeSignalKind(row.signal_type, row.signal_data)
      if (!kind || !EQUITY_CHECK_KINDS.has(kind)) continue
      res.scanned++
      const r = await runLifetimeChangeAction(svc, { brokerageId, signal: row, now }, { ...deps, windows })
      if (r.action === "acted") res.acted++
      else if (r.action === "replayed") res.replayed++
      else if (r.action === "refused") { res.refused++; res.errors.push(`${row.id}: ${r.reason}`) }
      else res.skipped++
      if (r.equity?.state === "estimated") res.estimates++
      if (r.equity?.cardId && r.equity.state === "estimated") res.cards++
      if (r.momentId) res.moments++
      if (r.consumed) res.consumed++
    }
  } catch (e) {
    res.errors.push(`run threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return res
}
