/**
 * scripts/wave154-partials-guard.ts — `npm run test:wave154-partials` (wave 155, lane 155K; directive K items 3, 4, 6 and the
 * 155C carry-in). Every proof is SIMULATED: an in-memory database that COUNTS writes, injected seams for the creative step, the
 * share-grant sealer and the email egress — no provider, model or network is ever reached. "Now" is derived at run time.
 *
 * Each repaired branch has a counterexample that is RED at the base d2d6468c, and each widening has a NEGATIVE twin proving
 * access for unrelated actors is at least as strict as before:
 *   K3  marketing education is not person acquisition (lib/repurpose/refurbish-run.ts, app/api/cron/local-intel/route.ts)
 *   K4  office circles + adopter calibration on m973 sharing (lib/marketing/circle-tactics.ts, m984)
 *   K6  the governed appraiser-packet send (lib/vendors/appraiser-independence.ts, app/actions/transaction-milestones.ts)
 *   C   one quiz grader (lib/kernel/agent-onboarding.ts → lib/academy/quiz.ts gradeQuiz)
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ── the fake database ────────────────────────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>
function fakeDb(seed: Record<string, Row[]>, opts: { refuse?: Set<string> } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const writes: Array<{ table: string; op: string; row: Row }> = []
  let n = 0
  function q(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let mode: "select" | "insert" | "update" = "select"
    let payload: Row | Row[] | null = null
    let limitN: number | null = null
    let single: "maybe" | "one" | null = null
    const api: any = {
      select() { return api },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return api },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return api },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return api },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return api },
      gte(c: string, v: any) { filters.push((r) => r[c] >= v); return api },
      not() { return api },
      or(expr: string) { const parts = expr.split(",").map((p) => p.split(".eq.")); filters.push((r) => parts.some(([c, v]) => r[c] === v)); return api },
      order() { return api },
      limit(k: number) { limitN = k; return api },
      maybeSingle() { single = "maybe"; return api },
      single() { single = "one"; return api },
      insert(p: Row | Row[]) { mode = "insert"; payload = p; return api },
      update(p: Row) { mode = "update"; payload = p; return api },
      then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve(run()).then(res, rej) },
    }
    function run() {
      if (opts.refuse?.has(table)) return { data: null, error: { message: `${table} refused (simulated)` } }
      const t = (tables[table] ??= [])
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: r.id ?? `id-${table}-${++n}`, ...r }))
        for (const r of rows) { t.push(r); writes.push({ table, op: "insert", row: r }) }
        return { data: single ? rows[0] : rows, error: null }
      }
      let rows = t.filter((r) => filters.every((f) => f(r)))
      if (mode === "update") { for (const r of rows) { Object.assign(r, payload); writes.push({ table, op: "update", row: r }) } }
      if (limitN != null) rows = rows.slice(0, limitN)
      if (single) return { data: rows[0] ?? null, error: single === "one" && !rows[0] ? { message: "no rows" } : null }
      return { data: rows, error: null }
    }
    return api
  }
  return { from: (t: string) => q(t), tables, writes }
}

const NOW = new Date()
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString()
const DAY = 86_400_000
const T1 = "t1-brokerage", T2 = "t2-brokerage"

async function main() {
  // A section whose module lacks the export (the base) counts as RED and the next section still runs.
  const section = async (name: string, fn: () => Promise<void>) => { try { await fn() } catch (e) { check(`${name} section ran`, false, e instanceof Error ? e.message : String(e)) } }
  // ═══ K3 — the topic → creative trigger without an acquisition territory ═══════════════════════════════════════════════
  await section("K3", async () => {
  console.log("K3 — marketing education is not person acquisition")
  const rr = await import("../lib/repurpose/refurbish-run")
  const ri = await import("../lib/repurpose/refurbish-idea")
  const fpq = ri.refurbishTriggerVerdict({ kind: "first_party_question" as never })
  check("K3.3 RED AT BASE: a first-party question STARTS a refurbish (tenant_owned) — at d2d6468c the verdict had no such kind and said no", fpq.start === true && fpq.rights === "tenant_owned", JSON.stringify(fpq))
  const topic = (id: string, kind: string, extra: Row = {}) => ({ id, brokerage_id: T2, topic_title: "What closing costs should I expect?", expires_at: iso(10 * DAY), status: "fresh", scraped_at: iso(-DAY), raw_data: { intake: { source_kind: kind }, provenance: [{ source_kind: kind, rights: "first_party" }], popularity_evidence_type: "measured", ...extra } })
  const k3db = fakeDb({ content_topic_bank: [topic("q1", "website_question"), { ...topic("r1", "reddit_thread"), raw_data: { intake: { source_kind: "reddit_thread" }, provenance: [{ source_kind: "reddit_thread", rights: "idea_only" }], popularity_evidence_type: "measured" } }], agent_action_ledger: [] })
  let executed = 0
  const seams = { record: async () => ({ recorded: true }), connectedPlatforms: async () => ["linkedin"], execute: async () => { executed++; return { started: true, reason: "drafted (simulated)" } } }
  const fp = await rr.startTopicRefurbish(k3db, { brokerageId: T2, topicId: "q1", now: NOW, territory: "none" }, seams as never)
  check("K3.4 RED AT BASE: a tenant WITHOUT a territory starts a creative from its own customers' question (the creative step ran once)", fp.started === true && executed === 1, `${fp.route}: ${fp.reason}`)
  const before = executed
  const tp = await rr.startTopicRefurbish(k3db, { brokerageId: T2, topicId: "r1", now: NOW, territory: "none" }, seams as never)
  check("K3.5 NEGATIVE: without a territory a Reddit (third-party research) topic is HELD and nothing is generated", !tp.started && executed === before && /third-party research/.test(tp.reason), tp.reason)
  const tw = await rr.startTopicRefurbish(k3db, { brokerageId: T2, topicId: "r1", now: NOW }, seams as never)
  check("K3.6 TWIN: the territory sweep's behavior is unchanged — the same Reddit topic still starts for a territory tenant", tw.started === true, tw.reason)
  check("K3.1 a website question (the tenant's own customers) is FIRST-PARTY", rr.topicAcquisitionClass("website_question") === "first_party")
  check("K3.2 NEGATIVE: Reddit / Apify / community / web research / an unknown or empty kind are THIRD-PARTY (fail closed)",
    ["reddit_thread", "apify_social", "community_post", "web_research", "facebook_group_question", "made_up_kind", "", null].every((k) => rr.topicAcquisitionClass(k as never) === "third_party"))
  // the sweep: who it visits
  const visited: Array<{ b: string; territory: string | undefined }> = []
  const pass = (async (_s: unknown, b: string, o: { territory?: string }) => { visited.push({ b, territory: o.territory }); return { considered: 1, started: 1, held: 0, skipped: 0, variants: 0, errors: [] } }) as never
  const intel = async () => ({ inserted: 0, refreshed: 0, errors: [] })
  const sw = await rr.runFirstPartyTopicSweep({ from: () => ({}) } as never, { now: NOW }, { resolve: async () => ({ activeBrokerageIds: [T1, T2], territories: [{ brokerage_id: T1 }], noOp: false, reason: "ok" }), intel, pass })
  check("K3.7 the first-party sweep visits ONLY the live tenant without a territory, always with territory 'none'", sw.visited === 1 && visited.length === 1 && visited[0].b === T2 && visited[0].territory === "none", JSON.stringify(visited))
  visited.length = 0
  const swFail = await rr.runFirstPartyTopicSweep({ from: () => ({}) } as never, { now: NOW }, { resolve: async () => ({ activeBrokerageIds: [], territories: [], noOp: true, reason: "subscription_query_failed", error: "refused" }), intel, pass })
  check("K3.8 NEGATIVE: an unreadable subscription list visits NOBODY (fail closed)", swFail.visited === 0 && visited.length === 0 && swFail.reason === "subscription_query_failed")
  const swTerr = await rr.runFirstPartyTopicSweep({ from: () => ({}) } as never, { now: NOW }, { resolve: async () => ({ activeBrokerageIds: [T1, T2], territories: [], noOp: true, reason: "territory_query_failed", error: "refused" }), intel, pass })
  check("K3.9 an unreadable territory list takes the STRICTER branch (every live tenant first-party only)", swTerr.visited === 2 && visited.every((v) => v.territory === "none"))
  // the paid geography pull keeps its gate
  const { resolveActivePullGate } = await import("../lib/lead-pipeline/scrape-territories")
  const gate = await resolveActivePullGate(fakeDb({ subscriptions: [{ brokerage_id: T2, status: "active", trial_end: null }], brokerages: [{ id: T2, status: "active" }], lead_scraping_markets: [] }) as never)
  const pull = gate.check({ brokerageId: T2 })
  check("K3.10 NEGATIVE: a paid / scraped geography pull for a tenant with no territory is STILL refused (resolveActivePullGate)", pull.allowed === false && pull.reason === "no_active_territories", JSON.stringify(pull))
  const cron = src("app/api/cron/local-intel/route.ts")
  check("K3.11 the existing local-intel cron reaches the first-party sweep after the territory sweep (stripped source)", /runLocalIntelSweep\(svc\)[\s\S]*runFirstPartyTopicSweep\(svc as never\)/.test(cron))
  // positive control for K3.11's regex: the same pattern on a specimen without the call does not match
  check("K3.12 positive control: the wiring regex does not match a route that never calls the sweep", !/runLocalIntelSweep\(svc\)[\s\S]*runFirstPartyTopicSweep\(svc as never\)/.test("const swept = await runLocalIntelSweep(svc)"))

  })
  // ═══ K4 — office circles + calibration ════════════════════════════════════════════════════════════════════════════════
  await section("K4", async () => {
  console.log("K4 — office circles and adopter calibration")
  const ct = await import("../lib/marketing/circle-tactics")
  const officeSeed = () => ({
    locations: [{ id: "L1", brokerage_id: T1, status: "active", name: "North" }, { id: "L2", brokerage_id: T1, status: "active", name: "South" }, { id: "L9", brokerage_id: T1, status: "archived" }, { id: "LX", brokerage_id: T2, status: "active" }],
    agents: [{ id: "ag-p", user_id: "u-p", brokerage_id: T1, is_active: true, location_id: "L1" }, { id: "ag-m", user_id: "u-m", brokerage_id: T1, is_active: true, location_id: "L1" }, { id: "ag-o", user_id: "u-o", brokerage_id: T1, is_active: true, location_id: "L2" }, { id: "ag-x", user_id: "u-x", brokerage_id: T2, is_active: true, location_id: "LX" }],
    team_members: [], agent_mentor_relationships: [], circle_tactic_shares: [], farm_territories: [],
  })
  const deps = (db: ReturnType<typeof fakeDb>) => ({ now: NOW, ledger: async (_c: unknown, run: () => Promise<any>) => run(), roi: async () => ({ ok: true as const, complete: true, campaigns: [] }), screens: { personalData: () => null, nearCopy: () => null }, decide: undefined, arbiter: (async () => ({ optionId: "recommend_adaptation", rationale: "simulated", source: "deterministic" })) as never, policy: {} as never })
  const shareIn = (locationId: string) => ({ circle: { kind: "office" as never, locationId }, method: "Lead with the consumer question then a short local answer", components: ["consumer_question_first_hook"], explanation: "Open on the question people ask most and answer it locally", sourceKind: "producer_outcome" as const, tacticCampaignIds: [] })
  const db4 = fakeDb(officeSeed())
  const sh = await ct.shareCircleTactic(db4, { userId: "u-p", brokerageId: T1 }, shareIn("L1"), deps(db4))
  const ins = db4.writes.find((w) => w.table === "circle_tactic_shares" && w.op === "insert")?.row
  check("K4.4 RED AT BASE: a producer shares with THEIR OFFICE (circle_kind office, location_id set) — at d2d6468c 'office' was unknown_circle_kind", sh.ok === true && ins?.circle_kind === "office" && ins?.location_id === "L1", JSON.stringify(sh))
  check("K4.5 the office share is evaluated for that office's other agent only (one member offer, not the other office's agent)", !!ins && Object.keys(ins.offers ?? {}).length === 1 && "u-m" in (ins.offers ?? {}), JSON.stringify(ins?.offers))
  const shOther = await ct.shareCircleTactic(db4, { userId: "u-p", brokerageId: T1 }, shareIn("L2"), deps(db4))
  check("K4.6 NEGATIVE: a producer cannot share with an office they are not seated in", !shOther.ok && (shOther as { reason: string }).reason === "producer_not_a_member_of_circle")
  const shX = await ct.shareCircleTactic(db4, { userId: "u-p", brokerageId: T1 }, shareIn("LX"), deps(db4))
  check("K4.7 NEGATIVE: another tenant's office is refused", !shX.ok && (shX as { reason: string }).reason === "office_not_in_tenant")
  const shA = await ct.shareCircleTactic(db4, { userId: "u-p", brokerageId: T1 }, shareIn("L9"), deps(db4))
  check("K4.8 NEGATIVE: an archived office shares nothing", !shA.ok && (shA as { reason: string }).reason === "office_not_active")
  const team = { ...shareIn("L1"), circle: { kind: "team" as never, teamId: "TM" } }
  const teamOnly = await ct.shareCircleTactic(db4, { userId: "u-p", brokerageId: T1 }, team, deps(db4))
  check("K4.9 TWIN: a team the producer is not on is still refused (team rule unchanged)", !teamOnly.ok)
  const sameOffice = await ct.listCircleTacticsForViewer(db4, { userId: "u-m", brokerageId: T1 }, { now: NOW })
  const otherOffice = await ct.listCircleTacticsForViewer(db4, { userId: "u-o", brokerageId: T1 }, { now: NOW })
  check("K4.10 the office's agent SEES the office share", sameOffice.visible.length === 1 && sameOffice.visible[0].circleKind === "office", JSON.stringify(sameOffice))
  check("K4.11 NEGATIVE: an agent of ANOTHER office of the same tenant does NOT see it", otherOffice.visible.length === 0 && !otherOffice.error)
  // the member moves office → the share disappears for them, and their adaptation stops counting
  const shareRow = db4.tables.circle_tactic_shares[0]
  shareRow.offers = { "u-m": { decision: "recommend_adaptation", adapted_topic_id: "topic-m" } }
  db4.tables.agents.find((a) => a.id === "ag-m")!.location_id = "L2"
  const moved = await ct.listCircleTacticsForViewer(db4, { userId: "u-m", brokerageId: T1 }, { now: NOW })
  const mine = await ct.listCircleTacticsForViewer(db4, { userId: "u-p", brokerageId: T1 }, { now: NOW })
  check("K4.12 NEGATIVE: a member who moved to another office no longer sees it", moved.visible.length === 0)
  check("K4.13 NEGATIVE: their adaptation stops counting in calibration (no other office's outcomes) — no_adopters", mine.mine[0]?.calibration?.status === "no_adopters", JSON.stringify(mine.mine[0]?.calibration))

  const cal2 = ct.classifyAdopterCalibration([{ adopterUserId: "a", adaptedEngagement: 9, baselineEngagements: [1, 2, 3] }, { adopterUserId: "b", adaptedEngagement: 9, baselineEngagements: [1, 2, 3] }, { adopterUserId: "c", adaptedEngagement: null, baselineEngagements: [1, 2, 3] }])
  check("K4.1 below the measured minimum the adopter result is NULL (never 0) — unmeasured adopters are not counted", cal2.status === "not_enough_measured_outcomes" && cal2.aboveOwnBaseline === null && cal2.measuredAdopters === 2 && cal2.adopters === 3, JSON.stringify(cal2))
  const cal3 = ct.classifyAdopterCalibration([{ adopterUserId: "a", adaptedEngagement: 9, baselineEngagements: [1, 2, 3] }, { adopterUserId: "b", adaptedEngagement: 1, baselineEngagements: [5, 6, 7] }, { adopterUserId: "c", adaptedEngagement: 4, baselineEngagements: [1, 3, 9] }])
  check("K4.2 at the minimum (CALIBRATION_MIN_MEASURED_ADOPTERS) a COUNT of adopters above their own median is shown", cal3.status === "calibrated" && cal3.aboveOwnBaseline === 2 && ct.CALIBRATION_MIN_MEASURED_ADOPTERS === ct.ROI_MIN_COMPARABLE_CAMPAIGNS, JSON.stringify(cal3))
  const calThin = ct.classifyAdopterCalibration([{ adopterUserId: "a", adaptedEngagement: 9, baselineEngagements: [1] }, { adopterUserId: "b", adaptedEngagement: 9, baselineEngagements: [1] }, { adopterUserId: "c", adaptedEngagement: 9, baselineEngagements: [1] }])
  check("K4.3 NEGATIVE: adopters without enough of their OWN measured posts are not measured", calThin.status === "not_enough_measured_outcomes" && calThin.measuredAdopters === 0)
  })
  // ═══ K6 — the governed appraiser-packet send ══════════════════════════════════════════════════════════════════════════
  await section("K6", async () => {
  console.log("K6 — the appraiser packet reaches the appraiser only through the governed send")
  const ai = await import("../lib/vendors/appraiser-independence")
  check("K6.0 RED AT BASE: a sender exists (sendAppraiserPacket / appraiserPacketSendVerdict were absent at d2d6468c)", typeof (ai as any).sendAppraiserPacket === "function" && typeof (ai as any).appraiserPacketSendVerdict === "function")
  type SendFacts = Parameters<typeof ai.appraiserPacketSendVerdict>[0]
  const facts = (o: Partial<SendFacts> = {}): SendFacts & { packet: NonNullable<SendFacts["packet"]> } => ({
    packet: { brokerageId: T1, transactionId: "tx1", documentType: "appraiser_packet", ref: "docref://generated-documents/T1/p.pdf", aiSourcedCompCount: 0 },
    actor: { brokerageId: T1, isTransactionAgent: true, impersonating: false }, transactionId: "tx1",
    recipient: { kind: "typed" as const, email: "appraiser@example.com", confirmed: true }, ...o,
  }) as SendFacts & { packet: NonNullable<SendFacts["packet"]> }
  const v = ai.appraiserPacketSendVerdict
  check("K6.1 the transaction's agent, a confirmed appraiser address, a provider-sourced packet → allowed", v(facts()).ok === true)
  check("K6.2 §5: a packet with an AI-web-search comparable is REFUSED", !v(facts({ packet: { ...facts().packet, aiSourcedCompCount: 2 } })).ok)
  check("K6.3 §5: a packet whose comparable sourcing is UNKNOWN is refused (unknown is not zero)", !v(facts({ packet: { ...facts().packet, aiSourcedCompCount: null } })).ok)
  check("K6.4 NEGATIVE: another agent of the same tenant is refused", (v(facts({ actor: { brokerageId: T1, isTransactionAgent: false, impersonating: false } })) as any).reason === "not_transaction_agent")
  check("K6.5 NEGATIVE: under impersonation it is refused (a support grant never sends for the account)", (v(facts({ actor: { brokerageId: T1, isTransactionAgent: true, impersonating: true } })) as any).reason === "impersonating")
  check("K6.6 NEGATIVE: another tenant's packet is refused", (v(facts({ packet: { ...facts().packet, brokerageId: T2 } })) as any).reason === "packet_not_found")
  check("K6.7 NEGATIVE: a bench vendor who is not an appraiser is refused", (v(facts({ recipient: { kind: "vendor", email: "x@example.com", category: "photographer", status: "active" } })) as any).reason === "vendor_not_appraiser")
  check("K6.8 NEGATIVE: an unconfirmed typed address is refused", (v(facts({ recipient: { kind: "typed", email: "x@example.com", confirmed: false } })) as any).reason === "recipient_unconfirmed")
  check("K6.9 NEGATIVE: a non-packet document is refused (the grant purpose stays appraiser_packet only)", (v(facts({ packet: { ...facts().packet, documentType: "market_report" } })) as any).reason === "not_an_appraiser_packet")
  const k6seed = () => ({
    transactions: [{ id: "tx1", brokerage_id: T1, agent_id: "ag-1", property_address: "12 Elm St", deleted_at: null }],
    agents: [{ id: "ag-1", user_id: "u-agent", brokerage_id: T1 }, { id: "ag-2", user_id: "u-other", brokerage_id: T1 }],
    generated_documents: [{ id: "doc1", brokerage_id: T1, transaction_id: "tx1", document_type: "appraiser_packet", blob_url: "docref://generated-documents/T1/p.pdf", metadata: { ai_sourced_comp_count: 0 } }],
    users: [{ id: "u-agent", first_name: "Pat", last_name: "Lee" }], brokerages: [{ id: T1, name: "Elm Realty" }], vendors: [], activities: [],
  })
  const sealer = { seal: (p: string) => `enc:v1:${Buffer.from(p).toString("base64")}`, open: (s: string) => Buffer.from(s.slice(7), "base64").toString(), isSealed: (s: string) => s.startsWith("enc:v1:") }
  const sends: Array<Record<string, any>> = []
  const k6deps = { sealer, origin: "https://app.example.test", now: NOW, dispatch: async (a: Record<string, unknown>) => { sends.push(a); return { success: true, messageId: "m1" } }, ledger: async (_c: unknown, run: () => Promise<any>) => run() }
  const db6 = fakeDb(k6seed())
  const ok6 = await ai.sendAppraiserPacket(db6, { userId: "u-agent", brokerageId: T1, impersonating: false }, { transactionId: "tx1", documentId: "doc1", recipientEmail: "Appraiser@Example.com", confirmRecipient: true, note: "Gate code 1234" }, k6deps)
  const mail = sends[0] ?? {}
  check("K6.10 the agent's send goes through the ONE egress once, humanApproved + transactional, to the named appraiser", ok6.ok === true && sends.length === 1 && mail.humanApproved === true && mail.channelPurpose === "transactional" && mail.to === "appraiser@example.com", JSON.stringify(ok6))
  check("K6.11 the body carries the SHARE-GRANT door link (&g=…), never a docref:// or a storage URL", /\/api\/documents\/open\?ref=[^"\s]+&g=enc/.test(String(mail.text)) && !/docref:\/\//.test(String(mail.html) + String(mail.text)) && !/supabase\.co\/storage/.test(String(mail.html)))
  const expectBody = ai.buildAppraiserPacketEmail({ propertyLabel: "12 Elm St", agentName: "Pat Lee", brokerageName: "Elm Realty", url: String(mail.text).match(/https:\/\/\S+/)?.[0] ?? "", expiresAt: (ok6 as any).expiresAt ?? "", note: "Gate code 1234" })
  check("K6.12 §5: the body IS the deterministic template (no model seam exists on this path)", mail.text === expectBody.text && mail.subject === expectBody.subject)
  check("K6.13 the grant lives the appraiser_packet week (7 days), and the deal's activity feed records the send", Math.abs(Date.parse((ok6 as any).expiresAt) - (NOW.getTime() + 7 * DAY)) < 2000 && db6.tables.activities.length === 1)
  const before6 = sends.length
  const other = await ai.sendAppraiserPacket(fakeDb(k6seed()), { userId: "u-other", brokerageId: T1, impersonating: false }, { transactionId: "tx1", documentId: "doc1", recipientEmail: "appraiser@example.com", confirmRecipient: true }, k6deps)
  check("K6.14 NEGATIVE: another agent of the same tenant sends nothing (0 egress calls)", !other.ok && sends.length === before6)
  const aiSeed = k6seed(); aiSeed.generated_documents[0].metadata = { ai_sourced_comp_count: 3 }
  const aiSend = await ai.sendAppraiserPacket(fakeDb(aiSeed), { userId: "u-agent", brokerageId: T1, impersonating: false }, { transactionId: "tx1", documentId: "doc1", recipientEmail: "appraiser@example.com", confirmRecipient: true }, k6deps)
  check("K6.15 NEGATIVE §5: an AI-sourced packet sends nothing (0 egress calls)", !aiSend.ok && (aiSend as any).reason === "ai_sourced_comps" && sends.length === before6)
  const xt = await ai.sendAppraiserPacket(fakeDb(k6seed()), { userId: "u-agent", brokerageId: T2, impersonating: false }, { transactionId: "tx1", documentId: "doc1", recipientEmail: "appraiser@example.com", confirmRecipient: true }, k6deps)
  check("K6.16 NEGATIVE: the session's tenant pins every read — another tenant sees no transaction", !xt.ok && (xt as any).reason === "transaction_not_found" && sends.length === before6)
  const noKey = await ai.sendAppraiserPacket(fakeDb(k6seed()), { userId: "u-agent", brokerageId: T1, impersonating: false }, { transactionId: "tx1", documentId: "doc1", recipientEmail: "appraiser@example.com", confirmRecipient: true }, { ...k6deps, sealer: { ...sealer, isSealed: () => false } })
  check("K6.17 NEGATIVE: no sealing key → nothing is sent (fails closed, never a fallback link)", !noKey.ok && (noKey as any).reason === "grant_not_minted" && sends.length === before6)
  // the route inventory names no retired function (integrator carry-in from 155B2)
  const routesStale = ai.APPRAISER_REACH_ROUTES.filter((r) => r.file === "app/actions/vendor-marketplace.ts" && /assignVendorToTransaction/.test(r.what))
  check("K6.18 the appraiser route inventory names no retired function (vendor-marketplace assignVendorToTransaction → lib/kernel/vendors.ts)", routesStale.length === 0 && ai.APPRAISER_REACH_ROUTES.some((r) => r.file === "lib/vendors/appraiser-independence.ts" && r.authorship === "deterministic"))
  const actionSrc = src("app/actions/transaction-milestones.ts")
  check("K6.19 the session door takes the tenant from getAgentContext, never a parameter", /export async function sendAppraiserPacketAction\([\s\S]*?getAgentContext\(\)[\s\S]*?ctx\.brokerageId/.test(actionSrc) && !/SendAppraiserPacketParams\s*\{[^}]*brokerageId/.test(actionSrc))

  })
  // ═══ C — one quiz grader ══════════════════════════════════════════════════════════════════════════════════════════════
  await section("C", async () => {
  console.log("C — the onboarding quiz grades through the one grader")
  const ob = await import("../lib/kernel/agent-onboarding")
  const { gradeQuiz } = await import("../lib/academy/quiz")
  const qs = [{ id: "a", correctAnswer: "B" }, { id: "b", correctAnswer: 2 }, { id: "c", correctAnswer: true }, { id: "d", correctAnswer: "x" }, { id: "e", correctAnswer: "y" }]
  const ad = ob.onboardingQuizAsModuleQuiz(qs, { a: "B", b: 2, c: true, d: "x", e: "nope" })
  const g = gradeQuiz(ad.questions, ad.answers, 80)
  check("C.1 4 of 5 by the old `===` rule → 80% → passes at 80 (same verdict the old scorer gave)", g.correct === 4 && g.score === 80 && g.passed === true)
  const loose = ob.onboardingQuizAsModuleQuiz(qs, { a: "B", b: "2", c: "true" })
  const g2 = gradeQuiz(loose.questions, loose.answers, 80)
  check("C.2 NEGATIVE: a loose match ('2' for 2) and a missing answer are wrong — 1 of 5, not passed", g2.correct === 1 && !g2.passed)
  const g0 = gradeQuiz(ob.onboardingQuizAsModuleQuiz([], {}).questions, {}, 0)
  check("C.3 NEGATIVE (stricter): a quiz with no questions never passes, even at a 0 bar", g0.passed === false)
  const obSrc = src("lib/kernel/agent-onboarding.ts")
  check("C.4 the second scorer is gone: no `answers[question.id] === question.correctAnswer` counter in submitQuizAttempt", !/correctCount\+\+/.test(obSrc) && /gradeQuiz\(adapted\.questions, adapted\.answers, passingScore\)/.test(obSrc))
  check("C.5 positive control for C.4: the counter pattern is recognised on a specimen", /correctCount\+\+/.test("if (params.answers[question.id] === question.correctAnswer) { correctCount++ }"))

  })

  console.log(`\nwave154-partials: ${passed} passed, ${failed} failed (SIMULATED — in-memory database, injected seams, no provider or model called)`)
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
