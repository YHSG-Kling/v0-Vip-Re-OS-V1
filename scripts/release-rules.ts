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
  return {
    vercelHeap, ciCap, singlePass, pkgDeps, engineNode: pkgAll.engines?.node ?? null, ciInstall, vInstall, vDrift, ciDrift,
    o3Open: deployBuildOpen(vercelHeap, ciCap), o4Open: installParityOpen(ciInstall, vInstall, vDrift),
  }
}
