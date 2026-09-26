#!/usr/bin/env tsx
/**
 * scripts/voice-stage-doors-simulator.ts
 *
 * test:voice-stage-doors — THE VOICE AGENT CAN STAGE A NEWSLETTER, AN EMAIL CAMPAIGN, A BLOG
 * DRAFT, A PODCAST EPISODE AND A VIDEO PROJECT, AS THE SESSION ROW'S USER, IN THE SESSION
 * ROW'S TENANT, AND THE BODY CANNOT PICK EITHER (wave 85F; lane 85D's FINDING "5/8 voice
 * stage_* helpers reach a cookie-session "use server" door").
 *
 * THE DEFECT. The ElevenLabs tool webhook has no cookie session. stageNewsletterDraft,
 * stageEmailCampaign, stageBlogDraft, stagePodcastEpisode and stageVideoProject reached
 * "use server" actions that read the COOKIE session, so every spoken request was refused
 * ("Unauthorized" / "Not authenticated" / "Missing agent context"), or wrote through the anon
 * client and was refused by RLS; blog and podcast then fell back to raw service-role inserts
 * that skipped the gate and the counter.
 *
 * THE FIX. One server-only creator per type, lib/kernel/content-creators.ts, fed a VERIFIED
 * ctx: the voice session row (via content-staging) or the cookie session (the actions, which
 * keep their session gate and call the same creator).
 *
 * LAYERS
 *   BEHAVIOUR: the REAL POST handler, REAL content-staging, REAL kernel creators and the REAL
 *     compliance module (lib/video/script-compliance.ts), against an in-memory PostgREST with
 *     the live FKs (agent_id → agents, created_by/agent_user_id → users). Only the model calls,
 *     the outbound evaluator and the event bus are stubbed. No network.
 *   SOURCE (stripped/blanked, scripts/strip-comments.ts): no stage_* helper imports an
 *     @/app/actions door (0/8, with a fixture that must be flagged); every voice handler builds
 *     ctx from `session.`; each session door calls the kernel creator; each writer carries the
 *     compliance-first system prompt AND the post-check.
 *
 * POSITIVE CONTROLS (a green run proves these still bite): unsigned → 403 with zero DB ops;
 *   every session door refuses in the same no-cookie world; a blocking phrase in the podcast
 *   and newsletter drafts refuses them and a red-flag dictated video script is HELD for a
 *   human; a users id or another tenant's agents id offered as agentId is refused; the fake FK
 *   refuses a users id in agent_id (23503); a zero-row insert is refused; the source finder
 *   flags the pre-85F staging shape.
 *
 * Run: npx tsx --conditions=react-server scripts/voice-stage-doors-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE INTERCEPTION — only the model calls, the evaluator and the event bus are faked
// ─────────────────────────────────────────────────────────────────────────────
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__VSD.service(...a)",
  // NO COOKIE SESSION: what a webhook's cookie client is — anon, no user, RLS hides rows.
  "@/lib/supabase/server": "export const createClient = async (...a) => globalThis.__VSD.anon(...a); export const createServerClient = async (...a) => globalThis.__VSD.anon(...a)",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f",
  "@/lib/ai/generate": "export const generateObject = async (a) => globalThis.__VSD.generateObject(a); export const generateText = async () => ({ text: '' })",
  "@/lib/ai/resolve-model": "export const resolveModel = (m) => m",
  "@/lib/ai/gateway-chat": "export const gatewayChat = async (a) => globalThis.__VSD.gatewayChat(a)",
  // The kernel outbound evaluator builds its own cookie client; its verdict is faked so the
  // run exercises the fail-closed paths around it, not its gate internals (test:compliance-*).
  "@/lib/kernel/compliance": "export const evaluateOutbound = async (p) => globalThis.__VSD.evaluateOutbound(p)",
}
const STUB_BY_PATH: Array<[RegExp, string]> = [
  [/\/lib\/kernel\/notification-engine\.ts$/, "export const processKernelEvent = async (p) => globalThis.__VSD.event(p)"],
  [/\/lib\/kernel\/brand-compliance\.ts$/, "export const checkBrandCompliance = async () => ({ passed: true })"],
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
  insertReturnsNothing: Set<string>
  prompts: string[]
}
let world: World
let idSeq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`

// Live FKs (read 2026-09-26 from information_schema, project hrvaqgvukzxfskkcrwbt).
const FKS: Array<{ table: string; col: string; ref: string }> = [
  { table: "newsletter_campaigns", col: "agent_id", ref: "agents" },
  { table: "newsletter_campaigns", col: "created_by", ref: "users" },
  { table: "newsletter_campaigns", col: "brokerage_id", ref: "brokerages" },
  { table: "newsletter_sections", col: "newsletter_id", ref: "newsletter_campaigns" },
  { table: "email_campaigns", col: "agent_id", ref: "agents" },
  { table: "email_campaigns", col: "created_by", ref: "users" },
  { table: "email_campaigns", col: "brokerage_id", ref: "brokerages" },
  { table: "blog_posts", col: "agent_user_id", ref: "users" },
  { table: "blog_posts", col: "created_by", ref: "users" },
  { table: "blog_posts", col: "brokerage_id", ref: "brokerages" },
  { table: "podcast_episodes", col: "agent_id", ref: "agents" },
  { table: "podcast_episodes", col: "brokerage_id", ref: "brokerages" },
  { table: "podcast_episodes", col: "template_id", ref: "podcast_templates" },
  { table: "ai_video_projects", col: "agent_id", ref: "agents" },
  { table: "ai_video_projects", col: "brokerage_id", ref: "brokerages" },
  { table: "ai_video_projects", col: "listing_id", ref: "listings" },
  { table: "ai_generated_content", col: "agent_id", ref: "agents" },
  { table: "ai_generated_content", col: "user_id", ref: "users" },
]
// Live NOT NULL columns with no default that the creators write (a NULL is 23502).
const NOT_NULL: Record<string, string[]> = {
  ai_video_projects: ["agent_id", "audience_type"],
  podcast_episodes: ["agent_id", "brokerage_id", "title"],
  blog_posts: ["brokerage_id", "title"],
  email_campaigns: ["campaign_name", "subject_line"],
  newsletter_campaigns: ["campaign_name"],
}

function fkError(table: string, row: Row): { code: string; message: string } | null {
  for (const col of NOT_NULL[table] ?? []) {
    if (col in row && (row[col] === null || row[col] === undefined)) {
      return { code: "23502", message: `null value in column "${col}" of relation "${table}" violates not-null constraint` }
    }
  }
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
  overlaps() { return this }
  filter() { return this }
  match() { return this }
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
        const fk = fkError(this.table, { ...r, ...(this.payload as Row) })
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

// ─── model + evaluator fakes ────────────────────────────────────────────────
let modelCopy = "Spring is a good time to review your options. Here is what the numbers say."
;(globalThis as any).__VSD = {
  service: () => client("service"),
  anon: () => client("anon"),
  event: async (p: Row) => { world.events.push(p); return { success: true } },
  generateObject: async (a: any) => {
    world.prompts.push(String(a.system ?? ""))
    return { object: {
      sections: [
        { type: "market_update", title: "Market update", content: modelCopy, section_type: "market_update" },
        { type: "tips", title: "Tips", content: "Three things to check before listing.", section_type: "tips" },
      ],
      estimatedReadTime: 2, wordCount: 40,
    } }
  },
  gatewayChat: async (a: any) => {
    world.prompts.push(String(a.messages?.[0]?.content ?? ""))
    return { ok: true, content: `Welcome to the show. ${modelCopy} Thanks for listening.` }
  },
  evaluateOutbound: async () => ({ allowed: true, violations: [], complianceEventId: undefined }),
}

// Two tenants. A is the speaker's; B is the one a hostile body names. Hex-valid uuids
// (the video creator refuses a non-uuid actor, fail closed).
const A = { brokerage: "b0000000-0000-4000-8000-00000000000a", user: "c0000000-0000-4000-8000-00000000000a", agent: "a0000000-0000-4000-8000-00000000000a", listing: "d0000000-0000-4000-8000-00000000000a" }
const B = { brokerage: "b0000000-0000-4000-8000-00000000000b", user: "c0000000-0000-4000-8000-00000000000b", agent: "a0000000-0000-4000-8000-00000000000b", listing: "d0000000-0000-4000-8000-00000000000b", template: "e0000000-0000-4000-8000-00000000000b" }
const CONV = "conv_85f_voice"
const SECRET = "85f-tool-secret"
/** A federal catalogue row graded BLOCKING — the finder's positive-control phrase. */
const BLOCKED = "no section 8"

const FEATURES = ["newsletter_engine", "email_campaigns", "seo_blog_engine", "podcast_generation", "video_generation"]

function freshWorld(): void {
  modelCopy = "Spring is a good time to review your options. Here is what the numbers say."
  world = {
    ops: [], events: [], insertReturnsNothing: new Set(), prompts: [],
    tables: {
      brokerages: [{ id: A.brokerage, plan_tier: "brokerage", name: "Alpha Realty", about_text: "About A", bio_text: null }, { id: B.brokerage, plan_tier: "brokerage", name: "Beta" }],
      users: [
        { id: A.user, user_type: "agent", brokerage_id: A.brokerage, team_id: null, platform_role: null },
        { id: B.user, user_type: "agent", brokerage_id: B.brokerage, team_id: null, platform_role: null },
      ],
      agents: [
        { id: A.agent, user_id: A.user, brokerage_id: A.brokerage, created_at: "2026-01-01" },
        { id: B.agent, user_id: B.user, brokerage_id: B.brokerage, created_at: "2026-01-01" },
      ],
      listings: [{ id: A.listing, brokerage_id: A.brokerage }, { id: B.listing, brokerage_id: B.brokerage }],
      podcast_templates: [{ id: B.template, brokerage_id: B.brokerage, agent_id: B.agent, use_count: 0 }],
      feature_flags: FEATURES.map((feature_key) => ({
        feature_key, enabled: true, superadmin_only: false,
        solo_agent_access: true, team_access: true, brokerage_access: true, multi_location_access: true,
        solo_agent_limit: null, team_limit: null, brokerage_limit: null, multi_location_limit: null,
        beta: false, deprecated: false, sunset_date: null, rollout_percentage: null,
      })),
      feature_access_overrides: [],
      prohibited_phrases: [{ id: uuid(), phrase: BLOCKED, phrase_pattern: null, category: "fair_housing", severity: "critical", suggested_alternative: "all qualified applicants", is_active: true, brokerage_id: null }],
      agent_assistant_sessions: [{
        id: "f0000000-0000-4000-8000-00000000000a", brokerage_id: A.brokerage, agent_id: A.agent, user_id: A.user,
        conversation_id: CONV, tool_call_count: 0, ended_at: null, started_at: new Date().toISOString(),
      }],
      newsletter_campaigns: [], newsletter_sections: [], email_campaigns: [], blog_posts: [], podcast_episodes: [],
      ai_video_projects: [], ai_generated_content: [], feature_usage_tracking: [], agent_assistant_tool_calls: [],
      platform_controls: [], marketing_campaigns: [], newsletter_subscribers: [], content_topic_bank: [],
      video_scripts_library: [], lifecycle_events: [], brand_voice_profile: [],
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

/** Everything a hostile body could use to pick the tenant or identity. None of it may be read. */
const HOSTILE = {
  brokerage_id: B.brokerage, brokerageId: B.brokerage, agent_id: B.agent, agentId: B.agent,
  user_id: B.user, userId: B.user, created_by: B.user,
}

interface ToolCase {
  tool: string
  params: Record<string, unknown>
  table: string
  feature: string
  /** column → the id class it must hold */
  ids: Record<string, "agent" | "user">
}
const CASES: ToolCase[] = [
  { tool: "stage_newsletter_draft", params: { title: "Spring market notes", topic: "spring inventory" }, table: "newsletter_campaigns", feature: "newsletter_engine", ids: { agent_id: "agent", created_by: "user" } },
  { tool: "stage_email_campaign", params: { campaign_name: "Spring check-in", subject_line: "A quick spring update", content: "Hi — a quick note on the spring market." }, table: "email_campaigns", feature: "email_campaigns", ids: { agent_id: "agent", created_by: "user" } },
  { tool: "stage_blog_draft", params: { title: "What spring means for sellers", topic: "inventory is up" }, table: "blog_posts", feature: "seo_blog_engine", ids: { agent_user_id: "user", created_by: "user" } },
  { tool: "stage_podcast_episode", params: { title: "Spring market podcast", description: "inventory and rates" }, table: "podcast_episodes", feature: "podcast_generation", ids: { agent_id: "agent" } },
  { tool: "stage_video_project", params: { title: "Spring market video", script: "Inventory is up this spring. Here is what that means for you.", video_type: "market_update", listing_id: A.listing }, table: "ai_video_projects", feature: "", ids: { agent_id: "agent" } },
]

async function behaviour() {
  process.env.AGENT_ASSISTANT_TOOL_SECRET = SECRET
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test"

  console.log("\n── control: an UNSIGNED or wrong-secret webhook is refused before any read ──")
  for (const c of CASES) {
    for (const [label, headers] of [["no secret", {}], ["wrong secret", { "x-elevenlabs-tool-secret": "nope" }]] as const) {
      freshWorld()
      const r = await postTool(headers as Record<string, string>, { conversation_id: CONV, tool_name: c.tool, parameters: { ...c.params, ...HOSTILE } })
      ok(`${c.tool} ${label}: 403, zero database operations`, r.status === 403 && world.ops.length === 0, `status ${r.status}, ops ${world.ops.length}`)
    }
  }

  console.log("\n── each signed voice call stages AS THE SESSION ROW, body ids ignored ──")
  for (const c of CASES) {
    freshWorld()
    const r = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: c.tool, parameters: { ...c.params, ...HOSTILE } })
    const res = r.json?.result ?? {}
    const rows = world.tables[c.table]
    const row = rows[0] ?? {}
    ok(`${c.tool}: 200 and success (no longer refused by a cookie-session door)`, r.status === 200 && res.success === true, JSON.stringify(res).slice(0, 400))
    ok(`${c.tool}: exactly one ${c.table} row`, rows.length === 1, `rows ${rows.length}`)
    ok(`${c.tool}: brokerage_id is the session row's tenant A (body B ignored)`, row.brokerage_id === A.brokerage, `got ${row.brokerage_id}`)
    for (const [col, cls] of Object.entries(c.ids)) {
      const want = cls === "agent" ? A.agent : A.user
      ok(`${c.tool}: ${c.table}.${col} is A's ${cls === "agent" ? "AGENTS" : "USERS"} id (never the other class, never the body's)`, row[col] === want, `got ${row[col]}`)
    }
    const written = world.ops.filter((o) => /:(insert|update)$/.test(o.op)).map((o) => o.table)
    ok(`${c.tool}: nothing was written under tenant B`, [...new Set(written)].every((t) => (world.tables[t] ?? []).every((x) => x.brokerage_id !== B.brokerage || t === "podcast_templates")),
      [...new Set(written)].join(","))
    ok(`${c.tool}: the cookie (anon) client never wrote`, !world.ops.some((o) => o.op.startsWith("anon:") && !o.op.endsWith("select")),
      world.ops.filter((o) => o.op.startsWith("anon:") && !o.op.endsWith("select")).map((o) => o.table).join(","))
    if (c.feature) {
      const usage = world.tables.feature_usage_tracking.filter((u) => u.feature_key === c.feature)
      ok(`${c.tool}: the ${c.feature} usage row is booked to the session user in tenant A`, usage.length >= 1 && usage.every((u) => u.user_id === A.user && u.brokerage_id === A.brokerage),
        JSON.stringify(world.tables.feature_usage_tracking))
    }
    ok(`${c.tool}: the tool result deep-links the staged row`, typeof res.openUrl === "string" && res.openUrl.includes(String(row.id)), String(res.openUrl))

    if (c.tool === "stage_newsletter_draft") {
      ok("newsletter: AI-authored → approval_status pending_review + is_ai_generated (merged from the kernel duplicate)", row.approval_status === "pending_review" && row.is_ai_generated === true)
      ok("newsletter: the sections were decomposed onto newsletter_sections in tenant A", world.tables.newsletter_sections.length === 2 && world.tables.newsletter_sections.every((s) => s.newsletter_id === row.id && s.brokerage_id === A.brokerage))
      const art = world.tables.ai_generated_content[0] ?? {}
      ok("newsletter: the ai_generated_content artifact carries users id + agents id in their own columns", art.user_id === A.user && art.agent_id === A.agent)
      ok("newsletter: the WRITER's system prompt is compliance-first (Fair Housing + ThemFirst + the blocking phrase)",
        /Fair Housing compliance/.test(world.prompts[0] ?? "") && /ThemFirst|THEM|client experiences/i.test(world.prompts[0] ?? "") && (world.prompts[0] ?? "").includes(BLOCKED), (world.prompts[0] ?? "").slice(0, 300))
    }
    if (c.tool === "stage_podcast_episode") {
      ok("podcast: no dictated script → the kernel writer wrote one", String(row.script).startsWith("Welcome to the show"))
      ok("podcast: the WRITER's system prompt is compliance-first (Fair Housing + the blocking phrase)",
        /Fair Housing compliance/.test(world.prompts[0] ?? "") && (world.prompts[0] ?? "").includes(BLOCKED), (world.prompts[0] ?? "").slice(0, 300))
    }
    if (c.tool === "stage_video_project") {
      ok("video: audience_type customer_facing (the NOT NULL column the survivor used to write NULL)", row.audience_type === "customer_facing")
      ok("video: a dictated script is 'script_ready' and the listing is A's", row.status === "script_ready" && row.listing_id === A.listing)
      ok("video: brand_voice_context stamped (merged from the kernel duplicate)", row.brand_voice_context?.brokerage_name === "Alpha Realty")
    }
  }

  console.log("\n── a spoken video with no script is a shell, not a refusal ──")
  freshWorld()
  const shell = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_video_project", parameters: { title: "Spring shell" } })
  ok("no script → success, status 'draft' (it used to be refused \"Script is required\")", shell.json?.result?.success === true && world.tables.ai_video_projects[0]?.status === "draft", JSON.stringify(shell.json?.result))

  console.log("\n── positive controls: compliance-first still BITES ──")
  freshWorld()
  modelCopy = `Great home, ${BLOCKED} please.`
  const pod = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_podcast_episode", parameters: { title: "Bad podcast" } })
  ok("control: a podcast draft with a BLOCKING phrase is refused, no episode row", pod.json?.result?.success === false && world.tables.podcast_episodes.length === 0, JSON.stringify(pod.json?.result).slice(0, 300))
  freshWorld()
  modelCopy = `Great home, ${BLOCKED} please.`
  const nl = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_newsletter_draft", parameters: { title: "Bad issue" } })
  ok("control: a newsletter draft with a BLOCKING phrase is refused, no campaign row, no usage booked", nl.json?.result?.success === false && world.tables.newsletter_campaigns.length === 0 && world.tables.feature_usage_tracking.length === 0, JSON.stringify(nl.json?.result).slice(0, 300))
  freshWorld()
  const vid = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_video_project", parameters: { title: "Bad video", script: `This home is ${BLOCKED}.` } })
  ok("control: a red-flag dictated video script is HELD (no project) and a review row is filed in tenant A", vid.json?.result?.success === false && world.tables.ai_video_projects.length === 0 && world.tables.video_scripts_library.some((r) => r.brokerage_id === A.brokerage && r.approval_status === "pending_review"),
    JSON.stringify({ res: vid.json?.result, lib: world.tables.video_scripts_library }).slice(0, 400))
  freshWorld()
  world.tables.feature_flags.find((f) => f.feature_key === "email_campaigns")!.enabled = false
  const gated = await postTool({ "x-elevenlabs-tool-secret": SECRET }, { conversation_id: CONV, tool_name: "stage_email_campaign", parameters: CASES[1].params })
  ok("control: the feature gate still gates through the verified client (flag off → refused, no row)", gated.json?.result?.success === false && world.tables.email_campaigns.length === 0)

  console.log("\n── positive controls: the no-cookie world is real (every session door refuses in it) ──")
  freshWorld()
  const doors: Array<[string, () => Promise<any>]> = [
    ["aiWriteNewsletterContent", async () => (await import("../app/actions/ai-newsletter")).aiWriteNewsletterContent({ topic: "x" })],
    ["createNewsletterCampaign", async () => (await import("../app/actions/ai-newsletter")).createNewsletterCampaign({ title: "x", subjectLine: "x", preheaderText: "", template: "modern", content: [], audienceSegment: "all" })],
    ["createEmailCampaign", async () => (await import("../app/actions/email-campaigns")).createEmailCampaign({ brokerageId: A.brokerage, campaignName: "x", subjectLine: "x", createdBy: A.user })],
    ["saveBlogPost", async () => (await import("../app/actions/blog")).saveBlogPost({ title: "x" })],
    ["createPodcastEpisode", async () => (await import("../app/actions/podcast-generation")).createPodcastEpisode({ title: "x", script: "y" })],
    ["createVideoProject", async () => (await import("../app/actions/video/create-video-project")).createVideoProject({ brokerageId: A.brokerage, agentUserId: A.user, title: "x", script: "y", videoType: "market_update", backgroundType: "solid", format: "vertical", durationSeconds: 30, captionsEnabled: true })],
  ]
  for (const [name, call] of doors) {
    let out: any
    try { out = await call() } catch (e) { out = { success: false, error: String(e) } }
    ok(`control: session door ${name} refuses with no cookie session (the pre-85F voice outcome)`, out?.success === false, JSON.stringify(out).slice(0, 200))
  }
  ok("control: none of the session doors wrote anything", ["newsletter_campaigns", "email_campaigns", "blog_posts", "podcast_episodes", "ai_video_projects"].every((t) => world.tables[t].length === 0))

  console.log("\n── the kernel refuses what it cannot file honestly ──")
  freshWorld()
  const K = await import("../lib/kernel/content-creators")
  const noActor = await K.createEmailCampaign({ ctx: { userId: "", brokerageId: A.brokerage }, campaignName: "x", subjectLine: "y" })
  const foreignAgent = await K.createEmailCampaign({ ctx: { userId: A.user, brokerageId: A.brokerage, agentId: B.agent }, campaignName: "x", subjectLine: "y" })
  const usersAsAgent = await K.createEmailCampaign({ ctx: { userId: A.user, brokerageId: A.brokerage, agentId: A.user }, campaignName: "x", subjectLine: "y" })
  const foreignTemplate = await K.createPodcastEpisode({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x", script: "y", templateId: B.template })
  const foreignListing = await K.createVideoProject({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x", scriptPending: true, videoType: "market_update", backgroundType: "solid", format: "vertical", durationSeconds: 30, captionsEnabled: true, listingId: B.listing })
  const badType = await K.createVideoProject({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x", scriptPending: true, videoType: "reel", backgroundType: "solid", format: "vertical", durationSeconds: 30, captionsEnabled: true })
  ok("no verified user → refused (fail closed)", noActor.success === false)
  ok("another tenant's agents id → refused", foreignAgent.success === false && /not an agents row/.test(String((foreignAgent as any).error)))
  ok("a users id offered as agentId → refused before the FK", usersAsAgent.success === false && /not an agents row/.test(String((usersAsAgent as any).error)))
  ok("another tenant's podcast template → refused", foreignTemplate.success === false && /not on your brokerage/.test(String((foreignTemplate as any).error)))
  ok("another tenant's listing on a video → refused", foreignListing.success === false && /not on your brokerage/.test(String(foreignListing.error)))
  ok("a video type outside the CHECK → refused, not a 23514 (§6)", badType.success === false && /Unknown video type/.test(String(badType.error)))
  ok("none of the refusals wrote a row", ["email_campaigns", "podcast_episodes", "ai_video_projects"].every((t) => world.tables[t].length === 0))
  const internal = await K.createVideoProject({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x", scriptPending: true, videoType: "education", backgroundType: "solid", format: "vertical", durationSeconds: 30, captionsEnabled: true, audienceType: "internal" })
  ok("audience 'internal' folds onto the CHECK's 'in_house' (§6)", internal.success === true && world.tables.ai_video_projects[0]?.audience_type === "in_house", JSON.stringify(internal).slice(0, 200))
  const badAudience = await K.createVideoProject({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x", scriptPending: true, videoType: "education", backgroundType: "solid", format: "vertical", durationSeconds: 30, captionsEnabled: true, audienceType: "public" as any })
  ok("an audience outside the CHECK → refused, not a 23514", badAudience.success === false && /Unknown audience type/.test(String(badAudience.error)))

  console.log("\n── counted inserts: a zero-row return is a refusal ──")
  for (const [table, run] of [
    ["email_campaigns", () => K.createEmailCampaign({ ctx: { userId: A.user, brokerageId: A.brokerage }, campaignName: "x", subjectLine: "y" })],
    ["blog_posts", () => K.createBlogPostDraft({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x" })],
    ["podcast_episodes", () => K.createPodcastEpisode({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x", script: "y" })],
    ["ai_video_projects", () => K.createVideoProject({ ctx: { userId: A.user, brokerageId: A.brokerage }, title: "x", scriptPending: true, videoType: "education", backgroundType: "solid", format: "vertical", durationSeconds: 30, captionsEnabled: true })],
  ] as const) {
    freshWorld()
    world.insertReturnsNothing.add(table)
    const out = await (run as () => Promise<any>)()
    ok(`${table}: 0 rows returned → success:false, no usage booked`, out.success === false && world.tables.feature_usage_tracking.length === 0, JSON.stringify(out).slice(0, 200))
  }

  console.log("\n── the fake's FK is live: a users id in agent_id is 23503 ──")
  freshWorld()
  const { error: fkErr } = await client("service").from("podcast_episodes").insert({ brokerage_id: A.brokerage, agent_id: A.user, title: "x" }).select() as any
  ok("control: podcast_episodes.agent_id = users id → 23503 (the class error the kernel can no longer make)", fkErr?.code === "23503")
  const { error: nnErr } = await client("service").from("ai_video_projects").insert({ brokerage_id: A.brokerage, agent_id: A.agent, audience_type: null }).select() as any
  ok("control: ai_video_projects.audience_type = NULL → 23502 (what the old survivor wrote)", nnErr?.code === "23502")
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

/** The finder: a helper the webhook reaches must not import a cookie-session "use server" door. */
export function cookieDoorImports(body: string): string[] {
  return [...body.matchAll(/import\(\s*"(@\/app\/actions\/[^"]+)"\s*\)/g)].map((m) => m[1])
}

/** The voice handler's ctx must be the session row's, and params never name an id. */
export function voiceCtxViolations(body: string, stageFn: string): string[] {
  const v: string[] = []
  const call = new RegExp(`${stageFn}\\(\\s*\\{([^}]*)\\}`).exec(body)
  if (!call) return [`${stageFn}(ctx, …) call not found`]
  if (!/brokerageId:\s*session\.brokerage_id/.test(call[1])) v.push("ctx.brokerageId is not session.brokerage_id")
  if (!/userId:\s*session\.user_id/.test(call[1])) v.push("ctx.userId is not session.user_id")
  for (const m of body.matchAll(/params\s*(?:\.\s*|\[\s*)(brokerage_?[iI]d|agent_?[iI]d|user_?[iI]d|created_?[bB]y)/g)) v.push(`reads params.${m[1]}`)
  return v
}

/** A model WRITER is compliance-first only when the rules are an input AND the output is graded. */
export function writerComplianceGaps(body: string): string[] {
  const gaps: string[] = []
  if (!/buildComplianceSystemBlocks\s*\(/.test(body)) gaps.push("no buildComplianceSystemBlocks in the prompt")
  if (!/(postcheckScript|gradeWrittenCopy)\s*\(/.test(body)) gaps.push("no postcheckScript on the output")
  return gaps
}

function source() {
  console.log("\n── R1: no stage_* helper imports a cookie-session door (lane 85D's census, now a RULE) ──")
  const staging = stripComments(read("lib/wizard-staging/content-staging.ts"))
  const helpers = [...staging.matchAll(/export\s+async\s+function\s+(stage\w+)\s*\(/g)].map((m) => m[1])
  const bound = helpers.filter((h) => cookieDoorImports(fnBody(staging, h) ?? "").length > 0)
  console.log(`  · census: ${bound.length} of ${helpers.length} staging helpers import a cookie-session door: ${bound.join(", ") || "none"}`)
  ok(`denominator: the eight voice stage_* helpers are all found (${helpers.length})`, helpers.length === 8, helpers.join(", "))
  ok(`0/${helpers.length} stage_* helpers reach a "use server" door`, bound.length === 0, bound.join(", "))
  const FIVE = ["stageNewsletterDraft", "stageEmailCampaign", "stageBlogDraft", "stagePodcastEpisode", "stageVideoProject"]
  for (const h of FIVE) {
    const body = fnBody(staging, h) ?? ""
    ok(`${h} imports the kernel creators`, /import\(\s*"@\/lib\/kernel\/content-creators"\s*\)/.test(body))
    ok(`${h} carries no raw .from(…).insert( (the old fallback merged onto the creator)`, !/\.from\(\s*"[a-z_]+"\s*\)\s*\.insert\(/.test(body))
  }

  console.log("\n── R2: every voice handler builds ctx from the session row ──")
  const route = blankStrings(read("app/api/agent-assistant/tool-call/route.ts"))
  for (const h of FIVE) {
    const voice = fnBody(route, `${h}Voice`)
    ok(`${h}Voice found`, !!voice)
    const v = voiceCtxViolations(voice ?? "", h)
    ok(`${h}Voice: ctx = { session.brokerage_id, session.user_id }; no params.* id`, v.length === 0, v.join("; "))
  }

  console.log("\n── R3: each session door keeps its session gate and calls the ONE creator ──")
  const DOORS: Array<[string, string, string, RegExp]> = [
    ["app/actions/ai-newsletter.ts", "aiWriteNewsletterContent", "authorNewsletterContent", /getAgentContext\(\)/],
    ["app/actions/ai-newsletter.ts", "createNewsletterCampaign", "createNewsletterCampaign", /getAgentContext\(\)/],
    ["app/actions/email-campaigns.ts", "createEmailCampaign", "createEmailCampaign", /requireCaller\(\)/],
    ["app/actions/blog.ts", "saveBlogPost", "createBlogPostDraft", /getAgentContext\(\)/],
    ["app/actions/podcast-generation.ts", "createPodcastEpisode", "createPodcastEpisode", /getAgentContext\(\)/],
    ["app/actions/video/create-video-project.ts", "createVideoProject", "createVideoProject", /requireCaller\(\)/],
  ]
  for (const [file, fn, kernel, gate] of DOORS) {
    const body = fnBody(stripComments(read(file)), fn) ?? ""
    ok(`${file} ${fn}: session gate present`, gate.test(body))
    ok(`${file} ${fn}: imports lib/kernel/content-creators and names ${kernel}`, /import\(\s*"@\/lib\/kernel\/content-creators"\s*\)/.test(body) && new RegExp(`\\b${kernel}\\b`).test(body))
    ok(`${file} ${fn}: no raw .insert( left in the door`, !/\.insert\(/.test(body))
  }
  ok("the kernel module is server-only and NOT a \"use server\" file",
    /import\s+"server-only"/.test(stripComments(read("lib/kernel/content-creators.ts"))) && !/^\s*["']use server["']/.test(read("lib/kernel/content-creators.ts")))

  console.log("\n── R4: every model WRITER is compliance-first (prompt input + post-check) ──")
  const kernel = stripComments(read("lib/kernel/content-creators.ts"))
  for (const w of ["authorNewsletterContent", "writePodcastScript"]) {
    const gaps = writerComplianceGaps(fnBody(kernel, w) ?? "")
    ok(`${w}: buildComplianceSystemBlocks + postcheckScript`, gaps.length === 0, gaps.join("; "))
  }
  ok("gradeWrittenCopy runs postcheckScript", /postcheckScript\s*\(/.test(fnBody(kernel, "gradeWrittenCopy") ?? ""))
  ok("the video creator holds through evaluateVideoRenderHold", /evaluateVideoRenderHold\s*\(/.test(fnBody(kernel, "createVideoProject") ?? ""))
  ok("the newsletter per-section gate no longer fails OPEN (.catch(() => ({ allowed: true …",
    !/allowed:\s*true/.test(fnBody(kernel, "authorNewsletterContent") ?? "x"))

  console.log("\n── positive controls: the finders still recognise the defects ──")
  const oldStaging = stripComments(`export async function stageBlogDraft(ctx, intake) {
    const { saveBlogPost } = await import("@/app/actions/blog")
    return saveBlogPost({ title: intake.title })
  }`)
  ok("control: the pre-85F staging helper (a cookie-session door) is flagged", cookieDoorImports(fnBody(oldStaging, "stageBlogDraft") ?? "").length === 1)
  const tomb = stripComments(`export async function stageBlogDraft(ctx, intake) {
    // was: await import("@/app/actions/blog")
    return 1
  }`)
  ok("control: a tombstone naming the old door is NOT an import", cookieDoorImports(fnBody(tomb, "stageBlogDraft") ?? "").length === 0)
  ok("control: a body-supplied brokerage_id in a voice ctx is flagged",
    voiceCtxViolations(blankStrings(`async function stageEmailCampaignVoice(params, session) { return stageEmailCampaign({ brokerageId: String(params.brokerage_id), userId: session.user_id }, {}) }`), "stageEmailCampaign").length >= 2)
  ok("control: the pre-85F podcast writer (bare prompt, no post-check) is flagged twice",
    writerComplianceGaps(`async function generateScriptFromKeywords(k) { return gatewayChat({ messages: [{ role: "system", content: "You are a podcast writer." }] }) }`).length === 2)
}

async function main() {
  await behaviour()
  source()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`VOICE STAGE DOORS — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("OK — the voice agent stages newsletter / email / blog / podcast / video as the session row's user, in its tenant")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
