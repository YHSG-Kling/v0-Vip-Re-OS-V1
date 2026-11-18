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
// Run:  npx tsx scripts/os-coverage-ledger.ts              (check: rules + the generated docs agree with the code)
//       npx tsx scripts/os-coverage-ledger.ts --write      (emit docs/architecture/OS-ARBITRATION-COVERAGE.md + os-arbitration-coverage.json)
//       npx tsx scripts/os-coverage-ledger.ts --write-baseline   (integrator: create, or PRUNE-only tighten, the frozen-gap baseline)
// Summary line: `RESULT: N passed, M failed`.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join, dirname, normalize } from "node:path"
import { tmpdir } from "node:os"
import { registerHooks } from "node:module"
import { blankComments, blankStrings, stringLiterals } from "./strip-comments"
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
const DOC_JSON = "docs/architecture/os-arbitration-coverage.json"
const BASELINE_FILE = "scripts/os-coverage-ledger-baseline.json"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const U = (why: string) => `unresolved: ${why}`

// ══ OWNER-HELD — a path that is deliberately not autonomous, with the owner's reason. Each entry must still be a row. ══
const OWNER_HELD: Record<string, string> = {}

// ══ 1. SOURCE VIEWS (one scanner — CLAUDE.md §2) ═════════════════════════════════════════════════════════════════════════
// Kept per file: the blankStrings() view (tokens), the line index, every `.from("<table>")` literal with the 64 characters of
// COMMENT-BLANKED code after it (the reused WRITE / READ / NEXT / RECOVERY regexes read table names there and nowhere else), the
// offsets of the literal "brokerage_id" / "platform_role", and the import edges. The comment-blanked view itself is transient
// (codeOf) — holding both full views of 76 MB of source cost ~1.9 GB RSS on the first measurement.
interface FromLit { at: number; text: string }
interface Views { ids: string; lineStarts: Int32Array; froms: FromLit[]; brokerageAt: number[]; platformAt: number[]; useServer: boolean }
const viewCache = new Map<string, Views | null>()
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
  const v: Views = { ids, lineStarts: Int32Array.from(starts), froms, brokerageAt, platformAt, useServer: hasUseServerDirective(code) }
  if (rawText === undefined) {
    viewCache.set(file, v); edgeCache.set(file, parseEdges(file, code)); collectApiLiterals(file, code)
    for (const m of code.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*["'`]([a-z][a-z0-9_.:]*)["'`]/g)) { if (!CONST_LITS.has(m[2])) CONST_LITS.set(m[2], new Set()); CONST_LITS.get(m[2])!.add(m[1]) }
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
  for (const m of s.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
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
const GATE_EXTRA_RE = new RegExp(`\\b(?:${[...OUTBOUND_GATES, "autonomyDecision", "authorityAllows", "isToolAllowedAtAuthority", "requireLenderVendorActor", "requirePortalActor", "requireContactPortal\\w*", "assertTenant\\w*", "governSpokenConfirm", "preflightDeclaredGates"].join("|")})\\s*\\(`)
const CONSENT_RE = /\b(?:checkSuppression|requireContactConsent|requireConsent\w*|channelRefusalForRecipient|isSuppressed\w*|evaluateOutboundCompliance|captureConsentedContact|hasConsent\w*|isOptedOut\w*)\s*\(/
const SIGNATURE_RE = /\b(?:timingSafeEqual|verify\w*Signature|validateRequest|constructEvent|verifyWebhook\w*|verifyHmac\w*|verifySvix\w*|validateTwilio\w*|verifyCronAuth)\s*\(|\bprocess\.env\.[A-Z0-9_]*(?:SECRET|SIGNING|WEBHOOK_TOKEN|VERIFY_TOKEN)[A-Z0-9_]*\b/
const CRON_AUTH_RE = /\bverifyCronAuth\s*\(/
const EVIDENCE_TABLE_RE = /(?:ledger|audit|_log$|_logs$|_events$|_receipts?$|invocations?$|_calls$|_history$|_outcomes?$|dead_letters$)/
const TENANT_ID_RE = /\b(?:brokerageId|brokerage_id|requireCallerTenant|getAgentContext)\b/
const PLATFORM_RE = /\b(?:requirePlatform\w*|platform_role|isPlatformStaff\w*|requireSuperadmin\w*)\b/
const LIVE = new Set(LIVE_TABLES)

// ══ 4. PATH FACTS ═══════════════════════════════════════════════════════════════════════════════════════════════════════
interface Hit { token: string; at: string }
interface Facts {
  writes: Map<string, string>; reads: Set<string>; egress: Hit[]; gates: Hit[]; evidence: Hit[]
  next: Hit | null; recovery: Hit | null; session: Hit | null; tenant: boolean; platform: boolean
  consent: Hit | null; signature: Hit | null; budget: Hit | null; files: Set<string>
}
const emptyFacts = (): Facts => ({ writes: new Map(), reads: new Set(), egress: [], gates: [], evidence: [], next: null, recovery: null, session: null, tenant: false, platform: false, consent: null, signature: null, budget: null, files: new Set() })
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
  const ev = firstHit(OUTCOME_RE, ids, v, file, from) ?? firstHit(DOOR_RE, ids, v, file, from)
  if (ev) f.evidence.push(ev)
  for (const [t, at] of f.writes) if (EVIDENCE_TABLE_RE.test(t)) { f.evidence.push({ token: `row:${t}`, at }); break }
  f.next = firstHit(NEXT_RE, ids, v, file, from) ?? fromHit(NEXT_RE, v, file, from, to)
  f.recovery = firstHit(RECOVERY_RE, ids, v, file, from) ?? fromHit(RECOVERY_RE, v, file, from, to)
  for (const t of SESSION_TOKENS) {
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
  f.signature = firstHit(SIGNATURE_RE, ids, v, file, from)
  return f
}
function merge(a: Facts, b: Facts): Facts {
  for (const [t, at] of b.writes) if (!a.writes.has(t)) a.writes.set(t, at)
  for (const t of b.reads) a.reads.add(t)
  a.egress.push(...b.egress); a.gates.push(...b.gates); a.evidence.push(...b.evidence)
  a.next ??= b.next; a.recovery ??= b.recovery; a.session ??= b.session; a.consent ??= b.consent; a.signature ??= b.signature; a.budget ??= b.budget
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
  if (!fn) { const ff = fileFacts(file); memberMemo.set(key, ff); return ff }
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
  for (const e of edgesOf(file)) {
    if (e.target === file) continue
    const inSpan = e.at >= a && e.at < b
    for (const p of e.pairs) {
      if (!p.local) { if (inSpan) merge(f, memberFacts(e.target, p.name, hop + 1)); continue }
      const l = p.local.replace(/\$/g, "\\$")
      if (p.name === "*") {
        const members = new Set([...ids.matchAll(new RegExp(`\\b${l}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1]))
        if (members.size) for (const mb of members) merge(f, memberFacts(e.target, mb, hop + 1))
        else if (new RegExp(`\\b${l}\\b`).test(ids)) merge(f, fileFacts(e.target))
      } else if (new RegExp(`\\b${l}\\b`).test(ids)) merge(f, memberFacts(e.target, p.name, hop + 1))
    }
  }
  return f
}

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
}
interface Draft {
  id: string; kind: TriggerKind; entry: string; action: string; source_event: string; trigger: string | null; worker: string | null
  owner: string | null; ownerWhy?: string; facts: Facts; consequentialHint?: boolean; actorHint?: string; deadline?: string
  decisionHint?: string; evidenceHint?: string; readbackHint?: string; subject?: string
  /** the tables the plane / surface lens reads, when the facts also carry a shared route head's writes */
  lensTables?: string[]
}

// TABLE_MANAGER (imported below) gives the steward of each written table; the owner of a path is the steward of what it writes.
let TABLE_MANAGER: Record<string, string> = {}
let MANAGER_KEYS = new Set<string>()
/** The bus and the ledgers are carriers, not domains: their steward is not the owner of an action that merely writes them. */
const CARRIER_TABLES = new Set(["manager_signals", "notifications", "kernel_events", "lifecycle_events", "agent_action_ledger"])
function ownerFromWrites(f: Facts, addressed?: string | null): { owner: string | null; why: string } {
  const counts = new Map<string, number>()
  for (const t of f.writes.keys()) { if (CARRIER_TABLES.has(t) || EVIDENCE_TABLE_RE.test(t)) continue; const m = TABLE_MANAGER[t]; if (m) counts.set(m, (counts.get(m) ?? 0) + 1) }
  if (!counts.size && addressed && MANAGER_KEYS.has(addressed)) return { owner: addressed, why: `the manager the path addresses (toManager "${addressed}")` }
  if (!counts.size) return { owner: null, why: f.writes.size ? `it writes only carriers / unstewarded tables (${[...f.writes.keys()].slice(0, 3).join(", ")}) and addresses no manager` : "it writes no table, and no registry names an owner" }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { owner: best[0][0], why: `TABLE_MANAGER steward of ${[...f.writes.keys()].filter((t) => TABLE_MANAGER[t] === best[0][0]).slice(0, 2).join(", ")}` }
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
  const st: State = OWNER_HELD[d.id] ? "owner-held" : stateOf(missing)
  const planes = planesOf(d, d.lensTables ?? written)
  const surfaces = surfacesOf(d, d.lensTables ?? written)
  return {
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
    why: OWNER_HELD[d.id] ?? (missing.length ? `missing: ${missing.join(", ")}` : consequential ? "trigger → worker → owner → decision → evidence → readback" : "read / decide surface: trigger → worker"),
  }
}
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
/** The export's span plus every same-file top-level function it calls, to a fixpoint. */
function closureSpans(fns: FnSpan[], v: Views, root: FnSpan): FnSpan[] {
  const byName = new Map(fns.map((f) => [f.name, f]))
  const seen = new Set([root.name]); const queue = [root]; const out: FnSpan[] = [root]
  while (queue.length) {
    const cur = queue.pop()!
    const body = v.ids.slice(cur.start, cur.end)
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const callee = byName.get(m[1])
      if (callee && !seen.has(callee.name)) { seen.add(callee.name); out.push(callee); queue.push(callee) }
    }
  }
  return out
}
function exportFacts(file: string, v: Views, fns: FnSpan[], root: FnSpan): Facts {
  const f = emptyFacts()
  for (const s of closureSpans(fns, v, root)) merge(f, pathFacts(file, s.start, s.end, v))
  return f
}

// ══ 8. THE CENSUS ═══════════════════════════════════════════════════════════════════════════════════════════════════════
interface Census { rows: Row[]; denominators: Record<string, number>; blind: string[]; cronDrift: string[]; readOnlyExports: number }

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
  const { riskClassForTool } = await import("../lib/ai-isa/persona-tool-policy")
  let SIGNAL_HANDLER_KEYS: Set<string>
  let signalHandlersFrom = "runtime import of lib/kernel/manager-signals.ts SIGNAL_HANDLERS"
  try { SIGNAL_HANDLER_KEYS = new Set(Object.keys((await import("../lib/kernel/manager-signals")).SIGNAL_HANDLERS)) } catch (e) {
    signalHandlersFrom = `STATIC parse (runtime import failed: ${(e as Error).message.slice(0, 80)})`
    SIGNAL_HANDLER_KEYS = new Set([...(codeOf("lib/kernel/manager-signals.ts")).matchAll(/^\s*["']([a-z_]+:[a-z_]+)["']\s*:/gm)].map((m) => m[1]))
  }
  const drafts: Draft[] = []
  const blind: string[] = []
  const rowsOut: Row[] = []

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
  // …plus the WRAPPER doors: an exported (emit|publish|fire|record)…Event function in lib/kernel whose own body calls a base door
  const baseDoorRe = new RegExp(`\\b(?:${emitDoors.join("|") || "emitKernelEvent"})\\b`)
  for (const f of FILES.filter((x) => x.startsWith("lib/kernel/") && baseDoorRe.test(views(x)?.ids ?? ""))) {
    const v = views(f)!
    for (const fn of fnsOf(f)) if (fn.exported && /^(?:emit|publish|fire|record)\w*Event\w*$/.test(fn.name) && !emitDoors.includes(fn.name) && baseDoorRe.test(v.ids.slice(fn.start, fn.end))) emitDoors.push(fn.name)
  }
  // …and the reactor / fanout's own exported entry points (calling one with an event IS emitting into it, e.g. writePortalUpdate)
  for (const rf of reactorFiles) for (const fn of fnsOf(rf)) if (fn.exported && !emitDoors.includes(fn.name)) emitDoors.push(fn.name)
  const emitDoorRe = new RegExp(`\\b(?:${emitDoors.join("|") || "emitKernelEvent"})\\b`)
  const emitterFiles = FILES.filter((f) => emitDoorRe.test(views(f)?.ids ?? "") && f !== "lib/kernel/emit.ts")
  const emitCode = new Map(emitterFiles.map((f) => [f, codeOf(f)] as const))
  // A CONSUMER site is structural: `=== KernelEvent.X`, `case KernelEvent.X`, or a map key `[KernelEvent.X]:`. Any other
  // occurrence in a file that calls an emit function is an EMISSION site.
  const consumerSites = new Map<string, Array<{ file: string; idx: number }>>()
  const emitSites = new Map<string, Set<string>>()
  for (const f of FILES) {
    if (f === "lib/kernel/events.ts") continue
    const v = views(f); if (!v || !v.ids.includes("KernelEvent.")) continue
    for (const m of v.ids.matchAll(/\bKernelEvent\.([A-Z0-9_]+)\b/g)) {
      const before = v.ids.slice(Math.max(0, m.index! - 8), m.index!), after = v.ids.slice(m.index! + m[0].length, m.index! + m[0].length + 4)
      const consumer = /===\s*$|case\s+$/.test(before) || (/\[\s*$/.test(before) && /^\s*\]\s*:/.test(after))
      if (consumer) { if (!consumerSites.has(m[1])) consumerSites.set(m[1], []); consumerSites.get(m[1])!.push({ file: f, idx: m.index! }) }
      else if (emitCode.has(f) && !reactorFiles.includes(f)) { if (!emitSites.has(m[1])) emitSites.set(m[1], new Set()); emitSites.get(m[1])!.add(f) }
    }
  }
  for (const [key, value] of Object.entries(ev)) {
    if (typeof value !== "string") continue
    const emitters = [...new Set([...(emitSites.get(key) ?? []), ...emitterFiles.filter((f) => !reactorFiles.includes(f) && carriesLiteral(value, emitCode.get(f)!, views(f)!.ids))])]
    const facts = emptyFacts(); let worker: string | null = null; let addressed: string | null = null
    for (const site of consumerSites.get(key) ?? []) {
      const v = views(site.file)!
      if (reactorFiles.includes(site.file)) {
        const open = v.ids.indexOf("{", site.idx); const close = open < 0 ? v.ids.length : matchBrace(v.ids, open)
        merge(facts, pathFacts(site.file, site.idx, close + 1, v))
        addressed ??= /\btoManager\s*:\s*["']([a-z_]+)["']/.exec((reactorCode.get(site.file) ?? "").slice(site.idx, close + 1))?.[1] ?? null
      } else merge(facts, pathFacts(site.file))
      worker ??= `${site.file}:${lineAt(v, site.idx)}`
    }
    const ow = ownerFromWrites(facts, addressed)
    drafts.push({
      id: `kernel_event:${value}`, kind: "kernel_event", entry: worker ?? "lib/kernel/events.ts", action: `kernel.${value}`, source_event: `KernelEvent.${key}`,
      trigger: emitters.length ? `emitted by ${emitters[0]}${emitters.length > 1 ? ` (+${emitters.length - 1})` : ""}` : null,
      worker, owner: ow.owner, ownerWhy: ow.why, facts, actorHint: "kernel event bus",
    })
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
        owner: null, facts: pathFacts(file, at, lineEnd, v), actorHint: "orchestrator event bus",
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
  const signalReaderFiles = readersOf("manager_signals", undefined).filter((x) => x !== "lib/kernel/manager-signals.ts")
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
    for (const a of capReg.buildFullActionManifest() as Array<{ capability: string; kind: string; verb: string; mutates?: boolean }>) {
      const isApp = a.capability in capReg.APP_CAPABILITY_REGISTRY
      const at = isApp ? capV.ids.search(new RegExp(`^\\s*${a.capability}\\s*:`, "m")) : -1
      const facts = emptyFacts(); merge(facts, routeFacts)
      const lensTables: string[] = []
      drafts.push({
        id: `capability:${a.kind}:${a.capability}`, kind: "capability",
        entry: isApp && at >= 0 ? `lib/agentic-os/app-capability-registry.ts:${lineAt(capV, at)}` : `${a.kind} manifest (buildFullActionManifest)`,
        action: `${a.verb} ${a.capability}`, source_event: `MCP tools/call · REST /api/agentic-os/actions/${a.capability}/invoke`,
        trigger: `${mcp} tools/call (buildFullActionManifest)`,
        worker: execKeys.has(a.capability) ? `executor ${a.capability} (${mcp} / ${inv})` : null,
        owner: isApp ? capMgr[a.capability] ?? null : null, ownerWhy: isApp ? "CAPABILITY_MANAGER has no entry" : `a ${a.kind} capability: CAPABILITY_MANAGER covers app capabilities only`,
        facts, consequentialHint: !!a.mutates, actorHint: "agent token (scope-gated)",
        subject: a.capability, lensTables,
      })
    }
  }

  // ── assistant / voice tools ──
  {
    const route = "app/api/agent-assistant/tool-call/route.ts"; const v = views(route)!
    const rcode = codeOf(route); const routeHead = pathFacts(route, 0, v.ids.search(/\bfunction\s+runTool\b/) >>> 0, v)
    const vtm = toolReg.VOICE_TOOL_MANAGER as Readonly<Record<string, string>>
    const regV = views("lib/voice/tool-registry.ts")!
    for (const [name, tool] of Object.entries(toolReg.voiceTools as Record<string, { category: string; authority: string; gates: string[] }>)) {
      const m = new RegExp(`case\\s+["']${name}["']\\s*:`).exec(rcode)
      let facts = emptyFacts()
      if (m) {
        const nextCase = rcode.slice(m.index + m[0].length).search(/\n\s*(?:case\s+["'][a-z_]+["']\s*:|default\s*:)/)
        facts = pathFacts(route, m.index, nextCase < 0 ? rcode.length : m.index + m[0].length + nextCase, v)
      }
      const lensTables = [...facts.writes.keys()]
      merge(facts, routeHead)
      const risk = riskClassForTool(name)
      const regAt = regV.ids.search(new RegExp(`^\\s*${name}\\s*:\\s*\\{`, "m"))
      drafts.push({
        id: `assistant_tool:${name}`, kind: "assistant_tool", entry: m ? `${route}:${lineAt(v, m.index)}` : `lib/voice/tool-registry.ts:${lineAt(regV, regAt >>> 0)}`,
        action: `tool.${name} (${tool.category}, ${risk})`, source_event: "agent assistant / voice tool call",
        trigger: m ? `${route} POST (assistant session)` : null, worker: m ? `${route} runTool case "${name}"` : null,
        owner: vtm[name] ?? null, ownerWhy: "VOICE_TOOL_MANAGER deliberately leaves bench-wide tools unattributed (lib/voice/tool-registry.ts)",
        facts, consequentialHint: risk !== "READ" || ["send", "stage", "schedule"].includes(tool.category),
        lensTables, actorHint: "signed-in seat (assistant session)", decisionHint: `session seat under authorityAllows + declared gates [${tool.gates.join(", ") || "none"}] (${route})`,
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
    const ow = ownerFromWrites(facts)
    const at = v.ids.search(/export\s+(?:async\s+)?(?:function|const)\s+(?:POST|PUT|PATCH|DELETE|GET)\b/)
    drafts.push({
      id: `${hook ? "webhook" : "http"}:${url}`, kind: hook ? "webhook" : "http", entry: `${file}:${lineAt(v, at >>> 0)}`, action: `${methods.join("/")} ${url}`,
      source_event: hook ? "provider callback" : "HTTP request",
      trigger: hook ? (methods.length ? `external provider callback (${methods.join("/")})` : null) : callers.length ? `fetch from ${callers[0]}${callers.length > 1 ? ` (+${callers.length - 1})` : ""}` : null,
      worker: methods.length ? `${file} ${methods.join("/")}` : null, owner: ow.owner, ownerWhy: ow.why, facts,
    })
  }
  blind.push("webhook triggers: a provider console registration cannot be read from code — an exported handler on a callback path is taken as reachable; http triggers count only in-repo `/api/…` literals (an external caller reads as no trigger — unresolved, not dead, CLAUDE.md §1)")

  // ── consequential "use server" exports ──
  let readOnlyExports = 0
  const useServerFiles = [...FILES.filter((f) => (f.startsWith("app/") || f.startsWith("lib/")) && (views(f)?.useServer ?? false)), ...fixtureFiles.map((x) => x.file)]
  for (const file of useServerFiles) {
    const fixture = fixtureFiles.find((x) => x.file === file)
    const v = fixture ? views(file, fixture.raw)! : views(file)!
    const fns = topLevelFns(v)
    const importers = IMPORTED.get(file)
    for (const fn of fns.filter((x) => x.exported)) {
      const facts = fixture ? factsOfSpan(file, v, fn.start, fn.end) : exportFacts(file, v, fns, fn)
      if (!facts.writes.size && !facts.egress.length) { readOnlyExports++; continue }
      const callers = [...(importers?.get(fn.name) ?? []), ...(importers?.get("*") ?? [])]
      const ow = ownerFromWrites(facts)
      drafts.push({
        id: `server_action:${file}#${fn.name}`, kind: "server_action", entry: `${file}:${fn.line}`, action: fn.name, source_event: "UI / caller invocation (public server action)",
        trigger: callers.length ? `imported by ${callers[0]}${callers.length > 1 ? ` (+${callers.length - 1})` : ""}` : fixture ? `fixture caller` : null,
        worker: `${file} ${fn.name}`, owner: ow.owner, ownerWhy: ow.why, facts,
      })
    }
  }
  blind.push("server actions: a path is the export + its same-file callees + the WHOLE-FILE facts of each local module it references (one hop; a lib module's facts are module-level — over-reports writes, under-reports anything two hops away); a computed import specifier is not an edge")

  for (const d of drafts) rowsOut.push(finish(d))
  const denominators: Record<string, number> = {}
  for (const r of rowsOut) denominators[r.trigger_kind] = (denominators[r.trigger_kind] ?? 0) + 1
  denominators["server_action (read-only, not rows)"] = readOnlyExports
  denominators["use-server modules scanned"] = useServerFiles.length
  denominators["runtime files scanned"] = FILES.length
  blind.push(`manager-signal consumers from ${signalHandlersFrom}; a publisher is a file that calls publishManagerSignal AND carries the type as an exact string literal (a type built at run time is invisible)`)
  blind.push("planes and A7.1 surfaces are a LEXICAL lens over the entry path, action name and written tables (a row may sit on several planes; an unmatched row is '(unclassified)')")
  blind.push("readback = a reader of a written table in ANOTHER file via `.from(t).select` (an RPC, a view or a trigger-maintained reader is invisible); evidence = a ledger door (OUTCOME_RE / DOOR_TOKENS) or a write to a ledger-shaped table on the path")
  blind.push("decision owner = the first authority / arbiter / approval / spend / compliance token (PLANE_RES) or outbound gate on the path, a session read for a human-initiated action, or a verified provider signature for a webhook; a gate two hops away is invisible")
  return { rows: rowsOut, denominators, blind, cronDrift, readOnlyExports }
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
function render(c: Census, matrix: MatrixOut): { md: string; json: string } {
  const rows = [...c.rows].sort((a, b) => a.id.localeCompare(b.id))
  const byState = (rs: Row[]) => { const o: Record<string, number> = { working: 0, partial: 0, missing: 0, "owner-held": 0 }; for (const r of rs) o[r.state]++; return o }
  const all = byState(rows)
  const L: string[] = []
  L.push("# OS Arbitration and Autonomy Coverage Ledger", "",
    "> GENERATED by `scripts/os-coverage-ledger.ts --write` (wave 154, lane 154A1) — do not edit. One row per real executable action, derived by traversing the code;",
    "> a field that cannot be derived reads `unresolved: <reason>`. Machine-readable twin: `docs/architecture/os-arbitration-coverage.json`.", "",
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
  if (c.cronDrift.length) L.push("## Cron drift", "", ...c.cronDrift.map((x) => `- ${x}`), "")
  // one row per line: diff-friendly and a third of the pretty-printed size
  const head = JSON.stringify({ generator: "scripts/os-coverage-ledger.ts", denominators: c.denominators, states: all, missingLinks: linkCount, decisionMatrix: matrix.json, blindSpots: c.blind })
  const json = `${head.slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}`
  return { md: L.join("\n") + "\n", json: json + "\n" }
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
  rmSync(fxDir, { recursive: true, force: true })

  section("C — the census (every population read from its registry)")
  const c = await census([], [{ file: FX, raw: fxRaw }])
  const fxRows = c.rows.filter((r) => r.id.startsWith(`server_action:${FX}`))
  const realRows = c.rows.filter((r) => !r.id.startsWith(`server_action:${FX}`))
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
  if (WRITE_BASELINE) {
    const next: Baseline = {}
    for (const r of realRows) if (r.missing.length && !OWNER_HELD[r.id]) {
      if (!baselineExists) next[r.id] = sig(r.missing)
      else if (baseline[r.id] !== undefined) { const allowed = new Set(baseline[r.id].split(",")); const keep = r.missing.filter((m) => allowed.has(m)); if (keep.length) next[r.id] = sig(keep) }
    }
    writeFileSync(join(ROOT, BASELINE_FILE), JSON.stringify({ note: "Frozen gaps of scripts/os-coverage-ledger.ts (wave 154, lane 154A1). --write-baseline only PRUNES once this file exists: a closed gap leaves, a new gap is red. Never add by hand.", gaps: next }, null, 1) + "\n")
    console.log(`  · ${baselineExists ? "pruned" : "created"} ${BASELINE_FILE}: ${Object.keys(next).length} frozen gaps (was ${Object.keys(baseline).length})`)
  }
  const live = judge(realRows, WRITE_BASELINE ? JSON.parse(rawOf(BASELINE_FILE)).gaps : baseline, OWNER_HELD)
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
  const out = render({ ...c, rows: realRows }, matrix)
  const mapSection = out.md.slice(out.md.indexOf("## 2."), out.md.indexOf("## 3."))
  check("every component on the kernel-to-customer map resolves to live code (a function token in stripped source)", !!mapSection && !mapSection.includes("MISSING"), mapSection.match(/MISSING[^|]*/g)?.join("; "))
  if (WRITE) {
    mkdirSync(join(ROOT, "docs/architecture"), { recursive: true })
    writeFileSync(join(ROOT, DOC_MD), out.md); writeFileSync(join(ROOT, DOC_JSON), out.json)
    console.log(`  · wrote ${DOC_MD} (${out.md.length} bytes) and ${DOC_JSON} (${out.json.length} bytes)`)
  }
  const mdNow = rawOf(DOC_MD), jsonNow = rawOf(DOC_JSON)
  check(`${DOC_MD} + ${DOC_JSON} are the rendering of the code (line anchors excluded)`, !!mdNow && !!jsonNow && structural(mdNow) === structural(out.md) && structural(jsonNow) === structural(out.json),
    !mdNow || !jsonNow ? "absent — run `npx tsx scripts/os-coverage-ledger.ts --write`" : "stale — re-run with --write")

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
export { topLevelFns, factsOfSpan, pathFacts, exportFacts, views, judge, stateOf, census }
