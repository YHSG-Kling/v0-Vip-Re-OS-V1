/**
 * scripts/canaries/commission-payment.ts — COMMISSIONS / PAYMENTS canary (wave 142, lane 142J):
 *   deterministic waterfall · brokerage authorizes → CHECK or DIRECT DEPOSIT · recorded + mirrored onto the
 *   seven-year deal stamp · QuickBooks matched only against real markers · no double payout · corrections linked
 * through the survivors at HEAD: lib/commission/waterfall/04-split-agent-brokerage.ts (splitAgentBrokerage — integer
 * cents, pure), lib/kernel/financial.ts markCommissionPaid (THE payout record: finance-admin gate → transition table →
 * agent_commissions paid + payment_method → commission_splits mirror → transaction_commissions stamp through
 * lib/commission/ledger-sync.ts → COMMISSION_PAID event), lib/commission/ledger-sync.ts (ledgerPatchFromStamp /
 * stampPatchFromLedger — un-paying clears paid_at) and lib/finance/qb-reconciliation.ts reconcileLedgerRows (0 rows →
 * coverage null, never 100 %). Owner (wave 142): "LLMs never calculate authoritative compensation … Stripe Billing
 * does not execute brokerage payouts … no duplicate payouts".
 *
 * MEASURED AT HEAD (the 142C hook): the payment vocabulary is pending / approved / paid / disputed — no
 * payment_initiated / payment_recorded / payment_received / reconciled states, no receipt ATTESTATION row; and
 * markCommissionPaid is exported from FOUR files (lib/kernel/financial.ts is the live survivor through
 * app/actions/financial-kernel.ts). In-memory only (the live platform has never paid a commission).
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, listFiles, strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"

export async function run() {
  const c = canary("Commissions / payments: deterministic waterfall → brokerage authorizes → check / direct deposit → recorded + stamped → reconciled · no double payout")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — a payout record is money; the live ledger has never been operated")
  const B = uuid(), ADMIN = uuid(), AG_U = uuid(), AG = uuid(), TX = uuid(), C1 = uuid(), SPLIT = uuid(), STAMP = uuid()
  // WIRED 142K (lane 142C): a SECOND deal's commission walks the seven payment states; its row carries the m787 columns
  // (applied live, so markCommissionPaid's "column exists" rule stamps the instruction instant) and the ledger's net.
  const TX2 = uuid(), C2 = uuid(), SPLIT2 = uuid(), STAMP2 = uuid()
  // WAVE 143 (lane 143C): a THIRD deal whose commission funds are NOT yet recorded as received - the funds-received gate.
  const TX3 = uuid(), C3 = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-pay` }],
    users: [
      { id: ADMIN, email: `broker@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B, platform_role: null },
      { id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B, platform_role: null },
    ],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    transactions: [
      { id: TX, brokerage_id: B, agent_id: AG, status: "closed", stage: "CLOSED", property_address: `1 ${CANARY_TAG} Way`, sales_price: 400_000, close_date: nowIso().slice(0, 10) },
      { id: TX2, brokerage_id: B, agent_id: AG, status: "closed", stage: "CLOSED", property_address: `2 ${CANARY_TAG} Way`, sales_price: 400_000, close_date: nowIso().slice(0, 10) },
      { id: TX3, brokerage_id: B, agent_id: AG, status: "closed", stage: "CLOSED", property_address: `3 ${CANARY_TAG} Way`, sales_price: 400_000, close_date: nowIso().slice(0, 10) },
    ],
    agent_commissions: [
      { id: C3, brokerage_id: B, agent_id: AG, transaction_id: TX3, status: "approved", amount: 16_800, net_to_agent: 16_800, paid_at: null, payment_method: null, deposit_received_at: null, payment_initiated_at: null, created_at: nowIso(), updated_at: nowIso() },
      { id: C1, brokerage_id: B, agent_id: AG, transaction_id: TX, status: "approved", amount: 16_800, paid_at: null, payment_method: null, deposit_received_at: nowIso(), created_at: nowIso(), updated_at: nowIso() },
      { id: C2, brokerage_id: B, agent_id: AG, transaction_id: TX2, status: "approved", amount: 16_800, net_to_agent: 16_800, paid_at: null, payment_method: null, deposit_received_at: nowIso(), payment_initiated_at: null, payment_received_at: null, payment_received_by: null, payment_received_attestation: null, reconciled_at: null, reconciled_by: null, reconciled_via: null, reconciled_reference: null, quickbooks_synced_at: null, quickbooks_export_id: null, created_at: nowIso(), updated_at: nowIso() },
    ],
    commission_splits: [
      { id: SPLIT, brokerage_id: B, commission_id: C1, status: "approved", amount: 16_800, paid_at: null },
      { id: SPLIT2, brokerage_id: B, commission_id: C2, status: "approved", amount: 16_800, paid_at: null },
    ],
    transaction_commissions: [
      { id: STAMP, brokerage_id: B, transaction_id: TX, recipient_type: "agent", recipient_id: AG, status: "approved", calculated_amount: 16_800, paid_date: null },
      { id: STAMP2, brokerage_id: B, transaction_id: TX2, recipient_type: "agent", recipient_id: AG, status: "approved", calculated_amount: 16_800, paid_date: null },
    ],
  })
  setSvc(svc)

  // ── 1 · the waterfall is arithmetic (pure) ──
  const { splitAgentBrokerage } = await import("../../lib/commission/waterfall/04-split-agent-brokerage")
  type Ctx04 = Parameters<typeof splitAgentBrokerage>[0]
  // Stage 04 reads adjustedGrossCents + agentSplitPercent only; the rest of the running context is stage 01–03's.
  const ctx = { transactionId: TX, brokerageId: B, agentId: AG, purchasePriceCents: 40_000_000, grossRateDecimal: 0.06, agentSplitPercent: 70, resolvedFrom: "agent_profile", grossCommissionCents: 2_400_000, adjustedGrossCents: 2_400_000, agentPortionCents: 0, brokeragePortionCents: 0, agentNetCents: 0, brokerageFinalCents: 0, agentFinalNetCents: 0, totalFeesCents: 0, capApplied: false, capStatus: "n/a", amountTowardsCap: 0 } as unknown as Ctx04
  const split = splitAgentBrokerage(ctx)
  const odd = splitAgentBrokerage({ ...ctx, adjustedGrossCents: 1_001, agentSplitPercent: 33.33 })
  c.step("DETERMINISTIC WATERFALL: 70 % of $24,000.00 → agent $16,800.00 / brokerage $7,200.00 in integer cents; an odd split (33.33 % of 1,001 ¢) rounds to integers whose sum is the gross — no cent is created or lost, no model anywhere in lib/commission/waterfall", split.agentPortionCents === 1_680_000 && split.brokeragePortionCents === 720_000 && odd.agentPortionCents + odd.brokeragePortionCents === 1_001 && Number.isInteger(odd.agentPortionCents) && listFiles("lib/commission/waterfall", (f) => /\.ts$/.test(f)).every((f) => !/generateText|generateObject|gatewayChat|Routed\(/.test(strippedRepo(f) ?? "")), `${split.agentPortionCents}/${split.brokeragePortionCents}; odd ${odd.agentPortionCents}+${odd.brokeragePortionCents}`)

  // ── 2 · the brokerage authorizes and pays by CHECK (the kernel's payout record) ──
  const { markCommissionPaid, initiateCommissionPayout } = await import("../../lib/kernel/financial")
  type Ctx = Parameters<typeof markCommissionPaid>[0]["ctx"]
  const broker = { userId: ADMIN, agentId: null, brokerageId: B, userType: "broker", platformRole: null, isTenantPrincipal: true } as unknown as Ctx
  const agentActor = { userId: AG_U, agentId: AG, brokerageId: B, userType: "agent", platformRole: null, isTenantPrincipal: false } as unknown as Ctx
  const refusedAgent = await markCommissionPaid({ ctx: agentActor, commissionId: C1, brokerageId: B, method: "check" })
  c.step("AUTHORITY (fail closed): the AGENT cannot mark their own commission paid — only a brokerage finance admin (BROKERAGE_FINANCE_ADMIN_USER_TYPES) may; nothing changed", !refusedAgent.success && /permission/i.test(refusedAgent.error ?? "") && (svc.tables.agent_commissions ?? [])[0].status === "approved", refusedAgent.error ?? "allowed")
  const paid = await markCommissionPaid({ ctx: broker, commissionId: C1, brokerageId: B, method: "check" })
  const row = (svc.tables.agent_commissions ?? []).find((r) => r.id === C1)
  const splitRow = (svc.tables.commission_splits ?? []).find((r) => r.id === SPLIT)
  const stamp = (svc.tables.transaction_commissions ?? []).find((r) => r.id === STAMP)
  c.step("PAYOUT RECORDED: the broker pays by CHECK → agent_commissions reads paid with payment_method 'check' and a paid_at; the splits ledger mirrors paid; the seven-year DEAL STAMP (transaction_commissions, the agent recipient row) mirrors paid with the paid_date — one payout, three ledgers in agreement", paid.success && row?.status === "paid" && row?.payment_method === "check" && !!row?.paid_at && splitRow?.status === "paid" && stamp?.status === "paid" && !!stamp?.paid_date, paid.success ? `paid_at ${String(row?.paid_at).slice(0, 10)}; stamp ${stamp?.status}/${stamp?.paid_date}` : paid.error)
  const again = await markCommissionPaid({ ctx: broker, commissionId: C1, brokerageId: B, method: "direct_deposit" })
  c.step("NO DOUBLE PAYOUT: paying the same commission again is REFUSED by the transition table (paid is terminal) — the method stays 'check', paid_at unchanged; a correction is a linked adjustment, never a second payout", !again.success && /paid\s*→\s*paid|Invalid status transition/.test(again.error ?? "") && (svc.tables.agent_commissions ?? []).find((r) => r.id === C1)?.payment_method === "check", again.error ?? "paid twice")
  // ── 2b · WAVE 143 (lane 143C): THE FUNDS-RECEIVED GATE - a payout needs the title company's payment recorded as received ──
  const gateInit = await initiateCommissionPayout({ ctx: broker, commissionId: C3, brokerageId: B, method: "check" })
  const gatePaid = await markCommissionPaid({ ctx: broker, commissionId: C3, brokerageId: B, method: "check" })
  const c3Row = (svc.tables.agent_commissions ?? []).find((r) => r.id === C3) as Record<string, any> | undefined // eslint-disable-line @typescript-eslint/no-explicit-any -- the in-memory row
  c.step("FUNDS RECEIVED BEFORE THE AGENT IS PAID (owner, no-CDA flow: 'title pays the brokerage; receipt verified; disbursement authorized; agent paid'): on a deal whose deposit is NOT recorded both initiating and recording a payout are REFUSED by name (funds_not_received) and the row stays approved with no instruction stamped; the same rule that let C1/C2 pay once the deposit was recorded", !gateInit.success && /funds_not_received/.test(gateInit.error ?? "") && !gatePaid.success && /funds_not_received/.test(gatePaid.error ?? "") && c3Row?.status === "approved" && !c3Row?.payment_initiated_at, gatePaid.error)
  const evidence = [...(svc.tables.lifecycle_events ?? []), ...(svc.tables.kernel_events ?? []), ...(svc.tables.agent_action_ledger ?? [])].filter((e) => JSON.stringify(e).includes(C1))
  console.log(`    evidence rows naming the payout: ${evidence.length} (${[...new Set(evidence.map((e) => String(e.event ?? e.event_type ?? e.action ?? "?")))].join(",") || "none"})`)

  // ── 3 · the stamp ↔ ledger rule (pure): un-paying clears the instant ──
  const { ledgerPatchFromStamp, stampPatchFromLedger, COMMISSION_LEDGER_STATUSES } = await import("../../lib/commission/ledger-sync")
  c.step("STAMP ↔ LEDGER: a paid stamp carries its disbursement instant; an approved stamp CLEARS paid_at (un-paying cannot leave a stale instant); a status outside the vocabulary patches nothing (null, never a guess); the vocabulary is pending / approved / paid / disputed", ledgerPatchFromStamp({ status: "paid", paid_date: "2026-10-19" })?.paid_at?.startsWith("2026-10-19") === true && ledgerPatchFromStamp({ status: "approved", paid_date: "2026-10-19" })?.paid_at === null && ledgerPatchFromStamp({ status: "payment_recorded" }) === null && stampPatchFromLedger({ status: "paid", paid_at: "2026-10-19T15:00:00.000Z" })?.paid_date === "2026-10-19" && [...COMMISSION_LEDGER_STATUSES].join() === "pending,approved,paid,disputed", [...COMMISSION_LEDGER_STATUSES].join(","))

  // ── 4 · QuickBooks: matched against REAL markers only (pure) ──
  const { reconcileLedgerRows } = await import("../../lib/finance/qb-reconciliation")
  const recon = reconcileLedgerRows([{ id: "a", label: "A", amount: 100, exportId: "qb_1", syncedAt: nowIso() }, { id: "b", label: "B", amount: 50, exportId: "qb_2", syncedAt: nowIso() }, { id: "c", label: "C", amount: 25, exportId: null, syncedAt: null }])
  const empty = reconcileLedgerRows([])
  const qb = strippedRepo("lib/finance/qb-reconciliation.ts") ?? ""
  c.step("QUICKBOOKS RECONCILIATION: 2 of 3 rows carry a real export marker → 67 % coverage, the unexported row named with its amount; ZERO rows → coverage null (never 100 % — 0 rows proves nothing); a scope with no connected integration reads not_connected and unapplied marker columns read requires_migration (no numbers invented)", recon.coveragePct === 67 && recon.unexported.map((r) => r.id).join() === "c" && recon.unexportedAmount === 25 && empty.coveragePct === null && empty.totalRows === 0 && /["']not_connected["']/.test(qb) && /["']requires_migration["']/.test(qb), `coverage ${recon.coveragePct}%; empty ${empty.coveragePct}`)

  // ── 5 · Stripe never executes a brokerage payout; the duplicate census ──
  const stripeRail = (s: string) => /\w+\.(transfers|payouts)\.create\s*\(/.test(s)
  const stripeInFinance = ["lib/kernel/financial.ts", "lib/commission/payment-tracker.ts", "lib/commission/engine.ts", "lib/commission/finalization.ts"].filter((f) => stripeRail(strippedRepo(f) ?? ""))
  c.step("STRIPE BILLING NEVER PAYS AN AGENT: no commission module calls stripe transfers / payouts (0 of 4) — the payout is a RECORD (check / direct deposit); POSITIVE CONTROL: the finder recognises `stripe.transfers.create(` in a specimen and ignores the same words in prose (the vendor payout rail names it only in comments; its Stripe call rides the payment provider abstraction)", stripeInFinance.length === 0 && stripeRail("await stripe.transfers.create({ amount })") && !stripeRail(stripComments("// stripe.transfers.create() with destination\nconst x = 1")), stripeInFinance.join(",") || "0 of 4")
  const dup = [...listFiles("lib", (f) => /\.ts$/.test(f)), ...listFiles("app/actions", (f) => /\.ts$/.test(f))].filter((f) => /export\s+async\s+function\s+markCommissionPaid\s*\(/.test(strippedRepo(f) ?? ""))
  console.log(`    finding (lane 142C, §6 one vocabulary / §1 one survivor): markCommissionPaid is exported from ${dup.length} files — ${dup.join(", ")}; the live survivor is lib/kernel/financial.ts (app/actions/financial-kernel.ts markCommissionPaidAction)`)

  // ── WAVE142 HOOK (integrator): 142C — the payment states + receipt attestation on the one vocabulary. ──
  for (const h of hooksFor("commission-payment")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, `measured: COMMISSION_LEDGER_STATUSES = ${[...COMMISSION_LEDGER_STATUSES].join("/")} — no payment_initiated / payment_recorded / payment_received / reconciled, no receipt attestation; markCommissionPaid ×${dup.length}`); continue }
    // WAVE142 HOOK (integrator): 142C — wired 142K: the seven states DERIVED (pure) and the no-CDA flow walked in memory
    // on ONE row through the kernel's three new writers + the existing payout record.
    const { deriveCommissionPaymentState, COMMISSION_PAYMENT_STATES, COMMISSION_PAYMENT_STATE_LABELS } = await import("../../lib/commission/ledger-sync")
    const { attestCommissionReceived, reconcileCommissionPayment } = await import("../../lib/kernel/financial")
    const ladder = [{ status: "pending" }, { status: "pending", preliminary_statement_at: "x" }, { status: "approved" }, { status: "approved", payment_initiated_at: "x" }, { status: "paid", paid_at: "x" }, { status: "paid", payment_received_at: "x" }, { status: "paid", reconciled_at: "x" }].map((r) => deriveCommissionPaymentState(r).state)
    const held = deriveCommissionPaymentState({ status: "disputed", paid_at: "x" })
    c.step(`${h.lane} landed (${at}) — THE SEVEN PAYMENT STATES are DERIVED from the one four-value status + the evidence stamps (never a fifth status column — §6): expected → preliminary → approved_final → payment_initiated → payment_recorded → payment_received → reconciled, the later evidence wins; a DISPUTE holds the state its evidence reached (held) rather than inventing one; one tenant-facing label per state`, ladder.join() === [...COMMISSION_PAYMENT_STATES].join() && held.state === "payment_recorded" && held.held && COMMISSION_PAYMENT_STATES.every((s) => !!COMMISSION_PAYMENT_STATE_LABELS[s]), ladder.join(" → "))
    const c2 = () => (svc.tables.agent_commissions ?? []).find((r) => r.id === C2) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- the in-memory row
    const state = () => deriveCommissionPaymentState(c2() as never).state
    const s0 = state()
    const init = await initiateCommissionPayout({ ctx: broker, commissionId: C2, brokerageId: B, method: "check", reference: "chk 1042" })
    const initAgain = await initiateCommissionPayout({ ctx: broker, commissionId: C2, brokerageId: B, method: "direct_deposit" })
    const s1 = state()
    // Snapshots at this instant — the checks below are read after the whole flow has run.
    const afterInit = { status: c2().status, method: c2().payment_method, initiatedAt: c2().payment_initiated_at }
    const paid2 = await markCommissionPaid({ ctx: broker, commissionId: C2, brokerageId: B, method: "check" })
    const s2 = state()
    const stranger = { ...(agentActor as object), agentId: uuid() } as unknown as Ctx
    const attestation = { amount: 16_800, receivedAt: "2026-10-19", payer: "Canary Brokerage", method: "check" as const, reference: "chk 1042" }
    const foreignAttest = await attestCommissionReceived({ ctx: stranger, commissionId: C2, brokerageId: B, attestation })
    const attest = await attestCommissionReceived({ ctx: agentActor, commissionId: C2, brokerageId: B, attestation })
    const attestAgain = await attestCommissionReceived({ ctx: agentActor, commissionId: C2, brokerageId: B, attestation })
    const s3 = state()
    const qb = await reconcileCommissionPayment({ ctx: broker, commissionId: C2, brokerageId: B, via: "quickbooks" })
    const manualNoRef = await reconcileCommissionPayment({ ctx: broker, commissionId: C2, brokerageId: B, via: "manual" })
    const recon = await reconcileCommissionPayment({ ctx: broker, commissionId: C2, brokerageId: B, via: "manual", reference: "stmt 2026-10 line 14" })
    const reconAgain = await reconcileCommissionPayment({ ctx: broker, commissionId: C2, brokerageId: B, via: "manual", reference: "stmt 2026-10 line 14" })
    const initOnPaid = await initiateCommissionPayout({ ctx: broker, commissionId: C2, brokerageId: B, method: "check" })
    const s4 = state()
    const flow: Array<[string, boolean]> = [
      ["starts approved_final", s0 === "approved_final"],
      ["initiate (check)", init.success && init.data?.alreadyInitiated === false],
      ["second initiate = alreadyInitiated, method not re-stamped", initAgain.success && initAgain.data?.alreadyInitiated === true && afterInit.method === "check"],
      ["status still approved after initiate", afterInit.status === "approved" && afterInit.initiatedAt === init.data?.initiatedAt && s1 === "payment_initiated"],
      ["ledger posts (markCommissionPaid)", paid2.success && c2().status === "paid" && s2 === "payment_recorded"],
      ["instruction instant kept through the post", c2().payment_initiated_at === init.data?.initiatedAt && c2().payment_method === "check"],
      ["stranger's attestation refused", !foreignAttest.success && /agent who owns/.test(foreignAttest.error ?? "")],
      ["agent attests, amount matches ledger", attest.success && attest.data?.amountMatchesLedger === true && c2().payment_received_attestation?.payer === "Canary Brokerage" && c2().payment_received_attestation?.on_behalf === false && c2().payment_received_by === AG_U && s3 === "payment_received"],
      ["second attestation refused", !attestAgain.success && /already_attested/.test(attestAgain.error ?? "")],
      ["quickbooks refused without a confirmed export", !qb.success && /quickbooks_not_synced/.test(qb.error ?? "")],
      ["manual reconcile needs a reference", !manualNoRef.success],
      ["manual reconcile with a statement reference", recon.success && recon.data?.via === "manual" && c2().reconciled_reference === "stmt 2026-10 line 14" && c2().reconciled_by === ADMIN && s4 === "reconciled"],
      ["second reconcile refused", !reconAgain.success && /already_reconciled/.test(reconAgain.error ?? "")],
      ["payout on a paid row initiates nothing", initOnPaid.success && initOnPaid.data?.alreadyInitiated === true],
      ["one ledger row", (svc.tables.agent_commissions ?? []).filter((r) => r.id === C2).length === 1],
    ]
    const flowBad = flow.filter(([, ok]) => !ok).map(([n]) => n)
    c.step(`${h.lane} the NO-CDA FLOW end to end in memory on ONE row, every refusal READ: approved_final → the brokerage INITIATES the payout by CHECK (payment_initiated_at + method stamped; a second initiate reports alreadyInitiated and re-stamps nothing) → payment_initiated → the ledger POSTS it (markCommissionPaid keeps the instruction instant) → payment_recorded → the AGENT ATTESTS receipt (amount, date, payer, method, reference; a stranger's attestation refused; the amount matches the ledger's net) → payment_received; a second attestation refused by name (already_attested) → RECONCILED only against the ACTUAL connected integration (quickbooks refused: no confirmed export on the row) or a bank / statement reference (manual without one refused) → reconciled; a second reconcile refused (already_reconciled); a payout on a paid row initiates NOTHING (no duplicate payouts); the ledger stays ONE row; Stripe is never in the path (asserted above)`, flowBad.length === 0, `${s0} → ${s1} → ${s2} → ${s3} → ${s4}${flowBad.length ? `; FAILED: ${flowBad.join(", ")} — ${[init, initAgain, paid2, foreignAttest, attest, attestAgain, qb, manualNoRef, recon, reconAgain, initOnPaid].map((r) => (r.success ? "ok" : r.error)).join(" | ")}` : ""}`)
  }
  c.blind("The kernel's markCommissionPaid ran in memory with the finance-admin gate on the actor context (no session); the COMMISSION_PAID event's fan-out is counted, not asserted. The waterfall's other ten stages are the commission proofs' (test:commission-*). QuickBooks is the pure reconciler on fixtures — no QuickBooks connection, no export, no Stripe call.")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
