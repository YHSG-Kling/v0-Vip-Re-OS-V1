#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-asset-invariant-guard.ts   (run: tsx scripts/lead-magnet-asset-invariant-guard.ts — key to add: test:lead-magnet-asset-invariant)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147E — owner ruling 5 (2026-10-31: "when lead magnets are created, the asset for delivery is always created at
 * the same time") and contract C11. In memory, no network (producers are seams; the kernel, the deliverable module, C5 and the
 * C4 ledger run for real):
 *
 *   A. WHICH MAGNETS PROMISE AN ASSET — guide / book / report / agent-prepared value; none for alerts, RSVPs, plain forms; the
 *      app's list equals m898's trigger list.
 *   B. ONE UNIT — createLeadMagnet writes the magnet AND its deliverable; a deliverable record that cannot be written takes the
 *      magnet with it (counted delete); a failed / staged production keeps an unpublishable draft with the reason.
 *   C. PUBLISHABLE ONLY WHEN READY — a "live" create activates only on a READY asset whose creator C5 permits; a staged asset
 *      (a book still being written) stays unpublished; publishLeadMagnet refuses without a ready deliverable and refuses a
 *      publisher C5 does not permit; the approval lands on the deliverable; a magnet promising nothing is unchanged.
 *   D. VERSIONS — a re-production supersedes the previous ready version (exactly one ready).
 *   E. C4 BINDING — the promise records the ready deliverable; delivery sends THAT asset without a per-person render; a
 *      superseded version delivers the current one; no ready version → asset_missing (retried, escalated); a legacy magnet
 *      (no deliverable) keeps the runner path (C4 recovery preserved).
 *   F. THE DATABASE GATE — m898 (either line-1 stamp): table, CHECK lists equal to the code, the ready shape, one-ready index,
 *      RLS, the activation trigger and its condition.
 *   G. WIRING (stripped source) — the settings action cannot switch a draft on or resume a page without its asset; the kernel
 *      calls the deliverable module from both doors.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { createLeadMagnet, publishLeadMagnet } from "../lib/kernel/lead-magnets"
import { deliverableSpecFor, produceLeadMagnetDeliverable, ensureDeliverableForPublish, ASSET_PROMISING_MAGNET_TYPES, DELIVERABLE_STATUSES, DELIVERABLE_FULFILMENTS, type DeliverableDeps, type ProducedDeliverable } from "../lib/lead-magnets/deliverable-asset"
import { recordPromisedDeliverable, deliverPromised, PROMISE_ASSET_KINDS, type PromiseDeps } from "../lib/lead-magnets/promised-deliverables"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)

const B1 = "00000000-0000-4000-8000-0000000000b1"
const AG = "00000000-0000-4000-8000-0000000000d1", U1 = "00000000-0000-4000-8000-0000000000a1", U2 = "00000000-0000-4000-8000-0000000000a2"
const C1 = "00000000-0000-4000-8000-0000000000c1"
const NOW = new Date("2026-10-31T12:00:00Z")
const PDF1 = "https://cdn.example.com/client-docs/b1/buyer_guide-1.pdf", PDF2 = "https://cdn.example.com/client-docs/b1/buyer_guide-2.pdf"
const ORIGIN = "https://app.example.com"

function world(extra: Record<string, any[]> = {}, opts: Parameters<typeof memSupabase>[1] = {}) {
  return memSupabase({
    lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_promises: [], lifecycle_events: [], agent_action_ledger: [],
    agents: [{ id: AG, brokerage_id: B1, user_id: U1, is_active: true }],
    contacts: [{ id: C1, brokerage_id: B1, email: "rae@reader.test", first_name: "Rae", has_login: false, city: "Austin" }],
    activities: [], transparency_updates: [], manager_signals: [], book_projects: [],
    ...extra,
  }, { uuidIds: true, ...opts })
}

/** A guide producer seam: ready with a hosted booklet, or the outcome given. */
function guide(out: Partial<ProducedDeliverable> & { status?: ProducedDeliverable["status"] } = {}, url = PDF1): DeliverableDeps & { calls: number } {
  const d: DeliverableDeps & { calls: number } = {
    calls: 0, now: NOW,
    produceGuide: async () => { d.calls++; return { status: "ready", assetUrl: url, documentId: null, title: "The Complete Home-Buying Guide", coverNote: { subject: "Your home-buying guide", title: "The Complete Home-Buying Guide", body: "Here is your guide." }, validation: { ok: true, checks: ["hosted_pdf"] }, ...out } as ProducedDeliverable },
  }
  return d
}
const rows = (db: any, t: string) => (db.tables[t] ?? []) as any[]

/** SQL comments out (`--` to end of line, outside single-quoted strings). NOT scripts/strip-comments.ts: that scanner is for
 *  TypeScript — an apostrophe inside a SQL `--` comment ("magnet's") would open a TS string there and swallow real SQL. */
function stripSqlComments(sql: string): string {
  return sql.split("\n").map((line) => {
    let inStr = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "'") inStr = !inStr
      else if (!inStr && line[i] === "-" && line[i + 1] === "-") return line.slice(0, i)
    }
    return line
  }).join("\n")
}
const listIn = (sql: string, re: RegExp) => ((re.exec(sql)?.[1] ?? "").match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, "")).sort().join()

async function main() {
  // ── A ────────────────────────────────────────────────────────────────────
  section("A. which magnets promise an asset")
  check("buyer/seller guide → guide; with a book → book; market report → report; home value → valuation (a PERSON fulfils it)",
    deliverableSpecFor("buyer_guide", {})?.kind === "guide" && deliverableSpecFor("seller_guide", { book_id: "bk" })?.kind === "book" && deliverableSpecFor("market_report", null)?.kind === "report" && deliverableSpecFor("home_valuation", null)?.fulfilment === "human")
  check("alerts, RSVPs and plain forms promise no asset (the invariant does not apply)", ["listing_alert", "open_house", "generic_form", null].every((t) => deliverableSpecFor(t as never, {}) === null))
  check("every deliverable kind is a C4 promise kind (one vocabulary)", ["buyer_guide", "seller_guide", "market_report", "home_valuation"].every((t) => (PROMISE_ASSET_KINDS as readonly string[]).includes(deliverableSpecFor(t, {})!.kind)))
  check("ASSET_PROMISING_MAGNET_TYPES is exactly the types deliverableSpecFor answers for", [...ASSET_PROMISING_MAGNET_TYPES].sort().join() === ["buyer_guide", "seller_guide", "market_report", "home_valuation"].filter((t) => deliverableSpecFor(t, {})).sort().join())

  // ── B ────────────────────────────────────────────────────────────────────
  section("B. one unit: the magnet and its deliverable")
  {
    const db = world()
    const g = guide()
    const r = await createLeadMagnet({ title: "First-time buyer guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "draft" }, { client: db as never, deliverable: g })
    const f = rows(db, "lead_capture_forms")[0], d = rows(db, "lead_magnet_deliverables")[0]
    check("a draft guide: ONE magnet row + ONE deliverable row (v1, ready, hosted, validated) in the same create", r.success && rows(db, "lead_capture_forms").length === 1 && rows(db, "lead_magnet_deliverables").length === 1 && d.form_id === f.id && d.version === 1 && d.status === "ready" && d.asset_url === PDF1 && d.validation?.ok === true && g.calls === 1)
    check("the create reports the deliverable; the draft stays inactive", r.deliverable?.status === "ready" && r.deliverable?.id === d.id && f.is_active === false && r.lifecycleState === "draft")
  }
  {
    const db = world({}, { refuse: { lead_magnet_deliverables: "permission denied for table lead_magnet_deliverables" } })
    const r = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "draft" }, { client: db as never, deliverable: guide() })
    check("POSITIVE CONTROL: the deliverable record cannot be written → the magnet is DELETED again (never a magnet without its record)", !r.success && rows(db, "lead_capture_forms").length === 0 && /not kept/.test(r.error ?? ""), JSON.stringify(r))
  }
  {
    const db = world()
    const r = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live" }, { client: db as never, deliverable: guide({ status: "failed", assetUrl: null, coverNote: null, reason: "the designed PDF did not render" }) })
    const f = rows(db, "lead_capture_forms")[0], d = rows(db, "lead_magnet_deliverables")[0]
    check("a FAILED production (asked live): the magnet stays an unpublishable DRAFT, the deliverable says why", r.success && f.is_active === false && r.lifecycleState === "draft" && d.status === "failed" && /did not render/.test(d.error ?? "") && /did not render/.test(r.deliverable?.reason ?? ""))
  }
  {
    const db = world()
    const r = await createLeadMagnet({ title: "Report", description: "", magnetType: "market_report", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live" }, { client: db as never, deliverable: { now: NOW, produceReport: async () => ({ status: "ready", assetUrl: "https://cdn.example.com/r.pdf", coverNote: null }) } })
    check("a producer that claims ready WITHOUT its cover note is recorded FAILED (ready means hosted + carried)", rows(db, "lead_magnet_deliverables")[0]?.status === "failed" && rows(db, "lead_capture_forms")[0]?.is_active === false && r.success)
  }

  // ── C ────────────────────────────────────────────────────────────────────
  section("C. publishable only when the deliverable is ready (and the publisher is a C5 approver)")
  {
    const db = world()
    const r = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live" }, { client: db as never, deliverable: guide() })
    const f = rows(db, "lead_capture_forms")[0], d = rows(db, "lead_magnet_deliverables")[0]
    const led = rows(db, "agent_action_ledger").filter((x) => x.action === "marketing.lead_magnet.publish")
    check("a LIVE create with a ready asset: active + published, approved by the creator (C5 owner), ledgered", r.success && f.is_active === true && r.lifecycleState === "published" && d.approved_by === U1 && d.approver?.basis === "owner" && led.length === 1 && led[0].status === "executed", JSON.stringify({ r, d: { status: d?.status, approved_by: d?.approved_by } }))
  }
  {
    const db = world()
    const r = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U2, publishState: "live" }, { client: db as never, deliverable: guide() })
    check("a LIVE create by someone C5 does NOT permit (not the owner, no roster seat): ready asset, but stays unpublished with the reason", r.success && rows(db, "lead_capture_forms")[0]?.is_active === false && /not an approver/.test(r.deliverable?.reason ?? ""), JSON.stringify(r.deliverable))
  }
  {
    const db = world({ book_projects: [{ id: "bk-1", brokerage_id: B1, stage: "writing", project: { stage: "writing", title: "Calm Home Seller" }, distribution_form_id: null }] })
    const r = await createLeadMagnet({ title: "Book", description: "", magnetType: "seller_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live", settings: { book_id: "bk-1" } }, { client: db as never, deliverable: guide({ status: "staged", assetUrl: null, coverNote: null, reason: "the book this magnet distributes is still being written" }) })
    const d = rows(db, "lead_magnet_deliverables")[0]
    check("an ASYNC render (the book still being written) parks the deliverable STAGED; the offer stays unpublished", r.success && d.kind === "book" && d.status === "staged" && rows(db, "lead_capture_forms")[0]?.is_active === false)
    const pub = await publishLeadMagnet({ magnetId: r.magnetId!, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: db as never, deliverable: guide({ status: "staged", assetUrl: null, coverNote: null, reason: "the book this magnet distributes is still being written" }) })
    check("publishing while the book is still being written is refused, naming why (the book gate answers first), page off", !pub.success && /still being written/i.test(pub.error ?? "") && rows(db, "lead_capture_forms")[0]?.is_active === false, pub.error)
    const gate = await ensureDeliverableForPublish(db as never, { brokerageId: B1, formId: r.magnetId!, magnetType: "seller_guide", title: "Book", agentId: AG, settings: { book_id: "bk-1" }, actorUserId: U1 }, guide({ status: "staged", assetUrl: null, coverNote: null, reason: "the book this magnet distributes is still being written" }))
    check("the C11 gate itself refuses a STAGED deliverable with its reason (the offer stays unpublished until ready)", !gate.ok && /still being written/.test(gate.error))
  }
  {
    const db = world()
    const created = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "draft" }, { client: db as never, deliverable: guide({ status: "failed", assetUrl: null, coverNote: null, reason: "render failed" }) })
    const refused = await publishLeadMagnet({ magnetId: created.magnetId!, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: db as never, deliverable: guide({ status: "failed", assetUrl: null, coverNote: null, reason: "render failed again" }) })
    check("POSITIVE CONTROL: no ready deliverable → publish REFUSED (production retried at the door and failed again), page off", !refused.success && /not ready/.test(refused.error ?? "") && rows(db, "lead_capture_forms")[0]?.is_active === false && rows(db, "lead_magnet_deliverables").length === 2)
    const notMine = await publishLeadMagnet({ magnetId: created.magnetId!, brokerageId: B1, channels: ["landing_page"], actorUserId: U2, baseUrl: ORIGIN }, { client: db as never, deliverable: guide() })
    check("a ready asset but a publisher C5 does not permit → refused, nothing approved", !notMine.success && /not an approver/.test(notMine.error ?? "") && rows(db, "lead_capture_forms")[0]?.is_active === false && !rows(db, "lead_magnet_deliverables").some((d) => d.approved_by))
    const ok = await publishLeadMagnet({ magnetId: created.magnetId!, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: db as never, deliverable: guide() })
    const ready = rows(db, "lead_magnet_deliverables").filter((d) => d.status === "ready")
    check("the owner publishes a ready asset → published; the approval is on the deliverable (who + when + C5 basis)", ok.success && rows(db, "lead_capture_forms")[0]?.is_active === true && ready.length === 1 && ready[0].approved_by === U1 && !!ready[0].approved_at && ready[0].approver?.basis === "owner", ok.error)
  }
  {
    const db = world()
    const r = await createLeadMagnet({ title: "Ask us", description: "", magnetType: "generic_form", brokerageId: B1, agentId: AG, createdBy: U1 }, { client: db as never, deliverable: guide() })
    check("a magnet that promises NOTHING keeps the old live create byte-for-byte (active, no deliverable, producer not called)", r.success && r.lifecycleState === "published" && rows(db, "lead_capture_forms")[0]?.is_active === true && rows(db, "lead_magnet_deliverables").length === 0 && r.deliverable === null)
  }
  {
    const db = world()
    const created = await createLeadMagnet({ title: "Value", description: "", magnetType: "home_valuation", brokerageId: B1, agentId: AG, createdBy: U1 }, { client: db as never })
    const d = rows(db, "lead_magnet_deliverables")[0]
    check("an agent-prepared VALUE: ready = an agent with a user seat is assigned (fulfilment human, no file) → live", created.success && d.fulfilment === "human" && d.status === "ready" && d.validation?.fulfilled_by_user_id === U1 && rows(db, "lead_capture_forms")[0]?.is_active === true)
    const orphan = world({ agents: [] })
    const r2 = await createLeadMagnet({ title: "Value", description: "", magnetType: "home_valuation", brokerageId: B1, agentId: AG, createdBy: U1 }, { client: orphan as never })
    check("…and with nobody to prepare it, the value magnet does NOT go live (failed, said)", r2.success && rows(orphan, "lead_magnet_deliverables")[0]?.status === "failed" && rows(orphan, "lead_capture_forms")[0]?.is_active === false)
  }

  // ── D ────────────────────────────────────────────────────────────────────
  section("D. versions: one ready per magnet")
  {
    const db = world()
    const created = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "draft" }, { client: db as never, deliverable: guide() })
    const again = await produceLeadMagnetDeliverable(db as never, { brokerageId: B1, formId: created.magnetId!, magnetType: "buyer_guide", title: "Guide", agentId: AG, settings: {}, actorUserId: U1 }, guide({}, PDF2))
    const all = rows(db, "lead_magnet_deliverables")
    check("a re-production SUPERSEDES the previous ready version — exactly one ready (v2), v1 superseded", again.ok && all.length === 2 && all.filter((d) => d.status === "ready").length === 1 && all.find((d) => d.version === 2)?.status === "ready" && all.find((d) => d.version === 1)?.status === "superseded")
    const gate = await ensureDeliverableForPublish(db as never, { brokerageId: B1, formId: created.magnetId!, magnetType: "buyer_guide", title: "Guide", agentId: AG, settings: {}, actorUserId: U1 }, guide())
    check("the publish gate reuses the ready version (no needless re-production)", gate.ok && gate.required && gate.deliverable.version === 2 && rows(db, "lead_magnet_deliverables").length === 2)
  }

  // ── E ────────────────────────────────────────────────────────────────────
  section("E. C4 binding: the promise delivers the asset created with the magnet")
  {
    const db = world()
    const created = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live" }, { client: db as never, deliverable: guide() })
    const d1 = rows(db, "lead_magnet_deliverables")[0]
    const p = await recordPromisedDeliverable(db as never, { brokerageId: B1, formId: created.magnetId!, submissionId: "s-1", contactId: C1, magnetType: "buyer_guide", now: NOW })
    const prow = rows(db, "lead_magnet_promises")[0]
    check("the promise records the READY deliverable (id + version on asset_ref)", p.ok && p.promised && prow.asset_ref?.deliverable_id === d1.id && prow.asset_ref?.deliverable_version === 1)
    const sent: any[] = []
    let prepares = 0
    const deps: PromiseDeps = { now: NOW, prepare: async () => { prepares++; throw new Error("no per-person render") }, sendEmail: async (x) => { sent.push(x); return { success: true, providerKey: "sendgrid", messageId: "m-1" } }, recordActivity: async () => ({ ok: true }), finalize: async (a) => ({ ok: true, text: a.text }), publishSignal: async () => ({ ok: true }) }
    // a NEWER version is produced and the promised one superseded before delivery
    await produceLeadMagnetDeliverable(db as never, { brokerageId: B1, formId: created.magnetId!, magnetType: "buyer_guide", title: "Guide", agentId: AG, settings: {}, actorUserId: U1 }, guide({}, PDF2))
    const del = await deliverPromised(db as never, { brokerageId: B1, promiseId: prow.id }, deps)
    check("delivered from the deliverable — NO per-person render — and the superseded promised version falls to the CURRENT ready one", del.ok && del.status === "delivered" && prepares === 0 && sent.length === 1 && sent[0].text.includes(PDF2), JSON.stringify(del))
    check("the delivered row names the deliverable version (asset_version) and the chain on its evidence", /^lead_magnet_deliverables:.+:v2$/.test(rows(db, "lead_magnet_promises")[0]?.asset_version ?? "") && (del as any).evidence?.deliverable?.version === 2 && (del as any).evidence?.recipient?.contact_id === C1)
  }
  {
    const db = world()
    const created = await createLeadMagnet({ title: "Guide", description: "", magnetType: "buyer_guide", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "live" }, { client: db as never, deliverable: guide() })
    await recordPromisedDeliverable(db as never, { brokerageId: B1, formId: created.magnetId!, submissionId: "s-2", contactId: C1, magnetType: "buyer_guide", now: NOW })
    for (const d of rows(db, "lead_magnet_deliverables")) d.status = "failed"
    const sent: any[] = []
    const del = await deliverPromised(db as never, { brokerageId: B1, promiseId: rows(db, "lead_magnet_promises")[0].id }, { now: NOW, sendEmail: async (x) => { sent.push(x); return { success: true, providerKey: "sendgrid" } }, finalize: async (a) => ({ ok: true, text: a.text }), publishSignal: async () => ({ ok: true }), recordActivity: async () => ({ ok: true }) })
    check("no ready version left → ASSET_MISSING (retried with back-off, escalated when overdue) — never delivered, nothing sent", del.ok && del.status === "asset_missing" && sent.length === 0 && !!rows(db, "lead_magnet_promises")[0]?.next_attempt_at)
  }
  {
    const db = world({ lead_capture_forms: [{ id: "f-legacy", brokerage_id: B1, agent_id: AG, magnet_type: "buyer_guide", name: "Old guide", is_active: true, settings: { lifecycle: { state: "published", approved_by: U1 } } }] })
    await recordPromisedDeliverable(db as never, { brokerageId: B1, formId: "f-legacy", submissionId: "s-3", contactId: C1, magnetType: "buyer_guide", now: NOW })
    let prepares = 0
    const del = await deliverPromised(db as never, { brokerageId: B1, promiseId: rows(db, "lead_magnet_promises")[0].id }, { now: NOW, prepare: async () => { prepares++; return { deliverable: { subject: "s", title: "Guide", body: "b" }, pdfUrl: PDF1, documentId: null, deliverableKind: "booklet" } }, sendEmail: async () => ({ success: true, providerKey: "sendgrid" }), finalize: async (a) => ({ ok: true, text: a.text }), publishSignal: async () => ({ ok: true }), recordActivity: async () => ({ ok: true }) })
    check("a LEGACY published magnet (no deliverable) keeps C4's recovery path: the runner prepares, the promise is delivered", del.ok && del.status === "delivered" && prepares === 1 && !rows(db, "lead_magnet_promises")[0]?.asset_ref?.deliverable_id)
  }

  // ── F ────────────────────────────────────────────────────────────────────
  section("F. the database gate (m898)")
  const migFile = readdirSync(join(ROOT, "supabase/migrations")).find((f) => /^m898-/.test(f))
  check("m898 exists", !!migFile)
  if (migFile) {
    const text = raw(`supabase/migrations/${migFile}`)
    const line1 = text.split("\n")[0]
    check("line 1 is the lane stamp or the APPLIED stamp (the rule, not the waypoint)", /^-- WRITTEN, NOT APPLIED \(wave 147, lane 147E\)/.test(line1) || /^-- ── APPLIED LIVE /.test(line1), line1)
    const sql = stripSqlComments(text)
    const listOf = (re: RegExp) => listIn(sql, re)
    check("the SQL stripper removes comments and keeps code (the header's prose is gone, the CREATE TABLE stays)", !/WHY A NEW TABLE/.test(sql) && /CREATE TABLE IF NOT EXISTS public\.lead_magnet_deliverables/.test(sql) && /'\^https:\/\/'/.test(sql))
    check("status CHECK == DELIVERABLE_STATUSES", listOf(/status\s+IN\s*\(([^)]*)\)/) === [...DELIVERABLE_STATUSES].sort().join())
    check("kind CHECK == PROMISE_ASSET_KINDS (one vocabulary with m883)", listOf(/kind\s+IN\s*\(([^)]*)\)/) === [...PROMISE_ASSET_KINDS].sort().join())
    check("fulfilment CHECK == DELIVERABLE_FULFILMENTS", listOf(/fulfilment\s+IN\s*\(([^)]*)\)/) === [...DELIVERABLE_FULFILMENTS].sort().join())
    check("the trigger's magnet types == ASSET_PROMISING_MAGNET_TYPES", listOf(/magnet_type\s+IN\s*\(([^)]*)\)/) === [...ASSET_PROMISING_MAGNET_TYPES].sort().join())
    check("the trigger fires BEFORE INSERT OR UPDATE OF is_active and refuses activation without its OWN ready deliverable (same tenant)", /BEFORE INSERT OR UPDATE OF is_active ON public\.lead_capture_forms/.test(sql) && /OLD\.is_active IS DISTINCT FROM TRUE/.test(sql) && /d\.form_id = NEW\.id AND d\.brokerage_id = NEW\.brokerage_id AND d\.status = 'ready'/.test(sql) && /RAISE EXCEPTION/.test(sql))
    check("the ready shape: validated, produced, and (for a system asset) https-hosted with its cover note", /status <> 'ready' OR/.test(sql) && /validation ->> 'ok'\) = 'true'/.test(sql) && /asset_url ~ '\^https:\/\/'/.test(sql))
    check("one ready per magnet (partial unique index) + UNIQUE (form_id, version)", /UNIQUE INDEX[\s\S]*?\(form_id\) WHERE status = 'ready'/.test(sql) && /UNIQUE \(form_id, version\)/.test(sql))
    check("RLS on, tenant read only, writes revoked from authenticated / anon", /ENABLE ROW LEVEL SECURITY/.test(sql) && /current_user_brokerage_id\(\)/.test(sql) && /REVOKE INSERT, UPDATE, DELETE ON public\.lead_magnet_deliverables FROM authenticated, anon/.test(sql))
    const planted = listIn("CHECK (status IN ('ready', 'failed'))", /status\s+IN\s*\(([^)]*)\)/)
    check("positive control: the CHECK parser reads a planted list — and a drifted list would NOT equal the code", planted === "failed,ready" && planted !== [...DELIVERABLE_STATUSES].sort().join())
  }

  // ── G ────────────────────────────────────────────────────────────────────
  section("G. wiring (stripped source)")
  const act = code("app/actions/lead-magnets-actions.ts")
  const settingsAction = act.slice(act.indexOf("export async function updateMagnetSettingsAction"), act.indexOf("export async function getMagnetPerformanceAction"))
  check("the settings action cannot switch a never-published draft on (publish door only)", /updatePayload\.is_active === true/.test(settingsAction) && /state !== "published"/.test(settingsAction))
  check("…and a resumed page needs its asset ready (ensureDeliverableForPublish) before the write", settingsAction.indexOf("ensureDeliverableForPublish(") > 0 && settingsAction.indexOf("ensureDeliverableForPublish(") < settingsAction.indexOf(".update(updatePayload)"))
  const kern = code("lib/kernel/lead-magnets.ts")
  const createFn = kern.slice(kern.indexOf("export async function createLeadMagnet("), kern.indexOf("export async function cloneLeadMagnet("))
  const publishFn = kern.slice(kern.indexOf("export async function publishLeadMagnet("), kern.indexOf("// Create QR code if requested"))
  check("createLeadMagnet produces the deliverable and deletes the magnet when its record cannot be written", /produceLeadMagnetDeliverable\(/.test(createFn) && /\.from\("lead_capture_forms"\)\.delete\(\)/.test(createFn))
  check("createLeadMagnet never inserts an asset-promising magnet active (is_active: liveAtInsert = !isDraft && !spec)", /liveAtInsert = !isDraft && !spec/.test(createFn) && /is_active: liveAtInsert/.test(createFn))
  check("publishLeadMagnet: the deliverable gate + the C5 approver BEFORE the ledgered activation; the approval recorded inside it", publishFn.indexOf("ensureDeliverableForPublish(") > 0 && publishFn.indexOf("deliverableApprover(") > publishFn.indexOf("ensureDeliverableForPublish(") && publishFn.indexOf("recordDeliverableApproval(") > publishFn.indexOf("withActionLedger<"))

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  console.log("\nBlind spots (published beside the number):")
  for (const b of [
    "the m898 trigger is proven from its SQL text — the in-memory client runs no triggers; live, the integrator's VERIFY block (pg_trigger) confirms it",
    "the guide booklet / book / report producers are seams here (their own proofs: test:autonomous-marketing, test:book-publishing, test:market-report-producer)",
    "one transaction = the magnet insert + the deliverable insert as one unit with a COMPENSATING delete (supabase-js has no multi-statement transaction); a crash between the two leaves an inactive draft that the trigger keeps unpublishable",
    "updateMagnetSettingsAction is a session-gated \"use server\" export — proven by stripped-source order, not driven",
    "the C5 approver resolution runs for real on the in-memory tables (agents / teams / users empty except the owner) — roster and team-lead branches are proven by test:video-pipeline-truth's C5 section",
  ]) console.log(`  · ${b}`)
  if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); console.log("\n❌ LEAD_MAGNET_ASSET_INVARIANT_FAIL"); process.exit(1) }
  console.log("\n✅ LEAD_MAGNET_ASSET_INVARIANT_PASS — every lead magnet is created with its delivery asset; nothing publishes until that asset is produced, validated and approved; promises deliver the asset that was made")
}

main().catch((e) => { console.error(e); process.exit(1) })
