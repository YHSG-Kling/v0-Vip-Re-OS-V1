#!/usr/bin/env tsx
/**
 * scripts/blog-writer-merge-simulator.ts   (npm run test:blog-writer-merge)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE AI BLOG WRITER, COMPLIANCE-FIRST, REACHABLE WITHOUT A SESSION — lane 86C.
 *
 * THE DUPLICATE. lib/kernel/marketing.ts createBlogPost was an unwired second AI blog writer
 * (85F left it "unresolved"). The survivor, app/actions/blog.ts generateBlogPost, lacked what
 * the duplicate had (the umbrella campaign verified in-tenant; the insert on the service client
 * after the gate), and BOTH lacked the compliance-first writing prompt (CLAUDE.md §5). The
 * survivor was also a "use server" export that took userId AND brokerageId from the browser,
 * and its sessionless caller (the blog cadence cron) was refused on every run: anon feature
 * gate, then brok_blog_posts refusing the anon insert.
 *
 * THE MERGE. The body is lib/kernel/content-creators.ts writeBlogPost (server-only); the
 * session door is generateBlogPost; the cron calls the kernel with the policy row's tenant.
 * createBlogPost is deleted, its tombstone naming the survivor at file:line.
 *
 * LAYERS
 *   BEHAVIOUR: the REAL door, kernel writer, tenant-config door, brand-voice core and
 *     script-compliance kit against an in-memory PostgREST with the live FKs (blog_posts
 *     agent_user_id/created_by → users). Stubbed: the model, evaluateOutbound's verdict, the
 *     feature gate's verdict, the event bus, topic-bank and the session.
 *   SOURCE (stripped): one AI blog_posts writer; createBlogPost absent from code; the tombstone
 *     names lines that really hold the survivors (derived, not pinned).
 *
 * POSITIVE CONTROLS: a foreign campaign and a foreign seat are refused (own ones accepted); a
 *   hard fair-housing draft is refused (a warning-only draft is kept, warning surfaced); a
 *   blocked brief never reaches the model; a zero-row insert is refused; the anon world writes
 *   nothing; the finders flag fixtures of the defects.
 *
 * Run: npx tsx --conditions=react-server scripts/blog-writer-merge-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── Module interception: the model, the verdicts, the bus, the session ───────
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__BW.service()",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__BW.anon(); export const createServerClient = async () => globalThis.__BW.anon()",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f",
  "@/lib/ai/models": "export const generateTextRouted = async (a) => globalThis.__BW.model(a); export const generateObjectRouted = async () => ({ object: {} })",
  "@/lib/kernel/compliance": "export const evaluateOutbound = async (p, o) => globalThis.__BW.evaluate(p, o)",
  "@/lib/kernel/0.1-feature-access": "export const canAccessFeature = async (u, f, _t, c) => globalThis.__BW.gate(u, f, c); export const incrementFeatureUsage = async () => ({ success: true })",
  "@/lib/identity/get-agent-context": "export const getAgentContext = async () => globalThis.__BW.session(); export const requireSessionAgentId = async () => ({ ok: false })",
  "@/lib/content-intel/topic-bank": "export const pickTopics = async () => []; export const renderTopicsForPrompt = () => ''",
  "@/lib/content-intel/performance-aggregator": "export const logTopicUses = async () => {}",
}
const STUB_BY_PATH: Array<[RegExp, string]> = [
  [/\/lib\/kernel\/notification-engine\.ts$/, "export const processKernelEvent = async (p) => { globalThis.__BW.events.push(p) }"],
  [/\/lib\/agentic-os\/connector-gateway\.ts$/, "export const callConnector = async () => ({ ok: false })"],
]
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const bySpec = STUB_BY_SPEC[spec]
    if (bySpec !== undefined) return { url: `data:text/javascript,${encodeURIComponent(bySpec)}`, shortCircuit: true }
    const r = next(spec, ctx)
    for (const [re, body] of STUB_BY_PATH) if (re.test(r.url ?? "")) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return r
  },
})

// ── The world ────────────────────────────────────────────────────────────────
type Row = Record<string, any>
const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const USER_A = "11111111-0000-4000-8000-00000000000a"
const USER_A2 = "11111111-0000-4000-8000-0000000000a2"
const USER_B = "22222222-0000-4000-8000-00000000000b"
const CAMP_A = "77777777-0000-4000-8000-00000000000a"
const CAMP_B = "88888888-0000-4000-8000-00000000000b"
let tables: Record<string, Row[]> = {}
let ops: string[] = []
let seq = 0
let zeroRowInsert = false
const FKS: Array<[string, string, string]> = [
  ["blog_posts", "agent_user_id", "users"], ["blog_posts", "created_by", "users"],
  ["blog_posts", "brokerage_id", "brokerages"], ["blog_posts", "marketing_campaign_id", "marketing_campaigns"],
]
function reset() {
  seq = 0; ops = []; zeroRowInsert = false
  tables = {
    brokerages: [{ id: A, name: "Alpha Realty" }, { id: B, name: "Beta Homes" }],
    users: [{ id: USER_A, brokerage_id: A }, { id: USER_A2, brokerage_id: A }, { id: USER_B, brokerage_id: B }],
    marketing_campaigns: [{ id: CAMP_A, brokerage_id: A }, { id: CAMP_B, brokerage_id: B }],
    brand_voice_profile: [{ id: "bv", brokerage_id: A, team_id: null, agent_id: null, tone: "warm", prohibited_words: ["guaranteed"], preferred_words: [], key_brand_messages: ["Local since 1999"] }],
    blog_posts: [], seo_keywords: [], blog_post_keywords: [],
  }
}
class Query {
  private filters: Array<(r: Row) => boolean> = []
  private op: "select" | "insert" = "select"
  private payload: Row[] = []
  private returning = false
  private mode: "many" | "maybe" | "single" = "many"
  constructor(private who: "service" | "anon", private table: string) {}
  select() { if (this.op !== "select") this.returning = true; return this }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  or() { return this } ; order() { return this } ; limit() { return this } ; gte() { return this } ; ilike() { return this }
  maybeSingle() { this.mode = "maybe"; return this }
  single() { this.mode = "single"; return this }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve(this.run()).then(res, rej) }
  private shape(rows: Row[]) {
    if (this.mode === "many") return { data: rows, error: null }
    if (rows.length > 1) return { data: null, error: { message: "PGRST116" } }
    if (this.mode === "single" && rows.length === 0) return { data: null, error: { message: "PGRST116 0 rows" } }
    return { data: rows[0] ?? null, error: null }
  }
  private run() {
    ops.push(`${this.who}:${this.op}:${this.table}`)
    if (this.who === "anon") return this.op === "select" ? this.shape([]) : { data: null, error: { message: "new row violates row-level security policy" } }
    const t = (tables[this.table] ??= [])
    if (this.op === "select") return this.shape(t.filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r })))
    const out: Row[] = []
    for (const raw of this.payload) {
      const row: Row = { id: raw.id ?? `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ...raw }
      for (const [tb, col, ref] of FKS) {
        if (tb === this.table && row[col] != null && !(tables[ref] ?? []).some((r) => r.id === row[col])) {
          return { data: null, error: { code: "23503", message: `${tb}_${col}_fkey` } }
        }
      }
      t.push(row); out.push({ ...row })
    }
    if (zeroRowInsert && this.table === "blog_posts") return this.returning ? this.shape([]) : { data: null, error: null }
    return this.returning ? this.shape(out) : { data: null, error: null }
  }
}
const mk = (who: "service" | "anon") => ({ from: (t: string) => new Query(who, t), auth: { getUser: async () => ({ data: { user: null }, error: null }) } })

const BW: any = {
  service: () => mk("service"),
  anon: () => mk("anon"),
  events: [] as Row[],
  prompts: [] as Array<{ system: string; prompt: string }>,
  draft: { title: "What does a home inspection cover?", slug: "home-inspection", excerpt: "x", content: "<h2>What is inspected?</h2><p>The roof and systems.</p>", featuredImagePrompt: "" },
  model: async (a: any) => { BW.prompts.push({ system: a.system, prompt: a.prompt }); return { text: JSON.stringify(BW.draft) } },
  evaluate: async (_p: any, o: any) => { BW.gateClients.push(o?.client ? "client" : "none"); return { allowed: BW.allow, violations: BW.allow ? [] : ["FairHousing: steering"] } },
  gateClients: [] as string[],
  allow: true,
  gate: async (_u: string, _f: string, c: any) => { BW.featureClients.push(c ? "client" : "cookie"); return { allowed: true } },
  featureClients: [] as string[],
  session: async () => ({ isAuthenticated: true, userId: USER_A, brokerageId: A }),
}
;(globalThis as any).__BW = BW

async function main() {
  const { writeBlogPost } = await import("../lib/kernel/content-creators")
  const { generateBlogPost } = await import("../app/actions/blog")
  const ctxA = { userId: USER_A, brokerageId: A }
  const fresh = () => { reset(); BW.events = []; BW.prompts = []; BW.gateClients = []; BW.featureClients = []; BW.allow = true
    BW.draft = { title: "What does a home inspection cover?", slug: "home-inspection", excerpt: "x", content: "<h2>What is inspected?</h2><p>The roof and systems.</p>", featuredImagePrompt: "" } }

  console.log("\n── 1. The kernel writer (the cron's and the door's one body) ──")
  fresh()
  const r1 = await writeBlogPost({ ctx: ctxA, keywords: ["home inspection"], campaignId: CAMP_A })
  ok("a verified actor gets a post, filed in its tenant", r1.success && tables.blog_posts.length === 1 && tables.blog_posts[0].brokerage_id === A, JSON.stringify(r1))
  ok("created_by is the users id (FK users), is_ai_generated true, draft", tables.blog_posts[0]?.created_by === USER_A && tables.blog_posts[0]?.is_ai_generated === true && tables.blog_posts[0]?.publish_status === "draft")
  ok("the verified campaign is written", tables.blog_posts[0]?.marketing_campaign_id === CAMP_A)
  const sys = BW.prompts[0]?.system ?? ""
  ok("COMPLIANCE-FIRST: the Fair Housing block is in the SYSTEM prompt", /Fair Housing compliance \(Gate 4/.test(sys), sys.slice(0, 200))
  ok("COMPLIANCE-FIRST: the ThemFirst block is in the SYSTEM prompt", /ThemFirst|THEM FIRST|Them-First|CLIENT experiences/i.test(sys))
  ok("the tenant's brand voice reached the prompt through the SESSIONLESS door (service read)", /Avoid these words: guaranteed/.test(sys) && /Local since 1999/.test(sys))
  ok("the blocking gate and the post-check ran on the caller's client", BW.gateClients.length >= 2 && BW.gateClients.every((c: string) => c === "client"), JSON.stringify(BW.gateClients))
  ok("the feature gate ran through the client, never the anon cookie", BW.featureClients.every((c: string) => c === "client"))
  ok("the BLOG_POST_GENERATED event fired for the compliance officer's pass", BW.events.some((e: Row) => e.entityType === "blog_post"))
  ok("keywords are stored and linked in the tenant", tables.seo_keywords.length === 1 && tables.blog_post_keywords.length === 1 && tables.seo_keywords[0].brokerage_id === A)

  console.log("\n── 2. Caller-named ids are verified in the tenant (merged from createBlogPost) ──")
  fresh()
  const foreignCamp = await writeBlogPost({ ctx: ctxA, keywords: ["x"], campaignId: CAMP_B })
  ok("a campaign of another brokerage is refused, nothing written, no model call",
    !foreignCamp.success && tables.blog_posts.length === 0 && BW.prompts.length === 0, JSON.stringify(foreignCamp))
  fresh()
  const foreignSeat = await writeBlogPost({ ctx: ctxA, keywords: ["x"], agentUserId: USER_B })
  ok("a seat of another brokerage is refused as the post's agent", !foreignSeat.success && tables.blog_posts.length === 0)
  fresh()
  const ownSeat = await writeBlogPost({ ctx: ctxA, keywords: ["x"], agentUserId: USER_A2 })
  ok("POSITIVE CONTROL — a seat of the same brokerage is accepted and attributed", ownSeat.success && tables.blog_posts[0]?.agent_user_id === USER_A2 && tables.blog_posts[0]?.visibility_scope === "agent")

  console.log("\n── 3. Compliance: hard flags refuse, warnings pass through ──")
  fresh()
  BW.draft = { ...BW.draft, content: "<p>This is perfect for families with young children.</p>" }
  const red = await writeBlogPost({ ctx: ctxA, keywords: ["x"] })
  ok("a draft with a hard fair-housing flag is refused and NOT stored", !red.success && tables.blog_posts.length === 0, JSON.stringify(red))
  fresh()
  const clean = await writeBlogPost({ ctx: ctxA, keywords: ["x"] })
  ok("POSITIVE CONTROL — a clean draft is kept; advisory findings surface as complianceWarnings",
    clean.success && Array.isArray((clean as any).complianceWarnings))
  fresh()
  const brief = await writeBlogPost({ ctx: ctxA, keywords: ["homes perfect for families"] })
  ok("a brief that fails fair housing never reaches the model", !brief.success && BW.prompts.length === 0, JSON.stringify(brief))
  fresh()
  BW.allow = false
  const gated = await writeBlogPost({ ctx: ctxA, keywords: ["x"] })
  ok("the blocking gate still refuses (nothing stored)", !gated.success && tables.blog_posts.length === 0)
  fresh()
  zeroRowInsert = true
  const zero = await writeBlogPost({ ctx: ctxA, keywords: ["x"] })
  ok("a zero-row insert is REFUSED, never reported as created", !zero.success, JSON.stringify(zero))
  fresh()
  const noActor = await writeBlogPost({ ctx: { userId: "", brokerageId: A }, keywords: ["x"] })
  ok("no verified actor → refused before any read", !noActor.success && ops.length === 0)

  console.log("\n── 4. The session door ──")
  fresh()
  const doorOk = await generateBlogPost(USER_A, { brokerageId: A, keywords: ["home inspection"] })
  ok("the door writes as the SESSION's actor, in the session's tenant", doorOk.success && tables.blog_posts[0]?.brokerage_id === A && tables.blog_posts[0]?.created_by === USER_A, JSON.stringify(doorOk))
  fresh()
  const doorForeign = await generateBlogPost(USER_A, { brokerageId: B, keywords: ["x"] })
  ok("a body brokerageId naming another tenant is REFUSED (not corrected)", !doorForeign.success && tables.blog_posts.length === 0 && /not yours/.test(doorForeign.error ?? ""))
  fresh()
  const doorImposter = await generateBlogPost(USER_B, { brokerageId: A, keywords: ["x"] })
  ok("a claimed userId that is not the session's is refused", !doorImposter.success && tables.blog_posts.length === 0)
  fresh()
  BW.session = async () => ({ isAuthenticated: false, userId: null, brokerageId: null })
  const doorAnon = await generateBlogPost(USER_A, { brokerageId: A, keywords: ["x"] })
  ok("no session → refused, nothing read or written", !doorAnon.success && tables.blog_posts.length === 0)

  console.log("\n── 5. SOURCE: one writer, the duplicate gone, the tombstone true ──")
  const walk = (await import("./runtime-roots")) as any
  const files: string[] = [...walk.walkTs("app"), ...walk.walkTs("lib")]
  // THE RULE: a module that both CALLS A MODEL and INSERTS blog_posts is an AI blog writer, and
  // there is one. (Stagers that file copy another writer produced — lib/kernel/marketing-bench.ts
  // — insert blog_posts without a model call and are outside the rule by construction.)
  const MODEL_CALL = /\b(generateTextRouted|generateObjectRouted|gatewayChat|generateAIResponse|generateText)\s*\(/
  const BLOG_INSERT = /\.from\(\s*"blog_posts"\s*\)\s*\.insert\(/
  const isAiBlogWriter = (code: string) => MODEL_CALL.test(code) && BLOG_INSERT.test(code)
  const writers = files.filter((f) => isAiBlogWriter(stripComments(read(f))))
  const inserters = files.filter((f) => BLOG_INSERT.test(stripComments(read(f))))
  console.log(`    denominator: ${files.length} app/lib files scanned (comments stripped); ${inserters.length} insert blog_posts (${inserters.join(", ")}); AI writers: ${writers.join(", ")}`)
  ok("exactly ONE AI blog writer (model call + blog_posts insert), in the kernel", writers.length === 1 && writers[0] === "lib/kernel/content-creators.ts", writers.join(","))
  ok("POSITIVE CONTROL — the finder counts the pre-86C podcast repurpose writer shape",
    isAiBlogWriter(`const { text } = await generateTextRouted({ feature: "podcast_blog_post" })\nawait supabase.from("blog_posts").insert({ content: text })`))
  ok("POSITIVE CONTROL — a stager with no model call is not a writer",
    !isAiBlogWriter(`await supabase.from("blog_posts").insert({ content: d.body, is_ai_generated: true })`))
  const mk2 = stripComments(read("lib/kernel/marketing.ts"))
  ok("createBlogPost is gone from lib/kernel/marketing.ts code", !/\bcreateBlogPost\b/.test(mk2))
  ok("…and from the kernel barrel", !/\bcreateBlogPost\b|\bCreateBlogPostInput\b/.test(stripComments(read("lib/kernel/index.ts"))))
  ok("POSITIVE CONTROL — the absence finder sees a live export", /\bcreateBlogPost\b/.test(stripComments("export async function createBlogPost() {}")))
  const tomb = read("lib/kernel/marketing.ts")
  const named = [...tomb.matchAll(/(app\/actions\/blog\.ts|lib\/kernel\/content-creators\.ts):(\d+) (\w+)/g)]
  ok("the tombstone names both survivors at file:line", named.length === 2)
  for (const [, file, line, fn] of named) {
    const at = read(file).split("\n")[Number(line) - 1] ?? ""
    ok(`tombstone line resolves: ${file}:${line} holds ${fn}`, new RegExp(`function\\s+${fn}\\b`).test(at), at.trim())
  }
  const blogCode = blankStrings(stripComments(read("app/actions/blog.ts")))
  const doorBody = blogCode.slice(blogCode.indexOf("export async function generateBlogPost"), blogCode.indexOf("async function resolveBlogActor"))
  ok("the door resolves the session actor BEFORE the kernel call", doorBody.indexOf("resolveBlogActor(") > -1 && doorBody.indexOf("resolveBlogActor(") < doorBody.indexOf("writeBlogPost("))
  ok("the door has no blog_posts insert and no model call of its own", !/\.insert\(|generateText\(/.test(doorBody))
  const cron = stripComments(read("app/api/cron/blog-cadence-tick/route.ts"))
  ok("the cadence cron calls the kernel writer, not the cookie-session door", /writeBlogPost\(\s*\{\s*ctx:/.test(cron) && !/from\s+"@\/app\/actions\/blog"/.test(cron))
  ok("POSITIVE CONTROL — the cron finder flags the pre-86C import", /from\s+"@\/app\/actions\/blog"/.test(`import { generateBlogPost } from "@/app/actions/blog"`))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BLOG_WRITER_MERGE_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ BLOG_WRITER_MERGE_PASS — one compliance-first AI blog writer, session door + sessionless cron")
}

main().catch((err) => { console.error(err); process.exit(1) })
