#!/usr/bin/env tsx
/**
 * scripts/agent-booking-ledger-simulator.ts   (npm run test:agent-booking-ledger)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 86D (wave 86) — two blind spots in the AI agents, proven closed on the
 * REAL code (no DB, no network; only the edges are faked):
 *
 *   A · CALENDAR-AWARE BOOKING. The phone receptionist wrote the caller's
 *       spoken time straight in as a CONFIRMED showing and texted "You're
 *       booked" without reading the agent's calendar or already-scheduled
 *       showings; the chat/email/portal/avatar agents' request_showing only
 *       ever logged a request with a placeholder "now" time. Both now ride
 *       lib/kernel/self-book.ts (the portal's live-availability engine):
 *         · decideRequestedShowing — a caller-named window is CONFIRMED only
 *           when the agent's calendar is readable, free for the exact window,
 *           no scheduled showing overlaps, and it is past the lead time;
 *         · bookShowingFromCall — anything short of that becomes a follow-up
 *           for the agent to confirm and a "we've asked … to confirm" text,
 *           never a confirmed row;
 *         · request_showing(listing_id, slot_start) — real open times, then a
 *           booking through bookShowingSlot (via "ai_agent"), tenant-pinned.
 *   B · SPEND ATTRIBUTION. Voice plan-only turns, outbound-brief turns and
 *       every platform-agent turn reached generateTextRouted with no tenant
 *       and were booked nowhere; the platform prospect chat / live avatar
 *       headers claimed a booking that never happened. Now: every tenant voice
 *       turn carries its tenant; platform agents book platform_paid (m668);
 *       logAIUsage never stamps a tenant row platform-paid; manager-ops reads
 *       the platform-paid spend and says "unmeasured" (null) — never 0 — when
 *       the read is refused.
 *
 * Positive controls: each rule is run against a specimen that has the defect
 * (a busy calendar, a :30 request the hourly grid cannot hold, a foreign
 * listing, a missing ledger argument, a refused read) and must catch it.
 * Rule, not waypoint: no migration number, row count or date is pinned.
 *
 * Run: npx tsx --conditions=react-server scripts/agent-booking-ledger-simulator.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// ── MODULE INTERCEPTION — the edges only ────────────────────────────────────
const G = globalThis as any
G.__86D = {
  svc: null as MemClient | null,
  busy: null as Array<{ start: number; end: number }> | null | "error",
  freeSlots: [] as Array<{ startTime: string; endTime: string }>,
  calendarCalls: 0,
  eventsCreated: [] as Row[],
  bbaAllowed: true,
}
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__86D.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__86D.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f",
  "@/lib/buyer-broker/gate": "export const requireActiveBBA = async () => (globalThis.__86D.bbaAllowed ? { allowed: true } : { allowed: false, reason: 'A signed buyer agreement is needed first' })",
  "@/lib/providers/calendar/personal-calendar": [
    "export const getBusyViaPersonal = async () => { globalThis.__86D.calendarCalls++; const b = globalThis.__86D.busy; return b === null ? null : b === 'error' ? { success: false, error: 'boom' } : { success: true, busy: b } }",
    "export const getAvailabilityViaPersonal = async () => { globalThis.__86D.calendarCalls++; const b = globalThis.__86D.busy; return b === null ? null : { success: true, slots: globalThis.__86D.freeSlots } }",
    "export const createEventViaPersonal = async (u, ev) => { globalThis.__86D.eventsCreated.push({ u, ...ev }); return { success: true, eventId: 'ev-1' } }",
  ].join("\n"),
  "@/lib/kernel/manager-signals": "export const publishManagerSignal = async () => ({ ok: true })",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const AGENT = "a0000000-0000-4000-8000-000000000001"
const AGENT_USER = "u0000000-0000-4000-8000-000000000001"
const CONTACT = "c0000000-0000-4000-8000-000000000001"
const LISTING = "l0000000-0000-4000-8000-000000000001"
const FOREIGN_LISTING = "l0000000-0000-4000-8000-000000000009"
const HOUR = 3_600_000

function world(selfBooking: boolean, extra: Record<string, Row[]> = {}): MemClient {
  return memSupabase({
    brokerage_settings: [{ brokerage_id: BRK, settings: selfBooking ? { self_booking: { enabled: true } } : {} }],
    agents: [{ id: AGENT, user_id: AGENT_USER, brokerage_id: BRK }],
    listings: [
      { id: LISTING, brokerage_id: BRK, agent_id: AGENT, address: "12 Oak St", city: "Austin" },
      { id: FOREIGN_LISTING, brokerage_id: OTHER, agent_id: AGENT, address: "9 Elm St", city: "Dallas" },
    ],
    contacts: [{ id: CONTACT, brokerage_id: BRK, agent_id: null, first_name: "Pat", last_name: "Lee", phone: null }],
    showings: [], showing_requests: [], activities: [], notifications: [], client_portal_messages: [],
    ...extra,
  })
}

async function main() {
  const selfBook = await import("../lib/kernel/self-book")

  // ── A1 · the pure rule ──────────────────────────────────────────────────────
  console.log("\n[A1 · decideRequestedShowing — confirmed only when provably open]")
  const now = Date.UTC(2030, 0, 6, 12, 0) // any fixed instant; every other time is DERIVED from it
  const start = now + 26 * HOUR + 30 * 60_000 // tomorrow, on a :30 — the hourly grid cannot hold it
  const base = { startMs: start, durationMinutes: 30, nowMs: now, showings: [] as Array<{ scheduled_at: string | null; duration_minutes: number | null }> }
  ok("open calendar, no showings, past lead time → confirm", selfBook.decideRequestedShowing({ ...base, busy: [] }).confirm === true)
  ok("CONTROL: a :30 request against an open calendar is judged on its exact window (not the hourly grid)",
    selfBook.decideRequestedShowing({ ...base, busy: [{ start: start - HOUR, end: start }] }).confirm === true)
  const busy = selfBook.decideRequestedShowing({ ...base, busy: [{ start: start + 10 * 60_000, end: start + HOUR }] })
  ok("CONTROL: a calendar event overlapping the window → NOT confirmed (calendar_busy)", !busy.confirm && busy.reason === "calendar_busy")
  const clash = selfBook.decideRequestedShowing({ ...base, busy: [], showings: [{ scheduled_at: new Date(start - 15 * 60_000).toISOString(), duration_minutes: 45 }] })
  ok("CONTROL: an already-scheduled showing overlapping → NOT confirmed (showing_conflict)", !clash.confirm && clash.reason === "showing_conflict")
  ok("no calendar connected → NOT confirmed (no_calendar) — nobody checked is never 'fine'", selfBook.decideRequestedShowing({ ...base, busy: null }).reason === "no_calendar")
  ok("calendar read failed → NOT confirmed (calendar_unreadable)", selfBook.decideRequestedShowing({ ...base, busy: "error" }).reason === "calendar_unreadable")
  ok("inside the lead time → NOT confirmed (too_soon)", selfBook.decideRequestedShowing({ ...base, startMs: now + 30 * 60_000, busy: [] }).reason === "too_soon")

  // ── A2 · the voice door ─────────────────────────────────────────────────────
  console.log("\n[A2 · bookShowingFromCall — the spoken time never becomes a confirmed row unchecked]")
  const voice = await import("../lib/voice/twilio-voice")
  const ctx: any = { brokerageId: BRK, agentUserId: null, identity: { agentName: "Sam" } }
  const call = { id: "vc-1", contact_id: CONTACT, agent_id: AGENT }
  const when = new Date(Date.now() + 30 * HOUR).toISOString()
  for (const scenario of [
    { label: "busy calendar", busy: [{ start: Date.parse(when) - 60_000, end: Date.parse(when) + HOUR }] as any, expect: "pending_agent_confirmation" },
    { label: "no calendar connected", busy: null, expect: "pending_agent_confirmation" },
    { label: "open calendar", busy: [] as any, expect: "confirmed" },
  ]) {
    G.__86D.svc = world(false)
    G.__86D.busy = scenario.busy
    G.__86D.eventsCreated = []
    const texts: string[] = []
    const followUps: Row[] = []
    const out = await voice.bookShowingFromCall(G.__86D.svc, ctx, call, when, {
      text: async (m: string) => { texts.push(m) },
      writeFollowUp: async (p: any) => { followUps.push(p); return { success: true, activityId: "act-1", scheduledAt: p.scheduledAt } },
    })
    const confirmedRows = (G.__86D.svc.tables.showings ?? []).filter((r: Row) => r.is_confirmed === true)
    if (scenario.expect === "confirmed") {
      ok(`${scenario.label}: booked as confirmed`, out.booked === "confirmed", JSON.stringify(out))
      ok(`${scenario.label}: exactly one confirmed showing, attributed ai_scheduler`, confirmedRows.length === 1 && confirmedRows[0].sync_source === "ai_scheduler" && confirmedRows[0].agent_id === AGENT)
      ok(`${scenario.label}: mirrored onto the agent's own calendar (agents.id → users.id)`, G.__86D.eventsCreated.length === 1 && G.__86D.eventsCreated[0].u === AGENT_USER)
      ok(`${scenario.label}: caller told "You're booked"`, texts.length === 1 && /You're booked/.test(texts[0]))
    } else {
      ok(`${scenario.label}: NOT booked as confirmed (${JSON.stringify(out)})`, out.booked === "pending_agent_confirmation")
      ok(`${scenario.label}: ZERO confirmed showings written`, confirmedRows.length === 0 && (G.__86D.svc.tables.showings ?? []).length === 0)
      ok(`${scenario.label}: a showing follow-up at the REQUESTED time for the call's agent`, followUps.length === 1 && followUps[0].scheduledAt === when && followUps[0].agentId === AGENT && followUps[0].activityType === "showing")
      ok(`${scenario.label}: the agent's bell asks for confirmation`, (G.__86D.svc.tables.notifications ?? []).some((n: Row) => n.user_id === AGENT_USER && /needs your confirmation/.test(n.title)))
      ok(`${scenario.label}: caller told it is a request, never "You're booked"`, texts.length === 1 && /to confirm/.test(texts[0]) && !/You're booked/.test(texts[0]))
    }
  }
  // Source rule over stripped + string-blanked code: the confirmed insert comes AFTER the window check.
  const vsrc = blankStrings(stripComments(read("lib/voice/twilio-voice.ts")))
  const fnAt = vsrc.indexOf("export async function bookShowingFromCall")
  const fnBody = vsrc.slice(fnAt, vsrc.indexOf("\nasync function textCallConfirmation", fnAt))
  ok("rule: bookShowingFromCall judges the window BEFORE any confirmed insert", fnBody.indexOf("checkWindow(") > 0 && fnBody.indexOf("checkWindow(") < fnBody.indexOf("is_confirmed: true"))
  const preSpecimen = `export async function bookShowingFromCall(svc, ctx, call, dateTimeIso) { await svc.from("showings").insert({ is_confirmed: true }) }\nasync function textCallConfirmation() {}`
  const ps = blankStrings(stripComments(preSpecimen))
  ok("CONTROL: the pre-86D shape (insert with no window check) fails that rule", !(ps.indexOf("checkWindow(") > 0 && ps.indexOf("checkWindow(") < ps.indexOf("is_confirmed: true")))

  // ── A3 · request_showing, calendar-aware and tenant-pinned ─────────────────
  console.log("\n[A3 · request_showing(listing_id, slot_start) — real open times, booked on the ONE engine]")
  const { buildCustomerFreeTools } = await import("../lib/ai-isa/customer-context-tools")
  const opts = { toolCallId: "t", messages: [] } as any
  const slotA = { startTime: new Date(Date.now() + 28 * HOUR).toISOString(), endTime: new Date(Date.now() + 28.75 * HOUR).toISOString() }
  const slotB = { startTime: new Date(Date.now() + 29 * HOUR).toISOString(), endTime: new Date(Date.now() + 29.75 * HOUR).toISOString() }
  const toolsFor = async () => (await buildCustomerFreeTools({ brokerageId: BRK, contactId: CONTACT, leadId: null, agentId: AGENT }) as any).request_showing

  G.__86D.svc = world(true); G.__86D.busy = []; G.__86D.freeSlots = [slotA, slotB]; G.__86D.calendarCalls = 0
  const foreign = await (await toolsFor()).execute({ meeting_type: "showing", preferred_window: null, notes: "", listing_id: FOREIGN_LISTING, slot_start: null }, opts)
  ok("CONTROL: another tenant's listing id → no live booking, not even an availability read", foreign.mode === "requested" && G.__86D.calendarCalls === 0, JSON.stringify(foreign))

  G.__86D.svc = world(false)
  const off = await (await toolsFor()).execute({ meeting_type: "showing", preferred_window: "Saturday", notes: "", listing_id: LISTING, slot_start: null }, opts)
  ok("self-booking OFF (the default) → the request path, agent confirms", off.mode === "requested" && (G.__86D.svc.tables.activities ?? []).length === 1)

  G.__86D.svc = world(true)
  const offer = await (await toolsFor()).execute({ meeting_type: "showing", preferred_window: null, notes: "", listing_id: LISTING, slot_start: null }, opts)
  ok("self-booking ON → REAL open times from the agent's calendar, nothing written yet", offer.mode === "choose_slot" && offer.slots.length === 2 && G.__86D.svc.writes.length === 0, JSON.stringify(offer))
  const booked = await (await toolsFor()).execute({ meeting_type: "showing", preferred_window: null, notes: "", listing_id: LISTING, slot_start: slotB.startTime }, opts)
  const bookedRows = G.__86D.svc.tables.showings ?? []
  ok("picked slot → booked on the ONE engine (confirmed, self_book, ai_scheduler)", booked.mode === "booked" && bookedRows.length === 1 && bookedRows[0].scheduled_at === slotB.startTime && bookedRows[0].sync_source === "ai_scheduler" && bookedRows[0].scheduling_method === "self_book", JSON.stringify(booked))
  ok("the showing request row is attributed to the conversation (source 'message', a live CHECK value)", (G.__86D.svc.tables.showing_requests ?? []).some((r: Row) => r.source === "message" && r.status === "approved"))
  G.__86D.svc = world(true)
  const gone = await (await toolsFor()).execute({ meeting_type: "showing", preferred_window: null, notes: "", listing_id: LISTING, slot_start: new Date(Date.now() + 99 * HOUR).toISOString() }, opts)
  ok("CONTROL: a slot that is not open → no booking, fresh real times offered", gone.mode === "choose_slot" && gone.success === false && (G.__86D.svc.tables.showings ?? []).length === 0)
  G.__86D.svc = world(true, { contacts: [{ id: CONTACT, brokerage_id: BRK, agent_id: AGENT, first_name: "Pat", last_name: "Lee" }] }); G.__86D.bbaAllowed = false
  const bba = await (await toolsFor()).execute({ meeting_type: "showing", preferred_window: null, notes: "", listing_id: LISTING, slot_start: slotA.startTime }, opts)
  ok("CONTROL: the NAR-settlement BBA gate still refuses → falls back to the agent-confirmed request", bba.mode === "requested" && (G.__86D.svc.tables.showings ?? []).length === 0)
  G.__86D.bbaAllowed = true

  // ── B1 · voice turns carry their ledger ─────────────────────────────────────
  console.log("\n[B1 · every voice turn names who pays]")
  const seen: any[] = []
  const gen = async (a: any) => { seen.push(a); return { text: JSON.stringify({ say: "Hi", action: "continue" }) } }
  await voice.planTurnWithPrompt("SYS", null, "hello", undefined, { generateTextRouted: gen as any }, { brokerageId: BRK, agentId: AGENT })
  ok("a no-tools tenant turn books on the tenant (brokerageId + agents.id)", seen.length === 1 && seen[0].brokerageId === BRK && seen[0].agentId === AGENT && seen[0].feature === "voice_reception_turn")
  seen.length = 0
  await voice.planTurnWithPrompt("SYS", null, "hello", undefined, { generateTextRouted: gen as any })
  ok("CONTROL: the same turn with no ledger argument books nothing (what every such turn did pre-86D)", seen.length === 1 && !seen[0].brokerageId && !seen[0].platformPaid)
  seen.length = 0
  await voice.planTurnWithPrompt("SYS", null, "hello", undefined, { generateTextRouted: gen as any }, { platformPaid: true })
  ok("a platform ledger → platform-paid with NO tenant", seen.length === 1 && seen[0].platformPaid === true && seen[0].brokerageId === null)
  seen.length = 0
  await voice.planTurnWithPrompt("SYS", null, "hello", undefined, { generateTextRouted: gen as any }, { brokerageId: BRK, agentId: null })
  ok("a tenant ledger is never platform-paid", seen.length === 1 && !seen[0].platformPaid && seen[0].brokerageId === BRK)
  const vs = stripComments(read("lib/voice/twilio-voice.ts"))
  const platformBranch = vs.slice(vs.indexOf('if (input.deployment === "platform")'), vs.indexOf('deployment === "tenant" — pass ctx'))
  ok("rule: the platform deployment's round books platform-paid", /telemetry:\s*\{\s*platformPaid:\s*true\s*\}/.test(platformBranch))
  ok("rule: both outbound-brief doors pass a tenant ledger to planTurnWithPrompt",
    ["app/api/voice/twilio/turn/route.ts", "app/api/voice/relay/plan/route.ts"].every((f) => /planTurnWithPrompt\([\s\S]{0,400}?\{\s*brokerageId:\s*ctx!?\.brokerageId/.test(stripComments(read(f)))))

  // ── B2 · routed lanes + ledger writer ───────────────────────────────────────
  console.log("\n[B2 · platform-paid rows land; tenant rows are never relabelled]")
  const models = blankStrings(stripComments(read("lib/ai/models.ts")))
  const ledgerGuards = [...models.matchAll(/if \(([^)]*)\) \{\s*await logAIUsage\(/g)].map((m) => m[1])
  ok(`every routed ledger write admits platform-paid (${ledgerGuards.length} guards: ${ledgerGuards.join(" | ")})`,
    ledgerGuards.length >= 3 && ledgerGuards.every((g) => /platformPaid/.test(g)))
  for (const f of ["app/api/platform/prospect-chat/route.ts", "app/api/did/custom-llm/route.ts"]) {
    ok(`rule: ${f} passes platformPaid on its tenant-less call`, /brokerageId:\s*null[\s\S]{0,200}platformPaid:\s*true/.test(stripComments(read(f))))
  }
  const { logAIUsage } = await import("../lib/ai/cost-tracking")
  G.__86D.svc = memSupabase({ ai_tool_usage: [] })
  await logAIUsage({ userId: null, brokerageId: null, model: "claude-haiku", inputTokens: 100, outputTokens: 20, feature: "platform_prospect_chat", platformPaid: true, manager: "data_steward" })
  const pRow = G.__86D.svc.tables.ai_tool_usage[0]
  ok("platform-paid call → one row, brokerage NULL, platform_paid true, priced", !!pRow && pRow.brokerage_id === null && pRow.platform_paid === true && pRow.cost_cents >= 0 && pRow.model_used === "claude-haiku")
  G.__86D.svc = memSupabase({ ai_tool_usage: [] })
  await logAIUsage({ userId: null, brokerageId: BRK, model: "claude-haiku", inputTokens: 1, outputTokens: 1, feature: "voice_reception_turn", platformPaid: true }).catch(() => {})
  const tRow = G.__86D.svc.tables.ai_tool_usage[0]
  ok("a TENANT call flagged platformPaid is still the tenant's (no platform_paid key — safe before m668 too)", !!tRow && tRow.brokerage_id === BRK && !("platform_paid" in tRow))
  G.__86D.svc = memSupabase({ ai_tool_usage: [] })
  await logAIUsage({ userId: null, brokerageId: null, model: "claude-haiku", inputTokens: 1, outputTokens: 1, feature: "x" })
  ok("CONTROL: neither tenant, user nor flag → not written (m476 would refuse it)", G.__86D.svc.tables.ai_tool_usage.length === 0)

  // ── B3 · the reader ─────────────────────────────────────────────────────────
  console.log("\n[B3 · manager-ops reads platform-paid spend]")
  const { loadPlatformPaidAiSpend } = await import("../lib/platform/manager-ops")
  const recent = new Date().toISOString()
  const spend = await loadPlatformPaidAiSpend(memSupabase({ ai_tool_usage: [
    { feature: "platform_prospect_chat", cost_cents: 3, platform_paid: true, created_at: recent },
    { feature: "voice_reception_turn", cost_cents: 5, platform_paid: true, created_at: recent },
    { feature: "voice_reception_turn", cost_cents: 7, platform_paid: false, brokerage_id: BRK, created_at: recent },
  ] }) as any)
  ok("sums ONLY platform-paid rows", !!spend && spend.calls === 2 && spend.costCents === 8 && spend.byFeature.voice_reception_turn?.costCents === 5)
  const refused = await loadPlatformPaidAiSpend(memSupabase({ ai_tool_usage: [] }, { missingColumns: { ai_tool_usage: ["platform_paid"] } }) as any)
  ok("CONTROL: a refused read (column absent before m668) → null ('unmeasured'), never 0", refused === null)

  // ── B4 · m668's shape (the rule, not its number or its apply state) ─────────
  console.log("\n[B4 · the migration that lets platform rows land]")
  const mig = readdirSync(join(ROOT, "supabase/migrations")).find((f) => /platform-paid-ai-spend/.test(f))
  ok("a migration adds ai_tool_usage.platform_paid", !!mig)
  if (mig) {
    const sql = read(`supabase/migrations/${mig}`).replace(/--[^\n]*/g, "")
    ok("it widens the anon-rows CHECK by the platform arm only", /check\s*\(\s*user_id is not null or brokerage_id is not null or platform_paid\s*\)/i.test(sql))
    ok("it forbids a platform-paid row from naming a tenant", /check\s*\(\s*not platform_paid or brokerage_id is null\s*\)/i.test(sql))
    const policies = [...sql.matchAll(/create policy[\s\S]*?;/gi)].map((m) => m[0])
    ok(`every recreated tenant policy excludes platform-paid rows (${policies.length})`, policies.length >= 5 && policies.every((p) => /not platform_paid/i.test(p)))
    ok("CONTROL: the live pre-m668 policy text fails that rule", !/not platform_paid/i.test("create policy ai_tool_usage_tenant_select on public.ai_tool_usage for select to authenticated using ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()));"))
  }

  // ── C · "use server" trust gates PROVE the secret ───────────────────────────
  console.log("\n[C · a trusted-internal gate in a \"use server\" file compares a CALLER-SUPPLIED secret]")
  // The defect: `const trusted = !hasSession && !!process.env.CRON_SECRET` — "the
  // deploy has a secret" (true in every real deploy), so any anonymous POST was
  // trusted. Rule: a trust boolean that reads CRON_SECRET must also compare it
  // with `===` to something the caller passed.
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(join(ROOT, d))) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = `${d}/${n}`
      if (statSync(join(ROOT, p)).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(n)) out.push(p)
    }
    return out
  }
  // A declaration's initializer runs until `;` or a newline whose next
  // non-blank character does not continue an expression (TS here is mostly
  // semicolon-free, so `[^;]*` alone would swallow the next statements).
  const initializerOf = (code: string, from: number): string => {
    let i = from
    while (i < code.length) {
      const c = code[i]
      if (c === ";") break
      if (c === "\n") {
        const before = code.slice(from, i).replace(/[ \t]*$/, "")
        const rest = code.slice(i + 1).replace(/^[ \t]*/, "")
        const lineEndsOpen = before === "" || /(&&|\|\||[=?:(,!])$/.test(before)
        if (!lineEndsOpen && !/^(&&|\|\||\?|:|\.|!|===|!==|\()/.test(rest)) break
      }
      i++
    }
    return code.slice(from, i)
  }
  const envOnlyTrust = (src: string): string[] => {
    const code = blankStrings(stripComments(src))
    const out: string[] = []
    for (const m of code.matchAll(/const\s+(\w+)\s*=/g)) {
      const expr = initializerOf(code, (m.index ?? 0) + m[0].length)
      if (!/process\.env\.CRON_SECRET|\bcronSecret\b/.test(expr)) continue
      if (/^\s*process\.env\.CRON_SECRET\s*$/.test(expr)) continue // `const cronSecret = process.env.CRON_SECRET` — a read, not a verdict
      if (!/\bboolean\b|!!|&&|\|\|/.test(expr)) continue // not a trust verdict (e.g. a header value)
      // The SECRET itself must be one side of a strict comparison — an `===`
      // elsewhere in the verdict (e.g. actorUserId === 'system') proves nothing.
      if (!/(process\.env\.CRON_SECRET|\bcronSecret\b)\s*===|===\s*(process\.env\.CRON_SECRET|\bcronSecret\b)/.test(expr)) out.push(m[1])
    }
    return out
  }
  const useServer = [...walk("app"), ...walk("lib")].filter((f) => /^\s*["']use server["']/.test(read(f)))
  const offenders = useServer.flatMap((f) => envOnlyTrust(read(f)).map((v) => `${f}:${v}`))
  ok(`no "use server" trust verdict reads CRON_SECRET without comparing a caller-supplied value (${useServer.length} files scanned)`, offenders.length === 0, offenders.join(", "))
  ok("CONTROL: the pre-86D initiate-engagement gate is caught",
    envOnlyTrust("const hasSession = true\nconst isTrustedInternal = !hasSession && !!process.env.CRON_SECRET;").join() === "isTrustedInternal")
  ok("CONTROL: the pre-86D accept-handoff gate is caught",
    envOnlyTrust("const isSystemCaller =\n    params.actorUserId === 'system' && !!process.env.CRON_SECRET;").length === 1)
  ok("CONTROL: the fixed shape passes",
    envOnlyTrust("const cronSecret = process.env.CRON_SECRET;\nconst isTrustedInternal = !hasSession && !!cronSecret && opts?.internalSecret === cronSecret;").length === 0)
  for (const [f, needle] of [
    ["lib/ai-isa/speed-to-lead.ts", /doLeadEngagement\([^)]*internalSecret:\s*process\.env\.CRON_SECRET/],
    ["lib/ai-isa/convert-buyer-lead-on-intent.ts", /actorUserId:\s*"system",[\s\S]{0,120}internalSecret:\s*process\.env\.CRON_SECRET/],
    ["lib/ai-isa/convert-seller-lead-on-intent.ts", /actorUserId:\s*"system",[\s\S]{0,120}internalSecret:\s*process\.env\.CRON_SECRET/],
    ["app/api/cron/stale-contact-monitor/route.ts", /initiateAIISAContactEngagement\([^)]*internalSecret:\s*process\.env\.CRON_SECRET/],
  ] as Array<[string, RegExp]>) {
    ok(`the sessionless caller ${f} proves the secret`, needle.test(stripComments(read(f))))
  }

  // ── D · lead-stage bells go to the LEAD DESK, never a producing agent ───────
  console.log("\n[D · leadDeskRecipientUserIds — agents never see leads (CLAUDE.md §5)]")
  const { leadDeskRecipientUserIds, LEAD_DESK_USER_TYPES } = await import("../lib/auth/lead-visibility")
  const PRODUCER_AGENT = "a-prod"; const ISA_AGENT = "a-isa"
  const deskWorld = () => memSupabase({
    agents: [{ id: PRODUCER_AGENT, user_id: "u-prod" }, { id: ISA_AGENT, user_id: "u-isa" }],
    users: [
      { id: "u-prod", brokerage_id: BRK, user_type: "agent" },
      { id: "u-isa", brokerage_id: BRK, user_type: "isa" },
      { id: "u-broker", brokerage_id: BRK, user_type: "broker" },
      { id: "u-tl", brokerage_id: BRK, user_type: "team_lead" },
      { id: "u-co", brokerage_id: BRK, user_type: "compliance_officer" },
      { id: "u-other", brokerage_id: OTHER, user_type: "broker" },
    ],
  })
  const viaProducer = await leadDeskRecipientUserIds(deskWorld() as any, BRK, { preferAgentId: PRODUCER_AGENT })
  ok("CONTROL: a lead owned by a PRODUCING agent → that agent is NOT notified", !viaProducer.includes("u-prod"), viaProducer.join())
  // RE-ANCHORED lane 88B (owner, wave 88: "Isa is a system ai ai isa."): these are HUMAN escalations,
  // so the AI ISA seat is no longer a recipient — the rule is "a person on the lead desk", not "isa".
  ok("…the brokerage-wide HUMAN lead desk is (broker; not the AI ISA seat, team_lead of no team, compliance_officer, or another tenant)",
    viaProducer.includes("u-broker") && !viaProducer.includes("u-isa") && !viaProducer.includes("u-tl") && !viaProducer.includes("u-co") && !viaProducer.includes("u-other"))
  const viaIsa = await leadDeskRecipientUserIds(deskWorld() as any, BRK, { preferAgentId: ISA_AGENT })
  ok("a lead the AI ISA seat is working → the human desk, never the ISA itself", !viaIsa.includes("u-isa") && viaIsa.includes("u-broker"), viaIsa.join())
  ok("a refused users read → [] (the bell does not ring; it never falls back to an agent)",
    (await leadDeskRecipientUserIds(memSupabase({ users: [] }, { refuse: { users: "denied" } }) as any, BRK)).length === 0)
  ok("rule: the desk is derived from LEAD_DESK_USER_TYPES (no producer type in it)", !LEAD_DESK_USER_TYPES.has("agent"))
  for (const f of ["lib/ai-isa/tools.ts", "lib/ai-isa/conversation-handler.ts", "app/actions/ai-isa/initiate-engagement.ts"]) {
    const s = stripComments(read(f))
    ok(`rule: ${f} addresses its lead-stage bell through leadDeskRecipientUserIds`, /leadDeskRecipientUserIds\(/.test(s))
  }
  const toolsSrc = stripComments(read("lib/ai-isa/tools.ts"))
  const esc = toolsSrc.slice(toolsSrc.indexOf("escalate_to_agent: tool("), toolsSrc.indexOf("mark_qualification: tool("))
  ok("rule: escalate_to_agent no longer pages leads.agent_id's user directly", !/from\("agents"\)\.select\("user_id"\)/.test(esc))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
