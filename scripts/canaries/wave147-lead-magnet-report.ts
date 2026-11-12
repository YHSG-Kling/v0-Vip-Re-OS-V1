/**
 * scripts/canaries/wave147-lead-magnet-report.ts — LEAD MAGNET ASSET-AT-CREATION + MARKET REPORT canary (wave 147, lane 147J;
 * owner rulings 5 + 6, contract C11 — lane 147E):
 *   "A lead magnet's delivery asset is created at the same time as the lead magnet. No offer is published for an asset that has
 *    not been produced and validated." · "Build the market-report producer … verified current data, dated sources … Generic text
 *    is not a market report."
 *   → a magnet is created WITH its deliverable (one unit) → while the asset is not ready (a book still being written; a market
 *     report with no verifiable data) the publish is REFUSED and the page stays off → the validator refuses generic text and
 *     accepts the dated, sourced, territory-specific report the real producer builds → once the data exists the publish door
 *     re-produces, the C5 approver's approval lands ON the deliverable inside the ledgered activation → a person's submission
 *     records the promise against THAT deliverable and the delivery sends THAT asset (no per-person render), evidenced.
 *
 * Driven through the REAL modules: lib/kernel/lead-magnets.ts createLeadMagnet / publishLeadMagnet (→ lib/lead-magnets/
 * deliverable-asset.ts, the REAL market-report producer lib/market-reports/producer.ts with its validator, research and data
 * composer, C5 approverFor on the in-memory tables), lib/market-reports/validator.ts validateMarketReport,
 * lib/lead-magnets/promised-deliverables.ts recordPromisedDeliverable / deliverPromised. Seamed: the guide renderer, the
 * producer's providers (RentCast refresh, topic model, writer model, fair-housing scan, brand / tagline finaliser, PDF render,
 * video commission) and the email send — lane 147E's proofs seam the same ones.
 */
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { canary147, jsonOf, tbl } from "./wave147-harness"

const B1 = "e1470000-0000-4000-8000-00000000e0b1"
const AG = "e1470000-0000-4000-8000-00000000e0d1", U1 = "e1470000-0000-4000-8000-00000000e0a1", U2 = "e1470000-0000-4000-8000-00000000e0a2"
const C1 = "e1470000-0000-4000-8000-00000000e0c1"
const NOW = new Date("2026-10-31T12:00:00Z")
const ORIGIN = "https://app.example.com"
const GUIDE_PDF = "https://cdn.example.com/client-docs/e147/buyer_guide-1.pdf"
const REPORT_PDF = "https://cdn.example.com/client-docs/e147/market_report-78704.pdf"

const rentcastRow = () => ({ id: "e147-md-1", brokerage_id: B1, market_area: "78704", zip_code: "78704", city: "Austin", state: "TX", data_date: "2026-10-20", source_type: "rentcast", active_listings: 214, new_listings_30d: 61, sold_listings_30d: 0, median_sale_price: 612000, avg_days_on_market: 44, list_to_sale_ratio: 0, months_of_inventory: 0, price_trend_pct_1yr: -2.4 })
const sold = (i: number) => ({ id: `e147-l-${i}`, brokerage_id: B1, status: "sold", deleted_at: null, zip: "78704", city: "Austin", state: "TX", address: `${100 + i} Elm St`, sold_price: 580000 + i * 10000, sold_date: `2026-0${7 + (i % 3)}-1${i}`, list_price: 590000 + i * 10000, listing_date: `2026-0${6 + (i % 3)}-0${i + 1}`, bedrooms: 3, bathrooms: 2, sqft: 1800 })

function world(withData: boolean) {
  return memSupabase({
    brokerages: [{ id: B1, city: "Austin", state: "TX", zip: "78704", name: "Elm Realty 147J" }],
    agents: [{ id: AG, brokerage_id: B1, user_id: U1, is_active: true }],
    contacts: [{ id: C1, brokerage_id: B1, email: "reader.e147@example.test", first_name: "Rae", has_login: false, city: "Austin" }],
    lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_promises: [], lifecycle_events: [], agent_action_ledger: [],
    activities: [], transparency_updates: [], manager_signals: [], book_projects: [{ id: "e147-bk-1", brokerage_id: B1, stage: "writing", project: { stage: "writing", title: "Calm Home Seller" }, distribution_form_id: null }],
    market_data: withData ? [rentcastRow()] : [], market_trends: [], listings: withData ? [sold(1), sold(2), sold(3), sold(4)] : [],
    farm_territories: [], content_topic_bank: [], generated_documents: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
}

/** The producer's providers (lane 147E's proof seams): the model is OFF, so the data composer writes from the dated data. */
function producerSeams() {
  const calls = { renders: 0, writes: 0 }
  const deps = {
    now: NOW,
    refreshMarketData: async () => ({ source: "rentcast", success: true }),
    topics: async () => ({ suggestions: [{ title: "78704: what your equity did", angle: "How asking prices moved this year", format: "equity_this_quarter", evidence: [{ id: "market:e147-md-1", kind: "market_signal", summary: "asking prices down", observedAt: "2026-10-20", source: "market_data" }], whyNow: "prices moved", by: "ai" }], evidenceCount: 1, notes: [] }),
    write: async () => { calls.writes++; throw new Error("model off in the canary") },
    fairHousing: async () => ({ ok: true, findings: [] }),
    finalize: async (a: { texts: unknown }) => ({ ok: true, texts: a.texts, tagline: "Elm Realty — your neighbours in real estate" }),
    brand: async () => ({ brokerageName: "Elm Realty 147J", agentName: "Ann Agent", licenseLine: "Lic #147 (TX)", primaryColor: "#1144aa" }),
    render: async () => { calls.renders++; return { ok: true, pdfUrl: REPORT_PDF, documentId: "e147-doc-1", error: null } },
    approver: async () => ({ ok: true, permittedUserIds: [U1], primaryUserIds: [U1], basis: "owner", reason: "the agent approves their own asset" }),
    commissionVideo: async () => ({ ok: true, status: "staged", videoProjectId: "e147-vid-1" }),
  }
  return { deps, calls }
}
const guide = (status: "ready" | "staged", reason?: string) => ({
  now: NOW,
  produceGuide: async () => (status === "ready"
    ? { status: "ready", assetUrl: GUIDE_PDF, documentId: null, title: "The Complete Home-Buying Guide", coverNote: { subject: "Your home-buying guide", title: "The Complete Home-Buying Guide", body: "Here is your guide." }, validation: { ok: true, checks: ["hosted_pdf"] } }
    : { status: "staged", assetUrl: null, coverNote: null, reason: reason ?? "the book this magnet distributes is still being written" }),
})

export async function run() {
  const c = canary147("Lead magnet + market report (C11, ruling 6): created WITH its deliverable → publish refused while not ready → generic text refused, a dated sourced report accepted → the C5 approval on the deliverable → the promise delivers THAT asset")
  const lm = await quiet(async () => import("../../lib/kernel/lead-magnets")) as unknown as Record<string, any>
  const val = await quiet(async () => import("../../lib/market-reports/validator")) as unknown as Record<string, any>
  const prod = await quiet(async () => import("../../lib/market-reports/producer")) as unknown as Record<string, any>
  const pd = await quiet(async () => import("../../lib/lead-magnets/promised-deliverables")) as unknown as Record<string, any>

  // ── 1 · created as ONE unit; publish refused while the asset is not ready ──
  const g = c.track(world(false), B1)
  const book = await quiet(async () => lm.createLeadMagnet({ title: "Calm Home Seller", description: "", magnetType: "seller_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live", settings: { book_id: "e147-bk-1" } }, { client: g, deliverable: guide("staged") })) as Record<string, any>
  const bookForm = tbl(g, "lead_capture_forms").find((f) => f.id === book.magnetId) ?? {}
  const bookDel = tbl(g, "lead_magnet_deliverables").find((dd) => dd.form_id === book.magnetId) ?? {}
  c.rule("147E", "A LEAD MAGNET IS CREATED WITH ITS DELIVERY ASSET (ruling 5; C11 'createLeadMagnet … is one transaction with promiseDeliverable'): ONE magnet row and ONE deliverable row in the same create — the book still being written parks the deliverable STAGED and the offer stays OFF, even though it was asked live",
    book.success === true && !!bookForm.id && bookDel.form_id === book.magnetId && bookDel.kind === "book" && bookDel.status === "staged" && bookForm.is_active === false,
    `magnet ${bookForm.id ? "1 row" : "none"} (active ${bookForm.is_active}); deliverable ${bookDel.kind}/${bookDel.status} — ${String(bookDel.error ?? book.deliverable?.reason ?? "").slice(0, 70)}`)
  const pubStaged = await quiet(async () => lm.publishLeadMagnet({ magnetId: book.magnetId, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: g, deliverable: guide("staged") })) as Record<string, any>
  const guideMag = await quiet(async () => lm.createLeadMagnet({ title: "First-time buyer guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live" }, { client: g, deliverable: guide("ready") })) as Record<string, any>
  const guideForm = tbl(g, "lead_capture_forms").find((f) => f.id === guideMag.magnetId) ?? {}
  c.rule("147E", "NO OFFER IS PUBLISHED FOR AN ASSET THAT IS NOT READY (ruling 5; C11 'a magnet row cannot exist in a publishable state without its deliverable row in ready'): publishing the staged book is REFUSED, naming why, and its page stays off — POSITIVE CONTROL: a guide whose asset IS ready and whose creator C5 permits goes live in the same tenant",
    pubStaged.success === false && /still being written/i.test(String(pubStaged.error ?? "")) && tbl(g, "lead_capture_forms").find((f) => f.id === book.magnetId)?.is_active === false && guideMag.success === true && guideForm.is_active === true,
    `publish staged book → ${pubStaged.success ? "PUBLISHED" : `refused: ${String(pubStaged.error ?? "").slice(0, 80)}`}; control guide → active ${guideForm.is_active}`)

  // ── 2 · a market-report magnet with no verifiable data: produced, refused, unpublished ──
  const r = c.track(world(false), B1)
  const seamsNoData = producerSeams()
  const report = await quiet(async () => lm.createLeadMagnet({ title: "78704 market report", description: "", magnetType: "market_report", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live" }, { client: r, deliverable: { now: NOW, report: seamsNoData.deps } })) as Record<string, any>
  const repDel = () => tbl(r, "lead_magnet_deliverables").filter((dd) => dd.form_id === report.magnetId)
  const repForm = () => tbl(r, "lead_capture_forms").find((f) => f.id === report.magnetId) ?? {}
  c.rule("147E", "A MARKET REPORT WITHOUT VERIFIABLE DATA IS NEVER PUBLISHED (ruling 6: 'Generic text is not a market report'): the magnet and its report deliverable are created together; with no dated, sourced data for 78704 the REAL producer refuses, the deliverable is FAILED with the reason, nothing is rendered and the offer stays off",
    report.success === true && repDel().length === 1 && repDel()[0].kind === "report" && repDel()[0].status === "failed" && !!repDel()[0].error && repForm().is_active === false && seamsNoData.calls.renders === 0,
    `deliverable ${repDel()[0]?.kind}/${repDel()[0]?.status} — ${String(repDel()[0]?.error ?? "").slice(0, 110)}; renders ${seamsNoData.calls.renders}; active ${repForm().is_active}`)
  const pubNoData = await quiet(async () => lm.publishLeadMagnet({ magnetId: report.magnetId, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: r, deliverable: { now: NOW, report: producerSeams().deps } })) as Record<string, any>
  c.rule("147E", "…AND ITS PUBLISH IS REFUSED (C11 publish gate: the door re-produces and the producer refuses again): not ready, page off",
    pubNoData.success === false && /not ready/i.test(String(pubNoData.error ?? "")) && repForm().is_active === false, `publish → ${pubNoData.success ? "PUBLISHED" : String(pubNoData.error ?? "").slice(0, 100)}`)

  // ── 3 · the validator: generic text refused, the dated sourced report accepted ──
  const good = await quiet(async () => prod.produceMarketReport(world(true), { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "system" }, territory: { grain: "zip", label: "78704", zip: "78704", city: "Austin", state: "TX" }, topic: { title: "78704 market snapshot", angle: null, evidenceIds: [] }, purpose: "wave147-canary" }, producerSeams().deps)) as Record<string, any>
  const vGood = good.ok ? val.validateMarketReport(good.report, { now: NOW }) : { ok: false, refusals: [`not produced: ${good.stage}: ${good.reason}`], counts: {} }
  const generic = good.ok ? { ...good.report, data: [], unavailable: [], narrative: { headline: "The market is changing", sections: [{ heading: "Market update", body: "Now is a great time to buy or sell. Contact me today!", datumKeys: [] }], buyerTakeaways: [], sellerTakeaways: [], callToAction: "Call me today", authoredBy: "ai" } } : null
  const vGen = generic ? val.validateMarketReport(generic, { now: NOW }) : { ok: true, refusals: [] }
  const datum = good.ok ? good.report.data[0] : null
  c.rule("147E", "GENERIC TEXT IS REFUSED BY THE VALIDATOR; A DATED, SOURCED REPORT IS ACCEPTED (lane 147E item 6: 'a validator refuses a report without dated sourced data'): boilerplate with no data fails on V1 (no dated, sourced data), V3 (not built from data), V4 (no territory) and V7 (boilerplate) — the report the real producer builds from 78704's data passes, every datum dated and sourced",
    !vGen.ok && ["V1", "V3", "V4", "V7"].every((k) => (vGen.refusals as string[]).some((x) => x.startsWith(k))) && vGood.ok === true && !!datum && /^\d{4}-\d{2}-\d{2}$/.test(String(datum.asOf)) && !!datum.source?.provider,
    `generic → ${vGen.ok ? "ACCEPTED" : (vGen.refusals as string[]).map((x) => x.slice(0, 3)).join(",")}; produced → ${vGood.ok ? `accepted (${good.report.data.length} data, e.g. ${datum?.key} as of ${datum?.asOf} from ${datum?.source?.provider})` : jsonOf(vGood.refusals).slice(0, 120)}`)

  // ── 4 · the data arrives → the publish door re-produces → the C5 approval lands on the deliverable ──
  for (const row of [rentcastRow()]) (r.tables.market_data ??= []).push(row)
  for (const row of [sold(1), sold(2), sold(3), sold(4)]) (r.tables.listings ??= []).push(row)
  const notMine = await quiet(async () => lm.publishLeadMagnet({ magnetId: report.magnetId, brokerageId: B1, channels: ["landing_page"], actorUserId: U2, baseUrl: ORIGIN }, { client: r, deliverable: { now: NOW, report: producerSeams().deps } })) as Record<string, any>
  const seamsData = producerSeams()
  const pub = await quiet(async () => lm.publishLeadMagnet({ magnetId: report.magnetId, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: r, deliverable: { now: NOW, report: seamsData.deps } })) as Record<string, any>
  const ready = repDel().filter((dd) => dd.status === "ready")
  const actLedger = tbl(r, "agent_action_ledger").filter((l) => l.action === "marketing.lead_magnet.publish" && l.status === "executed")
  const produceLedger = tbl(r, "agent_action_ledger").filter((l) => l.action === "marketing.market_report.produce" && l.status === "executed")
  c.rule("147E", "THE APPROVAL IS THE C5 APPROVER'S AND IT LANDS ON THE DELIVERABLE (C11 + C5; lane 147E item 2 '… ↔ deliverable ↔ approval ↔ …'): a publisher C5 does not permit is refused with nothing approved; the owner's publish re-produces the report (READY, hosted PDF), records the approval on the deliverable (who + when + basis) inside the ledgered activation (marketing.lead_magnet.publish; the report itself ledgered marketing.market_report.produce) and only then switches the page on",
    notMine.success === false && /not an approver/.test(String(notMine.error ?? "")) && pub.success === true && repForm().is_active === true && ready.length === 1 && ready[0].asset_url === REPORT_PDF && ready[0].approved_by === U1 && !!ready[0].approved_at && ready[0].approver?.basis === "owner" && actLedger.length === 1 && produceLedger.length >= 1,
    `non-approver → ${notMine.success ? "PUBLISHED" : String(notMine.error ?? "").slice(0, 60)}; owner → ${pub.success ? "published" : pub.error}; ready ${ready.length} (${ready[0]?.asset_url === REPORT_PDF ? "the rendered report" : ready[0]?.asset_url}, approved_by ${ready[0]?.approved_by === U1 ? "the owner" : ready[0]?.approved_by}, basis ${ready[0]?.approver?.basis}); ledger publish ${actLedger.length}, produce ${produceLedger.length}`)

  // ── 5 · a person's submission → the promise → delivered: THAT asset, no per-person render ──
  const promise = await quiet(async () => pd.recordPromisedDeliverable(r, { brokerageId: B1, formId: report.magnetId, submissionId: "e147-sub-1", contactId: C1, magnetType: "market_report", now: NOW })) as Record<string, any>
  const prow = tbl(r, "lead_magnet_promises")[0] ?? {}
  const sent: Array<{ text: string }> = []
  let prepares = 0
  const del = await quiet(async () => pd.deliverPromised(r, { brokerageId: B1, promiseId: prow.id }, { now: NOW, prepare: async () => { prepares++; throw new Error("no per-person render") }, sendEmail: async (x: { text: string }) => { sent.push(x); return { success: true, providerKey: "sendgrid", messageId: "e147-m-1" } }, recordActivity: async () => ({ ok: true }), finalize: async (a: { text: string }) => ({ ok: true, text: a.text }), publishSignal: async () => ({ ok: true }) })) as Record<string, any>
  const after = tbl(r, "lead_magnet_promises")[0] ?? {}
  c.rule("147E", "THE PROMISE IS DELIVERED — THE ASSET THAT WAS MADE AND APPROVED (C4 + C11: 'Promises (C4) record the ready deliverable and deliver THAT asset, never a per-person render'): the promise binds the ready deliverable, the delivery sends the approved report's URL with NO per-person render, the row reads delivered with the deliverable version, and the evidence names the deliverable's approver and the recipient",
    promise.ok === true && prow.asset_ref?.deliverable_id === ready[0]?.id && del.ok === true && del.status === "delivered" && prepares === 0 && sent.length === 1 && sent[0].text.includes(REPORT_PDF)
      && /^lead_magnet_deliverables:.+:v\d+$/.test(String(after.asset_version ?? "")) && del.evidence?.deliverable?.approved_by === U1 && del.evidence?.recipient?.contact_id === C1,
    `promise → deliverable ${prow.asset_ref?.deliverable_id === ready[0]?.id ? "bound" : prow.asset_ref?.deliverable_id}; delivery ${del.status} (sent ${sent.length}, report url ${sent[0]?.text.includes(REPORT_PDF)}, per-person renders ${prepares}); asset_version ${after.asset_version}; evidence approver ${del.evidence?.deliverable?.approved_by === U1 ? "the owner" : del.evidence?.deliverable?.approved_by}`)

  c.blind("Every provider behind the producer is a seam (RentCast refresh, topic + writer models — the writer is OFF so the data composer writes, fair-housing scan, brand / tagline finaliser, PDF render, video commission); their own proofs are test:market-report-producer / test:content-distribution. The C5 approver runs for real on in-memory tables with only the owner agent seeded (the roster / team-lead branches are test:video-pipeline-truth's). m898's activation trigger is not executed (memSupabase runs no trigger) — the door's gate is what refuses here; the trigger is lane 147E's SQL proof. 'One transaction' is the magnet insert + the deliverable insert with a compensating delete (lane 147E blind spot).")
  return c.report()
}
