#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-acquisition-guard.ts   (npm run test:ledger-receipts-acquisition)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 155 (repair lane 155R4, group G12 — module list `acquisition_education1`: lead acquisition, scraping
 * configuration, education). A signed-in user's write leaves ONE receipt on agent_action_ledger through the one helper,
 * ledgerSessionAction (lib/kernel/action-ledger.ts): who (the SESSION user's users.id), which tenant (the session's),
 * a three-segment action, the subject row, the risk class, and how it settled.
 *
 *   A · STATIC (TypeScript-parsed, comments and strings blanked — CLAUDE.md §2): every export on the row list reaches
 *       ledgerSessionAction( in its own body or through a same-file helper that does; the two platform reads the
 *       analyzer over-reports are proven write-free instead. POSITIVE CONTROL: a planted export with no receipt is
 *       flagged, and a planted helper call is credited.
 *   B · DRIVEN against scripts/in-memory-supabase.ts (no DB, no network) — per MODULE one export, three times:
 *       (1) exactly one receipt: actor user = the session users.id, tenant = the session's, the action, subject, risk
 *           class, status executed, NO idempotency key;
 *       (2) the SAME export called twice writes TWO receipts and its write runs twice (the no-key rule: a key would
 *           silently turn a person's second save into a no-op — this is the regression canary);
 *       (3) a refused write settles the receipt `failed`.
 *   C · NO PAID PROVIDER IS CALLED: every provider / model seam is a counted stub and global fetch REFUSES and counts —
 *       the fetch count must be 0. A receipt never carries a Lead's or Contact's name, email, phone, address or a
 *       life-event type (the ledger is readable tenant-wide: has_brokerage_access).
 * Red at e88c1baa: no export on the list reached the helper, so A and every B(1)/(2)/(3) fail.
 * Rule, not waypoint: no row count, no date, no table list pinned beyond the fixtures each case seeds.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import ts from "typescript"
import { blankComments, blankStrings } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// ─── THE ROW LIST (os-coverage-ledger action ids, G12 list acquisition_education1) ────────────────────────────────
const ROWS: string[] = [
  ...["createMotivatedParams", "createPropertyParams", "createScrapingKeyword", "createScrapingMarket", "deleteScrapingKeyword", "deleteScrapingMarket", "updateMotivatedParams", "updatePropertyParams", "updateScrapingKeyword", "updateScrapingMarket"].map((n) => `app/actions/lead-scraping-config.ts#${n}`),
  "app/actions/admin/run-scrape-test.ts#runScrapeTestAction",
  "app/api/leads/raw/route.ts#PATCH",
  ...["handOffToHumanAgent", "pauseAIISA", "qualifyLead", "resumeAIISA"].map((n) => `app/actions/leads.ts#${n}`),
  ...["getLeadScore", "trackBehavioralEvent", "updateAutoResponseSettings"].map((n) => `app/actions/ai-auto-response.ts#${n}`),
  ...["skipGhostContact", "suppressGhostContact", "updateISACampaign"].map((n) => `app/actions/ai-isa.ts#${n}`),
  ...["createIsaPhoneNumber", "deleteIsaPhoneNumber", "toggleIsaPhoneNumber"].map((n) => `app/actions/isa-phone-numbers.ts#${n}`),
  ...["attestPromiseDeliveredAction", "generateQRCodeAction", "saveMagnetLandingContentAction"].map((n) => `app/actions/lead-magnets-actions.ts#${n}`),
  ...["aiGenerateDripCampaign", "aiPredictConversion"].map((n) => `app/actions/ai-lead-nurturing.ts#${n}`),
  ...["enrichLead", "rejectLead"].map((n) => `app/actions/lead-management.ts#${n}`),
  "app/actions/contact-enrichment.ts#markLifeChangeNotified",
  "app/actions/contact-intelligence.ts#getContactIntelligence",
  "app/actions/lead-governance/govern-lead.ts#governLead",
  "app/actions/lead-import/import-actions.ts#createImportRecord",
  "app/actions/lead-intelligence.ts#updateLeadProfile",
  "app/actions/lead-quick-actions.ts#verifyLeadAddressAction",
  "app/actions/voice-dial-batch.ts#rejectDialBatchAction",
  ...["assignResourceAction", "bulkAssignAction", "createResourceAction"].map((n) => `app/actions/education-kernel.ts#${n}`),
  ...["assignAcademyModuleAction", "setAgentOnboardingStatusAction"].map((n) => `app/actions/admin/agent-360.ts#${n}`),
  ...["createEducationModule", "deleteEducationModule"].map((n) => `app/actions/admin/license-tracking.ts#${n}`),
  "app/actions/admin/staff-360.ts#assignAcademyModuleToStaffAction",
  ...["assignErrorGroup", "dismissErrorGroup", "resolveErrorGroup"].map((n) => `app/actions/error-handler.ts#${n}`),
  "app/actions/support.ts#rateMyTicket",
]
/** Reads the analyzer credits with a write through its whole-file fallback on a destructured dynamic import — RE-CLASSIFIED, not ledgered. */
const READ_ONLY_ROWS = ["app/actions/superadmin/platform-controls.ts#getAcquisitionCapsAction", "app/actions/superadmin/platform-controls.ts#getStatusNoticeStateAction"]
/** A read whose only write is a ledgered sibling it calls (cross-module): the export → the member that carries the receipt. */
const REACHES_VIA: Record<string, string> = { "app/actions/contact-intelligence.ts#getContactIntelligence": "app/actions/ai-auto-response.ts#getLeadScore" }

// ─── A · STATIC ─────────────────────────────────────────────────────────────────────────────────────────────────────
const RECEIPT_RE = /\bledgerSessionAction\s*\(/
const WRITE_TOKEN_RE = /\.(?:insert|update|upsert|delete)\s*\(/
/** Top-level function bodies of a source text, comments AND strings blanked (a tombstone or a fixture is not a call site). */
function fnBodies(src: string, file = "x.ts"): Map<string, { body: string; exported: boolean }> {
  const clean = blankStrings(blankComments(src))
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out = new Map<string, { body: string; exported: boolean }>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      const exported = !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      out.set(st.name.text, { body: clean.slice(st.body.getStart(sf), st.body.getEnd()), exported })
    }
  }
  return out
}
function reachesReceipt(fns: Map<string, { body: string }>, name: string): boolean {
  const own = fns.get(name)
  if (!own) return false
  if (RECEIPT_RE.test(own.body)) return true
  for (const [helper, h] of fns) {
    if (helper === name || !RECEIPT_RE.test(h.body)) continue
    if (new RegExp(`\\b${helper}\\s*\\(`).test(own.body)) return true
  }
  return false
}
const fileFns = new Map<string, Map<string, { body: string; exported: boolean }>>()
const fnsOf = (file: string) => { let f = fileFns.get(file); if (!f) { f = fnBodies(readFileSync(join(ROOT, file), "utf8"), file); fileFns.set(file, f) } return f }

function staticSection() {
  console.log("\n[A · every export on the row list reaches ledgerSessionAction (stripped, parsed)]")
  // POSITIVE CONTROL first: the finder must still see the defect it was written for, and credit a helper call.
  const specimen = fnBodies([
    `export async function bare(id: string) { await svc.from("t").update({ a: 1 }).eq("id", id) }`,
    `// TOMBSTONE: ledgerSessionAction( used to be called here`,
    `export async function quoted() { const s = "ledgerSessionAction(" ; await svc.from("t").insert({}) }`,
    `async function withSessionReceipt(run: () => Promise<unknown>) { return ledgerSessionAction(ctx, run) }`,
    `export async function wrapped(id: string) { return withSessionReceipt(async () => svc.from("t").delete().eq("id", id)) }`,
  ].join("\n"))
  ok("POSITIVE CONTROL: a planted write with no receipt is flagged", !reachesReceipt(specimen, "bare"))
  ok("POSITIVE CONTROL: a receipt named only in a comment or a string is NOT a call site", !reachesReceipt(specimen, "quoted"))
  ok("POSITIVE CONTROL: an export calling a same-file helper that reaches the helper IS credited", reachesReceipt(specimen, "wrapped"))
  const missing: string[] = []
  for (const row of ROWS) {
    const target = REACHES_VIA[row] ?? row
    const [file, name] = target.split("#")
    const fns = fnsOf(file)
    if (!fns.get(name)?.exported) { missing.push(`${row} (export not found)`); continue }
    if (REACHES_VIA[row]) {
      const [f0, n0] = row.split("#")
      if (!new RegExp(`\\b${name}\\s*\\(`).test(fnsOf(f0).get(n0)?.body ?? "")) { missing.push(`${row} (does not call ${target})`); continue }
    }
    if (!reachesReceipt(fns, name)) missing.push(row)
  }
  ok(`all ${ROWS.length} row exports reach ledgerSessionAction (directly or via a same-file helper)`, missing.length === 0, missing.join("\n      "))
  for (const row of READ_ONLY_ROWS) {
    const [file, name] = row.split("#")
    const body = fnsOf(file).get(name)?.body ?? ""
    ok(`${name} is READ-ONLY in its own body (re-classified, not ledgered — it has no tenant either)`, body.length > 0 && !WRITE_TOKEN_RE.test(body))
  }
  ok("POSITIVE CONTROL: the write-token finder sees a planted write", WRITE_TOKEN_RE.test(`svc.from("platform_settings").update({ x: 1 })`))
  // Every action name in the list's modules is three lowercase segments (the live CHECK refuses anything else, and the
  // helper refuses BEFORE the action runs — a typo would break the person's action).
  const files = Array.from(new Set(ROWS.map((r) => r.split("#")[0])))
  const ACTION_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
  const bad: string[] = []
  let names = 0
  for (const f of files) {
    // Comments blanked, strings KEPT (the name is a string). Call sites only: a definition is followed by `<` or `(who`.
    const src = blankComments(readFileSync(join(ROOT, f), "utf8"))
    for (const m of src.matchAll(/\b(ledgerSessionAction|withSessionReceipt|withRouteReceipt)\s*\(/g)) {
      const win = src.slice(m.index! + m[0].length, m.index! + m[0].length + 600)
      if (/^\s*(?:who|ctx)\s*:/.test(win) || /function\s*$/.test(src.slice(Math.max(0, m.index! - 12), m.index!))) continue
      const name = (/\baction:\s*["']([^"']+)["']/.exec(win) ?? /["']([^"'\s/@]+\.[^"'\s/@]+)["']/.exec(win))?.[1]
      if (!name) continue
      names++
      if (!ACTION_RE.test(name)) bad.push(`${f}: ${name}`)
    }
  }
  ok(`every receipt action name at a call site (${names}) is domain.entity.action`, names >= ROWS.length - 2 && bad.length === 0, bad.join("; "))
  ok("POSITIVE CONTROL: the name check refuses a two-segment name", !ACTION_RE.test("commission.update") && ACTION_RE.test("lead.lifecycle.qualify"))
  // No key on any receipt THIS list writes: scoped to the row exports and the same-file helpers that reach the ledger (another
  // export of a shared file may hold a real once-only key of its own — support.ts's status change does).
  const keyed: string[] = []
  const KEY_RE = /\b(?:idempotencyKey|cycle)\s*:/
  for (const row of ROWS) {
    const [file, name] = (REACHES_VIA[row] ?? row).split("#")
    const fns = fnsOf(file)
    const scope = [fns.get(name)?.body ?? "", ...[...fns.entries()].filter(([n, h]) => n !== name && RECEIPT_RE.test(h.body) && new RegExp(`\\b${n}\\s*\\(`).test(fns.get(name)?.body ?? "")).map(([, h]) => h.body)]
    if (scope.some((b) => KEY_RE.test(b))) keyed.push(row)
  }
  ok("no receipt on the list passes an idempotencyKey or a cycle (recording-only — a second save always runs)", keyed.length === 0, keyed.join(", "))
  ok("POSITIVE CONTROL: the key finder sees a planted key", KEY_RE.test(`ledgerSessionAction({ brokerageId, cycle: \`split:\${id}\` }, run)`))
}

// ─── B · THE DRIVEN HALF — stubs first, before any app module loads ───────────────────────────────────────────────
const B = "b0000000-0000-4000-8000-000000000001"
const U = "a0000000-0000-4000-8000-000000000001"
const A = "c0000000-0000-4000-8000-000000000001"
const U2 = "a0000000-0000-4000-8000-000000000002"
const A2 = "c0000000-0000-4000-8000-000000000002"
const L = "d0000000-0000-4000-8000-000000000001"
const C = "e0000000-0000-4000-8000-000000000001"
const M = "f0000000-0000-4000-8000-000000000001"
const K = "f0000000-0000-4000-8000-000000000002"
const P = "f0000000-0000-4000-8000-000000000003"
const F = "f0000000-0000-4000-8000-000000000004"
const R = "f0000000-0000-4000-8000-000000000005"
const PR = "f0000000-0000-4000-8000-000000000006"
const BT = "f0000000-0000-4000-8000-000000000007"
const LM = "f0000000-0000-4000-8000-000000000008"
const E = "f0000000-0000-4000-8000-000000000009"
const T = "f0000000-0000-4000-8000-00000000000a"
/** Identity a receipt must never carry (the ledger is readable by every seat of the tenant). */
const SECRETS = ["Zelda", "Quartermaine", "zelda@private.test", "5550001111", "1 Secret Lane", "divorce"]

const W = globalThis as any
const counters = { fetch: 0, model: 0, lob: 0, batchdata: 0, score: 0 }
let ACTIVE: any = null
W.__R4__ = {
  client: () => ACTIVE,
  model: async () => { counters.model++; return { object: { conversionProbability: 41, projectedTimeline: "unknown", confidenceLevel: "low", keyFactors: [], riskFactors: [], accelerators: [], recommendation: "r" }, usage: {} } },
  lob: async () => { counters.lob++; return { data: { verified: true, deliverability: "deliverable" }, cost: 0 } },
  score: async (a: { id: string }) => {
    counters.score++
    const { error } = await ACTIVE.from("lead_scores").insert({ contact_id: a.id, score: 50, computed_at: new Date().toISOString() })
    if (error) throw new Error(error.message)
    return { score: 50 }
  },
}
W.fetch = async () => { counters.fetch++; throw new Error("network is disabled in this proof") }

const STUBS: Record<string, string> = {
  "server-only": "export {}",
  "next/headers": "const s={getAll:()=>[],get:()=>undefined,has:()=>false,set(){},delete(){}};export async function cookies(){return s};export async function headers(){return new Map()};export async function draftMode(){return {isEnabled:false,enable(){},disable(){}}}",
  "next/cache": "export function revalidatePath(){};export function revalidateTag(){};export function unstable_cache(f){return f};export function unstable_noStore(){};export function unstable_expireTag(){}",
  "@/lib/supabase/server": "export async function createClient(){return globalThis.__R4__.client()};export { createClient as createServerClient }",
  "@/lib/supabase/service": "export function createServiceClient(){return globalThis.__R4__.client()}",
  "@/lib/ai/generate": "const g=()=>globalThis.__R4__;export async function generateObject(o){return g().model(o)};export function bookedGenerateObject(){return (o)=>g().model(o)};export async function generateAIObject(o){return g().model(o)};export async function generateAIJSON(o){return (await g().model(o)).object};export async function generateAIText(o){await g().model(o);return ''};export async function generateChatResponse(o){await g().model(o);return ''}",
  "@/lib/external/lob-address-verify": "export async function verifyAddressViaLob(a){return globalThis.__R4__.lob(a)}",
  "@/lib/services/lead-management.service": "export async function calculateLeadScore(a){return globalThis.__R4__.score(a)}",
}
const LEAF_FILES: Array<[RegExp, string]> = [
  [/[\\/]lib[\\/]supabase[\\/]server\.ts$/, "@/lib/supabase/server"],
  [/[\\/]lib[\\/]supabase[\\/]service\.ts$/, "@/lib/supabase/service"],
  [/[\\/]lib[\\/]ai[\\/]generate\.ts$/, "@/lib/ai/generate"],
  [/[\\/]lib[\\/]external[\\/]lob-address-verify\.ts$/, "@/lib/external/lob-address-verify"],
  [/[\\/]lib[\\/]services[\\/]lead-management\.service\.ts$/, "@/lib/services/lead-management.service"],
]
const stubUrl = (k: string) => ({ url: `data:text/javascript,${encodeURIComponent(STUBS[k])}`, shortCircuit: true })
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (STUBS[spec] !== undefined) return stubUrl(spec)
    const r = next(spec, ctx)
    for (const [re, k] of LEAF_FILES) if (re.test(r?.url ?? "")) return stubUrl(k)
    return r
  },
})

/** One fresh tenant world per scenario. `failWrites`: writes to that table resolve refused (or THROW). */
function world(extra: Record<string, Row[]>, session: Row, failWrites?: { table: string; throws?: boolean }) {
  const mem = memSupabase({
    brokerages: [{ id: B, name: "Proof Realty" }],
    users: [
      { id: U, brokerage_id: B, user_type: "broker_owner", platform_role: null, team_id: null, email: "owner@proof.test", ...session },
      { id: U2, brokerage_id: B, user_type: "agent", platform_role: null, team_id: null, email: "agent@proof.test" },
    ],
    agents: [{ id: A, user_id: U, brokerage_id: B, is_active: true }, { id: A2, user_id: U2, brokerage_id: B, is_active: true }],
    user_role_assignments: [{ id: "ura-1", user_id: U, role: session.user_type ?? "broker_owner", brokerage_id: B, team_id: null, agent_id: A }],
    teams: [],
    ...extra,
  }, { uuidIds: true })
  const refused = { data: null, error: { message: "planted write refusal", code: "42501" } }
  const from = (t: string) => {
    const b = mem.from(t) as any
    if (!failWrites || t !== failWrites.table) return b
    let wrote = false
    for (const k of ["insert", "update", "upsert", "delete"]) { const f = b[k]; b[k] = (...a: unknown[]) => { wrote = true; f(...a); return b } }
    const th = b.then, si = b.single, ms = b.maybeSingle
    const out = async () => { if (failWrites.throws) throw new Error("planted write failure"); return refused }
    b.then = (res: any, rej: any) => (wrote ? out().then(res, rej) : th(res, rej))
    b.single = () => (wrote ? out() : si())
    b.maybeSingle = () => (wrote ? out() : ms())
    return b
  }
  const client = {
    from, tables: mem.tables, writes: mem.writes,
    auth: { getUser: async () => ({ data: { user: { id: U, email: session.email ?? "owner@proof.test", user_metadata: {}, app_metadata: {} } }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
  }
  ACTIVE = client
  return client
}
const receiptsOf = (c: any): Row[] => (c.tables.agent_action_ledger ?? []) as Row[]
const writesTo = (c: any, t: string) => (c.writes as Array<{ table: string; op: string }>).filter((w) => w.table === t && w.op !== "select").length

interface Case {
  label: string; file: string; action: string; risk: string; subjectType: string; subjectId?: string
  seed: () => Record<string, Row[]>; session?: Row; call: (m: any) => Promise<unknown>; writeTable: string
  between?: (c: any) => void; failThrows?: boolean; failCall?: (m: any) => Promise<unknown>
  detail?: (d: Row) => boolean; detailWhy?: string
}
const contact = (extra: Row = {}) => ({ id: C, contact_id: "e1000000-0000-4000-8000-000000000001", brokerage_id: B, agent_id: A, first_name: "Zelda", last_name: "Quartermaine", email: "zelda@private.test", phone: "5550001111", ...extra })
const lead = (extra: Row = {}) => ({ id: L, brokerage_id: B, agent_id: A, first_name: "Zelda", last_name: "Quartermaine", email: "zelda@private.test", phone: "5550001111", mailing_address: "1 Secret Lane", mailing_zip: "90210", lifecycle_state: "new", ai_outreach_paused: false, ...extra })
const market = () => ({ id: M, brokerage_id: B, name: "Westside", city: "Austin", state: "TX", zip_codes: ["78701"], counties: [], enabled_sources: ["batchdata_motivated"], monthly_budget_usd: 100, spend_this_month: 25, is_active: true })

const CASES: Case[] = [
  { label: "lead-scraping-config · updateScrapingMarket (territory + budget scope)", file: "app/actions/lead-scraping-config.ts", action: "lead_scraping.market.update", risk: "FINANCIAL", subjectType: "lead_scraping_market", subjectId: M,
    seed: () => ({ lead_scraping_markets: [market()], subscriber_service_areas: [] }), call: (m) => m.updateScrapingMarket(M, { zip_codes: ["78701", "78702"] }), writeTable: "lead_scraping_markets",
    detail: (d) => Array.isArray(d.territory?.zip_codes) && d.territory.zip_codes.includes("78702"), detailWhy: "the receipt records the territory the change set" },
  { label: "lead-scraping-config · updateScrapingKeyword", file: "app/actions/lead-scraping-config.ts", action: "lead_scraping.keyword.update", risk: "LOW_RISK_WRITE", subjectType: "lead_scraping_keyword", subjectId: K,
    seed: () => ({ lead_scraping_keywords: [{ id: K, brokerage_id: B, keyword: "must sell", keyword_type: "seller", weight: 1 }] }), call: (m) => m.updateScrapingKeyword(K, { weight: 3 }), writeTable: "lead_scraping_keywords" },
  { label: "run-scrape-test · runScrapeTestAction (a PAID pull — stubbed and counted)", file: "app/actions/admin/run-scrape-test.ts", action: "lead_scraping.provider_pull.preview", risk: "FINANCIAL", subjectType: "lead_scraping_market", subjectId: M,
    seed: () => ({ lead_scraping_markets: [market()] }), call: (m) => m.runScrapeTestAction(M, "batchdata_motivated"), writeTable: "__none__",
    failCall: (m) => m.runScrapeTestAction(M, "not_a_source"),
    detail: (d) => d.budget?.monthly_budget_usd === 100 && d.budget?.spend_this_month === 25 && d.territory?.city === "Austin", detailWhy: "the receipt records the budget and territory the pull ran under" },
  { label: "api/leads/raw · PATCH (platform staff repair, SESSION tenant)", file: "app/api/leads/raw/route.ts", action: "lead_pipeline.raw_lead.repair", risk: "LOW_RISK_WRITE", subjectType: "raw_scraped_lead", subjectId: R,
    session: { user_type: "admin", platform_role: "superadmin" },
    seed: () => ({ raw_scraped_leads: [{ id: R, brokerage_id: null, processing_status: "pending" }] }), call: async (m) => m.PATCH(new Request("http://proof.test/api/leads/raw", { method: "PATCH", body: JSON.stringify({ id: R, processing_status: RAW_STATUS }) })), writeTable: "raw_scraped_leads" },
  { label: "leads · pauseAIISA", file: "app/actions/leads.ts", action: "lead.ai_outreach.pause", risk: "LOW_RISK_WRITE", subjectType: "lead", subjectId: L,
    seed: () => ({ leads: [lead()], activities: [] }), call: (m) => m.pauseAIISA(L), writeTable: "leads" },
  { label: "ai-auto-response · updateAutoResponseSettings", file: "app/actions/ai-auto-response.ts", action: "ai_isa.auto_response.configure", risk: "LOW_RISK_WRITE", subjectType: "agent", subjectId: A,
    seed: () => ({ auto_response_settings: [] }), call: (m) => m.updateAutoResponseSettings({ is_enabled: true, custom_prompt: "Zelda" }), writeTable: "auto_response_settings" },
  { label: "ai-isa · suppressGhostContact (subject = the Contact)", file: "app/actions/ai-isa.ts", action: "ai_isa.ghost_contact.suppress", risk: "LOW_RISK_WRITE", subjectType: "contact", subjectId: C,
    seed: () => ({ contacts: [contact()], ai_isa_engagement_tracking: [] }), call: (m) => m.suppressGhostContact({ contactId: C }), writeTable: "ai_isa_engagement_tracking" },
  { label: "isa-phone-numbers · toggleIsaPhoneNumber", file: "app/actions/isa-phone-numbers.ts", action: "voice.phone_number.toggle", risk: "COMMUNICATION", subjectType: "tenant_phone_number", subjectId: P,
    seed: () => ({ tenant_phone_numbers: [{ id: P, brokerage_id: B, phone_number: "+15125550100", is_active: true }] }), call: (m) => m.toggleIsaPhoneNumber({ id: P, active: false }), writeTable: "tenant_phone_numbers" },
  { label: "lead-magnets-actions · saveMagnetLandingContentAction", file: "app/actions/lead-magnets-actions.ts", action: "marketing.lead_magnet_landing.save", risk: "LOW_RISK_WRITE", subjectType: "lead_capture_form", subjectId: F,
    seed: () => ({ lead_capture_forms: [{ id: F, brokerage_id: B, agent_id: A }] }), call: (m) => m.saveMagnetLandingContentAction(F, { headline: "Home values in 78701" }), writeTable: "lead_capture_forms" },
  { label: "ai-lead-nurturing · aiPredictConversion (model stubbed and counted)", file: "app/actions/ai-lead-nurturing.ts", action: "contact.conversion_prediction.record", risk: "LOW_RISK_WRITE", subjectType: "contact", subjectId: C,
    seed: () => ({ contacts: [contact()], activities: [], property_views: [] }), call: (m) => m.aiPredictConversion({ contactId: C }), writeTable: "contacts", failThrows: true },
  { label: "lead-management · rejectLead", file: "app/actions/lead-management.ts", action: "lead.lifecycle.reject", risk: "LOW_RISK_WRITE", subjectType: "lead", subjectId: L,
    seed: () => ({ leads: [lead()] }), call: (m) => m.rejectLead(L, "duplicate"), writeTable: "leads" },
  { label: "contact-enrichment · markLifeChangeNotified (no life-event type in the receipt)", file: "app/actions/contact-enrichment.ts", action: "contact.life_event.mark_notified", risk: "LOW_RISK_WRITE", subjectType: "contact", subjectId: C,
    seed: () => ({ contacts: [contact({ life_events: [{ type: "divorce", detected_at: "2026-01-01" }] })] }), call: (m) => m.markLifeChangeNotified(C, "divorce"), writeTable: "contacts",
    between: (c) => { for (const r of c.tables.contacts) r.life_events = [{ type: "divorce", detected_at: "2026-01-01" }] } },
  { label: "contact-intelligence · getContactIntelligence (its write is getLeadScore's ledgered compute)", file: "app/actions/contact-intelligence.ts", action: "lead_scoring.score_snapshot.compute", risk: "LOW_RISK_WRITE", subjectType: "contact", subjectId: C,
    seed: () => ({ contacts: [contact()], lead_scores: [] }), call: (m) => m.getContactIntelligence(C), writeTable: "lead_scores",
    between: (c) => { c.tables.lead_scores.length = 0 } },
  { label: "lead-governance · governLead", file: "app/actions/lead-governance/govern-lead.ts", action: "lead.governance.run", risk: "LOW_RISK_WRITE", subjectType: "lead", subjectId: L,
    seed: () => ({ leads: [lead()], activities: [], automation_errors: [] }), call: (m) => m.governLead(L), writeTable: "leads",
    failCall: async (m) => { ACTIVE.tables.leads.length = 0; return m.governLead(L) } },
  { label: "lead-import · createImportRecord (a purchased list = tenant spend)", file: "app/actions/lead-import/import-actions.ts", action: "lead_import.import.create", risk: "FINANCIAL", subjectType: "lead_import",
    seed: () => ({ lead_imports: [] }), call: (m) => m.createImportRecord({ fileName: "zelda-list.csv", totalRows: 10, fieldMap: { a: "first_name" }, listCostUsd: 25 }), writeTable: "lead_imports",
    detail: (d) => d.list_cost_usd === 25 && !JSON.stringify(d).includes("zelda-list"), detailWhy: "the cost is recorded, the file name is not" },
  { label: "lead-intelligence · updateLeadProfile", file: "app/actions/lead-intelligence.ts", action: "lead_intelligence.profile.triage", risk: "LOW_RISK_WRITE", subjectType: "unified_lead_profile", subjectId: PR,
    seed: () => ({ unified_lead_profile: [{ id: PR, brokerage_id: B }], activities: [] }), call: (m) => m.updateLeadProfile(PR, { temperature: "hot", ai_summary: "Zelda is selling" }), writeTable: "unified_lead_profile" },
  { label: "lead-quick-actions · verifyLeadAddressAction (PAID Lob — stubbed and counted)", file: "app/actions/lead-quick-actions.ts", action: "lead.mailing_address.verify", risk: "FINANCIAL", subjectType: "lead", subjectId: L,
    seed: () => ({ leads: [lead()] }), call: (m) => m.verifyLeadAddressAction({ leadId: L }), writeTable: "leads" },
  { label: "voice-dial-batch · rejectDialBatchAction", file: "app/actions/voice-dial-batch.ts", action: "voice.dial_batch.reject", risk: "COMMUNICATION", subjectType: "ai_isa_call_batch", subjectId: BT,
    seed: () => ({ ai_isa_call_batches: [{ id: BT, brokerage_id: B, proposed_by_agent_id: A, status: "proposed" }] }), call: (m) => m.rejectDialBatchAction(BT), writeTable: "ai_isa_call_batches",
    between: (c) => { for (const r of c.tables.ai_isa_call_batches) r.status = "proposed" } },
  { label: "education-kernel · assignResourceAction", file: "app/actions/education-kernel.ts", action: "education.learning_assignment.assign", risk: "LOW_RISK_WRITE", subjectType: "contact", subjectId: C,
    seed: () => ({ learning_modules: [{ id: LM, brokerage_id: B, status: "published" }], contacts: [contact()], learning_assignments: [] }), call: (m) => m.assignResourceAction({ contactId: C, resourceId: LM }), writeTable: "learning_assignments" },
  { label: "admin/agent-360 · setAgentOnboardingStatusAction", file: "app/actions/admin/agent-360.ts", action: "onboarding.agent_onboarding.set_status", risk: "LOW_RISK_WRITE", subjectType: "agent", subjectId: A2,
    seed: () => ({ agent_onboarding: [] }), call: (m) => m.setAgentOnboardingStatusAction({ targetUserId: U2, status: "in_progress" }), writeTable: "agent_onboarding" },
  { label: "admin/license-tracking · createEducationModule", file: "app/actions/admin/license-tracking.ts", action: "education.learning_module.create", risk: "LOW_RISK_WRITE", subjectType: "learning_module",
    seed: () => ({ learning_modules: [] }), call: (m) => m.createEducationModule({ title: "Fair housing", description: "d", targetRoles: ["agent"], required: true, contentBody: "b", quizQuestions: [] }), writeTable: "learning_modules" },
  { label: "admin/staff-360 · assignAcademyModuleToStaffAction", file: "app/actions/admin/staff-360.ts", action: "education.academy_assignment.assign", risk: "LOW_RISK_WRITE", subjectType: "user", subjectId: U2,
    seed: () => ({ learning_modules: [{ id: LM, brokerage_id: B, status: "published" }], learning_assignments: [] }), call: (m) => m.assignAcademyModuleToStaffAction({ targetUserId: U2, moduleId: LM }), writeTable: "learning_assignments",
    between: (c) => { c.tables.learning_assignments.length = 0 } },
  { label: "error-handler · dismissErrorGroup", file: "app/actions/error-handler.ts", action: "recovery.automation_error.dismiss", risk: "LOW_RISK_WRITE", subjectType: "automation_error", subjectId: E,
    seed: () => ({ automation_errors: [{ id: E, brokerage_id: B, status: "open" }], activities: [] }), call: (m) => m.dismissErrorGroup(E, "Zelda's import, known"), writeTable: "automation_errors" },
  { label: "support · rateMyTicket", file: "app/actions/support.ts", action: "support.ticket.rate", risk: "LOW_RISK_WRITE", subjectType: "support_ticket", subjectId: T,
    seed: () => ({ support_tickets: [{ id: T, brokerage_id: B, submitted_by_user_id: U, agent_id: null, lane: "tenant", status: "resolved", satisfaction_rating: null }] }), call: (m) => m.rateMyTicket({ ticketId: T, rating: 5, comment: "Zelda helped" }), writeTable: "support_tickets",
    between: (c) => { for (const r of c.tables.support_tickets) r.satisfaction_rating = null } },
]
let RAW_STATUS = "pending"

const seen: Row[] = []
async function attempt(fn: () => Promise<unknown>): Promise<unknown> { try { return await fn() } catch (e) { return { threw: (e as Error).message } } }

async function drivenSection() {
  console.log("\n[B · per module: one receipt · twice = two receipts and two runs (no key) · a refused write settles failed]")
  RAW_STATUS = (await import("../lib/lead-pipeline/processing-status")).RAW_PROCESSING_STATUSES.find((s: string) => s !== "pending") ?? "pending"
  const bd = await import("../lib/external/batchdata-client")
  ;(bd.BatchDataClient.prototype as any).getMotivatedSellerData = async () => { counters.batchdata++; return [] }
  const modules = new Set<string>()
  for (const c of CASES) {
    modules.add(c.file)
    let mod: any
    try { mod = await import(join(ROOT, c.file)) } catch (e) { ok(`${c.label}: module loads`, false, (e as Error).message.slice(0, 300)); continue }
    // (1) exactly one receipt
    const w1 = world(c.seed(), c.session ?? {})
    const res1 = await attempt(() => c.call(mod))
    const r1 = receiptsOf(w1)
    seen.push(...r1)
    const one = r1[0]
    const shape = !!one && one.actor_type === "user" && one.actor_user_id === U && one.brokerage_id === B && one.action === c.action
      && one.subject_type === c.subjectType && (c.subjectId === undefined || one.subject_id === c.subjectId) && one.risk_class === c.risk
      && one.reason_code === "HUMAN_REQUESTED" && (one.idempotency_key ?? null) === null
    ok(`${c.label}: exactly ONE receipt — session user, session tenant, ${c.action}, ${c.subjectType}, ${c.risk}, no key`, r1.length === 1 && shape,
      `receipts=${r1.length} ${one ? JSON.stringify({ a: one.action, t: one.brokerage_id, u: one.actor_user_id, s: `${one.subject_type}:${one.subject_id}`, r: one.risk_class, k: one.idempotency_key }) : ""} result=${JSON.stringify(res1)?.slice(0, 200)}`)
    ok(`${c.label}: the receipt settled executed`, one?.status === "executed", `status=${one?.status} error=${one?.error} result=${JSON.stringify(res1)?.slice(0, 200)}`)
    if (c.detail) ok(`${c.label}: ${c.detailWhy}`, !!one && c.detail((one.detail ?? {}) as Row), JSON.stringify(one?.detail)?.slice(0, 300))
    // (2) twice = two receipts, two runs
    const w2 = world(c.seed(), c.session ?? {})
    await attempt(() => c.call(mod))
    c.between?.(w2)
    await attempt(() => c.call(mod))
    const r2 = receiptsOf(w2)
    seen.push(...r2)
    const runs = c.writeTable === "__none__" ? r2.filter((r) => r.status === "executed").length : writesTo(w2, c.writeTable)
    ok(`${c.label}: called twice → TWO receipts and the write ran twice (no key — a second save is never a silent no-op)`, r2.length === 2 && r2.every((r) => (r.idempotency_key ?? null) === null) && runs >= 2, `receipts=${r2.length} runs=${runs}`)
    // (3) a refused write settles failed
    const w3 = world(c.seed(), c.session ?? {}, c.failCall ? undefined : { table: c.writeTable, throws: c.failThrows })
    await attempt(() => (c.failCall ?? c.call)(mod))
    const r3 = receiptsOf(w3)
    seen.push(...r3)
    ok(`${c.label}: a refused write settles the receipt failed`, r3.length === 1 && r3[0].status === "failed", `receipts=${r3.length} status=${r3[0]?.status}`)
  }
  const listed = new Set(ROWS.map((r) => r.split("#")[0]))
  const undriven = [...listed].filter((f) => !modules.has(f))
  ok(`every module on the list (${listed.size}) has a DRIVEN export`, undriven.length === 0, undriven.join(", "))
}

function providerSection() {
  console.log("\n[C · no paid provider is called · no identity in a receipt]")
  ok(`network calls: ${counters.fetch} (global fetch refuses and counts — must be 0)`, counters.fetch === 0)
  console.log(`    counted seams (stubs, never the vendor): model=${counters.model} lob=${counters.lob} batchdata=${counters.batchdata} scorer=${counters.score}`)
  ok("POSITIVE CONTROL: the paid seams WERE reached through their stubs (the counters see the path)", counters.model > 0 && counters.lob > 0 && counters.batchdata > 0)
  const leaked = seen.filter((r) => SECRETS.some((s) => JSON.stringify({ d: r.detail, ref: r.subject_ref, rd: r.reason_detail }).includes(s)))
  ok(`no receipt (${seen.length} written) carries a name, email, phone, address, free text or life-event type`, seen.length > 0 && leaked.length === 0, leaked.map((r) => `${r.action}: ${JSON.stringify(r.detail).slice(0, 160)}`).join("; "))
  ok("POSITIVE CONTROL: the identity scan flags a planted leak", SECRETS.some((s) => JSON.stringify({ d: { note: "call Zelda" } }).includes(s)))
}

async function main() {
  console.log("ledger-receipts-acquisition — wave 155, lane 155R4 (G12 list acquisition_education1)")
  staticSection()
  await drivenSection()
  providerSection()
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("LEDGER_RECEIPTS_ACQUISITION_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_ACQUISITION_PASS")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
