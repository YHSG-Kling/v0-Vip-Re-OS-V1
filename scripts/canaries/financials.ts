/**
 * scripts/canaries/financials.ts — FINANCIALS canary (wave 144, lane 144J; owner rulings 5–9 + "ONE RULE TO ENCODE
 * DETERMINISTICALLY"):
 *   gross-to-net waterfall · internal AND outside-partner referral · royalty a separate brokerage line · cap paid-to-date
 *   crossed mid-transaction · the cap cycle judged on the DEAL's date + anniversary rollover (never 1 January unless the
 *   agreement says) · downline residual = revenue share, never a referral · payout timing a brokerage SETTING with
 *   approval / initiation / verified receipt separate · no double payout · state tax proration on the net sheet
 * driven through the REAL engine (lib/commission/engine.ts calculateCommission, all eleven stages, in memory — the
 * fixture is scripts/canaries/_commission-deal.ts, the agreement-waterfall guard's shape) and the pure survivors
 * (lib/commission/cap-resolver.ts, referral-payout.ts, revenue-share-model.ts, ledger-sync.ts, lib/offers/net-sheet-calc.ts,
 * seller-closing-costs.ts). No payment provider, no QuickBooks, no Stripe is reached; nothing is paid.
 *
 * MEASURED AT 967a4866 (red where HEAD does not behave as ruled — the lane that owns the fix is named on the step):
 *   · an OUTSIDE-partner referral is left untouched by the waterfall (lib/commission/referral-payout.ts header: "NOT BUILT …
 *     an EXTERNAL referral partner / outside brokerage fee") — 144D;
 *   · the agreement's royalty_value is resolved (lib/brokerage/get-default-commission-structure.ts) but NO stage charges it —
 *     stage 10 prices transaction / desk / technology / E&O only — 144D;
 *   · stage 07 picks the cap window containing TODAY (lib/commission/waterfall/07-apply-cap.ts `nowDate`), so a deal that
 *     closed in a capped cycle and is calculated after the anniversary is charged against the NEW cycle — 144D;
 *   · the cap anniversary anchor is agents.created_at under a brokerage-wide basis, not the agent/team AGREEMENT — 144D;
 *   · payoutFundsGate (lib/commission/ledger-sync.ts) always demands the brokerage's receipt — the closing/CDA vs
 *     brokerage-receipt choice is not a setting the gate reads — 144D;
 *   · property-tax proration is a NOTE on the seller estimate, never a state-rule number — 144D.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, setSvc, uuid } from "./_harness"
import { findLanded, listFiles, strippedRepo } from "./_registry"
import { cents, newDeal, rowsOf, runEngine, seedDeal } from "./_commission-deal"

export async function run() {
  const c = canary("Financials: gross-to-net waterfall · internal + outside-partner referral · royalty separate · cap paid-to-date + anniversary · residual = revenue share · payout setting · tax proration")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — a commission calculation posts a ledger")
  // Every ruling here is DRIVEN through a door that exists at 967a4866 (the engine, the payout doors, the seller estimate): the
  // lane's new inputs ride the fixture, HEAD ignores them (red), and the landed behaviour turns the same step green. findLanded
  // answers are evidence only.
  const tenants: string[] = []
  const svcs: Array<Awaited<ReturnType<typeof runEngine>>["svc"]> = []
  const today = new Date().toISOString().slice(0, 10)

  // ── 1 · THE DETERMINISTIC WATERFALL (green — preserve) ──
  const plain = newDeal(); tenants.push(plain.B)
  const p = await runEngine(plain); svcs.push(p.svc)
  const pd = rowsOf(p.svc, "commission_distributions")
  const foot = pd.reduce((s, r) => s + cents(r.calculated_amount), 0)
  const llmInMoney = listFiles("lib/commission", (f) => /\.ts$/.test(f)).filter((f) => /\b(generateText|generateObject|generateTextRouted|generateObjectRouted|gatewayChat|streamText)\b/.test(strippedRepo(f) ?? ""))
  c.rule("144D", "GROSS-TO-NET IS ARITHMETIC: $400,000 × 3 % = $12,000.00 gross → 70/30 → agent $8,400.00 / brokerage $3,600.00; the persisted distributions FOOT to the gross; no model call anywhere under lib/commission (AI explains, the engine calculates)", p.r.success && cents(p.r.gross_commission) === 1_200_000 && cents(p.r.net_to_agent) === 840_000 && cents(p.r.net_to_brokerage) === 360_000 && foot === 1_200_000 && llmInMoney.length === 0, `${p.r.error ?? ""} gross ${p.r.gross_commission} agent ${p.r.net_to_agent} brokerage ${p.r.net_to_brokerage} foot ${foot / 100}${llmInMoney.length ? ` LLM in ${llmInMoney.join(",")}` : ""}`)

  // ── 2 · REFERRAL — internal agent (green) and OUTSIDE PARTNER (ruling 5) ──
  const rIn = newDeal(); tenants.push(rIn.B)
  const REFERRER = uuid(), REF_IN = uuid()
  rIn.extra = { agents: [{ id: REFERRER, brokerage_id: rIn.B, user_id: uuid(), team_id: null }], referrals: [{ id: REF_IN, brokerage_id: rIn.B, agent_id: rIn.A, referring_agent_id: REFERRER, partner_id: null, referral_fee_pct: 25, status: "received", referred_contact_id: rIn.C, transaction_id: null, created_at: "2026-07-01T00:00:00Z" }] }
  const ri = await runEngine(rIn); svcs.push(ri.svc)
  const riRef = rowsOf(ri.svc, "commission_distributions").filter((r) => r.distribution_type === "referral")
  const again = await runEngine(rIn, { svc: ri.svc })
  c.rule("144D", "INTERNAL REFERRAL (ruling 5): the agreed 25 % comes off the top to the REFERRING agent ($3,000.00) before the split (agent $6,300.00), the referral is LINKED to this one deal; a re-run of the same deal books NO second fee (no double payment)", ri.r.success && riRef.length === 1 && riRef[0].agent_id === REFERRER && cents(riRef[0].calculated_amount) === 300_000 && cents(ri.r.net_to_agent) === 630_000 && rowsOf(ri.svc, "referrals")[0]?.transaction_id === rIn.T && rowsOf(ri.svc, "commission_distributions").filter((r) => r.distribution_type === "referral" && r.transaction_id === rIn.T && !r.voided_at).length <= 1 && again.r.success !== undefined, `${ri.r.error ?? ""} referral rows ${riRef.length} agent ${ri.r.net_to_agent}`)

  const rOut = newDeal(); tenants.push(rOut.B)
  const PARTNER = uuid(), REF_OUT = uuid()
  // partner_type is the LIVE vocabulary's licensed-real-estate value (scripts/check-vocabularies.ts referral_partners.partner_type):
  // the first version wrote "agent", which the live CHECK refuses — the in-memory client does not enforce CHECKs, so the fixture
  // was an impossible row (found when lane 144D's RESPA §8 rule correctly refused it). company_name = the brokerage of record.
  const partnerRow = { id: PARTNER, brokerage_id: rOut.B, partner_name: "Outside Referral Agent", company_name: "Other Realty LLC", partner_type: "real_estate_agent", active: true, referral_fee_flat: null, commission_split_percentage: 25 }
  rOut.extra = {
    referral_partners: [partnerRow],
    referrals: [{ id: REF_OUT, brokerage_id: rOut.B, agent_id: rOut.A, referring_agent_id: null, partner_id: PARTNER, referral_fee_pct: 25, status: "received", referred_contact_id: rOut.C, transaction_id: null, created_at: "2026-07-01T00:00:00Z" }],
  }
  const ro = await runEngine(rOut); svcs.push(ro.svc)
  const roRef = rowsOf(ro.svc, "commission_distributions").filter((r) => r.distribution_type === "referral")
  const { pickReferralForDeal } = await import("../../lib/commission/referral-payout")
  const pick = pickReferralForDeal([{ id: REF_OUT, agent_id: rOut.A, referring_agent_id: null, referral_fee_pct: 25, status: "received", transaction_id: null, created_at: "2026-07-01T00:00:00Z", partner_id: PARTNER } as never], { transactionId: rOut.T, producingAgentId: rOut.A, partners: new Map([[PARTNER, partnerRow]]), asOf: "2026-10-01" } as never)
  c.rule("144D", "OUTSIDE-PARTNER REFERRAL (ruling 5 — 'an outside agent/brokerage kept in the canonical PARTNER bucket … linked to transaction, agreement and waterfall; correct payee'): a referral whose payee is a referral_partners row (no internal referring agent) at an agreed 25 % is PICKED for the deal and deducted before the split — $3,000.00 to the PARTNER, never to an internal agent, the agent's net $6,300.00", ro.r.success && pick.referral?.id === REF_OUT && roRef.length === 1 && !roRef[0].agent_id && roRef[0].referral_partner_id === PARTNER && cents(roRef[0].calculated_amount) === 300_000 && cents(ro.r.net_to_agent) === 630_000, `HEAD: pick ${pick.referral ? "found" : "none"} (${pick.findings.join("; ") || "no finding"}); referral distributions ${roRef.length}; agent net ${ro.r.net_to_agent}${ro.r.error ? `; ${ro.r.error}` : ""}`)

  // ── 3 · ROYALTY — a separate brokerage line (ruling 7) ──
  const roy = newDeal({ terms: { royalty_type: "flat", royalty_value: 500 } }); tenants.push(roy.B)
  const ry = await runEngine(roy); svcs.push(ry.svc)
  const royRows = [...rowsOf(ry.svc, "commission_distributions"), ...((ry.r.distributions ?? []) as unknown as Array<Record<string, unknown>>)].filter((r) => r.distribution_type === "royalty")
  c.rule("144D", "ROYALTY (ruling 7 + the table: 'brokerage royalty — separate brokerage fee under the agreement'): the agreement's flat $500 royalty is charged as its OWN 'royalty' line to the brokerage — distinct from the split, the fees, the cap, a concession, a referral and revenue share — so the agent's net is $8,400.00 − $500.00", ry.r.success && royRows.length >= 1 && cents(royRows[0].calculated_amount) === 50_000 && cents(ry.r.net_to_agent) === 790_000, `HEAD: royalty lines ${royRows.length}; agent net ${ry.r.net_to_agent} (getDefaultCommissionStructure resolves royaltyValue; lib/commission/waterfall/10-fees.ts charges transaction/desk/technology/E&O only)${ry.r.error ? `; ${ry.r.error}` : ""}`)

  // ── 4 · CAP PAID-TO-DATE crossed mid-transaction (green — preserve) ──
  const end = (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10) })()
  const cap = newDeal(); tenants.push(cap.B)
  cap.extra = { agent_cap_tracking: [{ id: uuid(), agent_id: cap.A, brokerage_id: cap.B, cap_amount: 5_000, cap_paid_to_date: 4_000, anniversary_start: today, anniversary_end: end, is_capped: false }] }
  const cr = await runEngine(cap); svcs.push(cr.svc)
  c.rule("144D", "CAP CROSSED MID-TRANSACTION (ruling 9): $4,000 of a $5,000 cap paid → this deal's $3,600 brokerage portion takes ONLY the $1,000 remaining (hit_cap) and the agent keeps the other $2,600 → agent $11,000.00 / brokerage $1,000.00", cr.r.success && cr.r.cap_status === "hit_cap" && cents(cr.r.net_to_brokerage) === 100_000 && cents(cr.r.net_to_agent) === 1_100_000, `${cr.r.error ?? ""} ${cr.r.cap_status} agent ${cr.r.net_to_agent} brokerage ${cr.r.net_to_brokerage}`)

  // ── 5 · THE CAP CYCLE IS THE DEAL'S, not the wall clock's (anniversary rollover) ──
  const yesterday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10) })()
  const lastYear = (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10) })()
  const ten = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 10); return d.toISOString().slice(0, 10) })()
  const roll = newDeal({ close: ten }); tenants.push(roll.B)
  roll.extra = { agent_cap_tracking: [
    { id: uuid(), agent_id: roll.A, brokerage_id: roll.B, cap_amount: 5_000, cap_paid_to_date: 5_000, anniversary_start: lastYear, anniversary_end: yesterday, is_capped: true },
    { id: uuid(), agent_id: roll.A, brokerage_id: roll.B, cap_amount: 5_000, cap_paid_to_date: 0, anniversary_start: today, anniversary_end: end, is_capped: false },
  ] }
  const rr = await runEngine(roll); svcs.push(rr.svc)
  c.rule("144D", "ANNIVERSARY ROLLOVER judged on the DEAL'S DATE (ruling 9: 'stops taking that fee until the ANNIVERSARY cap date, when the total restarts'): a deal that CLOSED 10 days ago inside the agent's CAPPED cycle and is calculated after the anniversary is measured against THAT cycle → post_cap, brokerage $0, agent $12,000.00 — the new cycle (which began today) is not charged for it", rr.r.success && rr.r.cap_status === "post_cap" && cents(rr.r.net_to_brokerage) === 0, `HEAD: ${rr.r.cap_status} brokerage ${rr.r.net_to_brokerage} — lib/commission/waterfall/07-apply-cap.ts selects the window containing TODAY (nowDate), not the close date${rr.r.error ? `; ${rr.r.error}` : ""}`)

  const { resolveAnniversaryWindow, DEFAULT_CAP_ANNIVERSARY_BASIS } = await import("../../lib/commission/cap-resolver")
  const w = resolveAnniversaryWindow({ basis: "agent_start_date", today: "2027-01-02", agentCreatedAt: "2023-06-15T10:00:00Z" })
  const wBefore = resolveAnniversaryWindow({ basis: "agent_start_date", today: "2027-06-14", agentCreatedAt: "2023-06-15" })
  const wOn = resolveAnniversaryWindow({ basis: "agent_start_date", today: "2027-06-15", agentCreatedAt: "2023-06-15" })
  const cal = resolveAnniversaryWindow({ basis: "calendar_year", today: "2027-03-01" })
  c.rule("144D", "NEVER A 1-JANUARY RESET unless the agreement says so (pure): an anniversary of 15 June → on 2 January the cycle is 2026-06-15…2027-06-14; the day before the anniversary is still the old cycle, the anniversary day starts the new one; the calendar year applies ONLY when chosen; the default basis is the agent's own anniversary", w.ok && w.window.start === "2026-06-15" && w.window.end === "2027-06-14" && wBefore.ok && wBefore.window.start === "2026-06-15" && wOn.ok && wOn.window.start === "2027-06-15" && cal.ok && cal.window.start === "2027-01-01" && DEFAULT_CAP_ANNIVERSARY_BASIS === "agent_start_date", JSON.stringify({ w: w.ok ? w.window : w, before: wBefore.ok ? wBefore.window.start : null, on: wOn.ok ? wOn.window.start : null }))
  // Driven through the REAL engine (final): the agreement in force names a 1 March cap anniversary (the agent's own start date is
  // 1 September) and a $500 royalty; no ledger window exists yet, so the final opens the cycle and posts what counted toward it.
  const capFromAgreement = findLanded(["lib/commission", "supabase/migrations"], /\b(cap_anniversary_date|capAnniversaryDate|cap_cycle_start|capCycleStart|cap_eligible_types|capEligible\w*|cap_contribution_types|CAP_ELIGIBLE\w*)\b/)
  const capCase = async (terms: Record<string, unknown>) => {
    const d = newDeal({ close: "2026-10-15", terms: { royalty_type: "flat", royalty_value: 500, cap_amount: 20_000, cap_anniversary_date: "2021-03-01", ...terms } }); tenants.push(d.B)
    const seeded = seedDeal(d)
    Object.assign(seeded.agents[0], { created_at: "2019-09-01T00:00:00Z", anniversary_date: "2019-09-01" })
    seeded.agent_cap_tracking = []
    const s = canaryClient(seeded as never)
    const e = await runEngine(d, { svc: s }); svcs.push(s)
    const windows = rowsOf(s, "agent_cap_tracking").filter((r) => r.agent_id === d.A).map((w) => ({ start: String(w.anniversary_start ?? "").slice(0, 10), paid: Number(w.cap_paid_to_date) }))
    return { ok: !!e.r.success, error: e.r.error ?? null, windows }
  }
  const capSilent = await capCase({})                                                            // the agreement lists no eligible types → the split alone
  const capListed = await capCase({ cap_eligible_contributions: ["brokerage_split", "royalty"] })  // the agreement counts its royalty
  const capFromAgreementOk = capSilent.ok && capListed.ok && capSilent.windows.length === 1 && capSilent.windows[0].start === "2026-03-01" && capSilent.windows[0].paid === 3_600 && capListed.windows.length === 1 && capListed.windows[0].paid === 4_100
  c.rule("144D", "THE CAP CYCLE COMES FROM THE AGREEMENT (ruling 9: 'cap-eligible contribution types, cycle/anniversary, exceptions and effective agreement version come from the agreement'): an agreement naming a 1 March cap anniversary opens the cycle on 1 March (not the agent's 1 September start, not 1 January); with no eligible types listed only the $3,600 split counts toward the cap and the $500 royalty does not; an agreement that LISTS the royalty counts it ($4,100) — at HEAD the anchor is agents.created_at under the brokerage-wide basis and the royalty is never charged", capFromAgreementOk, `silent ${JSON.stringify(capSilent)}; listed ${JSON.stringify(capListed)}${capFromAgreement ? `; terms landed at ${capFromAgreement}` : ""}`)

  // ── 6 · RESIDUAL = REVENUE SHARE with the downline, never a referral (pure, green — preserve) ──
  const { NON_RESIDUAL_ECONOMIC_EDGES, RESIDUAL_ELIGIBLE_RELATIONSHIPS } = await import("../../lib/commission/revenue-share-model")
  c.rule("144D", "RESIDUAL = REVENUE SHARE with the DOWNLINE (ruling 7): only sponsor / mentor / team-lead relationships are residual-eligible; a referred_by edge (a referral) and a vendor edge NEVER mint a residual — the two are different rails (distribution_type 'referral' vs 'residual')", (NON_RESIDUAL_ECONOMIC_EDGES as readonly string[]).includes("referred_by") && !(RESIDUAL_ELIGIBLE_RELATIONSHIPS as readonly string[]).includes("referred_by" as never) && [...RESIDUAL_ELIGIBLE_RELATIONSHIPS].join() === "sponsor,mentor,team_lead", [...RESIDUAL_ELIGIBLE_RELATIONSHIPS].join(","))

  // ── 7 · PAYOUT TIMING is a brokerage SETTING (ruling 8) ──
  const { payoutFundsGate } = await import("../../lib/commission/ledger-sync")
  const noFunds = payoutFundsGate({ deposit_received_at: null }, null)
  const funded = payoutFundsGate({ deposit_received_at: new Date().toISOString() }, null)
  c.rule("144D", "AFTER-RECEIPT MODE (green — preserve): with no brokerage receipt recorded a payout is refused by name (funds_not_received) unless a stated advance reason is kept; once the receipt is recorded it is allowed — approval, initiation and verified receipt stay separate states", !noFunds.ok && /funds_not_received/.test(noFunds.error) && funded.ok, noFunds.ok ? "allowed" : noFunds.error.slice(0, 80))
  // Driven through the payout DOORS that exist at 967a4866 (lib/kernel/financial.ts initiateCommissionPayout / markCommissionPaid):
  // the brokerage's setting rides the brokerage row (at HEAD nothing reads it, so the closing-time case is refused — red).
  const payoutSetting = findLanded(["lib/commission", "lib/transactions", "lib/kernel/financial.ts", "lib/kernel/tenant-policy.ts", "lib/brokerage", "supabase/migrations"], /\b(\w*payout_timing|payoutTiming|resolvePayoutTiming|payout_gate|payoutGateMode|pay_at_closing|payAtClosing|PAYOUT_TIMING\w*|PAYOUT_GATE\w*)\b/)
  const fk = await import("../../lib/kernel/financial")
  const payoutCase = async (brokerage: Record<string, unknown>, cda: Record<string, unknown> | null, door: "initiate" | "mark") => {
    const d = newDeal(), ADM = uuid(), CM = uuid()
    tenants.push(d.B)
    const s = canaryClient({
      brokerages: [{ id: d.B, name: `${CANARY_TAG} Payout Brokerage`, ...brokerage }],
      users: [{ id: ADM, email: `payout-broker@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: d.B }],
      agents: [{ id: d.A, user_id: d.U, brokerage_id: d.B, is_active: true }],
      transactions: [{ id: d.T, brokerage_id: d.B, agent_id: d.A, status: "closed", stage: "CLOSED", close_date: today }],
      agent_commissions: [{ id: CM, brokerage_id: d.B, agent_id: d.A, transaction_id: d.T, status: "approved", net_to_agent: 8_400, deposit_received_at: null, payment_initiated_at: null }],
      closing_disclosure_agreement: cda ? [{ id: uuid(), transaction_id: d.T, brokerage_id: d.B, ...cda }] : [],
    } as never)
    svcs.push(s); setSvc(s)
    const ctx = { userId: ADM, agentId: null, brokerageId: d.B, userType: "broker_owner", platformRole: null, isTenantPrincipal: true } as never
    const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}
    try {
      const r = door === "initiate" ? await fk.initiateCommissionPayout({ ctx, commissionId: CM, brokerageId: d.B, method: "check" }) : await fk.markCommissionPaid({ ctx, commissionId: CM, brokerageId: d.B, method: "check" })
      return { ok: !!r.success, error: String((r as { error?: string }).error ?? "") }
    } finally { console.warn = w; console.error = e }
  }
  const signedSent = { status: "approved", broker_approved_at: `${today}T00:00:00Z`, sent_to_title_at: `${today}T01:00:00Z` }
  const atClosing = await payoutCase({ offers_cda: true, commission_payout_timing: "at_closing_per_cda" }, signedSent, "initiate")
  const atClosingUndelivered = await payoutCase({ offers_cda: true, commission_payout_timing: "at_closing_per_cda" }, { ...signedSent, sent_to_title_at: null }, "mark")
  const afterReceipt = await payoutCase({ offers_cda: true, commission_payout_timing: "after_brokerage_receipt" }, signedSent, "mark")
  const payoutOk = atClosing.ok && !atClosingUndelivered.ok && !afterReceipt.ok && /funds_not_received/.test(afterReceipt.error)
  c.rule("144D", "PAYOUT GATE IS A BROKERAGE SETTING (ruling 8: 'either pay out at closing (CDA authorizes the permitted closing-time distribution) or pay out when the brokerage receives the final commission'): a closing-time brokerage releases the payout on the VERIFIED closing with the broker-signed CDA delivered to title and NO brokerage-receipt stamp, and refuses it while the CDA is undelivered; an after-receipt brokerage still refuses it (funds_not_received) — at HEAD payoutFundsGate takes only the row and always demands the receipt", payoutOk, `closing-time ${atClosing.ok ? "released" : `refused (${atClosing.error.slice(0, 90)})`}; CDA undelivered ${atClosingUndelivered.ok ? "RELEASED" : "refused"}; after-receipt ${afterReceipt.ok ? "RELEASED" : `refused (${afterReceipt.error.slice(0, 40)})`}${payoutSetting ? `; setting landed at ${payoutSetting}` : ""}`)

  // ── 8 · NET SHEET: state-dependent tax proration (ruling 6) ──
  const { estimateSellerClosingCosts } = await import("../../lib/offers/seller-closing-costs")
  const est = estimateSellerClosingCosts({ salePrice: 400_000, state: "TX", commission: { kind: "rate", rateDecimal: 0.06, sourceNote: "listing agreement" }, mortgagePayoff: { amount: 200_000, sourceNote: "payoff statement" } })
  const taxLine = est.lines.find((l) => /tax/i.test(l.label) && /prorat/i.test(`${l.label} ${l.note ?? ""}`))
  // Driven through the ONE seller estimate (estimateSellerClosingCosts) with the deal's convention as an input — at HEAD the
  // input is ignored and the line stays a note. Amounts are the inputs' arithmetic: 181 / 365 × $7,300 = $3,620 owed by the
  // seller (arrears, Jan-1 period, 1 July close); 272 / 365 × $7,300 = $5,440 reimbursed TO the seller (advance, July fiscal
  // year, 1 October close) — a negative seller cost.
  const proration = findLanded(["lib/offers", "lib/commission", "lib/transactions", "lib/net-sheet"], /export\s+(async\s+)?function\s+\w*[Pp]rorat\w*\s*\(|export\s+const\s+\w*PRORATION\w*\s*=|\btaxProration\s*[?]?:/)
  const prorate = (tp: Record<string, unknown> | null) => estimateSellerClosingCosts({ salePrice: 400_000, state: "TX", commission: { kind: "rate", rateDecimal: 0.06, sourceNote: "listing agreement" }, taxProration: tp } as never).lines.find((l) => /tax/i.test(l.label) && /prorat/i.test(`${l.label} ${l.note ?? ""}`))
  const arrears = prorate({ annualTax: 7_300, periodStart: "2026-01-01", timing: "arrears", closeDate: "2026-07-01", closingDayOwner: "buyer", dayBasis: "actual_365", source: "title's proration instruction" })
  const advance = prorate({ annualTax: 7_300, periodStart: "2026-07-01", timing: "advance", closeDate: "2026-10-01", closingDayOwner: "seller", dayBasis: "actual_365", source: "county fiscal year per escrow" })
  const partial = prorate({ annualTax: 7_300, closeDate: "2026-07-01" })
  const prorationOk = !!arrears && !arrears.pending && arrears.high === 3_620 && !!advance && !advance.pending && advance.high === -5_440 && !!partial && partial.pending === true && !!taxLine?.pending
  c.rule("144D", "TAX PRORATION ON THE NET SHEET (ruling 6: 'tax proration (state-dependent) … never hard-code one state's rule for all'): given the deal's convention (arrears vs advance, the tax period, the day count, the closing-day owner, its named source), the ONE seller estimate computes the proration as a NUMBER — the same deal under two conventions gives two answers ($3,620 owed in arrears; $5,440 reimbursed in advance) — and a state alone or a partial convention stays PENDING (never invented)", prorationOk, `arrears ${arrears ? `${arrears.high}${arrears.pending ? " pending" : ""}` : "none"}; advance ${advance ? `${advance.high}${advance.pending ? " pending" : ""}` : "none"}; partial ${partial?.pending ? "pending" : "COMPUTED"}; state alone ${taxLine?.pending ? "pending" : "COMPUTED"}${proration ? `; landed at ${proration}` : ""}`)

  c.blind("The engine ran in memory (scripts/in-memory-supabase.ts): no RLS, triggers or live CHECKs — the m812 referral link and the commission_distributions CHECK are modelled by the fixture, not the database. Refunds / corrections of a capped deal (distribution-correction.ts) and an agreement change mid-cycle are the agreement-waterfall guard's; this canary asserts the cycle rule on the deal's date. A 'landed' probe is evidence only — a landed capability stays RED here until its behavioural assertion is wired at the WAVE144 WIRE line (no false green).")
  let deleted: Array<{ table: string; deleted: number }> = [], residual = 0, mismatches: string[] = []
  for (const s of svcs) {
    const bid = tenants.find((t) => (s.tables.brokerages ?? []).some((b) => b.id === t)) ?? null
    const cl = await cleanupCanary(s, bid)
    deleted = [...deleted, ...cl.cleanup]; residual += cl.residual; mismatches = [...mismatches, ...cl.mismatches]
  }
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, `${deleted.reduce((n, x) => n + Math.max(0, x.deleted), 0)} rows`)
  return c.report(deleted, residual)
}
