#!/usr/bin/env tsx
/**
 * scripts/voice-direct-mail-door-simulator.ts
 *
 * test:voice-direct-mail-door — THE VOICE AGENT CAN FILE A DIRECT MAIL CAMPAIGN, AS THE
 * SESSION ROW'S USER, IN THE SESSION ROW'S TENANT, AND NOBODY ELSE CAN (wave 85D; owner:
 * "fix voice agent direct mail").
 *
 * THE DEFECT. The ElevenLabs tool webhook (app/api/agent-assistant/tool-call) has no cookie
 * session. It authenticates by a shared secret header and attributes the call through
 * conversation_id → agent_assistant_sessions. stage_direct_mail_campaign reached the
 * "use server" action app/actions/ai-direct-mail.ts createDirectMailCampaign, which reads
 * the COOKIE session (getAgentContext) and so answered every spoken request "Not signed
 * in" (lane84E's unresolved door). Under the action, the feature gate also read through the
 * cookie client, which is anon in a webhook, and feature_flags is readable by
 * `authenticated` only.
 *
 * THE FIX. There is ONE creator, lib/kernel/marketing.ts createDirectMailCampaign. The actor
 * is VERIFIED by each door (the cookie session for the actions, the session row for the
 * webhook). The kernel resolves agents.id itself, counts its insert, mints the tracked QR,
 * gates through the caller's client and books the usage row. The duplicates merged onto it
 * with tombstones.
 *
 * LAYERS
 *   BEHAVIOUR: the REAL POST handler, the REAL content-staging and kernel, against an
 *     in-memory PostgREST world with the live FKs (agent_id → agents, created_by → users,
 *     qr_codes.agent_id → agents). No network, no creds.
 *   SOURCE: rules over stripped/blanked source (scripts/strip-comments.ts): the voice
 *     handler's actor comes from `session.`, never `params.`; no door that a webhook can
 *     reach calls a cookie-session action for direct mail; every kernel call passes ctx;
 *     the user-authored doors carry no raw direct_mail_campaigns insert.
 *
 * POSITIVE CONTROLS (a green run proves these still bite):
 *   · unsigned / wrong-secret webhook → 403, and ZERO database operations
 *   · body brokerage_id / brokerageId / agent_id / user_id naming tenant B → IGNORED (row is A's)
 *   · the SESSION door, in the same no-cookie world, still refuses "Not signed in": the
 *     voice success is not an artifact of a faked cookie session
 *   · canAccessFeature WITHOUT the client, in that world, refuses: the reason the seam exists
 *   · a users id offered as agent_id is refused by the fake FK (23503), so the FK is live in
 *     the fake and agent_id=agents.id is a real result
 *   · an insert that returns no row is REFUSED, never "created"
 *   · another tenant's tenant-wide override does not reach this tenant under the service
 *     client; this tenant's own override does
 *   · source rules run against the pre-85D specimens and must flag them
 *
 * Run: npx tsx --conditions=react-server scripts/voice-direct-mail-door-simulator.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0
let fail = 0
const failures: string[] = []
const findings: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
function finding(name: string) { findings.push(name); console.log(`  ⚠ FINDING ${name}`) }

// ─────────────────────────────────────────────────────────────────────────────
// MODULE INTERCEPTION — the real route/staging/kernel run; only the edges are faked
// ─────────────────────────────────────────────────────────────────────────────
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__VDM.service(...a)",
  // NO COOKIE SESSION: what a webhook's cookie client is: anon, no user, RLS hides rows.
  "@/lib/supabase/server": "export const createClient = async (...a) => globalThis.__VDM.anon(...a)",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f",
}
const STUB_BY_PATH: Array<[RegExp, string]> = [
  [/\/lib\/kernel\/notification-engine\.ts$/, "export const processKernelEvent = async (p) => globalThis.__VDM.event(p)"],
]
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const bySpec = STUB_BY_SPEC[spec]
    if (bySpec !== undefined) return { url: `data:text/javascript,${encodeURIComponent(bySpec)}`, shortCircuit: true }
    const r = next(spec, ctx)
    for (const [re, body] of STUB_BY_PATH) {
      if (re.test(r.url ?? "")) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    }
    return r
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// THE WORLD — an in-memory PostgREST with the live FKs that matter here
// ─────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>
interface Op { table: string; op: string; payload?: unknown }
interface World {
  tables: Record<string, Row[]>
  ops: Op[]
  events: Row[]
  /** tables whose insert silently returns no row (a RLS-hidden return / eaten write) */
  insertReturnsNothing: Set<string>
}
let world: World
let idSeq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`

const FKS: Array<{ table: string; col: string; ref: string }> = [
  { table: "direct_mail_campaigns", col: "agent_id", ref: "agents" },
  { table: "direct_mail_campaigns", col: "created_by", ref: "users" },
  { table: "direct_mail_campaigns", col: "brokerage_id", ref: "brokerages" },
  { table: "qr_codes", col: "agent_id", ref: "agents" },
]

function fkError(table: string, row: Row): { code: string; message: string } | null {
  for (const fk of FKS) {
    if (fk.table !== table) continue
    const v = row[fk.col]
    if (v === null || v === undefined) continue
    if (!(world.tables[fk.ref] ?? []).some((r) => r.id === v)) {
      return { code: "23503", message: `insert or update on table "${table}" violates foreign key constraint "${table}_${fk.col}_fkey"` }
    }
  }
  return null
}

type Filter = (r: Row) => boolean
function parseOr(expr: string): Filter {
  const arms = expr.split(",").map((a) => a.trim())
  const fs: Filter[] = arms.map((arm) => {
    const m = /^(\w+)\.(not\.)?(eq|is)\.(.+)$/.exec(arm)
    if (!m) return () => false
    const [, col, not, op, raw] = m
    const val = raw === "null" ? null : raw
    const base: Filter = op === "is" ? (r) => (r[col] ?? null) === val : (r) => String(r[col]) === String(val)
    return not ? (r) => !base(r) : base
  })
  return (r) => fs.some((f) => f(r))
}

class Query {
  private filters: Filter[] = []
  private op: "select" | "insert" | "update" | "delete" = "select"
  private payload: any = null
  private returning = false
  private mode: "many" | "maybe" | "single" = "many"
  private lim: number | null = null
  private head = false
  constructor(private db: "service" | "anon", private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") { this.head = !!opts?.head } else this.returning = true
    return this
  }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this }
  upsert(rows: Row | Row[]) { return this.insert(rows) }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this }
  delete() { this.op = "delete"; return this }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this }
  lte(c: string, v: any) { this.filters.push((r) => r[c] <= v); return this }
  gt(c: string, v: any) { this.filters.push((r) => r[c] > v); return this }
  lt(c: string, v: any) { this.filters.push((r) => r[c] < v); return this }
  not(c: string, op: string, v: unknown) {
    this.filters.push((r) => !(op === "is" ? (r[c] ?? null) === v : r[c] === v)); return this
  }
  or(expr: string) { this.filters.push(parseOr(expr)); return this }
  ilike() { return this }
  like() { return this }
  contains() { return this }
  order() { return this }
  range() { return this }
  limit(n: number) { this.lim = n; return this }
  maybeSingle() { this.mode = "maybe"; return this }
  single() { this.mode = "single"; return this }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    try { return Promise.resolve(this.run()).then(res, rej) } catch (e) { return rej ? rej(e) : Promise.reject(e) }
  }
  private shape(rows: Row[]) {
    if (this.head) return { data: null, error: null, count: rows.length }
    if (this.mode === "many") return { data: rows, error: null, count: rows.length }
    if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } }
    if (this.mode === "single" && rows.length === 0) return { data: null, error: { code: "PGRST116", message: "0 rows" } }
    return { data: rows[0] ?? null, error: null }
  }
  private run() {
    world.ops.push({ table: this.table, op: `${this.db}:${this.op}`, payload: this.payload })
    // The anon client (no cookie session): every table is RLS-hidden, every write refused.
    if (this.db === "anon") {
      if (this.op === "select") return this.shape([])
      return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } }
    }
    const t = (world.tables[this.table] ??= [])
    const match = (r: Row) => this.filters.every((f) => f(r))
    if (this.op === "select") {
      let rows = t.filter(match)
      if (this.lim !== null) rows = rows.slice(0, this.lim)
      return this.shape(rows.map((r) => ({ ...r })))
    }
    if (this.op === "insert") {
      const out: Row[] = []
      for (const raw of this.payload as Row[]) {
        const row = { id: raw.id ?? uuid(), ...raw }
        const fk = fkError(this.table, row)
        if (fk) return { data: null, error: fk }
        t.push(row)
        out.push({ ...row })
      }
      if (world.insertReturnsNothing.has(this.table)) return this.returning ? this.shape([]) : { data: null, error: null }
      return this.returning ? this.shape(out) : { data: null, error: null }
    }
    if (this.op === "update") {
      const hit = t.filter(match)
      for (const r of hit) {
        const next = { ...r, ...(this.payload as Row) }
        const fk = fkError(this.table, next)
        if (fk) return { data: null, error: fk }
        Object.assign(r, this.payload)
      }
      return this.returning ? this.shape(hit.map((r) => ({ ...r }))) : { data: null, error: null }
    }
    const gone = t.filter(match)
    world.tables[this.table] = t.filter((r) => !match(r))
    return this.returning ? this.shape(gone) : { data: null, error: null }
  }
}
function client(db: "service" | "anon") {
  return {
    from: (table: string) => new Query(db, table),
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    storage: { from: () => ({ upload: async () => ({ data: null, error: { message: "no storage" } }) }) },
  }
}
;(globalThis as any).__VDM = {
  service: () => client("service"),
  anon: () => client("anon"),
  event: async (p: Row) => { world.events.push(p); return { success: true } },
}

// Two tenants. A is the speaker's; B is the one a hostile body names.
const A = { brokerage: "b0000000-0000-4000-8000-00000000000a", user: "u0000000-0000-4000-8000-00000000000a", agent: "a0000000-0000-4000-8000-00000000000a" }
const B = { brokerage: "b0000000-0000-4000-8000-00000000000b", user: "u0000000-0000-4000-8000-00000000000b", agent: "a0000000-0000-4000-8000-00000000000b" }
const CONV = "conv_85d_voice"
const SECRET = "85d-tool-secret"

function freshWorld(opts: { agentRowForA?: boolean; flagEnabled?: boolean } = {}): void {
  const agentRowForA = opts.agentRowForA ?? true
  world = {
    ops: [], events: [], insertReturnsNothing: new Set(),
    tables: {
      brokerages: [{ id: A.brokerage, plan_tier: "brokerage" }, { id: B.brokerage, plan_tier: "brokerage" }],
      users: [
        { id: A.user, user_type: "agent", brokerage_id: A.brokerage, team_id: null, platform_role: null },
        { id: B.user, user_type: "agent", brokerage_id: B.brokerage, team_id: null, platform_role: null },
      ],
      agents: [
        ...(agentRowForA ? [{ id: A.agent, user_id: A.user, brokerage_id: A.brokerage, created_at: "2026-01-01" }] : []),
        { id: B.agent, user_id: B.user, brokerage_id: B.brokerage, created_at: "2026-01-01" },
      ],
      feature_flags: [{
        feature_key: "direct_mail", enabled: opts.flagEnabled ?? true, superadmin_only: false,
        solo_agent_access: true, team_access: true, brokerage_access: true, multi_location_access: true,
        solo_agent_limit: null, team_limit: null, brokerage_limit: null, multi_location_limit: null,
        beta: false, deprecated: false, sunset_date: null, rollout_percentage: null,
      }],
      feature_access_overrides: [],
      agent_assistant_sessions: [{
        id: "s0000000-0000-4000-8000-00000000000a", brokerage_id: A.brokerage, agent_id: A.agent, user_id: A.user,
        conversation_id: CONV, tool_call_count: 0, ended_at: null, started_at: new Date().toISOString(),
      }],
      direct_mail_campaigns: [], qr_codes: [], feature_usage_tracking: [], agent_assistant_tool_calls: [],
      platform_controls: [], marketing_campaigns: [],
    },
  }
}

async function postTool(headers: Record<string, string>, body: unknown) {
  const { POST } = await import("../app/api/agent-assistant/tool-call/route")
  const { NextRequest } = await import("next/server")
  const req = new NextRequest("http://localhost/api/agent-assistant/tool-call", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })
  const res = await POST(req)
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const HOSTILE_PARAMS = {
  campaign_name: "Spring past-client postcards",
  target_audience: "past_clients",
  piece_type: "postcard_6x9",
  budget: 79,
  copy_text: "Hi neighbor, spring is a great time to talk about your home, whenever you're ready.",
  // Everything below is the body trying to pick the tenant / identity. None of it may be read.
  brokerage_id: B.brokerage, brokerageId: B.brokerage, agent_id: B.agent, agentId: B.agent,
  user_id: B.user, userId: B.user, created_by: B.user,
}

async function behaviour() {
  process.env.AGENT_ASSISTANT_TOOL_SECRET = SECRET
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test"

  console.log("\n── control: an UNSIGNED or wrong-secret webhook is refused before any read ──")
  for (const [label, headers] of [["no secret header", {}], ["wrong secret", { "x-elevenlabs-tool-secret": "nope" }]] as const) {
    freshWorld()
    const r = await postTool(headers as Record<string, string>, { conversation_id: CONV, tool_name: "stage_direct_mail_campaign", parameters: HOSTILE_PARAMS })
    ok(`${label}: 403 and zero database operations (${world.ops.length} ops)`, r.status === 403 && world.ops.length === 0,
      `status ${r.status}, ops ${world.ops.map((o) => o.table + ":" + o.op).join(",")}`)
    ok(`${label}: no direct_mail_campaigns row`, world.tables.direct_mail_campaigns.length === 0)
  }

  console.log("\n── the signed voice call files the campaign AS THE SESSION ROW, body ids ignored ──")
  freshWorld()
  const r = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_direct_mail_campaign", parameters: HOSTILE_PARAMS })
  const res = r.json?.result ?? {}
  const rows = world.tables.direct_mail_campaigns
  const row = rows[0] ?? {}
  ok("200, tool result success (no longer \"Not signed in\")", r.status === 200 && res.success === true, JSON.stringify(res).slice(0, 300))
  ok("exactly one direct_mail_campaigns row", rows.length === 1, `rows ${rows.length}`)
  ok("brokerage_id is the SESSION ROW's tenant A — body brokerage_id/brokerageId (B) ignored",
    row.brokerage_id === A.brokerage, `got ${row.brokerage_id}`)
  ok("agent_id is A's AGENTS id (resolved users→agents, tenant-pinned), not the body's agent_id and not a users id",
    row.agent_id === A.agent, `got ${row.agent_id}`)
  ok("created_by is the session row's USERS id, not the body's user_id",
    row.created_by === A.user, `got ${row.created_by}`)
  ok("nothing was written under tenant B", !JSON.stringify(world.tables).includes(`"brokerage_id":"${B.brokerage}","agent_id"`) &&
    rows.every((x) => x.brokerage_id !== B.brokerage) && world.tables.qr_codes.every((q) => q.brokerage_id !== B.brokerage))
  ok("spoken piece 'postcard_6x9' folded onto the column vocabulary ('postcard')", row.piece_type === "postcard", `got ${row.piece_type}`)
  ok("dictated copy is the campaign copy (it used to be dropped)", row.copy_text === HOSTILE_PARAMS.copy_text, `got ${row.copy_text}`)
  ok("status planning: staged, nothing prints or mails", row.status === "planning")
  ok("budget economics priced it ($79 → 100 pieces at $0.79)", row.quantity === 100 && row.per_piece_cost === 0.79,
    `quantity ${row.quantity}, per ${row.per_piece_cost}`)
  const qr = world.tables.qr_codes[0] ?? {}
  ok("a tracked QR was minted in tenant A under A's agents id, and reverse-linked (qr_code_id)",
    world.tables.qr_codes.length === 1 && qr.brokerage_id === A.brokerage && qr.agent_id === A.agent && row.qr_code_id === qr.id && !!row.tracking_id,
    JSON.stringify({ qr, link: row.qr_code_id, tracking: row.tracking_id }))
  const usage = world.tables.feature_usage_tracking[0] ?? {}
  ok("the direct_mail usage row is booked to the session user in tenant A",
    world.tables.feature_usage_tracking.length === 1 && usage.user_id === A.user && usage.brokerage_id === A.brokerage && usage.feature_key === "direct_mail")
  ok("DIRECT_MAIL_CAMPAIGN_CREATED emitted once, for tenant A",
    world.events.length === 1 && world.events[0].brokerageId === A.brokerage && world.events[0].entityId === row.id)
  ok("the tool result deep-links the staged campaign", typeof res.openUrl === "string" && res.openUrl.includes(String(row.id)), String(res.openUrl))
  ok("the audit row is stamped with the session tenant", world.tables.agent_assistant_tool_calls.length === 1 &&
    world.tables.agent_assistant_tool_calls[0].brokerage_id === A.brokerage)
  ok("the cookie (anon) client was never used to write", !world.ops.some((o) => o.op.startsWith("anon:") && !o.op.endsWith("select")))

  console.log("\n── a session user with NO agents row files agent_id NULL, never the users id ──")
  freshWorld({ agentRowForA: false })
  world.tables.agent_assistant_sessions[0].agent_id = null
  const r2 = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_direct_mail_campaign", parameters: HOSTILE_PARAMS })
  const row2 = world.tables.direct_mail_campaigns[0] ?? {}
  ok("filed, agent_id NULL, created_by the users id", r2.json?.result?.success === true && row2.agent_id === null && row2.created_by === A.user,
    JSON.stringify({ res: r2.json?.result, agent: row2.agent_id }))

  console.log("\n── the feature gate still gates (through the verified client) ──")
  freshWorld({ flagEnabled: false })
  const r3 = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_direct_mail_campaign", parameters: HOSTILE_PARAMS })
  ok("flag disabled → refused, no row", r3.json?.result?.success === false && world.tables.direct_mail_campaigns.length === 0,
    JSON.stringify(r3.json?.result))

  console.log("\n── an insert that comes back with no row is REFUSED, never announced ──")
  freshWorld()
  world.insertReturnsNothing.add("direct_mail_campaigns")
  const r4 = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_direct_mail_campaign", parameters: HOSTILE_PARAMS })
  ok("counted insert: 0 rows returned → success:false, no QR minted, no event",
    r4.json?.result?.success === false && world.tables.qr_codes.length === 0 && world.events.length === 0,
    JSON.stringify(r4.json?.result))

  console.log("\n── an unknown conversation is not attributed to anyone ──")
  freshWorld()
  world.tables.agent_assistant_sessions[0].started_at = "2020-01-01T00:00:00Z"
  world.tables.agent_assistant_sessions[0].conversation_id = null
  const r5 = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: "conv_unknown", tool_name: "stage_direct_mail_campaign", parameters: HOSTILE_PARAMS })
  ok("no session row in window → refused, no row", !!r5.json?.result?.error && world.tables.direct_mail_campaigns.length === 0, JSON.stringify(r5.json))

  console.log("\n── positive controls: the no-cookie world is real ──")
  freshWorld()
  const { createDirectMailCampaign: sessionDoor } = await import("../app/actions/ai-direct-mail")
  const sd = await sessionDoor({ brokerageId: A.brokerage, campaignName: "x", targetAudience: "y", mailingType: "postcard" }) as any
  ok("control: the SESSION door in this world refuses \"Not signed in\" (the pre-85D voice outcome)",
    sd?.success === false && /Not signed in/.test(String(sd?.error)) && world.tables.direct_mail_campaigns.length === 0, JSON.stringify(sd))
  const { canAccessFeature } = await import("../lib/kernel/0.1-feature-access")
  const anonGate = await canAccessFeature(A.user, "direct_mail")
  const svcGate = await canAccessFeature(A.user, "direct_mail", undefined, client("service") as any)
  ok("control: the gate through the cookie client (anon here) REFUSES; through the verified client it ALLOWS",
    anonGate.allowed === false && svcGate.allowed === true, JSON.stringify({ anonGate, svcGate }))

  console.log("\n── FK is live in the fake: a users id in agent_id is 23503 ──")
  freshWorld()
  const { data: _d, error: fkErr } = await client("service").from("direct_mail_campaigns")
    .insert({ brokerage_id: A.brokerage, agent_id: A.user, created_by: A.user, campaign_name: "x", target_audience: "y", quantity: 1, status: "planning" }).select() as any
  ok("control: agent_id = users id is refused 23503 (the class error the kernel can no longer make)", fkErr?.code === "23503")

  console.log("\n── the service-client gate is pinned to the user's tenant (FEATURE_OVERRIDE_TENANT_PIN) ──")
  freshWorld()
  world.tables.feature_access_overrides.push({ feature_key: "direct_mail", override_type: "disabled", trial_ends_at: null,
    disabled_reason: "tenant B disabled mail", user_id: null, team_id: null, brokerage_id: B.brokerage, created_at: "2026-09-26" })
  const pinned = await canAccessFeature(A.user, "direct_mail", undefined, client("service") as any)
  ok("tenant B's tenant-wide disable does NOT reach tenant A's user", pinned.allowed === true, JSON.stringify(pinned))
  world.tables.feature_access_overrides.push({ feature_key: "direct_mail", override_type: "disabled", trial_ends_at: null,
    disabled_reason: "tenant A disabled mail", user_id: null, team_id: null, brokerage_id: A.brokerage, created_at: "2026-09-26" })
  const own = await canAccessFeature(A.user, "direct_mail", undefined, client("service") as any)
  ok("control: tenant A's OWN disable does (the pin is not blind)", own.allowed === false, JSON.stringify(own))

  console.log("\n── the kernel refuses what it cannot file honestly ──")
  freshWorld()
  const { createDirectMailCampaign: kernel } = await import("../lib/kernel/marketing")
  const noActor = await kernel({ ctx: { userId: "", brokerageId: A.brokerage }, campaignName: "x", targetAudience: "y", quantity: 1 })
  const foreignAgent = await kernel({ ctx: { userId: A.user, brokerageId: A.brokerage, agentId: B.agent }, campaignName: "x", targetAudience: "y", quantity: 1 })
  const usersAsAgent = await kernel({ ctx: { userId: A.user, brokerageId: A.brokerage, agentId: A.user }, campaignName: "x", targetAudience: "y", quantity: 1 })
  const badPiece = await kernel({ ctx: { userId: A.user, brokerageId: A.brokerage }, campaignName: "x", targetAudience: "y", quantity: 1, pieceType: "brochure" })
  ok("no verified user → refused (fail closed)", noActor.success === false)
  ok("an agents id from ANOTHER tenant → refused", foreignAgent.success === false && /not an agents row/.test(String(foreignAgent.error)))
  ok("a users id offered as agentId → refused before the FK", usersAsAgent.success === false && /not an agents row/.test(String(usersAsAgent.error)))
  ok("an unfoldable piece type → refused, not written (§6)", badPiece.success === false && /piece type/.test(String(badPiece.error)))
  ok("none of the four refusals wrote a row", world.tables.direct_mail_campaigns.length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE RULES (stripped / blanked source — a tombstone is not a call site)
// ─────────────────────────────────────────────────────────────────────────────
function balanced(code: string, open: number): string {
  const o = code[open]; const c = o === "{" ? "}" : ")"
  let d = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) d++
    else if (code[i] === c) { d--; if (d === 0) return code.slice(open, i + 1) }
  }
  return code.slice(open)
}
function fnBody(code: string, name: string): string | null {
  const m = new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`).exec(code)
  if (!m) return null
  const params = balanced(code, m.index + m[0].length - 1)
  // Skip a return-type annotation: a `{` inside `<…>` (Promise<{ … }>) or directly after
  // `:` / `|` / `&` is a type literal, not the body.
  let angle = 0
  for (let i = m.index + m[0].length - 1 + params.length; i < code.length; i++) {
    const ch = code[i]
    if (ch === "<") angle++
    else if (ch === ">" && code[i - 1] !== "=") angle--
    else if (ch === "{") {
      const prev = code.slice(0, i).trimEnd().slice(-1)
      if (angle > 0 || prev === ":" || prev === "|" || prev === "&") { i += balanced(code, i).length - 1; continue }
      return balanced(code, i)
    }
  }
  return null
}

/** R1 — the voice handler's actor comes from the session row; params never name an id. */
export function voiceActorViolations(body: string): string[] {
  const v: string[] = []
  const call = /stageDirectMailCampaign\(\s*\{([^}]*)\}/.exec(body)
  if (!call) return ["stageDirectMailCampaign(ctx, …) call not found"]
  if (!/brokerageId:\s*session\.brokerage_id/.test(call[1])) v.push("ctx.brokerageId is not session.brokerage_id")
  if (!/userId:\s*session\.user_id/.test(call[1])) v.push("ctx.userId is not session.user_id")
  for (const m of body.matchAll(/params\s*(?:\.\s*|\[\s*)(brokerage_?[iI]d|agent_?[iI]d|user_?[iI]d|created_?[bB]y)/g)) v.push(`reads params.${m[1]} (the body)`)
  return v
}

/** R2 — a helper the webhook reaches must not call a cookie-session ("use server") direct-mail door. */
export function sessionBoundDoorViolations(body: string): string[] {
  const v: string[] = []
  for (const m of body.matchAll(/import\(\s*"(@\/app\/actions\/[^"]+)"\s*\)/g)) v.push(`imports ${m[1]} (a cookie-session "use server" door)`)
  return v
}

/** R3 — every call of the kernel creator hands it a ctx. */
export function kernelCallsWithoutCtx(code: string, localName: string): number {
  let n = 0
  for (const m of code.matchAll(new RegExp(`(?<![\\w.$])${localName}\\s*\\(`, "g"))) {
    const before = code.slice(Math.max(0, m.index! - 30), m.index!)
    if (/function\s+$/.test(before)) continue
    const args = balanced(code, m.index! + m[0].length - 1)
    if (!/^\(\s*\{\s*ctx\s*:/.test(args)) n++
  }
  return n
}

function source() {
  console.log("\n── R1: the voice handler's actor is the session row, never the body ──")
  const route = blankStrings(read("app/api/agent-assistant/tool-call/route.ts"))
  const vbody = fnBody(route, "stageDirectMailCampaignVoice")
  ok("stageDirectMailCampaignVoice found", !!vbody)
  const v1 = voiceActorViolations(vbody ?? "")
  ok("ctx = { session.brokerage_id, session.user_id }; no params.* id read", v1.length === 0, v1.join("; "))
  ok("the secret check precedes the first database read in POST",
    (() => { const p = fnBody(route, "POST") ?? ""; const s = p.search(/secretMatches\(/); const d = p.search(/\.from\(/); return s >= 0 && d > s })())

  console.log("\n── R2: the webhook-reachable staging helper files through the kernel, not a session door ──")
  // stripComments, NOT blankStrings: the module specifier inside import("…") IS the signal.
  const staging = stripComments(read("lib/wizard-staging/content-staging.ts"))
  const sbody = fnBody(staging, "stageDirectMailCampaign")
  ok("stageDirectMailCampaign found", !!sbody)
  const v2 = sessionBoundDoorViolations(sbody ?? "")
  ok("stageDirectMailCampaign imports no @/app/actions door", v2.length === 0, v2.join("; "))
  ok("stageDirectMailCampaign imports the kernel creator", /import\(\s*"@\/lib\/kernel\/marketing"\s*\)/.test(sbody ?? ""))

  // The census 85D published as a FINDING (5/8) is a RULE since wave 85F closed it: every voice
  // stage_* helper files through a server-only kernel creator (lib/kernel/content-creators.ts
  // for the other five; behaviour proven by test:voice-stage-doors). Derived, not pinned: the
  // denominator is whatever stage_* helpers exist.
  const helpers = [...staging.matchAll(/export\s+async\s+function\s+(stage\w+)\s*\(/g)].map((m) => m[1])
  const bound = helpers.filter((h) => sessionBoundDoorViolations(fnBody(staging, h) ?? "").length > 0)
  console.log(`  · census: ${bound.length} of ${helpers.length} staging helpers import a cookie-session door: ${bound.join(", ") || "none"}`)
  ok(`0/${helpers.length} voice stage_* helpers reach a cookie-session "use server" door`, helpers.length > 0 && bound.length === 0, bound.join(", "))
  if (bound.length > 0) finding(`${bound.length}/${helpers.length} voice stage_* helpers reach a cookie-session "use server" door (${bound.join(", ")})`)
  // POSITIVE CONTROL for the census itself: a fixture helper that reaches a cookie door is
  // counted, so the 0 above is a clean tree and not a blind finder.
  const fixture = stripComments(`export async function stageFixtureDraft(ctx, intake) {
    const { saveBlogPost } = await import("@/app/actions/blog")
    return saveBlogPost({ title: intake.title })
  }
  export async function stageFixtureClean(ctx, intake) {
    const { createBlogPostDraft } = await import("@/lib/kernel/content-creators")
    return createBlogPostDraft({ ctx, title: intake.title })
  }`)
  const fixtureHelpers = [...fixture.matchAll(/export\s+async\s+function\s+(stage\w+)\s*\(/g)].map((m) => m[1])
  const fixtureBound = fixtureHelpers.filter((h) => sessionBoundDoorViolations(fnBody(fixture, h) ?? "").length > 0)
  ok("control: the census flags exactly the fixture helper that reaches a cookie door (1/2)",
    fixtureHelpers.length === 2 && fixtureBound.length === 1 && fixtureBound[0] === "stageFixtureDraft", fixtureBound.join(","))

  console.log("\n── R3: every kernel-creator call carries ctx; the user-authored doors carry no raw insert ──")
  const DOORS = [
    ["app/actions/direct-mail.ts", "createMailCampaign"],
    ["app/actions/ai-direct-mail.ts", "createDirectMailCampaign"],
    ["lib/wizard-staging/content-staging.ts", "stageDirectMailCampaign"],
    ["app/actions/neighbor-notifications.ts", "launchNeighborNotification"],
  ] as const
  for (const [file, fn] of DOORS) {
    const code = stripComments(read(file))
    const body = fnBody(blankStrings(read(file)), fn) ?? ""
    ok(`${file} ${fn}: no raw .from("direct_mail_campaigns").insert(`,
      !/\.from\(\s*"direct_mail_campaigns"\s*\)\s*\.insert\(/.test(fnBody(code, fn) ?? "x"))
    const alias = /createDirectMailCampaign\s+as\s+(\w+)/.exec(code)?.[1]
    const local = alias ?? "createDirectMailCampaign"
    const calls = [...body.matchAll(new RegExp(`(?<![\\w.$])${local}\\s*\\(`, "g"))].length
    ok(`${file} ${fn}: calls the kernel creator (${calls}) and every call passes ctx`, calls >= 1 && kernelCallsWithoutCtx(body, local) === 0)
  }

  // Denominator: every raw direct_mail_campaigns insert left in app/ lib/ (stripped source).
  const files: string[] = []
  const walk = (d: string) => {
    let es: string[] = []
    try { es = readdirSync(d) } catch { return }
    for (const e of es) {
      if (e === "node_modules" || e.startsWith(".")) continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".d.ts")) files.push(p)
    }
  }
  walk(join(ROOT, "app")); walk(join(ROOT, "lib"))
  const inserters: string[] = []
  for (const abs of files) {
    const raw = readFileSync(abs, "utf8")
    if (!raw.includes("direct_mail_campaigns")) continue
    const code = stripComments(raw)
    const n = [...code.matchAll(/\.from\(\s*"direct_mail_campaigns"\s*\)\s*\.insert\(/g)].length
    if (n > 0) inserters.push(`${abs.slice(ROOT.length + 1)}${n > 1 ? ` ×${n}` : ""}`)
  }
  const useServerInserters = inserters.filter((f) => /^\s*["']use server["']/.test(read(f.replace(/ ×\d+$/, ""))))
  console.log(`  · census: ${inserters.length} files still insert direct_mail_campaigns directly: ${inserters.join(", ")}`)
  ok("the kernel is among them (the finder is not blind — positive control)", inserters.some((f) => f.startsWith("lib/kernel/marketing.ts")))
  ok(`no "use server" door inserts direct_mail_campaigns raw (${useServerInserters.length})`, useServerInserters.length === 0, useServerInserters.join(", "))

  console.log("\n── positive controls: the pre-85D shapes are flagged ──")
  const oldVoice = blankStrings(`async function stageDirectMailCampaignVoice(params, session) {
    return stageDirectMailCampaign({ brokerageId: String(params.brokerage_id), userId: session.user_id }, {})
  }`)
  ok("control: a body-supplied brokerage_id in the voice ctx is flagged",
    voiceActorViolations(fnBody(oldVoice, "stageDirectMailCampaignVoice") ?? "").length >= 2)
  const oldStaging = stripComments(`export async function stageDirectMailCampaign(ctx, intake) {
    const { createDirectMailCampaign } = await import("@/app/actions/ai-direct-mail")
    return createDirectMailCampaign({ brokerageId: ctx.brokerageId })
  }`)
  ok("control: the old staging helper (cookie-session action) is flagged",
    sessionBoundDoorViolations(fnBody(oldStaging, "stageDirectMailCampaign") ?? "").length === 1)
  ok("control: a kernel call without ctx is counted",
    kernelCallsWithoutCtx(`fileDirectMailCampaign({ campaignName: "x" })`, "fileDirectMailCampaign") === 1)
  const oldDoor = stripComments(`export async function createMailCampaign(p) {\n  await supabase.from("direct_mail_campaigns").insert({ agent_id: p.agentId })\n}`)
  ok("control: a raw insert in a door is found", /\.from\(\s*"direct_mail_campaigns"\s*\)\s*\.insert\(/.test(fnBody(oldDoor, "createMailCampaign") ?? ""))
  const tomb = stripComments(`// .from("direct_mail_campaigns").insert({ agent_id: users.id })\nconst x = 1`)
  ok("control: a tombstone naming the old insert is NOT an insert", !/\.from\(\s*"direct_mail_campaigns"\s*\)\s*\.insert\(/.test(tomb))
}

async function main() {
  await behaviour()
  source()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`VOICE DIRECT MAIL DOOR — ${pass} passed, ${fail} failed, ${findings.length} finding(s)`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("OK — the voice agent files direct mail as the session row's user, in its tenant; the body cannot pick either")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
