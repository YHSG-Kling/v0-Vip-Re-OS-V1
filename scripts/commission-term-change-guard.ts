#!/usr/bin/env tsx
/**
 * scripts/commission-term-change-guard.ts — wave 153, lane 153B (owner ruling 4, 2026-11-14: "anyone attached to the
 * offer/listing/transaction that holds a seat or admin can change comission terms but not after a transaction has closed").
 *
 * Drives the REAL survivor on the in-memory client (scripts/in-memory-supabase.ts — no network, no model, SIMULATED):
 *   lib/commission/commission-term-change.ts loadCommissionTermsForChange / requestCommissionTermChange /
 *   decideCommissionTermChange / withdrawCommissionTermChange / listPendingCommissionTermChanges, through the REAL
 *   lib/kernel/action-ledger.ts withActionLedger (idempotency on the unique key), with the waterfall re-run injected.
 * The directive's proofs (153B, B1/B2), each with an adverse case and a positive control:
 *   1 who may submit: unrelated seat refused · vendor / Contact refused · another tenant's deal not found · the deal's agent,
 *     the deal team's lead, the assigned TC and a finance admin may — seat membership alone never does;
 *   2 the approval path: the agent where the brokerage requires (or never answered) approval → requested, rate unchanged,
 *     the broker told; the agent where no approval is required → applied; a TC / team lead always request; a finance admin
 *     applies directly;
 *   3 an executed agreement governs → refused without executed evidence; with it, the broker still reviews;
 *   4 conflicting versions: a second change while one is pending is refused; a decision against a value that moved since
 *     the request is a named conflict, the rate untouched;
 *   5 frozen: closed · funded (closed / payout pending) · fell through (refunded) · finalized · posted · paid refuse,
 *     naming the separately ledgered correction;
 *   6 re-run does not duplicate: the same submission key twice → one record, one waterfall run (replayed); a second
 *     decision → refused, the rate moved once;
 *   7 the decision door: finance admins only; a denial needs its reason and keeps the rate; the requester may withdraw;
 *   8 the anchors: a listing with no deal (its own rate), a listing with a deal (judged on the deal), an offer (flat amount),
 *     a promoted offer (judged on the deal);
 *   9 evidence: the ledger rows (FINANCIAL, before → after), the deal team told (agent, team lead, TC, finance + compliance;
 *     never the actor), m902 absent → refused by name;
 *  10 the shared ledger's partitions: a term change is never listed, approved or held as an agent concession;
 *  11 wiring (stripped source, positive controls): the ungated commission write is closed, stage 03 never nets a term change,
 *     the doors and the screens reach the writer, the proof is registered and RUN by the guard chain.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try { const so = _require.resolve("server-only"); _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as any } catch { /* not installed */ }

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(src(p))
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn() } finally { console.warn = w; console.error = e; console.log = l } }

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const A = u(1), B = u(2)
const U_BROKER = u(11), U_AG1 = u(12), U_AG2 = u(13), U_LEAD = u(14), U_LEAD2 = u(15), U_TC = u(16), U_COMP = u(17), U_VENDOR = u(18), U_CONTACT = u(19), U_BBROKER = u(20)
const A1 = u(21), A2 = u(22), ALEAD = u(23), ALEAD2 = u(24), TEAM1 = u(31), TEAM2 = u(32), TC1 = u(33)
const T_OPEN = u(41), T_CLOSED = u(42), T_FUNDED = u(43), T_LOST = u(44), T_FINAL = u(45), T_POSTED = u(46), T_PAID = u(47), T_GOV = u(48), T_B = u(49)
const L_FREE = u(51), L_DEAL = u(52), L_GOV = u(53), LA_GOV = u(54), O_DRAFT = u(55), O_PROMOTED = u(56), DOC_AMEND = u(57), DOC_B = u(58)

type Actor = { userId: string; agentId: string | null; brokerageId: string; userType: string; isTenantPrincipal?: boolean }
const actor = (userId: string, userType: string, agentId: string | null = null, brokerageId = A): Actor => ({ userId, agentId, brokerageId, userType, isTenantPrincipal: false })
const BROKER = actor(U_BROKER, "broker"), AG1 = actor(U_AG1, "agent", A1), AG2 = actor(U_AG2, "agent", A2), LEAD = actor(U_LEAD, "team_lead", ALEAD)
const LEAD2 = actor(U_LEAD2, "team_lead", ALEAD2), TC = actor(U_TC, "tc"), COMP = actor(U_COMP, "compliance_officer"), VENDOR = actor(U_VENDOR, "vendor"), CONTACT = actor(U_CONTACT, "contact")

const deal = (id: string, over: Row = {}): Row => ({ id, brokerage_id: A, status: "under_contract", stage: "INSPECTION", deleted_at: null, deal_name: `Deal ${id.slice(-2)}`, property_address: `${id.slice(-2)} Oak St`, agent_id: A1, buyer_agent_id: null, seller_agent_id: null, coordinator_id: null, commission_percentage: 3, commission_finalized_at: null, purchase_price: 400000, listing_id: null, buyer_contact_id: null, offer_id: null, created_at: "2026-11-01T00:00:00.000Z", ...over })

function seed(over: Partial<Record<string, Row[]>> = {}, opts: Parameters<typeof memSupabase>[1] = {}) {
  const base: Record<string, Row[]> = {
    brokerages: [{ id: A, plan_tier: "brokerage", agent_concession_approval: null }, { id: B, plan_tier: "brokerage", agent_concession_approval: "no_approval_required" }],
    users: [
      { id: U_BROKER, brokerage_id: A, user_type: "broker" }, { id: U_AG1, brokerage_id: A, user_type: "agent" }, { id: U_AG2, brokerage_id: A, user_type: "agent" },
      { id: U_LEAD, brokerage_id: A, user_type: "team_lead" }, { id: U_LEAD2, brokerage_id: A, user_type: "team_lead" }, { id: U_TC, brokerage_id: A, user_type: "tc" },
      { id: U_COMP, brokerage_id: A, user_type: "compliance_officer" }, { id: U_VENDOR, brokerage_id: A, user_type: "vendor" }, { id: U_CONTACT, brokerage_id: A, user_type: "contact" },
      { id: U_BBROKER, brokerage_id: B, user_type: "broker" },
    ],
    agents: [
      { id: A1, brokerage_id: A, user_id: U_AG1, team_id: TEAM1 }, { id: A2, brokerage_id: A, user_id: U_AG2, team_id: null },
      { id: ALEAD, brokerage_id: A, user_id: U_LEAD, team_id: TEAM1 }, { id: ALEAD2, brokerage_id: A, user_id: U_LEAD2, team_id: TEAM2 },
    ],
    teams: [{ id: TEAM1, brokerage_id: A, team_lead_id: U_LEAD, deleted_at: null }, { id: TEAM2, brokerage_id: A, team_lead_id: U_LEAD2, deleted_at: null }],
    transaction_coordinators: [{ id: TC1, brokerage_id: A, user_id: U_TC, is_active: true }],
    transactions: [
      deal(T_OPEN, { coordinator_id: TC1, listing_id: L_DEAL }),
      deal(T_CLOSED, { status: "closed", stage: "CLOSED" }),
      deal(T_FUNDED, { status: "funded", stage: "CLOSED" }),
      deal(T_LOST, { status: "lost", stage: "LOST" }),
      deal(T_FINAL, { commission_finalized_at: "2026-11-10T12:00:00.000Z" }),
      deal(T_POSTED),
      deal(T_PAID, { status: "clear_to_close" }),
      deal(T_GOV, { listing_id: L_GOV }),
      { ...deal(T_B), brokerage_id: B, agent_id: null },
    ],
    commission_distributions: [{ id: u(61), brokerage_id: A, transaction_id: T_POSTED, status: "pending" }],
    agent_commissions: [{ id: u(62), brokerage_id: A, transaction_id: T_PAID, status: "paid" }],
    listings: [
      { id: L_FREE, brokerage_id: A, agent_id: A1, team_id: null, status: "active", deleted_at: null, commission_rate: 6, list_price: 500000, address: "1 Free Listing Ln" },
      { id: L_DEAL, brokerage_id: A, agent_id: A1, team_id: null, status: "pending", deleted_at: null, commission_rate: 6, list_price: 400000, address: "41 Oak St" },
      { id: L_GOV, brokerage_id: A, agent_id: A1, team_id: null, status: "pending", deleted_at: null, commission_rate: 6, list_price: 400000, address: "48 Oak St" },
    ],
    listing_agreements: [{ id: LA_GOV, brokerage_id: A, listing_id: L_GOV, esign_status: "fully_executed", fully_executed_at: "2026-10-01T00:00:00.000Z", total_commission_rate: 6, listing_commission_rate: 3, commission_flat_amount: null }],
    buyer_broker_agreements: [],
    offers: [
      { id: O_DRAFT, brokerage_id: A, agent_id: A1, transaction_id: null, listing_id: null, contact_id: null, status: "draft", esign_status: null, buyer_signed_at: null, seller_signed_at: null, fully_signed_contract_received_at: null, disclosed_buyer_commission_pct: null, disclosed_buyer_commission_flat: 5000, offer_price: 350000, property_address: "9 Draft Ct" },
      { id: O_PROMOTED, brokerage_id: A, agent_id: A1, transaction_id: T_OPEN, listing_id: L_DEAL, contact_id: null, status: "accepted", esign_status: "fully_signed", buyer_signed_at: "x", seller_signed_at: "x", fully_signed_contract_received_at: "x", disclosed_buyer_commission_pct: 2.5, disclosed_buyer_commission_flat: null, offer_price: 400000, property_address: "41 Oak St" },
    ],
    documents: [{ id: DOC_AMEND, brokerage_id: A }, { id: DOC_B, brokerage_id: B }],
    commission_adjustments: [], agent_action_ledger: [], notifications: [], closing_disclosure_agreement: [], tenant_policy_versions: [],
  }
  return memSupabase({ ...base, ...over } as Record<string, Row[]>, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, ...opts })
}

async function main() {
  const W = await import("../lib/commission/commission-term-change")
  const { requestCommissionTermChange, decideCommissionTermChange, withdrawCommissionTermChange, listPendingCommissionTermChanges, loadCommissionTermsForChange } = W
  let recomputes: string[] = []
  const deps = { recompute: async (i: { transactionId: string }) => { recomputes.push(i.transactionId); return { ok: true as const, gross: 10000, agentNet: 7000, brokerageNet: 3000 } } }
  let k = 0
  const key = () => `proof-submission-${++k}-${Date.now()}`
  const ask = (db: any, who: Actor, over: Record<string, unknown> = {}) => quiet(() => requestCommissionTermChange(db, who as any, { transactionId: T_OPEN, valueType: "percent", value: 2.5, reason: "Seller asked for a lower rate at inspection", effectiveDate: "2026-11-14", idempotencyKey: key(), ...over } as any, deps))
  const rate = (db: any, id = T_OPEN) => (db.tables.transactions as Row[]).find((t) => t.id === id)?.commission_percentage
  const termRows = (db: any) => (db.tables.commission_adjustments as Row[]).filter((r) => r.adjustment_type === "rate_override")

  // ── 1 ─────────────────────────────────────────────────────────────────────
  section("1 · who may submit — attached seat or finance admin; never seat membership alone")
  {
    const db = seed()
    const r = await ask(db, AG2)
    check("ADVERSE: an agent of the same workspace who is NOT on the deal is refused (not attached)", !r.ok && /^not_attached/.test(r.ok ? "" : r.error))
    const r2 = await ask(db, LEAD2)
    check("ADVERSE: a team lead whose team is not on the deal is refused (holding a team_lead seat is not permission)", !r2.ok && /^not_attached/.test(r2.ok ? "" : r2.error))
    const r3 = await ask(db, COMP)
    check("ADVERSE: the compliance officer (reads the books, never keeps them) is refused", !r3.ok && /^not_attached/.test(r3.ok ? "" : r3.error))
    const rv = await ask(db, VENDOR), rc = await ask(db, CONTACT)
    check("ADVERSE: a vendor and a Contact are refused outright — even before anything about the deal is shown", !rv.ok && !rc.ok && /^forbidden/.test(rv.ok ? "" : rv.error) && /^forbidden/.test(rc.ok ? "" : rc.error))
    // THE SEAT RULE, over the whole STORED vocabulary rather than two specimens: a seat is refused outright exactly when
    // it is neither on the tenant roster nor one of the two deal seats. Read from the generated cache and the live Set, so
    // neither side of this comparison is a list typed here.
    const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
    const { TENANT_ADMIN_USER_TYPES } = await import("../lib/auth/resolve-user-role")
    const stored = CHECK_VOCABULARIES.users?.user_type ?? []
    const wrong: string[] = []
    for (const t of stored) {
      // A fresh workspace per seat: a finance-admin seat is ALLOWED and applies directly, which is a real write, and it
      // must not land in the workspace the "none of those refusals wrote anything" control below reads.
      const res = await ask(seed(), actor(u(900 + stored.indexOf(t)), t))
      const outright = !res.ok && /^forbidden/.test(res.error)
      const dealSeat = TENANT_ADMIN_USER_TYPES.has(t) || t === "agent" || t === "tc"
      if (outright === dealSeat) wrong.push(`${t}:${res.ok ? "ok" : res.error.split(":")[0]}`)
    }
    check(`every stored seat outside the tenant roster + agent + tc is refused outright, and no seat inside it is (${stored.length} stored seats)`, stored.length >= 10 && wrong.length === 0, wrong.join(", "))
    const blank = await ask(seed(), actor(u(990), "")), unknown = await ask(seed(), actor(u(991), "a_seat_nobody_stored"))
    check("FAIL CLOSED: a seat whose type is empty or unknown is refused outright — it never reaches the attachment test", !blank.ok && /^forbidden/.test(blank.error) && !unknown.ok && /^forbidden/.test(unknown.error))
    const view = await quiet(() => loadCommissionTermsForChange(db as any, VENDOR as any, { transactionId: T_OPEN }))
    check("ADVERSE: a vendor cannot even LOAD the commission terms (§5: no financials for vendors / Contacts)", !view.ok)
    const rb = await ask(db, actor(U_BBROKER, "broker", null, B))
    check("ADVERSE: another workspace's finance admin naming this deal gets 'not found' (tenant from the session)", !rb.ok && /^deal_not_found/.test(rb.ok ? "" : rb.error))
    check("POSITIVE CONTROL: none of those refusals wrote anything", termRows(db).length === 0 && rate(db) === 3)
  }

  // ── 2 ─────────────────────────────────────────────────────────────────────
  section("2 · the approval path follows the brokerage's policy and the person's authority")
  {
    const db = seed()
    recomputes = []
    const r = await ask(db, AG1)
    check("the deal's agent where the brokerage never answered the approval question → REQUESTED (fail closed), rate unchanged", r.ok && r.record.approvalStatus === "requested" && !r.applied && rate(db) === 3, r.ok ? r.record.approvalStatus : r.error)
    check("…the record carries actor, before → after, reason, effective date (no waterfall run for a proposal)", r.ok && r.record.requestedBy === U_AG1 && r.record.priorValue === 3 && r.record.value === 2.5 && /lower rate/.test(r.record.reason ?? "") && r.record.effectiveDate === "2026-11-14" && recomputes.length === 0)
    const told = (db.tables.notifications as Row[]).filter((n) => n.type === "commission_term_change_requested")
    check("…and the deal team is told: the broker, the team lead, the TC and compliance — never the agent who asked", told.some((n) => n.user_id === U_BROKER) && told.some((n) => n.user_id === U_LEAD) && told.some((n) => n.user_id === U_TC) && told.some((n) => n.user_id === U_COMP) && !told.some((n) => n.user_id === U_AG1) && !told.some((n) => n.user_id === U_VENDOR || n.user_id === U_CONTACT))
    const pending = await quiet(() => listPendingCommissionTermChanges(db as any, BROKER as any))
    check("the finance queue lists it; an agent cannot read the queue", pending.ok && pending.records.length === 1 && !(await quiet(() => listPendingCommissionTermChanges(db as any, AG1 as any))).ok)
    const ok = r.ok ? await quiet(() => decideCommissionTermChange(db as any, BROKER as any, { adjustmentId: r.record.id, decision: "approved" }, deps)) : null
    check("the broker approves → the deal's rate moves 3% → 2.5%, the record is approved + applied, the waterfall re-runs ONCE", !!ok?.ok && rate(db) === 2.5 && ok.record.approvalStatus === "approved" && !!ok.record.appliedAt && recomputes.length === 1 && ok.recalculated?.ok === true)
    check("…and the settlement recheck is requested", !!ok?.ok && ok.recheck.some((x) => /settlement statement/.test(x)))

    const open = seed({ brokerages: [{ id: A, plan_tier: "brokerage", agent_concession_approval: "no_approval_required" }] })
    recomputes = []
    const r2 = await ask(open, AG1)
    check("the deal's agent where the brokerage EXPLICITLY requires no approval → applied at once, the waterfall re-run", r2.ok && r2.applied && r2.record.approvalStatus === "not_required" && rate(open) === 2.5 && recomputes.length === 1)
    const tc = await ask(seed({ brokerages: [{ id: A, plan_tier: "brokerage", agent_concession_approval: "no_approval_required" }] }), TC)
    const lead = await ask(seed({ brokerages: [{ id: A, plan_tier: "brokerage", agent_concession_approval: "no_approval_required" }] }), LEAD)
    check("the assigned TC and the deal team's lead may submit — but always as a REQUEST (neither holds the brokerage's books)", tc.ok && tc.record.approvalStatus === "requested" && lead.ok && lead.record.approvalStatus === "requested")
    const fin = seed()
    recomputes = []
    const r3 = await ask(fin, BROKER)
    check("a finance admin applies directly (they are the broker review), and the deal team is told it changed", r3.ok && r3.applied && rate(fin) === 2.5 && (fin.tables.notifications as Row[]).some((n) => n.type === "commission_term_changed" && n.user_id === U_AG1) && !(fin.tables.notifications as Row[]).some((n) => n.user_id === U_BROKER))
    const principal = seed()
    const r4 = await ask(principal, { ...actor(U_LEAD, "team_lead", ALEAD), isTenantPrincipal: true })
    check("a TEAM-tier principal (the lead IS the tenant, m526) applies directly", r4.ok && r4.applied && rate(principal) === 2.5)
  }

  // ── 3 ─────────────────────────────────────────────────────────────────────
  section("3 · an executed agreement governs → executed evidence and broker review")
  {
    const db = seed({ brokerages: [{ id: A, plan_tier: "brokerage", agent_concession_approval: "no_approval_required" }] })
    const r = await ask(db, AG1, { transactionId: T_GOV })
    check("ADVERSE: the executed listing agreement states the rate and no amendment is attached → refused (a proposal is not a signed modification)", !r.ok && /^evidence_required/.test(r.ok ? "" : r.error))
    const rForeign = await ask(db, AG1, { transactionId: T_GOV, evidenceDocumentId: DOC_B })
    check("ADVERSE: an 'amendment' stored in another workspace is not evidence", !rForeign.ok && /^evidence_not_found/.test(rForeign.ok ? "" : rForeign.error))
    const r2 = await ask(db, AG1, { transactionId: T_GOV, evidenceDocumentId: DOC_AMEND })
    check("with the executed amendment, even where the brokerage requires no approval, the broker still reviews (requested)", r2.ok && r2.record.approvalStatus === "requested" && r2.record.evidenceDocumentId === DOC_AMEND && rate(db, T_GOV) === 3)
    const view = await quiet(() => loadCommissionTermsForChange(db as any, AG1 as any, { transactionId: T_GOV }))
    check("the panel shows the governing agreement and says the amendment + broker review are needed", view.ok && view.view.governing.some((g) => g.kind === "listing_agreement" && g.id === LA_GOV) && /executed amendment/.test(view.view.approvalNote))
    const fin = await ask(seed(), BROKER, { transactionId: T_GOV, evidenceDocumentId: DOC_AMEND })
    check("a finance admin with the executed amendment applies it", fin.ok && fin.applied)
    const refused = await ask(seed({}, { refuse: { listing_agreements: "permission denied for table listing_agreements" } }), BROKER, { transactionId: T_GOV })
    check("FAIL CLOSED: an agreement read that is refused refuses the change ('nobody checked' is never 'nothing governs')", !refused.ok && /agreement_read_refused/.test(refused.ok ? "" : refused.error))
  }

  // ── 4 ─────────────────────────────────────────────────────────────────────
  section("4 · conflicting versions are resolved by a person, never raced")
  {
    const db = seed()
    const first = await ask(db, AG1)
    const second = await ask(db, LEAD, { value: 2.75 })
    check("ADVERSE: a second change while the first awaits the broker is refused (decide or withdraw the first)", first.ok && !second.ok && /^conflicting_pending/.test(second.ok ? "" : second.error))
    ;(db.tables.transactions as Row[]).find((t) => t.id === T_OPEN)!.commission_percentage = 2.8 // the rate moved some other way since the request
    const dec = first.ok ? await quiet(() => decideCommissionTermChange(db as any, BROKER as any, { adjustmentId: first.record.id, decision: "approved" }, deps)) : null
    check("ADVERSE: approving a request whose prior value no longer matches the deal is a named CONFLICT — the rate is untouched", !!dec && !dec.ok && /^conflict/.test(dec.ok ? "" : dec.error) && rate(db) === 2.8)
    const deny = first.ok ? await quiet(() => decideCommissionTermChange(db as any, BROKER as any, { adjustmentId: first.record.id, decision: "denied", note: "Superseded by the executed amendment of Nov 12" }, deps)) : null
    check("…the broker resolves it by denying (with the reason); the rate stays as the deal now carries it", !!deny?.ok && deny.record.approvalStatus === "denied" && rate(db) === 2.8)
  }

  // ── 5 ─────────────────────────────────────────────────────────────────────
  section("5 · frozen: after close, the terms are never silently rewritten")
  {
    const db = seed()
    const cases: Array<[string, string, RegExp]> = [
      [T_CLOSED, "closed", /closed/], [T_FUNDED, "funded — CLOSED / PAYOUT PENDING", /closed \(including closed with the payout pending\)/],
      [T_LOST, "fell through (refunded)", /fell through/], [T_FINAL, "finalized (CDA signed / final CD)", /finalized/],
      [T_POSTED, "posted to the ledger", /posted/], [T_PAID, "payout paid", /approved or paid/],
    ]
    for (const [tid, label, re] of cases) {
      const r = await ask(db, BROKER, { transactionId: tid })
      check(`ADVERSE: ${label} → refused, even for a finance admin`, !r.ok && /^frozen/.test(r.ok ? "" : r.error) && re.test(r.ok ? "" : r.error), r.ok ? "applied!" : r.error)
    }
    const closed = await ask(db, BROKER, { transactionId: T_CLOSED })
    check("…the refusal names the post-close path: a separately ledgered adjustment on the commission breakdown", !closed.ok && /separately ledgered adjustment/.test(closed.ok ? "" : closed.error))
    check("POSITIVE CONTROL: nothing on a frozen deal moved and nothing was recorded", [T_CLOSED, T_FUNDED, T_LOST, T_FINAL, T_POSTED, T_PAID].every((t) => rate(db, t) === 3) && termRows(db).length === 0)
    // a request made while open, then the deal closes before the broker decides
    const live = seed()
    const req = await ask(live, AG1)
    ;(live.tables.transactions as Row[]).find((t) => t.id === T_OPEN)!.status = "closed"
    const late = req.ok ? await quiet(() => decideCommissionTermChange(live as any, BROKER as any, { adjustmentId: req.record.id, decision: "approved" }, deps)) : null
    check("ADVERSE: a request pending when the deal closed can no longer be approved (frozen) — it can only be denied", !!late && !late.ok && /^frozen/.test(late.ok ? "" : late.error) && rate(live) === 3)
    const view = await quiet(() => loadCommissionTermsForChange(db as any, AG1 as any, { transactionId: T_FUNDED }))
    check("the panel on a closed deal shows the terms with the freeze reason (no form)", view.ok && !!view.view.frozen && view.view.current.percent === 3)
  }

  // ── 6 ─────────────────────────────────────────────────────────────────────
  section("6 · re-running never duplicates")
  {
    const db = seed({ brokerages: [{ id: A, plan_tier: "brokerage", agent_concession_approval: "no_approval_required" }] })
    recomputes = []
    const same = { idempotencyKey: "same-submission-key-0001" }
    const r1 = await ask(db, AG1, same)
    const r2 = await ask(db, AG1, same)
    check("the same submission twice → ONE record, ONE rate move, ONE waterfall run; the second says replayed", r1.ok && r2.ok && r2.replayed && r2.record.id === r1.record.id && termRows(db).length === 1 && rate(db) === 2.5 && recomputes.length === 1)
    check("…one ledger row per submission (FINANCIAL, before → after, the policy that decided)", (db.tables.agent_action_ledger as Row[]).filter((l) => l.action === "finance.commission_term.changed").length === 1 && (db.tables.agent_action_ledger as Row[]).some((l) => l.risk_class === "FINANCIAL" && l.detail?.before === 3 && l.detail?.after === 2.5 && /^commission_payout_policy@/.test(String(l.policy_ref ?? l.detail?.policy_ref ?? ""))))
    const req = seed()
    recomputes = []
    const p = await ask(req, AG1)
    const d1 = p.ok ? await quiet(() => decideCommissionTermChange(req as any, BROKER as any, { adjustmentId: p.record.id, decision: "approved" }, deps)) : null
    const d2 = p.ok ? await quiet(() => decideCommissionTermChange(req as any, BROKER as any, { adjustmentId: p.record.id, decision: "approved" }, deps)) : null
    check("a second decision on the same request is refused; the rate moved once and the waterfall ran once", !!d1?.ok && !!d2 && !d2.ok && rate(req) === 2.5 && recomputes.length === 1)
  }

  // ── 7 ─────────────────────────────────────────────────────────────────────
  section("7 · the decision door")
  {
    const db = seed()
    const p = await ask(db, AG1)
    const byLead = p.ok ? await quiet(() => decideCommissionTermChange(db as any, LEAD as any, { adjustmentId: p.record.id, decision: "approved" }, deps)) : null
    const byAgent = p.ok ? await quiet(() => decideCommissionTermChange(db as any, AG1 as any, { adjustmentId: p.record.id, decision: "approved" }, deps)) : null
    check("ADVERSE: a team lead and the requesting agent cannot approve (finance admins only)", !!byLead && !byLead.ok && !!byAgent && !byAgent.ok && rate(db) === 3)
    const noNote = p.ok ? await quiet(() => decideCommissionTermChange(db as any, BROKER as any, { adjustmentId: p.record.id, decision: "denied" }, deps)) : null
    check("ADVERSE: a denial without a reason is refused", !!noNote && !noNote.ok && /^note_required/.test(noNote.ok ? "" : noNote.error))
    const wOther = p.ok ? await quiet(() => withdrawCommissionTermChange(db as any, AG2 as any, { adjustmentId: p.record.id })) : null
    const wOwn = p.ok ? await quiet(() => withdrawCommissionTermChange(db as any, AG1 as any, { adjustmentId: p.record.id })) : null
    check("only the person who asked can withdraw their pending request; the rate never moved", !!wOther && !wOther.ok && !!wOwn?.ok && wOwn.record.approvalStatus === "withdrawn" && rate(db) === 3)
  }

  // ── 8 ─────────────────────────────────────────────────────────────────────
  section("8 · entry from the listing, the offer and the deal at their real stage")
  {
    const db = seed({ brokerages: [{ id: A, plan_tier: "brokerage", agent_concession_approval: "no_approval_required" }] })
    recomputes = []
    const l = await ask(db, AG1, { transactionId: undefined, listingId: L_FREE, value: 5.5 })
    check("a listing with no deal yet: its own rate moves 6% → 5.5% (no waterfall — there is no deal to price)", l.ok && l.applied && l.record.anchor.kind === "listing" && (db.tables.listings as Row[]).find((x) => x.id === L_FREE)?.commission_rate === 5.5 && recomputes.length === 0)
    const ld = await ask(db, AG1, { transactionId: undefined, listingId: L_DEAL, value: 2.75 })
    check("a listing that has a deal on it is judged ON THE DEAL (the deal's rate moves, the waterfall runs)", ld.ok && ld.record.anchor.kind === "transaction" && ld.record.anchor.id === T_OPEN && rate(db) === 2.75 && recomputes.length === 1)
    const o = await ask(db, AG1, { transactionId: undefined, offerId: O_DRAFT, valueType: "flat", value: 4500 })
    check("an offer not yet a contract: its stated buyer-agent commission (flat) moves $5,000 → $4,500", o.ok && o.record.anchor.kind === "offer" && (db.tables.offers as Row[]).find((x) => x.id === O_DRAFT)?.disclosed_buyer_commission_flat === 4500)
    const badType = await ask(db, AG1, { valueType: "flat", value: 9000 })
    check("ADVERSE: a deal prices its commission as a rate — a flat amount on the deal is refused by name", !badType.ok && /records its commission as a percent/.test(badType.ok ? "" : badType.error))
    const po = await ask(seed(), BROKER, { transactionId: undefined, offerId: O_PROMOTED, value: 2.25 })
    check("an offer that already became a deal is judged on the deal", po.ok && po.record.anchor.kind === "transaction" && po.record.anchor.id === T_OPEN)
    const same = await ask(seed(), BROKER, { value: 3 })
    check("ADVERSE: 'changing' the rate to the value it already has is refused (no_change), never a phantom version", !same.ok && /^no_change/.test(same.ok ? "" : same.error))
    const missingKey = await quiet(() => requestCommissionTermChange(seed() as any, BROKER as any, { transactionId: T_OPEN, valueType: "percent", value: 2, reason: "a fine reason", effectiveDate: "2026-11-14", idempotencyKey: "" } as any, deps))
    check("ADVERSE: a submission without its idempotency key is refused (a retried submit must never record twice)", !missingKey.ok && /^idempotency_key_required/.test(missingKey.ok ? "" : missingKey.error))
  }

  // ── 9 ─────────────────────────────────────────────────────────────────────
  section("9 · evidence and the unapplied migration")
  {
    const db = seed({}, { missingColumns: { commission_adjustments: ["prior_value", "requested_by_user_id", "evidence_document_id", "applied_at", "listing_id"] } })
    const r = await ask(db, BROKER)
    check("m902 not applied → the change is refused BY NAME and the rate is untouched (PGRST204 refuses the whole row)", !r.ok && /m902 \(commission term change record\) is not applied/.test(r.ok ? "" : r.error) && rate(db) === 3)
    check("…and its ledger row settled as refused (decision ≠ applied)", (db.tables.agent_action_ledger as Row[]).some((l) => l.status === "failed"))
  }

  // ── 10 ────────────────────────────────────────────────────────────────────
  section("10 · the shared ledger's partitions: a term change is never an agent concession")
  {
    const C = await import("../lib/commission/agent-concession")
    const db = seed()
    const p = await ask(db, AG1, { transactionId: undefined, offerId: O_DRAFT, valueType: "flat", value: 4000 })
    const viaConcession = p.ok ? await quiet(() => C.decideAgentConcession(db as any, BROKER as any, { adjustmentId: p.record.id, decision: "approved" })) : null
    check("ADVERSE: the concession door refuses to approve a term change (it would read 'approved' without moving the term)", !!viaConcession && !viaConcession.ok && /not_a_concession/.test(viaConcession.ok ? "" : viaConcession.error))
    const listed = await quiet(() => C.listAgentConcessions(db as any, BROKER as any, { offerIds: [O_DRAFT] }))
    check("the CDA page's concession list never shows a term change", listed.ok && listed.records.length === 0)
    const held = await quiet(() => C.unauthorizedConcessionsOnOfferChain(db as any, { brokerageId: A, offerId: O_DRAFT }))
    check("a pending term change never holds the offer's dispatch as an 'unauthorized concession' (the offer still states the approved value)", held.ok && held.unauthorized.length === 0)
    ;(db.tables.commission_adjustments as Row[]).push({ id: u(70), brokerage_id: A, offer_id: O_DRAFT, transaction_id: null, adjustment_type: "credit", applies_to: "gross", direction: "credit", approval_status: "requested", is_active: true, value: 500, value_type: "flat", recipient_type: "buyer" })
    const held2 = await quiet(() => C.unauthorizedConcessionsOnOfferChain(db as any, { brokerageId: A, offerId: O_DRAFT }))
    check("POSITIVE CONTROL: a real pending agent concession on the same offer IS held", held2.ok && held2.unauthorized.length === 1)
  }

  // ── 11 ────────────────────────────────────────────────────────────────────
  section("11 · wiring (stripped source; every finder has a positive control)")
  const tx = code("app/actions/transactions.ts")
  const updateBody = (tx.match(/export async function updateTransaction\([\s\S]*?\n\}/) ?? [""])[0]
  const closesRate = (s: string) => /if \(updates\.commissionPercentage !== undefined\) return \{ success: false/.test(s)
  check("the ungated commission write is CLOSED: updateTransaction refuses commissionPercentage before it reaches the service", closesRate(updateBody) && updateBody.indexOf("commissionPercentage !== undefined") < updateBody.indexOf("TransactionService.updateTransaction"))
  check("POSITIVE CONTROL: the finder rejects the base shape (forwarded with no refusal)", !closesRate("export async function updateTransaction(id, updates) { return TransactionService.updateTransaction(id, updates) }"))
  check("the five doors reach the ONE writer with the SESSION actor", ["loadCommissionTermsForChange", "requestCommissionTermChange", "decideCommissionTermChange", "withdrawCommissionTermChange", "listPendingCommissionTermChanges"].every((f) => new RegExp(`${f}\\(createServiceClient\\(\\) as never, s\\.actor`).test(tx)) && /resolveSessionActor\(\)/.test(tx))
  const s3 = code("lib/commission/waterfall/03-apply-gross-adjustments.ts")
  const skips = (s: string) => /if \(adj\.adjustment_type === 'rate_override'\) continue/.test(s)
  check("stage 03 never nets a term change from the gross (an applied one already moved the rate stage 01 prices)", skips(s3) && s3.indexOf("rate_override") < s3.indexOf("magnitudeCents"))
  check("POSITIVE CONTROL: the finder rejects a stage 03 without the skip", !skips("for (const adj of adjustments) { const magnitudeCents = 1 }"))
  const writer = code("lib/commission/commission-term-change.ts")
  check("the writer asks the ENGINE's own agreement reader (no second copy of the executed-agreement query)", /governingClientAgreementRates\(/.test(writer) && !/\.from\("listing_agreements"\)/.test(writer))
  check("no model / AI call in the money path", !/generateText|generateObject|streamText|bookedGenerate|ai-gateway|@ai-sdk/.test(writer))
  check("every governing write is a counted compare-and-swap", /q\.is\(col, null\) : q\.eq\(col, from\)/.test(writer) && /\.select\("id"\)/.test(writer))
  const payouts = code("app/dashboard/financials/payouts/page.tsx"), agentPage = code("app/dashboard/financials/agent/page.tsx")
  check("the screens: the payouts page mounts the decision queue; the agent's deal rows mount the commission terms panel", /<CommissionTermChangeQueue \/>/.test(payouts) && /<CommissionTermsPanel transactionId=\{deal\.transaction_id\}/.test(agentPage))
  const mig = src("supabase/migrations/m902-commission-term-change-record.sql")
  check("m902: line 1 is the lane header (no migration token) OR the integrator's APPLIED LIVE stamp; it widens the anchor and adds the record columns", (mig.split("\n")[0] === "-- WRITTEN, NOT APPLIED (wave 153, lane 153B) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL" || /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP/.test(mig.split("\n")[0])) && /transaction_id is not null or offer_id is not null or listing_id is not null/.test(mig) && ["listing_id", "requested_by_user_id", "prior_value", "evidence_document_id", "applied_at"].every((c) => new RegExp(`add column if not exists ${c} `).test(mig)))
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers the proof and the guard chain RUNS it", pkg.scripts["test:commission-term-change"] === "tsx scripts/commission-term-change-guard.ts" && /(^| && )npm run test:commission-term-change( && |$)/.test(String(pkg.scripts.guard).trimEnd()))
  check("POSITIVE CONTROL: the chain finder refuses a prefix-only name", !/(^| && )npm run test:commission-term-change( && |$)/.test("npm run test:a && npm run test:commission-term-change-x"))

  console.log("\n  · SIMULATED: the in-memory client stands in for the database; the waterfall re-run is injected (the real one is lib/kernel/transactions.ts recalculateCommissionStateCommand). No provider, no network, no model. Nothing here is live.")
  console.log("  · blind spots: the executed-agreement question reads listing / buyer-broker agreements and the offer's execution stamps — an agent / team agreement that sets the GROSS rate is not a client agreement and is not consulted; the evidence document is checked for existence in the workspace, not for signatures (the broker reviews it); notifications are in-app only; listing ids in the queue link to the listing page without a label.")
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); console.log(` RESULT: ${passed} passed, ${failed + 1} failed`); process.exit(1) })
