/**
 * scripts/canaries/wave147-harness.ts — the WAVE-147 journey canaries' shared plumbing (lane 147J).
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT A FOURTH HARNESS. Everything still goes through the survivors:
 *   · scripts/canaries/_harness.ts        — canary() (step / rule / hook / pendingOwner / report), setSvc, stubModule,
 *                                           cleanupCanary (delete-and-COUNT, residual against the tenant predicate);
 *   · scripts/canaries/_registry.ts       — rulingVerdict (the verdict table), strippedRepo / listFiles (STRIPPED source,
 *                                           CLAUDE.md §2 — a tombstone or a comment is never a landing);
 *   · scripts/canaries/wave145-harness.ts — canary145().check (a throwing ruling step is RED for its owner), quiet().
 * This module adds only what wave 147 needs on top:
 *   1. the roster (WAVE147_CANARY_KEYS — one canary per wave-147 lane journey A · B · C · E · F · G · H; lane D evaluated
 *      DealMachine and built no adapter, so it has no journey; lane I is the registry and package keys);
 *   2. the wave-147 owner tags (147A–147I · "147Z" — the convergence lane that applies every Outside-lane item · "integrator"
 *      · "defect");
 *   3. ONE set of edge seams installed BEFORE any lane module is imported (the resolve hook reads the stub map on every
 *      resolution; a module linked before a stub is installed keeps the real import — so the runner imports this file first
 *      and every canary imports lib modules lazily). Every seam is a PASS-THROUGH: it re-exports the real module and overrides
 *      one door that delegates to the real function unless the canary running RIGHT NOW switched that seam on
 *      (globalThis.__W147). One canary's seam can therefore never leak into the next canary's journey. The seams are the ones
 *      the lane proofs themselves stub (consented-intake, listing-lifecycle, event-checkin-writers, action-evidence-census) —
 *      the network / send / session edges only; the lane modules under test always run for real;
 *   4. tracked cleanup: every in-memory client a canary writes is registered with its tenant(s); report() deletes those rows
 *      through cleanupCanary (`.delete()…select("id")` and the returned rows COUNTED — CLAUDE.md §3) and publishes the residual.
 *
 * Verdicts: green · red-awaiting-lane-147X · red-defect · hook (a lane-147Z convergence item the journey depends on that has
 * not landed — PENDING, counted beside the RESULT line, never a pass, never a failure; it turns into a green ruling step the
 * moment it lands, with no edit in between) · pending-owner (an OWNER decision no lane may take).
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { canary, cleanupCanary, stubModule, type CanaryCleanup, type CanaryReport, type CanarySvc, type RulingOwner } from "./_harness"
import { ROOT } from "./_registry"

/** One canary per wave-147 lane journey (WAVE147_SPEC "LANES"), in run order. */
export const WAVE147_CANARY_KEYS = [
  "wave147-consented-intake", "wave147-movement-signals", "wave147-conversational-buyer", "wave147-lead-magnet-report",
  "wave147-listing-lifecycle", "wave147-sms-completion", "wave147-support-loop",
] as const
export type Wave147CanaryKey = (typeof WAVE147_CANARY_KEYS)[number]

export type Wave147Lane = "147A" | "147B" | "147C" | "147D" | "147E" | "147F" | "147G" | "147H" | "147I" | "147Z"
export type Ruling147Owner = Wave147Lane | "integrator" | "defect"

// ── the pass-through edge seams (installed once, at module load, before any lane module links) ─────────────────────────────
export interface W147State {
  /** emitKernelEvent records instead of writing + fanning out (lane 147A's proof stubs the same edge). */
  recordEmit: boolean; events: Array<Record<string, any>>
  /** ensureClientWelcome / createSystemPortalInvite record instead of sending mail (lane 147A's proof). */
  recordWelcome: boolean; welcomes: Array<Record<string, any>>; invites: Array<Record<string, any>>
  /** recordLifecycleEvent records instead of writing (lane 147F's lifecycle + five-action proofs). */
  recordLifecycle: boolean; lifecycle: Array<Record<string, any>>
  /** getAgentContext answers this session (lane 147F's event-checkin proof); null = the real reader. */
  session: Record<string, unknown> | null
  /** requireCaller / requireCallerWithAgent / resolveWriteContextForTenant / resolveActingContext / mayUseAndAfford answer this
   *  caller (lane 147F's five-action proof); null = the real gates. */
  caller: Record<string, unknown> | null
  /** callConnector counts the routing layer's calls instead of leaving the process; null = the real gateway. */
  connector: Array<{ method: string; url: string }> | null
  /** recordListingAgreementAmendment is COUNTED (its domain writer has its own proof); null = the real writer. */
  amendments: number | null
}
const G = globalThis as unknown as { __W147: W147State }
export function resetSeams(): void {
  G.__W147 = { recordEmit: false, events: [], recordWelcome: false, welcomes: [], invites: [], recordLifecycle: false, lifecycle: [], session: null, caller: null, connector: null, amendments: null }
}
resetSeams()
export const seams = (): W147State => G.__W147

const STUB_DIR = mkdtempSync(join(tmpdir(), "wave147-canaries-"))
/** A FILE stub: re-exports the real module (every other importer keeps its names) and overrides the named doors. */
function passThrough(spec: string, realRel: string, body: string): void {
  const url = JSON.stringify(pathToFileURL(join(ROOT, realRel)).href)
  const file = join(STUB_DIR, `${spec.replace(/[^a-z0-9]+/gi, "_")}.mjs`)
  writeFileSync(file, `export * from ${url}\nimport * as __real from ${url}\nconst W = () => globalThis.__W147\n${body}\n`)
  stubModule(spec, pathToFileURL(file).href)
}
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
// The custom-domain DNS probe reads "no record yet" — no lookup leaves the process (lane 147F's census does the same). ESM
// IMPORTS ONLY: a CommonJS `require('node:dns')` (undici, reached by the enrichment queue) cannot load a data: URL in place of a
// builtin ("Cannot read properties of undefined (reading 'exports')" — measured), so a require keeps the real builtin. The
// census installs its stub through the shared map in a process undici never reaches; this process runs every journey.
const DNS_STUB = `data:text/javascript,${encodeURIComponent("import real from 'dns'; const nx = async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e }; export const promises = { ...real.promises, resolve4: nx, resolveCname: nx }; export default { ...real, promises }")}`
registerHooks({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:module's ResolveHookSync shape (the repo's idiom)
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "node:dns" && Array.isArray(ctx?.conditions) && ctx.conditions.includes("import") && !ctx.conditions.includes("require")) return { url: DNS_STUB, shortCircuit: true }
    return next(spec, ctx)
  },
})
passThrough("@/lib/kernel/emit", "lib/kernel/emit.ts",
  "export async function emitKernelEvent(i) { const w = W(); if (w && w.recordEmit) { w.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + w.events.length, fanOutOk: true, error: null } } return __real.emitKernelEvent(i) }")
passThrough("@/lib/kernel/client-welcome", "lib/kernel/client-welcome.ts",
  "export async function ensureClientWelcome(svc, c, o) { const w = W(); if (w && w.recordWelcome) { w.welcomes.push(c); return { state: 'sent' } } return __real.ensureClientWelcome(svc, c, o) }")
passThrough("@/lib/portal/portal-invite-core", "lib/portal/portal-invite-core.ts",
  "export async function createSystemPortalInvite(p) { const w = W(); if (w && w.recordWelcome) { w.invites.push(p); return { ok: true } } return __real.createSystemPortalInvite(p) }")
passThrough("@/lib/events/lifecycle-event-core", "lib/events/lifecycle-event-core.ts",
  "export async function recordLifecycleEvent(svc, b, i, ...r) { const w = W(); if (w && w.recordLifecycle) { w.lifecycle.push({ brokerageId: b, input: i }); return { ok: true, event: { id: 'evt-' + w.lifecycle.length }, deduped: false } } return __real.recordLifecycleEvent(svc, b, i, ...r) }")
passThrough("@/lib/identity", "lib/identity/index.ts",
  "export async function getAgentContext(...a) { const w = W(); if (w && w.session) return { ...w.session }; return __real.getAgentContext(...a) }")
passThrough("@/lib/auth/require-caller", "lib/auth/require-caller.ts",
  "export async function requireCaller(...a) { const w = W(); if (w && w.caller) return { ok: true, ...w.caller }; return __real.requireCaller(...a) }\n" +
  "export async function requireCallerWithAgent(...a) { const w = W(); if (w && w.caller) return { ok: true, ...w.caller }; return __real.requireCallerWithAgent(...a) }")
passThrough("@/lib/platform/acting-context", "lib/platform/acting-context.ts",
  "export async function resolveWriteContextForTenant(...a) { const w = W(); if (w && w.caller) return { ok: true, ...w.caller }; return __real.resolveWriteContextForTenant(...a) }\n" +
  "export async function resolveActingContext(...a) { const w = W(); if (w && w.caller) return { ok: true, ...w.caller }; return __real.resolveActingContext(...a) }")
passThrough("@/lib/billing/billing-access", "lib/billing/billing-access.ts",
  "export async function mayUseAndAfford(...a) { const w = W(); if (w && w.caller) return { allowed: true, reason: 'wave147 canary caller' }; return __real.mayUseAndAfford(...a) }")
passThrough("@/lib/agentic-os/connector-gateway", "lib/agentic-os/connector-gateway.ts",
  "export async function callConnector(req) { const w = W(); if (w && w.connector) { w.connector.push({ method: req.method ?? 'GET', url: String(req.url) }); return { ok: true, status: 200, data: { name: 'x', verified: true, verification: [] } } } return __real.callConnector(req) }")
passThrough("@/lib/listings/listing-agreement-terms", "lib/listings/listing-agreement-terms.ts",
  "export async function recordListingAgreementAmendment(svc, input) { const w = W(); if (w && typeof w.amendments === 'number') { w.amendments++; return { ok: true, id: 'ctv-' + w.amendments, agreementId: 'agr-1', versionNo: w.amendments + 1, changed: ['coming_soon_street_address_authorized'] } } return __real.recordListingAgreementAmendment(svc, input) }")

// ── the wave-147 canary: canary() with the wave-147 owner tags, check(), a convergence hook, and tracked cleanup ────────────
export function canary147(chain: string) {
  const c = canary(chain)
  // The 144 harness types the owner as a 144 lane; the runner and rulingVerdict read it as a string (red-awaiting-lane-<owner>).
  const own = (o: Ruling147Owner) => o as unknown as RulingOwner
  const tracked: Array<{ svc: unknown; tenants: string[] }> = []
  return {
    rule: (o: Ruling147Owner, step: string, ok: boolean, evidence = ""): boolean => c.rule(own(o), step, ok, evidence),
    pendingOwner: (o: Ruling147Owner, step: string, ok: boolean, decision: string, evidence = ""): boolean => c.pendingOwner(own(o), step, ok, decision, evidence),
    /** A ruling step whose body may throw (a landed module misbehaving): a throw is RED for that owner, with the error (canary145's rule). */
    async check(o: Ruling147Owner, step: string, body: () => Promise<{ ok: boolean; evidence: string }> | { ok: boolean; evidence: string }): Promise<boolean> {
      try { const r = await body(); return c.rule(own(o), step, r.ok, r.evidence) }
      catch (e) { return c.rule(own(o), step, false, `THREW: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400)) }
    },
    /**
     * A journey step that rides a lane-147Z CONVERGENCE item (an Outside-lane fix another lane wrote down). Landed → a ruling
     * step for `owner` (green when it holds, RED when it does not); not landed → a HOOK (pending, counted beside the RESULT line,
     * never a pass and never a failure). `landed` is decided by the caller from STRIPPED source, with its own positive control.
     */
    convergence(owner: Ruling147Owner, step: string, landed: boolean, holds: boolean, evidence = ""): void {
      if (landed) c.rule(own(owner), step, holds, evidence)
      else c.hook("147Z", step, evidence)
    },
    step: c.step,
    blind: c.blind,
    /** Register an in-memory client (and the tenants whose rows it holds) for the delete-and-count cleanup. */
    track<T>(svc: T, ...tenants: string[]): T { tracked.push({ svc, tenants }); return svc },
    /** Delete every tracked row, COUNT what came back, publish the residual; a mismatch is a red step. */
    async report(): Promise<CanaryReport> {
      const cleanup: CanaryCleanup[] = []
      let residual = 0
      const mismatches: string[] = []
      for (const t of tracked) for (const b of t.tenants) {
        const r = await cleanupCanary(t.svc as CanarySvc, b)
        for (const x of r.cleanup) { const prev = cleanup.find((y) => y.table === x.table); if (prev) prev.deleted += Math.max(0, x.deleted); else cleanup.push({ ...x, deleted: Math.max(0, x.deleted) }) }
        residual += r.residual
        mismatches.push(...r.mismatches)
      }
      if (mismatches.length) c.step("cleanup: every tracked row deleted and counted", false, mismatches.join("; "))
      resetSeams()
      return c.report(cleanup, residual)
    },
  }
}
export type Canary147 = ReturnType<typeof canary147>

/** A value's JSON text (for "does this output carry X anywhere" questions). */
export const jsonOf = (v: unknown): string => { try { return JSON.stringify(v) ?? "" } catch { return String(v) } }
export const tbl = (svc: unknown, t: string): Array<Record<string, any>> => (((svc as { tables?: Record<string, Array<Record<string, any>>> }).tables ?? {})[t] ?? [])
