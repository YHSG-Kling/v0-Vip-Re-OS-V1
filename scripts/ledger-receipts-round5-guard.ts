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
import { readFileSync, readdirSync, statSync } from "node:fs"
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
  // Wave 156 (156H round 2): calculateAffordability / calculateRentVsBuy retired onto the engine — their usage row + receipt
  // live in their survivor runCalculatorTool (app/actions/calculators.ts), the same session rule.
  { file: `${A}calculators.ts`, fn: "runCalculatorTool", kind: "session" },
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
const R: { db: MemClient; calls: Record<string, number>; authed: boolean; role?: string } = { db: memSupabase({}), calls: {}, authed: true }
const count = (k: string) => { R.calls[k] = (R.calls[k] ?? 0) + 1 }
// round 7 (lane 155R27): `R.role` lets a driven check sit in an admin seat; unset → "agent", exactly as rounds 5 and 6 ran.
const agentCtx = () => (R.authed ? { isAuthenticated: true, userId: U, brokerageId: B, agentId: AG, userType: R.role ?? "agent", role: R.role ?? "agent" } : { isAuthenticated: false, userId: "", brokerageId: null, agentId: null })
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
  // ── round 6 (lane 155R26) — every seam counted; no provider, no model, no network ──
  "@/lib/auth/require-caller": { requireCaller: async () => (R.authed ? { ok: true, userId: U, brokerageId: B } : { ok: false, error: "Not authenticated" }) },
  "@/lib/property/external-listings-search": { searchExternalListings: async (i: Record<string, unknown>) => { count("searchExternalListings"); R6.routeInputs.push(i); return { listings: [{ externalId: "e1", source: "rentcast", address: "1 Main St", city: "Pace", state: "FL", zip: "32571", price: 300000, bedrooms: 3, bathrooms: 2, squareFeet: 1500, propertyType: "Single Family", daysOnMarket: 4, photoUrl: null, listingType: "sale" }], source: "rentcast", listingType: "sale" } } },
  "@/lib/property-alerts/alert-cadence": { BUYER_LISTING_RECENCY_DAYS: 30 },
  "@/lib/agentic-os/connector-gateway": { callConnector: async () => { count("callConnector"); return { ok: true, status: 200, data: { results: [{ mlsNumber: "direct" }] } } } },
  "./emit": { emitKernelEvent: async (i: Record<string, unknown>) => { count("emitKernelEvent"); R6.emitted.push(i); return { error: null } } },
  "./events": { KernelEvent: { OPEN_HOUSE_CONTACT_RESOLVED: "open_house_contact_resolved" } },
  "@/lib/kernel/portal-auth": {
    resolveExternalPartnerIdentity: async () => (R.authed ? { ok: true, identity: { userId: U, vendorId: VENDOR, partnerTypes: ["lender"], isLenderVendor: true, isTitlePartner: false, titleVendorId: null } } : { ok: false, reason: "unauthenticated" }),
    // The REAL rule: a lane exists only for an assignment of this vendor to that transaction (seeded below).
    externalPartnerTransactionLane: async (_s: unknown, _i: unknown, txId: string) => (R6.assignedTx.has(txId) ? { ok: true, grantedVia: "lender" } : { ok: false, reason: "no_access" }),
  },
  "@/lib/kernel/agent-identity": { resolveAgentIdInBrokerage: async () => AG },
  "@/lib/education/skill-freshness-radar": { loadAgentCompetency: async () => { count("loadAgentCompetency"); return { gaps: [], gapTags: ["objection:price"], skills: [{ skill: "compliance", score: 90, confidence: "high" }], overall: 90, refusedRails: [] } } },
  "@/lib/kernel/relationship-graph": { deriveCompetencyEdges: async (s: MemClient) => { count("deriveCompetencyEdges"); await s.from("relationship_edges").insert({ relationship_type: "has_competency", brokerage_id: B }); return { planned: 1, written: 1, existing: 0, errors: [], degraded: false } } },
  "@/lib/education/skill-freshness": { COMPETENCY_GAP_SCORE: 60 },
}
const VENDOR = randomUUID()
const R6: { routeInputs: Array<Record<string, unknown>>; emitted: Array<Record<string, unknown>>; assignedTx: Set<string> } = { routeInputs: [], emitted: [], assignedTx: new Set() }
const PROSPECT = randomUUID(), MEMBER = randomUUID(), GOOD_TOKEN = "t".repeat(40)
interface Target { file: string }
const TARGET_FILES = [
  `${A}open-house-automation.ts`, `${A}listing-landing.ts`, "app/api/track/dwell/route.ts", "app/api/embed/session/heartbeat/route.ts",
  "app/api/did/agents/session/heartbeat/route.ts", `${A}public/tos-acceptance.ts`, `${A}superadmin/platform-brand.ts`, `${A}tenant-safety-actions.ts`,
  `${A}superadmin/platform-growth.ts`, `${A}portal-education.ts`, `${A}voice-assistant.ts`, `${A}collaborative-search.ts`,
  // round 6 (lane 155R26)
  `${A}ai-isa.ts`, `${A}assistant.ts`, `${A}ai-content-generation.tsx`, `${A}idx-search.ts`, "lib/kernel/open-house.ts",
  "app/api/external-portal/actions/complete/route.ts", "lib/learning-router/resolve-agent-learning-context.ts",
  // round 7 (lane 155R27)
  `${A}call-review-actions.ts`, `${A}onboarding/onboarding-ops.ts`, `${A}fair-housing-older-persons.ts`, "lib/kernel/reporting.ts", `${A}workflows.ts`,
]
/** The REAL doors — never stubbed: the ledger, the public-door decision and the platform evidence door are what is under proof. */
// round 7 (lane 155R27): + the older-persons store — its counted, tenant-pinned delete is what the withdrawal receipt wraps.
const REAL = new Set(["@/lib/kernel/action-ledger", "@/lib/security/public-rate-limit", "@/lib/platform/staff-action-gate", "@/lib/compliance/fair-housing-older-persons-store"])
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
/** round 7 (lane 155R27): stubs for ONE target file only — filled before that file is loaded, so the earlier rounds' targets
 *  keep exactly the stand-ins they were proven with. */
const FILE_COMMON: Record<string, Record<string, Record<string, unknown>>> = {}
const g = globalThis as any
g.__R23 = {
  bind: (file: string, spec: string, name: string) => {
    const fc = FILE_COMMON[file]?.[spec]; if (fc && name in fc) return fc[name]
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
      for (const n of Object.keys(FILE_COMMON[file]?.[spec] ?? {})) names.add(n)
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

// ══ ROUND 6 (wave 155, lane 155R26) — the last eight P1 / P2 rows ═══════════════════════════════════════════════════════════
// Rows: toggleCampaignStatus · dismissSuggestion / completeSuggestion (receipts) · analyzeABTest → content_ab_tests (a reader the
// panel uses) · searchProperties (the one listing route, session tenant) · attachOpenHouseSourceAttribution (subject reads) ·
// /api/external-portal/actions/complete (the deal read + its tenant; a refused record is not a success) · the learning READ
// that wrote has_competency (retired onto the daily development cycle — positive proof: test:adaptive-development §live).
function round6Static(): void {
  console.log("\n§R6-A — round 6, static (stripped source)")
  const rows: StaticRow[] = [
    { file: `${A}ai-isa.ts`, fn: "toggleCampaignStatus", kind: "session" },
    { file: `${A}assistant.ts`, fn: "dismissSuggestion", kind: "session", via: "setSuggestionStatus" },
    { file: `${A}assistant.ts`, fn: "completeSuggestion", kind: "session", via: "setSuggestionStatus" },
  ]
  for (const r of rows) {
    const f = rowFindings(r, read(r.file))
    check(`${r.file}#${r.fn} — session receipt, no key`, f.length === 0, f.join("; "))
  }
  const code6 = blankComments([`${A}ai-isa.ts`, `${A}assistant.ts`].map(read).join("\n"))
  const code6b = code6 + blankComments(read(`${A}idx-search.ts`))
  for (const n of ["ai_isa.campaign.toggle", "ai.suggestion.dismiss", "ai.suggestion.complete", "listing.property_search.run"]) check(`ledger action ${n} is domain.entity.action and is written in code`, ACTION_RE.test(n) && code6b.includes(`"${n}"`))

  // analyzeABTest's table has a reader the PRODUCT uses: listABTests (session-gated, tenant + agent pinned) and the panel calls it.
  const acg = blankComments(read(`${A}ai-content-generation.tsx`))
  const list = exportSpan(acg, "listABTests") ?? ""
  check("content_ab_tests has a reader outside its writers: listABTests reads it pinned to the session's tenant and agent",
    /requireContentActor\(\)/.test(list) && /\.from\(\s*"content_ab_tests"\s*\)\s*\.select\(/.test(list.replace(/\s+/g, " ")) && /\.eq\("brokerage_id", auth\.actor\.brokerageId\)/.test(list) && /\.eq\("agent_id", auth\.actor\.agentId\)/.test(list) && !WRITE_TOKEN.test(list))
  const panel = blankComments(read("app/dashboard/content/panels/ab-testing-panel.tsx"))
  check("the Experiments panel USES the reader: imports listABTests, calls it, renders the saved winner and confidence",
    /import \{[^}]*\blistABTests\b[^}]*\} from "@\/app\/actions\/ai-content-generation"/.test(panel) && /await listABTests\(\)/.test(panel) && /winner_variant \?\? t\.winner/.test(panel) && /confidence_level/.test(panel))

  // searchProperties takes the one listing route; nothing in its path names a vendor or reads a key.
  const idx = stripped(read(`${A}idx-search.ts`))
  const sp = exportSpan(idx, "searchProperties") ?? ""
  const helper = localSpan(idx, "searchListingsForSession")
  const VENDOR_CALL = /\bcallConnector\s*\(|\bIDXBrokerClient\b|process\.env\b/
  check("searchProperties: session gate first, then the one route (searchListingsForSession → searchExternalListings); no direct vendor call, no key",
    /getAgentContext\(\)/.test(sp) && sp.search(/getAgentContext\(\)/) < sp.search(/searchListingsForSession\(/) && /searchExternalListings\(/.test(helper) && !VENDOR_CALL.test(sp) && !VENDOR_CALL.test(helper))
  check("smartSearch takes the SAME route (no second listing path in this file)", /searchListingsForSession\(/.test(exportSpan(idx, "smartSearch") ?? "") && !/\bcallConnector\s*\(/.test(idx))
  check("POSITIVE CONTROL: the vendor finder catches a planted direct call", VENDOR_CALL.test(`await callConnector({ connector: "idxbroker" })`) && VENDOR_CALL.test("const k = process.env.X"))

  // The attribution worker reads both subjects, tenant-pinned, before it emits.
  const oh = blankComments(read("lib/kernel/open-house.ts"))
  const w = exportSpan(oh, "attachOpenHouseSourceAttribution") ?? ""
  const ev = w.search(/from\("open_house_events"\)[^\n]*\.eq\("brokerage_id", brokerage_id\)/), at = w.search(/from\("open_house_attendees"\)/), em = w.search(/emitKernelEvent\(/)
  check("attachOpenHouseSourceAttribution reads open_house_events (tenant-pinned) and the attendee row BEFORE emitting", ev >= 0 && at >= 0 && em > ev && em > at && /\.eq\("contact_id", contact_id\)\.eq\("brokerage_id", brokerage_id\)/.test(w))

  // The learning read writes nothing; the scheduled derive is the survivor.
  const lr = stripped(read("lib/learning-router/resolve-agent-learning-context.ts"))
  check("the learning-context READ makes no deriveCompetencyEdges call (no write on a read)", !/\bderiveCompetencyEdges\s*\(/.test(lr) && /loadAgentCompetency\(/.test(lr))
  check("the survivor derives has_competency on the scheduled cycle (radar UPDATE step, reached by the onboarding-reminders cron)",
    /deriveCompetencyEdges\(svc, \{ brokerageId: agent\.brokerage_id/.test(stripped(read("lib/education/skill-freshness-radar.ts"))) && /runAdaptiveDevelopmentAll\(/.test(stripped(read("app/api/cron/onboarding-reminders/route.ts"))) && /"\/api\/cron\/onboarding-reminders"/.test(read("lib/kernel/cron-dispatch.ts")))
}

async function round6Driven(): Promise<void> {
  console.log("\n§R6-B — round 6, driven against the in-memory client (no network, no provider, no model)")
  // ── row 1: toggleCampaignStatus ──
  const ai = await load(`${A}ai-isa.ts`).catch((e) => { check("ai-isa loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (ai) {
    const CMP = randomUUID(), DONE = randomUUID(), OTHER = randomUUID()
    const seed = () => ({ ai_isa_campaigns: [{ id: CMP, brokerage_id: B, status: "active", is_active: true }, { id: DONE, brokerage_id: B, status: "completed", is_active: false }, { id: OTHER, brokerage_id: B2, status: "paused", is_active: false }] })
    fresh(seed()); R.authed = true
    const r1 = await safe(() => ai.toggleCampaignStatus(CMP, "active"))
    const camp = () => (R.db.tables.ai_isa_campaigns as Row[]).find((x) => x.id === CMP)
    check("toggleCampaignStatus: paused, ONE receipt (ai_isa.campaign.toggle, session user + tenant, COMMUNICATION, no key)",
      (r1.v as any)?.success === true && camp()?.status === "paused" && ledger().length === 1 && ledger()[0].action === "ai_isa.campaign.toggle" && ledger()[0].actor_user_id === U && ledger()[0].brokerage_id === B && ledger()[0].risk_class === "COMMUNICATION" && !ledger()[0].idempotency_key,
      JSON.stringify({ r1, l: ledger().map((x) => [x.action, x.status]) }).slice(0, 220))
    await safe(() => ai.toggleCampaignStatus(CMP, "paused"))
    check("toggleCampaignStatus: a second toggle is a second receipt (no key)", ledger().length === 2 && camp()?.status === "active")
    fresh(seed())
    const done = await safe(() => ai.toggleCampaignStatus(DONE, "paused"))
    check("NEGATIVE toggleCampaignStatus: a COMPLETED campaign is not re-opened by a caller who says \"paused\" (status stays completed, nothing recorded)",
      (done.v as any)?.success === false && (R.db.tables.ai_isa_campaigns as Row[]).find((x) => x.id === DONE)?.status === "completed" && ledger().length === 0)
    fresh(seed())
    const other = await safe(() => ai.toggleCampaignStatus(OTHER, "paused"))
    check("NEGATIVE toggleCampaignStatus: another tenant's campaign is refused, unchanged, unrecorded", (other.v as any)?.success === false && (R.db.tables.ai_isa_campaigns as Row[]).find((x) => x.id === OTHER)?.status === "paused" && ledger().length === 0)
  }
  // ── row 2: dismissSuggestion / completeSuggestion ──
  const asst = await load(`${A}assistant.ts`).catch((e) => { check("assistant loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (asst) {
    const SG = randomUUID(), SG2 = randomUUID()
    const seed = () => ({ smart_assistant_suggestions: [{ id: SG, brokerage_id: B, status: "pending" }, { id: SG2, brokerage_id: B, status: "pending" }] })
    fresh(seed()); R.authed = true
    const d = await safe(() => asst.dismissSuggestion(SG))
    const c = await safe(() => asst.completeSuggestion(SG2))
    const st = (id: string) => (R.db.tables.smart_assistant_suggestions as Row[]).find((x) => x.id === id)?.status
    check("dismissSuggestion / completeSuggestion: each moves its card and leaves ONE receipt (session user + tenant, subject the suggestion)",
      (d.v as any)?.success === true && (c.v as any)?.success === true && st(SG) === "dismissed" && st(SG2) === "actioned" && ledger().length === 2
      && ledger().some((x) => x.action === "ai.suggestion.dismiss" && x.subject_id === SG) && ledger().some((x) => x.action === "ai.suggestion.complete" && x.subject_id === SG2)
      && ledger().every((x) => x.brokerage_id === B && x.actor_user_id === U && !x.idempotency_key), JSON.stringify({ d, c, l: ledger().map((x) => [x.action, x.status]) }).slice(0, 220))
    fresh(seed()); R.authed = false
    const anon = await safe(() => asst.dismissSuggestion(SG))
    R.authed = true
    check("NEGATIVE dismissSuggestion: no session tenant → refused before any write, nothing recorded", (anon.v as any)?.success === false && st(SG) === "pending" && ledger().length === 0)
    fresh(seed())
    const ghost = await safe(() => asst.completeSuggestion(randomUUID()))
    check("NEGATIVE completeSuggestion: an id that matches no row is NOT a success (the count is read) and its receipt settles failed",
      (ghost.v as any)?.success === false && ledger().length === 1 && ledger()[0].status === "failed")
  }
  // ── row 3: the A/B reader ──
  const acg = await load(`${A}ai-content-generation.tsx`).catch((e) => { check("ai-content-generation loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (acg) {
    const mine = randomUUID()
    fresh({ content_ab_tests: [
      { id: mine, agent_id: AG, brokerage_id: B, test_name: "Subject test", status: "completed", winner_variant: "A", confidence_level: 0.97, started_at: "2026-11-01T00:00:00Z" },
      { id: randomUUID(), agent_id: randomUUID(), brokerage_id: B, test_name: "Another agent", status: "running", started_at: "2026-11-02T00:00:00Z" },
      { id: randomUUID(), agent_id: AG, brokerage_id: B2, test_name: "Other tenant", status: "running", started_at: "2026-11-03T00:00:00Z" },
    ] }); R.authed = true
    const l = await safe(() => (typeof acg.listABTests === "function" ? acg.listABTests() : Promise.reject(new Error("listABTests is not exported"))))
    const tests = (l.v as any)?.tests as Row[] | undefined
    check("listABTests: returns the session agent's saved test in the session's tenant (winner + confidence as saved) and nothing else",
      (l.v as any)?.success === true && tests?.length === 1 && tests[0].id === mine && tests[0].winner_variant === "A" && tests[0].confidence_level === 0.97, JSON.stringify(l).slice(0, 220))
    R.authed = false
    const anon = await safe(() => (typeof acg.listABTests === "function" ? acg.listABTests() : Promise.reject(new Error("listABTests is not exported"))))
    R.authed = true
    check("NEGATIVE listABTests: an anonymous caller is refused (a use-server export is a public endpoint)", (anon.v as any)?.success === false)
  }
  // ── row 4: searchProperties ──
  const idx = await load(`${A}idx-search.ts`).catch((e) => { check("idx-search loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (idx) {
    fresh({ brokerages: [{ id: B, state: "FL" }] }); R.authed = true; R.calls.searchExternalListings = 0; R.calls.callConnector = 0; R6.routeInputs.length = 0
    const s = await safe(() => idx.searchProperties({ city: "Pace", beds: 3, brokerageId: B2 } as any))
    const p = (s.v as any)?.properties?.[0]
    check("searchProperties: ONE routed search under the SESSION's tenant (a body brokerageId is ignored), no direct vendor call; rows keep both field spellings the two screens read",
      (s.v as any)?.success === true && R.calls.searchExternalListings === 1 && R.calls.callConnector === 0 && R6.routeInputs[0]?.brokerageId === B && R6.routeInputs[0]?.state === "FL" && R6.routeInputs[0]?.bedroomsMin === 3
      && p?.mlsNumber === "rentcast-e1" && p?.mls_number === "rentcast-e1" && p?.list_price === 300000 && p?.price === 300000 && p?.beds === 3 && p?.bedrooms === 3, JSON.stringify({ s, calls: R.calls }).slice(0, 240))
    check("searchProperties: the (possibly metered) routed search leaves ONE receipt — listing.property_search.run, session user + tenant, no key",
      ledger().length === 1 && ledger()[0].action === "listing.property_search.run" && ledger()[0].brokerage_id === B && ledger()[0].actor_user_id === U && !ledger()[0].idempotency_key && ledger()[0].status === "executed", JSON.stringify(ledger().map((x) => [x.action, x.status])))
    R.authed = false; R.calls.searchExternalListings = 0; R.calls.callConnector = 0
    const anon = await safe(() => idx.searchProperties({ city: "Pace" }))
    R.authed = true
    check("NEGATIVE searchProperties: an anonymous caller reaches NO route and NO vendor (it used to reach IDX with no session at all)",
      (anon.v as any)?.success === false && (R.calls.searchExternalListings ?? 0) === 0 && (R.calls.callConnector ?? 0) === 0, JSON.stringify({ anon, calls: R.calls }).slice(0, 200))
  }
  // ── row 5: attachOpenHouseSourceAttribution ──
  const oh = await load("lib/kernel/open-house.ts").catch((e) => { check("lib/kernel/open-house loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (oh) {
    const E = randomUUID(), ATT = randomUUID(), CX = randomUUID()
    const seed = () => ({ open_house_events: [{ id: E, brokerage_id: B }], open_house_attendees: [{ id: ATT, event_id: E, contact_id: C, brokerage_id: B }] })
    const run = (over: Partial<{ contact_id: string; attendee_id: string; open_house_id: string; brokerage_id: string }>) =>
      safe(() => oh.attachOpenHouseSourceAttribution({ contact_id: C, open_house_id: E, attendee_id: ATT, brokerage_id: B, agent_id: AG, ...over }))
    fresh(seed()); R6.emitted.length = 0
    const ok = await run({})
    check("attachOpenHouseSourceAttribution: a real check-in is attributed — ONE event emitted for that contact", (ok.v as any)?.success === true && R6.emitted.length === 1 && R6.emitted[0].contactId === C, JSON.stringify(ok).slice(0, 200))
    fresh(seed()); R6.emitted.length = 0
    const notAttendee = await run({ contact_id: CX })
    check("NEGATIVE attribution: a contact who never checked in to THIS open house is refused and nothing is emitted (no open-house welcome)", (notAttendee.v as any)?.success === false && R6.emitted.length === 0)
    fresh(seed()); R6.emitted.length = 0
    const otherTenant = await run({ brokerage_id: B2 })
    check("NEGATIVE attribution: the event and check-in of another tenant are refused and nothing is emitted", (otherTenant.v as any)?.success === false && R6.emitted.length === 0)
  }
  // ── row 6: /api/external-portal/actions/complete ──
  const route = await load("app/api/external-portal/actions/complete/route.ts").catch((e) => { check("external-portal complete route loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (route) {
    const TX = randomUUID(), GHOST = randomUUID()
    R6.assignedTx = new Set([TX, GHOST]) // GHOST: an assignment row naming a transaction that does not exist
    const req = (body: unknown) => ({ json: async () => body }) as any
    fresh({ transactions: [{ id: TX, brokerage_id: B }], audit_log: [] }); R.authed = true
    const ok = await safe(() => route.POST(req({ actionId: "upload-docs", context: { transactionId: TX } })))
    const a = (R.db.tables.audit_log as Row[])
    check("complete: the named deal is READ and its tenant is stamped into the one audit row", (ok.v as any)?.status === 200 && a.length === 1 && a[0].after?.transaction_id === TX && a[0].after?.brokerage_id === B && a[0].user_id === U, JSON.stringify({ ok, a }).slice(0, 220))
    fresh({ transactions: [{ id: TX, brokerage_id: B }], audit_log: [] })
    const ghost = await safe(() => route.POST(req({ actionId: "upload-docs", context: { transactionId: GHOST } })))
    check("NEGATIVE complete: a transaction that does not exist is refused (403) and nothing is recorded", (ghost.v as any)?.status === 403 && (R.db.tables.audit_log as Row[]).length === 0, JSON.stringify(ghost).slice(0, 200))
    R.db = memSupabase({ transactions: [{ id: TX, brokerage_id: B }] }, { refuse: { audit_log: "refused by the proof" } })
    const refused = await safe(() => route.POST(req({ actionId: "upload-docs", context: { transactionId: TX } })))
    check("NEGATIVE complete: a REFUSED audit insert (the route's only effect) is not answered success", (refused.v as any)?.status === 503 && (refused.v as any)?.body?.success === false, JSON.stringify(refused).slice(0, 200))
  }
  // ── row 7: the learning READ writes nothing ──
  const lr = await load("lib/learning-router/resolve-agent-learning-context.ts").catch((e) => { check("resolve-agent-learning-context loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (lr) {
    const db = fresh({ users: [{ id: U, brokerage_id: B, user_type: "agent", created_at: "2026-01-01T00:00:00Z" }], learning_assignments: [], transactions: [], proactive_interventions: [], listing_health_interventions: [], brokerage_intelligence_insights: [], relationship_edges: [] })
    R.calls.deriveCompetencyEdges = 0; R.calls.loadAgentCompetency = 0
    const ctx = await safe(() => lr.resolveAgentLearningContext(db, U))
    check("the learning-context READ still loads the competency profile (its gap tag reaches the router) and WRITES NOTHING (no edge, no derivation)",
      (ctx.v as any)?.gapTags?.includes("objection:price") && R.calls.loadAgentCompetency === 1 && (R.calls.deriveCompetencyEdges ?? 0) === 0 && (db.tables.relationship_edges as Row[]).length === 0, JSON.stringify({ ctx, calls: R.calls }).slice(0, 220))
  }
}

// ══ ROUND 7 (wave 155, lane 155R27) — the thirteen P2 EXECUTABLE_GAP rows ══════════════════════════════════════════════════
// Closed by code: shareCallWithCoach (proves the call in the session's tenant, one receipt) · nudgeOnboardingAgentsAction (one
// receipt) · sendOnboardingReminder (RETIRED onto the nudge: it looked an agents.id up in users) · exportReportCsvAction (the PDF
// sibling's audit note) · the phone allowance card and meter (READS that paged platform staff — the bell stays on the money path)
// · removeOlderPersonsVerificationAction (exposed by rule J, one receipt) · the twin read can no longer reach the snapshot insert.
// Closed by a census RULE (J, scripts/os-coverage-ledger.ts tableConstFroms; its controls are section G13 there): the vendor
// portfolio pair and recordOlderPersonsVerificationAction write through a same-file table CONSTANT. logUserActivity is an owner
// question, but its forged-action hole is fixed and driven here.
function walkRuntime(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(join(ROOT, dir))) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = `${dir}/${n}`
    if (statSync(join(ROOT, p)).isDirectory()) walkRuntime(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}
/** The runtime files that CALL `name(` — stripped source (a tombstone or a string is never a call site). */
function callSitesOf(name: string, files: string[]): string[] {
  const re = new RegExp(`\\b${name}\\s*\\(`)
  return files.filter((f) => { const raw = read(f); return raw.includes(name) && re.test(stripped(raw).replace(new RegExp(`export\\s+async\\s+function\\s+${name}\\b`), "")) })
}
function round7Static(): void {
  console.log("\n§R7-A — round 7, static (stripped source)")
  const rows: StaticRow[] = [
    { file: `${A}call-review-actions.ts`, fn: "shareCallWithCoach", kind: "session", via: "ledgered" },
    { file: `${A}onboarding/onboarding-ops.ts`, fn: "nudgeOnboardingAgentsAction", kind: "session" },
    { file: `${A}fair-housing-older-persons.ts`, fn: "removeOlderPersonsVerificationAction", kind: "session" },
  ]
  for (const r of rows) { const f = rowFindings(r, read(r.file)); check(`${r.file}#${r.fn} — session receipt, no key`, f.length === 0, f.join("; ")) }
  const code7 = blankComments([`${A}call-review-actions.ts`, `${A}onboarding/onboarding-ops.ts`, `${A}fair-housing-older-persons.ts`].map(read).join("\n"))
  for (const n of ["coaching.call_review.share", "onboarding.agent_nudge.send", "compliance.older_persons.withdraw"]) check(`ledger action ${n} is domain.entity.action and is written in code`, ACTION_RE.test(n) && code7.includes(`"${n}"`))

  // shareCallWithCoach proves the call (tenant-pinned) BEFORE the receipt and before any notification.
  const share = exportSpan(blankComments(read(`${A}call-review-actions.ts`)), "shareCallWithCoach") ?? ""
  const rd = share.search(/\.from\("voice_calls"\)\.select\("id"\)\.eq\("id", String\(input\.callId \?\? ""\)\)\.eq\("brokerage_id", caller\.brokerageId\)/), lg = share.search(/\bledgered\(/), nt = share.search(/\.from\("notifications"\)\.insert\(/)
  check("shareCallWithCoach reads voice_calls pinned to the SESSION's brokerage before the receipt and before any notification", rd >= 0 && lg > rd && nt > lg, JSON.stringify({ rd, lg, nt }))

  // sendOnboardingReminder is retired onto a survivor that EXISTS at the file:line its tombstone names, and nothing calls it.
  const progRaw = read(`${A}onboarding/progress.ts`)
  check("sendOnboardingReminder is no longer an export of the \"use server\" file (stripped source)", !/export\s+async\s+function\s+sendOnboardingReminder\b/.test(stripped(progRaw)))
  const tomb = /TOMBSTONE[^\n]*sendOnboardingReminder[\s\S]{0,200}?(app\/actions\/[\w/-]+\.ts):(\d+)\s+(\w+)/.exec(progRaw)
  const survivorLine = tomb ? (read(tomb[1]).split("\n")[Number(tomb[2]) - 1] ?? "") : ""
  check("…its tombstone names the survivor at file:line, and that line IS `export async function <survivor>`", !!tomb && new RegExp(`^export async function ${tomb[3]}\\b`).test(survivorLine), tomb ? `${tomb[1]}:${tomb[2]} → ${survivorLine.slice(0, 80)}` : "no tombstone")
  const runtime = [...walkRuntime("app"), ...walkRuntime("lib")]
  const callers = callSitesOf("sendOnboardingReminder", runtime)
  check("…and no runtime file calls it (stripped source)", callers.length === 0, callers.join(", "))
  check("POSITIVE CONTROL: the call finder sees a planted call and ignores a tombstone / a string",
    /\bsendOnboardingReminder\s*\(/.test(stripped(`await sendOnboardingReminder(id)`)) && !/\bsendOnboardingReminder\s*\(/.test(stripped(`// sendOnboardingReminder(id) was here\nconst s = "sendOnboardingReminder(x)"`)))
  const panel = blankComments(read("app/dashboard/admin/components/os/onboarding-operations-panel.tsx"))
  check("the Onboarding Operations panel calls the survivor with the agents.id it holds (agent_onboarding.agent_id)",
    /import \{ nudgeOnboardingAgentsAction \} from "@\/app\/actions\/onboarding\/onboarding-ops"/.test(panel) && /await nudgeOnboardingAgentsAction\(\[record\.agent_id\]\)/.test(panel))

  // The CSV export leaves the PDF sibling's audit note (ai_assistant_notes, entity_type "report").
  const rep = blankComments(read("lib/kernel/reporting.ts"))
  const csv = exportSpan(rep, "exportReportCsv") ?? ""
  check("exportReportCsv writes its export audit note (ai_assistant_notes, entity_type \"report\", type csv_export) through sentinelWrite",
    /sentinelWrite\(supabase, supabase\.from\("ai_assistant_notes"\)\.insert\(/.test(csv) && /entity_type:\s*"report"/.test(csv) && /type: "csv_export"/.test(csv))

  // The phone READS never raise the platform incident; the money-path verdict still does.
  const pp = blankComments(read(`${A}phone-provisioning.ts`))
  const status = exportSpan(pp, "getPhoneAllowanceStatusAction") ?? ""
  check("the allowance card reads the verdict READ ONLY (readTenantNumberProvisioning, never the incident-raising evaluateTenantNumberProvisioning)",
    /\breadTenantNumberProvisioning\(/.test(status) && !/\bevaluateTenantNumberProvisioning\(/.test(status))

  // The twin READ cannot reach the snapshot insert.
  const tw = stripped(read("lib/kernel/brokerage-twin.ts"))
  const readSpan = exportSpan(tw, "readBrokerageTwin") ?? "", composeSpan = localSpan(tw, "composeTwinNow"), buildSpan = exportSpan(tw, "buildBrokerageTwin") ?? ""
  check("readBrokerageTwin builds through composeTwinNow (no insert), never through the persisting buildBrokerageTwin; the builder still persists",
    /\bcomposeTwinNow\(/.test(readSpan) && !/\bbuildBrokerageTwin\(/.test(readSpan) && !!composeSpan && !WRITE_TOKEN.test(composeSpan) && /\.insert\(/.test(buildSpan) && /\bcomposeTwinNow\(/.test(buildSpan))

  // Rule J lives in the census and is wired into views(); its controls are section G13 of the census guard.
  const led = blankComments(read("scripts/os-coverage-ledger.ts"))
  check("the census reads a same-file table CONSTANT (rule J: tableConstFroms, called from views()) and carries its controls (G13 J POSITIVE / NEGATIVE / LIVE)",
    /function tableConstFroms\(/.test(led) && /const constFroms = tableConstFroms\(code, ids\)/.test(led) && ["G13 J POSITIVE", "G13 J NEGATIVE", "G13 J LIVE"].every((s) => led.includes(s)))
}

async function round7Driven(): Promise<void> {
  console.log("\n§R7-B — round 7, driven against the in-memory client (no network, no provider, no model)")
  const RUR = await import(pathToFileURL(join(ROOT, "lib/auth/resolve-user-role.ts")).href)
  const roster = RUR.TENANT_ADMIN_USER_TYPES as Set<string>
  const realRole = { BROKERAGE_FINANCE_ADMIN_USER_TYPES: RUR.BROKERAGE_FINANCE_ADMIN_USER_TYPES, isAdminOrBroker: RUR.isAdminOrBroker,
    resolveTenantAdmin: async (_s: unknown, _u: string, p: { user_type?: string | null }) => ({ ok: true, isTenantAdmin: roster.has(String(p?.user_type ?? "")) }) }
  FILE_COMMON[`${A}call-review-actions.ts`] = { "@/lib/auth/resolve-user-role": realRole }
  FILE_COMMON[`${A}onboarding/onboarding-ops.ts`] = {
    "@/lib/auth/resolve-user-role": realRole,
    // The REAL rule: the roster is read from the brokerage the caller passes (the session's), nothing else.
    "@/lib/onboarding/onboarding-roster": { loadOnboardingRoster: async (_s: unknown, brokerageId: string) => ({ agents: R7.roster.filter((a) => a.brokerageId === brokerageId) }) },
  }
  FILE_COMMON[`${A}fair-housing-older-persons.ts`] = { "@/lib/auth/resolve-user-role": realRole }
  FILE_COMMON["lib/kernel/reporting.ts"] = { "@/lib/transactions/transaction-status": await import(pathToFileURL(join(ROOT, "lib/transactions/transaction-status.ts")).href) }
  FILE_COMMON[`${A}workflows.ts`] = { "@/lib/identity": { getAgentContext: async () => agentCtx() } }
  const LEAD = randomUUID(), LEAD2 = randomUUID(), CALL = randomUUID(), CALL2 = randomUUID()

  // ── shareCallWithCoach ──
  const cr = await load(`${A}call-review-actions.ts`).catch((e) => { check("call-review-actions loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (cr) {
    const seed = () => ({ users: [{ id: U, brokerage_id: B, user_type: "agent" }, { id: LEAD, brokerage_id: B, user_type: "broker" }, { id: LEAD2, brokerage_id: B2, user_type: "broker" }],
      voice_calls: [{ id: CALL, brokerage_id: B }, { id: CALL2, brokerage_id: B2 }], notifications: [] })
    const notes = () => (R.db.tables.notifications as Row[]).filter((n) => n.type === "call_review_share")
    fresh(seed()); R.authed = true; R.role = undefined
    const ok = await safe(() => cr.shareCallWithCoach({ callId: CALL }))
    check("shareCallWithCoach: the tenant's leader is notified and ONE receipt is filed (coaching.call_review.share, subject the call, session user + tenant, no key)",
      (ok.v as any)?.success === true && notes().length === 1 && notes()[0].user_id === LEAD && ledger().length === 1 && ledger()[0].action === "coaching.call_review.share"
      && ledger()[0].subject_id === CALL && ledger()[0].brokerage_id === B && ledger()[0].actor_user_id === U && !ledger()[0].idempotency_key, JSON.stringify({ ok, n: notes().length, l: ledger().map((x) => [x.action, x.subject_id === CALL]) }).slice(0, 220))
    await safe(() => cr.shareCallWithCoach({ callId: CALL }))
    check("shareCallWithCoach: a second share is a second receipt (no key)", ledger().length === 2)
    fresh(seed())
    const other = await safe(() => cr.shareCallWithCoach({ callId: CALL2 }))
    check("NEGATIVE shareCallWithCoach: another tenant's call is refused — no leader notified, nothing recorded", (other.v as any)?.success === false && notes().length === 0 && ledger().length === 0, JSON.stringify(other).slice(0, 200))
    fresh(seed())
    const ghost = await safe(() => cr.shareCallWithCoach({ callId: randomUUID() }))
    check("NEGATIVE shareCallWithCoach: a call id that names no call is refused — no leader notified", (ghost.v as any)?.success === false && notes().length === 0 && ledger().length === 0, JSON.stringify(ghost).slice(0, 200))
  }

  // ── nudgeOnboardingAgentsAction (the one onboarding-reminder door) ──
  const ops = await load(`${A}onboarding/onboarding-ops.ts`).catch((e) => { check("onboarding-ops loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (ops) {
    const AG1 = randomUUID(), AG_NOUSER = randomUUID(), AG_OTHER = randomUUID()
    R7.roster = [{ agentId: AG1, userId: U2, percentComplete: 40, brokerageId: B }, { agentId: AG_NOUSER, userId: null, percentComplete: 0, brokerageId: B }, { agentId: AG_OTHER, userId: randomUUID(), percentComplete: 10, brokerageId: B2 }]
    const nudges = () => (R.db.tables.notifications as Row[]).filter((n) => n.type === "onboarding_nudge")
    fresh({ notifications: [] }); R.authed = true; R.role = "broker"
    const r1 = await safe(() => ops.nudgeOnboardingAgentsAction([AG1, AG_NOUSER, AG_OTHER]))
    check("nudge: the in-tenant agent with a user row is notified, the seat with none is skipped, another tenant's agent is invisible — ONE receipt (onboarding.agent_nudge.send, session user + tenant, no key)",
      (r1.v as any)?.success === true && (r1.v as any)?.notified === 1 && (r1.v as any)?.skipped === 1 && nudges().length === 1 && nudges()[0].user_id === U2
      && ledger().length === 1 && ledger()[0].action === "onboarding.agent_nudge.send" && ledger()[0].brokerage_id === B && ledger()[0].actor_user_id === U && !ledger()[0].idempotency_key, JSON.stringify({ r1, l: ledger().map((x) => [x.action, x.status]) }).slice(0, 220))
    await safe(() => ops.nudgeOnboardingAgentsAction([AG1]))
    check("nudge: a second nudge is a second receipt (no key)", ledger().length === 2 && nudges().length === 2)
    fresh({ notifications: [] }); R.role = "agent"
    const no = await safe(() => ops.nudgeOnboardingAgentsAction([AG1]))
    check("NEGATIVE nudge: an agent seat (not the admin roster) is refused — nothing sent, nothing recorded", (no.v as any)?.success === false && nudges().length === 0 && ledger().length === 0)
    R.role = undefined
  }

  // ── removeOlderPersonsVerificationAction ──
  const fh = await load(`${A}fair-housing-older-persons.ts`).catch((e) => { check("fair-housing-older-persons loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (fh) {
    const V = randomUUID(), V2 = randomUUID()
    const seed = () => ({ older_persons_housing_verifications: [{ id: V, brokerage_id: B, community_name: "Oak Glen" }, { id: V2, brokerage_id: B2, community_name: "Elsewhere" }] })
    const rows = () => (R.db.tables.older_persons_housing_verifications as Row[]).map((x) => x.id)
    fresh(seed()); R.authed = true; R.role = "broker"
    const ok = await safe(() => fh.removeOlderPersonsVerificationAction(V))
    check("withdraw: the tenant's attestation is removed and ONE receipt is filed (compliance.older_persons.withdraw, subject the record, session user + tenant)",
      (ok.v as any)?.success === true && !rows().includes(V) && ledger().length === 1 && ledger()[0].action === "compliance.older_persons.withdraw" && ledger()[0].subject_id === V && ledger()[0].brokerage_id === B && ledger()[0].actor_user_id === U, JSON.stringify({ ok, l: ledger().map((x) => [x.action, x.status]) }).slice(0, 220))
    fresh(seed())
    const other = await safe(() => fh.removeOlderPersonsVerificationAction(V2))
    check("NEGATIVE withdraw: another tenant's attestation matches no row — not a success, still there, and the receipt settles failed", (other.v as any)?.success === false && rows().includes(V2) && ledger().every((x) => x.status === "failed"), JSON.stringify({ other, l: ledger().map((x) => x.status) }).slice(0, 200))
    fresh(seed()); R.role = "team_lead"
    const tl = await safe(() => fh.removeOlderPersonsVerificationAction(V))
    check("NEGATIVE withdraw: a team lead (the roster minus team_lead attests) is refused before anything is removed or recorded", (tl.v as any)?.success === false && rows().includes(V) && ledger().length === 0)
    R.role = undefined
  }

  // ── exportReportCsv: the audit note, never the content ──
  const rp = await load("lib/kernel/reporting.ts").catch((e) => { check("reporting loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (rp) {
    fresh({ ai_assistant_notes: [] })
    const r = await safe(() => rp.exportReportCsv({ ctx: { brokerageId: B, userId: U, agentId: AG }, reportType: "financial", rows: [{ id: "r1", gross_commission: "SENTINEL-4471" }], columns: ["id", "gross_commission"] }))
    const n = (R.db.tables.ai_assistant_notes as Row[])
    check("exportReportCsv: the CSV comes back AND one audit note is written under the session's tenant and user (type csv_export, row count) — never the exported values",
      (r.v as any)?.success === true && /SENTINEL-4471/.test((r.v as any)?.data?.csv ?? "") && n.length === 1 && n[0].brokerage_id === B && n[0].created_by === U && n[0].entity_type === "report"
      && /"csv_export"/.test(n[0].note_text) && /"rowCount":1/.test(n[0].note_text) && !/SENTINEL/.test(n[0].note_text), JSON.stringify({ r: (r.v as any)?.success, n }).slice(0, 220))
  }

  // ── the phone READS page nobody; the money-path verdict still raises the incident ──
  const ppr = await import(pathToFileURL(join(ROOT, "lib/billing/phone-plan-resolve.ts")).href).catch((e) => { check("phone-plan-resolve loads", false, (e as Error).message.slice(0, 200)); return null })
  const plan = await import(pathToFileURL(join(ROOT, "lib/billing/phone-plan.ts")).href)
  if (ppr) {
    const STAFF = randomUUID()
    const al = plan.resolvePhoneAllowance("solo_agent", null)
    const now = new Date(), month = now.toISOString().slice(0, 7)
    const seed = () => ({
      brokerages: [{ id: B, plan_tier: "solo_agent" }], subscription_tiers: [], notifications: [],
      users: [{ id: STAFF, platform_role: "superadmin", brokerage_id: B2 }],
      tenant_phone_numbers: Array.from({ length: al.includedNumbers }, () => ({ id: randomUUID(), brokerage_id: B, is_active: true })),
      messages: Array.from({ length: al.includedSmsSegments + 3 }, () => ({ id: randomUUID(), brokerage_id: B, type: "sms", created_at: now.toISOString() })),
      usage_logs: [],
    })
    const incidents = () => (R.db.tables.notifications as Row[]).filter((x) => x.type === "price_not_configured")
    // scripts/in-memory-supabase.ts returns no `count` for `.select(c, { count: "exact", head: true })`; the phone reads count
    // numbers and SMS that way. This wrapper (this section only) answers count = the rows the same filters matched.
    const counted = (raw: MemClient): MemClient => new Proxy(raw, { get(t, k) {
      if (k !== "from") return (t as any)[k]
      return (table: string) => {
        const b: any = (t as any).from(table); let wantCount = false, head = false
        const sel = b.select.bind(b); b.select = (c?: string, o?: { count?: string; head?: boolean }) => { wantCount = !!o?.count; head = !!o?.head; sel(c); return b }
        const then = b.then.bind(b); b.then = (res: any, rej: any) => then((r: any) => res(wantCount ? { ...r, data: head ? null : r.data, count: (r.data ?? []).length } : r), rej)
        return b
      }
    } }) as MemClient
    let db = counted(fresh(seed()))
    const rd = typeof ppr.readTenantNumberProvisioning === "function" ? await ppr.readTenantNumberProvisioning(db, B) : null
    check("NEGATIVE the allowance card's read: the next number is unpriced (priceNotConfigured shown) and NO platform incident is raised", !!rd?.priceNotConfigured && rd?.allowed === false && incidents().length === 0, JSON.stringify({ rd: rd ? { allowed: rd.allowed, p: !!rd.priceNotConfigured } : "readTenantNumberProvisioning absent", i: incidents().length }))
    db = counted(fresh(seed()))
    const ev = await ppr.evaluateTenantNumberProvisioning(db, B)
    check("POSITIVE the money-path verdict (purchase / port / carrier tick) still raises ONE platform incident naming the missing number rate", ev.allowed === false && incidents().length === 1 && incidents()[0].user_id === STAFF && /overage_number_cents/.test(incidents()[0].body), JSON.stringify(incidents().map((x) => x.title)))
    db = counted(fresh(seed()))
    const m = await ppr.loadTenantPhoneMeter(db, B, month)
    check("NEGATIVE the tenant's meter read: unpriced overage units are SHOWN (no amount) and NO platform incident is raised", m.meter.priceNotConfigured.length >= 1 && m.meter.overageTotalCents === null && incidents().length === 0, JSON.stringify({ p: m.meter.priceNotConfigured.length, i: incidents().length }))
  }

  // ── logUserActivity: only the verbs its caller sends; a refusal is not a success ──
  const wf = await load(`${A}workflows.ts`).catch((e) => { check("workflows loads under the harness", false, (e as Error).message.slice(0, 200)); return null })
  if (wf) {
    const auditRows = () => (R.db.tables.audit_log as Row[])
    fresh({ audit_log: [] }); R.authed = true
    const ok = await safe(() => wf.logUserActivity(undefined, "session_started", { path: "/dashboard", injected: "x".repeat(10) }))
    check("logUserActivity: \"session_started\" records ONE audit row for the session user with ONLY the route it started on", (ok.v as any)?.success === true && auditRows().length === 1 && auditRows()[0].user_id === U && auditRows()[0].action === "session_started" && JSON.stringify(auditRows()[0].after) === JSON.stringify({ path: "/dashboard" }), JSON.stringify({ ok, a: auditRows() }).slice(0, 220))
    fresh({ audit_log: [] })
    const forged = await safe(() => wf.logUserActivity(undefined, "regional_convention_review_completed", { entity: "forged" }))
    check("NEGATIVE logUserActivity: an action name its caller never sends is refused — no audit row is forged", (forged.v as any)?.success === false && auditRows().length === 0, JSON.stringify({ forged, a: auditRows().length }))
    fresh({ audit_log: [] }); R.authed = false
    const anon = await safe(() => wf.logUserActivity(undefined, "session_started", { path: "/x" }))
    R.authed = true
    check("NEGATIVE logUserActivity: an anonymous call is not reported as success and writes nothing", (anon.v as any)?.success === false && auditRows().length === 0, JSON.stringify(anon))
  }
}
const R7: { roster: Array<{ agentId: string; userId: string | null; percentComplete: number; brokerageId: string }> } = { roster: [] }

async function main(): Promise<void> {
  console.log("LEDGER RECEIPTS — round 5 (wave 155, lane 155R23) + round 6 (lane 155R26) + round 7 (lane 155R27)")
  // A PLACEHOLDER, never a real key, set in this process only: at the base, searchProperties read IDX env at load and called the
  // vendor with it — the round-6 negative must see that call (a counted stub) rather than pass because the env is unset.
  process.env.IDXBROKER_API_KEY = "proof-placeholder"
  staticSection()
  round6Static()
  round7Static()
  if (!process.argv.includes("--static-only")) { await drivenSection(); await round6Driven(); await round7Driven() }
  console.log(`\nRESULT: ${pass} passed, ${failures.length} failed`)
  if (failures.length) { console.log("❌ LEDGER_RECEIPTS_ROUND5_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_ROUND5_PASS — every round-5 write decides, then leaves one receipt (or one platform evidence row); no tenant is invented")
}
main().catch((e) => { console.error(e); process.exit(1) })
