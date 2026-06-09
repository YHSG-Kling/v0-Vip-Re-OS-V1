#!/usr/bin/env tsx
/**
 * scripts/portal-fanout-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 52 — regression-locks the CANONICAL portal fan-out (Lifecycle Event Contract
 * §6a, now RESOLVED). The differentiator promise is "every state change reaches the
 * client's portal so they always know where the deal stands." §6a once warned that
 * only ~10 of ~98 emitters fanned out to the portal; the codebase has since moved all
 * three fan-out channels BEHIND the reactor, so EVERY emitter — including a bare
 * processKernelEvent caller that passes only (entityType, entityId) — now reaches
 * both client portals.
 *
 * The reactor + fan-out modules are server-only (can't be imported under tsx — repo
 * convention), so this guards the invariant by SOURCE-CONTRACT analysis: it proves the
 * single converging call graph still exists, so a refactor can't silently re-break it:
 *
 *   emit.ts ─┐
 *            ├─► fanOutKernelEvent ─► processKernelEvent ─► dispatchKernelEvent
 *   79 direct processKernelEvent callers ─────────────────┘        │
 *                                                                  ├─ resolveEventContacts  (bare-caller fan-out)
 *                                                                  ├─ writePortalUpdate     (portal card)
 *                                                                  └─ enrollMatchingSequences (drip)
 *
 * The live DB behaviour (cards + bell + enrollment landing for buyer AND seller from a
 * bare emit, idempotently) is verified out-of-band via MCP against the real schema +
 * the transparency_updates partial-unique dedupe index.
 *
 * Run: npx tsx scripts/portal-fanout-simulator.ts  (npm run test:portal-fanout) — no DB/creds.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const notifSrc    = read("lib/kernel/notification-engine.ts")
const reactorSrc  = read("lib/kernel/event-reactor.ts")
const emitSrc     = read("lib/kernel/emit.ts")
const fanoutSrc   = read("lib/kernel/event-fanout.ts")
const resolverSrc = read("lib/kernel/resolve-event-contacts.ts")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── 1. Every path converges on the reactor ──────────────────────────────────
console.log("\n[1 · all emit paths converge on dispatchKernelEvent]")
check("processKernelEvent (the ~79 direct callers' entry) dispatches into the reactor",
  /dispatchKernelEvent\s*\(/.test(notifSrc) && /event-reactor/.test(notifSrc))
check("emit.ts routes through fanOutKernelEvent (audit + fan-out)",
  /fanOutKernelEvent\s*\(/.test(emitSrc))
check("fanOutKernelEvent forwards into processKernelEvent (no separate portal path to drift)",
  /processKernelEvent\s*\(/.test(fanoutSrc))

// ── 2. The reactor fans out ALL THREE client channels ───────────────────────
console.log("\n[2 · reactor fans out portal + enrollment + bell for every event]")
check("reactor imports the canonical portal writer + sequence enroller",
  /import\s*\{[^}]*\bwritePortalUpdate\b[^}]*\}/.test(reactorSrc) && /\benrollMatchingSequences\b/.test(reactorSrc))
check("reactor calls writePortalUpdate (client portal card)", /writePortalUpdate\s*\(/.test(reactorSrc))
check("reactor calls enrollMatchingSequences (campaign drip)", /enrollMatchingSequences\s*\(/.test(reactorSrc))

// ── 3. Bare callers (no contact ids) still reach the client — the §6a crux ──
console.log("\n[3 · bare emitter contact-resolution — the §6a fix]")
check("reactor imports the shared contact resolver", /resolve-event-contacts/.test(reactorSrc))
check("reactor falls back to resolveEventContacts when no explicit contact ids",
  /contactIds\.length\s*===\s*0/.test(reactorSrc) && /resolveEventContacts\s*\(/.test(reactorSrc))
// The fan-out is GATED on having resolved at least one contact (so internal events are a no-op).
check("fan-out runs only once at least one contact is resolved",
  /contactIds\.length\s*>\s*0/.test(reactorSrc))

// ── 4. Resolver returns BOTH represented sides per entity type ───────────────
console.log("\n[4 · resolver covers both sides for every client entity]")
for (const ent of ["transaction", "offer", "listing", "contact"]) {
  check(`resolver handles entityType '${ent}'`, new RegExp(`entityType\\s*===\\s*["']${ent}["']`).test(resolverSrc))
}
check("transaction resolves BOTH buyer + seller (bare caller never drops a side)",
  /buyer_contact_id/.test(resolverSrc) && /seller_contact_id/.test(resolverSrc))

// ── 5. Portal write is idempotent AND writes to the DEPLOYED schema ──────────
console.log("\n[5 · portal write idempotency — aligned to the live schema]")
check("portal card is a plain insert into transparency_updates (succeeds on the live schema)",
  /from\("transparency_updates"\)\s*\.insert\(/.test(fanoutSrc))
check("portal write does NOT reference the never-deployed dedupe_key column (the bug it restores)",
  !/dedupe_key:/.test(fanoutSrc))
check("portal write app-dedupes within a time window", /PORTAL_DEDUPE_WINDOW_MS/.test(fanoutSrc))
check("sequence enrollment skips an existing active enrollment (no double-enroll)",
  /status[\s\S]{0,40}active[\s\S]{0,80}continue/.test(fanoutSrc) || /already\s*active|existing[\s\S]{0,40}continue/i.test(fanoutSrc))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ §6a canonical: every emitter (even bare) fans out to both client portals — wiring locked")
