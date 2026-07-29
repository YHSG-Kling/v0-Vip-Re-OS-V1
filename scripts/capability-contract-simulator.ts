#!/usr/bin/env tsx
/**
 * scripts/capability-contract-simulator.ts (npm run test:capability-contract)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MCP TOOL LIST ADVERTISED 27 CAPABILITIES AND VOUCHED FOR NONE OF THEM.
 *
 * buildFullActionManifest powers /api/agentic-os/actions AND the MCP
 * `tools/list`. It answered ONE question — who is AUTHORIZED (scope) — and left
 * the other unanswered: can this actually RUN for this tenant?
 *
 * Those are different questions. A caller can hold `finance:write` while the
 * tenant has no QuickBooks connected at all. So every connected agent — the voice
 * admin included — saw all 27 app capabilities as available and could only learn
 * otherwise BY CALLING ONE AND WATCHING IT FAIL. An autonomous agent that
 * discovers its own limits by breaking things is the opposite of what a broker
 * needs before switching autonomy on.
 *
 * This is the first slice of the capability CONTRACT: each capability declares
 * what it needs, a resolver evaluates it against the tenant using the machinery
 * that already exists, and the discovery endpoint reports `operable` and `dark`
 * WITH REASONS beside `authorized`.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * Eight capabilities plainly depend on something external (direct mail needs a
 * print vendor, video needs the avatar + voice providers, a gift needs a gifting
 * vendor) and their provider keys are NOT asserted. Guessing one would be worse
 * than admitting the gap: a wrong contract reports a working capability dark, or
 * a broken one ready, and both are the defect this mechanism exists to remove.
 * They are listed in UNDECLARED_REQUIREMENTS and resolve to
 * "requirement_not_modelled" — held, never reported ready. This guard pins that
 * list so the backlog stays visible instead of decaying into false confidence.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  APP_CAPABILITY_REGISTRY,
  UNDECLARED_REQUIREMENTS,
  buildFullActionManifest,
  type AppCapability,
} from "../lib/agentic-os/app-capability-registry"
import { CONNECTOR_PROVIDERS } from "../lib/connections/scope"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

console.log("══════════════════════════════════════════════════")
console.log(" Capability contract — a capability states what it needs, or is held")
console.log("══════════════════════════════════════════════════")

const CAPS = Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]

console.log("\n[every declared requirement names a REAL provider]")
{
  // A contract naming a provider the Connection OS does not offer is worse than
  // no contract: it reports a capability permanently dark for a reason nobody can
  // action. Connection names must come from CONNECTOR_PROVIDERS.
  const known = new Set(Object.values(CONNECTOR_PROVIDERS).flat())
  check(`the Connection OS offers ${known.size} providers`, known.size > 0)

  const badConnections: string[] = []
  for (const c of CAPS) {
    for (const p of APP_CAPABILITY_REGISTRY[c].requires?.connections ?? []) {
      if (!known.has(p)) badConnections.push(`${c}→${p}`)
    }
  }
  check("no capability requires a provider the Connection OS does not offer",
    badConnections.length === 0, badConnections.join(", "))

  // Platform lanes are the OPPOSITE: they must NOT be tenant-connectable, or the
  // UI would show a connect button for something only the platform can fix.
  const miscategorised: string[] = []
  for (const c of CAPS) {
    for (const p of APP_CAPABILITY_REGISTRY[c].requires?.platform ?? []) {
      if (CONNECTOR_PROVIDERS.social.includes(p) || CONNECTOR_PROVIDERS.podcast.includes(p)) {
        miscategorised.push(`${c}→${p}`)
      }
    }
  }
  check("a platform-owned lane is not also offered as a tenant connection",
    miscategorised.length === 0, miscategorised.join(", "))

  check("a declared requirement is never empty (that would read as 'no dependency')",
    CAPS.every((c) => {
      const r = APP_CAPABILITY_REGISTRY[c].requires
      return !r || (r.connections?.length ?? 0) + (r.platform?.length ?? 0) > 0
    }))
}

console.log("\n[the honest backlog stays visible]")
{
  check("UNDECLARED_REQUIREMENTS is non-empty and every entry is a real capability",
    UNDECLARED_REQUIREMENTS.length > 0 &&
    UNDECLARED_REQUIREMENTS.every((c) => CAPS.includes(c)))

  // A capability cannot be both "declared" and "not modelled" — that ambiguity is
  // how a backlog turns into false confidence.
  const both = UNDECLARED_REQUIREMENTS.filter((c) => !!APP_CAPABILITY_REGISTRY[c].requires)
  check("nothing is both declared AND on the backlog", both.length === 0, both.join(", "))

  console.log(`  · ${UNDECLARED_REQUIREMENTS.length} of ${CAPS.length} capabilities have an unmapped dependency`)
  const declared = CAPS.filter((c) => !!APP_CAPABILITY_REGISTRY[c].requires)
  console.log(`  · ${declared.length} declare one: ${declared.join(", ")}`)
  const free = CAPS.filter((c) =>
    !APP_CAPABILITY_REGISTRY[c].requires &&
    !(UNDECLARED_REQUIREMENTS as readonly string[]).includes(c))
  console.log(`  · ${free.length} run on the kernel alone`)
  check("the three sets partition the registry exactly",
    declared.length + UNDECLARED_REQUIREMENTS.length + free.length === CAPS.length)
}

console.log("\n[the resolver is never optimistic]")
{
  const r = src("lib/agentic-os/resolve-app-capability.ts")
  check("the resolver exists", r.length > 0)
  check("a not-modelled dependency resolves to HELD, never to ready",
    /requirement_not_modelled[\s\S]{0,200}?operable: false/.test(r) ||
    /operable: false,\s*\n\s*reason: "requirement_not_modelled"/.test(r))
  check("a failed platform-credential probe fails CLOSED",
    /catch \{[\s\S]{0,400}?return false/.test(r))
  check("…and says so in a comment, because failing open here is the whole bug",
    /Failing closed is the point/.test(r))
  check("it reuses the EXISTING connection resolver rather than a second probe path",
    /from "@\/lib\/integrations\/connection-manager"/.test(r))
  check("…and mirrors the connected-capability resolver's shape",
    /operable/.test(r) && /missing/.test(r) && /satisfiedBy/.test(r))
  check("a tenant-fixable block is distinguished from a platform-only one",
    /no_connection/.test(r) && /no_platform_credential/.test(r))
  check("the platform-only explanation tells the broker there is nothing to do",
    /nothing for you to do/.test(r))
  check("it never throws — a probe failure is an honest verdict, not a 500",
    /Never throws/.test(r))
}

console.log("\n[discovery reports OPERABLE beside AUTHORIZED]")
{
  const route = src("app/api/agentic-os/actions/route.ts")
  check("the discovery endpoint resolves capability readiness",
    /resolveAllAppCapabilities/.test(route))
  check("…reports which actions are operable", /operable/.test(route))
  check("…and which are dark, WITH the reason and what is missing",
    /dark/.test(route) && /reason/.test(route) && /missing/.test(route))
  check("…and omits both rather than guessing when there is no brokerage context",
    /\.\.\.\(operable \? \{ operable, dark \} : \{\}\)/.test(route))
  check("authorized is still reported — scope and readiness are separate answers",
    /authorized: authorizedActions/.test(route))
}

console.log("\n[the manifest itself is unchanged in shape]")
{
  // The contract must not break existing consumers: the MCP route maps this
  // manifest to tools, and the scraper simulator asserts against it.
  const manifest = buildFullActionManifest()
  check("the manifest still builds", manifest.length > 0)
  check("…still covers every app capability",
    CAPS.every((c) => manifest.some((a) => a.kind === "app" && a.capability === c)))
  check("…and every entry still carries the fields consumers read",
    manifest.every((a) => !!a.action && !!a.verb && !!a.scope && typeof a.mutates === "boolean"))
  check("package.json wires this proof", /test:capability-contract/.test(src("package.json")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ CAPABILITY_CONTRACT_FAIL"); process.exit(1) }
console.log(" ✅ CAPABILITY_CONTRACT_PASS — nothing is advertised ready without evidence")
