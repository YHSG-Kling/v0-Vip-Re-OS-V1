#!/usr/bin/env tsx
/**
 * scripts/meeting-followthrough-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Round 40 — MEETING-TO-ACTION LOOP + PARKED-LEAD RETENTION POSTURE.
 *
 * Layer 1 — pure intent → proposal mapping (lib/ai-isa/meeting-followthrough):
 *           deriveMeetingIntents over a REAL transcript fixture — sell-first /
 *           financing / stated-timeline / objection each derived with the
 *           VERBATIM transcript line carried as evidence; a summary-hinted
 *           intent with NO transcript evidence derives nothing (grounding gate);
 *           at most one intent per kind.
 *
 * Layer 2 — stated-horizon math: "in six months" / "within 2 weeks" /
 *           "3 months from now" / "next month" / "next spring" (deterministic
 *           given now) resolve to days; minutes/hours are never horizons;
 *           clamped to [1, 730].
 *
 * Layer 3 — the consumer end-to-end on a mock client: one analyzed meeting →
 *           gated proposals in agent_client_messages (status 'proposed', the
 *           rationale carrying the [MEETING_FOLLOWTHROUGH] [callId] [kind] tag
 *           + the quote) + the timeline follow-up on contacts.next_followup_at;
 *           a SECOND run proposes/schedules NOTHING (dedupe per meeting).
 *
 * Layer 4 — no-direct-send lock: the consumer (and the retention module) never
 *           reference dispatchEmail / dispatchSms / dispatchDirectMail /
 *           providers/dispatch; BOTH trigger points are wired (zoom-transcripts
 *           post-analysis hook + the hourly voice sweep pickup — one consumer,
 *           two sources).
 *
 * Layer 5 — parked-lead retention tier math (lib/lead-pipeline/parked-retention):
 *           fresh/aging/stale boundaries by created_at, unprovable age = fresh
 *           (never purged on a guess), purged rows counted in NO tier.
 *
 * Layer 6 — purge preview honesty + execution: the preview's zip breakdown
 *           tallies EXACTLY to its count; execution nulls exactly the declared
 *           PII columns, stamps the purged_at marker in enrichment_profile,
 *           NEVER deletes a row, and reports moreRemaining honestly.
 *
 * Layer 7 — superadmin gate + audit locks: the archival action requires the
 *           superadmin gate before executing and ledgers to superadmin_audit_log;
 *           the coverage board mounts the posture + the form action.
 *
 * Run:  npx tsx scripts/meeting-followthrough-simulator.ts
 * npm:  test:meeting-followthrough
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  deriveMeetingIntents, parseStatedHorizon, findEvidenceLine, followthroughTag,
  runMeetingFollowthroughForCall,
  MEETING_FOLLOWTHROUGH_TAG, HORIZON_MAX_DAYS, SELL_FIRST_RE, FINANCING_RE,
} from "../lib/ai-isa/meeting-followthrough"
import {
  parkedLeadTier, summarizeParkedRetention, composePurgePreview, isPurgedParkedLead,
  executeStaleParkedPurge,
  PARKED_FRESH_MAX_DAYS, PARKED_AGING_MAX_DAYS, PARKED_PII_COLUMNS, PURGED_MARKER_KEY,
  PARKED_RETENTION_STATEMENT,
  type ParkedLeadRow,
} from "../lib/lead-pipeline/parked-retention"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · pure intent → proposal mapping, verbatim evidence carried]")

const NOW = new Date("2026-07-20T12:00:00Z")
const TRANSCRIPT = [
  "Agent: Thanks for hopping on the call today, both of you.",
  "Caller: Of course. So the big thing is we need to sell our house in Mocksley before we can buy anything.",
  "Caller: And honestly we were wondering about getting pre-approved — what does that even take?",
  "Agent: Great question, we can walk through it.",
  "Caller: We're not in a rush though. Realistically we'd move in six months, after the school year.",
  "Caller: My worry is the market feels overpriced right now.",
].join("\n")

const ANALYSIS = {
  summary: "Couple wants to buy but must sell their current home first; asked about pre-approval; six-month timeline; concerned prices are high.",
  intentPrimary: "sell current home then buy",
  objections: ["market feels overpriced"],
  keyTopics: ["sell first", "pre-approval", "timeline"],
}

const intents = deriveMeetingIntents(TRANSCRIPT, ANALYSIS, NOW)
const byKind = new Map(intents.map((i) => [i.kind, i] as const))
check("all four intent kinds derived from one real transcript", intents.length === 4 && byKind.has("sell_first") && byKind.has("financing_prequal") && byKind.has("timeline_followup") && byKind.has("objection_coaching"), JSON.stringify(intents.map((i) => i.kind)))
check("sell_first evidence is the verbatim transcript line", (byKind.get("sell_first")?.evidence ?? "").includes("we need to sell our house in Mocksley"))
check("financing evidence is the verbatim transcript line", (byKind.get("financing_prequal")?.evidence ?? "").includes("wondering about getting pre-approved"))
check("every evidence string appears verbatim in the transcript (or the extractor objections)", intents.every((i) => TRANSCRIPT.includes(i.evidence.replace(/…$/, "")) || ANALYSIS.objections.some((o) => i.evidence.includes(o))))
check("timeline resolved to ~6 months at the stated horizon", (byKind.get("timeline_followup")?.horizonDays ?? 0) === 180, String(byKind.get("timeline_followup")?.horizonDays))
check("objection coaching anchored to the transcript's own line", (byKind.get("objection_coaching")?.evidence ?? "").toLowerCase().includes("overpriced"))

// The grounding gate: the ANALYSIS hints sell/financing, but the transcript has no evidence.
const ungrounded = deriveMeetingIntents(
  "Agent: Hello!\nCaller: Just calling to say the keys worked, thanks again.",
  ANALYSIS_no_objections(),
  NOW,
)
function ANALYSIS_no_objections() { return { ...ANALYSIS, objections: [] } }
check("summary-hinted intents WITHOUT transcript evidence derive NOTHING (grounding gate)", ungrounded.length === 0, JSON.stringify(ungrounded))

const dupTranscript = "Caller: We need to sell our house first.\nCaller: Again — we have to sell before buying, need to sell it."
const dupIntents = deriveMeetingIntents(dupTranscript, ANALYSIS_no_objections(), NOW)
check("at most ONE intent per kind (no per-line stacking)", dupIntents.filter((i) => i.kind === "sell_first").length === 1)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · stated-horizon math]")

const h = (t: string) => parseStatedHorizon(t, NOW)
check('"in six months" → 180d', h("we'd move in six months")?.days === 180)
check('"within 2 weeks" → 14d', h("hoping to decide within 2 weeks")?.days === 14)
check('"3 months from now" → 90d', h("probably 3 months from now")?.days === 90)
check('"next month" → 30d', h("let's talk next month")?.days === 30)
const spring = h("we want to list next spring")
check('"next spring" → days until the next Mar 1 (deterministic)', spring != null && spring.days === Math.round((Date.UTC(2027, 2, 1) - NOW.getTime()) / 86_400_000), String(spring?.days))
check("minutes/hours are never horizons", h("call me back in 30 minutes") === null && h("in two hours") === null)
check("no stated timeline → null (nothing invented)", h("we love the kitchen") === null)
check(`horizon clamped to ${HORIZON_MAX_DAYS}d`, (h("in twelve years")?.days ?? 0) <= HORIZON_MAX_DAYS)
check("findEvidenceLine returns null when nothing matches", findEvidenceLine("Agent: hi", SELL_FIRST_RE) === null && findEvidenceLine("Agent: hi", FINANCING_RE) === null)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · consumer end-to-end on a mock client — gated proposals + dedupe]")

interface MockState {
  clientMessages: Array<Record<string, any>>
  contactFollowup: { at: string | null; reason: string | null }
  notifications: number
}

function makeMockSvc(state: MockState) {
  const CALL = { id: "call-1", brokerage_id: "brk-1", contact_id: "ct-1", agent_id: "ag-1", transcription: TRANSCRIPT }
  const ANALYSIS_ROW = { id: "an-1", summary: ANALYSIS.summary, intent_primary: ANALYSIS.intentPrimary, objections: ANALYSIS.objections, key_topics: ANALYSIS.keyTopics, analyzed_by: "zoom_transcript" }
  function chain(table: string): any {
    const filters: Array<{ op: string; col?: string; val?: any }> = []
    let op: "select" | "insert" | "update" = "select"
    let payload: any = null
    const resolve = () => {
      if (table === "voice_calls") return { data: CALL, error: null }
      if (table === "call_analyses") return { data: ANALYSIS_ROW, error: null }
      if (table === "contacts" && op === "select") {
        return { data: { first_name: "Jordan", last_name: "Reyes", next_followup_at: state.contactFollowup.at, agent_id: "ag-1" }, error: null }
      }
      if (table === "contacts" && op === "update") {
        state.contactFollowup = { at: payload.next_followup_at ?? state.contactFollowup.at, reason: payload.next_followup_reason ?? null }
        return { data: null, error: null }
      }
      if (table === "agent_client_messages" && op === "select") {
        const ilike = filters.find((f) => f.op === "ilike")
        const prefix = ilike ? String(ilike.val).replace(/%$/, "") : ""
        const hit = state.clientMessages.find((m) => (m.rationale ?? "").startsWith(prefix))
        return { data: hit ? { id: hit.id } : null, error: null }
      }
      if (table === "agent_client_messages" && op === "insert") {
        const row = { id: `acm-${state.clientMessages.length + 1}`, ...payload }
        state.clientMessages.push(row)
        return { data: { id: row.id }, error: null }
      }
      if (table === "notifications" && op === "insert") { state.notifications += 1; return { data: null, error: null } }
      return { data: null, error: null }
    }
    const proxy: any = new Proxy(() => {}, {
      get(_t, prop: string) {
        if (prop === "then") {
          const r = resolve()
          return (res: any) => res(r)
        }
        return (...args: any[]) => {
          if (prop === "insert" || prop === "update") { op = prop; payload = args[0] }
          else if (prop === "select" && op === "select") filters.push({ op: "select", val: args[0] })
          else filters.push({ op: prop, col: args[0], val: args[1] })
          return proxy
        }
      },
    })
    return proxy
  }
  return { from: (table: string) => chain(table) }
}

const state: MockState = { clientMessages: [], contactFollowup: { at: null, reason: null }, notifications: 0 }
const svc = makeMockSvc(state)

const run1 = await runMeetingFollowthroughForCall(svc as any, "call-1")
check("run 1: derived 4, proposed 3 gated messages, scheduled 1 follow-up", run1.ok && run1.derived === 4 && run1.proposed === 3 && run1.scheduled === 1, JSON.stringify(run1))
check("every proposal landed status='proposed' (the gate — a human approves)", state.clientMessages.length === 3 && state.clientMessages.every((m) => m.status === "proposed"))
check("every rationale starts with the per-(meeting,kind) dedupe tag", state.clientMessages.every((m) => (m.rationale ?? "").startsWith(`${MEETING_FOLLOWTHROUGH_TAG} [call-1] [`)))
check("every consumer-facing rationale carries the verbatim quote", state.clientMessages.every((m) => /"[^"]{10,}"/.test(m.rationale ?? "")))
check("sell_first proposal is the listing-side conversation to the CLIENT (audience seller, gated)", state.clientMessages.some((m) => (m.rationale ?? "").includes("[sell_first]") && m.audience === "seller" && m.recipient_contact_id === "ct-1"))
check("financing proposal is buyer pre-qual education (gated)", state.clientMessages.some((m) => (m.rationale ?? "").includes("[financing_prequal]") && m.audience === "buyer"))
check("objection lands as a coaching note to the AGENT (audience agent, no client recipient)", state.clientMessages.some((m) => (m.rationale ?? "").includes("[objection_coaching]") && m.audience === "agent" && !m.recipient_contact_id))
check("timeline follow-up scheduled ~180d out on the contact's canonical columns", state.contactFollowup.at != null && Math.round((new Date(state.contactFollowup.at!).getTime() - Date.now()) / 86_400_000) === 180 && (state.contactFollowup.reason ?? "").includes(MEETING_FOLLOWTHROUGH_TAG))

const run2 = await runMeetingFollowthroughForCall(svc as any, "call-1")
check("run 2 (redelivery): NOTHING new — deduped per meeting", run2.ok && run2.proposed === 0 && run2.scheduled === 0 && state.clientMessages.length === 3, JSON.stringify(run2))
check("dedupe tag helper matches the stored prefix format", followthroughTag("call-1", "sell_first") === `${MEETING_FOLLOWTHROUGH_TAG} [call-1] [sell_first]`)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · no-direct-send lock + both trigger points wired]")

const consumerSrc = src("lib/ai-isa/meeting-followthrough.ts")
const retentionSrc = src("lib/lead-pipeline/parked-retention.ts")
for (const banned of ["dispatchEmail", "dispatchSms", "dispatchDirectMail", "providers/dispatch"]) {
  check(`consumer never references ${banned}`, !consumerSrc.includes(banned))
  check(`retention module never references ${banned}`, !retentionSrc.includes(banned))
}
check("consumer proposes ONLY through proposeClientMessage (the gate)", consumerSrc.includes("proposeClientMessage") && consumerSrc.includes('status: "proposed"') === false)
check("zoom transcript lane triggers the consumer post-analysis (source 1)", src("lib/connections/zoom-transcripts.ts").includes("runMeetingFollowthroughForCall"))
check("hourly voice sweep picks up call analyses with the SAME consumer (source 2)", src("lib/voice/call-analysis.ts").includes("runMeetingFollowthroughForCall"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · parked-lead retention tier math]")

const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
check("89d old → fresh", parkedLeadTier(daysAgo(89), NOW) === "fresh")
check(`${PARKED_FRESH_MAX_DAYS}d old → aging (boundary)`, parkedLeadTier(daysAgo(PARKED_FRESH_MAX_DAYS), NOW) === "aging")
check(`${PARKED_AGING_MAX_DAYS}d old → aging (inclusive ceiling)`, parkedLeadTier(daysAgo(PARKED_AGING_MAX_DAYS), NOW) === "aging")
check("366d old → stale", parkedLeadTier(daysAgo(366), NOW) === "stale")
check("unprovable age → fresh (never purged on a guess)", parkedLeadTier(null, NOW) === "fresh" && parkedLeadTier("not-a-date", NOW) === "fresh")

const parkedRows: ParkedLeadRow[] = [
  { id: "l1", created_at: daysAgo(10), zip_code: "78660" },
  { id: "l2", created_at: daysAgo(120), zip_code: "78660" },
  { id: "l3", created_at: daysAgo(400), zip_code: "78701" },
  { id: "l4", created_at: daysAgo(500), zip_code: "78701" },
  { id: "l5", created_at: daysAgo(600), zip_code: null },
  { id: "l6", created_at: daysAgo(700), zip_code: "78702", enrichment_profile: { [PURGED_MARKER_KEY]: daysAgo(5) } },
]
const report = summarizeParkedRetention(parkedRows, NOW)
check("tier counts: 1 fresh · 1 aging · 3 stale", report.tiers.fresh === 1 && report.tiers.aging === 1 && report.tiers.stale === 3, JSON.stringify(report.tiers))
check("already-purged row counted separately, in NO tier", report.purged === 1 && report.total === 6)
check("posture statement rendered verbatim from the policy", report.statement === PARKED_RETENTION_STATEMENT && report.statement.includes("never an automatic deletion"))
check("isPurgedParkedLead reads the marker", isPurgedParkedLead({ [PURGED_MARKER_KEY]: "2026-01-01" }) && !isPurgedParkedLead({}) && !isPurgedParkedLead(null))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · purge preview honesty + execution]")

check("preview covers ONLY stale, not-yet-purged rows", report.stalePreview.count === 3)
check("preview zip breakdown tallies EXACTLY to its count", report.stalePreview.zips.reduce((s, z) => s + z.count, 0) === report.stalePreview.count, JSON.stringify(report.stalePreview.zips))
check("unknown zips stated as such, never dropped from the tally", report.stalePreview.zips.some((z) => z.zip === "(zip unknown)" && z.count === 1))
check("preview declares exactly the purged + retained columns", report.stalePreview.columnsPurged.join(",") === PARKED_PII_COLUMNS.join(",") && report.stalePreview.columnsRetained.includes("zip_code"))
const emptyPreview = composePurgePreview([])
check("empty stale set → an honest zero preview", emptyPreview.count === 0 && emptyPreview.zips.length === 0)

// Execution on a mock client: PII nulled, marker stamped, row NEVER deleted.
const purgeState = { updates: [] as Array<{ ids: string[]; payload: Record<string, any> }>, deletes: 0 }
const staleDbRows = [
  { id: "l3", zip_code: "78701", enrichment_profile: {} },
  { id: "l4", zip_code: "78701", enrichment_profile: {} },
  { id: "l5", zip_code: null, enrichment_profile: {} },
]
function makePurgeSvc() {
  function chain(_table: string): any {
    let op = "select"; let payload: any = null; let inIds: string[] = []
    const proxy: any = new Proxy(() => {}, {
      get(_t, prop: string) {
        if (prop === "then") {
          if (op === "select") return (res: any) => res({ data: staleDbRows, error: null })
          if (op === "update") { purgeState.updates.push({ ids: inIds, payload }); return (res: any) => res({ data: null, error: null }) }
          if (op === "delete") { purgeState.deletes += 1; return (res: any) => res({ data: null, error: null }) }
          return (res: any) => res({ data: null, error: null })
        }
        return (...args: any[]) => {
          if (prop === "update" || prop === "insert" || prop === "delete") { op = prop; payload = args[0] }
          if (prop === "in") inIds = args[1]
          return proxy
        }
      },
    })
    return proxy
  }
  return { from: (t: string) => chain(t) }
}
const purgeRes = await executeStaleParkedPurge(makePurgeSvc() as any, { now: NOW })
check("purge anonymized all 3 stale rows in one audited batch", purgeRes.ok && purgeRes.purged === 3 && purgeRes.moreRemaining === false, JSON.stringify(purgeRes))
check("receipt zip breakdown tallies exactly to rows purged", purgeRes.zips.reduce((s, z) => s + z.count, 0) === purgeRes.purged)
const upd = purgeState.updates[0]?.payload ?? {}
check("update nulls exactly the declared PII columns", PARKED_PII_COLUMNS.every((c) => c in upd && upd[c] === null))
check("purged_at marker stamped in enrichment_profile (also wiping enriched PII)", upd.enrichment_profile?.[PURGED_MARKER_KEY] === NOW.toISOString() && upd.enrichment_profile?.purge_reason === "parked_stale_archival")
check("rows are anonymized IN PLACE — no delete ever issued", purgeState.deletes === 0)
check("zip_code / created_at are NOT in the update payload (zip-level row retained)", !("zip_code" in upd) && !("created_at" in upd))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · superadmin gate + audit + board mount locks]")

const actionSrc = src("app/actions/superadmin/parked-retention.ts")
check("archival action is a server action gated by requireSuperadmin BEFORE executing", actionSrc.includes('"use server"') && actionSrc.indexOf("requireSuperadmin") < actionSrc.indexOf("executeStaleParkedPurge"))
check("every purge execution ledgers to superadmin_audit_log with the receipt", actionSrc.includes("superadmin_audit_log") && actionSrc.includes("parked_leads.stale_pii_purged") && actionSrc.includes("zips"))
check("action re-derives targets server-side (no client-supplied id list)", !/ids\s*:\s*string\[\]/.test(actionSrc))
const boardSrc = src("app/dashboard/superadmin/platform/territory-coverage-board.tsx")
check("coverage board renders the posture statement + tier counts", boardSrc.includes("Parked-lead retention posture") && boardSrc.includes("retention.statement") && boardSrc.includes("retention.tiers"))
check("board mounts the archival as the gated form action with the exact preview", boardSrc.includes("purgeStaleParkedLeadsFormAction") && boardSrc.includes("stalePreview"))
check("superadmin platform page feeds the board the retention report", src("app/dashboard/superadmin/platform/page.tsx").includes("loadParkedRetention"))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
