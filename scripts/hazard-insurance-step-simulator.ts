#!/usr/bin/env tsx
/**
 * scripts/hazard-insurance-step-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES THE BUYER'S HAZARD-INSURANCE STEP ACTUALLY EXIST ON A DEAL, AND CAN THE
 * READER THAT LOOKS AT IT BE WRONG QUIETLY?
 *
 * The backlog line for #142 said "build hazard insurance as a buyer transaction
 * step". It is built. What was never established is the only thing that makes it
 * a STEP rather than a declaration: a milestone DECLARED in the catalog is not a
 * milestone SEEDED on a deal, and `closing-orchestration.ts` only ever *finds*
 * `hazard_insurance_bound` — if nothing seeded it, that reader had been looking
 * for a row that never existed and quietly finding nothing, which is a check
 * that cannot fail.
 *
 * WHAT THIS PROVES (the constructs, never the spellings)
 *
 *   SEED   · the identity is on the BUYER journey and on NO seller journey;
 *          · the journey seeder builds its inserted rows FROM that catalog;
 *          · the offer→transaction bridge reaches that seeder with a journey
 *            that contains the hazard step. → the step DOES reach a buyer's deal.
 *
 *   DRIVE  · a detector for the unbound policy is registered in the closing
 *            engine's detector library and derives its verdict, severity and
 *            headline from the shared pure evaluator;
 *          · a route drives that engine, is gated by the cron secret rather than
 *            a cookie session, and is on the dispatcher's schedule registry.
 *            (A `"use server"` module gated on auth.getUser() CANNOT be driven
 *            by a cron — that mistake made the earnest-money watchdog return
 *            Unauthorized on every iteration for its whole life.)
 *
 *   REFUSE · supabase-js RESOLVES a refused query, so "no policy on file" and
 *            "we could not read the policies" arrive as the same value and mean
 *            opposite things. Every read in the action destructures its error;
 *            a refused insurance read returns ok:false with a NULL status and
 *            never a posture; the panel states the failure instead of rendering
 *            "not yet provided" over a policy that exists.
 *
 *   HONEST · the panel's blocker framing comes from the evaluator's verdict, not
 *            from the posture NAME (a bound policy with no binder on file is not
 *            a green state); the panel's style map is exhaustive over the
 *            posture union; and on a SELLER-side deal — where the buyer is the
 *            other brokerage's client and we never see the binder — the
 *            evaluator refuses to manufacture a closing blocker out of a silence
 *            it could not have observed.
 *
 *   SELECT · a deal can hold several insurance engagements (there is no
 *            uniqueness on the pair and a fresh row is inserted per quote
 *            request), so "the newest row" is the wrong coverage record the
 *            moment a comparison quote follows a binding. The shared selector
 *            prefers the policy-bearing engagement.
 *
 * ── TWO ASSERTIONS WERE WRITTEN RED AND CLOSED DURING THE WAVE ───────────────
 * `SEED.the-seeded-journey-is-derived-from-the-deal-side` and
 * `SELECT.the-closing-engine-resolves-the-same-engagement-as-the-panel` were
 * both failing when first written: the offer bridge seeded the literal
 * "purchase" journey onto every deal including seller-side ones, and the closing
 * engine picked `insuranceServices[0]` while the panel picked the policy-bearing
 * row. Both were one-line defects in files outside this wave's edit scope, and
 * both were closed. The assertions stay — the summary still counts open findings
 * separately, so a future regression is reported as such rather than absorbed.
 *
 * ── CONTROLS ─────────────────────────────────────────────────────────────────
 * Every SOURCE assertion carries negative controls: the defect is written back
 * into the real file, THE MUTATION IS VERIFIED TO HAVE APPLIED (a find-string
 * that no longer matches is theatre, not a control), the assertion is required
 * to flip RED, and the file is restored and re-verified by sha256. BEHAVIOUR
 * assertions run against already-imported modules — tsx emits CJS, so a mutated
 * module cannot be re-imported in-process — and are controlled by DISCRIMINATION
 * instead: each pairs the positive case with the cases that must NOT match, so a
 * constant-returning implementation fails them. Controls are skipped, and said
 * to be skipped, on an assertion that is already RED: breaking a broken thing
 * proves nothing.
 *
 * Run:  npx tsx scripts/hazard-insurance-step-simulator.ts [--no-negative]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

import {
  readHazardInsurance,
  selectHazardService,
  hazardSeverity,
  hazardReminderHeadline,
  HAZARD_EVIDENCE_LEAD_DAYS,
  HAZARD_EVIDENCE_URGENT_DAYS,
  HAZARD_EXPIRING_DAYS,
  HAZARD_NOT_OUR_SIDE_NOTE,
  type HazardServiceRow,
  type HazardPosture,
} from "../lib/transactions/hazard-insurance"
import {
  BUYER_MILESTONE_JOURNEY,
  SELLER_MILESTONE_JOURNEY,
  milestoneJourneyFor,
} from "../lib/transactions/milestone-catalog"
import { resolveMilestoneIdentity } from "../lib/transactions/milestone-identity"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  evaluator: "lib/transactions/hazard-insurance.ts",
  action:    "app/actions/transaction-hazard-insurance.ts",
  panel:     "app/dashboard/transactions/[id]/hazard-insurance-section.tsx",
  engine:    "lib/transactions/closing-orchestration.ts",
  seeder:    "lib/transactions/milestone-service.ts",
  bridge:    "lib/transactions/offer-bridge.ts",
  cronRoute: "app/api/cron/closing-orchestration/route.ts",
  cronReg:   "lib/kernel/cron-dispatch.ts",
}

/** Read fresh every time — the negative layer rewrites these files. */
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
/** Comment-stripped source: prose must never satisfy a structural assertion. */
const code = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

// ─────────────────────────────────────────────────────────────────────────────
// Construct-level source utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Index of the matching close brace for the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Body of a top-level function declaration, by name (`{ … }` inclusive). */
function fnBody(src: string, name: string): string | null {
  const m = new RegExp(`function\\s+${name}\\s*[(<]`).exec(src)
  if (!m) return null
  const open = src.indexOf("{", src.indexOf(")", m.index))
  if (open === -1) return null
  const close = matchBrace(src, open)
  return close === -1 ? null : src.slice(open, close + 1)
}

/** The argument list of a call, split at top level: `f(a, {b: 1}, c)` → 3 parts. */
function callArgs(src: string, callee: string): string[] | null {
  const m = new RegExp(`\\b${callee}\\s*\\(`).exec(src)
  if (!m) return null
  let i = m.index + m[0].length
  let depth = 1
  const parts: string[] = []
  let cur = ""
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i]
    if ("([{".includes(ch)) depth++
    else if (")]}".includes(ch)) { depth--; if (depth === 0) break }
    if (depth === 1 && ch === ",") { parts.push(cur.trim()); cur = "" } else cur += ch
  }
  parts.push(cur.trim())
  return parts.filter((p) => p.length > 0)
}

/** Does a module carry a top-level "use server" directive? */
function isUseServerModule(relPath: string): boolean {
  const abs = resolve(ROOT, relPath)
  if (!existsSync(abs)) return false
  const src = readFileSync(abs, "utf8")
    .replace(/^﻿/, "")
    .replace(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, "")
    .trimStart()
  return /^["']use server["']/.test(src)
}

/**
 * Every supabase `.from("<table>")` call in a module, paired with the statement
 * that owns it — the text from the nearest statement head (const/let/var/await/
 * return) up to the call. Used to ask whether the statement destructures `error`.
 */
function fromCallStatements(src: string): Array<{ table: string; head: string }> {
  const out: Array<{ table: string; head: string }> = []
  for (const m of src.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)/g)) {
    const before = src.slice(0, m.index!)
    const heads = [...before.matchAll(/(?:^|\n)[ \t]*(?:const|let|var|await|return)\b/g)]
    const start = heads.length ? heads[heads.length - 1].index! : 0
    out.push({ table: m[1], head: before.slice(start) })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion harness
// ─────────────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; detail?: string }
interface Assertion {
  id: string
  what: string
  layer: "source" | "behaviour"
  /** true = a KNOWN-OPEN finding outside this wave's edit scope. */
  openFinding?: boolean
  run: () => Outcome | Promise<Outcome>
  /** Source mutations that MUST flip this assertion to failure. */
  breaks: Array<{ file: string; find: string; replace: string }>
}

const A: Assertion[] = []

// ═════════════════════════════════════════════════════════════════════════════
// SEED — does `hazard_insurance_bound` reach a buyer's deal at all?
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "SEED.identity-is-on-the-buyer-journey-and-on-no-seller-journey",
  layer: "behaviour",
  what: "the hazard step is a catalog entry on the BUYER journey, resolves back to its canonical identity from the row a seeder would write, and is ABSENT from the seller journey — the buyer is the party who must have coverage in force at funding",
  run: () => {
    const buyer = BUYER_MILESTONE_JOURNEY.find((e) => e.id === "hazard_insurance_bound")
    if (!buyer) return { ok: false, detail: "the buyer journey does not declare hazard_insurance_bound" }
    if (SELLER_MILESTONE_JOURNEY.some((e) => e.id === "hazard_insurance_bound")) {
      return { ok: false, detail: "the SELLER journey declares it too — a seller would be asked for the buyer's policy" }
    }
    // A seeder writes milestone_name = entry.name and milestone_type = entry.id.
    // The row it writes must resolve BACK to the identity every reader matches on.
    const seededRow = { milestone_name: buyer.name, milestone_type: buyer.id }
    if (resolveMilestoneIdentity(seededRow) !== "hazard_insurance_bound") {
      return { ok: false, detail: `a seeded row (${buyer.name}) does not resolve to the identity readers match on` }
    }
    // Discrimination: the human name ALONE must still resolve, because
    // ensureRequiredMilestones and template seeders write different name shapes.
    if (resolveMilestoneIdentity({ milestone_name: buyer.name, milestone_type: null }) !== "hazard_insurance_bound") {
      return { ok: false, detail: "the human label alone does not resolve — a template-seeded row would be invisible" }
    }
    // …and an unrelated milestone must NOT resolve to it (an always-true resolver fails here).
    if (resolveMilestoneIdentity({ milestone_name: "Home Inspection", milestone_type: null }) === "hazard_insurance_bound") {
      return { ok: false, detail: "an unrelated milestone resolves to the hazard identity" }
    }
    if (!buyer.clientVisible) {
      return { ok: false, detail: "the step is hidden from the buyer, who is the person who has to buy the policy" }
    }
    return { ok: true, detail: `buyer journey entry "${buyer.name}" → hazard_insurance_bound, client-visible` }
  },
  breaks: [],
})

A.push({
  id: "SEED.the-journey-seeder-builds-its-rows-from-the-catalog",
  layer: "source",
  what: "seedJourneyMilestones inserts rows DERIVED from milestoneJourneyFor(...) — not from a list of its own — so the hazard step cannot be present in the catalog and absent from what lands on the deal",
  run: () => {
    const body = fnBody(code(F.seeder), "seedJourneyMilestones")
    if (!body) return { ok: false, detail: "seedJourneyMilestones is not a declared function in this module" }
    const m = /\b(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*milestoneJourneyFor\s*\(/.exec(body)
    if (!m) return { ok: false, detail: "no binding in the seeder is assigned from milestoneJourneyFor(...)" }
    const rowsIdent = m[1]
    const insert = new RegExp(`\\.from\\(\\s*["']transaction_milestones["']\\s*\\)\\s*\\.insert\\(\\s*${rowsIdent}\\b`)
    if (!insert.test(body)) {
      return { ok: false, detail: `the catalog-derived binding \`${rowsIdent}\` is not what gets inserted` }
    }
    if (!/milestone_type:\s*[A-Za-z0-9_$]+\.id/.test(body)) {
      return { ok: false, detail: "the inserted rows do not carry the catalog entry's canonical id as milestone_type" }
    }
    return { ok: true, detail: `\`${rowsIdent}\` ← milestoneJourneyFor(...) → inserted with canonical milestone_type` }
  },
  breaks: [
    {
      file: F.seeder,
      find: `  const rows = milestoneJourneyFor(transactionType)`,
      replace: `  const rows = ([] as any[])`,
    },
  ],
})

A.push({
  id: "SEED.the-offer-bridge-reaches-the-seeder-with-a-journey-containing-the-step",
  layer: "source",
  what: "THE LOAD-BEARING YES: createTransactionFromOffer calls the journey seeder, and the journey it names contains hazard_insurance_bound — so the step is SEEDED on a deal, not merely declared, and closing-orchestration's `find` is looking for a row that exists",
  run: () => {
    const src = code(F.bridge)
    const args = callArgs(src, "seedJourneyMilestones")
    if (!args) return { ok: false, detail: "the bridge never calls seedJourneyMilestones — nothing seeds the journey on an offer deal" }
    if (args.length < 3) return { ok: false, detail: `seedJourneyMilestones called with ${args.length} args; no journey argument` }
    const journeyArg = args[2]
    const lit = /^["']([^"']+)["']$/.exec(journeyArg)
    if (!lit) {
      // Derived (the fixed state): assert instead that BOTH journeys the helper
      // can return are still correct — the buyer one carries the step.
      return milestoneJourneyFor("purchase").some((e) => e.id === "hazard_insurance_bound")
        ? { ok: true, detail: `journey is derived (\`${journeyArg}\`); the buyer journey carries the step` }
        : { ok: false, detail: "the buyer journey no longer carries the step" }
    }
    const journey = milestoneJourneyFor(lit[1])
    return journey.some((e) => e.id === "hazard_insurance_bound")
      ? { ok: true, detail: `seedJourneyMilestones(..., "${lit[1]}") → journey of ${journey.length} incl. hazard_insurance_bound` }
      : { ok: false, detail: `the bridge seeds the "${lit[1]}" journey, which does NOT contain hazard_insurance_bound — the step never reaches the deal` }
  },
  breaks: [
    {
      // The call is now multi-line and DERIVED, so the old single-line find no
      // longer matched and the control had quietly become theatre — which this
      // harness catches and reports rather than counting as a pass. The mutation
      // now points the derived call at the journey that does NOT carry the step.
      file: F.bridge,
      find: `    dealType === "seller" ? "sale" : "purchase",`,
      replace: `    "sale",`,
    },
  ],
})

A.push({
  id: "SEED.the-seeded-journey-is-derived-from-the-deal-side",
  layer: "source",
  what: "the journey the bridge seeds is a function of the RESOLVED deal side, never a hardcoded literal. It WAS the literal \"purchase\", so a seller-side deal received the BUYER journey including the client-visible \"Homeowner's Insurance Bound\" step — which also made closing-orchestration's second buyer-side signal (`milestone != null`) vacuous, since every offer-bridge deal then carried the milestone and a seller-side deal could open an urgent hazard_insurance_unbound naming the OTHER brokerage's buyer",
  run: () => {
    const src = code(F.bridge)
    const args = callArgs(src, "seedJourneyMilestones")
    if (!args || args.length < 3) return { ok: false, detail: "no journey argument to inspect" }
    const journeyArg = args[2]
    if (/^["'][^"']*["']$/.test(journeyArg)) {
      return {
        ok: false,
        detail:
          `the journey is the literal ${journeyArg} while \`dealType\` (resolved a few lines above, and written to transactions.deal_type) is ignored. ` +
          `FIX, one line in ${F.bridge}: seedJourneyMilestones(transaction.id, params.brokerageId, dealType === "seller" ? "sale" : "purchase")`,
      }
    }
    return { ok: true, detail: `journey derived from \`${journeyArg}\`` }
  },
  breaks: [
    {
      file: F.bridge,
      find: `    dealType === "seller" ? "sale" : "purchase",`,
      replace: `    "purchase",`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// DRIVE — is anything actually firing the reminder windows?
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "DRIVE.a-hazard-detector-is-registered-and-derives-its-verdict-from-the-shared-evaluator",
  layer: "source",
  what: "the closing engine's detector library contains a detector whose body reaches readHazardInsurance, hazardSeverity and hazardReminderHeadline — the declared lead-time windows have a driver, and what the cron acts on is what the panel renders",
  run: () => {
    const src = code(F.engine)
    // The declaration's TYPE contains `=>`, so the `= [` that opens the registry
    // has to be found by scanning forward from the binding rather than by a
    // single regex over the whole declaration.
    const listStart = src.indexOf("const DETECTORS")
    if (listStart === -1) return { ok: false, detail: "no DETECTORS registry in the engine" }
    const eq = /=\s*\[/.exec(src.slice(listStart))
    if (!eq) return { ok: false, detail: "the DETECTORS binding is not an array literal" }
    const open = listStart + eq.index + eq[0].length - 1
    const close = src.indexOf("]", open)
    const registered = src.slice(open + 1, close).split(",").map((s) => s.trim()).filter(Boolean)
    const hazard = registered.filter((name) => {
      const body = fnBody(src, name)
      return !!body && /readHazardInsurance\s*\(/.test(body)
    })
    if (hazard.length === 0) {
      return { ok: false, detail: `none of the ${registered.length} registered detectors reads the hazard evaluator — the windows are declared with nothing firing them` }
    }
    const body = fnBody(src, hazard[0])!
    const missing = ["hazardSeverity", "hazardReminderHeadline"].filter((f) => !new RegExp(`${f}\\s*\\(`).test(body))
    if (missing.length) {
      return { ok: false, detail: `${hazard[0]} re-derives ${missing.join(" + ")} locally instead of sharing the pure function — the badge and the alarm can drift` }
    }
    if (!/blocksClosing/.test(body)) {
      return { ok: false, detail: `${hazard[0]} does not gate on the evaluator's blocksClosing verdict` }
    }
    return { ok: true, detail: `${hazard[0]} registered among ${registered.length} detectors, verdict + severity + headline all from the shared evaluator` }
  },
  breaks: [
    { file: F.engine, find: `  detectHazardInsuranceUnbound,\n]`, replace: `]` },
    {
      file: F.engine,
      find: `    severity:           hazardSeverity(status),`,
      replace: `    severity:           status.daysToClose != null && status.daysToClose <= 7 ? "urgent" : "high",`,
    },
  ],
})

A.push({
  id: "DRIVE.the-engine-is-driven-by-a-cron-secret-not-a-cookie-session",
  layer: "source",
  what: "the route that runs the engine verifies the cron secret BEFORE doing any work, and neither the route nor the engine is a `use server` module — a session-gated module cannot be driven by a cron, which is what made the earnest-money watchdog return Unauthorized on every iteration for its whole life",
  run: () => {
    const src = code(F.cronRoute)
    if (isUseServerModule(F.cronRoute)) return { ok: false, detail: "the route itself is a `use server` module" }
    if (isUseServerModule(F.engine)) return { ok: false, detail: "the engine is a `use server` module — a cron cannot drive it" }
    const guard = src.search(/\bverifyCronAuth\s*\(/)
    if (guard === -1) return { ok: false, detail: "the route does not verify the cron secret at all" }
    const work = src.search(/\brunClosingOrchestration\s*\(/)
    if (work === -1) return { ok: false, detail: "the route does not run the engine" }
    if (guard > work) return { ok: false, detail: "the engine runs before the cron secret is checked" }
    if (/@\/lib\/supabase\/server/.test(code(F.engine))) {
      return { ok: false, detail: "the engine imports the cookie-session client — there is no session on a cron invocation" }
    }
    if (!/createServiceClient/.test(code(F.engine))) {
      return { ok: false, detail: "the engine does not use the service client" }
    }
    return { ok: true, detail: "secret checked first; engine on the service client, no session in its graph" }
  },
  breaks: [
    {
      file: F.cronRoute,
      find: `  const unauth = verifyCronAuth(request)`,
      replace: `  const unauth = null as any`,
    },
  ],
})

A.push({
  id: "DRIVE.the-route-is-on-the-dispatchers-schedule-registry",
  layer: "source",
  what: "the cron registry the per-minute dispatcher fans out from carries this route's path with a schedule — a route nobody calls is a window that never fires, and vercel.json holds exactly one cron (the dispatcher), so the registry IS the schedule",
  run: () => {
    const wanted = "/" + F.cronRoute.replace(/^app\//, "").replace(/\/route\.ts$/, "")
    const src = code(F.cronReg)
    const entry = new RegExp(
      `\\{[^{}]*path:\\s*["']${wanted.replace(/\//g, "\\/")}["'][^{}]*schedule:\\s*["']([^"']+)["'][^{}]*\\}`,
    ).exec(src)
    if (!entry) return { ok: false, detail: `no registry entry pairs ${wanted} with a schedule — nothing ever calls the route` }
    const fields = entry[1].trim().split(/\s+/)
    if (fields.length !== 5) return { ok: false, detail: `the schedule "${entry[1]}" is not a 5-field cron expression` }
    return { ok: true, detail: `${wanted} on "${entry[1]}"` }
  },
  breaks: [
    {
      file: F.cronReg,
      find: `  { path: "/api/cron/closing-orchestration"               , schedule: "0 */6 * * *" },`,
      replace: `  { path: "/api/cron/closing-orchestration-disabled"      , schedule: "0 */6 * * *" },`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// REFUSE — "nothing came back" is never health
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "REFUSE.every-supabase-statement-in-the-action-destructures-its-error",
  layer: "source",
  what: "supabase-js RESOLVES a refused query, so an undestructured read hands back data:null — indistinguishable from an empty table, and on this screen the opposite fact. Every .from(...) statement in the action names `error` in its destructuring",
  run: () => {
    const stmts = fromCallStatements(code(F.action))
    if (stmts.length === 0) return { ok: false, detail: "no supabase statements found — the scan is broken, not the file" }
    const blind = stmts.filter((s) => !/\berror\b/.test(s.head)).map((s) => s.table)
    return blind.length === 0
      ? { ok: true, detail: `${stmts.length} statements, all error-destructured` }
      : { ok: false, detail: `statement(s) that cannot tell a refusal from an empty result: ${[...new Set(blind)].join(", ")}` }
  },
  breaks: [
    {
      file: F.action,
      find: `  const { data, error } = await svc`,
      replace: `  const { data } = await svc`,
    },
    {
      file: F.action,
      find: `    const { data: doc, error: docError } = await svc`,
      replace: `    const { data: doc } = await svc`,
    },
  ],
})

A.push({
  id: "REFUSE.a-refused-insurance-read-returns-no-posture-at-all",
  layer: "source",
  what: "when the insurance read is REFUSED the action returns before the evaluator is ever called, with the failure named and a NULL status — because degrading a refusal to posture 'none' would paint a red 'no coverage on this deal' blocker over a policy that exists",
  run: () => {
    const body = fnBody(code(F.action), "getTransactionHazardInsuranceAction")
    if (!body) return { ok: false, detail: "getTransactionHazardInsuranceAction is not a declared function" }
    const guard = /if\s*\(\s*!\s*([A-Za-z0-9_$]+)\.ok\s*\)\s*\{([\s\S]*?)\n  \}/.exec(body)
    if (!guard) return { ok: false, detail: "no `if (!<read>.ok)` refusal branch in the read action" }
    const branch = guard[2]
    if (!/\breturn\b/.test(branch)) return { ok: false, detail: "the refusal branch does not return — execution falls through into the evaluator" }
    if (!/\berror\b/.test(branch)) return { ok: false, detail: "the refusal branch returns without naming the failure" }
    const evalAt = body.search(/\breadHazardInsurance\s*\(/)
    if (evalAt !== -1 && evalAt < guard.index) {
      return { ok: false, detail: "the evaluator runs BEFORE the refusal is checked — a refused read is rendered as a posture" }
    }
    // The refusal shape itself: the `empty` view must carry a null status.
    if (!/status:\s*null/.test(body)) {
      return { ok: false, detail: "the refusal shape does not pin status to null" }
    }
    if (!/ok:\s*false/.test(body)) {
      return { ok: false, detail: "the refusal shape does not pin ok to false" }
    }
    return { ok: true, detail: "refusal returns first, names the failure, status null / ok false" }
  },
  breaks: [
    {
      file: F.action,
      find: `  if (!services.ok) {`,
      replace: `  if (false as boolean) {`,
    },
  ],
})

A.push({
  id: "REFUSE.the-panel-states-a-failed-read-instead-of-rendering-a-posture",
  layer: "source",
  what: "the panel refuses to dereference the status until it has checked both `ok` and the presence of a status — an empty panel would read as 'not yet provided', which is the opposite of 'we could not look'",
  run: () => {
    const src = code(F.panel)
    const guard = /if\s*\(\s*!\s*view\.ok\s*\|\|\s*!\s*view\.status\s*\)/.exec(src)
    if (!guard) return { ok: false, detail: "the panel has no combined ok/status guard" }
    const deref = src.search(/const\s+s\s*=\s*view\.status\b/)
    if (deref === -1) return { ok: false, detail: "cannot locate where the panel binds the status" }
    if (deref < guard.index) return { ok: false, detail: "the status is bound before the guard — a refused read renders as a posture" }
    if (!/view\.error/.test(src)) return { ok: false, detail: "the panel never surfaces the reported failure" }
    return { ok: true, detail: "guard precedes the status binding and the failure is stated" }
  },
  breaks: [
    {
      file: F.panel,
      find: `  if (!view.ok || !view.status) {`,
      replace: `  if (false) {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// HONEST — the badge may never be calmer than the verdict
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "HONEST.the-panels-blocker-framing-keys-off-the-verdict-not-the-posture-name",
  layer: "source",
  what: "a policy that is BOUND but whose binder was never filed is not a green state — the lender underwrites the document. The panel's badge and its deadline box both follow `blocksClosing`, the evaluator's verdict, rather than the posture NAME",
  run: () => {
    const src = code(F.panel)
    // The posture's own palette is `style.className`. EVERY expression that
    // reaches for it must also consult the verdict, or some state renders in the
    // colour its NAME suggests instead of the colour the evaluator ruled.
    const paletteExprs = [...src.matchAll(/className=\{([\s\S]*?)\}\s*\n/g)]
      .map((m) => m[1])
      .filter((e) => /\bstyle\.className\b/.test(e))
    if (paletteExprs.length === 0) return { ok: false, detail: "no expression in the panel selects a posture palette" }
    const blind = paletteExprs.filter((e) => !/blocksClosing/.test(e))
    if (blind.length) {
      return { ok: false, detail: `posture palette chosen without consulting the verdict: ${blind.map((e) => e.trim()).join(" | ")} — a bound-but-unevidenced policy would render green` }
    }
    const uses = (src.match(/\bs\.blocksClosing\b/g) ?? []).length
    if (uses < 2) return { ok: false, detail: `blocksClosing is consulted ${uses}× — the deadline box no longer follows the verdict` }
    return { ok: true, detail: `${paletteExprs.length} palette expression(s) gated on the verdict, ${uses} verdict site(s) total` }
  },
  breaks: [
    {
      file: F.panel,
      find: `            className={s.blocksClosing ? POSTURE_STYLE.lapsed.className : style.className}`,
      replace: `            className={style.className}`,
    },
  ],
})

A.push({
  id: "HONEST.the-panels-style-map-is-exhaustive-over-the-posture-union",
  layer: "source",
  what: "every member of HazardPosture has an entry in the panel's style map — a posture the map does not know renders as an undefined style, i.e. an unstyled badge on the one state nobody anticipated",
  run: () => {
    const unionSrc = code(F.evaluator)
    const decl = /export type HazardPosture\s*=([\s\S]*?)\n\n/.exec(unionSrc)
    if (!decl) return { ok: false, detail: "cannot locate the HazardPosture union" }
    const members = new Set([...decl[1].matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]))
    if (members.size === 0) return { ok: false, detail: "the posture union parsed as empty — the scan is broken" }
    const mapSrc = code(F.panel)
    const mapDecl = /POSTURE_STYLE[^=]*=\s*\{/.exec(mapSrc)
    if (!mapDecl) return { ok: false, detail: "no POSTURE_STYLE map in the panel" }
    // The `{` of the object literal is the LAST character of the matched
    // declaration — the annotation `Record<HazardPosture, { … }>` carries a brace
    // of its own and indexOf would find that one.
    const open = mapDecl.index + mapDecl[0].length - 1
    const body = mapSrc.slice(open, matchBrace(mapSrc, open) + 1)
    const keys = new Set([...body.matchAll(/(?:^|\n)\s*([a-z_]+)\s*:/g)].map((m) => m[1]))
    const missing = [...members].filter((m) => !keys.has(m))
    const extra = [...keys].filter((k) => !members.has(k))
    if (missing.length) return { ok: false, detail: `posture(s) with no style: ${missing.join(", ")}` }
    if (extra.length) return { ok: false, detail: `style key(s) for no posture: ${extra.join(", ")}` }
    return { ok: true, detail: `${members.size} postures, ${keys.size} styles, exact cover` }
  },
  breaks: [
    {
      file: F.panel,
      find: `  expiry_unknown:  { className: "bg-amber-50 text-amber-800 border-amber-200",     Icon: ShieldQuestion },\n`,
      replace: ``,
    },
  ],
})

A.push({
  id: "HONEST.the-action-passes-the-resolved-deal-side-into-the-evaluator",
  layer: "source",
  what: "the panel's read passes the RESOLVED deal side into the evaluator rather than a constant — on a seller-side deal the buyer is the other brokerage's client, we never see their binder, and 'nothing on file' means we were not told",
  run: () => {
    const body = fnBody(code(F.action), "getTransactionHazardInsuranceAction")
    if (!body) return { ok: false, detail: "the read action is not a declared function" }
    const call = /readHazardInsurance\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(body)
    if (!call) return { ok: false, detail: "the read action does not call the evaluator with an object argument" }
    const prop = /representsBuyer\s*:\s*([^,\n]+)/.exec(call[1])
    if (!prop) return { ok: false, detail: "the deal side is not passed — the evaluator falls back to assuming we represent the buyer" }
    const value = prop[1].trim()
    if (/^(true|false)$/.test(value)) return { ok: false, detail: `the deal side is hardcoded to ${value}` }
    if (!/\bscope\b|\bdealType\b|\brepresentsBuyer\b/.test(value)) {
      return { ok: false, detail: `the deal side comes from \`${value}\`, which is not the resolved transaction scope` }
    }
    return { ok: true, detail: `representsBuyer ← ${value}` }
  },
  breaks: [
    {
      file: F.action,
      find: `    now: new Date(),\n    representsBuyer: scope.representsBuyer,\n  })`,
      replace: `    now: new Date(),\n  })`,
    },
  ],
})

A.push({
  id: "HONEST.the-evaluator-refuses-to-raise-a-blocker-on-a-deal-whose-buyer-is-not-ours",
  layer: "behaviour",
  what: "with the SAME inputs, a deal we represent the buyer on inside the lead-time window raises a closing blocker and one we do not does NOT — and omitting the flag keeps the pre-existing buyer-side behaviour exactly, so no caller silently changes meaning",
  run: () => {
    const now = new Date("2026-08-11T00:00:00.000Z")
    const closeIn3 = "2026-08-14"
    const ours = readHazardInsurance({ service: null, closeDate: closeIn3, now, representsBuyer: true })
    const theirs = readHazardInsurance({ service: null, closeDate: closeIn3, now, representsBuyer: false })
    const dflt = readHazardInsurance({ service: null, closeDate: closeIn3, now })

    if (!ours.blocksClosing) return { ok: false, detail: "our own buyer, 3 days out, nothing on file — and no blocker raised" }
    if (theirs.blocksClosing) return { ok: false, detail: "a blocker was raised on the other brokerage's buyer, from a silence we could not have observed" }
    if (!dflt.blocksClosing) return { ok: false, detail: "the default changed meaning — an existing caller that omits the flag lost its alarm" }
    if (ours.representsBuyer !== true || theirs.representsBuyer !== false) {
      return { ok: false, detail: "the status does not carry the side it was evaluated under" }
    }
    if (ours.detail === theirs.detail) {
      return { ok: false, detail: "both sides get the same sentence — the seller-side reading is not stated" }
    }
    // Discrimination: outside the window, our own buyer must ALSO be quiet.
    const far = readHazardInsurance({ service: null, closeDate: "2026-12-01", now, representsBuyer: true })
    if (far.blocksClosing) return { ok: false, detail: "a blocker is raised months out — the lead time is not being applied" }
    // …and a policy that lapses before the close is a blocker on OUR side at any distance.
    const lapsing: HazardServiceRow = {
      id: "svc-1", service_type: "insurance_quote", status: "bound", vendor_name: "Acme Mutual",
      vendor_id: null, quote_amount: null, cost: null,
      policy: { carrier: "Acme Mutual", expiry: "2026-11-01", document_id: "doc-1" },
    }
    const before = readHazardInsurance({ service: lapsing, closeDate: "2026-12-01", now, representsBuyer: true })
    if (!before.expiresBeforeClosing || !before.blocksClosing) {
      return { ok: false, detail: "a policy expiring before the close date is not flagged — the one case where 'insured today' and 'insured at funding' disagree" }
    }
    if (!HAZARD_NOT_OUR_SIDE_NOTE.length) return { ok: false, detail: "the seller-side note is empty" }
    return { ok: true, detail: "blocker on our side only, default unchanged, lead time and pre-close lapse both still bite" }
  },
  breaks: [],
})

// ═════════════════════════════════════════════════════════════════════════════
// SELECT — which engagement IS the deal's coverage record
// ═════════════════════════════════════════════════════════════════════════════

const svcRow = (id: string, policy: HazardServiceRow["policy"], status = "quote_requested"): HazardServiceRow => ({
  id, service_type: "insurance_quote", status, vendor_name: `carrier-${id}`,
  vendor_id: null, quote_amount: null, cost: null, policy,
})

A.push({
  id: "SELECT.the-coverage-record-is-the-policy-bearing-engagement",
  layer: "behaviour",
  what: "a deal can hold several insurance engagements (a fresh row per quote request, no uniqueness on the pair). The selector prefers the one that actually CARRIES a policy over a newer bare quote — otherwise requesting one more comparison quote after binding hides the coverage and both the panel and the cron report the opposite of the truth",
  run: () => {
    const bound = svcRow("bound", { carrier: "Acme Mutual", expiry: "2027-09-01", document_id: "doc-1" }, "bound")
    const bare = svcRow("bare", null)
    const empty = svcRow("empty", {})

    // Newest first, newest is a bare quote → the bound row is still the record.
    if (selectHazardService([bare, bound])?.id !== "bound") {
      return { ok: false, detail: "a newer bare quote hid the bound policy" }
    }
    // An EMPTY policy object is not a policy. The selector and the EVALUATOR must
    // agree on that — one definition lives inside the evaluator module and both
    // read it — so this is checked from BOTH ends: the selector skips the empty
    // row, and the evaluator reads that same row as nothing on file.
    const emptyRead = readHazardInsurance({ service: empty, closeDate: null, now: new Date("2026-08-11T00:00:00.000Z") })
    if (emptyRead.hasPolicyOnFile) return { ok: false, detail: "the evaluator read `{}` as a policy on file" }
    if (selectHazardService([empty, bound])?.id !== "bound") {
      return { ok: false, detail: "an empty `{}` policy object was treated as the coverage record" }
    }
    // Discrimination: with no policy anywhere, it must still be the NEWEST row —
    // an implementation that always hunts for a policy would return null here.
    if (selectHazardService([bare, empty])?.id !== "bare") {
      return { ok: false, detail: "with nothing bound, the newest engagement is not selected" }
    }
    // …and an implementation that always returns [0] fails the first case above.
    if (selectHazardService([])?.id !== undefined) return { ok: false, detail: "an empty list did not resolve to null" }
    if (selectHazardService(null) !== null) return { ok: false, detail: "a null list did not resolve to null" }

    // End to end: the selected row is what the evaluator reads as coverage.
    const status = readHazardInsurance({
      service: selectHazardService([bare, bound]),
      closeDate: "2026-08-20",
      now: new Date("2026-08-11T00:00:00.000Z"),
    })
    if (!status.hasPolicyOnFile || status.posture !== "bound") {
      return { ok: false, detail: `the selected row read as ${status.posture}, not bound coverage` }
    }
    return { ok: true, detail: "policy-bearing row wins; empty `{}` is not a policy; newest wins when nothing is bound" }
  },
  breaks: [],
})

A.push({
  id: "SELECT.both-the-read-and-the-write-in-the-action-resolve-through-the-selector",
  layer: "source",
  what: "the panel's read and the policy write resolve the SAME engagement through the SAME pure selector — otherwise binding lands on one row while the panel reads another, and the deal ends up with two policies and no way to say which is the coverage",
  run: () => {
    const src = code(F.action)
    const uses = (src.match(/selectHazardService\s*\(/g) ?? []).length
    if (uses < 2) return { ok: false, detail: `the selector is used ${uses}× — read and write do not both go through it` }
    const readBody = fnBody(src, "getTransactionHazardInsuranceAction")
    if (!readBody) return { ok: false, detail: "the read action is not a declared function" }
    const call = /readHazardInsurance\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(readBody)
    const svcProp = call && /service\s*:\s*([^,\n]+)/.exec(call[1])
    if (!svcProp) return { ok: false, detail: "cannot locate the evaluator's `service` argument" }
    if (!/selectHazardService\s*\(/.test(svcProp[1])) {
      return { ok: false, detail: `the evaluator is handed \`${svcProp[1].trim()}\` — an index, not the selector's verdict` }
    }
    if (/\.limit\(\s*1\s*\)/.test(src)) {
      return { ok: false, detail: "a read still truncates to one row, so the selector can never see the policy-bearing engagement" }
    }
    return { ok: true, detail: `selector used ${uses}×; the evaluator reads its verdict; no single-row truncation` }
  },
  breaks: [
    {
      file: F.action,
      find: `    service: selectHazardService(services.rows),`,
      replace: `    service: services.rows[0] ?? null,`,
    },
  ],
})

A.push({
  id: "SELECT.the-closing-engine-resolves-the-same-engagement-as-the-panel",
  layer: "source",
  what: "the closing engine and the panel resolve the deal's coverage record through the SAME selector. The engine used to hand the evaluator `insuranceServices[0]`, the NEWEST engagement; the evaluator's whole contract is that an agent never sees a calmer badge than the cron acted on, and two different selections off one list break it — the cron raising hazard_insurance_unbound over coverage the panel shows as bound, each surface authoritative on its own screen",
  run: () => {
    const src = code(F.engine)
    const call = /readHazardInsurance\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(src)
    if (!call) return { ok: false, detail: "the engine does not call the evaluator with an object argument" }
    const svcProp = /service\s*:\s*([^,\n]+)/.exec(call[1])
    if (!svcProp) return { ok: false, detail: "cannot locate the engine's `service` argument" }
    const value = svcProp[1].trim()
    if (/selectHazardService\s*\(/.test(value)) return { ok: true, detail: `engine resolves via the shared selector (${value})` }
    return {
      ok: false,
      detail:
        `the engine picks \`${value}\` instead of the shared selector. ` +
        `FIX, one line in ${F.engine}: service: selectHazardService(ev.insuranceServices)  ` +
        `(plus adding selectHazardService to the existing import from ./hazard-insurance)`,
    }
  },
  breaks: [
    {
      file: F.engine,
      find: `    service: selectHazardService(ev.insuranceServices),`,
      replace: `    service: ev.insuranceServices[0] ?? null,`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// EVALUATOR — the pure functions, driven with real inputs
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "EVAL.every-posture-is-derived-and-none-is-rounded-up-to-covered",
  layer: "behaviour",
  what: "the evaluator is driven across the whole posture space with real records: absence, quoted, approved-not-bound, bound-with-and-without a binder, expiring, lapsed, and an expiry it cannot parse — the last of which must stay its own answer rather than being rounded to covered or to lapsed",
  run: () => {
    const now = new Date("2026-08-11T00:00:00.000Z")
    const close = "2026-08-16"                  // 5 days out — inside the lead time
    const R = (service: HazardServiceRow | null, closeDate: string | null = close) =>
      readHazardInsurance({ service, closeDate, now })

    const cases: Array<[string, boolean]> = []
    const expect = (name: string, cond: boolean) => cases.push([name, cond])

    const none = R(null)
    expect("no engagement → posture none, nothing on file, blocker inside the lead time",
      none.posture === "none" && !none.hasPolicyOnFile && none.blocksClosing)
    expect("the binder due date is the close date minus the lead time",
      none.evidenceDueDate === "2026-08-06" && HAZARD_EVIDENCE_LEAD_DAYS === 10)
    expect("no close date → no fabricated deadline and no blocker",
      (() => { const s = R(null, null); return s.evidenceDueDate === null && s.daysToClose === null && !s.blocksClosing })())

    const quoted = R(svcRow("q", null, "quote_requested"))
    expect("engagement, no policy → quote_requested and NOT coverage",
      quoted.posture === "quote_requested" && !quoted.coverageInForce && quoted.blocksClosing)

    const approved = R(svcRow("a", null, "approved"))
    expect("an APPROVED quote is still not coverage",
      approved.posture === "quote_approved" && !approved.coverageInForce && approved.blocksClosing)

    const emptyObj = R(svcRow("e", {}, "bound"))
    expect("`{}` is not a policy — it reads as nothing on file, never as a bound policy with blank fields",
      !emptyObj.hasPolicyOnFile && emptyObj.posture !== "bound")

    const boundNoDoc = R(svcRow("b1", { carrier: "Acme Mutual", policy_number: "HO-1", coverage_amount: 450000, expiry: "2027-09-01" }, "bound"))
    expect("bound but no binder filed → coverage in force, evidence missing, STILL a closing item",
      boundNoDoc.posture === "bound" && boundNoDoc.coverageInForce && boundNoDoc.missingEvidenceDocument && boundNoDoc.blocksClosing)
    expect("…and its badge does not read green",
      /not filed/i.test(boundNoDoc.label))

    const boundDoc = R(svcRow("b2", { carrier: "Acme Mutual", expiry: "2027-09-01", document_id: "doc-1" }, "bound"))
    expect("bound WITH the binder on file → no closing item",
      boundDoc.posture === "bound" && boundDoc.coverageInForce && !boundDoc.missingEvidenceDocument && !boundDoc.blocksClosing)

    const expiring = R(svcRow("b3", { carrier: "Acme Mutual", expiry: "2026-09-20", document_id: "doc-1" }, "bound"))
    expect("expiry inside the widest reminder window → expiring, still in force",
      expiring.posture === "expiring" && expiring.coverageInForce && HAZARD_EXPIRING_DAYS === 60)

    const preClose = R(svcRow("b4", { carrier: "Acme Mutual", expiry: "2026-08-15", document_id: "doc-1" }, "bound"))
    expect("expiry on or before the close date → blocker regardless of the binder",
      preClose.expiresBeforeClosing && preClose.blocksClosing)

    const lapsed = R(svcRow("b5", { carrier: "Acme Mutual", expiry: "2026-07-01", document_id: "doc-1" }, "bound"))
    expect("expiry already past → lapsed and NOT in force",
      lapsed.posture === "lapsed" && !lapsed.coverageInForce && lapsed.blocksClosing)

    const unreadable = R(svcRow("b6", { carrier: "Acme Mutual", expiry: "not-a-date", document_id: "doc-1" }, "bound"))
    expect("an unparseable expiry is its OWN answer — never covered, never lapsed",
      unreadable.posture === "expiry_unknown" && !unreadable.coverageInForce && unreadable.daysToExpiry === null)

    expect("nothing is ever asserted: no figure appears that was not stored",
      none.carrier === null && none.coverageAmount === null && none.annualPremium === null && none.expiry === null)

    // Severity + headline, shared with the cron.
    expect("severity escalates inside the urgent window and abstains without a close date",
      hazardSeverity(R(null, "2026-08-13")) === "urgent" &&
      hazardSeverity(R(null, "2026-08-20")) === "high" &&
      hazardSeverity(R(null, null)) === "medium" &&
      HAZARD_EVIDENCE_URGENT_DAYS === 7)

    // The headline must cover the whole posture union with something specific:
    // no default branch, and no two postures sharing one sentence.
    const byPosture = new Map<HazardPosture, string>()
    for (const s of [none, quoted, approved, boundNoDoc, boundDoc, expiring, preClose, lapsed, unreadable]) {
      byPosture.set(s.posture, hazardReminderHeadline(s))
    }
    expect("every posture reached produces a non-empty, posture-specific headline",
      [...byPosture.values()].every((h) => h.length > 0) &&
      new Set([...byPosture.values()]).size >= byPosture.size)

    const bad = cases.filter(([, ok]) => !ok).map(([n]) => n)
    return bad.length === 0
      ? { ok: true, detail: `${cases.length} evaluator cases, all held` }
      : { ok: false, detail: `failed: ${bad.join(" | ")}` }
  },
  breaks: [],
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  let pass = 0, failScoped = 0, failOpen = 0
  const failures: string[] = []

  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────")
  const redIds = new Set<string>()
  for (const a of A) {
    const r = await a.run()
    if (r.ok) {
      pass++
      console.log(`  ✔ ${a.id}\n      ${a.what}${r.detail ? `\n      → ${r.detail}` : ""}`)
    } else {
      redIds.add(a.id)
      if (a.openFinding) failOpen++; else failScoped++
      failures.push(`${a.openFinding ? "[OPEN] " : ""}${a.id}: ${r.detail ?? ""}`)
      console.log(`  ✘ ${a.id}${a.openFinding ? "   (KNOWN-OPEN, outside this wave's edit scope)" : ""}\n      ${a.what}\n      → ${r.detail ?? ""}`)
    }
  }

  let negPass = 0, negFail = 0, negSkip = 0
  const negProblems: string[] = []
  if (RUN_NEGATIVE) {
    console.log("\n─── NEGATIVE CONTROLS (the defect is written back on purpose) ────")
    for (const a of A) {
      if (redIds.has(a.id)) {
        negSkip++
        console.log(`  · ${a.id}  control skipped — the assertion is ALREADY RED; breaking a broken thing proves nothing`)
        continue
      }
      if (a.breaks.length === 0) {
        if (a.layer === "behaviour") {
          console.log(`  · ${a.id}  controlled by DISCRIMINATION (the run pairs each positive with the cases that must NOT match)`)
          continue
        }
        negFail++
        negProblems.push(`${a.id}: source assertion with NO negative control`)
        console.log(`  ✘ ${a.id}  no negative control defined`)
        continue
      }
      for (let i = 0; i < a.breaks.length; i++) {
        const b = a.breaks[i]
        const path = resolve(ROOT, b.file)
        const before = readFileSync(path, "utf8")
        const digest = createHash("sha256").update(before).digest("hex")
        const after = before.replace(b.find, b.replace)
        if (after === before) {
          negFail++
          negProblems.push(`${a.id}[${i}]: the mutation DID NOT APPLY to ${b.file} — the control is theatre`)
          console.log(`  ✘ ${a.id}[${i}]  mutation did not apply to ${b.file} — fix the find string`)
          continue
        }
        writeFileSync(path, after, "utf8")
        let broke = false, detail = ""
        try { const r = await a.run(); broke = !r.ok; detail = r.detail ?? "" }
        catch (e) { broke = true; detail = `threw: ${(e as Error).message}` }
        finally { writeFileSync(path, before, "utf8") }
        const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digest
        if (broke && restored) {
          negPass++
          console.log(`  ✔ ${a.id}[${i}]  flipped RED as required, ${b.file} restored (sha256 verified)`)
        } else {
          negFail++
          if (!broke) negProblems.push(`${a.id}[${i}]: still PASSED with the defect reintroduced — the assertion is worthless as written`)
          if (!restored) negProblems.push(`${a.id}[${i}]: FILE NOT RESTORED (${b.file})`)
          console.log(`  ✘ ${a.id}[${i}]  ${!broke ? "did NOT flip" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
        }
      }
    }
  }

  console.log("\n" + "═".repeat(72))
  console.log(` ASSERTIONS        ${pass} passed, ${failScoped} failed in scope, ${failOpen} KNOWN-OPEN (out of scope)`)
  if (RUN_NEGATIVE) console.log(` CONTROLS          ${negPass} flipped RED as required, ${negFail} did not, ${negSkip} skipped (already red)`)
  console.log("═".repeat(72))
  if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log("  · " + f)) }
  if (negProblems.length) { console.log("\nControl problems:"); negProblems.forEach((f) => console.log("  · " + f)) }

  if (failScoped > 0 || negFail > 0) {
    console.log("\n ❌ HAZARD_INSURANCE_STEP_FAIL — an in-scope assertion or a control failed")
    process.exit(1)
  }
  if (failOpen > 0) {
    console.log(`\n ❌ HAZARD_INSURANCE_STEP_OPEN — every in-scope assertion holds; ${failOpen} named out-of-scope defect(s) remain, each a one-line fix in the message above`)
    process.exit(1)
  }
  console.log("\n ✅ HAZARD_INSURANCE_STEP_PASS — the step is seeded onto a buyer's deal, the reminder lane is driven by a cron-gated route, and a reader that cannot see the data refuses instead of reporting all clear")
}

main().catch((e) => { console.error(e); process.exit(1) })
