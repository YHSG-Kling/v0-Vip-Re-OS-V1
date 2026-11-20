#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-round5-guard.ts — WAVE 155 (lane 155R23, ROUND 5): THE LAST P1 / P2 WRITES WITH NO RECEIPT, NO DECISION
 * OR NO READER (29 census rows: G12 20 · G99 7 · G14 1 · G10 1).
 *
 * WHAT IT PROVES, per row, by what the code DOES:
 *   (a) a SESSION write leaves ONE receipt through the one helper (ledgerSessionAction, lib/kernel/action-ledger.ts): the session
 *       user, the SESSION's tenant, a three-segment action, no idempotency key (a second act is a second receipt);
 *   (b) a PUBLIC door (handleRSVP, the two landing-page beacons, /api/track/dwell, the two heartbeats, the two collaborator doors)
 *       DECIDES first (decidePublicDoor, lib/security/public-rate-limit.ts) and only then writes, under ONE receipt whose tenant
 *       is the one the door PROVED from a row — never a body field; a refused door writes nothing and records nothing;
 *   (c) a PLATFORM act with NO tenant (platform topics, platform stills, the platform-wide safety finding, the platform funnel,
 *       pre-account ToS, the dev seed) is evidenced on the platform's door — recordPlatformEvidence
 *       (lib/platform/staff-action-gate.ts) → superadmin_audit_log — and NEVER as an agent_action_ledger row with an invented tenant;
 *   (d) a row the census miscounts is held as a DISAGREEMENT, with the exact statement and why it is not on the path — no receipt.
 *
 *   §A STATIC (stripped source — CLAUDE.md §2: a tombstone or a string is never a call site): every row's export span reaches its
 *      door; a public door's decidePublicDoor precedes its first write token; no receipt carries `cycle` / `idempotencyKey`; every
 *      action literal is domain.entity.action. Disagreements: listVideoTopicPoolAction passes `markUsed: false` and the bank's
 *      write sits under `if (args.markUsed`; prediction_accuracy_log has a reader outside its writer. POSITIVE CONTROLS: each
 *      finder is fed a planted specimen it must catch (a door only in a comment, a write before the door, a key, a two-segment name).
 *   §B DRIVEN (in-memory client, no network, no provider, no model; imports of the module under test → counted stubs; the ledger,
 *      the public door and the platform evidence door are REAL): one receipt / one evidence row per act, the right tenant and
 *      actor, two acts → two rows (the no-key canary), and the NEGATIVES — a refused door, a wrong-contact heartbeat, an
 *      unpublished listing, a token from another listing, an unknown topic / finding id — write nothing and record nothing.
 *
 * RED AT THE BASE (15d212bf): app/ + lib/ restored to the base, this same guard — see the lane notes for the measured count.
 * Run: `npm run test:ledger-receipts-round5`.
 * BLIND SPOTS: the in-memory client has no RLS, CHECKs or NOT NULLs (the live action-name / reason-code CHECKs are held by
 * test:action-ledger §14); stubs stand in for every import of a module under test except the three real doors, so a defect inside
 * a stubbed dependency is not this guard's to see; the coaching, screenshot, demo, seed, calculator and accept-invitation rows are
 * proven statically only.
 */
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { memSupabase, type Row, type MemClient } from "./in-memory-supabase"
import { blankComments, blankStrings } from "./strip-comments"

const ROOT = process.env.R23_ROOT || process.cwd()
let pass = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
  return ok
}
const read = (f: string) => readFileSync(join(ROOT, f), "utf8")
const stripped = (src: string) => blankStrings(blankComments(src))

// ══ §A STATIC ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
/** The text of one export: `export async function name` (or a route's `export async function POST`) to its column-0 brace. */
function exportSpan(src: string, name: string): string | null {
  const lines = src.split("\n")
  const s = lines.findIndex((l) => new RegExp(`^export async function ${name}\\b`).test(l))
  if (s < 0) return null
  let e = s + 1
  while (e < lines.length && lines[e].trimEnd() !== "}") e++
  return lines.slice(s, e + 1).join("\n")
}
/** A file-local helper's span (a non-exported `async function name`). */
function localSpan(src: string, name: string): string {
  const lines = src.split("\n")
  const s = lines.findIndex((l) => new RegExp(`^async function ${name}\\b`).test(l))
  if (s < 0) return ""
  let e = s + 1
  while (e < lines.length && lines[e].trimEnd() !== "}") e++
  return lines.slice(s, e + 1).join("\n")
}
const SESSION_DOOR = /\bledgerSessionAction\s*\(/
const LEDGER_DOOR = /\b(?:ledgerSessionAction|withActionLedger)\s*(?:<[^>(]*>)?\s*\(/
const PLATFORM_DOOR = /\brecordPlatformEvidence\s*\(/
const DECISION = /\bdecidePublicDoor\s*\(/
const WRITE_TOKEN = /\.(?:insert|update|upsert|delete)\s*\(|\bheartbeatLiveAgentSession\s*\(|\brecordCollaboratorOpinion\s*\(|\bcollaboratorView\s*\(/
const KEY_TOKEN = /\b(?:cycle|idempotencyKey)\s*:/
const ACTION_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/** The door decides before the first write: true when decidePublicDoor (in the span or in a named local door) precedes any write. */
function decidesBeforeWrite(span: string, localDoor?: string, src?: string): boolean {
  const d = span.search(localDoor ? new RegExp(`\\b${localDoor}\\s*\\(`) : DECISION)
  const w = span.search(WRITE_TOKEN)
  const doorHasDecision = localDoor ? DECISION.test(localSpan(src ?? "", localDoor)) : true
  return d >= 0 && doorHasDecision && (w < 0 || d < w)
}
/** Action literals of every ledger / evidence context in a commentFree (strings kept) source. */
function actionLiterals(commentFree: string): string[] {
  return [...commentFree.matchAll(/\baction:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1])
}

type Kind = "session" | "public" | "platform"
interface StaticRow { file: string; fn: string; kind: Kind; door?: string; via?: string }
const A = "app/actions/"
const STATIC_ROWS: StaticRow[] = [
  { file: `${A}open-house-automation.ts`, fn: "handleRSVP", kind: "public" },
  { file: "app/api/did/agents/session/heartbeat/route.ts", fn: "POST", kind: "session" },
  { file: `${A}buyer-coaching.ts`, fn: "getBuyerCoaching", kind: "session" },
  { file: `${A}listing-landing.ts`, fn: "logLandingSession", kind: "public", door: "landingDoor" },
  { file: `${A}listing-landing.ts`, fn: "trackCtaClick", kind: "public", door: "landingDoor" },
  { file: `${A}portal-education.ts`, fn: "notifyPortalEducationCompleted", kind: "session" },
  { file: `${A}seller-coaching.ts`, fn: "getListingCoaching", kind: "session" },
  { file: `${A}superadmin/platform-brand.ts`, fn: "addTopicAction", kind: "platform", via: "audit" },
  { file: `${A}superadmin/platform-brand.ts`, fn: "dismissTopicAction", kind: "platform", via: "audit" },
  { file: `${A}superadmin/screenshot-capture.ts`, fn: "captureDemoStillAction", kind: "platform", via: "evidence" },
  { file: `${A}superadmin/screenshot-capture.ts`, fn: "capturePublicPropertyStillAction", kind: "platform", via: "evidence" },
  { file: `${A}superadmin/screenshot-capture.ts`, fn: "setScreenshotUsesAction", kind: "platform", via: "evidence" },
  { file: "app/api/track/dwell/route.ts", fn: "POST", kind: "public" },
  { file: `${A}collaborative-search.ts`, fn: "submitFamilyOpinionAction", kind: "public", door: "collaboratorDoor" },
  { file: "app/api/seed/users/route.ts", fn: "POST", kind: "platform" },
  { file: `${A}calculators.ts`, fn: "calculateAffordability", kind: "session" },
  { file: `${A}calculators.ts`, fn: "calculateRentVsBuy", kind: "session" },
  { file: `${A}demo-auth.ts`, fn: "demoSignIn", kind: "session", via: "provisionDemoProfile" },
  { file: `${A}tenant-safety-actions.ts`, fn: "resolveTenantSafetyFindingAction", kind: "platform" },
  { file: `${A}voice-assistant.ts`, fn: "getVoiceConfig", kind: "session" },
  { file: "app/api/embed/session/heartbeat/route.ts", fn: "POST", kind: "public" },
  { file: `${A}collaborative-search.ts`, fn: "acceptInvitation", kind: "public", door: "collaboratorDoor" },
  { file: `${A}public/tos-acceptance.ts`, fn: "recordTosAcceptanceAction", kind: "platform" },
  { file: `${A}superadmin/platform-growth.ts`, fn: "capturePlatformProspectAction", kind: "platform", via: "funnelEvidence" },
  { file: `${A}superadmin/platform-growth.ts`, fn: "requestPlatformDemoAction", kind: "platform", via: "funnelEvidence" },
]

/** Judges ONE row's span — the same function the planted specimens are fed. */
function rowFindings(r: StaticRow, src: string): string[] {
  const code = stripped(src)
  const span = exportSpan(code, r.fn)
  if (!span) return ["export not found"]
  const f: string[] = []
  const reachVia = r.via ? new RegExp(`\\b${r.via}\\s*\\(`).test(span) : false
  const viaSpan = r.via ? localSpan(code, r.via) : ""
  if (r.kind === "platform") {
    if (!(PLATFORM_DOOR.test(span) || (reachVia && PLATFORM_DOOR.test(viaSpan)))) f.push("does not reach recordPlatformEvidence")
    if (LEDGER_DOOR.test(span)) f.push("a tenant-less platform act files an agent_action_ledger receipt (an invented tenant)")
  } else {
    if (!(LEDGER_DOOR.test(span) || (reachVia && LEDGER_DOOR.test(viaSpan)))) f.push("does not reach the action ledger")
    if (r.kind === "session" && !(SESSION_DOOR.test(span) || (reachVia && LEDGER_DOOR.test(viaSpan)))) f.push("a session write that is not ledgerSessionAction")
    if (r.kind === "public" && !decidesBeforeWrite(span, r.door, code)) f.push("no public-door decision before the first write")
  }
  if (KEY_TOKEN.test(span) || KEY_TOKEN.test(viaSpan)) f.push("carries cycle / idempotencyKey (a second act would replay)")
  return f
}

function staticSection(): void {
  console.log("§A — static, on stripped source")
  for (const r of STATIC_ROWS) {
    const f = rowFindings(r, read(r.file))
    check(`${r.file}#${r.fn} — ${r.kind} door${r.kind === "public" ? " decides first," : ""} no key`, f.length === 0, f.join("; "))
  }
  // Every action literal in these files is lowercase dotted (ledger names three segments; platform evidence names free text).
  const files = [...new Set(STATIC_ROWS.map((r) => r.file))]
  const bad = files.flatMap((file) => actionLiterals(blankComments(read(file))).filter((a) => !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,2}$/.test(a)).map((a) => `${file}: ${a}`))
  check(`every action literal in the ${files.length} row files is lowercase dotted`, bad.length === 0, bad.join(", "))
  // Ledger action names (three segments, the live CHECK) — the platform evidence names are free text (two segments, like the 30+ existing ones).
  const ledgerNames = ["marketing.open_house_rsvp.record", "billing.live_agent_session.heartbeat", "coaching.buyer_stage_card.load", "marketing.listing_landing_view.record",
    "marketing.listing_landing_cta.click", "portal.education_completion.notify", "coaching.seller_stage_card.load", "marketing.website_visitor.dwell",
    "portal.collaborative_search_opinion.record", "calculator.affordability.run", "calculator.rent_vs_buy.run", "auth.demo_account.provision", "voice.assistant_config.seed",
    "portal.collaborative_search_member.open"]
  const all = STATIC_ROWS.map((r) => read(r.file)).join("\n")
  const allCode = blankComments(all)
  for (const n of ledgerNames) check(`ledger action ${n} is domain.entity.action and is written in code`, ACTION_RE.test(n) && (allCode.includes(`"${n}"`) || allCode.includes(`'${n}'`)))

  // ── (d) census disagreements, held by what the code does ─────────────────────────────────────────────────────────────────
  const cv = stripped(read(`${A}custom-video.ts`))
  const pool = exportSpan(cv, "listVideoTopicPoolAction") ?? ""
  const poolRaw = exportSpan(blankComments(read(`${A}custom-video.ts`)), "listVideoTopicPoolAction") ?? ""
  check("DISAGREEMENT listVideoTopicPoolAction: calls pickTopics with markUsed: false, writes nothing itself, files no receipt",
    /\bpickTopics\s*\(/.test(pool) && /\bmarkUsed:\s*false\b/.test(poolRaw) && !WRITE_TOKEN.test(pool) && !LEDGER_DOOR.test(pool))
  const bank = stripped(read("lib/content-intel/topic-bank.ts"))
  const guarded = /if\s*\(\s*args\.markUsed\s*&&[\s\S]{0,900}?\.from\(\s*[^)]*\)\s*\.update\s*\(/.test(bank)
  check("DISAGREEMENT: the only topic-bank write the census credits (content_topic_bank .update) sits under `if (args.markUsed && …)`", guarded)
  const pa = blankComments(read("lib/analytics/prediction-accuracy.ts"))
  check("DISAGREEMENT logActualPerformanceAction: prediction_accuracy_log HAS a reader outside its writer (lib/analytics/prediction-accuracy.ts contentAdapter)",
    /\.from\(\s*"prediction_accuracy_log"\s*\)\s*\.select\s*\(/.test(pa.replace(/\s+/g, " ")))
  const an = blankComments(read(`${A}analytics.ts`))
  check("DISAGREEMENT (readback half of the two calculators): tool_usage_sessions HAS a reader (app/actions/analytics.ts)",
    /\.from\(\s*"tool_usage_sessions"\s*\)\s*\.select\s*\(/.test(an.replace(/\s+/g, " ")))
  check("no receipt was added to logActualPerformanceAction (a reader exists — nothing to receipt into existence)",
    !LEDGER_DOOR.test(exportSpan(stripped(read(`${A}content-prediction.ts`)), "logActualPerformanceAction") ?? "x"))

  // ── POSITIVE CONTROLS: every finder above must catch the defect it was written for ────────────────────────────────────────
  const pub: StaticRow = { file: "x.ts", fn: "planted", kind: "public" }
  const ses: StaticRow = { file: "x.ts", fn: "planted", kind: "session" }
  const plat: StaticRow = { file: "x.ts", fn: "planted", kind: "platform" }
  check("POSITIVE CONTROL: a door only in a COMMENT is no door", rowFindings(ses, `export async function planted() {\n  // ledgerSessionAction({ action: "a.b.c" }, run)\n  await db.from("t").insert({})\n}`).length > 0)
  check("POSITIVE CONTROL: a door only in a STRING is no door", rowFindings(ses, `export async function planted() {\n  const s = "ledgerSessionAction(x)"; await db.from("t").insert({})\n}`).length > 0)
  check("POSITIVE CONTROL: a write BEFORE the public decision is caught", rowFindings(pub, `export async function planted() {\n  await db.from("t").update({})\n  await decidePublicDoor({})\n  await withActionLedger({}, run, h)\n}`).some((x) => x.includes("decision")))
  check("POSITIVE CONTROL: a decision then a receipt is accepted", rowFindings(pub, `export async function planted() {\n  await decidePublicDoor({})\n  await withActionLedger({}, async () => db.from("t").update({}), h)\n}`).length === 0)
  check("POSITIVE CONTROL: a receipt with an idempotency key is caught", rowFindings(ses, `export async function planted() {\n  await ledgerSessionAction({ idempotencyKey: "k" }, run)\n}`).some((x) => x.includes("idempotencyKey")))
  check("POSITIVE CONTROL: a tenant-less platform act on the ledger is caught", rowFindings(plat, `export async function planted() {\n  await recordPlatformEvidence({})\n  await ledgerSessionAction({}, run)\n}`).some((x) => x.includes("invented tenant")))
  check("POSITIVE CONTROL: a two-segment ledger action name fails the pattern", !ACTION_RE.test("platform.topic"))
  check("POSITIVE CONTROL: the markUsed rule sees a write that is NOT guarded", !/if\s*\(\s*args\.markUsed\s*&&[\s\S]{0,900}?\.from\(\s*[^)]*\)\s*\.update\s*\(/.test(`await svc.from("content_topic_bank").update({})`))
}

// ══ §B DRIVEN ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const U = randomUUID(), B = randomUUID(), B2 = randomUUID(), C = randomUUID(), C2 = randomUUID(), AG = randomUUID(), U2 = randomUUID()
const R: { db: MemClient; calls: Record<string, number>; authed: boolean } = { db: memSupabase({}), calls: {}, authed: true }
const count = (k: string) => { R.calls[k] = (R.calls[k] ?? 0) + 1 }
const agentCtx = () => (R.authed ? { isAuthenticated: true, userId: U, brokerageId: B, agentId: AG, userType: "agent", role: "agent" } : { isAuthenticated: false, userId: "", brokerageId: null, agentId: null })
const nextJson = (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 })
const COMMON: Record<string, Record<string, unknown>> = {
  "@/lib/identity/get-agent-context": { getAgentContext: async () => agentCtx() },
  "@/lib/validations": { isValidUUID: (s: string) => /^[0-9a-f-]{36}$/i.test(String(s)) },
  "@/lib/db/best-effort": { bestEffort: async (p: any) => { try { return await p } catch { return null } } },
  "@/lib/kernel/write-sentinel": { sentinelWrite: async (_s: unknown, p: any) => { try { return await p } catch { return null } } },
  "@/lib/listings/listing-status-sync": { publiclyVisibleListingStatuses: () => ["active", "coming_soon"] },
  "@/lib/auth/platform-guard": { requireMarketing: async () => ({ ok: true, userId: U, role: "marketing", access: "write" }), requirePlatformStaff: async () => ({ ok: true }) },
  "@/lib/platform/product-brand": {
    validateTopic: (i: { topic: string; source: string; competitor?: string; url?: string }) => (i.topic?.trim() ? { ok: true, value: { source: i.source, topic: i.topic.trim(), competitor: i.competitor ?? null, url: i.url ?? null } } : { ok: false, error: "topic required" }),
    loadProductBrand: async () => ({}), resolveProductBrand: (x: unknown) => x,
  },
  "@/lib/platform/growth-funnel": { validateProspectInput: (i: any) => (i.email ? { ok: true, value: { email: i.email, name: i.name ?? null, company: null, roleInterest: null, source: i.source ?? "get_started", interestNote: i.interestNote ?? null } } : { ok: false, error: "email" }) },
  "@/lib/platform/prospect-capture": { upsertPlatformProspect: async () => { count("upsertPlatformProspect"); return { id: PROSPECT } } },
  "@/lib/did/live-session-metering": { heartbeatLiveAgentSession: async (id: string) => { count("heartbeat"); await R.db.from("live_agent_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", id).eq("status", "active") } },
  "@/lib/portal/require-contact-access": { requireContactAccess: async () => ({ ok: true, userId: U, brokerageId: B, isContactSelf: true }) },
  "@/lib/notifications/recipient-tenant": { resolveAgentRecipient: async () => ({ ok: true, userId: U2, brokerageId: B }) },
  "@/lib/portal/collaborative-share": {
    resolveCollaborator: async (_s: unknown, token: string) => (token === GOOD_TOKEN ? { ok: true, c: { memberId: MEMBER, memberName: "Aunt", memberEmail: "a@example.test", searchId: randomUUID(), brokerageId: B, buyerContactId: C } } : { ok: false, error: "This link isn't valid." }),
    recordCollaboratorOpinion: async () => { count("recordCollaboratorOpinion"); await R.db.from("property_family_ratings").insert({ brokerage_id: B, vote: "love" }); return { ok: true, agentNotified: false, consensus: { avg_rating: 5, vote_count: 1 } } },
    collaboratorView: async () => { count("collaboratorView"); return { ok: true, view: { viewRecorded: true, buyerFirstName: null, collaboratorName: null, homes: [] } } },
  },
  "next/cache": { revalidatePath: () => {}, revalidateTag: () => {} },
  "next/server": { NextResponse: { json: nextJson } },
}
const PROSPECT = randomUUID(), MEMBER = randomUUID(), GOOD_TOKEN = "t".repeat(40)
interface Target { file: string }
const TARGET_FILES = [
  `${A}open-house-automation.ts`, `${A}listing-landing.ts`, "app/api/track/dwell/route.ts", "app/api/embed/session/heartbeat/route.ts",
  "app/api/did/agents/session/heartbeat/route.ts", `${A}public/tos-acceptance.ts`, `${A}superadmin/platform-brand.ts`, `${A}tenant-safety-actions.ts`,
  `${A}superadmin/platform-growth.ts`, `${A}portal-education.ts`, `${A}voice-assistant.ts`, `${A}collaborative-search.ts`,
]
/** The REAL doors — never stubbed: the ledger, the public-door decision and the platform evidence door are what is under proof. */
const REAL = new Set(["@/lib/kernel/action-ledger", "@/lib/security/public-rate-limit", "@/lib/platform/staff-action-gate"])
function importsOf(file: string): Map<string, Set<string>> {
  const src = blankComments(read(file))
  const out = new Map<string, Set<string>>()
  const add = (spec: string, names: string[]) => { const s = out.get(spec) ?? new Set<string>(); names.forEach((n) => n && s.add(n)); out.set(spec, s) }
  for (const m of src.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)) {
    if (m[1]) continue
    const names: string[] = []
    const brace = /\{([\s\S]*)\}/.exec(m[2])
    if (brace) for (const part of brace[1].split(",")) { const p = part.trim(); if (!p || p.startsWith("type ")) continue; names.push(p.split(/\s+as\s+/)[0].trim()) }
    const def = m[2].replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim()
    if (def && !def.startsWith("*")) names.push("default")
    add(m[3], names)
  }
  for (const m of src.matchAll(/\b(?:const|let)\s*\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) add(m[2], m[1].split(",").map((p) => p.trim().split(":")[0].trim()))
  return out
}
const g = globalThis as any
g.__R23 = {
  bind: (file: string, spec: string, name: string) => {
    if (COMMON[spec] && name in COMMON[spec]) return COMMON[spec][name]
    // An unstubbed import resolves to a stand-in that throws only when CALLED (never at load), naming itself.
    return new Proxy(function () {}, { apply: () => { throw new Error(`R23 harness: unstubbed ${spec}#${name} called from ${file}`) }, get: (_t, k) => (k === "then" ? undefined : `${spec}#${name}.${String(k)}`) })
  },
  db: () => R.db,
}
const TARGETS = new Map(TARGET_FILES.map((f) => [pathToFileURL(join(ROOT, f)).href, f]))
const IMPORTS = new Map(TARGET_FILES.map((f) => [f, importsOf(f)]))
const dataUrl = (src: string) => `data:text/javascript,${encodeURIComponent(src)}`
const DB_STUB = "export const createClient = async () => globalThis.__R23.db(); export const createServerClient = createClient; export const createServiceClient = () => globalThis.__R23.db()"
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: dataUrl("export {}"), shortCircuit: true }
    if (spec === "@/lib/supabase/server" || spec === "@/lib/supabase/service") return { url: dataUrl(DB_STUB), shortCircuit: true }
    if (spec === "next/headers") return { url: dataUrl("export const headers = async () => new Map(); export const cookies = async () => ({ get() {}, getAll() { return [] }, set() {}, delete() {} })"), shortCircuit: true }
    const file = ctx?.parentURL ? TARGETS.get(String(ctx.parentURL)) : undefined
    if (file && !REAL.has(spec) && (spec.startsWith("@/") || spec.startsWith(".") || spec.startsWith("next/"))) {
      const names = new Set(IMPORTS.get(file)?.get(spec) ?? [])
      for (const n of Object.keys(COMMON[spec] ?? {})) names.add(n)
      const lines = [...names].map((n) => n === "default"
        ? `export default globalThis.__R23.bind(${JSON.stringify(file)}, ${JSON.stringify(spec)}, "default")`
        : `export const ${n} = globalThis.__R23.bind(${JSON.stringify(file)}, ${JSON.stringify(spec)}, ${JSON.stringify(n)})`)
      return { url: dataUrl(`${lines.join("\n")}\nexport {}`), shortCircuit: true }
    }
    if (spec === "next/cache") return { url: dataUrl("export const revalidatePath = () => {}; export const revalidateTag = () => {}"), shortCircuit: true }
    return next(spec, ctx)
  },
})

function fresh(seed: Record<string, Row[]>): MemClient {
  const db = memSupabase({ agent_action_ledger: [], superadmin_audit_log: [], ...seed }, { uuidIds: true })
  ;(db as any).auth = { getUser: async () => ({ data: { user: R.authed ? { id: U, email: "pat@example.test" } : null }, error: null }) }
  R.db = db
  return db
}
const ledger = () => (R.db.tables.agent_action_ledger ?? []) as Row[]
const audit = () => (R.db.tables.superadmin_audit_log ?? []) as Row[]
const load = async (f: string) => import(pathToFileURL(join(ROOT, f)).href)
async function safe<T>(fn: () => Promise<T>): Promise<{ v?: T; threw?: string }> { try { return { v: await fn() } } catch (e) { return { threw: (e as Error).message.slice(0, 200) } } }

async function drivenSection(): Promise<void> {
  console.log("\n§B — driven against the in-memory client (no network, no provider, no model)")

  // ── the platform evidence door itself ──
  {
    const { recordPlatformEvidence } = await import(pathToFileURL(join(ROOT, "lib/platform/staff-action-gate.ts")).href).catch(() => ({ recordPlatformEvidence: undefined }))
    check("recordPlatformEvidence exists (the tenant-less platform evidence door)", typeof recordPlatformEvidence === "function")
    if (typeof recordPlatformEvidence === "function") {
      const db = fresh({})
      const ok = await recordPlatformEvidence({ actorUserId: U, actorEmail: null, action: "x.y", targetType: "t", targetId: "singleton", details: { a: 1 } }, { client: db })
      const row = audit()[0]
      check("a non-uuid target goes to details.target_ref, never into the uuid column", ok.ok === true && row?.target_id === null && row?.details?.target_ref === "singleton")
      const refusing = memSupabase({}, { refuse: { superadmin_audit_log: "refused by the proof" } })
      const no = await recordPlatformEvidence({ actorUserId: null, actorEmail: "public:x", action: "x.y", targetType: "t", targetId: null, details: {} }, { client: refusing })
      check("a REFUSED evidence insert is read and reported (supabase-js resolves refusals), never swallowed", no.ok === false)
    }
  }

  // ── (b) handleRSVP ──
  {
    const m = await load(`${A}open-house-automation.ts`).catch((e) => { check("open-house-automation loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (m) {
      const E = randomUUID(), I = randomUUID(), I2 = randomUUID()
      const seed = () => ({ open_house_invitations: [{ id: I, event_id: E, brokerage_id: B, contact_id: C }, { id: I2, event_id: E, brokerage_id: null, contact_id: C2 }], open_house_rsvp_tracking: [] })
      fresh(seed())
      const r = await safe(() => m.handleRSVP({ eventId: E, invitationId: I, response: "yes" }))
      const rows = ledger()
      check("handleRSVP: one receipt, executed, actor system, tenant = the INVITATION's brokerage", rows.length === 1 && rows[0].status === "executed" && rows[0].actor_type === "system" && rows[0].brokerage_id === B && rows[0].action === "marketing.open_house_rsvp.record" && !rows[0].idempotency_key, `${JSON.stringify(rows.map((x) => [x.action, x.status, x.actor_type]))} ${JSON.stringify(r).slice(0, 160)}`)
      await safe(() => m.handleRSVP({ eventId: E, invitationId: I, response: "maybe" }))
      check("handleRSVP: a changed answer is a second receipt (no key)", ledger().length === 2)
      fresh(seed())
      const wrong = await safe(() => m.handleRSVP({ eventId: randomUUID(), invitationId: I, response: "yes" }))
      check("NEGATIVE handleRSVP: an invitation id with ANOTHER event id writes nothing and records nothing", (wrong.v as any)?.success === false && ledger().length === 0 && (R.db.tables.open_house_rsvp_tracking ?? []).length === 0 && !R.db.tables.open_house_invitations.some((x) => x.rsvp_response))
      fresh(seed())
      const untenanted = await safe(() => m.handleRSVP({ eventId: E, invitationId: I2, response: "yes" }))
      check("NEGATIVE handleRSVP: an untenanted invitation is REFUSED before any write (decision first)", (untenanted.v as any)?.success === false && !R.db.tables.open_house_invitations.some((x) => x.rsvp_response) && ledger().length === 0, JSON.stringify(untenanted).slice(0, 160))
      fresh(seed())
      const bogus = await safe(() => m.handleRSVP({ eventId: E, invitationId: I, response: "definitely" as any }))
      check("NEGATIVE handleRSVP: a response outside yes / maybe / no is refused (a use-server export is public)", (bogus.v as any)?.success === false && ledger().length === 0)
    }
  }

  // ── (b) landing beacons ──
  {
    const m = await load(`${A}listing-landing.ts`).catch((e) => { check("listing-landing loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (m) {
      const L = randomUUID(), L2 = randomUUID(), Lhidden = randomUUID()
      const seed = () => ({ listings: [{ id: L, brokerage_id: B, status: "active", deleted_at: null }, { id: L2, brokerage_id: B2, status: "active", deleted_at: null }, { id: Lhidden, brokerage_id: B, status: "withdrawn", deleted_at: null }], smart_landing_sessions: [], listing_page_analytics: [] })
      fresh(seed())
      await safe(() => m.logLandingSession({ listingId: L, sessionToken: "tok-1" }))
      const s = (R.db.tables.smart_landing_sessions ?? []) as Row[]
      check("logLandingSession: the session row is stamped with the LISTING's brokerage and one receipt names it", s.length === 1 && s[0].brokerage_id === B && ledger().length === 1 && ledger()[0].brokerage_id === B && ledger()[0].action === "marketing.listing_landing_view.record", `${s.length} sessions ${JSON.stringify(ledger().map((x) => x.action))}`)
      fresh(seed())
      await safe(() => m.logLandingSession({ listingId: Lhidden, sessionToken: "tok-1" }))
      check("NEGATIVE logLandingSession: a listing that is not publicly visible writes NOTHING (decision before the write)", (R.db.tables.smart_landing_sessions ?? []).length === 0 && ledger().length === 0)
      fresh({ ...seed(), smart_landing_sessions: [{ id: randomUUID(), listing_id: L, session_token: "tok-1", cta_clicked: false }, { id: randomUUID(), listing_id: L2, session_token: "tok-x", cta_clicked: false }] })
      await safe(() => m.trackCtaClick(L, "tok-1"))
      check("trackCtaClick: the click flips THIS listing's session and leaves one receipt", (R.db.tables.smart_landing_sessions as Row[]).find((x) => x.listing_id === L)?.cta_clicked === true && ledger().length === 1 && ledger()[0].status === "executed")
      fresh({ ...seed(), smart_landing_sessions: [{ id: randomUUID(), listing_id: L2, session_token: "tok-x", cta_clicked: false }] })
      await safe(() => m.trackCtaClick(L, "tok-x"))
      check("NEGATIVE trackCtaClick: a token from ANOTHER listing's session flips nothing", (R.db.tables.smart_landing_sessions as Row[])[0].cta_clicked === false)
    }
  }

  // ── (b) dwell + embed heartbeat ──
  {
    const dw = await load("app/api/track/dwell/route.ts").catch((e) => { check("dwell route loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (dw) {
      const W = randomUUID()
      const req = (b: unknown) => ({ json: async () => b, headers: new Map([["x-forwarded-for", "198.51.100.7"]]) })
      fresh({ website_visitors: [{ id: W, session_id: "sess-1", brokerage_id: B }] })
      await safe(() => dw.POST(req({ sessionId: "sess-1", pageUrl: "https://x.test/a", seconds: 30 })))
      check("dwell: one receipt, actor system, tenant = the VISITOR ROW's, subject the visitor row, no page URL in it", ledger().length === 1 && ledger()[0].brokerage_id === B && ledger()[0].actor_type === "system" && ledger()[0].subject_id === W && !JSON.stringify(ledger()[0]).includes("x.test"), JSON.stringify(ledger()).slice(0, 200))
      fresh({ website_visitors: [] })
      await safe(() => dw.POST(req({ sessionId: "sess-unknown", pageUrl: "https://x.test/a", seconds: 30 })))
      check("NEGATIVE dwell: a session the pixel never minted records nothing", ledger().length === 0)
    }
    const hb = await load("app/api/embed/session/heartbeat/route.ts").catch((e) => { check("embed heartbeat loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (hb) {
      const Ls = randomUUID()
      const req = (b: unknown) => ({ json: async () => b, headers: new Map([["x-forwarded-for", "198.51.100.8"]]) })
      fresh({ live_agent_sessions: [{ id: Ls, brokerage_id: B, status: "active" }] }); R.calls.heartbeat = 0
      await safe(() => hb.POST(req({ liveSessionId: Ls }))); await safe(() => hb.POST(req({ liveSessionId: Ls })))
      check("embed heartbeat: two beats → two FINANCIAL receipts under the SESSION ROW's tenant (no key)", ledger().length === 2 && ledger().every((x) => x.risk_class === "FINANCIAL" && x.brokerage_id === B && x.action === "billing.live_agent_session.heartbeat") && R.calls.heartbeat === 2)
      fresh({ live_agent_sessions: [{ id: Ls, brokerage_id: B, status: "ended" }] }); R.calls.heartbeat = 0
      await safe(() => hb.POST(req({ liveSessionId: Ls })))
      check("NEGATIVE embed heartbeat: a closed session is neither stamped nor receipted", ledger().length === 0 && R.calls.heartbeat === 0)
    }
  }

  // ── (a) the portal heartbeat (session route) ──
  {
    const hb = await load("app/api/did/agents/session/heartbeat/route.ts").catch((e) => { check("portal heartbeat loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (hb) {
      const Ls = randomUUID(), Lother = randomUUID()
      const seed = () => ({ contacts: [{ id: C, agent_id: null, brokerage_id: B, email: "pat@example.test" }], live_agent_sessions: [{ id: Ls, brokerage_id: B, contact_id: C, status: "active" }, { id: Lother, brokerage_id: B2, contact_id: C2, status: "active" }] })
      const req = (b: unknown) => ({ json: async () => b, headers: new Map() })
      fresh(seed()); R.calls.heartbeat = 0
      await safe(() => hb.POST(req({ contactId: C, liveSessionId: Ls })))
      check("portal heartbeat: one FINANCIAL receipt, actor the signed-in user, tenant the contact's", ledger().length === 1 && ledger()[0].actor_type === "user" && ledger()[0].actor_user_id === U && ledger()[0].brokerage_id === B && R.calls.heartbeat === 1)
      fresh(seed()); R.calls.heartbeat = 0
      await safe(() => hb.POST(req({ contactId: C, liveSessionId: Lother })))
      check("NEGATIVE portal heartbeat: access to one contact cannot keep ANOTHER contact's session alive (billed duration)", R.calls.heartbeat === 0 && ledger().length === 0)
    }
  }

  // ── (c) the tenant-less platform acts ──
  {
    const tos = await load(`${A}public/tos-acceptance.ts`).catch((e) => { check("tos-acceptance loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (tos) {
      fresh({ platform_tos_acceptances: [] })
      const r = await safe(() => tos.recordTosAcceptanceAction({ email: "new@example.test", version: "2026-07-01" }))
      const a = audit()
      check("ToS: one platform evidence row (no actor user, the public surface named, the acceptance row's id) and NO ledger row", (r.v as any)?.ok === true && a.length === 1 && a[0].actor_user_id === null && a[0].actor_email === "public:platform-tos-acceptance" && a[0].target_id === (R.db.tables.platform_tos_acceptances as Row[])[0]?.id && ledger().length === 0, JSON.stringify({ r, a }).slice(0, 200))
      check("ToS: the visitor's email is NOT copied into the audit row", !JSON.stringify(a).includes("new@example.test"))
    }
    const br = await load(`${A}superadmin/platform-brand.ts`).catch((e) => { check("platform-brand loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (br) {
      fresh({ platform_content_topics: [] })
      await safe(() => br.addTopicAction({ topic: "Spring market" }))
      const topic = (R.db.tables.platform_content_topics as Row[])[0]
      check("addTopicAction: one platform evidence row naming the staff user and the topic id, NO ledger row", audit().length === 1 && audit()[0].actor_user_id === U && audit()[0].target_id === topic?.id && ledger().length === 0)
      fresh({ platform_content_topics: [] })
      const r = await safe(() => br.dismissTopicAction(randomUUID()))
      check("NEGATIVE dismissTopicAction: an id that matches nothing is REFUSED (counted) and leaves no evidence", (r.v as any)?.ok === false && audit().length === 0, JSON.stringify(r).slice(0, 160))
    }
    const ts = await load(`${A}tenant-safety-actions.ts`).catch((e) => { check("tenant-safety-actions loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (ts) {
      const F = randomUUID()
      fresh({ users: [{ id: U, user_type: "broker", brokerage_id: B }], tenant_safety_findings: [{ id: F, resolved: false }] })
      await safe(() => ts.resolveTenantSafetyFindingAction({ findingId: F, resolutionNote: "fixed" }))
      check("resolveTenantSafetyFindingAction: one platform evidence row (platform-wide finding), NO ledger row with the resolver's tenant", audit().length === 1 && audit()[0].target_id === F && ledger().length === 0)
      fresh({ users: [{ id: U, user_type: "broker", brokerage_id: B }], tenant_safety_findings: [] })
      const r = await safe(() => ts.resolveTenantSafetyFindingAction({ findingId: F }))
      check("NEGATIVE resolveTenantSafetyFindingAction: a finding that matches nothing is not reported resolved", (r.v as any)?.success === false && audit().length === 0)
    }
    const gr = await load(`${A}superadmin/platform-growth.ts`).catch((e) => { check("platform-growth loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (gr) {
      fresh({})
      await safe(() => gr.capturePlatformProspectAction({ email: "hand@example.test" }))
      check("capturePlatformProspectAction: one platform evidence row (no actor, public surface, the prospect id), NO ledger row, no email in it", audit().length === 1 && audit()[0].actor_user_id === null && audit()[0].target_id === PROSPECT && ledger().length === 0 && !JSON.stringify(audit()).includes("hand@example.test"))
    }
  }

  // ── (a) session receipts ──
  {
    const pe = await load(`${A}portal-education.ts`).catch((e) => { check("portal-education loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (pe) {
      fresh({ contacts: [{ id: C, agent_id: AG }], notifications: [] })
      await safe(() => pe.notifyPortalEducationCompleted({ contactId: C, contactFirstName: "Kim" }))
      check("notifyPortalEducationCompleted: one receipt (session user, session tenant, COMMUNICATION), one notice", ledger().length === 1 && ledger()[0].actor_user_id === U && ledger()[0].brokerage_id === B && ledger()[0].risk_class === "COMMUNICATION" && (R.db.tables.notifications as Row[]).length === 1)
      await safe(() => pe.notifyPortalEducationCompleted({ contactId: C, contactFirstName: "Kim" }))
      check("notifyPortalEducationCompleted: a repeat that finds the prior notice writes nothing and records nothing", ledger().length === 1 && (R.db.tables.notifications as Row[]).length === 1)
    }
    const va = await load(`${A}voice-assistant.ts`).catch((e) => { check("voice-assistant loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (va) {
      fresh({ voice_assistant_config: [] }); R.authed = true
      await safe(() => va.getVoiceConfig())
      check("getVoiceConfig: the SEED leaves one receipt (voice.assistant_config.seed, session tenant)", ledger().length === 1 && ledger()[0].action === "voice.assistant_config.seed" && ledger()[0].brokerage_id === B)
      await safe(() => va.getVoiceConfig())
      check("getVoiceConfig: a view that finds its row records nothing", ledger().length === 1)
    }
    const cs = await load(`${A}collaborative-search.ts`).catch((e) => { check("collaborative-search loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
    if (cs) {
      fresh({ property_family_ratings: [] })
      await safe(() => cs.submitFamilyOpinionAction({ token: GOOD_TOKEN, sharedHomeId: randomUUID(), vote: "love", comment: "Lovely kitchen" }))
      check("submitFamilyOpinionAction: one receipt, actor system, tenant = the MEMBER row's, subject the member, no comment text", ledger().length === 1 && ledger()[0].actor_type === "system" && ledger()[0].brokerage_id === B && ledger()[0].subject_id === MEMBER && !JSON.stringify(ledger()).includes("Lovely kitchen"))
      fresh({ property_family_ratings: [] }); R.calls.recordCollaboratorOpinion = 0
      await safe(() => cs.submitFamilyOpinionAction({ token: "bad".repeat(10), sharedHomeId: randomUUID(), vote: "love" }))
      check("NEGATIVE submitFamilyOpinionAction: an invalid token writes nothing and records nothing", ledger().length === 0 && (R.calls.recordCollaboratorOpinion ?? 0) === 0)
      fresh({}); R.calls.collaboratorView = 0
      await safe(() => cs.acceptInvitation(GOOD_TOKEN))
      check("acceptInvitation: one receipt per open under the member's tenant", ledger().length === 1 && ledger()[0].action === "portal.collaborative_search_member.open" && ledger()[0].brokerage_id === B && R.calls.collaboratorView === 1)
    }
  }
}

async function main(): Promise<void> {
  console.log("LEDGER RECEIPTS — round 5 (wave 155, lane 155R23)")
  staticSection()
  if (!process.argv.includes("--static-only")) await drivenSection()
  console.log(`\nRESULT: ${pass} passed, ${failures.length} failed`)
  if (failures.length) { console.log("❌ LEDGER_RECEIPTS_ROUND5_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_ROUND5_PASS — every round-5 write decides, then leaves one receipt (or one platform evidence row); no tenant is invented")
}
main().catch((e) => { console.error(e); process.exit(1) })
