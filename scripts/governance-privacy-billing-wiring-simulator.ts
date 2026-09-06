// scripts/governance-privacy-billing-wiring-simulator.ts
//
// PROOF for the CATEGORY-C governance burn-down: privacy (DSAR), platform
// billing, forms drafts, and vendor contact access.
//
// Run:  npx tsx scripts/governance-privacy-billing-wiring-simulator.ts
//       npx tsx scripts/governance-privacy-billing-wiring-simulator.ts --negative
//
// HOW THIS FILE TRIES NOT TO LIE TO YOU
//   1. Every source is COMMENT-STRIPPED before any scan. A promise written in a
//      comment cannot satisfy a check. There is a self-test for exactly that.
//   2. Checks assert CONSTRUCTS, not spellings: a sliced function body, a sliced
//      insert payload, the ORDER of two branches, the FIRST key of an object.
//      The authorization checks assert "a capability gate and no tenant-role
//      list", not any particular gate spelling.
//   3. Every check is NEGATIVE-TESTED with --negative: real source is mutated on
//      disk, the mutation is proven by sha256, that one check is re-run and must
//      FAIL, then the file is restored and the sha256 verified back.
//   4. The live-database layer is optional and SKIPS LOUDLY. A skip is not a pass.
//
// NOTE ON COMMENT MARKERS: this file never writes a block-comment opener or
// closer inside a string literal. Where one is needed it is built by
// concatenation, so a comment-stripper reading this file cannot swallow it.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

const ROOT = process.cwd()
const NEGATIVE = process.argv.includes("--negative")

// ── files under proof ────────────────────────────────────────────────────────

const F = {
  dsar:        "app/actions/privacy/data-subject-requests.ts",
  dsarPage:    "app/dashboard/admin/privacy/requests/page.tsx",
  dsarActions: "app/dashboard/admin/privacy/requests/dsar-row-actions.tsx",
  billing:     "app/actions/billing.ts",
  forms:       "app/actions/forms-kernel.ts",
  formsFlow:   "app/dashboard/transactions/[id]/components/transaction-form-esign-flow.tsx",
  vendor:      "app/actions/vendor-contact-access.ts",
  vendorPage:  "app/dashboard/vendors/page.tsx",
  vendorPanel: "app/dashboard/vendors/vendor-access-panel.tsx",
  // named survivors the burn-down leans on
  esignRoute:  "app/api/esign/status/[transactionId]/route.ts",
  esignPoller: "app/components/forms/EsignStatusTracker.tsx",
  syncSurvivor:"lib/transactions/sync-from-provider.ts",
  portalDocs:  "app/portal/[contactId]/documents/page.tsx",
  oversight:   "lib/platform/subscription-oversight.ts",
  // The GATED entry point to the oversight roster. The lib loader takes an
  // injected client and cannot hold a session gate, so the gate assertions live
  // here — following the behaviour rather than the old file path.
  oversightAction: "app/actions/superadmin/subscription-oversight.ts",
  oversightPg: "app/dashboard/superadmin/subscriptions/page.tsx",
  tierSurvivor:"app/actions/superadmin/brokerage-management.ts",
  tierSurfUI:  "app/dashboard/superadmin/brokerages/[id]/brokerage-actions.tsx",
  capGate:     "lib/platform/require-capability.ts",
} as const

// ── comment stripping ────────────────────────────────────────────────────────
// A character state machine: it must not strip a comment marker that lives
// inside a string or template literal, and must not treat an apostrophe inside
// a comment as opening a string.

const SLASH = "/"
const STAR = "*"
const BLOCK_OPEN = SLASH + STAR
const BLOCK_CLOSE = STAR + SLASH
const LINE_OPEN = SLASH + SLASH

function stripComments(src: string): string {
  let out = ""
  let i = 0
  const n = src.length
  let quote: string | null = null
  while (i < n) {
    const c = src[i]
    const c2 = src[i] + (src[i + 1] ?? "")
    if (quote) {
      out += c
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue }
    if (c2 === LINE_OPEN) {
      while (i < n && src[i] !== "\n") i++
      continue
    }
    if (c2 === BLOCK_OPEN) {
      i += 2
      while (i < n && src[i] + (src[i + 1] ?? "") !== BLOCK_CLOSE) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

// ── source slicing helpers (constructs, not spellings) ───────────────────────

/** Body of `function NAME(...)`, brace-matched. Empty string when absent. */
function fnBody(src: string, name: string): string {
  const decl = new RegExp(`function\\s+${name}\\s*[(<]`).exec(src)
  if (!decl) return ""
  // 1. walk past the PARAMETER LIST (its own braces, e.g. `params: { a: string }`,
  //    are inside the parens so they cannot be mistaken for the body).
  let i = decl.index
  let paren = 0
  let started = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === "(") { paren++; started = true; continue }
    if (c === ")") { paren--; if (started && paren === 0) { i++; break } }
  }
  if (i >= src.length) return ""
  // 2. walk past the RETURN TYPE. `): Promise<{ ok: boolean }> {` puts a brace at
  //    paren-depth 0 that is NOT the body — it lives inside the angle brackets.
  //    Tracking angle depth is what separates the annotation from the body; without
  //    it every action with a structured return type yielded its own type as its
  //    "body" and every construct check silently passed on an empty string.
  let angle = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === "<") { angle++; continue }
    if (c === ">") { if (src[i - 1] !== "=") angle = Math.max(0, angle - 1); continue }
    if (c === "{" && angle === 0) break
  }
  if (i >= src.length) return ""
  return braceBlock(src, i)
}

/** The `{...}` block starting at index `open`, brace-matched, inclusive. */
function braceBlock(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  return ""
}

/**
 * The object literal passed to `.insert(` or `.update(` for a given table:
 * finds `.from("<table>")`, then the first `.insert(`/`.update(` after it, then
 * brace-matches its first object argument. This is what makes "brokerage_id is
 * the FIRST key of the payload" an assertion about the payload rather than a
 * grep of the file.
 */
function writePayload(src: string, table: string, op: "insert" | "update"): string {
  const needle = `.from("${table}")`
  let from = src.indexOf(needle)
  while (from >= 0) {
    const opIdx = src.indexOf(`.${op}(`, from)
    const nextFrom = src.indexOf(".from(", from + needle.length)
    // TIGHTENED: the write must belong to THIS `.from(...)`. Without this, a
    // `.from("t").select()` earlier in the file would "find" an `.insert(` that
    // actually belongs to a DIFFERENT table further down — which is exactly how
    // the read-gate-table check survived having its table renamed.
    const belongsToThisFrom = opIdx >= 0 && (nextFrom < 0 || opIdx < nextFrom)
    if (belongsToThisFrom) {
      const brace = src.indexOf("{", opIdx)
      if (brace < 0) return ""
      return braceBlock(src, brace)
    }
    // advance to the next occurrence of THIS table, not the next `.from(` of any
    // table — otherwise the scan drifts onto another table's write and reports a
    // payload that has nothing to do with the table asked for.
    from = src.indexOf(needle, from + needle.length)
  }
  return ""
}

/** First key of an object-literal source slice. */
function firstKey(objSrc: string): string | null {
  const m = /\{\s*([A-Za-z_$][\w$]*)\s*:/.exec(objSrc)
  return m ? m[1] : null
}

/**
 * Does the body contain an `if` whose TEST matches `test` and whose CONSEQUENT
 * matches `consequent`? This is the "assert the branch, not the token" tool: a
 * name survives in its declaration even when the branch is gutted.
 */
function hasGuardBranch(body: string, test: RegExp, consequent: RegExp): boolean {
  const re = /\bif\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    // slice the test
    let depth = 0, i = m.index + m[0].length - 1
    for (; i < body.length; i++) {
      if (body[i] === "(") depth++
      else if (body[i] === ")") { depth--; if (depth === 0) break }
    }
    const testSrc = body.slice(m.index, i + 1)
    if (!test.test(testSrc)) continue
    // consequent: either a brace block or a single statement to the next newline
    const after = body.slice(i + 1)
    const braceAt = after.indexOf("{")
    const conseq = braceAt >= 0 && braceAt < 4
      ? braceBlock(after, braceAt)
      : after.slice(0, after.indexOf("\n") + 1 || 200)
    if (consequent.test(conseq)) return true
  }
  return false
}

/** Index of the first match, or Infinity. Used for ORDER assertions. */
function at(body: string, re: RegExp): number {
  const m = re.exec(body)
  return m ? m.index : Number.POSITIVE_INFINITY
}

// ── tenant-role vocabulary (what a platform gate must NOT be) ────────────────
// These are TENANT user_types in this schema. If a cross-tenant reader tests
// membership against any of them, it is a tenant-role list wearing a platform
// gate's name — the exact bug this pass exists to keep out.
const TENANT_ROLE_TOKENS = ["broker", "admin", "broker_admin", "broker_owner", "agent", "team_lead", "tc", "isa"]

function usesTenantRoleList(body: string): boolean {
  // A membership test (`includes(`, `.has(`, `Set([`, array literal) whose
  // neighbourhood carries two or more tenant-role string literals.
  const windows = [...body.matchAll(/(includes\s*\(|\.has\s*\(|\bSet\s*\(\[|\[\s*")/g)]
  for (const w of windows) {
    const slice = body.slice(Math.max(0, w.index! - 200), w.index! + 300)
    const hits = TENANT_ROLE_TOKENS.filter((r) => new RegExp(`["']${r}["']`).test(slice))
    if (hits.length >= 2) return true
  }
  return false
}

// ── check registry ───────────────────────────────────────────────────────────

interface CheckResult { ok: boolean; detail: string }
interface Check {
  id: string
  what: string
  /** file to mutate for the negative test */
  file: string
  /** [findInRealSource, replaceWith] — must be present or the negative test is INCONCLUSIVE */
  mutate: [string, string]
  run: () => CheckResult
}

const src = (rel: string): string => {
  const p = resolve(ROOT, rel)
  if (!existsSync(p)) return ""
  return stripComments(readFileSync(p, "utf8"))
}
const raw = (rel: string): string => {
  const p = resolve(ROOT, rel)
  return existsSync(p) ? readFileSync(p, "utf8") : ""
}

const checks: Check[] = []
const def = (c: Check) => { checks.push(c) }

// ═══ DSAR ════════════════════════════════════════════════════════════════════

def({
  id: "dsar.verify.zero-row-refusal",
  what: "verifyDSARIdentityAction counts matched rows and REFUSES on zero",
  file: F.dsar,
  mutate: ['if ((count ?? 0) === 0) {\n    return { ok: false, error: "No open request matched — it may belong to another brokerage, be unattributed, or already be closed. Nothing was verified." }\n  }', "if (false) { }"],
  run() {
    const b = fnBody(src(F.dsar), "verifyDSARIdentityAction")
    if (!b) return { ok: false, detail: "function body not found" }
    const counted = /\{\s*count\s*:\s*["']exact["']\s*\}/.test(b)
    const branch = hasGuardBranch(b, /count[\s\S]*0/, /return[\s\S]*ok\s*:\s*false/)
    return { ok: counted && branch, detail: `count:"exact"=${counted} refuse-branch=${branch}` }
  },
})

def({
  id: "dsar.verify.method-vocabulary",
  what: "identity method is validated against a fixed vocabulary BEFORE the write",
  file: F.dsar,
  mutate: ["if (!(DSAR_IDENTITY_METHODS as readonly string[]).includes(params.method)) {", "if (false) {"],
  run() {
    const b = fnBody(src(F.dsar), "verifyDSARIdentityAction")
    const guard = hasGuardBranch(b, /includes\s*\(\s*params\.method/, /return[\s\S]*ok\s*:\s*false/)
    const beforeWrite = at(b, /includes\s*\(\s*params\.method/) < at(b, /\.from\(/)
    return { ok: guard && beforeWrite, detail: `guard=${guard} before-write=${beforeWrite}` }
  },
})

def({
  id: "dsar.export.identity-gates-the-read",
  what: "fulfillExportRequestAction refuses on unverified identity BEFORE gathering any subject data",
  file: F.dsar,
  mutate: ['if (!req.identity_verified) return { ok: false, error: "Verify identity before fulfilling export" }', "// gate removed"],
  run() {
    const b = fnBody(src(F.dsar), "fulfillExportRequestAction")
    if (!b) return { ok: false, detail: "function body not found" }
    const gateAt = at(b, /if\s*\(\s*!\s*\w+\.identity_verified\s*\)/)
    // the first data-gathering read of subject records
    const readAt = Math.min(
      at(b, /\.from\(\s*["']contacts["']\s*\)/),
      at(b, /Promise\.all\s*\(\s*\[/),
    )
    const refuses = hasGuardBranch(b, /!\s*\w+\.identity_verified/, /ok\s*:\s*false/)
    return {
      ok: refuses && gateAt < readAt,
      detail: `refuses=${refuses} gateIdx=${gateAt} firstSubjectReadIdx=${readAt}`,
    }
  },
})

def({
  id: "dsar.export.aborts-on-partial-read",
  what: "a failed source aborts the export instead of shipping a short bundle",
  file: F.dsar,
  mutate: ["if (failedSources.length > 0) {", "if (false) {"],
  run() {
    const b = fnBody(src(F.dsar), "fulfillExportRequestAction")
    const branch = hasGuardBranch(b, /failedSources[\s\S]*length/, /return[\s\S]*ok\s*:\s*false/)
    const beforeBundle = at(b, /failedSources\.length\s*>\s*0/) < at(b, /const\s+bundle\s*=/)
    return { ok: branch && beforeBundle, detail: `abort-branch=${branch} before-bundle-built=${beforeBundle}` }
  },
})

def({
  id: "dsar.export.close-out-zero-row-refusal",
  what: "the request is not reported fulfilled unless a row was actually closed",
  file: F.dsar,
  mutate: ['if ((closeCount ?? 0) === 0) {', "if (false) {"],
  run() {
    const b = fnBody(src(F.dsar), "fulfillExportRequestAction")
    const counted = /\{\s*count\s*:\s*["']exact["']\s*\}/.test(b)
    const branch = hasGuardBranch(b, /closeCount[\s\S]*0/, /return[\s\S]*ok\s*:\s*false/)
    return { ok: counted && branch, detail: `count:"exact"=${counted} refuse-branch=${branch}` }
  },
})

def({
  id: "dsar.deny.zero-row-refusal",
  what: "denyDSARRequestAction refuses when no OPEN request matched",
  file: F.dsar,
  mutate: ['if ((count ?? 0) === 0) {\n    return { ok: false, error: "No open request matched — it may belong to another brokerage, be unattributed, or already be closed. Nothing was denied." }\n  }', "if (false) { }"],
  run() {
    const b = fnBody(src(F.dsar), "denyDSARRequestAction")
    const counted = /\{\s*count\s*:\s*["']exact["']\s*\}/.test(b)
    const branch = hasGuardBranch(b, /count[\s\S]*0/, /return[\s\S]*ok\s*:\s*false/)
    return { ok: counted && branch, detail: `count:"exact"=${counted} refuse-branch=${branch}` }
  },
})

def({
  id: "dsar.audit.uses-existing-ledger",
  what: "all three DSAR answers write to the EXISTING audit_log, not a parallel privacy log",
  file: F.dsar,
  mutate: ['action:      "dsar.export_fulfilled",', 'action:      "x",'],
  run() {
    const s = src(F.dsar)
    const bodies = ["verifyDSARIdentityAction", "fulfillExportRequestAction", "denyDSARRequestAction"].map((f) => fnBody(s, f))
    const each = bodies.map((b) => /\.from\(\s*["']audit_log["']\s*\)/.test(b) && /action\s*:\s*["']dsar\./.test(b))
    // and no parallel privacy ledger was invented
    const parallel = /\.from\(\s*["'](?:dsar_audit|privacy_audit|privacy_log)\w*["']\s*\)/.test(s)
    return { ok: each.every(Boolean) && !parallel, detail: `per-action=${each.join(",")} parallel-ledger-invented=${parallel}` }
  },
})

def({
  id: "dsar.wired.queue-page",
  what: "the DSAR queue page renders the three fulfillment capabilities",
  file: F.dsarPage,
  mutate: ["<DSARRowActions", "<Fragment_no_actions"],
  run() {
    const p = src(F.dsarPage)
    const a = src(F.dsarActions)
    const mounted = /<DSARRowActions[\s\S]{0,400}requestId=/.test(p) && /from\s+["']\.\/dsar-row-actions["']/.test(p)
    const importsAll = ["verifyDSARIdentityAction", "fulfillExportRequestAction", "denyDSARRequestAction"]
      .every((n) => new RegExp(`\\b${n}\\b`).test(a))
    // each handler must READ the verdict before its success path
    const readsVerdict = ["handleVerify", "handleExport", "handleDeny"].every((h) => {
      const b = fnBody(a, h)
      return hasGuardBranch(b, /!\s*res\.ok/, /toast\.error|return/) && at(b, /!\s*res\.ok/) < at(b, /toast\.success/)
    })
    return { ok: mounted && importsAll && readsVerdict, detail: `mounted=${mounted} imports=${importsAll} reads-verdict-first=${readsVerdict}` }
  },
})

def({
  id: "dsar.wired.export-hidden-until-verified",
  what: "the Export control is not offered until identity is verified (UI mirrors the server refusal)",
  file: F.dsarActions,
  mutate: ["{identityVerified && EXPORTABLE.has(requestType) && (", "{true && ("],
  run() {
    const a = src(F.dsarActions)
    const guarded = /\{\s*identityVerified\s*&&[\s\S]{0,200}onClick=\{handleExport\}/.test(a)
    return { ok: guarded, detail: `export-button-guarded-by-identityVerified=${guarded}` }
  },
})

// ═══ PLATFORM BILLING ════════════════════════════════════════════════════════

// ═══ PLATFORM BILLING ════════════════════════════════════════════════════════
//
// RETARGETED 2026-09-04 (§2). Eight assertions here pinned the BODIES of
// `getAllBrokeragesBilling`, `getDelinquentAccounts` and `manualTierOverride` in
// app/actions/billing.ts. All three were unwired duplicates, and BURN-C merged
// them onto their named survivors and deleted them — so all eight went red with
// "function body not found", BECAUSE THE MERGE FINISHED. That is the forbidden
// waypoint: an assertion that can only pass while the duplicate exists.
//
// The properties they asserted are REAL INVARIANTS and none is dropped. Each is
// re-aimed at the survivor that now owns the behaviour:
//
//   getAllBrokeragesBilling / getDelinquentAccounts
//     → lib/platform/subscription-oversight.ts:loadSubscriptionOversight,
//       reached through app/actions/superadmin/subscription-oversight.ts, which
//       is where the GATE lives (the lib function is a pure loader taking an
//       injected client, so the gate cannot be in it — the assertion has to
//       follow the gate to the action, not stay where the code used to be).
//   manualTierOverride
//     → app/actions/superadmin/brokerage-management.ts:changeBrokerageTierAction.
//
// The mutations are re-anchored into the survivors too, so each check is still
// PROVED ABLE TO FAIL rather than merely relocated.

def({
  id: "billing.oversight.gate-before-read",
  what: "the cross-tenant subscription roster is gated BEFORE it reads, and the gate is the canonical platform-identity one",
  file: F.oversightAction,
  mutate: ["const auth = await requireSuperadmin()", "const auth = { ok: true as const }"],
  run() {
    const a = src(F.oversightAction)
    const b = fnBody(a, "getSubscriptionOversightAction")
    if (!b) return { ok: false, detail: "getSubscriptionOversightAction not found — the survivor moved" }
    const gateAt   = at(b, /requireSuperadmin\s*\(/)
    const loadAt   = at(b, /loadSubscriptionOversight\s*\(/)
    const branched = hasGuardBranch(b, /!\s*auth\.ok/, /return\s+auth/)
    // The gate must resolve identity through the ONE roster module, not a
    // hand-typed user_type list (§6) — the same property the deleted checks had.
    const canonical = /isPlatformSuperadminIdentity/.test(a)
    const roleList  = usesTenantRoleList(b)
    return {
      ok: gateAt < loadAt && branched && canonical && !roleList,
      detail: `gateIdx=${gateAt} loadIdx=${loadAt} branched=${branched} canonical-identity=${canonical} tenant-role-list=${roleList}`,
    }
  },
})

def({
  id: "billing.oversight.denial-is-not-empty",
  what: "a refused subscription roster is a refusal, never an empty roster",
  file: F.oversightAction,
  mutate: ["if (!auth.ok) return auth", "if (!auth.ok) return { ok: true as const, data: { rows: [] } as any }"],
  run() {
    const a = src(F.oversightAction)
    const b = fnBody(a, "getSubscriptionOversightAction")
    if (!b) return { ok: false, detail: "getSubscriptionOversightAction not found — the survivor moved" }
    const deniesLoudly   = hasGuardBranch(b, /!\s*auth\.ok/, /return\s+auth/)
    // No path may hand back a fabricated empty roster in place of a refusal.
    const fabricatesEmpty = /return\s*\[\s*\]/.test(b) || /rows\s*:\s*\[\s*\]/.test(b)
    const denialBeforeLoad = at(b, /!\s*auth\.ok/) < at(b, /loadSubscriptionOversight\s*\(/)
    return {
      ok: deniesLoudly && !fabricatesEmpty && denialBeforeLoad,
      detail: `denies-loudly=${deniesLoudly} fabricated-empty-roster=${fabricatesEmpty} denial-before-load=${denialBeforeLoad}`,
    }
  },
})

def({
  id: "billing.tier-override.superadmin-only",
  what: "a price change requires a resolved SUPERADMIN, refused before anything is read or written",
  file: F.tierSurvivor,
  mutate: ["const auth = await requireSuperadmin()", "const auth = { ok: true as const, userId: \"x\", email: \"x\" }"],
  run() {
    const b = fnBody(src(F.tierSurvivor), "changeBrokerageTierAction")
    if (!b) return { ok: false, detail: "changeBrokerageTierAction not found — the survivor moved" }
    const gateAt   = at(b, /requireSuperadmin\s*\(/)
    const readAt   = at(b, /\.from\(/)
    const branched = hasGuardBranch(b, /!\s*auth\.ok/, /return\s+auth/)
    // THE AUTHORIZATION DECISION must not consult a hand-typed roster — so the
    // region checked is everything up to the gate's refusal, NOT the whole body.
    //
    // The ancestor of this check asserted "no tenant-role list ANYWHERE in the
    // body", which was true of the deleted duplicate (a pure gated read) and is
    // NOT true of the survivor: at :378 it runs
    // `.in("user_type", ["broker","admin","broker_owner"])` to pick which
    // brokerage admin the AI-entitlement row is attributed to. That is a DATA
    // QUERY a hundred lines after the gate, not an authorization decision, and
    // failing the survivor for it would be pinning the assertion to the deleted
    // function's shape rather than to the rule.
    const gatingRegion = b.slice(0, Math.max(0, at(b, /return\s+auth/)))
    const roleListInGate = usesTenantRoleList(gatingRegion)
    return {
      ok: gateAt < readAt && branched && !roleListInGate,
      detail: `gateIdx=${gateAt} firstReadIdx=${readAt} branched=${branched} role-list-in-gating-region=${roleListInGate}`,
    }
  },
})

def({
  id: "billing.tier-override.who-and-why",
  what: "the price change records WHO did it and WHY, and refuses a blank reason BEFORE writing",
  file: F.tierSurvivor,
  mutate: ["if (tierChangeReason.length < 10) {", "if (false) {"],
  run() {
    const b = fnBody(src(F.tierSurvivor), "changeBrokerageTierAction")
    if (!b) return { ok: false, detail: "changeBrokerageTierAction not found — the survivor moved" }
    const reasonGuard = /tierChangeReason\.length\s*<\s*10/.test(b)
    const beforeWrite = at(b, /tierChangeReason\.length\s*<\s*10/) < at(b, /\.update\(/)
    const auditWho    = /actorUserId:\s*auth\.userId/.test(b)
    const auditWhy    = /reason:\s*tierChangeReason/.test(b)
    // Both the previous and the new tier, or the record cannot say what changed.
    const beforeAfter = /previous_tier:\s*previousTier/.test(b) && /new_tier:\s*params\.newTier/.test(b)
    return {
      ok: reasonGuard && beforeWrite && auditWho && auditWhy && beforeAfter,
      detail: `reason-guard=${reasonGuard} before-write=${beforeWrite} audit.user_id=${auditWho} audit.reason=${auditWhy} before+after=${beforeAfter}`,
    }
  },
})

def({
  id: "billing.tier-override.idempotent",
  what: "re-submitting the same tier is a no-op: no write, no second audit entry",
  file: F.tierSurvivor,
  mutate: ["if (previousTier === params.newTier) return { ok: true, previousTier }", "if (false) return { ok: true, previousTier }"],
  run() {
    const b = fnBody(src(F.tierSurvivor), "changeBrokerageTierAction")
    if (!b) return { ok: false, detail: "changeBrokerageTierAction not found — the survivor moved" }
    const noOpBranch  = /previousTier\s*===\s*params\.newTier/.test(b)
    const beforeUpdate = at(b, /previousTier\s*===\s*params\.newTier/) < at(b, /\.update\(/)
    const beforeAudit  = at(b, /previousTier\s*===\s*params\.newTier/) < at(b, /writeAuditLog\s*\(/)
    return {
      ok: noOpBranch && beforeUpdate && beforeAudit,
      detail: `no-op-branch=${noOpBranch} before-update=${beforeUpdate} before-audit=${beforeAudit}`,
    }
  },
})

def({
  id: "billing.tier-override.write-error-is-read",
  // RETARGETED, AND NARROWED HONESTLY. Its ancestor asserted `count: "exact"` on
  // the tier UPDATE — a zero-row refusal. The survivor does NOT count rows; it
  // reads the brokerage with `.maybeSingle()` and refuses "Brokerage not found"
  // BEFORE updating, then reads the update's own error. That is a different
  // shape, and weaker in one narrow way: a row deleted between the read and the
  // write would update nothing and still report success. Asserting `count` here
  // would fail a survivor nobody has changed, so this asserts what the survivor
  // ACTUALLY guarantees, and the residual gap is written down rather than
  // silently claimed as covered — see lane-BURNC notes.
  what: "the tier write proves the brokerage exists first and READS the update's error (§3 — supabase-js resolves refusals)",
  file: F.tierSurvivor,
  mutate: ["if (error) return { ok: false, error: error.message }", "if (false) return { ok: false, error: error.message }"],
  run() {
    const b = fnBody(src(F.tierSurvivor), "changeBrokerageTierAction")
    if (!b) return { ok: false, detail: "changeBrokerageTierAction not found — the survivor moved" }
    const existenceRefusal = /Brokerage not found/.test(b)
    const existsBeforeWrite = at(b, /Brokerage not found/) < at(b, /\.update\(/)
    const readsUpdateError = /const\s*\{\s*error\s*\}\s*=\s*await\s+svc[\s\S]{0,200}?\.update\(/.test(b)
      && /if\s*\(\s*error\s*\)\s*return\s*\{\s*ok:\s*false/.test(b)
    // And the SECOND write (subscriptions.tier_id) reads its error too — the
    // drift this function documents having closed.
    const readsSyncError = /tierSyncError/.test(b)
    return {
      ok: existenceRefusal && existsBeforeWrite && readsUpdateError && readsSyncError,
      detail: `existence-refusal=${existenceRefusal} exists-before-write=${existsBeforeWrite} update-error-read=${readsUpdateError} tier-sync-error-read=${readsSyncError}`,
    }
  },
})

def({
  id: "billing.not-wired.named-survivors-exist",
  what: "the three platform capabilities are unwired because NAMED wired rivals exist",
  file: F.oversightPg,
  mutate: ["getSubscriptionOversightAction()", "null as any"],
  run() {
    const readRival = /export\s+async\s+function\s+loadSubscriptionOversight/.test(src(F.oversight))
    const readWired = /getSubscriptionOversightAction\s*\(/.test(src(F.oversightPg))
    const writeRival = /export\s+async\s+function\s+changeBrokerageTierAction/.test(src(F.tierSurvivor))
    const writeWired = /changeBrokerageTierAction\s*\(/.test(src(F.tierSurfUI))
    return {
      ok: readRival && readWired && writeRival && writeWired,
      detail: `loadSubscriptionOversight=${readRival} wired=${readWired} changeBrokerageTierAction=${writeRival} wired=${writeWired}`,
    }
  },
})

// ═══ VENDOR CONTACT ACCESS ═══════════════════════════════════════════════════

def({
  id: "vendor.assign.tenant-from-session",
  what: "the grant takes its brokerage from the SESSION, never from the caller's input",
  file: F.vendor,
  mutate: ["brokerage_id:   auth.brokerageId,\n        vendor_id:      input.vendorId,", "brokerage_id:   (input as any).brokerageId,\n        vendor_id:      input.vendorId,"],
  run() {
    const b = fnBody(src(F.vendor), "assignVendorToContactAction")
    if (!b) return { ok: false, detail: "function body not found" }
    const fromInput = /input\s*(?:as\s+any\s*)?\)?\.\s*brokerage_?[Ii]d/.test(b) || /\(input as any\)\.brokerageId/.test(b)
    const fromSession = /auth\.brokerageId/.test(b)
    return { ok: fromSession && !fromInput, detail: `session-derived=${fromSession} caller-supplied-tenant=${fromInput}` }
  },
})

def({
  id: "vendor.assign.both-sides-scoped",
  what: "vendor AND contact are each verified to belong to the caller's brokerage",
  file: F.vendor,
  mutate: ['if (contact.brokerage_id !== auth.brokerageId) return { ok: false, error: "Contact belongs to another brokerage" }', "// contact scope check removed"],
  run() {
    const b = fnBody(src(F.vendor), "assignVendorToContactAction")
    const v = hasGuardBranch(b, /vendor\.brokerage_id\s*!==\s*auth\.brokerageId/, /ok\s*:\s*false/)
    const c = hasGuardBranch(b, /contact\.brokerage_id\s*!==\s*auth\.brokerageId/, /ok\s*:\s*false/)
    const beforeWrite = Math.max(
      at(b, /vendor\.brokerage_id\s*!==/), at(b, /contact\.brokerage_id\s*!==/),
    ) < at(b, /\.insert\(/)
    return { ok: v && c && beforeWrite, detail: `vendor-scoped=${v} contact-scoped=${c} before-write=${beforeWrite}` }
  },
})

def({
  id: "vendor.assign.tenant-stamp-first",
  what: "brokerage_id is the FIRST key of the vendor_contact_assignments insert payload",
  file: F.vendor,
  mutate: ["brokerage_id:   auth.brokerageId,\n        vendor_id:      input.vendorId,\n        contact_id:     input.contactId,", "vendor_id:      input.vendorId,\n        contact_id:     input.contactId,\n        brokerage_id:   auth.brokerageId,"],
  run() {
    const p = writePayload(src(F.vendor), "vendor_contact_assignments", "insert")
    if (!p) return { ok: false, detail: "insert payload not found" }
    const k = firstKey(p)
    return { ok: k === "brokerage_id", detail: `firstKey=${k}` }
  },
})

def({
  id: "vendor.assign.null-transaction-uses-is-null",
  what: "the reactivate lookup uses IS NULL for a contact-level grant (eq.null matches nothing)",
  file: F.vendor,
  mutate: ['existingQ.is("transaction_id", null)', 'existingQ.eq("transaction_id", null as any)'],
  run() {
    const b = fnBody(src(F.vendor), "assignVendorToContactAction")
    const isNull = /\.is\(\s*["']transaction_id["']\s*,\s*null\s*\)/.test(b)
    const eqNull = /\.eq\(\s*["']transaction_id["']\s*,\s*(?:null|input\.transactionId\s*\?\?\s*null)/.test(b)
    return { ok: isNull && !eqNull, detail: `is-null=${isNull} eq-null-present=${eqNull}` }
  },
})

def({
  id: "vendor.assign.scope-vocabulary",
  what: "scope is validated against the live CHECK vocabulary before any write",
  file: F.vendor,
  mutate: ["if (!(VENDOR_ACCESS_SCOPES as readonly string[]).includes(scope)) {", "if (false) {"],
  run() {
    const s = src(F.vendor)
    const b = fnBody(s, "assignVendorToContactAction")
    const guard = hasGuardBranch(b, /includes\s*\(\s*scope\s*\)/, /return[\s\S]*ok\s*:\s*false/)
    const beforeWrite = at(b, /includes\s*\(\s*scope\s*\)/) < at(b, /\.insert\(/)
    // the vocabulary itself must be the four values the column accepts
    const vocab = /VENDOR_ACCESS_SCOPES\s*=\s*\[([\s\S]*?)\]/.exec(s)?.[1] ?? ""
    const complete = ["pii_basic", "pii_full", "transaction_docs", "financial"].every((v) => vocab.includes(`"${v}"`))
    const noExtras = (vocab.match(/"/g)?.length ?? 0) === 8
    return { ok: guard && beforeWrite && complete && noExtras, detail: `guard=${guard} before-write=${beforeWrite} vocab-complete=${complete} no-extra-values=${noExtras}` }
  },
})

def({
  id: "vendor.revoke.zero-row-refusal",
  what: "A REVOKE THAT MATCHED NO ROW MUST NOT REPORT SUCCESS",
  file: F.vendor,
  mutate: ["if ((count ?? 0) === 0) {\n    return {\n      ok: false,", "if (false) {\n    return {\n      ok: false,"],
  run() {
    const b = fnBody(src(F.vendor), "revokeVendorContactAccessAction")
    if (!b) return { ok: false, detail: "function body not found" }
    const counted = /\.update\(\s*\{[\s\S]*?\}\s*,\s*\{\s*count\s*:\s*["']exact["']/.test(b)
    const branch = hasGuardBranch(b, /count[\s\S]*0/, /ok\s*:\s*false/)
    const scoped = /\.eq\(\s*["']brokerage_id["']\s*,\s*auth\.brokerageId\s*\)/.test(b)
      && /\.eq\(\s*["']status["']\s*,\s*["']active["']\s*\)/.test(b)
    return { ok: counted && branch && scoped, detail: `count:"exact"=${counted} refuse-branch=${branch} tenant+active-scoped=${scoped}` }
  },
})

def({
  id: "vendor.audit.grant-and-revoke",
  what: "granting and revoking access to a client's PII are both written to audit_log",
  file: F.vendor,
  mutate: ['action:      "vendor_contact_access.revoked",', 'action:      "x",'],
  run() {
    const s = src(F.vendor)
    const g = fnBody(s, "assignVendorToContactAction")
    const r = fnBody(s, "revokeVendorContactAccessAction")
    const gOk = /\.from\(\s*["']audit_log["']\s*\)/.test(g) && /action\s*:\s*["']vendor_contact_access\.granted["']/.test(g)
    const rOk = /\.from\(\s*["']audit_log["']\s*\)/.test(r) && /action\s*:\s*["']vendor_contact_access\.revoked["']/.test(r)
    // tenant on the audit payload leads the object
    const gPayload = writePayload(g, "audit_log", "insert")
    const tenantFirstIsh = /\bafter\s*:\s*\{\s*brokerage_id\s*:/.test(gPayload)
    return { ok: gOk && rOk && tenantFirstIsh, detail: `grant-audited=${gOk} revoke-audited=${rOk} tenant-leads-payload=${tenantFirstIsh}` }
  },
})

def({
  id: "vendor.wired.access-panel",
  what: "the vendors page renders grant/revoke/list, and the panel reads each verdict",
  file: F.vendorPage,
  mutate: ["<VendorAccessPanel", "<Fragment_no_panel"],
  run() {
    const p = src(F.vendorPage)
    const panel = src(F.vendorPanel)
    const listed = /listVendorAssignmentsForBrokerageAction\s*\(/.test(p)
    const mounted = /<VendorAccessPanel[\s\S]{0,400}assignments=/.test(p)
    const importsWrites = /assignVendorToContactAction/.test(panel) && /revokeVendorContactAccessAction/.test(panel)
    const readsVerdict = ["handleGrant", "handleRevoke"].every((h) => {
      const b = fnBody(panel, h)
      return hasGuardBranch(b, /!\s*res\.ok/, /toast\.error|return/) && at(b, /!\s*res\.ok/) < at(b, /toast\.success/)
    })
    // a load failure must not render as "no grants exist"
    const honestEmpty = /loadError/.test(p) && /loadError\s*\?/.test(panel)
    return {
      ok: listed && mounted && importsWrites && readsVerdict && honestEmpty,
      detail: `list-wired=${listed} panel-mounted=${mounted} write-actions-imported=${importsWrites} reads-verdict-first=${readsVerdict} honest-empty=${honestEmpty}`,
    }
  },
})

def({
  id: "vendor.wired.read-gate-still-owns-access",
  what: "the wired writer feeds the SAME table the pre-existing read gate enforces",
  file: F.vendor,
  mutate: ['.from("vendor_contact_assignments")\n      .insert({', '.from("vendor_contact_assignments_v2")\n      .insert({'],
  run() {
    const gate = src("lib/vendor/assignment-access.ts")
    const gateReads = /\.from\(\s*["']vendor_contact_assignments["']\s*\)/.test(gate)
    const writerWrites = !!writePayload(src(F.vendor), "vendor_contact_assignments", "insert")
    return { ok: gateReads && writerWrites, detail: `read-gate-table=${gateReads} writer-same-table=${writerWrites}` }
  },
})

// ═══ FORMS ═══════════════════════════════════════════════════════════════════

def({
  id: "forms.loadFormDraft.wired-and-wins",
  what: "a saved draft is restored and OVERRIDES the context prefill",
  file: F.formsFlow,
  mutate: ["fields = { ...fields, ...(draft.field_values ?? {}) }", "fields = { ...fields }"],
  run() {
    const f = src(F.formsFlow)
    const imported = /loadFormDraftAction/.test(f)
    const called = /loadFormDraftAction\s*\(/.test(f)
    // ORDER: the draft merge must come AFTER the context prefill assignment
    const prefillAt = at(f, /res\.data\.prefill\?\.fields/)
    const draftAt = at(f, /draft\.field_values/)
    const draftWins = /\.\.\.\s*fields\s*,\s*\.\.\.\s*\(?\s*draft\.field_values/.test(f)
    const adoptsId = /setFormSubmissionId\s*\(\s*draft\.id/.test(f)
    return {
      ok: imported && called && draftAt > prefillAt && draftWins && adoptsId,
      detail: `imported=${imported} called=${called} prefillIdx=${prefillAt} draftIdx=${draftAt} draft-spread-last=${draftWins} adopts-draft-id=${adoptsId}`,
    }
  },
})

def({
  id: "forms.getEsignStatusAction.deleted-with-live-duplicate",
  what: "the deleted pass-through has a wired, more complete duplicate reaching the same kernel function",
  file: F.forms,
  mutate: ["export async function syncEsignDocsAction(input: {", "export async function getEsignStatusAction(x: any) { return getEsignStatus(x) }\nexport async function syncEsignDocsAction(input: {"],
  run() {
    const gone = !/\bgetEsignStatusAction\b/.test(src(F.forms))
    const route = src(F.esignRoute)
    const routeDelegates = /from\s+["']@\/lib\/kernel\/forms["']/.test(route) && /getEsignStatus\s*\(/.test(route)
    const routeWired = /\/api\/esign\/status\//.test(src(F.esignPoller))
    const pollerMounted = /EsignStatusTracker/.test(src("app/portal/[contactId]/offers/page.tsx"))
    return {
      ok: gone && routeDelegates && routeWired && pollerMounted,
      detail: `symbol-gone=${gone} route-delegates-to-kernel=${routeDelegates} poller-hits-route=${routeWired} poller-mounted=${pollerMounted}`,
    }
  },
})

def({
  id: "forms.syncEsignDocs.kept-with-named-survivor",
  what: "syncEsignDocsAction is kept (not deleted) and its named more complete survivor is wired",
  file: F.syncSurvivor,
  mutate: ["export async function syncTransactionDocumentsFromProvider(", "async function __disabled("],
  run() {
    const stillThere = /export\s+async\s+function\s+syncEsignDocsAction/.test(src(F.forms))
    const survivor = src(F.syncSurvivor)
    const survivorExists = /export\s+async\s+function\s+syncTransactionDocumentsFromProvider/.test(survivor)
    // the survivor is MORE complete: it persists what the kept wrapper only returns
    const survivorPersists = /\.from\(\s*["']transaction_documents["']\s*\)/.test(survivor) && /\.upsert\(/.test(survivor)
    const survivorWired = /sync-from-provider/.test(src(F.portalDocs))
    return {
      ok: stillThere && survivorExists && survivorPersists && survivorWired,
      detail: `wrapper-kept=${stillThere} survivor-exists=${survivorExists} survivor-persists=${survivorPersists} survivor-wired=${survivorWired}`,
    }
  },
})

// ═══ SELF-TEST: a comment cannot satisfy a check ═════════════════════════════

function selfTest(): { ok: boolean; detail: string } {
  const commented =
    `${BLOCK_OPEN} export async function ghostAction() { const x = { count: "exact" } } ${BLOCK_CLOSE}\n` +
    `${LINE_OPEN} if ((count ?? 0) === 0) return { ok: false }\n` +
    `export async function realAction() { return 1 }\n`
  const stripped = stripComments(commented)
  const ghostSurvives = /ghostAction/.test(stripped)
  const guardSurvives = /count \?\? 0/.test(stripped)
  const realSurvives = /realAction/.test(stripped)

  // and a marker inside a STRING must survive stripping
  const inString = `const s = "${BLOCK_OPEN} not a comment ${BLOCK_CLOSE}"; const t = 1`
  const strKept = stripComments(inString).includes("not a comment")

  // the branch helper must reject a gutted branch that still mentions the token
  const gutted = `function f() { const count = 1; if (false) { } return { ok: true } }`
  const guttedRejected = !hasGuardBranch(fnBody(gutted, "f"), /count[\s\S]*0/, /ok\s*:\s*false/)

  // fnBody must return the BODY, not a structured return-type annotation. When it
  // returned the annotation, every construct check ran against an empty-ish string
  // and reported a confident FAIL/PASS about source it had never read.
  const rt = `async function g(p: { a: string }): Promise<{ ok: boolean; error?: string }> { const count = 0; if ((count ?? 0) === 0) { return { ok: false } } return { ok: true } }`
  const rtBody = fnBody(rt, "g")
  const bodyNotAnnotation = /return\s*\{\s*ok:\s*true/.test(rtBody) && hasGuardBranch(rtBody, /count[\s\S]*0/, /ok\s*:\s*false/)

  const ok = !ghostSurvives && !guardSurvives && realSurvives && strKept && guttedRejected && bodyNotAnnotation
  return {
    ok,
    detail: `comment-fn-stripped=${!ghostSurvives} comment-guard-stripped=${!guardSurvives} real-code-kept=${realSurvives} string-marker-kept=${strKept} gutted-branch-rejected=${guttedRejected} body-not-return-type=${bodyNotAnnotation}`,
  }
}

// ═══ LIVE LAYER (optional, skips loudly) ═════════════════════════════════════

async function liveLayer(): Promise<{ ran: boolean; lines: string[] }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return {
      ran: false,
      lines: [
        "LIVE LAYER SKIPPED — NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.",
        "A SKIP IS NOT A PASS. The vocabulary and nullability assertions below were",
        "verified against the live database by hand during authoring; without creds",
        "this run proves the SOURCE constructs only.",
      ],
    }
  }
  const lines: string[] = []
  try {
    const { createClient } = await import("@supabase/supabase-js")
    const db = createClient(url, key)
    for (const t of ["data_subject_requests", "vendor_contact_assignments", "audit_log", "subscription_tiers"]) {
      const { error } = await db.from(t).select("*", { count: "exact", head: true })
      lines.push(`  ${error ? "FAIL" : "ok  "} table reachable: ${t}${error ? ` — ${error.message}` : ""}`)
    }
    return { ran: true, lines }
  } catch (e: any) {
    return { ran: false, lines: [`LIVE LAYER SKIPPED — ${e?.message ?? e}. A SKIP IS NOT A PASS.`] }
  }
}

// ═══ NEGATIVE TESTING ════════════════════════════════════════════════════════

function sha(rel: string): string {
  return createHash("sha256").update(raw(rel)).digest("hex").slice(0, 16)
}

interface NegResult { id: string; verdict: "PROVEN" | "INCONCLUSIVE" | "WORTHLESS"; note: string }

function negativeTest(c: Check): NegResult {
  const path = resolve(ROOT, c.file)
  const before = readFileSync(path, "utf8")
  const shaBefore = sha(c.file)
  const [find, replace] = c.mutate

  if (!before.includes(find)) {
    return { id: c.id, verdict: "INCONCLUSIVE", note: `mutation anchor not found in ${c.file} — cannot prove this check can fail` }
  }
  if (!c.run().ok) {
    return { id: c.id, verdict: "INCONCLUSIVE", note: "check already failing before mutation" }
  }

  writeFileSync(path, before.replace(find, replace), "utf8")
  const shaMutated = sha(c.file)
  if (shaMutated === shaBefore) {
    writeFileSync(path, before, "utf8")
    return { id: c.id, verdict: "INCONCLUSIVE", note: "mutation did not change the file (sha256 unchanged)" }
  }

  const failedUnderMutation = !c.run().ok

  writeFileSync(path, before, "utf8")
  const shaRestored = sha(c.file)
  const restored = shaRestored === shaBefore

  if (!restored) {
    return { id: c.id, verdict: "INCONCLUSIVE", note: `RESTORE FAILED — ${c.file} sha ${shaBefore} -> ${shaRestored}` }
  }
  return failedUnderMutation
    ? { id: c.id, verdict: "PROVEN", note: `sha ${shaBefore} -> ${shaMutated} -> ${shaRestored}` }
    : { id: c.id, verdict: "WORTHLESS", note: "check still passed with the construct removed — TIGHTEN IT" }
}

// ═══ MAIN ════════════════════════════════════════════════════════════════════

async function main() {
  console.log("")
  console.log("GOVERNANCE / PRIVACY / BILLING / VENDOR-ACCESS WIRING PROOF")
  console.log("=".repeat(78))

  const st = selfTest()
  console.log(`\n[self-test] comment-stripper + branch-assertion`)
  console.log(`  ${st.ok ? "PASS" : "FAIL"}  ${st.detail}`)
  if (!st.ok) {
    console.log("\nSELF-TEST FAILED — every other result in this run is untrustworthy.")
    process.exit(1)
  }

  console.log(`\n[assertions] ${checks.length} checks`)
  console.log("-".repeat(78))
  let failed = 0
  for (const c of checks) {
    const r = c.run()
    if (!r.ok) failed++
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${c.id}`)
    console.log(`        ${c.what}`)
    console.log(`        ${r.detail}`)
  }

  const live = await liveLayer()
  console.log(`\n[live database]`)
  for (const l of live.lines) console.log(`  ${l}`)

  let negLines: NegResult[] = []
  if (NEGATIVE) {
    console.log(`\n[negative tests] mutate real source, prove by sha256, re-run, restore`)
    console.log("-".repeat(78))
    for (const c of checks) {
      const n = negativeTest(c)
      negLines.push(n)
      console.log(`  ${n.verdict.padEnd(12)} ${n.id}`)
      console.log(`        ${n.note}`)
    }
  } else {
    console.log(`\n[negative tests] not run — pass --negative to mutate real source and prove each check can fail.`)
  }

  console.log("\n" + "=".repeat(78))
  console.log(`assertions: ${checks.length}   failed: ${failed}`)
  if (NEGATIVE) {
    const proven = negLines.filter((n) => n.verdict === "PROVEN").length
    const worthless = negLines.filter((n) => n.verdict === "WORTHLESS").length
    const inconclusive = negLines.filter((n) => n.verdict === "INCONCLUSIVE").length
    console.log(`negative: PROVEN ${proven}  WORTHLESS ${worthless}  INCONCLUSIVE ${inconclusive}`)
    if (worthless > 0) console.log("A WORTHLESS check must be tightened — it cannot be made to fail.")
    if (failed > 0 || worthless > 0) process.exit(1)
  } else if (failed > 0) {
    process.exit(1)
  }
  if (!live.ran) console.log("live layer: SKIPPED (a skip is not a pass)")
  console.log("")
}

main().catch((e) => { console.error(e); process.exit(1) })
