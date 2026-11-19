#!/usr/bin/env tsx
// scripts/arbitration-sinks-guard.ts — `test:arbitration-sinks` (wave 155, lane 155B2; directive B3, "key risk classes should be
// enforced deterministically at action sink … The LLM cannot grant permissions").
// ─────────────────────────────────────────────────────────────────────────────
// For each of the NINE risk classes of directive line 152 this names THE ONE sink function (file:line derived from the code, never
// typed in), and proves four things on STRIPPED source (CLAUDE.md §2 — a tombstone is not a call site):
//   A. the sink exists and its deterministic gate runs BEFORE the provider / writer seam inside it (order of first occurrence);
//   B. CENSUS — every file in app/ and lib/ that reaches the underlying writer / provider seam is the sink itself, a provider
//      implementation it drives, or a NAMED known bypass (each with its reason and remedy). A new bypass fails. A known entry
//      whose bypass is gone fails too (stale) — the list can only shrink, it can never sit reading as enforced;
//   C. FACT-FORCING (cross-check from the vendored ECC skill plugins/ecc/skills/gateguard — "decide from gathered facts, never
//      from self-evaluation"): no sink module imports a model-call helper, so no model text can be an input to its verdict;
//   D. whether the sink writes a governance record today (detail.governance via governanceRecord) — DERIVED, reported, not
//      asserted: the "no" list is the batch-2 work order, not a failure of this guard.
// Each finder has a POSITIVE CONTROL (a planted specimen is found) and a NEGATIVE control (the same token inside a comment /
// tombstone is not). Call-token seams scan with strings blanked too (prose inside a registry string is not a call); table seams
// keep strings (the table name IS a string) and blank comments only.
// Run: npx tsx scripts/arbitration-sinks-guard.ts   (summary line `RESULT: N passed, M failed`)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const files: string[] = []
const walk = (d: string) => {
  if (!existsSync(join(ROOT, d))) return
  for (const n of readdirSync(join(ROOT, d))) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(d, n)
    if (statSync(join(ROOT, p)).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) files.push(p)
  }
}
walk("app"); walk("lib")

type View = "code" | "calls"
const cache = new Map<string, string>()
const view = (f: string, v: View): string => {
  const k = `${v}:${f}`
  if (!cache.has(k)) { const s = raw(f); cache.set(k, v === "calls" ? blankStrings(s) : stripComments(s)) }
  return cache.get(k)!
}

interface SinkClass {
  key: string
  label: string
  sink: { file: string; fn: string }
  /** Tokens that must occur in the sink body BEFORE the first `seamInBody` token (the deterministic gate). */
  gates: RegExp[]
  seamInBody: RegExp
  /** The underlying writer / provider seam, scanned over app/ + lib/. */
  seam: RegExp
  seamView: View
  /** Files allowed to hold the seam: the sink module and the provider implementations it drives. */
  allowed: (f: string) => boolean
  /** A file counts only when it ALSO matches this (code view) — e.g. the egress guard's "imports the messaging module". */
  requires?: RegExp
  /** Named bypasses: file → why it is outside the sink today and the remedy. Shrink-only. */
  known: Record<string, string>
}

const B2 = "batch-2 work order — route through the sink"
const CLASSES: SinkClass[] = [
  {
    key: "credentials", label: "access / credentials",
    // resolveScopedConnectionResult (the exported door) reads through this private reader; the owner pin is the gate.
    sink: { file: "lib/connections/resolve-scoped.ts", fn: "readOwnerCredential" },
    gates: [/\.eq\(\s*["'`]owner_type["'`]/, /\.eq\(\s*["'`]owner_id["'`]/], seamInBody: /\bdecryptSecret\s*\(/,
    seam: /\bdecryptSecret\s*\(/, seamView: "calls",
    allowed: (f) => f === "lib/connections/resolve-scoped.ts" || f === "lib/security/secret-crypto.ts" || f === "lib/security/secret-migration.ts",
    known: Object.fromEntries([
      "app/actions/ai-listing-intake.ts", "app/actions/ai-offer-creation.ts", "app/actions/lead-import/crm-pull-actions.ts",
      "app/actions/marketing/image-library.ts", "app/actions/seller-showings.ts", "app/actions/social-dm.ts",
      "app/api/cron/connector-health/route.ts", "app/api/cron/publish-social-posts/route.ts", "app/api/webhooks/batchdata-smart-search/route.ts",
      "lib/ads/connectors/registry.ts", "lib/billing/resolve-stripe-account.ts", "lib/buyer-offer/credentials-helper.ts",
      "lib/connections/accounting-scopes.ts", "lib/connections/zoom.ts", "lib/content-intel/newsapi-ai.ts",
      "lib/inbound-mail/resolve-user-provider.ts", "lib/integrations/connection-manager.ts", "lib/kernel/forms.ts",
      "lib/kernel/ingress-reconciliation.ts", "lib/platform/platform-social.ts", "lib/platform/provider-posture.ts",
      "lib/property-alerts/alert-notifier.ts", "lib/providers/email/personal-email-adapter.ts", "lib/providers/exa/monitors.ts",
      "lib/security/oauth-refresh.ts", "lib/social/analytics-sync.ts", "lib/social/inbound-social.ts",
    ].map((f) => [f, `decrypts a stored secret OUTSIDE the scoped reader (its own query decides whose credential operates) — ${B2}; per-file owner/tenant pin unverified here`])),
  },
  {
    key: "paid_acquisition", label: "mass paid acquisition",
    sink: { file: "lib/lead-pipeline/pooled-pull.ts", fn: "runPooledBatchDataLane" },
    gates: [/\bdeps\.approval\s*\(/], seamInBody: /\bdeps\.search\s*\(/,
    seam: /\b(?:fetchMotivatedSellers|fetchIncrementalPropertySearch|skipTraceBatchDataV3Batch|createSmartSearchSubscription)\s*\(/, seamView: "calls",
    allowed: (f) => f === "lib/lead-pipeline/pooled-pull.ts" || /^lib\/external\/(batchdata|peopledata)-client\.ts$/.test(f),
    known: {
      "app/api/cron/lead-scraping/route.ts": `the scraping cron's own per-territory pulls — gated by the cron's pull gate (subscription + territory, P1) but not the pooled per-approval spend reservation — ${B2}`,
      "lib/buyer-search/investor-offmarket-runner.ts": `investor off-market bulk search outside the pooled lane — ${B2}`,
      "lib/kernel/intent-campaign.ts": `intent-campaign bulk pull outside the pooled lane — ${B2}`,
      "lib/kernel/listings-batchdata-feed.ts": `listings feed incremental search outside the pooled lane — ${B2}`,
      "lib/lead-pipeline/enrichment-orchestrator.ts": `batch skip trace outside the pooled lane — ${B2}`,
    },
  },
  {
    key: "outbound_send", label: "outbound send",
    sink: { file: "lib/providers/dispatch.ts", fn: "dispatchSms" },
    gates: [/\bcheckSuppression\s*\(/, /\bevaluateOutboundCompliance\s*\(/, /\bdeconflictGate\s*\(/], seamInBody: /\bresolveProvider\s*\(/,
    seam: /\b(?:sendEmail|sendSMS|sendViaTwilio|sendViaTelnyx|sendViaBandwidth)\s*\(/, seamView: "calls",
    requires: /(?:from\s*|import\(\s*)["']@\/lib\/providers\/messaging["']/,
    allowed: (f) => f === "lib/providers/dispatch.ts" || f.startsWith("lib/providers/messaging/"),
    known: {}, // filled from scripts/egress-send-guard-simulator.ts ALLOWLIST below — ONE reviewed list, not a second one
  },
  {
    key: "ad_budget", label: "ad budget / paid ad launch",
    sink: { file: "lib/ads/launch-assembler.ts", fn: "publishLaunchingCampaigns" },
    gates: [/\bloadConnectorCredential\s*\(|\bassembleAdFromCampaign\s*\(/], seamInBody: /\.publishCampaign\s*\(/,
    seam: /\.publishCampaign\s*\(/, seamView: "calls",
    allowed: (f) => f === "lib/ads/launch-assembler.ts" || f.startsWith("lib/ads/connectors/"),
    known: {
      "lib/ads/ctv-campaign.ts": `the streaming-TV (Vibe) launch — a second launch path with its own human-confirmed dispatch (dispatchCtvCampaignAction), not publishLaunchingCampaigns — ${B2}`,
    },
  },
  {
    key: "financial_ledger", label: "financial ledger write (the brokerage's books)",
    sink: { file: "lib/finance/accounting-egress.ts", fn: "pushExpenseToAccounting" },
    gates: [/\bbuildQuickBooksForBrokerage\s*\(/, /\bresolveExpenseAccountRef\s*\(/, /\bresolveBusinessUnit\s*\(/], seamInBody: /\.createPurchase\s*\(/,
    seam: /\.(?:createPurchase|createInvoice|createJournalEntry)\s*\(/, seamView: "calls",
    allowed: (f) => f === "lib/finance/accounting-egress.ts" || f.startsWith("lib/providers/accounting/"),
    known: {
      "app/actions/accounting-sync.ts":
        "pushManualAccountingEntryAction posts a manual invoice / expense / journal entry straight to QuickBooks (gated: finance roster + session tenant) and writes its own accounting_sync_log rows — no sync_errors row on failure, no SYSTEM_SYNC_COMPLETED on success. " + B2 + " (exact diff: lane 155B2 notes, Outside-lane requests).",
    },
  },
  {
    key: "commission_edit", label: "commission edit",
    // Commission TERMS (not the computed waterfall outputs in transaction_commissions, which the engine derives from them).
    sink: { file: "lib/commission/commission-term-change.ts", fn: "requestCommissionTermChange" },
    gates: [/\btermChangeAuthority\s*\(/], seamInBody: /\.from\(\s*["'`]commission_adjustments["'`]\s*\)\s*\.\s*insert\b/,
    seam: /\.from\(\s*["'`](?:commission_adjustments|commission_agreements|agent_commission_profiles)["'`]\s*\)\s*\.\s*(?:insert|upsert|update)\b/, seamView: "code",
    allowed: (f) => f === "lib/commission/commission-term-change.ts",
    known: {
      "app/actions/admin/agent-profile.ts": `admin edit of an agent's commission profile (future deals' default split) — not a per-deal term change — ${B2}: name its own gate on the ledger`,
      "app/actions/seller-listing/execution-engine.ts": `writes the commission agreement captured with the executed listing agreement — ${B2}`,
      "lib/commission/agent-concession.ts": `agent concession writes a commission adjustment outside the term-change door — ${B2}`,
      "lib/commission/agreement-onboarding.ts": `onboarding seeds the agent's first commission agreement — ${B2}`,
      "lib/kernel/users.ts": `seat provisioning seeds a commission profile row — ${B2}`,
    },
  },
  {
    key: "esign", label: "legal document / e-sign",
    sink: { file: "lib/esign/dispatch-packet.ts", fn: "dispatchEsignPacket" },
    gates: [/\bincompletePacketReason\s*\(/, /\bresolveESignChoice\s*\(/], seamInBody: /\bprovider\.createTransaction\s*\(/,
    seam: /\b(?:sendEnvelope|createEnvelope|sendForSignature|createSignatureRequest)\s*\(/, seamView: "calls",
    allowed: (f) => f === "lib/esign/dispatch-packet.ts" || f.startsWith("lib/integrations/providers/"),
    known: {
      "app/actions/admin/commission-agreement.ts": `sends the commission agreement for signature directly — ${B2}`,
      "app/actions/buyer-broker-agreements.ts": `sends the buyer-broker agreement directly — ${B2}`,
      "app/actions/buyer-offer/acknowledge-commission.ts": `sends the commission acknowledgment directly — ${B2}`,
      "app/api/agent-assistant/tool-call/route.ts": `staff voice tool (lane 155B3's file) — spoken human confirmation is its gate — ${B2}`,
      "lib/kernel/forms.ts": `forms kernel send-for-signature — ${B2}`,
      "lib/workflow/adapters/send-for-esign.ts": `workflow step adapter — ${B2}`,
    },
  },
  {
    key: "cda_release", label: "closing / CDA release",
    sink: { file: "app/actions/cda-portal.ts", fn: "approveCdaAction" },
    gates: [/\brequireAuth\s*\(/, /\bcdaFigureGate\s*\(/, /\bfreshClosingFileGate\s*\(/], seamInBody: /\.update\s*\(/,
    seam: /\bbroker_approved_at\s*:(?!\s*(?:string\b|\(|null\b))/, seamView: "code",
    allowed: (f) => f === "app/actions/cda-portal.ts",
    known: {},
  },
  {
    key: "payout", label: "irreversible payout",
    sink: { file: "lib/kernel/financial.ts", fn: "initiateCommissionPayout" },
    gates: [/\bpayoutReleaseGate\s*\(/], seamInBody: /\.update\s*\(/,
    seam: /\bcreateTransfer\s*\(|\bpayment_initiated_at\s*:(?!\s*(?:string\b|\(|null\b))/, seamView: "calls",
    allowed: (f) => f === "lib/kernel/financial.ts" || f === "lib/providers/payment/index.ts",
    known: {
      "app/actions/vendor-payments.ts": `initiateVendorPayout → createTransfer (real money to a vendor's connected account): gated by the session tenant + vendor-in-brokerage + W-9 soft gate, NOT the commission release gate (a vendor invoice is not a commission) — ${B2}: record its decision on the ledger`,
    },
  },
]

/** The census finder — the SAME function the controls exercise. */
function finds(src: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  return (src.match(g) ?? []).length
}
function bodyOf(src: string, fn: string): string {
  const i = src.search(new RegExp(`\\bfunction\\s+${fn}\\s*[(<]`))
  if (i < 0) return ""
  const j = src.indexOf("\nexport ", i + 10)
  return src.slice(i, j < 0 ? undefined : j)
}
const lineOf = (src: string, fn: string) => { const i = src.search(new RegExp(`\\bfunction\\s+${fn}\\s*[(<]`)); return i < 0 ? 0 : src.slice(0, i).split("\n").length }
const MODEL_IMPORT = /(?:from\s*|import\(\s*)["'](?:@\/lib\/ai\/[^"']*|@\/lib\/llm[^"']*|ai|@ai-sdk\/[^"']+|openai|@anthropic-ai\/sdk)["']|\bgenerateText\s*\(|\bgenerateAIResponse\s*\(/

const BORROWED = new Set<string>()
// The outbound class reuses the ONE reviewed list (egress-send-guard's ALLOWLIST) instead of restating it.
{
  const eg = stripComments(raw("scripts/egress-send-guard-simulator.ts"))
  const block = eg.slice(eg.indexOf("const ALLOWLIST"), eg.indexOf("\n}", eg.indexOf("const ALLOWLIST")))
  const outbound = CLASSES.find((c) => c.key === "outbound_send")!
  for (const m of block.matchAll(/["']([a-z0-9_./\[\]-]+\.tsx?)["']\s*:\s*\{\s*cls:\s*["']([a-z0-9-]+)["']/g)) {
    if (m[2] === "gate") continue // the sink itself, not an exemption
    outbound.known[m[1]] = `reviewed in scripts/egress-send-guard-simulator.ts ALLOWLIST (class ${m[2]})`
    BORROWED.add(m[1]) // that guard owns this entry's staleness (it may import the senders without calling one here)
  }
  console.log(`\n[outbound] ${Object.keys(outbound.known).length} reviewed exemptions read from egress-send-guard's ALLOWLIST (one list, two guards)`)
  check("POSITIVE CONTROL · the egress allowlist reader found entries (a broken reader would read as 'no exemptions')", Object.keys(outbound.known).length > 5)
}

const report: string[] = []
for (const c of CLASSES) {
  console.log(`\n══ ${c.label} — sink ${c.sink.file}#${c.sink.fn}`)
  const sinkSrc = view(c.sink.file, "code")
  const body = bodyOf(sinkSrc, c.sink.fn)
  const line = lineOf(raw(c.sink.file), c.sink.fn)
  check(`${c.key} · A · the sink exists: ${c.sink.file}:${line} ${c.sink.fn}`, body.length > 0)
  const seamAt = body.search(c.seamInBody)
  const gateAts = c.gates.map((g) => body.search(g))
  check(`${c.key} · A · every gate (${c.gates.map((g) => g.source.replace(/\\[bs]|\\\(|\\s\*|\(\?:|\)/g, "")).join(" + ")}) runs before the seam inside the sink`,
    seamAt >= 0 && gateAts.every((a) => a >= 0 && a < seamAt), `seam@${seamAt} gates@${gateAts.join(",")}`)
  const hits: Record<string, number> = {}
  for (const f of files) { const n = finds(view(f, c.seamView), c.seam); if (n && (!c.requires || c.requires.test(view(f, "code")))) hits[f] = n }
  const outside = Object.keys(hits).filter((f) => !c.allowed(f))
  const unexplained = outside.filter((f) => !(f in c.known))
  const stale = Object.keys(c.known).filter((f) => !(f in hits) && !BORROWED.has(f))
  check(`${c.key} · B · census: ${Object.keys(hits).length} file(s) reach the seam; ${outside.length - unexplained.length} named bypass(es); NO unexplained caller around the sink`, unexplained.length === 0, unexplained.join(", "))
  check(`${c.key} · B · every named bypass still exists (shrink-only list, nothing reads as enforced after it is gone)`, stale.length === 0, stale.join(", "))
  const modelFree = !MODEL_IMPORT.test(sinkSrc)
  check(`${c.key} · C · fact-forcing: the sink module imports no model-call helper — its verdict is computed from recorded facts`, modelFree)
  const gov = /\bgovernanceRecord\s*\(/.test(view(c.sink.file, "calls"))
  const ledgered = /\bwithActionLedger\s*\(|\brecordNonAction\s*\(/.test(view(c.sink.file, "calls"))
  report.push(`  ${c.key.padEnd(17)} ${`${c.sink.file}:${line}`.padEnd(48)} governance=${gov ? "yes" : "no "} ledger=${ledgered ? "yes" : "no "} bypasses=${outside.length}`)
}

console.log("\n══ controls")
check("POSITIVE CONTROL · a planted direct provider call is found by the census finder", finds(blankStrings("export async function x(){ await qbo.createPurchase({ amount: 1 }) }"), /\.(?:createPurchase|createInvoice|createJournalEntry)\s*\(/) === 1)
check("NEGATIVE CONTROL · the same call inside a tombstone comment is NOT a call site", finds(blankStrings("// TOMBSTONE: qbo.createPurchase({ amount }) lived here"), /\.(?:createPurchase|createInvoice|createJournalEntry)\s*\(/) === 0)
check("NEGATIVE CONTROL · a call token inside registry prose (a string) is NOT a call site in the call view", finds(blankStrings('const what = "sendForSignature( is the provider seam"'), /\bsendForSignature\s*\(/) === 0)
check("POSITIVE CONTROL · a table seam (a string literal) is still found in the code view", finds(stripComments('await s.from("platform_credentials").select("*")'), /\.from\(\s*["'`]platform_credentials["'`]\s*\)\s*\.\s*select\s*\(/) === 1)
check("POSITIVE CONTROL · the gate-order check rejects a seam that precedes its gate", (() => { const b = "function f(){ deps.search(); deps.approval() }"; return b.search(/\bdeps\.search\s*\(/) < b.search(/\bdeps\.approval\s*\(/) })())
check("POSITIVE CONTROL · the model-import finder recognises a model helper import", MODEL_IMPORT.test('import { generateText } from "ai"'))

console.log("\n SINKS (governance = detail.governance via governanceRecord; the 'no' rows are the batch-2 work order, reported not failed):")
console.log(report.join("\n"))
console.log("\n BLIND SPOTS: a seam is a token family, so a provider reached through a NEW alias (another client name, raw fetch to the provider host) is not seen until its token is added; credentials WRITES (27 files write platform_credentials) are outside this census — it covers the READ door that lets a credential operate; commission writes outside the term-change door are counted only for the three agreement tables; CDA release is pinned on the broker_approved_at stamp.")
console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(` failed: ${failures.join(" | ")}`); process.exit(1) }
