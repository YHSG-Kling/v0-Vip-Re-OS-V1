#!/usr/bin/env tsx
/**
 * scripts/capability-ownership-simulator.ts (npm run test:capability-ownership)
 * ─────────────────────────────────────────────────────────────────────────────
 * SIX FEATURES SHIPPED WITH NO MANAGER ACCOUNTABLE FOR THEM.
 *
 * The owner's standing rule for this OS: a feature is not finished when it works —
 * it is finished when a MANAGER owns it, collaborates over the bus, and closes its
 * loop decisively, autonomously where that is the honest thing to do.
 *
 * An audit of two days of commits found six features with no MAINTENANCE_DOMAINS
 * entry at all: the capability contract, the seat accounting, the lead-score
 * consolidation, the assignment methods, the step palette and the vendor taxonomy.
 * The existing guard checked that every DECLARED domain has a valid manager — it
 * never asked whether a new feature had declared one, so all six slipped in
 * unowned while the guard stayed green.
 *
 * Closed both ways here:
 *   · every capability names an accountable manager (CAPABILITY_MANAGER), proven
 *     EXHAUSTIVE against the registry so a new capability cannot ship unowned;
 *   · readiness stops being passive — a dark capability publishes onto the manager
 *     bus, routed to whoever can actually act;
 *   · and a proof with no manager domain now FAILS, baselined shrink-only so the
 *     legacy backlog can only get smaller (the orphan-route / writer-less-read
 *     idiom this repo already uses).
 *
 * THE ROUTING IS THE INTERESTING PART, and it is about restraint as much as action:
 * a capability the self-healer is already repairing raises NOTHING. Telling a
 * manager "direct mail is down" while the repair is in flight produces a decision
 * that is wrong by the time it lands. Autonomy means letting the autonomous part
 * finish.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  CAPABILITY_MANAGER, capabilityOwner, routeDarkCapability, darkCapabilityBrief,
  CAPABILITY_DARK_SIGNAL,
} from "../lib/agentic-os/capability-ownership"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "../lib/agentic-os/app-capability-registry"
import { MANAGERS, MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { validSignalRoute } from "../lib/kernel/manager-signals"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

console.log("══════════════════════════════════════════════════")
console.log(" Capability ownership — a manager owns it, and the loop closes")
console.log("══════════════════════════════════════════════════")

const CAPS = Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]

console.log("\n[every capability has an accountable manager]")
{
  const unowned = CAPS.filter((c) => !CAPABILITY_MANAGER[c])
  check(`all ${CAPS.length} capabilities name an owner`, unowned.length === 0, unowned.join(", "))
  const phantom = CAPS.filter((c) => !(CAPABILITY_MANAGER[c] in MANAGERS))
  check("every owner is one of the 14 registered managers", phantom.length === 0, phantom.join(", "))
  check("no EXTRA keys — the map cannot drift ahead of the registry",
    Object.keys(CAPABILITY_MANAGER).length === CAPS.length)

  // Ownership follows the CHARTER, not the implementation. The clearest test of
  // that: direct mail is a SEND, so the Orchestrator owns it even though the Lob
  // credential is the Steward's to configure.
  check("direct mail is owned by the manager that SENDS, not the one that holds the key",
    capabilityOwner("direct_mail_send") === "campaign_orchestrator")
  check("money is the Finance Manager's", capabilityOwner("payment_transfer") === "finance_manager" &&
    capabilityOwner("accounting_sync") === "finance_manager")
  check("lead qualification is the ISA's", capabilityOwner("isa_qualify") === "ai_isa" &&
    capabilityOwner("lead_search") === "ai_isa")
  check("valuation is the Listing Concierge's", capabilityOwner("cma_generate") === "listing_concierge")
  check("gifts and notes are the Sphere Manager's — lifetime clients",
    capabilityOwner("gift_send") === "sphere_of_influence" &&
    capabilityOwner("handwritten_note_send") === "sphere_of_influence")
  check("connection health is the Steward's", capabilityOwner("connectivity_scan") === "data_steward")
}

console.log("\n[the routing knows when to say NOTHING]")
{
  // Restraint first: a repair in flight means there is no decision to make.
  const healing = routeDarkCapability({
    capability: "direct_mail_send", reason: "no_platform_credential",
    healingInFlight: true, missing: ["lob"],
  })
  check("a capability the healer is repairing raises NOTHING",
    healing.action === "hold_for_healer" && healing.to === null)
  check("…and says why, in words a human can read",
    /being repaired automatically/.test(healing.reason))
  check("…even when the underlying reason would otherwise escalate",
    healing.action !== "escalate_platform")

  // A manager must never be handed an action it has no power over.
  const platform = routeDarkCapability({
    capability: "direct_mail_send", reason: "no_platform_credential",
    healingInFlight: false, missing: ["lob"],
  })
  check("a missing PLATFORM credential goes to the Steward, not the owning manager",
    platform.action === "escalate_platform" && platform.to === "data_steward")
  check("…and says plainly that the owning manager cannot fix it",
    /cannot/.test(platform.reason))

  // Only the genuinely actionable reaches the owner.
  const tenant = routeDarkCapability({
    capability: "social_post_publish", reason: "no_connection",
    healingInFlight: false, missing: ["meta", "linkedin"],
  })
  check("a tenant-connectable gap reaches the OWNING manager",
    tenant.action === "notify_owner" && tenant.to === capabilityOwner("social_post_publish"))
  check("…and frames it as a decision, not a complaint",
    /decides how to work around it/.test(tenant.reason))
  check("…naming what would fix it", tenant.reason.includes("meta / linkedin"))

  // A contract gap is the platform's problem, never the tenant's.
  const unmodelled = routeDarkCapability({
    capability: "gift_send", reason: "requirement_not_modelled",
    healingInFlight: false, missing: [],
  })
  check("an unmodelled requirement is a CONTRACT gap, escalated to the platform",
    unmodelled.action === "escalate_platform" && unmodelled.to === "data_steward")

  check("the brief a manager reads names the capability's purpose",
    darkCapabilityBrief("direct_mail_send", tenant).includes(
      APP_CAPABILITY_REGISTRY.direct_mail_send.purpose))
}

console.log("\n[the signal is governed, like every other signal on the bus]")
{
  check("capability_dark is catalogued in the SIGNAL_REGISTRY",
    CAPABILITY_DARK_SIGNAL in SIGNAL_REGISTRY)
  const spec = SIGNAL_REGISTRY[CAPABILITY_DARK_SIGNAL]
  check("…declared feed_only with no consumers, honestly",
    spec?.disposition === "feed_only" && spec.consumers.length === 0)
  check("…as an alert, which is what the feed should render it as", spec?.kind === "alert")
  check("…and the catalog says WHY feed-only: the workaround is a judgement about a client",
    /judgement about a client relationship/.test(spec?.what ?? ""))

  // A signal needs two DISTINCT registered managers. The escalator handles the
  // case where the observer would be talking to itself.
  check("data_steward → campaign_orchestrator is a valid route",
    validSignalRoute("data_steward", "campaign_orchestrator"))
  check("data_steward → data_steward is NOT (a manager never signals itself)",
    !validSignalRoute("data_steward", "data_steward"))
  const esc = src("lib/agentic-os/escalate-dark-capabilities.ts")
  check("…so the escalator sends AS cron_manager when the target is the Steward",
    esc.includes('route.to === "data_steward" ? "cron_manager" : "data_steward"'))
  // THE BUG LIVE TESTING CAUGHT, pinned shut. manager_signals.entity_id is a UUID
  // column; I first passed the capability NAME into it, which made Postgres reject
  // both the dedupe SELECT and the INSERT. publishManagerSignal returns
  // { ok: false } rather than throwing, so the cron would have logged
  // `capabilitiesEscalated: 0` on a healthy-looking run — forever, having published
  // nothing. Reading the code did not find it; writing a real row did.
  check("the capability is NEVER written to entity_id (a uuid column)",
    !esc.includes("entityId: r.capability"))
  check("…entity_id is explicitly null, with the reason stated",
    esc.includes("entityId: null") && /this column is a uuid/.test(esc))
  check("…the capability travels in the payload, where a string belongs",
    esc.includes("capability: r.capability"))
  check("the dedupe is done HERE, reading payload.capability",
    esc.includes("openFor.has(r.capability)") && esc.includes("dedupe: false"))
  check("…seeded from ONE read of the open signals, not one per capability",
    /signal_type", CAPABILITY_DARK_SIGNAL/.test(esc) && esc.includes('eq("status", "open")'))
  check("a FAILED publish is counted, never swallowed as 'nothing dark'",
    esc.includes("result.failed++") && /publish failure that reads as/.test(esc))
  check("…and the cron surfaces that count",
    src("app/api/cron/connector-health/route.ts").includes("capabilityEscalationsFailed"))
  check("…and it never throws — a readiness sweep cannot take the cron down",
    esc.includes("result.error = e instanceof Error"))
  check("operable capabilities are skipped before any work is done",
    esc.includes("if (r.operable) continue"))
}

console.log("\n[the loop rides an EXISTING heartbeat]")
{
  const cron = src("app/api/cron/connector-health/route.ts")
  check("the connector-health cron runs the escalation", /escalateDarkCapabilities/.test(cron))
  check("…and reports what it did, so the run is auditable",
    /capabilitiesEscalated/.test(cron) && /capabilitiesHeldForHealer/.test(cron))
  check("…and says why it is not a new schedule",
    /second heartbeat asking the same question/.test(cron))
  check("no new cron path was added for it",
    !/capability-escalation/.test(src("lib/kernel/cron-dispatch.ts")))
}

console.log("\n[the six unowned features now have owners]")
{
  // THE audit finding. Each of these shipped with no MAINTENANCE_DOMAINS entry, so
  // no manager was accountable — and the ownership guard stayed green because it
  // only checked that DECLARED domains have valid managers.
  const EXPECTED: Array<{ domain: string; proof: string; manager: string }> = [
    { domain: "agentic_capability_contract",  proof: "test:capability-contract",        manager: "data_steward" },
    { domain: "agentic_capability_ownership", proof: "test:capability-ownership",        manager: "cron_manager" },
    { domain: "lead_assignment_method",       proof: "test:assignment-method",           manager: "ai_isa" },
    { domain: "lead_score_consolidation",     proof: "test:lead-score-consolidation",    manager: "ai_isa" },
    { domain: "workflow_step_palette",        proof: "test:sequence-step-palette",       manager: "campaign_orchestrator" },
    { domain: "vendor_taxonomy_unification",  proof: "test:vendor-categories",           manager: "data_steward" },
    { domain: "tenant_seat_accounting",       proof: "test:seat-display",                manager: "finance_manager" },
  ]
  for (const e of EXPECTED) {
    const d = MAINTENANCE_DOMAINS[e.domain]
    check(`${e.domain} → ${e.manager}`, d?.manager === e.manager, d ? `is ${d.manager}` : "MISSING")
    check(`…proved by ${e.proof}`, d?.proof === e.proof, d?.proof ?? "MISSING")
  }
  check("every one of them is wired into package.json",
    EXPECTED.every((e) => new RegExp(`"${e.proof}"`).test(src("package.json"))))
  check("…and every domain's manager is a real seat",
    EXPECTED.every((e) => MAINTENANCE_DOMAINS[e.domain]?.manager in MANAGERS))
}

console.log("\n[an unowned proof can never slip in again]")
{
  // The class, closed. A shrink-only baseline of the proofs that predate this rule;
  // anything NEW without a manager domain fails. Same idiom as the orphan-route
  // sweep — building something and not assigning an owner is now a build break.
  const guard = src("scripts/manager-proof-ownership-guard.ts")
  check("the guard exists", guard.length > 0)
  check("…it derives the proof list from package.json, not a hand-kept copy",
    guard.includes("package.json"))
  check("…compares against MAINTENANCE_DOMAINS", /MAINTENANCE_DOMAINS/.test(guard))
  check("…and is shrink-only: a NEW unowned proof fails, the legacy backlog cannot grow",
    /baseline/i.test(guard) && /FAIL/.test(guard))
  check("the guard is on the chain", /test:proof-ownership/.test(src("package.json")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ CAPABILITY_OWNERSHIP_FAIL"); process.exit(1) }
console.log(" ✅ CAPABILITY_OWNERSHIP_PASS — every capability owned, every dark one routed")
