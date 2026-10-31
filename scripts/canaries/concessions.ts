/**
 * scripts/canaries/concessions.ts — CONCESSIONS canary (wave 144, lane 144J; owner ruling 4 + the deterministic table):
 *   SELLER concession = the seller gives the buyer $ out of the SELLER'S NET — never from any commission;
 *   AGENT concession  = a credit the agent gives to the buyer or seller, its own record (agent, beneficiary, amount, reason,
 *                       approval, transaction, settlement treatment, ledger effect), subtracted from THAT agent's gross
 *                       commission; where the brokerage requires it the agent ASKS FIRST — unapproved = blocked, evidence kept;
 *   never conflated.
 * Through the survivors at 967a4866: lib/offers/net-sheet-calc.ts computeNetProceeds / rankOffersByNet (the canonical seller
 * net sheet — its header "KEEP-ONE"), lib/cma/net-sheet-math.ts computeNetSheetScenario (the listing-presentation net sheet),
 * lib/commission/engine.ts calculateCommission (all eleven stages, in memory) and lib/transactions/closing-compliance-core.ts
 * (the settlement-vs-contract term vocabulary). Nothing is paid, signed or sent.
 *
 * MEASURED AT 967a4866: the seller-concession half HOLDS everywhere it is computed (green — preserve). The agent-concession
 * half does not exist: no record, no engine input, no approval policy, no closing-statement term (grep agent_concession →
 * nothing under lib/, app/, supabase/migrations) — 144D.
 */
import { CANARY_EMAIL_DOMAIN, LIVE, canary, canaryClient, cleanupCanary, landedModule, setSvc, uuid, type CanarySvc } from "./_harness"
import { findLanded, strippedRepo } from "./_registry"
import { cents, newDeal, rowsOf, runEngine, seedDeal } from "./_commission-deal"

export async function run() {
  const c = canary("Concessions: seller credit → seller's net only · agent credit → THAT agent's commission + broker approval · never conflated")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")

  // ── 1 · SELLER CONCESSION reduces the SELLER'S NET only — the offer net sheet (pure) ──
  const { computeNetProceeds, rankOffersByNet } = await import("../../lib/offers/net-sheet-calc")
  const costs = { commissionRate: 0.06, mortgagePayoff: 200_000, countyCityTaxes: 3_000, hoaDuesProration: 500, otherProratedFees: 0, transactionFee: 395 }
  const without = computeNetProceeds({ offerPrice: 500_000, buyerClosingCredit: 0 }, costs)
  const withCredit = computeNetProceeds({ offerPrice: 500_000, buyerClosingCredit: 5_000 }, costs)
  const ranked = rankOffersByNet([{ offerId: "a", buyerName: null, offerPrice: 500_000, financingType: "conventional", buyerClosingCredit: 0 }, { offerId: "b", buyerName: null, offerPrice: 500_000, financingType: "conventional", buyerClosingCredit: 5_000 }], costs)
  const la = ranked.lines.find((l) => l.offerId === "a"), lb = ranked.lines.find((l) => l.offerId === "b")
  c.rule("144D", "SELLER CONCESSION → SELLER'S NET ONLY (offer net sheet): a $5,000 seller credit to the buyer lowers the seller's net by exactly $5,000 ($266,105 → $261,105) and leaves the COMMISSION line untouched ($30,000 on both offers — commission is on the price, never on price − credit)", without - withCredit === 5_000 && without === 266_105 && la?.commission === 30_000 && lb?.commission === 30_000, `net ${without} → ${withCredit}; commission ${la?.commission}/${lb?.commission}`)

  // ── 2 · the listing-presentation net sheet agrees (one rule wherever a seller's net is computed) ──
  const { computeNetSheetScenario } = await import("../../lib/cma/net-sheet-math")
  const cma0 = computeNetSheetScenario("base", 500_000, { closingCosts: 0, mortgagePayoffAmount: 200_000, propertyTaxes: 3_000, hoaFees: 500, transactionFee: 395, sellerConcessions: 0 }, 0.03, 0.03, 0)
  const cma5 = computeNetSheetScenario("credit", 500_000, { closingCosts: 0, mortgagePayoffAmount: 200_000, propertyTaxes: 3_000, hoaFees: 500, transactionFee: 395, sellerConcessions: 5_000 }, 0.03, 0.03, 0)
  c.rule("144D", "ONE RULE IN BOTH SELLER-NET ENGINES: the listing-presentation net sheet (lib/cma/net-sheet-math.ts) subtracts the seller concession from the seller's net, keeps both commission lines on the price, and nets the SAME dollars as the offer net sheet on the same facts ($261,105)", cma5.netProceeds === withCredit && cma0.netProceeds === without && cma5.breakdown.listingCommission === cma0.breakdown.listingCommission && cma5.breakdown.buyerCommission === 15_000, `cma ${cma0.netProceeds} → ${cma5.netProceeds}; offer ${without} → ${withCredit}`)
  // The duplicate census (CLAUDE.md §1/§6 — published, never counted as a pass): a THIRD seller-net calculation lives in a
  // "use server" file (a public endpoint) with no transaction-fee line.
  const thirdEngine = /export\s+async\s+function\s+calculateNetSheet\s*\(/.test(strippedRepo("app/actions/seller-offers.ts") ?? "")
  console.log(`    finding (ruling 6 'reuse the existing net-sheet engine'; outside every wave-144 lane's domain): seller-net arithmetic lives in lib/offers/net-sheet-calc.ts (canonical), lib/cma/net-sheet-math.ts${thirdEngine ? " and app/actions/seller-offers.ts calculateNetSheet (a public server action, no transaction-fee line)" : ""} — they agree on the concession rule; the merge onto the canonical engine is the integrator's to assign`)

  // ── 3 · THE ENGINE: a seller concession on the deal is not a commission input ──
  const plain = newDeal()
  const e0 = await runEngine(plain)
  const credited = newDeal({ transaction: { closing_cost_contribution: 5_000 } })
  const e5 = await runEngine(credited)
  c.rule("144D", "SELLER CONCESSION NEVER FROM COMMISSION (the commission engine): the same $400,000 deal with a $5,000 seller credit to the buyer (transactions.closing_cost_contribution) posts the SAME $12,000.00 gross and the SAME agent $8,400.00 / brokerage $3,600.00 — the credit is the seller's settlement line, not a commission deduction", e0.r.success && e5.r.success && cents(e5.r.gross_commission) === cents(e0.r.gross_commission) && cents(e5.r.net_to_agent) === 840_000 && cents(e5.r.net_to_brokerage) === 360_000, `${e5.r.error ?? ""} gross ${e0.r.gross_commission}/${e5.r.gross_commission} agent ${e5.r.net_to_agent}`)

  // ── 4/5 · AGENT CONCESSION — driven through lane 144D's LANDED writer when its file exists (red at 967a4866: it does not) ──
  // lib/commission/agent-concession.ts (request / broker decide) + the engine's stage 03, on the same deal fixture as above.
  const record = findLanded(["lib/commission", "lib/kernel/financial.ts", "lib/transactions", "app/actions", "supabase/migrations"], /\b(agent_concessions?|agentConcession\w*|AGENT_CONCESSION\w*)\b/)
  const conc = await landedModule("../../lib/commission/agent-concession.ts")
  const extraSvcs: Array<{ svc: CanarySvc; B: string }> = []
  const concessionDeal = (brokerage: Record<string, unknown> = {}) => {
    const d = newDeal(), ADMIN = uuid()
    d.extra = { users: [{ id: d.U, brokerage_id: d.B, user_type: "agent", email: `concession-agent@${CANARY_EMAIL_DOMAIN}` }, { id: ADMIN, brokerage_id: d.B, user_type: "broker_owner", email: `concession-broker@${CANARY_EMAIL_DOMAIN}` }] }
    const seeded = seedDeal(d)
    Object.assign(seeded.brokerages[0], brokerage)
    const svc = canaryClient(seeded as never)
    extraSvcs.push({ svc, B: d.B })
    return { d, svc, agent: { userId: d.U, agentId: d.A, brokerageId: d.B, userType: "agent", isTenantPrincipal: false }, broker: { userId: ADMIN, agentId: null, brokerageId: d.B, userType: "broker_owner", isTenantPrincipal: false }, ADMIN }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a landed module's results, typed loosely so this compiles at 967a4866
  const quietly = async (f: () => Promise<any>): Promise<any> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
  const agentFlow = conc ? await (async () => {
    // Undeclared approval policy (fail closed → approval required): request → the final is HELD → the agent cannot approve → the broker approves.
    const k = concessionDeal()
    setSvc(k.svc)
    const req = await quietly(() => conc.requestAgentConcession(k.svc, k.agent, { transactionId: k.d.T, beneficiary: "buyer", beneficiaryName: "Pat Buyer", amount: 1_000, valueType: "flat", reason: "credit toward the buyer's closing costs" }))
    const row = rowsOf(k.svc, "commission_adjustments")[0]
    const statusAtRequest = row?.approval_status // read NOW: the in-memory row is the live object the decision later updates
    const held = await runEngine(k.d, { svc: k.svc })
    const byAgent = await quietly(() => conc.decideAgentConcession(k.svc, k.agent, { adjustmentId: row?.id, decision: "approved" }))
    const byBroker = await quietly(() => conc.decideAgentConcession(k.svc, k.broker, { adjustmentId: row?.id, decision: "approved", note: "approved for the inspection repair" }))
    const applied = await runEngine(k.d, { svc: k.svc })
    const ev = (rowsOf(k.svc, "commission_calculations").at(-1)?.breakdown_json as Record<string, any> | undefined)?.agent_concessions?.[0]
    // A brokerage that does not require approval records the concession directly.
    const n = concessionDeal({ agent_concession_approval: "no_approval_required" })
    setSvc(n.svc)
    const direct = await quietly(() => conc.requestAgentConcession(n.svc, n.agent, { transactionId: n.d.T, beneficiary: "seller", amount: 600, valueType: "flat", reason: "home warranty credit for the seller" }))
    const directRow = rowsOf(n.svc, "commission_adjustments")[0]
    return {
      record: { written: !!req?.ok && !!row, agent: row?.concession_agent_id === k.d.A, beneficiary: row?.recipient_type === "buyer", amount: Number(row?.value) === 1_000, reason: /closing costs/.test(String(row?.notes ?? "")), transaction: row?.transaction_id === k.d.T, settlement: typeof row?.settlement_treatment === "string" && row.settlement_treatment.length > 0, ledgerEffect: ev?.ledger_effect === "reduces_gross_before_split", notASellerCredit: row?.applies_to === "gross" && row?.direction === "credit" },
      permission: { requested: statusAtRequest === "requested" && !!req?.requiresApproval, finalHeld: held.r.success === false, agentRefused: !byAgent?.ok, brokerApproved: !!byBroker?.ok && row?.approval_decided_by === k.ADMIN && !!row?.approval_decided_at, directWhereNotRequired: !!direct?.ok && directRow?.approval_status === "not_required" },
      allocation: { grossLowerByExactly1000: applied.r.success && cents(applied.r.gross_commission) === 1_100_000, splitAfter: applied.r.success && cents(applied.r.net_to_agent) === 770_000, thatAgent: ev?.concession_agent_id === k.d.A && ev?.signed_amount === -1_000 },
    }
  })() : null
  const allTrue = (o: Record<string, boolean> | undefined) => !!o && Object.values(o).every(Boolean)
  c.rule("144D", "AGENT CONCESSION IS ITS OWN RECORD (ruling 4: 'Record agent, beneficiary, amount, reason, approval, transaction, settlement treatment, ledger effect'): an agent's $1,000 credit to the buyer is written as an agent concession naming the agent, the beneficiary (buyer | seller), the amount, the reason, the approval, the transaction, its settlement treatment and its ledger effect — never as a seller credit", allTrue(agentFlow?.record), agentFlow ? `landed writer: ${JSON.stringify(agentFlow.record)}` : record ? `landed at ${record}, but lib/commission/agent-concession.ts is absent` : "HEAD: no agent-concession record, writer or column under lib/commission, lib/kernel/financial.ts, lib/transactions, app/actions or supabase/migrations")
  // The owner's words: 'the $ amount is subtracted from THAT agent's gross commission' (table: 'that agent's gross commission
  // allocation'). Asserted: the gross attributed to that agent is exactly $1,000 lower and the agent's split applies after it.
  // NOT asserted (an owner question, published in the lane notes): whether the brokerage shares the concession through the split
  // (144D: yes — gross before split) or the agent bears all of it; and a co-agent's concession on a multi-agent deal (144D holds it).
  c.rule("144D", "AGENT CONCESSION COMES OFF THAT AGENT'S GROSS COMMISSION (the table: 'that agent's gross commission allocation'): once approved, agent A's $1,000 credit to the buyer lowers the gross commission attributed to A by exactly $1,000 ($12,000 → $11,000) and A's 70 % split applies AFTER it ($7,700); the calculation's evidence names A and the signed −$1,000 — the engine reads the agent concession as an input", allTrue(agentFlow?.allocation), agentFlow ? `landed engine: ${JSON.stringify(agentFlow.allocation)}` : "HEAD: calculateCommission has no agent-concession input (stages 01–11)")
  c.rule("144D", "ASK PERMISSION FIRST (ruling 4: 'some brokers require the agent to ASK PERMISSION FIRST … request broker approval, block unauthorized commitment, keep approval evidence'): with no declared policy (fail closed) the request is recorded as REQUESTED and a FINAL commission is HELD; the agent cannot approve their own concession; the broker's approval is kept (who + when); a brokerage that declares no approval required records the concession directly", allTrue(agentFlow?.permission), agentFlow ? `landed writer: ${JSON.stringify(agentFlow.permission)}` : "HEAD: no concession-approval setting under lib/commission, tenant-policy, lib/kernel/financial.ts, lib/brokerage, app/actions or a migration")

  // ── 6 · NEVER CONFLATED — the closing comparison speaks both credits ──
  const { CLOSING_TERM_KEYS, CONTRACT_FIELD_TO_TERM } = await import("../../lib/transactions/closing-compliance-core")
  const keys = CLOSING_TERM_KEYS as readonly string[]
  const agentTerm = keys.find((k) => /agent_(credit|concession)/.test(k))
  c.rule("144D", "NEVER CONFLATE THE TWO CREDITS at closing compliance: the settlement-vs-contract comparison carries the seller's credit (seller_credit — the contract's seller_concession_amount) AND an agent credit as a SEPARATE term, so a statement that shows the agent's credit as a seller credit is a MISMATCH, never a match", keys.includes("seller_credit") && CONTRACT_FIELD_TO_TERM.seller_concession_amount?.term === "seller_credit" && !!agentTerm && agentTerm !== "seller_credit", `HEAD terms: ${keys.join(", ")}`)

  c.blind("The engine ran in memory: closing_cost_contribution is seeded on the transaction to prove the engine does not read it — a future reader that does would turn step 3 red, which is the point. The net-sheet engines are pure and were called with identical facts; the third, server-action engine is reported, not called (a 'use server' module). Settlement treatment of an agent concession on a REAL closing statement is not exercised (no title company, no statement).")
  const cls = [await cleanupCanary(e0.svc, plain.B), await cleanupCanary(e5.svc, credited.B)]
  for (const x of extraSvcs) cls.push(await cleanupCanary(x.svc, x.B))
  const residual = cls.reduce((n, x) => n + x.residual, 0)
  const all = cls.flatMap((x) => x.cleanup)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cls.every((x) => x.mismatches.length === 0) && residual === 0, `${all.reduce((n, x) => n + Math.max(0, x.deleted), 0)} rows`)
  return c.report(all, residual)
}
