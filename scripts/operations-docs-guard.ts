#!/usr/bin/env tsx
/**
 * scripts/operations-docs-guard.ts   (wave 143, lane 143H — npm run test:operations-docs, NOT YET REGISTERED:
 * the lane notes list the package.json key and chain membership for the integrator)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OPERATIONS DOCUMENTS ARE DERIVED FROM THE CODE, NOT WRITTEN BESIDE IT.
 *
 *   docs/operations/ENVIRONMENT-INVENTORY.md   every environment name the repo reads, declares or documents
 *   docs/operations/PROVIDER-CERTIFICATION.md  every provider adapter, every webhook door
 *   docs/operations/OWNER-SQL.md               the owner-held statements, verbatim from their migration files
 *   docs/operations/ACTIVATION-CHECKLIST.md    the ordered owner activation steps, each with its verification
 *   docs/architecture/PRODUCTION-ARCHITECTURE.md §15  the deployment facts (vercel.json, crons, buckets, headers…)
 *
 * A document that was typed by hand is true on the day it is typed. These are regenerated from the census, the
 * registries and the config files, and this guard FAILS when a committed block no longer equals what the code
 * produces — so "the inventory is complete" is a property that is checked, not a sentence that is asserted.
 *
 *   npx tsx --conditions=react-server scripts/operations-docs-guard.ts          verify (exit 1 on any failure)
 *   npx tsx --conditions=react-server scripts/operations-docs-guard.ts --write  regenerate the GENERATED blocks
 *
 * ── MEASUREMENT DISCIPLINE (CLAUDE.md §2) ───────────────────────────────────────────────────────────────────
 * · Code is read through scripts/strip-comments.ts (never a hand-rolled stripper); a tombstone is not a read.
 * · Every absence claim has a POSITIVE CONTROL (the finder is shown to recognise the defect it hunts).
 * · BLIND SPOTS, published beside the numbers (they are also printed in the generated block):
 *     – a name assembled at runtime (`${x}_API_KEY`) has no literal and is invisible to every arm;
 *     – "declared" arms read literal declaration keys (clientIdEnv / envKey / secretEnv / envVars / *_ENV tables) —
 *       a declaration spelled any other way is not seen;
 *     – the environment's PRESENCE in a real Vercel project is not readable from this container (no credential,
 *       and the owner ruling forbids it): the inventory carries the repo-side facts and the exact owner command;
 *     – a provider contract is certified against the registry, the vendor documentation URLs and the response
 *       fixtures in this repo — NOT against a live call (no provider credential exists here; none was used).
 * NO VALUES are ever read, printed or written: the only process.env access in this file is none at all.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { runtimeFiles } from "./runtime-roots"
import { stripComments, blankComments } from "./strip-comments"
import {
  envReadsInSource, declaredEnvNamesInSource, namesFromEnvExample, namesFromVercelJson, namesFromWorkflowYaml,
} from "./env-var-parity"
import { claimOf } from "./migration-status"
import { LIVE_TABLES } from "./live-tables"
import { ENV_META, SYSTEMS, type Meta, type Req, type SysKey } from "./operations-docs-data"
import { buildLaunchChecklist, type LaunchTier } from "@/lib/platform/launch-checklist"
import { WEBHOOK_CONTRACT } from "@/lib/providers/webhook-contract"
import { PROVIDER_TENANCY } from "@/lib/providers/tenancy-matrix"
import { CONNECTOR_REGISTRY } from "@/lib/agentic-os/connector-registry"
import { PLATFORM_PROVIDER_KEYS } from "@/lib/agentic-os/connector-probe"
import { PLATFORM_ONLY_STRIPE_ENV, PLATFORM_WEBHOOK_ENV } from "@/lib/billing/stripe-account-scope"
import { deriveProviderAdapters, validateAdapterSet, type ProviderAdapter } from "@/lib/kernel/provider-adapters"
import { CRON_REGISTRY } from "@/lib/kernel/cron-dispatch"
import { LIVE_BUCKET_CONFIG } from "@/lib/storage/bucket-limits"
import { PRELIMINARY_STATEMENT_DOC_TYPES } from "@/lib/transactions/cda-closing-policy"

const ROOT = process.cwd()
const WRITE = process.argv.includes("--write")
const rd = (p: string): string => readFileSync(join(ROOT, p), "utf8")
const has = (p: string): boolean => existsSync(join(ROOT, p))

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// ═════════════════════════════════════════════════════════════════════════════
// PURE FINDERS (each has a positive control further down)
// ═════════════════════════════════════════════════════════════════════════════

/** Names the code carries that no ENV_META row classifies. */
function unclassifiedNames(universe: Iterable<string>, meta: Record<string, unknown>): string[] {
  return [...new Set(universe)].filter((n) => !(n in meta)).sort()
}
/** Rows that name nothing the code, the example file or a registry carries. */
function phantomRows(universe: Iterable<string>, meta: Record<string, unknown>): string[] {
  const u = new Set(universe)
  return Object.keys(meta).filter((n) => !u.has(n)).sort()
}
const EXEMPT_FROM_DIRECT_READ: ReadonlySet<Req> = new Set<Req>(["RETIRED", "ALIAS", "UNUSED", "UNIMPLEMENTED", "CI/TOOLING", "PROVIDED"])
/**
 * A credential name a REGISTRY declares (adapter, connector, tenancy matrix, launch checklist, webhook contract, probe
 * keys) must be OBTAINED by something: a direct read, or a `via` naming the computed-key consumer, or an explicit
 * disposition (retired / alias / unused / unimplemented). The wave-143 defect it hunts: CONNECTOR_REGISTRY.d_id declared
 * `D_ID_API_KEY` — a name no client, probe, matrix or example file used (they all say DID_API_KEY), so the adapter
 * declaration and the provider-posture env map named a variable an operator would never set.
 */
function declaredButNeverObtained(registryNames: Iterable<string>, directReads: ReadonlyMap<string, number>, meta: Record<string, Meta>): string[] {
  const out: string[] = []
  for (const n of new Set(registryNames)) {
    if ((directReads.get(n) ?? 0) > 0) continue
    const m = meta[n]
    if (m && (m.via || (m.req && EXEMPT_FROM_DIRECT_READ.has(m.req)))) continue
    out.push(n)
  }
  return out.sort()
}
/** A NEXT_PUBLIC_ name whose spelling says secret. Only a hard-gated DEV-ONLY demo value may be one. */
function publicSecretShaped(names: Iterable<string>, meta: Record<string, Meta>): string[] {
  return [...names].filter((n) => /^NEXT_PUBLIC_/.test(n) && /SECRET|PRIVATE|TOKEN|PASSWORD|SERVICE_ROLE/.test(n) && meta[n]?.req !== "DEV-ONLY").sort()
}
/** `.env.example` lines that assign a VALUE to a name that is not a classified non-secret config default. */
function valuedCredentialAssignments(example: string, meta: Record<string, Meta>): string[] {
  const out: string[] = []
  for (const raw of example.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(\S.*)$/.exec(raw.trim())
    if (!m) continue
    const info = meta[m[1]]
    if (!info || info.kind !== "config" || secretShapedLiterals(m[2]).length > 0) out.push(m[1])
  }
  return out.sort()
}
/** The dev-only bypass is gated OFF in production in the source that reads it. */
function gatedOffInProduction(codeWithStrings: string, name: string): boolean {
  const at = codeWithStrings.indexOf(name)
  if (at < 0) return false
  const win = codeWithStrings.slice(Math.max(0, at - 220), at + 220)
  return /NODE_ENV\s*!==\s*["']production["']/.test(win) || /VERCEL_ENV\s*!==\s*["']production["']/.test(win)
    || (/NODE_ENV\s*===\s*["']production["']/.test(win) && /!==\s*["']true["']/.test(win))
}
const SECRET_SHAPES: ReadonlyArray<[string, RegExp]> = [
  ["stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["stripe webhook secret", /\bwhsec_[A-Za-z0-9]{16,}/],
  ["aws access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["sendgrid key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ["twilio account sid", /\bAC[a-f0-9]{32}\b/],
  ["slack token", /\bxox[abp]-[A-Za-z0-9-]{10,}/],
  ["bearer token", /\bBearer [A-Za-z0-9._-]{24,}/],
  ["long hex (≥48)", /\b[a-f0-9]{48,}\b/],
]
function secretShapedLiterals(text: string): string[] {
  return SECRET_SHAPES.filter(([, re]) => re.test(text)).map(([label]) => label)
}
/** Extract the GENERATED block `id` from a document, or null. */
function docBlock(md: string, id: string): string | null {
  const m = new RegExp(`<!-- GENERATED:${id}:BEGIN -->\\n([\\s\\S]*?)\\n<!-- GENERATED:${id}:END -->`).exec(md)
  return m ? m[1] : null
}
function replaceBlock(md: string, id: string, body: string): string {
  return md.replace(new RegExp(`(<!-- GENERATED:${id}:BEGIN -->\\n)[\\s\\S]*?(\\n<!-- GENERATED:${id}:END -->)`), (_m, a, b) => `${a}${body}${b}`)
}
/** SQL statements with `--` comments removed (a `--` inside a quoted literal truncates that line: published blind spot). */
function sqlStatements(sql: string): string[] {
  const code = sql.split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l }).join("\n")
  return code.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)
}
/** The kinds a lane-143H migration may contain: a guarded UPDATE, ALTER COLUMN, COMMENT. Never a DROP / DELETE / TRUNCATE / INSERT. */
function migrationViolations(sql: string): string[] {
  const out: string[] = []
  for (const s of sqlStatements(sql)) {
    if (/^(DROP|DELETE|TRUNCATE|INSERT|GRANT|REVOKE|CREATE)\b/i.test(s)) out.push(`forbidden statement: ${s.slice(0, 60)}`)
    else if (/^UPDATE\b/i.test(s) && !/\bWHERE\b/i.test(s)) out.push(`UPDATE without WHERE: ${s.slice(0, 60)}`)
    else if (/^ALTER TABLE\b/i.test(s) && /\bDROP\s+(COLUMN|CONSTRAINT|TABLE)\b/i.test(s)) out.push(`destructive ALTER: ${s.slice(0, 60)}`)
    else if (!/^(UPDATE|ALTER TABLE|COMMENT ON)\b/i.test(s)) out.push(`unrecognised statement: ${s.slice(0, 60)}`)
  }
  return out
}
interface ChecklistStep { id: string; title: string; hasOwnerAction: boolean; hasVerify: boolean }
interface ChecklistParse { sections: string[]; steps: ChecklistStep[] }
function parseChecklist(md: string): ChecklistParse {
  const sections: string[] = []
  const steps: ChecklistStep[] = []
  let cur: ChecklistStep | null = null
  for (const line of md.split("\n")) {
    const sec = /^## (\d+)\. (.+)$/.exec(line)
    if (sec) { sections.push(sec[2].trim()); cur = null; continue }
    const st = /^### (\d+\.\d+) (.+)$/.exec(line)
    if (st) { cur = { id: st[1], title: st[2].trim(), hasOwnerAction: false, hasVerify: false }; steps.push(cur); continue }
    if (cur && /^- \*\*(Owner action|Operator action):\*\*/.test(line)) cur.hasOwnerAction = true
    if (cur && /^- \*\*Verify:\*\*\s*\S/.test(line)) cur.hasVerify = true
  }
  return { sections, steps }
}
const GLOBAL_HEADERS_RE = /source:\s*['"]\/\(\.\*\)['"][\s\S]{0,900}?X-Content-Type-Options[\s\S]{0,120}?nosniff[\s\S]{0,200}?Referrer-Policy[\s\S]{0,120}?strict-origin-when-cross-origin/
const norm = (s: string): string => s.replace(/\s+/g, " ").trim()
const mdCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
const lineNo = (text: string, index: number): number => { let n = 1; for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++; return n }
const lineOfNeedle = (text: string, needle: string | RegExp): number | null => {
  const m = typeof needle === "string" ? (text.indexOf(needle) >= 0 ? { index: text.indexOf(needle) } : null) : needle.exec(text)
  return m ? lineNo(text, m.index) : null
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CENSUS
// ═════════════════════════════════════════════════════════════════════════════
interface Site { file: string; line: number }
interface NameFacts {
  direct: number
  firstDirect: Site | null
  declared: Site | null
  files: Set<string>
}
function relPath(abs: string): string { return relative(ROOT, abs).split(sep).join("/") }

function censusRuntime(): Map<string, NameFacts> {
  const facts = new Map<string, NameFacts>()
  const get = (n: string): NameFacts => { let f = facts.get(n); if (!f) { f = { direct: 0, firstDirect: null, declared: null, files: new Set() }; facts.set(n, f) } return f }
  for (const abs of runtimeFiles(ROOT)) {
    const rel = relPath(abs)
    let src: string
    try { src = readFileSync(abs, "utf8") } catch { continue }
    for (const r of envReadsInSource(src)) { const f = get(r.name); f.direct++; f.files.add(rel); f.firstDirect ??= { file: rel, line: r.line } }
    for (const r of declaredEnvNamesInSource(src)) { const f = get(r.name); f.files.add(rel); f.declared ??= { file: rel, line: r.line } }
  }
  return facts
}

/** Names read by tooling — scripts/, e2e/, root *.config.* — that the deployed app never reads. */
const FIXTURE_NAMES = new Set(["GHOST_VAR", "GHOST_A", "GHOST_B", "GHOST_C", "GHOST_SECRET", "FOO", "X", "OLDVENDOR_API_KEY", "WHY"])
function censusTooling(excludeNames: ReadonlySet<string>): Array<{ name: string; n: number; first: Site }> {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel) }
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) files.push(rel)
    }
  }
  for (const d of ["scripts", "e2e"]) if (has(d)) walk(d)
  for (const f of ["next.config.ts", "remotion.config.ts", "playwright.config.ts"]) if (has(f)) files.push(f)
  const acc = new Map<string, { n: number; first: Site }>()
  for (const rel of files) {
    if (rel.startsWith("scripts/__h143_") || rel === "scripts/operations-docs-guard.ts" || rel === "scripts/operations-docs-data.ts") continue
    let src: string
    try { src = readFileSync(join(ROOT, rel), "utf8") } catch { continue }
    for (const r of envReadsInSource(src)) {
      if (excludeNames.has(r.name) || FIXTURE_NAMES.has(r.name) || /^GHOST_/.test(r.name)) continue
      const cur = acc.get(r.name)
      if (cur) cur.n++
      else acc.set(r.name, { n: 1, first: { file: rel, line: r.line } })
    }
  }
  return [...acc.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name))
}

function documentedSources(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const addAll = (names: Set<string>, label: string): void => { for (const n of names) { const a = out.get(n) ?? []; a.push(label); out.set(n, a) } }
  if (has(".env.example")) addAll(namesFromEnvExample(rd(".env.example")), ".env.example")
  if (has("vercel.json")) addAll(namesFromVercelJson(rd("vercel.json")), "vercel.json")
  if (has(".github/workflows")) {
    for (const e of readdirSync(join(ROOT, ".github/workflows"))) if (/\.ya?ml$/.test(e)) addAll(namesFromWorkflowYaml(rd(`.github/workflows/${e}`)), "workflow")
  }
  return out
}

interface RegistryDecl { names: Map<string, string[]> }
function registryDeclarations(adapters: ProviderAdapter[]): RegistryDecl {
  const names = new Map<string, string[]>()
  const put = (n: string, by: string): void => { if (!/^[A-Z][A-Z0-9_]*$/.test(n)) return; const a = names.get(n) ?? []; if (!a.includes(by)) a.push(by); names.set(n, a) }
  for (const it of buildLaunchChecklist().items) for (const v of it.envVars) put(v, "launch-checklist")
  for (const e of WEBHOOK_CONTRACT) for (const v of e.secretEnv) put(v, "webhook-contract")
  for (const t of PROVIDER_TENANCY) for (const v of t.envVars) put(v, "tenancy-matrix")
  for (const s of Object.values(CONNECTOR_REGISTRY)) if (s.envKey) put(s.envKey, "connector-registry")
  for (const a of adapters) for (const v of a.credential.envVars) put(v, "provider-adapters")
  for (const v of Object.values(PLATFORM_PROVIDER_KEYS)) put(v, "connector-probe")
  for (const v of PLATFORM_ONLY_STRIPE_ENV) put(v, "stripe-account-scope")
  for (const v of Object.values(PLATFORM_WEBHOOK_ENV)) put(v, "stripe-account-scope")
  return { names }
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDERING
// ═════════════════════════════════════════════════════════════════════════════
const TIER_REQ: Record<LaunchTier, Req> = { "launch-blocking": "REQUIRED", "launch-degraded": "DEGRADED", optional: "OPTIONAL" }
const TIER_RANK: Record<LaunchTier, number> = { "launch-blocking": 3, "launch-degraded": 2, optional: 1 }

function launchTiers(): Map<string, LaunchTier> {
  const out = new Map<string, LaunchTier>()
  for (const it of buildLaunchChecklist().items) for (const v of it.envVars) {
    const cur = out.get(v)
    if (!cur || TIER_RANK[it.tier] > TIER_RANK[cur]) out.set(v, it.tier)
  }
  return out
}
const reqFor = (name: string, tiers: Map<string, LaunchTier>): Req => {
  const m = ENV_META[name]
  if (m?.req) return m.req
  const t = tiers.get(name)
  return t ? TIER_REQ[t] : "OPTIONAL"
}
const scopeLabel = (name: string, m: Meta): string => {
  if (m.kind === "provided") return "provided"
  if (/^NEXT_PUBLIC_/.test(name)) return "public (browser bundle, build-time)"
  if (m.kind === "secret") return "server secret"
  if (m.kind === "public") return "public by design"
  return "server config"
}

function renderEnvInventory(ctx: {
  universe: string[]
  facts: Map<string, NameFacts>
  docs: Map<string, string[]>
  tiers: Map<string, LaunchTier>
  tenancy: Map<string, string>
  registry: RegistryDecl
  tooling: Array<{ name: string; n: number; first: Site }>
}): string {
  const { universe, facts, docs, tiers, tenancy, registry, tooling } = ctx
  const L: string[] = []
  const bySys = new Map<SysKey, string[]>()
  for (const n of universe) { const s = ENV_META[n].sys; bySys.set(s, [...(bySys.get(s) ?? []), n]) }
  const reqCounts = new Map<Req, number>()
  for (const n of universe) { const r = reqFor(n, tiers); reqCounts.set(r, (reqCounts.get(r) ?? 0) + 1) }
  const directNames = universe.filter((n) => (facts.get(n)?.direct ?? 0) > 0).length
  const declaredOnly = universe.filter((n) => (facts.get(n)?.direct ?? 0) === 0 && facts.get(n)?.declared).length
  const readSites = [...facts.values()].reduce((a, f) => a + f.direct, 0)

  L.push("### Census (derived — this block is regenerated by `scripts/operations-docs-guard.ts --write`)")
  L.push("")
  L.push(`- **${universe.length}** distinct names in scope: **${directNames}** read directly (\`process.env.X\` and its three other forms, ${readSites} read sites), **${declaredOnly}** obtained only through a config declaration line (computed-key reads), the rest documented in \`.env.example\` / workflows with no read site (CI, tooling, retired, unused).`)
  L.push(`- Requirement mix: ${[...reqCounts.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} ${c}`).join(" · ")}.`)
  L.push(`- Registry cross-check: **${registry.names.size}** credential names are declared by the launch checklist, webhook contract, tenancy matrix, connector registry, provider adapters, probe keys and Stripe scope; every one is in this inventory, documented in \`.env.example\`, and either read by code, named by its computed-key consumer (\`via\`), or carries an explicit disposition.`)
  L.push(`- **Presence in a real Vercel project is NOT readable from this repository and was not probed** (owner ruling: no production configuration access in wave 143). The repo-side facts are below; the live presence check is the owner command in ACTIVATION-CHECKLIST §1 (names only) and the in-product Launch checklist card (\`/dashboard/superadmin/connectors\`, presence-only).`)
  L.push("- **BLIND SPOTS:** a name assembled at runtime has no literal and is invisible; declaration arms read literal keys (`clientIdEnv`, `envKey`, `env_key`, `secretEnv`, `envVars`, `*_ENV` tables) only; a prose mention inside a string literal counts as a read (the census reads strings intact), which is why `VAPI_ISA_ASSISTANT_ID` is listed as RETIRED.")
  L.push("")

  const flagged = (want: Req[]): string[] => universe.filter((n) => want.includes(reqFor(n, tiers)))
  L.push("### Names an operator must NOT set in Production, or must set the survivor instead")
  L.push("")
  L.push("| Name | Disposition | What to do |")
  L.push("|---|---|---|")
  for (const n of flagged(["DEV-ONLY", "ALIAS", "RETIRED", "UNUSED", "UNIMPLEMENTED"])) {
    const m = ENV_META[n]
    const r = reqFor(n, tiers)
    const todo = r === "DEV-ONLY" ? "Keep UNSET in Production (the code hard-gates it; the guard proves the gate)."
      : r === "ALIAS" ? `Set \`${m.alias}\` instead.`
      : r === "RETIRED" ? "Inert — do not set. Safe to delete from an old Vercel project."
      : r === "UNUSED" ? "Nothing reads it. Leave unset."
      : "The lane refuses honestly (no third-party API is offered). Leave unset."
    L.push(`| \`${n}\` | ${r} | ${mdCell(todo)} |`)
  }
  L.push("")

  for (const key of Object.keys(SYSTEMS) as SysKey[]) {
    const names = bySys.get(key)
    if (!names?.length) continue
    const info = SYSTEMS[key]
    L.push(`### ${info.title}`)
    L.push("")
    L.push(`- **Owner:** ${info.owner}`)
    L.push(`- **Where obtained:** ${info.obtain}`)
    L.push(`- **Verified by:** ${info.verify}`)
    L.push("")
    L.push("| Name | Requirement | Scope | Tenancy (matrix) | Purpose | Repo reads | Documented |")
    L.push("|---|---|---|---|---|---|---|")
    for (const n of names.sort()) {
      const m = ENV_META[n]
      const f = facts.get(n)
      const reads = f && f.direct > 0 ? `${f.direct} @ ${f.firstDirect!.file}:${f.firstDirect!.line}` : f?.declared ? `declared @ ${f.declared.file}:${f.declared.line}` : "none"
      const doc = (docs.get(n) ?? []).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "—"
      L.push(`| \`${n}\` | ${reqFor(n, tiers)} | ${scopeLabel(n, m)} | ${tenancy.get(n) ?? "platform"} | ${mdCell(m.purpose)} | ${reads} | ${doc} |`)
    }
    L.push("")
  }

  L.push("### Tooling and guard switches (read by `scripts/`, `e2e/`, `*.config.ts` — never by the deployed app)")
  L.push("")
  const group = (n: string): string =>
    /BASELINE$|^UPDATE_|REBASELINE|_AS_LIBRARY$|^GUARD_|VERBOSE|_STAMP$|_REPORT$|_OUT$/.test(n) ? "guard switch"
    : /^(CI|E2E_BASE_URL|UI_SMOKE_BASE_URL|NEXT_RUNTIME)$/.test(n) ? "CI / runner"
    : /LIVE|^RUN_|^TEST_|SMOKE_DRILL|_CHILD$/.test(n) ? "live-test / child-process switch"
    : "tooling input (a credential or id a script reads)"
  const groups = new Map<string, string[]>()
  for (const t of tooling) groups.set(group(t.name), [...(groups.get(group(t.name)) ?? []), `\`${t.name}\` ×${t.n}`])
  for (const [g, items] of [...groups.entries()].sort()) L.push(`- **${g}** (${items.length}): ${items.join(", ")}`)
  L.push("")
  L.push("Scripts that read a credential name (for example `SUPABASE_SERVICE_ROLE_KEY`) read it from the developer's or CI's shell; none of them runs in production.")
  return L.join("\n")
}

/** The proof corpus: every .ts under scripts/ and scripts/canaries (this lane's own files excluded), comments blanked. */
function loadProofCorpus(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const dir of ["scripts", "scripts/canaries"]) {
    if (!has(dir)) continue
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (!e.isFile() || !/\.ts$/.test(e.name)) continue
      const file = `${dir}/${e.name}`
      if (/^scripts\/(__h143_|operations-docs-)/.test(file)) continue
      out.push({ file, text: blankComments(rd(file)) })
    }
  }
  return out
}
/** Needles that name one provider precisely: its quoted key/aliases/service keys, its credential env names, its host. */
function providerNeedles(a: ProviderAdapter): string[] {
  const keys = [a.provider, ...a.aliases, ...a.health.serviceKeys].filter((k) => k.length >= 3)
  const needles = new Set<string>()
  for (const k of keys) { needles.add(`"${k}"`); needles.add(`'${k}'`) }
  for (const v of a.credential.envVars) needles.add(v)
  try { const h = new URL(a.api.baseUrl).hostname; if (h.includes(".")) needles.add(h) } catch { /* no base URL */ }
  return [...needles]
}
/** The scripts that name the provider, most mentions first — a pointer for the reader, NOT a coverage claim. */
function scriptsNaming(a: ProviderAdapter, corpus: Array<{ file: string; text: string }>): Array<{ file: string; n: number }> {
  const needles = providerNeedles(a)
  const out: Array<{ file: string; n: number }> = []
  for (const c of corpus) {
    let n = 0
    for (const nd of needles) { let from = 0; for (;;) { const i = c.text.indexOf(nd, from); if (i < 0) break; n++; from = i + nd.length } }
    if (n > 0) out.push({ file: c.file, n })
  }
  return out.sort((x, y) => y.n - x.n || x.file.localeCompare(y.file))
}

function renderProviderBlocks(adapters: ProviderAdapter[]): { contracts: string; costRouting: string; doors: string } {
  const corpus = loadProofCorpus()
  const sorted = [...adapters].sort((a, b) => a.provider.localeCompare(b.provider))
  const C: string[] = []
  C.push(`**${adapters.length} adapters** derived from the route tables (\`deriveProviderAdapters\`, lib/kernel/provider-adapters.ts) — lifecycle mix: ${["live", "inbound_only", "vocabulary_only", "unimplemented"].map((k) => `${k} ${adapters.filter((a) => a.lifecycle === k).length}`).join(" · ")}. \`validateAdapterSet\` refusals: **${validateAdapterSet({ adapters, missing: [], unrouted: [] }).length}**.`)
  const live = adapters.filter((a) => a.lifecycle === "live")
  C.push(`Of the ${live.length} live adapters: **${live.filter((a) => a.api.contractSource.length > 0).length}** carry a base URL verified against the vendor's own documentation or SDK (\`contractSource\`), **${live.filter((a) => a.api.docsUrl).length}** name an official docs root, **${live.filter((a) => a.credential.survivor === "platform_env").length}** are reached with a platform env key, **${live.filter((a) => a.credential.survivor === "tenant_connection").length}** with a tenant's own connection, **${live.filter((a) => a.credential.survivor === "keyless").length}** need no credential. **No provider API was called to produce this table** — it is the registry plus the vendor documentation URLs, nothing live.`)
  C.push("")
  C.push("| Provider | Lifecycle | Transport · version | Base URL | Credential model | Credential env (names only) | Vendor docs | Contract verified against |")
  C.push("|---|---|---|---|---|---|---|---|")
  for (const a of sorted) {
    const cred = a.credential.survivor === "platform_env" ? "platform env key" : a.credential.survivor === "tenant_connection" ? "tenant connection (encrypted row)" : "keyless"
    C.push(`| ${a.provider} | ${a.lifecycle} | ${mdCell(`${a.api.transport} · ${a.api.version}`)} | ${mdCell(a.api.baseUrl || "—")} | ${cred} | ${a.credential.envVars.map((v) => `\`${v}\``).join(", ") || "—"} | ${a.api.docsUrl ? `[docs](${a.api.docsUrl})` : `none (${mdCell(a.api.urlNote ?? "unverified")})`} | ${a.api.contractSource.length ? `vendor docs (${a.api.contractSource.length})` : "registry only"} |`)
  }
  const R: string[] = []
  const priceStates = new Map<string, string[]>()
  for (const a of adapters) priceStates.set(a.cost.priceState, [...(priceStates.get(a.cost.priceState) ?? []), a.provider])
  R.push(`Price state mix: ${[...priceStates.entries()].sort((x, y) => y[1].length - x[1].length).map(([s, p]) => `${s} ${p.length}`).join(" · ")}. **Unknown** (declared, never $0-by-default): ${(priceStates.get("unknown") ?? []).join(", ") || "none"}. Live health probes: ${adapters.filter((a) => a.health.liveProbe).map((a) => a.provider).join(", ")}. Outside the rails with a published reason: ${adapters.filter((a) => a.route.exception).map((a) => a.provider).join(", ")}.`)
  R.push("")
  const named = sorted.map((a) => ({ a, hits: scriptsNaming(a, corpus) }))
  R.push(`Scripts under \`scripts/\` that name each provider (its quoted key, aliases, credential env names or host; comments blanked): **${named.filter((x) => x.hits.length === 0).length}** of ${adapters.length} adapters are named by **no** script at all — ${named.filter((x) => x.hits.length === 0).map((x) => x.a.provider).join(", ") || "none"}. A mention is a pointer for the reader, **not** a response-mapping coverage claim.`)
  R.push("")
  R.push("| Provider | Payer | Price state · unit | Ledger | Booking | Health probe | Fallback (route-table order) | Route paths | Outside the rails | Scripts naming it (count · top 3) |")
  R.push("|---|---|---|---|---|---|---|---|---|---|")
  for (const { a, hits } of named) {
    const fb = Object.entries(a.fallback).map(([cap, p]) => `${cap}→${p.join(">") || "—"}`).join("; ") || "—"
    const top = hits.slice(0, 3).map((h) => h.file.replace(/^scripts\//, "")).join(", ")
    R.push(`| ${a.provider} | ${a.cost.payer} | ${a.cost.priceState}${a.cost.unitUsd ? ` · $${a.cost.unitUsd}/${mdCell(a.cost.unit)}` : ""} | ${a.cost.ledger} | ${mdCell(a.cost.booking)} | ${a.health.liveProbe ? "live probe" : "ledger-derived only"} | ${mdCell(fb)} | ${a.route.paths.join(", ") || "—"} | ${a.route.exception ? mdCell(a.route.exception) : "—"} | ${hits.length ? `${hits.length} · ${top}` : "**none**"} |`)
  }
  const D: string[] = []
  const blind = WEBHOOK_CONTRACT.filter((e) => !e.failureVisibility).length
  D.push(`**${WEBHOOK_CONTRACT.length} contracted webhook doors** (\`WEBHOOK_CONTRACT\`, lib/providers/webhook-contract.ts:101); every one is signature- or secret-verified (readiness census W). **${blind}** have no declared failure visibility (a delivery failure there is blind to the platform — see PROVIDER-CERTIFICATION §Findings).`)
  D.push("")
  D.push("| Provider · event | Path | Verification | Secret env (names only) | Where the human pastes the URL | Failure visible to the platform |")
  D.push("|---|---|---|---|---|---|")
  for (const e of WEBHOOK_CONTRACT) {
    D.push(`| ${e.provider} · ${e.eventKind} | \`${e.path}\` | ${e.scheme} | ${e.secretEnv.map((v) => `\`${v}\``).join(", ") || "— (secretless / per-tenant)"} | ${mdCell(e.consoleField)} | ${e.failureVisibility ? mdCell(e.failureVisibility) : "**no — blind**"} |`)
  }
  return { contracts: C.join("\n"), costRouting: R.join("\n"), doors: D.join("\n") }
}

function maxDurationCensus(): { total: number; histogram: Array<[number, number]>; above300: string[]; routes: number; pages: number } {
  const hist = new Map<number, number>()
  const above: string[] = []
  let routes = 0
  let pages = 0
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { walk(rel); continue }
      const isRoute = /^route\.(ts|tsx)$/.test(e.name)
      const isPage = /^page\.(ts|tsx)$/.test(e.name)
      if (isRoute) routes++
      if (isPage) pages++
      if (!isRoute && !isPage) continue
      const src = blankComments(rd(rel))
      const m = /export const maxDuration\s*=\s*(\d+)/.exec(src)
      if (m) { const n = Number(m[1]); hist.set(n, (hist.get(n) ?? 0) + 1); if (n > 300) above.push(`${rel} (${n}s)`) }
    }
  }
  walk("app")
  return { total: [...hist.values()].reduce((a, b) => a + b, 0), histogram: [...hist.entries()].sort((a, b) => a[0] - b[0]), above300: above.sort(), routes, pages }
}

function renderHostingFacts(): string {
  const vercel = JSON.parse(rd("vercel.json")) as { buildCommand?: string; installCommand?: string; functions?: Record<string, { memory?: number; maxDuration?: number; includeFiles?: string }>; crons?: Array<{ path: string; schedule: string }> }
  const vText = rd("vercel.json")
  const next = blankComments(rd("next.config.ts"))
  const nextRaw = rd("next.config.ts")
  const proxy = blankComments(rd("proxy.ts"))
  const pkg = JSON.parse(rd("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: unknown; packageManager?: string }
  const dep = (n: string): string => pkg.dependencies?.[n] ?? pkg.devDependencies?.[n] ?? "?"
  const md = maxDurationCensus()
  const distinct = new Set(CRON_REGISTRY.map((c) => c.path.split("?")[0]))
  const cronSrc = rd("lib/kernel/cron-dispatch.ts")
  const fanout = /AbortSignal\.timeout\((\d[\d_]*)\)/.exec(cronSrc)
  const mig = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort()
  const num = (f: string): number => Number(/^m(\d+)-/.exec(f)?.[1] ?? 0)
  const highest = mig.reduce((a, f) => Math.max(a, num(f)), 0)
  const notApplied = mig.filter((f) => claimOf(rd(`supabase/migrations/${f}`)) === "not_applied")
  const pub = Object.entries(LIVE_BUCKET_CONFIG).filter(([, c]) => c.isPublic).map(([k]) => k).sort()
  const priv = Object.entries(LIVE_BUCKET_CONFIG).filter(([, c]) => !c.isPublic).map(([k]) => k).sort()
  const globalHeaders = /source:\s*['"]\/\(\.\*\)['"][\s\S]{0,200}?headers:\s*\[([\s\S]*?)\]\s*,?\s*\}/.exec(next)?.[1] ?? ""
  const headerKeys = [...globalHeaders.matchAll(/key:\s*['"]([A-Za-z-]+)['"]/g)].map((m) => m[1])
  const widgetCsp = /frame-ancestors \*/.test(next)
  const proxyFrame = /frame-ancestors \$\{allowed\.join/.test(proxy) || /frame-ancestors/.test(proxy)
  const L = (file: string, needle: string | RegExp, text?: string): string => { const n = lineOfNeedle(text ?? rd(file), needle); return n ? `${file}:${n}` : file }
  const rows: string[] = []
  rows.push("| Fact | Reading (derived) | Source |")
  rows.push("|---|---|---|")
  rows.push(`| Framework | Next.js ${dep("next")} (App Router) · React ${dep("react")} · build uses webpack (\`next build --webpack\`) | package.json, ${L("vercel.json", "buildCommand", vText)} |`)
  rows.push(`| Build command | \`${mdCell(vercel.buildCommand ?? "—")}\` | ${L("vercel.json", "buildCommand", vText)} |`)
  rows.push(`| Lockfile policy | \`--no-frozen-lockfile\` in BOTH install and build: **a deployment may resolve different dependency versions than CI tested** (finding F-1) | ${L("vercel.json", "installCommand", vText)} |`)
  rows.push(`| Type-checking at build | \`typescript.ignoreBuildErrors: true\` — type safety is the CI \`type-check\` gate, NOT the Vercel build | ${L("next.config.ts", "ignoreBuildErrors", nextRaw)} |`)
  rows.push(`| Runtime pin | ${pkg.engines ? "engines set" : "no \`engines\`, no .nvmrc — the Node version is the Vercel project setting (finding F-2)"}; package manager ${pkg.packageManager ?? "unpinned (pnpm used by vercel.json, npm lockfile also present)"} | package.json |`)
  rows.push(`| Route handlers / pages | ${md.routes} \`route.ts\` handlers · ${md.pages} \`page.tsx\` pages under app/ | app/ |`)
  rows.push(`| Function overrides | ${Object.keys(vercel.functions ?? {}).length} routes with explicit memory/duration: ${Object.entries(vercel.functions ?? {}).map(([k, v]) => `\`${k.replace(/^app\/api\//, "").replace(/\/route\.ts$/, "")}\` ${v.memory ?? "default"} MB · ${v.maxDuration ?? "default"} s`).join("; ")} | ${L("vercel.json", '"functions"', vText)} |`)
  rows.push(`| Per-route \`maxDuration\` | ${md.total} routes declare one: ${md.histogram.map(([s, c]) => `${s}s ×${c}`).join(" · ")}. **Above 300 s: ${md.above300.length ? md.above300.join(", ") : "none"}** — a duration above the plan's default needs Fluid compute / Pro limits (verify in the project; ACTIVATION-CHECKLIST §1) | app/**/route.ts |`)
  rows.push(`| Platform crons | ${(vercel.crons ?? []).map((c) => `\`${c.path}\` \`${c.schedule}\``).join(", ") || "none"} — ONE per-minute cron (a per-minute schedule needs a plan that allows it) | ${L("vercel.json", '"crons"', vText)} |`)
  rows.push(`| Cron registry | ${CRON_REGISTRY.length} registry entries over ${distinct.size} distinct routes, fanned out by the dispatcher | ${L("lib/kernel/cron-dispatch.ts", "export const CRON_REGISTRY", cronSrc)} |`)
  rows.push(`| Cron fan-out timeout | each target fetch aborts after **${fanout ? Number(fanout[1].replace(/_/g, "")) / 1000 : "?"} s**, but ${md.histogram.filter(([s]) => s > 55).reduce((a, [, c]) => a + c, 0)} routes declare \`maxDuration\` above that: a long-running target is reported as a dispatch FAILURE ("timeout") while it keeps running (log noise, not lost work; finding F-3) | ${L("lib/kernel/cron-dispatch.ts", "AbortSignal.timeout", cronSrc)} |`)
  rows.push(`| Cron self-call origin | \`CRON_DISPATCH_BASE_URL\` → \`VERCEL_PROJECT_PRODUCTION_URL\` → \`VERCEL_URL\`; Deployment Protection on the chosen host would answer the dispatcher with a Vercel page, not the route (verify \`dispatched = due\`) | ${L("lib/kernel/cron-dispatch.ts", "CRON_DISPATCH_BASE_URL", cronSrc)} |`)
  rows.push(`| Webhook doors | ${WEBHOOK_CONTRACT.length} contracted; ${WEBHOOK_CONTRACT.filter((e) => !e.failureVisibility).length} with no declared failure visibility | lib/providers/webhook-contract.ts:101 |`)
  rows.push(`| Background work | Vercel Workflow (\`withWorkflow\` wraps the Next config; \`workflows/\` holds ${has("workflows") ? readdirSync(join(ROOT, "workflows")).length : 0} file(s)); durable queues live in Postgres and are drained by the cron registry | ${L("next.config.ts", /withWorkflow\(/, nextRaw)} |`)
  rows.push(`| Media storage | Supabase Storage, ${Object.keys(LIVE_BUCKET_CONFIG).length} live buckets — public: ${pub.map((b) => `\`${b}\``).join(", ")}; private: ${priv.map((b) => `\`${b}\``).join(", ")}. No Vercel Blob. Remotion output is hosted via \`hostRenderedMedia\` | lib/storage/bucket-limits.ts:46 |`)
  rows.push(`| Tenant routing | \`proxy.ts\` (edge middleware) classifies public/protected paths, rewrites white-label custom domains and sets per-tenant \`frame-ancestors\`; baseline tenant site = path \`/site/<slug>\` (${has("app/site/[slug]") ? "present" : "ABSENT"}); no wildcard subdomain (readiness B9b UNSUPPORTED) | proxy.ts, lib/platform/custom-domains.ts |`)
  rows.push(`| Domains / SSL | Custom domains attach through the Vercel domains API (needs \`VERCEL_TOKEN\` + \`VERCEL_PROJECT_ID\`); certificates are issued by Vercel once DNS verifies; the app only records \`pending_dns → verifying → active\` | lib/platform/custom-domains.ts:437 |`)
  rows.push(`| Security headers (global) | ${headerKeys.length ? headerKeys.join(", ") : "none"} on \`/(.*)\`; widget routes add a \`frame-ancestors *\` CSP (${widgetCsp ? "present" : "absent"}); \`proxy.ts\` sets per-tenant \`frame-ancestors\` (${proxyFrame ? "present" : "absent"}). **No site-wide CSP and no explicit HSTS from the app** — HSTS is the Vercel edge default (verify with \`curl -sI\`) | ${L("next.config.ts", "async headers", nextRaw)} |`)
  rows.push(`| Observability | \`@vercel/analytics\` ${has("app/layout.tsx") && /@vercel\/analytics/.test(rd("app/layout.tsx")) ? "mounted" : "NOT mounted"} · \`collectError\` → \`automation_errors\` · connector health from \`api_response_logs\` · root \`app/error.tsx\` ${has("app/error.tsx") ? "present" : "ABSENT"} · app/global-error.tsx ${has("app/global-error.tsx") ? "present" : "ABSENT"} · instrumentation.ts ${has("instrumentation.ts") ? "present" : "ABSENT"} (R-5 stays open) | app/layout.tsx, lib/errors/collect-error.ts:115 |`)
  rows.push(`| Liveness endpoint | ${has("app/api/health/route.ts") ? "present" : "**none** — no unauthenticated health route exists for an external uptime monitor (finding F-4); \`/api/admin/health-status\` is gated"} | app/api/ |`)
  rows.push(`| Database access | PostgREST only (supabase-js over HTTPS; no \`DATABASE_URL\`, no pooled connection string in code) — no connection-pool exhaustion mode from serverless fan-out | lib/supabase/service.ts:4 |`)
  rows.push(`| Migrations | ${mig.length} files, highest m${highest}; **${notApplied.length}** headers claim WRITTEN, NOT APPLIED (${notApplied.map((f) => f.split("-")[0]).join(", ")}). Applied by the integrator through the Supabase MCP, never by CI or Vercel | supabase/migrations/ |`)
  rows.push(`| Live schema cache | ${LIVE_TABLES.length} relations in \`scripts/live-tables.ts\` (a cache of the live database; regenerate, never hand-edit) | scripts/live-tables.ts:33 |`)
  return rows.join("\n")
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[operations-docs-guard — wave 143, lane 143H]")

// ── positive controls first: a finder that cannot see its defect reads as a clean tree ──
console.log("\nPOSITIVE CONTROLS")
check("unclassified-name finder: a name with no row is reported", unclassifiedNames(["REAL", "GHOST"], { REAL: {} }).join() === "GHOST")
check("phantom-row finder: a row naming nothing is reported", phantomRows(["REAL"], { REAL: {}, STALE: {} }).join() === "STALE")
{
  const meta = { VIA: { sys: "core", kind: "secret", purpose: "x", via: "a.ts" } as Meta, GONE: { sys: "core", kind: "secret", purpose: "x", req: "RETIRED" } as Meta }
  const reads = new Map<string, number>([["READ", 3]])
  check("declared-never-obtained finder: the D_ID_API_KEY shape (declared by a registry, read by nothing, no disposition) is caught; a read, a via and an explicit disposition are not",
    declaredButNeverObtained(["D_ID_API_KEY", "READ", "VIA", "GONE"], reads, meta).join() === "D_ID_API_KEY")
}
check("public-secret finder: a NEXT_PUBLIC_*_SECRET is caught; a DEV-ONLY demo password and an ordinary public key are not",
  publicSecretShaped(["NEXT_PUBLIC_X_SECRET", "NEXT_PUBLIC_DEMO_PASSWORD", "NEXT_PUBLIC_SUPABASE_URL"], { NEXT_PUBLIC_DEMO_PASSWORD: { sys: "core", kind: "public", purpose: "", req: "DEV-ONLY" } }).join() === "NEXT_PUBLIC_X_SECRET")
check("production-gate finder: a bypass guarded by NODE_ENV !== 'production' is gated; an unguarded one is not",
  gatedOffInProduction('const d = process.env.NODE_ENV !== "production" && process.env.SKIP_X === "true"', "SKIP_X") && !gatedOffInProduction('const d = process.env.SKIP_X === "true"', "SKIP_X"))
{
  const live = "sk_" + "live_" + "a".repeat(24)
  const jwt = ["eyJ" + "a".repeat(24), "b".repeat(14), "c".repeat(14)].join(".")
  check("secret-shape finder: a Stripe key, a JWT and a 64-hex string are caught; ordinary prose and an 8-char commit are not",
    secretShapedLiterals(live).length === 1 && secretShapedLiterals(jwt).includes("jwt") && secretShapedLiterals("f".repeat(64)).includes("long hex (≥48)")
    && secretShapedLiterals("see commit 21da8e4e and STRIPE_SECRET_KEY=").length === 0)
}
check("generated-block extractor/replacer round-trips and detects drift", (() => {
  const doc = "a\n<!-- GENERATED:t:BEGIN -->\nOLD\n<!-- GENERATED:t:END -->\nb"
  return docBlock(doc, "t") === "OLD" && docBlock(replaceBlock(doc, "t", "NEW"), "t") === "NEW" && docBlock(doc, "missing") === null
})())
check("SQL statement reader drops comments and splits statements", sqlStatements("-- c\nUPDATE a SET b = 1 WHERE c;\n-- DROP TABLE x;\nALTER TABLE a ALTER COLUMN b DROP NOT NULL;").length === 2)
check("migration census: a DROP, a DELETE, an UPDATE without WHERE and a DROP COLUMN are refused; a guarded UPDATE and ALTER COLUMN are not",
  migrationViolations("DROP INDEX x; DELETE FROM t WHERE a; UPDATE t SET a = 1; ALTER TABLE t DROP COLUMN c;").length === 4
  && migrationViolations("UPDATE t SET a = 1 WHERE b = 2; ALTER TABLE t ALTER COLUMN a DROP NOT NULL; COMMENT ON COLUMN t.a IS 'x';").length === 0)
check("checklist parser: sections, steps, owner action and verify are read; a step with no Verify is reported",
  (() => { const p = parseChecklist("## 1. A\n### 1.1 One\n- **Owner action:** x\n- **Verify:** y\n### 1.2 Two\n- **Owner action:** x\n"); return p.sections.length === 1 && p.steps.length === 2 && p.steps[0].hasVerify && !p.steps[1].hasVerify })())

check("proof-naming finder: a provider named in a proof script (quoted key, env name or host) is found; one named nowhere is not; a comment mention does not count",
  (() => {
    const fake = { provider: "acmeleads", aliases: [], health: { serviceKeys: [] }, credential: { envVars: ["ACMELEADS_API_KEY"] }, api: { baseUrl: "https://api.acmeleads.example/v1" } } as unknown as ProviderAdapter
    const corpus = [{ file: "scripts/a.ts", text: blankComments('const k = "acmeleads"\n// "other" ACMELEADS_API_KEY in a comment\n') }, { file: "scripts/b.ts", text: blankComments("// acmeleads only in a comment\nconst x = 1\n") }]
    const none = { ...fake, provider: "ghostco", credential: { envVars: [] }, api: { baseUrl: "https://ghostco.example" } } as unknown as ProviderAdapter
    return scriptsNaming(fake, corpus).length === 1 && scriptsNaming(none, corpus).length === 0
  })())

// ── 1. ENV ───────────────────────────────────────────────────────────────────
console.log("\nA. ENVIRONMENT INVENTORY")
const facts = censusRuntime()
const docs = documentedSources()
const tiers = launchTiers()
const derived = deriveProviderAdapters()
const adapters = derived.adapters
const registry = registryDeclarations(adapters)
const universe = [...new Set([...facts.keys(), ...docs.keys(), ...registry.names.keys()])].sort()
const directReads = new Map<string, number>([...facts.entries()].map(([k, v]) => [k, v.direct]))

check(`every name the code reads, declares or documents has an ENV_META row (${universe.length} names)`, unclassifiedNames(universe, ENV_META).length === 0, `unclassified: ${unclassifiedNames(universe, ENV_META).join(", ")}`)
check(`no ENV_META row names something absent from the code, the example file, the workflows and every registry (${Object.keys(ENV_META).length} rows)`, phantomRows(universe, ENV_META).length === 0, `phantom: ${phantomRows(universe, ENV_META).join(", ")}`)
const undocumentedRegistry = [...registry.names.keys()].filter((n) => !docs.has(n)).sort()
check(`every credential name a registry declares (${registry.names.size}) has a documented source (.env.example / workflow)`, undocumentedRegistry.length === 0, `undocumented: ${undocumentedRegistry.join(", ")}`)
const neverObtained = declaredButNeverObtained(registry.names.keys(), directReads, ENV_META)
check("every registry-declared credential name is read by code, named by its computed-key consumer, or carries an explicit disposition (no D_ID_API_KEY-shaped orphan)", neverObtained.length === 0, `declared, never obtained: ${neverObtained.join(", ")}`)
const publicSecrets = publicSecretShaped(universe, ENV_META)
check("no secret-shaped NEXT_PUBLIC_ name is inlined into the browser bundle except a hard-gated DEV-ONLY demo value", publicSecrets.length === 0, publicSecrets.join(", "))
{
  const conflicts: string[] = []
  for (const n of universe) {
    const m = ENV_META[n]; const t = tiers.get(n)
    if (!m?.req || !t) continue
    if (t === "launch-blocking" && m.req !== "REQUIRED") conflicts.push(`${n}: launch-blocking but ${m.req}`)
    if (t === "launch-degraded" && !["DEGRADED", "REQUIRED"].includes(m.req)) conflicts.push(`${n}: launch-degraded but ${m.req}`)
    if (m.req === "ALIAS" && !m.alias) conflicts.push(`${n}: ALIAS with no survivor`)
    if (m.req === "ALIAS" && m.alias && !(m.alias in ENV_META)) conflicts.push(`${n}: ALIAS survivor ${m.alias} has no row`)
  }
  check("a curated requirement never contradicts the launch checklist tier (one vocabulary), and every ALIAS names a classified survivor", conflicts.length === 0, conflicts.join("; "))
}
{
  const gates: Array<[string, string, string]> = [
    ["NEXT_PUBLIC_DEMO_MODE", "app/constants/auth.ts", "demo sign-in"],
    ["NEXT_PUBLIC_DEMO_PASSWORD", "app/constants/auth.ts", "demo password"],
    ["INBOUND_SKIP_SIG_VERIFY", "lib/providers/inbound-router.ts", "inbound signature bypass"],
    ["ALLOW_PROD_MAINTENANCE_ROUTES", "lib/auth/require-admin-maintenance-access.ts", "maintenance routes"],
  ]
  const ungated = gates.filter(([name, file]) => !gatedOffInProduction(blankComments(rd(file)), name))
  const devOnly = universe.filter((n) => ENV_META[n]?.req === "DEV-ONLY")
  check(`every DEV-ONLY name the code reads is hard-gated off in production in its own source (${gates.map((g) => g[0]).join(", ")})`, ungated.length === 0 && gates.every(([n]) => devOnly.includes(n)), ungated.map((g) => g[0]).join(", "))
}
{
  // demo password literal: the code default exists; it must stay behind the gate and out of Production.
  const auth = blankComments(rd("app/constants/auth.ts"))
  check("the demo sign-in is ON only outside Production (VERCEL_ENV !== 'production')", /ENABLED:\s*process\.env\.NEXT_PUBLIC_DEMO_MODE === 'true' && process\.env\.VERCEL_ENV !== 'production'/.test(auth))
}
const tooling = censusTooling(new Set(universe))

const inventoryDoc = "docs/operations/ENVIRONMENT-INVENTORY.md"
const tenancyOf = new Map<string, string>()
for (const t of PROVIDER_TENANCY) for (const v of t.envVars) tenancyOf.set(v, t.models.join(" + "))
const envBlock = (unclassifiedNames(universe, ENV_META).length === 0) ? renderEnvInventory({ universe, facts, docs, tiers, tenancy: tenancyOf, registry, tooling }) : ""

// ── 2. PROVIDERS ─────────────────────────────────────────────────────────────
console.log("\nB. PROVIDER CERTIFICATION")
const adapterRefusals = validateAdapterSet(derived)
check(`the adapter set validates (${adapters.length} adapters; ${derived.missing.length} routed-without-declaration, ${derived.unrouted.length} declared-unrouted)`, adapterRefusals.length === 0 && derived.missing.length === 0 && derived.unrouted.length === 0, adapterRefusals.join("; "))
check("every platform-paid live adapter books a usage ledger (no unmetered paid capability)", adapters.filter((a) => a.lifecycle === "live" && a.cost.payer === "platform" && a.cost.priceState !== "free").every((a) => a.cost.ledger !== "free" && a.cost.booking.length > 0))
check("every credential env name any adapter declares is a name nothing contradicts (no adapter credential outside the inventory)", adapters.every((a) => a.credential.envVars.every((v) => v in ENV_META)))
check("every webhook door's secret env names are inventoried", WEBHOOK_CONTRACT.every((e) => e.secretEnv.every((v) => v in ENV_META)))
check("every contracted webhook route file exists", WEBHOOK_CONTRACT.every((e) => has(e.routeFile)), WEBHOOK_CONTRACT.filter((e) => !has(e.routeFile)).map((e) => e.routeFile).join(", "))
const provBlocks = renderProviderBlocks(adapters)
const provDoc = "docs/operations/PROVIDER-CERTIFICATION.md"

// ── 3. HOSTING FACTS ─────────────────────────────────────────────────────────
console.log("\nC. HOSTING FACTS (vercel.json, next.config.ts, proxy.ts, the cron registry)")
{
  const v = JSON.parse(rd("vercel.json")) as { functions?: Record<string, unknown>; crons?: Array<{ path: string; schedule: string }> }
  const fnMissing = Object.keys(v.functions ?? {}).filter((f) => !has(f))
  check("every vercel.json function override names an existing route file", fnMissing.length === 0, fnMissing.join(", "))
  check("vercel.json schedules exactly one platform cron: the dispatcher, every minute", (v.crons ?? []).length === 1 && v.crons![0].path === "/api/cron/dispatch" && v.crons![0].schedule === "* * * * *")
  const registered = new Set(CRON_REGISTRY.map((c) => c.path.split("?")[0]))
  const cronRoutes: string[] = []
  const walk = (dir: string): void => { for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) { const rel = `${dir}/${e.name}`; if (e.isDirectory()) walk(rel); else if (e.name === "route.ts") cronRoutes.push("/" + dir.replace(/^app\//, "")) } }
  walk("app/api/cron")
  const unregistered = cronRoutes.filter((p) => p !== "/api/cron/dispatch" && !registered.has(p))
  check(`every app/api/cron route is in CRON_REGISTRY (${cronRoutes.length - 1} routes, ${unregistered.length} unregistered)`, unregistered.length === 0, unregistered.slice(0, 8).join(", "))
  const next = blankComments(rd("next.config.ts"))
  check("next.config.ts sets nosniff and a Referrer-Policy on every path (source '/(.*)')", GLOBAL_HEADERS_RE.test(next))
  check("POSITIVE CONTROL — the header finder rejects a config with no global source, and accepts one", !GLOBAL_HEADERS_RE.test("headers() { return [{ source: '/widget/:path*', headers: W }] }")
    && GLOBAL_HEADERS_RE.test("headers() { return [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }] }"))
  // The sweep conflation (scripts/dangling-link-sweep.ts:179 reads every `source:` as a redirect): a catch-all '/:path*' header source would turn every path into "served by a redirect".
  check("no headers() source is the catch-all '/:path*' (it would blind scripts/dangling-link-sweep.ts, which reads every `source:` as a redirect)", !/source\s*:\s*['"]\/:path\*['"]/.test(next))
  check("the app still frames-controls per tenant in proxy.ts (frame-ancestors) and the widget routes keep their explicit CSP", /frame-ancestors/.test(blankComments(rd("proxy.ts"))) && /frame-ancestors \*/.test(next))
  check("the demo of absence stays true: no app/global-error.tsx and no instrumentation.ts (R-5) and no app/api/health route (F-4) — if one lands, the facts block and the notes must be updated",
    !has("app/global-error.tsx") && !has("instrumentation.ts") && !has("app/api/health/route.ts"))
}
const archDoc = "docs/architecture/PRODUCTION-ARCHITECTURE.md"
const hostBlock = renderHostingFacts()

// ── 4. OWNER SQL ─────────────────────────────────────────────────────────────
console.log("\nD. OWNER SQL, MIGRATIONS WRITTEN BY THIS LANE")
const ownerSqlDoc = "docs/operations/OWNER-SQL.md"
{
  const mig = (n: number): string | null => readdirSync(join(ROOT, "supabase/migrations")).find((f) => new RegExp(`^m${n}-`).test(f)) ?? null
  const docText = has(ownerSqlDoc) ? norm(rd(ownerSqlDoc)) : ""
  const need: Array<[number, string[]]> = []
  for (const n of [739, 771, 795]) { const f = mig(n); if (f) need.push([n, sqlStatements(rd(`supabase/migrations/${f}`))]) }
  const missing: string[] = []
  for (const [n, stmts] of need) for (const s of stmts) if (!docText.includes(norm(s))) missing.push(`m${n}: ${s.slice(0, 70)}`)
  check(`OWNER-SQL.md carries every statement of m739, m771 and m795 verbatim (${need.reduce((a, [, s]) => a + s.length, 0)} statements)`, has(ownerSqlDoc) && missing.length === 0, missing.join(" | "))
  check("POSITIVE CONTROL — a tampered statement is not found verbatim", !norm("DROP INDEX IF EXISTS public.uq_x;").includes(norm("DROP INDEX IF EXISTS public.uq_y;")))
  check("OWNER-SQL.md states the verification SELECTs and the post-apply regeneration", /pg_constraint|pg_indexes|information_schema/.test(docText) && /schema:regen/.test(docText))

  const m840 = mig(840), m841 = mig(841)
  for (const [label, f] of [["m840", m840], ["m841", m841]] as const) {
    const sql = f ? rd(`supabase/migrations/${f}`) : ""
    // RULE, not a waypoint (CLAUDE.md §2): the file states its status on line 1 — the lane stamp until applied, APPLIED LIVE after
    // (the integrator applied both on 2026-10-24: m840 touched 0 rows, m841 is a nullability change).
    check(`${label}: present and states its status on line 1 (lane stamp or APPLIED LIVE; claimOf agrees)`, !!f && /^-- (WRITTEN, NOT APPLIED \(wave 143, lane 143H\)|── APPLIED LIVE )/.test(sql.split("\n")[0]) && ["applied", "not_applied"].includes(claimOf(sql)))
    check(`${label}: only guarded UPDATE / ALTER COLUMN / COMMENT statements (no DROP INDEX / DROP COLUMN / DELETE / INSERT)`, !!f && migrationViolations(sql).length === 0, f ? migrationViolations(sql).join("; ") : "absent")
  }
  const s840 = m840 ? rd(`supabase/migrations/${m840}`) : ""
  const family = PRELIMINARY_STATEMENT_DOC_TYPES as readonly string[]
  check("m840 rewrites the retired family member INTO the survivor the family reader lists first, and both are members of PRELIMINARY_STATEMENT_DOC_TYPES (reader valid before AND after)",
    family.length === 2 && s840.includes(`doc_type   = '${family[0]}'`) && s840.includes(`WHERE doc_type = '${family[1]}'`))
  const vocab = rd("scripts/check-vocabularies.ts")
  const tdBlock = /\n  transaction_documents: \{([\s\S]*?)\n  \},/.exec(vocab)?.[1] ?? ""
  check("the cached CHECK vocabulary has no transaction_documents.doc_type constraint (m840 cannot be refused by a CHECK) — and the positive control sees `status`", /\bstatus:/.test(tdBlock) && !/\bdoc_type:/.test(tdBlock))
  const snap = rd("scripts/schema-snapshot.ts")
  const gsCols = /\n  global_settings: \[([^\]]*)\]/.exec(snap)?.[1] ?? ""
  const gsVocab = /\n  global_settings: \{([\s\S]*?)\n  \},/.exec(vocab)?.[1] ?? ""
  check("m841 targets the survivor: global_settings.timezone exists in the cached schema and carries no CHECK; brokerages carries no timezone column (no second spelling)",
    /"timezone"/.test(gsCols) && !/\btimezone:/.test(gsVocab) && !/\n  brokerages: \[[^\]]*"timezone"/.test(snap))
}

// ── 5. ACTIVATION CHECKLIST ──────────────────────────────────────────────────
console.log("\nE. ACTIVATION CHECKLIST")
const checklistDoc = "docs/operations/ACTIVATION-CHECKLIST.md"
{
  const ORDER = ["Vercel environment", "Supabase privileged migrations", "Stripe products and prices", "Provider keys", "Tier snapshots", "Launch authorization"]
  const parsed = has(checklistDoc) ? parseChecklist(rd(checklistDoc)) : { sections: [], steps: [] }
  check("the checklist has the six owner-ruled sections, in order", parsed.sections.join("|") === ORDER.join("|"), `found: ${parsed.sections.join(" | ")}`)
  const noVerify = parsed.steps.filter((s) => !s.hasVerify).map((s) => s.id)
  const noAction = parsed.steps.filter((s) => !s.hasOwnerAction).map((s) => s.id)
  check(`every step (${parsed.steps.length}) names an owner/operator action and a verification command or proof`, parsed.steps.length >= 18 && noVerify.length === 0 && noAction.length === 0, `no Verify: ${noVerify.join(",")}; no action: ${noAction.join(",")}`)
  const text = has(checklistDoc) ? rd(checklistDoc) : ""
  const stripeEnv = ["STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_VENDOR_WEBHOOK_SECRET"]
  check("the Stripe section names every Stripe env name and both webhook paths (the 404 trap /api/webhooks/stripe is called out)", stripeEnv.every((n) => text.includes(n)) && text.includes("/api/billing/webhook") && text.includes("/api/webhooks/stripe/vendor"))
  const reqNames = universe.filter((n) => reqFor(n, tiers) === "REQUIRED")
  const missingReq = reqNames.filter((n) => !text.includes(n))
  check(`every REQUIRED environment name (${reqNames.length}) appears in the checklist`, missingReq.length === 0, missingReq.join(", "))
}

// ── 6. NO SECRETS IN DOCS ────────────────────────────────────────────────────
console.log("\nF. HYGIENE")
{
  const targets = [inventoryDoc, provDoc, ownerSqlDoc, checklistDoc, archDoc, ".env.example", "scripts/operations-docs-data.ts"].filter(has)
  const bad = targets.flatMap((t) => secretShapedLiterals(rd(t)).map((l) => `${t}: ${l}`))
  check(`no secret-shaped literal in the ${targets.length} operations documents, the example file or the curated data`, bad.length === 0, bad.join("; "))
  const valued = valuedCredentialAssignments(rd(".env.example"), ENV_META)
  check("no .env.example assignment carries a value unless its name is a classified NON-secret config default (credentials and keys are blank — names only)", valued.length === 0, valued.join(", "))
  check("POSITIVE CONTROL — a value on a secret name is caught; a numeric default on a config name and a blank secret are not",
    valuedCredentialAssignments("SECRET_X=abc123\nCFG_Y=4000\nSECRET_Z=\n", { SECRET_X: { sys: "core", kind: "secret", purpose: "" }, CFG_Y: { sys: "core", kind: "config", purpose: "" }, SECRET_Z: { sys: "core", kind: "secret", purpose: "" } }).join() === "SECRET_X")
}

// ── 7. DRIFT: the committed generated blocks equal what the code produces ───────
console.log("\nG. GENERATED BLOCKS (drift)")
const blocks: Array<[string, string, string]> = [
  [inventoryDoc, "env-inventory", envBlock],
  [provDoc, "provider-contracts", provBlocks.contracts],
  [provDoc, "provider-cost-routing", provBlocks.costRouting],
  [provDoc, "webhook-doors", provBlocks.doors],
  [archDoc, "hosting-facts", hostBlock],
]
if (WRITE) {
  for (const [file, id, body] of blocks) {
    if (!has(file)) { console.log(`  ⚠ ${file} does not exist — cannot write block ${id}`); continue }
    const cur = rd(file)
    if (docBlock(cur, id) === null) { console.log(`  ⚠ ${file} has no GENERATED:${id} markers`); continue }
    const next = replaceBlock(cur, id, body)
    if (next !== cur) { writeFileSync(join(ROOT, file), next); console.log(`  ✎ wrote ${file} [${id}] (${body.split("\n").length} lines)`) }
  }
}
for (const [file, id, body] of blocks) {
  const cur = has(file) ? docBlock(rd(file), id) : null
  check(`${file} [${id}] equals the generated output (${body.split("\n").length} lines)`, cur !== null && cur === body, cur === null ? "missing file or markers" : "committed block differs — run with --write and review the diff")
}
check("POSITIVE CONTROL — a one-character change to a block is detected as drift", (() => {
  const sample = "| `NAME` | REQUIRED | server secret |"
  const doc = `x\n<!-- GENERATED:t:BEGIN -->\n${sample}\n<!-- GENERATED:t:END -->`
  return docBlock(doc, "t") === sample && docBlock(doc, "t") !== sample.slice(0, -1)
})())

console.log(`\n ${tooling.length} tooling-only environment names inventoried · ${universe.length} app names · ${registry.names.size} registry-declared credentials`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
