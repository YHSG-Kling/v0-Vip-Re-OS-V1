#!/usr/bin/env tsx
/**
 * scripts/proof-only-exports-guard.ts (npm run test:proof-only-exports) — wave 155, lane 155R25.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EIGHT EXPORTS ONLY A PROOF CALLED (test:orphan-exports category A at 15d212bf) — each reaches ONE honest outcome, and
 * this guard holds it by the RULE of that outcome, never by a count:
 *   · WIRED    — a product caller found in STRIPPED source (a tombstone is not a call site, CLAUDE.md §2) AND driven once here;
 *   · RETIRED  — gone from stripped source, its tombstone (raw source — a tombstone IS a comment) names a survivor at a
 *                file:line that really declares it, and no product file calls it;
 *   · TAGGED   — the tag matches test:orphan-exports' OWN regex (copied below and asserted identical to the guard's text);
 *   (lane 155R25b, integrator ruling: the intelligence ladder and its three Datafiniti adapters are RETIRED onto their survivors —
 *    the tombstone's every cited file:line is checked live; no tag survives on a retired adapter.)
 * Every driven check is SIMULATED (in-memory client, no network, no provider, no model; every seam counted).
 * `--base <rev>` re-runs the STATIC judges on that commit's text (git show) and prints each verdict — the red-at-base controls.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"

const BASE = (() => { const i = process.argv.indexOf("--base"); return i > 0 ? process.argv[i + 1] : null })()
const raw = (p: string): string => {
  try { return BASE ? execFileSync("git", ["show", `${BASE}:${p}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : readFileSync(p, "utf8") } catch { return "" }
}
const memo = new Map<string, string>()
const once = (k: string, f: () => string) => { let v = memo.get(k); if (v === undefined) { v = f(); memo.set(k, v) } return v }
const code = (p: string) => once(`c:${p}`, () => stripComments(raw(p)))                // strings kept (import paths, table names)
const calls = (p: string) => once(`k:${p}`, () => blankStrings(stripComments(raw(p)))) // strings blanked (a quoted name is not a call)
let pass = 0, fail = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`) }
}
/** The body of `export (async) function name` up to the next top-level export (stripped text). */
const bodyOf = (src: string, name: string) => { const i = src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`)); if (i < 0) return ""; const j = src.indexOf("\nexport ", i + 10); return src.slice(i, j < 0 ? undefined : j) }

// THE TAG RULE — copied from scripts/orphan-export-guard.ts adjudicationTag (asserted identical below, so the two cannot drift).
const TAG_RE = /@(proofSeam|ownerRuled)\s+(?!\*\/)\S[^*\n]*(?:[\s\S]{0,300})?$/
function tagOf(src: string, name: string): string | null {
  const decl = src.search(new RegExp(`^export\\s+(?:async\\s+)?(?:function\\*?|const|let|class|type|interface|enum)\\s+${name}\\b`, "m"))
  if (decl < 0) return null
  const m = src.slice(Math.max(0, decl - 600), decl).match(TAG_RE)
  return m ? m[1] : null
}

/** Product files (app/ lib/ components/), walked once. */
const PRODUCT: string[] = []
for (const top of ["app", "lib", "components"]) {
  const walk = (d: string) => { let es: string[] = []; try { es = readdirSync(d) } catch { return } for (const e of es) { if (e === "node_modules" || e.startsWith(".")) continue; const p = join(d, e); let st; try { st = statSync(p) } catch { continue } if (st.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e)) PRODUCT.push(p) } }
  walk(top)
}
/** Product files OTHER than `own` whose stripped, string-blanked text names `name` (the orphan census's own reference rule). */
const productReferrers = (name: string, own: string) => { const re = new RegExp(`\\b${name}\\b`); return PRODUCT.filter((f) => f !== own && re.test(calls(f))) }

const F = {
  planner: "lib/lead-pipeline/source-discovery-planner.ts",
  scoped: "lib/connections/resolve-scoped.ts",
  connected: "lib/agentic-os/resolve-connected-capability.ts",
  describe: "app/api/agentic-os/actions/[capability]/route.ts",
  invoke: "app/api/agentic-os/actions/[capability]/invoke/route.ts",
  approval: "lib/kernel/approval-authority.ts",
  catalog: "lib/marketing/content-catalog.ts",
  tax: "lib/finance/tax-planning.ts",
  panel: "app/dashboard/financials/components/planning/tax-readiness-panel.tsx",
  coordinator: "app/actions/ai-transaction-coordinator.ts",
  closing: "app/actions/ai-closing-workflow.ts",
}

console.log(`\n[proof-only-exports] ${BASE ? `STATIC judges on ${BASE} (each WIRED / RETIRED / TAGGED verdict is expected RED there)` : "the eight category-A exports of 15d212bf"}`)

// ── 0 · the instrument ───────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n[0 · the instrument — controls able to fail]")
{
  const og = readFileSync("scripts/orphan-export-guard.ts", "utf8")
  check("the tag regex is test:orphan-exports' own (text identical)", og.includes(TAG_RE.source.replace(/\//g, "\\/")) || og.includes(String(TAG_RE)), "drifted from scripts/orphan-export-guard.ts adjudicationTag")
  const tagged = "/** @ownerRuled 2026-11-19 owner R11: held */\nexport function a() {}\n"
  check("POSITIVE CONTROL · a short tag right above an export is read", tagOf(tagged, "a") === "ownerRuled")
  check("NEGATIVE CONTROL · a bare tag with no reason does not count", tagOf("/** @ownerRuled */\nexport function a() {}\n", "a") === null)
  check("NEGATIVE CONTROL · a tag more than 300 characters above the export does not count", tagOf(`/** @ownerRuled 2026 held */\n${"// x\n".repeat(80)}export function a() {}\n`, "a") === null)
  check("NEGATIVE CONTROL · a tombstone naming a function is not a call site (stripped)", !/\bfoo\s*\(/.test(blankStrings(stripComments("// foo( lived here\nconst why = \"foo(\"\n"))) && /\bfoo\s*\(/.test(blankStrings(stripComments("foo(1)\n"))))
}

// ── 1–4 · the intelligence ladder and its licensed-dataset seam ─────────────────────────────────────────────────────
console.log("\n[1–4 · the intelligence ladder and its Datafiniti seam — MERGED ONTO THEIR SURVIVORS AND RETIRED (lane 155R25b)]")
{
  // Integrator ruling (architectural laws 1 / 2): the ladder was a fifth chooser; its rules live where the decision is made.
  const p = code(F.planner)
  for (const n of ["chooseIntelligenceSource", "datafinitiLadderCandidates", "spendableDatafinitiRows", "licensedDatasetCandidate", "PRODUCTION_DATAFINITI_DATASET_SEAM", "INTELLIGENCE_LADDER"]) {
    check(`${n} · gone from stripped source, and no product or proof file calls it`, raw(F.planner).length > 0 && !new RegExp(`export\\s+(?:const|function)\\s+${n}\\b`).test(p)
      && !BASE && ![...PRODUCT, "scripts/intelligence-brief-guard.ts"].some((f) => f !== F.planner && new RegExp(`\\b${n}\\b`).test(calls(f))))
  }
  check("no @ownerRuled tag survives on a retired adapter (a tag on an adapter to a retired chooser is not a ruling)", !/@ownerRuled 2026-11-19 owner R11/.test(raw(F.planner)))
  // The tombstone names each survivor at file:line — every cited line must still carry the token it names.
  const tomb = raw(F.planner).slice(raw(F.planner).indexOf("TOMBSTONE (wave 155, lane 155R25b"))
  const LINES: Array<[string, RegExp]> = [
    ["app/api/cron/lead-scraping/route.ts:384", /FREE RUNGS FIRST/], ["lib/content-intel/local-intel.ts:796", /heldNow\.has\(/],
    ["lib/content-intel/topic-intelligence.ts:347", /export const TOPIC_KIND_LADDER\b/], ["lib/content-intel/topic-intake.ts:412", /rights_unknown/],
    ["lib/content-intel/topic-intake.ts:417", /stale_source/], ["lib/content-intel/topic-intake.ts:204", /export function rewordedNearCopyProblem\b/],
    ["lib/providers/scrape-checkpoint.ts:171", /not a public post page/], ["lib/lead-pipeline/freshness.ts:209", /export function evaluateFreshness\b/],
    ["lib/lead-pipeline/pipeline-processor.ts:258", /evaluateFreshness\(/], ["lib/vendor-governance/budget-eval.ts:159", /export function decideSpendBackpressure\b/],
    ["lib/lead-pipeline/datafiniti-dataset-door.ts:141", /export function datafinitiDatasetSelection\b/], ["lib/lead-pipeline/datafiniti-territory-door.ts:246", /activation\.state !== "active"/],
    [`${F.planner}:145`, /export const IDEAS_ONLY_SOURCES\b/], [`${F.planner}:514`, /export function resolveSourceDoor\b/], [`${F.planner}:557`, /LICENSE-HELD/],
    [`${F.planner}:608`, /export function paidPullApproval\b/], [`${F.planner}:329`, /needs_quote/],
  ]
  const bad = LINES.filter(([ref, re]) => {
    const [file, n] = [ref.slice(0, ref.lastIndexOf(":")), Number(ref.slice(ref.lastIndexOf(":") + 1))]
    // A self-reference is written "(this file :145)"; any other survivor is named by its own file name.
    const cited = (file === F.planner || tomb.includes(file.replace(/^.*\//, ""))) && (tomb.includes(ref) || tomb.includes(`:${n}`))
    return !cited || !re.test(raw(file).split("\n")[n - 1] ?? "")
  }).map(([r]) => r)
  check(`the tombstone names each survivor at a LIVE file:line (${LINES.length} cited lines checked)`, tomb.length > 0 && bad.length === 0, bad)
}

// ── 5 · the stated-origin credential door ──────────────────────────────────────────────────────────────────────────
console.log("\n[5 · resolveScopedConnectionForOrigin — WIRED (an external agent's token request on the agentic API)]")
{
  check("5 · resolve-connected-capability.ts calls the door (stripped)", /\bresolveScopedConnectionForOrigin\s*\(/.test(calls(F.connected)))
  for (const [label, f] of [["describe", F.describe], ["invoke", F.invoke]] as const) {
    const c = code(f)
    const tokenBranch = c.search(/caller\.via\s*!==\s*"token"/), origin = c.search(/\bresolveConnectedCapabilityForOrigin\s*\(/)
    check(`5 · the agentic ${label} route sends a TOKEN caller through resolveConnectedCapabilityForOrigin (session callers keep the plain probe)`, tokenBranch >= 0 && origin > tokenBranch && /trustClass:\s*"model_output"/.test(c))
  }
  check("5 · the plain probe stays free of the record (LESSON 5: a read-only caller is read-only in the source)", !/\bresolveScopedConnectionForOrigin\s*\(/.test(bodyOf(calls(F.connected), "resolveConnectedCapability")))
}

// ── 6 · approval inheritance ───────────────────────────────────────────────────────────────────────────────────────
console.log("\n[6 · approvalInherits — WIRED (the ONE re-open rule every send / publish door and the catalog read)]")
{
  const body = bodyOf(calls(F.approval), "marketingApprovalReopened")
  check("6 · marketingApprovalReopened decides through approvalInherits (stripped)", /\bapprovalInherits\s*\(/.test(body))
  check("6 · the inline version-only copy is gone (stamp.fingerprint !== marketingAssetFingerprint(row))", !/stamp\.fingerprint\s*!==\s*marketingAssetFingerprint\(row\)/.test(body))
  for (const f of ["app/actions/direct-mail.ts", "app/actions/blog.ts", "lib/social/publisher.ts"]) check(`6 · product door ${f} calls refuseReopenedMarketingAssets`, /\brefuseReopenedMarketingAssets\s*\(/.test(calls(f)))
  check("6 · the catalog judges with the session tenant (marketingApprovalReopened(r, B))", /\bmarketingApprovalReopened\(r,\s*B\)/.test(calls(F.catalog)))
}

// ── 7 · net self-employment income ─────────────────────────────────────────────────────────────────────────────────
console.log("\n[7 · computeNetSelfEmploymentIncome — WIRED (the tax readiness panel's 'Est. Taxable')]")
{
  const c = code(F.panel)
  check("7 · the panel imports it from the one estimator", /import\s*\{[^}]*\bcomputeNetSelfEmploymentIncome\b[^}]*\}\s*from\s*"@\/lib\/finance\/tax-planning"/.test(c))
  check("7 · the panel computes Est. Taxable with it over the plan's own income and CONFIRMED deductible", /computeNetSelfEmploymentIncome\(\s*plan\.periodToDate\.income,\s*plan\.periodToDate\.confirmedDeductible\s*\)/.test(c))
  check("7 · the second inline computation (ytdGCI − ytdExpenses as a taxable figure) is gone", !/=\s*ytdGCI\s*-\s*ytdExpenses/.test(c))
}

// ── 8 · prepareForClosing ──────────────────────────────────────────────────────────────────────────────────────────
console.log("\n[8 · prepareForClosing — MERGED AND RETIRED (survivor aiGenerateClosingChecklist)]")
{
  check("8 · gone from stripped source", !/export\s+async\s+function\s+prepareForClosing\b/.test(code(F.coordinator)) && raw(F.coordinator).length > 0)
  const t = raw(F.coordinator).match(/TOMBSTONE[^\n]*prepareForClosing[\s\S]{0,400}?Survivor:\s*(app\/actions\/ai-closing-workflow\.ts):(\d+)\s+aiGenerateClosingChecklist/)
  const line = t ? (raw(t[1]).split("\n")[Number(t[2]) - 1] ?? "") : ""
  check("8 · the tombstone names the survivor at a file:line that really declares it", !!t && /export\s+async\s+function\s+aiGenerateClosingChecklist\b/.test(line), t ? `${t[1]}:${t[2]} → ${line.trim().slice(0, 80)}` : "no tombstone")
  const callers = BASE ? [] : PRODUCT.filter((f) => /\bprepareForClosing\s*\(/.test(calls(f)))
  check("8 · no product file calls it", callers.length === 0, callers)
  const s = bodyOf(code(F.closing), "aiGenerateClosingChecklist")
  check("8 · the survivor carries what was merged (documents, parties role + company, potential issues, day-of-closing)", /"transaction_documents"/.test(s) && /select\(\s*"role, company"\s*\)/.test(s) && /potential_issues:\s*z\.array/.test(s) && /day_of_closing:\s*z\.array/.test(s))
}

// ── the census rule: a WIRED export is no longer category A ─────────────────────────────────────────────────────────
if (!BASE) {
  console.log("\n[census rule — category A is 'a proof names it, NO product file does, not even its own']")
  const inFileReached = (name: string, own: string) => (calls(own).match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length > 1 && PRODUCT.some((f) => f !== own && raw(f).includes(own.replace(/\.(ts|tsx)$/, "").replace(/^/, "@/")))
  for (const [n, own] of [["resolveScopedConnectionForOrigin", F.scoped], ["computeNetSelfEmploymentIncome", F.tax]] as const) {
    const r = productReferrers(n, own)
    check(`${n} · referenced by another product file (${r.slice(0, 3).join(", ")})`, r.length > 0)
  }
  check("approvalInherits · called in its own module, and that module is imported by product files (category B — live helper)", inFileReached("approvalInherits", F.approval))
}

// ── DRIVEN (SIMULATED) ─────────────────────────────────────────────────────────────────────────────────────────────
if (!BASE) {
  const { memSupabase } = await import("./in-memory-supabase")

  console.log("\n[D7 · the panel's figure, driven through THE estimator]  SIMULATED")
  {
    const T = await import("../lib/finance/tax-planning")
    const year = new Date().getUTCFullYear(), today = new Date().toISOString().slice(0, 10)
    const none = { federalRate: null, stateRate: null, stateCodes: null, selfEmploymentRate: null, otherReserveRate: null, accountantTargets: {}, incomeBasis: null, deductibleCategories: null, fiscalYearStartMonth: null, dueDateOverrides: {} }
    const expenses = T.sumDeductibleExpenses([{ amount: 10000, category: "marketing" }, { amount: 30000, category: "vehicle" }], ["marketing"])
    const plan = T.buildTaxPlan({ taxYear: year, today, assumptions: none as never, income: { recognized: 100000, earnedNotPaid: 0, disputedExcluded: 0 }, expenses, recorded: [] })
    const shown = T.computeNetSelfEmploymentIncome(plan.periodToDate.income, plan.periodToDate.confirmedDeductible)
    const oldInline = 100000 - 40000
    check(`D7 · Est. Taxable = income − CONFIRMED deductible = ${shown} (10,000 confirmed of 40,000 recorded)`, shown === 90000, { shown, confirmed: plan.periodToDate.confirmedDeductible })
    check(`D7 · CONTROL: the retired inline formula gives ${oldInline} — the check tells the two apart`, oldInline !== shown)
    const loss = T.buildTaxPlan({ taxYear: year, today, assumptions: none as never, income: { recognized: 5000, earnedNotPaid: 0, disputedExcluded: 0 }, expenses: T.sumDeductibleExpenses([{ amount: 9000, category: "marketing" }], ["marketing"]), recorded: [] })
    check("D7 · a loss shows 0, never a negative taxable figure (the plan still says isLoss)", T.computeNetSelfEmploymentIncome(loss.periodToDate.income, loss.periodToDate.confirmedDeductible) === 0 && loss.periodToDate.isLoss)
  }

  console.log("\n[D6 · a send / publish door on an in-memory client]  SIMULATED")
  {
    const A = await import("../lib/kernel/approval-authority")
    const B = "b6b6b6b6-0000-4000-8000-000000000155"
    const base = { asset_type: "image", asset_name: "Open house art", preview_text: null, variants: null, audience: null, brand: null }
    const mk = (id: string, url: string, vis: string, stampedVis: string | null) => {
      const row: Record<string, unknown> = { id, brokerage_id: B, agent_user_id: "uOwner", team_id: null, visibility_scope: vis, ...base, asset_url: url, approval_status: "approved" }
      const actsFor = stampedVis === "brokerage" ? "brokerage" as const : null
      row.metadata = { approval: { fingerprint: A.marketingAssetFingerprint(row), scope_key: A.marketingScopeKey({ brokerageId: B, actsFor, teamId: null, ownerUserId: "uOwner" }), approved_by: "uAdm", approved_at: new Date().toISOString(), authority: "content_brand" } }
      return row
    }
    const d = memSupabase({ marketing_assets: [mk("a1", "https://cdn.example.test/same.png", "agent", null), mk("a2", "https://cdn.example.test/moved.png", "brokerage", null)] })
    const ok = await A.refuseReopenedMarketingAssets(d as never, B, ["https://cdn.example.test/same.png"])
    const moved = await A.refuseReopenedMarketingAssets(d as never, B, ["https://cdn.example.test/moved.png"])
    check("D6 · POSITIVE CONTROL: the approved piece in its approved scope PASSES the door (1 asset judged)", ok.ok && ok.matched === 1, ok)
    check("D6 · the same version moved to the brokerage voice after approval is REFUSED at the door (approvalInherits: scope differs)", !moved.ok && moved.assetIds.join() === "a2", moved)
    check("D6 · the rule itself: identical scope + version under content_brand inherits; spend_publication never does", A.approvalInherits("content_brand", { scopeKey: "s", fingerprint: "v" }, { scopeKey: "s", fingerprint: "v" }) && !A.approvalInherits("spend_publication", { scopeKey: "s", fingerprint: "v" }, { scopeKey: "s", fingerprint: "v" }))
  }

  console.log("\n[D5 · the stated-origin probe on an in-memory client (the agentic token path)]  SIMULATED")
  {
    const { registerHooks } = await import("node:module")
    const G = globalThis as any
    G.__R25 = { svc: null as unknown, mints: 0, fetches: 0 }
    const STUB: Record<string, string> = {
      "server-only": "export{}",
      "@/lib/supabase/service": "export function createServiceClient(){ const s = globalThis.__R25.svc; if (!s) { globalThis.__R25.mints++; throw new Error('proof-only-exports: no service client') } return s }; export const createClient = createServiceClient",
      "@/lib/supabase/server": "export async function createClient(){ const s = globalThis.__R25.svc; if (!s) throw new Error('proof-only-exports: no session client'); return s }; export const createServerClient = createClient",
      "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
    }
    registerHooks({ resolve(spec: string, ctx: any, next: any) { const b = STUB[spec]; return b !== undefined ? { url: `data:text/javascript,${encodeURIComponent(b)}`, shortCircuit: true } : next(spec, ctx) } })
    delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY
    G.fetch = async () => { G.__R25.fetches++; throw new Error("no network in proof-only-exports") }
    const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const o = { e: console.error, w: console.warn, l: console.log }; console.error = console.warn = console.log = () => {}; try { return await fn() } finally { console.error = o.e; console.warn = o.w; console.log = o.l } }
    const B = "b5b5b5b5-0000-4000-8000-000000000155"
    const world = () => {
      const mem = memSupabase({ agent_action_ledger: [] }, { unique: { agent_action_ledger: [["idempotency_key"]] } }) as any
      const touched: string[] = []
      G.__R25.svc = new Proxy(mem, { get(t, p) { if (p === "from") return (table: string) => { touched.push(table); return t.from(table) }; return t[p as string] } })
      return { rows: () => mem.tables.agent_action_ledger as Array<Record<string, any>>, credentialReads: () => touched.filter((x) => x !== "agent_action_ledger" && x !== "tenant_policy_versions").length }
    }
    const R = await import("../lib/agentic-os/resolve-connected-capability")
    const verified = { trustClass: "model_output", sink: { verification: { kind: "deterministic" as const, check: "agentic bearer token holds scope calendar:read (hasScope)" } } }
    const w1 = world()
    const r1 = await quiet(() => R.resolveConnectedCapabilityForOrigin("calendar_availability_get", { brokerageId: B }, verified))
    const reads1 = w1.rows().filter((r) => r.action === "access.credential.read")
    check(`D5 · a scoped token probe: ONE access.credential.read decision row per provider probed (${reads1.length} of 3), never a value; not connected`, reads1.length === 3 && !r1.connected && reads1.every((r) => !JSON.stringify(r).match(/secret|token_value|api_key"\s*:\s*"/i)), { rows: w1.rows().map((r) => `${r.action}:${r.status}`) })
    check("D5 · …and the store was really read behind the door (seam reached)", w1.credentialReads() > 0, w1.credentialReads())
    const w2 = world()
    const r2 = await quiet(() => R.resolveConnectedCapabilityForOrigin("calendar_availability_get", { brokerageId: B }, { trustClass: "model_output", sink: { modelClaims: { approved: true } } } as never))
    check("D5 · an UNVERIFIED model origin is HELD: ONE decision.wait row, ZERO credential reads, the walk stops (not 3 holds)", w2.rows().length === 1 && /\.decision\.wait$/.test(String(w2.rows()[0]?.action)) && w2.credentialReads() === 0 && !r2.connected, { rows: w2.rows().map((r) => r.action), reads: w2.credentialReads() })
    const w3 = world()
    await quiet(() => R.resolveConnectedCapability("calendar_availability_get", { brokerageId: B }))
    check("D5 · CONTROL: the plain probe (a signed-in person) writes NO record — the door is what records", w3.rows().length === 0)
    check("D5 · no network was attempted and no provider was called", G.__R25.fetches === 0, G.__R25.fetches)
  }
}

console.log("\n BLIND SPOTS: the static judges read the files named here only — a NEW caller of a retired name elsewhere is caught by the")
console.log(" product-wide scan in §8, a new caller of a wired one is not needed; the driven checks run the real modules on an in-memory")
console.log(" client, never a live database; the ladder's moved rules are driven by test:intelligence-brief, not here.")
console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (BASE) process.exit(0)
if (fail > 0) { console.log(` failed: ${failures.join(" | ")}`); process.exit(1) }
