#!/usr/bin/env tsx
/**
 * scripts/wave156-k-guard.ts — wave 156, lane 156K (canaries C22, C23)
 *
 * RECRUITING STAYS WITH THE ONE RECRUITING MANAGER; A PROSPECT IS NOT RE-FILED FROM A SUSPENDED SEAT; THE FUNNEL IS COUNTED
 * FROM PERSISTED EVENTS; AND NO TRAINING / GAMIFICATION REWARD CAN BE FORGED FROM THE BROWSER.
 *
 * §A  C22 — the manager registry has ONE recruiting owner (recruiting_manager) and no second one; every recruiting table, the
 *     recruit-outreach cron and the course-completion contract resolve to it; no user type "recruit"; this lane wrote no
 *     migration (no user / seat / tier schema change); the seat gate module is byte-identical to the starting commit.
 * §B  RECRUITING INTAKE, DRIVEN — app/recruiting/[brokerageSlug]/actions.ts submitRecruitInquiry and
 *     lib/recruit-pipeline/recruit-processor.ts processRawRecruit against the in-memory client: a SUSPENDED member, a current
 *     member, a DECLINED recruit and a person already in the pipeline file NO new prospect; a member of another brokerage, a
 *     portal contact of this tenant and a new person DO (positive controls); a refused read files nothing; the public answer
 *     carries no internal id.
 * §C  ONBOARDING ONLY AFTER AN ACTUAL JOIN — app/api/recruiting/provision-agent POST: a recruit not yet Joined is refused before
 *     the seat gate; a suspended member of the tenant is refused before the seat gate and the provisioner (counted seams); a
 *     Joined new person reaches the seat gate exactly once, for the recruit's tenant, and then the ONE provisioner.
 * §D  TRAINING COMPLETION CANNOT BE CLAIMED — app/api/onboarding/training/progress POST: a browser that claims 100% at once,
 *     or after a long idle gap, is credited only real elapsed time; a video of another tenant is refused; an honest playback
 *     of a short video completes it (positive control); the Lead Management Essentials certification
 *     (lib/onboarding/certification-engine.ts) is NOT earned by the forged claim and IS earned by the honest one; a course with
 *     a required quiz (learning_modules) is not completed by any video save, and the route's own "all videos watched" event
 *     earns nothing — only the persisted graded pass does (positive control), once.
 * §E  GAMIFICATION REFLECTS PERSISTED OUTCOMES — the open-house count is HELD events (a cancelled one is refused, a replay
 *     emits nothing, a duplicate calendar row of the same open house earns once); the appointment reward needs an executed
 *     agreement preceded by a genuine appointment, and a RE-SIGN with the same buyer adds no points and no second badge; no
 *     "use server" / route file in app/ writes points, badges or calls the award RPC itself (comment-stripped census, control).
 * §F  THE FUNNEL AND ITS SCOPE — lib/recruiting/recruiting-roi-compute.ts computeRecruitingFunnel (pure) on a fixture with one
 *     recruit per path; app/actions/recruiting-roi.ts getRecruitingFunnel and getRecruitingROISummary DRIVEN for two tenants:
 *     an independent team's lead sees only their own tenant (count and money), and is not handed the books-only production
 *     stage; a refused ledger read shows its stages as unknown, never 0; the funnel reads no personal trait (source rule +
 *     positive control).
 *     ROUND 2 — WHO MAY READ WHICH FIGURE, driven: broker_owner (every stage and the money, tenant-wide); a team lead who is not
 *     the tenant principal (their team's stage counts by teams.team_lead_id; production NOT PERMITTED as a typed state; every
 *     money export refused NOT_PERMITTED in words); the compliance officer (reads the books, may not enter a cost); another
 *     tenant's broker (own tenant only); an agent, a vendor and a contact (refused); refused reads (UNKNOWN — never 0, never
 *     "not permitted"); an unreadable team scope refuses the funnel.
 *
 * RED AT BASE: WAVE156_K_ROOT=<a checkout of the starting commit> runs every driven check against that tree's modules.
 *
 * BLIND SPOTS (published). The in-memory client has no row security: the browser's DIRECT writes to video_completion_tracking
 * and recruits through the data API are governed by live policies this guard cannot see — the owner SQL in the lane report
 * closes them; until it is applied, a seat can still write its own percent_watched through the data API. Watch credit is a
 * wall-clock bound on the server's own writes: a script that keeps pinging the route for 0.45 × the video's length is
 * indistinguishable from playback at 2x (no client-side measurement can be proven). The rate limiter is per process. The
 * provisioner and seat gate are COUNTED seams here (their own rules are test:seat-cap / test:seat-user-convergence). Business-
 * card intake is not driven (it already refuses an existing member; a declined recruit's card is a human's deliberate act).
 * The funnel's "contacted" counts a recruiting draft a human APPROVED (approval delivers it to the recruiter, who sends it
 * personally) — a send outside the platform is not seen.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.WAVE156_K_ROOT || WT
const BASE2 = "/tmp/claude-0/-home-user-v0-Vip-Re-OS-V1/366a5662-e062-5f62-b566-b8516bba37ed/scratchpad/w156/base2"
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string, root = ROOT): string => { const p = join(root, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }

// ═══ ids ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000156`
const B1 = u("b", 1), B2 = u("b", 2)
const U_BROKER = u("a", 1), U_SUSP = u("a", 2), U_MEMBER = u("a", 3), U_CONTACT = u("a", 4), U_OTHER = u("a", 5), U_AGENT = u("a", 6), U_NEW = u("a", 8)
const AG = u("e", 6)
const R_DECL = u("c", 1), R_EXIST = u("c", 2), R_JOINED_NEW = u("c", 3), R_JOINED_SUSP = u("c", 4), R_OFFER = u("c", 5)

// ═══ seams ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__K = {
  svc: null as MemClient | null, seat: null as string | null, ctx: null as any,
  calls: { events: [] as any[], seat: [] as any[], invite: [] as any[] },
}
const withRpc = (m: MemClient): MemClient => {
  const t = (n: string) => (m.tables[n] ??= [])
  const writer = (a: Record<string, any>) => {
    const agent = t("agents").find((x) => x.id === a.p_agent_id)
    if (!agent) return { data: null, error: { message: "no agents row" } }
    agent.gamification_points = (agent.gamification_points ?? 0) + Number(a.p_points)
    const log = { id: u("9", 100 + t("agent_points_log").length), agent_id: agent.id, brokerage_id: agent.brokerage_id, points: a.p_points, reason: a.p_reason, reference_type: a.p_reference_type, reference_id: a.p_reference_id, created_at: new Date().toISOString() }
    t("agent_points_log").push(log)
    return { data: { brokerage_id: agent.brokerage_id, points_added: a.p_points, new_total: agent.gamification_points, log_id: log.id, already_awarded: false }, error: null }
  }
  return Object.assign(m, {
    rpc: async (fn: string, a: Record<string, any>) => {
      if (fn === "award_agent_points") return writer(a)
      if (fn === "award_agent_points_once") {
        const standing = t("agent_points_log").some((r) => r.agent_id === a.p_agent_id && r.reason === a.p_reason && (a.p_reference_id == null || r.reference_id === a.p_reference_id))
        return standing ? { data: { already_awarded: true }, error: null } : writer(a)
      }
      return { data: null, error: { message: `unknown rpc ${fn}`, code: "PGRST202" } }
    },
    auth: { getUser: async () => ({ data: { user: G.__K.seat ? { id: G.__K.seat, email: "seat@example.test", user_metadata: {} } : null }, error: null }) },
  })
}
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const OVERRIDE: Record<string, string> = {
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__K.svc }; export async function createServerClient(){ return globalThis.__K.svc }",
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__K.svc }",
  "lib/identity/get-agent-context.ts": "export async function getAgentContext(){ return globalThis.__K.ctx }",
  "lib/kernel/index.ts": "export async function processKernelEvent(p){ globalThis.__K.calls.events.push(p); return { success: true } }",
  "lib/kernel/notification-engine.ts": "export async function processKernelEvent(p){ globalThis.__K.calls.events.push(p); return { success: true } }",
  "lib/kernel/seat-usage.ts": "export async function seatGate(_svc, brokerageId, role, opts){ globalThis.__K.calls.seat.push({ brokerageId, role, opts }); return { allowed: true, reason: 'within_limit', decision: null, message: null, seatCount: 1, tier: 'brokerage' } }",
  "lib/kernel/users.ts": "export async function inviteTenantMember(p){ globalThis.__K.calls.invite.push(p); return { success: true, userId: '" + U_NEW + "', agentId: null } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})
const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
async function drive<X>(fn: () => Promise<X>): Promise<{ r: X | undefined; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}
function world(seed: Record<string, Row[]>, opts: Parameters<typeof memSupabase>[1] = {}): MemClient {
  const m = withRpc(memSupabase(seed, { uuidIds: true, stampCreatedAt: true, ...opts }))
  G.__K.svc = m
  G.__K.calls = { events: [], seat: [], invite: [] }
  return m
}
const T = (m: MemClient, t: string): Row[] => m.tables[t] ?? []
const isoAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const today = () => new Date().toISOString().slice(0, 10)
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

// ═══ §A ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
/** PURE: manager keys that claim recruiting, other than the one owner. */
const secondRecruitingOwners = (keys: string[]): string[] => keys.filter((k) => /recruit/i.test(k) && k !== "recruiting_manager")
async function sectionA() {
  section("§A C22 — one recruiting owner, no schema change")
  const reg = await load("lib/kernel/manager-registry.ts")
  const keys = Object.keys(reg.MANAGERS)
  check("the registry names recruiting_manager and NO second recruiting owner", keys.includes("recruiting_manager") && secondRecruitingOwners(keys).length === 0, keys)
  check("POSITIVE CONTROL: the finder flags a second recruiting owner", secondRecruitingOwners([...keys, "sphere_recruiting_owner"]).length === 1)
  check("sphere_of_influence still exists and owns no recruiting table", keys.includes("sphere_of_influence") && !Object.entries(reg.TABLE_MANAGER).some(([t, m]) => /recruit/.test(t) && m === "sphere_of_influence"))
  const recruitingTables = Object.keys(reg.TABLE_MANAGER).filter((t) => /recruit/.test(t))
  check(`every recruiting table resolves to recruiting_manager (${recruitingTables.join(", ")})`, recruitingTables.length >= 5 && recruitingTables.every((t) => reg.TABLE_MANAGER[t] === "recruiting_manager"))
  const cronKey = Object.keys(reg.CRON_MANAGER).find((k) => k.includes("recruit-outreach"))
  check("the recruit-outreach cron resolves to recruiting_manager", !!cronKey && reg.CRON_MANAGER[cronKey!] === "recruiting_manager", cronKey)
  check("the course-completion contract (education / certification) is recruiting_manager's", reg.MAINTENANCE_DOMAINS.course_completion_contract?.manager === "recruiting_manager")
  const vocab = (await import("./check-vocabularies")).CHECK_VOCABULARIES
  check("no user type 'recruit' in the live users.user_type vocabulary", !vocab.users.user_type.includes("recruit") && vocab.users.user_type.includes("agent"))
  const mine = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => /^m104[5-9]-/.test(f))
  check("this lane wrote no migration (m1045–m1049 unused): no user / seat / tier schema change", mine.length === 0, mine)
  const seatSame = existsSync(join(BASE2, "lib/kernel/seat-usage.ts")) && raw("lib/kernel/seat-usage.ts") === readFileSync(join(BASE2, "lib/kernel/seat-usage.ts"), "utf8")
  check("per-tenant seat caps unaffected: lib/kernel/seat-usage.ts is byte-identical to the starting commit", seatSame)
}

// ═══ §B ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const intakeWorld = (opts: Parameters<typeof memSupabase>[1] = {}) => world({
  brokerages: [{ id: B1, slug: "alpha", name: "Alpha", is_active: true, archived_at: null, deleted_at: null }, { id: B2, slug: "beta", name: "Beta", is_active: true, archived_at: null, deleted_at: null }],
  users: [
    { id: U_BROKER, brokerage_id: B1, user_type: "broker", status: "active", email: "broker@alpha.test" },
    { id: U_SUSP, brokerage_id: B1, user_type: "agent", status: "suspended", email: "suspended@alpha.test" },
    { id: U_MEMBER, brokerage_id: B1, user_type: "agent", status: "active", email: "member@alpha.test" },
    { id: U_CONTACT, brokerage_id: B1, user_type: "contact", status: "active", email: "client_agent@elsewhere.test" },
    { id: U_OTHER, brokerage_id: B2, user_type: "agent", status: "active", email: "switcher@beta.test" },
  ],
  agents: [], notifications: [],
  recruits: [
    { id: R_DECL, brokerage_id: B1, first_name: "Dee", last_name: "Clined", email: "declined@x.test", status: "declined", provisioned: false },
    { id: R_EXIST, brokerage_id: B1, first_name: "Eve", last_name: "Xist", email: "existing@x.test", status: "contacted", provisioned: false },
  ],
  raw_recruit_prospects: [], lead_scraping_markets: [{ id: u("f", 1), state: "TX", brokerage_id: B1 }], platform_prospects: [],
}, opts)
async function sectionB() {
  section("§B recruiting intake — a suspended seat is never re-filed as a prospect")
  let act: any
  try { act = await load("app/recruiting/[brokerageSlug]/actions.ts") } catch (e) { check("the public recruiting action loads", false, (e as Error).message); return }
  const submit = (email: string, first = "Pat", last = "Doe") => drive(() => act.submitRecruitInquiry({ brokerageSlug: "alpha", firstName: first, lastName: last, email }))
  const rowsFor = (m: MemClient, email: string) => T(m, "recruits").filter((r) => String(r.email).toLowerCase() === email.toLowerCase())

  let m = intakeWorld()
  const s1 = await submit("Suspended@alpha.test")
  check("a SUSPENDED member of this brokerage submitting the public page files NO prospect", rowsFor(m, "suspended@alpha.test").length === 0, { r: s1.r, threw: s1.threw })
  check("…the public answer is the same thanks (no refusal that reveals the seat), and the broker is told", !!s1.r && (s1.r as any).success === true && !(s1.r as any).recruitId && T(m, "notifications").some((n) => n.user_id === U_BROKER && /SUSPENDED/.test(String(n.body))), s1.r)
  m = intakeWorld()
  await submit("member@alpha.test")
  check("a current member of this brokerage files no prospect", rowsFor(m, "member@alpha.test").length === 0)
  m = intakeWorld()
  await submit("declined@x.test", "Dee", "Clined")
  check("a recruit who DECLINED is not re-opened as a new prospect (still one row, still declined)", rowsFor(m, "declined@x.test").length === 1 && rowsFor(m, "declined@x.test")[0].status === "declined")
  m = intakeWorld()
  await submit("existing@x.test", "Eve", "Xist")
  check("a person already in the pipeline gets no second row", rowsFor(m, "existing@x.test").length === 1)
  m = intakeWorld()
  const ok1 = await submit("switcher@beta.test", "Sam", "Witcher")
  check("POSITIVE: an agent of ANOTHER brokerage is a legitimate recruit — filed under this tenant as a prospect", rowsFor(m, "switcher@beta.test").length === 1 && rowsFor(m, "switcher@beta.test")[0].brokerage_id === B1 && rowsFor(m, "switcher@beta.test")[0].status === "prospect", ok1)
  m = intakeWorld()
  await submit("client_agent@elsewhere.test", "Cal", "Client")
  check("POSITIVE: a portal CONTACT of this tenant is not a member — filed as a prospect", rowsFor(m, "client_agent@elsewhere.test").length === 1)
  m = intakeWorld({ refuse: { users: "permission denied (fixture)" } })
  const ref = await submit("brand_new@x.test", "Bran", "New")
  check("a refused member read files NOTHING (fail closed) and says so", rowsFor(m, "brand_new@x.test").length === 0 && (ref.r as any)?.success === false, ref.r)

  let proc: any
  try { proc = await load("lib/recruit-pipeline/recruit-processor.ts") } catch (e) { check("the recruit promotion loads", false, (e as Error).message); return }
  const RAW = u("f", 10), RAW2 = u("f", 11)
  m = intakeWorld()
  T(m, "raw_recruit_prospects").push(
    { id: RAW, brokerage_id: null, market_id: u("f", 1), source: "reddit_agent_switch", source_record_id: "r1", raw_data: {}, normalized_preview: { firstName: "Sus", lastName: "Pended", email: "suspended@alpha.test", state: "TX" }, processing_status: "pending" },
    { id: RAW2, brokerage_id: null, market_id: u("f", 1), source: "reddit_agent_switch", source_record_id: "r2", raw_data: {}, normalized_preview: { firstName: "Nora", lastName: "Newman", email: "nora@x.test", state: "TX" }, processing_status: "pending" },
  )
  const p1 = await drive(() => proc.processRawRecruit(RAW))
  check("the scraped-signal promotion does not file a suspended member as a prospect", rowsFor(m, "suspended@alpha.test").length === 0 && (p1.r as any)?.action !== "created", p1.r ?? p1.threw)
  const p2 = await drive(() => proc.processRawRecruit(RAW2))
  check("POSITIVE: the promotion files a new person under the market's brokerage", rowsFor(m, "nora@x.test").length === 1 && (p2.r as any)?.action === "created", p2.r ?? p2.threw)
}

// ═══ §C ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionC() {
  section("§C onboarding only after an actual join; a suspended seat is not re-provisioned")
  let route: any
  try { route = await load("app/api/recruiting/provision-agent/route.ts") } catch (e) { check("the provisioning route loads", false, (e as Error).message); return }
  const fresh = () => {
    const m = intakeWorld()
    T(m, "recruits").push(
      { id: R_JOINED_NEW, brokerage_id: B1, first_name: "New", last_name: "Hire", email: "newhire@x.test", status: "joined", provisioned: false },
      { id: R_JOINED_SUSP, brokerage_id: B1, first_name: "Sus", last_name: "Pended", email: "suspended@alpha.test", status: "joined", provisioned: false },
      { id: R_OFFER, brokerage_id: B1, first_name: "Off", last_name: "Er", email: "offer@x.test", status: "offer_extended", provisioned: false },
    )
    G.__K.seat = U_BROKER
    return m
  }
  const post = (recruitId: string) => drive(async () => {
    const res = await route.POST(new Request("http://localhost/api/recruiting/provision-agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recruitId }) }))
    return { status: res.status, body: await res.json() }
  })
  let m = fresh()
  const offer = await post(R_OFFER)
  check("a recruit with an offer but no join decision is refused (422) — no seat gate, no provisioner", (offer.r as any)?.status === 422 && G.__K.calls.seat.length === 0 && G.__K.calls.invite.length === 0, offer.r ?? offer.threw)
  m = fresh()
  const susp = await post(R_JOINED_SUSP)
  check("a recruit whose email is a SUSPENDED member of this tenant is refused (409) before the seat gate and the provisioner; the recruit stays unprovisioned",
    (susp.r as any)?.status === 409 && G.__K.calls.seat.length === 0 && G.__K.calls.invite.length === 0 && T(m, "recruits").find((r) => r.id === R_JOINED_SUSP)?.provisioned === false, susp.r ?? susp.threw)
  m = fresh()
  const okp = await post(R_JOINED_NEW)
  check("POSITIVE: a Joined new person reaches the seat gate ONCE for the recruit's tenant, then the one provisioner, and is marked provisioned",
    (okp.r as any)?.status === 200 && G.__K.calls.seat.length === 1 && G.__K.calls.seat[0].brokerageId === B1 && G.__K.calls.invite.length === 1 && T(m, "recruits").find((r) => r.id === R_JOINED_NEW)?.provisioned === true, okp.r ?? okp.threw)
}

// ═══ §D ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const V_FORGE = u("7", 1), V_IDLE = u("7", 2), V_SHORT = u("7", 3), V_X = u("7", 4), V_ANON = u("7", 5), V_CERT_FORGE = u("7", 6), V_CERT_HONEST = u("7", 7)
const MOD = u("8", 1)
const Q5 = [0, 1, 2, 3, 4].map((i) => ({ q: `Question ${i + 1}`, choices: ["a", "b", "c", "d"], correct_idx: i % 4, explainer: `Tip ${i + 1}` }))
const trainingWorld = (videos: Row[], tracking: Row[] = []) => world({
  users: [{ id: U_AGENT, brokerage_id: B1, user_type: "agent" }],
  agents: [{ id: AG, user_id: U_AGENT, brokerage_id: B1, gamification_points: 0 }],
  training_videos: videos, video_completion_tracking: tracking, agent_certifications: [], agent_action_ledger: [], lifecycle_events: [],
  learning_modules: [{ id: MOD, brokerage_id: B1, required: true, status: "published", title: "Course with a quiz", quiz_questions: Q5 }],
  learning_assignments: [{ id: u("8", 2), brokerage_id: B1, module_id: MOD, agent_user_id: U_AGENT, status: "viewed", viewed_at: isoAgo(3600), signal_metadata: {} }],
  agent_points_log: [], gamification_badges: [], agent_badges: [], notifications: [],
})
const vid = (id: string, duration: number, over: Row = {}) => ({ id, brokerage_id: null, title: `Video ${id.slice(0, 2)}`, category: "lead_management", is_required: true, duration_seconds: duration, ...over })
async function sectionD() {
  section("§D a training video is completed by watched time the server measured, never by the browser's claim")
  let route: any, cert: any, awards: any, events: any
  try {
    route = await load("app/api/onboarding/training/progress/route.ts")
    cert = await load("lib/onboarding/certification-engine.ts")
    awards = await load("lib/gamification/lifecycle-awards.ts")
    events = await load("lib/kernel/events.ts")
  } catch (e) { check("the training modules load", false, (e as Error).message); return }
  const ctx = { isAuthenticated: true, agentId: AG, brokerageId: B1, userId: U_AGENT }
  const post = (videoId: string, percentWatched: number, positionSeconds = 1) => drive(async () => {
    const res = await route.POST(new Request("http://localhost/api/onboarding/training/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videoId, positionSeconds, percentWatched }) }))
    return { status: res.status, body: await res.json() }
  })
  const row = (m: MemClient, v: string) => T(m, "video_completion_tracking").find((r) => r.training_video_id === v)
  const videoEvents = () => G.__K.calls.events.filter((e: any) => e.event === events.KernelEvent.TRAINING_VIDEO_COMPLETED).length

  G.__K.ctx = { isAuthenticated: false, agentId: null, brokerageId: null, userId: null }
  let m = trainingWorld([vid(V_ANON, 600)])
  const anon = await post(V_ANON, 100)
  check("an anonymous POST is refused (401) and writes nothing", (anon.r as any)?.status === 401 && T(m, "video_completion_tracking").length === 0, anon.r)

  G.__K.ctx = ctx
  m = trainingWorld([vid(V_FORGE, 600)])
  const f1 = await post(V_FORGE, 100, 600)
  check("a first POST claiming 100% of a 10-minute video completes NOTHING and credits nothing (no recorded time yet)", (f1.r as any)?.status === 200 && row(m, V_FORGE)?.completed !== true && Number(row(m, V_FORGE)?.percent_watched ?? 0) === 0 && videoEvents() === 0, { r: f1.r, row: row(m, V_FORGE) })

  m = trainingWorld([vid(V_IDLE, 600)], [{ id: u("6", 1), agent_id: AG, brokerage_id: B1, training_video_id: V_IDLE, percent_watched: 0, completed: false, created_at: isoAgo(86400), updated_at: isoAgo(86400) }])
  await post(V_IDLE, 100, 600)
  const idle = row(m, V_IDLE)
  check("a claim of 100% a DAY after the last save is credited one capped step (30 s × 2 of 600 s = 10%), not completed", idle?.completed !== true && Math.abs(Number(idle?.percent_watched) - 10) < 0.01, idle)

  m = trainingWorld([vid(V_X, 20, { brokerage_id: B2 })])
  const xr = await post(V_X, 50)
  check("a video of ANOTHER tenant is refused (404) and no progress row is written", (xr.r as any)?.status === 404 && T(m, "video_completion_tracking").length === 0, xr.r)

  m = trainingWorld([vid(V_SHORT, 20)], [{ id: u("6", 2), agent_id: AG, brokerage_id: B1, training_video_id: V_SHORT, percent_watched: 0, completed: false, created_at: isoAgo(15), updated_at: isoAgo(15) }])
  const h = await post(V_SHORT, 95, 19)
  check("POSITIVE: an honest playback (15 s of real time on a 20-second video) completes it, once, and emits TRAINING_VIDEO_COMPLETED", (h.r as any)?.body?.completed === true && row(m, V_SHORT)?.completed === true && videoEvents() === 1, { r: h.r, row: row(m, V_SHORT) })

  // The certification that reads ONLY these videos.
  m = trainingWorld([vid(V_CERT_FORGE, 600)])
  await post(V_CERT_FORGE, 100, 600)
  const forged = await drive(() => cert.checkCertificationEligibility("Lead Management Essentials", AG, B1))
  check("the Lead Management Essentials certification is NOT earned by a browser's 100% claim", (forged.r as any)?.eligible === false, forged.r ?? forged.threw)
  m = trainingWorld([vid(V_CERT_HONEST, 20)], [{ id: u("6", 3), agent_id: AG, brokerage_id: B1, training_video_id: V_CERT_HONEST, percent_watched: 0, completed: false, created_at: isoAgo(15), updated_at: isoAgo(15) }])
  await post(V_CERT_HONEST, 95, 19)
  const honest = await drive(() => cert.checkCertificationEligibility("Lead Management Essentials", AG, B1))
  check("POSITIVE: the same certification IS earned after an honest playback", (honest.r as any)?.eligible === true, honest.r ?? honest.threw)

  // A course with a required quiz is a learning_modules row; no video save touches it, and the video route's event earns nothing.
  const asg = T(m, "learning_assignments")[0]
  check("a course with a required quiz is NOT completed by any video save (its assignment is still 'viewed')", asg.status === "viewed" && !asg.completed_at)
  const routeEvent = await drive(() => awards.awardLifecycleMilestones(m, { event: events.KernelEvent.TRAINING_COURSE_COMPLETED, brokerageId: B1, entityType: "agent", entityId: AG }))
  check("the video route's own 'all required videos watched' event (entity agent) earns NO points", (routeEvent.r as any)?.awarded?.length === 0 && T(m, "agent_points_log").length === 0, routeEvent.r ?? routeEvent.threw)
  const viewedOnly = await drive(() => awards.awardLifecycleMilestones(m, { event: events.KernelEvent.TRAINING_COURSE_COMPLETED, brokerageId: B1, entityType: "learning_module", entityId: MOD, metadata: { agent_id: AG } }))
  check("a course event for a course only VIEWED (no persisted pass) earns nothing", (viewedOnly.r as any)?.awarded?.length === 0, viewedOnly.r ?? viewedOnly.threw)
  const cc = await load("lib/academy/course-completion.ts")
  const pass = await drive(() => cc.recordCourseAttempt(m, { brokerageId: B1, userId: U_AGENT, module: T(m, "learning_modules")[0], answers: Object.fromEntries(Q5.map((q, i) => [i, q.correct_idx])) }))
  const earned = await drive(() => awards.awardLifecycleMilestones(m, { event: events.KernelEvent.TRAINING_COURSE_COMPLETED, brokerageId: B1, entityType: "learning_module", entityId: MOD, metadata: { agent_id: AG } }))
  const replay = await drive(() => awards.awardLifecycleMilestones(m, { event: events.KernelEvent.TRAINING_COURSE_COMPLETED, brokerageId: B1, entityType: "learning_module", entityId: MOD, metadata: { agent_id: AG } }))
  check("POSITIVE: after the PERSISTED graded pass the course earns TRAINING_COMPLETED once; a replay earns nothing",
    (pass.r as any)?.completedNow === true && (earned.r as any)?.awarded?.length === 1 && (replay.r as any)?.awarded?.length === 0 && T(m, "agent_points_log").length === 1, { pass: pass.r ?? pass.threw, earned: earned.r, replay: replay.r })

  // The rule itself, pure (absent at the starting commit).
  const credit = cert.creditWatchProgress
  check("PURE: creditWatchProgress — unknown duration credits nothing new; a first save credits 0; the gap is capped; the claim caps it",
    typeof credit === "function" &&
      credit({ durationSeconds: null, claimedPercent: 100, prior: { percentWatched: 40, lastWriteAt: isoAgo(10) }, now: new Date() }).creditedPercent === 40 &&
      credit({ durationSeconds: 600, claimedPercent: 100, prior: null, now: new Date() }).creditedPercent === 0 &&
      Math.abs(credit({ durationSeconds: 600, claimedPercent: 100, prior: { percentWatched: 0, lastWriteAt: isoAgo(99999) }, now: new Date() }).creditedPercent - 10) < 0.01 &&
      credit({ durationSeconds: 20, claimedPercent: 50, prior: { percentWatched: 0, lastWriteAt: isoAgo(15) }, now: new Date() }).creditedPercent === 50)
  const stripped = stripComments(raw("app/api/onboarding/training/progress/route.ts"))
  const claimRule = (s: string) => /percentWatched\s*>=\s*90/.test(s)
  check("SOURCE: the route no longer completes on the browser's percentWatched (comment-stripped)", !claimRule(stripped) && /creditWatchProgress\(/.test(stripped))
  check("POSITIVE CONTROL: the finder recognises the old claim rule", claimRule("const shouldComplete = percentWatched >= 90 && !wasCompleted"))
}

// ═══ §E ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionE() {
  section("§E open-house count, signed-agreement appointment, re-sign — persisted outcomes only")
  const awards = await load("lib/gamification/lifecycle-awards.ts")
  const { KernelEvent } = await load("lib/kernel/events.ts")
  const L = u("5", 1), OH1 = u("5", 2), OH_DUP = u("5", 3), OH_CXL = u("5", 4), C1 = u("5", 5), C2 = u("5", 6), BBA1 = u("5", 7), BBA2 = u("5", 8), BBA3 = u("5", 9), BADGE = u("5", 10)
  const m = world({
    users: [{ id: U_AGENT, brokerage_id: B1, user_type: "agent" }],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: B1, gamification_points: 0 }],
    open_house_events: [
      { id: OH1, brokerage_id: B1, listing_id: L, event_date: yesterday(), event_type: "open_house", status: "scheduled", cancelled_at: null, created_at: isoAgo(864000), agent_id: AG },
      { id: OH_DUP, brokerage_id: B1, listing_id: L, event_date: yesterday(), event_type: "open_house", status: "scheduled", cancelled_at: null, created_at: isoAgo(86400), agent_id: AG },
      { id: OH_CXL, brokerage_id: B1, listing_id: L, event_date: today(), event_type: "open_house", status: "cancelled", cancelled_at: isoAgo(100), created_at: isoAgo(86400), agent_id: AG },
    ],
    calendar_events: [{ id: u("5", 11), brokerage_id: B1, entity_type: "contact", entity_id: C1, agent_user_id: U_AGENT, status: "completed", start_at: isoAgo(30 * 86400) }],
    buyer_broker_agreements: [
      { id: BBA1, brokerage_id: B1, agent_id: AG, buyer_contact_id: C1, status: "active", signed_at: isoAgo(20 * 86400), signed_method: "provider", cancelled_at: null, expiration_date: null },
      { id: BBA2, brokerage_id: B1, agent_id: AG, buyer_contact_id: C1, status: "active", signed_at: isoAgo(5 * 86400), signed_method: "provider", cancelled_at: null, expiration_date: null },
      { id: BBA3, brokerage_id: B1, agent_id: AG, buyer_contact_id: C2, status: "active", signed_at: isoAgo(5 * 86400), signed_method: "provider", cancelled_at: null, expiration_date: null },
    ],
    gamification_badges: [{ id: BADGE, badge_name: "Signed on the dotted line", badge_tier: "bronze", required_points: null, trigger_event: "SIGNED_AGREEMENT_APPOINTMENT", brokerage_id: null, is_active: true }],
    agent_badges: [], agent_points_log: [], notifications: [], open_house_attendees: [], event_attendance_evidence: [], open_house_rsvp_tracking: [], lifecycle_events: [],
  })
  const emits: any[] = []
  const emit = async (e: any) => { emits.push(e); return { error: null } }
  const cxl = await drive(() => awards.recordOpenHouseHeld(m, { eventId: OH_CXL, brokerageId: B1, via: "host_ended", emit }))
  check("a CANCELLED open house is never held (refused, no event)", (cxl.r as any)?.ok === false && emits.length === 0, cxl.r)
  const h1 = await drive(() => awards.recordOpenHouseHeld(m, { eventId: OH1, brokerageId: B1, via: "host_ended", emit }))
  const h1b = await drive(() => awards.recordOpenHouseHeld(m, { eventId: OH1, brokerageId: B1, via: "host_ended", emit }))
  check("the host ending the open house holds it and emits ONCE; a replay emits nothing", (h1.r as any)?.held === true && (h1b.r as any)?.alreadyCompleted === true && emits.length === 1, { h1: h1.r, h1b: h1b.r })
  await drive(() => awards.recordOpenHouseHeld(m, { eventId: OH_DUP, brokerageId: B1, via: "host_ended", emit }))
  const ohEv = (id: string) => ({ event: KernelEvent.LISTING_OPEN_HOUSE_COMPLETED, brokerageId: B1, entityType: "open_house_event", entityId: id })
  const a1 = await drive(() => awards.awardLifecycleMilestones(m, ohEv(OH1)))
  const a2 = await drive(() => awards.awardLifecycleMilestones(m, ohEv(OH_DUP)))
  const a3 = await drive(() => awards.awardLifecycleMilestones(m, ohEv(OH_CXL)))
  const ohPoints = T(m, "agent_points_log").filter((r) => r.reason === "OPEN_HOUSE_HOSTED")
  check("the open-house count is HELD events: two calendar rows of the same open house earn ONE award, a cancelled one earns none", ohPoints.length === 1 && (a1.r as any)?.awarded?.length === 1 && (a2.r as any)?.awarded?.length === 0 && (a3.r as any)?.awarded?.length === 0, { a1: a1.r, a2: a2.r, a3: a3.r })

  const sign = (id: string) => drive(() => awards.awardLifecycleMilestones(m, { event: KernelEvent.BUYER_BROKER_AGREEMENT_SIGNED, brokerageId: B1, entityType: "buyer_broker_agreement", entityId: id }))
  const s1 = await sign(BBA1)
  const s2 = await sign(BBA2)
  const s3 = await sign(BBA3)
  const sig = T(m, "agent_points_log").filter((r) => r.reason === "SIGNED_AGREEMENT_APPOINTMENT")
  check("an executed buyer agreement preceded by a genuine appointment earns the appointment reward and its badge once", (s1.r as any)?.awarded?.length === 1 && (s1.r as any)?.badgesAwarded === 1, s1.r)
  check("a RE-SIGN with the same buyer (same engagement) adds no points and no second badge", (s2.r as any)?.awarded?.length === 0 && (s2.r as any)?.badgesAwarded === 0 && sig.length === 1 && T(m, "agent_badges").length === 1, { s2: s2.r, badges: T(m, "agent_badges").length })
  check("an executed agreement with NO genuine appointment earns nothing", (s3.r as any)?.awarded?.length === 0 && sig.length === 1, s3.r)

  // No browser-reachable file writes a reward itself.
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(join(ROOT, d), { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) { if (f.name !== "node_modules") walk(p) } else if (/\.(ts|tsx)$/.test(f.name)) files.push(p) } }
  walk("app")
  const SELF_AWARD = /\bawardAgentPoints(?:Once)?\s*\(|rpc\(\s*["']award_agent_points|from\(\s*["'](?:agent_points_log|agent_badges)["']\s*\)\s*\.(?:insert|upsert|update)\(/
  const doors = files.filter((f) => { const s = raw(f); return /^\s*["']use server["']/m.test(s) || /\/route\.tsx?$/.test(f) })
  // The audited, gated call sites are DERIVED from lib/gamification/award-census.ts (path "call_site", trust verified_outcome):
  // an authorized contact reassignment and a tenant admin's audited correction (never to their own record).
  const { AWARD_CENSUS } = await load("lib/gamification/award-census.ts")
  const audited = new Set<string>((AWARD_CENSUS as Array<{ path: string; trust: string; emitters: Array<{ file: string }> }>)
    .filter((c) => c.path === "call_site" && c.trust === "verified_outcome").flatMap((c) => c.emitters.map((e) => e.file)))
  const hits = doors.filter((f) => SELF_AWARD.test(stripComments(raw(f))))
  const offenders = hits.filter((f) => !audited.has(f))
  check(`no "use server" action or route in app/ (${doors.length} files) writes points or badges or calls the award RPC itself, outside the ${hits.length - offenders.length} audited call sites the award census names`, offenders.length === 0 && hits.every((f) => audited.has(f)), { offenders, audited: [...audited] })
  check("POSITIVE CONTROL: the census finder recognises a self-award", SELF_AWARD.test(`await svc.from("agent_points_log").insert({ points: 50 })`) && SELF_AWARD.test(`await awardAgentPointsOnce(db, x)`))
}

// ═══ §F ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionF() {
  section("§F the recruiting funnel, from persisted events, inside the session's tenant")
  let compute: any
  try { compute = await load("lib/recruiting/recruiting-roi-compute.ts") } catch (e) { check("the funnel compute loads", false, (e as Error).message); return }
  const R = (n: number) => u("4", n)
  const PU4 = u("4", 40), AG4 = u("4", 41)
  const facts = {
    recruits: [
      { id: R(1), status: "prospect", provisioned: false, provisioned_user_id: null },
      { id: R(2), status: "contacted", provisioned: false, provisioned_user_id: null },
      { id: R(3), status: "declined", provisioned: false, provisioned_user_id: null },
      { id: R(4), status: "joined", provisioned: true, provisioned_user_id: PU4 },
      { id: R(5), status: "offer_extended", provisioned: false, provisioned_user_id: null },
    ],
    recordedMoves: { [R(3)]: ["contacted", "interviewing", "declined"] },
    approvedOutreach: [R(2)],
    seats: { [PU4]: { active: true, certified: true, producing: true } },
  }
  const expected = { sourced: 5, contacted: 4, conversation: 3, offer: 2, joined: 1, seat_provisioned: 1, trained: 1, retained: 1, producing: 1 }
  const got = typeof compute.computeRecruitingFunnel === "function" ? compute.computeRecruitingFunnel(facts) : null
  const asMap = (r: any) => Object.fromEntries((r?.stages ?? []).map((s: any) => [s.key, s.count]))
  check("PURE: every stage counted from the recorded events (a declined recruit's interview counts from the ledger)", !!got && JSON.stringify(asMap(got)) === JSON.stringify(expected) && got.declined === 1, got)
  const unknown = got ? compute.computeRecruitingFunnel({ ...facts, recordedMoves: null }) : null
  check("PURE: with the ledger unreadable the ledger-dependent stages are UNKNOWN (null), never 0", !!unknown && asMap(unknown).conversation === null && asMap(unknown).offer === null && asMap(unknown).sourced === 5, unknown)

  // Trait words bounded by non-letters ("agents" is not "age"; "date_of_birth" is "birth").
  const TRAITS = /(?:^|[^a-z])(age|birth\w*|dob|gender|sex|race|ethnic\w*|religio\w*|national_?origin|nationality|disab\w*|marital\w*|family_status|pregnan\w*|veteran\w*|sexual_orientation)(?=[^a-z]|$)/i
  // A top-level function's text: from its declaration to the first column-0 "}" line (a "}> {" type-literal close is not one).
  const body = (s: string, name: string) => { const at = s.search(new RegExp(`function\\s+${name}\\s*\\(`)); if (at < 0) return ""; const end = s.indexOf("\n}\n", at); return s.slice(at, end < 0 ? undefined : end) }
  const computeSrc = body(stripComments(raw("lib/recruiting/recruiting-roi-compute.ts")), "computeRecruitingFunnel")
  const actionSrc = body(stripComments(raw("app/actions/recruiting-roi.ts")), "getRecruitingFunnel")
  check("SOURCE: the funnel compute and its reader name no personal trait (comment-stripped, whole bodies)", computeSrc.includes("declined:") && actionSrc.includes("computeRecruitingFunnel(") && !TRAITS.test(computeSrc) && !TRAITS.test(actionSrc), { c: computeSrc.length, a: actionSrc.length })
  check("POSITIVE CONTROL: the trait finder recognises a trait column, and not the word agents", TRAITS.test(`select("id, gender, status")`) && TRAITS.test("r.date_of_birth") && !TRAITS.test(`from("agents").select("id, user_id, is_active")`))

  // ── ROUND 2: WHO MAY READ WHICH FIGURE, driven (app/actions/recruiting-roi.ts). B1 is a brokerage with two teams; U_LEAD1 leads
  // TM1 (teams.team_lead_id) and is NOT the tenant principal (two live teams), so the books are not theirs. B2 is another tenant.
  let act: any
  try { act = await load("app/actions/recruiting-roi.ts") } catch (e) { check("the recruiting ROI actions load", false, (e as Error).message); return }
  const U_OWNER = u("a", 30), U_LEAD1 = u("a", 31), U_AGENT1 = u("a", 32), U_VENDOR = u("a", 33), U_CLIENT = u("a", 34), U_CO = u("a", 35), U_BROKER2 = u("a", 36)
  const TM1 = u("3", 1), TM2 = u("3", 2), AG_T = u("4", 60), PU_T = u("4", 61)
  const roles = (m: MemClient) => m
  const tenants = (opts: Parameters<typeof memSupabase>[1] = {}) => roles(world({
    users: [
      { id: U_OWNER, brokerage_id: B1, user_type: "broker_owner" }, { id: U_LEAD1, brokerage_id: B1, user_type: "team_lead" },
      { id: U_AGENT1, brokerage_id: B1, user_type: "agent" }, { id: U_VENDOR, brokerage_id: B1, user_type: "vendor" },
      { id: U_CLIENT, brokerage_id: B1, user_type: "contact" }, { id: U_CO, brokerage_id: B1, user_type: "compliance_officer" },
      { id: U_BROKER2, brokerage_id: B2, user_type: "broker" }, { id: PU4, brokerage_id: B1, user_type: "agent" }, { id: PU_T, brokerage_id: B1, user_type: "agent" },
    ],
    user_role_assignments: [],
    teams: [{ id: TM1, brokerage_id: B1, team_lead_id: U_LEAD1, deleted_at: null }, { id: TM2, brokerage_id: B1, team_lead_id: U_OWNER, deleted_at: null }],
    recruits: [
      ...facts.recruits.map((r) => ({ ...r, brokerage_id: B1, recruiter_agent_id: null })),
      { id: R(6), brokerage_id: B1, status: "interviewing", provisioned: false, provisioned_user_id: null, recruiter_agent_id: AG_T },
      { id: R(20), brokerage_id: B2, status: "prospect", provisioned: false, provisioned_user_id: null, recruiter_agent_id: null },
      { id: R(21), brokerage_id: B2, status: "interviewing", provisioned: false, provisioned_user_id: null, recruiter_agent_id: null },
    ],
    agent_action_ledger: [{ id: R(30), brokerage_id: B1, action: "recruiting.recruit.advance_stage", status: "executed", subject_id: R(3), detail: { from: "contacted", to: "interviewing" } }],
    agent_client_messages: [{ id: R(31), brokerage_id: B1, agent_kind: "recruiting_manager", entity_type: "recruit", entity_id: R(2), status: "approved" }],
    agents: [{ id: AG4, user_id: PU4, brokerage_id: B1, is_active: true, team_id: TM2 }, { id: AG_T, user_id: PU_T, brokerage_id: B1, is_active: true, team_id: TM1 }],
    agent_certifications: [{ id: R(32), brokerage_id: B1, agent_id: AG4, certification_name: "Platform Fundamentals" }],
    recruiting_analytics: [{ id: R(33), brokerage_id: B1, recruited_agent_id: AG4, transaction_count: 2, year_number: 1 }],
    recruiting_roi: [
      { id: R(34), brokerage_id: B1, recruited_agent_id: AG4, total_recruiting_cost: 500000, lifetime_brokerage_net: 900000, roi_pct: 80, computed_at: isoAgo(60) },
      { id: R(35), brokerage_id: B2, recruited_agent_id: u("4", 50), total_recruiting_cost: 1000, lifetime_brokerage_net: 2000, roi_pct: 100, computed_at: isoAgo(60) },
    ],
    recruiting_costs: [{ id: R(36), brokerage_id: B1, recruited_agent_id: AG4, cost_type: "training", amount: 500000 }],
  }, opts))
  const stateOf = (r: any, k: string) => (r?.stages ?? []).find((s: any) => s.key === k)?.state
  // broker_owner: real figures for the whole tenant (6 recruits — R6 is TM1's), production included, and the money.
  const ownerExpected = { sourced: 6, contacted: 5, conversation: 4, offer: 2, joined: 1, seat_provisioned: 1, trained: 1, retained: 1, producing: 1 }
  tenants(); G.__K.seat = U_OWNER
  const fo = await drive(() => act.getRecruitingFunnel())
  check("broker_owner: the funnel counts the whole tenant through every stage, production included, every stage 'ok'", !!fo.r && JSON.stringify(asMap(fo.r)) === JSON.stringify(ownerExpected) && (fo.r as any).stages.every((s: any) => s.state === "ok") && (fo.r as any).scope === "tenant", fo.r ?? fo.threw)
  const so = await drive(() => act.getRecruitingROISummary())
  check("broker_owner: the money is read, this tenant's only (1 recruit, 500000 invested — not the other tenant's 1000)", (so.r as any)?.activeRecruits === 1 && (so.r as any)?.totalInvested === 500000, so.r ?? so.threw)
  const ao = await drive(() => act.getRecruitingAccess())
  check("broker_owner: access says the money is readable and the funnel is tenant-wide", (ao.r as any)?.money?.state === "ok" && (ao.r as any)?.funnelScope === "tenant", ao.r ?? ao.threw)
  // the finance-less team lead: THEIR team's stage counts; production NOT PERMITTED (never 0, never "unknown"); money refused in words.
  tenants(); G.__K.seat = U_LEAD1
  const fl = await drive(() => act.getRecruitingFunnel())
  check("team lead (not the principal): the funnel counts ONLY their team's recruits (1, referred by a TM1 agent), scope 'team'", !!fl.r && asMap(fl.r).sourced === 1 && asMap(fl.r).conversation === 1 && (fl.r as any).scope === "team", fl.r ?? fl.threw)
  check("team lead: production is NOT PERMITTED — a typed state, distinct from unknown and from a real 0", !!fl.r && stateOf(fl.r, "producing") === "not_permitted" && asMap(fl.r).producing === null && stateOf(fl.r, "sourced") === "ok", fl.r)
  const sl = await drive(() => act.getRecruitingROISummary())
  check("team lead: the ROI money is REFUSED in words (NOT_PERMITTED), never an empty zero-shaped answer", !!sl.threw && /NOT_PERMITTED/.test(sl.threw) && !sl.r, sl)
  const cl = await drive(() => act.getRecruitingCostBreakdown())
  const bl = await drive(() => act.getBreakEvenAnalysis())
  check("team lead: cost breakdown and break-even are refused the same way", /NOT_PERMITTED/.test(cl.threw ?? "") && /NOT_PERMITTED/.test(bl.threw ?? ""), { cl, bl })
  const al = await drive(() => act.getRecruitingAccess())
  check("team lead: access says the money is not permitted (with the reason) and the funnel is team-scoped", (al.r as any)?.money?.state === "not_permitted" && /books/.test((al.r as any)?.money?.reason ?? "") && (al.r as any)?.funnelScope === "team", al.r ?? al.threw)
  // compliance officer: reads the books (m467) — production and money readable — but does not keep them (no cost entry).
  tenants(); G.__K.seat = U_CO
  const fc = await drive(() => act.getRecruitingFunnel())
  const ac = await drive(() => act.addRecruitingCost(AG4, "training", 100))
  check("compliance officer: reads the books (production 'ok'), but may not enter a cost (keeps no books)", !!fc.r && stateOf(fc.r, "producing") === "ok" && /NOT_PERMITTED/.test(ac.threw ?? "") && T(G.__K.svc, "recruiting_costs").length === 1, { fc: fc.r ?? fc.threw, ac })
  // another tenant's admin sees only their own tenant.
  tenants(); G.__K.seat = U_BROKER2
  const f2 = await drive(() => act.getRecruitingFunnel())
  check("another tenant's broker sees only their tenant's recruits (2) and none of B1's", !!f2.r && asMap(f2.r).sourced === 2, f2.r ?? f2.threw)
  // refused seats.
  for (const [who, seat] of [["an agent", U_AGENT1], ["a vendor", U_VENDOR], ["a contact", U_CLIENT]] as const) {
    tenants(); G.__K.seat = seat
    const ff = await drive(() => act.getRecruitingFunnel())
    const fs = await drive(() => act.getRecruitingROISummary())
    const fx = await drive(() => act.getRecruitingAccess())
    check(`${who} is refused the funnel, the money and the access answer (Forbidden), nothing returned`, !!ff.threw && !!fs.threw && !!fx.threw && !ff.r && !fs.r && !fx.r && /Forbidden/.test(ff.threw ?? ""), { ff: ff.threw, fs: fs.threw })
  }
  // refused reads: unknown, never 0.
  tenants({ refuse: { agent_action_ledger: "permission denied (fixture)" } }); G.__K.seat = U_OWNER
  const fr = await drive(() => act.getRecruitingFunnel())
  check("a refused ledger read: the interview / offer stages are UNKNOWN (not 0, not 'not permitted') and the blind spot is named", !!fr.r && asMap(fr.r).conversation === null && stateOf(fr.r, "conversation") === "unknown" && (fr.r as any).blindSpots.some((b: string) => /stage moves/.test(b)), fr.r ?? fr.threw)
  tenants({ refuse: { recruiting_analytics: "permission denied (fixture)" } }); G.__K.seat = U_OWNER
  const fp = await drive(() => act.getRecruitingFunnel())
  check("a refused production read for a books reader: production UNKNOWN, not 0", !!fp.r && stateOf(fp.r, "producing") === "unknown" && asMap(fp.r).producing === null, fp.r ?? fp.threw)
  tenants({ refuse: { teams: "permission denied (fixture)" } }); G.__K.seat = U_LEAD1
  const ft = await drive(() => act.getRecruitingFunnel())
  check("a team lead whose team cannot be read gets NO counts (refused, fail closed) — never the tenant's or zeros", !!ft.threw && !ft.r, ft)
  tenants({ refuse: { recruiting_roi: "permission denied (fixture)" } }); G.__K.seat = U_OWNER
  const fz = await drive(() => act.getRecruitingROISummary())
  check("a refused money read throws its refusal — the summary never reads as 0", !!fz.threw && !fz.r, fz)
}


async function main() {
  console.log(`wave156-k-guard — ROOT=${ROOT}`)
  for (const s of [sectionA, sectionB, sectionC, sectionD, sectionE, sectionF]) {
    try { await s() } catch (e) { check(`${s.name} ran to completion`, false, (e as Error)?.stack?.split("\n").slice(0, 3).join(" | ")) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log("FAILED:"); for (const f of fails) console.log(`  - ${f}`) }
  process.exit(failed ? 1 : 0)
}
main()
