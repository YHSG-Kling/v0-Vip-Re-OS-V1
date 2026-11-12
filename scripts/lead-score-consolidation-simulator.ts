#!/usr/bin/env tsx
/**
 * scripts/lead-score-consolidation-simulator.ts (npm run test:lead-score-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE LEAD SCORERS, AND THE BEHAVIOURAL 30% READ COLUMNS THAT DO NOT EXIST.
 *
 * `calculateLeadScore` was defined in three modules:
 *
 *   lib/lead-governance/multi-factor-scorer.ts     the declared authority. PURE,
 *                                                 0-100, five explainable factors.
 *   lib/services/lead-management.service.ts        the orchestrator — already
 *                                                 delegates to the authority for
 *                                                 70% and adds a 30% behavioural
 *                                                 refinement. Legitimate layering.
 *   app/actions/ai-auto-response.ts                a THIRD implementation, marked
 *                                                 @deprecated and still called on
 *                                                 this file's live path.
 *
 * The behavioural refinement read `record.lead_behavioral_data[0]` as a
 * pre-aggregated row. The live table is a pure EVENT LOG (event_type, event_data,
 * occurred_at — verified against the database), so all four columns it wanted were
 * undefined:
 *
 *   email_open_count          20 engagement points, never earnable
 *   site_visit_count          25 engagement points, never earnable
 *   response_rate             responsiveness, always 0
 *   avg_response_time_hours   defaulted to 48h, which falls through every branch
 *
 * responsiveness was therefore EXACTLY 50 for every lead and contact in the system,
 * forever — a factor with zero discriminating power. And on the contacts side the
 * log was never even fetched (only the leads branch fetched it) while a comment
 * claimed it was "fetched separately".
 *
 * The deprecated third scorer was the only one that read the log correctly. Its
 * defects were WHERE it wrote and HOW it normalised:
 *
 *   · `min(100, floor(totalPoints / 10))` put a hot score of 70 at 700 raw points —
 *     ~24 CMA requests or ~28 showing requests from one person.
 *   · It wrote `lead_scores`; the authoritative path wrote `contacts.lead_score` and
 *     never touched lead_scores. getHotLeads — the hot-lead list on the AGENT
 *     DASHBOARD and /leads — queries lead_scores where score >= 70. So that surface
 *     was empty by arithmetic while the real scores sat in a column it never read,
 *     and contact-intelligence showed lead_scores.score beside
 *     contacts.last_scored_at: two numbers, two formulas, one panel.
 *
 * Consolidated per the owner's rule — keep the more advanced, port what the other
 * uniquely had, then remove it: the event weights are ported verbatim into
 * lib/lead-scoring/behavioral-events.ts, the canonical scorer now writes the
 * lead_scores snapshot (keep-both-and-sync, as ruled for the commission ledgers),
 * and the third implementation is gone.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  EVENT_POINTS,
  HIGH_INTENT_EVENTS,
  REPLY_EVENTS,
  ENGAGEMENT_SATURATION,
  RECENCY_SATURATION,
  RECENT_WINDOW_DAYS,
  HOT_WINDOW_DAYS,
  pointsForEvent,
  summarizeBehavioralEvents,
  priorityTier,
  type BehavioralEvent,
} from "../lib/lead-scoring/behavioral-events"
import { recordBehavioralEvent, isScoredEventType } from "../lib/lead-scoring/record-behavioral-event"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
/** Source with comments removed. The phantom-column assertions below must test CODE:
 *  the fix documents each dead column by name, and a raw-text search would trip on
 *  the very explanation that proves the column is no longer read. */
// stripComments already removes TRAILING line comments, so the per-line pass that
// used to follow it is gone. It was not merely redundant: `(^|\s)//.*$` fires on the
// slashes inside any string holding a URL, so it deleted the tail of every line
// carrying one — the analyzer's own blind spot, bolted on to cover the anchored
// regex that could not see a trailing comment in the first place.
const code = (p: string) => stripComments(src(p))

console.log("══════════════════════════════════════════════════")
console.log(" Lead scoring — one scorer, reading the table that actually exists")
console.log("══════════════════════════════════════════════════")

const NOW = new Date("2026-07-29T12:00:00Z")
const ev = (event_type: string, daysAgo: number, event_data?: Record<string, unknown>): BehavioralEvent => ({
  event_type,
  occurred_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  event_data: event_data ?? null,
})

console.log("\n[the event log is read as an event log]")
{
  // The shape assertion that started this: only columns the live table HAS.
  const one = ev("showing_request", 1)
  check("an event carries event_type, occurred_at and event_data — nothing else",
    Object.keys(one).sort().join(",") === "event_data,event_type,occurred_at")

  check("per-type weights are ported verbatim from the deprecated scorer",
    EVENT_POINTS.showing_request === 25 && EVENT_POINTS.cma_request === 30 &&
    EVENT_POINTS.website_visit === 5 && EVENT_POINTS.email_open === 3 &&
    EVENT_POINTS.email_click === 10 && EVENT_POINTS.form_submit === 15 &&
    EVENT_POINTS.property_view === 8 && EVENT_POINTS.property_save === 12 &&
    EVENT_POINTS.call_answered === 20 && EVENT_POINTS.sms_reply === 10 &&
    EVENT_POINTS.document_download === 15)
  check("…all eleven of them", Object.keys(EVENT_POINTS).length === 11)

  check("an unknown event type falls back to an explicit points_awarded",
    pointsForEvent(ev("mystery_event", 1, { points_awarded: 7 })) === 7)
  check("…and scores zero when there is no weight and no explicit award",
    pointsForEvent(ev("mystery_event", 1)) === 0)
  check("…and ignores a non-numeric points_awarded rather than producing NaN",
    pointsForEvent(ev("mystery_event", 1, { points_awarded: "lots" })) === 0)
}

console.log("\n[no signal is a constant any more]")
{
  // THE headline defect: responsiveness could only ever be 50.
  const none = summarizeBehavioralEvents([], NOW)
  check("no events → responsiveness is 50, meaning UNKNOWN, and it says so",
    none.responsiveness === 50 && none.engagement === 0)

  const replied = summarizeBehavioralEvents([ev("sms_reply", 2), ev("call_answered", 3)], NOW)
  check("a contact who replies scores ABOVE neutral — the old code could not",
    replied.responsiveness > 50, String(replied.responsiveness))
  check("…and it saturates rather than running away",
    summarizeBehavioralEvents(Array.from({ length: 50 }, () => ev("sms_reply", 1)), NOW).responsiveness === 100)
  check("reply events are the ones a CONTACT initiates, not ones we send",
    REPLY_EVENTS.has("sms_reply") && REPLY_EVENTS.has("call_answered") &&
    !REPLY_EVENTS.has("email_open") && !REPLY_EVENTS.has("website_visit"))

  // The other never-earnable points: opens and visits.
  const browsing = summarizeBehavioralEvents(
    [ev("email_open", 1), ev("email_open", 2), ev("website_visit", 3), ev("website_visit", 4)], NOW)
  check("email opens and site visits now earn engagement (they earned 0 before)",
    browsing.engagement > 0, String(browsing.engagement))
}

console.log("\n[a hot lead can actually reach hot]")
{
  // The deprecated normalisation: floor(points/10). 70 needed 700 raw points.
  const fourShowings = [ev("showing_request", 1), ev("showing_request", 2), ev("showing_request", 3), ev("showing_request", 4)]
  const oldWay = Math.min(100, Math.floor(fourShowings.reduce((s, e) => s + pointsForEvent(e), 0) / 10))
  check("FOUR showing requests scored 10 under the old /10 normalisation",
    oldWay === 10, `old score ${oldWay}`)

  const now = summarizeBehavioralEvents(fourShowings, NOW)
  check("…and is a strong engagement signal now", now.engagement >= 80, String(now.engagement))
  check("…with intent at maximum, because 4 high-intent actions is not browsing",
    now.intent === 80, String(now.intent))

  // Saturation is a stated threshold, not a magic divisor.
  check("engagement saturates at a documented, reachable point",
    ENGAGEMENT_SATURATION === 120 && RECENCY_SATURATION === 60)
  const saturating = Array.from({ length: 5 }, (_, i) => ev("showing_request", i + 1))
  check("…five showing requests in a month reaches 100 engagement",
    summarizeBehavioralEvents(saturating, NOW).engagement === 100)
  check("intent keeps the ported ×20 multiplier",
    summarizeBehavioralEvents([ev("cma_request", 1)], NOW).intent === 20 &&
    summarizeBehavioralEvents([ev("cma_request", 1), ev("cma_request", 2)], NOW).intent === 40)
  check("high-intent means transacting, not browsing",
    HIGH_INTENT_EVENTS.has("showing_request") && HIGH_INTENT_EVENTS.has("cma_request") &&
    !HIGH_INTENT_EVENTS.has("website_visit") && !HIGH_INTENT_EVENTS.has("email_open"))
}

console.log("\n[recency is real time, not a boolean]")
{
  // The leads branch used `event_type ? 1 : 0` — one event and a thousand identical.
  const oneView = summarizeBehavioralEvents([ev("website_visit", 1)], NOW)
  const thousand = summarizeBehavioralEvents(Array.from({ length: 1000 }, () => ev("showing_request", 1)), NOW)
  check("one page view and a thousand showing requests no longer score the same",
    oneView.engagement !== thousand.engagement, `${oneView.engagement} vs ${thousand.engagement}`)

  const thisWeek = summarizeBehavioralEvents([ev("showing_request", 2), ev("showing_request", 3)], NOW)
  const lastYear = summarizeBehavioralEvents([ev("showing_request", 300), ev("showing_request", 301)], NOW)
  check("activity this week outranks identical activity a year ago",
    thisWeek.recency > lastYear.recency && lastYear.recency === 0)
  check("…and stale activity earns no ENGAGEMENT either (30-day window)",
    lastYear.engagement === 0)
  check("the windows are the documented ones", RECENT_WINDOW_DAYS === 30 && HOT_WINDOW_DAYS === 7)

  // A boundary that decides real money: exactly at the edge.
  check("an event exactly at the 7-day edge still counts as hot-window",
    summarizeBehavioralEvents([ev("showing_request", 7)], NOW).recency > 0)
  check("…and one just past 30 days counts for neither",
    summarizeBehavioralEvents([ev("showing_request", 31)], NOW).engagement === 0)
}

console.log("\n[it never invents engagement it cannot prove]")
{
  const noTs: BehavioralEvent[] = [{ event_type: "showing_request", occurred_at: null }]
  const s = summarizeBehavioralEvents(noTs, NOW)
  check("an event with no timestamp counts in totals but earns NO recency credit",
    s.totalPoints === 25 && s.recency === 0 && s.engagement === 0)
  check("…same for an unparseable timestamp, rather than throwing or guessing now()",
    summarizeBehavioralEvents([{ event_type: "cma_request", occurred_at: "not-a-date" }], NOW).recency === 0)
  check("null/undefined input is an empty summary, not a crash",
    summarizeBehavioralEvents(null, NOW).eventCount === 0 &&
    summarizeBehavioralEvents(undefined, NOW).eventCount === 0)
  check("a malformed row without event_type is skipped",
    summarizeBehavioralEvents([{ event_type: "" } as BehavioralEvent], NOW).totalPoints === 0)
  check("every factor stays inside 0-100 no matter the input",
    [summarizeBehavioralEvents(Array.from({ length: 5000 }, () => ev("cma_request", 0)), NOW)]
      .every((r) => [r.engagement, r.recency, r.intent, r.responsiveness]
        .every((v) => v >= 0 && v <= 100)))
  check("byType explains the score without feeding it",
    summarizeBehavioralEvents([ev("email_open", 1), ev("email_open", 2)], NOW).byType.email_open === 2)
}

console.log("\n[the phantom columns are gone from the scorer]")
{
  const svc = code("lib/services/lead-management.service.ts")
  for (const col of ["email_open_count", "site_visit_count", "response_rate", "avg_response_time_hours"]) {
    check(`the scorer no longer reads the non-existent ${col}`, !new RegExp(`\\.${col}\\b`).test(svc))
  }
  check("the constant-50 responsiveness calculator was DELETED, not patched",
    !/function calculateResponsivenessScore/.test(svc))
  check("…and the deletion is explained where it used to live",
    // Wrap-tolerant: the sentence spans a comment line break.
    /returned exactly 50 for every[\s\S]{0,20}?lead and contact/.test(
      src("lib/services/lead-management.service.ts")))
  check("responsiveness now comes from the event summary",
    /responsivenessScore = behavior\.responsiveness/.test(svc))
  check("the event log is folded ONCE, by the module that understands it",
    /summarizeBehavioralEvents\(record\.lead_behavioral_data/.test(svc))
  check("the CONTACTS branch now actually fetches the log it always claimed to",
    (svc.match(/from\("lead_behavioral_data"\)/g) ?? []).length >= 2)
  check("…selecting only columns the live table has",
    !/from\("lead_behavioral_data"\)\s*\n\s*\.select\("\*"\)/.test(svc))
  check("the 70/30 baseline-to-behaviour split is unchanged — layering was never the bug",
    /baselineScore \* 0\.7 \+ behavioralScore \* 0\.3/.test(svc))
}

console.log("\n[one score reaches the surfaces that show it]")
{
  const svc = src("lib/services/lead-management.service.ts")
  check("the canonical scorer writes the contact-side lead_scores snapshot",
    /from\("lead_scores"\)/.test(svc))
  check("…stamped with the OWNER ON THE RECORD, never a caller-supplied agent",
    /agent_id: record\.agent_id/.test(svc))
  check("…and skips rather than failing when a contact has no owner (NOT NULL column)",
    /if \(record\.agent_id\)/.test(svc))
  check("…carrying the priority tier the UI's hot/warm/cold language needs",
    /priorityTier\(totalScore/.test(svc))
  check("…and an ai_confidence that reflects whether there was behaviour to infer from",
    /behavior\.eventCount > 0 \? 0\.9 : 0\.7/.test(svc))
  check("agentId is no longer a REQUIRED param the implementation ignores",
    /agentId\?: string/.test(svc))

  const auto = src("app/actions/ai-auto-response.ts")
  check("the third implementation is gone", !/export async function calculateLeadScore/.test(auto))
  check("…and nothing in that file still upserts a score of its own",
    !/from\("lead_scores"\)\s*\.upsert/.test(auto))
  check("its live caller routes through the canonical scorer",
    /lib\/services\/lead-management\.service/.test(auto))
  check("…without letting a scoring failure fail behaviour tracking",
    /scoring after behavioural event failed/.test(auto))
  check("the hot-lead threshold is stated once so list and tier agree",
    /const HOT_LEAD_SCORE = 70/.test(auto))
  check("the snapshot UPSERTS on contact_id — lead_scores is UNIQUE(contact_id)",
    /onConflict: "contact_id"/.test(src("lib/services/lead-management.service.ts")))
  check("…and says why an unqualified upsert would have failed the same way",
    /default\s*\n?\s*\/\/ conflict target is the primary key/.test(
      src("lib/services/lead-management.service.ts")))
  check("getHotLeads ranks by score with no dedupe, because one row per contact",
    /\.order\("score", \{ ascending: false \}\)/.test(auto) && !/seen\.has\(key\)/.test(auto))
  check("getLeadScore uses maybeSingle — never-scored is a state, not an error",
    /\.eq\("contact_id", contactId\)\s*\n\s*\.maybeSingle\(\)/.test(auto))
  check("…and its fallback reads contacts.lead_score, the canonical column",
    /lead_score\.gte\.\$\{HOT_LEAD_SCORE\}/.test(auto) &&
    !/intent_score\.gte\.70/.test(auto))
  check("getLeadScore no longer uses .single() on what is now a history",
    !/from\("lead_scores"\)\s*\n\s*\.select\("\*"\)\s*\n\s*\.eq\("contact_id", contactId\)\s*\n\s*\.single\(\)/.test(auto))
}

console.log("\n[the hot/warm/cold tier is ported, over an authoritative score]")
{
  check("hot at 70+, or on strong intent alone", priorityTier(70, 0, 0) === "hot" && priorityTier(10, 60, 0) === "hot")
  check("warm at 40+, or on strong engagement alone", priorityTier(40, 0, 0) === "warm" && priorityTier(10, 0, 50) === "warm")
  check("cold otherwise", priorityTier(10, 10, 10) === "cold")
  check("the tier's hot threshold matches the hot-LIST threshold",
    priorityTier(70, 0, 0) === "hot" && /const HOT_LEAD_SCORE = 70/.test(src("app/actions/ai-auto-response.ts")))
}

console.log("\n[there is exactly ONE calculateLeadScore implementation left]")
{
  // The authority + the orchestrator that delegates to it. Not a third.
  const impls = [
    "lib/lead-governance/multi-factor-scorer.ts",
    "lib/services/lead-management.service.ts",
    "app/actions/ai-auto-response.ts",
  ].filter((f) => /export (async )?function calculateLeadScore/.test(src(f)))
  check("only the authority and its orchestrator define it", impls.length === 2, impls.join(", "))
  check("…and the orchestrator DELEGATES to the authority rather than competing",
    /multi-factor-scorer/.test(src("lib/services/lead-management.service.ts")))
  check("package.json wires this proof", /test:lead-score-consolidation/.test(src("package.json")))
}

console.log("\n[the recorder — the event source the behavioural 30% never had]")
{
  // ONE writer. Before this, trackBehavioralEvent (agent-session-gated) was the
  // only insert into lead_behavioral_data, so portal contacts and provider
  // webhooks — the people who actually generate behaviour — could write nothing.
  const recorder = code("lib/lead-scoring/record-behavioral-event.ts")
  check("the recorder exists in lib/lead-scoring", recorder.length > 0)
  check("…and is the ONE module that inserts into lead_behavioral_data",
    /from\("lead_behavioral_data"\)\.insert|from\("lead_behavioral_data"\)\s*\n?\s*\.insert/.test(recorder))

  // Every OTHER writer is gone: the wrapper delegates instead of inserting.
  const auto = code("app/actions/ai-auto-response.ts")
  check("the legacy action no longer writes the table directly",
    !/from\("lead_behavioral_data"\)/.test(auto))
  check("…it DELEGATES to the lib recorder", /record-behavioral-event/.test(auto))
  check("…and keeps its agent-session gate (auth user + agent context)",
    /getUser\(\)/.test(auto) && /getAgentContext\(\)/.test(auto))

  // The recorder writes ONLY columns the live table has (measured schema).
  const LIVE_COLUMNS = new Set([
    "id", "lead_id", "event_type", "event_data", "page_url", "referrer",
    "device_type", "session_id", "ip_address", "user_agent", "occurred_at",
    "created_at", "brokerage_id",
  ])
  const insertBlock = recorder.match(/\.insert\(\{([\s\S]*?)\}\)/)?.[1] ?? ""
  const writtenCols = [...insertBlock.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1])
  check("every column the recorder writes exists on the live table",
    writtenCols.length > 0 && writtenCols.every((c) => LIVE_COLUMNS.has(c)),
    writtenCols.filter((c) => !LIVE_COLUMNS.has(c)).join(","))
  check("…including the two the scorer's query needs (lead_id, occurred_at)",
    writtenCols.includes("lead_id") && writtenCols.includes("occurred_at") &&
    writtenCols.includes("event_type") && writtenCols.includes("brokerage_id"))

  // SHAPE PARITY: a row as the recorder writes it, read back as the scorer reads
  // it (event_type, event_data, occurred_at), earns points in the summariser.
  for (const t of ["property_view", "property_save", "email_open", "email_click", "sms_reply"]) {
    check(`call-site event '${t}' is in the scored vocabulary and earns points`,
      isScoredEventType(t) && summarizeBehavioralEvents([ev(t, 1)], NOW).totalPoints === EVENT_POINTS[t])
  }

  // The four real behavioural moments are wired.
  const idx = code("app/actions/idx-search.ts")
  check("trackPropertyView records property_view through the recorder",
    /recordBehavioralEvent/.test(idx) && /eventType: "property_view"/.test(idx))
  check("saveProperty records property_save through the recorder",
    /eventType: "property_save"/.test(idx))
  const sg = code("app/api/webhooks/sendgrid-events/route.ts")
  check("the SendGrid webhook records email_open / email_click",
    /recordBehavioralEvent/.test(sg) && /"email_open" : "email_click"/.test(sg))
  const inboundRoute = code("app/api/providers/inbound/route.ts")
  check("the inbound SMS router records sms_reply",
    /recordBehavioralEvent/.test(inboundRoute) && /eventType: "sms_reply"/.test(inboundRoute))

  // PORTAL CALLERS NEVER PASS IDENTITY FROM THE BODY: tenant comes from the
  // gate (requireContactAccess) or the provider-resolved match, never a
  // caller-supplied brokerageId.
  check("trackPropertyView + saveProperty resolve tenant via requireContactAccess",
    (idx.match(/requireContactAccess\(/g) ?? []).length >= 2 &&
    (idx.match(/brokerageId: access\.brokerageId/g) ?? []).length >= 2)
  check("…and no idx-search recorder call takes brokerageId from the body",
    !/brokerageId: data\.propertyData\.brokerageId/.test(idx.split("recordBehavioralEvent")[1] ?? ""))
  check("the SendGrid site stamps the tenant the provider correlation proved",
    /brokerageId: trackContact\.brokerage_id/.test(sg))
  check("the inbound router stamps the tenant its signature-verified ingress resolved",
    /brokerageId: inbound\.brokerageId/.test(inboundRoute))

  // NEGATIVE CONTROLS — run the real function.
  check("recorder refuses a call with no tenant (fails closed, reports why)",
    await recordBehavioralEvent({ brokerageId: "", contactId: "c-1", eventType: "sms_reply" })
      .then((r) => r.recorded === false && !!r.reason))
  check("…and a call with no contact",
    await recordBehavioralEvent({ brokerageId: "b-1", contactId: "", eventType: "sms_reply" })
      .then((r) => r.recorded === false))
  check("…and a call with no event type",
    await recordBehavioralEvent({ brokerageId: "b-1", contactId: "c-1", eventType: "" })
      .then((r) => r.recorded === false))
  check("a refused write is DESTRUCTURED and reported, never swallowed",
    /const \{ error \} = await svc/.test(recorder) && /NOT recorded/.test(src("lib/lead-scoring/record-behavioral-event.ts")))
  check("the recorder never throws at a call site — refusals return { recorded: false }",
    /recorded: false/.test(recorder) && !/throw /.test(recorder))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ LEAD_SCORE_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_SCORE_CONSOLIDATION_PASS — one scorer, real columns, a reachable hot")
