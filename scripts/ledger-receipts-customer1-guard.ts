#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-customer1-guard.ts   (npm run test:ledger-receipts-customer1)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 155, lane 155R12 — G12 list "customer1" (buyer execution, collaborative search, chat, listing media, photos,
 * seller decisions, buyer agreements …): every user-initiated write on the list leaves ONE receipt on
 * agent_action_ledger through THE helper, lib/kernel/action-ledger.ts ledgerSessionAction — who (the session user),
 * which tenant (the session's), what (a three-segment action), on what (the subject row), under which risk class.
 *
 * STATIC (stripped source, scripts/strip-comments.ts):
 *   · every export on the row list reaches the helper (directly, or through its module's withReceipt shim, whose own
 *     body calls ledgerSessionAction); two thin wrappers reach it through the canonical export they delegate to;
 *   · every receipt's action is three lowercase segments, its riskClass is in ToolRiskClass, and NO receipt passes
 *     `cycle` / `idempotencyKey` (a key would turn a person's second save into a silent no-op); no receipt takes its
 *     tenant from an argument (params./input./data.);
 *   · the eight rows left OPEN carry their evidence (read-only bodies; anonymous public analytics).
 *   Each absence check has a POSITIVE CONTROL (CLAUDE.md §2).
 * DRIVEN (SIMULATED — in-memory client, scripts/in-memory-supabase.ts): one export per receipted module (26) runs with
 *   the session and its heavy collaborators stubbed at the module boundary; the receipt path itself (the export, its
 *   shim, ledgerSessionAction, withActionLedger) is the real code:
 *     one call → exactly one receipt (actor, tenant, action, subject, risk class), settled executed;
 *     a refused write → the receipt settles failed;
 *     two calls → TWO receipts and the write ran twice (the no-key rule — the regression canary).
 * Red at e88c1baa: no export on the list reached the helper.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire, register } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type MemOptions, type Row } from "./in-memory-supabase"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const src = (p: string) => stripComments(raw(p))

// ─── THE ROW LIST (103 rows, $S/b2/g12/customer1-rows.json) ─────────────────────────────────────────────────────
const A = "app/actions/"
const WRAPPED: Record<string, string[]> = {
  [`${A}buyer-broker-agreements.ts`]: ["cancelBBAAction", "clickThroughSignBBAAction", "createBBADraftAction", "recordSignedBBAAction"],
  [`${A}buyer-execution.ts`]: ["adminOverrideFinancialVerification", "agentAdvanceBuyer", "agentConfigureBuyerSearch", "checkBuyerCanPerformAction", "handleBuyerVoiceAssistant", "lenderConfirmBuyerFinancials"],
  [`${A}property-alerts/alert-actions.ts`]: ["buyerAdjustAlert", "deletePropertyAlert", "markResultViewed", "pausePropertyAlert", "previewAlertCriteria"],
  [`${A}acquisition-plan.ts`]: ["proposeAcquisitionPlan"],
  [`${A}investor-buybox-preview.ts`]: ["getInvestorBuyboxPreviewForListing"],
  [`${A}collaborative-search.ts`]: ["addPropertyToSearch", "closeCollaborativeSearch", "createCollaborativeSearch", "markAsFinalist", "rateProperty", "removeMember", "removePropertyFromSearch", "trackPortalActivity", "updateSearchCriteria"],
  [`${A}ai-chat.ts`]: ["acceptAiSuggestion", "applyChatTemplate", "createChatSession", "grantMessageAccess", "revokeMessageAccess", "sendChatMessage", "updateAgentChatPreferences"],
  [`${A}listing-media.ts`]: ["approveListingMedia", "approveSocialPost", "deleteListingMedia", "deleteSocialPost", "deleteVideoProject", "rejectListingMedia", "setPrimaryMedia"],
  [`${A}photo-management.ts`]: ["optimizePhotoOrder", "savePhotoOrderingRule"],
  [`${A}seller-decision-governance.ts`]: ["logCMAQuality", "logNetSheetActivity", "logPresentationActivity", "logSellerDecisionReversal", "logSellerDecisionTransition", "validateListingNetSheetValidity"],
  [`${A}marketing-package-automation.ts`]: ["activateMarketingPackage", "bookMarketingService", "completeMarketingService", "generateListingOptimizations", "recordMarketingServiceQuote"],
  [`${A}open-house-kernel.ts`]: ["createOpenHouseAttendeeFromContactAction", "generateOpenHouseFollowupNextActionAction", "notifyAssignedAgentForOpenHouseLeadAction", "resolveAutopilotActionStatus"],
  ["app/dashboard/sphere/actions.ts"]: ["approveSphereTouch", "dismissSphereTouch", "updateSphereMessage"],
  [`${A}ai-cma.ts`]: ["generateAICMA", "getAIPriceAdjustmentRecommendation", "updateCMAReport"],
  [`${A}buyer-move.ts`]: ["ensureBuyerMoveCaseAction", "setServiceModeAction", "updateMoveTaskAction"],
  [`${A}cma-presentation/net-sheet-calculator.ts`]: ["generateNetSheet", "saveNetSheetEmailDraft", "shareNetSheetToPortal"],
  [`${A}idx-search.ts`]: ["saveProperty", "trackPropertyView", "unsaveProperty"],
  [`${A}intent-writers.ts`]: ["assignVendorToContact", "logPropertyUpgrade", "setPortalMilestonePreferences"],
  [`${A}predictive-listing.ts`]: ["cancelQueuedAutoTouch", "dismissPredictiveSeller", "markPredictiveAction"],
  [`${A}settings/listing-task-templates.ts`]: ["createListingTaskTemplate", "deleteListingTaskTemplate", "updateListingTaskTemplate"],
  [`${A}showings.ts`]: ["cancelShowing", "createShowing", "requestShowing"],
  [`${A}smart-insights.ts`]: ["unsaveProperty"],
  [`${A}ai-reply-coach.ts`]: ["generateAIReplyDraft", "recordDraftSent"],
  [`${A}brokerage-intelligence.ts`]: ["adoptInsightAction", "dismissInsightAction"],
  [`${A}buyer-fatigue.ts`]: ["dismissFatigueAlert", "getReinvigorationSuggestions"],
  [`${A}contacts/accessibility-preferences.ts`]: ["saveContactAccessibilityPreferences", "saveMyAccessibilityPreferences"],
}
/** Thin wrappers that delegate to a canonical export which carries the receipt — a second receipt would double-record. */
const DELEGATED: Array<{ file: string; fn: string; to: string; toFile: string; importSpec: string }> = [
  { file: `${A}smart-insights.ts`, fn: "requestShowing", to: "requestShowing", toFile: `${A}showings.ts`, importSpec: "./showings" },
  { file: `${A}smart-insights.ts`, fn: "saveProperty", to: "saveProperty", toFile: `${A}idx-search.ts`, importSpec: "./idx-search" },
]
/** Left OPEN with evidence (re-classification is the integrator's call). */
const OPEN_READS: Array<{ file: string; fn: string }> = [
  { file: `${A}listing-lifecycle-core.ts`, fn: "validateListingTransition" },
  { file: `${A}photo-management.ts`, fn: "getListingPhotoSet" }, { file: `${A}photo-management.ts`, fn: "getPhotoEnhancementHistory" },
  { file: `${A}photo-management.ts`, fn: "validatePhotoQuality" }, { file: `${A}photo-management.ts`, fn: "getPhotoPerformanceStats" },
  { file: "app/dashboard/sphere/actions.ts", fn: "loadSphereResonance" },
]
const OPEN_ANON: Array<{ file: string; fn: string }> = [{ file: `${A}listing-landing.ts`, fn: "logLandingSession" }, { file: `${A}listing-landing.ts`, fn: "trackCtaClick" }]
const rowCount = Object.values(WRAPPED).reduce((s, l) => s + l.length, 0) + DELEGATED.length + OPEN_READS.length + OPEN_ANON.length

/** The body of `export async function <fn>(` up to the next top-level export (stripped source). */
function bodyOf(text: string, fn: string): string {
  const at = text.search(new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`))
  if (at < 0) return ""
  const next = text.slice(at + 1).search(/\nexport\s/)
  return next < 0 ? text.slice(at) : text.slice(at, at + 1 + next)
}
/** The first argument of every `<token>(` call — a balanced scan, strings skipped. */
function firstArgs(text: string, token: string): string[] {
  const out: string[] = []
  const re = new RegExp(`\\b${token}\\s*(?:<[^>(]*>)?\\(`, "g")
  for (const m of text.matchAll(re)) {
    let i = m.index! + m[0].length, depth = 0, q: string | null = null
    const start = i
    for (; i < text.length; i++) {
      const c = text[i]
      if (q) { if (c === "\\") { i++; continue } if (c === q) q = null; continue }
      if (c === '"' || c === "'" || c === "`") { q = c; continue }
      if (c === "(" || c === "{" || c === "[") depth++
      else if (c === ")" || c === "}" || c === "]") { if (depth === 0) break; depth-- }
      else if (c === "," && depth === 0) break
    }
    out.push(text.slice(start, i))
  }
  return out
}
const ACTION_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const RISK = new Set((src("lib/ai-isa/persona-tool-policy.ts").match(/export type ToolRiskClass\s*=([^\n]*)/)?.[1] ?? "").match(/"([A-Z_]+)"/g)?.map((s) => s.slice(1, -1)) ?? [])
const KEY_RE = /\b(?:cycle|idempotencyKey)\s*:/
const ARG_TENANT_RE = /brokerageId\s*:\s*(?:params|input|data|args)\./
const DOOR_RE = /\b(?:withReceipt|ledgerSessionAction)\s*\(/

function staticLayer() {
  console.log(`\n[static — ${rowCount} rows on the list: ${rowCount - DELEGATED.length - OPEN_READS.length - OPEN_ANON.length} receipted here, ${DELEGATED.length} through their canonical export, ${OPEN_READS.length + OPEN_ANON.length} open with evidence]`)
  check("the list is the 103 rows handed to this lane", rowCount === 103)
  check(`positive controls: the action pattern refuses a two-segment name; RISK read ${RISK.size} classes from ToolRiskClass; the key / argument-tenant finders see their specimens`,
    !ACTION_RE.test("commission.update") && ACTION_RE.test("buyer.property_alert.pause") && RISK.size === 6 && RISK.has("LEGAL") &&
      KEY_RE.test(`{ action: "a.b.c", cycle: "x" }`) && ARG_TENANT_RE.test(`{ brokerageId: params.brokerageId }`) && !ARG_TENANT_RE.test(`{ brokerageId: ctx.brokerageId }`) &&
      firstArgs(`withReceipt({ a: f(1, 2), b: "x,y" }, () => 1)`, "withReceipt")[0] === `{ a: f(1, 2), b: "x,y" }`)
  const missing: string[] = [], badNames: string[] = [], badRisk: string[] = [], keyed: string[] = [], argTenant: string[] = [], badShim: string[] = []
  let receipts = 0
  for (const [file, fns] of Object.entries(WRAPPED)) {
    const s = src(file)
    for (const fn of fns) if (!DOOR_RE.test(bodyOf(s, fn))) missing.push(`${file}#${fn}`)
    const shim = s.match(/async function withReceipt[\s\S]*?\n}\n/)?.[0]
    if (/\bwithReceipt\s*\(/.test(s.replace(/async function withReceipt/, "")) && !(shim && /\bledgerSessionAction\s*\(/.test(shim) && !KEY_RE.test(shim) && /reasonCode:\s*"HUMAN_REQUESTED"/.test(shim))) badShim.push(file)
    for (const arg of [...firstArgs(s, "withReceipt"), ...firstArgs(s, "ledgerSessionAction")]) {
      if (/^\s*rc\b|^\s*ctx\b|^\s*call\b/.test(arg) || /\baction:\s*rc\.action\b/.test(arg)) continue // the shim's own definition / pass-through call
      receipts++
      const action = arg.match(/\baction:\s*"([^"]+)"/)?.[1]
      const risk = arg.match(/\briskClass:\s*"([^"]+)"/)?.[1]
      if (!action || !ACTION_RE.test(action)) badNames.push(`${file}: ${action ?? "(none)"}`)
      if (!risk || !RISK.has(risk)) badRisk.push(`${file}: ${risk ?? "(none)"}`)
      if (KEY_RE.test(arg)) keyed.push(`${file}: ${action}`)
      // buyer-move: authAndScope OVERWRITES params.brokerageId with the session tenant before any receipt (asserted below).
      if (ARG_TENANT_RE.test(arg) && !(file.endsWith("buyer-move.ts") && /brokerageId:\s*params\.brokerageId\b/.test(arg))) argTenant.push(`${file}: ${action}`)
    }
  }
  check(`every receipted export on the list reaches the helper (${missing.length} missing${missing.length ? ": " + missing.join(", ") : ""})`, missing.length === 0)
  check(`every module's withReceipt shim calls ledgerSessionAction, with reasonCode HUMAN_REQUESTED and no key (${badShim.join(", ") || "all"})`, badShim.length === 0)
  check(`${receipts} receipt sites: every action is three lowercase segments (${badNames.join("; ") || "ok"})`, receipts >= 88 && badNames.length === 0)
  check(`every riskClass is in ToolRiskClass (${badRisk.join("; ") || "ok"})`, badRisk.length === 0)
  check(`NO receipt passes cycle / idempotencyKey — a person's second save must run (${keyed.join("; ") || "none keyed"})`, keyed.length === 0)
  check(`no receipt takes its tenant from an argument (${argTenant.join("; ") || "none"}); buyer-move's params.brokerageId is the session's (authAndScope overwrites it)`,
    argTenant.length === 0 && /params\.brokerageId\s*=\s*caller\.brokerageId/.test(src(`${A}buyer-move.ts`)))
  for (const d of DELEGATED) {
    const b = bodyOf(src(d.file), d.fn)
    check(`${d.file}#${d.fn} delegates to ${d.toFile}#${d.to}, which carries the receipt (no second receipt here)`,
      b.includes(`import("${d.importSpec}")`) && !DOOR_RE.test(b) && DOOR_RE.test(bodyOf(src(d.toFile), d.to)))
  }
  const WRITE = /\.(?:insert|update|upsert|delete)\s*\(/
  check("positive control: the write finder sees optimizePhotoOrder's reorder write", WRITE.test(bodyOf(src(`${A}photo-management.ts`), "optimizePhotoOrder")))
  for (const r of OPEN_READS) check(`OPEN (read-only — the analyzer attributes an imported module's writes to it): ${r.file}#${r.fn} writes nothing in its own body`, bodyOf(src(r.file), r.fn).length > 0 && !WRITE.test(bodyOf(src(r.file), r.fn)) && !DOOR_RE.test(bodyOf(src(r.file), r.fn)))
  for (const r of OPEN_ANON) check(`OPEN (anonymous public analytics — no session user to name as actor): ${r.file}#${r.fn} reads no session`, bodyOf(src(r.file), r.fn).length > 0 && !/auth\.getUser|getAgentContext|requireCaller|requireContactAccess/.test(bodyOf(src(r.file), r.fn)))
}

// ─── DRIVEN — module-boundary stubs (the next-headers-shim / seat-proof idiom: CJS Module._load + an ESM hook) ───
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const UID = U(1), BRK = U(2), AG = U(3), OTHER_BRK = U(4)
const G = globalThis as any
let MEM: MemClient
const calls: Record<string, number> = {}
let delegateFail = false
const delegate = (name: string, ok: unknown) => async (..._a: unknown[]) => {
  calls[name] = (calls[name] ?? 0) + 1
  return delegateFail ? { success: false, ok: false, error: `${name} refused (simulated)` } : ok
}
const session = { contactSelf: false }
const agentCtx = async () => ({ isAuthenticated: true, userId: UID, agentId: AG, brokerageId: BRK, teamId: null, userType: "agent" })
const caller = async () => ({ ok: true, userId: UID, brokerageId: BRK, agentId: AG, userType: "broker", supabase: MEM })
const OVERRIDE: Record<string, Record<string, unknown>> = {
  "@/lib/supabase/service": { createServiceClient: () => MEM },
  "@/lib/supabase/server": { createClient: async () => MEM },
  "next/cache": { revalidatePath: () => undefined, revalidateTag: () => undefined },
  "next/headers": { headers: async () => new Map(), cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }) },
  "server-only": {},
  "@/lib/identity": { getAgentContext: agentCtx },
  "@/lib/identity/get-agent-context": { getAgentContext: agentCtx },
  "@/lib/portal/require-contact-access": {
    requireContactAccess: async (cid: string) => ({ ok: true, userId: UID, brokerageId: BRK, isContactSelf: session.contactSelf, userType: "agent", contactId: cid }),
    accessRefusal: (e: string) => e,
  },
  "@/lib/auth/require-caller": { requireCallerTenant: caller, requireCaller: caller, requireTenantAdminOrSoloOwner: caller },
  "@/lib/auth/require-brokerage-admin": { requireBrokerageAdmin: async () => ({ brokerageId: BRK, userType: "admin" }) },
  "@/lib/platform/acting-context": {
    resolveWriteContext: async () => ({ ok: true, userId: UID, agentId: AG, brokerageId: BRK, userType: "broker", isImpersonating: false, impersonatorUserId: null, actorUserId: UID, db: MEM }),
    resolveActingContext: async () => ({ ok: true, userId: UID, agentId: AG, brokerageId: BRK, actorUserId: UID, db: MEM }),
    // the REAL rule, not a stub that always agrees (a permissive copy made this guard's own negative control pass for the wrong reason)
    decideClaimedTenant: (i: { actingBrokerageId?: string | null; claimedBrokerageId?: string | null }) => !i.actingBrokerageId ? { ok: false, reason: "no_session_tenant" } : i.claimedBrokerageId && i.claimedBrokerageId !== i.actingBrokerageId ? { ok: false, reason: "tenant_mismatch" } : { ok: true, brokerageId: i.actingBrokerageId },
  },
  "@/lib/auth/contact-access": { assertCanActOnContact: async (cid: string) => ({ ok: true, actorUserId: UID, contact: { id: cid, brokerage_id: BRK } }) },
  "@/lib/kernel/agent-identity-resolver": { resolveUserIdToAgentRecord: async () => AG },
  "@/lib/buyer-execution/multi-party-updates": { agentAssistSearchConfiguration: delegate("agentAssistSearchConfiguration", { success: true }) },
  "@/lib/contacts/accessibility-preferences": { writeAccessibilityPreferences: delegate("writeAccessibilityPreferences", { ok: true, preferences: {}, changed: [] }) },
  "@/lib/seller-decision-governance/decision-logger": { logNetSheetEvent: delegate("logNetSheetEvent", { ok: true }) },
  "@/lib/transactions/buyer-move": { updateMoveTask: delegate("updateMoveTask", { ok: true, case: null }) },
  "@/lib/external/batchdata-mcp": { investorBuyboxPreview: delegate("investorBuyboxPreview", { ok: true, rows: [{}, {}] }) },
  "@/lib/ai-isa/property-lookup-rail": { resolveBatchDataAccess: async () => ({ allowed: true }) },
  "@/lib/vendor-governance/usage-logger": { logVendorUsage: async () => null },
  "@/lib/buyer-execution/showing-financial-policy": { guardShowingFinancialGate: async () => ({ blocked: false }) },
  "@/lib/lead-pipeline/source-intent-map": { resolveSourceKey: (s: string) => s, SOURCE_MAP: {}, SOURCE_VENDOR: {}, expandEnabledSources: () => [] },
  "@/lib/lead-pipeline/source-discovery-planner": {
    planSourceDiscovery: (i: { budgetUsd: number }) => ({ budgetUsd: i.budgetUsd, totalQuoteUsd: 0, marketMode: "unknown", tilt: null, lines: [], blindSpots: [], plannerVersion: "sim" }),
    previewsFromObservedSearchCounts: () => ({ previews: {}, stale: 0, used: 0, distressPreviewCount: null }),
  },
  "@/lib/market-reports/market-twin": { loadMarketTwin: async () => ({ marketGap: { monthsOfSupply: null, asOf: null, source: null } }) },
}
/** Real on purpose: the receipt path and a few light pure modules. Everything else an action imports is stubbed. */
const REAL = new Set(["@/lib/kernel/action-ledger", "@/lib/validations", "@/lib/kernel/events", "@/lib/db/best-effort", "@/lib/auth/resolve-user-role"])
const MODULES = Object.keys(WRAPPED)
const IMPORTS: Record<string, Set<string>> = {}
const add = (spec: string, names: string[]) => { const s = (IMPORTS[spec] ??= new Set()); for (const n of names) if (n) s.add(n) }
const namesOf = (list: string) => list.split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => x.split(/\s+as\s+|\s*:\s*/)[0].trim())
for (const f of MODULES) {
  const s = src(f)
  for (const m of s.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) if (!/^import\s+type/.test(m[0])) add(m[2], namesOf(m[1]))
  for (const m of s.matchAll(/const\s+\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) add(m[2], namesOf(m[1]))
  for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], [])
}
for (const [spec, impl] of Object.entries(OVERRIDE)) add(spec, Object.keys(impl))
/** A stubbed module may also be imported by a REAL module (resolve-user-role, the ledger's own deps) for other names: the ESM
 *  stub exports every name the real file exports, so a named import never fails at link time. */
for (const spec of Object.keys(IMPORTS)) {
  if (!spec.startsWith("@/")) continue
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    let text: string
    try { text = src(spec.slice(2) + ext) } catch { continue }
    add(spec, [...text.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) if (!/^export\s*type/.test(m[0])) add(spec, m[1].split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => (x.split(/\s+as\s+/)[1] ?? x).trim()))
    break
  }
}
const UNDER_TEST = new Set(MODULES.map((f) => "@/" + f.replace(/\.tsx?$/, "")))
const STUBBED = Object.keys(IMPORTS).filter((spec) => !REAL.has(spec) && !UNDER_TEST.has(spec) && !spec.startsWith(".") && !spec.startsWith("node:") && (spec.startsWith("@/") || spec.startsWith("next/") || spec === "server-only"))
G.__R12__ = {}
for (const spec of STUBBED) {
  const impl: Record<string, unknown> = {}
  for (const n of IMPORTS[spec]) impl[n] = /^[A-Z][A-Z0-9_]+$/.test(n) ? {} : (..._a: unknown[]) => ({ success: true, ok: true })
  G.__R12__[spec] = Object.assign(impl, OVERRIDE[spec] ?? {})
}
const SUFFIXES = (spec: string) => [".ts", ".tsx", "/index.ts", "/index.tsx"].map((x) => `/${spec.slice(2)}${x}`)
const pathKey = (p: string) => { const q = String(p).replace(/\\/g, "/"); return STUBBED.find((spec) => spec.startsWith("@/") && SUFFIXES(spec).some((x) => q.endsWith(x))) }
{
  const nodeModule: any = createRequire(import.meta.url)("node:module")
  const realLoad = nodeModule._load
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    const key = G.__R12__[request] ? request : pathKey(request)
    if (key) return G.__R12__[key]
    return realLoad.call(this, request, ...rest)
  }
  const srcFor: Record<string, string> = {}
  for (const spec of STUBBED) srcFor[spec] = `const S = globalThis.__R12__[${JSON.stringify(spec)}];\n` +
    [...IMPORTS[spec]].filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n)).map((n) => `export const ${n} = typeof S[${JSON.stringify(n)}] === "function" ? (...a) => S[${JSON.stringify(n)}](...a) : S[${JSON.stringify(n)}];`).join("\n")
  const loader = `
const SRC = ${JSON.stringify(srcFor)};
const KEYS = Object.keys(SRC);
const byPath = (u) => KEYS.find((k) => k.startsWith("@/") && [".ts", ".tsx", "/index.ts", "/index.tsx"].some((x) => u.endsWith("/" + k.slice(2) + x)));
export async function resolve(specifier, context, next) {
  if (SRC[specifier] !== undefined) return { shortCircuit: true, url: "r12stub:" + encodeURIComponent(specifier) };
  const r = await next(specifier, context);
  const k = byPath(r.url ?? "");
  return k ? { shortCircuit: true, url: "r12stub:" + encodeURIComponent(k) } : r;
}
export async function load(url, context, next) {
  if (url.startsWith("r12stub:")) return { shortCircuit: true, format: "module", source: SRC[decodeURIComponent(url.slice(8))] };
  return next(url, context);
}`
  try { register(`data:text/javascript,${encodeURIComponent(loader)}`) } catch { /* hooks unavailable — the CJS patch above still holds */ }
}

const withAuth = (m: MemClient): MemClient => Object.assign(m, { auth: { getUser: async () => ({ data: { user: { id: UID, email: "agent@b.test" } }, error: null }) } }) as MemClient
const ledger = () => (MEM.tables.agent_action_ledger ?? []) as Row[]

interface Case {
  file: string; fn: string; args: () => unknown[]
  seed: () => Record<string, Row[]>; failOpts?: MemOptions; failByDelegate?: boolean
  action: string; subject: [string, string]; risk: string
  ran: () => number
}
const writesTo = (t: string) => () => MEM.writes.filter((w) => w.table === t).length
const insertsTo = (t: string) => () => MEM.writes.filter((w) => w.table === t && w.op === "insert").length
const called = (n: string) => () => calls[n] ?? 0
const C = U(10), L = U(11), X = U(12), AL = U(13), T = U(14), M = U(15), PA = U(16), SV = U(17), AA = U(18), CM = U(19), TX = U(20), TT = U(21), D = U(22), I = U(23), FA = U(24), SP = U(25)
const CASES: Case[] = [
  { file: `${A}buyer-broker-agreements.ts`, fn: "cancelBBAAction", args: () => [{ agreementId: X, reason: "The buyer chose another brokerage." }],
    seed: () => ({ users: [{ id: UID, user_type: "agent", brokerage_id: BRK }], agents: [{ id: AG, user_id: UID, brokerage_id: BRK }], buyer_broker_agreements: [{ id: X, brokerage_id: BRK, status: "draft" }] }),
    failOpts: { refuse: { buyer_broker_agreements: "denied (simulated)" } }, action: "transaction.buyer_agreement.cancel", subject: ["buyer_broker_agreement", X], risk: "LEGAL", ran: writesTo("buyer_broker_agreements") },
  { file: `${A}buyer-execution.ts`, fn: "agentConfigureBuyerSearch", args: () => [{ contactId: C, searchPreferences: { maxPrice: 500000 } }], seed: () => ({}),
    failByDelegate: true, action: "buyer.search_criteria.configure", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: called("agentAssistSearchConfiguration") },
  { file: `${A}property-alerts/alert-actions.ts`, fn: "pausePropertyAlert", args: () => [AL],
    seed: () => ({ property_alerts: [{ id: AL, contact_id: C, brokerage_id: BRK, agent_user_id: UID }], users: [{ id: UID, brokerage_id: BRK }] }),
    failOpts: { missingColumns: { property_alerts: ["paused_by"] } }, action: "buyer.property_alert.pause", subject: ["property_alert", AL], risk: "LOW_RISK_WRITE", ran: writesTo("property_alerts") },
  { file: `${A}acquisition-plan.ts`, fn: "proposeAcquisitionPlan", args: () => [{ territoryId: T, budgetUsd: 250 }],
    seed: () => ({ lead_scraping_markets: [{ id: T, brokerage_id: BRK, name: "North", city: "Pace", state: "FL", enabled_sources: [], zip_codes: [] }], raw_scraped_leads: [], batchdata_incremental_search_state: [], acquisition_plans: [] }),
    failOpts: { refuse: { acquisition_plans: "denied (simulated)" } }, action: "acquisition.plan.propose", subject: ["lead_scraping_market", T], risk: "LOW_RISK_WRITE", ran: writesTo("acquisition_plans") },
  { file: `${A}investor-buybox-preview.ts`, fn: "getInvestorBuyboxPreviewForListing", args: () => [{ listingId: L }],
    seed: () => ({ listings: [{ id: L, brokerage_id: BRK, address: "1 Main", city: "Pace", state: "FL", zip: "32571" }] }),
    failByDelegate: true, action: "listing.investor_buybox.preview", subject: ["listing", L], risk: "READ", ran: called("investorBuyboxPreview") },
  { file: `${A}collaborative-search.ts`, fn: "createCollaborativeSearch", args: () => [C, "Our short list"],
    seed: () => ({ contacts: [{ id: C, brokerage_id: BRK, email: "buyer@b.test", first_name: "Bea", last_name: "B" }], collaborative_searches: [], collaborative_search_members: [] }),
    failOpts: { refuse: { collaborative_searches: "denied (simulated)" } }, action: "buyer.collaborative_search.create", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: writesTo("collaborative_searches") },
  { file: `${A}ai-chat.ts`, fn: "updateAgentChatPreferences", args: () => [AG, {}],
    seed: () => ({ agents: [{ id: AG, brokerage_id: BRK, user_id: UID }], agent_chat_preferences: [] }),
    failOpts: { refuse: { agent_chat_preferences: "denied (simulated)" } }, action: "ai_chat.preferences.update", subject: ["agent", AG], risk: "LOW_RISK_WRITE", ran: writesTo("agent_chat_preferences") },
  { file: `${A}listing-media.ts`, fn: "deleteListingMedia", args: () => [M], seed: () => ({ listing_media: [{ id: M }] }),
    failOpts: { refuse: { listing_media: "denied (simulated)" } }, action: "listing.media.delete", subject: ["listing_media", M], risk: "LOW_RISK_WRITE", ran: writesTo("listing_media") },
  { file: `${A}photo-management.ts`, fn: "savePhotoOrderingRule", args: () => [{ ruleName: "Kitchen first", roomSequence: ["kitchen"], prioritizeHighQuality: true }],
    seed: () => ({ users: [{ id: UID, brokerage_id: BRK }], photo_ordering_rules: [] }),
    failOpts: { refuse: { photo_ordering_rules: "denied (simulated)" } }, action: "listing.photo_ordering_rule.save", subject: ["agent", AG], risk: "LOW_RISK_WRITE", ran: insertsTo("photo_ordering_rules") },
  { file: `${A}seller-decision-governance.ts`, fn: "logNetSheetActivity", args: () => [{ listing_id: L, event_type: "generated" }],
    seed: () => ({ users: [{ id: UID, user_type: "agent", brokerage_id: BRK }] }),
    failByDelegate: true, action: "seller.net_sheet.log_event", subject: ["listing", L], risk: "LOW_RISK_WRITE", ran: called("logNetSheetEvent") },
  { file: `${A}marketing-package-automation.ts`, fn: "recordMarketingServiceQuote", args: () => [{ serviceId: SV, quotedCost: 450 }],
    seed: () => ({ listing_marketing_services: [{ id: SV, brokerage_id: BRK, completed_at: null }] }),
    failOpts: { refuse: { listing_marketing_services: "denied (simulated)" } }, action: "marketing.listing_service.record_quote", subject: ["listing_marketing_service", SV], risk: "FINANCIAL", ran: writesTo("listing_marketing_services") },
  { file: `${A}open-house-kernel.ts`, fn: "resolveAutopilotActionStatus", args: () => [{ actionId: AA, outcome: "skipped" }],
    seed: () => ({ ai_autopilot_actions: [{ id: AA, brokerage_id: BRK, agent_id: AG, status: "pending" }] }),
    failOpts: { refuse: { ai_autopilot_actions: "denied (simulated)" } }, action: "open_house.autopilot_action.resolve", subject: ["ai_autopilot_action", AA], risk: "LOW_RISK_WRITE", ran: writesTo("ai_autopilot_actions") },
  { file: "app/dashboard/sphere/actions.ts", fn: "dismissSphereTouch", args: () => [PA, "not now"],
    seed: () => ({ agents: [{ id: AG, user_id: UID, brokerage_id: BRK }], predictive_listing_actions: [{ id: PA, agent_id: AG }] }),
    failOpts: { refuse: { predictive_listing_actions: "denied (simulated)" } }, action: "sphere.touch.dismiss", subject: ["predictive_listing_action", PA], risk: "LOW_RISK_WRITE", ran: writesTo("predictive_listing_actions") },
  { file: `${A}ai-cma.ts`, fn: "updateCMAReport", args: () => [CM, { status: "final" }], seed: () => ({ cma_reports: [{ id: CM, brokerage_id: BRK }] }),
    failOpts: { refuse: { cma_reports: "denied (simulated)" } }, action: "listing.cma_report.update", subject: ["cma_report", CM], risk: "LOW_RISK_WRITE", ran: writesTo("cma_reports") },
  { file: `${A}buyer-move.ts`, fn: "updateMoveTaskAction", args: () => [{ transactionId: TX, brokerageId: BRK, taskType: "utilities", status: "done" }],
    seed: () => ({ transactions: [{ id: TX, brokerage_id: BRK }] }),
    failByDelegate: true, action: "transaction.buyer_move_task.update", subject: ["transaction", TX], risk: "LOW_RISK_WRITE", ran: called("updateMoveTask") },
  { file: `${A}cma-presentation/net-sheet-calculator.ts`, fn: "saveNetSheetEmailDraft", args: () => [{ contactId: C, listingId: L, draftBody: "Your net, explained." }],
    seed: () => ({ users: [{ id: UID, brokerage_id: BRK }], ai_message_drafts: [] }),
    failOpts: { refuse: { ai_message_drafts: "denied (simulated)" } }, action: "seller.net_sheet.save_email_draft", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: writesTo("ai_message_drafts") },
  { file: `${A}idx-search.ts`, fn: "unsaveProperty", args: () => [{ contactId: C, mlsNumber: "MLS-1" }],
    seed: () => ({ saved_properties: [{ id: SP, contact_id: C, mls_number: "MLS-1" }] }),
    failOpts: { refuse: { saved_properties: "denied (simulated)" } }, action: "buyer.saved_property.unsave", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: writesTo("saved_properties") },
  { file: `${A}intent-writers.ts`, fn: "setPortalMilestonePreferences", args: () => [{ contactId: C, milestoneOverrides: { inspection: false } }],
    seed: () => ({ contacts: [{ id: C, brokerage_id: BRK }], contact_portal_preferences: [] }),
    failOpts: { refuse: { contact_portal_preferences: "denied (simulated)" } }, action: "contact.portal_milestones.set", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: writesTo("contact_portal_preferences") },
  { file: `${A}predictive-listing.ts`, fn: "cancelQueuedAutoTouch", args: () => [{ actionId: PA, brokerageId: BRK, userId: UID }],
    seed: () => ({ predictive_listing_actions: [{ id: PA, brokerage_id: BRK, status: "pending_review" }] }),
    failOpts: { refuse: { predictive_listing_actions: "denied (simulated)" } }, action: "predictive.auto_touch.cancel", subject: ["predictive_listing_action", PA], risk: "LOW_RISK_WRITE", ran: writesTo("predictive_listing_actions") },
  { file: `${A}settings/listing-task-templates.ts`, fn: "deleteListingTaskTemplate", args: () => [TT], seed: () => ({ listing_task_templates: [{ id: TT, brokerage_id: BRK }] }),
    failOpts: { refuse: { listing_task_templates: "denied (simulated)" } }, action: "listing.task_template.delete", subject: ["listing_task_template", TT], risk: "LOW_RISK_WRITE", ran: writesTo("listing_task_templates") },
  { file: `${A}showings.ts`, fn: "createShowing", args: () => [{ contactId: C, propertyId: L, propertyAddress: "1 Main", scheduledDate: "2099-01-01", scheduledTime: "10:00", agentId: AG }],
    seed: () => ({ contacts: [{ id: C, brokerage_id: BRK }], showing_requests: [] }),
    failOpts: { refuse: { showing_requests: "denied (simulated)" } }, action: "buyer.showing.create", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: writesTo("showing_requests") },
  { file: `${A}smart-insights.ts`, fn: "unsaveProperty", args: () => [C, SP], seed: () => ({ saved_properties: [{ id: SP, contact_id: C }] }),
    failOpts: { refuse: { saved_properties: "denied (simulated)" } }, action: "buyer.saved_property.unsave", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: writesTo("saved_properties") },
  { file: `${A}ai-reply-coach.ts`, fn: "recordDraftSent", args: () => [{ draftId: D, messageId: U(30) }], seed: () => ({ ai_message_drafts: [{ id: D, brokerage_id: BRK, status: "accepted" }] }),
    failOpts: { refuse: { ai_message_drafts: "denied (simulated)" } }, action: "ai_reply.draft.record_sent", subject: ["ai_message_draft", D], risk: "LOW_RISK_WRITE", ran: writesTo("ai_message_drafts") },
  { file: `${A}brokerage-intelligence.ts`, fn: "dismissInsightAction", args: () => [{ insightId: I }],
    seed: () => ({ users: [{ id: UID, user_type: "admin", brokerage_id: BRK }], brokerage_intelligence_insights: [{ id: I, brokerage_id: BRK }] }),
    failOpts: { refuse: { brokerage_intelligence_insights: "denied (simulated)" } }, action: "brokerage_intelligence.insight.dismiss", subject: ["brokerage_intelligence_insight", I], risk: "LOW_RISK_WRITE", ran: writesTo("brokerage_intelligence_insights") },
  { file: `${A}buyer-fatigue.ts`, fn: "dismissFatigueAlert", args: () => [FA],
    seed: () => ({ fatigue_alerts: [{ id: FA, brokerage_id: BRK, contact_id: C }], contacts: [{ id: C, brokerage_id: BRK, agent_id: AG, deleted_at: null }], users: [{ id: UID, user_type: "broker", brokerage_id: BRK }] }),
    failOpts: { missingColumns: { fatigue_alerts: ["dismissed_by"] } }, action: "buyer.fatigue_alert.dismiss", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: writesTo("fatigue_alerts") },
  { file: `${A}contacts/accessibility-preferences.ts`, fn: "saveContactAccessibilityPreferences", args: () => [{ contactId: C, preferences: {}, contactRequested: true }], seed: () => ({}),
    failByDelegate: true, action: "contact.accessibility_preferences.save", subject: ["contact", C], risk: "LOW_RISK_WRITE", ran: called("writeAccessibilityPreferences") },
]

async function drive(c: Case, opts: MemOptions = {}) {
  MEM = withAuth(memSupabase(c.seed(), { uuidIds: true, ...opts }))
  const mod = await import(join(process.cwd(), c.file)) as Record<string, (...a: unknown[]) => Promise<unknown>>
  if (typeof mod[c.fn] !== "function") throw new Error(`${c.file} exports no function ${c.fn} (got ${typeof mod[c.fn]})`)
  return (...a: unknown[]) => Promise.resolve().then(() => mod[c.fn](...a)).catch((e: unknown) => ({ threw: e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e) }))
}

async function drivenLayer() {
  console.log(`\n[driven — ${CASES.length} modules, one export each, in-memory client (SIMULATED)]`)
  check(`every receipted module is driven (${CASES.length} of ${MODULES.length})`, new Set(CASES.map((c) => c.file)).size === MODULES.length)
  for (const c of CASES) {
    const tag = `${c.file.replace(A, "")}#${c.fn}`
    try {
      delegateFail = false; for (const k of Object.keys(calls)) delete calls[k]
      let run = await drive(c)
      const out1 = await run(...c.args())
      const rows = ledger()
      const r = rows[0] ?? {}
      check(`${tag}: one call → exactly one receipt naming actor, tenant, ${c.action}, ${c.subject[0]} and ${c.risk}, settled executed`,
        rows.length === 1 && c.ran() === 1 && r.action === c.action && r.brokerage_id === BRK && r.actor_type === "user" && r.actor_user_id === UID &&
          r.subject_type === c.subject[0] && r.subject_id === c.subject[1] && r.risk_class === c.risk && r.reason_code === "HUMAN_REQUESTED" && r.status === "executed")
      if (!(rows.length === 1 && r.status === "executed")) console.log("     ↳", JSON.stringify({ out1, rows: rows.map((x) => ({ a: x.action, s: x.status, b: x.brokerage_id, st: x.subject_type, sid: x.subject_id, rc: x.risk_class, e: x.error })), ran: c.ran() }).slice(0, 600))
      await run(...c.args())
      check(`${tag}: called twice → TWO receipts and the write ran twice (no key: a second save is never a silent replay)`, ledger().length === 2 && c.ran() === 2)
      if (c.failByDelegate) { delegateFail = true; for (const k of Object.keys(calls)) delete calls[k]; run = await drive(c) }
      else run = await drive(c, c.failOpts)
      const out3 = await run(...c.args())
      const f = ledger()
      check(`${tag}: a refused write → its receipt settles failed`, f.length === 1 && f[0].status === "failed" && f[0].action === c.action)
      if (!(f.length === 1 && f[0].status === "failed")) console.log("     ↳", JSON.stringify({ out3, rows: f.map((x) => ({ a: x.action, s: x.status, e: x.error })) }).slice(0, 400))
    } catch (e) {
      check(`${tag}: driven without crashing (${e instanceof Error ? e.message.slice(0, 200) : String(e)})`, false)
    }
  }
  // NEGATIVE (the predictive-listing gate this lane added): an argument naming another tenant is refused — no write, no receipt.
  const pls = CASES.find((c) => c.fn === "cancelQueuedAutoTouch")!
  const run = await drive(pls)
  const refused = await run({ actionId: PA, brokerageId: OTHER_BRK, userId: UID }) as { success?: boolean }
  check("NEGATIVE: cancelQueuedAutoTouch with another tenant's brokerageId is refused — nothing written, no receipt", refused?.success === false && pls.ran() === 0 && ledger().length === 0)
}

async function main() {
  staticLayer()
  await drivenLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LEDGER_RECEIPTS_CUSTOMER1_FAIL\n" + fails.map((f) => `   - ${f}`).join("\n")); process.exit(1) }
  console.log(" ✅ LEDGER_RECEIPTS_CUSTOMER1_OK")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
