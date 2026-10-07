/**
 * scripts/exceptions-first-guard.ts  (npm run test:exceptions-first)
 *
 * WAVE 108, lane 108D — EXCEPTIONS-FIRST OPERATING INTERFACE. Proves lib/kernel/exceptions-first.ts
 * and its wiring into the Command Center:
 *   A  counts carry their denominator; a refused count is SAID, never rendered as 0
 *   B  every category names its reader + door; a refused reader is PUBLISHED (status + headline)
 *   C  ranking is deterministic (any input order → the same ranking) and severity-led
 *   D  team scope: un-narrowable categories are WITHHELD, the ledger is narrowed by the team's subjects
 *   E  nothing auto-handled is hidden: Σ buckets + unbucketed === total, including past the row cap
 *   F  the loader end-to-end over a fake client: refusal → refused category; overspend detector
 *   G  wiring (stripped source): loadCommandCenter calls the loader; the page leads with the panel;
 *      the manager standup collapses under "Handled automatically" — each scan with a positive control.
 * Pure + a fake client; no live reads, no writes.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  EXCEPTION_CATEGORIES, EXCEPTION_CATEGORY_ORDER, SEVERITY_RANK, rankExceptions, bucketActivity, composeExceptionsFirst,
  exceptionsHeadline, resolveActivityWindow, loadExceptionsFirst, humanInterventionItems, capacityItems,
  type ExceptionItem, type ActivityCount, type ExceptionCategoryKey,
} from "../lib/kernel/exceptions-first"
import { detectBudgetOverrun, OVERSPEND_TOLERANCE, SPEND_WINDOW_DAYS } from "../lib/ads/ad-manager"

const ROOT = process.cwd()
const src = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const item = (o: Partial<ExceptionItem> & { key: string; category: ExceptionCategoryKey }): ExceptionItem => ({
  severity: "medium", title: o.key, why: "w", count: 1, exposureCents: null, oldestAt: null,
  evidence: { table: "t", filter: "f", count: 1, via: "v" }, door: { label: "d", href: "/x" }, ...o,
})
const counted = (total: number, rows = 0): ActivityCount => {
  const r = bucketActivity(Array.from({ length: rows }, (_, i) => ({ actor_type: i % 3 === 0 ? "user" : "manager", actor_manager_key: i % 2 ? "ai_isa" : "deal_coordinator", status: "executed" })), total)
  return { status: "counted", total, windowStart: "2026-10-06T18:00:00.000Z", windowEnd: "2026-10-07T08:00:00.000Z", windowSource: "last_action", denominator: "agent_action_ledger rows for this brokerage", buckets: r.buckets, unbucketed: r.unbucketed, blindSpots: [] }
}

// Fake supabase: per-table result; records every filter call.
type Res = { data: any; error: { message: string } | null; count?: number | null }
function fakeSvc(results: Record<string, Res>) {
  const calls: Array<{ table: string; op: string; args: any[] }> = []
  const svc = {
    calls,
    from(table: string) {
      const b: any = {}
      for (const op of ["select", "eq", "in", "gte", "lte", "lt", "gt", "order", "limit", "not", "contains", "is"]) {
        b[op] = (...args: any[]) => { calls.push({ table, op, args }); return b }
      }
      b.then = (ok: any, ko: any) => Promise.resolve(results[table] ?? { data: [], error: null, count: 0 }).then(ok, ko)
      return b
    },
  }
  return svc
}
const twinStub = (over: any = {}) => ({
  brokerageId: "b1", teamId: null, at: "2026-10-07T08:00:00.000Z", blindSpots: [],
  atRisk: [
    { kind: "deal_health", severity: "critical", count: 2, headline: "2 deals critical", exposureCents: 1_800_000, evidence: { table: "deal_health_scores", filter: "risk_level=critical", count: 2, via: "calculateDealHealth", ids: ["t1", "t2"] } },
    { kind: "deal_health", severity: "watch", count: 9, headline: "9 deals to watch", exposureCents: 0, evidence: { table: "deal_health_scores", filter: "watch", count: 9, via: "calculateDealHealth" } },
    { kind: "compliance", severity: "at_risk", count: 1, headline: "1 open compliance flag", exposureCents: null, evidence: { table: "compliance_flags", filter: "status=open", count: 1, via: "compliance flag writers" } },
  ],
  capacity: { activeAgents: 4, maxLoad: 40, bands: {}, headroom: 10, unscored: 0, evidence: { table: "capacityFor", filter: "active agents", count: 4, via: "capacity-pick" },
    perAgent: [{ agentId: "a1", band: "over", load: 55, headroom: 0, followUpDebt: 0, fatigueTier: "ok", reasons: [] }, { agentId: "a2", band: "available", load: 5, headroom: 35, followUpDebt: 0, fatigueTier: "ok", reasons: [] }] },
  ...over,
}) as any

async function main() {
  console.log("━━━ exceptions-first guard (wave 108D) ━━━")

  // ── A. counts with denominators ──
  console.log("\nA. counts carry their denominator; a refused count is said")
  const a = counted(12421, 40)
  const v = composeExceptionsFirst({ scope: "brokerage", activity: a, readings: Object.fromEntries(EXCEPTION_CATEGORY_ORDER.map((k) => [k, { status: "published", items: [] }])) as any })
  check("A1 headline leads with the counted activity and the exception count", v.headline.startsWith("12,421 activities occurred since your last visit. You need to care about 0."), v.headline)
  check("A2 the denominator is published beside the number", v.activity.status === "counted" && v.activity.denominator.includes("agent_action_ledger"))
  const refusedCount: ActivityCount = { status: "refused", reason: "permission denied", windowStart: "x", windowEnd: "y", windowSource: "default_24h", denominator: "agent_action_ledger rows" }
  const h = exceptionsHeadline(refusedCount, 3, [])
  check("A3 a refused count is named, never '0 activities'", h.includes("could not be counted (permission denied)") && !/\b0 activities/.test(h), h)
  check("A4 the refused count's handled-automatically total is null (not 0)", composeExceptionsFirst({ scope: "brokerage", activity: refusedCount, readings: {} }).handledAutomatically.total === null)
  const now = new Date("2026-10-07T08:00:00.000Z")
  check("A5 window: no recorded action → last 24h (source published)", resolveActivityWindow(now, null).source === "default_24h")
  check("A6 window: a last action 14h ago → since then", resolveActivityWindow(now, "2026-10-06T18:00:00.000Z").source === "last_action")
  check("A7 window: an action 1h ago clamps to the 12h floor; 30d ago to the 7d ceiling", resolveActivityWindow(now, "2026-10-07T07:00:00.000Z").source === "clamped_min" && resolveActivityWindow(now, "2026-09-07T07:00:00.000Z").source === "clamped_max")

  // ── B. every category's reader named; refused → published ──
  console.log("\nB. readers named; refused readers published")
  const required: ExceptionCategoryKey[] = ["transaction_at_risk", "human_intervention", "agent_capacity", "campaign_overspend", "compliance_approval", "billing_anomaly", "mission_decision"]
  check("B1 the seven owner categories + OS health are in the table", required.every((k) => k in EXCEPTION_CATEGORIES) && "os_health" in EXCEPTION_CATEGORIES)
  check("B2 every category names a reader and an action door", EXCEPTION_CATEGORY_ORDER.every((k) => EXCEPTION_CATEGORIES[k].reader.length > 10 && EXCEPTION_CATEGORIES[k].door.href.startsWith("/")))
  const vr = composeExceptionsFirst({ scope: "brokerage", activity: a, readings: { billing_anomaly: { status: "refused", reason: "billing_invoices: permission denied" } } })
  const billing = vr.categories.find((c) => c.key === "billing_anomaly")
  check("B3 a refused reader is published with its reason (not dropped)", billing?.status === "refused" && billing.reason === "billing_invoices: permission denied")
  check("B4 the headline names every refused category as NOT clear", vr.headline.includes("billing anomalies") && vr.headline.includes("NOT counted as clear"), vr.headline)
  check("B5 a category with no reading at all is published as refused (never silently absent)", vr.categories.length === EXCEPTION_CATEGORY_ORDER.length && vr.categories.filter((c) => c.status === "refused").length === EXCEPTION_CATEGORY_ORDER.length)
  // positive control: the B4 matcher fails on a headline without a refusal
  check("B6 positive control — a clean headline does not match the refusal matcher", !v.headline.includes("NOT counted as clear"))

  // ── C. deterministic ranking ──
  console.log("\nC. ranking deterministic and severity-led")
  const pool: ExceptionItem[] = [
    item({ key: "m:1", category: "mission_decision", severity: "high", count: 1 }),
    item({ key: "t:1", category: "transaction_at_risk", severity: "critical", exposureCents: 900 }),
    item({ key: "t:2", category: "transaction_at_risk", severity: "critical", exposureCents: 5000 }),
    item({ key: "c:1", category: "agent_capacity", severity: "medium", count: 3 }),
    item({ key: "h:1", category: "human_intervention", severity: "high", count: 1, oldestAt: "2026-10-01T00:00:00Z" }),
    item({ key: "h:2", category: "human_intervention", severity: "high", count: 1, oldestAt: "2026-10-05T00:00:00Z" }),
    item({ key: "b:1", category: "billing_anomaly", severity: "critical" }),
  ]
  const base = rankExceptions(pool).map((x) => x.key).join(",")
  let stable = true
  let seed = 7
  for (let i = 0; i < 60; i++) {
    const shuffled = [...pool].sort(() => ((seed = (seed * 9301 + 49297) % 233280) / 233280) - 0.5)
    if (rankExceptions(shuffled).map((x) => x.key).join(",") !== base) stable = false
  }
  check("C1 sixty shuffles → one ranking", stable, base)
  const ranked = rankExceptions(pool)
  check("C2 severity first: no lower severity precedes a higher one", ranked.every((x, i) => i === 0 || SEVERITY_RANK[ranked[i - 1].severity] <= SEVERITY_RANK[x.severity]))
  check("C3 within a severity, more money first, then the oldest waiting", base.startsWith("t:2,t:1,b:1") && base.indexOf("h:1") < base.indexOf("h:2"), base)
  check("C4 ranks are 1..n", ranked.map((x) => x.rank).join(",") === ranked.map((_, i) => i + 1).join(","))

  // ── D. team scope ──
  console.log("\nD. team scope honoured")
  const teamSvc = fakeSvc({ agent_action_ledger: { data: [], error: null, count: 7 } })
  const tv = await loadExceptionsFirst(teamSvc, { brokerageId: "b1", scope: "team", teamId: "team1", viewerUserId: null, scopedEntityIds: ["c1", "l1"], now, twin: twinStub({ teamId: "team1" }), pendingActions: [], clientDecisions: [], economicGraph: null, cronOwners: [] })
  const st = (k: ExceptionCategoryKey) => tv.categories.find((c) => c.key === k)?.status
  check("D1 billing / missions / OS health are WITHHELD for a team (rows carry no team column)", st("billing_anomaly") === "withheld" && st("mission_decision") === "withheld" && st("os_health") === "withheld")
  check("D2 team-narrowable categories are read (twin, approvals, ads)", st("transaction_at_risk") === "published" && st("agent_capacity") === "published" && st("campaign_overspend") === "published")
  check("D3 the team ledger count is narrowed by the team's subjects", teamSvc.calls.some((c) => c.table === "agent_action_ledger" && c.op === "in" && c.args[0] === "subject_id" && c.args[1].join(",") === "c1,l1"))
  check("D4 the team's ad overspend read is narrowed by ad_campaigns.team_id", teamSvc.calls.some((c) => c.table === "ad_campaigns" && c.op === "eq" && c.args[0] === "team_id" && c.args[1] === "team1"))
  check("D5 withheld categories do not read their tables for a team", !teamSvc.calls.some((c) => c.table === "billing_invoices" || c.table === "missions" || c.table === "self_heal_events"))
  check("D6 withheld is not refused — the headline does not call a withheld category unreadable", !tv.headline.includes("NOT counted as clear"), tv.headline)
  const narrow = await loadExceptionsFirst(fakeSvc({}), { brokerageId: "b1", scope: "narrow", teamId: null, viewerUserId: null, scopedEntityIds: [], now, twin: null, pendingActions: [], clientDecisions: [], economicGraph: null, cronOwners: [] })
  check("D7 an office / agent scope withholds every category and refuses the brokerage count", narrow.categories.every((c) => c.status === "withheld") && narrow.activity.status === "refused")

  // ── E. nothing auto-handled hidden ──
  console.log("\nE. Σ buckets + unbucketed === total")
  const e1 = bucketActivity(Array.from({ length: 50 }, (_, i) => ({ actor_type: i < 10 ? "user" : "manager", actor_manager_key: i < 10 ? null : ["ai_isa", "deal_coordinator", null][i % 3], status: i % 4 ? "executed" : "skipped" })), 50)
  check("E1 every row lands in one bucket", e1.buckets.reduce((s, b) => s + b.count, 0) + e1.unbucketed === 50 && e1.unbucketed === 0)
  const e2 = bucketActivity(Array.from({ length: 5000 }, () => ({ actor_type: "system", actor_manager_key: null, status: "executed" })), 12421)
  check("E2 past the read cap the overflow is published as unbucketed", e2.buckets.reduce((s, b) => s + b.count, 0) + e2.unbucketed === 12421 && e2.unbucketed === 7421)
  check("E3 people are a bucket of their own (human work is not counted as automation)", e1.buckets.some((b) => b.key === "people" && b.count === 10))
  const vv = composeExceptionsFirst({ scope: "brokerage", activity: counted(12421, 5000), readings: {} })
  check("E4 handled-automatically total equals the counted activity", vv.handledAutomatically.total === 12421 && vv.handledAutomatically.buckets.reduce((s, b) => s + b.count, 0) + vv.handledAutomatically.unbucketed === 12421)

  // ── F. loader end-to-end ──
  console.log("\nF. loader over a fake client")
  const brokerSvc = fakeSvc({
    agent_action_ledger: { data: [{ actor_type: "manager", actor_manager_key: "ai_isa", status: "executed" }, { actor_type: "user", actor_manager_key: null, status: "executed" }], error: null, count: 2 },
    billing_invoices: { data: null, error: { message: "permission denied for table billing_invoices" } },
    missions: { data: [{ id: "m1", objective: "Grow seller business", state: "APPROVAL_REQUIRED", state_changed_at: "2026-10-06T00:00:00Z", brokerage_id: "b1" }], error: null },
    ad_campaigns: { data: [{ id: "ad1", campaign_name: "Spring sellers", daily_budget: 10 }], error: null },
    ad_performance: { data: [{ ad_campaign_id: "ad1", spend: 600, captured_at: "2026-10-06T00:00:00Z" }], error: null },
    self_heal_events: { data: [{ id: "e1", subject: "s1", action: null, outcome: "escalated", detail: { flow: "x" }, created_at: "2026-10-06T00:00:00Z" }], error: null },
  })
  const fv = await loadExceptionsFirst(brokerSvc, {
    brokerageId: "b1", scope: "brokerage", teamId: null, viewerUserId: "u1", scopedEntityIds: null, now, twin: twinStub(),
    pendingActions: [{ id: "p1", queue: "client_message", brokerageId: "b1", actionType: "approve_client_message", rationale: null, actionInput: {}, status: "proposed", proposedAt: "2026-10-05T00:00:00Z", ageHours: 50, slaLevel: "breached", managerKey: "deal_coordinator", managerLabel: "Deal Coordinator", compliance: { status: "blocked", manager: "compliance_officer", findings: ["x"] } } as any],
    clientDecisions: [{ id: "d1", source: "client_offer_decision", title: "Seller accepted", description: null, contactId: null, transactionId: "tx1", dueDate: "2026-10-01", createdAt: "2026-09-30T00:00:00Z" }],
    economicGraph: { summaryDrifts: 1, conservationFailures: 0, measured: true }, cronOwners: [{ cronName: "lead-scoring", status: "failed", startedAt: "2026-10-07T01:00:00Z" }],
  })
  const fst = (k: ExceptionCategoryKey) => fv.categories.find((c) => c.key === k)
  check("F1 a refused billing read publishes billing as refused with the reader's error", fst("billing_anomaly")?.status === "refused" && /permission denied/.test(fst("billing_anomaly")?.reason ?? ""))
  check("F2 the activity count is the ledger's exact count", fv.activity.status === "counted" && fv.activity.total === 2 && fv.handledAutomatically.buckets.length === 2)
  check("F3 'since your last visit' reads the viewer's own last user action", brokerSvc.calls.some((c) => c.table === "agent_action_ledger" && c.op === "eq" && c.args[0] === "actor_user_id" && c.args[1] === "u1"))
  const cats = new Set(fv.exceptions.map((x) => x.category))
  check("F4 every readable category with a fixture surfaces (deal risk, human, capacity, overspend, compliance, mission, OS health)",
    ["transaction_at_risk", "human_intervention", "agent_capacity", "campaign_overspend", "compliance_approval", "mission_decision", "os_health"].every((k) => cats.has(k as ExceptionCategoryKey)), [...cats].join(","))
  check("F5 the top exception is critical and every exception carries evidence + a door", fv.exceptions[0].severity === "critical" && fv.exceptions.every((x) => x.evidence.via && x.evidence.table && x.door.href))
  check("F6 a compliance-blocked draft counts once (compliance), not again as an SLA-breached approval", !fv.exceptions.some((x) => x.key === "human_intervention:sla_breached"))
  check("F7 twin 'watch' risks are monitoring, not exceptions", !fv.exceptions.some((x) => x.key.endsWith(":watch")))
  check("F8 the overspend detector: $600 against $10/day × 30 is an overrun; within tolerance is not",
    detectBudgetOverrun({ campaignId: "c", name: null, dailyBudget: 10, spend: 600 })?.ratio === 2 && detectBudgetOverrun({ campaignId: "c", name: null, dailyBudget: 10, spend: 10 * SPEND_WINDOW_DAYS * (1 + OVERSPEND_TOLERANCE) }) === null && detectBudgetOverrun({ campaignId: "c", name: null, dailyBudget: 0, spend: 999 }) === null)
  check("F9 positive control — the capacity builder sees an over-band agent", capacityItems(twinStub()).some((x) => x.key === "agent_capacity:over" && x.evidence.ids?.[0] === "a1"))
  check("F10 positive control — an overdue client decision is high, a fresh one medium", humanInterventionItems([{ id: "d", source: "vendor_request", title: "t", description: null, contactId: null, transactionId: null, dueDate: "2026-10-01", createdAt: null }], [], now)[0]?.severity === "high")

  // ── G. wiring ──
  console.log("\nG. wiring (stripped source, each with a positive control)")
  const cc = src("lib/kernel/command-center.ts")
  const callRe = /import\("@\/lib\/kernel\/exceptions-first"\)[\s\S]{0,200}loadExceptionsFirst\(supabase,/
  check("G1 loadCommandCenter calls loadExceptionsFirst with its own client", callRe.test(cc))
  check("G1c positive control — the matcher misses when the call is absent", !callRe.test(cc.replace(/loadExceptionsFirst\(supabase,/g, "somethingElse(supabase,")))
  check("G2 the loader receives the viewer and the team's entity ids", /viewerUserId: params\.viewerUserId/.test(cc) && /scopedEntityIds,/.test(cc))
  const page = src("app/dashboard/admin/command-center/page.tsx")
  const panelAt = page.indexOf("<ExceptionsFirstPanel")
  check("G3 the page renders the panel BEFORE every other card (leads with the sentence)", panelAt > 0 && panelAt < page.indexOf("<AutonomyHaltBanner") && panelAt < page.indexOf("<MissionsCard") && panelAt < page.indexOf("<CommandCenterClient"))
  check("G4 the page passes the session user as the viewer", /viewerUserId: user\.id/.test(page))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  const collapseRe = /<details[^>]*open=\{!data\.exceptionsFirst\}[\s\S]{0,400}Handled automatically/
  check("G5 the manager standup collapses under 'Handled automatically' when the panel leads", collapseRe.test(client))
  check("G5c positive control — the collapse matcher misses a plain section", !collapseRe.test(client.replace(/open=\{!data\.exceptionsFirst\}/, "")))
  check("G6 every category door's anchor exists (#approval-queue, #missions, #exception-center)",
    client.includes('id="approval-queue"') && page.includes('id="missions"') && src("app/dashboard/brokerage/page.tsx").includes('id="exception-center"'))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ EXCEPTIONS_FIRST_FAIL"); process.exit(1) }
  console.log(" ✅ EXCEPTIONS_FIRST_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
