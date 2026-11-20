#!/usr/bin/env tsx
// scripts/os-coverage-ledger.ts — `test:os-coverage-ledger` (wave 154, lane 154A1; directive A2, A6 items 1/2/5/6, A7.1, A7.2, A7.4)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Owner ruling R7 (2026-11-17): "the arbiter completion was only what it already built and not auditing the complete os from the
// platform down to the prospects/tenants such as the system wide kernel/arbiter." Wave 153 certified arbitration from a manager
// registry and 33 policy questions. This file is the OS ARBITRATION AND AUTONOMY COVERAGE LEDGER: ONE ROW PER REAL EXECUTABLE
// ACTION, derived by TRAVERSING THE CODE — nothing in a row is typed here.
//
// POPULATIONS (every one READ from its registry or from the tree; the denominators are printed):
//   cron            lib/kernel/cron-dispatch.ts CRON_REGISTRY (driven by vercel.json's one dispatcher cron) + every app/api/cron/**
//                   route the registry does NOT schedule (a worker with no trigger)
//   kernel_event    lib/kernel/events.ts KernelEvent — emitters (emitKernelEvent call sites) and handlers (event-reactor / fanout)
//   orchestrator    lib/orchestrator/internal.ts EVENT_HANDLERS — the second event vocabulary (lib/events/types.ts EVENT_TYPES)
//   manager_signal  lib/kernel/signal-registry.ts SIGNAL_REGISTRY — publishers (publishManagerSignal) and SIGNAL_HANDLERS consumers
//   capability      lib/agentic-os/app-capability-registry.ts buildFullActionManifest (the MCP + REST agentic surface) with
//                   capability-ownership.ts CAPABILITY_MANAGER and the routes' executor maps
//   assistant_tool  lib/voice/tool-registry.ts voiceTools + VOICE_TOOL_MANAGER, executed by app/api/agent-assistant/tool-call
//   provider_egress lib/providers/dispatch.ts exported dispatch* doors
//   webhook         app/api route files on a provider callback path
//   http            every other app/api route exporting POST / PUT / PATCH / DELETE
//   server_action   every CONSEQUENTIAL export of a "use server" module (a write or an egress on its own path); read-only exports
//                   are counted in the denominator, not made rows
//
// PER ROW (directive A7.2, mapped onto real repo types): domain · entrypoint file:line · trigger_kind · source_event · actor ·
// tenant_scope · subject · typed_action · decision_owner · registered_manager · worker · policy_gate · consent · budget ·
// dependencies · deadline · writer · receipt · readback · downstream_trigger · recovery · operator_surface · test · state.
// A field that cannot be derived is the literal `unresolved: <reason>` — never a guess, never an invented manager key.
//
// HOW A PATH IS READ (CLAUDE.md §2): every token is matched on blankStrings() output (a word in a string or a tombstone is not a
// call); table names and import specifiers on blankComments() output (strings kept, comments blank, offsets intact). A path is
// the entry span (the route file / the export body + its same-file callees / the reactor block / the tool's case) plus the
// whole-file facts of every local module that span actually references (ONE hop).
//
// THE TOKEN VOCABULARIES ARE NOT RETYPED: the plane / next / recovery / outcome / write / read regexes are evaluated out of
// scripts/manager-ownership-matrix-guard.ts (wave 153 §H census) and the ledger doors out of scripts/action-evidence-census.ts
// (DOOR_TOKENS), the session tokens come from scripts/session-tokens.ts, the egress doors are the exports of
// lib/providers/dispatch.ts, the live tables from scripts/live-tables.ts. Each loaded vocabulary has a positive control.
//
// STATE, BY RULE (state()):  missing — no trigger reaches it, or no worker executes it;  working — trigger + worker and, when the
// action is CONSEQUENTIAL (writes / egress / a mutating capability / a non-READ tool), a registered owner, a decision owner, evidence
// and a readback;  partial — anything between;  owner-held — listed in OWNER_HELD with the reason.
//
// THE GUARD (A7.4): it FAILS when a registered executable path lacks an owner, a decision owner, a trigger, a worker, evidence or a
// readback (or names a table that is not live) and is neither OWNER_HELD nor a frozen gap in scripts/os-coverage-ledger-baseline.json
// with exactly those missing links (the baseline only tightens: a gap that closes is pruned by --write-baseline, a new gap is red).
// A planted fixture (a cron with no owner and no route; a "use server" fixture whose ledger call is only in a comment and a string)
// must be flagged, or the guard itself is broken.
//
// WAVE 155 (lane 155B1, directive B1 / B4): every open row is CLASSIFIED by rule (classify(): EXECUTABLE_GAP · DECLARATIVE_READ_ONLY ·
// LEGACY_ORPHAN · SIMULATED_ONLY · OWNER_HELD · UNKNOWN), each EXECUTABLE_GAP gets ONE root-cause group (GROUPS — the shared door
// that closes it) and a risk class (P0 money / credentials / legal / send / paid acquisition · P1 customer-facing · P2 internal).
// These are ADDITIONAL columns: they never feed state() and never widen the baseline. The summary is checked in
// (docs/architecture/os-arbitration-gap-groups.json); THE RATCHET (ratchet()) also fails a NEW P0 executable gap (the frozen
// `p0ExecutableGaps` list), a read-only row with a write / send / spend on its path, a classified working row (an UNKNOWN counted
// as working), an ungrouped gap and an owner outside MANAGERS — each with a planted positive control (section F).
//
// Run:  npx tsx scripts/os-coverage-ledger.ts              (check: rules + the generated docs agree with the code)
//       npx tsx scripts/os-coverage-ledger.ts --write      (emit docs/architecture/OS-ARBITRATION-COVERAGE.md, the CHECKED document, and the
//                                                           machine-readable twin coverage/os-arbitration-coverage.json — an ON-DEMAND
//                                                           artifact outside git: `/coverage` is git-ignored, the run regenerates it in seconds)
//       npx tsx scripts/os-coverage-ledger.ts --json      (write ONLY the on-demand JSON artifact, nothing checked in changes)
//       npx tsx scripts/os-coverage-ledger.ts --write-baseline   (integrator: create, or PRUNE-only tighten, the frozen-gap baseline)
// Summary line: `RESULT: N passed, M failed`.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { join, dirname, normalize } from "node:path"
import { tmpdir } from "node:os"
import { registerHooks } from "node:module"
import { blankComments, blankStrings, stringLiterals, stripComments } from "./strip-comments"
import { EVENT_OWNER_HELD, conditionalAuditVerified } from "./event-claims-ledger"
import { runtimeFiles } from "./runtime-roots"
import { SESSION_TOKENS, hasUseServerDirective } from "./session-tokens"
import { LIVE_TABLES } from "./live-tables"
import { memSupabase } from "./in-memory-supabase"

// ── only the service-client constructor and `server-only` are replaced (the registries are imported for real) ──
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('os-coverage-ledger: no database in the census') }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const ROOT = process.cwd()
const WRITE = process.argv.includes("--write")
const WRITE_BASELINE = process.argv.includes("--write-baseline")
const DOC_MD = "docs/architecture/OS-ARBITRATION-COVERAGE.md"
// WAVE 154 (lane 154A3): the per-row JSON (~5.6 MB, one row per line) changed on every run and was never read by anything but a
// person or a script. It is an ON-DEMAND ARTIFACT now, written OUTSIDE git (`/coverage` is in .gitignore) by --write / --json.
// What is CHECKED is the committed Markdown (rendering of the code, line anchors excluded) and the frozen-gap baseline.
const DOC_JSON = "coverage/os-arbitration-coverage.json"
const WRITE_JSON = WRITE || process.argv.includes("--json")
const BASELINE_FILE = "scripts/os-coverage-ledger-baseline.json"
/** WAVE 155 (lane 155B1): the CHECKED-IN classification summary (groups, counts, classifications by domain — small). */
const DOC_GROUPS = "docs/architecture/os-arbitration-gap-groups.json"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const U = (why: string) => `unresolved: ${why}`

// ══ OWNER-HELD — a path that is deliberately not autonomous, with the owner's reason. Each entry must still be a row. ══
const OWNER_HELD: Record<string, string> = {
  // WAVE 154 (lane 154A3). Lane 154E moved the referral reward onto a PROVEN close (lib/gamification/lifecycle-awards.ts: the
  // award runs only when a closed / funded transaction evidences the won referral — referralEvidenceTransaction). Giving the
  // event a consumer closed its frozen `worker` gap and exposed the next link: the deciding rule is a deterministic evidence
  // read by the registered manager (recruiting_manager), not a named gate token. Whether a registered manager's deterministic
  // rule counts as the decision owner is the OWNER's question (lane 154A1 owner decision 2: 538 autonomously triggered rows
  // carry no named gate) — held here, with this reason, until the owner rules; never frozen by widening the baseline.
  // WAVE 155 (lane 155R16, folding lane 155R18 request B1 — exact line from its notes): no caller in app/ lib/ scripts/
  // (app/newsletters/newsletters-client.tsx and marketing-studio-client.tsx say why NOT to call it); the scheduled path's survivor is
  // app/api/cron/send-email-campaigns; scripts/orphan-export-guard.ts already lists it as owner-ruled.
  "server_action:app/actions/email-campaigns.ts#sendEmailCampaign": "@ownerRuled documented-hold — manual counterpart of the send-email-campaigns cron, waiting on an email-campaign management surface (email-campaigns.ts:454)",
  // WAVE 155 (lane 155R20 request R2, applied by the integrator): four rows whose owner the census rule cannot derive. Each is
  // dispositioned in scripts/owner-resolution-guard.ts §D with a reference owner; whether that reference IS the owner is the
  // owner's ruling (lane 155R18 owner decision 3), so they are held with the question — never frozen into the baseline.
  "server_action:app/actions/content-compliance.ts#evaluateCompliance": "owner-held pending owner decision: compliance_events is GENERIC for ownership (lane 155R16) so a gated draft is not compliance_officer's — but is an EXPLICIT compliance evaluation the user asked for? reference owner compliance_officer (scripts/owner-resolution-guard.ts §D)",
  "server_action:app/actions/content-compliance.ts#batchEvaluate": "owner-held pending the same owner decision as evaluateCompliance (an explicit compliance evaluation; reference owner compliance_officer)",
  "server_action:app/actions/communications.ts#draftTeamAnnouncementAction": "owner-held pending owner decision 3 (lane 155R18): a model draft returned to the composer, writing only api_response_logs telemetry — reference owner recruiting_manager (its sibling notifyBrokerageAgentsAction reads teams)",
  "server_action:app/actions/twin-scenario.ts#simulateTwinScenario": "owner-held pending the own-span rule: it writes only its own evidence row; the twin it projects is read inside the same-file helper project() → readBrokerageTwin — reference owner data_steward (brokerage_twin_snapshots)",
  // WAVE 155 (integrator): THE OTHER LIFECYCLE AWARDS ASK THE SAME QUESTION. These nine events are consumed by the ONE award trigger
  // (lib/kernel/event-reactor.ts, block L6 → awardLifecycleMilestones), exactly as referral_converted is: whether an award is made
  // is decided by LIFECYCLE_AWARD_RULES — a deterministic evidence rule under recruiting_manager, not a named gate token. They were
  // open and unfrozen since the census was corrected (lane 155R16 listed them as unresolved); the fan-out's autonomy halt
  // (lane 155R20) holds their reactor block but is not the award rule. One owner question (decision 2), ten rows; held with it.
  "kernel_event:agent_work_anniversary": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:buyer_broker_agreement_signed": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:ce_completed": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:competency_improved": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:lifetime_customer": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:lifetime_customer_touchpoint_sent": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:mentor_session_held": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:user_onboarding_completed": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "kernel_event:user_onboarding_step_completed": "owner-held pending owner decision 2 (the same question as referral_converted): the award is decided by LIFECYCLE_AWARD_RULES through the one award trigger under recruiting_manager — a rule, not a named gate token",
  "orchestrator_event:transaction.contingency_cleared": "owner-held pending owner decision (lane 155R24): build or retire? Nothing produces the moment — no writer of transactions.*_contingency_removed_at, no trigger, no catalog milestone; the consumer is kept dormant (nothing runs)",
  "orchestrator_event:transaction.closing_soon": "owner-held pending owner decision (lane 155R24): build or retire? A closing gift (closing_gifts.price_cents) is spend; the producer would be the deadline watcher's close-date approach; kept dormant (nothing runs) until the gift policy is ruled",
  "kernel_event:referral_converted": "owner-held pending owner decision 2 (does a registered manager's deterministic evidence rule count as the decision owner?): the award is decided by referralEvidenceTransaction (a closed/funded transaction must evidence the won referral) under recruiting_manager — a rule, not a named gate token",
}
/** Set by the census: manifest capabilities that are discoverable but not callable over MCP / REST (published, not rows). */
let capabilityCatalogOnly = 0

// ══ 1. SOURCE VIEWS (one scanner — CLAUDE.md §2) ═════════════════════════════════════════════════════════════════════════
// Kept per file: the blankStrings() view (tokens), the line index, every `.from("<table>")` literal with the 64 characters of
// COMMENT-BLANKED code after it (the reused WRITE / READ / NEXT / RECOVERY regexes read table names there and nowhere else), the
// offsets of the literal "brokerage_id" / "platform_role", and the import edges. The comment-blanked view itself is transient
// (codeOf) — holding both full views of 76 MB of source cost ~1.9 GB RSS on the first measurement.
interface FromLit { at: number; text: string }
interface Views { ids: string; lineStarts: Int32Array; froms: FromLit[]; brokerageAt: number[]; platformAt: number[]; useServer: boolean
  /** WAVE 155 (lane 155R16): offsets of `.eq("<…_token|token_hash>"` — a grant looked up by its token (comment-blanked view) */
  tokenEqAt?: number[] }
const viewCache = new Map<string, Views | null>()
/** a grant row looked up by its token column (lane 155R16, the verified-grant-token door — see grantTokenIn) */
const TOKEN_EQ_RE = /\.eq\(\s*["'`](?:[a-z_]*_)?token(?:_hash)?["'`]/g
function rawOf(file: string): string { try { return readFileSync(join(ROOT, file), "utf8") } catch { return "" } }
const fresh = (s: string): string => JSON.parse(JSON.stringify(s)) as string // a copy that does not pin its parent string
function codeOf(file: string, rawText?: string): string { const raw = rawText ?? rawOf(file); return raw ? blankComments(raw) : "" }
function views(file: string, rawText?: string): Views | null {
  if (rawText === undefined && viewCache.has(file)) return viewCache.get(file)!
  const raw = rawText ?? rawOf(file)
  if (!raw) { viewCache.set(file, null); return null }
  const code = blankComments(raw)
  const ids = blankStrings(raw)
  const starts: number[] = [0]
  for (let i = 0; i < ids.length; i++) if (ids.charCodeAt(i) === 10) starts.push(i + 1)
  const froms: FromLit[] = []
  for (const m of code.matchAll(/\.from\(\s*["'`][a-z_][a-z0-9_]*["'`]/g)) froms.push({ at: m.index!, text: fresh(code.slice(m.index!, m.index! + m[0].length + 64)) })
  const brokerageAt = [...code.matchAll(/["']brokerage_id["']/g)].map((m) => m.index!)
  const platformAt = [...code.matchAll(/["']platform_role["']/g)].map((m) => m.index!)
  const tokenEqAt = [...code.matchAll(TOKEN_EQ_RE)].filter((m) => ids.startsWith(".eq(", m.index!)).map((m) => m.index!)
  const v: Views = { ids, lineStarts: Int32Array.from(starts), froms, brokerageAt, platformAt, useServer: hasUseServerDirective(code), tokenEqAt }
  if (rawText === undefined) {
    viewCache.set(file, v); edgeCache.set(file, parseEdges(file, code)); collectApiLiterals(file, code)
    for (const m of code.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*["'`]([a-z][a-z0-9_.:]*)["'`]/g)) { if (!CONST_LITS.has(m[2])) CONST_LITS.set(m[2], new Set()); CONST_LITS.get(m[2])!.add(m[1]) }
    // WAVE 155 (lane 155B1): every compound string literal (snake_case or dotted) → the files that carry it. The orphan rule asks
    // "does this event / signal value appear in ANY runtime file besides its registry?" — a value built at run time from a
    // literal elsewhere makes the row UNKNOWN, never LEGACY_ORPHAN (CLAUDE.md §1: unreferenced is not dead).
    for (const m of code.matchAll(/["'`]([a-z][a-z0-9]*(?:[_.][a-z0-9]+)+)["'`]/g)) { let s = LIT_FILES.get(m[1]); if (!s) LIT_FILES.set(m[1], (s = new Set())); s.add(file) }
  }
  return v
}
function lineAt(v: Views, idx: number): number {
  let lo = 0, hi = v.lineStarts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (v.lineStarts[mid] <= idx) lo = mid; else hi = mid - 1 }
  return lo + 1
}

/** A `const NAME = <expr>` evaluated out of another guard's COMMENT-BLANKED source (its vocabulary, not a retyped copy). */
function constFromSource(file: string, name: string): unknown {
  const src = blankComments(rawOf(file))
  const m = new RegExp(`\\bconst\\s+${name}\\b[^=]*=`).exec(src)
  if (!m) throw new Error(`${file} no longer defines const ${name}`)
  const rest = src.slice(m.index + m[0].length).split("\n")
  for (let n = 1; n <= 60 && n <= rest.length; n++) {
    const text = rest.slice(0, n).join("\n").trim().replace(/\s+as\s+const\s*$/, "")
    try { return new Function(`return (${text})`)() } catch { /* the expression continues on the next line */ }
  }
  throw new Error(`${file}: const ${name} did not evaluate`)
}

// ══ 2. THE IMPORT GRAPH (stripped specifiers; one resolver over the runtime file set) ═══════════════════════════════════════
const FILES: string[] = runtimeFiles(".").map((f) => normalize(f).replace(/\\/g, "/"))
const FILE_SET = new Set(FILES)
function resolveSpec(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/components/")) base = join("app/components", spec.slice("@/components/".length))
  else if (spec.startsWith("@/")) base = spec.slice(2)
  else if (spec.startsWith(".")) base = join(dirname(from), spec)
  else return null
  base = normalize(base).replace(/\\/g, "/")
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (FILE_SET.has(c)) return c
  return null
}
interface Pair { name: string; local: string }
interface Edge { target: string; at: number; pairs: Pair[] }
const edgeCache = new Map<string, Edge[]>()
const API_LITERALS: Array<{ text: string; file: string }> = []
/** "<literal>" -> the UPPER_CASE constants defined as exactly that literal (a type published through a named constant is still seen). */
const CONST_LITS = new Map<string, Set<string>>()
/** "<compound literal>" -> the runtime files whose comment-blanked source carries it as a string (wave 155, lane 155B1). */
const LIT_FILES = new Map<string, Set<string>>()
const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
function carriesLiteral(lit: string, code: string, ids: string): boolean {
  if (new RegExp(`["'\`]${reEsc(lit)}["'\`]`).test(code)) return true
  for (const n of CONST_LITS.get(lit) ?? []) if (new RegExp(`\\b${n}\\b`).test(ids)) return true
  return false
}
function collectApiLiterals(file: string, code: string): void {
  for (const m of code.matchAll(/["'`]((?:\$\{[^}]*\})?\/api\/[^"'`\s?#]*)/g)) API_LITERALS.push({ text: fresh(m[1].replace(/^\$\{[^}]*\}/, "")), file })
}
function edgesOf(file: string): Edge[] { views(file); return edgeCache.get(file) ?? [] }
/** An import edge. Each pair binds an imported NAME to a LOCAL: name "*" = namespace, "default" = default import; an inline
 *  dynamic import has local "" (it is used where it is written) and names the member it calls, or "*" when unknown. */
function parseEdges(file: string, s: string): Edge[] {
  const out: Edge[] = []
  const ID = /^[A-Za-z_$][\w$]*$/
  const add = (spec: string, at: number, pairs: Pair[]) => {
    const target = resolveSpec(file, spec)
    const ok = pairs.filter((p) => (p.local === "" || ID.test(p.local)) && (p.name === "*" || ID.test(p.name)))
    if (target && ok.length) out.push({ target, at, pairs: ok })
  }
  for (const m of s.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) {
    add(m[2], m.index!, m[1].split(",").map((x) => x.trim()).filter(Boolean).map((x) => ({ name: x.split(/\s*:\s*/)[0].trim(), local: (x.split(/\s*:\s*/)[1] ?? x).trim() })))
  }
  for (const m of s.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) add(m[2], m.index!, [{ name: "*", local: m[1] }])
  for (const m of s.matchAll(/\(\s*await\s+import\(\s*["']([^"']+)["']\s*\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g)) add(m[1], m.index!, [{ name: m[2], local: "" }])
  for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)\s*\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[^]{0,120}?\b\2\.([A-Za-z_$][\w$]*)/g)) add(m[1], m.index!, [{ name: m[3], local: "" }])
  for (const m of s.matchAll(/(?:^|[\n;])\s*import\s+(type\s+)?([^;]*?)\s+from\s*["']([^"']+)["']/g)) {
    if (m[1]) continue
    const clause = m[2].trim()
    const brace = /\{([\s\S]*)\}/.exec(clause)
    const pairs: Pair[] = brace ? brace[1].split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => ({ name: x.split(/\s+as\s+/)[0].trim(), local: (x.split(/\s+as\s+/)[1] ?? x).trim() })) : []
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause); if (ns) pairs.push({ name: "*", local: ns[1] })
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause); if (def) pairs.push({ name: "default", local: def[1] })
    add(m[3], m.index!, pairs)
  }
  // a barrel re-export is an edge too (the barrel's importers reach the name through it)
  for (const m of s.matchAll(/(?:^|[\n;])\s*export\s+(?:type\s+)?(\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/g)) {
    if (/^\s*export\s+type\b/.test(m[0].trim())) continue
    add(m[2], m.index!, m[1] === "*" ? [{ name: "*", local: "" }] : m[1].slice(1, -1).split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => ({ name: x.split(/\s+as\s+/)[0].trim(), local: "" })))
  }
  // WAVE 155 (integrator; found by lane 155R21) — `const [{ a }, { b }] = await Promise.all([import("m1"), import("m2")])` BINDS
  // NAMES, exactly like `const { a } = await import("m1")`. It was not recognised, so each import fell to the bare fallback
  // below and bound "*": the WHOLE module. lib/listing-lifecycle/readiness-checker.ts loads governingListingAgreementTerms (three
  // SELECTs) this way, and validateListingTransition — which only validates — inherited the inserts of two other exports of
  // lib/listings/listing-agreement-terms.ts and read as a P0 write with no receipt. Each pattern is bound to the import at the
  // same position: a brace pattern binds its names, a plain identifier the namespace; anything else (a spread, a call that is not
  // an import, a nested bracket) is left to the fallback, which over-reports (stated). Controls: section G (G3b).
  for (const m of s.matchAll(/(?:const|let|var)\s+\[([^\]]*)\]\s*=\s*await\s+Promise\.all\(\s*\[([^\]]*)\]\s*\)/g)) {
    const split = (list: string): string[] => { const parts: string[] = []; let depth = 0, cur = ""; for (const ch of list) { if (ch === "{" || ch === "(") depth++; else if (ch === "}" || ch === ")") depth--; if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = "" } else cur += ch } if (cur.trim()) parts.push(cur.trim()); return parts }
    const patterns = split(m[1]), calls = split(m[2])
    const listAt = m.index! + m[0].indexOf(m[2], m[0].indexOf("Promise.all"))
    let cursor = 0
    calls.forEach((call, i) => {
      const at = listAt + m[2].indexOf(call, cursor); cursor = m[2].indexOf(call, cursor) + call.length
      const imp = /^import\(\s*["']([^"']+)["']\s*\)$/.exec(call); const pat = patterns[i]
      if (!imp || !pat) return
      const brace = /^\{([\s\S]*)\}$/.exec(pat)
      if (brace) add(imp[1], at, brace[1].split(",").map((x) => x.trim()).filter(Boolean).map((x) => ({ name: x.split(/\s*:\s*/)[0].trim(), local: (x.split(/\s*:\s*/)[1] ?? x).trim() })))
      else if (ID.test(pat)) add(imp[1], at, [{ name: "*", local: pat }])
    })
  }
  for (const m of s.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    // WAVE 155 (lane 155R16): an INLINE TYPE (`Promise<import("x").Dates>`, `typeof import("x")`) is not an import edge — a
    // bare `import("x").Name` without `await` / a wrapping paren is a property of a Promise at run time, i.e. a type position.
    // app/actions/transactions.ts getClosingDates names `import("@/lib/transactions/closing-dates").ClosingDates` in its return
    // type and inherited that module's writes. Control: section G.
    const before = s.slice(Math.max(0, m.index! - 16), m.index!), after = s.slice(m.index! + m[0].length, m.index! + m[0].length + 8)
    if (/\btypeof\s+$/.test(before) || (/^\s*\.\s*[A-Za-z_$]/.test(after) && !/(?:\bawait\s+|\(\s*)$/.test(before))) continue
    const target = resolveSpec(file, m[1])
    if (target && !out.some((e) => e.target === target && e.at <= m.index! && m.index! - e.at < 200)) out.push({ target, at: m.index!, pairs: [{ name: "*", local: "" }] })
  }
  return out
}
/** importers: target file → the names imported from it by OTHER files ("*" = the whole module may be used). */
const IMPORTED = new Map<string, Map<string, Set<string>>>()
for (const f of FILES) for (const e of edgesOf(f)) {
  if (e.target === f) continue
  if (!IMPORTED.has(e.target)) IMPORTED.set(e.target, new Map())
  const m = IMPORTED.get(e.target)!
  for (const p of e.pairs) { const n = p.name === "default" ? "*" : p.name; if (!m.has(n)) m.set(n, new Set()); m.get(n)!.add(f) }
}

// ══ 3. THE VOCABULARIES (loaded from their owners) ══════════════════════════════════════════════════════════════════════
const MOG = "scripts/manager-ownership-matrix-guard.ts"
const AEC = "scripts/action-evidence-census.ts"
const PLANE_RES = constFromSource(MOG, "PLANE_RES") as Array<[string, RegExp]>
const NEXT_RE = constFromSource(MOG, "NEXT_RE") as RegExp
const RECOVERY_RE = constFromSource(MOG, "RECOVERY_RE") as RegExp
const OUTCOME_RE = constFromSource(MOG, "OUTCOME_RE") as RegExp
const WRITE_RE = constFromSource(MOG, "WRITE_RE") as RegExp
const READ_RE = constFromSource(MOG, "READ_RE") as RegExp
const DOOR_TOKENS = constFromSource(AEC, "DOOR_TOKENS") as string[]
const DOOR_RE = new RegExp(`\\b(?:${DOOR_TOKENS.join("|")})\\s*(?:<[^>]*>)?\\s*\\(`)
const PLANE_NAME: Record<string, string> = { A: "authority", E: "arbiter", D: "egress", G: "delegation", P: "approval", R: "resource/spend", C: "closing compliance" }
const DECISION_PLANES = new Set(["A", "E", "P", "R", "C"])
// The egress doors ARE the exports of lib/providers/dispatch.ts (derived) plus the connector gateway's one door.
const DISPATCH_FILE = "lib/providers/dispatch.ts"
const DISPATCH_DOORS = [...blankStrings(rawOf(DISPATCH_FILE)).matchAll(/export\s+async\s+function\s+((?:re)?dispatch[A-Z]\w*)\s*\(/g)].map((m) => m[1])
const EGRESS_RE = new RegExp(`\\b(?:${[...DISPATCH_DOORS, "callConnector"].join("|")})\\s*\\(`)
// The outbound policy chain's gates, as dispatch.ts calls them (the decision tokens a send path inherits).
const OUTBOUND_GATES = ["autonomyGate", "checkSuppression", "deconflictGate", "evaluateOutboundCompliance", "channelRefusalForRecipient", "contentSafetyBackstop", "requireConsentForVideoAvatarSource"]
const GATE_EXTRA_RE = new RegExp(`\\b(?:${[...OUTBOUND_GATES, "autonomyDecision", "authorityAllows", "isToolAllowedAtAuthority", "requireLenderVendorActor", "requirePortalActor", "requireContactPortal\\w*", "assertTenant\\w*", "governSpokenConfirm", "preflightDeclaredGates",
  // WAVE 154 (lane 154A3): the PAYOUT RELEASE GATE (lib/kernel/financial.ts payoutReleaseGate — owner ruling 8: funds received, or
  // the verified closing + the broker-signed, delivered CDA) is THE money decision for a commission payout. It was missing from
  // this vocabulary, so a path that asked it read as having no decision. Positive control in section A.
  "payoutReleaseGate",
  // WAVE 155 (lane 155B1): two decisions an ANONYMOUS public caller is subjected to, missing from this vocabulary so the route
  // read as "no decision": the TENANT'S OWN OPT-IN for public intake, resolved fail-closed by the slug's brokerage and its
  // `widget_enabled` setting (lib/widget/resolve-widget-tenant.ts resolveWidgetTenant), and the per-tenant USAGE CAP before a
  // paid session starts (lib/usage/check-cap.ts checkUsageCap). NOT added: widgetCallOriginAllowed (it admits any caller that
  // sends no Origin header) and checkPublicRateLimit (a rate limit is not a decision). Positive control in section A.
  "resolveWidgetTenant", "checkUsageCap",
  // WAVE 155 (lane 155R16; lane 155R17 request 5): the first-touch arbiter (lib/campaign-sequences/first-touch-coordination.ts
  // decideFirstTouch — a PURE decision over who touches a new contact first, exhaustively unit-tested). Positive control in section A.
  "decideFirstTouch",
  // WAVE 155 (lane 155R16, folding lane 155R18 request A2): THE PUBLIC-DOOR DECISION (lib/security/public-rate-limit.ts
  // decidePublicDoor, merged after this lane's base) — the cap, then the tenant's own opt-in row read fail-closed BEFORE any write.
  // A bare checkPublicRateLimit still is not a decision (control in section F).
  "decidePublicDoor"].join("|")})\\s*\\(`)
const CONSENT_RE = /\b(?:checkSuppression|requireContactConsent|requireConsent\w*|channelRefusalForRecipient|isSuppressed\w*|evaluateOutboundCompliance|captureConsentedContact|hasConsent\w*|isOptedOut\w*)\s*\(/
const SIGNATURE_CALL_RE = /\b(?:timingSafeEqual|verify\w*Signature|validateRequest|constructEvent|verifyWebhook\w*|verifyHmac\w*|verifySvix\w*|validateTwilio\w*|verifyCronAuth)\s*\(/
const SIGNATURE_RE = new RegExp(`${SIGNATURE_CALL_RE.source}|\\bprocess\\.env\\.[A-Z0-9_]*(?:SECRET|SIGNING|WEBHOOK_TOKEN|VERIFY_TOKEN)[A-Z0-9_]*\\b`)
// WAVE 155 (lane 155R16) — TWO DOORS A CALLER PASSES THAT THE CENSUS COULD NOT SEE (defect 5), each fail-closed BY CODE:
// (1) an INTERNAL caller authenticated by the platform's own shared secret — `const s = process.env.X_SECRET` followed by a
//     refusal that fires when the secret is UNSET OR the credential differs (`if (!s || h !== \`Bearer ${s}\`) return …`), or
//     `const denied = verifyCronAuth(req); if (denied) return denied` (lib/cron-auth.ts: 500 unset, 401 wrong). A fail-OPEN read
//     (`if (process.env.CRON_SECRET && h !== …)`, the shape lane 86G removed) is NOT one. Credited on an http row as the
//     counterpart of "session actor": it AUTHENTICATES the platform's own process (lib/cron-auth.ts says so of itself) — the run's
//     policy decision, where one exists, is the calling path's (a blind spot, stated).
// (2) a VERIFIED GRANT TOKEN on a public form — the grant row is looked up by its token (`.eq("token" | "…_token" | "…token_hash")`),
//     the path refuses when it is absent (`if (!row) return`) and compares its expiry (`…expires_at`). The person who issued the
//     link decided; the holder proves the grant. A token lookup with no expiry, or no refusal, is not one.
const EXPIRY_RE = /\bnew\s+Date\s*\(\s*[\w$.?]*expires_at\s*\)|\b[\w$.?]*expires_at\b\s*(?:[<>]=?|\)\s*[<>])/
const REFUSAL_RE = /\bif\s*\(\s*!\s*[\w$.]+\s*\)\s*(?:\{\s*)?return\b/
/** PURE (over string-blanked source) — the fail-closed internal shared-secret refusal, or null. */
function internalSecretAt(ids: string): { token: string; index: number } | null {
  const cron = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*verifyCronAuth\s*\([^;\n]*\)\s*;?\s*\n?\s*if\s*\(\s*\1\s*\)\s*(?:\{\s*)?return\b/.exec(ids)
  if (cron) return { token: "verifyCronAuth (fail-closed CRON_SECRET)", index: cron.index }
  for (const d of ids.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z0-9_]*(?:SECRET|TOKEN)[A-Z0-9_]*)\b/g)) {
    const n = reEsc(d[1])
    const after = ids.slice(d.index!, d.index! + 1500)
    for (const c of after.matchAll(new RegExp(`\\bif\\s*\\(\\s*!\\s*${n}\\s*\\|\\|`, "g"))) {
      const open = c.index! + c[0].indexOf("("); const close = matchParen(after, open); const cond = after.slice(open, close + 1)
      // the refusal fires on a MISMATCH: an inequality against the secret, or a NEGATED constant-time compare
      const rest = cond.slice(cond.indexOf("||"))
      const compares = /!\s*(?:timingSafeEqual|secretsEqual)\s*\(/.test(rest) || new RegExp(`!==?[^|&]*\\b${n}\\b|\\b${n}\\b[^|&]*!==?`).test(rest)
      if (compares && /^\s*(?:\{\s*)?return\b/.test(after.slice(close + 1))) return { token: `fail-closed shared secret ${d[2]}`, index: d.index! }
    }
  }
  return null
}
/** PURE — the verified-grant-token door over a span: a token lookup offset in the span + an expiry comparison + a refusal. */
function grantTokenIn(ids: string, tokenEqInSpan: boolean): boolean {
  return tokenEqInSpan && EXPIRY_RE.test(ids) && REFUSAL_RE.test(ids)
}
const CRON_AUTH_RE = /\bverifyCronAuth\s*\(/
const EVIDENCE_TABLE_RE = /(?:ledger|audit|_log$|_logs$|_events$|_receipts?$|invocations?$|_calls$|_history$|_outcomes?$|dead_letters$)/
/** a table that is a LOG by name, not merely by an `_events` suffix (calendar_events, phone_number_events are domain tables) */
const TRUE_LOG_RE = /(?:ledger|audit|_logs?$|_receipts?$|dead_letters$|self_heal_events$|_history$|^lifecycle_events$|^kernel_events$)/
// WAVE 155 (lane 155R16) — G08b: A TABLE IS A LOG WHEN ITS NAME SAYS SO, OR WHEN ITS NAME ONLY HAS A RECORD SUFFIX AND THE CODE
// NEVER REWRITES ITS ROWS. EVIDENCE_TABLE_RE alone read every `*_events` / `*_calls` / `*_outcomes` table as a ledger: an
// appointment (calendar_events — rescheduled and cancelled by `.update`), an open house (open_house_events), a call record
// (voice_calls — status-updated) earned EVIDENCE for the very write that is the domain fact, and was SKIPPED as an owner even
// though TABLE_MANAGER stewards it. TRUE_LOG_RE alone (the group's first text) over-corrects the other way: compliance_events is
// the outbound gate's append-only decision ledger (22 writer files, every insert carries `gate_name`, no runtime `.update` /
// `.upsert`), and reading it as a domain table would hand its steward (compliance_officer) the OWNERSHIP of every gated draft
// (generateVideo, generateVideoScript …) — a new false credit. So the suffix is decided by CODE: a suffix-named table that some
// runtime file rewrites (`.from("t").update(` / `.upsert(` on comment- AND string-blanked source) is a domain table; one that is
// only ever inserted is a log. The SAME predicate drives ownership (ownerFromWrites) and evidence (factsOfSpan) — one change,
// both directions. Controls: section G (pure matrix + a planted tombstone / string specimen + the census's own derivation).
/** PURE — the log rule over a table name and whether runtime code rewrites its rows. */
function logTableRule(table: string, rewritten: boolean): boolean {
  return TRUE_LOG_RE.test(table) || (EVIDENCE_TABLE_RE.test(table) && !rewritten)
}
/** PURE — the tables a file's code REWRITES: a `.from("t")` literal that is a real call (present in the string-blanked view,
 *  so a specimen inside a string literal is not one) followed by `.update(` / `.upsert(`. */
function rewrittenIn(v: Views): string[] {
  const out: string[] = []
  for (const s of v.froms) {
    if (!v.ids.startsWith(".from(", s.at)) continue
    const m = /^\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)\s*\.(?:update|upsert)\s*\(/.exec(s.text); if (m) out.push(m[1])
  }
  return out
}
/** PURE — the tables a file reads through a PostgREST EMBED: inside a real `.select(` call's string argument, or in the same-file
 *  string / template constant the call names (`.select(X)` with `const X = \`…\``), every `name (` / `alias:name(` /
 *  `name!fk(` / `name!inner(`. `ids` = string-blanked (real calls), `code` = comment-blanked (strings kept, comments blank). */
function embeddedReads(ids: string, code: string): Array<{ table: string; at: number }> {
  const out: Array<{ table: string; at: number }> = []
  const EMBED = /(?:^|[,\s(])(?:[a-z_][a-z0-9_]*\s*:\s*)?([a-z_][a-z0-9_]*)\s*(?:!\s*[a-z_][a-z0-9_]*\s*)*\(/g
  const consts = new Map<string, string>()
  for (const m of code.matchAll(/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(`[^`]*`|"[^"\n]*"|'[^'\n]*')/g)) if (!/\$\{/.test(m[2])) consts.set(m[1], m[2])
  for (const m of ids.matchAll(/\.select\(/g)) {
    const open = m.index! + m[0].length - 1; const close = matchParen(ids, open)
    let arg = code.slice(open + 1, close).trim()
    const ident = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(arg); if (ident && consts.has(ident[1])) arg = consts.get(ident[1])!
    const lit = /^(["'`])([\s\S]*?)\1/.exec(arg); if (!lit) continue
    for (const e of lit[2].matchAll(EMBED)) out.push({ table: e[1], at: m.index! })
  }
  return out
}
let REWRITTEN: Set<string> | null = null
function rewrittenTables(): Set<string> {
  if (REWRITTEN) return REWRITTEN
  REWRITTEN = new Set()
  for (const f of FILES) { const v = views(f); if (v) for (const t of rewrittenIn(v)) REWRITTEN.add(t) }
  return REWRITTEN
}
const isLogTable = (t: string): boolean => logTableRule(t, rewrittenTables().has(t))
const TENANT_ID_RE = /\b(?:brokerageId|brokerage_id|requireCallerTenant|getAgentContext)\b/
const PLATFORM_RE = /\b(?:requirePlatform\w*|platform_role|isPlatformStaff\w*|requireSuperadmin\w*)\b/
const LIVE = new Set(LIVE_TABLES)

// ══ 4. PATH FACTS ═══════════════════════════════════════════════════════════════════════════════════════════════════════
interface Hit { token: string; at: string }
interface Facts {
  writes: Map<string, string>; reads: Set<string>; egress: Hit[]; gates: Hit[]; evidence: Hit[]
  next: Hit | null; recovery: Hit | null; session: Hit | null; tenant: boolean; platform: boolean
  consent: Hit | null; signature: Hit | null; budget: Hit | null; files: Set<string>
  /** WAVE 155 (lane 155R16): a fail-closed internal shared-secret refusal on the path (internalSecretAt) */
  internal: Hit | null
}
const emptyFacts = (): Facts => ({ writes: new Map(), reads: new Set(), egress: [], gates: [], evidence: [], next: null, recovery: null, session: null, tenant: false, platform: false, consent: null, signature: null, budget: null, files: new Set(), internal: null })
function firstHit(re: RegExp, text: string, v: Views, file: string, base: number): Hit | null {
  const r = new RegExp(re.source, re.flags.replace("g", ""))
  const m = r.exec(text)
  return m ? { token: m[0].replace(/\s*\($/, "").trim(), at: `${file}:${lineAt(v, base + m.index)}` } : null
}
/** The first `.from("<table>")` snippet inside [from, to) that the regex matches (table names are read ONLY here). */
function fromHit(re: RegExp, v: Views, file: string, from: number, to: number): Hit | null {
  const r = new RegExp(re.source, re.flags.replace("g", ""))
  for (const s of v.froms) { if (s.at < from || s.at >= to) continue; const m = r.exec(s.text); if (m) return { token: m[0].replace(/\s*\($/, "").trim(), at: `${file}:${lineAt(v, s.at)}` } }
  return null
}
function factsOfSpan(file: string, v: Views, from: number, to: number): Facts {
  const f = emptyFacts()
  f.files.add(file)
  const ids = v.ids.slice(from, to)
  const W = new RegExp(WRITE_RE.source), R = new RegExp(READ_RE.source)
  for (const s of v.froms) {
    if (s.at < from || s.at >= to) continue
    const w = W.exec(s.text); if (w && !f.writes.has(w[1])) f.writes.set(w[1], `${file}:${lineAt(v, s.at)}`)
    const r = R.exec(s.text); if (r) f.reads.add(r[1])
  }
  for (const m of ids.matchAll(new RegExp(EGRESS_RE.source, "g"))) f.egress.push({ token: m[0].replace(/\s*\($/, ""), at: `${file}:${lineAt(v, from + m.index!)}` })
  for (const [plane, re] of PLANE_RES) {
    if (!DECISION_PLANES.has(plane)) continue
    const h = firstHit(re, ids, v, file, from) ?? fromHit(re, v, file, from, to)
    if (h) { f.gates.push({ token: `${PLANE_NAME[plane]}:${h.token}`, at: h.at }); if (plane === "R" && !f.budget) f.budget = h }
  }
  const extra = firstHit(GATE_EXTRA_RE, ids, v, file, from); if (extra) f.gates.push({ token: `policy:${extra.token}`, at: extra.at })
  const tokAt = (v.tokenEqAt ?? []).find((x) => x >= from && x < to)
  if (tokAt !== undefined && grantTokenIn(ids, true)) f.gates.push({ token: "policy:verified grant token (lookup by token + refusal + expiry)", at: `${file}:${lineAt(v, tokAt)}` })
  const ev = firstHit(OUTCOME_RE, ids, v, file, from) ?? firstHit(DOOR_RE, ids, v, file, from)
  if (ev) f.evidence.push(ev)
  for (const [t, at] of f.writes) if (isLogTable(t)) { f.evidence.push({ token: `row:${t}`, at }); break }
  f.next = firstHit(NEXT_RE, ids, v, file, from) ?? fromHit(NEXT_RE, v, file, from, to)
  f.recovery = firstHit(RECOVERY_RE, ids, v, file, from) ?? fromHit(RECOVERY_RE, v, file, from, to)
  for (const t of SESSION_TOKENS) {
    // WAVE 155 (lane 155R16, folding lane 155R18 request F1): `headers()` reads REQUEST HEADERS, not a session — publicCallerIp
    // (lib/security/public-rate-limit.ts) read as "session actor" on anonymous doors. A path with a real session still matches
    // auth.getUser / cookies() / the cookie client. The shared vocabulary (scripts/session-tokens.ts) is not edited. Control: G8.
    if (t.name === "headers()") continue
    if (t.on !== "identifiers") {
      // the one specifier token (the cookie client's module): the file imports it AND the span calls createClient(
      const e = edgesOf(file).find((x) => x.target === "lib/supabase/server.ts")
      if (e && /\bcreateClient\s*\(/.test(ids)) { f.session = { token: t.name, at: `${file}:${lineAt(v, e.at)}` }; break }
      continue
    }
    const h = firstHit(t.re, ids, v, file, from); if (h) { f.session = { token: t.name, at: h.at }; break }
  }
  f.tenant = TENANT_ID_RE.test(ids) || v.brokerageAt.some((x) => x >= from && x < to)
  f.platform = PLATFORM_RE.test(ids) || v.platformAt.some((x) => x >= from && x < to)
  f.consent = firstHit(CONSENT_RE, ids, v, file, from)
  // WAVE 155 (lane 155R16): a VERIFYING CALL is preferred over a bare secret read — /api/voice/twilio/intelligence reads
  // process.env.RELAY_SHARED_SECRET on line 25 and compares it with timingSafeEqual on line 28; the first-in-text hit was the read
  // (which never counts on an http path), so the verification it performs was invisible. Control: section G.
  f.signature = firstHit(SIGNATURE_CALL_RE, ids, v, file, from) ?? firstHit(SIGNATURE_RE, ids, v, file, from)
  const sec = internalSecretAt(ids); if (sec) f.internal = { token: sec.token, at: `${file}:${lineAt(v, from + sec.index)}` }
  return f
}
function merge(a: Facts, b: Facts): Facts {
  for (const [t, at] of b.writes) if (!a.writes.has(t)) a.writes.set(t, at)
  for (const t of b.reads) a.reads.add(t)
  a.egress.push(...b.egress); a.gates.push(...b.gates); a.evidence.push(...b.evidence)
  a.next ??= b.next; a.recovery ??= b.recovery; a.session ??= b.session; a.consent ??= b.consent; a.signature ??= b.signature; a.budget ??= b.budget; a.internal ??= b.internal
  a.tenant ||= b.tenant; a.platform ||= b.platform
  for (const x of b.files) a.files.add(x)
  return a
}
const fileFactsCache = new Map<string, Facts>()
function fileFacts(file: string): Facts {
  const hit = fileFactsCache.get(file); if (hit) return hit
  const v = views(file)
  const f = v ? factsOfSpan(file, v, 0, v.ids.length) : emptyFacts()
  fileFactsCache.set(file, f)
  return f
}
/** THE CALL-GRAPH WALK. A span's facts = its own + for every import binding the span USES, the facts of the MEMBER it uses
 *  (that export's body + its same-file callees, walked again, to MAX_HOPS): a named binding → that export; `NS.member` → that
 *  member; an inline dynamic import → the member it calls. A default import, an unknown member, or a name the target only
 *  re-exports falls back to the target's whole-file facts (over-reports — stated). */
const MAX_HOPS = 3
const fnsCache = new Map<string, FnSpan[]>()
function fnsOf(file: string): FnSpan[] { let f = fnsCache.get(file); if (!f) { const v = views(file); f = v ? topLevelFns(v) : []; fnsCache.set(file, f) } return f }
const memberMemo = new Map<string, Facts>()
function memberFacts(file: string, name: string, hop: number): Facts {
  const key = `${file}#${name}#${hop}`
  const hit = memberMemo.get(key); if (hit) return hit
  const v = views(file); if (!v) return emptyFacts()
  const fns = fnsOf(file)
  const fn = name === "*" || name === "default" ? undefined : fns.find((x) => x.name === name)
  if (!fn) {
    // WAVE 155 (lane 155R16; cause found by lane 155R9) — A TYPE OR A CONSTANT IS NOT A CALL. An imported name the target does not
    // define as a function fell back to the target's WHOLE-FILE facts, so an export that merely read a constant
    // (MODULE_QUIZ_PASSING_SCORE) or named an interface imported without `type` inherited every write of the module that
    // defines it, and a read-only export became a consequential row "writing" its sibling's tables. Now: a type / interface,
    // or a const whose initializer is DATA (no function, arrow, class, `new` of anything but a collection, or call of anything
    // but a pure builtin), contributes NOTHING; a name the target only re-exports is followed to the module it comes from;
    // anything else (a class, a call result, a wrapped function) keeps the whole-file fallback (over-reports — stated).
    const k = name === "*" || name === "default" ? "unknown" : bindingKind(v.ids, name)
    if (k === "type" || k === "data") { const e0 = emptyFacts(); memberMemo.set(key, e0); return e0 }
    const via = name === "*" || name === "default" ? undefined : edgesOf(file).find((e) => e.target !== file && e.pairs.some((p) => p.local === "" && p.name === name))
    if (via) {
      // …and a name re-exported FROM the fan-out file (lib/kernel/index.ts re-exports processKernelEvent) is the same door: the
      // re-export must not carry the fan-out's own gate and receipt back to whoever imported the barrel (lane 155R20 request R1).
      memberMemo.set(key, emptyFacts()); const f0 = memberFacts(via.target, name, hop)
      const ff = FANOUT_DOOR_FILES.includes(via.target) ? { ...f0, evidence: [], gates: [], budget: null } : f0
      memberMemo.set(key, ff); return ff
    }
    const ff = fileFacts(file); memberMemo.set(key, ff); return ff
  }
  memberMemo.set(key, emptyFacts()) // cycle guard
  const f = emptyFacts()
  for (const s of closureSpans(fns, v, fn)) merge(f, pathFacts(file, s.start, s.end, v, hop))
  memberMemo.set(key, f)
  return f
}
function pathFacts(file: string, from?: number, to?: number, v0?: Views, hop = 0): Facts {
  const v = v0 ?? views(file)
  if (!v) return emptyFacts()
  const a = from === undefined ? 0 : from, b = to === undefined ? v.ids.length : to
  const f = factsOfSpan(file, v, a, b)
  if (hop >= MAX_HOPS) return f
  const ids = v.ids.slice(a, b)
  // WAVE 155 (lane 155R16; lane 155R6 request 3) — A RECEIPT BEYOND AN EMIT DOOR IS THE REACTOR'S. A caller that emits a kernel
  // event reaches dispatchKernelEvent; a withActionLedger inside the reactor (a concierge spawn, a campaign hold) is that BLOCK's
  // receipt for its own write, not the caller's for the caller's write. Evidence is therefore dropped at the import edge INTO a
  // reactor file from any file that is not itself a reactor file (a reactor row walking its own block keeps its receipt).
  // …and the same for a DECISION (lane 155R17 request 2): a gate inside the reactor (the Deal Coordinator gate on the offer_accepted
  // block) decides THAT block; transaction_closed / referral_converted / updateTrainingJobStatus borrowed it by emitting into the
  // reactor. Writes beyond the door are still merged (a blind spot, stated). Controls: section G (G2).
  // WAVE 155 (lane 155R20 request R1, applied by the integrator) — THE FAN-OUT IS THE SAME KIND OF DOOR. Once processKernelEvent
  // (lib/kernel/notification-engine.ts) asks the autonomy gate and writes ONE receipt for the REACTION, every caller that emits an
  // event reached that gate and receipt through emit → processKernelEvent and was credited with a decision and evidence for its
  // OWN write — 21 rows, measured (ten award events, two tracking routes, createNewsletterCampaign, createMailCampaign …). The
  // reaction's decision is the reaction's. Gates, evidence and budget are dropped at the edge into a fan-out file from any other
  // file; the kernel-event rows that are consumed INSIDE the fan-out keep them through their own consumer site.
  // Control: section G ("a caller whose only gate is beyond the fan-out has no decision").
  const crossesIntoReactor = (target: string) => (REACTOR_FILES.includes(target) && !REACTOR_FILES.includes(file)) || (FANOUT_DOOR_FILES.includes(target) && file !== target)
  const add = (target: string, mf: Facts) => merge(f, crossesIntoReactor(target) ? { ...mf, evidence: [], gates: [], budget: null } : mf)
  for (const e of edgesOf(file)) {
    if (e.target === file) continue
    const inSpan = e.at >= a && e.at < b
    for (const p of e.pairs) {
      if (!p.local) { if (inSpan) add(e.target, memberFacts(e.target, p.name, hop + 1)); continue }
      const l = p.local.replace(/\$/g, "\\$")
      if (p.name === "*") {
        const members = new Set([...ids.matchAll(new RegExp(`\\b${l}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1]))
        if (members.size) for (const mb of members) add(e.target, memberFacts(e.target, mb, hop + 1))
        else if (new RegExp(`\\b${l}\\b`).test(ids)) add(e.target, fileFacts(e.target))
      } else if (new RegExp(`\\b${l}\\b`).test(ids)) {
        // WAVE 155 (lane 155R22 part 2, rule F): every call of the binding here passes a literal `<flag>: false` → the callee's
        // blocks guarded by that flag are not on THIS caller's path (falseFlagGatedFacts proves it or returns null)
        const flags = falseFlagsAt(ids, p.local)
        add(e.target, (flags.length ? falseFlagGatedFacts(e.target, p.name, hop + 1, flags) : null) ?? memberFacts(e.target, p.name, hop + 1))
      }
    }
  }
  return f
}
/** PURE (rule F) — the flags EVERY reference to `local` in `ids` passes as a literal `false` in an object-literal FIRST argument
 *  (`local({ …, markUsed: false, … })`). Any reference that is not such a call (the function passed on, a call with a variable
 *  argument) → []. Only depth-1 keys of the literal count. */
function falseFlagsAt(ids: string, local: string): string[] {
  const refs = [...ids.matchAll(new RegExp(`\\b${reEsc(local)}\\b`, "g"))]
  let common = null as Set<string> | null
  for (const r of refs) {
    if (/(?:\.|\{\s*|,\s*)$/.test(ids.slice(Math.max(0, r.index! - 3), r.index!)) && /^\s*[,}:]/.test(ids.slice(r.index! + local.length, r.index! + local.length + 3))) continue // the destructure that binds it
    const m = /^\s*\(\s*\{/.exec(ids.slice(r.index! + local.length)); if (!m) return []
    const open = r.index! + local.length + m[0].length - 1; const obj = ids.slice(open + 1, matchBrace(ids, open))
    const flat = obj.replace(/\{[^{}]*\}|\([^()]*\)|\[[^[\]]*\]/g, "")
    const fl = new Set([...flat.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*false\b/g)].map((x) => x[1]))
    common = common ? new Set([...common].filter((x) => fl.has(x))) : fl
    if (!common.size) return []
  }
  return common ? [...common] : []
}
/** Rule F — the callee's facts WITHOUT the blocks guarded by `if (<firstParam>.<flag> [&& …]) { … }` for a flag the caller passes
 *  as literal false. PROVEN or null: the guard's condition has no `||` / `?` (so false short-circuits it), the parameter and the
 *  flag are never reassigned in the body, and what remains outside the blocks writes, sends and spends NOTHING (every write of the
 *  callee sits under the guard) — otherwise null and the caller keeps the full callee facts. */
function falseFlagGatedFacts(file: string, name: string, hop: number, flags: string[]): Facts | null {
  const v = views(file); if (!v) return null
  const fn = fnsOf(file).find((x) => x.name === name); if (!fn) return null
  const body = v.ids.slice(fn.start, fn.end)
  const P = /^[^(]*\(\s*([A-Za-z_$][\w$]*)/.exec(body)?.[1]; if (!P) return null
  if (new RegExp(`\\b${reEsc(P)}\\s*=(?![=>])|\\b${reEsc(P)}\\.(?:${flags.map(reEsc).join("|")})\\s*=(?!=)`).test(body)) return null
  const blocks: Array<[number, number]> = []
  for (const m of body.matchAll(new RegExp(`\\bif\\s*\\(\\s*${reEsc(P)}\\.(?:${flags.map(reEsc).join("|")})\\b([^{]*?)\\)\\s*\\{`, "g"))) {
    if (m[1].trim() && !/^&&[^|?]*$/.test(m[1].trim())) continue
    const open = fn.start + m.index! + m[0].length - 1; blocks.push([fn.start + m.index!, matchBrace(v.ids, open) + 1])
  }
  if (!blocks.length) return null
  const f = emptyFacts(); let at = fn.start
  const pieces: Array<[number, number]> = []
  for (const [s, e] of blocks.sort((a, b) => a[0] - b[0])) { if (s > at) pieces.push([at, s]); at = Math.max(at, e) }
  if (at < fn.end) pieces.push([at, fn.end])
  const byName = new Map(fnsOf(file).map((x) => [x.name, x]))
  for (const [s, e] of pieces) {
    merge(f, pathFacts(file, s, e, v, hop))
    for (const m of v.ids.slice(s, e).matchAll(CALLEE_RE)) { const c = byName.get(m[1]); if (c && c.name !== name) merge(f, memberFacts(file, c.name, hop)) }
  }
  return f.writes.size || f.egress.length || f.budget ? null : f
}
/** The kernel reactor (the files dispatchKernelEvent runs in) — the census's kernel-event consumer files. */
const REACTOR_FILES = ["lib/kernel/event-reactor.ts", "lib/kernel/event-fanout.ts"]
/** The one typed-event fan-out (processKernelEvent): its gate and receipt decide the REACTION, never the emitter's own write. */
const FANOUT_DOOR_FILES = ["lib/kernel/notification-engine.ts"]

// ══ 5. READERS, CALLERS, TESTS (whole-tree indexes, built once) ═════════════════════════════════════════════════════════
// A READER of a table is any `.select` of it — EXCEPT one inside the very function that performs the path's write (a writer's
// own read-before-write / idempotency claim is not a readback; a page that renders the row, or a sibling function of the
// writer's module, is). Each read is kept with its enclosing top-level function's span.
interface ReadSite { file: string; start: number; end: number }
const READERS = new Map<string, ReadSite[]>()
{
  const R = new RegExp(READ_RE.source)
  for (const f of FILES) {
    const v = views(f); if (!v || !v.froms.length) continue
    let fns: FnSpan[] | null = null
    for (const s of v.froms) {
      const m = R.exec(s.text); if (!m) continue
      fns ??= fnsOf(f)
      const fn = fns.find((x) => x.start <= s.at && s.at < x.end)
      if (!READERS.has(m[1])) READERS.set(m[1], [])
      READERS.get(m[1])!.push({ file: f, start: fn ? fn.start : s.at, end: fn ? fn.end : s.at + 1 })
    }
    // WAVE 155 (lane 155R16; lanes 155R15 / 155R17 request) — A READ THROUGH AN EMBED IS A READ. `.select("…, comments:
    // marketing_campaign_comments(…)")` (app/actions/marketing-studio.ts getCampaignById) and `.select(SCRAPE_TERRITORY_SELECT)` (a
    // same-file template constant embedding lead_scraping_property_params (…)) read the child table; the index counted only the
    // `.from(t)` table, so the child's writers read "no readback". Read on the comment-blanked view (a planted embed in a comment
    // is blank), from a REAL `.select(` call (present in the string-blanked view), and only for names in LIVE_TABLES. Controls: G7.
    if (!v.ids.includes(".select(")) continue
    const code = codeOf(f)
    for (const site of embeddedReads(v.ids, code)) {
      if (!LIVE.has(site.table)) continue
      fns ??= fnsOf(f)
      const fn = fns.find((x) => x.start <= site.at && site.at < x.end)
      if (!READERS.has(site.table)) READERS.set(site.table, [])
      READERS.get(site.table)!.push({ file: f, start: fn ? fn.start : site.at, end: fn ? fn.end : site.at + 1 })
    }
  }
}
/** Readers of `table`, minus the function that holds the write at `writerAt` ("file:line"). */
function readersOf(table: string, writerAt: string | undefined): string[] {
  let wf = "", wOff = -1
  if (writerAt) { const i = writerAt.lastIndexOf(":"); wf = writerAt.slice(0, i); const v = views(wf); const ln = Number(writerAt.slice(i + 1)); if (v && ln > 0) wOff = v.lineStarts[ln - 1] ?? -1 }
  const out = new Set<string>()
  for (const r of READERS.get(table) ?? []) if (!(r.file === wf && wOff >= r.start && wOff < r.end)) out.add(r.file)
  return [...out]
}
const isUiFile = (f: string) => f.startsWith("app/") && !f.startsWith("app/api/")
/** A UI surface for a reader: the reader is a page / component, or a page / component imports the reader's module. */
function uiSurfaceOf(reader: string): string | null {
  if (isUiFile(reader)) return reader
  for (const set of IMPORTED.get(reader)?.values() ?? []) for (const imp of set) if (isUiFile(imp)) return `${imp} (via ${reader})`
  return null
}

const PKG = JSON.parse(rawOf("package.json")) as { scripts: Record<string, string> }
const TEST_SCRIPTS = new Map<string, string>() // script file → test:key
for (const [k, cmd] of Object.entries(PKG.scripts)) {
  if (!k.startsWith("test:")) continue
  // this census is not the test of the paths it names (it would certify itself)
  const m = /scripts\/[\w./-]+\.ts/.exec(cmd); if (m && m[0] !== "scripts/os-coverage-ledger.ts") TEST_SCRIPTS.set(m[0], k)
}
const TEST_INDEX = new Map<string, Set<string>>() // normalized literal → test keys
for (const [file, key] of TEST_SCRIPTS) {
  const raw = rawOf(file); if (!raw) continue
  for (const lit of stringLiterals(raw)) {
    let t = lit.text.trim(); if (!t || t.length > 200) continue
    t = t.replace(/^(?:\.\.\/)+/, "").replace(/^@\//, "").replace(/\.(tsx?|js)$/, "")
    if (!TEST_INDEX.has(t)) TEST_INDEX.set(t, new Set())
    TEST_INDEX.get(t)!.add(key)
  }
}
function testsFor(...keys: string[]): string {
  const hits = new Set<string>()
  for (const k of keys) { if (!k) continue; const t = TEST_INDEX.get(k.replace(/\.(tsx?)$/, "")); if (t) for (const x of t) hits.add(x) }
  return hits.size ? [...hits].sort().slice(0, 3).join(", ") + (hits.size > 3 ? ` (+${hits.size - 3})` : "") : U("no registered test:* script names this entrypoint or action")
}

// ══ 6. ROWS ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
type TriggerKind = "cron" | "kernel_event" | "orchestrator_event" | "manager_signal" | "capability" | "assistant_tool" | "provider_egress" | "webhook" | "http" | "server_action"
type State = "working" | "partial" | "missing" | "owner-held"
type Link = "trigger" | "worker" | "owner" | "decision" | "evidence" | "readback" | "schema"
interface Row {
  id: string; domain: string; planes: string[]; surfaces: string[]; entrypoint: string; trigger_kind: TriggerKind; trigger: string; source_event: string
  actor: string; tenant_scope: string; subject: string; typed_action: string; decision_owner: string; registered_manager: string
  worker: string; policy_gate: string; consent: string; budget: string; dependencies: string; deadline: string; writer: string
  receipt: string; readback: string; downstream_trigger: string; recovery: string; operator_surface: string; test: string
  consequential: boolean; state: State; missing: Link[]; why: string
  // ── WAVE 155 (lane 155B1, directive B1): the row-level evidence ledger. ADDITIONAL columns — none of them feeds state(). ──
  action_id: string; file_line: string; task_type: string; tenant_actor_source: string; source_trust: string
  permitted_writer_egress: string; next_trigger_or_terminal: string; failure_handling: string; ledger_evidence: string; domain_b2: Domain
  /** what the row's OWN path writes / sends / spends (the read-only rule and the ratchet both read this, never the verdict) */
  path_effects: { writes: string[]; egress: string[]; spend: string | null }
  classification: Classification | null; classification_evidence: string; root_cause_group: string | null; risk_class: RiskClass
}
type Classification = "EXECUTABLE_GAP" | "DECLARATIVE_READ_ONLY" | "LEGACY_ORPHAN" | "SIMULATED_ONLY" | "OWNER_HELD" | "UNKNOWN"
type RiskClass = "P0" | "P1" | "P2"
type Domain = "platform" | "acquisition" | "customer-facing" | "marketing" | "transaction" | "finance" | "education" | "recovery"
interface Draft {
  id: string; kind: TriggerKind; entry: string; action: string; source_event: string; trigger: string | null; worker: string | null
  owner: string | null; ownerWhy?: string; facts: Facts; consequentialHint?: boolean; actorHint?: string; deadline?: string
  decisionHint?: string; evidenceHint?: string; readbackHint?: string; subject?: string
  /** the tables the plane / surface lens reads, when the facts also carry a shared route head's writes */
  lensTables?: string[]
  // ── classification inputs (wave 155, lane 155B1) — each derived from code by the population that builds the draft ──
  /** the row's own path when `facts` also carries a shared head (an assistant tool's case without the route head) */
  ownFacts?: Facts
  /** kernel event: true = every emission site passes `auditOnly: true` (emit.ts shouldFanOut skips the reactor by design);
   *  false = some site fans out; null = an emission site is not a door call this file can read (unprovable) */
  auditOnlyEmits?: boolean | null
  /** files OTHER than the registry / the row's own module that still carry its value or name (a dynamic reference) */
  elsewhere?: string[]
  /** assistant tool: lib/ai-isa/persona-tool-policy.ts riskClassForTool */
  toolRisk?: string
  /** WAVE 155 (lane 155R22): a hold DERIVED from a ledger another guard on the chain keeps (scripts/event-claims-ledger.ts
   *  EVENT_OWNER_HELD), applied by the population only where its own row has the shape the ledger holds — never typed here */
  heldWhy?: string
  /** WAVE 155 (lane 155R22 part 2, rule B): the platform-role gate on the row's OWN path (token @ file:line) when it has no
   *  tenant-seat gate there — derived by platformStaffDoorAt, never typed */
  staffDoor?: string
  /** rule C: the own-record write (table @ file:line) when every write of the path is an update / delete pinned to the session
   *  user's own id — derived by ownRecordWriteAt */
  ownRecord?: string
}
const STAFF_DOOR_Q = "Platform-staff acts: only platform_sentinel is a registered platform manager. Is a platform act owned by the tenant steward of what it touches (the Data Steward for credentials and connections), or by a platform manager? Until ruled: the act runs only for a platform role, is recorded in the staff audit log, and no manager performs it."
const OWN_RECORD_Q = "The seat's own record (lane 155R18 owner decision 3): is a write pinned to the signed-in user's OWN rows that touches nothing else (marking one's own notifications read) a manager action that needs an owner and a receipt? Until ruled: it runs only on the caller's own rows, under the session, and no manager performs it."
/** PURE (rules B / C) — the hold a derived door earns, from its final `missing` set: a staff door missing ONLY `owner`; an own-record
 *  write decided by the session and missing nothing but `owner` / `evidence`. Anything else keeps its gap. */
function derivedDoorHold(d: Pick<Draft, "staffDoor" | "ownRecord">, missing: Link[], decision: string | null): string | undefined {
  if (d.staffDoor && missing.length === 1 && missing[0] === "owner") return `owner-held (platform-staff door: ${d.staffDoor}): ${STAFF_DOOR_Q}`
  if (d.ownRecord && missing.includes("owner") && missing.every((m) => m === "owner" || m === "evidence") && !!decision?.startsWith("session actor")) return `owner-held (own record: ${d.ownRecord}): ${OWN_RECORD_Q}`
  return undefined
}

// TABLE_MANAGER (imported below) gives the steward of each written table; the owner of a path is the steward of what it writes.
let TABLE_MANAGER: Record<string, string> = {}
let MANAGER_KEYS = new Set<string>()
/** The bus and the ledgers are carriers, not domains: their steward is not the owner of an action that merely writes them. */
const CARRIER_TABLES = new Set(["manager_signals", "notifications", "kernel_events", "lifecycle_events", "agent_action_ledger"])
function ownerFromWrites(f: Facts, addressed?: string | null): { owner: string | null; why: string } {
  const counts = new Map<string, number>()
  for (const t of f.writes.keys()) { if (CARRIER_TABLES.has(t) || isLogTable(t)) continue; const m = TABLE_MANAGER[t]; if (m) counts.set(m, (counts.get(m) ?? 0) + 1) }
  if (!counts.size && addressed && MANAGER_KEYS.has(addressed)) return { owner: addressed, why: `the manager the path addresses (toManager "${addressed}")` }
  if (!counts.size) return { owner: null, why: f.writes.size ? `it writes only carriers / unstewarded tables (${[...f.writes.keys()].slice(0, 3).join(", ")}) and addresses no manager` : "it writes no table, and no registry names an owner" }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { owner: best[0][0], why: `TABLE_MANAGER steward of ${[...f.writes.keys()].filter((t) => TABLE_MANAGER[t] === best[0][0]).slice(0, 2).join(", ")}` }
}

// WAVE 155 (lane 155R16, folding lane 155R18 request A1): AN AUDITED READ IS OWNED BY THE STEWARD OF WHAT IT READ. A path whose only
// writes are carriers / logs (isLogTable — the SAME predicate as ownership and evidence, so a G08b domain-table write never reaches
// here) has no written steward: its owner is (1) the steward of a non-generic LOG it writes (document_access_log …), else (2) the
// TABLE_MANAGER steward of the domain tables its OWN span reads (never the gate / ledger helpers' identity reads); a tie → null.
// compliance_events is GENERIC here (lane 155R16): the outbound gate writes it on every gated path, so its steward
// (compliance_officer) must not own every gated draft. Controls: section G (G8).
const GENERIC_TELEMETRY = new Set(["self_heal_events", "api_response_logs", "audit_log", "superadmin_audit_log", "automation_errors", "compliance_events"])
const ACTOR_IDENTITY_READS = new Set(["users", "agents", "brokerages", "user_role_assignments", "teams", "team_members", "platform_staff", "platform_role_capability_overrides", "platform_impersonation_sessions"])
function ownerOfAuditedRead(own: Facts, path: Facts): { owner: string | null; why: string } | null {
  if (!path.writes.size || [...path.writes.keys()].some((t) => !CARRIER_TABLES.has(t) && !isLogTable(t))) return null
  const logs = new Map<string, number>()
  for (const t of path.writes.keys()) { if (CARRIER_TABLES.has(t) || GENERIC_TELEMETRY.has(t)) continue; const m = TABLE_MANAGER[t]; if (m) logs.set(m, (logs.get(m) ?? 0) + 1) }
  const lb = [...logs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (lb.length === 1 || (lb.length > 1 && lb[0][1] > lb[1][1])) return { owner: lb[0][0], why: `steward of the log it writes (${[...path.writes.keys()].filter((t) => TABLE_MANAGER[t] === lb[0][0] && !GENERIC_TELEMETRY.has(t)).slice(0, 2).join(", ")}); its only writes are carriers / logs` }
  if (lb.length) return null
  const counts = new Map<string, number>()
  for (const t of own.reads) { if (ACTOR_IDENTITY_READS.has(t) || CARRIER_TABLES.has(t)) continue; const m = TABLE_MANAGER[t]; if (m) counts.set(m, (counts.get(m) ?? 0) + 1) }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (!best.length || (best.length > 1 && best[0][1] === best[1][1])) return null
  return { owner: best[0][0], why: `steward of what its own span reads (${[...own.reads].filter((t) => TABLE_MANAGER[t] === best[0][0] && !ACTOR_IDENTITY_READS.has(t)).slice(0, 2).join(", ")}); its only writes are carriers / logs` }
}

// WAVE 155 (lane 155R22; the rule of scripts/owner-resolution-guard.ts §D, lane 155R18) — THE WORKER HOP. A log-only action is
// very often a gate plus ONE delegated call (exportFinancialReportAction = getFinancialActorContext() + exportFinancialReport()):
// its OWN span reads nothing, so the own-span rule above resolved nothing and 44 rows read "log-only owner" while §D named their
// steward one hop away. The rule reaches exactly that hop and no further:
//   · it applies ONLY where the own-span rule found NO stewarded read at all (a tie stays a tie) and the path writes no stewarded
//     non-generic log (that log's steward already answers) — and, like the rule above, only while every write is a carrier / log;
//   · the WORKERS are the callees the action's own span calls (an imported function, `NS.member(`, an inline dynamic import's
//     member, or a same-file top-level function) MINUS every gate / identity / ledger / carrier helper (isNotAWorker: the
//     census's own decision, gate and ledger-door tokens, plus the require*/gate*/assert*/check*/can*… and get*Context /
//     resolve*Actor / audit* / emit* / notify* … name shapes) — their reads say WHO acts and WHERE the record goes, not the subject;
//   · a worker's reads are its body and its same-file callees (minus the same helpers) — ONE hop: the worker's own imports
//     are not followed (the facts walk does that for writes; for ownership a second hop is a guess);
//   · the owner is the steward of the workers' stewarded reads (identity and carriers excluded) when EXACTLY ONE steward appears
//     across every worker — two stewards, from one worker or two, resolve NOTHING (stricter than the own-span majority:
//     a majority over a delegated module's reads is arithmetic, not evidence). Never a typed owner. Controls: section G (G9).
const NOT_A_WORKER_RE = /^(?:require|gate|assert|ensure|authori[sz]e|guard|verify|check|can|is|has|allow|decide|enforce|refuse|seat)(?:[A-Z_]|$)|^evaluate(?:Outbound|Compliance|Consent|Policy|Authority|Approval)\w*$|^\w+(?:Can|Allowed|Gate)$|^(?:get|resolve|load|read|fetch|current|lookup)\w*(?:Context|Actor|Session|Caller|Identity|Role|Seat|Staff|Tenant|User|UserType|Brokerage|BrokerageId|Membership|Permissions?)$|^(?:withActionLedger|ledger\w*|audit\w*|\w+Audit|emit\w*|publish\w*|notify\w*|raise\w*Notification\w*|create\w*Notification\w*|insert\w*Notification\w*|record\w*Event\w*|log\w*Event\w*|sentinelWrite|resultFamily|track\w*|create\w*Client|revalidatePath|revalidateTag|redirect|notFound|cookies|headers)$/
function isNotAWorker(name: string): boolean {
  const call = `${name}(`
  return NOT_A_WORKER_RE.test(name) || GATE_EXTRA_RE.test(call) || DOOR_RE.test(call) || OUTCOME_RE.test(call)
    || PLANE_RES.some(([p, re]) => DECISION_PLANES.has(p) && new RegExp(re.source, re.flags.replace("g", "")).test(call))
}
/** PURE — a span that RESOLVES the signed-in identity (auth.getUser, requireCaller, getAgentContext … — not the cookie-client
 *  constructor or cookies(), which are only the transport a data worker uses), or asks an authority (plane A) or policy
 *  (GATE_EXTRA) gate, says WHO may act. */
function actsAsGate(f: Facts): boolean {
  return (!!f.session && !/^(?:createClient\(\)|cookies\(\)|createServerClient)/.test(f.session.token)) || f.gates.some((g) => g.token.startsWith("authority:") || g.token.startsWith("policy:"))
}
/** PURE — an AUTHORIZATION module (integrator, wave 155): every function in it says WHO may act — a seat, a lane, a grant — so
 *  none of its reads is the act's subject. BY LOCATION, because a lane check is handed the identity instead of resolving it and
 *  is named like a worker: lib/kernel/portal-auth.ts externalPartnerTransactionLane reads vendor_assignments to prove a partner
 *  is on a deal, and once lane 155T3 moved the title gate onto the vendor rail the worker hop credited the route that calls it
 *  (/api/external-portal/actions/complete — one audit row about a TRANSACTION) to vendor_assignments' steward. The two ledgers
 *  disagreed and test:owner-resolution said so. Blind spot: an authorization helper kept outside these locations is still
 *  judged by name and structure only. */
const AUTH_MODULE_RE = /(?:^|\/)(?:auth|security)\/|(?:^|\/)(?:[\w-]*-auth|auth-[\w-]*|require-[\w-]+)\.tsx?$/
function isAuthorizationModule(file: string): boolean { return AUTH_MODULE_RE.test(file) }
interface DelegatedWorker { name: string; at: string; reads: string[] }
/** PURE — the worker-hop owner (rule above). `own` = the action's own span, `path` = its whole path, `workers` = its delegates. */
function ownerOfDelegatedRead(own: Facts, path: Facts, workers: DelegatedWorker[]): { owner: string | null; why: string } | null {
  if (!path.writes.size || [...path.writes.keys()].some((t) => !CARRIER_TABLES.has(t) && !isLogTable(t))) return null
  if ([...path.writes.keys()].some((t) => !CARRIER_TABLES.has(t) && !GENERIC_TELEMETRY.has(t) && !!TABLE_MANAGER[t])) return null
  if ([...own.reads].some((t) => !ACTOR_IDENTITY_READS.has(t) && !CARRIER_TABLES.has(t) && !!TABLE_MANAGER[t])) return null
  const by = new Map<string, Array<{ table: string; worker: DelegatedWorker }>>()
  for (const w of workers) for (const t of w.reads) {
    if (ACTOR_IDENTITY_READS.has(t) || CARRIER_TABLES.has(t)) continue
    const m = TABLE_MANAGER[t]; if (!m) continue
    if (!by.has(m)) by.set(m, []); by.get(m)!.push({ table: t, worker: w })
  }
  if (by.size !== 1) return null
  const [owner, hits] = [...by.entries()][0]
  const w0 = hits[0].worker
  return { owner, why: `steward of what the worker it delegates to reads (${w0.name} @ ${w0.at} reads ${[...new Set(hits.map((h) => h.table))].slice(0, 2).join(", ")}); its only writes are carriers / logs` }
}
const CALLEE_RE = /\b([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g
/** The delegates of the span [from, to) of `file` (rule above). `fns` / `v` are passed so a planted fixture walks too. */
function delegatedWorkers(file: string, v: Views, fns: FnSpan[], from: number, to: number, self?: string): DelegatedWorker[] {
  const ids = v.ids.slice(from, to)
  const out = new Map<string, DelegatedWorker>()
  const add = (tFile: string, tv: Views | null, tfns: FnSpan[], fnName: string, localName: string, depth = 0): void => {
    if (!tv || isAuthorizationModule(tFile) || isNotAWorker(localName) || isNotAWorker(fnName)) return
    const key = `${tFile}#${fnName}`; if (out.has(key)) return
    const fn = tfns.find((x) => x.name === fnName)
    if (!fn) {
      // a name the target only RE-EXPORTS is followed to the module it comes from (once) — never a whole-file fallback
      const via = depth ? undefined : edgesOf(tFile).find((e) => e.target !== tFile && e.pairs.some((p) => p.local === "" && p.name === fnName))
      if (via) add(via.target, views(via.target), fnsOf(via.target), fnName, localName, 1)
      return
    }
    const byName = new Map(tfns.map((f) => [f.name, f]))
    const reads = new Set<string>(); const seen = new Set([fn.name]); const queue = [fn]
    while (queue.length) {
      const cur = queue.pop()!
      const cf = factsOfSpan(tFile, tv, cur.start, cur.end)
      // …and STRUCTURALLY: a helper whose own body resolves the session or asks an authority / policy gate is an identity / gate
      // helper whatever its name (app/actions/open-house-kernel.ts resolveOpenHouseScope: getAgentContext + the tenant proof)
      if (actsAsGate(cf)) { if (cur === fn) return; continue }
      for (const t of cf.reads) reads.add(t)
      for (const m of tv.ids.slice(cur.start, cur.end).matchAll(CALLEE_RE)) { const c = byName.get(m[1]); if (c && !seen.has(c.name) && !isNotAWorker(c.name)) { seen.add(c.name); queue.push(c) } }
    }
    out.set(key, { name: fnName, at: `${tFile}:${fn.line}`, reads: [...reads] })
  }
  const called = new Set([...ids.matchAll(CALLEE_RE)].map((m) => m[1]))
  for (const n of called) if (n !== self && fns.some((x) => x.name === n)) add(file, v, fns, n, n)
  for (const e of edgesOf(file)) {
    if (e.target === file) continue
    const inSpan = e.at >= from && e.at < to
    for (const p of e.pairs) {
      if (!p.local) { if (inSpan && p.name !== "*" && p.name !== "default") add(e.target, views(e.target), fnsOf(e.target), p.name, p.name); continue }
      if (p.name === "*") { for (const m of ids.matchAll(new RegExp(`\\b${reEsc(p.local)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g"))) add(e.target, views(e.target), fnsOf(e.target), m[1], m[1]); continue }
      if (p.name !== "default" && called.has(p.local)) add(e.target, views(e.target), fnsOf(e.target), p.name, p.local)
    }
  }
  return [...out.values()]
}
// WAVE 155 (lane 155R22 part 2, rule B) — THE PLATFORM-STAFF DOOR, DERIVED. A platform gate is a GATE-SHAPED function in lib/
// (isNotAWorker's shapes, or a name ending Auth / Guard / Identity / Gate) whose own body reads the platform role (the literal
// "platform_role", or a PLATFORM_RE token: requirePlatform*, isPlatformStaff*, requireSuperadmin*) — or calls such a gate, to a
// fixpoint (requireProviders → requirePlatformCapability; requireSuperadminAuth → isPlatformSuperadminIdentity …). Nothing listed.
let platformGates: Set<string> | null = null
const gateShaped = (n: string) => isNotAWorker(n) || /(?:Auth|Guard|Identity|Gate)$/.test(n)
function platformGateSet(): Set<string> {
  if (platformGates) return platformGates
  const set = new Set<string>()
  const lib = FILES.filter((f) => f.startsWith("lib/"))
  for (const f of lib) {
    const v = views(f); if (!v || !/platform/i.test(v.ids) && !v.platformAt.length) continue
    for (const fn of fnsOf(f)) if (gateShaped(fn.name) && (PLATFORM_RE.test(v.ids.slice(fn.start, fn.end)) || v.platformAt.some((x) => x >= fn.start && x < fn.end))) set.add(`${f}#${fn.name}`)
  }
  for (let round = 0, grew = true; grew && round < 6; round++) {
    grew = false
    for (const f of lib) {
      const v = views(f); if (!v) continue
      const imported = new Map<string, string>()
      for (const e of edgesOf(f)) for (const p of e.pairs) if (p.local && p.name !== "*") imported.set(p.local, `${e.target}#${p.name}`)
      for (const fn of fnsOf(f)) {
        const key = `${f}#${fn.name}`; if (set.has(key) || !gateShaped(fn.name)) continue
        const called = [...v.ids.slice(fn.start, fn.end).matchAll(CALLEE_RE)].map((m) => m[1])
        if (called.some((n) => set.has(`${f}#${n}`) || set.has(imported.get(n) ?? ""))) { set.add(key); grew = true }
      }
    }
  }
  return (platformGates = set)
}
/** The platform-role gate on the OWN path [spans] of `file` (token @ file:line) when that path asks NO tenant-seat gate (an
 *  authority-plane token — requireCallerTenant, getAgentContext … — or a tenant-seat session resolver); null otherwise. */
function platformStaffDoorAt(file: string, v: Views, spans: Array<{ start: number; end: number }>): string | null {
  const set = platformGateSet()
  const imported = new Map<string, string>()
  for (const e of edgesOf(file)) for (const p of e.pairs) if (p.local && p.name !== "*") imported.set(p.local, `${e.target}#${p.name}`)
  let hit: string | null = null
  for (const s of spans) {
    const f = factsOfSpan(file, v, s.start, s.end)
    if (f.gates.some((g) => g.token.startsWith("authority:")) || (f.session && /^(?:getAgentContext|requireCaller|requireActor|resolveActor)$/.test(f.session.token))) return null
    // only a REFUSING call of a platform gate counts (refusingGateCall): `const g = await gate(…)` then `if (!g.ok …) return|throw`,
    // or `if (!gate(…)) return|throw`. An admitting alternative (`if (sameTenant || isPlatformStaffIdentity(…)) {` —
    // app/actions/self-book-showing.ts) and a bare platform_role read are not a staff-only door.
    const ids = v.ids.slice(s.start, s.end)
    const platRe = new RegExp(`^(?:${PLATFORM_RE.source.replace(/^\\b\(\?:|\)\\b$/g, "")})$`)
    for (const m of ids.matchAll(CALLEE_RE)) {
      const k = imported.get(m[1]) ?? `${file}#${m[1]}`
      if (!(set.has(k) || platRe.test(m[1])) || !refusingGateCall(ids, m.index!, m[1])) continue
      hit ??= `${m[1]} @ ${file}:${lineAt(v, s.start + m.index!)}`; break
    }
  }
  return hit
}
/** PURE (rule B) — the call of `name` at `at` in `ids` REFUSES the act when it fails: it is the negated condition of an `if` that
 *  returns / throws, or its awaited result is bound and then negated in such an `if` before anything else is called. */
function refusingGateCall(ids: string, at: number, name: string): boolean {
  if (/\bif\s*\([^(){}]*!\s*$/.test(ids.slice(Math.max(0, at - 60), at))) {
    const open = ids.indexOf("(", at); const close = matchParen(ids, open)
    const cond = ids.slice(ids.lastIndexOf("if", at), close)
    const condEnd = matchParen(ids, ids.indexOf("(", ids.lastIndexOf("if", at)))
    return !/\|\|[^!]*$/.test(cond.slice(0, at - ids.lastIndexOf("if", at))) && /^\s*\)\s*(?:\{\s*)?(?:return|throw)\b/.test(ids.slice(condEnd, condEnd + 40))
  }
  const b = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(ids.slice(Math.max(0, at - 60), at)); if (!b) return false
  const after = ids.slice(matchParen(ids, ids.indexOf("(", at)) + 1, matchParen(ids, ids.indexOf("(", at)) + 300)
  return new RegExp(`^[^]*?\\bif\\s*\\(\\s*!\\s*${reEsc(b[1])}\\b(?:\\.ok\\b)?[^{}]*?\\)\\s*(?:\\{\\s*)?(?:return|throw)\\b`).test(after)
    || new RegExp(`^[^]*?\\bif\\s*\\(\\s*${reEsc(b[1])}\\s+instanceof\\s+\\w+\\s*\\)\\s*(?:\\{\\s*)?(?:return|throw)\\b`).test(after)
}
/** PURE-ish (rule C) — the own-record write of an export: every write the WHOLE path makes is in the export's own span, to one
 *  table, each an `.update(` / `.delete(` (never an insert / upsert) whose chain pins `.eq("user_id", R.userId | R.id)` where R
 *  is bound in that span as `const R = await <call>(` (not a parameter). Returns "table @ file:line" or null. */
function ownRecordWriteAt(file: string, v: Views, fn: { start: number; end: number }, pathWrites: string[], code: string): string | null {
  const own = factsOfSpan(file, v, fn.start, fn.end)
  if (!pathWrites.length || pathWrites.length !== own.writes.size || pathWrites.some((t) => !own.writes.has(t)) || own.writes.size !== 1) return null
  const W = new RegExp(WRITE_RE.source)
  const span = code.slice(fn.start, fn.end)
  const params = /\(([^)]*)\)/.exec(v.ids.slice(fn.start, fn.end))?.[1] ?? ""
  let first: string | null = null
  for (const s of v.froms) {
    if (s.at < fn.start || s.at >= fn.end || !W.test(s.text)) continue
    const rest = code.slice(s.at, fn.end); const stop = rest.search(/;|\n\s*\n|\n\s*(?:const|let|if|return|for|throw)\b/)
    const chain = stop < 0 ? rest : rest.slice(0, stop)
    if (/\.(?:insert|upsert)\s*\(/.test(chain) || !/\.(?:update|delete)\s*\(/.test(chain)) return null
    const pin = /\.eq\(\s*["']user_id["']\s*,\s*([A-Za-z_$][\w$]*)\.(?:userId|id)\s*\)/.exec(chain)
    if (!pin || new RegExp(`\\b${reEsc(pin[1])}\\b`).test(params) || !new RegExp(`\\b(?:const|let)\\s+${reEsc(pin[1])}\\s*=\\s*await\\s+[\\w$.]+\\s*\\(`).test(span)) return null
    first ??= `${[...own.writes.keys()][0]} @ ${file}:${lineAt(v, s.at)}`
  }
  return first
}
function finish(d: Draft): Row {
  const f = d.facts
  const consequential = d.consequentialHint ?? (f.writes.size > 0 || f.egress.length > 0)
  const owner = d.owner && (MANAGER_KEYS.has(d.owner) || d.owner.startsWith("feed") || d.owner.startsWith("per-call")) ? d.owner : null
  const gate = f.gates[0] ?? null
  let decision: string | null = null
  if (d.decisionHint) decision = d.decisionHint
  else if (f.gates.some((g) => g.token.startsWith("approval:"))) { const g = f.gates.find((x) => x.token.startsWith("approval:"))!; decision = `human approver (${g.token} @ ${g.at})` }
  else if (f.session && (d.kind === "server_action" || d.kind === "http")) decision = `session actor (${f.session.token} @ ${f.session.at})`
  else if (gate) decision = `${owner ?? "the path"} under ${gate.token} @ ${gate.at}`
  else if (f.signature && d.kind === "webhook") decision = `provider of record (signature verified: ${f.signature.token} @ ${f.signature.at})`
  // WAVE 155 (lane 155B1): a provider callback is a provider callback whatever its URL looks like. /api/voice/twilio/recording
  // verifies Twilio's signature but its path does not match isWebhookPath, so it was typed `http` and refused the decision a
  // webhook gets for the very same call. verifyCronAuth is the platform's OWN shared secret (an internal caller), not a provider
  // of record, so it never counts here; nor does a bare `process.env.*_SECRET` read (only a VERIFYING CALL is a decision on an
  // http path — reading a secret is not comparing it). Positive + negative control in section C.
  else if (f.signature && d.kind === "http" && !CRON_AUTH_RE.test(f.signature.token + "(") && !f.signature.token.startsWith("process.env")) decision = `provider of record (signature verified: ${f.signature.token} @ ${f.signature.at})`
  // WAVE 155 (lane 155R16): the platform's own process, authenticated fail-closed (internalSecretAt) — an http route, or a server
  // action only a secret holder can drive (direct-mail.ts trackDelivery: LOB_WEBHOOK_SECRET + secretsEqual). A cron's run decision
  // stays the cron population's rule (G05), and a webhook's is its provider signature.
  else if (f.internal && (d.kind === "http" || d.kind === "server_action") && f.internal.at.startsWith(`${d.entry.split(":")[0]}:`)) decision = `internal caller (${f.internal.token} @ ${f.internal.at})`
  const evidence = d.evidenceHint ?? (f.evidence[0] ? `${f.evidence[0].token} @ ${f.evidence[0].at}` : null)
  const written = [...f.writes.keys()]
  const readTables = written.filter((t) => readersOf(t, f.writes.get(t)).length > 0)
  let readback: string | null = d.readbackHint ?? null
  if (!readback && readTables.length) { const r = readersOf(readTables[0], f.writes.get(readTables[0])); readback = `${readTables[0]} read by ${r[0]}${r.length > 1 ? ` (+${r.length - 1})` : ""}` }
  if (!readback && !written.length && f.egress.length) readback = "send intent / provider receipt read by lib/outcomes reconciliation (dispatch door)"
  const uiReader = written.map((t) => readersOf(t, f.writes.get(t)).map(uiSurfaceOf).find(Boolean)).find(Boolean)
  const notLive = written.filter((t) => !LIVE.has(t))
  const missing: Link[] = []
  if (!d.trigger) missing.push("trigger")
  if (!d.worker) missing.push("worker")
  if (consequential) {
    if (!owner) missing.push("owner")
    if (!decision) missing.push("decision")
    if (!evidence) missing.push("evidence")
    if (!readback) missing.push("readback")
  }
  if (notLive.length) missing.push("schema")
  const heldWhy = OWNER_HELD[d.id] ?? d.heldWhy ?? derivedDoorHold(d, missing, decision)
  const st: State = heldWhy ? "owner-held" : stateOf(missing)
  const planes = planesOf(d, d.lensTables ?? written)
  const surfaces = surfacesOf(d, d.lensTables ?? written)
  const effects = effectsOf(d)
  // the risk lens reads what the action DOES, not the generic usage meter every metered action also writes (billing_usage,
  // ai_tool_usage …): a blog draft is not a billing action because its usage is metered. Paid-vendor metering stays in.
  const text = rowText(d, effects.writes.filter((t) => !METER_TABLES.has(t)))
  const domain_b2 = domainOf(planes, text)
  const risk_class = riskOf(text, effects.egress, d.toolRisk, consequential, domain_b2)
  const cls = classify({ id: d.id, kind: d.kind, state: st, missing, consequential, worker: !!d.worker, effects, auditOnlyEmits: d.auditOnlyEmits, elsewhere: d.elsewhere,
    providerRoute: d.kind !== "server_action" && PROVIDER_ROUTES.has("/" + d.entry.split(":")[0].replace(/^app\//, "").replace(/\/route\.tsx?$/, "")), ownerHeldWhy: heldWhy })
  const sourceTrust = f.session ? "authenticated session" : d.kind === "webhook" || (d.kind === "http" && decision?.startsWith("provider of record")) ? (f.signature ? "provider (signature-verified)" : "provider (UNVERIFIED)")
    : d.kind === "cron" ? "scheduler (CRON_SECRET)" : ["kernel_event", "orchestrator_event", "manager_signal"].includes(d.kind) ? "internal bus (trusted emitter)"
    : decision?.startsWith("internal caller") ? "platform internal caller (fail-closed shared secret)"
    : d.kind === "capability" ? "agent token (scope-gated)" : d.kind === "assistant_tool" ? "authenticated session (assistant)" : d.kind === "provider_egress" ? "calling module (DispatchActorContext)"
    : "anonymous / unauthenticated on the path"
  const row0 = {
    action_id: d.id, file_line: d.entry,
    task_type: effects.egress.length ? "send / provider call" : effects.writes.some((t) => !CARRIER_OR_EVIDENCE(t)) ? "state change" : effects.writes.length ? "record / route only" : consequential ? "declared consequential, no effect seen on its own path" : "read / decide",
    tenant_actor_source: `${d.actorHint ?? (f.session ? `signed-in user (${f.session.token})` : d.kind)} · ${f.platform ? "platform" : f.tenant ? "tenant from the path" : "tenant unresolved"}`,
    source_trust: sourceTrust,
    permitted_writer_egress: [...effects.writes.slice(0, 4), ...effects.egress.slice(0, 2)].join(", ") || "none on its own path",
    next_trigger_or_terminal: f.next ? `${f.next.token} @ ${f.next.at}` : "terminal (no downstream trigger on the path)",
    failure_handling: f.recovery ? `${f.recovery.token} @ ${f.recovery.at}` : d.kind === "cron" ? "next scheduled tick" : U("no retry / sweep / escalation on the path"),
    ledger_evidence: evidence ?? U(consequential ? "no ledger door and no ledger-shaped row on the path" : "not required (not consequential)"),
    domain_b2, path_effects: effects, classification: cls?.c ?? null, classification_evidence: cls?.ev ?? "working — nothing to classify", risk_class,
  }
  const out: Row = {
    id: d.id, domain: planes[0] ?? "(unclassified)", planes, surfaces, entrypoint: d.entry, trigger_kind: d.kind,
    trigger: d.trigger ?? U(TRIGGER_WHY[d.kind]), source_event: d.source_event,
    actor: d.actorHint ?? (f.session ? `signed-in user (${f.session.token})` : d.kind === "webhook" ? "external provider" : d.kind === "cron" ? "scheduler (cron dispatch)" : "system"),
    tenant_scope: f.platform ? "platform" : f.tenant ? "tenant (brokerage-scoped on the path)" : U("no brokerage predicate or platform gate on the path"),
    subject: d.subject ?? (written[0] ?? U("the path writes no table")),
    typed_action: d.action,
    decision_owner: decision ?? U("no authority / approval / spend / compliance / arbiter call on the path"),
    registered_manager: owner ?? U(d.ownerWhy ?? "no registry names an owner"),
    worker: d.worker ?? U("nothing executes it"),
    policy_gate: f.gates.length ? f.gates.slice(0, 3).map((g) => `${g.token} @ ${g.at}`).join("; ") : U("no gate token on the path"),
    consent: f.consent ? `${f.consent.token} @ ${f.consent.at}` : f.egress.some((e) => e.token.startsWith("dispatch")) ? `dispatch policy chain (${OUTBOUND_GATES.slice(0, 3).join(", ")}) @ ${DISPATCH_FILE}` : consequential && f.egress.length ? U("egress without a consent gate on the path") : "n/a (no outbound contact)",
    budget: f.budget ? `${f.budget.token} @ ${f.budget.at}` : f.egress.length ? U("egress without a spend gate on the path") : "n/a",
    dependencies: f.reads.size ? [...f.reads].slice(0, 4).join(", ") + (f.reads.size > 4 ? ` (+${f.reads.size - 4})` : "") : "none read",
    deadline: d.deadline ?? (f.gates.find((g) => /evaluateApprovalSla/.test(g.token)) ? "approval SLA" : "none on the path"),
    writer: [...written.slice(0, 4), ...[...new Set(f.egress.map((e) => e.token))].slice(0, 2)].join(", ") || "none (read / decide only)",
    receipt: f.egress.length ? `DispatchResult from ${f.egress[0].token} @ ${f.egress[0].at}` : written.length ? `row write ${f.writes.get(written[0])}` : "n/a",
    readback: readback ?? U(written.length ? `no reader of ${written.slice(0, 3).join(", ")} outside the writer` : "nothing persisted to read back"),
    downstream_trigger: f.next ? `${f.next.token} @ ${f.next.at}` : "none on the path",
    recovery: f.recovery ? `${f.recovery.token} @ ${f.recovery.at}` : d.kind === "cron" ? "next scheduled tick (cron dispatch)" : U("no retry / sweep / escalation on the path"),
    operator_surface: uiReader ? `${uiReader}` : U(written.length ? "no UI-side reader of what it writes" : "no persisted state"),
    test: testsFor(d.entry.split(":")[0], d.action),
    consequential, state: st, missing,
    why: heldWhy ?? (missing.length ? `missing: ${missing.join(", ")}` : consequential ? "trigger → worker → owner → decision → evidence → readback" : "read / decide surface: trigger → worker"),
    ...row0, root_cause_group: null,
  }
  out.root_cause_group = groupOf(out)
  return out
}
/** Callback routes the providers deliver to, read from lib/providers/channel-provider-matrix.ts PROVIDER_RECEIVE_TRUTH (census). */
let PROVIDER_ROUTES = new Set<string>()
let SQL_TEXT: string | undefined
const TRIGGER_WHY: Record<TriggerKind, string> = {
  cron: "not in CRON_REGISTRY and no in-repo self-call", kernel_event: "no emission site (an emit call carrying KernelEvent.X, its literal or a named constant)",
  orchestrator_event: "no logEventAndTrigger / emitEventFromCron site carries the type", manager_signal: "no publishManagerSignal site carries the type (literal or named constant)",
  capability: "not in the manifest", assistant_tool: "no case in the tool-call route", provider_egress: "no importer",
  webhook: "no exported handler", http: "no in-repo /api caller (an external caller is possible: unreferenced is not dead)",
  server_action: "no in-repo importer (a public server action may still be called externally: unreferenced is not dead)",
}
/** PURE — the one state rule (positive controls drive it directly). */
function stateOf(missing: Link[]): State {
  if (missing.includes("trigger") || missing.includes("worker")) return "missing"
  return missing.length ? "partial" : "working"
}

// ══ 6b. WHAT KIND OF WORK EACH GAP IS (wave 155, lane 155B1 — directive B1 / B4) ═════════════════════════════════════════
// An ADDITIONAL column. It never changes a row's working / partial / missing verdict and never touches the baseline: it says
// whether a gap is a workflow to repair (EXECUTABLE_GAP), a read / registry entry that needs no mutating-action receipt
// (DECLARATIVE_READ_ONLY — only where the row's OWN path provably writes, sends and spends nothing), a retired surface with no
// caller of any kind (LEGACY_ORPHAN — proven per CLAUDE.md §1, else UNKNOWN), complete code waiting on a provider
// (SIMULATED_ONLY), a held decision (OWNER_HELD) or not provable either way (UNKNOWN — never promoted). Every rule is a
// predicate over derived fields; there is no list of row ids and no wildcard. Positive + negative fixtures: section F.
const CARRIER_OR_EVIDENCE = (t: string) => CARRIER_TABLES.has(t) || isLogTable(t)
const COST_LEDGER_TABLES = new Set(["ai_tool_usage"]) // CLAUDE.md §5: the AI cost ledger
const METER_TABLES = new Set(["ai_tool_usage", "billing_usage", "usage_counters", "feature_usage_tracking"])
/** Consequential at the SINK — WAVE155_EVAL_SPEC SCOPE-001..005 / INJECT-001..005: an outbound send, paid acquisition, a commission
 *  edit / payout / CDA release, a legal document or e-sign, money, a credential. Read over the row's entry, action and written tables. */
const P0_SINK_RE = /commission|payout|\bcda\b|closing_disclosure|invoice|billing|subscription|stripe|payment|ledger_entr|refund|credential|api_key|oauth|secret|e_?sign|docusign|dotloop|signature|contract|agreement|\boffers?\b|offer_|scrap|skip_trace|apify|batchdata|peoplesearch|datafiniti|ad_campaign|ad_spend|audience_sync|vendor_usage|overage|settlement|\btax|expense|escrow|earnest|frozen_terms|wire_fraud|impersonat|platform_role/
const CUSTOMER_RE = /contact|\blead|leads?_|message|portal|client|buyer|seller|listing|showing|sms|email|newsletter|social|video|campaign|chat|visitor|widget|open_house/
const EDUCATION_RE = /recruit|gamif|point|badge|academy|coach|competen|education|training|course|quiz|learning|ce_/
const RECOVERY_RE_B2 = /recover|heal|incident|error|health|cron|heartbeat|sentinel|deploy|observab|fatigue|support|ticket|dead_letter|retry|exception/
function domainOf(planes: string[], text: string): Domain {
  const p = planes[0] ?? ""
  if (p.startsWith("P10")) return EDUCATION_RE.test(text) ? "education" : RECOVERY_RE_B2.test(text) ? "recovery" : "platform"
  if (p.startsWith("P9")) return "finance"
  if (p.startsWith("P8")) return "transaction"
  if (p.startsWith("P7") || p.startsWith("P5")) return "customer-facing"
  if (p.startsWith("P6")) return "marketing"
  if (p.startsWith("P4")) return "acquisition"
  return "platform"
}
function riskOf(text: string, egress: string[], toolRisk: string | undefined, consequential: boolean, domain: Domain): RiskClass {
  if (egress.some((e) => e !== "dispatchWebSearch")) return "P0" // an outbound send / provider spend (SCOPE-001 / 002)
  if (toolRisk && ["COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE"].includes(toolRisk)) return "P0"
  if (P0_SINK_RE.test(text) || domain === "finance") return "P0"
  if (consequential && (["acquisition", "customer-facing", "marketing", "transaction"].includes(domain) || CUSTOMER_RE.test(text))) return "P1"
  return "P2"
}
/** The row's own effects: what ITS path writes / sends / spends (a shared route head is excluded where the draft says so). */
function effectsOf(d: Draft): Row["path_effects"] {
  const o = d.ownFacts ?? d.facts
  return { writes: [...o.writes.keys()], egress: [...new Set(o.egress.map((e) => e.token))], spend: o.budget ? `${o.budget.token} @ ${o.budget.at}` : null }
}
interface ClassInput { id: string; kind: TriggerKind; state: State; missing: Link[]; consequential: boolean; worker: boolean; effects: Row["path_effects"]
  auditOnlyEmits?: boolean | null; elsewhere?: string[]; providerRoute?: boolean; ownerHeldWhy?: string }
/** PURE — the classification rule (directive B1). Returns null for a working row (nothing to classify). */
function classify(x: ClassInput): { c: Classification; ev: string } | null {
  if (x.state === "working") return null
  if (x.state === "owner-held") return { c: "OWNER_HELD", ev: `OWNER_HELD entry: ${x.ownerHeldWhy ?? "held"}` }
  if (x.missing.includes("schema")) return { c: "EXECUTABLE_GAP", ev: "writes a table that is not live" }
  const noEffects = !x.effects.writes.length && !x.effects.egress.length && !x.effects.spend
  if (x.missing.includes("trigger")) {
    const elsewhere = x.elsewhere ?? []
    if (x.kind === "kernel_event" || x.kind === "orchestrator_event" || x.kind === "manager_signal") {
      if (elsewhere.length) return { c: "UNKNOWN", ev: `no emitter the census can read, but the value is carried by ${elsewhere.slice(0, 2).join(", ")}${elsewhere.length > 2 ? ` (+${elsewhere.length - 2})` : ""} — a run-time emission cannot be ruled out` }
      if (!x.worker) return { c: "LEGACY_ORPHAN", ev: "vocabulary entry with no emitter, no consumer, and its value in no other runtime file and no SQL migration" }
      return { c: "EXECUTABLE_GAP", ev: "a consumer waits for an event nothing emits (value in no other runtime file and no SQL migration)" }
    }
    if (x.kind === "server_action") {
      if (elsewhere.length) return { c: "UNKNOWN", ev: `no importer and no same-module caller, but the name appears in ${elsewhere.slice(0, 2).join(", ")}${elsewhere.length > 2 ? ` (+${elsewhere.length - 2})` : ""}` }
      return { c: "LEGACY_ORPHAN", ev: "no importer, no same-module caller, the export name in no other runtime file; a server action has no cron, webhook, self-call or provider-console surface (it is reachable only through a bundled import)" }
    }
    if (x.providerRoute && x.missing.length === 1) return { c: "SIMULATED_ONLY", ev: "fully linked in code; the only absent link is the provider's own callback registration (PROVIDER_RECEIVE_TRUTH route), which is a console setting, not code" }
    return { c: "UNKNOWN", ev: `${x.kind}: the caller may be outside the repo (provider console, external client, another scheduler) — unreferenced is not dead (CLAUDE.md §1)` }
  }
  if (x.missing.includes("worker")) {
    if (x.kind === "kernel_event" && x.auditOnlyEmits === true) return { c: "DECLARATIVE_READ_ONLY", ev: "every emission site passes `auditOnly: true` (lib/kernel/emit.ts shouldFanOut skips the reactor): the lifecycle_events row IS the record; no write, send or spend follows it" }
    return { c: "EXECUTABLE_GAP", ev: x.kind === "kernel_event" ? (x.auditOnlyEmits === null ? "emitted and fanned out with no consumer (an emission site is not a readable door call — audit-only cannot be proven)" : "emitted and fanned out to the reactor, which has no consumer") : "registered, nothing executes it" }
  }
  if (x.kind === "assistant_tool" && noEffects && x.worker) return { c: "DECLARATIVE_READ_ONLY", ev: "the tool's own case writes no table, calls no egress door and passes no spend gate; it is consequential only because its risk class is not READ" }
  return { c: "EXECUTABLE_GAP", ev: `a reachable path lacks ${x.missing.join(", ")}` }
}

// ── THE ROOT-CAUSE GROUPS: one shared change closes each. First matching rule wins; every EXECUTABLE_GAP lands in exactly one
//    group (the fallback is per kind + missing signature, so nothing is swallowed by a wildcard). The leverage point is a
//    function token resolved to file:line in stripped source at render time. ──
interface GroupDef { id: string; title: string; leverage: Array<[string, string]>; fix: string; proof: string; split: string; match: (r: Row) => boolean }
const isSessionDecided = (r: Row) => /^(session actor|human approver)/.test(r.decision_owner)
/** the populations whose owner IS ownerFromWrites (a cron / tool / capability / signal owner comes from its own registry) */
const OWNER_FROM_WRITES_KINDS: TriggerKind[] = ["http", "webhook", "server_action", "kernel_event"]
const unstewarded = (r: Row) => r.path_effects.writes.filter((t) => !CARRIER_TABLES.has(t) && !isLogTable(t) && !TABLE_MANAGER[t])
const GROUPS: GroupDef[] = [
  { id: "G01-event-no-consumer", title: "kernel events emitted and fanned out, but the reactor has no case — the event dies at the bus", leverage: [["lib/kernel/event-reactor.ts", "dispatchKernelEvent"], ["lib/kernel/emit.ts", "emitKernelEvent"]],
    fix: "per event: a reactor case that publishes the owning manager's registered signal (the 151 routed events are the pattern), OR — where the owner has ruled it a record — `auditOnly: true` at the emit site (an owner decision, never a default)", proof: "a canary emits each event through dispatchKernelEvent against memSupabase and asserts a manager_signals row for the named consumer; red at the base (zero rows)", split: "split by domain (one lane per 2–3 domains); the reactor file is shared — serialize edits",
    match: (r) => r.trigger_kind === "kernel_event" && r.missing.includes("worker") },
  { id: "G02-consumer-no-emitter", title: "a handler waits for an event no code emits (reads with no writer)", leverage: [["lib/kernel/emit.ts", "emitKernelEvent"], ["lib/orchestrator/internal.ts", "EVENT_HANDLERS"]],
    fix: "emit at the canonical writer of the domain fact (the table write that IS the event), or tombstone the handler naming its survivor (CLAUDE.md §1)", proof: "a canary drives the writer and asserts the handler ran; red at the base", split: "one lane (≤ 20 rows); coordinate orchestrator rows with lane 155B2",
    match: (r) => (r.trigger_kind === "kernel_event" || r.trigger_kind === "orchestrator_event") && r.missing.includes("trigger") },
  { id: "G03-orchestrator-unowned", title: "orchestrator EVENT_HANDLERS carry no owning manager (the census has no owner registry to read for them)", leverage: [["lib/orchestrator/internal.ts", "EVENT_HANDLERS"]],
    fix: "give each handler its registered manager through the existing registries (integrator: a row per handler in manager-registry, read by the census) — lane 155B2 owns these handlers now", proof: "census: orchestrator rows resolve an owner in MANAGERS; a planted handler with no row stays red", split: "hand to 155B2's follow-up; do not split",
    match: (r) => r.trigger_kind === "orchestrator_event" },
  { id: "G04-reactor-ungated", title: "reactor blocks that WRITE a domain table with no gate and no ledger receipt", leverage: [["lib/kernel/event-reactor.ts", "dispatchKernelEvent"], ["lib/kernel/action-ledger.ts", "withActionLedger"]],
    fix: "route the block through the owning manager's signal (decision moves to the consumer), or wrap its write in withActionLedger under the manager's gate", proof: "a canary per block: the reactor write leaves an agent_action_ledger row; red at the base", split: "one lane",
    match: (r) => r.trigger_kind === "kernel_event" && (r.missing.includes("decision") || r.missing.includes("evidence")) },
  { id: "G05-cron-no-decision", title: "crons whose path asks no gate — no halt, authority, spend or approval decides the run", leverage: [["lib/kernel/cron-logging.ts", "createCronRunContext"], ["lib/managers/autonomy-gate.ts", "autonomyDecision"], ["lib/kernel/manager-registry.ts", "resolveCronManager"]],
    fix: "ONE cron decision at the shared run-context door: resolveCronManager(path) + autonomyDecision over the platform halt (god switch) and the tenant halt, recorded on the run row; a held run records `held` and does no work. Alternative is OWNER decision 2 (does a registered manager's deterministic rule count as the decision owner?) — that would be an analyzer change, not code", proof: "planted platform halt: every manager cron returns `held` with zero domain writes; red at the base (they run)", split: "one lane for the door; the per-route adoption is mechanical (routes already call the run-context actions)",
    match: (r) => r.trigger_kind === "cron" && r.missing.includes("decision") },
  { id: "G06-cron-no-evidence", title: "crons that never open a cron run context, so no run row evidences what they did", leverage: [["lib/kernel/cron-logging.ts", "recordCronSuccess"]],
    fix: "open createCronRunContext / recordCronSuccess / recordCronFailure like the other 200 crons", proof: "a canary runs the route against memSupabase and asserts a cron_execution_logs row; red at the base", split: "one lane",
    match: (r) => r.trigger_kind === "cron" && r.missing.includes("evidence") },
  { id: "G07-tool-unowned", title: "assistant tools that act but name no owning manager", leverage: [["lib/voice/tool-registry.ts", "VOICE_TOOL_MANAGER"]],
    fix: "a VOICE_TOOL_MANAGER row per tool (integrator — shared registry); a tool that only reads is DECLARATIVE_READ_ONLY instead and needs its risk class set to READ", proof: "census: owner resolves in MANAGERS; the guard's fake-manager control stays red", split: "integrator, one change",
    match: (r) => r.trigger_kind === "assistant_tool" && r.missing.includes("owner") },
  { id: "G08-table-no-steward", title: "paths that write a table no TABLE_MANAGER row stewards", leverage: [["lib/kernel/manager-registry.ts", "TABLE_MANAGER"]],
    fix: "a TABLE_MANAGER row per unstewarded table (integrator; the table list is in os-arbitration-gap-groups.json)", proof: "census: owner resolves; a planted unstewarded write stays red (section C control)", split: "integrator, one change",
    match: (r) => r.missing.includes("owner") && unstewarded(r).length > 0 },
  // WAVE 155 (lane 155R16): CLOSED by isLogTable (one predicate for ownership AND evidence). Kept as a TRIPWIRE — a row that misses
  // an owner while writing a stewarded table the log rule calls a DOMAIN table means ownerFromWrites and isLogTable disagree again.
  { id: "G08b-stewarded-table-read-as-log", title: "the path writes a STEWARDED domain table yet reads as unowned — the log rule (isLogTable) and the owner rule disagree (closed by lane 155R16; a tripwire)", leverage: [["scripts/os-coverage-ledger.ts", "logTableRule"], ["lib/kernel/manager-registry.ts", "TABLE_MANAGER"]],
    fix: "ownerFromWrites and factsOfSpan must read the SAME isLogTable predicate (a log by name, or a record-suffixed table no runtime code rewrites); a row here means one of them stopped doing so", proof: "section G: a planted write to calendar_events resolves its owner from TABLE_MANAGER and earns NO evidence; a planted append-only compliance_events write earns evidence and NO owner", split: "analyzer only",
    match: (r) => r.missing.includes("owner") && OWNER_FROM_WRITES_KINDS.includes(r.trigger_kind) && r.path_effects.writes.some((t) => !CARRIER_TABLES.has(t) && !isLogTable(t) && !!TABLE_MANAGER[t]) },
  { id: "G09-log-only-owner", title: "paths whose only writes are carriers or evidence tables (self_heal_events, audit_log, notifications…) — no steward is derivable", leverage: [["lib/kernel/manager-registry.ts", "resolveTableManager"]],
    fix: "name the owner where the action is (the module's manager) or route the record through the owner's signal; never steward a log table to move a number", proof: "census: owner resolves for each; planted log-only write stays red", split: "one lane",
    match: (r) => r.missing.includes("owner") },
  { id: "G10-public-no-decision", title: "public / internal endpoints with no session and no decision on the path (tracking beacons, embeds, intake uploads)", leverage: [["lib/widget/resolve-widget-tenant.ts", "resolveWidgetTenant"], ["lib/usage/check-cap.ts", "checkUsageCap"]],
    fix: "resolve the tenant fail-closed from the tenant's own opt-in (resolveWidgetTenant pattern) and cap spend (checkUsageCap) before the write; a rate limit alone is not a decision", proof: "INJECT-001 canary: a body-supplied tenant is ignored and an un-opted-in slug writes nothing; red where the route trusts the body", split: "one lane (≤ 25 rows)",
    match: (r) => r.missing.includes("decision") && !isSessionDecided(r) },
  { id: "G11-ai-spend-unledgered", title: "AI generate-and-return actions whose only persisted effect is the cost ledger row (a model call with no action receipt)", leverage: [["lib/kernel/action-ledger.ts", "ledgerToolCall"]],
    fix: "wrap the model call in ledgerToolCall (tool, cost, actor, tenant) — ai_tool_usage keeps metering, the ledger carries why and under which policy", proof: "a canary calls the action with an injected model seam and asserts one ledger row + one ai_tool_usage row; red at the base", split: "one lane",
    match: (r) => r.missing.includes("evidence") && r.path_effects.writes.filter((t) => !CARRIER_OR_EVIDENCE(t)).every((t) => COST_LEDGER_TABLES.has(t)) && r.path_effects.writes.some((t) => COST_LEDGER_TABLES.has(t)) },
  ...(["P0", "P1", "P2"] as const).map((rc): GroupDef => ({ id: `G12-session-write-unledgered-${rc}`, title: `${rc} user-initiated writes decided by the signed-in session that leave no action-ledger receipt`, leverage: [["lib/kernel/action-ledger.ts", "withActionLedger"]],
    fix: "per MODULE (not per export): resolve the ActionContext once where the module already resolves its session, and wrap each mutating export's write in withActionLedger (three-segment action name) — the module list with rows closed per change is in os-arbitration-gap-groups.json", proof: "per module: a canary invokes one export against memSupabase and asserts an agent_action_ledger row naming actor, tenant and policy; red at the base", split: rc === "P2" ? "split by module across lanes; lowest priority" : "split by domain; P0 modules first",
    match: (r: Row) => r.missing.includes("evidence") && isSessionDecided(r) && r.risk_class === rc })),
  { id: "G13-webhook-no-evidence", title: "provider callbacks that write without a ledger receipt", leverage: [["lib/kernel/action-ledger.ts", "withActionLedger"]],
    fix: "record the callback's effect in withActionLedger (actor = provider of record)", proof: "replay a signed fixture payload; assert one ledger row; red at the base", split: "one lane",
    match: (r) => r.trigger_kind === "webhook" && r.missing.includes("evidence") },
  { id: "G14-no-readback", title: "paths that persist state nobody reads", leverage: [["lib/kernel/manager-registry.ts", "TABLE_MANAGER"]],
    fix: "add the operator surface that reads it, or stop writing it (orphan doctrine: name the survivor)", proof: "census readback resolves to a reader outside the writer", split: "one lane",
    match: (r) => r.missing.includes("readback") },
]
/** PURE — the root-cause group of an EXECUTABLE_GAP row (null for every other classification). */
function groupOf(r: Row): string | null {
  if (r.classification !== "EXECUTABLE_GAP") return null
  const g = GROUPS.find((x) => x.match(r))
  return g ? g.id : `G99-${r.trigger_kind}-${sig(r.missing).replace(/,/g, "+")}`
}

// ── THE TEN PLANES OF A2 and the A7.1 SURFACES — each a LEXICAL matcher over the row's entry path, action and written tables.
//    The classification is a lens (stated as a blind spot); the rows and their states are derived from code. ──
const PLANES: Array<[string, RegExp]> = [
  ["P1 platform · billing · metering", /superadmin|platform|meter|usage|billing|subscription|stripe|invoice|overage|feature_access|entitle|suspend|dunning|credential|trial/],
  ["P2 tenant provisioning · seats · offices · websites", /onboard|invit|seat|office|location|membership|website|domain|tenant|brokerage_settings|brokerages\b|user_role|users\b|provision|signup|teams?\b/],
  ["P3 command center · NL / voice · tasks · approvals", /command|assistant|voice|tool.call|ai.chat|copilot|task|approval|mission|search|delegat/],
  ["P4 raw acquisition · RawData · Raw Lead · Lead", /raw|scrap|apify|zyte|zenrows|exa\b|datafiniti|rentcast|versium|batchdata|peoplesearch|skip.trace|lead.source|acquisition|dedup|suppress|enrich|isa\b|ai_isa|leads?\b|speed.to.lead/],
  ["P5 prospects · contacts · portal · conversation", /contact|portal|buyer|seller|persona|saved|alert|tour|showing|customer|chat|conversation|sms|inbound|message/],
  ["P6 marketing · content · channels · ads", /market|campaign|content|topic|refurbish|omnipresen|asset|media|seo|magnet|social|qr\b|newsletter|blog|podcast|video|remotion|did\b|avatar|\bads?\b|ad_|direct.mail|anniversar|lifetime|ghost|roi\b|youtube|book/],
  ["P7 listings · shopping agent · MLS / IDX", /listing|concierge|shopping|mls|idx|photo|open.house|cma\b|valuation|avm|propert/],
  ["P8 offers · transactions · documents · closing", /offer|counter|addend|transaction|deal|esign|e.sign|docusign|dotloop|document|closing|compliance|lender|title|trid|insurance|contingen|coordinator/],
  ["P9 commission · settlement · brokerage finance", /commission|cda\b|settlement|residual|royalt|expense|tax|payout|referral|financ|accounting|quickbooks|fee|ledger_entr|p.?l\b/],
  ["P10 recruiting · gamification · support · ops", /recruit|gamif|point|badge|academy|coach|report|competen|fatigue|support|ticket|recover|heal|incident|deploy|observab|health|cron|heartbeat|sentinel|error|education/],
]
const PLANE_PRIORITY = [8, 7, 6, 3, 5, 4, 0, 1, 9, 2]
function rowText(d: Draft, written: string[]): string { return `${d.kind} ${d.entry.split(":")[0]} ${d.action} ${d.source_event} ${written.join(" ")}`.toLowerCase().replace(/[-/]/g, "_") }
function planesOf(d: Draft, written: string[]): string[] {
  const t = rowText(d, written).replace(/_/g, " ")
  return PLANE_PRIORITY.filter((i) => PLANES[i][1].test(t)).map((i) => PLANES[i][0])
}
const A71: Array<[string, RegExp]> = [
  ["SaaS subscriber lifecycle", /subscription|billing|plan.snapshot|agreement|suspend|renew|cancel|stripe|checkout|dunning/],
  ["Organization and membership", /invit|office|seat|membership|team.member|revoc|deactivat|location|transfer/],
  ["Tenant website / landing / IDX", /website|landing|domain|idx|lead.magnet|form.submi|forms?\b/],
  ["Platform provider fabric", /provider|connector|credential|vendor.budget|rate.limit|fallback|routeCapability|byok|connection/],
  ["Platform security", /security|permission|policy|export|isolation|impersonat|audit|access/],
  ["Kernel supervisor / mission board", /mission|supervisor|objective|controller/],
  ["Manager-to-manager bus", /signal|delegat|referral|handoff|dissent|deliberat/],
  ["Cron / scheduling / watchers", /cron|schedul|watcher|sweep|reaper|tick|dispatch.due/],
  ["Natural-language and voice command", /voice|assistant|tool.call|ai.chat|copilot|intent|command/],
  ["Raw external research", /exa\b|google|apify|zyte|zenrows|scrap|public.record|web.search|research/],
  ["RawData and identity", /raw.data|raw_|identity|dedup|match|skip.trace|crosswalk/],
  ["Raw Lead to Lead", /raw.lead|promot|qualif|gate.eligib|lead.score/],
  ["Lead to Contact", /convert.lead|lead.to.contact|conversion|assign|claim/],
  ["Existing Contact / Customer 360", /contact|customer.360|preference|persona|stage|intent/],
  ["Conversation / AI ISA", /isa\b|ai_isa|conversation|reply|inbound|sms|voicemail|speed.to.lead|followup|follow.up/],
  ["Consumer portals / stage education, collaboration", /portal|saved.home|family|collaborat|education/],
  ["Shopping Agent / property search", /shopping|property.search|buyer.search|rentcast|mls|idx|coming.soon/],
  ["Market Twin / intelligence graph", /twin|intelligence|permit|housing.match|economic|market.signal/],
  ["Content-topic pool", /topic|content.idea|virality|competitor/],
  ["Brand / asset studio", /asset|did\b|avatar|remotion|render|image|podcast|book|print|brand/],
  ["Paid advertising", /\bads?\b|ad_campaign|ad.creative|audience|meta.ads|google.ads|tv.spot/],
  ["Outbound channels", /email|sms|voice.call|social|direct.mail|qr\b|notification|push|dispatch/],
  ["Campaign bundles / Refurbish / Omnipresence", /bundle|refurbish|omnipresen|campaign.sequence|episode|saturation/],
  ["Events and community intelligence", /event.kind|open.house|local.event|community|webinar|zoom/],
  ["Circle learning and top producers", /circle|top.producer|cohort|tactic|playbook/],
  ["Listing lifecycle", /listing|presentation|photograph|mls.live|coming.soon|agreement.signed/],
  ["Offers / counters", /offer|counter|e.?sign|accepted/],
  ["Transaction / deal coordination", /transaction|deal|checklist|tc.task|vendor.assign|moving|contingen/],
  ["Addenda / document intelligence", /addend|document|term.change|amend/],
  ["Compliance and CDA", /compliance|cda\b|broker.review|required.doc/],
  ["Lender / title / insurance", /lender|title|insurance|trid|closing.disclosure|appraisal|\bcd\b/],
  ["Commission and settlement", /commission|settlement|split|concession|residual|cap\b|payout/],
  ["Brokerage finance", /office.receipt|expense|tax|accounting|quickbooks|p.?l\b|brokerage.fee|financ/],
  ["ROI and budgets", /roi\b|attribution|spend|budget|return/],
  ["Gamification / Academy", /gamif|point|badge|academy|training|competenc/],
  ["Recruitment / onboarding", /recruit|applicant|onboard/],
  ["Sphere / lifetime / reviews", /sphere|lifetime|anniversar|equity|refinance|review|ghost|reactivat/],
  ["Support / education", /support|ticket|triage|faq|help/],
  ["Operations and incidents", /incident|runtime|storage|failed.job|timeout|retry|self.heal|dead.letter|recover/],
  ["Audit / security / production", /deploy|owner.sql|live.test|readiness|dpa|legal.approval|certif/],
]
function surfacesOf(d: Draft, written: string[]): string[] {
  const t = rowText(d, written).replace(/_/g, " ")
  return A71.filter(([, re]) => re.test(t)).map(([s]) => s)
}

// ══ 7. EXPORT BODIES (for "use server" exports and dispatch doors) ═══════════════════════════════════════════════════════
interface FnSpan { name: string; start: number; end: number; exported: boolean; line: number }
function matchBrace(ids: string, open: number): number {
  let depth = 0
  for (let i = open; i < ids.length; i++) { const c = ids[i]; if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) return i } }
  return ids.length - 1
}
function matchParen(ids: string, open: number): number {
  let depth = 0
  for (let i = open; i < ids.length; i++) { const c = ids[i]; if (c === "(") depth++; else if (c === ")") { depth--; if (depth === 0) return i } }
  return ids.length - 1
}
function matchBracket(ids: string, open: number): number {
  let depth = 0
  for (let i = open; i < ids.length; i++) { const c = ids[i]; if (c === "[") depth++; else if (c === "]") { depth--; if (depth === 0) return i } }
  return ids.length - 1
}

// ── wave 155 (lane 155B1): the four new derivations, PURE so section F drives each with a positive and a negative fixture ──
/** PURE (wave 155, lane 155R16 — the rides rule of scripts/event-claims-guard.ts classify(), lane 155R6 request 2). Each site
 *  RIDES (1) the innermost door call whose span contains it; else (2) for `const NAME = …KernelEvent.X…`, the first later door
 *  call whose span uses NAME; else (3) a map VALUE (`'state': KernelEvent.X`) of a map the file looks up by key (`NAME[…]`) rides
 *  the file's doors as a whole. A site that rides nothing is not an emission. Returns true = every riding call is audit-only;
 *  false = one fans out; null = one passes a non-literal auditOnly (unprovable — never read-only); undefined = no site rides. */
function auditOnlyAt(ids: string, sites: number[], calls: Array<[number, number, boolean | null]>): boolean | null | undefined {
  let any = false, unprovable = false
  for (const pos of sites) {
    let rides: [number, number, boolean | null] | "file" | null = calls.filter(([s, e]) => pos > s && pos < e).sort((a, b) => b[0] - a[0])[0] ?? null
    if (!rides) {
      const decl = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=[^;\n]*(?:\n[^;\n]*){0,3}$/.exec(ids.slice(Math.max(0, pos - 200), pos))
      if (decl) rides = calls.find(([s, e]) => s > pos && new RegExp(`\\b${reEsc(decl[1])}\\b`).test(ids.slice(s, e))) ?? null
      if (!rides && /[\w'"\]]\s*:\s*$/.test(ids.slice(Math.max(0, pos - 80), pos)) && (!decl || new RegExp(`\\b${reEsc(decl[1])}\\s*\\[`).test(ids))) rides = "file"
    }
    if (!rides) continue
    any = true
    const audit = rides === "file" ? (calls.some(([, , a]) => a === false) ? false : calls.some(([, , a]) => a === null) ? null : calls.length ? true : null) : rides[2]
    if (audit === false) return false
    if (audit === null) unprovable = true
  }
  return !any ? undefined : unprovable ? null : true
}
/** PURE (wave 155, lane 155R22) — a file's local ALIASES of an emit door: `const NAME = <one statement that NAMES a door as a
 *  value>` (lib/kernel/brokerage-identity.ts `const emit = deps.emit ?? (await import("@/lib/kernel/emit")).emitKernelEvent`;
 *  lib/ai-isa/lead-action-plan.ts `const emit = deps.emit ?? (async (input) => (…).emitKernelEvent(input))`). A call through the
 *  alias IS a door call, judged by its OWN arguments exactly like the door (scripts/event-claims-guard.ts counts every `emit(`
 *  as a door; this is narrower: only a binding whose initializer names one). An initializer that CALLS the door at its head
 *  (`const r = await emitKernelEvent(…)`) binds a result, not a door. `spans` = the initializers: the forwarding call inside
 *  one is the alias's body, not an emission. Blind spot: file-level, not scope-aware (a same-named binding elsewhere in the
 *  file is read as the alias too). Controls: section G (G10). */
function doorAliases(ids: string, doors: string[]): { names: string[]; spans: Array<[number, number]> } {
  const names: string[] = []; const spans: Array<[number, number]> = []
  if (!doors.length) return { names, spans }
  const doorRe = new RegExp(`\\b(?:${doors.map(reEsc).join("|")})\\b`)
  const headCall = new RegExp(`^\\s*(?:await\\s+)?(?:[\\w$]+\\s*\\.\\s*)*(?:${doors.map(reEsc).join("|")})\\s*(?:<[^<>()]*>)?\\s*\\(`)
  for (const m of ids.matchAll(/(?:^|[\n;{])\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?![=>])/g)) {
    const s = m.index! + m[0].length
    let depth = 0, e = s
    for (; e < ids.length; e++) { const c = ids[e]; if (c === "(" || c === "[" || c === "{") depth++; else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth-- } else if ((c === ";" || c === "\n") && depth === 0) break }
    const init = ids.slice(s, e)
    if (!doors.includes(m[1]) && doorRe.test(init) && !headCall.test(init)) { names.push(m[1]); spans.push([s, e]) }
  }
  return { names: [...new Set(names)], spans }
}
/** PURE (wave 155, lane 155R22; the literal rule of scripts/event-claims-guard.ts classify()) — a quoted event VALUE is an
 *  emission site only when it sits inside a door call, or is keyed as an event (`event: "x"`, `event_type:`, `eventType:`).
 *  Anything else is not this event: lib/kernel/crm.ts `activity_type: "contact_archived"` on an `activities` insert fell to the
 *  file-level fallback and charged CONTACT_ARCHIVED (emitted `auditOnly: true`) with the file's other fan-out. A KernelEvent.X
 *  reference is not filtered (the map-value shape stays the census's). Controls: section G (G10). */
function literalEventSite(code: string, i: number, calls: Array<[number, number, boolean | null]>): boolean {
  return calls.some(([s, e]) => i > s && i < e) || /\bevent(?:_type|Type)?\s*:\s*$/.test(code.slice(Math.max(0, i - 40), i))
}
/** PURE (wave 155, lane 155R22) — THE EVENT LEDGER'S HOLD. scripts/event-claims-guard.ts (on the chain) holds each fan-out
 *  event no reactor case claims with ONE owner question, in scripts/event-claims-ledger.ts EVENT_OWNER_HELD. The census applies
 *  that hold — the question VERBATIM — only to a row with exactly the shape the ledger holds: emitted, no consumer, and not
 *  proven audit-only by the census itself. Any other row is not held (a consumed or audit-proven event in the list is STALE —
 *  staleEventHolds — never a reason to hide a row). An event in neither list keeps its classification (EXECUTABLE_GAP). */
function eventLedgerHold(value: string, row: { worker: boolean; emitted: boolean; auditOnlyEmits: boolean | null | undefined }, held: Record<string, string>): string | undefined {
  const q = held[value]
  if (!q || row.worker || !row.emitted || row.auditOnlyEmits === true) return undefined
  return `owner-held by the event-claims ledger (scripts/event-claims-ledger.ts EVENT_OWNER_HELD, ratcheted by test:event-claims): ${q}`
}
/** PURE — the ledger entries the census cannot honor: no kernel_event row (the event left the enum), or a row the hold did not
 *  apply to (it has a consumer, no emitter, or is proven audit-only). A stale list holds nothing; this list must be empty. */
function staleEventHolds(held: Record<string, string>, rowById: (id: string) => { state: State } | undefined): string[] {
  return Object.keys(held).filter((v) => { const r = rowById(`kernel_event:${v}`); return !r || r.state !== "owner-held" })
}
/** PURE — the direct `lifecycle_events` inserts in a file: [start, end] of each `.insert(` argument list whose `.from(` is a real
 *  call (present in the string-blanked view) of the literal `lifecycle_events` (read on the comment-blanked view). */
function directAuditInserts(v: Pick<Views, "ids">, code: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of code.matchAll(/\.from\(\s*["'`]lifecycle_events["'`]\s*\)\s*\.insert\s*\(/g)) {
    if (!v.ids.startsWith(".from(", m.index!)) continue
    const open = m.index! + m[0].length - 1; out.push([m.index!, matchParen(v.ids, open)])
  }
  return out
}
/** PURE — every door call in `ids` ([start, end, audit]): `audit` is true when the call's own arguments say `auditOnly: true` or it
 *  calls a name in `auditNames`; null when its arguments pass `auditOnly` as anything else; false otherwise. Direct lifecycle_events
 *  inserts are audit calls. */
function doorCallSpans(ids: string, code: string, doors: string[], auditNames: Set<string>): Array<[number, number, boolean | null]> {
  const out: Array<[number, number, boolean | null]> = []
  if (doors.length) for (const m of ids.matchAll(new RegExp(`\\b(${doors.map(reEsc).join("|")})\\s*(?:<[^>()]*>)?\\s*\\(`, "g"))) {
    if (/function\s+$/.test(ids.slice(Math.max(0, m.index! - 12), m.index!))) continue // the door's own declaration, not a call
    const open = m.index! + m[0].length - 1; const close = matchParen(ids, open); const args = ids.slice(open, close)
    out.push([m.index!, close, /\bauditOnly\s*:\s*true\b/.test(args) || auditNames.has(m[1]) ? true : /\bauditOnly\b/.test(args) ? null : false])
  }
  for (const [s, e] of directAuditInserts({ ids }, code)) out.push([s, e, true])
  return out
}
/** PURE — a file's own wrapper doors: a top-level function / const arrow, or a default-deps property `name: async (…)`, whose body
 *  calls a door or inserts into lifecycle_events (audit when every such call in its body is audit). */
function localWrappers(ids: string, code: string, doors: string[], auditNames: Set<string>): { doors: string[]; audit: Set<string> } {
  const out: string[] = []; const audit = new Set<string>()
  const heads = [...ids.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*async\s*\(/g)]
  for (const m of heads) {
    const name = m[1] ?? m[2] ?? m[3]
    if (doors.includes(name) || out.includes(name)) continue
    const paren = m.index! + m[0].length - 1
    const bodyOpen = ids.indexOf("{", matchParen(ids, paren) + 1); if (bodyOpen < 0) continue
    const bodyClose = matchBrace(ids, bodyOpen)
    const calls = doorCallSpans(ids.slice(bodyOpen, bodyClose + 1), code.slice(bodyOpen, bodyClose + 1), doors, auditNames)
    if (!calls.length) continue
    out.push(name)
    if (calls.every(([, , a]) => a === true)) audit.add(name)
  }
  return { doors: out, audit }
}
const AWARD_FILE = "lib/gamification/award-points.ts"
/** PURE (lane 155R16; lane 155R6 request 1) — consumer sites the structural scan cannot see: a reactor array tested with
 *  `.includes(params.event` (site = the enclosing `if`), and LIFECYCLE_AWARD_RULES events while a reactor calls
 *  awardLifecycleMilestones (site = the `if` that encloses that call). Over string-blanked sources. */
function reactorConsumerShapes(reactors: Array<{ file: string; ids: string }>, awardIds: string): Array<{ key: string; file: string; idx: number; shape: "array" | "award" }> {
  const out: Array<{ key: string; file: string; idx: number; shape: "array" | "award" }> = []
  const enclosingIf = (ids: string, pos: number): number => {
    let best = -1
    for (const m of ids.slice(Math.max(0, pos - 3000), pos).matchAll(/\bif\s*\(/g)) {
      const at = Math.max(0, pos - 3000) + m.index!; const close = matchParen(ids, at + m[0].length - 1)
      const open = ids.indexOf("{", close); if (open < 0) continue
      if ((close > pos) || (open < pos && matchBrace(ids, open) > pos)) best = at
    }
    return best
  }
  for (const r of reactors) {
    for (const m of r.ids.matchAll(/\bconst\s+([A-Z_][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*\[/g)) {
      const open = m.index! + m[0].length - 1; const body = r.ids.slice(open, matchBracket(r.ids, open))
      const test = new RegExp(`\\b${m[1]}\\.includes\\(\\s*params\\.event\\b`).exec(r.ids); if (!test) continue
      const at = enclosingIf(r.ids, test.index); if (at < 0) continue
      for (const k of body.matchAll(/\bKernelEvent\.([A-Z0-9_]+)\b/g)) out.push({ key: k[1], file: r.file, idx: at, shape: "array" })
    }
    const call = /\bawardLifecycleMilestones\s*\(/.exec(r.ids)
    if (call && !/function\s+$/.test(r.ids.slice(Math.max(0, call.index - 12), call.index))) {
      const at = enclosingIf(r.ids, call.index)
      const rulesAt = awardIds.search(/\bLIFECYCLE_AWARD_RULES\s*(?::[^=\n]+)?=\s*\[/)
      if (at >= 0 && rulesAt >= 0) {
        const open = awardIds.indexOf("[", awardIds.indexOf("=", rulesAt)); const rules = awardIds.slice(open, matchBracket(awardIds, open))
        for (const k of rules.matchAll(/\bevent\s*:\s*KernelEvent\.([A-Z0-9_]+)\b/g)) out.push({ key: k[1], file: r.file, idx: at, shape: "award" })
      }
    }
  }
  return out
}
/** The same-module export that is imported and whose same-file call graph reaches `fn` (an export's sibling caller). */
function siblingCaller(fns: FnSpan[], v: Views, fn: FnSpan, imported: (name: string) => boolean): FnSpan | undefined {
  return fns.find((x) => x.exported && x.name !== fn.name && imported(x.name) && closureSpans(fns, v, x).some((s) => s.name === fn.name))
}
/** A reactor block that ONLY routes: it runs inside the reactor, publishes ≥ 1 signal, writes nothing but carriers and sends
 *  nothing — and every signal it publishes resolves to a decision on its own row. Otherwise null (the gap stays). */
function routingLink(i: { signals: string[]; writes: string[]; egress: number; outsideReactor: boolean; decisionOf: (t: string) => string | null }): Array<[string, string]> | null {
  if (i.outsideReactor || !i.signals.length || i.egress || !i.writes.every((t) => CARRIER_TABLES.has(t))) return null
  const out = i.signals.map((s) => [s, i.decisionOf(s)] as const)
  return out.every(([, d]) => !!d) ? (out as Array<[string, string]>) : null
}
/** PURE (lane 155R16; lane 155R17 request 3) — a routing helper: exactly ONE imported function is called, it writes only the signal
 *  bus (manager_signals) and sends nothing; its literal `signalType:` values and `toManager:` literal are returned. Otherwise null. */
function helperRouteRule(i: { called: string[]; writes: string[]; egress: number; code: string }): { signals: string[]; toManager: string | null } | null {
  if (i.called.length !== 1 || i.egress || !i.writes.length || !i.writes.every((t) => t === "manager_signals")) return null
  const signals = [...new Set([...i.code.matchAll(/\bsignalType\s*:\s*["']([a-z_]+)["']/g)].map((m) => m[1]))]
  return signals.length ? { signals, toManager: /\btoManager\s*:\s*["']([a-z_]+)["']/.exec(i.code)?.[1] ?? null } : null
}
/** End of a `case "x":` span in comment-blanked source: labels with no code of their own fall through to the shared body. */
function caseSpanEnd(code: string, afterLabel: number): number {
  const LABEL = /\n\s*(?:case\s+["'][a-z_]+["']\s*:|default\s*:)/g
  let pos = afterLabel
  for (;;) {
    LABEL.lastIndex = pos; const nx = LABEL.exec(code)
    if (!nx) return code.length
    if (code.slice(pos, nx.index).trim()) return nx.index
    pos = nx.index + nx[0].length
  }
}
// WAVE 155 (lane 155R7) — A PER-CALL OWNER IS AN OWNER. A reactor block that picks its `toManager` at run time
// (`const toManager: ManagerKey | null = params.entityType === "buyer" ? "shopping_agent" : … : null`, or
// `routeForEvent("video_generation_requested", …).to`) addresses a registered manager on EVERY call that publishes —
// the census read only a LITERAL `toManager: "x"`, so these blocks read "addresses no manager". The owner is credited only
// when EVERY value the binding can take is provable from code (a literal / null result of a ternary or an assignment, or
// the literal `to:` results of the signal-routing function routeForEvent dispatches that event to) AND every candidate is
// in MANAGERS (checked by the caller). A binding assigned from anything else (a variable, a call, a body field) resolves
// nothing. Controls: section F (positive, negative, a fake candidate).
/** PURE. The statement that starts at `from`: lines are joined while the text so far ends in `=`, `?`, `:` or `||`. */
function statementFrom(text: string, from: number): string {
  const lines = text.slice(from).split("\n"); let out = ""
  for (const ln of lines) { out += ` ${ln}`; if (out.trim() && !/(?:=|\?|:|\|\|)\s*$/.test(out.trimEnd())) break }
  return out.trim()
}
/** PURE. The literal manager keys a per-call `toManager` binding can take inside `block`, or null when one is unprovable. */
function perCallToManager(block: string, routeCandidates: (event: string) => string[] | null): { binding: string; candidates: string[] } | null {
  if (/\btoManager\s*:\s*["']/.test(block)) return null // a literal is the addressed rule's, not this one
  const prop = /\btoManager\s*:\s*([A-Za-z_$][\w$]*)(\s*\??\.\s*to)?\s*[,\n}]/.exec(block)
  const ident = /\btoManager\s*[,\n}]/.test(block) ? "toManager" : prop?.[1]
  if (!ident) return null
  const id = ident.replace(/\$/g, "\\$")
  if (prop?.[2]) {
    const decl = new RegExp(`\\b(?:const|let)\\s+${id}\\s*=\\s*routeForEvent\\(\\s*["']([a-z_]+)["']`).exec(block)
    const c = decl ? routeCandidates(decl[1]) : null
    return decl && c && c.length ? { binding: `routeForEvent("${decl[1]}").to`, candidates: [...new Set(c)].sort() } : null
  }
  const decl = new RegExp(`\\b(?:const|let)\\s+${id}\\b[^=\\n]*=(?!=)`).exec(block); if (!decl) return null
  const LIT = /^\s*(?:\?\s*["'][a-z_]+["']\s*:\s*)*(?:["'][a-z_]+["']|null)\s*$/
  const strip = (s: string) => s.replace(/[\w$.?]+\s*===\s*["'][^"']*["']/g, "")
  const rhs = strip(statementFrom(block, decl.index + decl[0].length))
  if (!LIT.test(rhs)) return null
  const out = [...rhs.matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1])
  for (const a of block.matchAll(new RegExp(`(?<![\\w$.])${id}\\s*=(?!=)`, "g"))) {
    if (/(?:const|let)\s+$/.test(block.slice(Math.max(0, a.index - 8), a.index))) continue
    const r = strip(statementFrom(block, a.index + a[0].length))
    if (!LIT.test(r)) return null
    out.push(...[...r.matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]))
  }
  return out.length ? { binding: ident, candidates: [...new Set(out)].sort() } : null
}
// WAVE 155 (lane 155R7) — the shared team-command dispatcher: a tool handed to it runs ONE case of routeTeamCommand.
const TEAM_FILE = "lib/voice/team-commands.ts"
/** The `case "<name>"` span of routeTeamCommand (fall-through labels joined, bounded by the function). */
function teamCaseSpan(name: string): { start: number; end: number } | null {
  const rt = fnsOf(TEAM_FILE).find((f) => f.name === "routeTeamCommand"); if (!rt) return null
  const code = codeOf(TEAM_FILE)
  const m = new RegExp(`case\\s+["']${reEsc(name)}["']\\s*:`).exec(code.slice(rt.start, rt.end)); if (!m) return null
  const start = rt.start + m.index
  return { start, end: Math.min(rt.end, caseSpanEnd(code, start + m[0].length)) }
}
/** A dispatched tool's OWN effects: its case in routeTeamCommand plus the same-file helpers that case calls. */
function teamCaseFacts(name: string): Facts | null {
  const v = views(TEAM_FILE); const span = teamCaseSpan(name); if (!v || !span) return null
  const fns = fnsOf(TEAM_FILE); const shared = new Set(["routeTeamCommand", "dispatchTeamCommand"])
  const f = pathFacts(TEAM_FILE, span.start, span.end, v); const seen = new Set<string>()
  for (const c of v.ids.slice(span.start, span.end).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const fn = fns.find((x) => x.name === c[1] && !shared.has(x.name)); if (!fn || seen.has(fn.name)) continue
    seen.add(fn.name)
    for (const s of closureSpans(fns, v, fn)) if (!shared.has(s.name)) merge(f, pathFacts(TEAM_FILE, s.start, s.end, v))
  }
  return f
}
/** PURE — the per-call owner rule for an assistant tool (inputs derived by toolPerCallCredited; controls: section F). */
function toolPerCallRule(i: { failsClosed: boolean; pathCallsResolver: boolean; viaDispatcher: boolean; dispatcherCallsResolver: boolean; kind: string; caseSuppliesOwner: boolean }): boolean {
  if (!i.failsClosed) return false
  if (i.pathCallsResolver) return true
  return i.viaDispatcher && i.dispatcherCallsResolver && (i.kind === "team_command" || i.caseSuppliesOwner)
}
function toolPerCallCredited(name: string, kind: string, pathText: string, resolve: (tool: string, r: { manager?: string | null; formMode?: string | null }) => string | null): boolean {
  const code = codeOf(TEAM_FILE); const d = fnsOf(TEAM_FILE).find((f) => f.name === "dispatchTeamCommand"); const span = teamCaseSpan(name)
  const RESOLVER = /\bvoiceToolOwnerForCall\s*\(/
  return toolPerCallRule({
    failsClosed: resolve(name, { manager: "__not_a_manager__", formMode: "__not_a_form_mode__" }) === null,
    pathCallsResolver: RESOLVER.test(pathText),
    viaDispatcher: /\bdispatchTeamCommand\s*\(/.test(pathText),
    dispatcherCallsResolver: !!d && RESOLVER.test(code.slice(d.start, d.end)),
    kind,
    caseSuppliesOwner: !!span && /\bownerManager\s*:/.test(code.slice(span.start, span.end)),
  })
}
function topLevelFns(v: Views): FnSpan[] {
  const out: FnSpan[] = []
  const re = /(^|\n)(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=>)/g
  for (const m of v.ids.matchAll(re)) {
    const name = m[3] ?? m[4]
    const s = m.index! + m[1].length
    let i = s + m[0].length - m[1].length
    if (m[3]) {
      // past the parameter list, then the first `{` that is a BODY (a return-type object is followed by > | & , [ { =)
      let depth = 0, j = v.ids.indexOf("(", s)
      for (; j < v.ids.length; j++) { const c = v.ids[j]; if (c === "(") depth++; else if (c === ")") { depth--; if (depth === 0) break } }
      i = j + 1
      for (;;) {
        const o = v.ids.indexOf("{", i); if (o < 0) { i = -1; break }
        const close = matchBrace(v.ids, o)
        const after = v.ids.slice(close + 1).match(/^\s*(\S)/)?.[1] ?? ""
        if (/[>|&,\[{=]/.test(after)) { i = close + 1; continue }
        out.push({ name, start: s, end: close + 1, exported: !!m[2], line: lineAt(v, s) }); break
      }
    } else {
      const o = v.ids.slice(i).match(/^\s*\{/) ? v.ids.indexOf("{", i) : -1
      const end = o >= 0 ? matchBrace(v.ids, o) + 1 : (v.ids.indexOf("\n", i) < 0 ? v.ids.length : v.ids.indexOf("\n", i))
      out.push({ name, start: s, end, exported: !!m[2], line: lineAt(v, s) })
    }
  }
  return out
}
/** PURE (over string-blanked source) — what a top-level NAME binds when it is NOT a function topLevelFns found:
 *  "type" (interface / type alias), "data" (an enum, or a const whose initializer contains no function, arrow, class, method,
 *  `new` of anything but Set / Map / RegExp / Date / URL, and no call but a pure builtin), or "unknown" (anything else — the
 *  caller keeps its whole-file fallback). Lane 155R16; controls: section G. */
const DATA_CALLEES = /^(?:Object\.(?:freeze|fromEntries|entries|keys|values|assign)|Symbol|Array\.from|String|Number|Boolean|new\s+(?:Set|Map|RegExp|Date|URL))$/
/** PURE — the top-level `const|let|var NAME[: <annotation, any number of lines>] =` of a file: the declaration's offset and the
 *  offset just past its `=` (null when there is none). The annotation is walked at bracket depth (< > { } [ ] ( )); an `=>` inside it
 *  (a function type) is skipped; an `=` at depth 0 starts the initializer. */
function declInitAt(ids: string, n: string): { index: number; end: number } | null {
  const h = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${n}\\b\\s*`).exec(ids)
  if (!h) return null
  let i = h.index + h[0].length
  if (ids[i] === "=") return ids[i + 1] === "=" || ids[i + 1] === ">" ? null : { index: h.index, end: i + 1 }
  if (ids[i] !== ":") return null
  let depth = 0
  for (i++; i < ids.length && i - h.index < 20000; i++) {
    const c = ids[i]
    if (c === "<" || c === "{" || c === "[" || c === "(") depth++
    else if (c === ">" && ids[i - 1] !== "=") depth--
    else if (c === "}" || c === "]" || c === ")") depth--
    else if (c === "=" && depth === 0) { if (ids[i + 1] === ">" || ids[i + 1] === "=") { i++; continue } return { index: h.index, end: i + 1 } }
    else if (c === ";" && depth === 0) return null
    if (depth < 0) return null
  }
  return null
}
function bindingKind(ids: string, name: string): "type" | "data" | "unknown" {
  const n = reEsc(name)
  if (new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface\\s+${n}\\b|type\\s+${n}\\b[^=\\n]*=)`).test(ids)) return "type"
  if (new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+${n}\\b`).test(ids)) return "data"
  // WAVE 155 (lane 155R22 part 2): the type annotation may span LINES (`export const PROVIDER_METADATA: Record<ProviderName, {\n …\n }> = {`
  // — lib/onboarding/integration-tester.ts). The one-line pattern missed it, the binding read "unknown", and the whole-file
  // fallback credited the tester's callConnector to every importer of the constant (getIntegrationStatus / getMaskedCredentials
  // read as P0 acts). The annotation is now scanned at bracket depth (<>{}[]()) to the `=` that starts the initializer. Control: G11.
  const d = declInitAt(ids, n)
  if (!d) return "unknown"
  // the initializer: to the first `;` or line end at bracket depth 0 that does not continue the expression
  let depth = 0, i = d.end, init = ""
  for (; i < ids.length && i - d.index < 20000; i++) {
    const c = ids[i]
    if (c === "(" || c === "[" || c === "{") depth++
    else if (c === ")" || c === "]" || c === "}") depth--
    if (depth === 0 && (c === ";" || (c === "\n" && init.trim() && !/(?:[=?:|&,+\-*/(\[{]|\bas|\bsatisfies)\s*$/.test(init) && !/^\s*(?:[.?:|&+\-*/]|as\b|satisfies\b)/.test(ids.slice(i + 1, i + 40))))) break
    init += c
  }
  if (!init.trim() || /=>|\bfunction\b|\bclass\b|\basync\b|\byield\b|\bawait\b/.test(init)) return "unknown"
  for (const m of init.matchAll(/((?:new\s+)?[A-Za-z_$][\w$.]*)\s*(?:<[^>()]*>)?\s*\(/g)) if (!DATA_CALLEES.test(m[1].trim())) return "unknown"
  return "data"
}
/** The export's span plus every same-file top-level function it calls, to a fixpoint. */
function closureSpans(fns: FnSpan[], v: Views, root: FnSpan): FnSpan[] {
  const byName = new Map(fns.map((f) => [f.name, f]))
  // WAVE 155 (lane 155R16): …and a same-file top-level OBJECT literal a walked function names (`{ ...defaultDeps, ...deps }`): its
  // members are the injected default doors the function calls as `d.ledger(…)` (lib/kernel/skill-marketplace.ts defaultDeps holds
  // the withActionLedger receipt). Without it, the receipt was invisible and the only credit was a false one through a constant.
  // ONLY the members a walked body CALLS (`.ledger(` / `ledger(` after a destructure) — not the whole object (a list action that
  // names the same deps object to read must not inherit its ledger member's insert).
  const objs = objectSpansOf(v)
  const seen = new Set([root.name]); const queue = [root]; const out: FnSpan[] = [root]
  const named = new Set<FnSpan>(); const walked: string[] = []
  while (queue.length) {
    const cur = queue.pop()!
    const body = v.ids.slice(cur.start, cur.end); walked.push(body)
    // WAVE 155 (integrator): A CALL WRITTEN WITH EXPLICIT TYPE ARGUMENTS IS STILL A CALL. `ledgered<{ success: boolean }>(seat, …)`
    // was not followed to the same-file helper that holds the receipt, so app/actions/copilot.ts handleCoachingSessionBooked read
    // "missing evidence" with its receipt in place — the census accusing live code. The optional `<…>` admits one level of type
    // arguments with no nested angle bracket or parenthesis (a function type or a nested generic there is still not followed —
    // a blind spot, stated). Controls: section B (a followed generic call; a comparison `a < b && b > (a)` is not a call).
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g)) {
      const callee = byName.get(m[1])
      if (callee && !seen.has(callee.name)) { seen.add(callee.name); out.push(callee); queue.push(callee) }
    }
    for (const o of objs) if (!named.has(o) && new RegExp(`\\b${reEsc(o.name)}\\b`).test(body) && !(o.start >= cur.start && o.end <= cur.end)) named.add(o)
    for (const o of named) for (const mb of objectMembersOf(v, o)) {
      const key = `${o.name}.${mb.name}`
      if (seen.has(key) || !walked.some((w) => new RegExp(`(?:\\.\\s*|\\b)${reEsc(mb.name)}\\s*\\(`).test(w))) continue
      seen.add(key); const span = { ...mb, name: key }; out.push(span); queue.push(span)
    }
  }
  return out
}
const memberCache = new WeakMap<FnSpan, FnSpan[]>()
/** The depth-1 members of an object literal span: `name: <value>` or `name(…) {…}` / `async name(…) {…}`, each to its end. */
function objectMembersOf(v: Views, o: FnSpan): FnSpan[] {
  let ms = memberCache.get(o); if (ms) return ms
  ms = []
  const open = v.ids.indexOf("{", o.start); let depth = 0, i = open, cur: { name: string; start: number } | null = null
  const close = (end: number) => { if (cur) ms!.push({ name: cur.name, start: cur.start, end, exported: false, line: lineAt(v, cur.start) }); cur = null }
  for (; i < o.end; i++) {
    const c = v.ids[i]
    if (c === "{" || c === "(" || c === "[") { depth++; if (depth !== 1 || i !== open) continue }
    else if (c === "}" || c === ")" || c === "]") { if (depth === 1) close(i); depth--; continue }
    if (depth === 1 && (i === open || c === ",")) {
      close(i)
      const m = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(|<)/.exec(v.ids.slice(i + 1, i + 200)); if (m) cur = { name: m[1], start: i + 1 }
    }
  }
  memberCache.set(o, ms)
  return ms
}
const objCache = new WeakMap<Views, FnSpan[]>()
/** Top-level `const NAME[: T] = {` object literals of a file (not functions — topLevelFns has those). */
function objectSpansOf(v: Views): FnSpan[] {
  let o = objCache.get(v); if (o) return o
  o = []
  for (const m of v.ids.matchAll(/(^|\n)(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\{/g)) {
    const s = m.index! + m[1].length; const open = m.index! + m[0].length - 1
    o.push({ name: m[3], start: s, end: matchBrace(v.ids, open) + 1, exported: !!m[2], line: lineAt(v, s) })
  }
  objCache.set(v, o)
  return o
}
function exportFacts(file: string, v: Views, fns: FnSpan[], root: FnSpan): Facts {
  const f = emptyFacts()
  for (const s of closureSpans(fns, v, root)) merge(f, pathFacts(file, s.start, s.end, v))
  return f
}

const ROUTE_METHOD_NAMES = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
/** PURE over a file's views + edges — the file binds `name` to something other than `owner`'s export: its own top-level
 *  declaration of the name (function / const / let / class / interface / type / enum), or an import / re-export of the name
 *  from a module other than `owner`. */
function bindsElsewhere(file: string, v: Views, name: string, owner: string, edges: Edge[] = edgesOf(file)): boolean {
  const n = reEsc(name)
  if (new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+|class\\s+|interface\\s+|type\\s+|enum\\s+)${n}\\b`).test(v.ids)) return true
  // a module that itself imports / re-exports from `owner` (a barrel) may be passing the owner's export through — not elsewhere
  return edges.some((e) => e.target !== owner && e.pairs.some((p) => p.name === name && (p.local === name || p.local === "")) && !edgesOf(e.target).some((x) => x.target === owner))
}
// ══ 8. THE CENSUS ═══════════════════════════════════════════════════════════════════════════════════════════════════════
interface Census { rows: Row[]; denominators: Record<string, number>; blind: string[]; cronDrift: string[]; readOnlyExports: number; emitDoors?: string[] }

function routeMethods(v: Views): string[] {
  return [...v.ids.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1])
}
const isWebhookPath = (p: string) => /\/webhooks?\/|webhook|twiml|callback|\/inbound|status-callback|\/events\/?$/.test(p)
function routePattern(file: string): RegExp {
  const p = "/" + file.replace(/^app\//, "").replace(/\/route\.tsx?$/, "").split("/").filter((s) => !/^\(.*\)$/.test(s)).join("/")
  const src = p.split("/").map((s) => /^\[\[?\.\.\./.test(s) ? "(?:/.*)?" : /^\[.*\]$/.test(s) ? "/[^/]+" : s ? `/${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "").join("")
  return new RegExp(`^${src.replace(/^\/\(\?:\/\.\*\)\?/, "")}/?$`)
}
function apiCallers(file: string): string[] {
  const re = routePattern(file)
  const out = new Set<string>()
  for (const l of API_LITERALS) { if (l.file === file) continue; const t = l.text.replace(/\$\{[^}]*\}/g, "x"); if (re.test(t)) out.add(l.file) }
  return [...out]
}

async function census(extraCron: Array<{ path: string; schedule: string }> = [], fixtureFiles: Array<{ file: string; raw: string }> = [], plantedOnly = false): Promise<Census> {
  const reg = await import("../lib/kernel/manager-registry")
  TABLE_MANAGER = reg.TABLE_MANAGER as Record<string, string>
  MANAGER_KEYS = new Set(Object.keys(reg.MANAGERS))
  const CRON_MANAGER = reg.CRON_MANAGER as Record<string, string>
  const { CRON_REGISTRY } = await import("../lib/kernel/cron-dispatch")
  const { SIGNAL_REGISTRY } = await import("../lib/kernel/signal-registry")
  const { KernelEvent } = await import("../lib/kernel/events")
  const capReg = await import("../lib/agentic-os/app-capability-registry")
  const { CAPABILITY_MANAGER } = await import("../lib/agentic-os/capability-ownership")
  const toolReg = await import("../lib/voice/tool-registry")
  const { TEAM_COMMAND_MANAGER } = await import("../lib/kernel/ai-teammates")
  const { riskClassForTool } = await import("../lib/ai-isa/persona-tool-policy")
  let SIGNAL_HANDLER_KEYS: Set<string>
  let signalHandlersFrom = "runtime import of lib/kernel/manager-signals.ts SIGNAL_HANDLERS"
  try { SIGNAL_HANDLER_KEYS = new Set(Object.keys((await import("../lib/kernel/manager-signals")).SIGNAL_HANDLERS)) } catch (e) {
    signalHandlersFrom = `STATIC parse (runtime import failed: ${(e as Error).message.slice(0, 80)})`
    SIGNAL_HANDLER_KEYS = new Set([...(codeOf("lib/kernel/manager-signals.ts")).matchAll(/^\s*["']([a-z_]+:[a-z_]+)["']\s*:/gm)].map((m) => m[1]))
  }
  const drafts: Draft[] = []
  const blind: string[] = []
  let emitDoorsOut: string[] = []
  const rowsOut: Row[] = []
  // WAVE 155 (lane 155B1) — classification inputs. Provider callback routes are READ (statically) from the receive-truth matrix;
  // the SQL migrations are read once so an event value a DB trigger writes is never called an orphan (CLAUDE.md §3).
  PROVIDER_ROUTES = new Set([...codeOf("lib/providers/channel-provider-matrix.ts").matchAll(/\broute\s*:\s*["'](\/api\/[^"']+)["']/g)].map((m) => m[1]))
  const sqlText = SQL_TEXT ??= (() => { try { const dir = join(ROOT, "supabase/migrations"); return readdirSync(dir).filter((x) => x.endsWith(".sql")).map((x) => readFileSync(join(dir, x), "utf8")).join("\n") } catch { return "" } })()
  const inSql = (lit: string) => sqlText.includes(`'${lit}'`)
  const signalReaderFiles = readersOf("manager_signals", undefined).filter((x) => x !== "lib/kernel/manager-signals.ts")
  /** A signal's decision as its own row derives it (handled → its consumer, when every consumer has a SIGNAL_HANDLERS entry;
   *  feed → the human on the Command Center, when a reader exists) — null when that row could not name one either. */
  const signalDecision = (type: string): string | null => {
    const spec = (SIGNAL_REGISTRY as Record<string, { consumers: string[]; disposition: string }>)[type]
    if (!spec) return null
    if (spec.disposition === "handled") return spec.consumers.length && spec.consumers.every((c) => SIGNAL_HANDLER_KEYS.has(`${c}:${type}`)) ? `${spec.consumers[0]} (consumer of signal "${type}")` : null
    return signalReaderFiles.length ? `human on the Command Center feed (signal "${type}")` : null
  }

  // ── cron ──
  const vercel = JSON.parse(rawOf("vercel.json")) as { crons?: Array<{ path: string; schedule: string }> }
  const dispatcherScheduled = (vercel.crons ?? []).some((c) => c.path === "/api/cron/dispatch")
  const dispatchRoute = "app/api/cron/dispatch/route.ts"
  const dispatcherCalls = /\bdispatchDueCrons\s*\(/.test(views(dispatchRoute)?.ids ?? "")
  const cronDrift = (vercel.crons ?? []).filter((c) => c.path !== "/api/cron/dispatch" && !CRON_REGISTRY.some((r) => r.path === c.path)).map((c) => `${c.path} is in vercel.json but not in CRON_REGISTRY`)
  const registryCron = plantedOnly ? extraCron : [...CRON_REGISTRY, ...extraCron]
  const scheduledFiles = new Set<string>()
  for (const c of registryCron) {
    const base = c.path.split("?")[0]
    const file = `app${base}/route.ts`
    scheduledFiles.add(file)
    const v = views(file)
    const methods = v ? routeMethods(v) : []
    const owner = CRON_MANAGER[base] ?? null
    drafts.push({
      id: `cron:${c.path}`, kind: "cron", entry: v ? `${file}:${lineAt(v, v.ids.search(/export\s+(?:async\s+)?(?:function|const)\s+(?:GET|POST)\b/) >>> 0)}` : `${file} (absent)`,
      action: base.replace("/api/cron/", "cron."), source_event: `schedule "${c.schedule}"${c.path.includes("?") ? ` (${c.path.split("?")[1]})` : ""}`,
      trigger: dispatcherScheduled && dispatcherCalls ? `CRON_REGISTRY "${c.schedule}" via vercel.json /api/cron/dispatch → dispatchDueCrons` : null,
      worker: methods.length ? `${file} ${methods.join("/")}` : null,
      owner, ownerWhy: owner ? undefined : "CRON_MANAGER has no entry (resolveCronManager falls back to the operations seat, which HOLDS, not owns)",
      facts: v ? pathFacts(file) : emptyFacts(), deadline: `cron "${c.schedule}"`,
      decisionHint: undefined,
    })
  }
  if (plantedOnly) return { rows: drafts.map(finish), denominators: {}, blind, cronDrift, readOnlyExports: 0 }
  // cron route files the registry does not schedule — a worker with no trigger (unless something self-calls it)
  for (const file of FILES.filter((f) => /^app\/api\/cron\/.+\/route\.ts$/.test(f) && !scheduledFiles.has(f) && f !== dispatchRoute)) {
    const v = views(file)!; const callers = apiCallers(file)
    const base = "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "")
    drafts.push({
      id: `cron:${base}`, kind: "cron", entry: `${file}:1`, action: base.replace("/api/cron/", "cron."), source_event: "not scheduled",
      trigger: callers.length ? `self-call from ${callers[0]}` : null, worker: routeMethods(v).length ? `${file} ${routeMethods(v).join("/")}` : null,
      owner: CRON_MANAGER[base] ?? null, ownerWhy: "CRON_MANAGER has no entry", facts: pathFacts(file), deadline: "none (not in CRON_REGISTRY)",
    })
  }

  // ── kernel events ──
  const ev = KernelEvent as unknown as Record<string, string>
  const reactorFiles = ["lib/kernel/event-reactor.ts", "lib/kernel/event-fanout.ts"]
  const reactorCode = new Map(reactorFiles.map((f) => [f, codeOf(f)] as const))
  // the emit doors are DERIVED: every exported function named (emit|dispatch|process)KernelEvent in lib/kernel
  const emitDoors = [...new Set(FILES.filter((f) => f.startsWith("lib/kernel/")).flatMap((f) => [...(views(f)?.ids ?? "").matchAll(/export\s+async\s+function\s+((?:emit|dispatch|process)KernelEvent)\s*\(/g)].map((m) => m[1])))]
  // …plus the WRAPPER doors: an exported (emit|publish|fire|record|log)…Event function in lib/kernel or lib/events whose own body
  // calls a door, to a fixpoint. WAVE 155 (lane 155R16): lib/events/lifecycle-event-core.ts recordLifecycleEvent hands every
  // KernelEvent-valued type to emitKernelEvent (the kernel fan-out), and logEventAndTrigger wraps it — both were invisible, so an
  // event emitted only through them (credit_status_updated, lib/events/event-helpers.ts) read as "no emitter". Control: section G.
  const sharedAudit = new Set<string>() // a derived wrapper door whose every door call in its own body is audit-only
  for (let grew = true; grew;) {
    grew = false
    const doorRe = new RegExp(`\\b(?:${emitDoors.join("|") || "emitKernelEvent"})\\b`)
    for (const f of FILES.filter((x) => (x.startsWith("lib/kernel/") || x.startsWith("lib/events/")) && !REACTOR_FILES.includes(x) && doorRe.test(views(x)?.ids ?? ""))) {
      const v = views(f)!
      for (const fn of fnsOf(f)) {
        if (!fn.exported || !/^(?:emit|publish|fire|record|log)\w*Event\w*$/.test(fn.name) || emitDoors.includes(fn.name) || !doorRe.test(v.ids.slice(fn.start, fn.end))) continue
        emitDoors.push(fn.name); grew = true
        const calls = doorCallSpans(v.ids.slice(fn.start, fn.end), codeOf(f).slice(fn.start, fn.end), emitDoors.filter((x) => x !== fn.name), sharedAudit)
        if (!/KernelEvent$/.test(fn.name) && calls.length && calls.every(([, , a]) => a === true)) sharedAudit.add(fn.name)
      }
    }
  }
  // …and the reactor / fanout's own exported entry points (calling one with an event IS emitting into it, e.g. writePortalUpdate)
  for (const rf of reactorFiles) for (const fn of fnsOf(rf)) if (fn.exported && !emitDoors.includes(fn.name)) emitDoors.push(fn.name)
  const emitDoorRe = new RegExp(`\\b(?:${emitDoors.join("|") || "emitKernelEvent"})\\b`)
  emitDoorsOut = [...emitDoors]
  // WAVE 155 (lane 155R16; lane 155R6 request 2): a DIRECT `.from("lifecycle_events").insert(` (or a same-file wrapper whose body
  // does one — lib/kernel/scraping.ts scrapeEvent) is an emission AS A RECORD: the row is written, the reactor never sees it.
  // Such files are emitters too (the 11 scraping events read as "no emitter" — UNKNOWN). The door files themselves are excluded.
  const DOOR_FILES = new Set(["lib/kernel/emit.ts", "lib/events/lifecycle-event-core.ts"])
  const emitterFiles = FILES.filter((f) => !DOOR_FILES.has(f) && (emitDoorRe.test(views(f)?.ids ?? "") || (views(f)?.ids.includes("KernelEvent.") && directAuditInserts(views(f)!, codeOf(f)).length > 0)))
  const emitCode = new Map(emitterFiles.map((f) => [f, codeOf(f)] as const))
  // A CONSUMER site is structural: `=== KernelEvent.X`, `case KernelEvent.X`, or a map key `[KernelEvent.X]:`. Any other
  // occurrence in a file that calls an emit function is an EMISSION site.
  const consumerSites = new Map<string, Array<{ file: string; idx: number }>>()
  const emitSites = new Map<string, Set<string>>()
  const kernelRefs = new Map<string, Set<string>>() // KEY → every file that names KernelEvent.KEY (orphan proof)
  for (const f of FILES) {
    if (f === "lib/kernel/events.ts") continue
    const v = views(f); if (!v || !v.ids.includes("KernelEvent.")) continue
    for (const m of v.ids.matchAll(/\bKernelEvent\.([A-Z0-9_]+)\b/g)) {
      if (!kernelRefs.has(m[1])) kernelRefs.set(m[1], new Set()); kernelRefs.get(m[1])!.add(f)
      const before = v.ids.slice(Math.max(0, m.index! - 8), m.index!), after = v.ids.slice(m.index! + m[0].length, m.index! + m[0].length + 4)
      const consumer = /===\s*$|case\s+$/.test(before) || (/\[\s*$/.test(before) && /^\s*\]\s*:/.test(after))
      if (consumer) { if (!consumerSites.has(m[1])) consumerSites.set(m[1], []); consumerSites.get(m[1])!.push({ file: f, idx: m.index! }) }
      else if (emitCode.has(f) && !reactorFiles.includes(f)) { if (!emitSites.has(m[1])) emitSites.set(m[1], new Set()); emitSites.get(m[1])!.add(f) }
    }
  }
  // WAVE 155 (lane 155R16; lane 155R6 request 1) — TWO MORE CONSUMER SHAPES (reference: scripts/event-claims-guard.ts classify()):
  // (a) a KernelEvent.X inside a reactor `const NAME = [ … ]` that the reactor tests with `NAME.includes(params.event` — the
  //     consumer is that `if` block; (b) an `event: KernelEvent.X` in lib/gamification/award-points.ts LIFECYCLE_AWARD_RULES while
  //     the reactor calls awardLifecycleMilestones — the consumer is the reactor's L6 block. ONLY for an event with no structural
  //     consumer of its own: an event a `case` already consumes is judged on that block (the award hook runs for every known
  //     event; merging it into every row would charge each with the award path's facts — a blind spot, stated). The award rule is
  //     NOT credited as the decision: whether a registered manager's deterministic rule decides is OWNER decision 2 (OWNER_HELD
  //     kernel_event:referral_converted holds exactly that question) — the walk finds a gate or the row says it has none.
  const shapeSites = reactorConsumerShapes(reactorFiles.map((f) => ({ file: f, ids: views(f)?.ids ?? "" })), views(AWARD_FILE)?.ids ?? "")
  const structural = new Set(consumerSites.keys())
  for (const s of shapeSites) {
    if (structural.has(s.key)) continue
    const list = consumerSites.get(s.key) ?? []
    if (!list.some((x) => x.file === s.file && x.idx === s.idx)) list.push({ file: s.file, idx: s.idx })
    consumerSites.set(s.key, list)
  }
  // WAVE 155 (lane 155R7): the literal `to:` results of the signal-routing function routeForEvent dispatches `event` to.
  const routeCandidates = (event: string): string[] | null => {
    const SR = "lib/kernel/signal-routing.ts"; if (!views(SR)) return null
    const code = codeOf(SR); const fns = fnsOf(SR)
    const rf = fns.find((f) => f.name === "routeForEvent"); if (!rf) return null
    const m = new RegExp(`event\\s*===\\s*["']${reEsc(event)}["']\\s*\\)\\s*return\\s+([A-Za-z_$][\\w$]*)\\s*\\(`).exec(code.slice(rf.start, rf.end)); if (!m) return null
    const fn = fns.find((f) => f.name === m[1]); if (!fn) return null
    return [...code.slice(fn.start, fn.end).matchAll(/\bto\s*:\s*["']([a-z_]+)["']/g)].map((x) => x[1])
  }
  const callsCache = new Map<string, Array<[number, number, boolean | null]>>() // fileDoorCalls (below)
  for (const [key, value] of Object.entries(ev)) {
    if (typeof value !== "string") continue
    const emitters = [...new Set([...(emitSites.get(key) ?? []), ...emitterFiles.filter((f) => !reactorFiles.includes(f) && carriesLiteral(value, emitCode.get(f)!, views(f)!.ids))])]
    const facts = emptyFacts(); let worker: string | null = null; let addressed: string | null = null
    let perCall: { binding: string; candidates: string[] } | null = null
    const signals = new Set<string>(); let outsideReactor = false
    for (const site of consumerSites.get(key) ?? []) {
      const v = views(site.file)!
      if (reactorFiles.includes(site.file)) {
        const open = v.ids.indexOf("{", site.idx); const close = open < 0 ? v.ids.length : matchBrace(v.ids, open)
        merge(facts, pathFacts(site.file, site.idx, close + 1, v))
        const block = (reactorCode.get(site.file) ?? "").slice(site.idx, close + 1)
        addressed ??= /\btoManager\s*:\s*["']([a-z_]+)["']/.exec(block)?.[1] ?? null
        perCall ??= perCallToManager(block, routeCandidates)
        for (const s of block.matchAll(/\bsignalType\s*:\s*["']([a-z_]+)["']/g)) signals.add(s[1])
        // WAVE 155 (lane 155R16; lane 155R17 request 3): a block whose ONLY imported call is one helper whose only write is the
        // signal bus routes through that helper — its literal signalType / toManager are the block's (control: G6)
        if (!/\bsignalType\s*:/.test(block)) {
          const imports = new Map<string, { target: string; name: string }>()
          for (const e of edgesOf(site.file)) for (const p of e.pairs) if (p.local && e.target !== site.file) imports.set(p.local, { target: e.target, name: p.name })
          const called = [...new Set([...v.ids.slice(site.idx, close + 1).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]).filter((n) => imports.has(n) && !["publishManagerSignal", "createServiceClient", "createClient"].includes(n)))] // a client constructor is not an action
          const h = called.length === 1 ? (() => {
            const t = imports.get(called[0])!; const fn = fnsOf(t.target).find((x) => x.name === t.name); if (!fn) return null
            const mf = memberFacts(t.target, t.name, 1)
            return helperRouteRule({ called, writes: [...mf.writes.keys()], egress: mf.egress.length, code: codeOf(t.target).slice(fn.start, fn.end) })
          })() : null
          if (h) { for (const s of h.signals) signals.add(s); addressed ??= h.toManager }
        }
      } else { merge(facts, pathFacts(site.file)); outsideReactor = true }
      worker ??= `${site.file}:${lineAt(v, site.idx)}`
    }
    const ow0 = ownerFromWrites(facts, addressed)
    const pc = !ow0.owner && perCall && perCall.candidates.every((k) => MANAGER_KEYS.has(k)) ? perCall : null
    const ow = pc ? { owner: `per-call: toManager ∈ {${pc.candidates.join(" | ")}} (${pc.binding} @ ${worker})`, why: "the reactor resolves its manager per call" } : ow0
    // WAVE 155 (lane 155B1) — A ROUTING HOP IS NOT A DECISION. A reactor block whose ONLY effect is publishManagerSignal (it
    // writes nothing but carriers, sends nothing) hands the event to a registered manager: the decision and the consequence
    // are that consumer's, and the census already judges them on the row `manager_signal:<type>` — where the very same
    // manager_signals row is accepted as evidence. Reading the event row as "no decision, no evidence" counted one gap
    // twice and accused the routing of the consumer's job. The link is credited ONLY when every published type resolves to
    // a signal whose own row names a decision (signalDecision); a block that also writes a domain table, sends, runs
    // outside the reactor, or publishes an unregistered / unhandled type keeps its gap. Controls: section F.
    const link = routingLink({ signals: [...signals], writes: [...facts.writes.keys()], egress: facts.egress.length, outsideReactor, decisionOf: signalDecision })
    const auditOnlyEmits = emitters.length && !worker ? auditOnlyEmission(key, value, emitters) : undefined
    drafts.push({
      id: `kernel_event:${value}`, kind: "kernel_event", entry: worker ?? "lib/kernel/events.ts", action: `kernel.${value}`, source_event: `KernelEvent.${key}`,
      trigger: emitters.length ? `emitted by ${emitters[0]}${emitters.length > 1 ? ` (+${emitters.length - 1})` : ""}` : null,
      worker, owner: ow.owner, ownerWhy: ow.why, facts, actorHint: "kernel event bus",
      decisionHint: link ? `routed to ${link.map(([, dcs]) => dcs).join("; ")} — the decision is judged on manager_signal:${link[0][0]}` : undefined,
      evidenceHint: link ? `manager_signals row (publishManagerSignal, signal "${link.map(([s]) => s).join(", ")}") @ ${worker}` : undefined,
      auditOnlyEmits,
      heldWhy: eventLedgerHold(value, { worker: !!worker, emitted: emitters.length > 0, auditOnlyEmits }, EVENT_OWNER_HELD),
      elsewhere: emitters.length ? [] : [...new Set([...(kernelRefs.get(key) ?? []), ...(LIT_FILES.get(value) ?? [])]
        .filter((f) => f !== "lib/kernel/events.ts" && !reactorFiles.includes(f) && !(consumerSites.get(key) ?? []).some((s) => s.file === f))
        .concat(inSql(value) ? ["supabase/migrations (SQL)"] : []))],
    })
  }
  // WAVE 155 (lane 155R16; lane 155R6 request 2) — THE CALL A SITE RIDES. Each file's door calls are the shared doors, its own
  // same-file wrappers (a function, a const arrow, or a default-deps property `name: async (…)` whose body calls a door or inserts
  // into lifecycle_events) and its direct lifecycle_events inserts; a call is audit-only when its own arguments say
  // `auditOnly: true`, it is a direct insert, or it calls an audit-only wrapper. A site with no riding call is not an emission.
  function fileDoorCalls(f: string): Array<[number, number, boolean | null]> {
    const hit = callsCache.get(f); if (hit) return hit
    const v = views(f)!; const code = emitCode.get(f) ?? codeOf(f)
    // WAVE 155 (lane 155R22): a local alias of a door (doorAliases) is a door in this file — before the wrappers are read, so a
    // wrapper whose body calls the alias (lib/kernel/brokerage-transfer.ts emitTransferEvent → `emit({ …, auditOnly: true })`)
    // is an audit wrapper; the forwarding call INSIDE an alias's initializer is its body, not an emission
    const al = doorAliases(v.ids, emitDoors)
    const doors = [...emitDoors, ...al.names]
    const w = localWrappers(v.ids, code, doors, sharedAudit)
    const calls = doorCallSpans(v.ids, code, [...doors, ...w.doors], new Set([...sharedAudit, ...w.audit]))
      .filter(([s]) => !al.spans.some(([a, b]) => s >= a && s < b))
    callsCache.set(f, calls)
    return calls
  }
  function auditOnlyEmission(key: string, value: string, files: string[]): boolean | null {
    let any = false
    for (const f of files) {
      const v = views(f)!; const code = emitCode.get(f) ?? codeOf(f)
      const calls = fileDoorCalls(f)
      const sites = [...v.ids.matchAll(new RegExp(`\\bKernelEvent\\.${key}\\b`, "g"))].map((m) => m.index!)
        .concat([...code.matchAll(new RegExp(`["'\`]${reEsc(value)}["'\`]`, "g"))].map((m) => m.index!).filter((i) => literalEventSite(code, i, calls)))
        .filter((i) => !/(?:===\s*|case\s+)$/.test(v.ids.slice(Math.max(0, i - 8), i)))
      let r = auditOnlyAt(v.ids, sites, calls)
      if (r === undefined) continue // this file carries the value without riding a door (not an emission here)
      // WAVE 155 (lane 155R22): an `auditOnly: <expression>` the event-claims ledger names for THIS event and file, re-verified
      // against the file's comment-stripped code (scripts/event-claims-ledger.ts CONDITIONAL_AUDIT) — commission_calculated's
      // `auditOnly: nextStatus !== "approved"` is the audit branch exactly. File-level (a blind spot, stated). Control: G10.
      if (r === null && conditionalAuditVerified(value, f, stripComments(rawOf(f)))) r = true
      if (r !== true) return r // a fan-out (false) or an unprovable auditOnly expression (null)
      any = true
    }
    return any ? true : null
  }

  // ── orchestrator events (lib/orchestrator/internal.ts EVENT_HANDLERS) ──
  {
    const file = "lib/orchestrator/internal.ts"; const v = views(file)!
    const types = views("lib/events/types.ts")!
    const constOf = new Map<string, string>()
    for (const m of codeOf("lib/events/types.ts").matchAll(/^\s*([A-Z_]+)\s*:\s*["']([a-z_]+\.[a-z_]+)["']/gm)) constOf.set(m[2], m[1])
    // the emit doors are DERIVED: every exported async function of lib/events/* and of the orchestrator itself
    const orchDoors = [...new Set([file, ...FILES.filter((f) => f.startsWith("lib/events/"))].flatMap((f) => [...(views(f)?.ids ?? "").matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1])))]
    const emitFns = new RegExp(`\\b(?:${orchDoors.join("|")})\\b`)
    const orchCode = new Map(FILES.filter((f) => f !== file && f !== "lib/events/types.ts" && emitFns.test(views(f)?.ids ?? "")).map((f) => [f, codeOf(f)] as const))
    const vcode = codeOf(file); const start = vcode.indexOf("const EVENT_HANDLERS"); const end = matchBrace(v.ids, v.ids.indexOf("{", v.ids.indexOf("=", start)))
    for (const m of vcode.slice(start, end).matchAll(/^\s*["']([a-z_]+\.[a-z_]+)["']\s*:\s*(.*)$/gm)) {
      const type = m[1]; const handler = m[2]; const at = start + m.index!
      const c = constOf.get(type)
      const emitters = [...orchCode.keys()].filter((f) => new RegExp(`["'\`]${type.replace(".", "\\.")}["'\`]`).test(orchCode.get(f)!) || (c ? new RegExp(`\\bEVENT_TYPES\\.${c}\\b`).test(views(f)!.ids) : false))
      const stub = /NotWired\b|notImplemented\b/.test(handler)
      const lineEnd = vcode.indexOf("\n", at + 1)
      drafts.push({
        id: `orchestrator_event:${type}`, kind: "orchestrator_event", entry: `${file}:${lineAt(v, at + 1)}`, action: `orchestrator.${type}`, source_event: c ? `EVENT_TYPES.${c}` : type,
        trigger: emitters.length ? `emitted by ${emitters[0]}${emitters.length > 1 ? ` (+${emitters.length - 1})` : ""}` : null,
        worker: stub ? null : `${file}:${lineAt(v, at + 1)} ${handler.trim().slice(0, 60)}`,
        owner: (reg as { ORCHESTRATOR_EVENT_MANAGER?: Record<string, string> }).ORCHESTRATOR_EVENT_MANAGER?.[type] ?? null, facts: pathFacts(file, at, lineEnd, v), actorHint: "orchestrator event bus",
        // a type no door call carries may still be built elsewhere: any other runtime file carrying the literal or EVENT_TYPES.<C>, or SQL
        elsewhere: emitters.length ? [] : [...new Set([...(LIT_FILES.get(type) ?? [])].filter((f) => f !== file && f !== "lib/events/types.ts")
          .concat(c ? FILES.filter((f) => f !== file && new RegExp(`\\bEVENT_TYPES\\.${c}\\b`).test(views(f)?.ids ?? "")) : [])
          .concat(inSql(type) ? ["supabase/migrations (SQL)"] : []))],
      })
    }
  }

  // ── manager signals ──
  // publish doors are DERIVED: publishManagerSignal, plus every exported WRAPPER whose own body references it and forwards a
  // caller-supplied signalType (publishQualificationSignal, a reel's delivery helper, …)
  const pubDoors = ["publishManagerSignal"]
  for (const f of FILES.filter((x) => /\bpublishManagerSignal\b/.test(views(x)?.ids ?? ""))) {
    const v = views(f)!
    for (const fn of fnsOf(f)) {
      if (!fn.exported || pubDoors.includes(fn.name)) continue
      const body = v.ids.slice(fn.start, fn.end)
      if (/\bpublishManagerSignal\b/.test(body) && /\b\w+\.signalType\b|\bsignalType\s*[,}]/.test(body)) pubDoors.push(fn.name)
    }
  }
  const pubDoorRe = new RegExp(`\\b(?:${pubDoors.join("|")})\\b`)
  const publisherFiles = FILES.filter((f) => pubDoorRe.test(views(f)?.ids ?? ""))
  const pubCode = new Map(publisherFiles.map((f) => [f, codeOf(f)] as const))
  for (const [type, spec] of Object.entries(SIGNAL_REGISTRY as Record<string, { consumers: string[]; disposition: string; what: string }>)) {
    const pubs = publisherFiles.filter((f) => carriesLiteral(type, pubCode.get(f)!, views(f)!.ids))
    const handled = spec.disposition === "handled"
    const missingHandlers = handled ? spec.consumers.filter((c) => !SIGNAL_HANDLER_KEYS.has(`${c}:${type}`)) : []
    const worker = handled ? (spec.consumers.length && !missingHandlers.length ? `SIGNAL_HANDLERS ${spec.consumers.map((c) => `${c}:${type}`).join(", ")}` : null) : `feed (Command Center): ${signalReaderFiles.find(isUiFile) ?? signalReaderFiles[0] ?? "no reader"}`
    const f = emptyFacts(); f.writes.set("manager_signals", "lib/kernel/manager-signals.ts (publishManagerSignal)")
    drafts.push({
      id: `manager_signal:${type}`, kind: "manager_signal", entry: `lib/kernel/signal-registry.ts:${lineAt(views("lib/kernel/signal-registry.ts")!, views("lib/kernel/signal-registry.ts")!.ids.search(new RegExp(`\\b${type}\\s*:`)) >>> 0)}`,
      action: `signal.${type}`, source_event: `${spec.disposition}${missingHandlers.length ? ` (no SIGNAL_HANDLERS entry for ${missingHandlers.join(", ")})` : ""}`,
      trigger: pubs.length ? `published by ${pubs[0]}${pubs.length > 1 ? ` (+${pubs.length - 1})` : ""}` : null,
      worker, owner: handled ? (spec.consumers[0] ?? null) : "feed (human on the Command Center)", ownerWhy: "a handled signal with no consumer",
      facts: f, consequentialHint: handled, actorHint: "publishing manager",
      decisionHint: handled ? (spec.consumers[0] ? `${spec.consumers[0]} (consumer)` : undefined) : "human on the feed",
      evidenceHint: "manager_signals row (publishManagerSignal)", readbackHint: signalReaderFiles.length ? `manager_signals read by ${signalReaderFiles[0]}` : undefined,
    })
  }

  // ── agentic capabilities (MCP + REST) ──
  {
    const mcp = "app/api/agentic-os/mcp/route.ts", inv = "app/api/agentic-os/actions/[capability]/invoke/route.ts"
    const execKeys = new Set<string>()
    for (const [file, name] of [[mcp, "READ_EXECUTORS"], [inv, "EXECUTORS"]] as const) {
      const v = views(file); if (!v) continue
      const s = v.ids.search(new RegExp(`const\\s+${name}\\b`)); if (s < 0) continue
      const o = v.ids.indexOf("{", v.ids.indexOf("=", s)); const e = matchBrace(v.ids, o)
      for (const m of v.ids.slice(o, e).matchAll(/^\s{2}([a-z_]+)\s*:/gm)) execKeys.add(m[1])
    }
    const routeFacts = merge(pathFacts(mcp), pathFacts(inv))
    const capMgr = CAPABILITY_MANAGER as Record<string, string>
    const capV = views("lib/agentic-os/app-capability-registry.ts")!
    // WAVE 154 (lane 154A3): THE POPULATION IS WHAT THE SURFACE OFFERS AS CALLABLE. The MCP route lists a tool only when it can
    // be served there (its callableHere rule): a read executor, or an APP capability whose survivor has a worker in the manager
    // delegation runtime (DELEGATION_WORKERS) when the route files the request through requestDelegation. Both halves are read
    // from code: the executor maps above, the DELEGATION_WORKERS keys out of lib/kernel/manager-delegation.ts, and the route's
    // own tokens (it must call requestDelegation AND gate tools/list on callableHere, or no capability is delegate-callable).
    // A manifest entry that is not callable is CATALOG-ONLY: counted in the denominators, not a row (it is not an executable
    // action surface any more — the route refuses it by name instead of planning it through a path that cannot run it).
    const delegationKeys = new Set<string>()
    {
      const mv = views(mcp)
      const binds = !!mv && /\brequestDelegation\s*\(/.test(mv.ids) && /\bcallableHere\s*\(/.test(mv.ids) && /\bDELEGATION_WORKERS\b/.test(mv.ids)
      const dv = views("lib/kernel/manager-delegation.ts")
      const ds = dv ? dv.ids.search(/const\s+DELEGATION_WORKERS\b/) : -1
      if (binds && dv && ds >= 0) {
        const o = dv.ids.indexOf("{", dv.ids.indexOf("(", ds)); const e = matchBrace(dv.ids, o)
        for (const m of dv.ids.slice(o, e).matchAll(/^\s{2}([a-z_]+)\s*:\s*async\b/gm)) delegationKeys.add(m[1])
      }
    }
    let catalogOnly = 0
    for (const a of capReg.buildFullActionManifest() as Array<{ capability: string; kind: string; verb: string; mutates?: boolean }>) {
      const isApp = a.capability in capReg.APP_CAPABILITY_REGISTRY
      const delegated = isApp && delegationKeys.has(a.capability)
      if (!execKeys.has(a.capability) && !delegated) { catalogOnly++; continue }
      const at = isApp ? capV.ids.search(new RegExp(`^\\s*${a.capability}\\s*:`, "m")) : -1
      const facts = emptyFacts(); merge(facts, routeFacts)
      const lensTables: string[] = []
      drafts.push({
        id: `capability:${a.kind}:${a.capability}`, kind: "capability",
        entry: isApp && at >= 0 ? `lib/agentic-os/app-capability-registry.ts:${lineAt(capV, at)}` : `${a.kind} manifest (buildFullActionManifest)`,
        action: `${a.verb} ${a.capability}`, source_event: `MCP tools/call · REST /api/agentic-os/actions/${a.capability}/invoke`,
        trigger: `${mcp} tools/call (buildFullActionManifest)`,
        worker: execKeys.has(a.capability) ? `executor ${a.capability} (${mcp} / ${inv})` : `DELEGATION_WORKERS.${a.capability} (lib/kernel/manager-delegation.ts) via requestDelegation in ${mcp}`,
        owner: isApp ? capMgr[a.capability] ?? null : null, ownerWhy: isApp ? "CAPABILITY_MANAGER has no entry" : `a ${a.kind} capability: CAPABILITY_MANAGER covers app capabilities only`,
        facts, consequentialHint: !!a.mutates, actorHint: "agent token (scope-gated)",
        subject: a.capability, lensTables,
      })
    }
    capabilityCatalogOnly = catalogOnly
    blind.push(`agentic capabilities: rows are the CALLABLE ones (an executor, or a DELEGATION_WORKERS survivor bound through requestDelegation); ${catalogOnly} manifest entr${catalogOnly === 1 ? "y is" : "ies are"} catalog-only (refused by name on tools/call) and counted, not rows`)
  }

  // ── assistant / voice tools ──
  {
    const route = "app/api/agent-assistant/tool-call/route.ts"; const v = views(route)!
    const rcode = codeOf(route); const routeHead = pathFacts(route, 0, v.ids.search(/\bfunction\s+runTool\b/) >>> 0, v)
    const vtm = toolReg.VOICE_TOOL_MANAGER as Readonly<Record<string, string>>
    const regV = views("lib/voice/tool-registry.ts")!
    const routeFns = fnsOf(route); const seenHelpers = new Set<string>()
    for (const [name, tool] of Object.entries(toolReg.voiceTools as Record<string, { category: string; authority: string; gates: string[] }>)) {
      const m = new RegExp(`case\\s+["']${name}["']\\s*:`).exec(rcode)
      let facts = emptyFacts()
      let caseText = "", pathText = "" // the case's own code, and the case + its same-file helpers (wave 155, lane 155R7)
      if (m) {
        // WAVE 155 (lane 155B1) — A FALL-THROUGH LABEL RUNS THE SHARED BODY. `case "broker_objective": case "run_skill": … {
        // dispatchTeamCommand(…) }` gave broker_objective an EMPTY span (it ended at the very next label), so the tool read as
        // writing and sending nothing. The span now skips every label that has no code of its own. Control: section F.
        const end = caseSpanEnd(rcode, m.index + m[0].length)
        facts = pathFacts(route, m.index, end, v)
        caseText = pathText = rcode.slice(m.index, end)
        // …and a helper the case calls that is defined in the route file itself (runTeamCommandTool, fillFormField) is part of
        // the path, exactly as a server action's same-file callees are (closureSpans).
        for (const c of v.ids.slice(m.index, end).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          const fn = routeFns.find((x) => x.name === c[1] && x.name !== "runTool"); if (!fn || seenHelpers.has(fn.name + name)) continue
          seenHelpers.add(fn.name + name)
          for (const s of closureSpans(routeFns, v, fn)) if (s.name !== "runTool") { merge(facts, pathFacts(route, s.start, s.end, v)); pathText += `\n${rcode.slice(s.start, s.end)}` }
        }
      }
      const lensTables = [...facts.writes.keys()]
      let ownFacts = merge(emptyFacts(), facts) // the case alone, before the shared route head joins it (wave 155, lane 155B1)
      // WAVE 155 (lane 155R7) — THE SHARED DISPATCHER RUNS ONLY THIS TOOL'S CASE. A fall-through label that hands `toolName`
      // to lib/voice/team-commands.ts dispatchTeamCommand runs that module's `case "<name>"` and nothing else, but the walk
      // folded the WHOLE switch into every such tool (each of ~25 tools "wrote" the same 27 tables). The tool's OWN effects
      // (ownFacts → path_effects, the read-only rule and the ratchet's read-only check) now come from its own case there;
      // `facts` (what state() judges) keeps the wide walk — narrowing it would move other rows' links (stated, a blind spot).
      const own = m && /\bdispatchTeamCommand\s*\(\s*toolName\b/.test(caseText) ? teamCaseFacts(name) : null
      if (own) ownFacts = merge(own, factsOfSpan(route, v, m!.index, caseSpanEnd(rcode, m!.index + m![0].length)))
      merge(facts, routeHead)
      const risk = riskClassForTool(name)
      // WAVE 155 (lane 155R7) — A TOOL DECIDED PER CALL IS OWNED PER CALL. lib/voice/tool-registry.ts VOICE_TOOL_PER_CALL_OWNER
      // names the fact each such handler resolves; voiceToolOwnerForCall turns it into the call's one manager (fail closed).
      // Credited ONLY when (a) the tool is listed, (b) the resolver fails closed on a key outside MANAGERS and on an unknown
      // form mode, and (c) the handler path really calls it — in the route case / its helpers, or through dispatchTeamCommand
      // (which calls it) with the tool's own case there supplying `ownerManager:` (run_team_command passes its sub-command's).
      const perCallKind = (toolReg.VOICE_TOOL_PER_CALL_OWNER as Readonly<Record<string, string>> | undefined)?.[name]
      const perCallOwner = perCallKind && toolPerCallCredited(name, perCallKind, pathText, (k, r) => toolReg.voiceToolOwnerForCall(k, r, reg.MANAGERS))
        ? `per-call: voiceToolOwnerForCall(${name} → ${perCallKind}) in lib/voice/tool-registry.ts` : null
      const regAt = regV.ids.search(new RegExp(`^\\s*${name}\\s*:\\s*\\{`, "m"))
      drafts.push({
        id: `assistant_tool:${name}`, kind: "assistant_tool", entry: m ? `${route}:${lineAt(v, m.index)}` : `lib/voice/tool-registry.ts:${lineAt(regV, regAt >>> 0)}`,
        action: `tool.${name} (${tool.category}, ${risk})`, source_event: "agent assistant / voice tool call",
        trigger: m ? `${route} POST (assistant session)` : null, worker: m ? `${route} runTool case "${name}"` : null,
        // ONE resolver, the production one (lib/voice-admin/assistant-reach.ts toolOwner): the tool table first, then the team-command table.
        owner: vtm[name] ?? (TEAM_COMMAND_MANAGER as Readonly<Record<string, string>>)[name] ?? perCallOwner ?? null, ownerWhy: perCallKind ? `listed per call (${perCallKind}) but its handler path does not call voiceToolOwnerForCall with that fact` : "neither VOICE_TOOL_MANAGER nor TEAM_COMMAND_MANAGER names it — bench-wide tools are deliberately unattributed (lib/voice/tool-registry.ts)",
        facts, consequentialHint: risk !== "READ" || ["send", "stage", "schedule"].includes(tool.category),
        lensTables, ownFacts: m ? ownFacts : undefined, toolRisk: risk, actorHint: "signed-in seat (assistant session)", decisionHint: `session seat under authorityAllows + declared gates [${tool.gates.join(", ") || "none"}] (${route})`,
      })
    }
  }

  // ── provider egress doors ──
  {
    const v = views(DISPATCH_FILE)!; const fns = topLevelFns(v)
    for (const door of DISPATCH_DOORS) {
      const fn = fns.find((x) => x.name === door && x.exported); if (!fn) continue
      const importers = [...(IMPORTED.get(DISPATCH_FILE)?.get(door) ?? [])]
      const facts = exportFacts(DISPATCH_FILE, v, fns, fn)
      drafts.push({
        id: `provider_egress:${door}`, kind: "provider_egress", entry: `${DISPATCH_FILE}:${fn.line}`, action: `egress.${door}`, source_event: "caller request",
        trigger: importers.length ? `called from ${importers.length} module(s), e.g. ${importers[0]}` : null, worker: `${DISPATCH_FILE} ${door}`,
        owner: "per-call: managerForDispatch(managerKey, systemSource) in lib/managers/autonomy-gate.ts", facts, consequentialHint: !/WebSearch/.test(door), actorHint: "calling manager / session (DispatchActorContext)",
      })
    }
  }

  // ── webhook + http routes ──
  for (const file of FILES.filter((f) => /^app\/api\/.+\/route\.tsx?$/.test(f) && !f.startsWith("app/api/cron/"))) {
    const v = views(file)!; const methods = routeMethods(v)
    const url = "/" + file.replace(/^app\//, "").replace(/\/route\.tsx?$/, "")
    const hook = isWebhookPath(url)
    const mutating = methods.filter((m) => m !== "GET")
    if (!hook && !mutating.length) continue
    const facts = pathFacts(file)
    const callers = hook ? [] : apiCallers(file)
    // WAVE 155 (lane 155R22): …then the worker hop (ownerOfDelegatedRead) where the own span read no stewarded table at all
    const ow = ((o) => { if (o.owner) return o; const own = factsOfSpan(file, v, 0, v.ids.length); return ownerOfAuditedRead(own, facts) ?? ownerOfDelegatedRead(own, facts, delegatedWorkers(file, v, fnsOf(file), 0, v.ids.length)) ?? o })(ownerFromWrites(facts))
    const at = v.ids.search(/export\s+(?:async\s+)?(?:function|const)\s+(?:POST|PUT|PATCH|DELETE|GET)\b/)
    drafts.push({
      id: `${hook ? "webhook" : "http"}:${url}`, kind: hook ? "webhook" : "http", entry: `${file}:${lineAt(v, at >>> 0)}`, action: `${methods.join("/")} ${url}`,
      source_event: hook ? "provider callback" : "HTTP request",
      trigger: hook ? (methods.length ? `external provider callback (${methods.join("/")})` : null) : callers.length ? `fetch from ${callers[0]}${callers.length > 1 ? ` (+${callers.length - 1})` : ""}` : null,
      worker: methods.length ? `${file} ${methods.join("/")}` : null, owner: ow.owner, ownerWhy: ow.why, facts,
      staffDoor: ow.owner ? undefined : platformStaffDoorAt(file, v, [{ start: 0, end: v.ids.length }]) ?? undefined,
    })
  }
  blind.push("webhook triggers: a provider console registration cannot be read from code — an exported handler on a callback path is taken as reachable; http triggers count only in-repo `/api/…` literals (an external caller reads as no trigger — unresolved, not dead, CLAUDE.md §1)")

  // ── consequential "use server" exports ──
  let readOnlyExports = 0
  const orphanCandidates: Array<{ d: Draft; name: string; file: string; start: number; end: number }> = []
  const useServerFiles = [...FILES.filter((f) => (f.startsWith("app/") || f.startsWith("lib/")) && (views(f)?.useServer ?? false)), ...fixtureFiles.map((x) => x.file)]
  for (const file of useServerFiles) {
    const fixture = fixtureFiles.find((x) => x.file === file)
    const v = fixture ? views(file, fixture.raw)! : views(file)!
    const fns = topLevelFns(v)
    const importers = IMPORTED.get(file)
    // WAVE 155 (lane 155R16): a "use server" ROUTE file's GET / POST / … exports are Next route handlers — reached by URL, never by
    // an import — and are already rows of the http population (http:/api/track/visitor is working there). Counting them again
    // as server actions made a second, false "missing (no importer)" row of the same handler. Control: section G.
    const routeFile = /^app\/api\/.+\/route\.tsx?$/.test(file)
    for (const fn of fns.filter((x) => x.exported && !(routeFile && ROUTE_METHOD_NAMES.has(x.name)))) {
      const facts = fixture ? factsOfSpan(file, v, fn.start, fn.end) : exportFacts(file, v, fns, fn)
      if (!facts.writes.size && !facts.egress.length) { readOnlyExports++; continue }
      const callers = [...(importers?.get(fn.name) ?? []), ...(importers?.get("*") ?? [])]
      // WAVE 155 (lane 155R22): …then the worker hop (ownerOfDelegatedRead) where the own span read no stewarded table at all
      const ow = ((o) => { if (o.owner) return o; const own = factsOfSpan(file, v, fn.start, fn.end); return ownerOfAuditedRead(own, facts) ?? ownerOfDelegatedRead(own, facts, delegatedWorkers(file, v, fns, fn.start, fn.end, fn.name)) ?? o })(ownerFromWrites(facts))
      // WAVE 155 (lane 155B1) — A SIBLING CALL IS A CALLER. An export that no file imports may still run: another export of the
      // SAME module that IS imported calls it (closureSpans — the exact same-file call graph the facts already walk). The
      // census read only importers, so such an export read as "no trigger". Controls: section F (a sibling-called export
      // gains a trigger; an export nothing calls does not).
      const sibling = callers.length || fixture ? undefined : siblingCaller(fns, v, fn, (n) => (importers?.get(n)?.size ?? 0) > 0)
      const d: Draft = {
        id: `server_action:${file}#${fn.name}`, kind: "server_action", entry: `${file}:${fn.line}`, action: fn.name, source_event: "UI / caller invocation (public server action)",
        trigger: callers.length ? `imported by ${callers[0]}${callers.length > 1 ? ` (+${callers.length - 1})` : ""}` : fixture ? `fixture caller` : sibling ? `called by ${sibling.name} (same module), imported by ${[...importers!.get(sibling.name)!][0]}` : null,
        worker: `${file} ${fn.name}`, owner: ow.owner, ownerWhy: ow.why, facts,
        // WAVE 155 (lane 155R22 part 2): rules B and C — derived only for a row no owner rule resolved
        staffDoor: ow.owner ? undefined : platformStaffDoorAt(file, v, closureSpans(fns, v, fn)) ?? undefined,
        ownRecord: ow.owner ? undefined : ownRecordWriteAt(file, v, fn, [...facts.writes.keys()], fixture ? codeOf(file, fixture.raw) : codeOf(file)) ?? undefined,
      }
      if (!d.trigger) { d.elsewhere = []; orphanCandidates.push({ d, name: fn.name, file, start: fn.start, end: fn.end }) }
      drafts.push(d)
    }
  }
  // the orphan proof for an export with no caller: its NAME as an identifier in any other runtime file, or in its own module
  // outside its own body (an object map, a re-export, a prop) — any hit makes it UNKNOWN, never LEGACY_ORPHAN
  // WAVE 155 (lane 155R16): …but NOT in a file that binds that name to SOMETHING ELSE — it declares its own top-level binding of
  // the name, or imports / re-exports the name from a module other than the export's own. app/actions/transactions.ts
  // addLender "appeared" in lib/application/transactions.ts (its OWN `export async function addLender`) and lib/application/
  // index.ts (`export { addLender } from "./transactions"` — the lib module's), 28 such rows read UNKNOWN for a name collision.
  // Controls: section G (a same-named declaration and a foreign re-export are not references; a bare use is).
  if (orphanCandidates.length) {
    const names = [...new Set(orphanCandidates.map((o) => o.name))]
    const re = new RegExp(`\\b(${names.map(reEsc).join("|")})\\b`, "g")
    for (const f of FILES) {
      const v = views(f); if (!v) continue
      for (const m of v.ids.matchAll(re)) for (const o of orphanCandidates) {
        if (o.name !== m[1]) continue
        if (f === o.file && m.index! >= o.start && m.index! < o.end) continue
        if (f !== o.file && bindsElsewhere(f, v, o.name, o.file)) continue
        if (!o.d.elsewhere!.includes(f)) o.d.elsewhere!.push(f === o.file ? `${f} (same module, outside its body)` : f)
      }
    }
  }
  blind.push("server actions: a path is the export + its same-file callees + the WHOLE-FILE facts of each local module it references (one hop; a lib module's facts are module-level — over-reports writes, under-reports anything two hops away); a computed import specifier is not an edge")

  for (const d of drafts) rowsOut.push(finish(d))
  const denominators: Record<string, number> = {}
  for (const r of rowsOut) denominators[r.trigger_kind] = (denominators[r.trigger_kind] ?? 0) + 1
  denominators["server_action (read-only, not rows)"] = readOnlyExports
  denominators["capability (catalog-only, not callable — not rows)"] = capabilityCatalogOnly
  denominators["use-server modules scanned"] = useServerFiles.length
  denominators["runtime files scanned"] = FILES.length
  blind.push(`manager-signal consumers from ${signalHandlersFrom}; a publisher is a file that calls publishManagerSignal AND carries the type as an exact string literal (a type built at run time is invisible)`)
  blind.push("planes and A7.1 surfaces are a LEXICAL lens over the entry path, action name and written tables (a row may sit on several planes; an unmatched row is '(unclassified)')")
  blind.push("readback = a reader of a written table in ANOTHER file via `.from(t).select` (an RPC, a view or a trigger-maintained reader is invisible); evidence = a ledger door (OUTCOME_RE / DOOR_TOKENS) or a write to a ledger-shaped table on the path")
  blind.push("decision owner = the first authority / arbiter / approval / spend / compliance token (PLANE_RES) or outbound gate on the path, a session read for a human-initiated action, or a verified provider signature for a webhook; a gate two hops away is invisible")
  // WAVE 155 (lane 155R16) — the blind spots of this lane's rules, published beside the numbers (CLAUDE.md §2)
  blind.push("log tables (isLogTable): a table is a log when its name says so (TRUE_LOG_RE) or when its name only has a record suffix (_events/_calls/_outcomes/invocations) and NO runtime `.from(t).update(` / `.upsert(` exists — a rewrite done only by an RPC, a trigger or SQL is invisible (the table would read as a log); an append-only gate ledger (compliance_events) is credited as evidence of the DECISION on the path, not of the action's outcome")
  blind.push("a receipt beyond an emit door (inside lib/kernel/event-reactor.ts / event-fanout.ts) is never the caller's evidence; WRITES and GATES found beyond the door are still merged into the caller's path, and the orchestrator's handlers (lib/orchestrator/internal.ts, reached through logEventAndTrigger) are not cut the same way")
  blind.push("the walk follows an imported FUNCTION (its body + same-file callees + the members it calls of a same-file object literal, e.g. defaultDeps.ledger), a re-export to its module, and nothing for a type / interface / enum / data constant; a class, a call result or a wrapped function still falls back to the target's whole-file facts (over-reports); a write gated by a data flag (`markUsed: false`) is credited as if the flag were true")
  blind.push(`kernel-event consumers: \`=== / case / [X]:\` (any file), a reactor array tested with \`.includes(params.event\`, or an L6 award rule while the reactor calls awardLifecycleMilestones — the last two only for an event with no structural consumer; a map key in a non-reactor file (notification-engine's title map) still counts as a consumer; emitters include every exported (emit|publish|fire|record|log)…Event door in lib/kernel + lib/events (${emitDoorsOut.length} doors) and direct lifecycle_events inserts (audit records)`)
  blind.push("decision doors: an INTERNAL caller (a fail-closed shared-secret refusal on the entry file — an http route or a secret-held server action) is credited as the counterpart of a session actor: it AUTHENTICATES the platform's own process; a verified grant token = a lookup by a token column + a refusal + an expiry comparison (a token column named otherwise, or an expiry kept elsewhere, is invisible)")
  // WAVE 155 (lane 155R22) — the blind spots of this lane's rules, published beside the numbers (CLAUDE.md §2)
  blind.push("owner by the WORKER HOP (ownerOfDelegatedRead): only a log-only path whose own span read no stewarded table; the workers are the callees its own span calls minus gate / identity / ledger / carrier helpers — by NAME (isNotAWorker: the census's decision, gate and ledger-door tokens plus require*/gate*/check*/can*/evaluateOutbound*, get*Context, audit*/emit*/notify* … shapes) or by STRUCTURE (the helper's own body resolves the signed-in identity or asks an authority / policy gate). A gate named like a worker and doing neither is read as a worker; a worker that resolves the identity itself is dropped (its row stays open). ONE hop: a worker's own imports, a worker reached through a call result or a class, and a dynamic `.from(variable)` are invisible; exactly ONE steward across all workers resolves, two resolve nothing")
  blind.push("kernel-event holds DERIVED from scripts/event-claims-ledger.ts EVENT_OWNER_HELD apply only to an emitted, unconsumed, not-audit-proven row; audit-only proof also reads a local door ALIAS (`const emit = … emitKernelEvent`, file-level — not scope-aware), refuses a quoted event value that is neither inside a door call nor keyed `event:` (an activity_type of the same spelling), and accepts a CONDITIONAL_AUDIT entry re-verified against its named file (file-level: one verified expression covers every site of that event in that file)")
  // WAVE 155 (lane 155R22 part 2) — rules A, B, C, E, F
  blind.push("A: an imported DATA constant (a multi-line type annotation now read at bracket depth) carries nothing; a namespace import, `export *`, a default import, a class, or a const whose initializer calls a non-builtin still falls back to the target's whole-file facts (over-reports)")
  blind.push("B: a platform-staff door = a row whose own path (export + same-file callees) reaches a DERIVED platform gate (a gate-shaped lib/ function whose body reads platform_role or a PLATFORM_RE token, to a fixpoint) and asks no authority-plane / tenant-seat token; held ONLY when `owner` is its one missing link. A platform check written inline without those tokens is invisible; a gate that is not gate-shaped by name is not derived")
  blind.push("C: an own-record write = every write of the path in the export's own span, one table, update/delete only, pinned `.eq(\"user_id\", R.userId|R.id)` with R bound by `const R = await <call>(` — RLS-only pinning, a pin through a helper, or a pin on another column is invisible (the row stays open)")
  blind.push("F: a callee block guarded by `if (<firstParam>.<flag> [&& …])` is dropped only when EVERY reference in the caller passes a literal `<flag>: false` in an object-literal first argument, the guard has no `||` / `?`, nothing reassigns the parameter or flag, and nothing consequential remains outside the guard; an inline `(await import(x)).fn(…)` call and a flag read through a destructured local are not evaluated")
  return { rows: rowsOut, denominators, blind, cronDrift, readOnlyExports, emitDoors: emitDoorsOut }
}

// ══ 9. THE GUARD RULE (pure) ════════════════════════════════════════════════════════════════════════════════════════════
type Baseline = Record<string, string>
const sig = (missing: Link[]) => [...missing].sort().join(",")
/** A row is a failure when it lacks a required link, is not owner-held, and its exact gap is not frozen in the baseline. */
function judge(rows: Row[], baseline: Baseline, ownerHeld: Record<string, string>): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (!r.missing.length || ownerHeld[r.id]) continue
    const frozen = baseline[r.id]
    if (frozen === undefined) { out.push(`${r.id} — NEW gap: missing ${sig(r.missing)} (${r.entrypoint})`); continue }
    const allowed = new Set(frozen.split(",").filter(Boolean))
    const extra = r.missing.filter((m) => !allowed.has(m))
    if (extra.length) out.push(`${r.id} — gap WIDENED: now also missing ${extra.join(",")} (frozen: ${frozen})`)
  }
  return out
}

// ══ 10. THE HUMAN-VERSUS-AUTONOMY MATRIX (driven through the real deciders) ═════════════════════════════════════════════
interface MatrixOut { lines: string[]; json: Record<string, unknown> }
async function decisionMatrix(): Promise<MatrixOut> {
  const ptp = await import("../lib/ai-isa/persona-tool-policy")
  const ag = await import("../lib/managers/autonomy-gate")
  const aa = await import("../lib/kernel/approval-authority")
  const sla = await import("../lib/kernel/approval-sla")
  const toolReg = await import("../lib/voice/tool-registry")
  const lines: string[] = []
  // (a) tool risk class × authority rung — isToolAllowedAtAuthority over every known tool name
  const names = [...new Set([...Object.keys(toolReg.voiceTools), ...Object.keys(ptp.TOOL_APPROVAL_GATE), ...ptp.FREE_INTERNAL_TOOL_NAMES])].sort()
  const classes: Record<string, string[]> = {}
  for (const n of names) (classes[ptp.riskClassForTool(n)] ??= []).push(n)
  const levels = [0, 1, 2, 3, 4, 5, 6] as const
  lines.push("| risk class | tools (known) | lowest rung | rungs 0–6 that mount it (✓ runs without a person · ✗ withheld) | human rule |", "|---|---|---|---|---|")
  const riskJson: Record<string, unknown> = {}
  for (const cls of ["READ", "LOW_RISK_WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE"]) {
    const tools = classes[cls] ?? []
    const rep = tools.find((t) => cls !== "FINANCIAL" || ptp.TOOL_APPROVAL_GATE[t]) ?? tools[0]
    const mounts = rep ? levels.map((l) => (ptp.isToolAllowedAtAuthority(rep, l) ? "✓" : "✗")).join(" ") : "—"
    const min = (ptp.MIN_AUTHORITY_FOR_RISK as Record<string, number | null>)[cls]
    const rule = min === null ? "never an AI tool — a person owns it" : cls === "FINANCIAL" ? "only with a named human-approval gate (TOOL_APPROVAL_GATE)" : cls === "COMMUNICATION" ? "sent through the dispatch policy chain; an autonomous send below rung 3 is HELD" : "none"
    lines.push(`| ${cls} | ${tools.length}${rep ? ` (e.g. \`${rep}\`)` : ""} | ${min ?? "never"} | ${mounts} | ${rule} |`)
    riskJson[cls] = { tools: tools.length, representative: rep ?? null, lowestRung: min, mounts }
  }
  // (b) autonomous outbound send — autonomyDecision over each posture / halt / rung (dispatch.ts autonomyGate)
  const scenarios: Array<[string, Parameters<typeof ag.autonomyDecision>[0]]> = [
    ["not a manager action (transactional / system)", { managerKey: null, effective: null }],
    ["a person approved it in the approval queue", { managerKey: "ai_isa", effective: "approval_required", humanApproved: true }],
    ["platform halted (god switch)", { managerKey: "ai_isa", effective: "autonomous", platformHalt: { halted: true, reason: null } }],
    ["tenant autonomy paused by platform staff", { managerKey: "ai_isa", effective: "autonomous", tenantHalt: { halted: true, reason: null } }],
    ["agent kind below rung 3 (communicate)", { managerKey: "ai_isa", effective: "autonomous", authorityLevel: 2 }],
    ["posture approval_required", { managerKey: "ai_isa", effective: "approval_required" }],
    ["posture autonomous, accuracy rail not earned", { managerKey: "ai_isa", effective: "autonomous", accuracyGate: { held: true, reason: null } }],
    ["posture autonomous", { managerKey: "ai_isa", effective: "autonomous", authorityLevel: 6 }],
    ["posture review_recommended (advisory)", { managerKey: "ai_isa", effective: "review_recommended" }],
    ["no posture signal", { managerKey: "ai_isa", effective: null }],
  ]
  lines.push("", "| autonomous outbound send (lib/managers/autonomy-gate.ts autonomyDecision, called by dispatch.ts autonomyGate) | outcome |", "|---|---|")
  const sendJson: Record<string, string> = {}
  for (const [label, input] of scenarios) { const d = ag.autonomyDecision(input); const o = d.allow ? "RUNS without a person" : "HELD for a person (approval queue)"; lines.push(`| ${label} | ${o} |`); sendJson[label] = o }
  // (c) who approves a tenant's own asset — approverFor on the in-memory PostgREST
  const B = "b1540000-0000-4000-8000-0000000000a1", AG = "a1540000-0000-4000-8000-0000000000a1", UA = "u1540000-0000-4000-8000-0000000000a1"
  const UL = "u1540000-0000-4000-8000-0000000000b1", UB = "u1540000-0000-4000-8000-0000000000c1", T = "71540000-0000-4000-8000-0000000000a1"
  const seed = (policy: Record<string, unknown> | null) => memSupabase({
    agents: [{ id: AG, user_id: UA, brokerage_id: B, team_id: T, is_active: true }],
    users: [{ id: UA, brokerage_id: B, user_type: "agent" }, { id: UL, brokerage_id: B, user_type: "team_lead" }, { id: UB, brokerage_id: B, user_type: "broker" }],
    user_role_assignments: [], team_members: [{ team_id: T, agent_id: AG, brokerage_id: B, is_active: true }],
    teams: [{ id: T, team_lead_id: UL, brokerage_id: B, deleted_at: null }],
    brokerage_settings: policy ? [{ brokerage_id: B, settings: policy }] : [],
  })
  lines.push("", "| asset kind (approverFor) | agent's own | team's | brokerage's | tenant policy requires the brokerage |", "|---|---|---|---|---|")
  const approveJson: Record<string, unknown> = {}
  for (const kind of aa.APPROVAL_ASSET_KINDS) {
    const cell = async (scope: Record<string, string>, policy: Record<string, unknown> | null) => {
      const d = await aa.approverFor({ brokerageId: B, assetKind: kind, scope, client: seed(policy) as never })
      return d.ok ? `${d.tier} (${d.basis})` : `refused: ${d.reason}`
    }
    const req = { [aa.PUBLICATION_APPROVAL_POLICY_KEY]: { require_brokerage_approval: { [kind]: { basis: "brokerage_policy" } } } }
    const row = [await cell({ agentId: AG }, null), await cell({ teamId: T }, null), await cell({}, null), await cell({ agentId: AG }, req)]
    lines.push(`| ${kind} | ${row.join(" | ")} |`)
    approveJson[kind] = row
  }
  // (d) approval SLA — evaluateApprovalSla (escalation only ever HOLDS; nothing auto-fires)
  const now = new Date("2026-11-18T12:00:00Z")
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
  const slaRows = [0, 11.9, 12, 23.9, 24, 48].map((h) => `${h}h → ${sla.evaluateApprovalSla(at(h), now).level}`)
  lines.push("", `Approval SLA (lib/kernel/approval-sla.ts evaluateApprovalSla, default windows): ${slaRows.join(" · ")}; the per-kind rail breaches at ${sla.APPROVAL_SLA_BREACH_HOURS}h. A breach ESCALATES to a person; it never fires the held action.`)
  // (e) the deterministic outbound chain, in the order dispatch.ts calls it
  const dv = views(DISPATCH_FILE)!
  const order = OUTBOUND_GATES.map((g) => ({ g, i: dv.ids.search(new RegExp(`\\b${g}\\s*\\(`)) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)
  lines.push("", `Deterministic outbound chain (never an LLM): ${order.map((x) => `\`${x.g}\` @ ${DISPATCH_FILE}:${lineAt(dv, x.i)}`).join(" → ")}.`)
  return { lines, json: { riskClassByRung: riskJson, autonomousSend: sendJson, assetApprover: approveJson, approvalSla: slaRows, outboundChain: order.map((x) => x.g) } }
}

// ══ 11. RENDERING ═══════════════════════════════════════════════════════════════════════════════════════════════════════
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
function consequence(r: Row): number {
  let s = 0
  if (r.planes.some((p) => p.startsWith("P9") || p.startsWith("P1 "))) s += 4
  if (r.planes.some((p) => p.startsWith("P8"))) s += 3
  if (r.writer.match(/dispatch|callConnector/)) s += 4
  if (r.missing.includes("schema")) s += 6
  if (r.missing.includes("trigger") || r.missing.includes("worker")) s += r.consequential ? 3 : 1
  if (r.missing.includes("decision") && r.consequential) s += 2
  if (r.missing.includes("evidence") && r.consequential) s += 2
  if (r.missing.includes("owner") && r.consequential) s += 1
  if (r.missing.includes("readback") && r.consequential) s += 1
  if (["cron", "kernel_event", "orchestrator_event", "manager_signal", "webhook", "provider_egress"].includes(r.trigger_kind)) s += 2
  return s
}
const FIX: Record<Link, string> = {
  schema: "point the write at the live table (scripts/live-tables.ts) or write the migration",
  trigger: "register the trigger (CRON_REGISTRY row / emitter / publisher / caller) or tombstone the worker naming its survivor",
  worker: "bind the executor (handler / SIGNAL_HANDLERS entry / capability executor) or retire the registry row",
  decision: "call the existing gate on the path (authority / approval / spend / compliance) before the write",
  evidence: "wrap the consequential write in withActionLedger (lib/kernel/action-ledger.ts)",
  owner: "add the registry row (CRON_MANAGER / TABLE_MANAGER / CAPABILITY_MANAGER / VOICE_TOOL_MANAGER) — integrator",
  readback: "add the reader of what it writes (the operator surface) or stop writing it",
}
/** A function / const token resolved to file:line in STRIPPED source — or MISSING (the guard fails on any MISSING anchor). */
function anchor(file: string, token: string): string {
  const v = views(file); if (!v) return `MISSING ${file}`
  const i = v.ids.search(new RegExp(`\\b(?:function\\s+|const\\s+|let\\s+)${token}\\b`))
  const j = i >= 0 ? i : v.ids.search(new RegExp(`\\b${token}\\b`))
  return j < 0 ? `MISSING ${file} · ${token}` : `${file}:${lineAt(v, j)} ${token}`
}
const tally = <T,>(xs: T[], key: (x: T) => string | null): Record<string, number> => {
  const o: Record<string, number> = {}
  for (const x of xs) { const k = key(x) ?? "(none)"; o[k] = (o[k] ?? 0) + 1 }
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}
const AUTONOMOUS: TriggerKind[] = ["cron", "kernel_event", "orchestrator_event", "manager_signal", "webhook"]
/** THE CHECKED-IN SUMMARY (docs/architecture/os-arbitration-gap-groups.json): groups, counts, classifications by domain — small. */
function gapGroups(rows: Row[]): Record<string, unknown> {
  const open = rows.filter((r) => r.state !== "working")
  const eg = open.filter((r) => r.classification === "EXECUTABLE_GAP")
  const ids = [...new Set(eg.map((r) => r.root_cause_group!))]
  const order = (id: string) => { const i = GROUPS.findIndex((g) => g.id === id); return i < 0 ? 1e3 : i }
  ids.sort((a, b) => order(a) - order(b) || a.localeCompare(b))
  const byDomain: Record<string, Record<string, number>> = {}
  for (const r of open) { const d = (byDomain[r.domain_b2] ??= {}); d[r.classification!] = (d[r.classification!] ?? 0) + 1 }
  const groups = ids.map((id) => {
    const g = GROUPS.find((x) => x.id === id)
    const rs = eg.filter((r) => r.root_cause_group === id).sort((a, b) => a.id.localeCompare(b.id))
    const out: Record<string, unknown> = {
      id, rows: rs.length, title: g?.title ?? "unclustered: one kind + one missing-link signature (no shared door found)",
      risk: tally(rs, (r) => r.risk_class), domains: tally(rs, (r) => r.domain_b2), missing: tally(rs, (r) => sig(r.missing)),
      leverage: g ? g.leverage.map(([f, t]) => anchor(f, t)) : [], fix: g?.fix ?? "per row", proof: g?.proof ?? "per row", split: g?.split ?? "per row",
      sample: rs.slice(0, 5).map((r) => r.id),
    }
    if (id === "G08-table-no-steward") out.unstewardedTables = Object.fromEntries(Object.entries(tally(rs.flatMap((r) => unstewarded(r)), (t) => t)).slice(0, 25))
    if (id.startsWith("G12") || id === "G09-log-only-owner" || id === "G05-cron-no-decision") out.modules = Object.fromEntries(Object.entries(tally(rs, (r) => r.file_line.split(":")[0])).slice(0, 15))
    return out
  })
  const residue: Record<string, unknown> = {}
  for (const cl of ["DECLARATIVE_READ_ONLY", "LEGACY_ORPHAN", "SIMULATED_ONLY", "OWNER_HELD", "UNKNOWN"] as Classification[]) {
    const rs = open.filter((r) => r.classification === cl).sort((a, b) => a.id.localeCompare(b.id))
    residue[cl] = { rows: rs.length, byKind: tally(rs, (r) => r.trigger_kind), evidenceClass: tally(rs, (r) => r.classification_evidence.replace(/ (carried by|appears in) .*$/, " …").slice(0, 140)), sample: rs.slice(0, 5).map((r) => r.id) }
  }
  // WAVE 155 (lane 155R16): the evidence credit that is still a JUDGMENT — a record-suffixed table (not a log by name) taken as
  // evidence because no runtime code rewrites it. Published, not hidden: a gate's own ledger (compliance_events) evidences the
  // DECISION on the path, not the outcome of the action.
  const eventsCredit = rows.filter((r) => /^row:\w+ @/.test(r.ledger_evidence) && !TRUE_LOG_RE.test(r.ledger_evidence.slice(4).split(" ")[0]))
  const rewrittenCredit = eventsCredit.filter((r) => rewrittenTables().has(r.ledger_evidence.slice(4).split(" ")[0]))
  return {
    generator: "scripts/os-coverage-ledger.ts --write (wave 155, lane 155B1) — GENERATED, do not edit; per-row ledger: coverage/os-arbitration-coverage.json (on demand)",
    states: tally(rows, (r) => r.state), classification: tally(open, (r) => r.classification), classificationByDomain: byDomain,
    executableGapRisk: tally(eg, (r) => r.risk_class), groups, residue,
    blindSpots: {
      evidenceCreditedByAnEventsDomainTable: { rows: rewrittenCredit.length, note: "a record-suffixed table that runtime code REWRITES (a domain table: calendar_events, open_house_events, voice_calls …) taken as evidence — 0 by construction since lane 155R16 (isLogTable); a non-zero count means the predicate was bypassed", sample: rewrittenCredit.slice(0, 5).map((r) => r.id) },
      evidenceCreditedByAnAppendOnlySuffixTable: { rows: eventsCredit.length, note: "evidence is a write to a record-suffixed table that is not a log BY NAME but that no runtime code rewrites (append-only: compliance_events, contact_consent_events, usage_events …). Taken as a ledger by rule; a gate's own ledger (compliance_events) evidences the decision on the path, not the action's outcome", byTable: tally(eventsCredit, (r) => r.ledger_evidence.slice(4).split(" ")[0]), sample: eventsCredit.slice(0, 5).map((r) => r.id) },
      autonomousConsequentialWithoutRecovery: { rows: rows.filter((r) => r.consequential && AUTONOMOUS.includes(r.trigger_kind) && r.failure_handling.startsWith("unresolved")).length, note: "recovery is REPORTED per row but is not a judged link (ECC agent-architecture-audit layer 12 cross-check): a failed autonomous run with no retry / sweep / escalation on its path" },
    },
  }
}
/** PURE — THE B4 RATCHET over classified rows (extra failures beyond judge()). */
function ratchet(rows: Row[], p0Frozen: Set<string> | null, managerKeys: Set<string>): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r.state === "working" && r.classification !== null) out.push(`${r.id} — a WORKING row carries classification ${r.classification} (an UNKNOWN or a gap counted as working)`)
    if (r.state !== "working" && r.classification === null) out.push(`${r.id} — a ${r.state} row is unclassified`)
    if (r.classification === "DECLARATIVE_READ_ONLY" && (r.path_effects.writes.length || r.path_effects.egress.length || r.path_effects.spend)) out.push(`${r.id} — DECLARATIVE_READ_ONLY but its path writes / sends / spends (${[...r.path_effects.writes, ...r.path_effects.egress, r.path_effects.spend ?? ""].filter(Boolean).slice(0, 3).join(", ")})`)
    if (r.classification === "EXECUTABLE_GAP" && !r.root_cause_group) out.push(`${r.id} — EXECUTABLE_GAP with no root-cause group`)
    if (r.classification === "EXECUTABLE_GAP" && r.risk_class === "P0" && p0Frozen && !p0Frozen.has(r.id)) out.push(`${r.id} — NEW P0 executable gap (${sig(r.missing)}; ${r.root_cause_group}) not in the frozen P0 list`)
    const m = r.registered_manager
    if (!(m.startsWith("unresolved") || m.startsWith("feed") || m.startsWith("per-call") || managerKeys.has(m))) out.push(`${r.id} — owner "${m}" is not a manager in MANAGERS`)
  }
  return out
}
function render(c: Census, matrix: MatrixOut): { md: string; json: string; groups: string } {
  const rows = [...c.rows].sort((a, b) => a.id.localeCompare(b.id))
  const byState = (rs: Row[]) => { const o: Record<string, number> = { working: 0, partial: 0, missing: 0, "owner-held": 0 }; for (const r of rs) o[r.state]++; return o }
  const all = byState(rows)
  const L: string[] = []
  L.push("# OS Arbitration and Autonomy Coverage Ledger", "",
    "> GENERATED by `scripts/os-coverage-ledger.ts --write` (wave 154, lane 154A1) — do not edit. One row per real executable action, derived by traversing the code;",
    "> a field that cannot be derived reads `unresolved: <reason>`. Machine-readable twin (on demand, not committed): `npx tsx scripts/os-coverage-ledger.ts --json` → `coverage/os-arbitration-coverage.json`.", "",
    "## 1. Totals (numerator / denominator)", "",
    `Rows: **${rows.length}** — working **${all.working}** · partial **${all.partial}** · missing **${all.missing}** · owner-held **${all["owner-held"]}**. Consequential rows: ${rows.filter((r) => r.consequential).length}.`, "",
    "| population | rows / scanned |", "|---|---|", ...Object.entries(c.denominators).map(([k, v]) => `| ${k} | ${v} |`), "")
  L.push("| trigger kind | rows | working | partial | missing |", "|---|---|---|---|---|")
  for (const k of [...new Set(rows.map((r) => r.trigger_kind))].sort()) { const rs = rows.filter((r) => r.trigger_kind === k); const s = byState(rs); L.push(`| ${k} | ${rs.length} | ${s.working} | ${s.partial} | ${s.missing} |`) }
  const linkCount: Record<string, number> = {}
  for (const r of rows) for (const m of r.missing) linkCount[m] = (linkCount[m] ?? 0) + 1
  L.push("", `Missing links across all rows: ${Object.entries(linkCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}.`, "")
  L.push("## 2. Kernel-to-customer map (existing components, by contract step)", "",
    "| contract step (A1) | existing component (live code) |", "|---|---|")
  const comp = (file: string, token: string) => { const v = views(file); if (!v) return `MISSING ${file}`; const i = v.ids.search(new RegExp(`\\b${token}\\b`)); return i < 0 ? `MISSING ${file} · ${token}` : `\`${token}\` @ ${file}:${lineAt(v, i)}` }
  const MAP: Array<[string, Array<[string, string]>]> = [
    ["OBSERVE (triggers)", [["lib/kernel/cron-dispatch.ts", "dispatchDueCrons"], ["lib/kernel/emit.ts", "emitKernelEvent"], ["lib/kernel/manager-signals.ts", "publishManagerSignal"], ["lib/kernel/ingress-reconciliation.ts", "runIngressReconciliation"]]],
    ["IDENTIFY ACTOR / TENANT", [["lib/kernel/manager-registry.ts", "resolveTableManager"], ["lib/voice/tool-registry.ts", "authorityAllows"], ["lib/kernel/portal-auth.ts", "requireLenderVendorActor"]]],
    ["BUILD TYPED ACTION · SELECT MANAGER", [["lib/kernel/manager-registry.ts", "resolveCronManager"], ["lib/kernel/manager-delegation.ts", "requestDelegation"], ["lib/agentic-os/capability-ownership.ts", "capabilityOwner"]]],
    ["CHECK AUTHORITY / POLICY / BUDGET", [["lib/ai-isa/persona-tool-policy.ts", "isToolAllowedAtAuthority"], ["lib/managers/autonomy-gate.ts", "autonomyDecision"], ["lib/kernel/approval-authority.ts", "approverFor"]]],
    ["COORDINATE OR HOLD", [["lib/ai-isa/followup-arbiter.ts", "arbitratePlannedTouch"], ["lib/kernel/approval-sla.ts", "evaluateApprovalSla"]]],
    ["EXECUTE THROUGH ONE WRITER / EGRESS", [[DISPATCH_FILE, "dispatchEmail"], [DISPATCH_FILE, "dispatchSms"], ["lib/agentic-os/connector-gateway.ts", "callConnector"]]],
    ["VERIFY · LEDGER · READER", [["lib/kernel/action-ledger.ts", "withActionLedger"], ["lib/kernel/action-ledger.ts", "ledgerToolCall"]]],
    ["RECOVER / LEARN", [["lib/kernel/ingress-reconciliation.ts", "runIngressReconciliation"], [DISPATCH_FILE, "redispatchSendIntent"]]],
  ]
  for (const [step, cs] of MAP) L.push(`| ${step} | ${cs.map(([f, t]) => comp(f, t)).join(" · ")} |`)
  L.push("", "## 3. The ten planes of A2", "", "| plane | rows | working | partial | missing |", "|---|---|---|---|---|")
  for (const [p] of PLANES) { const rs = rows.filter((r) => r.planes.includes(p)); const s = byState(rs); L.push(`| ${p} | ${rs.length} | ${s.working} | ${s.partial} | ${s.missing} |`) }
  const uncl = rows.filter((r) => !r.planes.length).length
  L.push("", `Unclassified rows (no plane matcher): ${uncl}.`, "", "## 4. The A7.1 surfaces", "", "| surface | rows | working | partial | missing | example working row / exact missing link |", "|---|---|---|---|---|---|")
  for (const [s] of A71) {
    const rs = rows.filter((r) => r.surfaces.includes(s)); const st = byState(rs)
    const w = rs.filter((r) => r.state === "working").sort((x, y) => x.surfaces.length - y.surfaces.length || x.id.localeCompare(y.id))[0]
    const ex = !rs.length ? `**missing** — no registered executable action matches \`${A71.find((x) => x[0] === s)![1].source}\`` : w ? `\`${w.id}\` @ ${w.entrypoint}` : `no working row — e.g. \`${rs[0].id}\` ${rs[0].why}`
    L.push(`| ${s} | ${rs.length} | ${st.working} | ${st.partial} | ${st.missing} | ${esc(ex)} |`)
  }
  L.push("", "## 5. Human-versus-autonomy decision matrix (driven through the real deciders, SIMULATED inputs)", "", ...matrix.lines, "")
  const auto = rows.filter((r) => ["cron", "kernel_event", "orchestrator_event", "manager_signal", "webhook"].includes(r.trigger_kind))
  const held = rows.filter((r) => r.decision_owner.startsWith("human approver"))
  const human = rows.filter((r) => r.decision_owner.startsWith("session"))
  L.push(`Per row: ${auto.length} rows start without a person (cron / event / signal / webhook), of which ${auto.filter((r) => r.decision_owner.startsWith("unresolved")).length} carry no decision gate on their path; ${held.length} rows hold for a human approver on the path; ${human.length} rows are decided by the signed-in person.`, "")
  L.push("## 6. Gap list (ranked by consequence; top 60 — the full set is the JSON)", "", "| # | row | missing | entrypoint | smallest in-place fix |", "|---|---|---|---|---|")
  const gaps = rows.filter((r) => r.missing.length && r.state !== "owner-held").sort((a, b) => consequence(b) - consequence(a) || a.id.localeCompare(b.id))
  gaps.slice(0, 60).forEach((r, i) => L.push(`| ${i + 1} | \`${esc(r.id)}\` | ${r.missing.join(", ")} | ${esc(r.entrypoint)} | ${FIX[r.missing[0]]} |`))
  L.push("", "## 7. Per-plane rows (state ≠ working; working rows are in the JSON)", "")
  for (const [p] of PLANES) {
    const rs = rows.filter((r) => r.domain === p && r.state !== "working")
    if (!rs.length) continue
    L.push(`### ${p} — ${rs.length} not working`, "", "| row | state | missing | manager | decision owner | entrypoint |", "|---|---|---|---|---|---|")
    for (const r of rs.slice(0, 80)) L.push(`| \`${esc(r.id)}\` | ${r.state} | ${r.missing.join(", ")} | ${esc(r.registered_manager.slice(0, 60))} | ${esc(r.decision_owner.slice(0, 70))} | ${esc(r.entrypoint)} |`)
    if (rs.length > 80) L.push(`| … ${rs.length - 80} more in the JSON | | | | | |`)
    L.push("")
  }
  L.push("## 8. Blind spots (published beside the numbers, CLAUDE.md §2)", "", ...c.blind.map((b) => `- ${b}`), "")
  const gg = gapGroups(rows) as { classification: Record<string, number>; classificationByDomain: Record<string, Record<string, number>>; groups: Array<Record<string, any>>; residue: Record<string, any>; blindSpots: Record<string, { rows: number; note: string }> }
  const CL = ["EXECUTABLE_GAP", "DECLARATIVE_READ_ONLY", "LEGACY_ORPHAN", "SIMULATED_ONLY", "OWNER_HELD", "UNKNOWN"]
  L.push("## 9. What kind of work each open row is (wave 155, lane 155B1 — directive B1 / B4)", "",
    "An ADDITIONAL column: it never changes a verdict above and never widens the baseline. Rules: `classify()` and `GROUPS` in the generator; the checked-in summary is `docs/architecture/os-arbitration-gap-groups.json`.", "",
    `Open rows: ${Object.entries(gg.classification).map(([k, v]) => `${k} **${v}**`).join(" · ")}.`, "",
    `| domain (directive B2) | ${CL.join(" | ")} |`, `|---|${CL.map(() => "---").join("|")}|`,
    ...Object.entries(gg.classificationByDomain).sort((a, b) => a[0].localeCompare(b[0])).map(([d, o]) => `| ${d} | ${CL.map((k) => o[k] ?? 0).join(" | ")} |`), "",
    "| root-cause group | rows | risk | leverage point | fix |", "|---|---|---|---|---|",
    ...gg.groups.map((g) => `| \`${g.id}\` ${esc(String(g.title))} | ${g.rows} | ${Object.entries(g.risk as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(" · ")} | ${esc((g.leverage as string[]).join("; ") || "—")} | ${esc(String(g.fix).slice(0, 220))} |`), "",
    "| residue | rows | evidence class |", "|---|---|---|",
    ...Object.entries(gg.residue).map(([k, v]) => `| ${k} | ${v.rows} | ${esc(Object.entries(v.evidenceClass as Record<string, number>).map(([e, n]) => `${n}× ${e}`).join(" · ").slice(0, 400) || "—")} |`), "",
    ...Object.entries(gg.blindSpots).map(([k, v]) => `- **${k}**: ${v.rows} rows — ${v.note}`), "")
  if (c.cronDrift.length) L.push("## Cron drift", "", ...c.cronDrift.map((x) => `- ${x}`), "")
  // one row per line: diff-friendly and a third of the pretty-printed size
  const head = JSON.stringify({ generator: "scripts/os-coverage-ledger.ts", denominators: c.denominators, states: all, missingLinks: linkCount, decisionMatrix: matrix.json, blindSpots: c.blind })
  const json = `${head.slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}`
  return { md: L.join("\n") + "\n", json: json + "\n", groups: JSON.stringify(gg, null, 1) + "\n" }
}
/** Structure only — every `:<line>` anchor removed, so a line drift elsewhere does not turn the guard red (rows / fields / states still must agree). */
const structural = (s: string) => s.replace(/(\.tsx?|\.json):\d+/g, "$1")

// ══ 12. MAIN ════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const t0 = Date.now()
  section("A — the vocabularies are loaded from their owners, and each still sees its defect (positive controls)")
  check(`PLANE_RES (${PLANE_RES.length} planes) evaluated out of ${MOG}`, PLANE_RES.length >= 5 && PLANE_RES.some(([p, re]) => p === "A" && re.test("isToolAllowedAtAuthority(")))
  check("NEXT_RE / RECOVERY_RE / OUTCOME_RE / WRITE_RE / READ_RE still recognise their specimens", NEXT_RE.test("emitKernelEvent(") && RECOVERY_RE.test("recordSelfHeal(") && OUTCOME_RE.test("withActionLedger(") && new RegExp(WRITE_RE.source).test(`.from("deals").insert`) && new RegExp(READ_RE.source).test(`.from("deals").select`))
  check(`DOOR_TOKENS (${DOOR_TOKENS.length}) evaluated out of ${AEC}`, DOOR_TOKENS.includes("withActionLedger") && DOOR_RE.test("ledgerToolExecutions("))
  check(`egress doors derived from ${DISPATCH_FILE} exports (${DISPATCH_DOORS.join(", ")})`, DISPATCH_DOORS.includes("dispatchEmail") && DISPATCH_DOORS.includes("dispatchSms"))
  check("POSITIVE CONTROL: the gate vocabulary recognises the payout release gate as a call, and not as a word in a comment (lane 154A3)",
    GATE_EXTRA_RE.test("const gate = payoutReleaseGate({ timing: inputs.timing })") && !GATE_EXTRA_RE.test("the payoutReleaseGate decides") && /\bfunction payoutReleaseGate\s*\(/.test(views("lib/kernel/financial.ts")?.ids ?? ""))
  check("POSITIVE CONTROL (lane 155R16 / 155R17 request 5): the gate vocabulary reads the first-touch arbiter as a call, not as a word — and the function still exists",
    GATE_EXTRA_RE.test("const action = decideFirstTouch({ contact })") && !GATE_EXTRA_RE.test("decideFirstTouch decides who goes first") && /\bfunction decideFirstTouch\s*\(/.test(views("lib/campaign-sequences/first-touch-coordination.ts")?.ids ?? ""))
  check(`every outbound gate this file names is still called in ${DISPATCH_FILE}`, OUTBOUND_GATES.slice(0, 3).every((g) => new RegExp(`\\b${g}\\s*\\(`).test(views(DISPATCH_FILE)!.ids)))

  section("B — the fact extractor reads code, not words (planted fixture; a tombstone and a string are not a call)")
  const fxDir = mkdtempSync(join(tmpdir(), "os-coverage-ledger-"))
  const FX = "app/actions/__os_coverage_fixture__.ts"
  const fxRaw = [
    `"use server"`,
    `// TOMBSTONE: this used to call withActionLedger( and getAgentContext( — a comment is not a call site`,
    `export async function plantedUnledgered(id: string) {`,
    `  const note = "withActionLedger(  requireCallerTenant(  approverFor("`,
    `  await svc.from("transactions").update({ note }).eq("id", id)`,
    `}`,
    `export async function plantedLedgered(id: string) {`,
    `  await withActionLedger({ action: "x" }, async () => svc.from("transactions").update({}).eq("id", id))`,
    `}`,
    `export async function plantedGhostTable() { await svc.from("os_coverage_table_that_is_not_live").insert({}) }`,
    `export async function plantedRead() { return svc.from("transactions").select("id") }`,
  ].join("\n")
  const fxV = views(FX, fxRaw)!
  const fxFns = topLevelFns(fxV)
  const fxFacts = (n: string) => factsOfSpan(FX, fxV, fxFns.find((f) => f.name === n)!.start, fxFns.find((f) => f.name === n)!.end)
  check("the export extractor finds all four planted exports", ["plantedUnledgered", "plantedLedgered", "plantedGhostTable", "plantedRead"].every((n) => fxFns.some((f) => f.name === n && f.exported)))
  check("POSITIVE CONTROL: a write whose ledger door is only in a comment and a string has NO evidence and NO gate", fxFacts("plantedUnledgered").writes.has("transactions") && fxFacts("plantedUnledgered").evidence.length === 0 && fxFacts("plantedUnledgered").gates.length === 0 && !fxFacts("plantedUnledgered").session)
  check("…and the same write inside withActionLedger( has evidence", fxFacts("plantedLedgered").evidence.some((e) => e.token === "withActionLedger"))
  check("a read-only export is not consequential (no write, no egress)", fxFacts("plantedRead").writes.size === 0 && fxFacts("plantedRead").egress.length === 0)
  {
    const FX_GEN = "app/actions/__os_coverage_generic_call_fixture__.ts"
    const fxGenV = views(FX_GEN, [
      `async function helperLedgered<T>(run: () => Promise<T>) { return withActionLedger({ action: "x" }, run) }`,
      `export async function plantedGenericCall(id: string) {`,
      `  return helperLedgered<{ ok: boolean; error?: string }>(async () => svc.from("transactions").update({}).eq("id", id))`,
      `}`,
      `export async function plantedComparison(a: number, b: number) { if (a < b && b > (a)) return 1; return 0 }`,
      `export async function plantedPlainCall(id: string) { return helperLedgered(async () => svc.from("transactions").update({}).eq("id", id)) }`,
    ].join("\n"))!
    const fxGenFns = topLevelFns(fxGenV)
    const reach = (n: string) => closureSpans(fxGenFns, fxGenV, fxGenFns.find((f) => f.name === n)!).map((x) => x.name)
    check("POSITIVE CONTROL (newly FOUND): a same-file helper called with explicit type arguments is followed to its receipt", reach("plantedGenericCall").includes("helperLedgered"), JSON.stringify(reach("plantedGenericCall")))
    check("…a plain call to the same helper is still followed", reach("plantedPlainCall").includes("helperLedgered"))
    check("NEGATIVE CONTROL: a comparison (`a < b && b > (a)`) is not read as a call", !reach("plantedComparison").includes("helperLedgered") && reach("plantedComparison").length === 1, JSON.stringify(reach("plantedComparison")))
  }
  rmSync(fxDir, { recursive: true, force: true })

  section("C — the census (every population read from its registry)")
  // WAVE 155 (lane 155R16): a planted "use server" ROUTE file — its POST is the http population's row, its helper is a server action
  const FX_ROUTE = "app/api/__os_coverage_route_fixture__/route.ts"
  const fxRouteRaw = [`"use server"`, `export async function POST(req: Request) { await svc.from("deals").update({}) }`, `export async function plantedRouteHelper() { await svc.from("deals").update({}) }`].join("\n")
  // WAVE 155 (lane 155R22): the worker-hop fixture (section G, G9) — tables chosen from TABLE_MANAGER at run time, never typed
  const FX_HOP = "app/actions/__os_coverage_hop_fixture__.ts"
  const TM0 = (await import("../lib/kernel/manager-registry")).TABLE_MANAGER as Record<string, string> // census() sets TABLE_MANAGER from the same import
  const hopA = Object.keys(TM0).find((t) => !ACTOR_IDENTITY_READS.has(t) && !CARRIER_TABLES.has(t) && !EVIDENCE_TABLE_RE.test(t) && LIVE.has(t))!
  const hopB = Object.keys(TM0).find((t) => !ACTOR_IDENTITY_READS.has(t) && !CARRIER_TABLES.has(t) && !EVIDENCE_TABLE_RE.test(t) && LIVE.has(t) && TM0[t] !== TM0[hopA])!
  const sel = (t: string) => `const { data } = await createServiceClient().from("${t}").select("*").eq("id", id); return data`
  const logW = `await createServiceClient().from("self_heal_events").insert({ subject: id })`
  const fxHopRaw = [`"use server"`, `import { createServiceClient } from "@/lib/supabase/service"`,
    `async function requireSeat(id: string) { ${sel(hopA)} }`,
    `async function loadScope(id: string) { const ctx = await getAgentContext(); ${sel(hopA)} }`,
    `async function loadThing(id: string) { ${sel(hopA)} }`,
    `async function loadOther(id: string) { ${sel(hopB)} }`,
    `export async function plantedWorkerRead(id: string) { await requireSeat(id); await loadThing(id); ${logW} }`,
    `export async function plantedGateOnlyRead(id: string) { await requireSeat(id); ${logW} }`,
    `export async function plantedStructuralGateRead(id: string) { await loadScope(id); ${logW} }`,
    `export async function plantedTwoWorkers(id: string) { await loadThing(id); await loadOther(id); ${logW} }`].join("\n")
  // WAVE 155 (lane 155R22 part 2): the staff-door (B) and own-record (C) fixture (section G, G11)
  const FX_P2 = "app/actions/__os_coverage_p2_fixture__.ts"
  const sess2 = `const { data: { user } } = await supabase.auth.getUser()`
  const fxP2Raw = [`"use server"`, `import { createServiceClient } from "@/lib/supabase/service"`,
    `export async function plantedStaffLogOnly(id: string) { ${sess2}; const gate = await requirePlatformCapability("providers"); if (!gate.ok) return; await createServiceClient().from("superadmin_audit_log").insert({ action: id }) }`,
    `export async function plantedTenantLogOnly(id: string) { ${sess2}; const t = await requireCallerTenant(id); await createServiceClient().from("superadmin_audit_log").insert({ action: id }) }`,
    `export async function plantedStaffOwned(id: string) { ${sess2}; const gate = await requirePlatformCapability("providers"); if (!gate.ok) return; await createServiceClient().from("${hopA}").update({ x: id }).eq("id", id); await createServiceClient().from("superadmin_audit_log").insert({ action: id }) }`,
    `export async function plantedStaffNoEvidence(id: string) { ${sess2}; const gate = await requirePlatformCapability("providers"); if (!gate.ok) return; await createServiceClient().from("notifications").insert({ title: id }) }`,
    `export async function plantedOwnRecord(id: string) { ${sess2}; const ctx = await resolveWriteContext()\n  const { error } = await ctx.db.from("notifications").update({ is_read: true }).eq("id", id).eq("user_id", ctx.userId) }`,
    `export async function plantedOtherRecord(target: string) { ${sess2}; const ctx = await resolveWriteContext()\n  const { error } = await ctx.db.from("notifications").insert({ user_id: target, title: "x" }) }`,
    `export async function plantedParamPinned(input: { userId: string }) { ${sess2}\n  const { error } = await createServiceClient().from("notifications").update({ is_read: true }).eq("user_id", input.userId) }`,
    `export async function plantedStaffAlternative(id: string) { ${sess2}; if (sameTenant || isPlatformStaffIdentity(u.user_type, u.platform_role)) { await createServiceClient().from("superadmin_audit_log").insert({ action: id }) } }`,
    `export async function plantedStaffUnchecked(id: string) { ${sess2}; const gate = await requirePlatformCapability("providers"); await createServiceClient().from("superadmin_audit_log").insert({ action: id }) }`].join("\n")
  const c = await census([], [{ file: FX, raw: fxRaw }, { file: FX_ROUTE, raw: fxRouteRaw }, { file: FX_HOP, raw: fxHopRaw }, { file: FX_P2, raw: fxP2Raw }])
  const isFixtureRow = (id: string) => id.includes("__os_coverage_")
  const fxRows = c.rows.filter((r) => r.id.startsWith(`server_action:${FX}`))
  const realRows = c.rows.filter((r) => !isFixtureRow(r.id))
  const fx = (n: string) => fxRows.find((r) => r.id.endsWith(`#${n}`))
  check("POSITIVE CONTROL: the planted unledgered write is a row missing evidence + decision, and its owner resolves from TABLE_MANAGER (transactions)", !!fx("plantedUnledgered") && fx("plantedUnledgered")!.missing.includes("evidence") && fx("plantedUnledgered")!.missing.includes("decision") && !fx("plantedUnledgered")!.missing.includes("owner") && !fx("plantedUnledgered")!.missing.includes("schema"), JSON.stringify(fx("plantedUnledgered")?.missing))
  check("POSITIVE CONTROL: a write to a table that is not live is flagged `schema`", !!fx("plantedGhostTable") && fx("plantedGhostTable")!.missing.includes("schema"))
  check("the planted read-only export is NOT a row", !fx("plantedRead"))
  {
    const pf = emptyFacts(); pf.writes.set("__os_coverage_unread_unowned__", `${FX}:5`)
    const planted = finish({ id: "planted:owner-readback", kind: "server_action", entry: `${FX}:3`, action: "planted", source_event: "planted", trigger: "planted caller", worker: "planted", owner: null, facts: pf })
    check("POSITIVE CONTROL: a consequential write to a table with no steward and no reader is missing owner AND readback (and schema)", ["owner", "readback", "schema"].every((m) => planted.missing.includes(m as Link)), JSON.stringify(planted.missing))
    const ok = emptyFacts(); ok.writes.set("transactions", `${FX}:5`); ok.evidence.push({ token: "withActionLedger", at: `${FX}:5` }); ok.gates.push({ token: "authority:requireCallerTenant", at: `${FX}:4` })
    const good = finish({ id: "planted:working", kind: "server_action", entry: `${FX}:3`, action: "planted", source_event: "planted", trigger: "planted caller", worker: "planted", owner: "deal_coordinator", facts: ok })
    check("…and the same write to a stewarded, read table behind a gate and a ledger is `working`", good.state === "working", JSON.stringify(good.missing))
  }
  check("stateOf: no trigger → missing · gaps → partial · none → working",stateOf(["trigger"]) === "missing" && stateOf(["worker", "owner"]) === "missing" && stateOf(["evidence"]) === "partial" && stateOf([]) === "working")
  for (const k of ["cron", "kernel_event", "orchestrator_event", "manager_signal", "capability", "assistant_tool", "provider_egress", "webhook", "http", "server_action"]) {
    check(`population ${k} is non-empty (${c.denominators[k] ?? 0} rows)`, (c.denominators[k] ?? 0) > 0)
  }
  check("no vercel.json cron drifts from CRON_REGISTRY", c.cronDrift.length === 0, c.cronDrift.join("; "))
  check("every row field is derived or `unresolved: <reason>` (never empty)", realRows.every((r) => Object.values(r).every((x) => x !== "" && x !== undefined)))
  check("no row names a manager key that is not in MANAGERS (the census never invents an owner)", realRows.every((r) => r.registered_manager.startsWith("unresolved") || MANAGER_KEYS.has(r.registered_manager) || r.registered_manager.startsWith("feed") || r.registered_manager.startsWith("per-call")))
  for (const [p] of PLANES) check(`plane "${p}" maps to at least one real action`, realRows.some((r) => r.planes.includes(p)))

  section("D — THE GUARD (A7.4): a registered path that lacks owner / decision / trigger / worker / evidence / readback fails")
  const baselineExists = existsSync(join(ROOT, BASELINE_FILE))
  const baseline: Baseline = baselineExists ? JSON.parse(rawOf(BASELINE_FILE)).gaps ?? {} : {}
  // the planted cron: a registry row with no CRON_MANAGER owner and no route file
  const planted = await census([{ path: "/api/cron/__os_coverage_planted__", schedule: "0 3 * * *" }], [], true)
  const plantedRow = planted.rows.find((r) => r.id === "cron:/api/cron/__os_coverage_planted__")
  const plantedFail = judge(planted.rows, baseline, OWNER_HELD).find((x) => x.includes("__os_coverage_planted__"))
  check("POSITIVE CONTROL: a planted CRON_REGISTRY row with no owner and no route is a `missing` row and FAILS the guard", !!plantedRow && plantedRow.state === "missing" && plantedRow.missing.includes("worker") && !!plantedFail, plantedFail ?? JSON.stringify(plantedRow?.missing))
  check("POSITIVE CONTROL: the planted unledgered server action FAILS the guard (not frozen)", judge(fxRows, baseline, OWNER_HELD).some((x) => x.includes("plantedUnledgered")))
  check("…and a frozen gap that WIDENS fails too", judge([{ ...fx("plantedUnledgered")!, missing: ["evidence", "readback"] }], { [fx("plantedUnledgered")!.id]: "evidence" }, {}).some((x) => x.includes("WIDENED")))
  check("…and an OWNER_HELD row with its reason does not fail", judge([fx("plantedUnledgered")!], {}, { [fx("plantedUnledgered")!.id]: "owner reason" }).length === 0)
  check("every OWNER_HELD entry is a real row with a reason", Object.entries(OWNER_HELD).every(([id, why]) => why.length > 10 && realRows.some((r) => r.id === id)))
  // WAVE 155 (lane 155R22): the holds a population DERIVED from another guard's ledger (eventLedgerHold) count exactly like the
  // static ones for the judge and the baseline prune — one held map, built from the rows, never typed
  const HELD: Record<string, string> = { ...OWNER_HELD }
  for (const r of realRows) if (r.state === "owner-held" && !HELD[r.id]) HELD[r.id] = r.why
  // WAVE 155 (lane 155B1, B4): the frozen P0 EXECUTABLE_GAP list. Created ONCE from the measured rows (it adds a constraint,
  // it allows nothing new: every id in it is already a frozen gap); afterwards --write-baseline only PRUNES it.
  const baselineDoc = baselineExists ? JSON.parse(rawOf(BASELINE_FILE)) as { p0ExecutableGaps?: string[] } : {}
  const p0Frozen: Set<string> | null = baselineDoc.p0ExecutableGaps ? new Set(baselineDoc.p0ExecutableGaps) : null
  const isP0Gap = (r: Row) => r.classification === "EXECUTABLE_GAP" && r.risk_class === "P0"
  if (WRITE_BASELINE) {
    const next: Baseline = {}
    for (const r of realRows) if (r.missing.length && !HELD[r.id]) {
      if (!baselineExists) next[r.id] = sig(r.missing)
      else if (baseline[r.id] !== undefined) { const allowed = new Set(baseline[r.id].split(",")); const keep = r.missing.filter((m) => allowed.has(m)); if (keep.length) next[r.id] = sig(keep) }
    }
    const p0 = realRows.filter((r) => isP0Gap(r) && next[r.id] !== undefined && (!p0Frozen || p0Frozen.has(r.id))).map((r) => r.id).sort()
    writeFileSync(join(ROOT, BASELINE_FILE), JSON.stringify({ note: "Frozen gaps of scripts/os-coverage-ledger.ts (wave 154, lane 154A1). --write-baseline only PRUNES once this file exists: a closed gap leaves, a new gap is red. Never add by hand. p0ExecutableGaps (wave 155, lane 155B1): the P0 EXECUTABLE_GAP rows at the freeze — a P0 executable gap outside it is red; prune-only.", gaps: next, p0ExecutableGaps: p0 }, null, 1) + "\n")
    console.log(`  · ${baselineExists ? "pruned" : "created"} ${BASELINE_FILE}: ${Object.keys(next).length} frozen gaps (was ${Object.keys(baseline).length}); ${p0.length} frozen P0 executable gaps (was ${p0Frozen ? p0Frozen.size : "absent"})`)
  }
  const live = judge(realRows, WRITE_BASELINE ? JSON.parse(rawOf(BASELINE_FILE)).gaps : baseline, HELD)
  check(`no registered executable path has an UNFROZEN gap (${realRows.filter((r) => r.missing.length).length} gapped rows, ${Object.keys(baseline).length} frozen)`, live.length === 0, live.slice(0, 12).join("\n      ") + (live.length > 12 ? `\n      … ${live.length - 12} more` : ""))
  const stale = Object.keys(baseline).filter((id) => { const r = realRows.find((x) => x.id === id); return !r || !r.missing.length })
  console.log(`  · ${stale.length} frozen gap(s) have closed or left the tree — run --write-baseline to tighten (informational, never red)`)

  section("E — the human-versus-autonomy matrix (the real deciders) and the generated documents")
  const matrix = await decisionMatrix()
  const risk = matrix.json.riskClassByRung as Record<string, { lowestRung: number | null }>
  check("the matrix is derived: LEGAL / IRREVERSIBLE never run without a person; READ runs at rung 0", risk.LEGAL?.lowestRung === null && risk.IRREVERSIBLE?.lowestRung === null && risk.READ?.lowestRung === 0)
  const send = matrix.json.autonomousSend as Record<string, string>
  check("autonomyDecision: a halt or approval_required HOLDS; autonomous RUNS", send["platform halted (god switch)"].startsWith("HELD") && send["posture approval_required"].startsWith("HELD") && send["posture autonomous"].startsWith("RUNS"))
  const ap = matrix.json.assetApprover as Record<string, string[]>
  check("approverFor: the owner approves their own asset; a tenant policy moves it to the brokerage", Object.values(ap).every((r) => r[0].startsWith("owner_agent") && r[3].startsWith("tenant_admin")))
  // WAVE 155 (lane 155R22): the PUBLISHED denominators count real rows only. They were counted over every row the census built,
  // fixtures included (at 15d212bf: server_action 1918 printed vs 1914 real rows; "use-server modules scanned" 668 with the 2
  // planted files) — a planted control moved a published number. Recounted here from realRows; the fixture files are subtracted.
  const realDen: Record<string, number> = { ...c.denominators }
  for (const k of Object.keys(realDen)) if (c.rows.some((r) => r.trigger_kind === k)) realDen[k] = realRows.filter((r) => r.trigger_kind === k).length
  realDen["use-server modules scanned"] = (c.denominators["use-server modules scanned"] ?? 0) - [FX, FX_ROUTE, FX_HOP, FX_P2].length
  c.denominators = realDen
  const out = render({ ...c, rows: realRows }, matrix)
  const mapSection = out.md.slice(out.md.indexOf("## 2."), out.md.indexOf("## 3."))
  check("every component on the kernel-to-customer map resolves to live code (a function token in stripped source)", !!mapSection && !mapSection.includes("MISSING"), mapSection.match(/MISSING[^|]*/g)?.join("; "))
  if (WRITE) {
    mkdirSync(join(ROOT, "docs/architecture"), { recursive: true })
    writeFileSync(join(ROOT, DOC_MD), out.md)
    console.log(`  · wrote ${DOC_MD} (${out.md.length} bytes)`)
  }
  if (WRITE_JSON) {
    mkdirSync(join(ROOT, dirname(DOC_JSON)), { recursive: true })
    writeFileSync(join(ROOT, DOC_JSON), out.json)
    console.log(`  · wrote the on-demand artifact ${DOC_JSON} (${out.json.length} bytes, git-ignored)`)
  }
  const mdNow = rawOf(DOC_MD)
  check(`${DOC_MD} is the rendering of the code (line anchors excluded; the JSON twin is an on-demand artifact, not checked in)`, !!mdNow && structural(mdNow) === structural(out.md),
    !mdNow ? "absent — run `npx tsx scripts/os-coverage-ledger.ts --write`" : "stale — re-run with --write")
  if (WRITE) { writeFileSync(join(ROOT, DOC_GROUPS), out.groups); console.log(`  · wrote ${DOC_GROUPS} (${out.groups.length} bytes)`) }
  const groupsNow = rawOf(DOC_GROUPS)
  check(`${DOC_GROUPS} is the rendering of the code (line anchors excluded)`, !!groupsNow && structural(groupsNow) === structural(out.groups), !groupsNow ? "absent — run with --write" : "stale — re-run with --write")
  check("every root-cause group's leverage point resolves to live code (a token in stripped source)", !out.groups.includes("MISSING "), out.groups.match(/MISSING [^"]*/g)?.join("; "))
  check(`the checked-in summary stays small (${out.groups.length} bytes ≤ 64 KB; the per-row ledger is the on-demand JSON)`, out.groups.length <= 65536)

  section("F — CLASSIFICATION + THE B4 RATCHET (wave 155, lane 155B1): every open row is classified by rule; each rule has a positive and a negative fixture")
  const ci = (o: Partial<ClassInput>): ClassInput => ({ id: "fx", kind: "server_action", state: "partial", missing: ["evidence"], consequential: true, worker: true, effects: { writes: [], egress: [], spend: null }, ...o })
  const cOf = (o: Partial<ClassInput>) => classify(ci(o))?.c ?? null
  check("classify: a working row is not classified; an OWNER_HELD row is OWNER_HELD", cOf({ state: "working", missing: [] }) === null && cOf({ state: "owner-held" }) === "OWNER_HELD")
  check("POSITIVE: an event whose every emission says auditOnly is DECLARATIVE_READ_ONLY — NEGATIVE: one fan-out emission, or an unprovable site, keeps it an EXECUTABLE_GAP",
    cOf({ kind: "kernel_event", missing: ["worker"], worker: false, auditOnlyEmits: true }) === "DECLARATIVE_READ_ONLY" && cOf({ kind: "kernel_event", missing: ["worker"], worker: false, auditOnlyEmits: false }) === "EXECUTABLE_GAP" && cOf({ kind: "kernel_event", missing: ["worker"], worker: false, auditOnlyEmits: null }) === "EXECUTABLE_GAP")
  check("POSITIVE: a tool whose own path writes / sends / spends nothing is DECLARATIVE_READ_ONLY — NEGATIVE: one write, one send or one spend gate and it is an EXECUTABLE_GAP",
    cOf({ kind: "assistant_tool", missing: ["owner"] }) === "DECLARATIVE_READ_ONLY" && cOf({ kind: "assistant_tool", missing: ["owner"], effects: { writes: ["contacts"], egress: [], spend: null } }) === "EXECUTABLE_GAP"
    && cOf({ kind: "assistant_tool", missing: ["owner"], effects: { writes: [], egress: ["dispatchSms"], spend: null } }) === "EXECUTABLE_GAP" && cOf({ kind: "assistant_tool", missing: ["owner"], effects: { writes: [], egress: [], spend: "mayUseAndAfford @ x:1" } }) === "EXECUTABLE_GAP")
  check("POSITIVE: an event / export with no caller and no reference anywhere is LEGACY_ORPHAN — NEGATIVE: a reference elsewhere (or SQL) makes it UNKNOWN; an http / cron route is never an orphan (external callers)",
    cOf({ kind: "kernel_event", missing: ["trigger", "worker"], worker: false, elsewhere: [] }) === "LEGACY_ORPHAN" && cOf({ kind: "kernel_event", missing: ["trigger", "worker"], worker: false, elsewhere: ["supabase/migrations (SQL)"] }) === "UNKNOWN"
    && cOf({ kind: "server_action", missing: ["trigger"], elsewhere: [] }) === "LEGACY_ORPHAN" && cOf({ kind: "server_action", missing: ["trigger"], elsewhere: ["app/x.tsx"] }) === "UNKNOWN"
    && cOf({ kind: "http", missing: ["trigger"] }) === "UNKNOWN" && cOf({ kind: "cron", missing: ["trigger"] }) === "UNKNOWN")
  check("a consumer waiting on an event nothing emits is an EXECUTABLE_GAP (reads with no writer), not an orphan", cOf({ kind: "orchestrator_event", missing: ["trigger"], elsewhere: [] }) === "EXECUTABLE_GAP")
  check("SIMULATED_ONLY: only a provider-callback route whose ONE absent link is its trigger — NEGATIVE: the same route also missing evidence is not", cOf({ kind: "http", missing: ["trigger"], providerRoute: true }) === "SIMULATED_ONLY" && cOf({ kind: "http", missing: ["trigger", "evidence"], providerRoute: true }) === "UNKNOWN")
  {
    // RESTATED (wave 155, lane 155R16 — lane 155R6 request 2, CLAUDE.md §2 / lesson 7): `const e = KernelEvent.X` used by a later
    // audit-only door call now RIDES that call (true; it read null before — the shape the census could not see).
    const at = (s: string) => auditOnlyAt(s, [...s.matchAll(/KernelEvent\.X/g)].map((m) => m.index!), doorCallSpans(s, s, ["emitKernelEvent"], new Set()))
    check("POSITIVE: auditOnlyAt reads `auditOnly: true` inside the door call, and a const the later audit-only call uses — NEGATIVE: a fan-out sibling → false; a non-literal auditOnly → null; a site in no door call and no const → not an emission",
      at(`a(); emitKernelEvent({ event: KernelEvent.X, auditOnly: true }); b()`) === true && at(`const e = KernelEvent.X; emitKernelEvent({ event: e, auditOnly: true })`) === true
      && at(`emitKernelEvent({ event: KernelEvent.X }); emitKernelEvent({ event: KernelEvent.X, auditOnly: true })`) === false
      && at(`emitKernelEvent({ event: KernelEvent.X, auditOnly: flag })`) === null && at(`notify(KernelEvent.X)`) === undefined && at("") === undefined)
    const sfx = "app/actions/__os_sibling_fixture__.ts"
    const sv = views(sfx, [`"use server"`, `export async function viaUi() { await helperExport() }`, `export async function helperExport() { await svc.from("deals").update({}) }`, `export async function nobodyCalls() { await svc.from("deals").update({}) }`].join("\n"))!
    const sf = topLevelFns(sv); const imported = (n: string) => n === "viaUi"
    check("POSITIVE: an export only a sibling export calls has that sibling as its caller — NEGATIVE: an export nothing calls has none",
      siblingCaller(sf, sv, sf.find((x) => x.name === "helperExport")!, imported)?.name === "viaUi" && siblingCaller(sf, sv, sf.find((x) => x.name === "nobodyCalls")!, imported) === undefined)
    const dec = (t: string) => (t === "known_signal" ? "compliance_officer (consumer)" : null)
    check("POSITIVE: a reactor block that only publishes a resolvable signal links to it — NEGATIVE: a domain write, a send, a non-reactor consumer or an unresolvable signal keeps the gap",
      !!routingLink({ signals: ["known_signal"], writes: ["manager_signals"], egress: 0, outsideReactor: false, decisionOf: dec })
      && routingLink({ signals: ["known_signal"], writes: ["manager_signals", "deals"], egress: 0, outsideReactor: false, decisionOf: dec }) === null
      && routingLink({ signals: ["known_signal"], writes: ["manager_signals"], egress: 1, outsideReactor: false, decisionOf: dec }) === null
      && routingLink({ signals: ["known_signal"], writes: ["manager_signals"], egress: 0, outsideReactor: true, decisionOf: dec }) === null
      && routingLink({ signals: ["unknown_signal"], writes: ["manager_signals"], egress: 0, outsideReactor: false, decisionOf: dec }) === null
      && routingLink({ signals: [], writes: [], egress: 0, outsideReactor: false, decisionOf: dec }) === null)
    const sw = `switch (t) {\n  case "a":\n  case "b": {\n    doIt()\n  }\n  case "c":\n    other()\n}`
    const afterA = sw.indexOf(`case "a":`) + `case "a":`.length, afterC = sw.indexOf(`case "c":`) + `case "c":`.length
    check("POSITIVE: a fall-through case label's span runs through the shared body — NEGATIVE: a label with its own code ends at the next label",
      sw.slice(afterA, caseSpanEnd(sw, afterA)).includes("doIt(") && !sw.slice(afterA, caseSpanEnd(sw, afterA)).includes("other(") && sw.slice(afterC, caseSpanEnd(sw, afterC)).includes("other("))
    const sigF = (token: string) => { const f = emptyFacts(); f.writes.set("deals", `${FX}:5`); f.signature = { token, at: `${FX}:4` }; f.evidence.push({ token: "withActionLedger", at: `${FX}:5` }); return f }
    const httpRow = (token: string) => finish({ id: "planted:http", kind: "http", entry: `${FX}:3`, action: "POST /x", source_event: "x", trigger: "t", worker: "w", owner: "deal_coordinator", facts: sigF(token) })
    check("POSITIVE: an http route that VERIFIES a provider signature has the provider of record as decision — NEGATIVE: verifyCronAuth (the platform's own secret) or a bare secret read does not",
      !httpRow("validateTwilioSignature").missing.includes("decision") && httpRow("verifyCronAuth").missing.includes("decision") && httpRow("process.env.X_SECRET").missing.includes("decision"))
    check("POSITIVE: the gate vocabulary reads the tenant's own opt-in and the usage cap — NEGATIVE: the origin check and a rate limit are not decisions (and both gates still exist)",
      GATE_EXTRA_RE.test("resolveWidgetTenant(svc, {})") && GATE_EXTRA_RE.test("checkUsageCap({})") && !GATE_EXTRA_RE.test("widgetCallOriginAllowed(req)") && !GATE_EXTRA_RE.test("checkPublicRateLimit(req)")
      && /\bfunction resolveWidgetTenant\s*\(/.test(views("lib/widget/resolve-widget-tenant.ts")?.ids ?? "") && /\bfunction checkUsageCap\s*\(/.test(views("lib/usage/check-cap.ts")?.ids ?? ""))
    const fake = finish({ id: "planted:fake-manager", kind: "server_action", entry: `${FX}:3`, action: "x", source_event: "x", trigger: "t", worker: "w", owner: "invented_manager", facts: sigF("validateTwilioSignature") })
    check("POSITIVE CONTROL: an owner that is not in MANAGERS is never written onto a row (it reads unresolved and the row misses `owner`)", fake.registered_manager.startsWith("unresolved") && fake.missing.includes("owner"))
    // WAVE 155 (lane 155R7) — the per-call owner rules.
    const noRoute = () => null
    const tern = `{\n const toManager: ManagerKey | null =\n   params.entityType === "buyer" ? "shopping_agent" :\n   params.entityType === "seller" ? "listing_concierge" : null\n if (toManager) await publishManagerSignal({ fromManager: "data_steward", toManager, signalType: "x" })\n}`
    const assigned = `{\n let toManager: ManagerKey | null = null\n if (t === "seller") toManager = "listing_concierge"\n else if (t === "buyer") toManager = "shopping_agent"\n await publishManagerSignal({ toManager, signalType: "x" })\n}`
    const fromBody = `{\n let toManager: ManagerKey | null = null\n toManager = params.metadata.manager\n await publishManagerSignal({ toManager, signalType: "x" })\n}`
    const routed = `{\n const route = routeForEvent("ev_x", {})\n if (route?.to) await publishManagerSignal({ fromManager: route.from, toManager: route.to, signalType: "x" })\n}`
    const pcT = perCallToManager(tern, noRoute), pcA = perCallToManager(assigned, noRoute)
    check("POSITIVE: a reactor block whose toManager is a per-call ternary / assignment over literals names exactly those managers (comparison literals are not candidates) — and a routeForEvent binding takes the router's literal `to:` results",
      JSON.stringify(pcT?.candidates) === `["listing_concierge","shopping_agent"]` && JSON.stringify(pcA?.candidates) === `["listing_concierge","shopping_agent"]`
      && JSON.stringify(perCallToManager(routed, (e) => (e === "ev_x" ? ["listing_concierge", "campaign_orchestrator"] : null))?.candidates) === `["campaign_orchestrator","listing_concierge"]`)
    check("NEGATIVE: a toManager assigned from a body field, a routeForEvent the router does not resolve, or a block with no toManager resolves nothing — and a literal toManager stays the addressed rule's",
      perCallToManager(fromBody, noRoute) === null && perCallToManager(routed, noRoute) === null && perCallToManager(`{ await publishManagerSignal({ signalType: "x" }) }`, noRoute) === null
      && perCallToManager(`{ await publishManagerSignal({ toManager: "deal_coordinator", signalType: "x" }) }`, noRoute) === null)
    const fakeCand = perCallToManager(tern.replace(`"listing_concierge"`, `"invented_manager"`), noRoute)
    check("POSITIVE CONTROL: a per-call candidate that is not in MANAGERS is extracted but never credited (the census requires every candidate in MANAGERS)",
      !!fakeCand && fakeCand.candidates.includes("invented_manager") && !fakeCand.candidates.every((k) => MANAGER_KEYS.has(k)) && pcT!.candidates.every((k) => MANAGER_KEYS.has(k)))
    const rule = (o: Partial<Parameters<typeof toolPerCallRule>[0]>) => toolPerCallRule({ failsClosed: true, pathCallsResolver: false, viaDispatcher: false, dispatcherCallsResolver: false, kind: "skill", caseSuppliesOwner: false, ...o })
    check("POSITIVE: a per-call tool is owned when its handler calls voiceToolOwnerForCall, or reaches it through the dispatcher with its case supplying the fact — NEGATIVE: a handler that resolves nothing, a case that supplies nothing, or a resolver that does not fail closed is not",
      rule({ pathCallsResolver: true }) && rule({ viaDispatcher: true, dispatcherCallsResolver: true, caseSuppliesOwner: true }) && rule({ viaDispatcher: true, dispatcherCallsResolver: true, kind: "team_command" })
      && !rule({}) && !rule({ viaDispatcher: true, dispatcherCallsResolver: true }) && !rule({ viaDispatcher: true, caseSuppliesOwner: true }) && !rule({ pathCallsResolver: true, failsClosed: false }))
    const toolRegC = await import("../lib/voice/tool-registry"); const regC = await import("../lib/kernel/manager-registry")
    const own = (t: string, r: { manager?: string | null; formMode?: string | null }) => toolRegC.voiceToolOwnerForCall(t, r, regC.MANAGERS)
    check("POSITIVE CONTROL: the registry's per-call resolver returns a registered manager for THAT call and fails closed on an invented manager, an unknown form mode and an unlisted tool",
      own("run_skill", { manager: "ads_manager" }) === "ads_manager" && own("fill_form_field", { formMode: "listing" }) === "listing_concierge" && own("fill_form_field", { formMode: "offer" }) === "shopping_agent"
      && own("run_skill", { manager: "invented_manager" }) === null && own("fill_form_field", { formMode: "deed" }) === null && own("team_query", { manager: "ads_manager" }) === null && own("create_task", {}) === "deal_coordinator")
  }
  // the ratchet, against the real rows, then against planted defects (each must be caught)
  const p0Now = WRITE_BASELINE ? new Set((JSON.parse(rawOf(BASELINE_FILE)) as { p0ExecutableGaps?: string[] }).p0ExecutableGaps ?? []) : p0Frozen
  const rr = ratchet(realRows, p0Now, MANAGER_KEYS)
  check(`THE RATCHET holds on the real rows: no unclassified open row, no classified working row, no read-only row with an effect, no ungrouped executable gap, no invented manager, no NEW P0 executable gap (${realRows.filter(isP0Gap).length} P0 executable gaps, ${p0Now ? p0Now.size : "no"} frozen)`,
    rr.length === 0 && !!p0Now, (p0Now ? "" : "no p0ExecutableGaps in the baseline — run --write-baseline once; ") + rr.slice(0, 10).join("\n      ") + (rr.length > 10 ? `\n      … ${rr.length - 10} more` : ""))
  {
    const base = realRows.find((r) => r.classification === "EXECUTABLE_GAP" && r.risk_class === "P0") ?? realRows.find((r) => r.state !== "working")!
    const planted: Array<[string, Row, string]> = [
      ["a read-only row whose path writes", { ...base, id: "planted:ro-write", classification: "DECLARATIVE_READ_ONLY", path_effects: { writes: ["contacts"], egress: [], spend: null } }, "DECLARATIVE_READ_ONLY but its path writes"],
      ["a read-only row whose path sends", { ...base, id: "planted:ro-send", classification: "DECLARATIVE_READ_ONLY", path_effects: { writes: [], egress: ["dispatchSms"], spend: null } }, "DECLARATIVE_READ_ONLY but its path writes"],
      ["an UNKNOWN counted as working", { ...base, id: "planted:unknown-working", state: "working", missing: [], classification: "UNKNOWN" }, "WORKING row carries classification"],
      ["a new P0 executable gap", { ...base, id: "planted:new-p0", classification: "EXECUTABLE_GAP", risk_class: "P0", root_cause_group: "G12-session-write-unledgered-P0" }, "NEW P0 executable gap"],
      ["an invented manager", { ...base, id: "planted:fake-owner", registered_manager: "invented_manager" }, "is not a manager in MANAGERS"],
      ["an ungrouped executable gap", { ...base, id: "planted:ungrouped", classification: "EXECUTABLE_GAP", root_cause_group: null }, "no root-cause group"],
    ]
    for (const [label, row, needle] of planted) check(`POSITIVE CONTROL: the ratchet catches ${label}`, ratchet([row], p0Now ?? new Set(), MANAGER_KEYS).some((x) => x.includes(needle)))
  }

  section("G — THE ANALYZER TELLS THE TRUTH IN BOTH DIRECTIONS (wave 155, lane 155R16): each change has a positive and a negative control")
  {
    // G1 — the log rule (G08b): one predicate for ownership AND evidence
    check("G1 POSITIVE: a log by name is a log even when rewritten (agent_action_ledger); an append-only record-suffixed table is a log — NEGATIVE: a REWRITTEN record-suffixed table (calendar_events) and a plain domain table are not",
      logTableRule("agent_action_ledger", true) && logTableRule("compliance_events", false) && !logTableRule("calendar_events", true) && !logTableRule("deals", false))
    const rv = views("app/actions/__os_coverage_rewrite__.ts", [
      `// TOMBSTONE: svc.from("compliance_events").update({}) used to stand here — a comment is not a rewrite`,
      `const specimen = "svc.from('mission_events').update({})"`,
      `await svc.from("calendar_events").update({ status: "cancelled" }).eq("id", id)`,
      `await svc.from("voice_calls").upsert({ id })`, `await svc.from("usage_events").insert({})`].join("\n"))!
    const rw = rewrittenIn(rv)
    check("G1 POSITIVE: rewrittenIn sees a real `.update(` / `.upsert(` — NEGATIVE: a tombstone, a string specimen and an insert are not rewrites",
      rw.includes("calendar_events") && rw.includes("voice_calls") && !rw.includes("compliance_events") && !rw.includes("mission_events") && !rw.includes("usage_events"), JSON.stringify(rw))
    check("G1 POSITIVE CONTROL (the finder still sees its defect in the tree): some record-suffixed table that TABLE_MANAGER stewards is rewritten by runtime code",
      [...rewrittenTables()].some((t) => EVIDENCE_TABLE_RE.test(t) && !TRUE_LOG_RE.test(t) && !!TABLE_MANAGER[t]))
    const rewrittenStewarded = [...rewrittenTables()].find((t) => EVIDENCE_TABLE_RE.test(t) && !TRUE_LOG_RE.test(t) && !!TABLE_MANAGER[t])!
    const appendOnly = Object.keys(TABLE_MANAGER).find((t) => EVIDENCE_TABLE_RE.test(t) && !TRUE_LOG_RE.test(t) && !rewrittenTables().has(t))!
    const one = (t: string) => { const f = emptyFacts(); f.writes.set(t, `${FX}:5`); for (const [x, at] of f.writes) if (isLogTable(x)) f.evidence.push({ token: `row:${x}`, at }); return finish({ id: `planted:g1:${t}`, kind: "server_action", entry: `${FX}:3`, action: "x", source_event: "x", trigger: "t", worker: "w", owner: ownerFromWrites(f).owner, facts: f }) }
    const dom = one(rewrittenStewarded), log = one(appendOnly)
    check(`G1 POSITIVE: a planted write to a rewritten stewarded table (${rewrittenStewarded}) resolves its owner from TABLE_MANAGER and earns NO evidence — NEGATIVE: a planted append-only write (${appendOnly}) earns evidence and NO owner`,
      dom.registered_manager === TABLE_MANAGER[rewrittenStewarded] && dom.missing.includes("evidence") && log.ledger_evidence.startsWith(`row:${appendOnly}`) && log.missing.includes("owner"), JSON.stringify([dom.registered_manager, dom.missing, log.ledger_evidence, log.missing]))
    check("G1 TRIPWIRE: no real row lands in G08b (the owner rule and the log rule agree)", !realRows.some((r) => r.root_cause_group === "G08b-stewarded-table-read-as-log"))

    // G2..G5 — planted multi-file specimens (views + edges injected, removed after)
    const files: Record<string, string> = {
      "lib/__os_coverage_lib__.ts": [`export const LIMIT = 80`, `export const RULES = Object.freeze({ a: 1, b: [2, 3] })`, `export interface Shape { a: number }`, `export type Alias = { b: string }`,
        `export const makeClient = createThing()`, `export async function writer() { await svc.from("deals").update({}) }`, `export async function readsOnly() { return svc.from("deals").select("id") }`].join("\n"),
      "lib/__os_coverage_barrel__.ts": `export { writer } from "./__os_coverage_lib__"`,
      "app/actions/__os_coverage_walk__.ts": [`"use server"`, `import { LIMIT, RULES, Shape, writer } from "@/lib/__os_coverage_lib__"`, `import { writer as viaBarrel } from "@/lib/__os_coverage_barrel__"`,
        `import { dispatchKernelEvent } from "@/lib/kernel/event-reactor"`,
        `import { processKernelEvent } from "@/lib/kernel/notification-engine"`, `import { processKernelEvent as viaKernelIndex } from "@/lib/kernel"`,
        `const deps = { ledger: async () => withActionLedger({ action: "a.b.c" }, async () => 1), read: async () => 1 }`,
        `export async function readsConst(x: Shape): Promise<number> { return LIMIT + RULES.a }`,
        `export async function inlineType(): Promise<import("@/lib/__os_coverage_lib__").Shape | null> { return null }`,
        `export async function callsWriter() { await writer() }`, `export async function callsViaBarrel() { await viaBarrel() }`,
        `export async function usesDepsRead() { const d = { ...deps }; return d.read() }`, `export async function usesDepsLedger() { const d = { ...deps }; return d.ledger() }`,
        `export async function emitsOnly() { await svc.from("deals").update({}); await dispatchKernelEvent({ event: "x" }) }`,
        `export async function emitsAndLedgers() { await withActionLedger({ action: "a.b.c" }, async () => svc.from("deals").update({})); await dispatchKernelEvent({ event: "x" }) }`,
        `export async function promiseAllReads() { const [{ readsOnly }, { LIMIT: lim }] = await Promise.all([import("@/lib/__os_coverage_lib__"), import("@/lib/__os_coverage_lib__")]); return [await readsOnly(), lim] }`,
        `export async function promiseAllWrites() { const [{ writer: w2 }] = await Promise.all([import("@/lib/__os_coverage_lib__")]); await w2() }`,
        `export async function fansOutOnly() { await svc.from("deals").update({}); await processKernelEvent({ event: "x" }) }`,
        `export async function fansOutViaIndex() { await svc.from("deals").update({}); await viaKernelIndex({ event: "x" }) }`,
        `export async function fansOutAndLedgers() { await withActionLedger({ action: "a.b.c" }, async () => svc.from("deals").update({})); await processKernelEvent({ event: "x" }) }`].join("\n"),
    }
    for (const f of Object.keys(files)) FILE_SET.add(f)
    for (const [f, raw] of Object.entries(files)) { viewCache.set(f, views(f, raw)); edgeCache.set(f, parseEdges(f, blankComments(raw))); fnsCache.delete(f) }
    try {
      const W = "app/actions/__os_coverage_walk__.ts"; const wv = views(W)!; const wf = fnsOf(W)
      const ef = (n: string) => exportFacts(W, wv, wf, wf.find((x) => x.name === n)!)
      // G3 — the walk: a type / a data constant / an inline type is not a call; a re-export and a called deps member are followed
      check("G3 bindingKind: interface / type alias → type; a literal, an array, a frozen object, an enum → data — NEGATIVE: an arrow, a method object, a call result → unknown",
        bindingKind(blankStrings(files["lib/__os_coverage_lib__.ts"]), "Shape") === "type" && bindingKind(blankStrings(files["lib/__os_coverage_lib__.ts"]), "Alias") === "type"
        && bindingKind("export const LIMIT = 80", "LIMIT") === "data" && bindingKind("export const R = Object.freeze({ a: [1, 2] })", "R") === "data" && bindingKind("export enum E { A }", "E") === "data"
        && bindingKind("export const f = async () => 1", "f") === "unknown" && bindingKind("export const o = { run() { return 1 } }", "o") === "unknown" && bindingKind("export const c = createThing()", "c") === "unknown")
      check("G3 POSITIVE: an export that reads an imported CONSTANT and names an imported INTERFACE (no `type` keyword), or names an inline `import(\"x\").T` type, writes NOTHING — NEGATIVE: an export that CALLS the module's writer writes its table",
        ef("readsConst").writes.size === 0 && ef("inlineType").writes.size === 0 && ef("callsWriter").writes.has("deals"), JSON.stringify([[...ef("readsConst").writes.keys()], [...ef("inlineType").writes.keys()]]))
      check("G3 POSITIVE (newly FOUND): a function reached through a BARREL re-export is followed to its module (it read as the barrel's empty file before)", ef("callsViaBarrel").writes.has("deals"))
      check("G3 POSITIVE: a called member of a same-file deps object (d.ledger) carries its receipt — NEGATIVE: an export that calls only d.read() inherits no receipt",
        ef("usesDepsLedger").evidence.some((e) => /withActionLedger/.test(e.token)) && !ef("usesDepsRead").evidence.length, JSON.stringify([ef("usesDepsLedger").evidence.map((e) => e.token), ef("usesDepsRead").evidence.map((e) => e.token)]))
      check("G3 inline type: `Promise<import(\"x\").T>` and `typeof import(\"x\")` are not edges — NEGATIVE: `await import(\"x\")` and `(await import(\"x\")).m` still are",
        !parseEdges(W, `type A = Promise<import("@/lib/kernel/events").KernelEvent>`).length && !parseEdges(W, `type B = typeof import("@/lib/kernel/events")`).length
        && parseEdges(W, `const m = await import("@/lib/kernel/events")`).length === 1 && parseEdges(W, `const k = (await import("@/lib/kernel/events")).KernelEvent`).length === 1)
      // G3b — a Promise.all of dynamic imports binds names, not whole modules (lane 155R21's finding)
      check("G3b POSITIVE: `const [{ readsOnly }] = await Promise.all([import(\"m\")])` that calls only the module's READER writes NOTHING — NEGATIVE: the same shape binding and calling the module's WRITER writes its table",
        ef("promiseAllReads").writes.size === 0 && ef("promiseAllWrites").writes.has("deals"), JSON.stringify([[...ef("promiseAllReads").writes.keys()], [...ef("promiseAllWrites").writes.keys()]]))
      check("G3b parse: each brace pattern is bound to the import at ITS position, and the bare fallback adds no whole-module edge for them",
        (() => { const e = parseEdges(W, `const [{ a }, { b: c }] = await Promise.all([import("@/lib/__os_coverage_lib__"), import("@/lib/__os_coverage_barrel__")])`); return e.length === 2 && e[0].pairs.length === 1 && e[0].pairs[0].name === "a" && e[1].pairs[0].name === "b" && e[1].pairs[0].local === "c" && !e.some((x) => x.pairs.some((q) => q.name === "*")) })())
      check("G3b NEGATIVE: an element that is not a plain import (a call, a spread) is left to the whole-module fallback — the over-report stays",
        parseEdges(W, `const [x] = await Promise.all([load(import("@/lib/__os_coverage_lib__"))])`).some((x) => x.pairs.some((q) => q.name === "*")))
      // G2 — a receipt beyond the emit door is the reactor's
      const reactorOwn = memberFacts("lib/kernel/event-reactor.ts", "dispatchKernelEvent", 1)
      check("G2 PRECONDITION (else the next control proves nothing): the reactor's own walk still carries a ledger receipt", reactorOwn.evidence.length > 0)
      check("G2 POSITIVE: a caller whose only receipt is beyond dispatchKernelEvent has NO evidence (its own write stays) — NEGATIVE: the same caller with its own withActionLedger keeps it",
        ef("emitsOnly").writes.has("deals") && !ef("emitsOnly").evidence.length && ef("emitsAndLedgers").evidence.some((e) => /withActionLedger/.test(e.token)), JSON.stringify(ef("emitsOnly").evidence))
      check("G2 (lane 155R17 request 2) PRECONDITION: the reactor's own walk carries a gate — POSITIVE: a caller borrows NO gate from beyond the emit door",
        reactorOwn.gates.length > 0 && !ef("emitsOnly").gates.length, JSON.stringify(ef("emitsOnly").gates.map((g) => g.token)))
      // G2b — the typed-event fan-out is the same kind of door (lane 155R20 request R1)
      const fanoutOwn = memberFacts("lib/kernel/notification-engine.ts", "processKernelEvent", 1)
      check("G2b PRECONDITION (else the next controls prove nothing): the fan-out's own walk carries a gate AND a ledger receipt", fanoutOwn.gates.length > 0 && fanoutOwn.evidence.length > 0, JSON.stringify([fanoutOwn.gates.map((g) => g.token), fanoutOwn.evidence.map((e) => e.token)]))
      check("G2b POSITIVE: a caller whose only gate and receipt are beyond processKernelEvent has NO decision and NO evidence (its own write stays) — directly and through the lib/kernel barrel",
        ef("fansOutOnly").writes.has("deals") && !ef("fansOutOnly").evidence.length && !ef("fansOutOnly").gates.length && !ef("fansOutViaIndex").evidence.length && !ef("fansOutViaIndex").gates.length,
        JSON.stringify([ef("fansOutOnly").evidence.map((e) => e.token), ef("fansOutOnly").gates.map((g) => g.token), ef("fansOutViaIndex").evidence.map((e) => e.token), ef("fansOutViaIndex").gates.map((g) => g.token)]))
      check("G2b NEGATIVE: the same caller with its OWN withActionLedger keeps its own receipt", ef("fansOutAndLedgers").evidence.some((e) => /withActionLedger/.test(e.token)))
    } finally {
      for (const f of Object.keys(files)) { FILE_SET.delete(f); viewCache.delete(f); edgeCache.delete(f); fnsCache.delete(f); fileFactsCache.delete(f) }
      memberMemo.clear()
    }

    // G4 — UNKNOWN derived from code
    const own = "app/actions/__os_coverage_owner__.ts"
    const ev = (spec: string): Edge[] => [{ target: "lib/__other__.ts", at: 0, pairs: [{ name: "addLender", local: spec }] }]
    const vv = (s: string) => views("lib/__x__.ts", s)!
    check("G4 POSITIVE: a same-named DECLARATION and a re-export / import of the name from ANOTHER module are not references to the export — NEGATIVE: a bare use (no binding of its own) still is",
      bindsElsewhere("lib/__x__.ts", vv("export async function addLender() {}"), "addLender", own, []) && bindsElsewhere("lib/__x__.ts", vv("export { addLender } from './other'"), "addLender", own, ev(""))
      && bindsElsewhere("lib/__x__.ts", vv("import { addLender } from './other'\naddLender()"), "addLender", own, ev("addLender"))
      && !bindsElsewhere("lib/__x__.ts", vv("const m = { fn: addLender }"), "addLender", own, []))
    check("G4 POSITIVE: a \"use server\" route file's POST is not a server-action row (it is the http row) — NEGATIVE: a non-method export of the same file still is",
      !c.rows.some((r) => r.id === `server_action:${FX_ROUTE}#POST`) && c.rows.some((r) => r.id === `server_action:${FX_ROUTE}#plantedRouteHelper`))

    // G5 — decision doors, each with a route that lacks the check staying red
    const bearer = `const expected = process.env.INTERNAL_API_SECRET\nconst h = req.headers.get("authorization")\nif (!expected || h !== \`Bearer \${expected}\`) {\n  return new Response(null, { status: 401 })\n}`
    const cronOk = `const denied = verifyCronAuth(req)\nif (denied) return denied`
    const failOpen = `if (process.env.CRON_SECRET && req.headers.get("authorization") !== \`Bearer \${process.env.CRON_SECRET}\`) return new Response(null, { status: 401 })`
    const equality = `const s = process.env.X_SECRET\nif (!s || s === "placeholder") return null`
    const readOnly = `const s = process.env.X_SECRET\nconsole.log(Boolean(s))`
    check("G5 POSITIVE: a fail-closed bearer comparison and `verifyCronAuth` + early return are internal-caller doors — NEGATIVE: a fail-OPEN check (the shape lane 86G removed), an equality test and a bare secret read are not",
      !!internalSecretAt(blankStrings(bearer)) && !!internalSecretAt(blankStrings(cronOk)) && !internalSecretAt(blankStrings(failOpen)) && !internalSecretAt(blankStrings(equality)) && !internalSecretAt(blankStrings(readOnly)))
    const httpRow = (internalAt: string | null) => { const f = emptyFacts(); f.writes.set("deals", `${FX}:5`); f.evidence.push({ token: "withActionLedger", at: `${FX}:5` }); if (internalAt) f.internal = { token: "fail-closed shared secret X_SECRET", at: internalAt }; return finish({ id: "planted:g5", kind: "http", entry: `${FX}:3`, action: "POST /x", source_event: "x", trigger: "t", worker: "w", owner: "deal_coordinator", facts: f }) }
    check("G5 POSITIVE: an http route whose OWN file refuses without the secret is decided by the internal caller — NEGATIVE: the same route with the check only in another module, or with no check, stays red (missing decision)",
      !httpRow(`${FX}:4`).missing.includes("decision") && httpRow("lib/elsewhere.ts:9").missing.includes("decision") && httpRow(null).missing.includes("decision"))
    const grant = `const { data: row } = await svc.from("buyer_intake_tokens").select("*").eq("token", body.token).maybeSingle()\nif (!row) return NextResponse.json({}, { status: 404 })\nif (new Date(row.expires_at) < new Date()) return NextResponse.json({}, { status: 410 })\nawait svc.from("contacts").update({}).eq("id", row.contact_id)`
    const gf = (s: string) => { const v = views("app/api/__os_coverage_grant__/route.ts", s)!; return factsOfSpan("app/api/__os_coverage_grant__/route.ts", v, 0, v.ids.length).gates.some((g) => g.token.includes("verified grant token")) }
    check("G5 POSITIVE: a public form that looks up its grant by token, refuses when absent and compares the expiry has a decision — NEGATIVE: no expiry, no refusal, or no token lookup and it has none",
      gf(grant) && !gf(grant.replace(/\nif \(new Date[^\n]*/, "")) && !gf(grant.replace(/\nif \(!row\)[^\n]*/, "")) && !gf(grant.replace(`.eq("token", body.token)`, `.eq("id", body.id)`)))
    const sv = views("app/api/__os_coverage_sig__/route.ts", `const secret = process.env.RELAY_SHARED_SECRET\nconst given = url.searchParams.get("token") ?? ""\nif (!secret || !timingSafeEqual(Buffer.from(secret), Buffer.from(given))) return new Response(null, { status: 404 })`)!
    check("G5 POSITIVE: a verifying call is the signature even when a bare secret read precedes it — NEGATIVE: a path with only the read keeps the read (never a decision on http)",
      factsOfSpan("app/api/__os_coverage_sig__/route.ts", sv, 0, sv.ids.length).signature?.token === "timingSafeEqual" && factsOfSpan("x.ts", views("x.ts", readOnly)!, 0, readOnly.length).signature?.token.startsWith("process.env") === true)

    // G6 — kernel-event consumer shapes, audit-only riding, and the derived lib/events doors (lane 155R6 requests 1 + 2)
    const reactor = (s: string) => [{ file: "lib/kernel/event-reactor.ts", ids: blankStrings(s) }]
    const arr = reactorConsumerShapes(reactor(`const SOME_EVENTS: string[] = [KernelEvent.FOO]\nif (params.brokerageId && SOME_EVENTS.includes(params.event)) {\n  work()\n}`), "")
    const awardRules = blankStrings(`export const LIFECYCLE_AWARD_RULES: readonly R[] = [\n  { event: KernelEvent.BAR, reason: "X" },\n]`)
    const aw = reactorConsumerShapes(reactor(`if (isKnownEvent) {\n  await awardLifecycleMilestones(svc, {})\n}`), awardRules)
    check("G6 POSITIVE: a reactor array tested with .includes(params.event) and an award rule while the reactor calls awardLifecycleMilestones are consumers — NEGATIVE: an array never tested, or award rules with no reactor call, are not",
      arr.some((s) => s.key === "FOO" && s.shape === "array") && aw.some((s) => s.key === "BAR" && s.shape === "award")
      && !reactorConsumerShapes(reactor(`const SOME_EVENTS: string[] = [KernelEvent.FOO]\nwork()`), "").length && !reactorConsumerShapes(reactor(`work()`), awardRules).length)
    const scr = `async function scrapeEvent(svc, row) {\n  return svc.from("lifecycle_events").insert(row)\n}\nawait scrapeEvent(svc, { event_type: KernelEvent.X })`
    const fan = `async function echo(svc, ev) {\n  await emitKernelEvent({ event: ev })\n}\nawait echo(svc, { event_type: KernelEvent.X })`
    const ride = (s: string) => { const ids = blankStrings(s), code = blankComments(s); const w = localWrappers(ids, code, ["emitKernelEvent"], new Set()); return auditOnlyAt(ids, [...ids.matchAll(/KernelEvent\.X/g)].map((m) => m.index!), doorCallSpans(ids, code, ["emitKernelEvent", ...w.doors], w.audit)) }
    check("G6 POSITIVE: a site riding a same-file wrapper that only INSERTS lifecycle_events is a record (audit-only) — NEGATIVE: a wrapper that emits without auditOnly fans out; a lifecycle_events insert written inside a STRING is no door",
      ride(scr) === true && ride(fan) === false && !directAuditInserts({ ids: blankStrings(`const s = "svc.from('lifecycle_events').insert(row)"`) }, `const s = "svc.from('lifecycle_events').insert(row)"`).length)
    const helperCode = `export async function notifyComingSoon(svc, p) {\n  await publishManagerSignal({ fromManager: "data_steward", toManager: "listing_concierge", signalType: "coming_soon_sent" })\n}`
    const hr = helperRouteRule({ called: ["notifyComingSoon"], writes: ["manager_signals"], egress: 0, code: helperCode })
    check("G6 (lane 155R17 request 3) POSITIVE: a block whose one imported helper only publishes a signal takes that helper's signalType / toManager — NEGATIVE: a helper that also writes a domain table, sends, or a block calling two helpers takes nothing",
      JSON.stringify(hr) === `{"signals":["coming_soon_sent"],"toManager":"listing_concierge"}` && helperRouteRule({ called: ["h"], writes: ["manager_signals", "listings"], egress: 0, code: helperCode }) === null
      && helperRouteRule({ called: ["h"], writes: ["manager_signals"], egress: 1, code: helperCode }) === null && helperRouteRule({ called: ["a", "b"], writes: ["manager_signals"], egress: 0, code: helperCode }) === null)
    // G7 — a read through an embed is a read (lanes 155R15 / 155R17)
    const emb = (s: string) => embeddedReads(blankStrings(s), blankComments(s)).map((x) => x.table)
    const T = `const SEL = \`\n  id, name,\n  lead_scraping_property_params (id, min_price),\n  owner:users!agent_id(id)\n\`\nawait svc.from("lead_scraping_markets").select(SEL)\nawait svc.from("marketing_campaigns").select("id, comments:marketing_campaign_comments(id, body)")`
    const C = `// await svc.from("x").select("id, ghost_child_table(id)")\nconst s = "svc.from('x').select('id, string_child_table(id)')"\nawait svc.from("deals").select("id, count")`
    check("G7 POSITIVE: an embed in a `.select(\"…\")` literal and in a same-file template constant passed to `.select(X)` (alias: and !fk forms) is a read of the child — NEGATIVE: an embed in a comment, inside a string that is not a select argument, or a plain column list is not",
      ["lead_scraping_property_params", "users", "marketing_campaign_comments"].every((t) => emb(T).includes(t)) && !emb(C).length, JSON.stringify([emb(T), emb(C)]))
    check("G7 POSITIVE CONTROL (the finder still sees its defect in the tree): some live table is read ONLY through an embed somewhere — the index now counts it",
      [...READERS.keys()].some((t) => LIVE.has(t)) && FILES.some((f) => { const v = views(f); return !!v && v.ids.includes(".select(") && embeddedReads(v.ids, codeOf(f)).some((e) => LIVE.has(e.table)) }))
    const core = views("lib/events/lifecycle-event-core.ts")
    const coreFans = !!core && /export\s+async\s+function\s+recordLifecycleEvent\b/.test(core.ids) && /\bemitKernelEvent\b/.test(core.ids)
    check("G6 POSITIVE CONTROL: where lib/events/lifecycle-event-core.ts recordLifecycleEvent hands events to emitKernelEvent, it is a derived kernel emit door (and so is its wrapper logEventAndTrigger)",
      !coreFans || (!!c.emitDoors?.includes("recordLifecycleEvent") && !!c.emitDoors?.includes("logEventAndTrigger")), JSON.stringify(c.emitDoors?.filter((d) => /Lifecycle|logEvent/.test(d))))

    // G8 — lane 155R18's requests folded in (A1 audited-read owner, A2 decidePublicDoor, F1 headers() is not a session)
    const fx8 = (writes: string[], reads: string[] = []) => { const f = emptyFacts(); for (const t of writes) f.writes.set(t, `${FX}:5`); for (const t of reads) f.reads.add(t); return f }
    const stewardedRead = Object.keys(TABLE_MANAGER).find((t) => !ACTOR_IDENTITY_READS.has(t) && !CARRIER_TABLES.has(t) && !isLogTable(t))!
    const stewardedLog = Object.keys(TABLE_MANAGER).find((t) => isLogTable(t) && !GENERIC_TELEMETRY.has(t) && !CARRIER_TABLES.has(t))!
    check(`G8 A1 POSITIVE: a path writing only telemetry is owned by the steward of what its OWN span reads (${stewardedRead}); one writing a stewarded log (${stewardedLog}) by that log's steward — NEGATIVE: a domain write, identity-only reads, compliance_events (generic: the gate's) and a tie resolve nothing here`,
      ownerOfAuditedRead(fx8([], [stewardedRead]), fx8(["self_heal_events"]))?.owner === TABLE_MANAGER[stewardedRead]
      && ownerOfAuditedRead(fx8([]), fx8([stewardedLog]))?.owner === TABLE_MANAGER[stewardedLog]
      && ownerOfAuditedRead(fx8([], [stewardedRead]), fx8(["deals"])) === null
      && ownerOfAuditedRead(fx8([], ["users", "agents"]), fx8(["audit_log"])) === null
      && ownerOfAuditedRead(fx8([]), fx8(["compliance_events", "notifications"])) === null)
    check("G8 A2 POSITIVE: decidePublicDoor( is a decision — NEGATIVE: a door that calls only checkPublicRateLimit( stays undecided",
      GATE_EXTRA_RE.test("const door = await decidePublicDoor(req, svc, { slug })") && !GATE_EXTRA_RE.test("const limited = await checkPublicRateLimit(req)"))
    const sess = (s: string) => { const v = views("app/api/__os_coverage_sess__/route.ts", s)!; return factsOfSpan("app/api/__os_coverage_sess__/route.ts", v, 0, v.ids.length).session }
    check("G8 F1 POSITIVE: a door whose only session-shaped token is headers() (publicCallerIp) has NO session — NEGATIVE: auth.getUser still is one",
      sess(`export async function publicCallerIp() { const h = await headers(); return h.get("x-forwarded-for") }`) === null && sess(`const { data } = await supabase.auth.getUser()`)?.token === "auth.getUser")

    // G9 — lane 155R22: THE WORKER HOP (ownerOfDelegatedRead / delegatedWorkers). Each control can fail: the planted fixture rows
    // come from the SAME census run as the real rows (section C), tables chosen from TABLE_MANAGER at run time.
    const hop = (n: string) => c.rows.find((r) => r.id === `server_action:${FX_HOP}#${n}`)
    check(`G9 POSITIVE: a log-only action whose WORKER reads a stewarded table (${hopA}) is owned by that table's steward (${TABLE_MANAGER[hopA]}) — the gate it also calls adds nothing`,
      hop("plantedWorkerRead")?.registered_manager === TABLE_MANAGER[hopA], hop("plantedWorkerRead")?.registered_manager)
    check("G9 NEGATIVE: the same action whose only stewarded read is inside its GATE helper (named requireSeat) is owned by NOBODY",
      !!hop("plantedGateOnlyRead") && hop("plantedGateOnlyRead")!.missing.includes("owner"), hop("plantedGateOnlyRead")?.registered_manager)
    check("G9 NEGATIVE (structural): a helper whose own body resolves the signed-in identity (getAgentContext) is a gate whatever its name (loadScope) — owned by NOBODY",
      !!hop("plantedStructuralGateRead") && hop("plantedStructuralGateRead")!.missing.includes("owner"), hop("plantedStructuralGateRead")?.registered_manager)
    check(`G9 NEGATIVE: two workers reading two stewards' tables (${hopA} → ${TABLE_MANAGER[hopA]}, ${hopB} → ${TABLE_MANAGER[hopB]}) resolve NOTHING`,
      !!hop("plantedTwoWorkers") && hop("plantedTwoWorkers")!.missing.includes("owner"), hop("plantedTwoWorkers")?.registered_manager)
    check("G9 LOCATION: a helper that lives in an authorization module is a gate whatever it is named — portal-auth, lib/auth/**, lib/security/**, require-*.ts; NEGATIVE: a domain module, an OAuth client and a file that merely mentions auth are not",
      ["lib/kernel/portal-auth.ts", "lib/auth/lead-visibility.ts", "lib/security/rbac.ts", "lib/portal/require-contact-access.ts", "lib/x/session-auth.ts"].every(isAuthorizationModule)
      && !["lib/kernel/financial.ts", "lib/connections/google-oauth.ts", "lib/kernel/authority-ledger.ts", "lib/authors/list.ts", "app/actions/superadmin/ai-ops.ts"].some(isAuthorizationModule))
    {
      const ext = realRows.find((r) => r.id === "http:/api/external-portal/actions/complete")
      check("G9 LOCATION (the row that showed it): the external-portal completion route is NOT owned through the lane check it calls in lib/kernel/portal-auth.ts (unresolved, or the transaction's steward — never vendor_assignments' steward by that hop)",
        !!ext && !/externalPartnerTransactionLane|resolveExternalPartnerIdentity/.test(String(ext.decision_owner ?? "") + String(ext.classification_evidence ?? "") + String(ext.registered_manager ?? "")) && (ext.missing.includes("owner") || ext.registered_manager === TABLE_MANAGER.transactions), `${ext?.registered_manager} · ${ext?.missing}`)
    }
    const w9 = (reads: string[]): DelegatedWorker => ({ name: "w", at: `${FX}:1`, reads })
    check("G9 PURE: the rule applies only where the own span read no stewarded table and every write is a carrier / generic log — NEGATIVE: an own-span stewarded read, a domain write, a stewarded log written, identity-only worker reads and a worker with two stewards resolve nothing",
      ownerOfDelegatedRead(fx8([]), fx8(["audit_log"]), [w9([hopA, "users"])])?.owner === TABLE_MANAGER[hopA]
      && ownerOfDelegatedRead(fx8([], [hopA]), fx8(["audit_log"]), [w9([hopA])]) === null
      && ownerOfDelegatedRead(fx8([]), fx8([hopA]), [w9([hopA])]) === null
      && ownerOfDelegatedRead(fx8([]), fx8([stewardedLog]), [w9([hopA])]) === null
      && ownerOfDelegatedRead(fx8([]), fx8(["audit_log"]), [w9(["users", "agents", "teams"])]) === null
      && ownerOfDelegatedRead(fx8([]), fx8(["audit_log"]), [w9([hopA, hopB])]) === null)
    check("G9 PURE: gate / identity / ledger helpers are not workers (getFinancialActorContext, gateStaffAction, requireCallerTenant, withActionLedger, evaluateOutbound, auditStaffAction, emitKernelEvent, platformStaffCan) — NEGATIVE: real workers are (exportFinancialReport, loadOnboardingRoster, runGoLiveReadiness)",
      ["getFinancialActorContext", "gateStaffAction", "requireCallerTenant", "withActionLedger", "evaluateOutbound", "auditStaffAction", "emitKernelEvent", "platformStaffCan"].every(isNotAWorker)
      && !["exportFinancialReport", "loadOnboardingRoster", "runGoLiveReadiness"].some(isNotAWorker))
    check("G9 PURE: a span that resolves the identity or asks an authority / policy gate acts as a gate — NEGATIVE: a span that only uses the cookie client does not",
      actsAsGate({ ...emptyFacts(), session: { token: "getAgentContext", at: `${FX}:1` } }) && actsAsGate({ ...emptyFacts(), gates: [{ token: "policy:autonomyGate", at: `${FX}:1` }] })
      && !actsAsGate({ ...emptyFacts(), session: { token: 'createClient() from "@/lib/supabase/server"', at: `${FX}:1` } }) && !actsAsGate({ ...emptyFacts(), gates: [{ token: "resource/spend:meterVendorSpend", at: `${FX}:1` }] }))

    // G10 — lane 155R22: THE EVENT-CLAIMS LEDGER (scripts/event-claims-ledger.ts, one copy read by test:event-claims and here)
    const kev = (heldWhy: string | undefined) => finish({ id: "planted:kernel_event", kind: "kernel_event", entry: "lib/kernel/events.ts", action: "kernel.planted", source_event: "KernelEvent.PLANTED", trigger: "emitted by lib/x.ts", worker: null, owner: null, facts: emptyFacts(), actorHint: "kernel event bus", auditOnlyEmits: false, heldWhy })
    const q10 = "record or consumer? a planted question"
    const held10 = kev(eventLedgerHold("planted_event", { worker: false, emitted: true, auditOnlyEmits: false }, { planted_event: q10 }))
    const neither10 = kev(eventLedgerHold("planted_event", { worker: false, emitted: true, auditOnlyEmits: false }, {}))
    check("G10 POSITIVE: a fan-out event with no consumer that the ledger HOLDS is OWNER_HELD carrying the ledger's question VERBATIM — NEGATIVE: the same event in NEITHER list stays an EXECUTABLE_GAP in G01",
      held10.state === "owner-held" && held10.classification === "OWNER_HELD" && held10.why.includes(q10) && held10.classification_evidence.includes(q10)
      && neither10.classification === "EXECUTABLE_GAP" && neither10.root_cause_group === "G01-event-no-consumer", JSON.stringify([held10.classification, neither10.classification, neither10.root_cause_group]))
    check("G10 NEGATIVE: a held event that HAS a consumer, has no emitter, or is proven audit-only is NOT held (the ledger never hides a row of another shape)",
      eventLedgerHold("planted_event", { worker: true, emitted: true, auditOnlyEmits: undefined }, { planted_event: q10 }) === undefined
      && eventLedgerHold("planted_event", { worker: false, emitted: false, auditOnlyEmits: undefined }, { planted_event: q10 }) === undefined
      && eventLedgerHold("planted_event", { worker: false, emitted: true, auditOnlyEmits: true }, { planted_event: q10 }) === undefined)
    const rowOf = (id: string) => realRows.find((r) => r.id === id)
    check("G10 POSITIVE CONTROL: a ledger key whose event no longer exists is STALE (a stale list cannot hold a row)", staleEventHolds({ __os_coverage_no_such_event__: q10 }, rowOf).length === 1)
    const staleHolds = staleEventHolds(EVENT_OWNER_HELD, rowOf)
    check(`G10 every EVENT_OWNER_HELD entry holds a real kernel_event row of the held shape (${Object.keys(EVENT_OWNER_HELD).length - staleHolds.length}/${Object.keys(EVENT_OWNER_HELD).length})`, staleHolds.length === 0, `stale: ${staleHolds.join(", ")}`)
    const doors10 = ["emitKernelEvent", "processKernelEvent"]
    const alias10 = (src: string, ev = "PLANTED") => { const ids = blankStrings(src); const al = doorAliases(ids, doors10); const calls = doorCallSpans(ids, blankComments(src), [...doors10, ...al.names], new Set()).filter(([s]) => !al.spans.some(([a, b]) => s >= a && s < b)); return auditOnlyAt(ids, [...ids.matchAll(new RegExp(`KernelEvent\\.${ev}\\b`, "g"))].map((m) => m.index!), calls) }
    check("G10 POSITIVE: a call through a local ALIAS of a door (`const emit = deps.emit ?? …emitKernelEvent`) is judged by its own arguments — auditOnly: true → a record; without it → fan-out",
      alias10(`const emit = deps.emit ?? (await import("@/lib/kernel/emit")).emitKernelEvent\nawait emit({ event: KernelEvent.PLANTED, auditOnly: true })`) === true
      && alias10(`const emit = deps.emit ?? (async (i) => (await import("@/lib/kernel/emit")).emitKernelEvent(i))\nawait emit({ event: KernelEvent.PLANTED })`) === false)
    check("G10 NEGATIVE: a binding that does not name a door, or binds a door's RESULT, is not an alias (the site rides nothing)",
      alias10(`const emit = (x) => console.log(x)\nawait emit({ event: KernelEvent.PLANTED, auditOnly: true })`) === undefined
      && doorAliases(blankStrings(`const r = await emitKernelEvent({ event: KernelEvent.PLANTED })`), doors10).names.length === 0)
    const lit10 = `await emitKernelEvent({ event: KernelEvent.OTHER })\nawait svc.from("activities").insert({ activity_type: "planted_value" })\nawait processKernelEvent({ event: "planted_value", auditOnly: true })`
    const lcalls = doorCallSpans(blankStrings(lit10), blankComments(lit10), doors10, new Set())
    const litAt = (n: number) => [...lit10.matchAll(/"planted_value"/g)][n].index!
    check("G10 POSITIVE: a quoted event value inside a door call, or keyed `event:`, is an emission site — NEGATIVE: the same value as an `activity_type:` on another table's insert is not",
      literalEventSite(lit10, litAt(1), lcalls) && literalEventSite(`const x = { event: "planted_value" }`, `const x = { event: "planted_value" }`.indexOf(`"planted_value"`), []) && !literalEventSite(lit10, litAt(0), lcalls))
    const fin = stripComments(rawOf("lib/kernel/financial.ts"))
    check("G10 POSITIVE: a CONDITIONAL_AUDIT entry verifies against its named file's comment-stripped code — NEGATIVE: another file, or the code without the expression, does not",
      conditionalAuditVerified("commission_calculated", "lib/kernel/financial.ts", fin) && !conditionalAuditVerified("commission_calculated", "lib/kernel/crm.ts", fin)
      && !conditionalAuditVerified("commission_calculated", "lib/kernel/financial.ts", fin.replace(/auditOnly:\s*nextStatus !== "approved"/g, "auditOnly: false")) && !conditionalAuditVerified("contact_archived", "lib/kernel/financial.ts", fin))
    check("G10 POSITIVE CONTROL (the alias finder still sees its shape in the tree): some runtime file binds a local alias of a kernel emit door",
      FILES.some((f) => { const v = views(f); return !!v && v.ids.includes("emitKernelEvent") && doorAliases(v.ids, c.emitDoors ?? ["emitKernelEvent"]).names.length > 0 }))

    // G11 — lane 155R22 part 2. A: a constant with a MULTI-LINE annotation is data (it executes nothing in its module)
    const bk = (src: string, n: string) => bindingKind(blankStrings(src), n)
    check("G11 A PURE: a const whose type annotation spans lines and whose initializer is an object literal is DATA — NEGATIVE: a multi-line-annotated FUNCTION, and a multi-line-annotated call result, stay unknown (the whole-file fallback keeps them)",
      bk(`export const META: Record<string, {\n  label: string\n  fields: Array<{ key: string }>\n}> = {\n  a: { label: "x", fields: [] },\n}\n`, "META") === "data"
      && bk(`export const send: (\n  x: string,\n) => Promise<void> = async (x) => { await dispatchEmail(x) }\n`, "send") === "unknown"
      && bk(`export const client: Record<string,\n  string> = makeClient()\n`, "client") === "unknown")
    const IT = "lib/onboarding/integration-tester.ts"
    check("G11 A POSITIVE: importing the tester's data constant (PROVIDER_METADATA) carries NOTHING — NEGATIVE: CALLING its function (testIntegration) carries the connector send, and a namespace / unknown binding still over-reports the whole file",
      memberFacts(IT, "PROVIDER_METADATA", 1).egress.length === 0 && memberFacts(IT, "PROVIDER_METADATA", 1).writes.size === 0
      && memberFacts(IT, "testIntegration", 1).egress.length > 0 && memberFacts(IT, "*", 1).egress.length > 0)
    // B: the platform-staff door
    const p2 = (n: string) => c.rows.find((r) => r.id === `server_action:${FX_P2}#${n}`)
    check("G11 B POSITIVE: a platform-gated (requirePlatformCapability) log-only action missing ONLY owner is OWNER_HELD with the staff-door question verbatim",
      p2("plantedStaffLogOnly")?.classification === "OWNER_HELD" && !!p2("plantedStaffLogOnly")?.why.includes(STAFF_DOOR_Q), JSON.stringify([p2("plantedStaffLogOnly")?.classification, p2("plantedStaffLogOnly")?.missing]))
    check("G11 B NEGATIVE: the same action behind a TENANT gate (requireCallerTenant) stays an EXECUTABLE_GAP; a staff act with a derivable owner keeps that owner; a staff act that also misses evidence stays a gap",
      p2("plantedTenantLogOnly")?.classification === "EXECUTABLE_GAP" && p2("plantedStaffOwned")?.registered_manager === TABLE_MANAGER[hopA] && p2("plantedStaffOwned")?.state !== "owner-held"
      && p2("plantedStaffNoEvidence")?.classification === "EXECUTABLE_GAP" && !!p2("plantedStaffNoEvidence")?.missing.includes("evidence"),
      JSON.stringify([p2("plantedTenantLogOnly")?.classification, p2("plantedStaffOwned")?.registered_manager, p2("plantedStaffNoEvidence")?.classification]))
    check("G11 B NEGATIVE: a platform check that only ADMITS as an alternative (`sameTenant || isPlatformStaffIdentity(…)`), and a platform gate whose result is never checked, are not staff-only doors",
      p2("plantedStaffAlternative")?.classification === "EXECUTABLE_GAP" && p2("plantedStaffUnchecked")?.classification === "EXECUTABLE_GAP",
      JSON.stringify([p2("plantedStaffAlternative")?.classification, p2("plantedStaffUnchecked")?.classification]))
    check("G11 B PURE: refusingGateCall sees `if (!gate(…)) return` and `const g = await gate(…); if (!g.ok) return` — NEGATIVE: `if (a || gate(…)) {` and an unchecked binding",
      refusingGateCall(`if (!platformStaffCan(role, "p")) return { ok: false }`, 5, "platformStaffCan") && refusingGateCall(`const g = await gateX("t")\n  if (!g.ok || !g.userId) return g`, 16, "gateX")
      && !refusingGateCall(`if (a || gateX(b)) { go() }`, 9, "gateX") && !refusingGateCall(`const g = await gateX("t")\n  go(g)`, 16, "gateX"))
    const pg = platformGateSet()
    check(`G11 B DERIVED: the platform gates are derived from what their bodies read (${pg.size}): gateStaffAction and requireProviders (which only calls requirePlatformCapability) are in — NEGATIVE: a non-gate-shaped function that reads platform_role is not`,
      pg.has("lib/platform/staff-action-gate.ts#gateStaffAction") && pg.has("lib/auth/platform-guard.ts#requireProviders")
      && FILES.some((f) => f.startsWith("lib/") && fnsOf(f).some((fn) => !gateShaped(fn.name) && (views(f)?.platformAt ?? []).some((x) => x >= fn.start && x < fn.end) && !pg.has(`${f}#${fn.name}`))))
    // C: the own-record write
    check("G11 C POSITIVE: an update pinned to the session-resolved user's id, touching nothing else, is held with the own-record question — NEGATIVE: an insert for ANOTHER user, and a pin to a PARAMETER's userId, are not",
      p2("plantedOwnRecord")?.classification === "OWNER_HELD" && !!p2("plantedOwnRecord")?.why.includes(OWN_RECORD_Q)
      && p2("plantedOtherRecord")?.classification !== "OWNER_HELD" && p2("plantedParamPinned")?.classification !== "OWNER_HELD",
      JSON.stringify([p2("plantedOwnRecord")?.classification, p2("plantedOwnRecord")?.missing, p2("plantedOtherRecord")?.classification, p2("plantedParamPinned")?.classification]))
    // F: a write behind a literal-false flag
    check("G11 F PURE: every call passing `markUsed: false` yields that flag — NEGATIVE: a variable argument, a call without it, or the function passed on yields nothing",
      falseFlagsAt(`const { pickX } = await import("x")\nconst r = await pickX({ id, markUsed: false, limit: 2 })`, "pickX").join() === "markUsed"
      && falseFlagsAt(`await pickX({ markUsed: flag })`, "pickX").length === 0 && falseFlagsAt(`await pickX({ markUsed: false })\nawait pickX({ id })`, "pickX").length === 0
      && falseFlagsAt(`await pickX({ markUsed: false })\nrun(pickX)`, "pickX").length === 0)
    const TB = "lib/content-intel/topic-bank.ts"
    check("G11 F POSITIVE: pickTopics with markUsed false carries no write (its update and logTopicUses sit under `if (args.markUsed && …)`) — NEGATIVE: without the flag the full callee still writes, and a flag no guard names proves nothing",
      falseFlagGatedFacts(TB, "pickTopics", 1, ["markUsed"])?.writes.size === 0 && memberFacts(TB, "pickTopics", 1).writes.size > 0 && falseFlagGatedFacts(TB, "pickTopics", 1, ["__no_such_flag__"]) === null)
  }

  const st = { working: 0, partial: 0, missing: 0, "owner-held": 0 } as Record<State, number>
  for (const r of realRows) st[r.state]++
  console.log(`\n  rows ${realRows.length}: working ${st.working} · partial ${st.partial} · missing ${st.missing} · owner-held ${st["owner-held"]} — ${Object.entries(c.denominators).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
  console.log("✅ OS_COVERAGE_LEDGER_PASS — every registered executable path is derived, judged by rule and either covered, frozen with its exact gap, or owner-held")
}
// Run only when invoked as the guard, so a probe can import the extractor.
if (/os-coverage-ledger\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1) })
export { topLevelFns, factsOfSpan, pathFacts, exportFacts, views, judge, stateOf, census, classify, groupOf, ratchet, auditOnlyAt, siblingCaller, routingLink, caseSpanEnd,
  delegatedWorkers, ownerOfDelegatedRead, isNotAWorker, eventLedgerHold, staleEventHolds }
