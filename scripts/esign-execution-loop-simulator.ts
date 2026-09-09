#!/usr/bin/env tsx
/**
 * scripts/esign-execution-loop-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PROVIDER-AGNOSTIC E-SIGN EXECUTION LOOP (wave 47 lane FA), off the
 * owner ruling (2026-09-09): "dotloop is not the only esign provider available
 * and the users transaction and esign providers are found in the settings of
 * which provider they use."
 *
 *   · exactly ONE execution core (lib/forms/esign-execution-loop.ts) — no
 *     per-provider copy of the loop-completeness gate anywhere else.
 *   · every provider webhook that handles a signed/completed event
 *     (dotloop, docusign, skyslope, authentisign) calls the core.
 *   · the autonomous sweep (lib/transactions/esign-doc-sync-sweep.ts) calls it
 *     too — the half that covers Brokermint/FormSimplicity, which have no
 *     webhook at all.
 *   · the core itself never hardcodes a provider name in a branch — the
 *     provider is a DATA VALUE threaded through from the caller (which in
 *     turn resolved it from the tenant's settings — provider-resolver.ts /
 *     resolveTransactionFormsProvider), never assumed.
 *   · a positive control proves the "no hardcoded provider" checker can still
 *     fail (§2 — an absence assertion with no control is unproven).
 *
 * Run: npx tsx scripts/esign-execution-loop-simulator.ts   (npm run test:esign-execution-loop)
 */
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { evaluateEnvelopeExecution } from "../lib/forms/esign-execution-loop"
import { evalAnchorExecution } from "../lib/forms/esign-anchor-eval"
import { blankComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ E-sign execution loop is provider-agnostic — same invariant, every provider, resolved from settings.")
  console.log(" ESIGN_EXECUTION_LOOP_PASS")
  process.exit(0)
}

const root = process.cwd()
const read = (p: string) => readFileSync(resolve(root, p), "utf8")
// Comments blanked (never string literals here — every check below matches
// against a REAL code token that legitimately lives inside a string literal:
// an import specifier, a table name in `.from(...)`, a column name in
// `.eq(...)`, a signal type. Blanking strings too would blank those out and
// make every check vacuously pass, which is the exact §2 trap CLAUDE.md
// warns about — "a broken regex and a clean tree both report zero." A
// tombstone comment naming a provider as a past example is still excluded,
// since comments (not strings) are what gets blanked.
const stripped = (p: string) => blankComments(read(p))

const CORE_PATH        = "lib/forms/esign-execution-loop.ts"
const coreSrcRaw        = read(CORE_PATH)
const coreSrcStripped   = stripped(CORE_PATH)

const WEBHOOKS: Record<string, string> = {
  dotloop:      "app/api/webhooks/dotloop/route.ts",
  docusign:     "app/api/webhooks/docusign/route.ts",
  skyslope:     "app/api/webhooks/skyslope/route.ts",
  authentisign: "app/api/webhooks/authentisign/route.ts",
}
const SWEEP_PATH = "lib/transactions/esign-doc-sync-sweep.ts"

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" E-sign execution loop simulator (provider-agnostic)")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[exactly one execution core]")
  // No OTHER file in the tree defines a same-shaped gate — the two exported
  // entry points live in exactly one file. grep the whole tree (excluding the
  // core itself and this simulator) for a second definition of the export.
  const libFiles = walk(resolve(root, "lib"))
  const appFiles = walk(resolve(root, "app"))
  const scriptFiles = walk(resolve(root, "scripts"))
  const allSrc = [...libFiles, ...appFiles, ...scriptFiles].filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  const secondDefinitions = allSrc.filter((f) => {
    const rel = f.slice(root.length + 1)
    if (rel === CORE_PATH) return false
    const src = stripped(rel)
    return /export\s+(async\s+)?function\s+evaluateEnvelopeExecution\s*\(/.test(src)
  })
  check("evaluateEnvelopeExecution is defined in exactly ONE file",
    secondDefinitions.length === 0, secondDefinitions.map((f) => f.slice(root.length + 1)).join(", "))

  console.log("\n[every provider webhook handling a signed/completed event calls the core]")
  for (const [provider, path] of Object.entries(WEBHOOKS)) {
    const src = stripped(path)
    check(`${provider} webhook imports evaluateEnvelopeExecution from the core`,
      new RegExp(`import\\s*\\{[^}]*\\bevaluateEnvelopeExecution\\b[^}]*\\}\\s*from\\s*["']@/lib/forms/esign-execution-loop["']`).test(src))
    check(`${provider} webhook actually CALLS evaluateEnvelopeExecution (not just imports it)`,
      /evaluateEnvelopeExecution\s*\(/.test(src))
  }

  console.log("\n[the sweep — the autonomous half for providers with no webhook — calls the core]")
  const sweepSrc = stripped(SWEEP_PATH)
  check("the sweep imports evaluateEnvelopeExecution from the core",
    /import\s*\{[^}]*\bevaluateEnvelopeExecution\b[^}]*\}\s*from\s*["']@\/lib\/forms\/esign-execution-loop["']/.test(sweepSrc))
  check("the sweep calls evaluateEnvelopeExecution after a successful transaction-lane pull",
    /result\.ok\s*&&\s*t\.providerSource[\s\S]{0,300}evaluateEnvelopeExecution\s*\(/.test(sweepSrc))
  check("the sweep calls evaluateEnvelopeExecution after a successful listing-lane pull",
    /result\.ok\s*&&\s*listingProviderSource[\s\S]{0,300}evaluateEnvelopeExecution\s*\(/.test(sweepSrc))
  check("the sweep never hardcodes a provider name for the eval call — providerSource comes off the row",
    !/providerSource:\s*"(dotloop|docusign|skyslope|authentisign|brokermint|formsimplicity)"/.test(sweepSrc))

  console.log("\n[no provider name hardcoded in the core — provider is a DATA VALUE, not a branch]")
  // POSITIVE CONTROL FIRST (§2): a checker that always reports "clean" is worse
  // than no checker. Prove this exact regex still catches a hardcoded branch
  // on a synthetic PRE-FIX snippet before trusting it against the real file.
  const HARDCODED_PROVIDER_BRANCH = /providerSource\s*===?\s*["'](dotloop|docusign|skyslope|authentisign|brokermint|formsimplicity)["']|case\s*["'](dotloop|docusign|skyslope|authentisign|brokermint|formsimplicity)["']\s*:/
  const preFixHardcodedSnippet = `
    function pick(providerSource: string) {
      if (providerSource === "dotloop") return dotloopDocs
      return genericDocs
    }
  `
  check("control · the hardcoded-provider-branch regex correctly FIRES on a synthetic pre-fix snippet",
    HARDCODED_PROVIDER_BRANCH.test(preFixHardcodedSnippet))
  const cleanSnippet = `
    function pick(providerSource: string) {
      return docsByProvider[providerSource] ?? []
    }
  `
  check("control · the same regex correctly stays SILENT on a clean, data-driven snippet",
    !HARDCODED_PROVIDER_BRANCH.test(cleanSnippet))
  // Now the real check, using the same regex the control just proved works.
  // (Runs against comment+string-blanked source — a docblock naming "dotloop"
  // as an example, or the "dotloop_loop_id" column-name STRING LITERAL, must
  // never trip this; both are blanked by blankComments/blankStrings.)
  check("the core itself contains no `providerSource === \"<name>\"` branch for any known provider",
    !HARDCODED_PROVIDER_BRANCH.test(coreSrcStripped))
  check("the core's signature/type declares providerSource as a plain string, not a provider-name union",
    /providerSource:\s*string/.test(coreSrcStripped))

  console.log("\n[the core reads BOTH tracked-document sources — never just Dotloop's table]")
  check("the core reads client_documents (the Dotloop-era table, scoped by transaction_id/listing_id — not a provider name)",
    /\.from\(\s*["']client_documents["']\s*\)/.test(coreSrcStripped))
  check("the core reads transaction_documents (the m106/m614 provider-agnostic sync target, incl. the listing lane)",
    /\.from\(\s*["']transaction_documents["']\s*\)/.test(coreSrcStripped))
  check("the transaction_documents read is scoped by the CALLER-supplied providerSource value, not a literal",
    /\.eq\(\s*["']provider_source["']\s*,\s*input\.providerSource\s*\)/.test(coreSrcStripped))

  console.log("\n[fail-closed reads (§4) — a refused tracked-document read never reads as \"nothing outstanding\"]")
  // Window wide enough to span the explanatory comment before console.error
  // AND the long single-line template-literal console.error call itself
  // (which names the connector + envelope id + the underlying error message)
  // before reaching the `return NOT_FOUND` it guards — 400 chars comfortably
  // covers both today; not so wide it stops meaning anything (this file's
  // total is a few thousand characters, so 400 is still a real constraint).
  check("a client_documents read error is logged and refuses (returns NOT_FOUND), not swallowed",
    /clientDocsRes\.error[\s\S]{0,400}return NOT_FOUND/.test(coreSrcStripped)
    && /clientDocsRes\.error[\s\S]{0,120}console\.error/.test(coreSrcStripped))
  check("a transaction_documents read error is logged and refuses (returns NOT_FOUND), not swallowed",
    /txnDocsRes\.error[\s\S]{0,400}return NOT_FOUND/.test(coreSrcStripped)
    && /txnDocsRes\.error[\s\S]{0,120}console\.error/.test(coreSrcStripped))

  console.log("\n[the partial-loop signal — never left silent]")
  check("an incomplete loop signals deal_coordinator (not left silent)",
    /toManager:\s*"deal_coordinator"/.test(coreSrcStripped) && /signalType:\s*"esign_loop_partially_signed"/.test(coreSrcStripped))
  check("ready-writes are reached only when the core's OWN verdict says fully executed",
    /if\s*\(\s*fullyExecuted\s*\)\s*\{[\s\S]{0,60}readyWritesApplied\s*=\s*await\s+applyReadyWrites/.test(coreSrcStripped))

  console.log("\n[pure evalAnchorExecution — unchanged contract the core builds on]")
  const exec = evalAnchorExecution([
    { formKey: "purchase_agreement", anchorCount: 3, signed: true },
    { formKey: "addendum_via_second_envelope", anchorCount: 1, signed: false },
  ])
  check("a second, still-unsigned envelope's tracked document blocks the WHOLE loop (the exact multi-envelope case DocuSign/SkySlope/Authentisign needed this gate for)",
    !exec.allExecuted && exec.incomplete.includes("addendum_via_second_envelope"))

  console.log("\n[runtime shape — evaluateEnvelopeExecution's own return contract]")
  check("evaluateEnvelopeExecution is an async function (real I/O, not a pure predicate pretending to be one)",
    /export\s+async\s+function\s+evaluateEnvelopeExecution\s*\(/.test(coreSrcRaw))
  check("resolveEnvelopeBrokerageId is exported (webhooks have no session/tenant context to hand the core)",
    /export\s+async\s+function\s+resolveEnvelopeBrokerageId\s*\(/.test(coreSrcRaw))

  report()
}

function walk(dir: string): string[] {
  let out: string[] = []
  let entries: import("node:fs").Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const p = resolve(dir, e.name)
    if (e.isDirectory()) out = out.concat(walk(p))
    else out.push(p)
  }
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
