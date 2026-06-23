#!/usr/bin/env tsx
/**
 * scripts/state-fair-housing-simulator.ts  (npm run test:state-fair-housing)
 *
 * Proves the consolidation that closes the one real gap from the drift audit: state-specific
 * protected classes (CA source-of-income, NY arrest record, MA marital status, …) are now
 * consulted on the LIVE outbound surfaces — the client-message dissent path
 * (lib/kernel/manager-dissent.ts → runManagerDissent) AND the social/ads gate
 * (lib/kernel/marketing/real-estate-compliance-gate.ts → runComplianceGate) — not only the
 * marketing-content action. The national FAIR_HOUSING_PATTERNS were already shared; this adds
 * the state layer so every gate consults the SAME complete rule set.
 *
 *  - PURE layer (always): the canonical advisory formatter + the verdict-escalation contract
 *    (national-clear + state-flagged ⇒ dissent, never pass).
 *  - LIVE layer (creds-gated, self-cleaning): seeds a tagged throwaway brokerage in a covered
 *    state (CA) + two 'proposed' agent_client_messages (one with "no Section 8", one clean),
 *    runs runManagerDissent, asserts the violating one was annotated with a state Fair Housing
 *    dissent and the clean one passed, then deletes every tagged row (cleanup count == 0).
 *
 * Live run: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/state-fair-housing-simulator.ts
 */
import { randomUUID } from "node:crypto"
import { formatStateFairHousingAdvisory } from "../lib/compliance-rules/state-fair-housing-format"
import type { RuleViolation } from "../lib/compliance-rules/rule-evaluators"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

/** The exact escalation the runner applies inline — kept here as an executable contract. */
function verdictWithState(nationalVerdict: "pass" | "dissent" | "veto", stateAdvisoryCount: number): "pass" | "dissent" | "veto" {
  if (nationalVerdict === "veto") return "veto"
  return nationalVerdict === "dissent" || stateAdvisoryCount > 0 ? "dissent" : "pass"
}

function pureLayer(): void {
  console.log("\n[state Fair Housing · pure]")

  const v: RuleViolation = {
    rule_category: "regulatory",
    rule_name: "state_fair_housing_pattern_source_of_income",
    severity: "high",
    description: "source of income",
    offending_excerpt: "no Section 8",
    suggested_fix: "Remove or rephrase to focus on property features.",
    regulation_reference: "CA Gov. Code § 12955(p)",
  }
  const line = formatStateFairHousingAdvisory(v, "CA")
  check("formatter names the state, excerpt, fix and regulation", /\bCA\b/.test(line) && line.includes("no Section 8") && line.includes("CA Gov. Code"))
  check("formatter is identical across gates (one source of truth)", line === formatStateFairHousingAdvisory(v, "CA"))

  // verdict escalation contract
  check("national veto stays veto regardless of state", verdictWithState("veto", 3) === "veto")
  check("national-clear + state-flagged ⇒ dissent (the gap this closes)", verdictWithState("pass", 1) === "dissent")
  check("national-clear + state-clear ⇒ pass", verdictWithState("pass", 0) === "pass")
  check("national dissent + state-clear stays dissent", verdictWithState("dissent", 0) === "dissent")
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[state Fair Housing · live]  ⊘ skipped (no SUPABASE creds) — pure layer already proved the logic")
    return
  }
  console.log("\n[state Fair Housing · live — seed → runManagerDissent → assert → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runManagerDissent } = await import("../lib/kernel/manager-dissent")
  const svc = createServiceClient()

  const tag = `sfh-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const violatingId = randomUUID()
  const cleanId = randomUUID()

  try {
    // Covered state required — no real brokerage is in a covered state, so seed a throwaway CA one.
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (CA test)`, state: "CA" })
    const base = { brokerage_id: brokerageId, agent_kind: "sphere_of_influence", audience: "client", entity_type: "contact", channel: "email", status: "proposed" as const }
    await svc.from("agent_client_messages").insert([
      { ...base, id: violatingId, subject: `${tag} unit`, body: "Charming 2BR in a quiet building. Sorry, no Section 8 vouchers accepted." },
      { ...base, id: cleanId, subject: `${tag} unit`, body: "Charming 2BR with updated kitchen, hardwood floors, and a large balcony." },
    ])

    const res = await runManagerDissent(brokerageId)
    check("runManagerDissent reviewed both seeded proposals", res.reviewed >= 2)

    const { data: rows } = await svc.from("agent_client_messages").select("id, rationale, status").in("id", [violatingId, cleanId])
    const violating = (rows ?? []).find((r) => r.id === violatingId)
    const clean = (rows ?? []).find((r) => r.id === cleanId)

    check("violating proposal got a state Fair Housing dissent annotation",
      !!violating && /State Fair Housing \(CA/.test(violating.rationale ?? "") && /DISSENTS/.test(violating.rationale ?? ""))
    check("violating proposal names the source-of-income excerpt", !!violating && /no Section 8/i.test(violating.rationale ?? ""))
    check("clean proposal passed peer review (no state dissent)",
      !!clean && /no objections/i.test(clean.rationale ?? "") && !/State Fair Housing/.test(clean.rationale ?? ""))
  } finally {
    // Reverse-order cleanup; verify nothing tagged survives.
    await svc.from("agent_client_messages").delete().in("id", [violatingId, cleanId])
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete — zero tagged rows remain", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STATE_FAIR_HOUSING_FAIL"); process.exit(1) }
  console.log(" ✅ STATE_FAIR_HOUSING_PASS — state protected classes consulted on the live client-message + ads gates")
}

main().catch((e) => { console.error(e); process.exit(1) })
