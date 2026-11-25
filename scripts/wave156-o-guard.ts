#!/usr/bin/env tsx
/**
 * scripts/wave156-o-guard.ts — test:wave156-o (wave 156, lane 156O: production security and owner SQL, canaries C11 + C28)
 *
 * The release barrier as a CHECKED thing, not prose.
 *
 * §A THE PLATFORM-STAFF BOARD, DRIVEN — app/actions/superadmin/go-live-readiness.ts getGoLiveReadinessAction runs over
 *    counted stubs (session, service client, connector gateway, payment, email, Stripe resolver, BatchData — every provider
 *    seam counted, every provider env name cleared). Staff get the readiness with a configNote read from the ONE release-state
 *    source (lib/platform/go-live-readiness.ts RELEASE_STATES): it names all five states and prints no GO / release claim,
 *    even with every required domain ready (driven on the exported rollupReadiness). A tenant seat and an anonymous caller
 *    are refused before any probe runs, any provider is called or any audit row is written. The live storage-policy probe
 *    reads the function's verdict: open → broken naming the owner SQL, all scoped → ready (positive control).
 * §B C28 — the release-state rule (the one source): the five states are distinct; a live state refuses simulated / local
 *    evidence (negative) and accepts the owner's dated live read (positive control); SECURITY READBACK GREEN needs a named
 *    reader; nothing is MET while a blocker it names is open; the sheet's table is parsed and judged.
 * §C C11 — §R.6: a local PostgreSQL measurement, DERIVED from the 156E packet's own words, written as an APPLIED LIVE line is
 *    refused; the live line is accepted (positive control); the sheet's current line keeps R6 open.
 * §D THE SHEET — every step names category, who, before, do, after, rollback and what it unblocks; each "Also" names who,
 *    before, do and rollback; the step order matches the required order DERIVED from the sentence the sheet quotes (and, when
 *    the directive file is reachable, that sentence is the directive's). Controls: a swapped order and a missing After are caught.
 * §E OTHER SQL, DERIVED — §R.2's list is the live CHECK (scripts/check-vocabularies.ts) minus exactly the three retired events
 *    and nothing in app/ or lib/ (stripped) names a retired event as a literal; the competitor-ads upsert leads with the tenant
 *    (so §P.1 needs no code first); §R.1 stays HELD exactly while no code names `step_kind`.
 *
 * Every assertion reads comment-stripped source (scripts/strip-comments.ts) where it scans code. RED AT BASE: run with
 * W156O_ROOT=<the pre-wave checkout>; §A loads that tree's modules.
 * BLIND SPOTS (published): the live database, Vercel and counsel are not read here — the sheet records what an owner read;
 * this guard judges the SHAPE of that record, not that the read happened. The claim scan is phrase-based (RELEASE_CLAIM): a
 * new wording of a release claim is not seen until it is added there. The directive cross-check is skipped (printed) when the
 * directive file is not on this machine.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"

const WT = process.cwd()
const ROOT = process.env.W156O_ROOT || WT
const DIRECTIVE = process.env.W156_DIRECTIVE || "/tmp/claude-0/-home-user-v0-Vip-Re-OS-V1/366a5662-e062-5f62-b566-b8516bba37ed/scratchpad/w156/DIRECTIVE.md"
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300)}`}`) }
}
const raw = (f: string, root = ROOT) => { const p = join(root, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const section = (s: string) => console.log(`\n═══ ${s} ═══`)

// ── module hooks: counted seams (data: modules read their state from globalThis.__W156O) ─────────────────────────────
const G = globalThis as any
G.__W156O = { user: null as null | { id: string }, profile: null as any, calls: { connector: 0, stripe: 0, sendgrid: 0, batchdata: 0, stripeResolve: 0, rpc: 0, storage: 0, audit: 0 }, readiness: [] as any[] }
const S = "globalThis.__W156O"
const BY_SPEC: Record<string, string> = {
  "@/lib/supabase/server": `export async function createClient(){const s=${S};return{auth:{getUser:async()=>({data:{user:s.user}})},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:s.profile,error:null})})})})}}`,
  "@/lib/supabase/service": `export function createServiceClient(){const s=${S};const q={select(){return q},eq(){return q},then(r){return Promise.resolve({data:[],count:0,error:null}).then(r)}};return{from:(t)=>{if(t==="superadmin_audit_log")return{insert:async()=>{s.calls.audit++;return{error:null}}};return q},rpc:async(n)=>{s.calls.rpc++;return{data:s.readiness,error:null}},storage:{from:()=>({list:async()=>{s.calls.storage++;return{data:[],error:null}}})}}}`,
  "next/headers": `export async function headers(){return new Map()}`,
  "@/lib/agentic-os/connector-gateway": `export async function callConnector(){${S}.calls.connector++;return{ok:false,status:0,data:null}}`,
  "@/lib/providers/payment": `export async function getStripeBalance(){${S}.calls.stripe++;return{success:false,notConfigured:true,error:"stub: no platform credential"}}`,
  "@/lib/kernel/email-deliverability": `export async function probeSendgridDomainAuth(){${S}.calls.sendgrid++;return{status:"not_configured",detail:"stub"}}`,
  "@/lib/billing/resolve-stripe-account": `export async function resolvePlatformStripeAccount(){${S}.calls.stripeResolve++;return null}`,
  "@/lib/external/batchdata-mcp": `export async function callBatchDataMcp(){${S}.calls.batchdata++;return{ok:false}}`,
  "@/lib/geo/video-landing": `export function seoHintFromNarration(){return ""}`,
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`]) { const p = join(ROOT, c); if (existsSync(p) && !statSync(p).isDirectory()) return p }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const a = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    return a ? { url: pathToFileURL(a).href, shortCircuit: true } : next(spec, ctx)
  },
})
const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn() } finally { console.error = e; console.warn = w } }
const resetCalls = () => { for (const k of Object.keys(G.__W156O.calls)) G.__W156O.calls[k] = 0 }
const providerCalls = () => { const c = G.__W156O.calls; return c.connector + c.stripe + c.sendgrid + c.batchdata + c.stripeResolve }

// Every provider credential the probes read is cleared so no probe can reach a vendor (the seams count anything that tries).
for (const k of ["NEXT_PUBLIC_APP_URL", "CRON_SECRET", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY", "STRIPE_SECRET_KEY", "ELEVENLABS_API_KEY", "DID_API_KEY", "AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "BATCHDATA_MCP_URL", "BATCHDATA_API_KEY", "TWILIO_PLATFORM_NUMBER", "CONVERSATION_RELAY_WSS_URL"]) delete process.env[k]

const FIVE = ["CODE GREEN", "SECURITY READBACK GREEN", "LEGAL/LICENSING READY", "PREVIEW LIVE VERIFIED", "PUBLIC RELEASE AUTHORIZED"]
const OPEN_BUCKETS = ["agent-documents", "brokerage-forms", "client-documents", "offer-documents", "transaction-documents"].map((b) => ({ bucket_id: b, verdict: "open" })).concat([{ bucket_id: "documents", verdict: "service_only" }])
const SCOPED = OPEN_BUCKETS.map((b) => ({ ...b, verdict: b.bucket_id === "documents" || b.bucket_id === "offer-documents" ? "service_only" : "owner_scoped" }))

async function sectionA() {
  section("§A the platform-staff go-live board, driven")
  const lib = await load("lib/platform/go-live-readiness.ts").catch(() => ({} as any))
  const act = await load("app/actions/superadmin/go-live-readiness.ts").catch((e) => ({ __err: String(e) } as any))
  check("A0 the board's action and module load", typeof act.getGoLiveReadinessAction === "function" && typeof lib.rollupReadiness === "function", act.__err)
  if (typeof act.getGoLiveReadinessAction !== "function") return

  G.__W156O.user = { id: "u-staff" }; G.__W156O.profile = { user_type: "agent", platform_role: "superadmin", email: "s@x" }; G.__W156O.readiness = OPEN_BUCKETS; resetCalls()
  const staff: any = await quiet(() => act.getGoLiveReadinessAction())
  const note: string = staff?.readiness?.configNote ?? ""
  check("A1 platform staff get the readiness, audited once", staff?.ok === true && G.__W156O.calls.audit === 1, staff)
  check("A2 the board's note is read from the ONE source: it names all five release states and prints no GO", FIVE.every((k) => note.includes(k)) && !/\bGO\b/.test(note), note)
  check("A2 the note is exactly configurationNote(requiredReady, requiredTotal) of the same module (one source, no second wording)",
    typeof lib.configurationNote === "function" && note === lib.configurationNote(staff.readiness.requiredReady, staff.readiness.requiredTotal))
  const c3 = G.__W156O.calls
  check("A3 with every provider key cleared no probe reached a vendor: the egress seams (connector gateway, BatchData) are called 0 times; Stripe and SendGrid are asked once each through their own config-gated seam",
    c3.connector === 0 && c3.batchdata === 0 && c3.stripe === 1 && c3.sendgrid === 1, c3)
  const sp = (staff?.readiness?.domains ?? []).find((d: any) => d.key === "storage_policies")
  check("A4 the storage-policy domain reads the LIVE function: five open buckets → broken, naming the owner SQL", sp?.status === "broken" && /OWNER-SQL/.test(sp?.detail ?? "") && G.__W156O.calls.rpc === 1, sp)
  G.__W156O.readiness = SCOPED; resetCalls()
  const scoped: any = await quiet(() => act.getGoLiveReadinessAction())
  const sp2 = (scoped?.readiness?.domains ?? []).find((d: any) => d.key === "storage_policies")
  check("A4 POSITIVE CONTROL — every bucket owner-scoped or service-only → ready", sp2?.status === "ready", sp2)

  const all = lib.rollupReadiness([{ key: "a", label: "a", status: "ready", optional: false, detail: "" }, { key: "b", label: "b", status: "ready", optional: false, detail: "" }], "2026-11-25T00:00:00Z")
  check("A5 even with EVERY required configuration domain ready the board makes no release claim (no GO, no 'ready to sell', names the five states)",
    all.requiredReady === all.requiredTotal && !/\bGO\b/.test(all.configNote) && typeof lib.releaseClaimAllowed === "function" && lib.releaseClaimAllowed(all.configNote, false) && FIVE.every((k) => all.configNote.includes(k)))
  const card = stripComments(raw("app/dashboard/superadmin/connectors/go-live-card.tsx"))
  check("A6 the card renders the note and carries no GO literal of its own", /r\.configNote/.test(card) && !/["']\s*—\s*GO["']/.test(card))
  check("A6 POSITIVE CONTROL — the card pattern still sees the old GO literal", /["']\s*—\s*GO["']/.test(`{r.requiredReady === r.requiredTotal ? " — GO" : " — not yet"}`))

  for (const [label, user, profile] of [["a tenant broker_owner seat", { id: "u-b" }, { user_type: "broker_owner", platform_role: null, email: "b@x" }], ["an anonymous caller", null, null]] as const) {
    G.__W156O.user = user; G.__W156O.profile = profile; G.__W156O.readiness = OPEN_BUCKETS; resetCalls()
    const r: any = await quiet(() => act.getGoLiveReadinessAction())
    check(`A7 ${label} is refused before any probe, provider call or audit row`, r?.ok === false && G.__W156O.calls.rpc === 0 && G.__W156O.calls.storage === 0 && providerCalls() === 0 && G.__W156O.calls.audit === 0, { r, calls: G.__W156O.calls })
  }
}

async function sectionsBtoE() {
  const rules = await import(pathToFileURL(join(WT, "scripts/release-rules.ts")).href).catch(() => ({} as any))
  const lib = await load("lib/platform/go-live-readiness.ts").catch(() => ({} as any))
  section("§B C28 — the release-state rule (one source)")
  const ok = typeof lib.releaseStateVerdict === "function" && Array.isArray(lib.RELEASE_STATES)
  check("B0 the one source exists in the product module the board reads, and release-rules re-exports the SAME functions", ok && rules.releaseStateVerdict === lib.releaseStateVerdict && rules.RELEASE_STATES === lib.RELEASE_STATES)
  if (!ok) { section("§C–§E skipped (no source)"); return }
  const keys: string[] = lib.RELEASE_STATES.map((s: any) => s.key)
  check(`B1 the five states are DISTINCT keys with distinct evidence rules (${keys.join(" · ")})`, JSON.stringify(keys) === JSON.stringify(FIVE) && new Set(lib.RELEASE_STATES.map((s: any) => s.shape.map(String).join())).size === 5)
  const row = (k: string, over: any = {}) => { const s = lib.RELEASE_STATES.find((x: any) => x.key === k); return { state: k, status: "MET", date: "2026-12-01", origin: s.specimen.origin, reader: s.specimen.reader, evidence: s.specimen.evidence, ...over } }
  const v = (k: string, over: any = {}, open: string[] = [], others = true) => lib.releaseStateVerdict(k, row(k, over), { openBlockers: open, otherStatesMet: others })
  for (const k of FIVE.filter((x) => x !== "CODE GREEN")) {
    check(`B2 ${k}: simulated evidence is refused (origin simulated / local_db, or 'in-memory canary' in the evidence) — and its live specimen is accepted (positive control)`,
      !v(k, { origin: "simulated" }).met && !v(k, { origin: "local_db" }).met && !v(k, { evidence: `${row(k).evidence}; proven by the in-memory canary` }).met && v(k).met)
  }
  check("B2 CODE GREEN is not live: the integrator's local chain run may satisfy it, a simulated origin may not", v("CODE GREEN", { origin: "local_chain" }).met && !v("CODE GREEN", { origin: "simulated" }).met)
  check("B3 SECURITY READBACK GREEN requires a dated read by a NAMED reader (blank / 'lane 156O' / 'CI' readers and a missing date refused)",
    !v("SECURITY READBACK GREEN", { reader: "" }).met && !v("SECURITY READBACK GREEN", { reader: "lane 156O" }).met && !v("SECURITY READBACK GREEN", { reader: "CI" }).met && !v("SECURITY READBACK GREEN", { date: "—" }).met && v("SECURITY READBACK GREEN", { reader: "owner" }).met)
  check("B4 nothing is MET while a blocker it names is open (R6 holds SECURITY READBACK GREEN; SEK holds PREVIEW LIVE VERIFIED; LEGAL holds LEGAL/LICENSING READY)",
    !v("SECURITY READBACK GREEN", {}, ["R6"]).met && !v("PREVIEW LIVE VERIFIED", {}, ["SEK"]).met && !v("LEGAL/LICENSING READY", {}, ["LEGAL"]).met && !v("PUBLIC RELEASE AUTHORIZED", {}, [], false).met)
  const sheet = raw("docs/operations/WAVE156-OWNER-ACTION-SHEET.md")
  const table = lib.parseReleaseStateTable(sheet)
  const verdicts = lib.releaseStateVerdicts(table, ["R6"])
  check(`B5 the sheet's release-state table names the five states; today none is MET (${verdicts.map((x: any) => `${x.key}: ${x.met ? "MET" : x.why}`).join(" · ")})`, FIVE.every((k) => table.has(k)) && verdicts.every((x: any) => !x.met))
  const forged = sheet.replace(/^\| SECURITY READBACK GREEN \|[^\n]*$/m, "| SECURITY READBACK GREEN | MET | 2026-11-25 | simulated | owner | hrvaqgvukzxfskkcrwbt pg_policies storage_bucket_policy_readiness() all scoped |")
  const forgedV = lib.releaseStateVerdicts(lib.parseReleaseStateTable(forged), []).find((x: any) => x.key === "SECURITY READBACK GREEN")
  const honest = lib.releaseStateVerdicts(lib.parseReleaseStateTable(forged.replace("| simulated |", "| live_read |")), []).find((x: any) => x.key === "SECURITY READBACK GREEN")
  check("B6 a sheet row claiming SECURITY READBACK GREEN from a simulated origin reads NOT MET; the same row from a live read with no open blocker reads MET (positive control)", forgedV && !forgedV.met && honest?.met === true, { forgedV, honest })

  section("§C C11 — a local PostgreSQL measurement can never mark §R.6 applied")
  const packet = raw("docs/operations/WAVE156-R6-DEAL-TABLE-POLICY-PACKET.md")
  const localWords = /PostgreSQL 16\.\d+[^\n.|]*/.exec(packet)?.[0] ?? ""
  check(`C1 the packet itself names its local measurement ("${localWords.slice(0, 60)}")`, localWords.length > 0)
  check("C1 that measurement written as an APPLIED LIVE line — with the project, the 10 rows and the refusals — is REFUSED",
    typeof rules.r6AppliedLive === "function" && !rules.r6AppliedLive(`- R6 status: APPLIED LIVE 2026-11-25 — ${localWords}: hrvaqgvukzxfskkcrwbt 10 rows, vendor REFUSED`))
  check("C1 POSITIVE CONTROL — the owner's live read-back line lifts it", rules.r6AppliedLive?.("- R6 status: APPLIED LIVE 2026-12-01 — hrvaqgvukzxfskkcrwbt AFTER read-back 10 rows; two-tenant script 5 REFUSED then ROLLBACK") === true)
  check("C2 the sheet carries the R6 status line and today it keeps R6 OPEN", /^- R6 status:/m.test(sheet) && rules.r6AppliedLive?.(sheet) === false)
  check("C3 test:release-blockers and test:production-readiness both carry R6 as an obligation through the one rule (stripped source)",
    ["scripts/release-blockers-guard.ts", "scripts/production-readiness-guard.ts"].every((f) => { const s = stripComments(raw(f, WT)); return /\{\s*id:\s*"R6"/.test(s) && /\br6AppliedLive\(/.test(s) && /import\s*\{[^}]*\br6AppliedLive\b[^}]*\}\s*from\s*"\.\/release-rules"/.test(s) }))

  section("§D the sheet — required fields and the required order (derived)")
  const quote = /^Required order[^"\n]*"([^"]+)"/m.exec(sheet)?.[1] ?? ""
  const phrases = quote.replace(/\.$/, "").split(";").map((s) => s.trim()).filter(Boolean)
  check(`D1 the sheet quotes the required order (${phrases.length} phrases)`, phrases.length >= 8)
  const dir = existsSync(DIRECTIVE) ? readFileSync(DIRECTIVE, "utf8") : ""
  if (dir) check("D1 the quoted sentence is the directive's own (mandatory final artifacts, item 6) — derived, not retyped", dir.replace(/\s+/g, " ").includes(quote.replace(/\s+/g, " ").replace(/\.$/, "")))
  else console.log("  · D1 directive cross-check skipped: the directive file is not on this machine (blind spot)")
  const steps = (doc: string) => doc.split(/^## /m).filter((s) => /^Step \d+ /.test(s))
  const FIELDS = ["Category", "Who", "Before", "Do", "After", "Rollback", "Unblocks"]
  const thin = (doc: string) => steps(doc).flatMap((s) => FIELDS.filter((f) => !new RegExp(`^- \\*\\*${f}:\\*\\*`, "m").test(s)).map((f) => `${s.slice(0, 7).trim()} lacks ${f}`))
  const thinNow = thin(sheet)
  check(`D2 every step (${steps(sheet).length}) names category, who, before, do, after, rollback and what it unblocks`, steps(sheet).length >= 8 && thinNow.length === 0, thinNow)
  const alsoSecs = sheet.split(/^### /m).filter((s) => /^Also [A-Z] /.test(s))
  const alsoThin = alsoSecs.filter((s) => !(/\*\*Who:\*\*/.test(s) && /\*\*Before/.test(s) && /\*\*Live today:\*\*/.test(s) && /Rollback/.test(s))).map((s) => s.slice(0, 7))
  check(`D2 every other-SQL item (${alsoSecs.length}) names who, the live read, before and rollback`, alsoSecs.length >= 5 && alsoThin.length === 0, alsoThin)
  const orderOf = (doc: string) => steps(doc).map((s) => phrases.indexOf((/^- \*\*Category:\*\*\s*(.+)$/m.exec(s)?.[1] ?? "").trim()))
  const inOrder = (idx: number[]) => idx.every((n, i) => n >= 0 && (i === 0 || n >= idx[i - 1])) && phrases.every((_, p) => idx.includes(p))
  check(`D3 the steps follow the required order and cover every phrase (category indices ${orderOf(sheet).join(",")})`, inOrder(orderOf(sheet)))
  const parts = sheet.split(/^(?=## Step )/m)
  const swapped = [parts[0], parts[3], parts[2], parts[1], ...parts.slice(4)].join("")
  check("D3 POSITIVE CONTROL — swapping step 1 and step 3 breaks the order; deleting a step's After is caught", !inOrder(orderOf(swapped)) && thin(sheet.replace(/^- \*\*After:\*\*/m, "- After:")).length > 0)
  check("D4 the sheet makes no release claim (one rule: releaseClaimAllowed)", lib.releaseClaimAllowed(sheet, false))

  section("§E other SQL, derived from code and the generated caches")
  const ownerSql = raw("docs/operations/OWNER-SQL.md")
  const r2 = ownerSql.split(/^### /m).find((s) => /^R\.2 /.test(s)) ?? ""
  const r2List = [...(/ADD CONSTRAINT <conname> CHECK \(trigger_event IN \(([^)]*)\)/.exec(r2)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  const vocab = (await import(pathToFileURL(join(ROOT, "scripts/check-vocabularies.ts")).href).catch(() => ({} as any))).CHECK_VOCABULARIES
  const live: string[] = [...(vocab?.notification_rules?.trigger_event ?? [])].sort()
  const RETIRED = ["enrichment_failed", "raw_lead_viability_failed", "raw_lead_viability_passed"]
  check(`E1 §R.2's list is the live CHECK (${live.length}) minus exactly the three retired events (${r2List.length})`, live.length > 0 && JSON.stringify(r2List) === JSON.stringify(live.filter((e) => !RETIRED.includes(e))))
  const literal = (src: string, ev: string) => new RegExp(`["'\`]${ev}["'\`]`).test(src)
  const emitters: string[] = []
  for (const r of ["app", "lib"]) for (const f of walkTs(join(ROOT, r))) { const s = stripComments(readFileSync(f, "utf8")); for (const ev of RETIRED) if (literal(s, ev)) emitters.push(`${f.slice(ROOT.length + 1)}:${ev}`) }
  check("E2 no code in app/ or lib/ (stripped) names a retired event as a literal — §R.2 needs no app change first", emitters.length === 0, emitters)
  check("E2 POSITIVE CONTROL — the finder sees a quoted retired event and ignores contact_enrichment_failed", literal(`emit("enrichment_failed")`, "enrichment_failed") && !literal(`emit("contact_enrichment_failed")`, "enrichment_failed"))
  const exa = stripComments(raw("app/api/cron/competitor-ads-exa/route.ts"))
  check("E3 the competitor-ads upsert's conflict target leads with the tenant — §P.1 (drop the global index) needs no code first", /from\("competitor_ads"\)\.upsert\([\s\S]{0,2000}onConflict:\s*"brokerage_id,source_platform,provider_ad_id"/.test(exa))
  let stepKind = 0
  for (const r of ["app", "lib"]) for (const f of walkTs(join(ROOT, r))) if (/\bstep_kind\b/.test(stripComments(readFileSync(f, "utf8")))) stepKind++
  const alsoE = alsoSecs.find((s) => /^Also E /.test(s)) ?? ""
  check(`E4 §R.1 is HELD on the sheet exactly while no code names step_kind (${stepKind} file(s) do)`, (stepKind === 0) === /HELD/.test(alsoE.split("\n")[0]))
}

;(async () => {
  console.log(`wave156-o-guard — the release barrier, measured (modules from ${ROOT === WT ? "this tree" : ROOT})`)
  await sectionA()
  await sectionsBtoE()
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
})()
