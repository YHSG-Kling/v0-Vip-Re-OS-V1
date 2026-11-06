/**
 * scripts/release-rules.ts — THE ONE DERIVATION of the deployment owner obligations O3 and O4 (wave 149, lane 149I2;
 * the rules are lane 149K's, moved here VERBATIM from scripts/release-blockers-guard.ts §E so that guard and block O of
 * scripts/production-readiness-guard.ts read the SAME rule over the SAME facts — one canonical path, never a copy).
 *
 *   O3 the Vercel deployment build — vercel.json's single pass must run with MORE heap than the CI compile cap the
 *      build bracket recorded aborting (at or below it the deploy is OPEN).
 *   O4 CI ≠ Vercel, the install — Vercel must install the SAME package manager CI certifies, frozen, from a lockfile
 *      that covers every package.json dependency at the same specifier (PRODUCTION-ARCHITECTURE §15.3 F-1).
 *
 * Pure rules + one reader of repository facts (no network, no env). Both are derived every run, never pinned.
 * Blind spot (carried from 149K): root-importer SPECIFIERS only — a transitive npm-vs-pnpm resolution difference under one
 * specifier is not measured; the Vercel project's own settings (machine, Node major) are not repository facts.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { parse as parseYaml } from "yaml"

export type Deps = Record<string, string>
export interface InstallShape { pm: "npm" | "pnpm" | "yarn" | "unknown"; frozen: boolean }
export interface LockDrift { absent: string[]; drifted: string[] }

/** PURE — the O3 rule: Vercel's single pass must run with at least the compile heap CI's full pass needs; the CI default
 *  (the cap the bracket recorded aborting at the ~90% give-up line) is the floor, so at or below it the deploy is OPEN. */
export const deployBuildOpen = (vh: number, cap: number): boolean => !(vh > cap)

/** PURE — which package manager an install command runs, and whether it is frozen. */
export function installOf(cmd: string): InstallShape {
  const pm = /\bpnpm\s+(i|install)\b/.test(cmd) ? "pnpm" : /\bnpm\s+ci\b/.test(cmd) ? "npm" : /\byarn\b/.test(cmd) ? "yarn" : /\bnpm\s+(i|install)\b/.test(cmd) ? "npm" : "unknown"
  const frozen = pm === "npm" ? /\bnpm\s+ci\b/.test(cmd) : pm === "pnpm" ? /--frozen-lockfile\b/.test(cmd) && !/--no-frozen-lockfile/.test(cmd) : /--frozen-lockfile|--immutable/.test(cmd)
  return { pm, frozen }
}

/** PURE — the package.json dependencies a lockfile's root importer does not lock at the same specifier. */
export function lockDrift(pkgDeps: Deps, locked: Deps): LockDrift {
  const absent = Object.keys(pkgDeps).filter((k) => !(k in locked))
  const drifted = Object.keys(pkgDeps).filter((k) => k in locked && locked[k] !== pkgDeps[k])
  return { absent, drifted }
}

/** PURE — the O4 install-parity rule. */
export const installParityOpen = (ci: { pm: string; frozen: boolean }, v: { pm: string; frozen: boolean }, drift: LockDrift): boolean =>
  !(ci.pm === v.pm && v.frozen && drift.absent.length === 0 && drift.drifted.length === 0)

export interface DeploymentFacts {
  vercelHeap: number
  ciCap: number
  singlePass: boolean
  pkgDeps: Deps
  engineNode: string | null
  ciInstall: InstallShape
  vInstall: InstallShape
  vDrift: LockDrift
  ciDrift: LockDrift
  o3Open: boolean
  o4Open: boolean
  /** the Node major every CI workflow runs (.github/actions/node-deps input default) */
  ciNodeMajor: number
  /** package.json engines.node does not pin ciNodeMajor (Vercel deploys the engines major, else the project setting) */
  nodeParityOpen: boolean
}

/** The repository facts O3/O4 are derived from (vercel.json, the build bracket, package.json, both lockfiles, the CI
 *  install action's run: blocks — YAML comments mention other commands in prose, so only run: is read). */
export function readDeploymentFacts(root: string): DeploymentFacts {
  const read = (p: string) => readFileSync(join(root, p), "utf8")
  const vercel = JSON.parse(read("vercel.json")) as { buildCommand?: string; installCommand?: string }
  const vercelHeap = Number((vercel.buildCommand ?? "").match(/max-old-space-size=(\d+)/)?.[1] ?? 0)
  const ciCap = Number(read(".github/workflows/build.yml").match(/BUILD_HEAP_MB \|\| '(\d+)'/)?.[1] ?? 0)
  const singlePass = /next build --webpack/.test(vercel.buildCommand ?? "") && !/experimental-build-mode/.test(vercel.buildCommand ?? "")
  const pkgAll = JSON.parse(read("package.json")) as { dependencies?: Deps; devDependencies?: Deps; engines?: { node?: string } }
  const pkgDeps: Deps = { ...(pkgAll.dependencies ?? {}), ...(pkgAll.devDependencies ?? {}) }
  const lock = JSON.parse(read("package-lock.json")) as { packages?: Record<string, { dependencies?: Deps; devDependencies?: Deps }> }
  const npmRoot = lock.packages?.[""]
  const npmLocked: Deps = { ...(npmRoot?.dependencies ?? {}), ...(npmRoot?.devDependencies ?? {}) }
  const pnpmLocked: Deps = (() => {
    if (!existsSync(join(root, "pnpm-lock.yaml"))) return {}
    const imp = (parseYaml(read("pnpm-lock.yaml")) as { importers?: Record<string, { dependencies?: Record<string, { specifier: string }>; devDependencies?: Record<string, { specifier: string }> }> }).importers?.["."]
    const out: Deps = {}
    for (const [k, v] of Object.entries({ ...(imp?.dependencies ?? {}), ...(imp?.devDependencies ?? {}) })) out[k] = v.specifier
    return out
  })()
  const nodeDeps = parseYaml(read(".github/actions/node-deps/action.yml")) as { runs?: { steps?: Array<{ run?: string }> } }
  const ciInstall = installOf((nodeDeps.runs?.steps ?? []).map((s) => s.run ?? "").join("\n"))
  const vInstall = installOf(`${vercel.installCommand ?? ""} ${vercel.buildCommand ?? ""}`)
  const vLocked = vInstall.pm === "pnpm" ? pnpmLocked : vInstall.pm === "npm" ? npmLocked : {}
  const vDrift = lockDrift(pkgDeps, vLocked)
  const ciDrift = lockDrift(pkgDeps, npmLocked)
  const ciNodeMajor = Number((parseYaml(read(".github/actions/node-deps/action.yml")) as { inputs?: Record<string, { default?: string }> }).inputs?.["node-version"]?.default ?? 0)
  const engineNode = pkgAll.engines?.node ?? null
  return {
    vercelHeap, ciCap, singlePass, pkgDeps, engineNode, ciInstall, vInstall, vDrift, ciDrift,
    o3Open: deployBuildOpen(vercelHeap, ciCap), o4Open: installParityOpen(ciInstall, vInstall, vDrift),
    ciNodeMajor, nodeParityOpen: nodeParityOpen(engineNode, ciNodeMajor),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// wave 150, lane 150AAF — THE OWNER HALF OF O3 (Node parity, the build machine's RAM, the custom domain) and the C42
// RELEASE GATE ROWS. Every row is DERIVED from the evidence ledger in docs/operations/ACTIVATION-CHECKLIST.md §6.7 and the
// tree it was observed on — never pinned. A row observed on another tree is STALE, and a commit this checkout cannot see
// is UNKNOWN; both read as not observed (fail closed: "nobody checked" never renders as "checked and fine").
// ═════════════════════════════════════════════════════════════════════════════

/** PURE — the major a package.json engines.node range PINS ("22.x", "22", "^22", "~22", "22.x.x"); null when the range
 *  admits more than one major (">=22" lets Vercel pick 24 — that is not a pin). */
export function nodeMajorPinned(range: string | null): number | null {
  const m = /^\s*[~^]?\s*(\d+)(?:\.(?:x|\*|\d+))?(?:\.(?:x|\*|\d+))?\s*$/.exec(range ?? "")
  return m ? Number(m[1]) : null
}
/** PURE — Node parity: package.json engines.node (Vercel deploys THAT major, overriding the project setting) must pin
 *  the major every CI workflow runs (.github/actions/node-deps input default). */
export const nodeParityOpen = (engine: string | null, ciMajor: number): boolean => !(ciMajor > 0 && nodeMajorPinned(engine) === ciMajor)

/** The off-heap RSS the build bracket measured beside the compile heap (".github/workflows/build.yml": "~4-5 GB measured
 *  off-heap"; the CI full-pass preflight refuses heap + this above the runner's RAM). The upper end, so the rule is safe. */
export const BUILD_OFF_HEAP_MB = 5120
/** PURE — the build machine must hold the configured compile heap PLUS the measured off-heap; an unreported RAM is OPEN. */
export const machineFitOpen = (heapMb: number, ramMb: number | null): boolean => !(ramMb !== null && ramMb > 0 && heapMb > 0 && heapMb + BUILD_OFF_HEAP_MB <= ramMb)

export type GateState = "OBSERVED" | "NOT OBSERVED"
export interface EvidenceRow { row: string; status: string; date: string; commit: string; evidence: string }
export type Freshness = "fresh" | "stale" | "unknown"
export interface ReleaseGate {
  row: string
  gate: string
  /** true = only a deployed build can produce this evidence (CI, tsc and the chain never can). */
  deployOnly: boolean
  /** false = a project setting, not a property of one tree (dated, never commit-bound). */
  commitBound: boolean
  /** every pattern must match the evidence cell (read raw: it is ledger prose, not code). */
  shape: RegExp[]
  /** a well-formed evidence cell — the positive control proves the shape still ACCEPTS what it was written for. */
  specimen: string
}
/** The chain's own exit token, spelled in two halves so no proof output of this module ever prints it whole. */
const CHAIN_TOKEN = ["GUARD", "EXIT=0"].join("_")
const DPL = /\bdpl_[A-Za-z0-9]{10,}\b/
/** C42 — the separate mandatory rows (R1–R9), then the owner half of O3 (M1 machine RAM, M2 custom domain). */
export const RELEASE_GATES: readonly ReleaseGate[] = Object.freeze([
  { row: "R1", gate: "full guard chain, its own final exit line", deployOnly: false, commitBound: true,
    shape: [new RegExp(`\\b${CHAIN_TOKEN}\\b`), /\b\d+ proofs\b/], specimen: `chain log final line ${CHAIN_TOKEN}; 886 proofs, 0 red RESULT lines` },
  { row: "R2", gate: "whole-project tsc --noEmit", deployOnly: false, commitBound: true,
    shape: [/\bTSC_(?:ERRORS|EXIT)=0\b/, /\b\d{4,5} MB\b/], specimen: "TSC_ERRORS=0 at 12288 MB (the chain's type-check step)" },
  { row: "R3", gate: "CI build workflow, next-build verdict", deployOnly: false, commitBound: true,
    shape: [/\brun \d{9,}\b/, /\bnext-build\b[^|]*\bsuccess\b/], specimen: "build run 41765432933: next-build success" },
  { row: "R4", gate: "clean build of the deployable tree (single pass, fresh .next)", deployOnly: true, commitBound: true,
    shape: [DPL, /\bREADY\b/, /\bCompiled successfully\b/], specimen: "dpl_AbCdEf123456 READY; build log: Compiled successfully, Generating static pages" },
  { row: "R5", gate: "Vercel preview deploy + production smoke", deployOnly: true, commitBound: true,
    shape: [DPL, /\btest:production-smoke\b/, /\bRESULT: \d+ passed, 0 failed\b/], specimen: "dpl_AbCdEf123456 preview; npm run test:production-smoke → RESULT: 14 passed, 0 failed" },
  { row: "R6", gate: "one real browser sign-in on the deployment", deployOnly: true, commitBound: true,
    shape: [DPL, /\bsigned in\b/i, /\b(dashboard|portal)\b/], specimen: "dpl_AbCdEf123456: signed in as a broker_owner seat, landed on /dashboard" },
  { row: "R7", gate: "an observed Vercel Workflow timer", deployOnly: true, commitBound: true,
    shape: [DPL, /\bwrun_[A-Za-z0-9]{6,}\b/, /\bfired\b/i], specimen: "dpl_AbCdEf123456: completion-watch wrun_01ABCDEF timer fired, row settled" },
  { row: "R8", gate: "an observed cron tick through Deployment Protection", deployOnly: true, commitBound: true,
    shape: [DPL, /\/api\/cron\/dispatch\b/, /"ok":\s*true/, /"dispatched":\s*\d+/], specimen: `dpl_AbCdEf123456: /api/cron/dispatch {"ok":true,"due":12,"dispatched":12}` },
  { row: "R9", gate: "storage-policy evidence (the live readiness function)", deployOnly: false, commitBound: false,
    shape: [/storage_bucket_policy_readiness\(\)/, /agent-documents owner_scoped/, /brokerage-forms owner_scoped/, /client-documents owner_scoped/, /(?:^|[\s·:;,(])documents service_only/, /offer-documents service_only/, /transaction-documents owner_scoped/, /\b0 bucket-wide\b/, /\b11 owner policies\b/],
    specimen: "storage_bucket_policy_readiness(): agent-documents owner_scoped · brokerage-forms owner_scoped · client-documents owner_scoped · documents service_only · offer-documents service_only · transaction-documents owner_scoped; 0 bucket-wide; 11 owner policies" },
  { row: "M1", gate: "O3 owner half — the Vercel build machine and its RAM", deployOnly: false, commitBound: false,
    shape: [/\b(Standard|Enhanced|Turbo)\b/, /\b\d{4,6} MB RAM\b/], specimen: "Build Machine Turbo, 61440 MB RAM (settings page)" },
  { row: "M2", gate: "O3 owner half — custom production domain outside Deployment Protection", deployOnly: false, commitBound: false,
    shape: [/https:\/\/(?![^\s/]*\.vercel\.app)[a-z0-9-]+(?:\.[a-z0-9-]+)+/i, /\bNEXT_PUBLIC_APP_URL\b/, /\/login\b[^|]*\b200\b/], specimen: "https://app.example-brokerage.com attached; NEXT_PUBLIC_APP_URL set to it; curl -I /login → 200 without SSO" },
] as const)
export const CI_SIDE_ROWS = RELEASE_GATES.filter((g) => !g.deployOnly && g.row.startsWith("R")).map((g) => g.row)

/** PURE — the ledger table between the release-evidence markers (one row per gate; first matching row wins). */
export function parseEvidenceLedger(md: string): Map<string, EvidenceRow> {
  const block = /<!-- release-evidence:start -->([\s\S]*?)<!-- release-evidence:end -->/.exec(md)?.[1] ?? ""
  const rows = new Map<string, EvidenceRow>()
  for (const line of block.split("\n")) {
    const c = line.split(/(?<!\\)\|/).slice(1, -1).map((s) => s.trim())
    if (c.length !== 6 || !/^[RM]\d+$/.test(c[0])) continue
    if (!rows.has(c[0])) rows.set(c[0], { row: c[0], status: c[2], date: c[3], commit: c[4].replace(/`/g, ""), evidence: c[5] })
  }
  return rows
}

/** PURE — a gate row's verdict. OBSERVED needs: the status word, an ISO date, a commit (when commit-bound) that is FRESH
 *  against this tree, and evidence matching EVERY pattern of that gate's shape. */
export function gateVerdict(g: ReleaseGate, r: EvidenceRow | undefined, fresh: (commit: string) => Freshness): { state: GateState; why: string } {
  if (!r) return { state: "NOT OBSERVED", why: "no ledger row" }
  if (r.status !== "OBSERVED") return { state: "NOT OBSERVED", why: `status ${r.status || "blank"}` }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return { state: "NOT OBSERVED", why: "no ISO date" }
  if (g.commitBound) {
    if (!/^[0-9a-f]{7,40}$/.test(r.commit)) return { state: "NOT OBSERVED", why: "no commit" }
    const f = fresh(r.commit)
    if (f !== "fresh") return { state: "NOT OBSERVED", why: f === "stale" ? `observed on ${r.commit.slice(0, 8)} — the tree has changed since` : `commit ${r.commit.slice(0, 8)} not in this checkout (cannot be checked)` }
  }
  const missing = g.shape.filter((re) => !re.test(r.evidence))
  if (missing.length) return { state: "NOT OBSERVED", why: `evidence lacks ${missing.length} of ${g.shape.length} required facts` }
  return { state: "OBSERVED", why: g.commitBound ? `on ${r.commit.slice(0, 8)}, ${r.date}` : r.date }
}

/** PURE — the freshness rule: the evidence commit certifies THIS tree only when nothing but the ledger itself changed
 *  since (tracked diff to the working tree + untracked files). null = git could not answer → unknown. */
export const EVIDENCE_EXEMPT = Object.freeze(["docs/operations/ACTIVATION-CHECKLIST.md"])
export const freshnessOf = (changed: string[] | null): Freshness =>
  changed === null ? "unknown" : changed.filter((f) => f && !EVIDENCE_EXEMPT.includes(f)).length === 0 ? "fresh" : "stale"

/** Reads git for one commit: does it exist here, and what changed between it and the working tree. */
export function gitFreshness(root: string, commit: string): Freshness {
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" })
  if (git("cat-file", "-e", `${commit}^{commit}`).status !== 0) return "unknown"
  const d = git("diff", "--name-only", commit)
  const u = git("ls-files", "--others", "--exclude-standard")
  if (d.status !== 0 || u.status !== 0) return "unknown"
  return freshnessOf([...d.stdout.split("\n"), ...u.stdout.split("\n")].map((s) => s.trim()).filter(Boolean))
}

/** PURE — the build machine's RAM in MB from the M1 evidence cell (null when not reported). */
export const machineRamMb = (r: EvidenceRow | undefined): number | null => {
  const m = /\b(\d{4,6}) MB RAM\b/.exec(r?.evidence ?? "")
  return m ? Number(m[1]) : null
}

/** PURE — PRODUCTION-LIVE needs zero open owner obligations AND every R row observed on this tree. CI green alone,
 *  the chain alone, tsc alone — or all three together — is never production-live. */
export const productionLive = (openObligations: number, states: ReadonlyMap<string, GateState>): boolean =>
  openObligations === 0 && RELEASE_GATES.filter((g) => g.row.startsWith("R")).every((g) => states.get(g.row) === "OBSERVED")

/** PURE — the full O3: the heap half (code), Node parity (code: package.json engines), the machine fits heap + off-heap
 *  (owner: M1), and the custom domain outside Deployment Protection (owner: M2). */
export const o3FullOpen = (f: { heapOpen: boolean; nodeOpen: boolean; machineOpen: boolean; domainObserved: boolean }): boolean =>
  f.heapOpen || f.nodeOpen || f.machineOpen || !f.domainObserved

export interface ReleaseEvidence {
  /** the ACTIVATION-CHECKLIST text the ledger was parsed from ("" when the file is absent) */
  text: string
  ledger: Map<string, EvidenceRow>
  /** git freshness of one commit against this working tree (memoised) */
  fresh: (commit: string) => Freshness
  verdict: (row: string) => { state: GateState; why: string }
}
/** The ONE reader of the evidence ledger (release-blockers §F and E4, and block O of production-readiness). */
export function readReleaseEvidence(root: string): ReleaseEvidence {
  const p = join(root, "docs/operations/ACTIVATION-CHECKLIST.md")
  const text = existsSync(p) ? readFileSync(p, "utf8") : ""
  const ledger = parseEvidenceLedger(text)
  const memo = new Map<string, Freshness>()
  const fresh = (c: string): Freshness => { if (!memo.has(c)) memo.set(c, gitFreshness(root, c)); return memo.get(c)! }
  const verdict = (row: string) => { const g = RELEASE_GATES.find((x) => x.row === row); return g ? gateVerdict(g, ledger.get(row), fresh) : { state: "NOT OBSERVED" as GateState, why: "unknown row" } }
  return { text, ledger, fresh, verdict }
}

export interface O3Derivation { open: boolean; heapOpen: boolean; nodeOpen: boolean; machineOpen: boolean; domainObserved: boolean; ramMb: number | null; parts: string[] }
/** The WHOLE O3 over the repository facts and the ledger — the one derivation both guards print. */
export function deriveO3(f: DeploymentFacts, ev: ReleaseEvidence): O3Derivation {
  const m1 = ev.verdict("M1"), m2 = ev.verdict("M2")
  const ramMb = m1.state === "OBSERVED" ? machineRamMb(ev.ledger.get("M1")) : null
  const heapOpen = deployBuildOpen(f.vercelHeap, f.ciCap), machineOpen = machineFitOpen(f.vercelHeap, ramMb), domainObserved = m2.state === "OBSERVED"
  const parts = [
    heapOpen ? `heap ${f.vercelHeap} MB ≤ CI cap ${f.ciCap} MB` : "",
    f.nodeParityOpen ? `engines.node ${f.engineNode ?? "unset"} does not pin CI's Node ${f.ciNodeMajor}` : "",
    machineOpen ? (ramMb === null ? `build machine RAM not reported (ledger M1: ${m1.why})` : `${ramMb} MB RAM < heap ${f.vercelHeap} + off-heap ${BUILD_OFF_HEAP_MB} MB`) : "",
    domainObserved ? "" : `custom domain not observed (ledger M2: ${m2.why})`,
  ].filter(Boolean)
  return { open: o3FullOpen({ heapOpen, nodeOpen: f.nodeParityOpen, machineOpen, domainObserved }), heapOpen, nodeOpen: f.nodeParityOpen, machineOpen, domainObserved, ramMb, parts }
}
