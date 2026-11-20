#!/usr/bin/env tsx
/**
 * scripts/wave155-uncalled-platform-doors-guard.ts — test:wave155-uncalled-platform-doors (wave 155, lane 155R29).
 *
 * THE OTHER THIRTY: 25 "use server" exports nothing called and 5 routes whose caller is outside the repo. CLAUDE.md §4: an
 * uncalled export of a "use server" file is still a public door; §1: every retirement names a survivor the product CALLS.
 *
 * §A RETIRED DOORS (rule-shaped, read from COMMENT-STRIPPED source — scripts/strip-comments.ts; a tombstone is not a call site):
 *    for each retired export — the twin no longer exports it; no runtime file imports it from the twin's module (named, or a
 *    dynamic `import()` that destructures it); the twin carries a TOMBSTONE COMMENT naming `survivor file:line` (in a comment,
 *    never a string); that survivor file exports the survivor function ON that line; and the survivor's caller file uses it.
 *    Positive controls: a twin that still exports, a tombstone naming the wrong line, a tombstone inside a string, and a planted
 *    importer are each caught.
 * §B DRIVEN — every gate / refusal / counted write this lane added, against the in-memory client (scripts/in-memory-supabase.ts)
 *    with counted seams (no provider, no model, no network). The action ledger is REAL. Every NEGATIVE here is red at 6e562189:
 *    run with R29_ROOT=<a checkout of the base's app/ + lib/> to load the base modules (the seams stay this file's).
 *
 * BLIND SPOTS (published): §A sees imports and dynamic imports, not a name reached only through a string-keyed table (the one
 * such table this lane met — workflows.ts executeAITool — is driven in §B instead). §B drives the exports, not the screens;
 * the MCP ceiling is per instance (the domain API's durable layer counts kind "domain" rows only — not reused here).
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join, dirname } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.R29_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const readAt = (root: string) => (f: string): string | null => { const p = join(root, f); return existsSync(p) ? readFileSync(p, "utf8") : null }

// ══ §A — RETIRED DOORS ═══════════════════════════════════════════════════════════════════════════════════════════════
interface Retired { file: string; name: string; survivor: string; survivorName: string; caller: string; callerNeedle?: string }
const RETIRED: Retired[] = [
  { file: "app/actions/ai-auto-response.ts", name: "generateAIResponse", survivor: "app/actions/ai-reply-coach.ts:61", survivorName: "generateAIReplyDraft", caller: "app/components/ai-copilot/inline-ai-reply-coach.tsx" },
  { file: "app/actions/ai-content-generation.tsx", name: "checkCompliance", survivor: "app/actions/compliance-monitoring.ts:141", survivorName: "scanContentCompliance", caller: "app/components/compliance/FairHousingScanner.tsx" },
  { file: "app/actions/ai-content-generation.tsx", name: "scheduleContent", survivor: "app/actions/content-studio.ts:337", survivorName: "scheduleContent", caller: "app/actions/workflows.ts" },
  { file: "app/actions/buyer-offer/track-offer-lifecycle.ts", name: "recordSellerResponse", survivor: "app/actions/buyer-offer/record-seller-response.ts:122", survivorName: "recordSellerResponse", caller: "app/components/offer/offer-agent-actions.tsx" },
  { file: "app/actions/buyer-offer/track-offer-lifecycle.ts", name: "withdrawOffer", survivor: "lib/kernel/offers.ts:626", survivorName: "withdrawOffer", caller: "app/actions/offer-kernel-actions.ts" },
  { file: "app/actions/buyer-offer/track-offer-lifecycle.ts", name: "submitOffer", survivor: "lib/esign-webhooks/finalize-packet.ts:63", survivorName: "finalizeVoiceCockpitPacket", caller: "lib/forms/esign-execution-loop.ts" },
  { file: "app/actions/copilot.ts", name: "completeMilestone", survivor: "app/actions/transaction-milestones.ts:48", survivorName: "completeMilestoneAction", caller: "app/dashboard/transactions/[id]/transaction-detail-client.tsx" },
  { file: "app/actions/showings.ts", name: "updateShowing", survivor: "app/actions/seller-showings.ts:543", survivorName: "suggestAlternativeTime", caller: "app/components/dashboard/listings/showings/showing-requests-panel.tsx" },
  { file: "app/actions/social-media-automation.ts", name: "connectSocialAccount", survivor: "app/api/social/oauth/[platform]/route.ts:122", survivorName: "GET", caller: "app/dashboard/profile/profile-settings-client.tsx", callerNeedle: "/api/social/oauth/" },
  { file: "app/actions/social-publishing.ts", name: "connectSocialAccount", survivor: "app/api/social/oauth/[platform]/route.ts:122", survivorName: "GET", caller: "app/dashboard/profile/profile-settings-client.tsx", callerNeedle: "/api/social/oauth/" },
  { file: "app/actions/social-media-automation.ts", name: "disconnectSocialAccount", survivor: "app/actions/social-publishing.ts:156", survivorName: "disconnectSocialAccount", caller: "app/dashboard/profile/profile-settings-client.tsx" },
  { file: "app/actions/social-publishing.ts", name: "deleteSocialPost", survivor: "app/actions/social-media-automation.ts:1308", survivorName: "deleteSocialPost", caller: "app/dashboard/social/social-dashboard-client.tsx" },
  { file: "app/actions/social-publishing.ts", name: "updateSocialPost", survivor: "app/actions/social-media-automation.ts:1360", survivorName: "updateSocialPost", caller: "app/dashboard/social/components/post-composer-dialog.tsx" },
  { file: "app/actions/open-house-automation.ts", name: "scheduleOpenHouse", survivor: "app/actions/open-house.ts:93", survivorName: "createOpenHouse", caller: "app/dashboard/open-houses/open-houses-client.tsx" },
  { file: "app/actions/crm.ts", name: "deleteContact", survivor: "app/actions/contacts.ts:507", survivorName: "archiveContact", caller: "app/crm/page.tsx" },
  { file: "app/actions/listings.ts", name: "createListing", survivor: "app/actions/listings-kernel.ts:139", survivorName: "createListingWithSellerContact", caller: "app/components/form-wizard/FormWizard.tsx" },
  { file: "app/actions/orchestrator.ts", name: "emitEvent", survivor: "lib/orchestrator/internal.ts:359", survivorName: "emitEventFromCron", caller: "app/actions/listing-media.ts" },
  { file: "app/actions/ai-generate.ts", name: "generateAIText", survivor: "lib/ai/generate.ts:64", survivorName: "generateAIText", caller: "app/actions/neighborhood-reports.ts" },
  { file: "app/actions/ai-generate.ts", name: "generateChatResponse", survivor: "app/api/internal/ai-chat/route.ts:366", survivorName: "POST", caller: "app/components/shared/internal-ai-assistant.tsx", callerNeedle: "/api/internal/ai-chat" },
  { file: "app/actions/workflows.ts", name: "sendMessage", survivor: "app/actions/ai-communication-hub.ts:54", survivorName: "sendMessage", caller: "app/dashboard/communications/communications-os-client.tsx" },
]
const exportsFn = (code: string, name: string) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`).test(code)
const modOf = (f: string) => f.replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "")
function resolveSpec(importer: string, spec: string): string | null {
  if (spec.startsWith("@/")) return modOf(spec.slice(2))
  if (spec.startsWith(".")) return modOf(join(dirname(importer), spec).replace(/\\/g, "/"))
  return null
}
/** Every runtime file that imports `name` from `twinFile`'s module (stripped source: named import, or a dynamic import destructuring it). */
function importersOf(name: string, twinFile: string, files: Map<string, string>): string[] {
  const twin = modOf(twinFile)
  const out: string[] = []
  const word = new RegExp(`\\b${name}\\b`)
  for (const [f, code] of files) {
    if (f === twinFile || !word.test(code)) continue
    for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      if (resolveSpec(f, m[2]) === twin && m[1].split(",").some((x) => x.trim().split(/\s+as\s+/)[0].trim() === name)) out.push(f)
    }
    for (const m of code.matchAll(/\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) {
      if (resolveSpec(f, m[2]) === twin && m[1].split(",").some((x) => x.trim().split(/\s*:\s*/)[0].trim() === name)) out.push(f)
    }
    for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)\s*\)?\s*\.\s*(\w+)/g)) {
      if (resolveSpec(f, m[1]) === twin && m[2] === name) out.push(f)
    }
  }
  return out
}
function retiredProblems(r: Retired, readF: (f: string) => string | null, files: Map<string, string>): string[] {
  const out: string[] = []
  const raw = readF(r.file)
  if (raw === null) return [`${r.file} does not exist`]
  const code = stripComments(raw)
  if (exportsFn(code, r.name)) out.push(`${r.file} still exports ${r.name}`)
  if (!/TOMBSTONE/.test(raw) || !raw.includes(r.survivor)) out.push(`${r.file} has no TOMBSTONE naming ${r.survivor}`)
  else if (code.includes(r.survivor)) out.push(`${r.file} names ${r.survivor} in CODE (a string), not in a tombstone comment`)
  const at = r.survivor.lastIndexOf(":")
  const [sf, sl] = [r.survivor.slice(0, at), Number(r.survivor.slice(at + 1))]
  const sraw = readF(sf)
  if (sraw === null) out.push(`survivor ${sf} does not exist`)
  else {
    const line = sraw.split("\n")[sl - 1] ?? ""
    if (!new RegExp(`^export\\s+(?:async\\s+)?function\\s+${r.survivorName}\\b`).test(line)) out.push(`survivor ${r.survivor} is not where ${r.survivorName} is exported (line reads: ${line.trim().slice(0, 80)})`)
  }
  const craw = readF(r.caller)
  if (craw === null) out.push(`caller ${r.caller} does not exist`)
  else if (r.callerNeedle ? !craw.includes(r.callerNeedle) : !new RegExp(`\\b${r.survivorName}\\b`).test(stripComments(craw))) out.push(`caller ${r.caller} does not reach ${r.survivorName}`)
  const imps = importersOf(r.name, r.file, files)
  if (imps.length) out.push(`${r.name} is still imported from ${r.file} by ${imps.join(", ")}`)
  return out
}
function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (/\.(tsx?|mjs|jsx?)$/.test(e) && !/\.d\.ts$/.test(e)) acc.push(p)
  }
  return acc
}

function sectionA() {
  section("§A · every retired door: no call site, a tombstone COMMENT naming a survivor the product calls")
  const readF = readAt(ROOT)
  const files = new Map<string, string>()
  for (const top of ["app", "lib"]) for (const abs of walk(join(ROOT, top))) files.set(abs.slice(ROOT.length + 1), stripComments(readFileSync(abs, "utf8")))
  console.log(`  denominator: ${files.size} runtime files under app/ + lib/ (stripped), ${RETIRED.length} retired exports in ${new Set(RETIRED.map((r) => r.file)).size} files`)
  for (const r of RETIRED) {
    const p = retiredProblems(r, readF, files)
    check(`${r.file}#${r.name} → ${r.survivor} ${r.survivorName} (called from ${r.caller})`, p.length === 0, p)
  }
  // POSITIVE CONTROLS — the finder still recognizes each defect it was written for.
  const ctl: Retired = { file: "app/actions/x.ts", name: "doIt", survivor: "app/actions/y.ts:3", survivorName: "doIt", caller: "app/z.tsx" }
  const fx = (x: string, extra: Record<string, string> = {}) => (f: string) => ({ "app/actions/x.ts": x, "app/actions/y.ts": "\"use server\"\n\nexport async function doIt() { return 1 }\n", "app/z.tsx": "import { doIt } from \"@/app/actions/y\"\ndoIt()\n", ...extra } as Record<string, string>)[f] ?? null
  const good = "// TOMBSTONE: doIt DELETED → survivor app/actions/y.ts:3 doIt\nexport async function other() {}\n"
  check("CONTROL: a well-formed retirement passes the same check", retiredProblems(ctl, fx(good), new Map()).length === 0, retiredProblems(ctl, fx(good), new Map()))
  check("POSITIVE CONTROL: a twin that still exports the name is caught", retiredProblems(ctl, fx(good + "export async function doIt() {}\n"), new Map()).some((p) => /still exports/.test(p)))
  check("POSITIVE CONTROL: a tombstone naming the wrong line is caught", retiredProblems({ ...ctl, survivor: "app/actions/y.ts:1" }, fx("// TOMBSTONE → app/actions/y.ts:1\n"), new Map()).some((p) => /is not where/.test(p)))
  check("POSITIVE CONTROL: a 'tombstone' inside a string is not a tombstone", retiredProblems(ctl, fx("const n = \"TOMBSTONE app/actions/y.ts:3\"\n"), new Map()).some((p) => /in CODE/.test(p)))
  const planted = new Map([["app/w.tsx", stripComments("import { doIt } from \"@/app/actions/x\"\nawait doIt()\n")], ["app/sub/v.ts", "const { doIt } = await import(\"../actions/x\")"], ["app/u.ts", "const { doIt } = await import(\"./elsewhere\")"]])
  check("POSITIVE CONTROL: a planted importer (named, and a dynamic import that destructures it) is caught — and a namesake from another module is not", importersOf("doIt", "app/actions/x.ts", planted).join(",") === "app/w.tsx,app/sub/v.ts", importersOf("doIt", "app/actions/x.ts", planted))
  check("CONTROL: an importer COMMENTED OUT is not a call site (stripped source)", importersOf("doIt", "app/actions/x.ts", new Map([["app/w.tsx", stripComments("// import { doIt } from \"@/app/actions/x\"\n")]])).length === 0)
}

// ══ §B — DRIVEN ═══════════════════════════════════════════════════════════════════════════════════════════════════════
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000029`
const B1 = u("b", 1), B2 = u("b", 2)
const U_BROKER = u("a", 1), U_AGENT = u("a", 2), U_AGENT2 = u("a", 3), U_X = u("a", 9)
const AG_A = u("e", 2), AG_B = u("e", 3), AG_X = u("e", 9), AG_BR = u("e", 1)
const C_A = u("c", 1), C_X = u("c", 9), L_A = u("1", 1), L_X = u("1", 9)
const O_OPEN = u("d", 1), O_ACC = u("d", 2), O_X = u("d", 9)
const P_A = u("2", 1), P_B = u("2", 2), SA_A = u("3", 1), SA_B = u("3", 2), VI1 = u("4", 1), SIG1 = u("5", 1), SEQ1 = u("6", 1), CONV1 = u("7", 1)
const SECRET_B1 = "whsec_fixture_tenant_b1_secret"
const TX_A = u("9", 1)

function seedWorld(): MemClient {
  return memSupabase({
    brokerages: [{ id: B1, plan_tier: "brokerage" }, { id: B2, plan_tier: "brokerage" }],
    locations: [],
    users: [
      { id: U_BROKER, brokerage_id: B1, user_type: "broker", first_name: "Bea", last_name: "Broker", email: "bea@example.test" },
      { id: U_AGENT, brokerage_id: B1, user_type: "agent", first_name: "Ann", last_name: "Agent", email: "ann@example.test" },
      { id: U_AGENT2, brokerage_id: B1, user_type: "agent", first_name: "Ben", last_name: "Agent", email: "ben@example.test" },
      { id: U_X, brokerage_id: B2, user_type: "broker", first_name: "Xavi", last_name: "Other", email: "x@example.test" },
    ],
    agents: [
      { id: AG_BR, user_id: U_BROKER, brokerage_id: B1 },
      { id: AG_A, user_id: U_AGENT, brokerage_id: B1 },
      { id: AG_B, user_id: U_AGENT2, brokerage_id: B1 },
      { id: AG_X, user_id: U_X, brokerage_id: B2 },
    ],
    contacts: [
      { id: C_A, brokerage_id: B1, agent_id: AG_A, first_name: "Sam", last_name: "Seller", email: "sam@example.test" },
      { id: C_X, brokerage_id: B2, agent_id: AG_X, first_name: "Other", last_name: "Client", email: "other@example.test" },
    ],
    listings: [
      { id: L_A, brokerage_id: B1, agent_id: AG_A, address: "1 Fixture Way", lifecycle_stage: "CMA_GENERATION", status: "draft" },
      { id: L_X, brokerage_id: B2, agent_id: AG_X, address: "9 Other St", lifecycle_stage: "CMA_GENERATION", status: "draft" },
    ],
    offers: [
      { id: O_OPEN, brokerage_id: B1, status: "pending", contact_id: null, listing_id: null },
      { id: O_ACC, brokerage_id: B1, status: "accepted", contact_id: null, listing_id: null },
      { id: O_X, brokerage_id: B2, status: "pending", contact_id: null, listing_id: null },
    ],
    social_posts: [
      { id: P_A, brokerage_id: B1, user_id: U_AGENT, status: "draft", content: "mine", platform: "facebook" },
      { id: P_B, brokerage_id: B1, user_id: U_AGENT2, status: "draft", content: "theirs", platform: "facebook" },
    ],
    social_media_accounts: [
      { id: SA_A, brokerage_id: B1, user_id: U_AGENT, is_active: true },
      { id: SA_B, brokerage_id: B1, user_id: U_AGENT2, is_active: true },
    ],
    vendor_invoices: [{ id: VI1, brokerage_id: B1, status: "draft" }],
    behavioral_signals: [{ id: SIG1, brokerage_id: B1 }],
    tenant_webhook_subscriptions: [{ id: u("8", 1), brokerage_id: B1, secret: SECRET_B1, active: true }],
    campaign_sequences: [{ id: SEQ1, brokerage_id: B1, trigger_event: "qr_code_scanned", is_active: true }],
    sequence_enrollments: [], workflow_webhook_events: [], calendar_events: [], client_engagement_scores: [], lifetime_customer_touchpoints: [],
    referrals: [], activities: [], agent_action_ledger: [], conversations: [{ id: CONV1, brokerage_id: B1, contact_id: C_A }], messages: [],
    lifecycle_events: [], listing_stage_history: [], automation_errors: [],
    transactions: [{ id: TX_A, brokerage_id: B1, agent_id: AG_A }],
  }, { uuidIds: true })
}

const G = globalThis as any
G.__R29 = {
  mem: seedWorld() as MemClient, seat: null as string | null,
  caller: { brokerageId: null, scopes: [], via: "none", credentialId: null } as any, entitled: true,
  calls: { collect: [] as any[], invocations: [] as any[], rentcast: 0, hub: [] as any[], model: 0, prep: 0, milestones: [] as any[] },
  sess: () => Object.assign(G.__R29.mem, { auth: { getUser: async () => ({ data: { user: G.__R29.seat ? { id: G.__R29.seat, email: "seat@example.test", user_metadata: {} } : null }, error: null }) } }),
}
const STUBS: Record<string, string> = {
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__R29.sess() }; export async function createServerClient(){ return globalThis.__R29.sess() }",
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__R29.sess() }",
  "lib/kernel/emit.ts": "export async function emitKernelEvent(){ return { inserted: true } }; export function asWriteResult(){ return { data: null, error: null } }",
  "lib/negotiation/auto-trigger.ts": "export async function recordOutcomeForOfferSafe(){}",
  "lib/errors/collect-error.ts": "export async function collectError(p){ globalThis.__R29.calls.collect.push(p); return 'err-fixture-1' }",
  "lib/agentic-os/agent-credentials.ts": "export async function resolveAgenticCaller(){ return globalThis.__R29.caller }",
  "lib/agentic-os/invocation-log.ts": "export async function recordInvocation(i){ globalThis.__R29.calls.invocations.push(i); return true }",
  "lib/billing/billing-access.ts": "export async function mayUseAndAfford(){ return globalThis.__R29.entitled ? { allowed: true } : { allowed: false, reason: 'subscription_inactive' } }",
  "lib/property/rentcast.ts": "export async function getRentcastMarketStats(){ globalThis.__R29.calls.rentcast++; return { ok: true } }; export async function getRentcastComps(){ globalThis.__R29.calls.rentcast++; return { ok: true } }",
  "lib/lead-intelligence/visitor-email-capture.ts": `export async function resolveSignalIdentity(){ return { identified: true, contact: { id: '${C_A}' }, method: 'email_exact' } }`,
  "app/actions/ai-communication-hub.ts": "export async function sendMessage(p){ globalThis.__R29.calls.hub.push(p); return { success: true, messageId: 'm-1' } }",
  "lib/kernel/conversation-thread.ts": `export async function ensureConversationForContact(){ return '${CONV1}' }`,
  "lib/workflow-orchestrator/chains/listing-appt-prep.ts": "export async function fireListingAppointmentSetForBooking(){ globalThis.__R29.calls.prep++; return { status: 'skipped' } }",
  "lib/transactions/milestone-service.ts": "export async function completeMilestone(p){ globalThis.__R29.calls.milestones.push(p) }; export async function overrideMilestone(){}; export async function setMilestoneDate(){}",
  "lib/ai/models.ts": "export async function generateTextRouted(){ globalThis.__R29.calls.model++; return { text: '{}' } }; export async function generateObjectRouted(){ globalThis.__R29.calls.model++; return { object: {} } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }; export async function draftMode(){ return { isEnabled: false } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const base of [ROOT, WT]) for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"]) {
    const p = join(base, rel + ext)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    let r: any
    if (spec.startsWith("@/")) { const p = aliasPath(spec.slice(2)); r = p ? { url: pathToFileURL(p).href, shortCircuit: true } : next(spec, ctx) }
    else r = next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const rawUrl = String(r.url ?? "")
    const path = decodeURIComponent((rawUrl.startsWith("file://") ? rawUrl.slice("file://".length) : rawUrl).split("?")[0])
    const key = Object.keys(STUBS).find((k) => path.endsWith("/" + k))
    if (!key) return r
    return { url: dataUrl(`export * from ${JSON.stringify(pathToFileURL(path).href)}; ${STUBS[key]}`), shortCircuit: true }
  },
})
for (const k of ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RENTCAST_API_KEY", "WORKFLOW_WEBHOOK_SECRET"]) delete process.env[k]
process.env.INTERNAL_API_SECRET = "fixture-internal-api-secret-0029"

const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)
function as(seat: string | null): MemClient {
  G.__R29.mem = seedWorld(); G.__R29.seat = seat; G.__R29.entitled = true
  G.__R29.calls = { collect: [], invocations: [], rentcast: 0, hub: [], model: 0, prep: 0, milestones: [] }
  return G.__R29.mem
}
const T = (m: MemClient, t: string): Row[] => m.tables[t] ?? []
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
async function drive<X>(fn: () => Promise<X>): Promise<{ r: X | undefined; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}
const refused = (x: { r: any; threw: string | null }) => !!x.threw || x.r?.success === false || x.r?.ok === false
const receipts = (m: MemClient, action: string) => T(m, "agent_action_ledger").filter((r) => r.action === action)
const req = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://fixture.test${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }) as any
async function resJson(res: any): Promise<any> { try { return await res.clone().json() } catch { return null } }

async function guarded(label: string, fn: () => Promise<void>) {
  try { await fn() } catch (e) { check(`${label} — the harness ran`, false, (e as Error)?.stack?.slice(0, 400)) }
}

async function sectionB() {
  await guarded("kernel withdrawOffer", async () => {
    section("§B1 · lib/kernel/offers.ts withdrawOffer — the survivor carries what the retired twin enforced")
    const k = await load("lib/kernel/offers.ts")
    let m = as(U_AGENT); let x = await drive(() => k.withdrawOffer({ offerId: O_ACC, agentId: AG_A, brokerageId: B1 }, m))
    check("NEG an ACCEPTED offer is not withdrawn: refused, status stays accepted, no withdrawn activity", refused(x) && T(m, "offers").find((o) => o.id === O_ACC)?.status === "accepted" && !T(m, "activities").some((a) => a.entity_id === O_ACC), x)
    m = as(U_AGENT); x = await drive(() => k.withdrawOffer({ offerId: O_X, agentId: AG_A, brokerageId: B1 }, m))
    check("NEG another tenant's offer (the tenant pin): refused — a zero-row update is not a success; its row is unchanged", refused(x) && T(m, "offers").find((o) => o.id === O_X)?.status === "pending", x)
    m = as(U_AGENT); x = await drive(() => k.withdrawOffer({ offerId: O_OPEN, agentId: AG_A, brokerageId: B1, reason: "buyer changed plans" }, m))
    const act = T(m, "activities").filter((a) => a.entity_id === O_OPEN)
    check("POS an open offer is withdrawn AND its buyer.offer.withdrawn lifecycle activity is filed (the derivation reads it)", (x.r as any)?.success === true && T(m, "offers").find((o) => o.id === O_OPEN)?.status === "withdrawn" && act.length === 1 && act[0].activity_type === "buyer.offer.withdrawn" && act[0].brokerage_id === B1, { x, act })
  })

  await guarded("social-publishing disconnect", async () => {
    section("§B2 · app/actions/social-publishing.ts disconnectSocialAccount — merged: uuid, tenant pin, counted")
    const sp = await load("app/actions/social-publishing.ts")
    let m = as(U_AGENT); let x = await drive(() => sp.disconnectSocialAccount(SA_B))
    check("NEG a colleague's account: refused (zero rows is not success); it stays active", refused(x) && T(m, "social_media_accounts").find((a) => a.id === SA_B)?.is_active === true, x)
    m = as(U_AGENT); x = await drive(() => sp.disconnectSocialAccount("not-a-uuid"))
    check("NEG a malformed id is refused", refused(x), x)
    m = as(U_AGENT); x = await drive(() => sp.disconnectSocialAccount(SA_A))
    check("POS the caller's own account is disconnected, with ONE receipt", !x.threw && T(m, "social_media_accounts").find((a) => a.id === SA_A)?.is_active === false && receipts(m, "social.account.disconnect").length === 1, { x, r: receipts(m, "social.account.disconnect").length })
  })

  await guarded("social-media-automation edit/cancel", async () => {
    section("§B3 · app/actions/social-media-automation.ts updateSocialPost / deleteSocialPost — merged: own-post rule, tenant pin")
    const sma = await load("app/actions/social-media-automation.ts")
    let m = as(U_AGENT); let x = await drive(() => sma.updateSocialPost({ postId: P_B, userId: U_AGENT, content: "hijacked" }))
    check("NEG an agent cannot edit a colleague's post; it is unchanged", refused(x) && T(m, "social_posts").find((p) => p.id === P_B)?.content === "theirs", x)
    m = as(U_AGENT); x = await drive(() => sma.deleteSocialPost(P_B, U_AGENT))
    check("NEG an agent cannot cancel a colleague's post; it stays draft", refused(x) && T(m, "social_posts").find((p) => p.id === P_B)?.status === "draft", x)
    m = as(U_AGENT); x = await drive(() => sma.updateSocialPost({ postId: P_A, userId: U_AGENT, content: "edited" }))
    check("POS an agent edits their own post", (x.r as any)?.success === true && T(m, "social_posts").find((p) => p.id === P_A)?.content === "edited", x)
    m = as(U_BROKER); x = await drive(() => sma.updateSocialPost({ postId: P_B, userId: U_BROKER, content: "broker fix" }))
    check("POS leadership edits any post in its tenant", (x.r as any)?.success === true && T(m, "social_posts").find((p) => p.id === P_B)?.content === "broker fix", x)
  })

  await guarded("calculateEngagementScore", async () => {
    section("§B4 · app/actions/lifetime-customer-touchpoints.ts calculateEngagementScore — kept, made safe")
    const lt = await load("app/actions/lifetime-customer-touchpoints.ts")
    let m = as(U_AGENT); let x = await drive(() => lt.calculateEngagementScore(C_X))
    check("NEG another tenant's contact: refused, NO score row written (UNIQUE(contact_id) — it could rewrite theirs)", refused(x) && T(m, "client_engagement_scores").length === 0, { x, rows: T(m, "client_engagement_scores") })
    m = as(U_AGENT); x = await drive(() => lt.calculateEngagementScore(C_A))
    const sc = T(m, "client_engagement_scores")
    check("POS the tenant's own contact: one score row under the SESSION tenant, and ONE receipt", !x.threw && sc.length === 1 && sc[0].brokerage_id === B1 && receipts(m, "lifetime.engagement_score.calculate").length === 1, { x, sc, r: receipts(m, "lifetime.engagement_score.calculate").length })
  })

  await guarded("scheduleListingAppointment", async () => {
    section("§B5 · app/actions/listing-lifecycle.ts scheduleListingAppointment — kept, made safe")
    const ll = await load("app/actions/listing-lifecycle.ts")
    let m = as(U_AGENT); let x = await drive(() => ll.scheduleListingAppointment({ listing_id: L_X, contact_id: C_A, appointment_date: "2027-03-01", appointment_time: "10:00" }))
    check("NEG another tenant's listing: refused BEFORE any write — no calendar row lands under this tenant", refused(x) && T(m, "calendar_events").length === 0, { x, cal: T(m, "calendar_events").length })
    m = as(U_AGENT); x = await drive(() => ll.scheduleListingAppointment({ listing_id: L_A, contact_id: C_X, appointment_date: "2027-03-01", appointment_time: "10:00" }))
    check("NEG another tenant's contact: refused, no calendar row", refused(x) && T(m, "calendar_events").length === 0, { x, cal: T(m, "calendar_events").length })
    m = as(U_AGENT); x = await drive(() => ll.scheduleListingAppointment({ listing_id: L_A, contact_id: C_A, appointment_date: "2027-03-01", appointment_time: "10:00" }))
    check("POS the tenant's own listing + contact: booked (one calendar row) with ONE receipt", !x.threw && T(m, "calendar_events").length === 1 && receipts(m, "listing.appointment.schedule").length === 1, { x, cal: T(m, "calendar_events").length, r: receipts(m, "listing.appointment.schedule").length })
  })

  await guarded("submitVendorInvoice", async () => {
    section("§B6 · app/actions/vendor-payments.ts submitVendorInvoice — kept; the receipt a money state change owes")
    const vp = await load("app/actions/vendor-payments.ts")
    const m = as(U_BROKER); const x = await drive(() => vp.submitVendorInvoice(VI1))
    const rc = receipts(m, "vendor.invoice.submit")
    check("POS a draft invoice moves to submitted with ONE FINANCIAL receipt naming the session user", (x.r as any)?.success === true && T(m, "vendor_invoices")[0]?.status === "submitted" && rc.length === 1 && rc[0].risk_class === "FINANCIAL", { x, rc })
  })

  await guarded("resolveIdentity", async () => {
    section("§B7 · app/actions/lead-intelligence.ts resolveIdentity — kept, made safe")
    const li = await load("app/actions/lead-intelligence.ts")
    let m = as(U_AGENT); let x = await drive(() => li.resolveIdentity("not-a-uuid"))
    check("NEG a malformed signal id is refused, nothing recorded", refused(x) && T(m, "agent_action_ledger").length === 0, x)
    m = as(U_AGENT); x = await drive(() => li.resolveIdentity(SIG1))
    check("POS a staff re-match leaves ONE receipt (session user, session tenant, the signal)", (x.r as any)?.success === true && receipts(m, "lead_intelligence.signal_identity.resolve").length === 1 && receipts(m, "lead_intelligence.signal_identity.resolve")[0].brokerage_id === B1, { x, n: receipts(m, "lead_intelligence.signal_identity.resolve").length })
  })

  await guarded("executeAITool send-message", async () => {
    section("§B8 · app/actions/workflows.ts executeAITool(\"send-message\") — routed through the comms hub")
    const wf = await load("app/actions/workflows.ts")
    as(U_AGENT); let x = await drive(() => wf.executeAITool("send-message", { contactId: C_A, message: "hello", channel: "sms" }, {}))
    check("POS the step reaches the hub's send ONCE, with the contact's resolved thread", (x.r as any)?.success === true && G.__R29.calls.hub.length === 1 && G.__R29.calls.hub[0].conversationId === CONV1 && G.__R29.calls.hub[0].channel === "sms", { x, hub: G.__R29.calls.hub })
    as(U_AGENT); x = await drive(() => wf.executeAITool("send-message", { contactId: C_X, message: "hello", channel: "sms" }, {}))
    check("NEG another tenant's contact: refused, the hub is never reached", refused(x) && G.__R29.calls.hub.length === 0, { x, hub: G.__R29.calls.hub.length })
  })

  await guarded("errors/collect", async () => {
    section("§B9 · app/api/errors/collect — the credential decides the tenant")
    const route = await load("app/api/errors/collect/route.ts")
    as(U_AGENT); let res: any = await quiet(() => route.POST(req("/api/errors/collect", { workflowName: "w", errorMessage: "boom", brokerageId: B2, agentId: AG_X })))
    check("NEG a signed-in seat naming ANOTHER tenant: 403, nothing filed", res.status === 403 && G.__R29.calls.collect.length === 0, { status: res.status, filed: G.__R29.calls.collect })
    as(U_AGENT); res = await quiet(() => route.POST(req("/api/errors/collect", { workflowName: "w", errorMessage: "boom", agentId: AG_X })))
    check("POS a signed-in seat files under ITS tenant and ITS agent (a body agentId is not taken)", res.status === 200 && G.__R29.calls.collect.length === 1 && G.__R29.calls.collect[0].brokerageId === B1 && G.__R29.calls.collect[0].agentId === AG_A, { status: res.status, filed: G.__R29.calls.collect })
    as(null); res = await quiet(() => route.POST(req("/api/errors/collect", { workflowName: "w", errorMessage: "boom", brokerageId: B2 }, { "x-internal-api-secret": "fixture-internal-api-secret-0029" })))
    check("POS the service path (the platform secret) still names the tenant it reports for", res.status === 200 && G.__R29.calls.collect[0]?.brokerageId === B2, { status: res.status, filed: G.__R29.calls.collect })
    as(null); res = await quiet(() => route.POST(req("/api/errors/collect", { workflowName: "w", errorMessage: "boom" }, { "x-internal-api-secret": "wrong-secret-of-another-length" })))
    check("NEG a wrong secret and no session: 401, nothing filed", res.status === 401 && G.__R29.calls.collect.length === 0, res.status)
  })

  await guarded("agentic MCP", async () => {
    section("§B10 · app/api/agentic-os/mcp tools/call — the paid read executors take tenant, entitlement and a ceiling")
    const route = await load("app/api/agentic-os/mcp/route.ts")
    const call = (n = 1) => req("/api/agentic-os/mcp", { jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "market_stats", arguments: { zipCode: "32541" } } })
    as(null); G.__R29.caller = { brokerageId: null, scopes: ["*"], via: "token", credentialId: u("9", 1) }
    let res: any = await quiet(() => route.POST(call())); let body = await resJson(res)
    check("NEG a credential bound to NO tenant: the paid tool is not run (0 provider calls), the refusal is recorded", body?.result?.isError === true && G.__R29.calls.rentcast === 0 && G.__R29.calls.invocations.some((i: any) => i.decision === "unauthorized"), { body, rentcast: G.__R29.calls.rentcast })
    as(null); G.__R29.caller = { brokerageId: B1, scopes: ["*"], via: "token", credentialId: u("9", 2) }; G.__R29.entitled = false
    res = await quiet(() => route.POST(call())); body = await resJson(res)
    check("NEG a tenant whose subscription does not allow API access: 0 provider calls, recorded as blocked", body?.result?.isError === true && G.__R29.calls.rentcast === 0 && G.__R29.calls.invocations.some((i: any) => i.decision === "blocked"), { body, rentcast: G.__R29.calls.rentcast })
    as(null); G.__R29.caller = { brokerageId: B1, scopes: ["*"], via: "token", credentialId: u("9", 3) }
    let last: any = null
    for (let i = 0; i < 121; i++) last = await quiet(() => route.POST(call(i)))
    check("NEG the 121st call inside a minute from one credential is refused (429) and the provider ran 120 times, not 121", last?.status === 429 && G.__R29.calls.rentcast === 120, { status: last?.status, rentcast: G.__R29.calls.rentcast })
    as(null); G.__R29.caller = { brokerageId: B1, scopes: ["*"], via: "token", credentialId: u("9", 4) }
    res = await quiet(() => route.POST(call())); body = await resJson(res)
    check("POS an entitled tenant credential runs the tool (1 provider call)", !body?.result?.isError && G.__R29.calls.rentcast === 1, { body, rentcast: G.__R29.calls.rentcast })
  })

  await guarded("workflow/trigger", async () => {
    section("§B11 · app/api/workflow/trigger — a named contact must be the credential's tenant's")
    const route = await load("app/api/workflow/trigger/route.ts")
    const auth = { authorization: `Bearer ${SECRET_B1}` }
    let m = as(null); let res: any = await quiet(() => route.POST(req("/api/workflow/trigger", { event: "qr_code_scanned", brokerageId: B1, contactId: C_X }, auth)))
    check("NEG a tenant secret naming ANOTHER tenant's contact: refused (422), no enrollment, no audit row", res.status === 422 && T(m, "sequence_enrollments").length === 0, { status: res.status, enr: T(m, "sequence_enrollments") })
    m = as(null); res = await quiet(() => route.POST(req("/api/workflow/trigger", { event: "qr_code_scanned", brokerageId: B1, contactId: C_A }, auth)))
    check("POS the tenant's own contact is enrolled in its matching sequence", res.status === 200 && T(m, "sequence_enrollments").length === 1 && T(m, "sequence_enrollments")[0].brokerage_id === B1, { status: res.status, body: await resJson(res) })
  })

  // INTEGRATOR (wave 155 convergence): the survivor two retirements now name (copilot.ts and transactions.ts completeMilestone →
  // completeMilestoneAction) took its tenant from the BODY, anchored only by a read on the caller's RLS client — and its writer runs
  // on the service client. This in-memory client has no RLS, which is exactly the case the anchor cannot be trusted in.
  await guarded("completeMilestoneAction", async () => {
    section("§B12 · app/actions/transaction-milestones.ts completeMilestoneAction — the survivor's tenant is the session's, the body's is a claim")
    const tm = await load("app/actions/transaction-milestones.ts")
    let m = as(U_X); let x = await drive(() => tm.completeMilestoneAction({ transactionId: TX_A, brokerageId: B1, milestoneName: "inspection" }))
    check("NEG another tenant's seat naming this deal and ITS brokerage: refused before any write (0 milestone writes)", refused(x) && G.__R29.calls.milestones.length === 0, { x, n: G.__R29.calls.milestones.length })
    m = as(null); x = await drive(() => tm.completeMilestoneAction({ transactionId: TX_A, brokerageId: B1, milestoneName: "inspection" }))
    check("NEG no session: refused, 0 milestone writes", refused(x) && G.__R29.calls.milestones.length === 0, x)
    m = as(U_AGENT); x = await drive(() => tm.completeMilestoneAction({ transactionId: u("9", 9), brokerageId: B1, milestoneName: "inspection" }))
    check("NEG a deal that is not in the session's tenant: refused, 0 milestone writes", refused(x) && G.__R29.calls.milestones.length === 0, x)
    m = as(U_AGENT); x = await drive(() => tm.completeMilestoneAction({ transactionId: TX_A, brokerageId: B1, milestoneName: "inspection", notes: "report in" }))
    const w = G.__R29.calls.milestones[0]
    check("POS the tenant's own seat completes it once — the writer is handed the SESSION tenant and the SESSION user, and the merged note", (x.r as any)?.success === true && G.__R29.calls.milestones.length === 1 && w?.brokerageId === B1 && w?.completedBy === U_AGENT && w?.notes === "report in", { x, w })
    void m
  })
}

// ══ §C — WHAT THE SURVIVOR LACKED (integrator, wave 155 convergence) ═══════════════════════════════════════════════════════════════════
// Both retired connectSocialAccount doors wrote social_media_accounts.agent_id; their survivor, the OAuth callback, did not — and the
// readers that post on "the sender's own channel" filter on it, so every channel connected through the product was invisible to them
// (the opposite-missing census raised it as a column read by code and written by nobody the moment the dead writers left). The rule,
// on comment-stripped source: the callback's upsert stamps agent_id from an agents row resolved by the connecting user AND the tenant,
// reads that lookup's error, and never writes a tenantless row.
/** PURE — problems with a social-account callback source (empty = the rule holds). */
function socialCallbackProblems(code: string): string[] {
  const out: string[] = []
  const up = /\.from\(\s*"social_media_accounts"\s*\)\s*\.upsert\(\s*\{([\s\S]*?)\}\s*,\s*\{\s*onConflict/.exec(code)?.[1] ?? null
  if (up === null) return ["no social_media_accounts upsert found"]
  if (!/\bagent_id\s*:/.test(up)) out.push("the upsert does not stamp agent_id")
  if (/\bbrokerage_id\s*:[^,\n]*\?\?\s*null/.test(up)) out.push("the upsert may write a tenantless row (brokerage_id … ?? null)")
  const lookup = /const\s*\{\s*data:\s*(\w+)\s*,\s*error:\s*(\w+)\s*\}\s*=\s*await\s+\w+\s*\.from\(\s*"agents"\s*\)\s*\.select\(\s*"id"\s*\)([^\n]*)/.exec(code)
  if (!lookup) out.push("no agents lookup that reads its error")
  else {
    if (!/\.eq\(\s*"user_id"/.test(lookup[3]) || !/\.eq\(\s*"brokerage_id"/.test(lookup[3])) out.push("the agents lookup is not pinned to the connecting user AND the tenant")
    if (!new RegExp(`if\\s*\\(\\s*${lookup[2]}\\s*\\)`).test(code)) out.push("the agents lookup's error is never read")
    if (!new RegExp(`agent_id\\s*:[^\\n]*\\b${lookup[1]}\\b`).test(up)) out.push("agent_id is not the looked-up agents row")
  }
  return out
}
function sectionC() {
  section("§C · app/api/social/oauth/[platform]/route.ts — the survivor of the two retired connect doors writes what its readers filter on")
  const src = readAt(ROOT)("app/api/social/oauth/[platform]/route.ts")
  const problems = src === null ? ["route file missing"] : socialCallbackProblems(stripComments(src))
  check("the OAuth callback stamps agent_id from the connecting user's agents row in the same tenant, reads the lookup's error, and never writes a tenantless row", problems.length === 0, problems)
  const good = `const { data: a, error: aErr } = await db.from("agents").select("id").eq("user_id", u).eq("brokerage_id", b).maybeSingle()\nif (aErr) return fail()\nawait db.from("social_media_accounts").upsert({ brokerage_id: b, user_id: u, agent_id: (a as any)?.id ?? null }, { onConflict: "x" })`
  check("§C CONTROLS — a well-formed callback passes; no agent_id, a tenantless fallback, an unpinned lookup and an unread lookup error are each caught",
    socialCallbackProblems(good).length === 0
    && socialCallbackProblems(good.replace(", agent_id: (a as any)?.id ?? null", "")).some((x) => x.includes("does not stamp"))
    && socialCallbackProblems(good.replace("brokerage_id: b,", "brokerage_id: b ?? null,")).some((x) => x.includes("tenantless"))
    && socialCallbackProblems(good.replace('.eq("brokerage_id", b)', "")).some((x) => x.includes("not pinned"))
    && socialCallbackProblems(good.replace("if (aErr) return fail()", "")).some((x) => x.includes("never read")))
}

async function main() {
  console.log(`\nwave155-uncalled-platform-doors-guard — lane 155R29 (modules from ${ROOT === WT ? "this worktree" : ROOT})`)
  sectionA()
  await sectionB()
  sectionC()
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(`❌ WAVE155_UNCALLED_PLATFORM_DOORS_FAIL — ${fails.join(" | ")}`); process.exit(1) }
  console.log("✅ WAVE155_UNCALLED_PLATFORM_DOORS_PASS — every retired door names a called survivor; every added gate refuses")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
