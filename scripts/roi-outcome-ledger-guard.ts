#!/usr/bin/env tsx
/**
 * scripts/roi-outcome-ledger-guard.ts — wave 152, lane 152B (owner, verbatim: "build out or wire outcomes for the roi
 * ledger reader.")
 *
 * Drives the REAL survivors on the in-memory client (scripts/in-memory-supabase.ts — no network, no model, SIMULATED):
 *   · lib/marketing/attribution.ts attributeTransactionSafe / findTransactionsNeedingAttribution (THE credit writer)
 *   · lib/intelligence/roi-ledger.ts loadRoiOutcomeLedger / roiOutcomeCsv / realizedReturnOnMarketingSpend /
 *     loadRealizedCampaignRevenue / generateRoiLedger (THE reader, its formula, its export, the tile)
 * The directive's proofs (152B, lines 235–237), each with an adverse case and a positive control:
 *   P1 a QR / direct-mail Contact progresses to a closed deal: the reader traces the funnel and the earned commission
 *      without double counting (the tile no longer multiplies a deal by the number of models);
 *   P2 a pending deal shows no realized revenue;
 *   P3 a cancel, a commission correction and a reassignment propagate (reader at read time; writer retracts/refreshes);
 *   P4 unknown provider / campaign spend stays unknown;
 *   P5 a $0-cost campaign shows N/A for every spend-divided ratio;
 *   P6 a replayed event is one outcome;
 *   P7 cross-tenant, agent and team visibility (commission off an agent's display; a team lead sees the team only);
 *   P8 the CSV export agrees with the reader;
 *   R  recommendations are advisory, evidence-based on a comparable sample, and never raise spend;
 *   S  the writers / readers are wired (stripped-source census, each with a positive control).
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

// ── ids ──
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const A = u(1), B = u(2)
const U_BROKER = u(11), U_AG1 = u(12), U_AG2 = u(13), U_LEAD = u(14), U_CONTACT = u(15), U_BBROKER = u(16)
const A1 = u(21), A2 = u(22), ALEAD = u(23), TEAM1 = u(31)
const C_MAIL = u(41), C_SOCIAL = u(42), C_FREE = u(43), C_AG2 = u(44), C_B = u(45)
const DM1 = u(51), DM_AG2 = u(52), Q1 = u(53), AD_FREE = u(54)
const K1 = u(61), K2 = u(62), K3 = u(63), K4 = u(64), KB = u(65)
const T1 = u(71), T2 = u(72), T3 = u(73), T4 = u(74), TB = u(75)
const S1 = u(81), S2 = u(82), R1 = u(83), SH1 = u(84), AC1 = u(85)
const WINDOW = { sinceDay: "2026-10-01", untilDay: "2026-10-31" }
const NOW = new Date().toISOString()

function seed(over: Partial<Record<string, Row[]>> = {}, opts: Parameters<typeof memSupabase>[1] = {}) {
  const base: Record<string, Row[]> = {
    brokerages: [{ id: A, plan_tier: "brokerage" }, { id: B, plan_tier: "brokerage" }],
    users: [
      { id: U_BROKER, brokerage_id: A, user_type: "broker", location_id: null, team_id: null },
      { id: U_AG1, brokerage_id: A, user_type: "agent", location_id: null, team_id: TEAM1 },
      { id: U_AG2, brokerage_id: A, user_type: "agent", location_id: null, team_id: null },
      { id: U_LEAD, brokerage_id: A, user_type: "team_lead", location_id: null, team_id: TEAM1 },
      { id: U_CONTACT, brokerage_id: A, user_type: "contact", location_id: null, team_id: null },
      { id: U_BBROKER, brokerage_id: B, user_type: "broker", location_id: null, team_id: null },
    ],
    agents: [
      { id: A1, brokerage_id: A, user_id: U_AG1, team_id: TEAM1, location_id: null },
      { id: A2, brokerage_id: A, user_id: U_AG2, team_id: null, location_id: null },
      { id: ALEAD, brokerage_id: A, user_id: U_LEAD, team_id: TEAM1, location_id: null },
    ],
    teams: [{ id: TEAM1, brokerage_id: A, team_lead_id: U_LEAD, location_id: null, deleted_at: null }],
    team_members: [], locations: [], organization_members: [],
    marketing_campaigns: [
      { id: C_MAIL, brokerage_id: A, campaign_name: "Oak Street postcards", campaign_type: "direct_mail", agent_user_id: U_AG1, team_id: null, budget_spent: 0 },
      { id: C_SOCIAL, brokerage_id: A, campaign_name: "Neighborhood social", campaign_type: "social", agent_user_id: U_AG1, team_id: null, budget_spent: 0 },
      { id: C_FREE, brokerage_id: A, campaign_name: "Paused ad", campaign_type: "ad", agent_user_id: U_AG1, team_id: null, budget_spent: 0 },
      { id: C_AG2, brokerage_id: A, campaign_name: "Agent two mailer", campaign_type: "direct_mail", agent_user_id: U_AG2, team_id: null, budget_spent: 0 },
      { id: C_B, brokerage_id: B, campaign_name: "Other workspace", campaign_type: "direct_mail", agent_user_id: U_BBROKER, team_id: null, budget_spent: 0 },
    ],
    direct_mail_campaigns: [
      { id: DM1, brokerage_id: A, marketing_campaign_id: C_MAIL, per_piece_cost: 0.75, pieces_mailed: 1000, mailing_date: "2026-10-02" },
      { id: DM_AG2, brokerage_id: A, marketing_campaign_id: C_AG2, per_piece_cost: 0.6, pieces_mailed: 500, mailing_date: "2026-10-02" },
    ],
    qr_codes: [{ id: Q1, brokerage_id: A, marketing_campaign_id: C_MAIL }],
    qr_scan_events: [
      { id: S1, brokerage_id: A, qr_code_id: Q1, contact_id: K1, is_first_scan: true, scanned_at: "2026-10-05T10:00:00.000Z" },
      { id: S1, brokerage_id: A, qr_code_id: Q1, contact_id: K1, is_first_scan: true, scanned_at: "2026-10-05T10:00:00.000Z" }, // a REPLAYED scan event
      { id: S2, brokerage_id: A, qr_code_id: Q1, contact_id: K1, is_first_scan: false, scanned_at: "2026-10-06T10:00:00.000Z" },
    ],
    mail_response_tracking: [{ id: R1, brokerage_id: A, campaign_id: DM1, contact_id: K1, lead_id: null, response_type: "call", created_at: "2026-10-06T12:00:00.000Z" }],
    ad_campaigns: [{ id: AD_FREE, brokerage_id: A, marketing_campaign_id: C_FREE }],
    ad_performance: [],
    marketing_campaign_touchpoints: [
      { id: u(91), brokerage_id: A, campaign_id: C_MAIL, contact_id: K1, sent_at: "2026-10-03T09:00:00.000Z", status: "delivered" },
      { id: u(92), brokerage_id: A, campaign_id: C_SOCIAL, contact_id: K1, sent_at: "2026-10-04T09:00:00.000Z", status: "delivered" },
      { id: u(93), brokerage_id: A, campaign_id: C_MAIL, contact_id: K3, sent_at: "2026-10-03T09:00:00.000Z", status: "delivered" },
      { id: u(94), brokerage_id: A, campaign_id: C_MAIL, contact_id: K4, sent_at: "2026-10-03T09:00:00.000Z", status: "delivered" },
      { id: u(95), brokerage_id: A, campaign_id: C_AG2, contact_id: K2, sent_at: "2026-10-03T09:00:00.000Z", status: "delivered" },
      { id: u(96), brokerage_id: A, campaign_id: C_MAIL, contact_id: K2, sent_at: "2026-10-04T09:00:00.000Z", status: "delivered" },
      { id: u(97), brokerage_id: B, campaign_id: C_B, contact_id: K1, sent_at: "2026-10-04T09:00:00.000Z", status: "delivered" }, // MIS-STAMPED: another tenant, same person id
      { id: u(98), brokerage_id: B, campaign_id: C_B, contact_id: KB, sent_at: "2026-10-04T09:00:00.000Z", status: "delivered" },
    ],
    showings: [{ id: SH1, brokerage_id: A, contact_id: K1, status: "scheduled", created_at: "2026-10-08T15:00:00.000Z" }],
    transactions: [
      { id: T1, brokerage_id: A, status: "closed", deleted_at: null, deal_name: "12 Oak St", contract_date: "2026-10-10", close_date: "2026-10-25", actual_close_date: null, commission_amount: 12000, estimated_commission: 12000, commission_finalized_at: "2026-10-25T18:00:00.000Z", agent_id: A1, buyer_agent_id: null, seller_agent_id: null, buyer_contact_id: K1, seller_contact_id: null, contact_id: null, purchase_price: 400000, updated_at: NOW },
      { id: T2, brokerage_id: A, status: "under_contract", deleted_at: null, deal_name: "8 Elm Ct", contract_date: "2026-10-12", close_date: "2026-11-20", actual_close_date: null, commission_amount: null, estimated_commission: 9000, commission_finalized_at: null, agent_id: A1, buyer_agent_id: null, seller_agent_id: null, buyer_contact_id: K3, seller_contact_id: null, contact_id: null, purchase_price: 300000, updated_at: NOW },
      { id: T3, brokerage_id: A, status: "under_contract", deleted_at: null, deal_name: "3 Pine Rd", contract_date: "2026-10-11", close_date: "2026-10-28", actual_close_date: null, commission_amount: null, estimated_commission: 8000, commission_finalized_at: null, agent_id: A1, buyer_agent_id: null, seller_agent_id: null, buyer_contact_id: K4, seller_contact_id: null, contact_id: null, purchase_price: 260000, updated_at: NOW },
      { id: T4, brokerage_id: A, status: "funded", deleted_at: null, deal_name: "40 Bay Dr", contract_date: "2026-10-09", close_date: "2026-10-20", actual_close_date: null, commission_amount: 6000, estimated_commission: 6000, commission_finalized_at: "2026-10-20T18:00:00.000Z", agent_id: A2, buyer_agent_id: null, seller_agent_id: null, buyer_contact_id: K2, seller_contact_id: null, contact_id: null, purchase_price: 200000, updated_at: NOW },
      { id: TB, brokerage_id: B, status: "closed", deleted_at: null, deal_name: "Other workspace deal", contract_date: "2026-10-09", close_date: "2026-10-21", actual_close_date: null, commission_amount: 5000, estimated_commission: 5000, commission_finalized_at: "2026-10-21T18:00:00.000Z", agent_id: null, buyer_agent_id: null, seller_agent_id: null, buyer_contact_id: KB, seller_contact_id: null, contact_id: null, purchase_price: 180000, updated_at: NOW },
    ],
    agent_commissions: [
      { id: AC1, brokerage_id: A, transaction_id: T1, status: "paid", gross_commission: 12000, net_to_brokerage: 3600, brokerage_commission: 3600, net_to_agent: 8400, agent_commission: 8400, deposit_received_at: "2026-10-26T12:00:00.000Z", paid_at: "2026-10-28T12:00:00.000Z" },
    ],
    vendor_usage_tracking: [
      { id: u(101), brokerage_id: A, total_cost: 2.5, request_metadata: { coverage: "platform_covered", price_state: "fixed" }, created_at: "2026-10-05T00:00:00.000Z" },
      { id: u(102), brokerage_id: A, total_cost: 0, request_metadata: { price_state: "unknown", coverage: "platform_covered" }, created_at: "2026-10-05T00:00:00.000Z" },
      { id: u(103), brokerage_id: A, total_cost: 4, request_metadata: { coverage: "tenant_paid", price_state: "fixed" }, created_at: "2026-10-06T00:00:00.000Z" },
    ],
    ai_tool_usage: [{ id: u(104), brokerage_id: A, cost_cents: 120, platform_paid: true, created_at: "2026-10-05T00:00:00.000Z" }],
    raw_scraped_leads: [
      { id: u(105), brokerage_id: A, cost_per_record: 0.1, lead_id: u(106), created_at: "2026-10-02T00:00:00.000Z" },
      { id: u(107), brokerage_id: A, cost_per_record: 0.1, lead_id: null, created_at: "2026-10-02T00:00:00.000Z" },
    ],
    marketing_attribution_credits: [],
  }
  return memSupabase({ ...base, ...over } as Record<string, Row[]>, { uuidIds: true, stampCreatedAt: true, ...opts })
}

async function main() {
  const attribution = await import("../lib/marketing/attribution")
  const roi = await import("../lib/intelligence/roi-ledger")
  const { attributeTransactionSafe, findTransactionsNeedingAttribution } = attribution
  const { loadRoiOutcomeLedger, roiOutcomeCsv, realizedReturnOnMarketingSpend, loadRealizedCampaignRevenue, generateRoiLedger } = roi
  const { platformScope, tenantScope } = await import("../lib/kernel/tenant-scope")
  const CRON_SCOPE = platformScope("roi proof: the daily attribution cron's platform-wide candidate scan")
  type Ledger = Awaited<ReturnType<typeof loadRoiOutcomeLedger>>

  /** Credit every live deal through THE writer (T3 while it is still under contract), as the cron would. */
  async function credited(mem: ReturnType<typeof seed>) {
    for (const t of [T1, T2, T3, T4]) await quiet(() => attributeTransactionSafe(mem as any, t))
    return mem
  }
  const ledgerOf = async (mem: any, userId: string, brokerageId = A): Promise<Ledger> => quiet(() => loadRoiOutcomeLedger(mem, { userId, brokerageId }, WINDOW))
  const creditsFor = (mem: any, tx: string, model?: string) => (mem.tables.marketing_attribution_credits as Row[]).filter((c) => c.transaction_id === tx && (!model || c.attribution_model === model))

  // ── P1 ───────────────────────────────────────────────────────────────────
  section("P1 · QR / direct-mail Contact → closed deal, traced without double counting")
  const m1 = await credited(seed())
  const t1All = creditsFor(m1, T1)
  const t1AllSum = t1All.reduce((s, c) => s + Number(c.credit_dollars), 0)
  check("the writer credits T1 to both campaigns that touched its client, under four models (8 rows)", t1All.length === 8, `rows=${t1All.length}`)
  check("POSITIVE CONTROL: summing EVERY model's rows (the old tile's read) gives 4× the deal's $12,000", Math.round(t1AllSum) === 48000, `sum=${t1AllSum}`)
  check("the linear rows split the deal exactly once ($12,000)", Math.round(creditsFor(m1, T1, "linear").reduce((s, c) => s + Number(c.credit_dollars), 0)) === 12000)
  const brokerL = await ledgerOf(m1, U_BROKER)
  check("the broker's ledger reads", brokerL.ok, brokerL.ok ? "" : brokerL.error)
  if (brokerL.ok) {
    const l = brokerL.ledger
    check("sourced earned commission = T1 $12,000 + T4 $6,000 — each closed deal once (1,800,000¢)", l.attribution?.sourcedEarnedCents === 1_800_000, `got ${l.attribution?.sourcedEarnedCents}`)
    check("sourced deals = 2 (the pending and the lost deals are not sourced revenue)", l.attribution?.sourcedDeals === 2)
    check("every closed deal reconciles: its campaign shares add up to its earned commission exactly", !!l.attribution?.reconciled && (l.attribution?.reconciliation ?? []).every((r) => r.creditedCents === r.earnedCents) && (l.attribution?.reconciliation.length ?? 0) === 2)
    check("the campaign rows' sourced dollars add up to the same total (no campaign double-claims a deal)", l.campaigns.reduce((s, c) => s + (c.revenue?.sourcedEarnedCents ?? 0), 0) === 1_800_000)
    const mail = l.campaigns.find((c) => c.campaignId === C_MAIL)!
    check("the mailer is credited its linear half of T1 and T4 ($6,000 + $3,000)", mail.revenue?.sourcedEarnedCents === 900_000, `got ${mail.revenue?.sourcedEarnedCents}`)
    check("influence is a COUNT, labelled non-additive (the mailer touched 2 closed deals; 3 influenced across campaigns > 2 deals)", l.attribution?.influenceIsAdditive === false && mail.results.influencedDealsClosed === 2 && l.campaigns.reduce((s, c) => s + c.results.influencedDealsClosed, 0) > (l.attribution?.influencedDeals ?? 0))
    check("revenue status ladder: earned $18,000 · received $12,000 (deposit recorded) · paid out $8,400 (agent payout)", l.revenue?.earnedCents === 1_800_000 && l.revenue?.receivedCents === 1_200_000 && l.revenue?.disbursedCents === 840_000)
    check("net to the business is NULL, not a guess, when a closed deal (T4) has no commission ledger rows", l.revenue?.netBrokerageCents === null)
    const j = l.journeys.find((x) => x.transactionId === T1)!
    const kinds = new Set(j?.steps.map((s) => s.kind))
    check("the journey traces touch → QR scan → mail response → appointment → contract → close, each with its evidence row", !!j && ["touchpoint", "qr_scan", "mail_response", "appointment", "contract", "closed"].every((k) => kinds.has(k as any)) && j.steps.some((s) => s.ref === `qr_scan_events:${S1}`) && j.steps.some((s) => s.ref === `mail_response_tracking:${R1}`) && j.steps.some((s) => s.ref === `showings:${SH1}`))
    check("the journey's revenue status is 'disbursed' (closed, funds received, agent paid)", j?.revenueStatus === "disbursed")
    check("sale price is never read as revenue (no $400,000 figure anywhere in the ledger)", !JSON.stringify(l).includes("40000000") && !JSON.stringify(l).includes("400000.00"))
  }
  const tile = await quiet(() => generateRoiLedger(m1 as any, A, 3650))
  check("the Command Center tile credits ONE model on CLOSED deals: $18,000, not $72,000 (4 models) and not the $9,000 pending estimate", tile.attributedGciCents === 1_800_000 && tile.attributedDeals === 2, `got ${tile.attributedGciCents} over ${tile.attributedDeals}`)
  check("the tile's headline says commission, never 'closed volume'", /closed commission/.test(tile.headline) && !/closed volume/.test(tile.headline))

  // ── P1b · THE realized-credit read shared by every attribution reader (wave 152, lane 152K — 152B outside-lane 1–2) ──
  section("P1b · ONE realized-credit read: the tile, the allocation recommender, the board packet, the monthly report, the autonomy report")
  const shared = await quiet(() => roi.loadRealizedAttributionCredits(m1 as any, A, { sinceIso: "2000-01-01T00:00:00.000Z" }))
  const sharedSum = shared.ok ? shared.rows.reduce((s, r) => s + Number(r.credit_dollars ?? 0), 0) : -1
  check("loadRealizedAttributionCredits returns ONE model's rows on CLOSED / FUNDED deals only: $18,000 over T1 + T4 (never 4× $72,000, never the pending estimate)",
    shared.ok && Math.round(sharedSum) === 18000 && new Set(shared.rows.map((r) => r.transaction_id)).size === 2 && shared.rows.every((r) => r.transaction_id === T1 || r.transaction_id === T4), shared.ok ? `sum=${sharedSum}` : shared.error)
  check("…and every row it returns names its campaign (the allocation recommender groups by campaign)", shared.ok && shared.rows.every((r) => !!r.campaign_id))
  const refusedTx = await quiet(() => roi.loadRealizedAttributionCredits(memSupabase({ ...(m1.tables as any) }, { refuse: { transactions: "permission denied for table transactions" } }) as any, A, { sinceIso: "2000-01-01T00:00:00.000Z" }))
  check("ADVERSE · FAIL CLOSED: a refused deal read returns NO rows (ok:false) — never every credit shown as earned", !refusedTx.ok)
  const refusedCr = await quiet(() => roi.loadRealizedAttributionCredits(memSupabase({ ...(m1.tables as any) }, { refuse: { marketing_attribution_credits: "permission denied" } }) as any, A, { sinceIso: "2000-01-01T00:00:00.000Z" }))
  check("ADVERSE · FAIL CLOSED: a refused credit read is ok:false, not an empty 'nothing earned' success", !refusedCr.ok)
  const otherTenant = await quiet(() => roi.loadRealizedAttributionCredits(m1 as any, "00000000-0000-4000-8000-00000000dead", { sinceIso: "2000-01-01T00:00:00.000Z" }))
  check("ADVERSE · another tenant's id reads none of this tenant's credits", otherTenant.ok && otherTenant.rows.length === 0)
  // Wired: the four readers that summed every model (152B outside-lane 1–2) read through it and never read the table themselves.
  const readers = ["lib/kernel/resource-allocation.ts", "lib/kernel/board-packet.ts", "lib/kernel/intelligence-report.ts", "lib/kernel/reporting-autonomy.ts"]
  const direct = /from\("marketing_attribution_credits"\)/
  const unwired = readers.filter((f) => { const s = stripComments(readFileSync(join(process.cwd(), f), "utf8")); return direct.test(s) || !/loadRealizedAttributionCredits\(/.test(s) })
  check(`the four attribution readers (${readers.length}) read credits ONLY through loadRealizedAttributionCredits`, unwired.length === 0, unwired.join(", "))
  check("POSITIVE CONTROL: the finder flags the pre-fix every-model read", direct.test(`svc.from("marketing_attribution_credits").select("credit_dollars, transaction_id").eq("brokerage_id", b.id)`))
  check("no attribution reader labels a COMMISSION figure 'closed volume' (board packet markdown + PDF, reel, monthly report, Command Center tile)",
    ["lib/kernel/board-packet.ts", "lib/kernel/board-packet-pdf.ts", "lib/kernel/board-packet-reel.ts", "lib/kernel/intelligence-report.ts", "app/dashboard/admin/command-center/command-center-client.tsx"].every((f) => !/attributed[^`"\n]{0,40}closed volume|closed volume attributed|Attributed closed volume|of that closed volume/i.test(stripComments(readFileSync(join(process.cwd(), f), "utf8")))))

  // ── P2 ───────────────────────────────────────────────────────────────────
  section("P2 · a pending deal shows no realized revenue")
  if (brokerL.ok) {
    const l = brokerL.ledger
    check("the under-contract deal carries credit rows (the writer credits it at the ESTIMATE)", creditsFor(m1, T2).length > 0)
    check("…but earned revenue excludes it ($18,000 earned; its $9,000 sits in CONTRACTED beside the other in-escrow deal's $8,000)", l.revenue?.earnedCents === 1_800_000 && l.revenue?.contractedCents === 1_700_000, `earned=${l.revenue?.earnedCents} contracted=${l.revenue?.contractedCents}`)
    const j2 = l.journeys.find((x) => x.transactionId === T2)
    check("its journey says 'contracted' with no earned amount", j2?.revenueStatus === "contracted" && j2?.earnedCents === null)
    check("POSITIVE CONTROL: the same deal flipped to closed + finalized becomes earned", await (async () => {
      const m = await credited(seed()); const t = (m.tables.transactions as Row[]).find((x) => x.id === T2)!; Object.assign(t, { status: "closed", close_date: "2026-10-30", commission_amount: 9000, commission_finalized_at: "2026-10-30T00:00:00.000Z" })
      const r = await ledgerOf(m, U_BROKER); return r.ok && r.ledger.revenue?.earnedCents === 2_700_000
    })())
    check("a CLOSED deal whose commission is NOT finalized is counted as a closing but earns nothing, and the return is N/A", await (async () => {
      const m = await credited(seed()); const t = (m.tables.transactions as Row[]).find((x) => x.id === T4)!; Object.assign(t, { commission_finalized_at: null })
      const r = await ledgerOf(m, U_BROKER); if (!r.ok) return false
      const ag2 = r.ledger.campaigns.find((c) => c.campaignId === C_AG2)!
      return r.ledger.revenue?.closedNotEstablished === 1 && r.ledger.revenue?.earnedCents === 1_200_000 && ag2.ratios.realizedReturnOnMarketingSpend.value === null && /not finalized/.test(ag2.ratios.realizedReturnOnMarketingSpend.na ?? "")
    })())
  }

  // ── P3 ───────────────────────────────────────────────────────────────────
  section("P3 · cancel, commission correction and reassignment propagate")
  {
    const m = await credited(seed())
    check("PRE: the lost-to-be deal (T3) carries credit from when it was under contract (4 rows)", creditsFor(m, T3).length === 4)
    ;(m.tables.transactions as Row[]).find((x) => x.id === T3)!.status = "lost"
    const r = await ledgerOf(m, U_BROKER)
    check("READ TIME: the reader excludes the fallen-through deal at once (counted as reversed, no revenue)", r.ok && r.ledger.results.dealsReversed === 1 && r.ledger.journeys.find((j) => j.transactionId === T3)?.revenueStatus === "reversed")
    const todo = await quiet(() => findTransactionsNeedingAttribution(m as any, CRON_SCOPE, 14))
    check("WRITER: the cron's candidate list now returns the credited-but-lost deal (it used to skip any credited deal)", todo.includes(T3), todo.join(","))
    const tenantB = await quiet(() => findTransactionsNeedingAttribution(m as any, tenantScope(B, "roi proof"), 14))
    check("WRITER SCOPE: a TENANT-scoped candidate scan never returns another tenant's deals (the platform scan must be stated)", tenantB.length === 1 && tenantB[0] === TB, tenantB.join(","))
    const res = await quiet(() => attributeTransactionSafe(m as any, T3))
    check("WRITER: the run RETRACTS its credit, counted (4 rows removed)", res?.outcome === "retracted" && res.removedRows === 4, JSON.stringify(res))
    check("…and no credit row for it remains", creditsFor(m, T3).length === 0)
    check("ADVERSE: re-running the retraction removes nothing more and still reports 0 (a delete matching nothing is not a success claim)", (await quiet(() => attributeTransactionSafe(m as any, T3)))?.removedRows === 0)

    // commission correction
    ;(m.tables.agent_commissions as Row[]).find((x) => x.id === AC1)!.gross_commission = 11000
    ;(m.tables.transactions as Row[]).find((x) => x.id === T1)!.commission_amount = 11000
    const r2 = await ledgerOf(m, U_BROKER)
    check("READ TIME: a corrected commission restates the earned and sourced figures immediately ($11,000 + $6,000)", r2.ok && r2.ledger.attribution?.sourcedEarnedCents === 1_700_000 && !!r2.ledger.attribution?.reconciled)
    const todo2 = await quiet(() => findTransactionsNeedingAttribution(m as any, CRON_SCOPE, 14))
    check("WRITER: a credited deal whose commission moved is STALE work", todo2.includes(T1))
    await quiet(() => attributeTransactionSafe(m as any, T1))
    check("WRITER: the refresh re-splits the linear credit to the corrected $11,000", Math.round(creditsFor(m, T1, "linear").reduce((s, c) => s + Number(c.credit_dollars), 0)) === 11000)
    check("CONTROL: an unchanged credited deal is NOT re-queued (no churn)", !(await quiet(() => findTransactionsNeedingAttribution(m as any, CRON_SCOPE, 14))).includes(T4))

    // reassignment
    ;(m.tables.transactions as Row[]).find((x) => x.id === T1)!.agent_id = A2
    const ag1 = await ledgerOf(m, U_AG1), ag2 = await ledgerOf(m, U_AG2)
    check("REASSIGNMENT: the deal leaves the first agent's view and lands in the second's (scope reads the CURRENT agent)", ag1.ok && ag2.ok && ag1.ledger.results.dealsClosed === 0 && ag2.ledger.results.dealsClosed === 2)
  }

  // ── P4 ───────────────────────────────────────────────────────────────────
  section("P4 · unknown spend stays unknown")
  if (brokerL.ok) {
    const l = brokerL.ledger
    const social = l.campaigns.find((c) => c.campaignId === C_SOCIAL)!
    check("a campaign with no spend source and nothing entered is UNKNOWN (cost null), never $0", social.cost.status === "unknown" && social.cost.cents === null)
    check("its return and cost per contact are N/A, saying the cost is not recorded", social.ratios.realizedReturnOnMarketingSpend.value === null && /not recorded/.test(social.ratios.realizedReturnOnMarketingSpend.na ?? "") && social.ratios.costPerContact.value === null)
    check("the aggregate counts it as unknown and calculates the return ONLY over fully-recorded campaigns", l.costs.byStatus.unknown === 1 && l.costs.eligibleCampaigns === 2 && /2 of 4 campaign/.test(l.why.realizedReturnOnMarketingSpend))
    const roms = l.ratios.realizedReturnOnMarketingSpend.value
    check("aggregate return = (900,000 + 300,000 − 105,000) ÷ 105,000 over the mailers with recorded cost", roms != null && Math.abs(roms - (1_200_000 - 105_000) / 105_000) < 1e-9, `got ${roms}`)
    check("an UNPRICED provider call is counted, never added as $0 (platform $2.50, own account $4.00, 1 unpriced)", l.providerEconomics.vendorPlatformCoveredCents === 250 && l.providerEconomics.vendorTenantPaidCents === 400 && l.providerEconomics.vendorUnpricedCalls === 1)
    check("a tenant-typed amount is 'tenant_reported', not confirmed", await (async () => {
      const m = await credited(seed()); (m.tables.marketing_campaigns as Row[]).find((x) => x.id === C_SOCIAL)!.budget_spent = 250
      const r = await ledgerOf(m, U_BROKER); const s = r.ok ? r.ledger.campaigns.find((c) => c.campaignId === C_SOCIAL) : null
      return s?.cost.status === "tenant_reported" && s.cost.cents === 25_000
    })())
    check("a partly-costed mailer is PARTIAL and its ratios are N/A", await (async () => {
      const m = await credited(seed({}))
      ;(m.tables.direct_mail_campaigns as Row[]).push({ id: u(108), brokerage_id: A, marketing_campaign_id: C_MAIL, per_piece_cost: null, pieces_mailed: 300, mailing_date: "2026-10-03" })
      const r = await ledgerOf(m, U_BROKER); const c = r.ok ? r.ledger.campaigns.find((x) => x.campaignId === C_MAIL) : null
      return c?.cost.status === "partial" && c.ratios.realizedReturnOnMarketingSpend.value === null && /part/.test(c.ratios.realizedReturnOnMarketingSpend.na ?? "")
    })())
  }

  // ── P5 ───────────────────────────────────────────────────────────────────
  section("P5 · a $0-cost campaign shows N/A for spend-divided ratios")
  if (brokerL.ok) {
    const free = brokerL.ledger.campaigns.find((c) => c.campaignId === C_FREE)!
    check("the paused ad (ledger present, $0 spent) is 'none' — an honest zero", free.cost.status === "none" && free.cost.cents === 0)
    check("its return, cost per contact and cost per closed deal are all N/A (never Infinity, never 0)", [free.ratios.realizedReturnOnMarketingSpend, free.ratios.costPerContact, free.ratios.costPerClosedTransaction].every((r) => r.value === null && !!r.na))
  }
  const zero = realizedReturnOnMarketingSpend({ contributionCents: 500_000, spendCents: 0, spendStatus: "confirmed" })
  check("THE formula on $0 spend → N/A with a reason", zero.value === null && /\$0/.test(zero.na ?? ""))
  check("THE formula on unknown / partial spend → N/A", realizedReturnOnMarketingSpend({ contributionCents: 1, spendCents: null, spendStatus: "unknown" }).value === null && realizedReturnOnMarketingSpend({ contributionCents: 1, spendCents: 5, spendStatus: "partial" }).value === null)
  check("THE formula on an unestablished contribution → N/A", realizedReturnOnMarketingSpend({ contributionCents: null, spendCents: 100, spendStatus: "confirmed" }).value === null)
  check("POSITIVE CONTROL: $6,000 earned on $750 confirmed spend → 7 (700%)", realizedReturnOnMarketingSpend({ contributionCents: 600_000, spendCents: 75_000, spendStatus: "confirmed" }).value === 7)

  // ── P6 ───────────────────────────────────────────────────────────────────
  section("P6 · a replayed event is one outcome")
  {
    const m = await credited(seed())
    const before = (m.tables.marketing_attribution_credits as Row[]).length
    for (let i = 0; i < 3; i++) await quiet(() => attributeTransactionSafe(m as any, T1))
    check("re-running attribution for the same close three times leaves the same credit rows (unique campaign × deal × model)", (m.tables.marketing_attribution_credits as Row[]).length === before)
    const r = await ledgerOf(m, U_BROKER)
    check("…and the same sourced dollars", r.ok && r.ledger.attribution?.sourcedEarnedCents === 1_800_000)
    check("a replayed QR scan event (same id twice) counts once: 2 scans, 1 first scan — and carries no money", r.ok && r.ledger.activity.qrScans === 2 && r.ledger.activity.qrFirstScans === 1)
    check("POSITIVE CONTROL: the seed really holds the replayed scan row (3 rows, 2 ids)", (m.tables.qr_scan_events as Row[]).length === 3)
    check("WRITER TENANT PIN: a mis-stamped touchpoint of ANOTHER tenant for the same person earns no credit on this deal", !creditsFor(m, T1).some((c) => c.campaign_id === C_B))
    check("POSITIVE CONTROL: that foreign touchpoint IS in the seed for the deal's person", (m.tables.marketing_campaign_touchpoints as Row[]).some((t) => t.contact_id === K1 && t.campaign_id === C_B))
  }

  // ── P7 ───────────────────────────────────────────────────────────────────
  section("P7 · cross-tenant and agent / team visibility")
  {
    const m = await credited(seed())
    const ag = await ledgerOf(m, U_AG1)
    check("an agent's ledger reads (own work)", ag.ok && ag.ledger.scope.kind === "own")
    if (ag.ok) {
      const l = ag.ledger
      check("COMMISSION OFF AN AGENT'S DISPLAY: no revenue, no attribution dollars, no campaign dollars, no journey dollars", l.revenue === null && l.attribution === null && l.campaigns.every((c) => c.revenue === null) && l.journeys.every((j) => j.earnedCents === null) && !l.scope.moneyVisible && !!l.scope.moneyNote)
      check("…the money note is plain words with one action, and names no payer", /finance administrators/.test(l.scope.moneyNote ?? "") && /ask an account administrator/i.test(l.scope.moneyNote ?? "") && !/brokerage pays/i.test(l.scope.moneyNote ?? ""))
      check("the agent sees only their own campaigns (not agent two's mailer)", l.campaigns.every((c) => c.agentUserId === U_AG1) && !l.campaigns.some((c) => c.campaignId === C_AG2))
      check("the agent's closings are their own (T1), not agent two's (T4)", l.results.dealsClosed === 1 && !l.journeys.some((j) => j.transactionId === T4))
      check("a deal their campaign touched but another agent owns is counted as outside the view, without its money", l.campaigns.find((c) => c.campaignId === C_MAIL)?.results.dealsOutsideView === 1)
    }
    const lead = await ledgerOf(m, U_LEAD)
    check("TEAM LEAD (L4): scoped to the team they lead — never the whole tenant on the single-office roster rule", lead.ok && lead.ledger.scope.kind === "teams")
    check("…sees the team's deal (T1) and not the other agent's (T4), with the team's books", lead.ok && lead.ledger.attribution?.sourcedDeals === 1 && lead.ledger.attribution?.sourcedEarnedCents === 1_200_000 && lead.ledger.scope.moneyVisible)
    check("POSITIVE CONTROL: the broker sees both deals", brokerL.ok && brokerL.ledger.attribution?.sourcedDeals === 2)
    const other = await ledgerOf(m, U_BBROKER, B)
    const otherJson = other.ok ? JSON.stringify(other.ledger) : ""
    check("ANOTHER TENANT's broker sees their own campaign only — none of this tenant's campaigns, deals or people", other.ok && other.ledger.campaigns.length === 1 && other.ledger.campaigns[0].campaignId === C_B && ![T1, T2, T4, C_MAIL, C_SOCIAL, K1].some((id) => otherJson.includes(id)))
    const mismatch = await ledgerOf(m, U_BBROKER, A)
    check("ADVERSE: a session naming a workspace the user does not belong to is refused", !mismatch.ok && /different workspace/.test(mismatch.ok ? "" : mismatch.error))
    const contact = await ledgerOf(m, U_CONTACT)
    check("ADVERSE: a Contact seat is refused (Contacts see no financials)", !contact.ok)
    const refusedM = await credited(seed())
    const refusedRead = await quiet(() => loadRoiOutcomeLedger(memSupabase({ ...(refusedM.tables as any) }, { refuse: { agent_commissions: "permission denied for table agent_commissions" } }) as any, { userId: U_BROKER, brokerageId: A }, WINDOW))
    check("FAIL CLOSED: a refused commission-ledger read refuses the whole ledger (never a partial picture shown as complete)", !refusedRead.ok && /could not be read/.test(refusedRead.ok ? "" : refusedRead.error))
    ;(m.tables.marketing_attribution_credits as Row[]).push({ id: u(109), brokerage_id: B, campaign_id: C_MAIL, transaction_id: T1, attribution_model: "linear", attribution_weight: 1, credit_dollars: 99999, contact_id: K1, touchpoint_count: 1 })
    const afterForeign = await ledgerOf(m, U_BROKER)
    check("a credit row stamped with ANOTHER tenant cannot inflate this tenant's sourced revenue or break reconciliation", afterForeign.ok && afterForeign.ledger.attribution?.sourcedEarnedCents === 1_800_000 && !!afterForeign.ledger.attribution?.reconciled)
  }

  // ── P8 ───────────────────────────────────────────────────────────────────
  section("P8 · the CSV export agrees with the reader")
  if (brokerL.ok) {
    const l = brokerL.ledger
    const csv = roiOutcomeCsv(l)
    const lines = csv.trim().split("\n")
    const find = (prefix: string) => lines.find((x) => x.startsWith(prefix))?.split(",")[2]
    check("sourced earned dollars in the CSV equal the reader's", find("attribution,sourcedEarnedUsd,") === (l.attribution!.sourcedEarnedCents / 100).toFixed(2))
    check("earned / received / paid-out in the CSV equal the reader's", find("revenue,earnedUsd,") === (l.revenue!.earnedCents / 100).toFixed(2) && find("revenue,receivedUsd,") === (l.revenue!.receivedCents / 100).toFixed(2) && find("revenue,disbursedUsd,") === (l.revenue!.disbursedCents / 100).toFixed(2))
    check("an N/A ratio is exported as N/A with its reason, never 0", lines.some((x) => x.startsWith("Neighborhood social,") && x.includes("N/A")))
    check("every campaign row's cost and sourced dollars match the reader", l.campaigns.every((c) => {
      const row = lines.find((x) => x.startsWith(`${c.name},`))?.split(",") ?? []
      return row[3] === (c.cost.cents == null ? "" : (c.cost.cents / 100).toFixed(2)) && row[8] === (c.revenue ? (c.revenue.sourcedEarnedCents / 100).toFixed(2) : "")
    }))
    const ag = await ledgerOf(await credited(seed()), U_AG1)
    const agCsv = ag.ok ? roiOutcomeCsv(ag.ledger) : "revenue,"
    check("an agent's export carries no commission dollars either (the export is the reader, scope included)", ag.ok && !/^revenue,/m.test(agCsv) && !/sourcedEarnedUsd/.test(agCsv))
  }
  {
    const m = await credited(seed())
    const per = await quiet(() => loadRealizedCampaignRevenue(m as any, A, [C_MAIL, C_SOCIAL, C_AG2], WINDOW))
    check("the campaign_roi WRITER's revenue loader agrees with the reader per campaign (mailer $9,000, social $6,000, agent two $3,000)", per.ok && per.byCampaign.get(C_MAIL)?.earnedCents === 900_000 && per.byCampaign.get(C_SOCIAL)?.earnedCents === 600_000 && per.byCampaign.get(C_AG2)?.earnedCents === 300_000)
  }

  // ── R ────────────────────────────────────────────────────────────────────
  section("R · recommendations: advisory, evidence-based, never a spend increase")
  {
    const many: Row[] = [], mails: Row[] = [], tps: Row[] = []
    const costs = [1.0, 1.0, 1.0, 10.0]
    costs.forEach((cost, i) => {
      const cid = u(200 + i), did = u(210 + i)
      many.push({ id: cid, brokerage_id: A, campaign_name: `Farm mailer ${i + 1}`, campaign_type: "direct_mail", agent_user_id: U_AG1, team_id: null, budget_spent: 0 })
      mails.push({ id: did, brokerage_id: A, marketing_campaign_id: cid, per_piece_cost: cost, pieces_mailed: 100, mailing_date: "2026-10-02" })
      tps.push({ id: u(220 + i), brokerage_id: A, campaign_id: cid, contact_id: u(230 + i), sent_at: "2026-10-03T00:00:00.000Z", status: "delivered" })
    })
    const m = seed({ marketing_campaigns: many, direct_mail_campaigns: mails, marketing_campaign_touchpoints: tps, transactions: [], qr_codes: [], ad_campaigns: [] })
    const r = await ledgerOf(m, U_BROKER)
    const recs = r.ok ? r.ledger.recommendations : []
    const reduce = recs.filter((x) => x.kind === "review_reduce")
    check("the 10× cost-per-contact mailer is flagged for REVIEW, against 4 comparable mailers, owned by the campaign orchestrator", reduce.length === 1 && reduce[0].campaignId === u(203) && reduce[0].comparableSample === 4 && reduce[0].manager === "campaign_orchestrator")
    check("every recommendation needs a person's approval and none raises spend", recs.length > 0 && recs.every((x) => x.requiresApproval === true && !/increase|raise|boost/i.test(x.text)) && recs.every((x) => ["review_reduce", "record_spend", "finalize_commission", "repair_attribution"].includes(x.kind)))
    const thin = seed({ marketing_campaigns: many.slice(2), direct_mail_campaigns: mails.slice(2), marketing_campaign_touchpoints: tps.slice(2), transactions: [], qr_codes: [], ad_campaigns: [] })
    const rt = await ledgerOf(thin, U_BROKER)
    check("ADVERSE: with only 2 comparable campaigns nothing is recommended for reduction (no verified comparable sample)", rt.ok && !rt.ledger.recommendations.some((x) => x.kind === "review_reduce"))
    if (brokerL.ok) check("the unknown-cost campaign that reached a contact gets a 'record its cost' item for the data steward", brokerL.ledger.recommendations.some((x) => x.kind === "record_spend" && x.campaignId === C_SOCIAL && x.manager === "data_steward"))
  }

  // ── S ────────────────────────────────────────────────────────────────────
  section("S · wiring (stripped source; every finder has a positive control)")
  const fabricated = /DEFAULT_AVG_COMMISSION|\*\s*0\.3\b/
  check("POSITIVE CONTROL: the fabricated-revenue finder sees the retired shape", fabricated.test("const totalRevenue = totalConversions * DEFAULT_AVG_COMMISSION") && fabricated.test("qualifiedLeads = Math.floor(totalLeads * 0.3)"))
  const calc = code("lib/campaigns/roi-calculator.ts")
  check("campaign_roi WRITER: no invented revenue or qualification rate remains in code", !fabricated.test(calc))
  check("campaign_roi WRITER: revenue and return come from the reader's loader and THE formula", /loadRealizedCampaignRevenue\(/.test(calc) && /realizedReturnOnMarketingSpend\(/.test(calc))
  const attr = code("lib/marketing/attribution.ts")
  check("credit WRITER: eligibility reads the status vocabulary (no phantom 'completed'), and a retraction delete is COUNTED (.select after .delete)", !/"completed"/.test(attr) && /isInEscrow\(/.test(attr) && /\.delete\(\)[\s\S]{0,200}\.select\("id"\)/.test(attr))
  const pinned = (s: string) => [...s.matchAll(/\.from\("ai_isa_activities"\)([\s\S]{0,260})/g)].every((m) => /\.eq\("brokerage_id"/.test(m[1]))
  check("POSITIVE CONTROL: the tenant-pin finder rejects the old unpinned ISA read", !pinned(`.from("ai_isa_activities").select("id, outcome").gte("created_at", x)`))
  const agentRoi = code("app/dashboard/agent/roi/actions.ts")
  check("agent ROI: every ai_isa_activities read is tenant-pinned, and the reader decides whether dollars show", pinned(agentRoi) && /\.from\("ai_isa_activities"\)/.test(agentRoi) && /loadRoiOutcomeLedger\(svc, \{ userId: user\.id, brokerageId: profile\.brokerage_id \}/.test(agentRoi))
  const rep = code("app/api/dashboard/reporting/route.ts")
  check("reporting route: marketing totals come from the authorized reader with the session ids, not a brokerage-wide campaign_roi sum", /loadRoiOutcomeLedger\(createServiceClient\(\), \{ userId: user\.id, brokerageId \}/.test(rep) && !/\.from\("campaign_roi"\)/.test(rep))
  const page = code("app/dashboard/campaigns/roi/page.tsx")
  check("ROI page: the reader runs on the session's ids and filters the cache rows to the viewer's campaigns", /loadRoiOutcomeLedger\(createServiceClient\(\), \{ userId: user\.id, brokerageId: profile\.brokerage_id \}/.test(page) && /inView\.has\(r\.marketing_campaign_id\)/.test(page) && /roiOutcomeCsv\(outcomes\.ledger\)/.test(page))
  const client = code("app/dashboard/campaigns/roi/roi-dashboard-client.tsx")
  check("ROI client: an N/A return is never charted as 0 and the Outcomes tab renders the ledger", !/roi_percentage \?\? 0/.test(client) && /<OutcomesPanel ledger=\{outcomes\}/.test(client))
  check("POSITIVE CONTROL: the chart finder sees the retired coercion", /roi_percentage \?\? 0/.test("roi: ch.roi_percentage ?? 0,"))
  const mig = src("supabase/migrations/m943-channel-performance-window-upsert-key.sql")
  check("m943: line 1 is the lane header OR the integrator's APPLIED LIVE stamp (the rule, never the pre-apply waypoint) and the index matches the writer's ON CONFLICT target", (mig.split("\n")[0] === "-- WRITTEN, NOT APPLIED (wave 152, lane 152B) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL" || /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP \(project [a-z]+\) — wave 152, lane 152B ──$/.test(mig.split("\n")[0])) && /on public\.channel_performance \(brokerage_id, channel_type, window_start, window_end\)/.test(mig) && /onConflict:\s*"brokerage_id,channel_type,window_start,window_end"/.test(calc))
  const reg = code("lib/kernel/manager-registry.ts")
  check("registry: the capability row names an existing manager and this proof", /roi_outcome_ledger: \{ manager: "data_steward", proof: "test:roi-outcome-ledger"/.test(reg))
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers the proof and the guard chain RUNS it (not 'ends with it' — sibling lanes append after it; CLAUDE.md §2)", pkg.scripts["test:roi-outcome-ledger"] === "tsx scripts/roi-outcome-ledger-guard.ts" && /(^| && )npm run test:roi-outcome-ledger( && |$)/.test(String(pkg.scripts.guard).trimEnd()))
  check("POSITIVE CONTROL: the chain finder refuses a chain that never runs the proof and a prefix-only name", !/(^| && )npm run test:roi-outcome-ledger( && |$)/.test("npm run test:a && npm run test:roi-outcome-ledger-x") && /(^| && )npm run test:roi-outcome-ledger( && |$)/.test("npm run test:a && npm run test:roi-outcome-ledger && npm run test:b"))

  console.log("\n  · SIMULATED: the in-memory client stands in for the database; no provider, no network, no model. Nothing here is live.")
  console.log("  · blind spots: reads cap at 5,000 rows per table per window; a deal's commission ledger rows are summed as the tenant's gross (per-side gross on multi-agent deals is trusted as written); tenant-reported spend is a lifetime figure, not windowed; QR scans join campaigns through qr_codes.marketing_campaign_id only; duplicates avoided by the pre-pull check are not recorded anywhere, so they are not counted; channel_performance writes need m943 applied before the Channel Comparison tab can fill.")
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); console.log(` RESULT: ${passed} passed, ${failed + 1} failed`); process.exit(1) })
