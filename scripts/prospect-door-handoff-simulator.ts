#!/usr/bin/env tsx
/**
 * scripts/prospect-door-handoff-simulator.ts   (npm run test:prospect-door-handoff)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 87F (wave 87) — the prospect → subscriber door, "autonomous with humans when warranted",
 * proven on the REAL platform prospect tool bundle (lib/platform/prospect-agent-tools.ts) and the
 * REAL prospect writer (lib/platform/prospect-capture.ts). Only the edges are faked: the service
 * client (scripts/in-memory-supabase.ts), the platform-staff bell, and the conversion core's verdict.
 *
 *   A · a YES that needs a person (enterprise size / custom pricing / CRM migration) is HANDED OFF BY
 *       THE TOOL — staff bell + details.human_handoff stamped — instead of only telling the model to
 *       call request_human_handoff (before 87F a model that forgot left the YES with nobody).
 *   B · an open handoff is not rung twice (the model calling request_human_handoff afterwards is safe).
 *   C · controls: a clean YES rings no bell; a fresh request_human_handoff still rings.
 *   D · the demo the platform agent gives now covers LEAD ACQUISITION + LEAD INTELLIGENCE
 *       (lead_engine), the tool's topic enum is DERIVED from PRODUCT_DEMO_TOPICS (one vocabulary §6),
 *       and the script is real-estate literate (timeline buckets) and never salesy.
 *
 * Rule, not waypoint. Run: npx tsx scripts/prospect-door-handoff-simulator.ts
 */
import { registerHooks } from "node:module"
import { memSupabase, type MemClient } from "./in-memory-supabase"

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const G = globalThis as any
G.__87FH = { svc: null as MemClient | null, bells: [] as any[], conv: null as any }
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__87FH.svc",
  "@/lib/notifications/platform-staff": "export const notifyPlatformStaff = async (_svc, n) => { globalThis.__87FH.bells.push(n); return 2 }",
  "@/lib/platform/prospect-conversion": [
    "export const HUMAN_REASON_LABEL = { enterprise_size: 'enterprise size — contract and rollout plan', custom_pricing: 'custom pricing requested — a commercial decision', crm_migration: 'migration from their current CRM — white-glove data import' }",
    "export const convertProspectToSubscriber = async () => globalThis.__87FH.conv",
  ].join("\n"),
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

async function main() {
  const { buildPlatformProspectTools } = await import("../lib/platform/prospect-agent-tools")
  const brand: any = { name: "Demo OS", liveAgent: { demoClipUrl: null } }
  const world = () => memSupabase({
    platform_prospects: [
      { id: "p1", email: "owner@bigbrokerage.com", phone: null, name: "Pat Owner", status: "new", details: {} },
      { id: "p2", email: "solo@agent.com", phone: null, name: "Sam Solo", status: "new", details: {} },
    ],
    platform_reception_calls: [],
  })
  const build = async (prospectId: string) => buildPlatformProspectTools({
    source: "web:prospect_chat", phone: null, prospectId, callId: null, brand, hasLiveTransfer: false,
  }) as Promise<Record<string, any>>

  // ── A · needsHuman is handed off by the tool ─────────────────────────────────
  console.log("\n[A · a YES that needs a person is handed off deterministically]")
  G.__87FH.svc = world()
  G.__87FH.bells = []
  G.__87FH.conv = { ok: false, error: "This one needs a person", needsHuman: ["enterprise_size"] }
  let tools = await build("p1")
  const r = await tools.start_subscription.execute({
    email: "owner@bigbrokerage.com", name: "Pat Owner", company: "Big Brokerage", plan: "multi_location",
    activation: "paid", billing_cycle: null, wants_custom_pricing: false,
  })
  const row = () => (G.__87FH.svc.tables.platform_prospects as any[]).find((p) => p.id === "p1")
  ok("the tool answers needsHuman with handoffCreated", r.needsHuman === true && r.handoffCreated === true, JSON.stringify(r))
  ok("the platform staff bell rang once, naming the reason", G.__87FH.bells.length === 1 && /enterprise size/.test(G.__87FH.bells[0]?.body ?? ""), JSON.stringify(G.__87FH.bells))
  ok("details.human_handoff is stamped OPEN on the prospect (the growth board sees it)", row()?.details?.human_handoff?.status === "open" && /needs a person/.test(row()?.details?.human_handoff?.reason ?? ""))
  ok("the model is told the handoff is done — never to retry or re-request", /Do not call request_human_handoff again/.test(String(r.nextStep ?? "")))

  // ── B · no double bell ─────────────────────────────────────────────────────────
  console.log("\n[B · an open handoff is not rung twice]")
  const again = await tools.request_human_handoff.execute({ reason: "wants a contract", best_time: null, email: "owner@bigbrokerage.com", name: "Pat Owner" })
  ok("a later request_human_handoff on the same open handoff → alreadyRequested, no second bell", again.success === true && again.alreadyRequested === true && G.__87FH.bells.length === 1)

  // ── C · controls ───────────────────────────────────────────────────────────────
  console.log("\n[C · controls]")
  G.__87FH.svc = world()
  G.__87FH.bells = []
  G.__87FH.conv = { ok: true, alreadyConverted: false, brokerageId: "b1", userId: "u1", tier: "solo_agent", inviteSent: true, trialEndsAt: "2099-01-01T00:00:00.000Z", checkoutUrl: null, setupFeeCents: null, setupFeeWaived: false, humanReasons: [], staffNotified: 0, demoDisposition: "none", prospectLinked: 1 }
  tools = await build("p2")
  const clean = await tools.start_subscription.execute({
    email: "solo@agent.com", name: "Sam Solo", company: null, plan: "solo_agent", activation: "trial", billing_cycle: null, wants_custom_pricing: false,
  })
  ok("CONTROL: a clean self-serve YES creates the trial and rings NO bell (autonomous when no human is warranted)", clean.success === true && clean.trial === true && G.__87FH.bells.length === 0)
  const fresh = await tools.request_human_handoff.execute({ reason: "has a question about MLS import", best_time: "tomorrow am", email: "solo@agent.com", name: "Sam Solo" })
  ok("CONTROL: a fresh request_human_handoff (no open handoff) still rings", fresh.success === true && fresh.alreadyRequested === false && G.__87FH.bells.length === 1)

  // ── D · the lead engine demo ───────────────────────────────────────────────────
  console.log("\n[D · show_product_demo covers lead acquisition + lead intelligence]")
  const { PRODUCT_DEMO_TOPICS, describeProductDemo } = await import("../lib/platform/product-demo")
  const schema = tools.show_product_demo.inputSchema
  ok("the tool's topic enum accepts EVERY PRODUCT_DEMO_TOPICS entry (derived, not a hand copy)",
    PRODUCT_DEMO_TOPICS.every((t) => schema.safeParse({ topic: t }).success))
  ok("POSITIVE CONTROL: the enum still refuses a topic that is not in the list", !schema.safeParse({ topic: "crypto_trading" }).success)
  ok("lead_engine is a demo topic", (PRODUCT_DEMO_TOPICS as readonly string[]).includes("lead_engine"))
  const demo = describeProductDemo("lead_engine", { brandName: "Demo OS", surfaceCanShowClip: false }, [])
  const said = demo.walkthrough.join(" ")
  ok("the lead_engine script walks the linear pipeline (dedup → enrich → dedup → a real person in territory)", /de-duplicated/.test(said) && /enriched/.test(said) && /territory/.test(said))
  ok("real-estate literate: leads belong to the brokerage and qualify on the 1-3 / 3-6 / 6-12 buckets", /belong to the brokerage/.test(said) && /1-3, 3-6 or 6-12/.test(said))
  ok("lead intelligence = history + source cost is what the demo promises", /timeline/.test(said) && /cost/.test(said) && /sources earn their keep/.test(said))
  ok("never salesy (no act now / limited time / hurry / don't miss / guaranteed)", !/act now|limited time|hurry|don't miss|guarantee/i.test(said))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log(" PROSPECT_DOOR_HANDOFF_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
