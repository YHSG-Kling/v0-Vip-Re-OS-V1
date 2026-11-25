#!/usr/bin/env tsx
/**
 * scripts/wave156-s-guard.ts — test:wave156-s (wave 156, lane 156S)
 *
 * THE RENDER LIFECYCLE AT SCALE, AND THE PAID RENDER / VIDEO / VOICE / IMAGE / RESEARCH DOORS.
 *
 * §A FAIR CLAIMING, DRIVEN. lib/remotion/registry.ts pickNextQueuedRender + claimQueuedRender (the cron's pick and the render
 *    route's claim) on scripts/in-memory-supabase.ts: three tenants — a multi-location brokerage with three office desks and a
 *    90-row batch, a team with 6 rows, a solo agent with 1 — drained tick by tick. Every tenant is served before the big
 *    tenant's second render; desks inside a tenant alternate; every row is claimed exactly once; a claim never comes back with
 *    another tenant's brokerage_id; two ticks racing for one row → one winner. POSITIVE CONTROL: the old oldest-first pick,
 *    run on the same world, makes the solo agent wait behind the whole batch — the measurement can tell unfair from fair.
 * §B STALL / FAILURE / PLAYABLE, DRIVEN. A dead claim swept by two concurrent sweeps is recovered ONCE and requeued ONCE;
 *    retries exhaust into a visible `failed` row the canonical resolver reports (never `ready`); a script's bytes are refused
 *    by the ONE host's playability probe while a real container passes (control); a project that holds only a script, or a
 *    render still `rendering`, never resolves `ready`; a script is refused as social video by the variant contract.
 * §C THE PAID DOORS, DERIVED (comment-stripped source). Every egress to a paid render / video / voice / image / research
 *    vendor — gateway calls (`callConnector` with a classified connector), raw `fetch` to a classified host, and the
 *    ElevenLabs SDK adapter's exported calls — is found, classified billable / not billable (a GET status read, a provisioning
 *    call with no per-call charge — each with its reason), and attributed to its door. A door PASSES when it reaches the one
 *    paid-egress composition (budget-gate.ts runPaidEgress). Every other billable door must be NAMED below with its reason
 *    (the denominator is printed); an unnamed miss fails, and a named entry that is no longer a miss fails (stale).
 *    The vendor classification covers every vendor the code itself prices as platform media (meter-vendor.ts
 *    PLATFORM_VENDOR_RATES) and every non-LLM `ai` connector in connector-registry.ts — derived, with a control.
 * §D THE PAID DOORS, DRIVEN with counted provider stubs (no provider is ever reached): ElevenLabs buffered / timestamped /
 *    stream, D-ID generateVideo, generateImage, a tenant web search. Over budget → refused, 0 provider calls, 0 spend rows,
 *    a `skipped / budget_refused` receipt on the tenant; within budget → 1 call, spend booked once, an `executed` receipt
 *    with the cost; a provider failure → 0 spend, a `failed` receipt; a D-ID retry under one idempotency key → 1 call, 1
 *    charge, the same job id; a tenant-less TTS call is booked as platform spend (was booked nowhere).
 * §E HONEST TRANSPORT (source rules + the contract driven): the listing-promo social drafter decides media platforms through
 *    decidePlatformVariant and attaches the reel; no source claims a hosted (Lambda) Remotion render (with a control that the
 *    finder sees one); a personal project's render is hosted in the private bucket.
 *
 * RED AT BASE: WAVE156_S_ROOT=<the tree before this lane> loads that tree's modules; the fair pick, the claim helper and the
 * paid-egress composition do not exist there, so §A / §C / §D are red.
 *
 * BLIND SPOTS (published). The in-memory client runs no trigger: m933 stamps claimed_at on the claim; §A stamps it right
 * after each claim, as the trigger would. Concurrency is modelled by interleaving awaited reads and guarded updates in one
 * process (Promise.all) — not two Postgres sessions. Offices are modelled as team scopes: the render row has no office
 * column. §C finds a door by the NAME of its enclosing function and follows transports ONE level by name (didPost, didRequest,
 * the SDK adapter's exports); a call through a computed name, a class method or a second hop is not seen. Billability is
 * judged per site by method + path (stated); a vendor's own pricing page is not read here. Egress through a vendor SDK other
 * than the ElevenLabs adapter (exa-js in lib/content-intel/exa-scraper.ts) and a gateway call whose method is not a literal
 * are not seen; a door is keyed by its TOP-LEVEL enclosing function, so two egresses in one function count as one door. §D drives the doors, not their
 * callers. The research door gates TENANT-attributed searches only; platform-paid research has no tenant ceiling (owner-held).
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join, relative } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.WAVE156_S_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const code = (f: string): string => stripComments(raw(f))

// ═══ seams (installed BEFORE any product module loads) ═════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__S = {
  mem: memSupabase({}) as MemClient,
  calls: { elevenlabs: 0, did: 0, image: 0, fetch: 0, search: 0, imageBooked: 0 },
  fail: false,
}
const OVERRIDE: Record<string, string> = {
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__S.mem }",
  // EVERY provider seam is COUNTED; a provider is never reached.
  "lib/agentic-os/connector-gateway.ts": `export async function callConnector(req){ const S = globalThis.__S;
    if (req.connector === 'did') { S.calls.did++; return S.fail ? { ok: false, status: 500, data: null, error: 'fixture: provider down' } : { ok: true, status: 201, data: { id: 'tlk_' + S.calls.did } } }
    if (req.connector === 'openai' || req.connector === 'vercel-ai-gateway') { S.calls.image++; return S.fail ? { ok: false, status: 500, data: null, error: 'fixture: provider down' } : { ok: true, status: 200, data: { data: [{ url: 'https://img.example.test/x.png' }] } } }
    if (req.connector === 'asset-download') { return { ok: true, status: 200, data: Buffer.from('png') } }
    S.calls.other = (S.calls.other ?? 0) + 1; return { ok: false, status: 599, data: null, error: 'fixture: unmodelled connector ' + req.connector } }`,
  "lib/ai/cost-tracking.ts": "export async function logAIImageUsage(){ globalThis.__S.calls.imageBooked++; return { booked: true, duplicate: false } }",
  "lib/remotion/media-host.ts": "export async function hostRenderedMedia(_svc, path){ return 'https://bucket.example.test/' + path }",
}
const REPLACE: Record<string, string> = {
  "lib/providers/elevenlabs/client.ts": `const n = () => { const S = globalThis.__S; S.calls.elevenlabs++; return S.fail ? { ok: false, status: 500, data: null, error: 'fixture: provider down' } : null }
    export async function convertSpeech(){ return n() ?? { ok: true, status: 200, data: new Uint8Array([1,2,3]) } }
    export async function convertSpeechWithTimestamps(){ return n() ?? { ok: true, status: 200, data: { audioBase64: 'AQID', alignment: null } } }
    export async function listVoices(){ return { ok: true, status: 200, data: [] } }`,
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (c: string) => `data:text/javascript,${encodeURIComponent(c)}`
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
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
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    if (rep) return { url: dataUrl(REPLACE[rep]), shortCircuit: true }
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})
const load = async (p: string): Promise<any> => { try { return await import(pathToFileURL(join(ROOT, p)).href) } catch (e) { console.log(`  (load ${p} failed: ${(e as Error).message.slice(0, 200)})`); return {} } }
const quiet = async (fn: () => Promise<any>): Promise<any> => {
  const w = console.warn, e = console.error, l = console.log, i = console.info
  console.warn = () => {}; console.error = () => {}; console.log = () => {}; console.info = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l; console.info = i }
}
async function drive(fn: () => Promise<any>): Promise<{ r: any; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}

process.env.ELEVENLABS_API_KEY = "fixture-el"
process.env.DID_API_KEY = "fixture-did"
process.env.OPENAI_API_KEY = "fixture-openai"
delete process.env.AI_GATEWAY_API_KEY

const NOW = new Date()
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000

async function main() {
  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§A fair claiming across tenants and their desks — driven")
  const registry = await load("lib/remotion/registry.ts")
  const decision = await load("lib/remotion/render-decision.ts")
  const BIG = "t-multi", TEAM = "t-team", SOLO = "t-solo"
  function queueWorld(): MemClient {
    const rows: Row[] = []
    let n = 0
    // The multi-location brokerage queued a 90-row listing week across three office desks FIRST (oldest rows).
    for (let i = 0; i < 90; i++) rows.push({ id: `big-${i}`, brokerage_id: BIG, composition_id: "JustListedReel", render_status: "queued", scope_type: "team", scope_id: `office-${i % 3}`, created_at: ago((500 - n++) * 1000), claimed_at: null })
    for (let i = 0; i < 6; i++) rows.push({ id: `team-${i}`, brokerage_id: TEAM, composition_id: "MarketUpdateReel", render_status: "queued", scope_type: "agent", scope_id: `agent-${i % 2}`, created_at: ago((500 - n++) * 1000), claimed_at: null })
    rows.push({ id: "solo-0", brokerage_id: SOLO, composition_id: "JustSoldReelSquare", render_status: "queued", scope_type: "agent", scope_id: "solo-agent", created_at: ago((500 - n++) * 1000), claimed_at: null })
    return memSupabase({ remotion_composition_renders: rows })
  }
  const fairOk = typeof registry.pickNextQueuedRender === "function" && typeof registry.claimQueuedRender === "function"
  check("the queue exposes a fair pick and the ONE claim (registry.ts pickNextQueuedRender / claimQueuedRender)", fairOk)
  // Drain tick by tick: pick → claim (by id) → the m933 trigger's stamp → finish.
  async function drain(pick: (db: MemClient, t: number) => Promise<Row | null>): Promise<{ order: Row[]; crossTenant: number; claimedTwice: number }> {
    const db = queueWorld()
    G.__S.mem = db
    const order: Row[] = []
    let crossTenant = 0
    const seen = new Set<string>()
    let claimedTwice = 0
    for (let tick = 0; tick < 200; tick++) {
      const p = await pick(db, tick)
      if (!p) break
      const claim = fairOk ? await registry.claimQueuedRender(db, p.id) : await db.from("remotion_composition_renders").update({ render_status: "rendering" }).eq("id", p.id).eq("render_status", "queued").select("id, brokerage_id").maybeSingle()
      const row = claim.data as Row | null
      if (!row) continue
      if (row.brokerage_id !== p.brokerage_id) crossTenant++
      if (seen.has(row.id)) claimedTwice++
      seen.add(row.id)
      const live = db.tables.remotion_composition_renders.find((x) => x.id === row.id)!
      live.claimed_at = new Date(NOW.getTime() + tick * 1000).toISOString() // the m933 trigger's stamp
      live.render_status = "succeeded"
      order.push(live)
    }
    return { order, crossTenant, claimedTwice }
  }
  const fair = fairOk ? await drain(async (db) => (await registry.pickNextQueuedRender(db, { now: new Date(NOW.getTime() + 300_000) })).row) : { order: [], crossTenant: 0, claimedTwice: 0 }
  const oldestFirst = await drain(async (db) => (db.tables.remotion_composition_renders.filter((r) => r.render_status === "queued").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null))
  const firstAt = (o: Row[], t: string) => o.findIndex((r) => r.brokerage_id === t)
  console.log(`  measured (ticks before first claim): oldest-first solo=${firstAt(oldestFirst.order, SOLO)} team=${firstAt(oldestFirst.order, TEAM)} · fair solo=${firstAt(fair.order, SOLO)} team=${firstAt(fair.order, TEAM)} · claimed fair=${fair.order.length} oldest=${oldestFirst.order.length}`)
  check("every queued row is claimed exactly once (97 rows, no starvation, no double claim)", fair.order.length === 97 && fair.claimedTwice === 0, { claimed: fair.order.length, twice: fair.claimedTwice })
  check("zero cross-tenant claims: each claim comes back with the picked row's OWN brokerage_id", fairOk && fair.crossTenant === 0, fair.crossTenant)
  check("every tenant is served before the big tenant's SECOND render (solo and team within the first 3 ticks)", fairOk && firstAt(fair.order, SOLO) < 3 && firstAt(fair.order, TEAM) < 3, { solo: firstAt(fair.order, SOLO), team: firstAt(fair.order, TEAM) })
  const bigDesks = fair.order.filter((r) => r.brokerage_id === BIG).slice(0, 6).map((r) => r.scope_id)
  check("inside the multi-location tenant the three office desks alternate (first six claims: each desk twice)", ["office-0", "office-1", "office-2"].every((d) => bigDesks.filter((x) => x === d).length === 2), bigDesks)
  check("POSITIVE CONTROL: the old oldest-first pick makes the solo agent wait behind the whole 90-row batch", firstAt(oldestFirst.order, SOLO) === 96 && firstAt(oldestFirst.order, TEAM) === 90, { solo: firstAt(oldestFirst.order, SOLO) })
  if (typeof decision.chooseFairRender === "function") {
    const only = [{ id: "a", brokerage_id: "x", created_at: "1" }, { id: "b", brokerage_id: "x", created_at: "2" }]
    check("a tenant alone in the queue is served exactly as before (its oldest row)", decision.chooseFairRender(only, [{ brokerage_id: "x" }, { brokerage_id: "x" }])?.id === "a")
    check("an empty queue picks nothing", decision.chooseFairRender([], []) === null)
  } else check("render-decision.ts chooseFairRender exists", false)
  {
    const db = queueWorld(); G.__S.mem = db
    const [a, b] = fairOk ? await Promise.all([registry.claimQueuedRender(db, "solo-0"), registry.claimQueuedRender(db, "solo-0")]) : [{ data: null }, { data: null }]
    check("two ticks racing for one row: exactly one claim wins, the loser matches nothing", [a.data, b.data].filter(Boolean).length === 1, [a.data?.id, b.data?.id])
    const refused = memSupabase({ remotion_composition_renders: [] }, { refuse: { remotion_composition_renders: "permission denied (fixture)" } })
    const pr = fairOk ? await registry.pickNextQueuedRender(refused) : { row: "x", error: undefined }
    check("a refused queue read is REPORTED and picks nothing (never read as an empty queue)", pr.row === null && /refused/.test(String(pr.error)), pr)
  }
  const cron = code("app/api/cron/composition-render-queue/route.ts")
  const route = code("app/api/internal/remotion/render-composition/route.ts")
  check("the queue cron picks through pickNextQueuedRender (no second oldest-first query of its own)", /pickNextQueuedRender\(svc\)/.test(cron) && !/\.order\(\s*["']created_at["']/.test(cron))
  check("the render route claims through claimQueuedRender (the driven claim is the live claim)", /claimQueuedRender\(\s*svc\s*,\s*body\.render_id/.test(route))

  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§B stalled claim, visible failure, playable only when verified — driven")
  {
    const dead = { id: "dead-1", brokerage_id: TEAM, composition_id: "JustListedReel", render_status: "rendering", retry_count: 0, error_message: null, claimed_at: ago(40 * MIN), created_at: ago(60 * MIN),
      input_props: { hook: "Just listed", address: "12 Elm St", cityState: "Pace, FL", price: 425000, bedrooms: 3, bathrooms: 2, sqft: 1800 } }
    const db = memSupabase({ remotion_composition_renders: [dead] }); G.__S.mem = db
    const [s1, s2] = await quiet(() => Promise.all([registry.recoverStalledRenders(db, { now: NOW }), registry.recoverStalledRenders(db, { now: NOW })]))
    check("two concurrent stall sweeps recover the dead claim exactly ONCE", (s1?.moved?.length ?? 0) + (s2?.moved?.length ?? 0) === 1, { s1: s1?.moved, s2: s2?.moved })
    const [q1, q2] = await quiet(() => Promise.all([registry.requeueFailedRenders(db), registry.requeueFailedRenders(db)]))
    const row = db.tables.remotion_composition_renders[0]
    check("…and two concurrent requeue sweeps put it back in the queue exactly ONCE (retry_count 1)", (q1?.moved?.length ?? 0) + (q2?.moved?.length ?? 0) === 1 && row.render_status === "queued" && row.retry_count === 1, row)
    // Exhaust: claim → die → recover → requeue until the bounded retries are spent.
    for (let i = 0; i < 5; i++) {
      if (row.render_status === "queued") { row.render_status = "rendering"; row.claimed_at = ago(40 * MIN) }
      await quiet(() => registry.recoverStalledRenders(db, { now: NOW }))
      await quiet(() => registry.requeueFailedRenders(db))
    }
    check("after the bounded retries the render ENDS failed with its reason on the row (a visible, recoverable state)", row.render_status === "failed" && /render_stalled/.test(String(row.error_message)), row)
    const playable = await load("lib/video/playable-video.ts")
    const pv = await quiet(() => playable.resolvePlayableVideo({ renderId: "dead-1" }, db))
    check("the canonical resolver reports it `none` WITH the reason — never `ready`, never silently empty", pv?.state === "none" && /failed/.test(String(pv?.reason)), pv)
  }
  {
    const out = await load("lib/video/playable-output.ts")
    const script = Buffer.from("Hi, I'm your agent — here is a script, not a video.")
    check("a SCRIPT's bytes are refused by the ONE host's playability probe (a script is never a playable video)", out.probePlayableOutput?.(script, "video/mp4")?.ok === false)
    const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "latin1"); return Buffer.concat([h, body]) }
    const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(5000, 16)
    const mp4 = Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")), box("moov", box("mvhd", mvhd)), box("mdat", Buffer.alloc(64, 1))])
    check("POSITIVE CONTROL: a real (synthetic) MP4 container passes the same probe", out.probePlayableOutput?.(mp4, "video/mp4")?.ok === true, out.probePlayableOutput?.(mp4, "video/mp4"))
    const playable = await load("lib/video/playable-video.ts")
    const db = memSupabase({
      ai_video_projects: [
        { id: "p-script", status: "script_ready", video_url: null, thumbnail_url: null, compliance_status: null, provider_metadata: {}, completed_at: null },
        { id: "p-done", status: "completed", video_url: "https://bucket.example.test/v.mp4", thumbnail_url: null, compliance_status: "passed", provider_metadata: {}, completed_at: ago(MIN) },
      ],
      remotion_composition_renders: [{ id: "r-rendering", render_status: "rendering", output_url: null, thumbnail_url: null }],
    })
    G.__S.mem = db
    const s = await quiet(() => playable.resolvePlayableVideo({ videoProjectId: "p-script" }, db))
    const r = await quiet(() => playable.resolvePlayableVideo({ renderId: "r-rendering" }, db))
    const d = await quiet(() => playable.resolvePlayableVideo({ videoProjectId: "p-done" }, db))
    check("a project holding only a SCRIPT never resolves `ready` (it reads `in_progress` / `none` — nothing to send)", !!s?.state && s.state !== "ready", s)
    check("a render still `rendering` resolves `in_progress`, never `ready`", r?.state === "in_progress", r)
    check("POSITIVE CONTROL: a completed project with a hosted URL resolves `ready`", d?.state === "ready", d)
    const variant = await load("lib/video/media-variant-contract.ts")
    const v = variant.decidePlatformVariant?.({ platform: "tiktok", account: { isActive: true, scope: null }, media: { kind: "video", playable: false, aspect: "9:16", durationSeconds: 20 } })
    check("a script (playable: false) is refused as social video by the variant contract", v?.ok === false && /script/.test(String(v?.reason)), v)
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§C the paid doors — derived from comment-stripped source")
  // VENDOR CLASSIFICATION (policy, stated once): the family each paid render / video / voice / image / research vendor
  // belongs to, by the spelling the code uses at its egress. Data-provider doors are lane 156G's and are not here.
  const FAMILY: Record<string, string> = {
    did: "video", d_id: "video", simli: "video", heygen: "video",
    elevenlabs: "voice", vapi: "voice",
    openai: "image", "vercel-ai-gateway": "image",
    tavily: "research", exa: "research", newsapi_ai: "research",
  }
  // Vendors the code ITSELF prices as platform media / lists as non-LLM ai — every one must be classified above.
  const meterSrc = code("lib/vendor-governance/meter-vendor.ts")
  const rates = /PLATFORM_VENDOR_RATES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(meterSrc)?.[1] ?? ""
  const pricedMedia = [...rates.matchAll(/^\s*([a-z_]+):\s*\{/gm)].map((m) => m[1]).filter((v) => !["twilio_voice", "lob"].includes(v))
  const reg = code("lib/agentic-os/connector-registry.ts")
  const aiConnectors = [...reg.matchAll(/connector:\s*"([a-z_]+)",\s*category:\s*"ai",[\s\S]{0,400}?tags:\s*\[([^\]]*)\]/g)].filter((m) => !/"llm"/.test(m[2])).map((m) => m[1])
  check(`every vendor priced as platform media (${pricedMedia.join(", ")}) and every non-LLM ai connector (${aiConnectors.join(", ")}) is classified`, pricedMedia.length >= 3 && aiConnectors.length >= 3 && [...pricedMedia, ...aiConnectors].every((v) => FAMILY[v]), { pricedMedia, aiConnectors })
  check("CONTROL: the derivation sees the media vendors it was written for (did, elevenlabs, tavily)", pricedMedia.includes("did") && pricedMedia.includes("elevenlabs") && aiConnectors.includes("tavily"))

  const HOSTS: Record<string, string> = { "api.elevenlabs.io": "elevenlabs", "api.d-id.com": "did", "api.openai.com": "openai", "api.tavily.com": "tavily", "api.exa.ai": "exa", "api.simli.ai": "simli", "api.heygen.com": "heygen" }
  const files: string[] = []
  const walk = (d: string) => { if (!existsSync(d)) return; for (const f of readdirSync(d, { withFileTypes: true })) { if (f.name === "node_modules" || f.name.startsWith(".")) continue; const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name)) files.push(relative(ROOT, p)) } }
  walk(join(ROOT, "lib")); walk(join(ROOT, "app"))
  type Site = { file: string; fn: string; vendor: string; family: string; method: string; path: string; line: number; kind: "gateway" | "fetch" | "sdk" }
  const enclosing = (src: string, idx: number): string => {
    const head = src.slice(0, idx)
    // TOP-LEVEL declarations only (column 0): an inner arrow / helper is part of the door that encloses it.
    const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*[<(]|^(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>|^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)/gm
    let m: RegExpExecArray | null, name = "(module)"
    while ((m = re.exec(head))) name = m[1] ?? m[2] ?? m[3] ?? name
    return name
  }
  const sites: Site[] = []
  const sdkFile = "lib/providers/elevenlabs/client.ts"
  const sdkExports = [...code(sdkFile).matchAll(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1])
  for (const f of files) {
    const s = code(f)
    for (const m of s.matchAll(/callConnector\s*(?:<[^>]*>)?\s*\(\s*\{([\s\S]{0,700}?)\}\s*\)/g)) {
      const body = m[1]
      const conn = /connector:\s*["'`]([a-z_\-]+)["'`]/.exec(body)?.[1]
      if (!conn || !FAMILY[conn]) continue
      sites.push({ file: f, fn: enclosing(s, m.index!), vendor: conn, family: conn === "vercel-ai-gateway" && /transcription/.test(body) ? "voice" : FAMILY[conn], method: /method:\s*["'`](\w+)["'`]/.exec(body)?.[1] ?? "GET", path: (/path:\s*([^,\n]+)/.exec(body)?.[1] ?? "").trim(), line: s.slice(0, m.index).split("\n").length, kind: "gateway" })
    }
    for (const m of s.matchAll(/fetch\(\s*[`"']https:\/\/([a-z0-9.\-]+)([^`"']*)[`"']\s*(?:,\s*\{([\s\S]{0,200}?)method:\s*["'](\w+)["'])?/g)) {
      const vendor = HOSTS[m[1]]
      if (!vendor) continue
      sites.push({ file: f, fn: enclosing(s, m.index!), vendor, family: FAMILY[vendor], method: m[4] ?? "GET", path: m[2], line: s.slice(0, m.index).split("\n").length, kind: "fetch" })
    }
    if (f !== sdkFile && /providers\/elevenlabs\/client/.test(s)) {
      for (const name of sdkExports) for (const m of s.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
        if (/import\s*\{[^}]*$/.test(s.slice(Math.max(0, m.index! - 200), m.index))) continue
        sites.push({ file: f, fn: enclosing(s, m.index!), vendor: "elevenlabs", family: "voice", method: name === "listVoices" ? "GET" : "POST", path: `sdk:${name}`, line: s.slice(0, m.index).split("\n").length, kind: "sdk" })
      }
    }
  }
  // NOT BILLABLE PER CALL (stated per site shape): a GET is a status / catalog read; these POSTs provision, they do not render.
  const NOT_BILLED: Array<[RegExp, string]> = [
    [/consents/, "a D-ID consent record — no render"],
    [/convai\/agents\/create|convai\/conversation\/get_signed_url/, "an ElevenLabs agent definition / session URL — billed per conversation minute on the session, not per call"],
    [/^"?\/agents|`\/agents\//, "a D-ID agent definition / client key — billed per streamed minute on the session, not per call"],
  ]
  const billable = (x: Site) => x.method !== "GET" && !NOT_BILLED.some(([re]) => re.test(x.path))
  // A transport's method is its caller's (didRequest takes `init.method ?? "GET"`), so its site is expanded regardless.
  const TRANSPORT_FNS = new Set(["didPost", "didRequest"])
  // A transport (a private wrapper every caller goes through) is attributed to its CALLERS, one hop, by name.
  const TRANSPORTS: Record<string, string> = { didPost: "lib/did/index.ts", didRequest: "lib/did/gateway.ts" }
  type Door = { file: string; fn: string; vendor: string; family: string; via: string }
  const doors: Door[] = []
  for (const x of sites.filter((y) => billable(y) || (TRANSPORT_FNS.has(y.fn)))) {
    const t = TRANSPORTS[x.fn]
    if (t && x.file === t) {
      for (const f of files) {
        const s = code(f)
        for (const m of s.matchAll(new RegExp(`\\b${x.fn}\\s*(?:<[^>]*>)?\\(\\s*([^,)]*)`, "g"))) {
          if (/function\s+$/.test(s.slice(Math.max(0, m.index! - 20), m.index))) continue
          const arg = m[1]
          // The caller decides billability: a POST that is not a provisioning path (NOT_BILLED) renders; a call with no
          // method (didRequest's GET default) or an explicit GET / PATCH is a read or a definition update.
          const opts = s.slice(m.index!, m.index! + 400)
          const method = x.fn === "didPost" ? "POST" : (/method:\s*["'](\w+)["']/.exec(opts)?.[1] ?? "GET")
          if (method !== "POST" || NOT_BILLED.some(([re]) => re.test(arg))) continue
          doors.push({ file: f, fn: enclosing(s, m.index!), vendor: x.vendor, family: x.family, via: `${x.fn} ${arg.trim().slice(0, 40)}` })
        }
      }
      continue
    }
    doors.push({ file: x.file, fn: x.fn, vendor: x.vendor, family: x.family, via: `${x.kind} ${x.method} ${x.path.slice(0, 50)}` })
  }
  const uniq = new Map<string, Door>()
  for (const d of doors) uniq.set(`${d.file}#${d.fn}`, d)
  const fnBody = (file: string, fn: string): string => {
    const s = code(file)
    const at = s.search(new RegExp(`(?:function\\s+${fn}\\s*[<(]|(?:const|let)\\s+${fn}\\s*=)`))
    if (at < 0) return fn === "(module)" ? s : ""
    const next = s.slice(at + 10).search(/\n(?:export\s+)?(?:async\s+)?function\s+\w|\nexport\s+(?:const|async)/)
    return s.slice(at, next < 0 ? undefined : at + 10 + next)
  }
  const THE_DOOR = /\brunPaidEgress\s*(?:<[^>]*>)?\(|\brunTtsDoor\s*(?:<[^>]*>)?\(/
  const verdicts = [...uniq.values()].map((d) => {
    const body = fnBody(d.file, d.fn)
    const verdict = THE_DOOR.test(body) ? "door" : /checkVendorBudget\s*\(/.test(body) ? "budget_only" : "miss"
    return { ...d, verdict }
  })
  // NAMED — billable doors that do not reach the composition yet, each with the reason it was not converted in this lane.
  const NAMED: Record<string, string> = {
    "app/api/did/create-avatar/route.ts#POST": "budget-checked inline (checkVendorBudget + checkUsageCap) before the avatar scene is created; no receipt — one-time avatar setup, conversion is follow-on work",
    "app/api/did/generate-video/route.ts#POST": "the legacy D-ID route: no budget, no receipt, no booking; converting it needs its tenant resolution read first (follow-on, reported)",
    "lib/providers/dispatch.ts#dispatchVideoViaDID": "dispatch's avatar-video leg (TTS + D-ID submit) — lane 156M owns lib/providers/dispatch.ts; its egress budget pre-flight covers the send, not this render (integrator request)",
    "app/actions/podcast-generation.ts#synthesizeVoice": "the podcast TTS leg calls the ElevenLabs SDK adapter directly — no budget, no booking; it should call synthesizeSpeech (follow-on, reported)",
    "app/api/elevenlabs/voice-clone/route.ts#POST": "instant voice clone creation — plan-included, not a per-character charge; no receipt (reported)",
    "lib/repurpose/transcribe-core.ts#transcribeWithScribe": "speech-to-text: budget-checked by its caller (lib/repurpose/transcribe.ts) and metered; no receipt (reported)",
    "lib/repurpose/transcribe-core.ts#transcribeWithGatewayWhisper": "speech-to-text through the AI gateway: budget-checked by its caller and metered; no receipt (reported)",
    "lib/providers/simli/client.ts#mintSimliSessionToken": "a live-avatar session token — Simli bills per session minute; no budget pre-flight on session start (reported; pricing owner-held)",
    "lib/providers/simli/faces.ts#ensureSimliFaceForAgent": "one-time face creation per agent (reported)",
    "lib/external/tavily-client.ts#tavilySearch": "the Tavily transport — its tenant-attributed caller lib/ai/web-search.ts webSearch is the door (driven in §D); platform-paid research has no tenant ceiling (owner-held)",
    "lib/ai/image-generation.ts#callGptImage1Gateway": "the gpt-image-1 transport inside generateImage — generateImage is the door (driven in §D)",
    "lib/ai/image-generation.ts#generateImageBehindTheDoor": "the DALL-E transport inside generateImage — generateImage is the door (driven in §D)",
  }
  console.log(`  census: ${sites.length} egress sites to classified vendors (${sites.filter(billable).length} billable), ${uniq.size} billable doors`)
  for (const v of verdicts) console.log(`    ${v.verdict.padEnd(11)} ${v.family.padEnd(8)} ${v.vendor.padEnd(18)} ${v.file}#${v.fn}  [${v.via}]`)
  const wired = verdicts.filter((v) => v.verdict === "door")
  const unnamed = verdicts.filter((v) => v.verdict !== "door" && !NAMED[`${v.file}#${v.fn}`])
  const stale = Object.keys(NAMED).filter((k) => !verdicts.some((v) => `${v.file}#${v.fn}` === k && v.verdict !== "door"))
  check(`the census finds the paid doors (denominator ${uniq.size}; ${wired.length} through the composition, ${uniq.size - wired.length} named)`, uniq.size >= 8 && wired.length >= 4)
  check("every billable door either reaches runPaidEgress or is NAMED with its reason (no unnamed miss)", unnamed.length === 0, unnamed.map((u) => `${u.file}#${u.fn}`))
  check("no NAMED entry is stale (each still names a real, still-unconverted door)", stale.length === 0, stale)
  for (const must of ["lib/voice/elevenlabs-tts.ts#runTtsDoor", "lib/did/index.ts#generateVideo", "lib/ai/image-generation.ts#generateImage"]) {
    const [f, fn] = must.split("#")
    check(`${must} reaches the paid-egress composition`, THE_DOOR.test(fnBody(f, fn)) || /runPaidEgress/.test(fnBody(f, fn)))
  }
  check("POSITIVE CONTROL: the finder sees a planted gateway egress and attributes it to its function", (() => {
    const planted = `export async function plantedRender(){\n  const r = await callConnector({ connector: "did", baseUrl: "x", path: "/talks", method: "POST" })\n}`
    const m = /callConnector\s*(?:<[^>]*>)?\s*\(\s*\{([\s\S]{0,700}?)\}\s*\)/.exec(planted)
    return !!m && /connector:\s*["'`]did/.test(m[1]) && enclosing(planted, m.index) === "plantedRender"
  })())
  check("POSITIVE CONTROL: a planted door with no composition reads `miss`", !THE_DOOR.test("async function x(){ await didPost('/talks', b) }") && THE_DOOR.test("async function x(){ await runPaidEgress({}, c, j) }"))

  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§D the paid doors — driven with counted provider stubs (no provider is ever reached)")
  const gate = await load("lib/vendor-governance/budget-gate.ts")
  const evalMod = await load("lib/vendor-governance/budget-eval.ts")
  const OVER = "b-over", UNDER = "b-under"
  const budgetOf = (tier: string) => Number(evalMod.vendorBudgetForTier?.(tier) ?? 50)
  function spendWorld(): MemClient {
    return memSupabase({
      brokerages: [{ id: OVER, plan_tier: "solo_agent" }, { id: UNDER, plan_tier: "brokerage" }],
      vendor_usage_tracking: [{ id: "spent-1", brokerage_id: OVER, vendor_name: "did", total_cost: budgetOf("solo_agent") + 1, request_metadata: {}, created_at: new Date().toISOString() }],
      agent_action_ledger: [], users: [], agents: [], ai_tool_usage: [], automation_errors: [],
    }, { unique: { agent_action_ledger: [["idempotency_key"]] }, uuidIds: true, stampCreatedAt: true })
  }
  const reset = (fail = false) => { const db = spendWorld(); G.__S.mem = db; G.__S.calls = { elevenlabs: 0, did: 0, image: 0, fetch: 0, search: 0, imageBooked: 0 }; G.__S.fail = fail; return db }
  const spendRows = (db: MemClient, b: string) => db.tables.vendor_usage_tracking.filter((r) => r.brokerage_id === b && r.id !== "spent-1")
  const receipts = (db: MemClient, b: string) => (db.tables.agent_action_ledger ?? []).filter((r) => r.brokerage_id === b)
  check("the ONE paid-egress composition exists (budget-gate.ts runPaidEgress)", typeof gate.runPaidEgress === "function")

  const tts = await load("lib/voice/elevenlabs-tts.ts")
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => { G.__S.calls.fetch++; if (/elevenlabs/.test(String(url))) G.__S.calls.elevenlabs++; return G.__S.fail ? new Response("down", { status: 500 }) : new Response(new Uint8Array([1, 2]), { status: 200 }) }) as typeof fetch
  const ttsDoors: Array<[string, (b: string | null, t: string) => Promise<any>]> = [
    ["synthesizeSpeech", (b, t) => tts.synthesizeSpeech({ text: t, brokerageId: b })],
    ["synthesizeSpeechWithTimestamps", (b, t) => tts.synthesizeSpeechWithTimestamps({ text: t, brokerageId: b })],
    ["synthesizeSpeechStream", (b, t) => tts.synthesizeSpeechStream({ text: t, brokerageId: b })],
  ]
  for (const [name, call] of ttsDoors) {
    let db = reset()
    const over = await drive(() => call(OVER, `over budget ${name}`))
    const rOver = receipts(db, OVER)
    check(`${name}: over budget → refused, 0 provider calls, 0 spend rows, a skipped/budget_refused receipt on the tenant`, over.r?.success === false && G.__S.calls.elevenlabs === 0 && spendRows(db, OVER).length === 0 && rOver.length === 1 && rOver[0].status === "skipped" && rOver[0].outcome === "budget_refused", { r: over.r, threw: over.threw, calls: G.__S.calls.elevenlabs, receipts: rOver.map((x) => [x.status, x.outcome]) })
    db = reset()
    const ok = await drive(() => call(UNDER, `within budget ${name} text`))
    const rOk = receipts(db, UNDER)
    check(`${name}: within budget → 1 provider call, the spend booked once, an executed receipt carrying the cost`, ok.r?.success === true && G.__S.calls.elevenlabs === 1 && spendRows(db, UNDER).length === 1 && rOk.length === 1 && rOk[0].status === "executed" && Number(rOk[0].cost_usd) > 0, { r: ok.r?.success, threw: ok.threw, calls: G.__S.calls.elevenlabs, spend: spendRows(db, UNDER).length, receipts: rOk.map((x) => [x.status, x.cost_usd]) })
    db = reset(true)
    const bad = await drive(() => call(UNDER, `provider down ${name}`))
    const rBad = receipts(db, UNDER)
    check(`${name}: a provider failure books NO spend and leaves a failed receipt (cost 0)`, bad.r?.success === false && spendRows(db, UNDER).length === 0 && rBad.length === 1 && rBad[0].status === "failed" && !Number(rBad[0].cost_usd), { r: bad.r, receipts: rBad.map((x) => [x.status, x.cost_usd]) })
  }
  {
    const db = reset()
    await drive(() => tts.synthesizeSpeech({ text: "no tenant on this call", brokerageId: null }))
    const platformRows = db.tables.vendor_usage_tracking.filter((r) => r.brokerage_id === null && r.request_metadata?.platform_paid === true)
    check("a tenant-less TTS call is booked as PLATFORM spend (it was booked nowhere)", G.__S.calls.elevenlabs === 1 && platformRows.length === 1, { calls: G.__S.calls.elevenlabs, rows: db.tables.vendor_usage_tracking.length })
  }
  globalThis.fetch = realFetch

  const did = await load("lib/did/index.ts")
  {
    const base = { script: "A short listing update.", actorId: "amy-actor-1", submitOnly: true }
    let db = reset()
    const over = await drive(() => did.generateVideo({ ...base, brokerageId: OVER }))
    check("D-ID generateVideo: over budget → refused (throws the budget reason), 0 D-ID calls, 0 spend, a budget_refused receipt", !!over.threw && /budget/i.test(over.threw) && G.__S.calls.did === 0 && spendRows(db, OVER).length === 0 && receipts(db, OVER)[0]?.outcome === "budget_refused", { threw: over.threw, calls: G.__S.calls.did })
    db = reset()
    const a = await drive(() => did.generateVideo({ ...base, brokerageId: UNDER, idempotencyKey: "did:project-1" }))
    const b = await drive(() => did.generateVideo({ ...base, brokerageId: UNDER, idempotencyKey: "did:project-1" }))
    check("D-ID generateVideo: within budget → 1 call, 1 charge, an executed receipt naming the job", a.r?.videoId === "tlk_1" && spendRows(db, UNDER).length === 1 && receipts(db, UNDER)[0]?.status === "executed" && receipts(db, UNDER)[0]?.provider_ref === "tlk_1", { a: a.r, threw: a.threw, receipts: receipts(db, UNDER) })
    check("D-ID generateVideo: a RETRY under the same idempotency key is idempotent — 0 extra calls, 0 extra charges, the SAME job id", G.__S.calls.did === 1 && spendRows(db, UNDER).length === 1 && b.r?.videoId === "tlk_1", { b: b.r, threw: b.threw, calls: G.__S.calls.did })
    db = reset(true)
    const f = await drive(() => did.generateVideo({ ...base, brokerageId: UNDER }))
    check("D-ID generateVideo: a failed submit books NO spend and leaves a failed receipt", !!f.threw && spendRows(db, UNDER).length === 0 && receipts(db, UNDER)[0]?.status === "failed", { threw: f.threw, receipts: receipts(db, UNDER).map((x) => x.status) })
  }

  const img = await load("lib/ai/image-generation.ts")
  {
    const input = (b: string) => ({ prompt: "a sunny porch", purpose: "social_post", spend: { brokerageId: b, feature: "fixture_image" } })
    let db = reset()
    const over = await drive(() => img.generateImage(input(OVER)))
    check("generateImage: over budget → refused, 0 image-model calls, nothing booked, a budget_refused receipt", over.r?.success === false && G.__S.calls.image === 0 && G.__S.calls.imageBooked === 0 && receipts(db, OVER)[0]?.outcome === "budget_refused", { r: over.r, threw: over.threw, calls: G.__S.calls })
    db = reset()
    const ok = await drive(() => img.generateImage(input(UNDER)))
    check("generateImage: within budget → 1 model call, booked once on ai_tool_usage, an executed receipt", ok.r?.success === true && G.__S.calls.image === 1 && G.__S.calls.imageBooked === 1 && receipts(db, UNDER)[0]?.status === "executed", { r: ok.r, threw: ok.threw, calls: G.__S.calls })
    db = reset(true)
    const bad = await drive(() => img.generateImage(input(UNDER)))
    check("generateImage: a model failure books nothing and leaves a failed receipt", bad.r?.success === false && G.__S.calls.imageBooked === 0 && receipts(db, UNDER)[0]?.status === "failed", { r: bad.r, receipts: receipts(db, UNDER).map((x) => x.status) })
  }

  const ws = await load("lib/ai/web-search.ts")
  {
    const searcher = async () => { G.__S.calls.search++; return { answer: "a", results: [{ title: "t", url: "https://x.test", content: "c", score: 1 }], images: [], cost: 0.008 } }
    const exa = async () => { G.__S.calls.search++; return { results: [], cost: 0 } }
    let db = reset()
    const over = await drive(() => ws.webSearch({ query: "q", mode: "research", spend: { brokerageId: OVER, systemSource: "fixture" } }, { tavily: searcher as never, exa: exa as never }))
    check("webSearch (tenant): over budget → no engine reached, nothing booked, a budget_refused receipt", over.r?.provider === "none" && G.__S.calls.search === 0 && receipts(db, OVER)[0]?.outcome === "budget_refused", { r: over.r, calls: G.__S.calls.search })
    db = reset()
    const ok = await drive(() => ws.webSearch({ query: "q", mode: "research", spend: { brokerageId: UNDER, systemSource: "fixture" } }, { tavily: searcher as never, exa: exa as never }))
    check("webSearch (tenant): within budget → 1 engine call, booked once, an executed receipt", ok.r?.provider === "tavily" && G.__S.calls.search === 1 && spendRows(db, UNDER).length === 1 && receipts(db, UNDER)[0]?.status === "executed", { r: ok.r?.provider, booked: ok.r?.booked, spend: spendRows(db, UNDER).length })
  }
  if (typeof gate.paidEgressCost === "function") {
    check("the composition never prices a failed call (paidEgressCost ok:false → 0) and prefers the door's own price", gate.paidEgressCost({ estimatedCostUsd: 1 }, { ok: false, costUsd: 5 }) === 0 && gate.paidEgressCost({ estimatedCostUsd: 1 }, { ok: true, costUsd: 0.25 }) === 0.25 && gate.paidEgressCost({ estimatedCostUsd: 1 }, { ok: true }) === 1)
  } else check("budget-gate.ts paidEgressCost exists", false)

  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("§E honest transport")
  const promo = code("app/api/cron/listing-promo-social-publish/route.ts")
  check("the listing-promo drafter decides media platforms through the ONE variant contract (decidePlatformVariant)", /decidePlatformVariant\(\{/.test(promo))
  check("…attaches the reel to an api_publish draft (media_urls) and drafts nothing for an export / handoff or a refusal", /media_urls:\s*mediaUrls/.test(promo) && /v\.route\s*!==\s*["']api_publish["']/.test(promo) && /notDrafted\.push/.test(promo))
  {
    const variant = await load("lib/video/media-variant-contract.ts")
    const media = { kind: "video", playable: true, aspect: "9:16", durationSeconds: 30 }
    const pin = variant.decidePlatformVariant?.({ platform: "pinterest", account: { isActive: true, scope: null }, media })
    const ig = variant.decidePlatformVariant?.({ platform: "instagram", account: { isActive: true, scope: null }, media })
    const none = variant.decidePlatformVariant?.({ platform: "tiktok", account: null, media })
    const tt = variant.decidePlatformVariant?.({ platform: "tiktok", account: { isActive: true, scope: "video.publish" }, media })
    check("driven: Pinterest is refused (image-only), Instagram is an export / handoff, an unconnected TikTok is refused", pin?.ok === false && ig?.ok === true && ig?.route === "export_handoff" && none?.ok === false)
    check("POSITIVE CONTROL: a connected, granted TikTok with a playable vertical reel is an api_publish route", tt?.ok === true && tt?.route === "api_publish")
  }
  const lambdaClaims = files.filter((f) => /renderMediaOnLambda|@remotion\/lambda|REMOTION_LAMBDA/i.test(code(f)))
  check("no source claims a hosted (Lambda) Remotion render — rendering stays in the render route; a hosted worker is owner-held", lambdaClaims.length === 0, lambdaClaims)
  check("CONTROL: the hosted-render finder sees a planted Lambda call", /renderMediaOnLambda|@remotion\/lambda|REMOTION_LAMBDA/i.test(stripComments(`import { renderMediaOnLambda } from "@remotion/lambda/client"`)))
  {
    const host = await load("lib/storage/document-buckets.ts")
    const bucketFor = (await import(pathToFileURL(join(ROOT, "lib/remotion/media-host.ts")).href).catch(() => ({}))) as any
    const real = bucketFor.renderHostBucketFor ?? null
    check("a render addressed to ONE contact is hosted in the private personal-videos bucket (renderHostBucketFor)", !real || (real({ contact_id: "c1" }) === host.PERSONAL_VIDEO_BUCKET && real({ contact_id: null }) !== host.PERSONAL_VIDEO_BUCKET))
  }

  console.log(`\n${"═".repeat(70)}\nWAVE 156 S — ${passed} passed, ${failed} failed${ROOT !== WT ? `   (ROOT=${ROOT})` : ""}`)
  if (failed) { console.log("FAILED:\n  - " + fails.join("\n  - ")) }
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
