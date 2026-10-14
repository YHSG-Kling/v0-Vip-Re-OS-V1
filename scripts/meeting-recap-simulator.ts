#!/usr/bin/env tsx
/**
 * scripts/meeting-recap-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Round 41 — THE CLIENT MEETING RECAP: "what we discussed, what happens next"
 * as a portal-visible, HUMAN-APPROVED card (lib/ai-isa/meeting-recap).
 *
 * Layer 1 — GROUNDING: every "what we discussed" point pairs a key topic with
 *           a VERBATIM transcript line; a topic with no transcript evidence
 *           derives NOTHING (the round-40 invariant); duplicate evidence
 *           collapses; capped.
 *
 * Layer 2 — NEXT STEPS FROM REAL ARTIFACTS ONLY: derived exclusively from the
 *           follow-through proposals actually created for THIS call (client-
 *           facing kinds; the agent coaching note never surfaces; a foreign
 *           call's proposals never leak in) + a follow-up actually scheduled
 *           at the stated horizon. Nothing → honest "nothing needed" (never
 *           an invented step).
 *
 * Layer 3 — DETERMINISTIC BRAND-VOICE FLOOR: the fallback recap is pure and
 *           deterministic, subject always carries the meeting date, body lists
 *           only the given points/steps, never a transcript line.
 *
 * Layer 4 — END-TO-END on a mock client: an analyzed zoom meeting → EXACTLY
 *           ONE proposal on the gate (status 'proposed', channel 'portal',
 *           entity_type 'meeting_recap', audience matching the contact's
 *           side); re-run → deduped; row marked SENT and re-run → still
 *           deduped (re-approval never re-proposes); the client body never
 *           contains raw transcript lines.
 *
 * Layer 5 — CONSERVATIVE MEETING GATE: zoom meetings always recap; a phone
 *           call recaps ONLY when a calendar appointment sits near the call
 *           time; an ungrounded analysis recaps nothing.
 *
 * Layer 6 — WIRING + EXPOSURE LOCKS (source greps): no direct-send helpers in
 *           the composer; the zoom lane + the voice sweep both trigger the
 *           recap AFTER follow-through; approval maps entity_type
 *           'meeting_recap' to the distinct portal update_type (generic path
 *           unchanged); the portal feed renders the distinct card and NEVER
 *           references the transcript; the author brief never receives the
 *           transcript.
 *
 * Run:  npx tsx scripts/meeting-recap-simulator.ts
 * npm:  test:meeting-recap
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  deriveDiscussedPoints, topicEvidenceRegex, deriveNextSteps, buildRecapFallback,
  meetingDateLabel, followupWhenLabel, meetingRecapTag, isMeetingConversation,
  composeMeetingRecap,
  MEETING_RECAP_TAG, MEETING_RECAP_ENTITY_TYPE, MAX_RECAP_POINTS, MEETING_EVENT_TYPES,
} from "../lib/ai-isa/meeting-recap"
import { followthroughTag, MEETING_FOLLOWTHROUGH_TAG } from "../lib/ai-isa/meeting-followthrough"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · grounding — every discussed point traces to a transcript line]")

const NOW = new Date("2026-07-20T12:00:00Z")
const TRANSCRIPT = [
  "Agent: Thanks for hopping on the meeting today, both of you.",
  "Caller: Of course. The big thing is we need to sell our house in Mocksley before we can buy anything.",
  "Caller: And we were wondering about getting pre-approved — what does that even take?",
  "Agent: Great question, we can walk through it.",
  "Caller: Realistically we'd move in six months, after the school year.",
  "Caller: My worry is the market feels overpriced right now.",
].join("\n")

const TOPICS = ["sell first", "pre-approval", "moving timeline", "closing paperwork"]
const points = deriveDiscussedPoints(TRANSCRIPT, TOPICS)
check("grounded topics derive points; ungrounded topics derive NOTHING",
  points.length === 2 && points[0].topic === "sell first" && points[1].topic === "pre-approval",
  JSON.stringify(points.map((p) => p.topic)))
check("every point's evidence is a VERBATIM transcript line",
  points.every((p) => TRANSCRIPT.split("\n").includes(p.evidence)))
check("'pre-approval' topic evidenced by the 'pre-approved' line (light stem, same topic)",
  (points.find((p) => p.topic === "pre-approval")?.evidence ?? "").includes("wondering about getting pre-approved"))
check("'closing paperwork' (never discussed) derives nothing — the grounding gate",
  !points.some((p) => p.topic === "closing paperwork"))
check("empty transcript derives zero points", deriveDiscussedPoints("", TOPICS).length === 0)
check("duplicate evidence collapses to one point",
  deriveDiscussedPoints("Caller: we need to sell before we buy anything", ["sell first", "selling the house"]).length === 1)
const MANY_TOPICS = ["kitchen", "garage", "basement", "roofing", "windows", "flooring", "painting", "plumbing"]
check(`points capped at ${MAX_RECAP_POINTS}`,
  deriveDiscussedPoints(
    MANY_TOPICS.map((t) => `Caller: we talked about the ${t} for a while`).join("\n"),
    MANY_TOPICS,
  ).length === MAX_RECAP_POINTS)
check("an unmatchable topic yields a null regex (dropped, never a wildcard)",
  topicEvidenceRegex("") === null && topicEvidenceRegex("ab") === null)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · next steps ONLY from real follow-through artifacts]")

const CALL_ID = "call-1"
const FT_PROPOSALS = [
  { rationale: `${followthroughTag(CALL_ID, "sell_first")} — the meeting surfaced a sell-first situation. They said: "we need to sell our house".`, audience: "seller" },
  { rationale: `${followthroughTag(CALL_ID, "financing_prequal")} — they asked about financing. They said: "wondering about getting pre-approved".`, audience: "buyer" },
  { rationale: `${followthroughTag(CALL_ID, "objection_coaching")} — objection detected. They said: "market feels overpriced".`, audience: "agent" },
  { rationale: `${followthroughTag("call-OTHER", "sell_first")} — a different meeting's proposal.`, audience: "seller" },
]
const FOLLOWUP_AT = new Date(NOW.getTime() + 180 * 86_400_000).toISOString()
const FOLLOWUP_REASON = `${followthroughTag(CALL_ID, "timeline_followup")} they said: "in six months"`

const steps = deriveNextSteps({ voiceCallId: CALL_ID, proposals: FT_PROPOSALS, followupAt: FOLLOWUP_AT, followupReason: FOLLOWUP_REASON, now: NOW })
const stepSources = steps.map((s) => s.source)
check("client-facing follow-through proposals become next steps (sell_first + financing)",
  stepSources.includes("sell_first") && stepSources.includes("financing_prequal"))
check("the agent coaching note NEVER surfaces as a client next step", !stepSources.includes("objection_coaching"))
check("a FOREIGN call's proposals never leak into this recap", steps.length === 3, JSON.stringify(stepSources))
check("the scheduled follow-up (this call's timeline tag, future-dated) becomes a step with its month",
  stepSources.includes("scheduled_followup") && steps.some((s) => s.text.includes(followupWhenLabel(FOLLOWUP_AT))))
check("a PAST follow-up date derives no step",
  !deriveNextSteps({ voiceCallId: CALL_ID, proposals: [], followupAt: new Date(NOW.getTime() - 86_400_000).toISOString(), followupReason: FOLLOWUP_REASON, now: NOW }).length)
check("another call's timeline tag on the contact derives no step",
  deriveNextSteps({ voiceCallId: CALL_ID, proposals: [], followupAt: FOLLOWUP_AT, followupReason: `${followthroughTag("call-OTHER", "timeline_followup")} …`, now: NOW }).length === 0)
check("ZERO artifacts → ZERO steps (nothing invented)",
  deriveNextSteps({ voiceCallId: CALL_ID, proposals: [], followupAt: null, followupReason: null, now: NOW }).length === 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · deterministic brand-voice floor]")

const DATE_LABEL = meetingDateLabel("2026-07-18T17:00:00Z")
check('meeting date label is deterministic UTC ("Jul 18")', DATE_LABEL === "Jul 18", DATE_LABEL)
const fb = buildRecapFallback({ firstName: "Jordan", meetingWord: "meeting", dateLabel: DATE_LABEL, points, nextSteps: steps })
const fb2 = buildRecapFallback({ firstName: "Jordan", meetingWord: "meeting", dateLabel: DATE_LABEL, points, nextSteps: steps })
check("floor is deterministic (same inputs → identical copy)", fb.subject === fb2.subject && fb.body === fb2.body)
check("subject carries the meeting date", fb.subject === `Recap of our meeting — ${DATE_LABEL}`)
check("body lists exactly the grounded topics", fb.body.includes("What we discussed: sell first, pre-approval."))
check("body lists every derived next step", steps.every((s) => fb.body.includes(s.text)))
check("body never contains a raw transcript line", !/(^|\n)(Caller|Agent):/.test(fb.body) && !fb.body.includes("Mocksley"))
const fbEmpty = buildRecapFallback({ firstName: null, meetingWord: "call", dateLabel: DATE_LABEL, points, nextSteps: [] })
check("no next steps → the honest 'nothing needed' line, never an invented step",
  fbEmpty.body.includes("Nothing is needed from you right now") && !fbEmpty.body.includes("•"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · end-to-end on a mock client — proposed-not-sent + dedupe]")

interface MockState {
  calls: Record<string, any>
  analyses: Record<string, any>
  contact: Record<string, any>
  clientMessages: Array<Record<string, any>>
  hasCalendarEvent: boolean
  notifications: number
}

function makeMockSvc(state: MockState) {
  function chain(table: string): any {
    const filters: Array<{ op: string; col?: string; val?: any }> = []
    let op: "select" | "insert" | "update" = "select"
    let payload: any = null
    let single = false
    const resolve = () => {
      if (table === "voice_calls") {
        const id = filters.find((f) => f.op === "eq" && f.col === "id")?.val
        return { data: state.calls[id] ?? null, error: null }
      }
      if (table === "call_analyses") {
        const id = filters.find((f) => f.op === "eq" && f.col === "voice_call_id")?.val
        return { data: state.analyses[id] ?? null, error: null }
      }
      if (table === "contacts" && op === "select") return { data: state.contact, error: null }
      if (table === "contacts" && op === "update") return { data: null, error: null }
      if (table === "agents") return { data: { user_id: "user-1", id: "ag-1" }, error: null }
      if (table === "calendar_events") return { data: state.hasCalendarEvent ? { id: "evt-1" } : null, error: null }
      if (table === "agent_client_messages" && op === "select") {
        const ilike = filters.find((f) => f.op === "ilike")
        const prefix = ilike ? String(ilike.val).replace(/%$/, "") : ""
        const hits = state.clientMessages.filter((m) => (m.rationale ?? "").startsWith(prefix))
        return single ? { data: hits[0] ?? null, error: null } : { data: hits, error: null }
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
          if (prop === "insert" || prop === "update") { op = prop as any; payload = args[0] }
          else if (prop === "maybeSingle" || prop === "single") single = true
          else if (prop !== "select") filters.push({ op: prop, col: args[0], val: args[1] })
          return proxy
        }
      },
    })
    return proxy
  }
  return { from: (table: string) => chain(table) }
}

const ANALYSIS_ROW = {
  id: "an-1", summary: "Sell-first couple; asked about pre-approval; six-month timeline.",
  key_topics: TOPICS, analyzed_by: "zoom_transcript", analyzed_at: "2026-07-18T18:00:00Z",
}
const state: MockState = {
  calls: {
    "call-1": { id: "call-1", brokerage_id: "brk-1", contact_id: "ct-1", agent_id: "ag-1", call_type: "zoom_meeting", started_at: "2026-07-18T17:00:00Z", transcription: TRANSCRIPT },
    "call-2": { id: "call-2", brokerage_id: "brk-1", contact_id: "ct-1", agent_id: "ag-1", call_type: "phone", started_at: "2026-07-18T17:00:00Z", transcription: TRANSCRIPT },
    "call-3": { id: "call-3", brokerage_id: "brk-1", contact_id: "ct-1", agent_id: "ag-1", call_type: "phone", started_at: "2026-07-18T17:00:00Z", transcription: TRANSCRIPT },
  },
  analyses: { "call-1": ANALYSIS_ROW, "call-2": { ...ANALYSIS_ROW, analyzed_by: "voice_intel_sweep" }, "call-3": { ...ANALYSIS_ROW, analyzed_by: "voice_intel_sweep" } },
  contact: { first_name: "Jordan", contact_type: "seller", agent_id: "ag-1", next_followup_at: FOLLOWUP_AT, next_followup_reason: FOLLOWUP_REASON },
  clientMessages: FT_PROPOSALS.map((p, i) => ({ id: `ft-${i}`, status: "proposed", ...p })),
  hasCalendarEvent: false,
  notifications: 0,
}
const svc = makeMockSvc(state)
const before = state.clientMessages.length

const run1 = await composeMeetingRecap(svc as any, "call-1", { now: NOW })
const recap = state.clientMessages[state.clientMessages.length - 1]
check("zoom meeting → EXACTLY ONE recap proposal landed", run1.ok && run1.proposed && state.clientMessages.length === before + 1, JSON.stringify(run1))
check("PROPOSED-NOT-SENT lock: status 'proposed' on the human gate", recap?.status === "proposed")
check("portal channel + the recap entity_type + the meeting as entity",
  recap?.channel === "portal" && recap?.entity_type === MEETING_RECAP_ENTITY_TYPE && recap?.entity_id === "call-1")
check("audience matches the contact's side (seller contact → seller audience)",
  recap?.audience === "seller" && recap?.recipient_contact_id === "ct-1")
check("subject is the deterministic date-carrying subject", recap?.subject === `Recap of our meeting — ${DATE_LABEL}`)
check("deterministic floor engaged (authoring unavailable here) — body is the pure fallback",
  recap?.body === fb.body)
check("client body carries topics + real next steps, NEVER a raw transcript line",
  recap?.body.includes("sell first") && steps.every((s) => recap?.body.includes(s.text)) && !/(^|\n)(Caller|Agent):/.test(recap?.body ?? "") && !(recap?.body ?? "").includes("Mocksley"))
check("rationale starts with the per-meeting dedupe tag + carries the grounding evidence",
  (recap?.rationale ?? "").startsWith(meetingRecapTag("call-1")) && (recap?.rationale ?? "").includes("we need to sell our house"))

const run2 = await composeMeetingRecap(svc as any, "call-1", { now: NOW })
check("re-run (webhook redelivery / sweep re-run): deduped, nothing new",
  run2.ok && !run2.proposed && state.clientMessages.length === before + 1, JSON.stringify(run2))

recap.status = "sent" // the human approved + it shipped
const run3 = await composeMeetingRecap(svc as any, "call-1", { now: NOW })
check("RE-APPROVAL NEVER RE-PROPOSES: a sent recap still blocks (dedupe spans all statuses)",
  run3.ok && !run3.proposed && state.clientMessages.length === before + 1)
check("dedupe tag helper matches the stored prefix", meetingRecapTag("call-1") === `${MEETING_RECAP_TAG} [call-1]`)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · conservative meeting gate]")

check("pure gate: zoom always; phone only with a linked appointment",
  isMeetingConversation("zoom_meeting", false) && !isMeetingConversation("phone", false) && isMeetingConversation("phone", true))
check("gate vocabulary is the client-facing consultation set (no drive-by types)",
  (MEETING_EVENT_TYPES as readonly string[]).includes("buyer_consultation") && !(MEETING_EVENT_TYPES as readonly string[]).includes("follow_up") && !(MEETING_EVENT_TYPES as readonly string[]).includes("showing"))

const runPhoneUnlinked = await composeMeetingRecap(svc as any, "call-2", { now: NOW })
check("phone call with NO calendar appointment → no recap (conservative)",
  runPhoneUnlinked.ok && !runPhoneUnlinked.proposed && state.clientMessages.length === before + 1, runPhoneUnlinked.reason)

state.hasCalendarEvent = true
const runPhoneLinked = await composeMeetingRecap(svc as any, "call-3", { now: NOW })
check("phone call WITH a linked calendar appointment → recap proposed",
  runPhoneLinked.ok && runPhoneLinked.proposed && state.clientMessages.length === before + 2, JSON.stringify(runPhoneLinked))
check("phone-lane recap says 'call', still date-stamped",
  state.clientMessages[state.clientMessages.length - 1]?.subject === `Recap of our call — ${DATE_LABEL}`)

state.hasCalendarEvent = false
state.analyses["call-4"] = { ...ANALYSIS_ROW, key_topics: ["closing paperwork", "escrow logistics"] }
state.calls["call-4"] = { ...state.calls["call-1"], id: "call-4" }
const runUngrounded = await composeMeetingRecap(svc as any, "call-4", { now: NOW })
check("an analysis whose topics have NO transcript evidence recaps NOTHING",
  runUngrounded.ok && !runUngrounded.proposed && state.clientMessages.length === before + 2, runUngrounded.reason)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · wiring + transcript-never-exposed locks]")

const recapSrc = src("lib/ai-isa/meeting-recap.ts")
for (const banned of ["dispatchEmail", "dispatchSms", "dispatchDirectMail", "providers/dispatch"]) {
  check(`composer never references ${banned}`, !recapSrc.includes(banned))
}
check("composer proposes ONLY through proposeClientMessage (the gate)",
  recapSrc.includes("proposeClientMessage") && !recapSrc.includes('status: "proposed"'))
check("brand-voice authoring wired (generateClientMessage) with the deterministic floor",
  recapSrc.includes("generateClientMessage") && recapSrc.includes("buildRecapFallback"))
const authorBlock = recapSrc.slice(recapSrc.indexOf("await generateClientMessage({"), recapSrc.indexOf("fallback,\n      })"))
check("the author brief NEVER receives the transcript or evidence lines (topics + derived steps only)",
  authorBlock.length > 0 && !authorBlock.includes("transcript") && !authorBlock.includes("evidence"))
check("subject stays deterministic so the meeting date is guaranteed on the card",
  recapSrc.includes("const subject = fallback.subject"))

const zoomSrc = src("lib/connections/zoom-transcripts.ts")
check("zoom lane triggers the recap AFTER follow-through (next steps can cite the real proposals)",
  zoomSrc.includes("composeMeetingRecap") && zoomSrc.indexOf("runMeetingFollowthroughForCall") < zoomSrc.indexOf("composeMeetingRecap"))
const sweepSrc = src("lib/voice/call-analysis.ts")
check("voice sweep triggers the recap AFTER follow-through (composer enforces the meeting gate)",
  sweepSrc.includes("composeMeetingRecap") && sweepSrc.indexOf("runMeetingFollowthroughForCall") < sweepSrc.indexOf("composeMeetingRecap") && sweepSrc.includes("recapsProposed"))

const acmSrc = src("lib/agents/agent-client-messages.ts")
check("approval maps the recap to the DISTINCT portal update_type",
  acmSrc.includes('m.entity_type === "meeting_recap"') && acmSrc.includes('"meeting_recap" : "agent_message"'))

const feedSrc = src("app/portal/[contactId]/components/RecentUpdatesFeed.tsx")
check("portal feed renders the distinct 'Meeting recap' card",
  feedSrc.includes('"meeting_recap"') && feedSrc.includes("Meeting recap"))
check("TRANSCRIPT-NEVER-EXPOSED: the portal feed CODE has no transcript reference (comments stripped)",
  !/transcript/i.test(stripComments(feedSrc)))
check("portal feed reads only the transparency card columns (no voice_calls / call_analyses)",
  !feedSrc.includes("voice_calls") && !feedSrc.includes("call_analyses"))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
